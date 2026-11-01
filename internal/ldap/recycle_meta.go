package ldap

// What a restore did not bring back: AD keeps one replPropertyMetaData
// entry per attribute that was ever set on an object, also after the value
// was removed (deleting an object strips most attributes; their metadata
// version is bumped). Attributes listed there that the restored object does
// not have are the ones the restore came back without.

import (
	"encoding/binary"
	"errors"
	"sort"
	"strconv"
	"strings"

	goldap "github.com/go-ldap/ldap/v3"
)

// replMetaEntrySize is the size of one PROPERTY_META_DATA_EXT entry of a
// version 1 replPropertyMetaData blob (MS-DRSR 5.150): attid (4), version
// (4), originating change time (8), originating invocation ID (16),
// originating USN (8), local USN (8).
const replMetaEntrySize = 48

// decodeReplPropertyMetaData returns the attribute IDs of a version 1
// replPropertyMetaData blob (header: version, reserved, count, reserved).
func decodeReplPropertyMetaData(b []byte) ([]uint32, error) {
	if len(b) < 16 {
		return nil, errors.New("replPropertyMetaData too short")
	}
	if v := binary.LittleEndian.Uint32(b); v != 1 {
		return nil, errors.New("unsupported replPropertyMetaData version " + strconv.Itoa(int(v)))
	}
	n := int(binary.LittleEndian.Uint32(b[8:]))
	if n < 0 || 16+n*replMetaEntrySize > len(b) {
		return nil, errors.New("replPropertyMetaData truncated")
	}
	out := make([]uint32, n)
	for i := 0; i < n; i++ {
		out[i] = binary.LittleEndian.Uint32(b[16+i*replMetaEntrySize:])
	}
	return out, nil
}

// replAttidPrefixes are entries of the default AD/Samba prefix table
// (MS-DRSR 5.16.4) whose attribute IDs are "index << 16 | last arc". The
// table of a forest can add dynamic prefixes (non-base schema extensions);
// IDs with other indexes are not resolved by name.
var replAttidPrefixes = map[uint32]string{
	0:  "2.5.4",
	2:  "1.2.840.113556.1.2",
	9:  "1.2.840.113556.1.4",
	19: "0.9.2342.19200300.100",
	20: "2.16.840.1.113730.3",
	21: "0.9.2342.19200300.100.1",
	22: "2.16.840.1.113730.3.1",
}

// attidOID returns the OID of a default-prefix attribute ID.
func attidOID(attid uint32) (string, bool) {
	prefix, ok := replAttidPrefixes[attid>>16]
	low := attid & 0xffff
	if !ok || low >= 0x4000 {
		return "", false
	}
	return prefix + "." + strconv.Itoa(int(low)), true
}

// restoreSecretAttrs are stripped secrets, summarised as "password".
var restoreSecretAttrs = map[string]bool{
	"unicodepwd": true, "dbcspwd": true, "ntpwdhistory": true, "lmpwdhistory": true,
	"supplementalcredentials": true, "userpassword": true,
}

// restoreQuietAttrs are system-maintained attributes a restored object
// legitimately lacks or that the server re-creates; they are never listed
// as missing.
var restoreQuietAttrs = map[string]bool{
	"isdeleted": true, "isrecycled": true, "lastknownparent": true, "msds-lastknownrdn": true,
	"name": true, "distinguishedname": true, "objectcategory": true, "samaccounttype": true,
	"ntsecuritydescriptor": true, "instancetype": true, "whencreated": true, "whenchanged": true,
	"usncreated": true, "usnchanged": true, "iscriticalsystemobject": true, "admincount": true,
	"badpwdcount": true, "badpasswordtime": true, "lastlogon": true, "lastlogoff": true,
	"lastlogontimestamp": true, "logoncount": true, "pwdlastset": true, "accountexpires": true,
	"codepage": true, "countrycode": true, "primarygroupid": true, "dscorepropagationdata": true,
	"showinadvancedviewonly": true, "systemflags": true, "objectguid": true, "objectsid": true,
	"replpropertymetadata": true, "msds-revealeddsas": true, "lockouttime": true,
}

// restoredWithout compares the attribute IDs of the replication metadata with
// the attributes an object has: names (schema OID → name, resolved via
// oidName) of attributes with metadata but no value, sorted, secrets as one
// "password", system attributes left out, plus the number of IDs that could
// not be resolved by name.
func restoredWithout(attids []uint32, present []string, oidName func(oid string) string) (names []string, other int) {
	has := map[string]bool{}
	for _, p := range present {
		has[strings.ToLower(strings.SplitN(p, ";", 2)[0])] = true
	}
	seen := map[string]bool{}
	password := false
	for _, id := range attids {
		oid, ok := attidOID(id)
		name := ""
		if ok {
			name = oidName(oid)
		}
		if name == "" {
			other++
			continue
		}
		k := strings.ToLower(name)
		switch {
		case has[k], seen[k], restoreQuietAttrs[k]:
		case restoreSecretAttrs[k]:
			password = true
		default:
			seen[k] = true
			names = append(names, name)
		}
	}
	sort.Slice(names, func(i, j int) bool { return strings.ToLower(names[i]) < strings.ToLower(names[j]) })
	if password {
		names = append(names, "password")
	}
	return names, other
}

// RestoredWithout reads the replication metadata and the attribute names of
// the (restored, live) entry dn and returns the attributes it no longer has
// although they were set before (see restoredWithout). oidName maps an
// attribute OID to its schema name ("" when unknown). Not logged.
func (c *Client) RestoredWithout(dn string, oidName func(oid string) string) (names []string, other int, err error) {
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases, 1, 10, false,
		"(objectClass=*)", []string{"*", "replPropertyMetaData"}, nil)
	var entry *goldap.Entry
	err = c.read(func(conn *goldap.Conn) error {
		res, err := conn.Search(req)
		if err == nil && len(res.Entries) > 0 {
			entry = res.Entries[0]
		}
		return err
	})
	if err != nil {
		return nil, 0, searchError(err)
	}
	if entry == nil {
		return nil, 0, ErrNotFound
	}
	attids, err := decodeReplPropertyMetaData(entry.GetRawAttributeValue("replPropertyMetaData"))
	if err != nil {
		return nil, 0, err
	}
	present := make([]string, 0, len(entry.Attributes))
	for _, a := range entry.Attributes {
		present = append(present, a.Name)
	}
	names, other = restoredWithout(attids, present, oidName)
	return names, other, nil
}
