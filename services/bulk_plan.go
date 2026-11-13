package services

import (
	"encoding/base64"
	"fmt"
	"strings"
	"sync"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/ldif"
	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// This file holds the pure planning logic of bulk modify and LDIF previews:
// it simulates attribute changes on an entry read from the directory,
// predicts obvious failures and computes per-attribute diffs. It does no I/O.

// ---------------------------------------------------------------------------
// Schema knowledge used for predictions

// attrTypeInfo is what the planner knows about an attribute type.
type attrTypeInfo struct {
	found       bool
	name        string
	singleValue bool
	noUserMod   bool
	equality    string // lowercase matching rule, inherited through SUP
	syntax      string // syntax OID without length, inherited through SUP
}

// schemaContext answers attribute type questions; it works without schema
// (all lookups then report found=false).
type schemaContext struct {
	attrs map[string]*models.SchemaAttribute // lowercase name, alias and OID
	// classes are the object classes by lowercase name, alias and OID.
	classes map[string]*models.SchemaObjectClass
	// hasSchema is true when the server's schema was read (lookups that find
	// nothing then mean "not defined on this server").
	hasSchema bool
	isAD      bool
	// rules caches classRules by object class list (LDIF imports ask it
	// for every add record).
	rulesMu sync.Mutex
	rules   map[string]*classRuleSet
	// namingContexts of the server (RootDSE); nil when unknown.
	namingContexts []string
}

func newSchemaContext(schema *models.SchemaInfo, serverType string) *schemaContext {
	sc := &schemaContext{attrs: map[string]*models.SchemaAttribute{}, classes: map[string]*models.SchemaObjectClass{}, isAD: serverType == models.ServerTypeAD}
	if schema != nil {
		sc.hasSchema = len(schema.Attributes) > 0 && len(schema.ObjectClasses) > 0
		for i := range schema.Attributes {
			a := &schema.Attributes[i]
			sc.attrs[strings.ToLower(a.Name)] = a
			if a.OID != "" {
				sc.attrs[strings.ToLower(a.OID)] = a
			}
		}
		// Aliases never shadow another type's primary name or OID.
		for i := range schema.Attributes {
			a := &schema.Attributes[i]
			for _, alias := range a.Aliases {
				if k := strings.ToLower(alias); sc.attrs[k] == nil {
					sc.attrs[k] = a
				}
			}
		}
		for i := range schema.ObjectClasses {
			oc := &schema.ObjectClasses[i]
			sc.classes[strings.ToLower(oc.Name)] = oc
			if oc.OID != "" {
				sc.classes[strings.ToLower(oc.OID)] = oc
			}
		}
		for i := range schema.ObjectClasses {
			oc := &schema.ObjectClasses[i]
			for _, alias := range oc.Aliases {
				if k := strings.ToLower(alias); sc.classes[k] == nil {
					sc.classes[k] = oc
				}
			}
		}
	}
	return sc
}

// findClass returns the object class with the name, alias or OID (nil when
// unknown).
func (sc *schemaContext) findClass(name string) *models.SchemaObjectClass {
	return sc.classes[strings.ToLower(strings.TrimSpace(name))]
}

// isNamingContext reports whether dn is one of the server's naming contexts
// (suffixes), whose entries have no parent entry.
func (sc *schemaContext) isNamingContext(dn string) bool {
	for _, nc := range sc.namingContexts {
		if dnEqual(nc, dn) {
			return true
		}
	}
	return false
}

// namingContextOf returns the deepest naming context of the server that dn
// lies at or below ("" when none is known).
func (sc *schemaContext) namingContextOf(dn string) string {
	parsed, err := goldap.ParseDN(dn)
	if err != nil {
		return ""
	}
	best, depth := "", -1
	for _, nc := range sc.namingContexts {
		ncDN, err := goldap.ParseDN(nc)
		if err != nil || len(ncDN.RDNs) <= depth {
			continue
		}
		if ncDN.AncestorOfFold(parsed) || ncDN.EqualFold(parsed) {
			best, depth = nc, len(ncDN.RDNs)
		}
	}
	return best
}

// belowNamingContext reports whether dn lies below one of the server's
// naming contexts.
func (sc *schemaContext) belowNamingContext(dn string) bool {
	parsed, err := goldap.ParseDN(dn)
	if err != nil {
		return false
	}
	for _, nc := range sc.namingContexts {
		if ncDN, err := goldap.ParseDN(nc); err == nil && ncDN.AncestorOfFold(parsed) {
			return true
		}
	}
	return false
}

func (sc *schemaContext) lookup(attr string) attrTypeInfo {
	base := strings.ToLower(attr)
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = base[:i]
	}
	a := sc.attrs[base]
	if a == nil {
		return attrTypeInfo{}
	}
	info := attrTypeInfo{found: true, name: a.Name, singleValue: a.SingleValue, noUserMod: a.NoUserMod}
	// equality and syntax are inherited from the supertype
	for cur, depth := a, 0; cur != nil && depth < 8; depth++ {
		if info.equality == "" {
			info.equality = strings.ToLower(cur.Equality)
		}
		if info.syntax == "" {
			info.syntax = cur.Syntax
			if i := strings.IndexByte(info.syntax, '{'); i >= 0 {
				info.syntax = info.syntax[:i]
			}
		}
		if cur.SuperType == "" {
			break
		}
		cur = sc.attrs[strings.ToLower(cur.SuperType)]
	}
	return info
}

