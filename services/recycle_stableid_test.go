package services

import (
	"bytes"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

func TestGuidBytesRoundTrip(t *testing.T) {
	// objectGUID bytes as AD stores them and the text the formatter shows.
	raw := []byte{0x78, 0x56, 0x34, 0x12, 0xbc, 0x9a, 0xf0, 0xde, 0x01, 0x28, 0x29, 0x2a, 0x5c, 0x00, 0x7f, 0x80}
	text := "12345678-9abc-def0-0128-292a5c007f80"
	got, ok := guidBytes(text)
	if !ok || !bytes.Equal(got, raw) {
		t.Fatalf("guidBytes(%q) = %x, %v; want %x", text, got, ok, raw)
	}
	if got, ok := guidBytes("{" + text + "}"); !ok || !bytes.Equal(got, raw) {
		t.Fatalf("braced GUID not accepted: %x %v", got, ok)
	}
	for _, bad := range []string{"", "12345678-9abc-def0-0128", "1234567g-9abc-def0-0128-292a5c007f80", "123456789abcdef00128292a5c007f80"} {
		if _, ok := guidBytes(bad); ok {
			t.Errorf("guidBytes(%q) accepted", bad)
		}
	}
	// The assertion value survives filter escaping and compilation as the raw bytes
	// (special characters, NUL and bytes >= 0x80 are hex-escaped, others sent as is).
	attr, value, err := stableIDFilterValue("objectGUID:" + text)
	if err != nil || attr != "objectGUID" {
		t.Fatalf("stableIDFilterValue: %q %v", attr, err)
	}
	pkt, err := goldap.CompileFilter(fmt.Sprintf("(%s=%s)", attr, goldap.EscapeFilter(value)))
	if err != nil {
		t.Fatalf("CompileFilter: %v", err)
	}
	if len(pkt.Children) != 2 || !bytes.Equal(pkt.Children[1].Data.Bytes(), raw) {
		t.Fatalf("compiled assertion value = %x, want %x", pkt.Children[1].Data.Bytes(), raw)
	}
}

func TestParseStableID(t *testing.T) {
	cases := []struct {
		in, attr, value string
		ok              bool
	}{
		{"entryUUID:5c1a…", "entryUUID", "5c1a…", true},
		{"nsuniqueid: a1b2c3d4-11111111-22222222-33333333 ", "nsUniqueId", "a1b2c3d4-11111111-22222222-33333333", true},
		{"OBJECTGUID:12345678-9abc-def0-0128-292a5c007f80", "objectGUID", "12345678-9abc-def0-0128-292a5c007f80", true},
		{"cn:alice", "", "", false},
		{"entryUUID:", "", "", false},
		{"plain", "", "", false},
	}
	for _, c := range cases {
		attr, value, ok := parseStableID(c.in)
		if attr != c.attr || value != c.value || ok != c.ok {
			t.Errorf("parseStableID(%q) = %q %q %v", c.in, attr, value, ok)
		}
	}
	if _, _, err := stableIDFilterValue("objectGUID:not-a-guid"); err == nil {
		t.Error("an invalid objectGUID must be refused")
	}
}

func TestStableIDFromPrefersGuidThenUniqueID(t *testing.T) {
	attrs := map[string]models.LDAPAttribute{
		"entryuuid":  {Name: "entryUUID", Values: []string{"e-1"}},
		"nsuniqueid": {Name: "nsUniqueId", Values: []string{"n-1"}},
	}
	if got := stableIDFrom(attrs); got != "nsUniqueId:n-1" {
		t.Errorf("389DS: got %q", got)
	}
	delete(attrs, "nsuniqueid")
	if got := stableIDFrom(attrs); got != "entryUUID:e-1" {
		t.Errorf("OpenLDAP: got %q", got)
	}
	attrs["objectguid"] = models.LDAPAttribute{Name: "objectGUID", Values: []string{"12345678-9abc-def0-0128-292a5c007f80"}}
	if got := stableIDFrom(attrs); got != "objectGUID:12345678-9abc-def0-0128-292a5c007f80" {
		t.Errorf("AD: got %q", got)
	}
	// A GUID the formatter could not render (binary) is no id.
	if got := stableIDFrom(map[string]models.LDAPAttribute{"objectguid": {Name: "objectGUID", Binary: true, Values: []string{"AAAA"}}}); got != "" {
		t.Errorf("binary objectGUID: got %q", got)
	}
}

func TestStableIDBases(t *testing.T) {
	got := stableIDBases([]string{"OU=Lab,DC=ad,DC=x", "", "DC=ad,DC=x", "dc=AD, dc=x", "CN=Configuration,DC=ad,DC=x", "DC=child,DC=ad,DC=x", "DC=other"})
	want := []string{"OU=Lab,DC=ad,DC=x", "DC=ad,DC=x", "DC=other"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("stableIDBases = %v, want %v", got, want)
	}
}

func TestListDescendantsBreadthFirst(t *testing.T) {
	tree := map[string][]string{
		"OU=r":           {"OU=a,OU=r", "CN=x,OU=r"},
		"OU=a,OU=r":      {"CN=a1,OU=a,OU=r", "OU=b,OU=a,OU=r"},
		"OU=b,OU=a,OU=r": {"CN=b1,OU=b,OU=a,OU=r"},
	}
	probes := 0
	children := func(dn string, n int) ([]string, bool, error) {
		probes++
		kids := tree[dn]
		if len(kids) > n {
			return kids[:n], true, nil
		}
		return kids, false, nil
	}
	dns, truncated, err := listDescendants("OU=r", 50, children)
	if err != nil || truncated {
		t.Fatalf("err=%v truncated=%v", err, truncated)
	}
	want := []string{"OU=a,OU=r", "CN=x,OU=r", "CN=a1,OU=a,OU=r", "OU=b,OU=a,OU=r", "CN=b1,OU=b,OU=a,OU=r"}
	if !reflect.DeepEqual(dns, want) {
		t.Errorf("dns = %v", dns)
	}
	if probes != 6 {
		t.Errorf("probes = %d, want one per entry (6)", probes)
	}

	probes = 0
	dns, truncated, _ = listDescendants("OU=r", 3, children)
	if !truncated || !reflect.DeepEqual(dns, want[:3]) {
		t.Errorf("limit 3: %v truncated=%v", dns, truncated)
	}
	if probes > 4 {
		t.Errorf("limit 3: %d probes, want at most limit+1", probes)
	}

	if _, _, err := listDescendants("OU=missing", 5, func(string, int) ([]string, bool, error) { return nil, false, errors.New("boom") }); err == nil {
		t.Error("a failed read of the root must be an error")
	}
	// A failed level below the root only truncates.
	dns, truncated, err = listDescendants("OU=r", 50, func(dn string, n int) ([]string, bool, error) {
		if dn == "OU=a,OU=r" {
			return nil, false, errors.New("insufficient access")
		}
		return children(dn, n)
	})
	if err != nil || !truncated || len(dns) != 2 {
		t.Errorf("failed level: %v truncated=%v err=%v", dns, truncated, err)
	}
}
