package ldap

import (
	"context"
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// Account status and account actions for AD, OpenLDAP (ppolicy) and 389DS.
//
// The status is computed from the server specific attributes by pure
// functions (computeADStatus, computePPolicyStatus, compute389Status) that get
// the entry's attributes, the effective policy and the current time. Actions
// are planned by pure functions as well (planADChange, ...) and sent as one
// atomic ModifyEntry, so read-only enforcement applies; the editor service
// writes the audit entry.

// accountAttrs is a case-insensitive view of an entry's attribute values
// (keys are lower case).
type accountAttrs map[string][]string

func newAccountAttrs(e *goldap.Entry) accountAttrs {
	a := accountAttrs{}
	if e == nil {
		return a
	}
	for _, attr := range e.Attributes {
		name := strings.ToLower(attr.Name)
		a[name] = append(a[name], attr.Values...)
	}
	return a
}

func (a accountAttrs) all(name string) []string { return a[strings.ToLower(name)] }

func (a accountAttrs) first(name string) string {
	if v := a[strings.ToLower(name)]; len(v) > 0 {
		return v[0]
	}
	return ""
}

func (a accountAttrs) has(name string) bool { return len(a[strings.ToLower(name)]) > 0 }

func (a accountAttrs) int64(name string) (int64, bool) {
	return parseInt64(a.first(name))
}

// hasValue reports whether the attribute has the value (case-insensitive).
func (a accountAttrs) hasValue(name, value string) bool {
	for _, v := range a.all(name) {
		if strings.EqualFold(strings.TrimSpace(v), value) {
			return true
		}
	}
	return false
}

// generalizedTime parses the first value of a Generalized Time attribute.
func (a accountAttrs) generalizedTime(name string) (time.Time, bool) {
	v := a.first(name)
	if v == "" {
		return time.Time{}, false
	}
	t, err := parseGeneralizedTime(v)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// fileTime parses the first value of a FILETIME attribute; 0 and "never"
// return false.
func (a accountAttrs) fileTime(name string) (time.Time, bool) {
	v, ok := a.int64(name)
	if !ok {
		return time.Time{}, false
	}
	return fileTimeToTime(v)
}

// newAccountStatus returns an empty status for dn.
func newAccountStatus(dn, serverType string, now time.Time) *models.AccountStatus {
	return &models.AccountStatus{
		DN:          dn,
		ServerType:  serverType,
		Evaluated:   isoTime(now),
		Enabled:     true,
		Unsupported: map[string]string{},
		Warnings:    []string{},
	}
}

// genericAccountObjectClasses are object classes of LDAP accounts that can
// bind (OpenLDAP, 389DS).
var genericAccountObjectClasses = map[string]bool{
	"person":               true,
	"organizationalperson": true,
	"inetorgperson":        true,
	"posixaccount":         true,
	"shadowaccount":        true,
	"account":              true,
	"simplesecurityobject": true,
	"inetuser":             true,
	"nsperson":             true,
	"nsaccount":            true,
}

// isGenericAccount reports whether an OpenLDAP/389DS entry is an account.
func isGenericAccount(objectClasses []string) bool {
	for _, oc := range objectClasses {
		if genericAccountObjectClasses[strings.ToLower(oc)] {
			return true
		}
	}
	return false
}

// accountReader reads account entries and their policies with unpaged
// searches: on the client's own connection, or, for an entry reached through
// a referral (e.g. a user of a child domain), on a temporary connection to
// the referred server, so the entry and its policies come from the server
// that holds them.
type accountReader struct {
	c    *Client
	conn *goldap.Conn // nil: the client's own connection
	ctx  context.Context
	// extra are further attributes read together with the account entry
	// (AccountStatusAndEntry: the password dialog's state in the same read);
	// entry is the raw result of that read.
	extra []string
	entry *goldap.Entry
}

// accountReader returns a reader on the client's own connection.
func (c *Client) accountReader() *accountReader {
	return &accountReader{c: c, ctx: context.Background()}
}

// search runs req unpaged. Referrals are not followed.
func (r *accountReader) search(req *goldap.SearchRequest) ([]*goldap.Entry, error) {
	if r.conn == nil {
		return r.c.SearchWithControls(req, 0)
	}
	entries, _, err := searchPage(r.ctx, r.conn, req)
	return entries, searchError(err)
}

// configProbe reads cn=config, which the bind account often may not see,
// without an operation-log entry on the client's own connection (see
// Client.configProbe); the account status reports the outcome itself.
func (r *accountReader) configProbe(req *goldap.SearchRequest) ([]*goldap.Entry, error) {
	if r.conn == nil {
		return r.c.configProbe(req)
	}
	return r.search(req)
}

// readAccountEntry reads attrs of dn with a base search.
func (r *accountReader) readAccountEntry(dn string, attrs []string) (accountAttrs, error) {
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases,
		0, 0, false, "(objectClass=*)", attrs, nil)
	entries, err := r.search(req)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, dn)
	}
	return newAccountAttrs(entries[0]), nil
}