const (
	syntaxDN          = "1.3.6.1.4.1.1466.115.121.1.12"
	syntaxOctetString = "1.3.6.1.4.1.1466.115.121.1.40"
)

// matchFunc compares two values of an attribute. equal is whether the server
// treats them as equal; certain is false when the matching rule is unknown
// and equal is only a guess (case-insensitive comparison).
type matchFunc func(a, b string) (equal, certain bool)

func (sc *schemaContext) matcher(attr string) matchFunc {
	info := sc.lookup(attr)
	rule := info.equality
	switch {
	case rule == "distinguishednamematch" || rule == "uniquemembermatch" || (rule == "" && info.syntax == syntaxDN):
		return func(a, b string) (bool, bool) { return dnEqual(a, b), true }
	case strings.Contains(rule, "caseexact") || strings.Contains(rule, "octetstring") || rule == "integermatch" || rule == "bitstringmatch" || rule == "uuidmatch" || (rule == "" && info.syntax == syntaxOctetString):
		return func(a, b string) (bool, bool) { return a == b, true }
	case rule == "telephonenumbermatch":
		return func(a, b string) (bool, bool) {
			return strings.EqualFold(stripChars(a, " -"), stripChars(b, " -")), true
		}
	case rule == "numericstringmatch":
		return func(a, b string) (bool, bool) { return stripChars(a, " ") == stripChars(b, " "), true }
	case strings.Contains(rule, "caseignore") || rule == "objectidentifiermatch" || rule == "booleanmatch":
		return func(a, b string) (bool, bool) { return strings.EqualFold(a, b), true }
	case rule == "" && sc.isAD:
		// AD compares strings case-insensitively
		return func(a, b string) (bool, bool) { return strings.EqualFold(a, b), true }
	default:
		return func(a, b string) (bool, bool) {
			if a == b {
				return true, true
			}
			return strings.EqualFold(a, b), false
		}
	}
}

func stripChars(s, chars string) string {
	return strings.Map(func(r rune) rune {
		if strings.ContainsRune(chars, r) {
			return -1
		}
		return r
	}, s)
}

// dnEqual compares two DNs case-insensitively; unparsable DNs are compared
// as strings.
func dnEqual(a, b string) bool {
	da, errA := goldap.ParseDN(a)
	db, errB := goldap.ParseDN(b)
	if errA != nil || errB != nil {
		return strings.EqualFold(a, b)
	}
	return da.EqualFold(db)
}

