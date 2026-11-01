package ldap

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// Account reports search candidates with a server side filter that is a
// superset of the result and keep the entries whose computed account status
// matches (computeADStatus & co.), so e.g. lockouts older than the effective
// lockout duration are not reported as locked. Filters are only narrowed by
// policy values when every policy that can apply is known: a bind that
// cannot read some PSOs (e.g. a delegated helpdesk account) must not lose
// accounts those PSOs govern.

const defaultAccountReportLimit = 5000

// reportSpec describes one report on one server type.
type reportSpec struct {
	filter  string
	columns []string
	match   func(st *models.AccountStatus) bool
	// requireAny, when set, is a filter that at least one entry below the
	// base must match for the report to be meaningful (e.g. "the server
	// records logon times"); requireMsg is the error otherwise.
	requireAny string
	requireMsg string
}

// AccountReport runs an account report (models.AccountReport*) below
// params.BaseDN. With params.DNs only those entries are read again (report
// rows after an account action) and returned whether they still match or
// not (Matches). Entries come with their computed account status
// (Statuses, same order). The group reports (emptyGroups,
// privilegedMembers) are in account_groupreport.go; their re-read returns
// the entries' current attributes only (no computed columns, Matches true).
func (c *Client) AccountReport(params models.AccountReportParams) (*models.AccountReportResult, error) {
	switch params.Report {
	case models.AccountReportEmptyGroups, models.AccountReportPrivilegedMembers:
		if len(params.DNs) > 0 {
			return c.rereadGroupReportRows(params)
		}
		if params.Report == models.AccountReportEmptyGroups {
			return c.emptyGroupsReport(params)
		}
		return c.privilegedMembersReport(params)
	}
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	base, err := c.accountReportBase(params, info)
	if err != nil {
		return nil, err
	}
	limit := params.SizeLimit
	if limit <= 0 {
		limit = defaultAccountReportLimit
	}
	if params.Report == models.AccountReportPasswordExpiring && (params.Days <= 0 || params.Days > 3650) {
		return nil, errors.New("days must be between 1 and 3650")
	}
	now := time.Now().UTC()
	// The policies of the shared cache (a re-read of report rows after an
	// account action needs no policy read); new ones are shared afterwards.
	pr := c.beginPolicyRead(now, policyCacheTTL)
	defer pr.finish()
	cache := pr.cache
	rd := c.accountReader()

	var spec reportSpec
	var attrs []string
	var status func(e *goldap.Entry, a accountAttrs) *models.AccountStatus
	var notes []string
	// Names of PSOs that apply to checked accounts but cannot be read.
	unreadable := map[string]bool{}

	switch info.ServerType {
	case models.ServerTypeAD:
		set := rd.adAllPolicies(base, cache)
		for _, p := range set.policies {
			if !p.Readable && p.Source == models.PolicySourcePSO {
				unreadable[p.Name] = true
			}
		}
		spec, notes, err = adReportSpecFor(params, set, now)
		attrs = append([]string{"cn", "displayName", "sAMAccountName", "userPrincipalName", "mail", "description", "whenChanged"}, adAccountAttrs...)
		status = func(e *goldap.Entry, a accountAttrs) *models.AccountStatus {
			st := newAccountStatus(e.DN, models.ServerTypeAD, now)
			kind, ok := adAccountKind(a.all("objectClass"))
			if !ok {
				return st
			}
			pol, _ := rd.adPolicy(e.DN, a.first("msDS-ResultantPSO"), cache)
			if pol != nil && !pol.Readable && pol.Source == models.PolicySourcePSO {
				unreadable[pol.Name] = true
			}
			computeADStatus(st, kind, a, pol, now)
			return st
		}
	case models.ServerTypeOpenLDAP:
		spec, err = ppolicyReportSpec(params, now)
		attrs = append([]string{"cn", "uid", "mail", "displayName", "description"}, ppolicyAccountAttrs...)
		status = func(e *goldap.Entry, a accountAttrs) *models.AccountStatus {
			st := newAccountStatus(e.DN, models.ServerTypeOpenLDAP, now)
			pol, _ := rd.ppolicyPolicy(e.DN, a.first("pwdPolicySubentry"), info, cache)
			computePPolicyStatus(st, a, pol, now)
			return st
		}
	case models.ServerType389DS:
		spec, err = dsReportSpec(params, now)
		attrs = append([]string{"cn", "uid", "mail", "displayName", "description"}, dsAccountAttrs...)
		status = func(e *goldap.Entry, a accountAttrs) *models.AccountStatus {
			st := newAccountStatus(e.DN, models.ServerType389DS, now)
			pol, _ := rd.dsPolicy(a.first("pwdpolicysubentry"), cache)
			compute389Status(st, a, pol, now)
			return st
		}
	default:
		return nil, errors.New("account reports are available for Active Directory, OpenLDAP and 389 Directory Server")
	}
	if err != nil {
		return nil, err
	}
	if len(params.DNs) > 0 {
		return c.rereadAccountReportRows(params.DNs, attrs, spec, status)
	}
	if spec.requireAny != "" {
		probe := goldap.NewSearchRequest(base, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
			1, 0, false, spec.requireAny, []string{"1.1"}, nil)
		found, err := c.SearchWithControls(probe, 0)
		if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
			return nil, err
		}
		if len(found) == 0 {
			return nil, &ReportUnavailableError{Reason: spec.requireMsg}
		}
	}

	req := goldap.NewSearchRequest(base, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
		0, 0, false, spec.filter, attrs, nil)
	entries, err := c.SearchWithControls(req, uint32(c.pageSize()))
	truncated := false
	if err != nil {
		if !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
			return nil, err
		}
		truncated = true
		notes = append(notes, "The server's size limit was reached; only part of the directory was checked.")
	}

	result := &models.AccountReportResult{
		Entries:    []models.LDAPEntry{},
		Candidates: len(entries),
		Columns:    spec.columns,
		Notes:      notes,
		Statuses:   []models.AccountStatus{},
		Extra:      []map[string]string{},
	}
	for _, e := range entries {
		st := status(e, newAccountAttrs(e))
		if !st.Applicable || !spec.match(st) {
			continue
		}
		if len(result.Entries) >= limit {
			truncated = true
			break
		}
		result.Entries = append(result.Entries, *convertEntry(e))
		result.Statuses = append(result.Statuses, *st)
	}
	if note := unreadablePSONote(params.Report, unreadable); note != "" {
		result.Notes = append(result.Notes, note)
	}
	result.TotalCount = len(result.Entries)
	result.Truncated = truncated
	return result, nil
}

