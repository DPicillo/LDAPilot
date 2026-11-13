package services

import (
	"fmt"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/ldif"
	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// What an LDIF import adapts in add records instead of letting the server
// refuse them (models.LDIFImportOptions): attributes the server maintains,
// attribute types and object classes its schema does not define, DN values
// of missing entries on Active Directory, and add records of entries that
// exist already. The planning here is pure; the simulator (bulk_ldif.go)
// supplies existence and the current entries.

// ldifImportSettings are the normalized options of a run plus the server
// facts the planning needs.
type ldifImportSettings struct {
	opts       models.LDIFImportOptions
	serverType string
	// tls is true when the connection is encrypted (LDAPS / StartTLS).
	tls bool
}

// normalizeLDIFImportOptions fills the defaults and refuses unknown values.
func normalizeLDIFImportOptions(o models.LDIFImportOptions) (models.LDIFImportOptions, error) {
	pick := func(field, v, def string, allowed ...string) (string, error) {
		v = strings.ToLower(strings.TrimSpace(v))
		if v == "" {
			return def, nil
		}
		for _, a := range allowed {
			if v == a {
				return v, nil
			}
		}
		return "", fmt.Errorf("unknown import option %s %q", field, v)
	}
	var err error
	out := models.LDIFImportOptions{}
	if out.ServerAttributes, err = pick("serverAttributes", o.ServerAttributes, models.LDIFImportOmit, models.LDIFImportOmit, models.LDIFImportSend); err != nil {
		return out, err
	}
	if out.UnknownSchema, err = pick("unknownSchema", o.UnknownSchema, models.LDIFImportOmit, models.LDIFImportOmit, models.LDIFImportSend); err != nil {
		return out, err
	}
	if out.MissingReferences, err = pick("missingReferences", o.MissingReferences, models.LDIFImportOmit, models.LDIFImportOmit, models.LDIFImportSend); err != nil {
		return out, err
	}
	if out.Existing, err = pick("existing", o.Existing, models.LDIFExistingSkip, models.LDIFExistingSkip, models.LDIFExistingUpdate, models.LDIFExistingFail); err != nil {
		return out, err
	}
	return out, nil
}

// newLDIFImportSettings resolves the settings of a run on client.
func newLDIFImportSettings(client *ldap.Client, o models.LDIFImportOptions) (ldifImportSettings, error) {
	opts, err := normalizeLDIFImportOptions(o)
	if err != nil {
		return ldifImportSettings{}, err
	}
	set := ldifImportSettings{opts: opts}
	if info, err := client.ServerInfo(); err == nil && info != nil {
		set.serverType = info.ServerType
	}
	p := client.Profile()
	set.tls = p.TLSMode == models.TLSSSL || p.TLSMode == models.TLSStartTLS
	return set, nil
}

// ldifRelaxSettable are the server-maintained attributes OpenLDAP stores
// from an add request with the Relax Rules control (checked on 2.4.57;
// entryCSN, structuralObjectClass, entryDN, hasSubordinates and
// subschemaSubentry are refused even then).
var ldifRelaxSettable = map[string]bool{
	"entryuuid": true, "createtimestamp": true, "creatorsname": true, "modifytimestamp": true, "modifiersname": true,
	"pwdchangedtime": true, "pwdhistory": true, "pwdfailuretime": true, "pwdgraceusetime": true,
}

// ldif389Assigned are the server-maintained attributes 389 Directory Server
// accepts in an add request but replaces with its own values (or refuses).
var ldif389Assigned = map[string]bool{
	"nsuniqueid": true, "entryuuid": true, "createtimestamp": true, "creatorsname": true, "modifytimestamp": true,
	"modifiersname": true, "entryid": true, "parentid": true, "numsubordinates": true, "dsentrydn": true,
	"entrydn": true, "nscpentrydn": true, "hassubordinates": true, "subschemasubentry": true, "entrycsn": true,
	"nsparentuniqueid": true, "structuralobjectclass": true, "contextcsn": true,
}

// ldifADSettable are the server-maintained attributes Active Directory
// stores from an import (pwdLastSet: only 0 and -1, see ldifADPwdLastSet).
var ldifADSettable = map[string]bool{"ntsecuritydescriptor": true}

// ldifServerAttr is how an import treats a server-maintained attribute.
type ldifServerAttr int

const (
	ldifUserAttr    ldifServerAttr = iota // an ordinary attribute: sent
	ldifSettable                          // maintained, stored when sent on request
	ldifSettableRlx                       // maintained, stored when sent with the Relax Rules control
	ldifNeverSent                         // maintained; the server refuses it or assigns its own value
)

// attrBase is the lower-case attribute type of a description without options.
func attrBase(name string) string {
	base := strings.ToLower(strings.TrimSpace(name))
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = base[:i]
	}
	return base
}