// readAccount reads the account entry dn with attrs plus r.extra (one base
// search) and keeps the raw entry in r.entry.
func (r *accountReader) readAccount(dn string, attrs []string) (accountAttrs, error) {
	if len(r.extra) > 0 {
		attrs = mergeAttributeNames(attrs, r.extra)
	}
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases,
		0, 0, false, "(objectClass=*)", attrs, nil)
	entries, err := r.search(req)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, dn)
	}
	r.entry = entries[0]
	return newAccountAttrs(entries[0]), nil
}

// mergeAttributeNames returns a followed by the names of b it lacks
// (case-insensitive).
func mergeAttributeNames(a, b []string) []string {
	out := append([]string(nil), a...)
	seen := make(map[string]bool, len(a)+len(b))
	for _, n := range a {
		seen[strings.ToLower(n)] = true
	}
	for _, n := range b {
		if k := strings.ToLower(n); !seen[k] {
			seen[k] = true
			out = append(out, n)
		}
	}
	return out
}

// serverInfo reads the RootDSE of the reader's server. fallback is returned
// when it cannot be read; its server type is kept when the type of the
// referred server is not recognized.
func (r *accountReader) serverInfo(fallback *models.ServerInfo) *models.ServerInfo {
	if r.conn == nil {
		return fallback
	}
	req := goldap.NewSearchRequest("", goldap.ScopeBaseObject, goldap.NeverDerefAliases,
		0, 0, false, "(objectClass=*)", rootDSECapabilityAttrs, nil)
	entries, err := r.search(req)
	if err != nil || len(entries) == 0 {
		return fallback
	}
	info := serverInfoFromRootDSE(entries[0])
	if info.ServerType == "" || info.ServerType == models.ServerTypeOther {
		info.ServerType = fallback.ServerType
	}
	return info
}

// status reads dn and computes its account status for the server type of
// info. It also returns the attributes read (nil for unknown server types).
func (r *accountReader) status(dn string, info *models.ServerInfo, now time.Time, cache policyCache) (*models.AccountStatus, accountAttrs, error) {
	switch info.ServerType {
	case models.ServerTypeAD:
		return r.adAccountStatus(dn, now, cache)
	case models.ServerTypeOpenLDAP:
		return r.ppolicyAccountStatus(dn, info, now, cache)
	case models.ServerType389DS:
		return r.dsAccountStatus(dn, now, cache)
	}
	st := newAccountStatus(dn, info.ServerType, now)
	st.Reason = "Account status is available for Active Directory, OpenLDAP (ppolicy) and 389 Directory Server; this server type is not recognized."
	return st, nil, nil
}

// policyCache caches policies (and policy lookups) for one status request or
// one report. Keys are policy DNs (lower case) or "#..." lookup keys. On the
// client's own connection it is seeded from (and merged back into) the
// shared policy cache, see account_policycache.go.
type policyCache map[string]*models.AccountPolicy

// AccountStatus computes the normalized account status of dn. An entry the
// server answers with a referral (e.g. a user of a child domain in the
// forest tree) is read on the referred server, without account actions (see
// accountStatusViaReferral). Policies come from the shared policy cache
// when they were read less than policyCacheTTL ago.
func (c *Client) AccountStatus(dn string) (*models.AccountStatus, error) {
	if strings.TrimSpace(dn) == "" {
		return nil, errors.New("DN must not be empty")
	}
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	pr := c.beginPolicyRead(now, policyCacheTTL)
	st, _, err := c.accountReader().status(dn, info, now, pr.cache)
	pr.finish()
	if err != nil && goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
		return c.accountStatusViaReferral(dn, err, info, now)
	}
	return st, err
}