// ReportUnavailableError is returned when a report cannot work on the
// server's configuration (e.g. no logon times are recorded); Reason says
// what to enable. The UI shows it as a hint, not as a failure.
type ReportUnavailableError struct{ Reason string }

func (e *ReportUnavailableError) Error() string { return e.Reason }

// accountReportBase returns the base DN of a report: params.BaseDN, the
// profile base DN, the default naming context or the first naming context.
func (c *Client) accountReportBase(params models.AccountReportParams, info *models.ServerInfo) (string, error) {
	base := strings.TrimSpace(params.BaseDN)
	if base == "" {
		base = c.Profile().BaseDN
	}
	if base == "" {
		base = info.DefaultNamingContext
	}
	if base == "" && len(info.NamingContexts) > 0 {
		base = info.NamingContexts[0]
	}
	if base == "" {
		return "", errors.New("no base DN for the report")
	}
	return base, nil
}

// rereadAccountReportRows reads dns (base scope) with the report's
// attributes and returns them with their status and whether they still
// match spec. Entries that no longer exist are left out.
func (c *Client) rereadAccountReportRows(dns []string, attrs []string, spec reportSpec,
	status func(e *goldap.Entry, a accountAttrs) *models.AccountStatus) (*models.AccountReportResult, error) {
	result := &models.AccountReportResult{
		Entries:  []models.LDAPEntry{},
		Columns:  spec.columns,
		Notes:    []string{},
		Statuses: []models.AccountStatus{},
		Extra:    []map[string]string{},
		Matches:  []bool{},
	}
	for _, dn := range dns {
		req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases,
			0, 0, false, "(objectClass=*)", attrs, nil)
		entries, err := c.SearchWithControls(req, 0)
		if err != nil {
			if goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject) {
				continue
			}
			return nil, err
		}
		for _, e := range entries {
			st := status(e, newAccountAttrs(e))
			result.Entries = append(result.Entries, *convertEntry(e))
			result.Statuses = append(result.Statuses, *st)
			result.Matches = append(result.Matches, st.Applicable && spec.match(st))
		}
	}
	result.Candidates = len(result.Entries)
	result.TotalCount = len(result.Entries)
	return result, nil
}

