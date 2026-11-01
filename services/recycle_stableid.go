package services

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// Stable entry ids (RW3-R-01): the id a server assigns to an entry and keeps
// through renames, moves and (AD) restores — objectGUID (Active Directory,
// Samba), nsUniqueId (389 Directory Server), entryUUID (OpenLDAP, RFC 4530).
// Bookmarks store it as "<attribute>:<value>" and find a renamed or moved
// entry by it when their DN no longer exists. Both reads are background
// reads of the bookmarks, not user operations: they do not write to the
// operation log (ReadAttributes / DNsWithValue).

// stableIDAttributes in order of preference: 389DS may also keep entryUUID
// (plugin), but only nsUniqueId is guaranteed on every entry there.
var stableIDAttributes = []string{"objectGUID", "nsUniqueId", "entryUUID"}

// stableIDLimit caps the DNs of one StableIDsOf call.
const stableIDLimit = 200

// StableIDInfo is the stable id of one entry (StableIDsOf).
type StableIDInfo struct {
	DN string `json:"dn"`
	// ID is "<attribute>:<value>" ("objectGUID:6f1c…", "entryUUID:…"); empty
	// when the entry has none of the id attributes (or the bind may not read
	// them).
	ID string `json:"id,omitempty"`
	// Missing: the entry does not exist (noSuchObject).
	Missing bool `json:"missing,omitempty"`
	// Error: the entry could not be read for another reason.
	Error string `json:"error,omitempty"`
}

// StableIDsOf reads the stable id of every DN (one base read per DN, at
// most 200, not logged). Entries that do not exist are reported as Missing.
func (s *BrowserService) StableIDsOf(profileID string, dns []string) ([]StableIDInfo, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	out := make([]StableIDInfo, 0, len(dns))
	for i, dn := range dns {
		info := StableIDInfo{DN: dn}
		switch {
		case i >= stableIDLimit:
			info.Error = "not checked (too many DNs)"
		case strings.TrimSpace(dn) == "":
			info.Error = "empty DN"
		default:
			attrs, err := client.ReadAttributes(strings.TrimSpace(dn), stableIDAttributes)
			switch {
			case goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject):
				info.Missing = true
			case err != nil:
				info.Error = err.Error()
			default:
				info.ID = stableIDFrom(attrs)
			}
		}
		out = append(out, info)
	}
	return out, nil
}

// FindByStableID returns the current DN of the entry with the stable id
// (StableIDInfo.ID), or "" when no entry below the tree's search bases and
// the server's naming contexts has it. Equality searches without
// attributes, not logged.
func (s *BrowserService) FindByStableID(profileID string, id string) (string, error) {
	attr, value, err := stableIDFilterValue(id)
	if err != nil {
		return "", err
	}
	client, err := s.pool.Get(profileID)
	if err != nil {
		return "", err
	}
	bases, _ := s.GetTreeSearchBases(profileID)
	if rootDSE, rerr := client.GetRootDSE(); rerr == nil {
		bases = append(bases, getAttrValues(rootDSE, "namingContexts")...)
	}
	var lastErr error
	for _, base := range stableIDBases(bases) {
		dns, err := client.DNsWithValue(base, attr, value, 2)
		if err != nil {
			lastErr = err
			continue
		}
		if len(dns) > 0 {
			return dns[0], nil
		}
	}
	if lastErr != nil {
		return "", lastErr
	}
	return "", nil
}

// stableIDFrom picks the preferred id attribute the entry has.
func stableIDFrom(attrs map[string]models.LDAPAttribute) string {
	for _, name := range stableIDAttributes {
		a, ok := attrs[strings.ToLower(name)]
		if !ok || a.Binary || len(a.Values) == 0 {
			continue
		}
		if v := strings.TrimSpace(a.Values[0]); v != "" {
			return name + ":" + v
		}
	}
	return ""
}

// parseStableID splits "<attribute>:<value>"; the attribute must be one of
// stableIDAttributes (returned in its canonical spelling).
func parseStableID(id string) (attr, value string, ok bool) {
	name, value, found := strings.Cut(strings.TrimSpace(id), ":")
	value = strings.TrimSpace(value)
	if !found || value == "" {
		return "", "", false
	}
	for _, a := range stableIDAttributes {
		if strings.EqualFold(a, strings.TrimSpace(name)) {
			return a, value, true
		}
	}
	return "", "", false
}

// stableIDFilterValue is the attribute and the assertion value to search
// for: objectGUID is matched against its 16 raw bytes (AD byte order), the
// others as text.
func stableIDFilterValue(id string) (attr, value string, err error) {
	attr, value, ok := parseStableID(id)
	if !ok {
		return "", "", fmt.Errorf("invalid stable id %q", id)
	}
	if attr == "objectGUID" {
		raw, ok := guidBytes(value)
		if !ok {
			return "", "", fmt.Errorf("invalid objectGUID %q", value)
		}
		return attr, string(raw), nil
	}
	return attr, value, nil
}

// guidBytes is the inverse of the objectGUID formatter: the text form
// xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx back to the 16 bytes AD stores (the
// first three groups little-endian).
func guidBytes(text string) ([]byte, bool) {
	parts := strings.Split(strings.Trim(strings.TrimSpace(text), "{}"), "-")
	if len(parts) != 5 || len(parts[0]) != 8 || len(parts[1]) != 4 || len(parts[2]) != 4 || len(parts[3]) != 4 || len(parts[4]) != 12 {
		return nil, false
	}
	b, err := hex.DecodeString(strings.Join(parts, ""))
	if err != nil {
		return nil, false
	}
	out := make([]byte, 16)
	binary.LittleEndian.PutUint32(out[0:4], binary.BigEndian.Uint32(b[0:4]))
	binary.LittleEndian.PutUint16(out[4:6], binary.BigEndian.Uint16(b[4:6]))
	binary.LittleEndian.PutUint16(out[6:8], binary.BigEndian.Uint16(b[6:8]))
	copy(out[8:], b[8:])
	return out, true
}

// stableIDBases drops empty bases and bases at or below another listed base
// (a subtree search covers them), keeping the order (the tree's bases first).
func stableIDBases(bases []string) []string {
	var out []string
	var parsed []*goldap.DN
	for _, b := range bases {
		b = strings.TrimSpace(b)
		if b == "" {
			continue
		}
		pb, err := goldap.ParseDN(b)
		covered := false
		for i, o := range out {
			if err == nil && parsed[i] != nil {
				if parsed[i].EqualFold(pb) || parsed[i].AncestorOfFold(pb) {
					covered = true
					break
				}
			} else if strings.EqualFold(o, b) {
				covered = true
				break
			}
		}
		if !covered {
			out = append(out, b)
			if err != nil {
				pb = nil
			}
			parsed = append(parsed, pb)
		}
	}
	return out
}
