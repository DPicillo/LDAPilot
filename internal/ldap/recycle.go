package ldap

import (
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// Deleted objects (AD tombstones / Recycle Bin), restore (reanimation) and
// subtree deletes.

const (
	// wkguidDeletedObjects is the well-known GUID of the Deleted Objects
	// container of every naming context (GUID_DELETED_OBJECTS_CONTAINER_W).
	wkguidDeletedObjects = "18E2EA80684F11D2B9AA00C04F79F805"

	// OIDTreeDelete is the tree delete control (1.2.840.113556.1.4.805).
	OIDTreeDelete = goldap.ControlTypeMicrosoftTreeDelete
	// OIDShowDeleted is the Show Deleted control (1.2.840.113556.1.4.417).
	OIDShowDeleted = goldap.ControlTypeMicrosoftShowDeleted
	// OIDShowRecycled is the Show Recycled control (1.2.840.113556.1.4.2064).
	OIDShowRecycled = goldap.ControlTypeMicrosoftShowRecycled
	// OIDManageDsaIT is the ManageDsaIT control (2.16.840.1.113730.3.4.2).
	OIDManageDsaIT = goldap.ControlTypeManageDsaIT

	// DefaultDescendantLimit caps CountDescendants.
	DefaultDescendantLimit = 10000
	// DefaultDeletedObjectsLimit caps ListDeletedObjects.
	DefaultDeletedObjectsLimit = 5000

	// treeDeleteMaxAttempts bounds the repetitions of a tree delete that AD
	// ends with adminLimitExceeded (it deletes large trees in chunks).
	treeDeleteMaxAttempts = 100
)

// deletedObjectAttrs are read for every deleted object.
var deletedObjectAttrs = []string{
	"objectClass", "name", "msDS-LastKnownRDN", "lastKnownParent",
	"whenChanged", "whenCreated", "isRecycled", "isDeleted",
	"objectSid", "objectGUID", "sAMAccountName",
}

// ErrDeletedObjectsUnsupported is returned for servers without AD deleted
// objects (no AD or no Show Deleted control).
var ErrDeletedObjectsUnsupported = errors.New("deleted objects are only available on Active Directory / Samba AD servers that support the Show Deleted control")

// recycleHasControl reports whether the server lists oid in supportedControl.
func (c *Client) recycleHasControl(oid string) bool {
	info, err := c.ServerInfo()
	if err != nil {
		return false
	}
	return slices.Contains(info.SupportedControls, oid)
}

// TreeDeleteSupported reports whether the server lists the tree delete
// control (1.2.840.113556.1.4.805) in supportedControl.
func (c *Client) TreeDeleteSupported() bool {
	return c.recycleHasControl(OIDTreeDelete)
}

func showDeletedControls(recycled bool) []goldap.Control {
	ctrls := []goldap.Control{goldap.NewControlString(OIDShowDeleted, true, "")}
	if recycled {
		ctrls = append(ctrls, goldap.NewControlString(OIDShowRecycled, true, ""))
	}
	return ctrls
}

// RecycleBinInfo reports whether the server has AD deleted objects, the
// state of the Recycle Bin optional feature, the configured lifetimes and the
// Deleted Objects container of each naming context hosted by the server
// (schema excluded). For other servers Supported is false with a Reason.
func (c *Client) RecycleBinInfo() (*models.RecycleBinInfo, error) {
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	out := &models.RecycleBinInfo{
		ServerType:            info.ServerType,
		DefaultNamingContext:  info.DefaultNamingContext,
		ShowRecycledSupported: slices.Contains(info.SupportedControls, OIDShowRecycled),
		TreeDeleteSupported:   slices.Contains(info.SupportedControls, OIDTreeDelete),
		Containers:            []models.DeletedObjectsContainer{},
	}
	if info.ServerType != models.ServerTypeAD {
		out.Reason = unsupportedReason(info.ServerType)
		return out, nil
	}
	if !slices.Contains(info.SupportedControls, OIDShowDeleted) {
		out.Reason = "The server does not announce the Show Deleted control (1.2.840.113556.1.4.417), so deleted objects cannot be listed."
		return out, nil
	}
	out.Supported = true

	if info.ConfigurationNamingContext != "" {
		if enabled, err := c.recycleBinEnabled(info.ConfigurationNamingContext); err == nil {
			out.RecycleBinEnabled, out.RecycleBinKnown = enabled, true
		}
		out.TombstoneLifetimeDays, out.DeletedObjectLifetimeDays = c.deletedLifetimes(info.ConfigurationNamingContext)
	}

	for _, nc := range deletedObjectsNamingContexts(info) {
		cont := models.DeletedObjectsContainer{NamingContext: nc, Kind: recycleNamingContextKind(nc, info)}
		dn, err := c.DeletedObjectsContainer(nc)
		if err != nil {
			cont.Error = err.Error()
		} else {
			cont.DN = dn
		}
		out.Containers = append(out.Containers, cont)
	}
	return out, nil
}

// unsupportedReason explains why a server type has no deleted objects view.
func unsupportedReason(serverType string) string {
	switch serverType {
	case models.ServerTypeOpenLDAP:
		return "OpenLDAP deletes entries immediately and keeps no deleted objects (no tombstones, no recycle bin). Restore deleted entries from an LDIF export or backup; the accesslog/auditlog overlays can record what was deleted."
	case models.ServerType389DS:
		return "389 Directory Server keeps tombstones only for replication; they are not exposed for restore here. Restore deleted entries from an LDIF export or backup."
	default:
		return "This server is not Active Directory: deleted objects (tombstones / AD Recycle Bin) are an Active Directory feature."
	}
}

// deletedObjectsNamingContexts returns the naming contexts to look for Deleted
// Objects containers in: the default NC first, then other domain NCs,
// application partitions and the configuration NC. The schema NC has none.
func deletedObjectsNamingContexts(info *models.ServerInfo) []string {
	var domains, apps, config []string
	seen := map[string]bool{}
	add := func(nc string) {
		key := strings.ToLower(nc)
		if nc == "" || seen[key] || strings.EqualFold(nc, info.SchemaNamingContext) {
			return
		}
		seen[key] = true
		switch recycleNamingContextKind(nc, info) {
		case models.NamingContextConfiguration:
			config = append(config, nc)
		case models.NamingContextApplication:
			apps = append(apps, nc)
		default:
			domains = append(domains, nc)
		}
	}
	add(info.DefaultNamingContext)
	for _, nc := range info.NamingContexts {
		add(nc)
	}
	return append(append(domains, apps...), config...)
}

// recycleNamingContextKind classifies a naming context.
func recycleNamingContextKind(nc string, info *models.ServerInfo) string {
	if strings.EqualFold(nc, info.ConfigurationNamingContext) {
		return models.NamingContextConfiguration
	}
	lower := strings.ToLower(nc)
	if strings.HasPrefix(lower, "dc=domaindnszones,") || strings.HasPrefix(lower, "dc=forestdnszones,") {
		return models.NamingContextApplication
	}
	return models.NamingContextDomain
}

// recycleBinEnabled reads msDS-EnabledFeature of CN=Partitions in the
// configuration NC.
func (c *Client) recycleBinEnabled(configNC string) (bool, error) {
	req := goldap.NewSearchRequest("CN=Partitions,"+configNC, goldap.ScopeBaseObject, goldap.NeverDerefAliases,
		0, 0, false, "(objectClass=*)", []string{"msDS-EnabledFeature"}, nil)
	entries, err := c.SearchWithControls(req, 0)
	if err != nil {
		return false, err
	}
	if len(entries) == 0 {
		return false, nil
	}
	return recycleBinEnabledIn(entries[0].GetEqualFoldAttributeValues("msDS-EnabledFeature")), nil
}

// recycleBinEnabledIn reports whether the Recycle Bin feature is among the
// msDS-EnabledFeature values (DNs of optional feature objects).
func recycleBinEnabledIn(values []string) bool {
	for _, v := range values {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(v)), "cn=recycle bin feature,") {
			return true
		}
	}
	return false
}

