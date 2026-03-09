package ldap

import (
	"crypto/tls"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// Client wraps an LDAP connection with convenience methods.
type Client struct {
	mu      sync.Mutex
	profile models.ConnectionProfile
	conn    *goldap.Conn
	logger  *Logger
}

// NewClient creates a new Client for the given connection profile.
func NewClient(profile models.ConnectionProfile) *Client {
	return &Client{
		profile: profile,
		logger:  NewLogger(),
	}
}

// Logger returns the client's operation logger.
func (c *Client) Logger() *Logger {
	return c.logger
}

// Profile returns the connection profile associated with this client.
func (c *Client) Profile() models.ConnectionProfile {
	return c.profile
}

// Connect establishes a connection to the LDAP server, handles TLS, and performs bind.
func (c *Client) Connect() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	start := time.Now()
	timeout := time.Duration(c.profile.Timeout) * time.Second
	if timeout == 0 {
		timeout = 10 * time.Second
	}

	tlsConfig := &tls.Config{
		InsecureSkipVerify: c.profile.TLSSkipVerify,
		ServerName:         c.profile.Host,
	}

	address := fmt.Sprintf("%s:%d", c.profile.Host, c.profile.Port)

	var conn *goldap.Conn
	var err error

	switch c.profile.TLSMode {
	case models.TLSSSL:
		conn, err = goldap.DialTLS("tcp", address, tlsConfig)
	case models.TLSStartTLS:
		conn, err = goldap.DialURL(fmt.Sprintf("ldap://%s", address))
		if err != nil {
			return fmt.Errorf("%w: %v", ErrConnectionFailed, err)
		}
		if err = conn.StartTLS(tlsConfig); err != nil {
			conn.Close()
			return fmt.Errorf("%w: StartTLS failed: %v", ErrConnectionFailed, err)
		}
	default:
		conn, err = goldap.DialURL(fmt.Sprintf("ldap://%s", address))
	}

	if err != nil {
		return fmt.Errorf("%w: %v", ErrConnectionFailed, err)
	}

	conn.SetTimeout(timeout)
	c.conn = conn

	// Perform bind
	switch c.profile.AuthMethod {
	case models.AuthSimple:
		if err := c.conn.Bind(c.profile.BindDN, c.profile.Password); err != nil {
			c.conn.Close()
			c.conn = nil
			bindErr := fmt.Errorf("%w: %s (bind DN: %s)", ErrBindFailed, ldapErrorDetail(err), c.profile.BindDN)
			c.logger.Log("BIND", fmt.Sprintf("Simple bind as %s to %s", c.profile.BindDN, address), time.Since(start), bindErr)
			return bindErr
		}
	case models.AuthNone:
		if err := c.conn.UnauthenticatedBind(""); err != nil {
			c.conn.Close()
			c.conn = nil
			bindErr := fmt.Errorf("%w: %s", ErrBindFailed, ldapErrorDetail(err))
			c.logger.Log("BIND", fmt.Sprintf("Anonymous bind to %s", address), time.Since(start), bindErr)
			return bindErr
		}
	}

	c.logger.Log("CONNECT", fmt.Sprintf("Connected to %s (TLS: %s, Auth: %s)", address, c.profile.TLSMode, c.profile.AuthMethod), time.Since(start), nil)
	return nil
}

// Close closes the LDAP connection.
func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn != nil {
		c.conn.Close()
		c.conn = nil
	}
}

// IsConnected returns true if the client has an active connection.
func (c *Client) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn != nil
}

// GetRootDSE reads the RootDSE entry and returns selected operational attributes.
// This provides AD forest information such as naming contexts.
func (c *Client) GetRootDSE() (*models.LDAPEntry, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return nil, ErrNotConnected
	}

	searchReq := goldap.NewSearchRequest(
		"",
		goldap.ScopeBaseObject,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=*)",
		[]string{
			"namingContexts",
			"defaultNamingContext",
			"rootDomainNamingContext",
			"configurationNamingContext",
			"schemaNamingContext",
			"dnsHostName",
			"forestFunctionality",
			"domainFunctionality",
			"domainControllerFunctionality",
			"serverName",
		},
		nil,
	)

	result, err := c.conn.Search(searchReq)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrSearchFailed, ldapErrorDetail(err))
	}
	if len(result.Entries) == 0 {
		return nil, fmt.Errorf("%w: RootDSE", ErrNotFound)
	}

	return convertEntry(result.Entries[0]), nil
}

