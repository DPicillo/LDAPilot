package ldap

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// Per-connection password storage policy (GitHub issue #1). Every client
// write that carries userPassword values (AddEntry, ModifyEntry,
// ModifyAttribute, AddAttribute and their *WithPasswordPolicy variants)
// goes through the hook in this file, so every caller - attribute editor,
// entry dialogs, bulk modify, LDIF import, AI tools - inherits it:
//
//   - values that already carry a storage scheme ("{SCHEME}...", incl.
//     "{CRYPT}$6$..." and "{CRYPT}$2b$...", case-insensitive) are sent
//     unchanged, as are the values of delete operations (the stored value
//     is needed to delete it);
//   - other (cleartext) values follow the effective policy: "client" hashes
//     them with the policy's scheme, "server" sends them as they are, or
//     with the Password Modify extended operation (RFC 3062) when the
//     server is not known to hash cleartext values and the write is a
//     single replace of userPassword; "ask" refuses the write until the
//     caller decides (PasswordWriteOptions.Policy); on Active Directory
//     userPassword values are always passed through unchanged;
//   - PasswordWriteOptions.AsIs stores the values exactly as given;
//   - a cleartext password (userPassword without scheme, unicodePwd,
//     Password Modify) is refused on a connection without TLS unless the
//     caller confirmed it (PasswordWriteOptions.AllowUnencrypted);
//   - after the write the stored userPassword is read back (when readable)
//     and the report warns about cleartext storage and about a server that
//     re-hashed a client-side hash.

// Errors of the password policy hook. Callers ask the user and retry with
// PasswordWriteOptions.Policy / AllowUnencrypted.
var (
	ErrPasswordDecisionRequired = errors.New("password policy: a decision is required")
	ErrPasswordUnencrypted      = errors.New("password policy: confirmation required to send a password over an unencrypted connection")
)

// adUserPasswordWarning is shown for userPassword writes on AD.
const adUserPasswordWarning = "Active Directory treats userPassword specially: with fUserPwdSupport (dSHeuristics) it sets the account password and needs the cleartext password (a hash would itself become the password); otherwise it is stored as an ordinary attribute that anyone allowed to read it can read, and the logon password does not change. LDAPilot does not hash userPassword on AD; set AD passwords with Reset Password (unicodePwd)."

// OIDs of the password attributes: a write may name an attribute by its
// numeric OID instead of its name (RFC 4512 attribute descriptions).
const (
	OIDUserPassword = "2.5.4.35"
	OIDUnicodePwd   = "1.2.840.113556.1.4.90"
	OIDAuthPassword = "1.3.6.1.4.1.4203.1.3.4"
)

// IsPasswordAttribute reports whether name is userPassword, by name or by
// its OID 2.5.4.35 (case and attribute options ignored).
func IsPasswordAttribute(name string) bool {
	base := attrBaseName(name)
	return strings.EqualFold(base, "userPassword") || base == OIDUserPassword
}

// IsUnicodePwdAttribute reports whether name is AD's unicodePwd, by name or
// by its OID (case and attribute options ignored).
func IsUnicodePwdAttribute(name string) bool {
	return isUnicodePwd(name)
}

// NormalizePasswordPolicy validates a profile policy setting and returns
// its stored form ("" for auto).
func NormalizePasswordPolicy(policy string) (string, error) {
	switch p := strings.ToLower(strings.TrimSpace(policy)); p {
	case "", models.PasswordPolicyAuto:
		return "", nil
	case models.PasswordPolicyClient, models.PasswordPolicyServer, models.PasswordPolicyAsk:
		return p, nil
	}
	return "", fmt.Errorf("unknown password storage policy %q (auto, client, server or ask)", policy)
}

// ValidateClientScheme checks a client-side scheme ID for the policy: it
// must be in the catalog and hash ("" is allowed: the server type's
// default). Returns the canonical ID.
func ValidateClientScheme(scheme string) (string, error) {
	if strings.TrimSpace(scheme) == "" {
		return "", nil
	}
	for _, s := range passwordSchemes {
		if strings.EqualFold(s.ID, strings.TrimSpace(scheme)) {
			if s.ID == SchemeCleartext {
				return "", errors.New("the client-side password scheme must hash; choose server-side hashing to send cleartext")
			}
			return s.ID, nil
		}
	}
	return "", fmt.Errorf("unknown password scheme %q", scheme)
}

// DefaultClientScheme is the client-side scheme used for serverType when
// the policy is "client" without a scheme: the strongest scheme the server
// type verifies without extra modules (OpenLDAP: SHA-512-crypt through the
// system crypt(3), proven in the lab; 389DS: PBKDF2-SHA512, its own
// default), else {SSHA}.
func DefaultClientScheme(serverType string) string {
	switch serverType {
	case models.ServerTypeOpenLDAP:
		return SchemeCryptSHA512
	case models.ServerType389DS:
		return SchemePBKDF2SHA512
	}
	return DefaultPasswordScheme
}

// DefaultPasswordPolicy is the policy of a profile without an explicit
// setting ("auto") on serverType.
func DefaultPasswordPolicy(serverType string) models.PasswordPolicyDefault {
	d := models.PasswordPolicyDefault{ServerType: serverType}
	switch serverType {
	case models.ServerTypeAD:
		d.Policy = models.PasswordPolicyAD
		d.Reason = "Active Directory: passwords are set through unicodePwd; userPassword is left to the server"
	case models.ServerTypeOpenLDAP:
		d.Policy, d.Scheme = models.PasswordPolicyClient, DefaultClientScheme(serverType)
		d.Reason = "OpenLDAP stores cleartext userPassword values as given unless ppolicy hashes them (olcPPolicyHashCleartext), which is usually not visible to LDAPilot; {CRYPT} SHA-512-crypt is the strongest scheme a stock server verifies without extra modules"
	case models.ServerType389DS:
		d.Policy = models.PasswordPolicyServer
		d.Reason = "389 Directory Server always hashes cleartext userPassword values with its passwordStorageScheme"
	default:
		d.Policy = models.PasswordPolicyAsk
		d.Reason = "unknown server: whether it hashes cleartext passwords or accepts pre-hashed values is not known"
	}
	return d
}