// deletedLifetimes reads tombstoneLifetime and msDS-DeletedObjectLifetime
// (days, 0 = not set) from CN=Directory Service.
func (c *Client) deletedLifetimes(configNC string) (int, int) {
	req := goldap.NewSearchRequest("CN=Directory Service,CN=Windows NT,CN=Services,"+configNC, goldap.ScopeBaseObject,
		goldap.NeverDerefAliases, 0, 0, false, "(objectClass=*)",
		[]string{"tombstoneLifetime", "msDS-DeletedObjectLifetime"}, nil)
	entries, err := c.SearchWithControls(req, 0)
	if err != nil || len(entries) == 0 {
		return 0, 0
	}
	tl, _ := strconv.Atoi(entries[0].GetEqualFoldAttributeValue("tombstoneLifetime"))
	dl, _ := strconv.Atoi(entries[0].GetEqualFoldAttributeValue("msDS-DeletedObjectLifetime"))
	return tl, dl
}

// DeletedObjectsContainer returns the DN of the Deleted Objects container of
// naming context nc, found via its well-known GUID.
func (c *Client) DeletedObjectsContainer(nc string) (string, error) {
	req := goldap.NewSearchRequest(fmt.Sprintf("<WKGUID=%s,%s>", wkguidDeletedObjects, nc), goldap.ScopeBaseObject,
		goldap.NeverDerefAliases, 0, 0, false, "(objectClass=*)", []string{"distinguishedName"}, showDeletedControls(false))
	entries, err := c.SearchWithControls(req, 0)
	if err != nil {
		return "", err
	}
	if len(entries) == 0 {
		return "", fmt.Errorf("no Deleted Objects container in %s", nc)
	}
	if dn := entries[0].GetEqualFoldAttributeValue("distinguishedName"); dn != "" {
		return dn, nil
	}
	return entries[0].DN, nil
}