// AccountStatusAndEntry is AccountStatus that also returns the raw account
// entry with the further attributes extra, read in the same base search (the
// password dialog's context needs both: one read instead of two). The entry
// is nil for server types without an account status; an entry answered with
// a referral is not followed (the error is returned).
func (c *Client) AccountStatusAndEntry(dn string, extra ...string) (*models.AccountStatus, *goldap.Entry, error) {
	if strings.TrimSpace(dn) == "" {
		return nil, nil, errors.New("DN must not be empty")
	}
	info, err := c.ServerInfo()
	if err != nil {
		return nil, nil, err
	}
	now := time.Now().UTC()
	r := c.accountReader()
	r.extra = extra
	pr := c.beginPolicyRead(now, policyCacheTTL)
	st, _, err := r.status(dn, info, now, pr.cache)
	pr.finish()
	if err != nil {
		return nil, nil, err
	}
	return st, r.entry, nil
}

// NewAccountPolicy returns the password policy a new account created below
// parentDN gets (the New User dialog's "must change password" option):
//   - OpenLDAP: the ppolicy default policy of the naming context (a new
//     entry has no pwdPolicySubentry); "no policy" without the ppolicy
//     overlay (the password policy control is not announced);
//   - 389DS: the subtree policy of parentDN (pwdpolicysubentry, provided by
//     the CoS of a local subtree policy) or the global policy;
//   - AD: the domain policy.
//
// nil for other server types.
func (c *Client) NewAccountPolicy(parentDN string) (*models.AccountPolicy, error) {
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	r := c.accountReader()
	pr := c.beginPolicyRead(now, policyCacheTTL)
	defer pr.finish()
	switch info.ServerType {
	case models.ServerTypeOpenLDAP:
		if !slices.Contains(info.SupportedControls, OIDPasswordPolicyControl) {
			return &models.AccountPolicy{Name: "No password policy", Source: models.PolicySourceNoPolicy, Readable: true}, nil
		}
		pol, _ := r.ppolicyPolicy(parentDN, "", info, pr.cache)
		return copyPolicy(pol), nil
	case models.ServerType389DS:
		subentry := ""
		if strings.TrimSpace(parentDN) != "" {
			if a, err := r.readAccountEntry(parentDN, []string{"pwdpolicysubentry"}); err == nil {
				subentry = a.first("pwdpolicysubentry")
			}
		}
		pol, _ := r.dsPolicy(subentry, pr.cache)
		return copyPolicy(pol), nil
	case models.ServerTypeAD:
		pol, _ := r.adPolicy(parentDN, "", pr.cache)
		return copyPolicy(pol), nil
	}
	return nil, nil
}

// copyPolicy returns a copy of p (nil for nil).
func copyPolicy(p *models.AccountPolicy) *models.AccountPolicy {
	if p == nil {
		return nil
	}
	cp := *p
	return &cp
}

// accountReferralActionReason is the reason for unsupported actions on an
// entry read through a referral to host.
func accountReferralActionReason(host string) string {
	return fmt.Sprintf("The entry is on another server (%s), reached through a referral; account actions need a connection to that server.", host)
}

// referralHost returns host:port of a referral URL (the URL itself when it
// cannot be parsed).
func referralHost(ref string) string {
	if t, err := parseReferralURL(ref); err == nil && t.host != "" {
		return net.JoinHostPort(t.host, t.port)
	}
	return ref
}

// accountReferralError explains a referral answer to the account read of dn
// when it cannot be followed.
func accountReferralError(dn string, refErr error, followingDisabled bool) error {
	refs := extractReferralURLs(refErr)
	where := "another server"
	if len(refs) > 0 {
		where = "another server (" + referralHost(refs[0]) + ")"
	}
	if followingDisabled {
		return fmt.Errorf("%s is on %s and referral following is disabled for this connection; connect to that server to see the account status", dn, where)
	}
	return fmt.Errorf("%s is on %s, but the referral names no server; connect to a server holding the entry to see the account status", dn, where)
}