// PasswordPolicyDefaults lists DefaultPasswordPolicy for every server type.
func PasswordPolicyDefaults() []models.PasswordPolicyDefault {
	out := []models.PasswordPolicyDefault{}
	for _, t := range []string{models.ServerTypeOpenLDAP, models.ServerType389DS, models.ServerTypeAD, models.ServerTypeOther} {
		out = append(out, DefaultPasswordPolicy(t))
	}
	return out
}

// serverPasswordHashing is what is known about a server hashing cleartext
// userPassword values itself.
type serverPasswordHashing struct {
	hashes bool
	note   string
}

// ResolvePasswordPolicy resolves the policy of profile against the
// detected server (info may be nil when unknown).
func ResolvePasswordPolicy(profile models.ConnectionProfile, info *models.ServerInfo, hashing serverPasswordHashing) models.EffectivePasswordPolicy {
	serverType := models.ServerTypeOther
	eff := models.EffectivePasswordPolicy{Warnings: []string{}}
	if info != nil {
		serverType = info.ServerType
		eff.PasswordModifyExop = slices.Contains(info.SupportedExtensions, OIDPasswordModify)
	}
	eff.ServerType = serverType
	eff.TLS = profile.TLSMode == models.TLSSSL || profile.TLSMode == models.TLSStartTLS
	eff.ServerHashes, eff.ServerHashing = hashing.hashes, hashing.note

	configured, err := NormalizePasswordPolicy(profile.PasswordPolicy)
	if err != nil {
		eff.Warnings = append(eff.Warnings, err.Error()+"; using the default of the server type")
		configured = ""
	}
	eff.Configured = configured
	if configured == "" {
		eff.Configured = models.PasswordPolicyAuto
	}

	def := DefaultPasswordPolicy(serverType)
	switch {
	case serverType == models.ServerTypeAD:
		eff.Policy, eff.Source, eff.Reason = models.PasswordPolicyAD, models.PasswordPolicySourceDefault, def.Reason
		if configured != "" {
			eff.Warnings = append(eff.Warnings, "The connection's password storage setting does not apply to Active Directory: userPassword is passed to the server unchanged.")
		}
	case configured == "":
		eff.Policy, eff.Scheme, eff.Source, eff.Reason = def.Policy, def.Scheme, models.PasswordPolicySourceDefault, def.Reason
	default:
		eff.Policy, eff.Source = configured, models.PasswordPolicySourceProfile
	}
	if eff.Policy == models.PasswordPolicyClient {
		scheme, err := ValidateClientScheme(profile.PasswordScheme)
		if err != nil {
			eff.Warnings = append(eff.Warnings, err.Error()+"; using the default scheme")
		}
		if eff.Source == models.PasswordPolicySourceProfile && scheme != "" {
			eff.Scheme = scheme
		}
		if eff.Scheme == "" {
			eff.Scheme = DefaultClientScheme(serverType)
		}
		eff.Warnings = append(eff.Warnings, schemeSupportWarnings(eff.Scheme, serverType)...)
	}
	eff.SchemeLabel = SchemeLabel(eff.Scheme)
	eff.Summary = policySummary(eff)
	return eff
}

// schemeSupportOn returns the catalog support level and note of scheme on
// serverType ("" when the catalog has no entry).
func schemeSupportOn(scheme, serverType string) (level, note string) {
	for _, s := range passwordSchemes {
		if !strings.EqualFold(s.ID, scheme) {
			continue
		}
		for _, sup := range s.Support {
			if sup.Server == serverType {
				return sup.Level, sup.Note
			}
		}
	}
	return "", ""
}

// schemeSupportWarnings warns when scheme is not built into serverType.
func schemeSupportWarnings(scheme, serverType string) []string {
	label := SchemeLabel(scheme)
	level, note := schemeSupportOn(scheme, serverType)
	switch level {
	case models.SchemeSupportNone:
		return []string{fmt.Sprintf("%s is not supported by this server type (%s): passwords hashed with it will not work.", label, note)}
	case models.SchemeSupportModule, models.SchemeSupportSystem:
		return []string{fmt.Sprintf("%s %s; if the server cannot verify it, passwords hashed with it will not work.", label, note)}
	}
	return nil
}

// keptSchemeSupportWarnings warns when the scheme of an already hashed
// value (PasswordSchemeOf) is not built into serverType: the value is sent
// unchanged, so the server must verify that scheme itself.
func keptSchemeSupportWarnings(scheme, serverType string) []string {
	label := SchemeLabel(scheme)
	if label == "" {
		return nil // not in the catalog: only the read-back can tell
	}
	level, note := schemeSupportOn(scheme, serverType)
	switch level {
	case models.SchemeSupportNone:
		return []string{fmt.Sprintf("userPassword: an already hashed %s value is sent unchanged, but this server type does not support the scheme (%s): it cannot verify it, so that password will not work.", label, note)}
	case models.SchemeSupportModule, models.SchemeSupportSystem:
		return []string{fmt.Sprintf("userPassword: an already hashed %s value is sent unchanged; the server %s. If it cannot verify the scheme, that password will not work.", label, note)}
	}
	return nil
}

// hashingPhrase turns a server hashing note into " with PBKDF2-SHA512"
// ("389 Directory Server stores passwords with PBKDF2-SHA512
// (passwordStorageScheme)"), else " (<note>)" without its own trailing
// parenthesis: no nested parentheses in the summary (RW2-P-04; the frontend's
// serverHashingScheme does the same).
func hashingPhrase(note string) string {
	n := strings.TrimSpace(note)
	if n == "" {
		return ""
	}
	if i := strings.Index(strings.ToLower(n), "stores passwords with "); i >= 0 {
		scheme := strings.TrimSpace(n[i+len("stores passwords with "):])
		if j := strings.Index(scheme, " ("); j >= 0 {
			scheme = strings.TrimSpace(scheme[:j])
		}
		if scheme != "" {
			return " with " + scheme
		}
	}
	if !strings.ContainsAny(n, " \t") {
		return " with " + n
	}
	if j := strings.LastIndex(n, " ("); j > 0 && strings.HasSuffix(n, ")") {
		n = strings.TrimSpace(n[:j])
	}
	return " (" + n + ")"
}