// bulkDNKey returns a normalized, case-insensitive key of a DN; unparsable DNs
// are lower-cased as is.
func bulkDNKey(dn string) string {
	parsed, err := goldap.ParseDN(dn)
	if err != nil {
		return strings.ToLower(strings.TrimSpace(dn))
	}
	return strings.ToLower(parsed.String())
}

// ---------------------------------------------------------------------------
// Simulation of modify changes

// simulateMode selects batch or LDIF semantics.
type simulateMode struct {
	// dropNoOps drops changes without effect instead of reporting them:
	// removing an absent attribute and replacing with identical values
	// (batch modify). With false (LDIF, sent as written) removing an absent
	// attribute is a predicted error.
	dropNoOps bool
	// ignoreValueNoOps drops adds of present values and deletes of absent
	// values instead of failing (BulkOptions.IgnoreNoOps).
	ignoreValueNoOps bool
	// rejectTextOnBinary fails text values for binary attributes (batch).
	rejectTextOnBinary bool
}

// simAttr is the simulated state of one attribute.
type simAttr struct {
	name   string
	values []string
	binary bool
}

// simResult is the outcome of simulateChanges.
type simResult struct {
	errors   []string
	warnings []string
	notes    []string
	diffs    []models.BulkAttrDiff
	changes  []models.AttributeChange // changes to send (unmasked)
	after    *models.LDAPEntry        // simulated entry after the changes
}

// isWriteOnlyAttribute reports attributes the server never returns
// (presence cannot be checked).
func isWriteOnlyAttribute(name string) bool {
	base := strings.ToLower(name)
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = base[:i]
	}
	return base == "unicodepwd" || base == ldap.OIDUnicodePwd || base == "clearpassword"
}

