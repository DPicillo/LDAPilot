package ldif

import (
	"container/heap"
	"encoding/base64"
	"fmt"
	"io"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

const defaultFoldWidth = 76

// Export converts a slice of LDAPEntry values into an LDIF-formatted string.
// Values of binary attributes are base64 already (see models.LDAPAttribute)
// and are written as "attr:: <value>" unchanged; text values are base64
// encoded only where RFC 2849 requires it. AD values the client renders as
// text (objectGUID, objectSid, msExchMailboxGuid, msDS-GenerationId) are
// written as their raw bytes (ldap.RawADValues), so the file imports the
// same values again. Entries are written in the given order (see
// SortParentFirst).
func Export(entries []models.LDAPEntry) (string, error) {
	var sb strings.Builder
	if err := ExportToWriter(&sb, entries); err != nil {
		return "", err
	}
	return sb.String(), nil
}

// ExportToWriter writes LDIF-formatted entries to the given writer.
func ExportToWriter(w io.Writer, entries []models.LDAPEntry) error {
	if _, err := fmt.Fprintf(w, "version: 1\n"); err != nil {
		return err
	}

	for _, entry := range entries {
		// Blank line separator between records (and after version header)
		if _, err := fmt.Fprintln(w); err != nil {
			return err
		}

		// Write DN - base64 encode if needed
		if needsBase64(entry.DN) {
			encoded := base64.StdEncoding.EncodeToString([]byte(entry.DN))
			if err := writeFolded(w, fmt.Sprintf("dn:: %s", encoded)); err != nil {
				return err
			}
		} else {
			if err := writeFolded(w, fmt.Sprintf("dn: %s", entry.DN)); err != nil {
				return err
			}
		}

		// Write attributes
		for _, attr := range entry.Attributes {
			attr = ldap.RawADValues(attr)
			for _, val := range attr.Values {
				if attr.Binary {
					if err := writeFolded(w, fmt.Sprintf("%s:: %s", attr.Name, val)); err != nil {
						return err
					}
				} else if needsBase64(val) {
					encoded := base64.StdEncoding.EncodeToString([]byte(val))
					if err := writeFolded(w, fmt.Sprintf("%s:: %s", attr.Name, encoded)); err != nil {
						return err
					}
				} else {
					if err := writeFolded(w, fmt.Sprintf("%s: %s", attr.Name, val)); err != nil {
						return err
					}
				}
			}
		}
	}

	return nil
}

// SortParentFirst orders entries for an LDIF import of add records: every
// entry comes after its parent and after the entries of the list that its
// values refer to (member, manager, …: AD refuses a DN value that points to
// an entry that does not exist yet), when those are in the list too.
// Otherwise entries with fewer RDNs come first and the order is kept
// (stable). Reference cycles (two managers of each other) are broken by
// that order; one of their adds then fails on AD.
func SortParentFirst(entries []models.LDAPEntry) {
	n := len(entries)
	if n < 2 {
		return
	}
	keys := make(map[string]int, n)
	depth := make([]int, n)
	for i, e := range entries {
		depth[i] = DNDepth(e.DN)
		if k := dnKey(e.DN); k != "" {
			if _, dup := keys[k]; !dup {
				keys[k] = i
			}
		}
	}
	// deps[i]: entries that must come before i; users[j]: entries waiting for j.
	indeg := make([]int, n)
	users := make([][]int, n)
	for i, e := range entries {
		seen := map[int]bool{i: true}
		add := func(j int) {
			if !seen[j] {
				seen[j] = true
				indeg[i]++
				users[j] = append(users[j], i)
			}
		}
		if j, ok := keys[parentKey(e.DN)]; ok {
			add(j)
		}
		for _, a := range e.Attributes {
			if a.Binary || strings.EqualFold(a.Name, "objectClass") || isBackLink(a.Name) {
				continue
			}
			for _, v := range a.Values {
				if !strings.Contains(v, "=") {
					continue
				}
				if j, ok := keys[dnKey(v)]; ok {
					add(j)
				}
			}
		}
	}
	less := func(a, b int) bool { return depth[a] < depth[b] || (depth[a] == depth[b] && a < b) }
	ready := &indexHeap{less: less}
	for i := 0; i < n; i++ {
		if indeg[i] == 0 {
			heap.Push(ready, i)
		}
	}
	done := make([]bool, n)
	order := make([]int, 0, n)
	for len(order) < n {
		var i int
		if ready.Len() > 0 {
			i = heap.Pop(ready).(int)
		} else {
			// A reference cycle: take the first remaining entry in depth order.
			i = -1
			for j := 0; j < n; j++ {
				if !done[j] && (i < 0 || less(j, i)) {
					i = j
				}
			}
		}
		if done[i] {
			continue
		}
		done[i] = true
		order = append(order, i)
		for _, u := range users[i] {
			if indeg[u]--; indeg[u] == 0 && !done[u] {
				heap.Push(ready, u)
			}
		}
	}
	sorted := make([]models.LDAPEntry, n)
	for k, i := range order {
		sorted[k] = entries[i]
	}
	copy(entries, sorted)
}

// backLinks are attributes the server derives from other entries' values
// (memberOf from the groups' member values, directReports from manager):
// an import never sends them, so they are no ordering dependency (a group
// and its members would otherwise refer to each other).
var backLinks = map[string]bool{"memberof": true, "ismemberof": true, "directreports": true, "managedobjects": true, "nsrole": true}

// isBackLink reports whether name is a back-link attribute (options ignored).
func isBackLink(name string) bool {
	base := strings.ToLower(name)
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = base[:i]
	}
	return backLinks[base]
}

