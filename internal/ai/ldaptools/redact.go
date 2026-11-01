package ldaptools

import (
	"fmt"
	"strings"

	ber "github.com/go-asn1-ber/asn1-ber"
	goldap "github.com/go-ldap/ldap/v3"

	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
)

// RedactedValue replaces the value of a secret attribute that a server
// returned although it was not requested.
const RedactedValue = "[redacted: secret attribute]"

// builtinSecrets is the exact built-in list (§6.5), lower-case.
var builtinSecrets = toSet(
	"unicodePwd", "userPassword", "authPassword", "ms-Mcs-AdmPwd", "msDS-ManagedPassword",
	"sambaNTPassword", "sambaLMPassword", "sambaPasswordHistory", "unixUserPassword", "userPKCS12",
	"supplementalCredentials", "dBCSPwd", "ntPwdHistory", "lmPwdHistory", "pwdHistory", "passwordHistory",
	"msFVE-RecoveryPassword", "msFVE-KeyPackage", "msTPM-OwnerInformation", "msTPM-OwnerInformationTemp",
	"msPKIAccountCredentials", "msPKIDPAPIMasterKeys", "krbPrincipalKey", "krbMKey", "krb5Key", "ipaNTHash",
	"trustAuthIncoming", "trustAuthOutgoing", "initialAuthIncoming", "initialAuthOutgoing", "currentValue",
	"priorValue", "olcRootPW", "nsslapd-rootpw",
)

// neverRedacted are metadata attributes that look like secrets by name but
// are not (§6.5).
var neverRedacted = toSet(
	"msLAPS-PasswordExpirationTime", "ms-Mcs-AdmPwdExpirationTime", "pwdLastSet", "pwdChangedTime", "pwdReset",
	"pwdAccountLockedTime", "pwdFailureTime", "pwdPolicySubentry", "pwdGraceUseTime", "pwdLastSuccess",
	"passwordExpirationTime", "passwordRetryCount", "passwordGraceUserTime", "msDS-UserPasswordExpiryTimeComputed",
	"pwdHistoryLength", "msDS-PasswordHistoryLength", "badPwdCount", "badPasswordTime",
)

// BuiltinSecretNames returns the built-in secret attribute names (for the
// settings UI).
func BuiltinSecretNames() []string {
	out := make([]string, 0, len(builtinSecrets))
	for _, n := range builtinOrder {
		out = append(out, n)
	}
	return out
}

var builtinOrder = []string{
	"unicodePwd", "userPassword", "authPassword", "ms-Mcs-AdmPwd", "msLAPS-*", "msDS-ManagedPassword",
	"sambaNTPassword", "sambaLMPassword", "supplementalCredentials", "msFVE-RecoveryPassword", "msFVE-KeyPackage",
	"msTPM-OwnerInformation", "krbPrincipalKey", "krb5Key", "ipaNTHash", "olcRootPW", "nsslapd-rootpw",
}

func toSet(names ...string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[strings.ToLower(n)] = true
	}
	return m
}

// hardSecretOIDs are password attributes recognised by OID even when the
// schema is not readable (the name forms are in builtinSecrets):
// authPassword (RFC 3112) and ppolicy's pwdHistory. userPassword (2.5.4.35)
// and unicodePwd (1.2.840.113556.1.4.90) are matched by the password
// storage policy's own checks (ldap.IsPasswordAttribute,
// ldap.IsUnicodePwdAttribute, GitHub issue #1).
var hardSecretOIDs = toSet("1.3.6.1.4.1.4203.1.3.4", "1.3.6.1.4.1.42.2.27.8.1.20")

// IsPasswordSecret reports whether name (any option, any case) is a
// password attribute that is never shown to the model under any setting:
// userPassword / 2.5.4.35, unicodePwd / 1.2.840.113556.1.4.90,
// authPassword, pwdHistory (name or OID).
func IsPasswordSecret(name string) bool {
	base := strings.ToLower(strings.TrimSpace(BaseAttr(name)))
	if base == "" {
		return false
	}
	return internalldap.IsPasswordAttribute(base) || internalldap.IsUnicodePwdAttribute(base) ||
		base == "authpassword" || base == "pwdhistory" || hardSecretOIDs[base]
}

// IsNeverRedacted reports whether the name is a metadata exception.
func IsNeverRedacted(name string) bool { return neverRedacted[strings.ToLower(BaseAttr(name))] }

// RedactPolicy is the redaction configuration of a call (live policy).
type RedactPolicy struct {
	User               []string          // user entries: "name", "prefix*" or a numeric OID
	Extra              func(string) bool // services.isSensitiveAttribute (injected)
	MaskPasswordValues bool              // mask password-like free text
}