// AccountReportAvailability tells which reports cannot run on the server
// (wrong server type, no logon tracking). The logon tracking probe is one
// search with size limit 1.
func (c *Client) AccountReportAvailability(baseDN string) (*models.ReportAvailability, error) {
	info, err := c.ServerInfo()
	if err != nil {
		return nil, err
	}
	out := &models.ReportAvailability{ServerType: info.ServerType, Unavailable: map[string]string{}}
	switch info.ServerType {
	case models.ServerTypeAD, models.ServerTypeOpenLDAP, models.ServerType389DS:
	default:
		reason := "Account reports are available for Active Directory, OpenLDAP and 389 Directory Server."
		for _, k := range []string{models.AccountReportLocked, models.AccountReportDisabled, models.AccountReportPasswordExpiring,
			models.AccountReportPasswordExpired, models.AccountReportNeverLoggedOn} {
			out.Unavailable[k] = reason
		}
	}
	if info.ServerType != models.ServerTypeAD {
		out.Unavailable[models.AccountReportPrivilegedMembers] = "Active Directory only"
	}
	var spec reportSpec
	switch info.ServerType {
	case models.ServerTypeOpenLDAP:
		spec, _ = ppolicyReportSpec(models.AccountReportParams{Report: models.AccountReportNeverLoggedOn}, time.Now())
	case models.ServerType389DS:
		spec, _ = dsReportSpec(models.AccountReportParams{Report: models.AccountReportNeverLoggedOn}, time.Now())
	}
	if spec.requireAny != "" {
		base, err := c.accountReportBase(models.AccountReportParams{BaseDN: baseDN}, info)
		if err == nil {
			probe := goldap.NewSearchRequest(base, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
				1, 0, false, spec.requireAny, []string{"1.1"}, nil)
			found, err := c.accountReader().search(probe)
			if (err == nil || goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded)) && len(found) == 0 {
				out.Unavailable[models.AccountReportNeverLoggedOn] = spec.requireMsg
			}
		}
	}
	return out, nil
}

// unreadablePSONote explains, for the lockout and password reports, that
// some PSOs could not be read, so the DC's computed values decide for the
// accounts they govern.
func unreadablePSONote(report string, unreadable map[string]bool) string {
	switch report {
	case models.AccountReportLocked, models.AccountReportPasswordExpiring, models.AccountReportPasswordExpired:
	default:
		return ""
	}
	if len(unreadable) == 0 {
		return ""
	}
	names := make([]string, 0, len(unreadable))
	for n := range unreadable {
		names = append(names, n)
	}
	sort.Strings(names)
	return "Password settings objects not readable with this connection: " + strings.Join(names, ", ") +
		". Lockout and password expiry of the accounts they govern come from the domain controller's computed values (msDS-User-Account-Control-Computed, msDS-UserPasswordExpiryTimeComputed); lockout end times may be missing."
}