// simulateChanges applies changes (with concrete values) to a copy of entry
// and predicts failures. The order of changes is respected, as the server
// applies them in order.
func simulateChanges(entry *models.LDAPEntry, changes []models.AttributeChange, mode simulateMode, sc *schemaContext) *simResult {
	res := &simResult{}
	state := make(map[string]*simAttr, len(entry.Attributes))
	var stateOrder []string
	inOrder := map[string]bool{}
	setAttr := func(key string, a *simAttr) {
		state[key] = a
		if !inOrder[key] {
			inOrder[key] = true
			stateOrder = append(stateOrder, key)
		}
	}
	for _, a := range entry.Attributes {
		key := strings.ToLower(a.Name)
		if _, dup := state[key]; dup {
			continue
		}
		setAttr(key, &simAttr{name: a.Name, values: append([]string(nil), a.Values...), binary: a.Binary})
	}
	before := make(map[string]*simAttr, len(state))
	for k, v := range state {
		cp := *v
		cp.values = append([]string(nil), v.values...)
		before[k] = &cp
	}

	type touched struct {
		key  string
		name string
		ops  []string
	}
	var touchedOrder []*touched
	touchedByKey := map[string]*touched{}

	for _, ch := range changes {
		op := strings.ToLower(ch.Operation)
		key := strings.ToLower(ch.Attribute)
		label := fmt.Sprintf("%s %s", op, ch.Attribute)
		t := touchedByKey[key]
		if t == nil {
			t = &touched{key: key, name: ch.Attribute}
			touchedByKey[key] = t
			touchedOrder = append(touchedOrder, t)
		}
		t.ops = append(t.ops, op)

		cur := state[key]
		sensitive := isSensitiveAttribute(ch.Attribute)
		writeOnly := isWriteOnlyAttribute(ch.Attribute)
		info := sc.lookup(ch.Attribute)
		match := sc.matcher(ch.Attribute)
		binaryAttr := ldap.IsKnownBinaryAttribute(ch.Attribute) || (cur != nil && cur.binary)

		if info.found && info.noUserMod {
			res.errors = append(res.errors, fmt.Sprintf("%s: %s is not user-modifiable (NO-USER-MODIFICATION)", label, info.name))
			continue
		}
		if mode.rejectTextOnBinary && binaryAttr && !ch.Binary && len(ch.Values) > 0 && !writeOnly {
			res.errors = append(res.errors, fmt.Sprintf("%s: %s is a binary attribute; text values cannot be written in a bulk modify", label, ch.Attribute))
			continue
		}

		values := ch.Values
		switch op {
		case models.ChangeAdd:
			if len(values) == 0 {
				res.errors = append(res.errors, fmt.Sprintf("%s: no values to add", label))
				continue
			}
			var kept []string
			for _, v := range values {
				if sensitive || cur == nil {
					kept = append(kept, v)
					continue
				}
				idx, certain := findValue(cur.values, v, match)
				switch {
				case idx >= 0 && certain:
					if mode.ignoreValueNoOps {
						res.notes = append(res.notes, fmt.Sprintf("%s: %q is already present (skipped)", label, displayValue(ch.Attribute, v, ch.Binary)))
						continue
					}
					res.errors = append(res.errors, fmt.Sprintf("%s: value %q is already present", label, displayValue(ch.Attribute, v, ch.Binary)))
				case idx >= 0:
					res.warnings = append(res.warnings, fmt.Sprintf("%s: %q may already be present as %q (differs only in case)", label, v, cur.values[idx]))
					kept = append(kept, v)
				default:
					kept = append(kept, v)
				}
			}
			if len(kept) == 0 {
				continue
			}
			if cur == nil {
				cur = &simAttr{name: ch.Attribute, binary: ch.Binary}
				setAttr(key, cur)
			}
			cur.values = append(cur.values, kept...)
			res.changes = append(res.changes, models.AttributeChange{Operation: models.ChangeAdd, Attribute: ch.Attribute, Values: kept, Binary: ch.Binary})

		case models.ChangeDelete:
			if len(values) == 0 {
				if writeOnly {
					res.changes = append(res.changes, models.AttributeChange{Operation: models.ChangeDelete, Attribute: ch.Attribute, Values: []string{}, Binary: ch.Binary})
					continue
				}
				if cur == nil || len(cur.values) == 0 {
					if mode.dropNoOps {
						res.notes = append(res.notes, fmt.Sprintf("%s: attribute not present, nothing to remove", label))
					} else {
						res.errors = append(res.errors, fmt.Sprintf("%s: attribute %s is not present", label, ch.Attribute))
					}
					continue
				}
				delete(state, key)
				res.changes = append(res.changes, models.AttributeChange{Operation: models.ChangeDelete, Attribute: ch.Attribute, Values: []string{}, Binary: ch.Binary})
				continue
			}
			var kept []string
			for _, v := range values {
				if sensitive {
					kept = append(kept, v) // stored as hash or not readable: cannot verify
					continue
				}
				idx, certain := -1, true
				if cur != nil {
					idx, certain = findValue(cur.values, v, match)
				}
				switch {
				case idx < 0:
					if mode.ignoreValueNoOps {
						res.notes = append(res.notes, fmt.Sprintf("%s: %q is not present (skipped)", label, displayValue(ch.Attribute, v, ch.Binary)))
						continue
					}
					res.errors = append(res.errors, fmt.Sprintf("%s: value %q is not present", label, displayValue(ch.Attribute, v, ch.Binary)))
				default:
					if !certain {
						res.warnings = append(res.warnings, fmt.Sprintf("%s: %q matched %q only case-insensitively", label, v, cur.values[idx]))
					}
					cur.values = append(cur.values[:idx], cur.values[idx+1:]...)
					kept = append(kept, v)
				}
			}
			if cur != nil && len(cur.values) == 0 {
				delete(state, key)
			}
			if len(kept) > 0 {
				res.changes = append(res.changes, models.AttributeChange{Operation: models.ChangeDelete, Attribute: ch.Attribute, Values: kept, Binary: ch.Binary})
			}

		case models.ChangeReplace:
			if !sensitive && mode.dropNoOps {
				if len(values) == 0 && (cur == nil || len(cur.values) == 0) {
					res.notes = append(res.notes, fmt.Sprintf("%s: attribute not present, nothing to remove", label))
					continue
				}
				if cur != nil && sameValueSet(cur.values, values) {
					res.notes = append(res.notes, fmt.Sprintf("%s: already has these values", label))
					continue
				}
			}
			if len(values) == 0 {
				delete(state, key)
			} else {
				if cur == nil {
					cur = &simAttr{name: ch.Attribute}
					setAttr(key, cur)
				}
				cur.values = append([]string(nil), values...)
				cur.binary = ch.Binary
			}
			vals := values
			if vals == nil {
				vals = []string{}
			}
			res.changes = append(res.changes, models.AttributeChange{Operation: models.ChangeReplace, Attribute: ch.Attribute, Values: vals, Binary: ch.Binary})

		default:
			res.errors = append(res.errors, fmt.Sprintf("unknown operation %q for %s", ch.Operation, ch.Attribute))
			continue
		}

		if info.found && info.singleValue {
			if a := state[key]; a != nil && len(a.values) > 1 {
				res.errors = append(res.errors, fmt.Sprintf("%s: %s is single-valued but would get %d values", label, info.name, len(a.values)))
			}
		}
	}

	// Removing the naming value fails (notAllowedOnRDN); renaming is needed.
	if rdnDN, err := goldap.ParseDN(entry.DN); err == nil && len(rdnDN.RDNs) > 0 {
		for _, ava := range rdnDN.RDNs[0].Attributes {
			key := strings.ToLower(ava.Type)
			if touchedByKey[key] == nil {
				continue
			}
			a := state[key]
			found := false
			if a != nil {
				for _, v := range a.values {
					if strings.EqualFold(v, ava.Value) {
						found = true
						break
					}
				}
			}
			if !found {
				res.errors = append(res.errors, fmt.Sprintf("the changes would remove the naming value %s=%s; rename the entry instead", ava.Type, ava.Value))
			}
		}
	}

	for _, t := range touchedOrder {
		res.diffs = append(res.diffs, buildDiff(t.name, t.ops, before[t.key], state[t.key]))
	}

	// OpenLDAP accounts disabled in the account panel: the ppolicy overlay
	// clears the permanent lock on a password change, apply sets it again
	// (ldap.PermanentLockGuard).
	if a := before["pwdaccountlockedtime"]; a != nil && len(a.values) > 0 && a.values[0] == ldap.PPolicyPermanentLock &&
		ldap.ChangesClearPermanentLock(res.changes) {
		res.warnings = append(res.warnings, "the account is disabled (pwdAccountLockedTime "+ldap.PPolicyPermanentLock+"); the ppolicy overlay clears that lock with the password change, LDAPilot sets it again right after the write")
	}

	after := &models.LDAPEntry{DN: entry.DN}
	for _, key := range stateOrder {
		if a := state[key]; a != nil {
			after.Attributes = append(after.Attributes, models.LDAPAttribute{Name: a.name, Values: a.values, Binary: a.binary})
		}
	}
	res.after = after
	return res
}