// ListDeletedObjects lists the deleted objects of naming context nc (empty =
// default naming context). text, if set, restricts the list to objects whose
// name, last known RDN or sAMAccountName contains it. Recycled objects are
// included when the server supports the Show Recycled control. At most
// sizeLimit objects are returned (<= 0: DefaultDeletedObjectsLimit), the
// cap is enforced on the client (Samba ignores size limits); Truncated
// reports a cut list. When the server supports server-side sorting the
// most recently deleted objects are requested first, so a cut list drops the
// oldest ones. The result is sorted by deletion time, newest first.
func (c *Client) ListDeletedObjects(nc, text string, sizeLimit int) (*models.DeletedObjectsList, error) {
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	if info.ServerType != models.ServerTypeAD || !slices.Contains(info.SupportedControls, OIDShowDeleted) {
		return nil, ErrDeletedObjectsUnsupported
	}
	if nc == "" {
		nc = info.DefaultNamingContext
	}
	if sizeLimit <= 0 {
		sizeLimit = DefaultDeletedObjectsLimit
	}
	containerDN, err := c.DeletedObjectsContainer(nc)
	if err != nil {
		return nil, err
	}
	recycleBin := false
	if info.ConfigurationNamingContext != "" {
		recycleBin, _ = c.recycleBinEnabled(info.ConfigurationNamingContext)
	}
	showRecycled := slices.Contains(info.SupportedControls, OIDShowRecycled)
	canSort := slices.Contains(info.SupportedControls, goldap.ControlTypeServerSideSorting)

	search := func(sorted bool) ([]*goldap.Entry, bool, error) {
		controls := showDeletedControls(showRecycled)
		if sorted {
			controls = append(controls, newestFirstSortControl())
		}
		req := goldap.NewSearchRequest(containerDN, goldap.ScopeSingleLevel, goldap.NeverDerefAliases,
			0, 0, false, deletedObjectsFilter(text), deletedObjectAttrs, controls)
		return c.recycleSearchCapped(req, sizeLimit)
	}
	entries, truncated, err := search(canSort)
	if err != nil && canSort && !errors.Is(err, ErrSearchCancelled) && !errors.Is(err, ErrNotConnected) {
		// The sort control is not critical, but some servers still refuse
		// sorting large result sets: list unsorted then.
		entries, truncated, err = search(false)
	}
	if err != nil {
		return nil, err
	}

	out := &models.DeletedObjectsList{
		ContainerDN:      containerDN,
		Objects:          make([]models.DeletedObject, 0, len(entries)),
		Truncated:        truncated,
		Limit:            sizeLimit,
		RecycledIncluded: showRecycled,
	}
	for _, e := range entries {
		out.Objects = append(out.Objects, deletedObjectFromEntry(e, recycleBin, nc))
	}
	sort.SliceStable(out.Objects, func(i, j int) bool { return out.Objects[i].DeletedAt > out.Objects[j].DeletedAt })
	return out, nil
}

