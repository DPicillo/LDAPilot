package services

import (
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

func TestDescribeChangesForAudit(t *testing.T) {
	got := describeChangesForAudit([]models.AttributeChange{
		{Operation: "replace", Attribute: "mail", Values: []string{"a@example.org"}},
		{Operation: "delete", Attribute: "description"},
		{Operation: "delete", Attribute: "unicodePwd", Values: []string{"OldSecret1!"}},
		{Operation: "add", Attribute: "unicodePwd", Values: []string{"NewSecret1!"}},
		{Operation: "replace", Attribute: "userPassword;x", Values: []string{"{SSHA}abc"}},
		{Operation: "add", Attribute: "jpegPhoto", Values: []string{"AP8A"}, Binary: true},
		{Operation: "add", Attribute: "member", Values: []string{"cn=1", "cn=2", "cn=3", "cn=4", "cn=5"}},
		{Operation: "replace", Attribute: "info", Values: []string{strings.Repeat("ä", 100)}},
	})
	for _, secret := range []string{"OldSecret1!", "NewSecret1!", "{SSHA}abc"} {
		if strings.Contains(got, secret) {
			t.Errorf("password leaked into audit details: %s", got)
		}
	}
	for _, want := range []string{
		"replace mail=[a@example.org]",
		"delete description",
		"delete unicodePwd=[***]",
		"add unicodePwd=[***]",
		"add jpegPhoto=[<binary 3 bytes>]",
		"add member=[cn=1; cn=2; cn=3; +2 more]",
		"replace info=[" + strings.Repeat("ä", 80) + "...]",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("audit details %q missing %q", got, want)
		}
	}
}

func TestIsSensitiveAttribute(t *testing.T) {
	for _, name := range []string{
		"unicodePwd", "userPassword", "userPassword;binary", "authPassword", "sambaNTPassword", "sambaLMPassword",
		"dBCSPwd", "ntPwdHistory", "lmPwdHistory", "supplementalCredentials", "msDS-ManagedPassword",
		"krbPrincipalKey", "userPKCS12",
		"ms-Mcs-AdmPwd", "msLAPS-Password", "msLAPS-EncryptedPassword", "msLAPS-EncryptedDSRMPassword",
		"olcRootPW", "nsslapd-rootpw", "msFVE-RecoveryPassword", "sambaPasswordHistory",
		"unixUserPassword", "pwdHistory", "passwordHistory", "msTPM-OwnerInformation",
		"2.5.4.35", "2.5.4.35;binary", "1.2.840.113556.1.4.90", "1.3.6.1.4.1.4203.1.3.4", // by OID
	} {
		if !isSensitiveAttribute(name) {
			t.Errorf("%s must be masked", name)
		}
	}
	for _, name := range []string{"pwdLastSet", "pwdReset", "pwdPolicySubentry", "mail", "description", "member",
		"badPasswordTime", "passwordExpirationTime", "passwordRetryCount", "msDS-UserPasswordExpiryTimeComputed",
		"msDS-MinimumPasswordLength", "msDS-MaximumPasswordAge", "msDS-PasswordSettingsPrecedence"} {
		if isSensitiveAttribute(name) {
			t.Errorf("%s must not be masked", name)
		}
	}

	got := describeChangesForAudit([]models.AttributeChange{
		{Operation: "replace", Attribute: "olcRootPW", Values: []string{"S3cret!"}},
		{Operation: "replace", Attribute: "ms-Mcs-AdmPwd", Values: []string{"S3cret!"}},
		{Operation: "replace", Attribute: "msLAPS-Password", Values: []string{"S3cret!"}},
		{Operation: "replace", Attribute: "nsslapd-rootpw", Values: []string{"S3cret!"}},
		{Operation: "replace", Attribute: "msFVE-RecoveryPassword", Values: []string{"S3cret!"}},
		{Operation: "replace", Attribute: "pwdLastSet", Values: []string{"0"}},
	})
	if strings.Contains(got, "S3cret!") {
		t.Errorf("secret leaked into audit details: %s", got)
	}
	if oid := describeChangesForAudit([]models.AttributeChange{{Operation: "replace", Attribute: "2.5.4.35", Values: []string{"Winter2026!"}}}); oid != "replace 2.5.4.35=[***]" {
		t.Errorf("userPassword by OID: %s", oid)
	}
	if !strings.Contains(got, "replace olcRootPW=[***]") || !strings.Contains(got, "replace pwdLastSet=[0]") {
		t.Errorf("unexpected audit details: %s", got)
	}
}