// passwordExpiresWithin reports whether the (not yet expired) password of st
// expires before now+days.
func passwordExpiresWithin(st *models.AccountStatus, now time.Time, days int) bool {
	if st.PasswordExpired || st.PasswordNeverExpires || st.MustChangePassword || st.PasswordExpires == "" || !st.Enabled {
		return false
	}
	t, err := time.Parse(time.RFC3339, st.PasswordExpires)
	if err != nil {
		return false
	}
	return t.After(now) && !t.After(now.Add(time.Duration(days)*24*time.Hour))
}

func passwordExpiredMatch(st *models.AccountStatus) bool {
	return st.PasswordExpired && !st.MustChangePassword && st.Enabled
}

// neverLoggedOnMatch: no logon time is recorded for the account.
func neverLoggedOnMatch(st *models.AccountStatus) bool {
	return st.LastLogon == "" && st.LastLogonReplicated == "" && (!st.HasLogonCount || st.LogonCount == 0)
}

func unknownReport(report string) error {
	return fmt.Errorf("unknown account report %q", report)
}

// adPolicySet is what an AD report knows about the password policies of a
// domain.
type adPolicySet struct {
	// policies are the domain policy and the PSOs found (unreadable ones
	// with Readable false).
	policies []*models.AccountPolicy
	// complete is true when every PSO of the domain is known and readable
	// together with the domain policy, so bounds derived from the policies
	// hold for every account.
	complete bool
}

// adReportSpecFor builds the AD report for the policies in set.
//
// The locked report checks every account with a lockoutTime and lets the
// DC's computed LOCKOUT bit decide (computeADStatus); narrowing the filter
// with the lockout durations would silently drop accounts governed by a PSO
// the bind cannot read. The password reports bound pwdLastSet with the
// shortest maximum password age only when set is complete; otherwise every
// enabled account with an expiring password is checked.
func adReportSpecFor(params models.AccountReportParams, set adPolicySet, now time.Time) (reportSpec, []string, error) {
	var notes []string
	shortestMaxAge := int64(0)
	var names []string
	for _, p := range set.policies {
		if !p.Readable {
			continue
		}
		names = append(names, p.Name)
		if p.MaxPasswordAgeSeconds > 0 && (shortestMaxAge == 0 || p.MaxPasswordAgeSeconds < shortestMaxAge) {
			shortestMaxAge = p.MaxPasswordAgeSeconds
		}
	}
	if len(names) > 0 {
		notes = append(notes, "Policies considered: "+strings.Join(names, ", ")+".")
	}
	if !set.complete {
		shortestMaxAge = 0
	}

	const users = "(objectCategory=person)(objectClass=user)"
	const enabledExpiring = "(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(userAccountControl:1.2.840.113556.1.4.803:=65536))(pwdLastSet>=1)"
	switch params.Report {
	case models.AccountReportLocked:
		return reportSpec{
			filter:  "(&(objectClass=user)(lockoutTime>=1))",
			columns: []string{"cn", "sAMAccountName", "lockoutTime", "badPwdCount", "msDS-ResultantPSO"},
			match:   func(st *models.AccountStatus) bool { return st.Locked },
		}, notes, nil
	case models.AccountReportDisabled:
		// objectClass=user also matches computers and (g)MSAs (subclasses of
		// user); the kind is shown in the Type column.
		return reportSpec{
			filter:  "(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=2))",
			columns: []string{"cn", "sAMAccountName", "description", "whenChanged"},
			match:   func(st *models.AccountStatus) bool { return !st.Enabled },
		}, notes, nil
	case models.AccountReportPasswordExpiring:
		bound := ""
		if shortestMaxAge > 0 {
			latest := now.Add(time.Duration(params.Days)*24*time.Hour - time.Duration(shortestMaxAge)*time.Second)
			bound = "(pwdLastSet<=" + strconv.FormatInt(timeToFileTime(latest), 10) + ")"
		}
		days := params.Days
		return reportSpec{
			filter:  "(&" + users + enabledExpiring + bound + ")",
			columns: []string{"cn", "sAMAccountName", "mail", "pwdLastSet", "msDS-UserPasswordExpiryTimeComputed"},
			match:   func(st *models.AccountStatus) bool { return passwordExpiresWithin(st, now, days) },
		}, notes, nil
	case models.AccountReportPasswordExpired:
		bound := ""
		if shortestMaxAge > 0 {
			bound = "(pwdLastSet<=" + strconv.FormatInt(timeToFileTime(now.Add(-time.Duration(shortestMaxAge)*time.Second)), 10) + ")"
		}
		return reportSpec{
			filter:  "(&" + users + enabledExpiring + bound + ")",
			columns: []string{"cn", "sAMAccountName", "mail", "pwdLastSet", "msDS-UserPasswordExpiryTimeComputed"},
			match:   passwordExpiredMatch,
		}, notes, nil
	case models.AccountReportNeverLoggedOn:
		notes = append(notes, "lastLogonTimestamp is replicated; lastLogon and logonCount are only known to the connected domain controller.")
		return reportSpec{
			filter:  "(&" + users + "(!(lastLogonTimestamp=*)))",
			columns: []string{"cn", "sAMAccountName", "whenCreated", "pwdLastSet", "description"},
			match:   neverLoggedOnMatch,
		}, notes, nil
	}
	return reportSpec{}, nil, unknownReport(params.Report)
}