// newestFirstSortControl requests a server-side sort (RFC 2891) by
// whenChanged (the deletion time of a deleted object), newest first. It is
// not critical: servers that cannot sort return the entries unsorted.
//
// The control value is encoded here: go-ldap encodes reverseOrder TRUE as
// 0x01, which Samba does not read as true (it accepts only the DER value
// 0xFF) and then sorts oldest first.
func newestFirstSortControl() goldap.Control {
	return goldap.NewControlString(goldap.ControlTypeServerSideSorting, false, derReverseSortKeyList("whenChanged"))
}

// derReverseSortKeyList returns the DER encoding of a SortKeyList with one
// key sorting attr in reverse order:
// SEQUENCE { SEQUENCE { attributeType OCTET STRING, reverseOrder [1] TRUE } }.
// attr must be shorter than 100 bytes (short-form lengths).
func derReverseSortKeyList(attr string) string {
	key := append([]byte{0x04, byte(len(attr))}, attr...)
	key = append(key, 0x81, 0x01, 0xFF)
	seq := func(content []byte) []byte { return append([]byte{0x30, byte(len(content))}, content...) }
	return string(seq(seq(key)))
}

// deletedObjectsFilter builds the filter for ListDeletedObjects.
func deletedObjectsFilter(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return "(isDeleted=TRUE)"
	}
	v := goldap.EscapeFilter(text)
	return fmt.Sprintf("(&(isDeleted=TRUE)(|(name=*%s*)(msDS-LastKnownRDN=*%s*)(sAMAccountName=*%s*)))", v, v, v)
}

// GetDeletedObject reads one deleted object (Show Deleted and, if supported,
// Show Recycled).
func (c *Client) GetDeletedObject(dn string) (*models.DeletedObject, error) {
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases, 0, 0, false,
		"(objectClass=*)", deletedObjectAttrs, showDeletedControls(slices.Contains(info.SupportedControls, OIDShowRecycled)))
	entries, err := c.SearchWithControls(req, 0)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, ErrNotFound
	}
	recycleBin := false
	if info.ConfigurationNamingContext != "" {
		recycleBin, _ = c.recycleBinEnabled(info.ConfigurationNamingContext)
	}
	obj := deletedObjectFromEntry(entries[0], recycleBin, "")
	return &obj, nil
}

// GetDeletedEntry reads all attributes of a deleted object, converted like
// GetEntry (binary contract applies).
func (c *Client) GetDeletedEntry(dn string) (*models.LDAPEntry, error) {
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases, 0, 0, false,
		"(objectClass=*)", []string{"*", "+"}, showDeletedControls(c.recycleHasControl(OIDShowRecycled)))
	entries, err := c.SearchWithControls(req, 0)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, ErrNotFound
	}
	return convertEntry(entries[0]), nil
}

// deletedObjectFromEntry converts a deleted object entry.
func deletedObjectFromEntry(e *goldap.Entry, recycleBinEnabled bool, nc string) models.DeletedObject {
	rdnAttr, rdnValue := deletedRDN(e.DN)
	name, _ := splitDeletedName(e.GetEqualFoldAttributeValue("name"))
	if name == "" {
		name = rdnValue
	}
	classes := e.GetEqualFoldAttributeValues("objectClass")
	obj := models.DeletedObject{
		DN:              e.DN,
		Name:            name,
		RDNAttribute:    rdnAttr,
		ObjectClass:     classes,
		LastKnownRDN:    e.GetEqualFoldAttributeValue("msDS-LastKnownRDN"),
		LastKnownParent: e.GetEqualFoldAttributeValue("lastKnownParent"),
		DeletedAt:       recycleTimeRFC3339(e.GetEqualFoldAttributeValue("whenChanged")),
		WhenCreated:     recycleTimeRFC3339(e.GetEqualFoldAttributeValue("whenCreated")),
		IsRecycled:      strings.EqualFold(e.GetEqualFoldAttributeValue("isRecycled"), "TRUE"),
		SAMAccountName:  e.GetEqualFoldAttributeValue("sAMAccountName"),
		NamingContext:   nc,
	}
	if len(classes) > 0 {
		obj.StructuralClass = classes[len(classes)-1]
	}
	if obj.LastKnownRDN != "" {
		obj.Name = obj.LastKnownRDN
	}
	if raw := e.GetEqualFoldRawAttributeValue("objectSid"); len(raw) > 0 {
		obj.ObjectSID, _ = formatSID(raw)
	}
	if raw := e.GetEqualFoldRawAttributeValue("objectGUID"); len(raw) > 0 {
		obj.ObjectGUID, _ = formatGUID(raw)
	}
	obj.ParentDeleted = IsDeletedObjectDN(obj.LastKnownParent)
	obj.State, obj.Restorable = classifyDeleted(obj.IsRecycled, recycleBinEnabled)
	if obj.LastKnownParent != "" && rdnAttr != "" {
		obj.OriginalDN = BuildRestoreDN(rdnAttr, obj.Name, obj.LastKnownParent)
	}
	return obj
}