// IsBackLinkAttribute reports whether name is an attribute the server
// derives from other entries' values (memberOf, directReports, …).
func IsBackLinkAttribute(name string) bool { return isBackLink(name) }

// indexHeap is a min-heap of entry indexes ordered by less.
type indexHeap struct {
	items []int
	less  func(a, b int) bool
}

func (h *indexHeap) Len() int           { return len(h.items) }
func (h *indexHeap) Less(i, j int) bool { return h.less(h.items[i], h.items[j]) }
func (h *indexHeap) Swap(i, j int)      { h.items[i], h.items[j] = h.items[j], h.items[i] }
func (h *indexHeap) Push(x any)         { h.items = append(h.items, x.(int)) }
func (h *indexHeap) Pop() any {
	last := h.items[len(h.items)-1]
	h.items = h.items[:len(h.items)-1]
	return last
}

// dnKey is a comparison key of a DN (attribute types and values lower
// case, escapes and spacing normalized); "" when dn does not parse.
func dnKey(dn string) string {
	parsed, err := goldap.ParseDN(strings.TrimSpace(dn))
	if err != nil || len(parsed.RDNs) == 0 {
		return ""
	}
	return rdnsKey(parsed.RDNs)
}

// parentKey is the dnKey of the parent of dn ("" for a single RDN or an
// unparsable DN).
func parentKey(dn string) string {
	parsed, err := goldap.ParseDN(strings.TrimSpace(dn))
	if err != nil || len(parsed.RDNs) < 2 {
		return ""
	}
	return rdnsKey(parsed.RDNs[1:])
}

func rdnsKey(rdns []*goldap.RelativeDN) string {
	var b strings.Builder
	for i, rdn := range rdns {
		if i > 0 {
			b.WriteByte(',')
		}
		for j, av := range rdn.Attributes {
			if j > 0 {
				b.WriteByte('+')
			}
			b.WriteString(strings.ToLower(av.Type))
			b.WriteByte('=')
			b.WriteString(goldap.EscapeDN(strings.ToLower(av.Value)))
		}
	}
	return b.String()
}

// DNDepth is the number of RDNs of dn (escape-aware; unparsable DNs are
// counted by their unescaped commas).
func DNDepth(dn string) int {
	if strings.TrimSpace(dn) == "" {
		return 0
	}
	if parsed, err := goldap.ParseDN(dn); err == nil {
		return len(parsed.RDNs)
	}
	n, escaped := 1, false
	for _, c := range dn {
		switch {
		case escaped:
			escaped = false
		case c == '\\':
			escaped = true
		case c == ',' || c == ';':
			n++
		}
	}
	return n
}

// nonImportableAttributes (lower case) are maintained by the server: they
// are returned by a read but an add record must not contain them (AD/Samba
// system attributes and back-links, operational attributes of OpenLDAP and
// 389 Directory Server). StripNonImportable removes them, together with the
// schema's NO-USER-MODIFICATION and operational attribute types.
var nonImportableAttributes = map[string]bool{
	// Active Directory / Samba
	"objectguid": true, "objectsid": true, "distinguishedname": true, "name": true,
	"whencreated": true, "whenchanged": true, "usncreated": true, "usnchanged": true,
	"instancetype": true, "dscorepropagationdata": true, "replpropertymetadata": true,
	"samaccounttype": true, "iscriticalsystemobject": true, "systemflags": true,
	"badpwdcount": true, "badpasswordtime": true, "lastlogon": true, "lastlogoff": true,
	"logoncount": true, "lastlogontimestamp": true, "pwdlastset": true, "lockouttime": true,
	"primarygroupid": true, "memberof": true, "directreports": true, "managedobjects": true,
	"ntsecuritydescriptor": true, "msds-user-account-control-computed": true,
	"msds-userpasswordexpirytimecomputed": true, "msds-resultantpso": true,
	"msds-approx-immed-subordinates": true, "msds-keyversionnumber": true,
	"tokengroups": true, "canonicalname": true, "allowedattributes": true,
	"allowedattributeseffective": true, "allowedchildclasses": true,
	"allowedchildclasseseffective": true, "sdrightseffective": true,
	"msds-revealeddsas": true, "msds-parentdistname": true,
	// RFC 4512 / OpenLDAP / 389 Directory Server operational attributes
	"createtimestamp": true, "modifytimestamp": true, "creatorsname": true, "modifiersname": true,
	"entryuuid": true, "entrycsn": true, "entrydn": true, "hassubordinates": true,
	"subschemasubentry": true, "structuralobjectclass": true, "numsubordinates": true,
	"contextcsn": true, "pwdchangedtime": true, "pwdfailuretime": true, "pwdhistory": true,
	"pwdgraceusetime": true, "nsuniqueid": true, "nsparentuniqueid": true, "parentid": true,
	"entryid": true, "nscpentrydn": true, "nsrole": true,
}