// ldifADPwdLastSet reports an AD pwdLastSet the server accepts in an add:
// 0 (must change the password at the next logon) or -1.
func ldifADPwdLastSet(a models.LDAPAttribute) bool {
	return len(a.Values) == 1 && (a.Values[0] == "0" || a.Values[0] == "-1")
}

// classifyServerAttribute tells whether attribute a of an add record is
// maintained by a server of serverType and, if so, whether an import can
// set it; reason explains a never-sent attribute.
func classifyServerAttribute(a models.LDAPAttribute, serverType string, sc *schemaContext) (ldifServerAttr, string) {
	base := attrBase(a.Name)
	if base == "objectclass" {
		return ldifUserAttr, ""
	}
	if serverType == models.ServerTypeAD && base == "pwdlastset" && ldifADPwdLastSet(a) {
		return ldifUserAttr, ""
	}
	maintained := !ldif.IsImportableAttribute(base, nil) || sc.lookup(base).noUserMod
	if !maintained {
		return ldifUserAttr, ""
	}
	// Back-links (memberOf, directReports, …) are never sent: a value from a
	// file would only contradict the other entries.
	if ldif.IsBackLinkAttribute(base) {
		return ldifNeverSent, "the server derives it from other entries (group members, manager)"
	}
	switch serverType {
	case models.ServerTypeOpenLDAP:
		if ldifRelaxSettable[base] {
			return ldifSettableRlx, ""
		}
		return ldifNeverSent, "OpenLDAP does not let an import set it, not even with the Relax Rules control"
	case models.ServerType389DS:
		if ldif389Assigned[base] {
			return ldifNeverSent, "389 Directory Server assigns it itself"
		}
		return ldifSettable, ""
	case models.ServerTypeAD:
		if ldifADSettable[base] {
			return ldifSettable, ""
		}
		if base == "pwdlastset" {
			return ldifNeverSent, "Active Directory accepts only 0 (must change the password) or -1"
		}
		return ldifNeverSent, "Active Directory assigns or maintains it itself"
	}
	// Unknown server type: send it and let the server decide.
	return ldifSettableRlx, ""
}

// ldifRefState is what an import knows about the entry a DN value refers to.
type ldifRefState int

const (
	ldifRefUnknown ldifRefState = iota // cannot tell: the value is sent
	ldifRefExists                      // exists (on the server or created by an earlier record)
	ldifRefMissing                     // does not exist
	ldifRefLater                       // created by a later add record of the file
)

// ldifAddPlan is an add record adapted for the server.
type ldifAddPlan struct {
	attrs       []models.LDAPAttribute
	adjustments []models.LDIFAdjustment
	errors      []string
	// deferred are DN values of entries a later record creates: added to the
	// entry with a modify at the end of the run (Active Directory).
	deferred []models.AttributeChange
	// relax: the add is sent with the Relax Rules control (OpenLDAP keeps
	// server-maintained attributes).
	relax bool
}

// ldifAdjustmentGroup collects names / values of one kind and reason.
type ldifAdjustmentGroup struct {
	kind   string
	reason string
	attrs  []string
	values []string
}

// ldifAdjuster collects the adjustments of one record, grouped by kind and
// reason in the order they first appear.
type ldifAdjuster struct {
	groups []*ldifAdjustmentGroup
}