// classifyDeleted returns the state of a deleted object and whether it can
// be restored. With the Recycle Bin enabled a deleted object keeps its
// attributes until it becomes recycled (isRecycled), which cannot be
// restored. Without the Recycle Bin every deleted object is a tombstone
// (Windows Server 2008 R2+ and Samba also set isRecycled on them), which can
// be reanimated with the attributes that were kept.
func classifyDeleted(isRecycled, recycleBinEnabled bool) (string, bool) {
	if !recycleBinEnabled {
		return models.DeletedStateTombstone, true
	}
	if isRecycled {
		return models.DeletedStateRecycled, false
	}
	return models.DeletedStateDeleted, true
}

// splitDeletedName splits the name of a deleted object into the original
// name and the object GUID of the "\nDEL:<guid>" suffix AD appends on
// delete. The DN-escaped form "\0ADEL:<guid>" is accepted as well.
func splitDeletedName(name string) (string, string) {
	for _, sep := range []string{"\nDEL:", "\\0ADEL:", "\\0aDEL:"} {
		if i := strings.Index(name, sep); i >= 0 {
			return name[:i], name[i+len(sep):]
		}
	}
	return name, ""
}

// IsDeletedObjectDN reports whether dn names a deleted object or lies below
// one (its RDN carries the "\0ADEL:" mangling).
func IsDeletedObjectDN(dn string) bool {
	lower := strings.ToLower(dn)
	return strings.Contains(lower, "\\0adel:") || strings.Contains(lower, "\ndel:")
}

// deletedRDN returns the RDN attribute type of dn and its value without the
// deleted-object suffix.
func deletedRDN(dn string) (string, string) {
	if parsed, err := goldap.ParseDN(dn); err == nil && len(parsed.RDNs) > 0 && len(parsed.RDNs[0].Attributes) > 0 {
		a := parsed.RDNs[0].Attributes[0]
		v, _ := splitDeletedName(a.Value)
		return a.Type, v
	}
	first := dn
	if i := recycleRDNSeparator(dn); i >= 0 {
		first = dn[:i]
	}
	typ, val, ok := strings.Cut(first, "=")
	if !ok {
		return "", ""
	}
	v, _ := splitDeletedName(val)
	return strings.TrimSpace(typ), v
}

// BuildRestoreDN builds the DN "<rdnAttr>=<escaped name>,<parentDN>".
func BuildRestoreDN(rdnAttr, name, parentDN string) string {
	return rdnAttr + "=" + goldap.EscapeDN(name) + "," + parentDN
}

// recycleTimeRFC3339 converts an LDAP GeneralizedTime
// ("20261029225435.0Z") to RFC 3339; unparsable values are returned as is.
func recycleTimeRFC3339(v string) string {
	if v == "" {
		return ""
	}
	for _, layout := range []string{"20060102150405.0Z", "20060102150405Z", "20060102150405.0Z0700", "20060102150405Z0700"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t.UTC().Format(time.RFC3339)
		}
	}
	return v
}

// LiveEntryExists reports whether the (live) entry dn exists; a referral
// counts as existing. Used for restore targets and after a failed tree
// delete.
func (c *Client) LiveEntryExists(dn string) (bool, error) {
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases, 0, 0, false,
		"(objectClass=*)", []string{"1.1"}, nil)
	entries, err := c.SearchWithControls(req, 0)
	if err != nil {
		if goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject) {
			return false, nil
		}
		if goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
			return true, nil
		}
		return false, err
	}
	return len(entries) > 0, nil
}