// GetForestPartitions queries CN=Partitions,CN=Configuration,... to discover all
// domains and partitions in the AD forest, including child domains hosted on other DCs.
// Returns a list of nCName values (the DN of each partition).
func (c *Client) GetForestPartitions(configNC string) ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return nil, ErrNotConnected
	}

	partitionsDN := "CN=Partitions," + configNC

	searchReq := goldap.NewSearchRequest(
		partitionsDN,
		goldap.ScopeSingleLevel,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=crossRef)",
		[]string{"nCName", "dnsRoot", "systemFlags"},
		nil,
	)

	result, err := c.conn.Search(searchReq)
	if err != nil {
		// If referrals are disabled, still try to use partial results
		if c.profile.DisableReferrals && goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
			if result == nil {
				return nil, nil
			}
		} else {
			return nil, fmt.Errorf("%w: %s", ErrSearchFailed, ldapErrorDetail(err))
		}
	}

	var partitions []string
	for _, entry := range result.Entries {
		ncName := entry.GetAttributeValue("nCName")
		if ncName != "" {
			partitions = append(partitions, ncName)
		}
	}

	return partitions, nil
}

// GetChildren performs a one-level search under parentDN and returns tree nodes.
// Uses paged results to handle containers with large numbers of children.
// If the server returns a referral and referral following is enabled,
// it connects to the referred server to fetch the children.
func (c *Client) GetChildren(parentDN string) ([]models.TreeNode, error) {
	c.mu.Lock()

	if c.conn == nil {
		c.mu.Unlock()
		return nil, ErrNotConnected
	}

	childAttrs := []string{"dn", "objectClass", "hasSubordinates", "msDS-Approx-Immed-Subordinates"}

	pageSize := c.profile.PageSize
	if pageSize <= 0 {
		pageSize = 500
	}

	searchReq := goldap.NewSearchRequest(
		parentDN,
		goldap.ScopeSingleLevel,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=*)",
		childAttrs,
		[]goldap.Control{goldap.NewControlPaging(uint32(pageSize))},
	)

	var allEntries []*goldap.Entry

	for {
		result, err := c.conn.Search(searchReq)
		if err != nil {
			if goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
				// Partial results are still useful
				if result != nil {
					allEntries = append(allEntries, result.Entries...)
				}
				break
			}
			if goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
				if c.profile.DisableReferrals {
					c.mu.Unlock()
					if result != nil {
						allEntries = append(allEntries, result.Entries...)
					}
					return c.entriesToTreeNodes(allEntries), nil
				}
				refs := extractReferralURLs(err)
				c.mu.Unlock()
				if len(refs) > 0 {
					return c.followReferralGetChildren(refs[0])
				}
				return nil, fmt.Errorf("%w: %s (referral with no URL)", ErrSearchFailed, parentDN)
			}
			c.mu.Unlock()
			return nil, fmt.Errorf("%w: %s", ErrSearchFailed, ldapErrorDetail(err))
		}

		allEntries = append(allEntries, result.Entries...)

		// Check for paging control in response
		pagingControl := goldap.FindControl(result.Controls, goldap.ControlTypePaging)
		if pagingCtrl, ok := pagingControl.(*goldap.ControlPaging); ok && len(pagingCtrl.Cookie) > 0 {
			searchReq.Controls = []goldap.Control{goldap.NewControlPaging(uint32(pageSize))}
			if ctrl := goldap.FindControl(searchReq.Controls, goldap.ControlTypePaging); ctrl != nil {
				ctrl.(*goldap.ControlPaging).SetCookie(pagingCtrl.Cookie)
			}
			continue
		}
		break
	}

	c.mu.Unlock()
	return c.entriesToTreeNodes(allEntries), nil
}

// followReferralGetChildren follows a referral URL to fetch children from a remote server.
func (c *Client) followReferralGetChildren(referralURL string) ([]models.TreeNode, error) {
	childAttrs := []string{"dn", "objectClass", "hasSubordinates", "msDS-Approx-Immed-Subordinates"}
	entries, err := c.followReferralSearch(referralURL, goldap.ScopeSingleLevel, "(objectClass=*)", childAttrs, 0)
	if err != nil {
		return nil, err
	}
	return c.entriesToTreeNodes(entries), nil
}