// Redactor decides which attributes are secret, resolving names through
// the connection's schema (aliases and OIDs).
type Redactor struct {
	pol    RedactPolicy
	schema *Schema
}

// NewRedactor creates a redactor. schema may be nil (then every OID-form
// name counts as secret).
func NewRedactor(pol RedactPolicy, schema *Schema) *Redactor {
	return &Redactor{pol: pol, schema: schema}
}

// MaskPasswords reports whether password-like free text is masked.
func (r *Redactor) MaskPasswords() bool { return r.pol.MaskPasswordValues }

// Schema returns the schema used for name resolution (may be nil).
func (r *Redactor) Schema() *Schema { return r.schema }

func (r *Redactor) nameSecret(n string) bool {
	l := strings.ToLower(n)
	if neverRedacted[l] {
		return false
	}
	if builtinSecrets[l] || strings.HasPrefix(l, "mslaps-") {
		return true
	}
	if strings.Contains(l, "password") || strings.Contains(l, "secret") || strings.Contains(l, "privatekey") ||
		strings.Contains(l, "pwdhistory") {
		return true
	}
	if strings.HasSuffix(l, "pwd") || strings.HasSuffix(l, "rootpw") || strings.HasSuffix(l, "credentials") {
		return true
	}
	if r.pol.Extra != nil && r.pol.Extra(n) {
		return true
	}
	for _, u := range r.pol.User {
		u = strings.ToLower(strings.TrimSpace(u))
		if u == "" {
			continue
		}
		if strings.HasSuffix(u, "*") {
			if strings.HasPrefix(l, strings.TrimSuffix(u, "*")) {
				return true
			}
		} else if u == l {
			return true
		}
	}
	return false
}

func (r *Redactor) userOID(oid string) bool {
	for _, u := range r.pol.User {
		if strings.TrimSpace(u) == oid {
			return true
		}
	}
	return false
}

// IsSecret reports whether the attribute (any name of its type, resolved
// through the schema) is secret. An OID that cannot be resolved counts as
// secret.
func (r *Redactor) IsSecret(name string) bool {
	base := strings.TrimSpace(BaseAttr(name))
	if base == "" {
		return false
	}
	if IsPasswordSecret(base) {
		return true
	}
	if neverRedacted[strings.ToLower(base)] {
		return false
	}
	if a := r.schema.Attr(base); a != nil {
		for _, n := range append([]string{a.OID}, a.Names...) {
			if IsPasswordSecret(n) {
				return true
			}
		}
		if r.userOID(a.OID) {
			return true
		}
		for _, n := range a.Names {
			if neverRedacted[strings.ToLower(n)] {
				return false
			}
		}
		for _, n := range a.Names {
			if r.nameSecret(n) {
				return true
			}
		}
		if IsNumericOID(base) {
			return false
		}
		return r.nameSecret(base)
	}
	if IsNumericOID(base) {
		return true // unresolvable OID
	}
	return r.nameSecret(base)
}

// ResolveRequested checks one requested attribute description. It returns
// the name to send, whether it is secret, and an error text for an OID that
// cannot be resolved.
func (r *Redactor) ResolveRequested(name string) (send string, secret bool, bad string) {
	base := BaseAttr(strings.TrimSpace(name))
	if IsPasswordSecret(base) {
		return name, true, ""
	}
	if IsNumericOID(base) {
		a := r.schema.Attr(base)
		if a == nil {
			return name, true, fmt.Sprintf("unknown attribute OID %s; use the attribute name", base)
		}
		return name, r.IsSecret(base), ""
	}
	return name, r.IsSecret(name), ""
}

// RequestAttrs removes secret attributes from a requested list. redacted
// describes each removed attribute for the model (RedactedLabel: an OID
// gets its name, plus the reason). bad is set for an unresolvable OID (the
// request is then rejected).
func (r *Redactor) RequestAttrs(attrs []string) (kept, redacted []string, bad string) {
	for _, a := range attrs {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		if a == "*" || a == "+" || a == "1.1" {
			kept = append(kept, a)
			continue
		}
		send, secret, b := r.ResolveRequested(a)
		if b != "" {
			return nil, nil, b
		}
		if secret {
			redacted = appendUniqueFold(redacted, r.RedactedLabel(a))
			continue
		}
		kept = append(kept, send)
	}
	return kept, redacted, ""
}

// Reasons given to the model for a redacted attribute (2b defect 3: a bare
// "2.5.4.35" in redacted_attributes was misnamed as displayName,
// description, … and once called empty).
const (
	RedactReasonPassword = "secret attribute (password) — never read"
	RedactReasonSecret   = "secret attribute — never read"
)

