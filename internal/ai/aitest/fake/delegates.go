package fake

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// In-memory test doubles of the track delegates (§5.4). Production uses
// the membership, account, password and recycle tracks through
// services/ai_backend.go; these only model what the tool tests need:
// direct and nested member/uniqueMember groups, AD userAccountControl
// account states, a password plan per server type and a deleted-objects
// list (Deleted).

func (c *FakeClient) Membership() ldaptools.MembershipResolver { return fakeMembership{c} }
func (c *FakeClient) Accounts() ldaptools.AccountInspector     { return fakeAccounts{c} }
func (c *FakeClient) Planner() ldaptools.AccountPlanner        { return fakeAccounts{c} }
func (c *FakeClient) Passwords() ldaptools.PasswordSetter      { return fakePasswords{c} }
func (c *FakeClient) Recycle() ldaptools.DeletedObjectsReader  { return fakeRecycle{c} }

func first(e *models.LDAPEntry, name string) string {
	if v := attrVals(e, name); len(v) > 0 {
		return v[0]
	}
	return ""
}

func hasClassFold(e *models.LDAPEntry, classes ...string) bool {
	for _, v := range attrVals(e, "objectClass") {
		for _, c := range classes {
			if strings.EqualFold(v, c) {
				return true
			}
		}
	}
	return false
}

func kindOf(e *models.LDAPEntry) string {
	switch {
	case e == nil:
		return "other"
	case hasClassFold(e, "computer"):
		return "computer"
	case hasClassFold(e, "group", "groupOfNames", "groupOfUniqueNames", "posixGroup"):
		return "group"
	case hasClassFold(e, "contact"):
		return "contact"
	case hasClassFold(e, "user", "inetOrgPerson", "person", "posixAccount"):
		return "user"
	}
	return "other"
}

func rdnVal(dn string) string {
	r, _, _ := strings.Cut(dn, ",")
	_, v, _ := strings.Cut(r, "=")
	return v
}

// --- membership ---

type fakeMembership struct{ c *FakeClient }

func memberAttrValues(e *models.LDAPEntry) []string {
	return append(append([]string{}, attrVals(e, "member")...), attrVals(e, "uniqueMember")...)
}

func (m fakeMembership) Members(ctx context.Context, groupDN string, transitive bool) (*ldaptools.Membership, error) {
	g := m.c.Get(groupDN)
	if g == nil {
		return nil, noSuchObject(groupDN)
	}
	if kindOf(g) != "group" {
		return nil, ldaptools.ErrNotApplicable
	}
	out := &ldaptools.Membership{DN: groupDN, Method: "fake"}
	type item struct {
		dn  string
		via []string
	}
	seen := map[string]bool{strings.ToLower(groupDN): true}
	queue := []item{}
	for _, v := range memberAttrValues(g) {
		queue = append(queue, item{dn: v})
	}
	for len(queue) > 0 {
		it := queue[0]
		queue = queue[1:]
		key := strings.ToLower(it.dn)
		if seen[key] {
			if strings.EqualFold(it.dn, groupDN) {
				out.Cycles = append(out.Cycles, append(append([]string{groupDN}, it.via...), groupDN))
			}
			continue
		}
		seen[key] = true
		e := m.c.Get(it.dn)
		mi := ldaptools.MemberItem{DN: it.dn, Name: rdnVal(it.dn), Type: kindOf(e), Depth: len(it.via) + 1, Via: it.via, Unresolved: e == nil}
		out.Items = append(out.Items, mi)
		if transitive && e != nil && mi.Type == "group" {
			for _, v := range memberAttrValues(e) {
				queue = append(queue, item{dn: v, via: append(append([]string{}, it.via...), it.dn)})
			}
		}
	}
	return out, nil
}