// adAllPolicies returns the domain policy of base and the PSOs of the domain.
//
// The PSOs are listed with (objectClass=*), which also returns PSOs whose
// attributes the bind cannot read; those get Readable false. The set is
// complete only when the domain policy and at least one PSO are readable
// and no listed PSO is unreadable, or when the domain has no Password
// Settings Container: an empty listing can also mean that the bind may not
// list PSOs (the AD default for non-admins).
func (r *accountReader) adAllPolicies(base string, cache policyCache) adPolicySet {
	domainDN := adDomainDN(base)
	if domainDN == "" {
		return adPolicySet{}
	}
	var set adPolicySet
	domain, _ := r.adPolicy(domainDN, "", cache)
	if domain != nil {
		set.policies = append(set.policies, domain)
	}
	domainKnown := domain != nil && domain.Readable
	req := goldap.NewSearchRequest("CN=Password Settings Container,CN=System,"+domainDN, goldap.ScopeSingleLevel,
		goldap.NeverDerefAliases, 0, 0, false, "(objectClass=*)", append([]string{"objectClass"}, adPSOAttrs...), nil)
	entries, err := r.search(req)
	if err != nil {
		// Without the container (domain functional level below 2008) no
		// PSO can exist.
		set.complete = domainKnown && goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject)
		return set
	}
	psos, allReadable := 0, true
	for _, e := range entries {
		a := newAccountAttrs(e)
		if a.has("objectClass") && !a.hasValue("objectClass", "msDS-PasswordSettings") {
			continue
		}
		pol := &models.AccountPolicy{DN: e.DN, Name: rdnValue(e.DN), Source: models.PolicySourcePSO}
		if a.has("msDS-LockoutThreshold") {
			fillADPolicy(pol, a, "msDS-LockoutDuration", "msDS-LockoutThreshold", "msDS-LockoutObservationWindow",
				"msDS-MaximumPasswordAge", "msDS-MinimumPasswordAge", "msDS-MinimumPasswordLength", "msDS-PasswordHistoryLength")
			fillADComplexity(pol, a, true)
		} else {
			allReadable = false
		}
		cache[strings.ToLower(e.DN)] = pol
		set.policies = append(set.policies, pol)
		psos++
	}
	set.complete = domainKnown && psos > 0 && allReadable
	return set
}