// findValue returns the index of v in values: an exact match first, else
// the first value the matching rule considers equal. certain is false when
// the match is only a case-insensitive guess.
func findValue(values []string, v string, match matchFunc) (int, bool) {
	for i, x := range values {
		if x == v {
			return i, true
		}
	}
	for i, x := range values {
		if eq, certain := match(x, v); eq {
			return i, certain
		}
	}
	return -1, true
}

// sameValueSet reports whether a and b hold the same values (exact, order
// ignored).
func sameValueSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	count := make(map[string]int, len(a))
	for _, v := range a {
		count[v]++
	}
	for _, v := range b {
		if count[v] == 0 {
			return false
		}
		count[v]--
	}
	return true
}

// displayValue renders a value for previews and reports: passwords masked,
// binary values by size.
func displayValue(attr, v string, binary bool) string {
	switch {
	case isSensitiveAttribute(attr):
		return "***"
	case binary:
		n := base64.StdEncoding.DecodedLen(len(v)) - strings.Count(v, "=")
		return fmt.Sprintf("<binary %d bytes>", n)
	}
	return v
}

func displayValues(attr string, values []string, binary bool, limit int) []string {
	out := make([]string, 0, len(values))
	for i, v := range values {
		if limit > 0 && i == limit {
			break
		}
		out = append(out, displayValue(attr, v, binary))
	}
	return out
}