// entriesToTreeNodes converts raw LDAP entries to TreeNode slice.
func (c *Client) entriesToTreeNodes(entries []*goldap.Entry) []models.TreeNode {
	nodes := make([]models.TreeNode, 0, len(entries))
	for _, entry := range entries {
		objectClasses := entry.GetAttributeValues("objectClass")
		hasSubStr := entry.GetAttributeValue("hasSubordinates")
		approxChildren := entry.GetAttributeValue("msDS-Approx-Immed-Subordinates")

		hasChildren := false
		if strings.EqualFold(hasSubStr, "TRUE") {
			hasChildren = true
		} else if approxChildren != "" && approxChildren != "0" {
			hasChildren = true
		} else if hasSubStr == "" && approxChildren == "" {
			hasChildren = c.probeHasChildren(entry.DN)
		}

		icon := determineIcon(objectClasses)
		rdn := extractRDN(entry.DN)

		nodes = append(nodes, models.TreeNode{
			DN:          entry.DN,
			RDN:         rdn,
			HasChildren: hasChildren,
			ObjectClass: objectClasses,
			Icon:        icon,
		})
	}
	return nodes
}

// probeHasChildren checks whether a DN has any children by doing a size-limited one-level search.
func (c *Client) probeHasChildren(dn string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return false
	}
	searchReq := goldap.NewSearchRequest(
		dn,
		goldap.ScopeSingleLevel,
		goldap.NeverDerefAliases,
		1, 5, false,
		"(objectClass=*)",
		[]string{"dn"},
		nil,
	)
	result, err := c.conn.Search(searchReq)
	if err != nil {
		return false
	}
	return len(result.Entries) > 0
}

// GetEntry retrieves a single entry by DN with all its attributes.
// If the server returns a referral and referral following is enabled,
// it connects to the referred server to fetch the entry.
func (c *Client) GetEntry(dn string) (*models.LDAPEntry, error) {
	c.mu.Lock()

	if c.conn == nil {
		c.mu.Unlock()
		return nil, ErrNotConnected
	}

	searchReq := goldap.NewSearchRequest(
		dn,
		goldap.ScopeBaseObject,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=*)",
		[]string{"*", "+"},
		nil,
	)

	result, err := c.conn.Search(searchReq)
	if err != nil {
		// Try to follow referral if not disabled
		if !c.profile.DisableReferrals && goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
			refs := extractReferralURLs(err)
			c.mu.Unlock()
			if len(refs) > 0 {
				return c.followReferralGetEntry(refs[0])
			}
			return nil, fmt.Errorf("%w: %s (referral with no URL)", ErrSearchFailed, dn)
		}
		c.mu.Unlock()
		return nil, fmt.Errorf("%w: %s", ErrSearchFailed, ldapErrorDetail(err))
	}

	if len(result.Entries) == 0 {
		c.mu.Unlock()
		return nil, fmt.Errorf("%w: %s", ErrNotFound, dn)
	}

	entry := result.Entries[0]
	c.resolveRangedAttributes(dn, entry)
	c.mu.Unlock()
	return convertEntry(entry), nil
}

// resolveRangedAttributes detects AD range-retrieved attributes (e.g. member;range=0-1499)
// and fetches all remaining chunks, merging them into a single attribute.
func (c *Client) resolveRangedAttributes(dn string, entry *goldap.Entry) {
	for i, attr := range entry.Attributes {
		baseName, _, endVal, isFinal, ok := parseRangeAttr(attr.Name)
		if !ok || isFinal {
			continue
		}

		// Collect all values starting with what we already have
		allValues := make([]string, len(attr.Values))
		copy(allValues, attr.Values)
		allByteValues := make([][]byte, len(attr.ByteValues))
		copy(allByteValues, attr.ByteValues)

		currentEnd := endVal
		done := false
		for iter := 0; iter < 1000 && !done; iter++ {
			nextStart := currentEnd + 1
			rangeAttr := fmt.Sprintf("%s;range=%d-*", baseName, nextStart)

			req := goldap.NewSearchRequest(
				dn,
				goldap.ScopeBaseObject,
				goldap.NeverDerefAliases,
				0, 0, false,
				"(objectClass=*)",
				[]string{rangeAttr},
				nil,
			)

			res, err := c.conn.Search(req)
			if err != nil || len(res.Entries) == 0 {
				break
			}

			// Find the returned range attribute
			found := false
			for _, a := range res.Entries[0].Attributes {
				_, _, nextEnd, nextFinal, isRange := parseRangeAttr(a.Name)
				if !isRange && strings.EqualFold(a.Name, baseName) {
					// Server returned the bare attribute name — this is the final chunk
					allValues = append(allValues, a.Values...)
					allByteValues = append(allByteValues, a.ByteValues...)
					found = true
					done = true
					break
				}
				if isRange {
					allValues = append(allValues, a.Values...)
					allByteValues = append(allByteValues, a.ByteValues...)
					found = true
					if nextFinal {
						done = true
					} else {
						currentEnd = nextEnd
					}
					break
				}
			}

			if !found {
				break
			}
		}

		// Replace the ranged attribute with the merged result
		entry.Attributes[i].Name = baseName
		entry.Attributes[i].Values = allValues
		entry.Attributes[i].ByteValues = allByteValues
	}
}

