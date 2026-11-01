package ldaptools

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	"github.com/dpicillo/LDAPilot/internal/models"
)

func init() {
	register(&readTool{def: &tools.Def{
		Name: "get_membership", DisplayName: "Group membership", Kind: tools.KindRead, Timeout: TimeoutCount, Directory: true,
		Description: "Resolve group membership. direction=members lists the members of a group; direction=member_of lists the groups an object belongs to. With transitive=true nested groups are expanded (cycle-safe) and each result shows the nesting path; for member_of the primary group (AD primaryGroupID, POSIX gidNumber) is included. Use this instead of reading member or memberOf yourself: those attributes are direct-only, can be very long and differ between servers (member, uniqueMember, memberUid).",
		Params: tools.Obj(
			connectionProp(),
			tools.R("dn", tools.Str("DN of the group (members) or of the user, computer or group (member_of).")),
			tools.R("direction", tools.Enum("members = members of the group; member_of = groups the object belongs to.", "", "members", "member_of")),
			tools.P("transitive", tools.Bool("Expand nested groups.", false)),
			tools.P("object_type", tools.Enum("Only return results of this type.", "any", "any", "user", "group", "computer", "contact")),
			tools.P("limit", tools.Int("Maximum results to return.", 1, 1000, 200)),
			tools.P("offset", tools.Int("Results to skip (paging).", 0, 10000, 0)),
		),
	}, run: runGetMembership})

	register(&readTool{def: &tools.Def{
		Name: "get_account_status", DisplayName: "Account status", Kind: tools.KindRead, Timeout: TimeoutRead, Directory: true,
		Description: "Summarise the state of one user or computer account: enabled or disabled, locked out (with lockout time), password last set, must change at next logon, password never expires, password expiry, account expiry, last logon, failed logon count and the effective password policy. Works for Active Directory, OpenLDAP with the ppolicy overlay and 389 Directory Server, using each server's own attributes. Use it for one specific account; to find all accounts in a state, use find_accounts.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("dn", tools.Str("DN of the account.")),
		),
	}, run: runAccountStatus})

	register(&readTool{def: &tools.Def{
		Name: "find_accounts", DisplayName: "Find accounts", Kind: tools.KindRead, Timeout: TimeoutCount, Directory: true,
		Description: "Find accounts in a given state: locked_out, disabled, expired, password_expired, must_change_password, password_never_expires, never_logged_on, or inactive (no logon for inactive_days). LDAPilot builds the correct server-specific query and verifies states that a filter alone cannot decide (for example AD lockouts that have already expired). never_logged_on and inactive skip disabled accounts (unless include_disabled=true) and accounts created less than inactive_days ago. Prefer this over hand-written filters for account-state questions. Use count_only=true for 'how many'.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("status", tools.Enum("The account state to find.", "", "locked_out", "disabled", "expired", "password_expired", "must_change_password", "password_never_expires", "never_logged_on", "inactive")),
			tools.P("base_dn", tools.Str("Entry to search below. Default: the connection's base DN.")),
			tools.P("object_kind", tools.Enum("Which accounts.", "users", "users", "computers", "all")),
			tools.P("inactive_days", tools.Int("Days without logon for inactive (also the minimum account age for never_logged_on and inactive).", 1, 3650, 90)),
			tools.P("include_disabled", tools.Bool("Also include disabled accounts (never_logged_on, inactive).", false)),
			tools.P("limit", tools.Int("Maximum accounts to return.", 1, 500, 50)),
			tools.P("offset", tools.Int("Accounts to skip (paging).", 0, 100000, 0)),
			tools.P("count_only", tools.Bool("Only count matches.", false)),
		),
	}, run: runFindAccounts})
}

// --- get_membership ---