// buildDiff compares the attribute before and after the changes.
func buildDiff(name string, ops []string, before, after *simAttr) models.BulkAttrDiff {
	var bv, av []string
	binary := false
	if before != nil {
		bv = before.values
		binary = before.binary
		name = before.name
	}
	if after != nil {
		av = after.values
		binary = binary || after.binary
	}
	added := valueDifference(av, bv)
	removed := valueDifference(bv, av)
	return models.BulkAttrDiff{
		Attribute:   name,
		Operations:  ops,
		Before:      displayValues(name, bv, binary, models.BulkDiffMaxValues),
		After:       displayValues(name, av, binary, models.BulkDiffMaxValues),
		BeforeCount: len(bv),
		AfterCount:  len(av),
		Added:       displayValues(name, added, binary, 0),
		Removed:     displayValues(name, removed, binary, 0),
		Changed:     len(added) > 0 || len(removed) > 0,
		Masked:      isSensitiveAttribute(name),
		Binary:      binary,
	}
}

// valueDifference returns the values of a that are not in b (exact,
// multiset semantics).
func valueDifference(a, b []string) []string {
	count := make(map[string]int, len(b))
	for _, v := range b {
		count[v]++
	}
	out := []string{}
	for _, v := range a {
		if count[v] > 0 {
			count[v]--
			continue
		}
		out = append(out, v)
	}
	return out
}

// maskChanges returns a copy of changes with password values masked and
// binary values summarized, for previews.
func maskChanges(changes []models.AttributeChange) []models.AttributeChange {
	out := make([]models.AttributeChange, len(changes))
	for i, ch := range changes {
		out[i] = models.AttributeChange{Operation: ch.Operation, Attribute: ch.Attribute, Values: displayValues(ch.Attribute, ch.Values, ch.Binary, 0)}
	}
	return out
}

// ---------------------------------------------------------------------------
// Batch modify planning

// changeTemplate is a requested batch change with templated values.
type changeTemplate struct {
	op        string
	attr      string
	binary    bool
	templates []*valueTemplate
	literals  []string // binary changes: base64 values, no templates
}

// compileBatchChanges validates the requested changes and parses their value
// templates. Errors concern the request itself, not single entries.
func compileBatchChanges(changes []models.AttributeChange) ([]changeTemplate, error) {
	if len(changes) == 0 {
		return nil, fmt.Errorf("no changes given")
	}
	out := make([]changeTemplate, 0, len(changes))
	for i, ch := range changes {
		op := strings.ToLower(strings.TrimSpace(ch.Operation))
		attr := strings.TrimSpace(ch.Attribute)
		where := fmt.Sprintf("change %d", i+1)
		if attr != "" {
			where += " (" + attr + ")"
		}
		switch op {
		case models.ChangeAdd, models.ChangeDelete, models.ChangeReplace:
		default:
			return nil, fmt.Errorf("%s: unknown operation %q", where, ch.Operation)
		}
		if attr == "" {
			return nil, fmt.Errorf("%s: attribute name is empty", where)
		}
		if !ldif.ValidAttributeDescription(attr) {
			return nil, fmt.Errorf("%s: invalid attribute name %q", where, attr)
		}
		if op == models.ChangeAdd && len(ch.Values) == 0 {
			return nil, fmt.Errorf("%s: add needs at least one value", where)
		}
		ct := changeTemplate{op: op, attr: attr, binary: ch.Binary}
		if ch.Binary {
			for _, v := range ch.Values {
				if _, err := base64.StdEncoding.DecodeString(v); err != nil {
					return nil, fmt.Errorf("%s: binary value is not valid base64", where)
				}
			}
			ct.literals = append([]string(nil), ch.Values...)
		} else {
			for _, v := range ch.Values {
				t, err := parseValueTemplate(v)
				if err != nil {
					return nil, fmt.Errorf("%s: %v", where, err)
				}
				ct.templates = append(ct.templates, t)
			}
		}
		out = append(out, ct)
	}
	return out, nil
}