func (m fakeMembership) MemberOf(ctx context.Context, dn string, transitive bool) (*ldaptools.Membership, error) {
	out := &ldaptools.Membership{DN: dn, Method: "fake"}
	m.c.mu.Lock()
	var groups []*models.LDAPEntry
	for _, k := range m.c.order {
		if e := m.c.entries[k]; e != nil && kindOf(e) == "group" {
			groups = append(groups, e)
		}
	}
	m.c.mu.Unlock()
	frontier := []string{dn}
	via := map[string][]string{strings.ToLower(dn): nil}
	for depth := 1; len(frontier) > 0 && depth <= 32; depth++ {
		var next []string
		for _, child := range frontier {
			for _, g := range groups {
				if _, done := via[strings.ToLower(g.DN)]; done {
					continue
				}
				for _, v := range memberAttrValues(g) {
					if strings.EqualFold(v, child) {
						path := append(append([]string{}, via[strings.ToLower(child)]...), child)[1:]
						via[strings.ToLower(g.DN)] = append(append([]string{}, via[strings.ToLower(child)]...), child)
						out.Items = append(out.Items, ldaptools.MemberItem{DN: g.DN, Name: rdnVal(g.DN), Type: "group", Depth: depth, Via: path})
						next = append(next, g.DN)
						break
					}
				}
			}
		}
		if !transitive {
			break
		}
		frontier = next
	}
	return out, nil
}

func (m fakeMembership) GroupInfo(ctx context.Context, groupDN string) (*ldaptools.GroupInfo, error) {
	g := m.c.Get(groupDN)
	if g == nil {
		return nil, noSuchObject(groupDN)
	}
	if kindOf(g) != "group" {
		return nil, ldaptools.ErrNotApplicable
	}
	attr := "member"
	switch {
	case hasClassFold(g, "groupOfUniqueNames"):
		attr = "uniqueMember"
	case hasClassFold(g, "posixGroup") && !hasClassFold(g, "groupOfNames"):
		attr = "memberUid"
	}
	info := &ldaptools.GroupInfo{DN: groupDN, ObjectClass: attrVals(g, "objectClass"), MemberAttrs: []string{attr}, Values: map[string][]string{},
		POSIX: hasClassFold(g, "posixGroup")}
	for _, a := range []string{"member", "uniqueMember", "memberUid"} {
		if v := attrVals(g, a); len(v) > 0 {
			info.Values[strings.ToLower(a)] = v
		}
	}
	info.MemberUIDs = info.POSIX && attr != "memberUid" && len(info.Values["memberuid"]) > 0
	info.PrimaryToken, _ = strconv.Atoi(first(g, "primaryGroupToken"))
	return info, nil
}

func (m fakeMembership) MemberValues(ctx context.Context, g *ldaptools.GroupInfo, op, member string) ([]ldaptools.MemberValue, error) {
	attr := g.MemberAttrs[0]
	if strings.EqualFold(attr, "memberUid") {
		e := m.c.Get(member)
		if e == nil || first(e, "uid") == "" {
			return nil, fmt.Errorf("%s has no uid", member)
		}
		return []ldaptools.MemberValue{{Attr: attr, Value: first(e, "uid")}}, nil
	}
	out := []ldaptools.MemberValue{{Attr: attr, Value: member}}
	if g.POSIX && (op == models.ChangeDelete || g.MemberUIDs) {
		if e := m.c.Get(member); e != nil && first(e, "uid") != "" {
			out = append(out, ldaptools.MemberValue{Attr: "memberUid", Value: first(e, "uid")})
		}
	}
	return out, nil
}

// --- accounts (AD userAccountControl only) ---

type fakeAccounts struct{ c *FakeClient }

func (a fakeAccounts) Status(ctx context.Context, dn string) (*ldaptools.AccountStatus, error) {
	e := a.c.Get(dn)
	if e == nil {
		return nil, noSuchObject(dn)
	}
	st := &ldaptools.AccountStatus{DN: dn, ServerType: a.c.SI.ServerType}
	k := kindOf(e)
	if k != "user" && k != "computer" {
		st.Reason = "not an account"
		return st, nil
	}
	st.Applicable, st.AccountType = true, k
	uac, _ := strconv.ParseInt(first(e, "userAccountControl"), 10, 64)
	st.Enabled = uac&2 == 0
	st.PasswordNeverExpires = uac&0x10000 != 0
	lt := first(e, "lockoutTime")
	st.LockedOut = lt != "" && lt != "0"
	if st.LockedOut {
		// fakeLockedUntil (test data only): an RFC 3339 end, or "permanent".
		st.LockoutTime = lt
		if u := first(e, "fakeLockedUntil"); u == "permanent" {
			st.LockedPermanently = true
		} else {
			st.LockedUntil = u
		}
	}
	st.MustChangePassword = first(e, "pwdLastSet") == "0"
	return st, nil
}