// policySummary describes an effective policy in one sentence.
func policySummary(eff models.EffectivePasswordPolicy) string {
	switch eff.Policy {
	case models.PasswordPolicyClient:
		return "Cleartext userPassword values are hashed on the client with " + eff.SchemeLabel + " before they are sent."
	case models.PasswordPolicyServer:
		switch {
		case eff.ServerHashes:
			return "Cleartext userPassword values are sent to the server, which hashes them" + hashingPhrase(eff.ServerHashing) + "."
		case eff.PasswordModifyExop:
			return "A single password change uses the Password Modify extended operation (RFC 3062), so the server hashes it; other writes send cleartext, which this server may store unhashed (" + eff.ServerHashing + ")."
		}
		return "Cleartext userPassword values are sent as they are; this server is not known to hash them and may store them in cleartext (" + eff.ServerHashing + ")."
	case models.PasswordPolicyAsk:
		return "Every write with a cleartext userPassword value asks how to store it."
	case models.PasswordPolicyAD:
		return "Active Directory: userPassword values are passed to the server unchanged; set passwords with Reset Password (unicodePwd)."
	}
	return ""
}

// passwordHasher hashes a password with a scheme (HashPassword).
type passwordHasher func(scheme, password string) (string, error)

// schemeRisk is a scheme of a write that the server type may not be able
// to verify: level is its catalog support level (SchemeSupportNone: never
// works; module/system: works only with the module or library).
type schemeRisk struct {
	level    string
	warnings []string
}

// passwordPlanner applies an effective policy to the password values of
// one write. With hash == nil it only plans (no hashing).
type passwordPlanner struct {
	eff    models.EffectivePasswordPolicy
	opts   models.PasswordWriteOptions
	mode   string
	scheme string
	hash   passwordHasher
	plan   models.PasswordWritePlan
	// report collects the warnings that are still relevant after the write
	// (they go into the PasswordWriteReport); cleartextRisk those that the
	// read-back settles when it shows no cleartext value.
	report        []string
	cleartextRisk []string
	// hashedSchemes are the client-side schemes used (for the read-back).
	hashedSchemes []string
	// keptSchemes are the schemes (PasswordSchemeOf) of values that were
	// already hashed and are sent unchanged (for the read-back: a server
	// that cannot verify such a scheme hashes the hash string again).
	keptSchemes []string
	// supportRisks are the warnings about a scheme (hashed on the client or
	// kept) that is not built into the server type; the report keeps them
	// unless the read-back shows the value was re-hashed.
	supportRisks []schemeRisk
	// tagged counts values with a "{...}" prefix that are not hashes of a
	// known scheme (treated as cleartext); clearTagSent those with a
	// cleartext tag ({CLEAR}, ...) that are sent as given.
	tagged       int
	clearTagSent int
	// unicodePwd: the write carries unicodePwd values.
	unicodePwd bool
}

func newPasswordPlanner(eff models.EffectivePasswordPolicy, opts models.PasswordWriteOptions, hash passwordHasher) (*passwordPlanner, error) {
	p := &passwordPlanner{eff: eff, opts: opts, mode: eff.Policy, scheme: eff.Scheme, hash: hash}
	p.plan = models.PasswordWritePlan{Policy: eff, AsIs: opts.AsIs, Unencrypted: !eff.TLS, Actions: []string{}, Warnings: []string{}}
	if eff.Policy != models.PasswordPolicyAD && !opts.AsIs {
		switch strings.ToLower(opts.Policy) {
		case "":
		case models.PasswordPolicyClient, models.PasswordPolicyServer:
			p.mode = strings.ToLower(opts.Policy)
			p.plan.Policy.Policy, p.plan.Policy.Source = p.mode, models.PasswordPolicySourceWrite
		default:
			return nil, fmt.Errorf("unknown password storage decision %q (client or server)", opts.Policy)
		}
		if p.mode == models.PasswordPolicyClient {
			scheme, err := ValidateClientScheme(opts.Scheme)
			if err != nil {
				return nil, err
			}
			if scheme != "" {
				p.scheme = scheme
			}
			if p.scheme == "" {
				p.scheme = DefaultClientScheme(eff.ServerType)
			}
			p.plan.Policy.Scheme, p.plan.Policy.SchemeLabel = p.scheme, SchemeLabel(p.scheme)
		}
	}
	return p, nil
}

// decodeValue returns the raw form of a value (binary values are base64).
func decodeValue(v string, binary bool) (string, bool) {
	if !binary {
		return v, true
	}
	raw, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		return v, false
	}
	return string(raw), true
}

// value processes one userPassword value to add or replace and returns the
// value to send (in the same encoding).
func (p *passwordPlanner) value(v string, binary bool) (string, error) {
	raw, ok := decodeValue(v, binary)
	if !ok {
		return v, nil // invalid base64: rawValues reports it
	}
	p.plan.HasPasswords = true
	p.plan.Values++
	// Only a known scheme with a plausible value is a hash; anything else
	// ("{Summer}2026!", "{CLEAR}x", "{SSHA}garbage") is a cleartext password
	// as a whole and follows the policy.
	kind, _ := classifyPasswordValue(raw)
	switch kind {
	case pwValueHashed:
		p.plan.Kept++
		if s := PasswordSchemeOf(raw); s != "" && !slices.Contains(p.keptSchemes, s) {
			p.keptSchemes = append(p.keptSchemes, s)
		}
		return v, nil
	case pwValueCleartextTag, pwValueUnknownTag, pwValueMalformed:
		p.tagged++
	}
	switch {
	case p.opts.AsIs, p.mode == models.PasswordPolicyAD, p.mode == models.PasswordPolicyServer:
		p.plan.Cleartext++
		p.plan.CleartextSent = true
		if kind == pwValueCleartextTag {
			p.clearTagSent++
		}
		return v, nil
	case p.mode == models.PasswordPolicyClient:
		p.plan.Hashed++
		if !slices.Contains(p.hashedSchemes, p.scheme) {
			p.hashedSchemes = append(p.hashedSchemes, p.scheme)
		}
		if p.hash == nil {
			return v, nil
		}
		h, err := p.hash(p.scheme, raw)
		if err != nil {
			return "", fmt.Errorf("hashing userPassword with %s: %w", SchemeLabel(p.scheme), err)
		}
		if binary {
			return base64.StdEncoding.EncodeToString([]byte(h)), nil
		}
		return h, nil
	default: // ask without a decision
		p.plan.Cleartext++
		p.plan.CleartextSent = true
		p.plan.NeedsDecision = true
		return v, nil
	}
}