func runGetMembership(ctx context.Context, s *Session, c *Call) *tools.Result {
	dn := cleanDN(c.Args.Str("dn"))
	if r := checkDN(c.Tool, dn); r != nil {
		return r
	}
	dir := c.Args.Str("direction")
	trans := c.Args.Bool("transitive", false)
	ot := c.Args.Str("object_type")
	if ot == "" {
		ot = "any"
	}
	limit, offset := c.Args.Int("limit", 200), c.Args.Int("offset", 0)
	key := fmt.Sprintf("membership|%s|%s|%s|%v", c.Conn.Info.ProfileID, strings.ToLower(dn), dir, trans)
	cache := s.Shared.Chat(s.ChatID)
	var mem *Membership
	if v, ok := cache.Get(key); ok {
		mem = v.(*Membership)
	} else {
		var err error
		if dir == "member_of" {
			mem, err = c.Client.Membership().MemberOf(ctx, dn, trans)
		} else {
			mem, err = c.Client.Membership().Members(ctx, dn, trans)
		}
		if err != nil {
			if errors.Is(err, ErrNotApplicable) {
				return errf(c.Tool, tools.ErrInvalidArguments, "Use direction=member_of for users and computers.", "%s is not a group.", dnOrDash(dn))
			}
			return entryDNError(ctx, c, err, dn)
		}
		cache.Put(c.Conn.Info.ProfileID, key, mem)
	}
	counts := map[string]int{"user": 0, "group": 0, "computer": 0, "contact": 0, "other": 0}
	var filtered []MemberItem
	for _, it := range mem.Items {
		t := it.Type
		if _, ok := counts[t]; !ok {
			t = "other"
		}
		counts[t]++
		if ot == "any" || it.Type == ot {
			filtered = append(filtered, it)
		}
	}
	z := NewSanitizer(false)
	r := newResult(c)
	r.Fields.Add("dn", z.DN(mem.DN))
	r.Fields.Add("direction", dir)
	r.Fields.Add("transitive", trans)
	r.Fields.Add("server_type", serverType(ctx, c.Client))
	r.Fields.Add("method", mem.Method)
	r.Fields.Add("total", len(filtered))
	r.Fields.Add("counts", tools.Fs("user", counts["user"], "group", counts["group"], "computer", counts["computer"], "contact", counts["contact"], "other", counts["other"]))
	if len(mem.Cycles) > 0 {
		var cyc [][]string
		for _, cy := range mem.Cycles {
			var row []string
			for _, d := range cy {
				row = append(row, z.DN(d))
			}
			cyc = append(cyc, row)
		}
		r.Fields.Add("cycles", cyc)
	}
	end := min(offset+limit, len(filtered))
	items := []any{}
	for i := offset; i < end; i++ {
		it := filtered[i]
		f := tools.Fs("dn", z.DN(it.DN), "name", z.Text(it.Name, "name", it.DN), "type", it.Type, "depth", it.Depth)
		via := make([]string, 0, len(it.Via))
		for _, v := range it.Via {
			via = append(via, z.DN(v))
		}
		f.Add("via", via)
		if it.Primary {
			f.Add("primary", true)
		}
		if it.PrimaryOnly {
			f.Add("primary_only", true)
		}
		if it.InCycle {
			f.Add("in_cycle", true)
		}
		if it.Unresolved {
			f.Add("unresolved", true)
		}
		if it.External {
			f.Add("external", true)
		}
		if it.DN != "" {
			r.DNs = append(r.DNs, it.DN)
		}
		items = append(items, f)
	}
	r.List = &tools.List{Key: "items", Items: items, Offset: offset, More: len(filtered) > end, Total: len(filtered)}
	r.Truncated = mem.Truncated
	r.Notes = append(r.Notes, mem.Warnings...)
	if mem.Truncated {
		r.Note("The membership list is incomplete (limits: 10000 items, depth 32, time budget).")
	}
	r.Warnings = append(r.Warnings, z.Warnings()...)
	r.Summary = map[string]string{"members": Plural(len(filtered), "member", "members"), "member_of": Plural(len(filtered), "group", "groups")}[dir]
	return r
}

// --- get_account_status ---