// accountStatusViaReferral computes the status of dn on the server a
// referral points to: the entry and its policies (PSO, domain policy,
// ppolicy subentry) are read there with the usual referral rules (TLS never
// weaker than the profile, credentials only for trusted hosts). All actions
// are marked unsupported, because writes are not sent through referrals.
func (c *Client) accountStatusViaReferral(dn string, refErr error, info *models.ServerInfo, now time.Time) (*models.AccountStatus, error) {
	refs := extractReferralURLs(refErr)
	if c.referralsDisabled() || len(refs) == 0 {
		return nil, accountReferralError(dn, refErr, c.referralsDisabled())
	}
	var st *models.AccountStatus
	err := c.withReferralConn(context.Background(), refs[0], dn, func(conn *goldap.Conn, baseDN string) error {
		r := &accountReader{c: c, conn: conn, ctx: context.Background()}
		var err error
		st, _, err = r.status(baseDN, r.serverInfo(info), now, policyCache{})
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("account status of %s via referral to %s: %w", dn, referralHost(refs[0]), err)
	}
	markReadViaReferral(st, dn, refs[0])
	return st, nil
}

// markReadViaReferral marks st (read on the server of the referral ref) as
// read-only: every action is unsupported, and a warning names the server.
func markReadViaReferral(st *models.AccountStatus, dn, ref string) {
	// The frontend matches the status to the requested DN.
	st.DN = dn
	host := referralHost(ref)
	reason := accountReferralActionReason(host)
	for _, action := range []string{
		models.AccountActionUnlock, models.AccountActionEnable, models.AccountActionDisable,
		models.AccountActionMustChange, models.AccountActionNeverExpires, models.AccountActionAccountExpires,
		models.AccountActionUAC, models.AccountActionResetPassword,
	} {
		st.Unsupported[action] = reason
	}
	st.Warnings = append(st.Warnings, fmt.Sprintf("Read through a referral from %s. Logon data is that server's view; account actions need a connection to that server.", host))
}

// AccountChange is an account action for PlanAccountChange/ApplyAccountChange.
type AccountChange struct {
	// Action is one of models.AccountAction* (except resetPassword).
	Action string
	// Set selects set (true) or clear (false) for mustChange, neverExpires
	// and accountExpires.
	Set bool
	// Expires is the account expiration time when Action is accountExpires
	// and Set is true.
	Expires time.Time
	// ExpectedUAC and UAC: for the uac action the userAccountControl value
	// the caller saw and the new value. The change fails when the value on
	// the server differs from ExpectedUAC.
	ExpectedUAC int64
	UAC         int64
}

// ErrAccountConflict is returned when an account attribute was changed on
// the server since the caller read it.
var ErrAccountConflict = errors.New("the account was changed on the server in the meantime; reload and try again")

// Describe returns a short human readable label of the change for logs and
// audit entries.
func (ch AccountChange) Describe() string {
	switch ch.Action {
	case models.AccountActionUnlock:
		return "Unlock account"
	case models.AccountActionEnable:
		return "Enable account"
	case models.AccountActionDisable:
		return "Disable account"
	case models.AccountActionMustChange:
		if ch.Set {
			return "Require password change at next logon"
		}
		return "Clear password change at next logon"
	case models.AccountActionNeverExpires:
		if ch.Set {
			return "Set password never expires"
		}
		return "Clear password never expires"
	case models.AccountActionAccountExpires:
		if ch.Set {
			return "Set account expiration " + isoTime(ch.Expires)
		}
		return "Clear account expiration"
	case models.AccountActionUAC:
		return fmt.Sprintf("Set userAccountControl 0x%X -> 0x%X", ch.ExpectedUAC, ch.UAC)
	}
	return "Account action " + ch.Action
}

// PlanAccountChange reads the current state of dn and returns the changes
// that perform ch, without sending them. It fails when the action does not
// apply (e.g. unlock of an account that is not locked) or is not supported
// by the server.
func (c *Client) PlanAccountChange(dn string, ch AccountChange) ([]models.AttributeChange, error) {
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	// Never a cached policy for a write (a policy changed outside the app
	// would plan the wrong change); what is read refreshes the shared cache.
	now := time.Now().UTC()
	pr := c.beginPolicyRead(now, 0)
	st, attrs, err := c.accountReader().status(dn, info, now, pr.cache)
	pr.finish()
	if err != nil {
		if goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
			where := "another server"
			if refs := extractReferralURLs(err); len(refs) > 0 {
				where = "another server (" + referralHost(refs[0]) + ")"
			}
			return nil, fmt.Errorf("%s is on %s, reached through a referral; account actions need a connection to that server", dn, where)
		}
		return nil, err
	}
	if err := checkApplicable(st, ch); err != nil {
		return nil, err
	}
	switch info.ServerType {
	case models.ServerTypeAD:
		return planADChange(attrs, st, ch)
	case models.ServerTypeOpenLDAP:
		return planPPolicyChange(attrs, st, ch)
	case models.ServerType389DS:
		return plan389Change(attrs, st, ch)
	}
	return nil, errors.New("account actions are not supported for this server type")
}