// The audit of a modify shows the values before the write and the new ones;
// value-level changes name their values; secrets are never shown.
func TestDescribeChangesWithBefore(t *testing.T) {
	changes := []models.AttributeChange{
		{Operation: "replace", Attribute: "description", Values: []string{"New text"}},
		{Operation: "replace", Attribute: "title", Values: []string{"Boss"}},
		{Operation: "delete", Attribute: "telephoneNumber"},
		{Operation: "add", Attribute: "mail", Values: []string{"b@example.org"}},
		{Operation: "delete", Attribute: "otherMailbox", Values: []string{"x@example.org"}},
		{Operation: "replace", Attribute: "userPassword", Values: []string{"Secret1!"}},
		{Operation: "replace", Attribute: "thumbnailPhoto", Values: []string{"AAEC"}, Binary: true},
	}
	if got := auditBeforeAttrs(changes); strings.Join(got, ",") != "description,title,telephoneNumber,thumbnailPhoto" {
		t.Fatalf("auditBeforeAttrs = %v (secrets and value-level changes are not read)", got)
	}
	entry := &models.LDAPEntry{DN: "cn=x", Attributes: []models.LDAPAttribute{
		{Name: "description", Values: []string{"Old text"}},
		{Name: "telephoneNumber", Values: []string{"123"}},
		{Name: "userPassword", Values: []string{"{SSHA}old"}},
		{Name: "thumbnailPhoto;binary", Values: []string{"AAECAw=="}, Binary: true},
	}}
	before := auditBeforeFromEntry(entry, changes)
	got := describeChangesWithBefore(changes, before)
	for _, want := range []string{
		"replace description: [Old text] → [New text]",
		"replace title: (none) → [Boss]",
		"delete telephoneNumber: [123] → (removed)",
		"add mail: +[b@example.org]",
		"delete otherMailbox: -[x@example.org]",
		"replace userPassword=[***]",
		"replace thumbnailPhoto: [<binary 4 bytes>] → [<binary 3 bytes>]",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("details %q missing %q", got, want)
		}
	}
	for _, secret := range []string{"Secret1!", "{SSHA}old"} {
		if strings.Contains(got, secret) {
			t.Errorf("secret leaked: %s", got)
		}
	}
	// No snapshot: the plain description.
	if describeChangesWithBefore(changes[:1], nil) != "replace description=[New text]" {
		t.Errorf("nil before = %q", describeChangesWithBefore(changes[:1], nil))
	}
}

func TestRenameAuditOperation(t *testing.T) {
	dn := "CN=Schmidt\\, Anna,OU=Users,DC=ad,DC=lab"
	if op := renameAuditOperation(dn, ""); op != "RENAME" {
		t.Errorf("no newSuperior = %s", op)
	}
	if op := renameAuditOperation(dn, "ou=users,dc=ad,dc=lab"); op != "RENAME" {
		t.Errorf("same parent (other case) = %s", op)
	}
	if op := renameAuditOperation(dn, "OU=Staff,DC=ad,DC=lab"); op != "MOVE" {
		t.Errorf("new parent = %s", op)
	}
	got := describeRenameForAudit(dn, "CN=Schmidt\\, Anna", true, "OU=Staff,DC=ad,DC=lab")
	if !strings.HasSuffix(got, " newDN=CN=Schmidt\\, Anna,OU=Staff,DC=ad,DC=lab") {
		t.Errorf("move details = %q", got)
	}
	got = describeRenameForAudit(dn, "CN=Anna Schmidt", false, "")
	if !strings.HasSuffix(got, "deleteOldRDN=false newDN=CN=Anna Schmidt,OU=Users,DC=ad,DC=lab") {
		t.Errorf("rename details = %q", got)
	}
}