// deleted records the values of a delete: sent unchanged, but a cleartext
// value is a password on the wire.
func (p *passwordPlanner) deleted(attr string, values []string, binary bool) {
	if len(values) == 0 {
		return
	}
	p.plan.HasPasswords = true
	if isUnicodePwd(attr) {
		p.unicodePwd = true
		p.plan.CleartextSent = true
		return
	}
	for _, v := range values {
		if raw, ok := decodeValue(v, binary); ok && !IsHashedPasswordValue(raw) {
			p.plan.CleartextSent = true
		}
	}
}

// changes applies the policy to the changes of a modify. exopPassword is
// set when the write is to be done with the Password Modify extended
// operation instead.
func (p *passwordPlanner) changes(changes []models.AttributeChange) (out []models.AttributeChange, exopPassword string, exop bool, err error) {
	out = make([]models.AttributeChange, len(changes))
	for i, ch := range changes {
		out[i] = ch
		op := strings.ToLower(ch.Operation)
		switch {
		case isUnicodePwd(ch.Attribute) && len(ch.Values) > 0:
			p.unicodePwd = true
			p.plan.HasPasswords = true
			p.plan.CleartextSent = true
		case !IsPasswordAttribute(ch.Attribute):
		case op == models.ChangeDelete:
			p.deleted(ch.Attribute, ch.Values, ch.Binary)
		case op == models.ChangeAdd || op == models.ChangeReplace:
			vals := make([]string, len(ch.Values))
			for j, v := range ch.Values {
				if vals[j], err = p.value(v, ch.Binary); err != nil {
					return nil, "", false, err
				}
			}
			out[i].Values = vals
		}
	}
	// RFC 3062 where the call shape allows it: the server policy on a server
	// not known to hash cleartext values, a single replace of userPassword
	// with one cleartext value.
	if p.mode == models.PasswordPolicyServer && !p.opts.AsIs && !p.eff.ServerHashes && p.eff.PasswordModifyExop &&
		len(changes) == 1 && IsPasswordAttribute(changes[0].Attribute) &&
		strings.EqualFold(changes[0].Operation, models.ChangeReplace) && len(changes[0].Values) == 1 && p.plan.Cleartext == 1 {
		if raw, ok := decodeValue(changes[0].Values[0], changes[0].Binary); ok {
			p.plan.Exop = true
			return out, raw, true, nil
		}
	}
	return out, "", false, nil
}

// attributes applies the policy to the attributes of an add.
func (p *passwordPlanner) attributes(attrs []models.LDAPAttribute) ([]models.LDAPAttribute, error) {
	out := make([]models.LDAPAttribute, len(attrs))
	for i, a := range attrs {
		out[i] = a
		switch {
		case isUnicodePwd(a.Name) && len(a.Values) > 0:
			p.unicodePwd = true
			p.plan.HasPasswords = true
			p.plan.CleartextSent = true
		case IsPasswordAttribute(a.Name):
			vals := make([]string, len(a.Values))
			for j, v := range a.Values {
				var err error
				if vals[j], err = p.value(v, a.Binary); err != nil {
					return nil, err
				}
			}
			out[i].Values = vals
		}
	}
	return out, nil
}

// valueCount is a count of values with a plural.
func valueCount(n int) string {
	if n == 1 {
		return "1 value"
	}
	return fmt.Sprintf("%d values", n)
}

// finish fills the plan's actions, warnings and flags.
func (p *passwordPlanner) finish() models.PasswordWritePlan {
	pl := &p.plan
	if pl.Hashed > 0 {
		pl.Actions = append(pl.Actions, fmt.Sprintf("userPassword: %s hashed on the client with %s", valueCount(pl.Hashed), SchemeLabel(p.scheme)))
	}
	if pl.Kept > 0 {
		pl.Actions = append(pl.Actions, fmt.Sprintf("userPassword: %s already hashed (known {SCHEME} prefix), sent unchanged", valueCount(pl.Kept)))
	}
	if pl.Cleartext > 0 {
		switch {
		case pl.Exop:
			pl.Actions = append(pl.Actions, "userPassword: set with the Password Modify extended operation (RFC 3062); the server hashes it")
		case p.opts.AsIs:
			pl.Actions = append(pl.Actions, fmt.Sprintf("userPassword: %s without a storage scheme stored exactly as given (no hashing)", valueCount(pl.Cleartext)))
			p.warnRisk("userPassword values without a known {SCHEME} prefix are stored as given: the server keeps them in cleartext unless it hashes cleartext values itself.")
		case p.mode == models.PasswordPolicyAD:
			pl.Actions = append(pl.Actions, fmt.Sprintf("userPassword: %s passed to Active Directory unchanged", valueCount(pl.Cleartext)))
		case p.mode == models.PasswordPolicyServer && p.eff.ServerHashes:
			// "…; the server hashes it with PBKDF2-SHA512", no nested parentheses (RW2-P-04).
			pl.Actions = append(pl.Actions, fmt.Sprintf("userPassword: %s sent in cleartext; the server hashes it%s", valueCount(pl.Cleartext), hashingPhrase(p.eff.ServerHashing)))
		case p.mode == models.PasswordPolicyServer:
			pl.Actions = append(pl.Actions, fmt.Sprintf("userPassword: %s sent in cleartext", valueCount(pl.Cleartext)))
			why := "this write is not a single password replace"
			if !p.eff.PasswordModifyExop {
				why = "the server does not announce it"
			}
			p.warnRisk(fmt.Sprintf("Server-side hashing: this server is not known to hash cleartext userPassword values (%s) and the Password Modify extended operation cannot be used (%s), so the password may be stored in cleartext.", p.eff.ServerHashing, why))
		default:
			pl.Actions = append(pl.Actions, fmt.Sprintf("userPassword: %s waiting for a decision (password storage policy \"ask\")", valueCount(pl.Cleartext)))
		}
	}
	if p.tagged > 0 && !p.opts.AsIs && p.mode != models.PasswordPolicyAD {
		subject := "1 value starts with a {...} prefix but is not a hash of a known storage scheme: it is"
		if p.tagged > 1 {
			subject = fmt.Sprintf("%d values start with a {...} prefix but are not hashes of a known storage scheme: they are", p.tagged)
		}
		p.warn("userPassword: "+subject+" treated as a cleartext password (the whole value, prefix included).", true)
	}
	if p.clearTagSent > 0 {
		p.warnRisk("userPassword: a value with a cleartext tag ({CLEAR}, {CLEARTEXT}, {PLAIN}) is sent as given; a server that knows the tag (389DS {CLEAR}) stores the password in cleartext.")
	}
	if pl.Hashed > 0 {
		// A scheme that is not built into the server type: the server may
		// store the hash as sent without being able to verify it.
		p.addSchemeRisk(p.scheme, schemeSupportWarnings(p.scheme, p.eff.ServerType))
	}
	if p.mode != models.PasswordPolicyAD && p.eff.Policy != models.PasswordPolicyAD {
		// Already hashed values are sent unchanged: the same applies to
		// their scheme (AD: adUserPasswordWarning covers every value).
		for _, s := range p.keptSchemes {
			if pl.Hashed > 0 && strings.EqualFold(s, p.scheme) {
				continue
			}
			p.addSchemeRisk(s, keptSchemeSupportWarnings(s, p.eff.ServerType))
		}
	}
	if p.unicodePwd {
		pl.Actions = append(pl.Actions, "unicodePwd: the password is sent to the server, which stores it")
	}
	if p.eff.Policy == models.PasswordPolicyAD && pl.Values > 0 {
		p.warn(adUserPasswordWarning, true)
	}
	if pl.Unencrypted && pl.CleartextSent {
		p.warn("The connection is not encrypted (no LDAPS/StartTLS): the password is sent in cleartext over the network.", false)
		pl.NeedsConfirm = !p.opts.AllowUnencrypted
	}
	return *pl
}