func (a fakeAccounts) Report(ctx context.Context, p ldaptools.ReportParams) (*ldaptools.AccountReport, error) {
	rep := &ldaptools.AccountReport{Method: "fake"}
	a.c.mu.Lock()
	keys := append([]string(nil), a.c.order...)
	a.c.mu.Unlock()
	for _, k := range keys {
		e := a.c.Get(k)
		if e == nil {
			continue
		}
		st, _ := a.Status(ctx, e.DN)
		if st == nil || !st.Applicable {
			continue
		}
		hit := false
		switch p.Kind {
		case "locked":
			hit = st.LockedOut
		case "disabled":
			hit = !st.Enabled
		case "passwordExpired":
			hit = st.PasswordExpired
		}
		if hit {
			it := ldaptools.ReportItem{DN: e.DN, Login: first(e, "sAMAccountName"), Name: rdnVal(e.DN)}
			if p.Kind == "locked" {
				it.LockedAt, it.LockedUntil, it.LockedPermanently = st.LockoutTime, st.LockedUntil, st.LockedPermanently
			}
			rep.Accounts = append(rep.Accounts, it)
		}
	}
	rep.Total = len(rep.Accounts)
	return rep, nil
}

func (a fakeAccounts) Plan(ctx context.Context, dn, action string) (*ldaptools.AccountPlan, error) {
	e := a.c.Get(dn)
	if e == nil {
		return nil, noSuchObject(dn)
	}
	if k := kindOf(e); k != "user" && k != "computer" {
		return nil, fmt.Errorf("%s is not an account: %w", dn, ldaptools.ErrNotApplicable)
	}
	raw := first(e, "userAccountControl")
	uac, _ := strconv.ParseInt(raw, 10, 64)
	plan := &ldaptools.AccountPlan{DN: dn, Action: action, Before: map[string][]string{"userAccountControl": {raw}}}
	switch action {
	case ldaptools.ActionEnable, ldaptools.ActionDisable:
		nv := uac &^ 2
		if action == ldaptools.ActionDisable {
			nv = uac | 2
		}
		if nv == uac {
			plan.NoOp, plan.Reason = true, "The account is already "+map[string]string{ldaptools.ActionEnable: "enabled", ldaptools.ActionDisable: "disabled"}[action]+"."
			return plan, nil
		}
		plan.Changes = []models.AttributeChange{{Operation: models.ChangeDelete, Attribute: "userAccountControl", Values: []string{raw}},
			{Operation: models.ChangeAdd, Attribute: "userAccountControl", Values: []string{strconv.FormatInt(nv, 10)}}}
	case ldaptools.ActionUnlock:
		lt := first(e, "lockoutTime")
		plan.Before = map[string][]string{"lockoutTime": {lt}}
		if lt == "" || lt == "0" {
			plan.NoOp, plan.Reason = true, "The account is not locked out."
			return plan, nil
		}
		plan.Changes = []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "lockoutTime", Values: []string{"0"}}}
		if ft := first(e, "pwdFailureTime"); ft != "" {
			// Like an OpenLDAP ppolicy unlock: the recorded failures go too.
			plan.Before["pwdFailureTime"] = []string{ft}
			plan.Changes = append(plan.Changes, models.AttributeChange{Operation: models.ChangeDelete, Attribute: "pwdFailureTime"})
		}
	case ldaptools.ActionMustChange, ldaptools.ActionClearMustChange:
		v := map[string]string{ldaptools.ActionMustChange: "0", ldaptools.ActionClearMustChange: "-1"}[action]
		plan.Before = map[string][]string{"pwdLastSet": {first(e, "pwdLastSet")}}
		plan.Changes = []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "pwdLastSet", Values: []string{v}}}
	default:
		return nil, errors.New("unknown action")
	}
	return plan, nil
}

func (a fakeAccounts) Apply(ctx context.Context, plan *ldaptools.AccountPlan) ([]models.AttributeChange, error) {
	sent := plan.Changes
	if a.c.AccountApplyHook != nil {
		sent = a.c.AccountApplyHook(plan.Changes)
	}
	return sent, a.c.Modify(ctx, plan.DN, sent, "")
}