// checkApplicable rejects actions on non-accounts and unsupported actions.
func checkApplicable(st *models.AccountStatus, ch AccountChange) error {
	if !st.Applicable {
		if st.Reason != "" {
			return errors.New(st.Reason)
		}
		return errors.New("the entry is not an account")
	}
	if reason, ok := st.Unsupported[ch.Action]; ok {
		return errors.New(reason)
	}
	return nil
}

// ApplyAccountChange plans ch and sends the changes as one atomic modify.
// When the modify fails because an attribute value changed in the meantime
// (noSuchAttribute, e.g. the server removed an expired lock or another admin
// changed userAccountControl), the change is planned again from the fresh
// state and retried once; the uac action is never retried but reports
// ErrAccountConflict. It returns the changes sent last (nil when planning
// failed).
func (c *Client) ApplyAccountChange(dn string, ch AccountChange) ([]models.AttributeChange, error) {
	if err := c.CheckWritable(); err != nil {
		return nil, err
	}
	for attempt := 0; ; attempt++ {
		changes, err := c.PlanAccountChange(dn, ch)
		if err != nil {
			return nil, err
		}
		changes, err = c.sendAccountChanges(dn, changes)
		if err == nil || !goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchAttribute) {
			return changes, err
		}
		if ch.Action == models.AccountActionUAC || attempt == 1 {
			return changes, fmt.Errorf("%w (%v)", ErrAccountConflict, err)
		}
	}
}

// relaxRulesOID is the OpenLDAP Relax Rules control. It lets a manager
// delete pwdFailureTime, which ppolicy declares NO-USER-MODIFICATION.
const relaxRulesOID = "1.3.6.1.4.1.4203.666.5.12"

// sendAccountChanges sends changes as one modify. A delete of pwdFailureTime
// (OpenLDAP) is sent with the Relax Rules control; when the server refuses
// it, the modify is repeated without that delete (the account is unlocked,
// but the recorded failures stay until the next successful bind). It returns
// the changes actually sent.
func (c *Client) sendAccountChanges(dn string, changes []models.AttributeChange) ([]models.AttributeChange, error) {
	reduced := make([]models.AttributeChange, 0, len(changes))
	for _, ch := range changes {
		if !strings.EqualFold(ch.Attribute, "pwdFailureTime") {
			reduced = append(reduced, ch)
		}
	}
	if len(reduced) == len(changes) {
		return changes, c.ModifyEntry(dn, changes)
	}
	err := c.ModifyEntry(dn, changes, goldap.NewControlString(relaxRulesOID, false, ""))
	if err == nil || len(reduced) == 0 || !(goldap.IsErrorWithCode(err, goldap.LDAPResultConstraintViolation) ||
		goldap.IsErrorWithCode(err, goldap.LDAPResultInsufficientAccessRights) ||
		goldap.IsErrorWithCode(err, goldap.LDAPResultUnavailableCriticalExtension)) {
		return changes, err
	}
	return reduced, c.ModifyEntry(dn, reduced)
}

// namingContextOf returns the naming context of info containing dn (longest
// match), or "".
func namingContextOf(dn string, info *models.ServerInfo) string {
	best := ""
	for _, nc := range info.NamingContexts {
		if nc != "" && isDNUnder(dn, nc) && len(nc) > len(best) {
			best = nc
		}
	}
	return best
}

// isDNUnder reports whether dn equals base or lies below it (case-insensitive).
func isDNUnder(dn, base string) bool {
	d, err1 := goldap.ParseDN(dn)
	b, err2 := goldap.ParseDN(base)
	if err1 != nil || err2 != nil {
		return strings.HasSuffix(strings.ToLower(dn), strings.ToLower(base))
	}
	return b.EqualFold(d) || b.AncestorOfFold(d)
}

// rdnValue (first RDN value of a DN) is shared with membership_graph.go.

// boolAttr parses TRUE/FALSE and on/off values; ok is false when missing.
func boolAttr(a accountAttrs, name string) (value bool, ok bool) {
	switch strings.ToLower(strings.TrimSpace(a.first(name))) {
	case "true", "on", "yes", "1":
		return true, true
	case "false", "off", "no", "0":
		return false, true
	}
	return false, false
}

// intAttr parses an integer attribute, 0 when missing.
func intAttr(a accountAttrs, name string) int64 {
	v, _ := a.int64(name)
	return v
}