// planBatchEntry expands the templates for one entry and simulates the
// changes. The returned preview carries the resolved, unmasked changes in
// the second return value.
func planBatchEntry(entry *models.LDAPEntry, changes []changeTemplate, opts models.BulkOptions, sc *schemaContext) (models.BulkPreviewEntry, []models.AttributeChange) {
	pe := models.BulkPreviewEntry{DN: entry.DN, Errors: []string{}, Warnings: []string{}, Notes: []string{}, Diffs: []models.BulkAttrDiff{}, Changes: []models.AttributeChange{}}
	te := newTemplateEntry(entry)

	concrete := make([]models.AttributeChange, 0, len(changes))
	var empty []string
	for _, ct := range changes {
		ch := models.AttributeChange{Operation: ct.op, Attribute: ct.attr, Binary: ct.binary, Values: []string{}}
		if ct.binary {
			ch.Values = append(ch.Values, ct.literals...)
		}
		seen := map[string]bool{}
		for _, t := range ct.templates {
			v, emp, err := t.expand(te)
			if err != nil {
				pe.Errors = append(pe.Errors, fmt.Sprintf("%s %s: %v", ct.op, ct.attr, err))
				continue
			}
			if len(emp) > 0 {
				empty = append(empty, emp...)
				continue
			}
			if seen[v] {
				pe.Warnings = append(pe.Warnings, fmt.Sprintf("%s %s: duplicate value %q ignored", ct.op, ct.attr, displayValue(ct.attr, v, false)))
				continue
			}
			seen[v] = true
			ch.Values = append(ch.Values, v)
		}
		concrete = append(concrete, ch)
	}

	if len(pe.Errors) == 0 && len(empty) > 0 {
		msg := "empty placeholder " + strings.Join(uniqueStrings(empty), ", ") + " (attribute missing or empty)"
		if opts.SkipEmptyPlaceholders {
			pe.Status = models.BulkStatusSkipped
			pe.Notes = append(pe.Notes, msg)
			return pe, nil
		}
		pe.Errors = append(pe.Errors, msg)
	}
	if len(pe.Errors) > 0 {
		pe.Status = models.BulkStatusError
		return pe, nil
	}

	sim := simulateChanges(entry, concrete, simulateMode{dropNoOps: true, ignoreValueNoOps: opts.IgnoreNoOps, rejectTextOnBinary: true}, sc)
	pe.Errors = append(pe.Errors, sim.errors...)
	pe.Warnings = append(pe.Warnings, sim.warnings...)
	pe.Notes = append(pe.Notes, sim.notes...)
	pe.Diffs = sim.diffs
	switch {
	case len(pe.Errors) > 0:
		pe.Status = models.BulkStatusError
		return pe, nil
	case len(sim.changes) == 0:
		pe.Status = models.BulkStatusUnchanged
		return pe, nil
	}
	pe.Status = models.BulkStatusChange
	pe.Changes = maskChanges(sim.changes)
	return pe, sim.changes
}

func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