// addSchemeRisk records the support warnings of scheme (none: nothing to do).
func (p *passwordPlanner) addSchemeRisk(scheme string, warnings []string) {
	if len(warnings) == 0 {
		return
	}
	level, _ := schemeSupportOn(scheme, p.eff.ServerType)
	p.plan.Warnings = append(p.plan.Warnings, warnings...)
	p.supportRisks = append(p.supportRisks, schemeRisk{level: level, warnings: warnings})
}

// warn adds a plan warning; forReport also puts it into the write report.
func (p *passwordPlanner) warn(w string, forReport bool) {
	p.plan.Warnings = append(p.plan.Warnings, w)
	if forReport {
		p.report = append(p.report, w)
	}
}

// warnRisk adds a plan warning about possible cleartext storage; the
// report keeps it only if the read-back does not rule it out.
func (p *passwordPlanner) warnRisk(w string) {
	p.plan.Warnings = append(p.plan.Warnings, w)
	p.cleartextRisk = append(p.cleartextRisk, w)
}

// planErr refuses a write that needs a decision or a confirmation.
func planErr(plan models.PasswordWritePlan) error {
	switch {
	case plan.NeedsDecision:
		return fmt.Errorf("%w: the connection's password storage policy is \"ask\"; choose client-side hashing or server-side hashing for the userPassword value(s)", ErrPasswordDecisionRequired)
	case plan.NeedsConfirm:
		return fmt.Errorf("%w: the password would be sent in cleartext without LDAPS/StartTLS; confirm it or connect with TLS", ErrPasswordUnencrypted)
	}
	return nil
}

// PlanPasswordChanges plans the password values of a modify under eff
// without hashing (dry runs, confirmation dialogs).
func PlanPasswordChanges(eff models.EffectivePasswordPolicy, changes []models.AttributeChange, opts models.PasswordWriteOptions) (models.PasswordWritePlan, error) {
	p, err := newPasswordPlanner(eff, opts, nil)
	if err != nil {
		return models.PasswordWritePlan{}, err
	}
	if _, _, _, err := p.changes(changes); err != nil {
		return models.PasswordWritePlan{}, err
	}
	return p.finish(), nil
}

// PlanPasswordAttributes plans the password values of an add under eff
// without hashing.
func PlanPasswordAttributes(eff models.EffectivePasswordPolicy, attrs []models.LDAPAttribute, opts models.PasswordWriteOptions) (models.PasswordWritePlan, error) {
	p, err := newPasswordPlanner(eff, opts, nil)
	if err != nil {
		return models.PasswordWritePlan{}, err
	}
	if _, err := p.attributes(attrs); err != nil {
		return models.PasswordWritePlan{}, err
	}
	return p.finish(), nil
}

// MergePasswordPlans adds the counts, flags and (distinct) messages of b to
// a, e.g. over the records of an LDIF file.
func MergePasswordPlans(a, b models.PasswordWritePlan) models.PasswordWritePlan {
	a.HasPasswords = a.HasPasswords || b.HasPasswords
	a.Values += b.Values
	a.Hashed += b.Hashed
	a.Kept += b.Kept
	a.Cleartext += b.Cleartext
	a.Exop = a.Exop || b.Exop
	a.CleartextSent = a.CleartextSent || b.CleartextSent
	a.NeedsConfirm = a.NeedsConfirm || b.NeedsConfirm
	a.NeedsDecision = a.NeedsDecision || b.NeedsDecision
	for _, m := range b.Actions {
		if !slices.Contains(a.Actions, m) {
			a.Actions = append(a.Actions, m)
		}
	}
	for _, m := range b.Warnings {
		if !slices.Contains(a.Warnings, m) {
			a.Warnings = append(a.Warnings, m)
		}
	}
	return a
}

// hasPasswordValues reports whether changes carry userPassword or
// unicodePwd values (the hook has nothing to do otherwise).
func hasPasswordValues(changes []models.AttributeChange) bool {
	for _, ch := range changes {
		if len(ch.Values) > 0 && (IsPasswordAttribute(ch.Attribute) || isUnicodePwd(ch.Attribute)) {
			return true
		}
	}
	return false
}

// hasPasswordAttributes is hasPasswordValues for an add.
func hasPasswordAttributes(attrs []models.LDAPAttribute) bool {
	for _, a := range attrs {
		if len(a.Values) > 0 && (IsPasswordAttribute(a.Name) || isUnicodePwd(a.Name)) {
			return true
		}
	}
	return false
}

// hasUserPasswordValues reports whether changes carry userPassword values
// (unicodePwd alone needs no server information).
func hasUserPasswordValues(changes []models.AttributeChange) bool {
	for _, ch := range changes {
		if len(ch.Values) > 0 && IsPasswordAttribute(ch.Attribute) {
			return true
		}
	}
	return false
}