// passwordOIDNames names the password attributes that are secret by OID
// even without a readable schema (IsPasswordSecret).
var passwordOIDNames = map[string]string{
	"2.5.4.35":                   "userPassword",
	"1.2.840.113556.1.4.90":      "unicodePwd",
	"1.3.6.1.4.1.4203.1.3.4":     "authPassword",
	"1.3.6.1.4.1.42.2.27.8.1.20": "pwdHistory",
}

// RedactedName names a secret attribute as requested; a numeric OID gets
// the attribute's name in front ("userPassword (2.5.4.35)"), from the
// schema or, for the password OIDs, from the built-in list.
func (r *Redactor) RedactedName(requested string) string {
	req := strings.TrimSpace(requested)
	base := strings.TrimSpace(BaseAttr(req))
	if !IsNumericOID(base) {
		return req
	}
	name := ""
	if a := r.schema.Attr(base); a != nil && len(a.Names) > 0 {
		name = a.Names[0]
	}
	if name == "" {
		name = passwordOIDNames[base]
	}
	if name == "" {
		return req
	}
	return name + " (" + req + ")"
}

// RedactedLabel is RedactedName plus the reason, for redacted_attributes:
// "userPassword (2.5.4.35): secret attribute (password) — never read".
func (r *Redactor) RedactedLabel(requested string) string {
	reason := RedactReasonSecret
	if r.isPasswordAttr(requested) {
		reason = RedactReasonPassword
	}
	return r.RedactedName(requested) + ": " + reason
}

// OIDNotes explains secret attributes that were requested by numeric OID
// (one note each): a small model trusted its own wrong idea of the OID
// over the label ("2.5.4.35 is cn") and answered with another value.
func (r *Redactor) OIDNotes(requested []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, a := range requested {
		base := strings.TrimSpace(BaseAttr(strings.TrimSpace(a)))
		if !IsNumericOID(base) || seen[base] || !r.IsSecret(base) {
			continue
		}
		seen[base] = true
		name := strings.TrimSuffix(strings.TrimSuffix(r.RedactedName(base), " ("+base+")"), base)
		if name == "" {
			continue
		}
		kind := "a secret attribute"
		if r.isPasswordAttr(base) {
			kind = "a password attribute"
		}
		out = append(out, fmt.Sprintf("%s is the OID of %s, %s: LDAPilot never reads it, so its value (and whether it has one) is unknown. Do not report a value for it.", base, name, kind))
	}
	return out
}

// isPasswordAttr reports a password attribute by name, OID or schema alias.
func (r *Redactor) isPasswordAttr(name string) bool {
	base := strings.TrimSpace(BaseAttr(strings.TrimSpace(name)))
	if IsPasswordSecret(base) {
		return true
	}
	if a := r.schema.Attr(base); a != nil {
		for _, n := range append([]string{a.OID}, a.Names...) {
			if IsPasswordSecret(n) {
				return true
			}
		}
	}
	return false
}

// FilterAttributes returns the attribute descriptions used in a compiled
// filter (equality, substrings, ≥, ≤, present, approx, extensible type).
func FilterAttributes(filter string) ([]string, error) {
	p, err := goldap.CompileFilter(filter)
	if err != nil {
		return nil, err
	}
	var out []string
	walkFilter(p, func(attr string) { out = append(out, attr) })
	return out, nil
}

func walkFilter(p *ber.Packet, fn func(attr string)) {
	if p == nil {
		return
	}
	switch p.Tag {
	case goldap.FilterAnd, goldap.FilterOr:
		for _, c := range p.Children {
			walkFilter(c, fn)
		}
	case goldap.FilterNot:
		for _, c := range p.Children {
			walkFilter(c, fn)
		}
	case goldap.FilterEqualityMatch, goldap.FilterGreaterOrEqual, goldap.FilterLessOrEqual, goldap.FilterApproxMatch, goldap.FilterSubstrings:
		if len(p.Children) > 0 {
			fn(packetString(p.Children[0]))
		}
	case goldap.FilterPresent:
		fn(packetString(p))
	case goldap.FilterExtensibleMatch:
		for _, c := range p.Children {
			if c.Tag == 2 { // type
				fn(packetString(c))
			}
		}
	}
}

func packetString(p *ber.Packet) string {
	if s, ok := p.Value.(string); ok && s != "" {
		return s
	}
	if p.Data != nil {
		return p.Data.String()
	}
	return ""
}

// CheckFilter rejects filters that reference a secret attribute (at any
// nesting level, with OID and alias resolution). It returns the offending
// attribute ("" if none) and a compile error.
func (r *Redactor) CheckFilter(filter string) (secret string, err error) {
	attrs, err := FilterAttributes(filter)
	if err != nil {
		return "", err
	}
	for _, a := range attrs {
		if r.IsSecret(a) {
			return a, nil
		}
	}
	return "", nil
}