func (a *ldifAdjuster) add(kind, reason, attr string, values ...string) {
	var g *ldifAdjustmentGroup
	for _, x := range a.groups {
		if x.kind == kind && x.reason == reason {
			g = x
			break
		}
	}
	if g == nil {
		g = &ldifAdjustmentGroup{kind: kind, reason: reason}
		a.groups = append(a.groups, g)
	}
	known := false
	for _, n := range g.attrs {
		if strings.EqualFold(n, attr) {
			known = true
		}
	}
	if !known {
		g.attrs = append(g.attrs, attr)
	}
	g.values = append(g.values, values...)
}

func (a *ldifAdjuster) result() []models.LDIFAdjustment {
	out := make([]models.LDIFAdjustment, 0, len(a.groups))
	for _, g := range a.groups {
		out = append(out, models.LDIFAdjustment{Kind: g.kind, Attributes: g.attrs, Values: g.values, Reason: g.reason, Text: ldifAdjustmentText(g)})
	}
	return out
}

// ldifAdjustmentText is the sentence of an adjustment group.
func ldifAdjustmentText(g *ldifAdjustmentGroup) string {
	names := strings.Join(g.attrs, ", ")
	switch g.kind {
	case models.LDIFAdjustServerOmitted:
		return "Left out " + names + ": " + g.reason
	case models.LDIFAdjustServerSent:
		return "Sent " + names + " (maintained by the server): " + g.reason
	case models.LDIFAdjustUnknownOmitted:
		return "Left out " + names + ": " + g.reason
	case models.LDIFAdjustClassOmitted:
		return "Left out object class " + strings.Join(g.values, ", ") + ": " + g.reason
	case models.LDIFAdjustRefOmitted:
		return fmt.Sprintf("Left out %s %s: %s", names, ldifValueList(g.values), g.reason)
	case models.LDIFAdjustRefDeferred:
		return fmt.Sprintf("%s %s set at the end of the run: %s", names, ldifValueList(g.values), g.reason)
	}
	return g.reason
}

// ldifValueList names values for a sentence ("value X", "values X, Y", "3
// values (X, Y, …)").
func ldifValueList(values []string) string {
	switch {
	case len(values) == 1:
		return "value " + values[0]
	case len(values) <= 3:
		return "values " + strings.Join(values, "; ")
	}
	return fmt.Sprintf("%d values (%s; …)", len(values), strings.Join(values[:2], "; "))
}

const (
	ldifReasonServerOmitted = "maintained by the server (\"Send them\" under Server-maintained attributes keeps them where this server allows it)"
	ldifReasonForeign       = "maintained by the directory the file comes from; this server does not define it"
	ldifReasonUpdateServer  = "maintained by the server; an existing entry keeps its own values"
	ldifReasonUnknown       = "not defined in this server's schema"
	ldifReasonMissingRef    = "the entry does not exist on this server, and Active Directory refuses references to missing entries"
	ldifReasonDeferredRef   = "a later record of the file creates the entry, and Active Directory refuses references to entries that do not exist yet"
	ldifReasonRelax         = "sent with the Relax Rules control, which lets OpenLDAP keep them"
	ldifReasonSentOnRequest = "sent as requested"
)