func runAccountStatus(ctx context.Context, s *Session, c *Call) *tools.Result {
	dn := cleanDN(c.Args.Str("dn"))
	if r := checkDN(c.Tool, dn); r != nil {
		return r
	}
	st, err := c.Client.Accounts().Status(ctx, dn)
	if err != nil {
		return entryDNError(ctx, c, err, dn)
	}
	z := NewSanitizer(false)
	r := newResult(c)
	r.Fields.Add("dn", z.DN(st.DN))
	r.Fields.Add("server_type", st.ServerType)
	r.Fields.Add("applicable", st.Applicable)
	r.DNs = []string{st.DN}
	if !st.Applicable {
		r.Fields.Add("reason", st.Reason)
		r.Summary = "not an account"
		return r
	}
	r.Fields.Add("account_type", st.AccountType)
	r.Fields.Add("enabled", st.Enabled)
	if st.DisabledBy != "" {
		r.Fields.Add("disabled_by", st.DisabledBy)
	}
	r.Fields.Add("locked_out", st.LockedOut)
	if st.LockedPermanently {
		r.Fields.Add("locked_permanently", true)
	}
	if st.LockoutTime != "" {
		r.Fields.Add("lockout_time", st.LockoutTime)
	}
	if st.LockedUntil != "" {
		r.Fields.Add("locked_until", st.LockedUntil)
	}
	if st.LockoutExpired {
		r.Fields.Add("lockout_expired", true)
	}
	r.Fields.Add("must_change_password", st.MustChangePassword)
	r.Fields.Add("password_never_expires", st.PasswordNeverExpires)
	if st.PasswordLastSet != "" {
		r.Fields.Add("password_last_set", st.PasswordLastSet)
	}
	if st.PasswordExpires != "" {
		r.Fields.Add("password_expires", st.PasswordExpires)
	}
	r.Fields.Add("password_expired", st.PasswordExpired)
	r.Fields.Add("account_expires", st.AccountExpires)
	r.Fields.Add("expired", st.Expired)
	if st.LastLogon != "" {
		r.Fields.Add("last_logon", st.LastLogon)
	}
	if st.LastLogonReplicated != "" {
		r.Fields.Add("last_logon_replicated", st.LastLogonReplicated)
	}
	if st.BadPasswordCount != nil {
		r.Fields.Add("bad_password_count", *st.BadPasswordCount)
	}
	if len(st.Policy) > 0 {
		var pf tools.Fields
		for _, k := range sortedKeys(st.Policy) {
			v := st.Policy[k]
			if ann := Annotate(k, v); ann != "" {
				v += " [" + ann + "]"
			}
			pf.Add(k, z.Text(v, k, st.DN))
		}
		r.Fields.Add("policy", pf)
	}
	if len(st.UnsupportedActions) > 0 {
		r.Fields.Add("unsupported_actions", st.UnsupportedActions)
	}
	r.Warnings = append(r.Warnings, st.Warnings...)
	r.Warnings = append(r.Warnings, z.Warnings()...)
	r.Notes = append(r.Notes, st.Notes...)
	state := "enabled"
	if !st.Enabled {
		state = "disabled"
	}
	if st.LockedOut {
		state += ", locked out"
	}
	r.Summary = state
	return r
}

// --- find_accounts ---