// PasswordPolicy returns the effective password storage policy of the
// client's profile on its server.
func (c *Client) PasswordPolicy() (*models.EffectivePasswordPolicy, error) {
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	eff := ResolvePasswordPolicy(c.Profile(), info, c.passwordHashing(info))
	return &eff, nil
}

// transportOnlyPolicy is the policy used for writes without userPassword
// values (unicodePwd only): only the TLS check applies.
func (c *Client) transportOnlyPolicy() models.EffectivePasswordPolicy {
	p := c.Profile()
	return models.EffectivePasswordPolicy{
		Policy:   models.PasswordPolicyServer,
		TLS:      p.TLSMode == models.TLSSSL || p.TLSMode == models.TLSStartTLS,
		Warnings: []string{},
	}
}

// policyFor returns the policy for a write; userPassword values need the
// server information.
func (c *Client) policyFor(userPassword bool) (models.EffectivePasswordPolicy, error) {
	if !userPassword {
		return c.transportOnlyPolicy(), nil
	}
	eff, err := c.PasswordPolicy()
	if err != nil {
		return models.EffectivePasswordPolicy{}, fmt.Errorf("password storage policy: %w", err)
	}
	return *eff, nil
}

// PlanPasswordChanges plans the password values of a modify without
// writing.
func (c *Client) PlanPasswordChanges(changes []models.AttributeChange, opts models.PasswordWriteOptions) (*models.PasswordWritePlan, error) {
	eff, err := c.policyFor(true)
	if err != nil {
		return nil, err
	}
	plan, err := PlanPasswordChanges(eff, changes, opts)
	return &plan, err
}

// PlanPasswordAttributes plans the password values of an add without
// writing.
func (c *Client) PlanPasswordAttributes(attrs []models.LDAPAttribute, opts models.PasswordWriteOptions) (*models.PasswordWritePlan, error) {
	eff, err := c.policyFor(true)
	if err != nil {
		return nil, err
	}
	plan, err := PlanPasswordAttributes(eff, attrs, opts)
	return &plan, err
}

// AddEntryWithPasswordPolicy creates an entry like AddEntry, applying the
// password storage policy with opts to its userPassword values. The report
// is nil when the entry has no password values.
func (c *Client) AddEntryWithPasswordPolicy(dn string, attrs []models.LDAPAttribute, opts models.PasswordWriteOptions) (*models.PasswordWriteReport, error) {
	// A new pwdPolicy / PSO / local policy entry may change effective policies.
	defer c.notePolicyWriteAdd(dn, attrs)
	if !hasPasswordAttributes(attrs) {
		return nil, c.addEntry(dn, attrs)
	}
	if err := c.CheckWritable(); err != nil {
		return nil, err
	}
	userPassword := false
	for _, a := range attrs {
		userPassword = userPassword || (IsPasswordAttribute(a.Name) && len(a.Values) > 0)
	}
	eff, err := c.policyFor(userPassword)
	if err != nil {
		return nil, fmt.Errorf("add entry failed: %w", err)
	}
	p, err := newPasswordPlanner(eff, opts, HashPassword)
	if err != nil {
		return nil, fmt.Errorf("add entry failed: %w", err)
	}
	// Refuse before hashing (argon2/bcrypt are expensive).
	if pre, err := PlanPasswordAttributes(eff, attrs, opts); err != nil || planErr(pre) != nil {
		if err == nil {
			err = planErr(pre)
		}
		return nil, fmt.Errorf("add entry failed: %w", err)
	}
	out, err := p.attributes(attrs)
	if err != nil {
		return nil, fmt.Errorf("add entry failed: %w", err)
	}
	plan := p.finish()
	if err := c.addEntry(dn, out); err != nil {
		return nil, err
	}
	return c.passwordReport(dn, p, plan, nil), nil
}

// ModifyEntryWithPasswordPolicy is ModifyEntry with the password storage
// policy applied with opts (see the top of this file). The report is nil
// when the changes carry no password values.
func (c *Client) ModifyEntryWithPasswordPolicy(dn string, changes []models.AttributeChange, opts models.PasswordWriteOptions, controls ...goldap.Control) (*models.PasswordWriteReport, error) {
	return c.modifyWithPolicy(dn, changes, opts, controls, "MODIFY", "modify entry")
}

// modifyWithPolicy is modify with the password storage hook.
func (c *Client) modifyWithPolicy(dn string, changes []models.AttributeChange, opts models.PasswordWriteOptions, controls []goldap.Control, logOp, what string) (*models.PasswordWriteReport, error) {
	// After the write (also a failed one: it may have reached the server):
	// a changed password policy must not be served from the shared cache.
	defer c.notePolicyWriteChanges(dn, changes)
	if !hasPasswordValues(changes) {
		return nil, c.modify(dn, changes, controls, logOp, what)
	}
	if err := c.CheckWritable(); err != nil {
		return nil, err
	}
	eff, err := c.policyFor(hasUserPasswordValues(changes))
	if err != nil {
		return nil, fmt.Errorf("%s failed: %w", what, err)
	}
	if pre, err := PlanPasswordChanges(eff, changes, opts); err != nil || planErr(pre) != nil {
		if err == nil {
			err = planErr(pre)
		}
		return nil, fmt.Errorf("%s failed: %w", what, err)
	}
	p, err := newPasswordPlanner(eff, opts, HashPassword)
	if err != nil {
		return nil, fmt.Errorf("%s failed: %w", what, err)
	}
	out, exopPassword, exop, err := p.changes(changes)
	if err != nil {
		return nil, fmt.Errorf("%s failed: %w", what, err)
	}
	plan := p.finish()
	var before []string
	if exop {
		if err := c.PasswordModify(dn, exopPassword); err != nil {
			return nil, err
		}
	} else {
		if plan.Values > 0 {
			before = c.storedPasswordsBefore(dn, changes)
		}
		if err := c.modify(dn, out, controls, logOp, what); err != nil {
			return nil, err
		}
	}
	return c.passwordReport(dn, p, plan, before), nil
}

// storedPasswordsBefore reads the userPassword values of dn before a
// modify that adds userPassword values without replacing them, so that the
// read-back judges only the values this write added: a cleartext value
// that was already there is reported as such, not as the result of the
// write. nil when the write replaces the values (or adds none) or the
// values are not readable.
func (c *Client) storedPasswordsBefore(dn string, changes []models.AttributeChange) []string {
	add := false
	for _, ch := range changes {
		if !IsPasswordAttribute(ch.Attribute) {
			continue
		}
		switch strings.ToLower(ch.Operation) {
		case models.ChangeReplace:
			return nil
		case models.ChangeAdd:
			add = add || len(ch.Values) > 0
		}
	}
	if !add {
		return nil
	}
	before, err := c.readStoredPasswords(dn)
	if err != nil {
		return nil
	}
	return before
}