// parseRangeAttr parses "member;range=0-1499" into ("member", 0, 1499, false, true).
// For the terminal form "member;range=1500-*", isFinal is true.
// Returns ok=false if the attribute name has no range option.
func parseRangeAttr(name string) (baseName string, start int, end int, isFinal bool, ok bool) {
	idx := strings.Index(strings.ToLower(name), ";range=")
	if idx < 0 {
		return name, 0, 0, false, false
	}

	baseName = name[:idx]
	rangeSpec := name[idx+7:] // after ";range="

	parts := strings.SplitN(rangeSpec, "-", 2)
	if len(parts) != 2 {
		return baseName, 0, 0, false, false
	}

	var s int
	fmt.Sscanf(parts[0], "%d", &s)

	if parts[1] == "*" {
		return baseName, s, 0, true, true
	}

	var e int
	fmt.Sscanf(parts[1], "%d", &e)
	return baseName, s, e, false, true
}

// Search performs a full LDAP search with the given parameters.
// If the server returns a referral and referral following is enabled,
// it connects to the referred server to perform the search there.
func (c *Client) Search(params models.SearchParams) (*models.SearchResult, error) {
	c.mu.Lock()

	if c.conn == nil {
		c.mu.Unlock()
		return nil, ErrNotConnected
	}
	searchStart := time.Now()

	if params.Filter == "" {
		params.Filter = "(objectClass=*)"
	}

	attrs := params.Attributes
	if len(attrs) == 0 {
		attrs = []string{"*"}
	}

	pageSize := c.profile.PageSize
	if pageSize <= 0 {
		pageSize = 500
	}

	searchReq := goldap.NewSearchRequest(
		params.BaseDN,
		int(params.Scope),
		goldap.NeverDerefAliases,
		params.SizeLimit,
		params.TimeLimit,
		false,
		params.Filter,
		attrs,
		[]goldap.Control{goldap.NewControlPaging(uint32(pageSize))},
	)

	var allEntries []*goldap.Entry
	truncated := false

	for {
		result, err := c.conn.Search(searchReq)
		if err != nil {
			// Check for size limit exceeded - partial results are still useful
			if goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
				truncated = true
				if result != nil {
					allEntries = append(allEntries, result.Entries...)
				}
				break
			}
			if goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
				if c.profile.DisableReferrals {
					if result != nil {
						allEntries = append(allEntries, result.Entries...)
					}
					break
				}
				// Follow referral
				refs := extractReferralURLs(err)
				c.mu.Unlock()
				if len(refs) > 0 {
					refEntries, refErr := c.followReferralSearch(
						refs[0], int(params.Scope), params.Filter, attrs, params.SizeLimit,
					)
					if refErr == nil {
						allEntries = append(allEntries, refEntries...)
					}
				}
				goto buildResult
			}
			c.mu.Unlock()
			return nil, fmt.Errorf("%w: %s", ErrSearchFailed, ldapErrorDetail(err))
		}

		allEntries = append(allEntries, result.Entries...)

		// Check for paging control in response
		pagingControl := goldap.FindControl(result.Controls, goldap.ControlTypePaging)
		if pagingCtrl, ok := pagingControl.(*goldap.ControlPaging); ok && len(pagingCtrl.Cookie) > 0 {
			searchReq.Controls = []goldap.Control{goldap.NewControlPaging(uint32(pageSize))}
			// Set the cookie for the next page
			if ctrl := goldap.FindControl(searchReq.Controls, goldap.ControlTypePaging); ctrl != nil {
				ctrl.(*goldap.ControlPaging).SetCookie(pagingCtrl.Cookie)
			}
			continue
		}
		break
	}
	c.mu.Unlock()