func runFindAccounts(ctx context.Context, s *Session, c *Call) *tools.Result {
	status := c.Args.Str("status")
	kind := c.Args.Str("object_kind")
	if kind == "" {
		kind = "users"
	}
	base := cleanDN(c.Args.Str("base_dn"))
	if base != "" {
		if r := checkDN(c.Tool, base); r != nil {
			return r
		}
	}
	limit, offset := c.Args.Int("limit", 50), c.Args.Int("offset", 0)
	countOnly := c.Args.Bool("count_only", false)
	st := serverType(ctx, c.Client)
	var rep *AccountReport
	var err error
	switch status {
	case "locked_out", "disabled", "password_expired":
		kindMap := map[string]string{"locked_out": "locked", "disabled": "disabled", "password_expired": "passwordExpired"}
		rep, err = c.Client.Accounts().Report(ctx, ReportParams{Kind: kindMap[status], BaseDN: base, ObjectKind: kind, Limit: 100000})
	default:
		rep, err = ownAccountQuery(ctx, s, c, st, status, base, kind)
	}
	if err != nil {
		if errors.Is(err, ErrUnsupported) {
			return errf(c.Tool, tools.ErrUnsupportedOnServer, "Use get_account_status for single accounts, or search_ldap with server-specific attributes.", "%s is not supported on this %s server: %s", status, st, strings.TrimSuffix(err.Error(), ": "+ErrUnsupported.Error()))
		}
		return ErrorResult(c.Tool, err, base)
	}
	z := NewSanitizer(false)
	r := newResult(c)
	r.Fields.Add("status", status)
	r.Fields.Add("total", rep.Total)
	if rep.Truncated {
		r.Fields.Add("total_is_lower_bound", true)
	}
	r.Fields.Add("method", rep.Method)
	r.Notes = append(r.Notes, rep.Notes...)
	if len(rep.ExpiredLockouts) > 0 {
		var ex []tools.Fields
		for _, a := range rep.ExpiredLockouts {
			r.DNs = append(r.DNs, a.DN)
			ex = append(ex, tools.Fs("dn", z.DN(a.DN), "login", z.Text(a.Login, "login", a.DN), "detail", a.Detail))
		}
		r.Fields.Add("expired_lockouts", ex)
		r.Note("%d account(s) still carry a lockout time although the lockout has expired (expired_lockouts): they are not locked now. Name them in the answer.", len(rep.ExpiredLockouts))
	}
	if countOnly {
		r.Fields.Add("count_only", true)
		r.Summary = Plural(rep.Total, "account", "accounts")
		return r
	}
	end := min(offset+limit, len(rep.Accounts))
	items := []any{}
	for i := offset; i < end; i++ {
		a := rep.Accounts[i]
		r.DNs = append(r.DNs, a.DN)
		f := tools.Fs("dn", z.DN(a.DN), "login", z.Text(a.Login, "login", a.DN), "name", z.Text(a.Name, "name", a.DN))
		if a.Detail != "" {
			f.Add("detail", a.Detail)
		}
		if a.LockedAt != "" {
			f.Add("locked_at", a.LockedAt)
		}
		switch {
		case a.LockedPermanently:
			f.Add("lockout_ends", "only when an administrator unlocks the account")
		case a.LockedUntil != "":
			f.Add("locked_until", a.LockedUntil)
		}
		items = append(items, f)
	}
	if status == "locked_out" && len(items) > 0 {
		r.Note("locked_until is when a lockout ends by itself; lockout_ends says when only an administrator can end it. Report these values; never assume a lockout duration.")
	}
	r.List = &tools.List{Key: "accounts", Items: items, Offset: offset, More: len(rep.Accounts) > end, Total: rep.Total}
	r.Warnings = append(r.Warnings, z.Warnings()...)
	r.Summary = Plural(rep.Total, "account", "accounts")
	return r
}