// DeletedObjectNamingContext returns the naming context of a deleted object
// below "CN=Deleted Objects,<nc>", or "" for other DNs.
func DeletedObjectNamingContext(dn string) string {
	container := RecycleParentDN(dn)
	if rdnType, rdnValue := deletedRDN(container); strings.EqualFold(rdnType, "CN") && strings.EqualFold(rdnValue, "Deleted Objects") {
		return RecycleParentDN(container)
	}
	return ""
}

// SAMAccountNameUser returns the DN of a live object below baseDN whose
// sAMAccountName is sam, or "" if there is none. AD refuses a restore that
// would duplicate a sAMAccountName, Samba does not, so restores check first.
func (c *Client) SAMAccountNameUser(baseDN, sam string) (string, error) {
	req := goldap.NewSearchRequest(baseDN, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases, 1, 0, false,
		"(sAMAccountName="+goldap.EscapeFilter(sam)+")", []string{"1.1"}, nil)
	entries, err := c.SearchWithControls(req, 0)
	if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
		return "", err
	}
	if len(entries) > 0 {
		return entries[0].DN, nil
	}
	return "", nil
}

// RestoreDeletedObject reanimates the deleted object dn as targetDN with one
// Modify request sent with the Show Deleted control: it deletes isDeleted and
// replaces distinguishedName. The error unwraps to the go-ldap error (see
// ClassifyRestoreError).
func (c *Client) RestoreDeletedObject(dn, targetDN string) error {
	if dn == "" || targetDN == "" {
		return errors.New("restore deleted object failed: DN and target DN are required")
	}
	start := time.Now()
	req := goldap.NewModifyRequest(dn, showDeletedControls(false))
	req.Delete("isDeleted", nil)
	req.Replace("distinguishedName", []string{targetDN})

	err := c.write(func(conn *goldap.Conn) error {
		return conn.Modify(req)
	})
	if errors.Is(err, ErrNotConnected) || errors.Is(err, ErrReadOnly) {
		return err
	}
	c.logger.Log("RESTORE", fmt.Sprintf("dn=%s target=%s", dn, targetDN), time.Since(start), err)
	return writeError("restore deleted object", err)
}

// ClassifyRestoreError maps a failed restore to a models.RestoreErr* kind.
func ClassifyRestoreError(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrReadOnly):
		return models.RestoreErrReadOnly
	case goldap.IsErrorWithCode(err, goldap.LDAPResultEntryAlreadyExists),
		goldap.IsErrorWithCode(err, goldap.LDAPResultConstraintViolation),
		goldap.IsErrorWithCode(err, goldap.LDAPResultAttributeOrValueExists):
		return models.RestoreErrConflict
	case goldap.IsErrorWithCode(err, goldap.LDAPResultInsufficientAccessRights):
		return models.RestoreErrPermission
	case goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject):
		return models.RestoreErrParentMissing
	case goldap.IsErrorWithCode(err, goldap.LDAPResultNamingViolation),
		goldap.IsErrorWithCode(err, goldap.LDAPResultObjectClassViolation),
		goldap.IsErrorWithCode(err, goldap.LDAPResultInvalidDNSyntax),
		goldap.IsErrorWithCode(err, goldap.LDAPResultAffectsMultipleDSAs):
		return models.RestoreErrInvalidTarget
	case goldap.IsErrorWithCode(err, goldap.LDAPResultUnwillingToPerform):
		return models.RestoreErrNotRestorable
	}
	return models.RestoreErrOther
}

// CountDescendants counts the entries below dn (dn itself excluded), up to
// limit (<= 0: DefaultDescendantLimit); capped reports that there are more.
// The cap is enforced on the client, so at most limit+1 DNs are read even
// from servers that ignore size limits (Samba).
func (c *Client) CountDescendants(dn string, limit int) (count int, capped bool, err error) {
	if limit <= 0 {
		limit = DefaultDescendantLimit
	}
	req := goldap.NewSearchRequest(dn, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases, 0, 0, false,
		"(objectClass=*)", []string{"1.1"}, c.recycleSubtreeControls())
	// The subtree includes dn itself: read up to limit+1 entries.
	entries, capped, err := c.recycleSearchCapped(req, limit+1)
	if err != nil {
		return 0, false, err
	}
	// A server-side size limit below ours also ends as capped, with the
	// number actually seen.
	return max(len(entries)-1, 0), capped, nil
}