buildResult:

	entries := make([]models.LDAPEntry, 0, len(allEntries))
	for _, e := range allEntries {
		entries = append(entries, *convertEntry(e))
	}

	c.logger.Log("SEARCH", fmt.Sprintf("base=%s scope=%d filter=%s -> %d entries", params.BaseDN, params.Scope, params.Filter, len(entries)), time.Since(searchStart), nil)

	return &models.SearchResult{
		Entries:    entries,
		TotalCount: len(entries),
		Truncated:  truncated,
	}, nil
}

// AddEntry creates a new LDAP entry with the given DN and attributes.
func (c *Client) AddEntry(dn string, attrs []models.LDAPAttribute) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return ErrNotConnected
	}

	start := time.Now()
	addReq := goldap.NewAddRequest(dn, nil)
	for _, attr := range attrs {
		addReq.Attribute(attr.Name, attr.Values)
	}

	err := c.conn.Add(addReq)
	c.logger.Log("ADD", fmt.Sprintf("dn=%s", dn), time.Since(start), err)
	if err != nil {
		return fmt.Errorf("add entry failed: %s", ldapErrorDetail(err))
	}
	return nil
}

// ModifyAttribute replaces the values of an attribute on an entry.
// For AD unicodePwd, the value is automatically encoded as UTF-16LE with quotes.
func (c *Client) ModifyAttribute(dn string, attrName string, values []string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return ErrNotConnected
	}

	start := time.Now()
	modReq := goldap.NewModifyRequest(dn, nil)

	if strings.EqualFold(attrName, "unicodePwd") {
		// AD requires unicodePwd as UTF-16LE encoded, quoted string
		for _, v := range values {
			encoded := encodeUnicodePwd(v)
			modReq.Changes = append(modReq.Changes, goldap.Change{
				Operation: goldap.ReplaceAttribute,
				Modification: goldap.PartialAttribute{
					Type: "unicodePwd",
					Vals: []string{string(encoded)},
				},
			})
		}
	} else {
		modReq.Replace(attrName, values)
	}

	err := c.conn.Modify(modReq)
	c.logger.Log("MODIFY", fmt.Sprintf("dn=%s attr=%s", dn, attrName), time.Since(start), err)
	if err != nil {
		return fmt.Errorf("modify %q failed: %s", attrName, ldapErrorDetail(err))
	}
	return nil
}

// encodeUnicodePwd encodes a password for AD's unicodePwd attribute.
// AD expects the password enclosed in quotes and encoded as UTF-16LE.
func encodeUnicodePwd(password string) []byte {
	quoted := "\"" + password + "\""
	encoded := make([]byte, len(quoted)*2)
	for i, ch := range quoted {
		encoded[i*2] = byte(ch & 0xFF)
		encoded[i*2+1] = byte(ch >> 8)
	}
	return encoded
}

// AddAttribute adds values to an attribute on an entry.
func (c *Client) AddAttribute(dn string, attrName string, values []string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return ErrNotConnected
	}

	start := time.Now()
	modReq := goldap.NewModifyRequest(dn, nil)
	modReq.Add(attrName, values)
	err := c.conn.Modify(modReq)
	c.logger.Log("ADD_ATTR", fmt.Sprintf("dn=%s attr=%s", dn, attrName), time.Since(start), err)
	if err != nil {
		return fmt.Errorf("add attribute %q failed: %s", attrName, ldapErrorDetail(err))
	}
	return nil
}

// DeleteAttribute removes an attribute from an entry.
func (c *Client) DeleteAttribute(dn string, attrName string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return ErrNotConnected
	}

	start := time.Now()
	modReq := goldap.NewModifyRequest(dn, nil)
	modReq.Delete(attrName, []string{})
	err := c.conn.Modify(modReq)
	c.logger.Log("DEL_ATTR", fmt.Sprintf("dn=%s attr=%s", dn, attrName), time.Since(start), err)
	if err != nil {
		return fmt.Errorf("delete attribute %q failed: %s", attrName, ldapErrorDetail(err))
	}
	return nil
}