// planLDIFAdd adapts the attributes of an add record (update: of the
// update of an existing entry, which never sends server-maintained
// attributes) with set. ref tells whether a referenced DN exists after the
// earlier records of the file; it is only used on Active Directory.
func planLDIFAdd(attrs []models.LDAPAttribute, set ldifImportSettings, sc *schemaContext, update bool, ref func(dn string) ldifRefState) ldifAddPlan {
	var plan ldifAddPlan
	adj := &ldifAdjuster{}
	checkSchema := sc.hasSchema
	for _, a := range attrs {
		base := attrBase(a.Name)
		// Attributes the server maintains (also the ones another server type
		// maintains that this one does not define: objectGUID on OpenLDAP).
		kind, reason := classifyServerAttribute(a, set.serverType, sc)
		if kind != ldifUserAttr {
			// OpenLDAP 2.4 does not publish entryCSN / contextCSN in its subschema.
			unknown := checkSchema && !sc.lookup(base).found && !(set.serverType == models.ServerTypeOpenLDAP && (base == "entrycsn" || base == "contextcsn"))
			switch {
			case update:
				adj.add(models.LDIFAdjustServerOmitted, ldifReasonUpdateServer, a.Name)
			case unknown:
				adj.add(models.LDIFAdjustServerOmitted, ldifReasonForeign, a.Name)
			case set.opts.ServerAttributes != models.LDIFImportSend:
				if kind != ldifNeverSent {
					reason = ldifReasonServerOmitted
				}
				adj.add(models.LDIFAdjustServerOmitted, reason, a.Name)
			case kind == ldifNeverSent:
				adj.add(models.LDIFAdjustServerOmitted, reason, a.Name)
			case kind == ldifSettableRlx:
				plan.relax = true
				adj.add(models.LDIFAdjustServerSent, ldifReasonRelax, a.Name)
				plan.attrs = append(plan.attrs, a)
			default:
				adj.add(models.LDIFAdjustServerSent, ldifReasonSentOnRequest, a.Name)
				plan.attrs = append(plan.attrs, a)
			}
			continue
		}
		// Attribute types the server does not know.
		if checkSchema && base != "objectclass" && !sc.lookup(base).found {
			if set.opts.UnknownSchema == models.LDIFImportSend {
				plan.errors = append(plan.errors, fmt.Sprintf("%s is not defined in this server's schema: the server refuses the record (choose \"Leave out\" under Unknown attributes and object classes)", a.Name))
				plan.attrs = append(plan.attrs, a)
				continue
			}
			adj.add(models.LDIFAdjustUnknownOmitted, ldifReasonUnknown, a.Name)
			continue
		}
		// Object classes the server does not know.
		if checkSchema && base == "objectclass" {
			kept := make([]string, 0, len(a.Values))
			var unknown []string
			for _, v := range a.Values {
				if sc.findClass(v) == nil {
					unknown = append(unknown, v)
					continue
				}
				kept = append(kept, v)
			}
			if len(unknown) > 0 && set.opts.UnknownSchema == models.LDIFImportSend {
				plan.errors = append(plan.errors, fmt.Sprintf("object class %s is not defined in this server's schema: the server refuses the record", strings.Join(unknown, ", ")))
				kept = a.Values
			} else if len(unknown) > 0 {
				adj.add(models.LDIFAdjustClassOmitted, ldifReasonUnknown, "objectClass", unknown...)
				if len(kept) == 0 {
					plan.errors = append(plan.errors, "none of the object classes "+strings.Join(unknown, ", ")+" is defined in this server's schema")
				}
			}
			if len(kept) > 0 {
				plan.attrs = append(plan.attrs, models.LDAPAttribute{Name: a.Name, Values: kept, Binary: a.Binary})
			}
			continue
		}
		// DN values of entries that do not exist (Active Directory refuses them).
		if set.serverType == models.ServerTypeAD && ref != nil && !a.Binary && sc.lookup(base).syntax == syntaxDN {
			kept := make([]string, 0, len(a.Values))
			var missing, later []string
			for _, v := range a.Values {
				switch ref(v) {
				case ldifRefMissing:
					missing = append(missing, v)
				case ldifRefLater:
					later = append(later, v)
				default:
					kept = append(kept, v) // unknown: let the server decide
				}
			}
			if len(later) > 0 {
				adj.add(models.LDIFAdjustRefDeferred, ldifReasonDeferredRef, a.Name, later...)
				plan.deferred = append(plan.deferred, models.AttributeChange{Operation: models.ChangeAdd, Attribute: a.Name, Values: later})
			}
			if len(missing) > 0 && set.opts.MissingReferences == models.LDIFImportSend {
				plan.errors = append(plan.errors, fmt.Sprintf("%s: %s does not exist on this server; Active Directory refuses the record (choose \"Leave out\" under References to missing entries)", a.Name, strings.Join(missing, "; ")))
				kept = a.Values
			} else if len(missing) > 0 {
				adj.add(models.LDIFAdjustRefOmitted, ldifReasonMissingRef, a.Name, missing...)
			}
			if len(kept) > 0 {
				plan.attrs = append(plan.attrs, models.LDAPAttribute{Name: a.Name, Values: kept, Binary: a.Binary})
			}
			continue
		}
		plan.attrs = append(plan.attrs, a)
	}
	if checkSchema && !update {
		plan.attrs = checkClassRules(plan.attrs, set, sc, adj, &plan.errors)
	}
	if !set.tls {
		for _, a := range plan.attrs {
			if ldap.IsUnicodePwdAttribute(a.Name) && len(a.Values) > 0 {
				plan.errors = append(plan.errors, "unicodePwd: Active Directory sets a password only over an encrypted connection (LDAPS or StartTLS); this connection has none, so the record is not sent. Reconnect with TLS, or remove the unicodePwd lines and set the password afterwards.")
				break
			}
		}
	}
	plan.adjustments = adj.result()
	return plan
}

