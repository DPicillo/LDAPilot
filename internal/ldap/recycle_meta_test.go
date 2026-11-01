package ldap

import (
	"encoding/binary"
	"reflect"
	"testing"
)

// replMetaBlob builds a version 1 replPropertyMetaData blob with the attids.
func replMetaBlob(attids ...uint32) []byte {
	b := make([]byte, 16+len(attids)*replMetaEntrySize)
	binary.LittleEndian.PutUint32(b, 1)
	binary.LittleEndian.PutUint32(b[8:], uint32(len(attids)))
	for i, id := range attids {
		binary.LittleEndian.PutUint32(b[16+i*replMetaEntrySize:], id)
		binary.LittleEndian.PutUint32(b[16+i*replMetaEntrySize+4:], 2)
	}
	return b
}

func TestDecodeReplPropertyMetaData(t *testing.T) {
	ids, err := decodeReplPropertyMetaData(replMetaBlob(0, 3, 0x00150003))
	if err != nil || !reflect.DeepEqual(ids, []uint32{0, 3, 0x00150003}) {
		t.Fatalf("ids = %x, err = %v", ids, err)
	}
	for _, bad := range [][]byte{nil, make([]byte, 10), replMetaBlob(1)[:30]} {
		if _, err := decodeReplPropertyMetaData(bad); err == nil {
			t.Errorf("no error for %d bytes", len(bad))
		}
	}
	v2 := replMetaBlob(1)
	binary.LittleEndian.PutUint32(v2, 2)
	if _, err := decodeReplPropertyMetaData(v2); err == nil {
		t.Error("version 2 accepted")
	}
}

func TestAttidOID(t *testing.T) {
	// Values seen on the lab's Samba DC.
	cases := map[uint32]string{
		0x00000004: "2.5.4.4",                   // sn
		0x00020119: "1.2.840.113556.1.2.281",    // nTSecurityDescriptor
		0x00090290: "1.2.840.113556.1.4.656",    // userPrincipalName
		0x00150003: "0.9.2342.19200300.100.1.3", // mail
		0x00160003: "2.16.840.1.113730.3.1.3",   // employeeNumber
	}
	for id, want := range cases {
		if got, ok := attidOID(id); !ok || got != want {
			t.Errorf("attidOID(%08x) = %q, %v; want %q", id, got, ok, want)
		}
	}
	for _, id := range []uint32{0x00050001, 0x80000001, 0x0009c001} {
		if got, ok := attidOID(id); ok {
			t.Errorf("attidOID(%08x) = %q, want unresolved", id, got)
		}
	}
}

func TestRestoredWithout(t *testing.T) {
	names := map[string]string{
		"2.5.4.0": "objectClass", "2.5.4.3": "cn", "2.5.4.4": "sn", "2.5.4.42": "givenName",
		"0.9.2342.19200300.100.1.3": "mail", "1.2.840.113556.1.4.90": "unicodePwd",
		"1.2.840.113556.1.4.160": "lmPwdHistory", "1.2.840.113556.1.4.96": "pwdLastSet",
		"1.2.840.113556.1.4.221": "sAMAccountName", "1.2.840.113556.1.4.656": "userPrincipalName",
	}
	oidName := func(oid string) string { return names[oid] }
	attids := []uint32{0, 3, 4, 42, 0x00150003, 0x0009005a, 0x000900a0, 0x00090060, 0x000900dd, 0x00090290, 0x00a00001}
	got, other := restoredWithout(attids, []string{"objectClass", "cn", "sAMAccountName", "userAccountControl"}, oidName)
	want := []string{"givenName", "mail", "sn", "userPrincipalName", "password"}
	if !reflect.DeepEqual(got, want) || other != 1 {
		t.Errorf("restoredWithout = %v, other %d; want %v, 1", got, other, want)
	}
	// Recycle Bin restore: everything is back.
	got, other = restoredWithout([]uint32{0, 3, 4}, []string{"objectClass", "cn", "sn"}, oidName)
	if len(got) != 0 || other != 0 {
		t.Errorf("complete restore = %v, %d", got, other)
	}
}

func TestNextPosixID(t *testing.T) {
	cases := []struct {
		ids  []int
		want int
	}{
		{nil, 10000},
		{[]int{0, 500, 999}, 10000},
		{[]int{1000, 1005, 2001}, 2002},
		{[]int{10000, 10007, 65534, 4294967}, 10008},
		{[]int{59999}, 10000},
	}
	for _, c := range cases {
		if got := nextPosixID(c.ids); got != c.want {
			t.Errorf("nextPosixID(%v) = %d, want %d", c.ids, got, c.want)
		}
	}
}

func TestDNToDNSName(t *testing.T) {
	cases := map[string]string{
		"DC=ad,DC=ldapilot,DC=lab":            "ad.ldapilot.lab",
		"OU=x,dc=demo, dc=ldapilot ,dc=local": "demo.ldapilot.local",
		"o=example":                           "",
		"":                                    "",
	}
	for dn, want := range cases {
		if got := DNToDNSName(dn); got != want {
			t.Errorf("DNToDNSName(%q) = %q, want %q", dn, got, want)
		}
	}
}