// DeleteEntry removes an entry by DN.
func (c *Client) DeleteEntry(dn string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return ErrNotConnected
	}

	start := time.Now()
	delReq := goldap.NewDelRequest(dn, nil)
	err := c.conn.Del(delReq)
	c.logger.Log("DELETE", fmt.Sprintf("dn=%s", dn), time.Since(start), err)
	if err != nil {
		return fmt.Errorf("delete entry failed: %s", ldapErrorDetail(err))
	}
	return nil
}

// RenameEntry renames or moves an LDAP entry.
func (c *Client) RenameEntry(dn string, newRDN string, deleteOldRDN bool, newSuperior string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return ErrNotConnected
	}

	start := time.Now()
	modDNReq := goldap.NewModifyDNRequest(dn, newRDN, deleteOldRDN, newSuperior)
	err := c.conn.ModifyDN(modDNReq)
	c.logger.Log("RENAME", fmt.Sprintf("dn=%s newRDN=%s newSuperior=%s", dn, newRDN, newSuperior), time.Since(start), err)
	if err != nil {
		return fmt.Errorf("rename entry failed: %s", ldapErrorDetail(err))
	}
	return nil
}

// convertEntry converts a go-ldap Entry to our models.LDAPEntry.
func convertEntry(entry *goldap.Entry) *models.LDAPEntry {
	attrs := make([]models.LDAPAttribute, 0, len(entry.Attributes))
	for _, a := range entry.Attributes {
		isBinary := len(a.ByteValues) > 0 && !isPrintable(a.ByteValues)

		values := a.Values
		if isBinary {
			if formatted := formatBinaryAttr(a.Name, a.ByteValues); formatted != nil {
				values = formatted
				isBinary = false
			}
		}

		attrs = append(attrs, models.LDAPAttribute{
			Name:   a.Name,
			Values: values,
			Binary: isBinary,
		})
	}
	return &models.LDAPEntry{
		DN:         entry.DN,
		Attributes: attrs,
	}
}

// isPrintable checks if byte values appear to be printable text.
func isPrintable(byteValues [][]byte) bool {
	for _, bv := range byteValues {
		for _, b := range bv {
			if b < 0x20 && b != '\n' && b != '\r' && b != '\t' {
				return false
			}
		}
	}
	return true
}

// determineIcon returns an icon name based on objectClass values.
func determineIcon(objectClasses []string) string {
	for _, oc := range objectClasses {
		lower := strings.ToLower(oc)
		switch lower {
		case "person", "inetorgperson", "user", "organizationalperson":
			return "user"
		case "group", "groupofnames", "groupofuniquenames", "posixgroup":
			return "users"
		case "organizationalunit":
			return "folder"
		case "organization":
			return "building"
		case "domain", "domaindns", "dcobject":
			return "globe"
		case "computer":
			return "monitor"
		case "container", "builtindomain", "lostandfound":
			return "box"
		case "grouppolicycontainer":
			return "settings"
		case "printqueue":
			return "printer"
		case "volume":
			return "harddrive"
		case "server":
			return "server"
		case "contact":
			return "contact"
		case "foreignsecurityprincipal":
			return "shield"
		case "subnet":
			return "network"
		case "site", "sitelink":
			return "landmark"
		case "ntsdsservice", "ntdsdsa":
			return "database"
		case "msds-managedserviceaccount", "msds-groupmanagedserviceaccount":
			return "usercog"
		}
	}
	return "file"
}

// extractRDN extracts the first RDN component from a full DN.
func extractRDN(dn string) string {
	parsed, err := goldap.ParseDN(dn)
	if err != nil || len(parsed.RDNs) == 0 {
		// Fallback: just take everything before the first unescaped comma
		parts := strings.SplitN(dn, ",", 2)
		return parts[0]
	}
	// Reconstruct the first RDN from its attributes
	parts := make([]string, 0, len(parsed.RDNs[0].Attributes))
	for _, attr := range parsed.RDNs[0].Attributes {
		parts = append(parts, fmt.Sprintf("%s=%s", attr.Type, attr.Value))
	}
	return strings.Join(parts, "+")
}
