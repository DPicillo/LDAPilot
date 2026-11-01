package services

import (
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ldif"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// valueDirectory is a fakeDirectory that also finds entries by value
// (valueOwnerReader), like ldap.Client.DNsWithValue.
type valueDirectory struct {
	*fakeDirectory
	searches []string
}

func (d *valueDirectory) DNsWithValue(base, attr, value string, limit int) ([]string, error) {
	d.searches = append(d.searches, base+"|"+attr+"="+value)
	var out []string
	for _, e := range d.entries {
		for _, a := range e.Attributes {
			if strings.EqualFold(a.Name, attr) {
				for _, v := range a.Values {
					if strings.EqualFold(v, value) {
						out = append(out, e.DN)
					}
				}
			}
		}
	}
	return out, nil
}

// An AD export re-imported next to the original: sAMAccountName in use is a
// predicted failure (Samba: "samldb: sAMAccountName 'x' already in use"),
// userPrincipalName a warning; values freed by an earlier delete of the file
// and duplicates within the file are handled.
func TestLDIFPreviewADUniqueValues(t *testing.T) {
	dir := &valueDirectory{fakeDirectory: newFakeDirectory(
		entryOf("DC=ad,DC=lab", "dc", "ad"),
		entryOf("OU=Sandbox,DC=ad,DC=lab", "ou", "Sandbox"),
		entryOf("CN=Anna,OU=Old,DC=ad,DC=lab", "sAMAccountName", "anna", "userPrincipalName", "anna@ad.lab"),
		entryOf("CN=Ben,OU=Old,DC=ad,DC=lab", "sAMAccountName", "ben"),
	)}
	ad := newSchemaContext(nil, models.ServerTypeAD)
	ad.namingContexts = []string{"DC=ad,DC=lab", "CN=Configuration,DC=ad,DC=lab"}
	content := strings.Join([]string{
		"dn: CN=Anna,OU=Sandbox,DC=ad,DC=lab", "changetype: add", "objectClass: user", "sAMAccountName: Anna", "userPrincipalName: anna@ad.lab", "",
		"dn: CN=Ben,OU=Old,DC=ad,DC=lab", "changetype: delete", "",
		"dn: CN=Ben,OU=Sandbox,DC=ad,DC=lab", "changetype: add", "objectClass: user", "sAMAccountName: ben", "",
		"dn: CN=Carl,OU=Sandbox,DC=ad,DC=lab", "changetype: add", "objectClass: user", "sAMAccountName: carl", "",
		"dn: CN=Carl2,OU=Sandbox,DC=ad,DC=lab", "changetype: add", "objectClass: user", "sAMAccountName: CARL", "",
	}, "\n")
	parsed := ldif.ParseChanges(content, ldif.ParseOptions{})
	preview, _ := buildLDIFPreview(parsed, newLDIFSimulator(dir, ad), nil)
	got := make([]string, len(preview.Records))
	for i, r := range preview.Records {
		got[i] = r.Status + " " + strings.Join(r.Errors, ";") + " | " + strings.Join(r.Warnings, ";")
	}
	want := []string{
		"error sAMAccountName 'Anna' is already used by CN=Anna,OU=Old,DC=ad,DC=lab (AD keeps it unique) | userPrincipalName 'anna@ad.lab' is already used by CN=Anna,OU=Old,DC=ad,DC=lab",
		"ok",
		"ok",
		"ok",
		"error sAMAccountName 'CARL' is already used by CN=Carl,OU=Sandbox,DC=ad,DC=lab (an earlier record of this file)",
	}
	for i := range want {
		if !strings.HasPrefix(got[i], want[i]) {
			t.Errorf("record %d = %q\nwant prefix %q", i, got[i], want[i])
		}
	}
	if len(dir.searches) == 0 || !strings.HasPrefix(dir.searches[0], "DC=ad,DC=lab|") {
		t.Errorf("searches = %v", dir.searches)
	}

	// Not AD: no checks
	dir.searches = nil
	buildLDIFPreview(parsed, newLDIFSimulator(dir, newSchemaContext(nil, models.ServerTypeOpenLDAP)), nil)
	if len(dir.searches) != 0 {
		t.Errorf("OpenLDAP searched %v", dir.searches)
	}
}