// --- passwords ---

type fakePasswords struct{ c *FakeClient }

// Plan: AD needs TLS (unicodePwd), other servers use Password Modify when
// announced, else a client-side {SSHA} userPassword.
func (p fakePasswords) Plan(ctx context.Context, dn string, mustChange bool) (*ldaptools.PasswordPlan, error) {
	plan := &ldaptools.PasswordPlan{DN: dn, MustChange: mustChange, Storage: &ai.PasswordPreview{Notes: []string{}}}
	switch {
	case p.c.SI.ServerType == models.ServerTypeAD:
		if !p.c.Info().TLS() {
			return nil, fmt.Errorf("Active Directory accepts password resets only over an encrypted connection: %w", ldaptools.ErrUnsupported)
		}
		plan.Method = ldaptools.PasswordAD
		plan.LDIF = "dn: " + dn + "\nchangetype: modify\nreplace: unicodePwd\nunicodePwd:: " + ldaptools.PasswordPlaceholder + "\n-\n"
	case ldaptools.HasControl(p.c.SI, "1.3.6.1.4.1.4203.1.11.1"):
		plan.Method = ldaptools.PasswordRFC3062
		plan.LDIF = "# Password Modify extended operation (value generated locally after approval)\n"
	default:
		plan.Method, plan.Scheme = ldaptools.PasswordUserPassword, "SSHA"
		plan.Storage.SchemeLabel = "{SSHA}"
		plan.LDIF = "dn: " + dn + "\nchangetype: modify\nreplace: userPassword\nuserPassword: {SSHA}" + ldaptools.PasswordPlaceholder + "\n-\n"
	}
	plan.Storage.Method = plan.Method
	plan.Storage.MustChange = mustChange
	if !p.c.Info().TLS() && plan.Method != ldaptools.PasswordUserPassword {
		plan.AllowUnencrypted = true
		plan.Storage.Unencrypted, plan.Storage.CleartextOnWire = true, true
	}
	return plan, nil
}

func (p fakePasswords) Apply(ctx context.Context, plan *ldaptools.PasswordPlan, value string) (*ldaptools.PasswordOutcome, error) {
	out := &ldaptools.PasswordOutcome{}
	switch plan.Method {
	case ldaptools.PasswordAD:
		ch := []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "unicodePwd", Values: []string{value}}}
		if plan.MustChange {
			ch = append(ch, models.AttributeChange{Operation: models.ChangeReplace, Attribute: "pwdLastSet", Values: []string{"0"}})
		}
		return out, p.c.Modify(ctx, plan.DN, ch, "")
	case ldaptools.PasswordRFC3062:
		return out, p.c.PasswordModify(ctx, plan.DN, value)
	}
	out.StoredSchemeLabel = "{SSHA}"
	return out, p.c.Modify(ctx, plan.DN, []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "userPassword", Values: []string{"{SSHA}hashed"}}}, "")
}

// --- deleted objects ---

type fakeRecycle struct{ c *FakeClient }

func (r fakeRecycle) List(ctx context.Context, nc, text string, limit int) (*models.DeletedObjectsList, error) {
	if r.c.SI.ServerType != models.ServerTypeAD {
		return nil, ldaptools.ErrUnsupported
	}
	out := &models.DeletedObjectsList{ContainerDN: "CN=Deleted Objects," + r.c.SI.DefaultNamingContext, Objects: []models.DeletedObject{}, Limit: limit}
	for _, o := range r.c.Deleted {
		if text == "" || strings.Contains(strings.ToLower(o.Name), strings.ToLower(text)) {
			if len(out.Objects) == limit {
				out.Truncated = true
				break
			}
			out.Objects = append(out.Objects, o)
		}
	}
	return out, nil
}

func (r fakeRecycle) Info(ctx context.Context) (*models.RecycleBinInfo, error) {
	return &models.RecycleBinInfo{Supported: r.c.SI.ServerType == models.ServerTypeAD, RecycleBinKnown: true, RecycleBinEnabled: true}, nil
}

// noSuchObject is the LDAP error the real delegates return for a missing DN.
func noSuchObject(dn string) error {
	return &goldap.Error{ResultCode: goldap.LDAPResultNoSuchObject, Err: fmt.Errorf("no such object %s", dn)}
}
