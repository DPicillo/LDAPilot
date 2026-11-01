package ldif

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// Subtree exports come back from the server in any order; the LDIF must
// list every parent before its children.
func TestSortParentFirst(t *testing.T) {
	entries := []models.LDAPEntry{
		{DN: "CN=Schmidt\\, Anna,OU=Special,DC=ad,DC=lab"},
		{DN: "OU=Child,OU=Special,DC=ad,DC=lab"},
		{DN: "OU=Special,DC=ad,DC=lab"},
		{DN: "CN=x,OU=Child,OU=Special,DC=ad,DC=lab"},
		{DN: "CN=b,OU=Special,DC=ad,DC=lab"},
	}
	SortParentFirst(entries)
	got := make([]string, len(entries))
	for i, e := range entries {
		got[i] = e.DN
	}
	want := []string{
		"OU=Special,DC=ad,DC=lab",
		"CN=Schmidt\\, Anna,OU=Special,DC=ad,DC=lab", // escaped comma: same depth, order kept
		"OU=Child,OU=Special,DC=ad,DC=lab",
		"CN=b,OU=Special,DC=ad,DC=lab",
		"CN=x,OU=Child,OU=Special,DC=ad,DC=lab",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("order:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// An exported AD entry re-imports with the raw objectGUID / objectSid bytes;
// the importable variant leaves server-maintained attributes out.
func TestExportADValuesRawAndImportable(t *testing.T) {
	guid := "9c60d57e-1234-5678-9abc-def001020304"
	entry := models.LDAPEntry{DN: "CN=u1,OU=Special,DC=ad,DC=lab", Attributes: []models.LDAPAttribute{
		{Name: "objectClass", Values: []string{"top", "person", "organizationalPerson", "user"}},
		{Name: "cn", Values: []string{"u1"}},
		{Name: "objectGUID", Values: []string{guid}},
		{Name: "objectSid", Values: []string{"S-1-5-21-1-2-3-1105"}},
		{Name: "whenCreated", Values: []string{"20261031143622.0Z"}},
		{Name: "uSNChanged", Values: []string{"4711"}},
		{Name: "memberOf", Values: []string{"CN=g,DC=ad,DC=lab"}},
		{Name: "description", Values: []string{"=cmd"}},
		{Name: "entryUUID", Values: []string{"x"}},
		{Name: "customOp", Values: []string{"y"}},
	}}
	out, err := Export([]models.LDAPEntry{entry})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, guid) || !strings.Contains(out, "objectGUID:: ") || !strings.Contains(out, "objectSid:: ") {
		t.Fatalf("GUID / SID not raw:\n%s", out)
	}
	parsed, err := Parse(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range parsed[0].Attributes {
		if a.Name == "objectGUID" {
			raw, _ := base64.StdEncoding.DecodeString(a.Values[0])
			want := []byte{0x7e, 0xd5, 0x60, 0x9c, 0x34, 0x12, 0x78, 0x56, 0x9a, 0xbc, 0xde, 0xf0, 0x01, 0x02, 0x03, 0x04}
			if !a.Binary || !bytes.Equal(raw, want) {
				t.Fatalf("objectGUID parsed = %+v (%x)", a, raw)
			}
		}
	}

	// Samba / AD publish objectClass as NO-USER-MODIFICATION: it is kept anyway.
	stripped := StripNonImportable([]models.LDAPEntry{entry}, map[string]bool{"customop": true, "objectclass": true})
	var names []string
	for _, a := range stripped[0].Attributes {
		names = append(names, a.Name)
	}
	if strings.Join(names, ",") != "objectClass,cn,description" {
		t.Fatalf("importable attributes = %v", names)
	}
	kept := KeepAttributes(stripped, []string{"CN"}, true)
	if len(kept[0].Attributes) != 2 || kept[0].Attributes[0].Name != "objectClass" {
		t.Fatalf("KeepAttributes = %+v", kept[0].Attributes)
	}
}

func TestCSVNeutralizesFormulas(t *testing.T) {
	out, err := ExportCSV([]models.LDAPEntry{{DN: "cn=a", Attributes: []models.LDAPAttribute{{Name: "description", Values: []string{"=HYPERLINK(\"x\")"}}}}}, []string{"description"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"'=HYPERLINK(""x"")"`) {
		t.Fatalf("csv = %s", out)
	}
}

// Values that refer to entries of the same export (member, manager) come
// after those entries (AD refuses DN values of entries that do not exist
// yet); reference cycles do not loop.
func TestSortParentFirstReferences(t *testing.T) {
	entries := []models.LDAPEntry{
		{DN: "CN=Team,OU=Src,DC=ad,DC=lab", Attributes: []models.LDAPAttribute{{Name: "member", Values: []string{"cn=anna, ou=src,dc=AD,dc=lab", "CN=Outside,DC=ad,DC=lab"}}}},
		{DN: "CN=Anna,OU=Src,DC=ad,DC=lab", Attributes: []models.LDAPAttribute{{Name: "manager", Values: []string{"CN=Boss,OU=Sub,OU=Src,DC=ad,DC=lab"}}}},
		{DN: "OU=Src,DC=ad,DC=lab"},
		{DN: "CN=Boss,OU=Sub,OU=Src,DC=ad,DC=lab"},
		{DN: "OU=Sub,OU=Src,DC=ad,DC=lab"},
		{DN: "CN=x,OU=Src,DC=ad,DC=lab", Attributes: []models.LDAPAttribute{{Name: "seeAlso", Values: []string{"CN=y,OU=Src,DC=ad,DC=lab"}}}},
		{DN: "CN=y,OU=Src,DC=ad,DC=lab", Attributes: []models.LDAPAttribute{{Name: "seeAlso", Values: []string{"CN=x,OU=Src,DC=ad,DC=lab"}}}},
	}
	SortParentFirst(entries)
	got := make([]string, len(entries))
	for i, e := range entries {
		got[i] = strings.SplitN(e.DN, ",", 2)[0]
	}
	want := "OU=Src|OU=Sub|CN=Boss|CN=Anna|CN=Team|CN=x|CN=y"
	if strings.Join(got, "|") != want {
		t.Fatalf("order %s, want %s", strings.Join(got, "|"), want)
	}
}