// checkClassRules checks an add against the schema rules of its object
// classes: attributes the classes (with their superclasses) do not allow
// are left out (UnknownSchema "send": predicted errors), missing MUST
// attributes and several values of a single-valued type are predicted
// errors. Operational attribute types need no class. Active Directory is
// only checked for single values: its classes get attributes from
// auxiliary classes the subschema does not show.
func checkClassRules(attrs []models.LDAPAttribute, set ldifImportSettings, sc *schemaContext, adj *ldifAdjuster, errs *[]string) []models.LDAPAttribute {
	var classes []string
	for _, a := range attrs {
		if attrBase(a.Name) == "objectclass" {
			classes = append(classes, a.Values...)
		}
	}
	allowed, must, anyAttr := sc.classRules(classes)
	checkAllowed := set.serverType != models.ServerTypeAD && len(classes) > 0 && !anyAttr
	present := map[string]bool{}
	out := make([]models.LDAPAttribute, 0, len(attrs))
	for _, a := range attrs {
		base := attrBase(a.Name)
		info := sc.attrs[base]
		if base == "objectclass" || info == nil {
			out = append(out, a)
			continue
		}
		primary := strings.ToLower(info.Name)
		operational := info.Usage != "" && !strings.EqualFold(info.Usage, "userApplications")
		if checkAllowed && !operational && !allowed[primary] {
			reason := "not allowed by the entry's object classes (" + strings.Join(classes, ", ") + ") on this server"
			if set.opts.UnknownSchema == models.LDIFImportSend {
				*errs = append(*errs, a.Name+" is "+reason+": the server refuses the record")
				out = append(out, a)
			} else {
				adj.add(models.LDIFAdjustUnknownOmitted, reason, a.Name)
			}
			continue
		}
		present[primary] = true
		if info.SingleValue && len(a.Values) > 1 {
			*errs = append(*errs, fmt.Sprintf("%s is single-valued on this server, but the record has %d values", info.Name, len(a.Values)))
		}
		out = append(out, a)
	}
	if set.serverType != models.ServerTypeAD {
		var missing []string
		for _, m := range must {
			if present[m] || m == "objectclass" {
				continue
			}
			name := m
			if a := sc.attrs[m]; a != nil {
				name = a.Name
			}
			missing = append(missing, name)
		}
		if len(missing) > 0 {
			*errs = append(*errs, "the record has no "+strings.Join(missing, ", ")+", which its object classes require on this server")
		}
	}
	return out
}

// classRuleSet is what a list of object classes allows (classRules).
type classRuleSet struct {
	allowed map[string]bool
	must    []string
	anyAttr bool
}