// ownAccountQuery implements the states the account delegate does not
// report (§5.2 table).
func ownAccountQuery(ctx context.Context, s *Session, c *Call, st, status, base, kind string) (*AccountReport, error) {
	if base == "" {
		base = baseDN(ctx, c.Client)
	}
	days := c.Args.Int("inactive_days", 90)
	incDisabled := c.Args.Bool("include_disabled", false)
	now := s.now()
	T := TimeToFiletime(now.Add(-time.Duration(days) * 24 * time.Hour))
	TG := now.Add(-time.Duration(days) * 24 * time.Hour).UTC().Format("20060102150405.0Z")
	NOW := TimeToFiletime(now)
	P := userFilter(st, kind)
	D := "(!(userAccountControl:1.2.840.113556.1.4.803:=2))"
	if incDisabled {
		D = ""
	}
	sch := s.Shared.Schema(ctx, c.Client)
	var filter string
	postDisabled := false
	switch st {
	case models.ServerTypeAD:
		switch status {
		case "expired":
			filter = fmt.Sprintf("(&%s(accountExpires>=1)(accountExpires<=%d))", P, NOW)
		case "must_change_password":
			filter = "(&" + P + "(pwdLastSet=0))"
		case "password_never_expires":
			filter = "(&" + P + "(userAccountControl:1.2.840.113556.1.4.803:=65536))"
		case "never_logged_on":
			filter = fmt.Sprintf("(&%s(!(lastLogonTimestamp=*))(whenCreated<=%s)%s)", P, TG, D)
		case "inactive":
			filter = fmt.Sprintf("(&%s(lastLogonTimestamp<=%d)(whenCreated<=%s)%s)", P, T, TG, D)
		}
	case models.ServerTypeOpenLDAP:
		switch status {
		case "must_change_password":
			filter = "(&" + P + "(pwdReset=TRUE))"
		case "never_logged_on", "inactive":
			if sch == nil || sch.Attr("pwdLastSuccess") == nil {
				return nil, fmt.Errorf("the server records no last-logon time (pwdLastSuccess requires the lastbind overlay): %w", ErrUnsupported)
			}
			if status == "never_logged_on" {
				filter = fmt.Sprintf("(&%s(!(pwdLastSuccess=*))(createTimestamp<=%s))", P, TG)
			} else {
				filter = fmt.Sprintf("(&%s(pwdLastSuccess<=%s)(createTimestamp<=%s))", P, TG, TG)
			}
			postDisabled = !incDisabled
		default:
			return nil, fmt.Errorf("%s: %w", status, ErrUnsupported)
		}
	case models.ServerType389DS:
		switch status {
		case "never_logged_on", "inactive":
			if sch == nil || sch.Attr("lastLoginTime") == nil {
				return nil, fmt.Errorf("the server records no last-logon time (lastLoginTime is not in the schema): %w", ErrUnsupported)
			}
			if status == "never_logged_on" {
				filter = fmt.Sprintf("(&%s(!(lastLoginTime=*))(createTimestamp<=%s))", P, TG)
			} else {
				filter = fmt.Sprintf("(&%s(lastLoginTime<=%s)(createTimestamp<=%s))", P, TG, TG)
			}
			postDisabled = !incDisabled
		default:
			return nil, fmt.Errorf("%s: %w", status, ErrUnsupported)
		}
	default:
		return nil, fmt.Errorf("%s: %w", status, ErrUnsupported)
	}
	if filter == "" {
		return nil, fmt.Errorf("%s: %w", status, ErrUnsupported)
	}
	rep := &AccountReport{Method: "filter " + filter}
	attrs := []string{"sAMAccountName", "uid", "cn", "lastLogonTimestamp", "pwdAccountLockedTime", "nsAccountLock"}
	res, err := searchRetry(ctx, c.Client, models.SearchParams{BaseDN: base, Filter: filter, Scope: models.ScopeSub, Attributes: attrs, SizeLimit: 100001})
	if err != nil {
		return nil, err
	}
	rep.Truncated = res.Truncated
	for i := range res.Entries {
		e := &res.Entries[i]
		if postDisabled && (attrValue(e, "pwdAccountLockedTime") == adminLockTime || strings.EqualFold(attrValue(e, "nsAccountLock"), "true")) {
			continue
		}
		login := attrValue(e, "sAMAccountName")
		if login == "" {
			login = attrValue(e, "uid")
		}
		detail := ""
		if v, ok := parseInt64(attrValue(e, "lastLogonTimestamp")); ok && v > 0 {
			detail = "last logon (replicated) " + ftString(v)
		}
		rep.Total++
		rep.Accounts = append(rep.Accounts, ReportItem{DN: e.DN, Login: login, Name: displayName(e, e.DN), Detail: detail})
	}
	if postDisabled {
		rep.Method += ", then excluded disabled accounts"
	}
	if st == models.ServerTypeAD && (status == "inactive" || status == "never_logged_on") {
		rep.Notes = append(rep.Notes, "lastLogonTimestamp can lag up to 14 days; lastLogon is not replicated.")
	}
	return rep, nil
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}