// ListSubtreeDNs returns the DNs of dn and all entries below it, ordered so
// that every entry comes before its parent (deepest first).
func (c *Client) ListSubtreeDNs(dn string) ([]string, error) {
	req := goldap.NewSearchRequest(dn, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases, 0, 0, false,
		"(objectClass=*)", []string{"1.1"}, c.recycleSubtreeControls())
	entries, err := c.SearchWithControls(req, uint32(c.pageSize()))
	if err != nil {
		return nil, err
	}
	dns := make([]string, 0, len(entries))
	for _, e := range entries {
		dns = append(dns, e.DN)
	}
	return SortDeepestFirst(dns), nil
}

// recycleSubtreeControls returns ManageDsaIT when the server supports it, so that
// referral objects inside a subtree are listed and deleted as entries.
func (c *Client) recycleSubtreeControls() []goldap.Control {
	if c.recycleHasControl(OIDManageDsaIT) {
		return []goldap.Control{goldap.NewControlManageDsaIT(true)}
	}
	return nil
}

// DeleteSubtreeEntry deletes one entry of a client-side subtree delete
// (with ManageDsaIT when supported).
func (c *Client) DeleteSubtreeEntry(dn string) error {
	return c.DeleteEntryWithControls(dn, c.recycleSubtreeControls()...)
}

// TreeDelete deletes dn and everything below it with the tree delete control
// in one request. AD deletes large trees in chunks and answers
// adminLimitExceeded until it is done, so the request is repeated then.
func (c *Client) TreeDelete(dn string) error {
	ctrl := goldap.NewControlString(OIDTreeDelete, true, "")
	var err error
	for attempt := 0; attempt < treeDeleteMaxAttempts; attempt++ {
		err = c.DeleteEntryWithControls(dn, ctrl)
		if err == nil || !goldap.IsErrorWithCode(err, goldap.LDAPResultAdminLimitExceeded) {
			return err
		}
	}
	return err
}

// SortDeepestFirst orders DNs by descending depth (number of RDNs), keeping
// the original order among DNs of the same depth, so that every entry comes
// before its ancestors.
func SortDeepestFirst(dns []string) []string {
	type item struct {
		dn    string
		depth int
	}
	items := make([]item, len(dns))
	for i, dn := range dns {
		items[i] = item{dn, recycleDNDepth(dn)}
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].depth > items[j].depth })
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.dn
	}
	return out
}

// recycleDNDepth returns the number of RDNs of dn.
func recycleDNDepth(dn string) int {
	if parsed, err := goldap.ParseDN(dn); err == nil {
		return len(parsed.RDNs)
	}
	if strings.TrimSpace(dn) == "" {
		return 0
	}
	n := 1
	rest := dn
	for {
		i := recycleRDNSeparator(rest)
		if i < 0 {
			return n
		}
		n++
		rest = rest[i+1:]
	}
}

// RecycleParentDN returns dn without its first RDN ("" for a single RDN), honouring
// backslash escapes and quoted values.
func RecycleParentDN(dn string) string {
	i := recycleRDNSeparator(dn)
	if i < 0 {
		return ""
	}
	return strings.TrimSpace(dn[i+1:])
}

// recycleRDNSeparator returns the index of the first RDN separator in dn
// (',' or ';' outside escapes and quotes), or -1.
func recycleRDNSeparator(dn string) int {
	inQuotes := false
	for i := 0; i < len(dn); i++ {
		switch dn[i] {
		case '\\':
			i++ // skip the escaped character (or first hex digit)
		case '"':
			inQuotes = !inQuotes
		case ',', ';':
			if !inQuotes {
				return i
			}
		}
	}
	return -1
}

// RecycleDNKey returns a comparison key for dn (case-insensitive, escapes and
// spacing normalized).
func RecycleDNKey(dn string) string {
	if parsed, err := goldap.ParseDN(dn); err == nil {
		return strings.ToLower(parsed.String())
	}
	return strings.ToLower(strings.TrimSpace(dn))
}