// splitStoredPasswords splits the userPassword values read back after a
// write into those the write added (not in before) and those that were
// there already.
func splitStoredPasswords(stored, before []string) (added, older []string) {
	left := map[string]int{}
	for _, v := range before {
		left[v]++
	}
	for _, v := range stored {
		if left[v] > 0 {
			left[v]--
			older = append(older, v)
			continue
		}
		added = append(added, v)
	}
	return added, older
}

// passwordReport logs what the policy did and reads the stored userPassword
// back to warn about cleartext storage and re-hashed client-side hashes.
// before are the values read before a write that adds values
// (storedPasswordsBefore; nil otherwise).
func (c *Client) passwordReport(dn string, p *passwordPlanner, plan models.PasswordWritePlan, before []string) *models.PasswordWriteReport {
	var stored []string
	var readErr error
	if plan.Values > 0 {
		stored, readErr = c.readStoredPasswords(dn)
	}
	r := buildPasswordReport(p, plan, stored, before, readErr)
	if len(r.Actions) > 0 {
		c.logger.Log("PWPOLICY", fmt.Sprintf("dn=%s %s", dn, strings.Join(r.Actions, "; ")), 0, nil)
	}
	for _, w := range r.Warnings {
		c.logger.Log("PWPOLICY", fmt.Sprintf("dn=%s WARNING: %s", dn, w), 0, nil)
	}
	return r
}

// buildPasswordReport is the report of a write planned by p: the plan's
// actions, the warnings that stay relevant after the write, and the
// assessment of the userPassword values read back (stored; nil when not
// readable, readErr when the read failed; not read when the write had no
// userPassword values to add or replace). before are the values the entry
// had before a write that added values: only the added ones are judged,
// older values without a known scheme get a warning of their own.
func buildPasswordReport(p *passwordPlanner, plan models.PasswordWritePlan, stored, before []string, readErr error) *models.PasswordWriteReport {
	r := &models.PasswordWriteReport{
		Actions:       append([]string{}, plan.Actions...),
		Warnings:      append([]string{}, p.report...),
		StoredSchemes: []string{},
		Exop:          plan.Exop,
	}
	if plan.Values > 0 {
		switch {
		case readErr != nil:
			r.Actions = append(r.Actions, "stored userPassword not checked: "+readErr.Error())
		case stored == nil:
			r.Actions = append(r.Actions, "stored userPassword not readable with this account; storage not checked")
		default:
			judged, older := stored, []string(nil)
			if len(before) > 0 {
				if added, kept := splitStoredPasswords(stored, before); len(added) > 0 {
					judged, older = added, kept
				}
			}
			assessStoredPasswords(r, judged, p.hashedSchemes, p.keptSchemes, p.eff.Policy == models.PasswordPolicyAD)
			if n := countNotHashed(older); n > 0 {
				what := "1 older userPassword value (not set by this write)"
				if n > 1 {
					what = fmt.Sprintf("%d older userPassword values (not set by this write)", n)
				}
				r.Warnings = append(r.Warnings, fmt.Sprintf("The entry still has %s stored in cleartext (no known storage scheme): anyone allowed to read userPassword can read it. Remove it (the attribute table marks it in red) or replace all values.", what))
			}
		}
	}
	if r.Cleartext || len(r.StoredSchemes) == 0 {
		// cleartext stored, or not checked: the prediction stays relevant
		r.Warnings = append(r.Warnings, p.cleartextRisk...)
	}
	if !r.Ineffective {
		// Stored as sent (or not checked): whether the server can verify
		// the scheme is not known; one it does not support never works.
		for _, risk := range p.supportRisks {
			r.Warnings = append(r.Warnings, risk.warnings...)
			if risk.level == models.SchemeSupportNone {
				r.Ineffective = true
			} else {
				r.Unconfirmed = true
			}
		}
		if r.Ineffective {
			r.Unconfirmed = false
		}
	}
	return r
}

// assessStoredPasswords fills r from the userPassword values read back
// after a write (labels only, never values), the client-side schemes the
// write hashed with and the schemes of the already hashed values it sent
// unchanged (keptSchemes). A sent scheme missing from the read-back means
// the server did not know it and hashed the hash string as a cleartext
// password: that password does not work.
func assessStoredPasswords(r *models.PasswordWriteReport, stored []string, hashedSchemes, keptSchemes []string, ad bool) {
	storedSchemes := map[string]bool{}
	plain, odd := false, false
	for _, v := range stored {
		label := PasswordSchemeLabel(v)
		if !slices.Contains(r.StoredSchemes, label) {
			r.StoredSchemes = append(r.StoredSchemes, label)
		}
		storedSchemes[PasswordSchemeOf(v)] = true
		switch kind, _ := classifyPasswordValue(v); kind {
		case pwValueCleartext, pwValueCleartextTag:
			plain = true
		case pwValueUnknownTag, pwValueMalformed:
			odd = true
		}
	}
	// A value that is not a hash of a known scheme is readable like a
	// cleartext password.
	r.Cleartext = plain || odd
	if len(r.StoredSchemes) > 0 {
		r.Actions = append(r.Actions, "stored as "+strings.Join(r.StoredSchemes, ", "))
	}
	switch {
	case r.Cleartext && ad:
		r.Warnings = append(r.Warnings, "Active Directory stored userPassword in cleartext as an ordinary attribute: anyone allowed to read userPassword can read the password. Remove the value and set the password with Reset Password (unicodePwd).")
	case plain:
		r.Warnings = append(r.Warnings, "The server stored userPassword in cleartext: anyone allowed to read userPassword can read the password. Hash it on the client or use server-side hashing (connection settings, Password storage).")
	}
	if odd && !ad {
		r.Warnings = append(r.Warnings, "The server stored a userPassword value without a known storage scheme as given: anyone allowed to read userPassword can read it like a cleartext password, and the server may not accept it for logons. Set the password again (Reset Password) or hash it on the client.")
	}
	for _, s := range hashedSchemes {
		if storedSchemes[s] {
			continue
		}
		r.Ineffective = true
		r.Warnings = append(r.Warnings, fmt.Sprintf(
			"The server stored %s instead of the %s value that was sent: it does not support the scheme and hashed the hash string as if it were a cleartext password, so the new password will NOT work. Choose a scheme the server supports or server-side hashing.",
			strings.Join(r.StoredSchemes, ", "), SchemeLabel(s)))
	}
	if ad {
		return // AD keeps userPassword values as given (adUserPasswordWarning)
	}
	for _, s := range keptSchemes {
		if storedSchemes[s] || slices.Contains(hashedSchemes, s) {
			continue
		}
		r.Ineffective = true
		r.Warnings = append(r.Warnings, fmt.Sprintf(
			"The server stored %s instead of the already hashed %s value that was sent: it does not know that scheme and hashed the hash string as if it were a cleartext password, so that password will NOT work. Send a hash in a scheme the server supports, or the cleartext password.",
			strings.Join(r.StoredSchemes, ", "), keptSchemeLabel(s)))
	}
}