// classRules returns what the object classes (and their superclasses)
// allow: the attribute types (lower-case primary names), the required ones,
// and whether one of them allows any attribute (extensibleObject). The
// result is cached per class list and must not be changed.
func (sc *schemaContext) classRules(classes []string) (allowed map[string]bool, must []string, anyAttr bool) {
	key := strings.ToLower(strings.Join(classes, "\x00"))
	sc.rulesMu.Lock()
	cached := sc.rules[key]
	sc.rulesMu.Unlock()
	if cached != nil {
		return cached.allowed, cached.must, cached.anyAttr
	}
	allowed, must, anyAttr = sc.computeClassRules(classes)
	sc.rulesMu.Lock()
	if sc.rules == nil {
		sc.rules = map[string]*classRuleSet{}
	}
	if len(sc.rules) < 4096 {
		sc.rules[key] = &classRuleSet{allowed: allowed, must: must, anyAttr: anyAttr}
	}
	sc.rulesMu.Unlock()
	return allowed, must, anyAttr
}

func (sc *schemaContext) computeClassRules(classes []string) (allowed map[string]bool, must []string, anyAttr bool) {
	allowed = map[string]bool{}
	seen := map[*models.SchemaObjectClass]bool{}
	mustSeen := map[string]bool{}
	var visit func(name string, depth int)
	visit = func(name string, depth int) {
		oc := sc.findClass(name)
		if oc == nil || seen[oc] || depth > 16 {
			return
		}
		seen[oc] = true
		if strings.EqualFold(oc.Name, "extensibleObject") || oc.OID == "1.3.6.1.4.1.1466.101.120.111" {
			anyAttr = true
		}
		for _, n := range oc.Must {
			k := sc.primaryName(n)
			allowed[k] = true
			if !mustSeen[k] {
				mustSeen[k] = true
				must = append(must, k)
			}
		}
		for _, n := range oc.May {
			allowed[sc.primaryName(n)] = true
		}
		for _, sup := range oc.SuperClass {
			visit(sup, depth+1)
		}
	}
	for _, c := range classes {
		visit(c, 0)
	}
	return allowed, must, anyAttr
}

// primaryName is the lower-case primary name of an attribute type given by
// name, alias or OID (the lower-cased input when unknown).
func (sc *schemaContext) primaryName(name string) string {
	if a := sc.attrs[attrBase(name)]; a != nil {
		return strings.ToLower(a.Name)
	}
	return attrBase(name)
}

// ldifUnicodePwdBlocked reports the error of planLDIFAdd that keeps a
// record from being sent (a password over an unencrypted connection).
func ldifUnicodePwdBlocked(errors []string) bool {
	for _, e := range errors {
		if strings.HasPrefix(e, "unicodePwd: Active Directory sets a password only over an encrypted connection") {
			return true
		}
	}
	return false
}

// ldifUpdateChanges are the changes that give an existing entry the
// attributes of an add record: missing object classes are added, every
// other attribute of the record replaces the entry's values unless they
// are equal already (password and binary values compared exactly).
// Attributes the record does not have stay as they are.
func ldifUpdateChanges(entry *models.LDAPEntry, attrs []models.LDAPAttribute, sc *schemaContext) []models.AttributeChange {
	find := func(name string) *models.LDAPAttribute {
		for i := range entry.Attributes {
			if strings.EqualFold(entry.Attributes[i].Name, name) {
				return &entry.Attributes[i]
			}
		}
		return nil
	}
	var out []models.AttributeChange
	for _, a := range attrs {
		if len(a.Values) == 0 {
			continue
		}
		cur := find(a.Name)
		if attrBase(a.Name) == "objectclass" {
			var missing []string
			for _, v := range a.Values {
				if cur == nil || !containsFold(cur.Values, v) {
					missing = append(missing, v)
				}
			}
			if len(missing) > 0 {
				out = append(out, models.AttributeChange{Operation: models.ChangeAdd, Attribute: a.Name, Values: missing})
			}
			continue
		}
		if cur != nil && !isWriteOnlyAttribute(a.Name) && sameValues(cur.Values, a.Values, sc.matcher(a.Name), a.Binary || isSensitiveAttribute(a.Name)) {
			continue
		}
		out = append(out, models.AttributeChange{Operation: models.ChangeReplace, Attribute: a.Name, Values: append([]string(nil), a.Values...), Binary: a.Binary})
	}
	return out
}