// IsImportableAttribute reports whether an attribute may appear in an add
// record: not server-maintained (nonImportableAttributes) and not in extra
// (lower-case names, e.g. the schema's NO-USER-MODIFICATION types).
// objectClass is always importable: every add record needs it, although
// Samba / AD publish it as NO-USER-MODIFICATION (systemOnly).
func IsImportableAttribute(name string, extra map[string]bool) bool {
	base := strings.ToLower(name)
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = base[:i]
	}
	if base == "objectclass" {
		return true
	}
	return !nonImportableAttributes[base] && !extra[base]
}

// StripNonImportable returns copies of the entries without server-maintained
// attributes (see IsImportableAttribute), so the LDIF can be imported again.
func StripNonImportable(entries []models.LDAPEntry, extra map[string]bool) []models.LDAPEntry {
	out := make([]models.LDAPEntry, len(entries))
	for i, e := range entries {
		attrs := make([]models.LDAPAttribute, 0, len(e.Attributes))
		for _, a := range e.Attributes {
			if IsImportableAttribute(a.Name, extra) {
				attrs = append(attrs, a)
			}
		}
		out[i] = models.LDAPEntry{DN: e.DN, Attributes: attrs}
	}
	return out
}

// KeepAttributes returns copies of the entries with only the named
// attributes (case-insensitive, options ignored), plus objectClass when
// keepObjectClass is set. Without names the entries are returned as they are.
func KeepAttributes(entries []models.LDAPEntry, names []string, keepObjectClass bool) []models.LDAPEntry {
	if len(names) == 0 {
		return entries
	}
	want := make(map[string]bool, len(names)+1)
	for _, n := range names {
		want[strings.ToLower(strings.TrimSpace(n))] = true
	}
	if keepObjectClass {
		want["objectclass"] = true
	}
	out := make([]models.LDAPEntry, len(entries))
	for i, e := range entries {
		attrs := make([]models.LDAPAttribute, 0, len(names))
		for _, a := range e.Attributes {
			base := strings.ToLower(a.Name)
			if j := strings.IndexByte(base, ';'); j >= 0 {
				base = base[:j]
			}
			if want[base] {
				attrs = append(attrs, a)
			}
		}
		out[i] = models.LDAPEntry{DN: e.DN, Attributes: attrs}
	}
	return out
}

// needsBase64 returns true if a string value should be base64-encoded per RFC 2849.
func needsBase64(s string) bool {
	if len(s) == 0 {
		return false
	}

	// Must base64 encode if starts with space, colon, or less-than
	first := s[0]
	if first == ' ' || first == ':' || first == '<' {
		return true
	}
	// Trailing spaces would be lost by many parsers (RFC 2849, note 8)
	if s[len(s)-1] == ' ' {
		return true
	}

	// Must base64 encode if contains non-ASCII or control characters
	for _, r := range s {
		if r < 0x20 || r > 0x7E {
			return true
		}
	}

	return false
}

// writeFolded writes a line to the writer, folding at defaultFoldWidth characters per RFC 2849.
// Uses rune-aware slicing to avoid breaking multi-byte UTF-8 characters.
func writeFolded(w io.Writer, line string) error {
	runes := []rune(line)
	if len(runes) <= defaultFoldWidth {
		_, err := fmt.Fprintf(w, "%s\n", line)
		return err
	}

	// Write first chunk
	if _, err := fmt.Fprintf(w, "%s\n", string(runes[:defaultFoldWidth])); err != nil {
		return err
	}

	remaining := runes[defaultFoldWidth:]
	for len(remaining) > 0 {
		// Continuation lines start with a space, so we can fit foldWidth-1 chars
		chunkSize := defaultFoldWidth - 1
		if chunkSize > len(remaining) {
			chunkSize = len(remaining)
		}
		if _, err := fmt.Fprintf(w, " %s\n", string(remaining[:chunkSize])); err != nil {
			return err
		}
		remaining = remaining[chunkSize:]
	}

	return nil
}
