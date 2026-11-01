package services

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// The AI tools' delegates (AI-SPEC §5.4) over the merged feature tracks:
// membership (Client.ResolveMembers/ResolveMemberOf/GroupMembership/
// MembershipChange), account (Client.AccountStatus/AccountReport/
// PlanAccountChange/ApplyAccountChange), password (resetPassword = the
// write path of EditorService.SetPassword, with the method taken from the
// connection's password storage policy like the password dialog) and
// recycle (Client.ListDeletedObjects/RecycleBinInfo). Reads run through
// aiClient.do (abandoned at the tool deadline, the slot is held until the
// call returns), writes through aiClient.write (read-only check first,
// never abandoned). The AI executor audits each write "via AI"; follow-up
// writes of a delegate (re-lock of a disabled OpenLDAP account, unlock
// after a reset) are audited here with the same marker.

func (a *aiClient) Membership() ldaptools.MembershipResolver { return aiMembership{a} }
func (a *aiClient) Accounts() ldaptools.AccountInspector     { return aiAccounts{a} }
func (a *aiClient) Planner() ldaptools.AccountPlanner        { return aiAccounts{a} }
func (a *aiClient) Passwords() ldaptools.PasswordSetter      { return aiPasswords{a} }
func (a *aiClient) Recycle() ldaptools.DeletedObjectsReader  { return aiRecycle{a} }

// sideAudit audits a delegate's follow-up write "via AI".
func (a *aiClient) sideAudit(op, dn, details string, err error) {
	if a.dir != nil && a.dir.audit != nil {
		a.dir.audit(a.profileID, op, dn, "via AI: "+details, err)
	}
}

// PasswordPolicy is the connection's effective password storage policy
// (get_server_info).
func (a *aiClient) PasswordPolicy(ctx context.Context) (*models.EffectivePasswordPolicy, error) {
	var eff *models.EffectivePasswordPolicy
	err := a.do(ctx, func() error {
		var err error
		eff, err = a.c.PasswordPolicy()
		return err
	})
	return eff, err
}

// --- membership ---

type aiMembership struct{ a *aiClient }