// sameValues reports whether a and b hold the same values: exactly, or with
// the attribute's matching rule (only when it is known for certain).
func sameValues(a, b []string, match matchFunc, exact bool) bool {
	if len(a) != len(b) {
		return false
	}
	if sameValueSet(a, b) {
		return true
	}
	if exact {
		return false
	}
	used := make([]bool, len(a))
	for _, v := range b {
		found := false
		for i, x := range a {
			if used[i] {
				continue
			}
			if eq, certain := match(x, v); eq && certain {
				used[i] = true
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func containsFold(values []string, v string) bool {
	for _, x := range values {
		if strings.EqualFold(x, v) {
			return true
		}
	}
	return false
}

// ldifRelaxControls are the controls of an add sent with Relax Rules.
func ldifRelaxControls(relax bool) []goldap.Control {
	if !relax {
		return nil
	}
	return []goldap.Control{goldap.NewControlString(ldap.RelaxRulesOID, false, "")}
}

// ldifAdjustedSummary is the short summary of a record's adjustments for
// apply results (BulkResultItem.Adjusted): the names per kind, without the
// reasons the dry run gave ("left out: entryUUID, entryCSN; sent: …").
func ldifAdjustedSummary(adjs []models.LDIFAdjustment) string {
	labels := []string{}
	names := map[string][]string{}
	add := func(label string, n ...string) {
		if _, ok := names[label]; !ok {
			labels = append(labels, label)
		}
		names[label] = append(names[label], n...)
	}
	for _, a := range adjs {
		switch a.Kind {
		case models.LDIFAdjustServerOmitted, models.LDIFAdjustUnknownOmitted:
			add("left out", a.Attributes...)
		case models.LDIFAdjustServerSent:
			add("sent", a.Attributes...)
		case models.LDIFAdjustClassOmitted:
			add("object classes left out", a.Values...)
		case models.LDIFAdjustRefOmitted:
			add("references left out", fmt.Sprintf("%s (%d)", strings.Join(a.Attributes, ", "), len(a.Values)))
		case models.LDIFAdjustRefDeferred:
			add("references set at the end", fmt.Sprintf("%s (%d)", strings.Join(a.Attributes, ", "), len(a.Values)))
		case models.LDIFAdjustExisting:
			add(strings.ToLower(a.Reason[:1]) + a.Reason[1:])
		}
	}
	parts := make([]string, 0, len(labels))
	for _, l := range labels {
		if len(names[l]) == 0 {
			parts = append(parts, l)
			continue
		}
		parts = append(parts, l+": "+strings.Join(names[l], ", "))
	}
	return strings.Join(parts, "; ")
}

// ldifAdjustmentTotals counts adjustments per kind, attribute and reason
// over the records, in the order they first appear.
type ldifAdjustmentTotals struct {
	order []string
	byKey map[string]*models.LDIFAdjustmentTotal
}

func (t *ldifAdjustmentTotals) add(adjs []models.LDIFAdjustment) {
	if t.byKey == nil {
		t.byKey = map[string]*models.LDIFAdjustmentTotal{}
	}
	seen := map[string]bool{}
	for _, a := range adjs {
		names := a.Attributes
		if a.Kind == models.LDIFAdjustClassOmitted {
			names = a.Values // object classes are counted by class
		}
		if a.Kind == models.LDIFAdjustExisting {
			names = []string{""}
		}
		for _, n := range names {
			key := a.Kind + "\x00" + strings.ToLower(n) + "\x00" + a.Reason
			if seen[key] {
				continue
			}
			seen[key] = true
			tot := t.byKey[key]
			if tot == nil {
				tot = &models.LDIFAdjustmentTotal{Kind: a.Kind, Attribute: n, Reason: a.Reason}
				t.byKey[key] = tot
				t.order = append(t.order, key)
			}
			tot.Records++
		}
	}
}

func (t *ldifAdjustmentTotals) list() []models.LDIFAdjustmentTotal {
	out := make([]models.LDIFAdjustmentTotal, 0, len(t.order))
	for _, k := range t.order {
		out = append(out, *t.byKey[k])
	}
	return out
}