// keptSchemeLabel names the scheme of an already hashed value: the catalog
// label, else the tag as "{TAG}" (only known schemes are kept, so the tag
// is never part of a typed password).
func keptSchemeLabel(scheme string) string {
	if l := SchemeLabel(scheme); l != "" {
		return l
	}
	return "{" + scheme + "}"
}

// countNotHashed counts the values that are not hashes of a known scheme.
func countNotHashed(values []string) int {
	n := 0
	for _, v := range values {
		if v != "" && !IsHashedPasswordValue(v) {
			n++
		}
	}
	return n
}

// readStoredPasswords reads the userPassword values of dn; nil when the
// attribute is not readable (or absent).
func (c *Client) readStoredPasswords(dn string) ([]string, error) {
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases, 1, 0, false,
		"(objectClass=*)", []string{"userPassword"}, nil)
	var entries []*goldap.Entry
	err := c.read(func(conn *goldap.Conn) error {
		res, err := conn.Search(req)
		if err != nil {
			return err
		}
		entries = res.Entries
		return nil
	})
	if err != nil {
		return nil, searchError(err)
	}
	if len(entries) == 0 {
		return nil, nil
	}
	var out []string
	for _, a := range entries[0].Attributes {
		if IsPasswordAttribute(a.Name) {
			for _, v := range a.ByteValues {
				out = append(out, string(v))
			}
		}
	}
	return out, nil
}

// passwordHashing returns what is known about the server hashing cleartext
// userPassword values, cached per connection like ServerInfo.
func (c *Client) passwordHashing(info *models.ServerInfo) serverPasswordHashing {
	c.mu.Lock()
	cached, conn := c.pwHashing, c.conn
	c.mu.Unlock()
	if cached != nil {
		return *cached
	}
	start := time.Now()
	h := c.detectPasswordHashing(info)
	c.logger.Log("PWPOLICY", "server password hashing: "+h.note, time.Since(start), nil)
	c.mu.Lock()
	if c.conn == conn {
		c.pwHashing = &h
	}
	c.mu.Unlock()
	return h
}

// configProbe reads server configuration (cn=config) that the bind account
// is often not allowed to see. It does not write to the operation log: an
// unreadable cn=config is expected (an ordinary admin DN on OpenLDAP gets
// noSuchObject), and the caller logs its conclusion (PWPOLICY), so a plain
// connect does not show an error in the Operations log.
func (c *Client) configProbe(req *goldap.SearchRequest) ([]*goldap.Entry, error) {
	var entries []*goldap.Entry
	err := c.read(func(conn *goldap.Conn) error {
		var err error
		entries, _, err = searchPage(context.Background(), conn, req)
		return err
	})
	return entries, searchError(err)
}

// detectPasswordHashing reads the server configuration where the bind
// account may read it: 389DS cn=config passwordStorageScheme, OpenLDAP
// ppolicy olcPPolicyHashCleartext in cn=config.
func (c *Client) detectPasswordHashing(info *models.ServerInfo) serverPasswordHashing {
	switch info.ServerType {
	case models.ServerType389DS:
		req := goldap.NewSearchRequest("cn=config", goldap.ScopeBaseObject, goldap.NeverDerefAliases, 1, 0, false,
			"(objectClass=*)", []string{"passwordStorageScheme"}, nil)
		if entries, err := c.configProbe(req); err == nil && len(entries) > 0 {
			if scheme := entries[0].GetEqualFoldAttributeValue("passwordStorageScheme"); scheme != "" {
				if strings.EqualFold(scheme, "CLEAR") {
					return serverPasswordHashing{note: "389 Directory Server is configured to store passwords in cleartext (passwordStorageScheme: CLEAR)"}
				}
				return serverPasswordHashing{hashes: true, note: "389 Directory Server stores passwords with " + scheme + " (passwordStorageScheme)"}
			}
		}
		return serverPasswordHashing{hashes: true, note: "389 Directory Server hashes cleartext passwords with its passwordStorageScheme"}
	case models.ServerTypeOpenLDAP:
		req := goldap.NewSearchRequest("cn=config", goldap.ScopeWholeSubtree, goldap.NeverDerefAliases, 0, 0, false,
			"(objectClass=olcPPolicyConfig)", []string{"olcPPolicyHashCleartext"}, nil)
		entries, err := c.configProbe(req)
		if err != nil {
			return serverPasswordHashing{note: "unknown: cn=config is not readable, so it is not known whether ppolicy hashes cleartext passwords (olcPPolicyHashCleartext)"}
		}
		if len(entries) == 0 {
			return serverPasswordHashing{note: "no ppolicy overlay: OpenLDAP stores cleartext userPassword values as given"}
		}
		for _, e := range entries {
			if strings.EqualFold(e.GetEqualFoldAttributeValue("olcPPolicyHashCleartext"), "TRUE") {
				return serverPasswordHashing{hashes: true, note: "OpenLDAP ppolicy hashes cleartext passwords (olcPPolicyHashCleartext: TRUE)"}
			}
		}
		return serverPasswordHashing{note: "OpenLDAP stores cleartext userPassword values as given (ppolicy olcPPolicyHashCleartext is off)"}
	case models.ServerTypeAD:
		return serverPasswordHashing{note: "Active Directory"}
	}
	return serverPasswordHashing{note: "unknown server: not known whether it hashes cleartext passwords"}
}