func (m aiMembership) resolve(ctx context.Context, dn string, members, transitive bool) (*ldaptools.Membership, error) {
	var res *models.MembershipResult
	err := m.a.do(ctx, func() error {
		var err error
		if members {
			res, err = m.a.c.ResolveMembersContext(ctx, dn, transitive)
		} else {
			res, err = m.a.c.ResolveMemberOfContext(ctx, dn, transitive)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	if members && !res.IsGroup {
		return nil, ldaptools.ErrNotApplicable
	}
	return aiMembershipFrom(res), nil
}

// aiMembershipFrom converts the membership track's result.
func aiMembershipFrom(res *models.MembershipResult) *ldaptools.Membership {
	out := &ldaptools.Membership{DN: res.DN, Method: res.Method, Truncated: res.Truncated, Warnings: res.Warnings}
	for _, c := range res.Cycles {
		out.Cycles = append(out.Cycles, c.Path)
	}
	for _, it := range res.Items {
		t := it.ObjectType
		switch t {
		case models.MemberTypeUser, models.MemberTypeGroup, models.MemberTypeComputer, models.MemberTypeContact:
		default:
			t = "other"
		}
		out.Items = append(out.Items, ldaptools.MemberItem{DN: it.DN, Name: it.Name, Type: t, Depth: it.Depth, Via: it.Path,
			Primary: it.Primary != "", PrimaryOnly: it.PrimaryOnly, InCycle: it.InCycle, Unresolved: it.Unresolved, External: it.External})
	}
	return out
}

func (m aiMembership) Members(ctx context.Context, groupDN string, transitive bool) (*ldaptools.Membership, error) {
	return m.resolve(ctx, groupDN, true, transitive)
}

func (m aiMembership) MemberOf(ctx context.Context, dn string, transitive bool) (*ldaptools.Membership, error) {
	return m.resolve(ctx, dn, false, transitive)
}

func (m aiMembership) GroupInfo(ctx context.Context, groupDN string) (*ldaptools.GroupInfo, error) {
	var gm *internalldap.GroupMembership
	err := m.a.do(ctx, func() error {
		var err error
		gm, err = m.a.c.GroupMembership(groupDN)
		return err
	})
	if err != nil {
		if errors.Is(err, internalldap.ErrNotAGroup) {
			return nil, ldaptools.ErrNotApplicable
		}
		return nil, err
	}
	res, err := m.a.Search(ctx, models.SearchParams{BaseDN: groupDN, Filter: "(objectClass=*)", Scope: models.ScopeBase, SizeLimit: 1,
		Attributes: []string{"objectClass", "member", "uniqueMember", "memberUid", "primaryGroupToken"}})
	if err != nil {
		return nil, err
	}
	if len(res.Entries) == 0 {
		return nil, fmt.Errorf("%w: %s", internalldap.ErrNotFound, groupDN)
	}
	e := res.Entries[0]
	info := &ldaptools.GroupInfo{DN: groupDN, MemberAttrs: []string{gm.Attribute}, Values: map[string][]string{}, POSIX: gm.POSIX, MemberUIDs: gm.MemberUIDs}
	for _, at := range e.Attributes {
		name := strings.ToLower(at.Name)
		switch {
		case name == "objectclass":
			info.ObjectClass = at.Values
		case name == "primarygrouptoken":
			if len(at.Values) > 0 {
				info.PrimaryToken, _ = strconv.Atoi(at.Values[0])
			}
		default:
			// AD ranged values ("member;range=0-1499") are complete here:
			// the client's search follows ranges.
			base, _, _ := strings.Cut(name, ";")
			info.Values[base] = append(info.Values[base], at.Values...)
		}
	}
	if gm.POSIX && !strings.EqualFold(gm.Attribute, "memberUid") {
		info.MemberAttrs = append(info.MemberAttrs, "memberUid")
	}
	return info, nil
}

// MemberValues mirrors EditorService.changeOneMembership: the group's
// member value from MembershipChange; for a delete of a uniqueMember also
// the stored values with an optional UID; for RFC 2307bis groups the
// member's memberUid (always on delete, on add when the group keeps
// memberUid values).
func (m aiMembership) MemberValues(ctx context.Context, g *ldaptools.GroupInfo, op, member string) ([]ldaptools.MemberValue, error) {
	gm := &internalldap.GroupMembership{Attribute: g.MemberAttrs[0], POSIX: g.POSIX, MemberUIDs: g.MemberUIDs}
	var out []ldaptools.MemberValue
	err := m.a.do(ctx, func() error {
		ch, err := m.a.c.MembershipChange(gm, op, member)
		if err != nil {
			return err
		}
		for _, v := range ch.Values {
			out = append(out, ldaptools.MemberValue{Attr: ch.Attribute, Value: v})
		}
		if op == models.ChangeDelete && strings.EqualFold(ch.Attribute, "uniqueMember") {
			if vs, err := m.a.c.MatchingMemberValues(g.DN, ch.Attribute, member); err == nil {
				for _, v := range vs {
					out = append(out, ldaptools.MemberValue{Attr: ch.Attribute, Value: v})
				}
			}
		}
		if gm.POSIX && !strings.EqualFold(ch.Attribute, "memberUid") && (op == models.ChangeDelete || gm.MemberUIDs) {
			if uid, err := m.a.c.MembershipValue("memberUid", member); err == nil {
				out = append(out, ldaptools.MemberValue{Attr: "memberUid", Value: uid})
			}
		}
		return nil
	})
	return out, err
}

// --- accounts ---

type aiAccounts struct{ a *aiClient }

func (s aiAccounts) status(ctx context.Context, dn string) (*models.AccountStatus, error) {
	var st *models.AccountStatus
	err := s.a.do(ctx, func() error {
		var err error
		st, err = s.a.c.AccountStatus(dn)
		return err
	})
	return st, err
}

// aiActionNames maps the account track's actions to the AI tools.
var aiActionNames = map[string]string{
	models.AccountActionUnlock: "unlock_account", models.AccountActionEnable: "set_account_enabled (enable)",
	models.AccountActionDisable: "set_account_enabled (disable)", models.AccountActionMustChange: "set_password_must_change",
	models.AccountActionResetPassword: "reset_password",
}

func (s aiAccounts) Status(ctx context.Context, dn string) (*ldaptools.AccountStatus, error) {
	st, err := s.status(ctx, dn)
	if err != nil {
		return nil, err
	}
	return aiAccountStatusFrom(st), nil
}

// aiAccountStatusFrom converts the account track's status.
func aiAccountStatusFrom(st *models.AccountStatus) *ldaptools.AccountStatus {
	bad := st.BadPasswordCount
	out := &ldaptools.AccountStatus{DN: st.DN, ServerType: st.ServerType, Applicable: st.Applicable, Reason: st.Reason, AccountType: st.Kind,
		Enabled: st.Enabled, DisabledBy: st.DisabledBy, LockedOut: st.Locked, LockedPermanently: st.LockedPermanently, LockoutTime: st.LockedAt,
		LockedUntil: st.LockedUntil, LockoutExpired: st.LockoutExpired, MustChangePassword: st.MustChangePassword,
		PasswordNeverExpires: st.PasswordNeverExpires, PasswordLastSet: st.PasswordLastSet, PasswordExpires: st.PasswordExpires,
		PasswordExpired: st.PasswordExpired, AccountExpires: st.AccountExpires, Expired: st.AccountExpired, LastLogon: st.LastLogon,
		LastLogonReplicated: st.LastLogonReplicated, BadPasswordCount: &bad, Warnings: st.Warnings}
	if st.AccountNeverExpires && out.AccountExpires == "" {
		out.AccountExpires = "never"
	}
	if st.PasswordExpiryNote != "" {
		out.Notes = append(out.Notes, "Password expiry: "+st.PasswordExpiryNote)
	}
	if st.DisabledByRole {
		out.Notes = append(out.Notes, "A 389 DS role (nsDisabledRole) disables the account.")
	}
	if p := st.Policy; p != nil {
		pol := map[string]string{"name": p.Name, "source": p.Source}
		if !p.Readable {
			pol["readable"] = "false"
		} else {
			pol["lockout_enabled"] = strconv.FormatBool(p.LockoutEnabled)
			if p.LockoutEnabled {
				pol["lockout_threshold"] = strconv.Itoa(p.LockoutThreshold)
				pol["lockout_duration"] = aiDuration(p.LockoutDurationSeconds, "until an administrator unlocks")
			}
			pol["max_password_age"] = aiDuration(p.MaxPasswordAgeSeconds, "never expires")
			pol["min_password_length"] = strconv.Itoa(p.MinPasswordLength)
			pol["password_history"] = strconv.Itoa(p.PasswordHistory)
			pol["must_change_enforced"] = strconv.FormatBool(p.MustChangeEnforced)
		}
		out.Policy = pol
	}
	actions := make([]string, 0, len(st.Unsupported))
	for k, reason := range st.Unsupported {
		name := aiActionNames[k]
		if name == "" {
			continue
		}
		actions = append(actions, name+": "+reason)
	}
	sort.Strings(actions)
	out.UnsupportedActions = actions
	return out
}

func aiDuration(secs int64, zero string) string {
	if secs <= 0 {
		return zero
	}
	d := time.Duration(secs) * time.Second
	switch {
	case d%(24*time.Hour) == 0:
		return fmt.Sprintf("%d days", int64(d/(24*time.Hour)))
	case d%time.Hour == 0:
		return fmt.Sprintf("%d hours", int64(d/time.Hour))
	case d%time.Minute == 0:
		return fmt.Sprintf("%d minutes", int64(d/time.Minute))
	}
	return d.String()
}

var aiReportKinds = map[string]string{"locked": models.AccountReportLocked, "disabled": models.AccountReportDisabled,
	"passwordExpired": models.AccountReportPasswordExpired}

func (s aiAccounts) Report(ctx context.Context, p ldaptools.ReportParams) (*ldaptools.AccountReport, error) {
	kind, ok := aiReportKinds[p.Kind]
	if !ok {
		return nil, fmt.Errorf("report %q: %w", p.Kind, ldaptools.ErrUnsupported)
	}
	limit := p.Limit
	if limit <= 0 || limit > 100000 {
		limit = 100000
	}
	var res *models.AccountReportResult
	err := s.a.do(ctx, func() error {
		var err error
		res, err = s.a.c.AccountReport(models.AccountReportParams{Report: kind, BaseDN: p.BaseDN, SizeLimit: limit})
		return err
	})
	if err != nil {
		return nil, err
	}
	out := aiReportFrom(res, kind, p.ObjectKind)
	if kind == models.AccountReportLocked {
		s.addLockoutTimes(ctx, out)
		out.ExpiredLockouts = s.expiredLockouts(ctx, p)
	}
	return out, nil
}

// aiLockoutDetailLimit bounds the per-account status reads of a locked
// report (locked accounts are usually few).
const aiLockoutDetailLimit = 100

// addLockoutTimes adds when each locked account was locked and when the
// lockout ends (or that it is permanent) from the account track's status,
// so the assistant never guesses a lockout window (UX A-23).
func (s aiAccounts) addLockoutTimes(ctx context.Context, rep *ldaptools.AccountReport) {
	for i := range rep.Accounts {
		if i >= aiLockoutDetailLimit || ctx.Err() != nil {
			return
		}
		st, err := s.status(ctx, rep.Accounts[i].DN)
		if err != nil || st == nil {
			continue
		}
		rep.Accounts[i].LockedAt, rep.Accounts[i].LockedUntil, rep.Accounts[i].LockedPermanently = st.LockedAt, st.LockedUntil, st.LockedPermanently
	}
}

// aiExpiredLockoutFilter selects accounts that still carry a lockout
// timestamp (the track's locked report drops them once the lockout
// duration has passed).
var aiExpiredLockoutFilter = map[string]string{
	models.ServerTypeAD:       "(&(objectClass=user)(lockoutTime>=1))",
	models.ServerTypeOpenLDAP: "(&(pwdAccountLockedTime=*)(!(pwdAccountLockedTime=000001010000Z)))",
	models.ServerType389DS:    "(accountUnlockTime=*)",
}

// expiredLockouts lists accounts whose lockout timestamp is still stored
// although the lockout has expired (AccountStatus.LockoutExpired), so the
// assistant can say "no account is locked now; X's lockout expired"
// instead of silently dropping them (AI-SPEC find_accounts locked_out).
// At most 200 candidates are checked.
func (s aiAccounts) expiredLockouts(ctx context.Context, p ldaptools.ReportParams) []ldaptools.ReportItem {
	info, err := s.a.ServerInfo(ctx)
	if err != nil || aiExpiredLockoutFilter[info.ServerType] == "" {
		return nil
	}
	base := p.BaseDN
	if base == "" {
		base = s.a.Info().BaseDN
	}
	if base == "" {
		base = info.DefaultNamingContext
	}
	res, err := s.a.Search(ctx, models.SearchParams{BaseDN: base, Filter: aiExpiredLockoutFilter[info.ServerType], Scope: models.ScopeSub, SizeLimit: 200,
		Attributes: []string{"objectClass", "sAMAccountName", "uid", "cn", "displayName"}})
	if err != nil || res == nil {
		return nil
	}
	var out []ldaptools.ReportItem
	for i := range res.Entries {
		e := &res.Entries[i]
		st, err := s.status(ctx, e.DN)
		if err != nil || st == nil || !st.LockoutExpired || st.Locked {
			continue
		}
		rep := aiReportFrom(&models.AccountReportResult{Entries: []models.LDAPEntry{*e}}, models.AccountReportLocked, p.ObjectKind)
		for _, it := range rep.Accounts {
			it.Detail = "lockout expired"
			if st.LockedAt != "" {
				it.Detail += " (locked at " + st.LockedAt + ")"
			}
			out = append(out, it)
		}
	}
	return out
}

// aiReportFrom converts an account report, keeping the object kind
// (users | computers | all; the track reports users and computers).
func aiReportFrom(res *models.AccountReportResult, kind, objectKind string) *ldaptools.AccountReport {
	out := &ldaptools.AccountReport{Truncated: res.Truncated, Method: "account report " + kind + " (status computed per account)", Notes: res.Notes}
	for i := range res.Entries {
		e := &res.Entries[i]
		computer := false
		for _, oc := range entryValues(e, "objectClass") {
			computer = computer || strings.EqualFold(oc, "computer")
		}
		if objectKind == "users" && computer || objectKind == "computers" && !computer {
			continue
		}
		login := entryValue(e, "sAMAccountName")
		if login == "" {
			login = entryValue(e, "uid")
		}
		name := entryValue(e, "displayName")
		if name == "" {
			name = entryValue(e, "cn")
		}
		out.Accounts = append(out.Accounts, ldaptools.ReportItem{DN: e.DN, Login: login, Name: name})
	}
	out.Total = len(out.Accounts)
	return out
}

func entryValues(e *models.LDAPEntry, name string) []string {
	for _, a := range e.Attributes {
		if strings.EqualFold(a.Name, name) {
			return a.Values
		}
	}
	return nil
}

func entryValue(e *models.LDAPEntry, name string) string {
	if v := entryValues(e, name); len(v) > 0 {
		return v[0]
	}
	return ""
}

// aiAccountChange maps an AI account action to the account track's change.
func aiAccountChange(action string) (internalldap.AccountChange, error) {
	switch action {
	case ldaptools.ActionUnlock:
		return internalldap.AccountChange{Action: models.AccountActionUnlock}, nil
	case ldaptools.ActionEnable:
		return internalldap.AccountChange{Action: models.AccountActionEnable}, nil
	case ldaptools.ActionDisable:
		return internalldap.AccountChange{Action: models.AccountActionDisable}, nil
	case ldaptools.ActionMustChange:
		return internalldap.AccountChange{Action: models.AccountActionMustChange, Set: true}, nil
	case ldaptools.ActionClearMustChange:
		return internalldap.AccountChange{Action: models.AccountActionMustChange, Set: false}, nil
	}
	return internalldap.AccountChange{}, fmt.Errorf("unknown account action %q", action)
}

// aiAccountNoOp returns why the action changes nothing on st ("" = it does).
func aiAccountNoOp(st *models.AccountStatus, action string) (reason, hint string) {
	switch action {
	case ldaptools.ActionUnlock:
		if !st.Locked {
			if !st.Enabled && st.ServerType == models.ServerTypeOpenLDAP {
				return "The account is disabled (permanent ppolicy lock), not locked out.", "Use set_account_enabled to enable it."
			}
			return "The account is not locked out.", ""
		}
	case ldaptools.ActionEnable:
		if st.Enabled {
			if st.Locked {
				return "The account is already enabled.", "It is locked out after failed logons; use unlock_account."
			}
			return "The account is already enabled.", ""
		}
	case ldaptools.ActionDisable:
		if !st.Enabled {
			return "The account is already disabled.", ""
		}
	case ldaptools.ActionMustChange:
		if st.MustChangePassword {
			return "The account must already change its password at the next logon.", ""
		}
	case ldaptools.ActionClearMustChange:
		if !st.MustChangePassword {
			return "The account does not have to change its password at the next logon.", ""
		}
	}
	return "", ""
}

func (s aiAccounts) Plan(ctx context.Context, dn, action string) (*ldaptools.AccountPlan, error) {
	ch, err := aiAccountChange(action)
	if err != nil {
		return nil, err
	}
	st, err := s.status(ctx, dn)
	if err != nil {
		return nil, err
	}
	if !st.Applicable {
		reason := st.Reason
		if reason == "" {
			reason = dn + " is not a user or computer account"
		}
		return nil, fmt.Errorf("%s: %w", reason, ldaptools.ErrNotApplicable)
	}
	plan := &ldaptools.AccountPlan{DN: dn, Action: action, Before: map[string][]string{}}
	if reason, hint := aiAccountNoOp(st, action); reason != "" {
		plan.NoOp, plan.Reason, plan.Hint = true, reason, hint
		return plan, nil
	}
	if reason, ok := st.Unsupported[ch.Action]; ok {
		return nil, fmt.Errorf("%s: %w", reason, ldaptools.ErrUnsupported)
	}
	err = s.a.do(ctx, func() error {
		var err error
		plan.Changes, err = s.a.c.PlanAccountChange(dn, ch)
		return err
	})
	if err != nil {
		return nil, err
	}
	var touched []string
	for _, c := range plan.Changes {
		if !slices.ContainsFunc(touched, func(t string) bool { return strings.EqualFold(t, c.Attribute) }) {
			touched = append(touched, c.Attribute)
		}
	}
	if len(touched) > 0 {
		res, err := s.a.Search(ctx, models.SearchParams{BaseDN: dn, Filter: "(objectClass=*)", Scope: models.ScopeBase, SizeLimit: 1, Attributes: touched})
		if err != nil {
			return nil, err
		}
		for _, t := range touched {
			var vals []string
			if len(res.Entries) > 0 {
				vals = entryValues(&res.Entries[0], t)
			}
			plan.Before[t] = vals
		}
	}
	if action == ldaptools.ActionMustChange && st.ServerType == models.ServerTypeAD && st.PasswordNeverExpires {
		plan.Notes = append(plan.Notes, "The account's password never expires (DONT_EXPIRE_PASSWORD): Active Directory does not ask the user to change it at the next logon.")
	}
	return plan, nil
}

func (s aiAccounts) Apply(ctx context.Context, plan *ldaptools.AccountPlan) ([]models.AttributeChange, error) {
	ch, err := aiAccountChange(plan.Action)
	if err != nil {
		return nil, err
	}
	var sent []models.AttributeChange
	err = s.a.write(ctx, func() error {
		var err error
		sent, err = s.a.c.ApplyAccountChange(plan.DN, ch)
		return err
	})
	if errors.Is(err, internalldap.ErrAccountConflict) {
		err = fmt.Errorf("%w: %v", ldaptools.ErrAccountConflict, err)
	}
	return sent, err
}

// --- passwords ---

type aiPasswords struct{ a *aiClient }

// aiPasswordSelection picks the reset method like the password dialog's
// policySelection (lib/passwordMethod.ts): AD → unicodePwd (TLS only);
// policy client → userPassword hashed with the policy's scheme; policy
// server → Password Modify when the server announces it (unless the
// connection is unencrypted and the server hashes cleartext itself: 389DS
// refuses the operation without TLS), else a cleartext userPassword the
// server hashes; policy ask → the user decides (ErrPasswordDecisionRequired).
// A server that neither hashes nor offers Password Modify is refused rather
// than storing the password in cleartext.
func aiPasswordSelection(serverType string, eff *models.EffectivePasswordPolicy, tls bool) (method, scheme string, err error) {
	if serverType == models.ServerTypeAD {
		if !tls {
			return "", "", fmt.Errorf("Active Directory accepts password resets only over an encrypted connection (LDAPS or StartTLS); this connection is not encrypted: %w", ldaptools.ErrUnsupported)
		}
		return models.PasswordMethodUnicodePwd, "", nil
	}
	if eff == nil {
		return "", "", fmt.Errorf("the connection's password storage policy could not be determined: %w", ldaptools.ErrUnsupported)
	}
	switch eff.Policy {
	case models.PasswordPolicyClient:
		if slices.ContainsFunc(internalldap.PasswordSchemes(), func(s models.PasswordScheme) bool { return strings.EqualFold(s.ID, eff.Scheme) }) {
			return models.PasswordMethodUserPassword, eff.Scheme, nil
		}
		return "", "", fmt.Errorf("the connection's password storage scheme %q is unknown: %w", eff.Scheme, ldaptools.ErrUnsupported)
	case models.PasswordPolicyServer:
		if eff.PasswordModifyExop && (tls || !eff.ServerHashes) {
			return models.PasswordMethodExop, "", nil
		}
		if eff.ServerHashes {
			return models.PasswordMethodUserPassword, internalldap.SchemeCleartext, nil
		}
		return "", "", fmt.Errorf("the connection's password storage policy is server-side hashing, but this server neither announces the Password Modify operation nor is known to hash cleartext passwords, so the password could be stored in cleartext: %w", ldaptools.ErrUnsupported)
	case models.PasswordPolicyAsk:
		return "", "", internalldap.ErrPasswordDecisionRequired
	}
	return "", "", fmt.Errorf("no password reset method for this server: %w", ldaptools.ErrUnsupported)
}

// aiPasswordMethodLabel names a method for the approval card.
func aiPasswordMethodLabel(method, scheme, schemeLabel string) string {
	switch method {
	case models.PasswordMethodUnicodePwd:
		return "replace unicodePwd (Active Directory)"
	case models.PasswordMethodExop:
		return "Password Modify extended operation (RFC 3062); the server hashes the password"
	}
	if strings.EqualFold(scheme, internalldap.SchemeCleartext) {
		return "replace userPassword with the cleartext password; the server hashes it"
	}
	return "replace userPassword, hashed by LDAPilot as " + schemeLabel
}

func aiSchemeLabel(scheme string) string {
	for _, s := range internalldap.PasswordSchemes() {
		if strings.EqualFold(s.ID, scheme) {
			return s.Label
		}
	}
	return scheme
}

// aiDSMustChange records on a 389 DS reset plan that the entry's effective
// password policy (pol from the account track: the local policy or the
// global one in cn=config; nil = unknown) decides "must change at next
// logon": with passwordMustChange on, the server marks the reset password
// as expired (passwordExpirationTime 19700101000000Z) itself. The plan
// reports the policy's value when it is readable; nothing is requested
// (passwordAccountChanges refuses must-change on 389 DS).
func aiDSMustChange(plan *ldaptools.PasswordPlan, pol *models.AccountPolicy) {
	plan.MustChange, plan.MustChangeKnown = false, false
	if pol == nil || !pol.Readable {
		plan.MustChangeBy = "389 DS password policy (passwordMustChange, not readable with this account)"
		plan.Notes = append(plan.Notes, "389 DS decides 'must change at next logon' through its password policy (passwordMustChange), which this account cannot read: the user may have to change the password at the next bind. must_change_at_next_logon has no effect on 389 DS.")
		return
	}
	name := firstNonEmptyStr(pol.Name, pol.DN, "password policy")
	switch pol.Source {
	case models.PolicySourceGlobal:
		name = "global policy in cn=config"
	case models.PolicySourceSubentry:
		name = "local policy " + firstNonEmptyStr(pol.Name, pol.DN)
	}
	plan.MustChangeKnown = true
	plan.MustChange = pol.MustChangeEnforced
	if pol.MustChangeEnforced {
		plan.MustChangeBy = "389 DS password policy (passwordMustChange: on, " + name + ")"
		plan.Notes = append(plan.Notes, "389 DS decides 'must change at next logon' through its password policy: passwordMustChange is on ("+name+"), so the user must change the password at the next bind. must_change_at_next_logon has no effect on 389 DS.")
		return
	}
	plan.MustChangeBy = "389 DS password policy (passwordMustChange: off, " + name + ")"
	plan.Notes = append(plan.Notes, "389 DS decides 'must change at next logon' through its password policy: passwordMustChange is off ("+name+"), so the user does not have to change the password. must_change_at_next_logon has no effect on 389 DS.")
}

func (p aiPasswords) Plan(ctx context.Context, dn string, mustChange bool) (*ldaptools.PasswordPlan, error) {
	var info *models.ServerInfo
	var eff *models.EffectivePasswordPolicy
	err := p.a.do(ctx, func() error {
		var err error
		if info, err = p.a.c.ServerInfo(); err != nil {
			return err
		}
		eff, _ = p.a.c.PasswordPolicy()
		return nil
	})
	if err != nil {
		return nil, err
	}
	tls := p.a.Info().TLS()
	method, scheme, err := aiPasswordSelection(info.ServerType, eff, tls)
	if err != nil {
		return nil, err
	}
	plan := &ldaptools.PasswordPlan{DN: dn, Method: method, Scheme: scheme, MustChange: mustChange}
	ppolicy := slices.Contains(info.SupportedControls, internalldap.OIDPasswordPolicyControl)
	switch {
	case info.ServerType == models.ServerType389DS:
		// Whatever the model asked: 389 DS's password policy decides after an
		// administrator reset (2b defect 2: the card said "Must change: no"
		// while the server set passwordExpirationTime 19700101000000Z).
		var pol *models.AccountPolicy
		_ = p.a.do(ctx, func() error {
			if st, err := p.a.c.AccountStatus(dn); err == nil && st != nil {
				pol = st.Policy
			}
			return nil
		})
		aiDSMustChange(plan, pol)
	case !mustChange:
	case info.ServerType == models.ServerTypeOpenLDAP && !ppolicy:
		plan.MustChange = false
		plan.Notes = append(plan.Notes, "The server has no password policy (ppolicy); 'must change at next logon' cannot be set.")
	case info.ServerType != models.ServerTypeAD && info.ServerType != models.ServerTypeOpenLDAP:
		plan.MustChange = false
		plan.Notes = append(plan.Notes, "'Must change at next logon' is only supported on Active Directory and OpenLDAP (ppolicy).")
	}
	req := models.PasswordChangeRequest{DN: dn, Method: method, Scheme: scheme, MustChange: plan.RequestMustChange()}
	accountChanges, err := passwordAccountChanges(info.ServerType, ppolicy, req)
	if err != nil {
		return nil, fmt.Errorf("%v: %w", err, ldaptools.ErrUnsupported)
	}
	cleartext := passwordChangeSendsCleartext(req)
	pv := &ai.PasswordPreview{Method: method, Scheme: scheme, CleartextOnWire: cleartext, Unencrypted: cleartext && !tls, MustChange: plan.MustChange, Notes: []string{}}
	if scheme != "" {
		pv.SchemeLabel = aiSchemeLabel(scheme)
	}
	pv.MethodLabel = aiPasswordMethodLabel(method, scheme, pv.SchemeLabel)
	if eff != nil {
		pv.Policy, pv.PolicySummary, pv.ServerHashes = eff.Policy, eff.Summary, eff.ServerHashes
		pv.Notes = append(pv.Notes, eff.Warnings...)
	}
	if info.ServerType == models.ServerTypeAD {
		pv.Policy = models.PasswordPolicyAD
	}
	if pv.Unencrypted {
		// The approval card states this once, from Storage.Unencrypted (a
		// note here was shown a second time as a warning, test-1 D9); the
		// tool result tells the model (prepareResetPassword).
		plan.AllowUnencrypted = true
	}
	plan.Storage = pv

	var ldif strings.Builder
	fmt.Fprintf(&ldif, "dn: %s\n", dn)
	switch method {
	case models.PasswordMethodUnicodePwd:
		ldif.WriteString("changetype: modify\nreplace: unicodePwd\nunicodePwd:: " + ldaptools.PasswordPlaceholder + "\n-\n")
	case models.PasswordMethodExop:
		ldif.WriteString("# Password Modify extended operation (value generated locally after approval)\n")
		if len(accountChanges) > 0 {
			ldif.WriteString("\ndn: " + dn + "\n")
		}
	default:
		value := ldaptools.PasswordPlaceholder
		if !strings.EqualFold(scheme, internalldap.SchemeCleartext) {
			value = "<generated locally after approval, hashed as " + pv.SchemeLabel + ">"
		}
		ldif.WriteString("changetype: modify\nreplace: userPassword\nuserPassword: " + value + "\n-\n")
	}
	if len(accountChanges) > 0 {
		if method == models.PasswordMethodExop {
			ldif.WriteString("changetype: modify\n")
		}
		for _, c := range accountChanges {
			fmt.Fprintf(&ldif, "%s: %s\n%s: %s\n-\n", c.Operation, c.Attribute, c.Attribute, strings.Join(c.Values, ""))
		}
	}
	plan.LDIF = ldif.String()
	return plan, nil
}

func (p aiPasswords) Apply(ctx context.Context, plan *ldaptools.PasswordPlan, value string) (*ldaptools.PasswordOutcome, error) {
	req := models.PasswordChangeRequest{DN: plan.DN, Password: value, Method: plan.Method, Scheme: plan.Scheme, MustChange: plan.RequestMustChange(),
		AllowUnencrypted: plan.AllowUnencrypted}
	var res *models.PasswordChangeResult
	err := p.a.write(ctx, func() error {
		var err error
		res, err = resetPassword(p.a.c, req, p.a.sideAudit, false)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &ldaptools.PasswordOutcome{StoredSchemeLabel: res.StoredSchemeLabel, Ineffective: res.Ineffective, Unconfirmed: res.Unconfirmed,
		MustChangeIgnored: res.MustChangeIgnored, Operations: res.Operations, Warnings: res.Warnings}, nil
}

// --- deleted objects ---

type aiRecycle struct{ a *aiClient }

func (r aiRecycle) List(ctx context.Context, nc, text string, limit int) (*models.DeletedObjectsList, error) {
	var out *models.DeletedObjectsList
	err := r.a.do(ctx, func() error {
		var err error
		out, err = r.a.c.ListDeletedObjects(nc, text, limit)
		return err
	})
	return out, err
}

func (r aiRecycle) Info(ctx context.Context) (*models.RecycleBinInfo, error) {
	var out *models.RecycleBinInfo
	err := r.a.do(ctx, func() error {
		var err error
		out, err = r.a.c.RecycleBinInfo()
		return err
	})
	return out, err
}
