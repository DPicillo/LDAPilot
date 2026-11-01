package services

import (
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// writeAudit appends an audit entry for a write operation on profileID. The
// bind DN of the profile's connection is recorded as user. Without a store
// nothing is written.
func writeAudit(store *config.AuditStore, pool *ldap.Pool, profileID, operation, dn, details string, err error) {
	if store == nil {
		return
	}
	entry := config.AuditEntry{
		Operation: operation,
		DN:        dn,
		Details:   details,
	}
	if err != nil {
		entry.Error = err.Error()
	}
	// The identity the connection is bound as (bind DN, NTLM user, Kerberos principal)
	if client, cerr := pool.Get(profileID); cerr == nil {
		entry.User = ldap.AuthIdentity(client.Profile())
	}
	_ = store.Append(profileID, entry)
}

// sensitiveAttributes are lowercase names of attributes holding secrets
// (cleartext passwords, password hashes, keys) whose values never appear in
// the audit log. isSensitiveAttribute also masks names matching
// sensitiveAttributePatterns.
var sensitiveAttributes = map[string]bool{
	"supplementalcredentials": true,
	"krbprincipalkey":         true,
	"krbmkey":                 true,
	"userpkcs12":              true,
	"mstpm-ownerinformation":  true, // TPM owner password hash (AD)
	"olcrootpw":               true, // OpenLDAP cn=config root password
	"nsslapd-rootpw":          true, // 389DS cn=config root password
	// password attributes written by their OID instead of their name
	ldap.OIDUserPassword: true, // userPassword
	ldap.OIDUnicodePwd:   true, // unicodePwd
	ldap.OIDAuthPassword: true, // authPassword
}

// sensitiveAttributePatterns catch password attributes by name: userPassword,
// authPassword, sambaNTPassword, msLAPS-Password, msLAPS-EncryptedPassword,
// msFVE-RecoveryPassword, unixUserPassword, passwordHistory (substring
// "password"), unicodePwd, dBCSPwd, ms-Mcs-AdmPwd (suffix "pwd"),
// ntPwdHistory, pwdHistory (substring "pwdhistory"), rootpw variants and
// generic secrets. Timestamps and flags such as pwdLastSet or pwdReset are
// not matched.
var sensitiveAttributePatterns = []func(name string) bool{
	func(n string) bool { return strings.Contains(n, "password") },
	func(n string) bool { return strings.HasSuffix(n, "pwd") },
	func(n string) bool { return strings.Contains(n, "pwdhistory") },
	func(n string) bool { return strings.HasSuffix(n, "rootpw") },
	func(n string) bool { return strings.Contains(n, "secret") },
}

// passwordMetadataSuffixes mark timestamps, counters and policy values whose
// names merely mention "password" (badPasswordTime, passwordExpirationTime,
// passwordRetryCount, msDS-UserPasswordExpiryTimeComputed,
// msDS-MinimumPasswordLength/Age): they are not secrets.
var passwordMetadataSuffixes = []string{"time", "timecomputed", "count", "length", "age", "precedence", "enabled", "warned"}

func isPasswordMetadata(n string) bool {
	if !strings.Contains(n, "password") {
		return false
	}
	for _, s := range passwordMetadataSuffixes {
		if strings.HasSuffix(n, s) {
			return true
		}
	}
	return false
}

// isSensitiveAttribute reports whether values of the attribute must be masked.
func isSensitiveAttribute(name string) bool {
	if i := strings.IndexByte(name, ';'); i >= 0 {
		name = name[:i]
	}
	name = strings.ToLower(name)
	if sensitiveAttributes[name] {
		return true
	}
	if isPasswordMetadata(name) {
		return false
	}
	for _, match := range sensitiveAttributePatterns {
		if match(name) {
			return true
		}
	}
	return false
}

// Limits for values shown in audit details.
const (
	auditMaxValues   = 3
	auditMaxValueLen = 80
)

// auditValues renders values for the audit log: passwords are masked, binary
// values shown by size, long values and long lists shortened.
func auditValues(attr string, values []string, binary bool) string {
	shown := make([]string, 0, auditMaxValues+1)
	for i, v := range values {
		if i == auditMaxValues {
			shown = append(shown, fmt.Sprintf("+%d more", len(values)-auditMaxValues))
			break
		}
		switch {
		case isSensitiveAttribute(attr):
			v = "***"
		case binary:
			v = fmt.Sprintf("<binary %d bytes>", base64.StdEncoding.DecodedLen(len(v))-strings.Count(v, "="))
		case len([]rune(v)) > auditMaxValueLen:
			v = string([]rune(v)[:auditMaxValueLen]) + "..."
		}
		shown = append(shown, v)
	}
	return "[" + strings.Join(shown, "; ") + "]"
}

// describeChangesForAudit summarizes modify changes for the audit log,
// e.g. "replace mail=[a@example.org]; delete description".
func describeChangesForAudit(changes []models.AttributeChange) string {
	parts := make([]string, 0, len(changes))
	for _, ch := range changes {
		part := strings.ToLower(ch.Operation) + " " + ch.Attribute
		if len(ch.Values) > 0 {
			part += "=" + auditValues(ch.Attribute, ch.Values, ch.Binary)
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, "; ")
}

// describeAttributesForAudit lists the attribute names of a new entry.
func describeAttributesForAudit(attrs []models.LDAPAttribute) string {
	names := make([]string, 0, len(attrs))
	for _, a := range attrs {
		names = append(names, a.Name)
	}
	return "attrs: " + strings.Join(names, ", ")
}

// auditBeforeAttrs returns the attributes whose current values an audit
// entry shows before the write: those replaced or removed completely
// (value-level add/delete name their values themselves). Secret attributes
// are left out (never read, always masked).
func auditBeforeAttrs(changes []models.AttributeChange) []string {
	var names []string
	seen := map[string]bool{}
	for _, ch := range changes {
		op := strings.ToLower(ch.Operation)
		if op != models.ChangeReplace && !(op == models.ChangeDelete && len(ch.Values) == 0) {
			continue
		}
		key := strings.ToLower(ch.Attribute)
		if ch.Attribute == "" || seen[key] || isSensitiveAttribute(ch.Attribute) {
			continue
		}
		seen[key] = true
		names = append(names, ch.Attribute)
	}
	return names
}

// auditBefore reads the values the changes will replace or remove (see
// auditBeforeAttrs) before the write, for the "old → new" audit details.
// A failed read gives nil: the audit then shows the new values only.
func auditBefore(client *ldap.Client, dn string, changes []models.AttributeChange) map[string]models.LDAPAttribute {
	names := auditBeforeAttrs(changes)
	if client == nil || len(names) == 0 {
		return nil
	}
	before, err := client.ReadAttributes(dn, names)
	if err != nil {
		return nil
	}
	return before
}

// auditBeforeFromEntry is auditBefore for an entry that was read anyway
// (bulk modify plans every entry on the values it read).
func auditBeforeFromEntry(entry *models.LDAPEntry, changes []models.AttributeChange) map[string]models.LDAPAttribute {
	if entry == nil {
		return nil
	}
	names := auditBeforeAttrs(changes)
	if len(names) == 0 {
		return nil
	}
	want := map[string]bool{}
	for _, n := range names {
		want[strings.ToLower(n)] = true
	}
	out := map[string]models.LDAPAttribute{}
	for _, a := range entry.Attributes {
		key := strings.ToLower(a.Name)
		if i := strings.IndexByte(key, ';'); i >= 0 {
			key = key[:i]
		}
		if want[key] {
			out[key] = a
		}
	}
	return out
}

// describeChangesWithBefore summarizes modify changes with the values before
// the write, e.g. "replace description: [Old text] → [New text]; add mail:
// +[a@example.org]; delete telephoneNumber: [123] → (removed)". Secrets are
// masked, binary values shown by size, long values shortened (auditValues).
// Without before values (nil) it is describeChangesForAudit.
func describeChangesWithBefore(changes []models.AttributeChange, before map[string]models.LDAPAttribute) string {
	if before == nil {
		return describeChangesForAudit(changes)
	}
	parts := make([]string, 0, len(changes))
	for _, ch := range changes {
		op := strings.ToLower(ch.Operation)
		key := strings.ToLower(ch.Attribute)
		if i := strings.IndexByte(key, ';'); i >= 0 {
			key = key[:i]
		}
		old, had := before[key]
		oldText := "(none)"
		if had && len(old.Values) > 0 {
			oldText = auditValues(ch.Attribute, old.Values, old.Binary)
		}
		switch {
		case isSensitiveAttribute(ch.Attribute):
			part := op + " " + ch.Attribute
			if len(ch.Values) > 0 {
				part += "=" + auditValues(ch.Attribute, ch.Values, ch.Binary)
			}
			parts = append(parts, part)
		case op == models.ChangeReplace:
			newText := "(removed)"
			if len(ch.Values) > 0 {
				newText = auditValues(ch.Attribute, ch.Values, ch.Binary)
			}
			parts = append(parts, fmt.Sprintf("replace %s: %s → %s", ch.Attribute, oldText, newText))
		case op == models.ChangeDelete && len(ch.Values) == 0:
			parts = append(parts, fmt.Sprintf("delete %s: %s → (removed)", ch.Attribute, oldText))
		case op == models.ChangeDelete:
			parts = append(parts, fmt.Sprintf("delete %s: -%s", ch.Attribute, auditValues(ch.Attribute, ch.Values, ch.Binary)))
		default:
			parts = append(parts, fmt.Sprintf("%s %s: +%s", op, ch.Attribute, auditValues(ch.Attribute, ch.Values, ch.Binary)))
		}
	}
	return strings.Join(parts, "; ")
}

// renameAuditOperation is the audit operation of a rename: MOVE when the
// entry gets another parent (newSuperior names a different DN), else RENAME.
func renameAuditOperation(dn, newSuperior string) string {
	if strings.TrimSpace(newSuperior) == "" {
		return "RENAME"
	}
	if bulkDNKey(newSuperior) == bulkDNKey(bulkParentDN(dn)) {
		return "RENAME"
	}
	return "MOVE"
}

// renamedDN is the DN of an entry after a rename/move: newRDN below
// newSuperior, or below its current parent when newSuperior is empty.
func renamedDN(dn, newRDN, newSuperior string) string {
	parent := strings.TrimSpace(newSuperior)
	if parent == "" {
		parent = bulkParentDN(dn)
	}
	if parent == "" {
		return newRDN
	}
	return newRDN + "," + parent
}

// describeRenameForAudit is the audit detail of a rename/move; newDN= lets
// the audit view link to the entry's new DN.
func describeRenameForAudit(dn, newRDN string, deleteOldRDN bool, newSuperior string) string {
	detail := fmt.Sprintf("newRDN=%s", newRDN)
	if newSuperior != "" {
		detail += fmt.Sprintf(" newSuperior=%s", newSuperior)
	}
	if !deleteOldRDN {
		detail += " deleteOldRDN=false"
	}
	return detail + " newDN=" + renamedDN(dn, newRDN, newSuperior)
}