// ppolicyReportSpec builds the OpenLDAP report.
func ppolicyReportSpec(params models.AccountReportParams, now time.Time) (reportSpec, error) {
	const people = "(|(objectClass=person)(objectClass=posixAccount)(objectClass=account)(objectClass=simpleSecurityObject))"
	switch params.Report {
	case models.AccountReportLocked:
		return reportSpec{
			filter:  "(&" + people + "(pwdAccountLockedTime=*))",
			columns: []string{"uid", "cn", "pwdAccountLockedTime", "pwdFailureTime"},
			match:   func(st *models.AccountStatus) bool { return st.Locked },
		}, nil
	case models.AccountReportDisabled:
		return reportSpec{
			filter:  "(&" + people + "(pwdAccountLockedTime=" + ppolicyPermanentLock + "))",
			columns: []string{"uid", "cn", "pwdAccountLockedTime", "description"},
			match:   func(st *models.AccountStatus) bool { return !st.Enabled },
		}, nil
	case models.AccountReportPasswordExpiring:
		days := params.Days
		return reportSpec{
			filter:  "(&" + people + "(pwdChangedTime=*))",
			columns: []string{"uid", "cn", "mail", "pwdChangedTime"},
			match:   func(st *models.AccountStatus) bool { return passwordExpiresWithin(st, now, days) },
		}, nil
	case models.AccountReportPasswordExpired:
		return reportSpec{
			filter:  "(&" + people + "(pwdChangedTime=*))",
			columns: []string{"uid", "cn", "mail", "pwdChangedTime"},
			match:   passwordExpiredMatch,
		}, nil
	case models.AccountReportNeverLoggedOn:
		return reportSpec{
			filter:     "(&" + people + "(!(pwdLastSuccess=*))(!(authTimestamp=*)))",
			columns:    []string{"uid", "cn", "mail", "createTimestamp"},
			match:      neverLoggedOnMatch,
			requireAny: "(|(pwdLastSuccess=*)(authTimestamp=*))",
			requireMsg: "This OpenLDAP server does not record logon times (no entry has pwdLastSuccess or authTimestamp); enable the lastbind overlay (2.4) or olcLastBind (2.5+) to use this report.",
		}, nil
	}
	return reportSpec{}, unknownReport(params.Report)
}

// dsReportSpec builds the 389DS report.
func dsReportSpec(params models.AccountReportParams, now time.Time) (reportSpec, error) {
	switch params.Report {
	case models.AccountReportLocked:
		return reportSpec{
			filter:  "(accountUnlockTime=*)",
			columns: []string{"uid", "cn", "passwordRetryCount", "accountUnlockTime"},
			match:   func(st *models.AccountStatus) bool { return st.Locked },
		}, nil
	case models.AccountReportDisabled:
		return reportSpec{
			filter:  "(|(nsAccountLock=true)(nsRoleDN=*))",
			columns: []string{"uid", "cn", "nsAccountLock", "nsRoleDN"},
			match:   func(st *models.AccountStatus) bool { return !st.Enabled },
		}, nil
	case models.AccountReportPasswordExpiring:
		days := params.Days
		return reportSpec{
			filter:  "(&(passwordExpirationTime=*)(!(passwordExpirationTime=" + generalizedTimeZero + ")))",
			columns: []string{"uid", "cn", "mail", "passwordExpirationTime"},
			match:   func(st *models.AccountStatus) bool { return passwordExpiresWithin(st, now, days) },
		}, nil
	case models.AccountReportPasswordExpired:
		return reportSpec{
			filter:  "(&(passwordExpirationTime=*)(!(passwordExpirationTime=" + generalizedTimeZero + ")))",
			columns: []string{"uid", "cn", "mail", "passwordExpirationTime"},
			match:   passwordExpiredMatch,
		}, nil
	case models.AccountReportNeverLoggedOn:
		return reportSpec{
			filter:     "(&(|(objectClass=person)(objectClass=nsAccount)(objectClass=account))(!(lastLoginTime=*)))",
			columns:    []string{"uid", "cn", "mail", "createTimestamp"},
			match:      neverLoggedOnMatch,
			requireAny: "(lastLoginTime=*)",
			requireMsg: "This 389 Directory Server does not record logon times (no entry has lastLoginTime); enable the Account Policy plugin with alwaysRecordLogin to use this report.",
		}, nil
	}
	return reportSpec{}, unknownReport(params.Report)
}
