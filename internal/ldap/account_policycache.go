package ldap

import (
	"runtime"
	"strings"
	"sync"
	"time"
	"weak"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// Shared password policy cache (RW1-P-06).
//
// Every account status read needs the effective policy of the entry: on
// OpenLDAP the default-policy lookup (cn=config probe or a subtree search
// for (objectClass=pwdPolicy)) plus the pwdPolicy entry, on 389DS the global
// policy in cn=config (and a local policy entry), on AD the domain NC head or
// a PSO. Menus, editor tabs, the Account tab, the password dialog and report
// rows read statuses all the time, so the policies are shared per client for
// policyCacheTTL instead of being read again for every status.
//
// Rules:
//   - A request (one status, one report) works on its own policyCache map,
//     seeded with copies of the shared entries (begin) and merged back when it
//     is done (finish). No lock is held during network I/O and no
//     *models.AccountPolicy is shared between requests.
//   - Write planning (PlanAccountChange: account actions, the enable step of
//     a password reset) never uses a cached policy: it reads every policy
//     fresh (maxAge 0) and refreshes the shared cache with what it read.
//   - Writes through this client that may change a policy (a cached policy
//     entry, anything below cn=config, policy attributes or policy object
//     classes) drop the whole cache (notePolicyWrite*). A request that began
//     before such a write does not merge its (possibly old) policies back:
//     the generation changed. Policies changed outside the app are seen
//     after at most policyCacheTTL.
//   - Only readable policies and the definitive "no policy" lookup are
//     shared; an unreadable policy (no access, a network blip) is read again
//     by the next request, as before.
//   - Entries belong to the connection they were read on; a reconnect starts
//     afresh. Reads through a referral (another server) never use the cache.

const (
	// policyCacheTTL is how long a shared policy serves status reads (the
	// tree's lock evaluation caches its lookups for the same time).
	policyCacheTTL = time.Minute
	// policyCacheMax bounds the shared entries (policies, PSOs and lookups
	// of one directory are few); the cache starts afresh above it.
	policyCacheMax = 256
)

// sharedPolicy is one shared cache entry: a copy of the policy and the time
// the request that read it began.
type sharedPolicy struct {
	pol models.AccountPolicy
	at  time.Time
}

// accountPolicyCache is the shared policy cache of one client.
type accountPolicyCache struct {
	mu      sync.Mutex
	gen     uint64       // bumped by invalidate
	conn    *goldap.Conn // connection the entries were read on
	entries map[string]sharedPolicy
}

// policyRead is the policy cache of one request (see begin / finish).
type policyRead struct {
	// cache is passed to the status / report code (policyCache keys).
	cache  policyCache
	shared *accountPolicyCache
	seeded map[string]bool
	gen    uint64
	conn   *goldap.Conn
	start  time.Time
}

// begin returns a request cache seeded with copies of the shared entries
// younger than maxAge that were read on conn. maxAge 0 seeds nothing (write
// planning reads every policy fresh).
func (s *accountPolicyCache) begin(conn *goldap.Conn, now time.Time, maxAge time.Duration) *policyRead {
	r := &policyRead{cache: policyCache{}, shared: s, seeded: map[string]bool{}, conn: conn, start: now}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != conn {
		// Reconnected (or the first request): nothing read so far is ours.
		s.conn, s.entries = conn, nil
		s.gen++
	}
	r.gen = s.gen
	if maxAge <= 0 {
		return r
	}
	for k, e := range s.entries {
		if age := now.Sub(e.at); age < 0 || age >= maxAge {
			continue
		}
		cp := e.pol
		r.cache[k] = &cp
		r.seeded[k] = true
	}
	return r
}

// shareablePolicy reports whether a policy read by a request may serve
// other requests: readable policies and the definitive "no policy" result.
func shareablePolicy(p *models.AccountPolicy) bool {
	return p != nil && (p.Readable || p.Source == models.PolicySourceNoPolicy)
}

// finish merges the policies the request read itself into the shared cache,
// stamped with the time the request began. Nothing is merged when the cache
// was invalidated (or reset by a reconnect) since begin.
func (r *policyRead) finish() {
	if r == nil || r.shared == nil {
		return
	}
	s := r.shared
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gen != r.gen || s.conn != r.conn {
		return
	}
	for k, p := range r.cache {
		if r.seeded[k] || !shareablePolicy(p) {
			continue
		}
		if cur, ok := s.entries[k]; ok && !cur.at.Before(r.start) {
			continue // a request that began later already stored it
		}
		if s.entries == nil || len(s.entries) >= policyCacheMax {
			s.entries = map[string]sharedPolicy{}
		}
		s.entries[k] = sharedPolicy{pol: *p, at: r.start}
	}
}

// invalidate drops every shared entry; requests running now do not merge
// their policies back.
func (s *accountPolicyCache) invalidate() {
	s.mu.Lock()
	s.entries = nil
	s.gen++
	s.mu.Unlock()
}

// holdsPolicyDN reports whether dn is the DN of a shared policy.
func (s *accountPolicyCache) holdsPolicyDN(dn string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.entries {
		if e.pol.DN != "" && sameDN(e.pol.DN, dn) {
			return true
		}
	}
	return false
}

// policyCaches attaches the shared cache to its client without a field in
// the Client struct (client.go): keys are weak pointers, so the cache does
// not keep a closed client alive, and the entry is removed when the client
// is collected.
var policyCaches sync.Map // weak.Pointer[Client] -> *accountPolicyCache

// policies returns the shared policy cache of c.
func (c *Client) policies() *accountPolicyCache {
	key := weak.Make(c)
	if v, ok := policyCaches.Load(key); ok {
		return v.(*accountPolicyCache)
	}
	v, loaded := policyCaches.LoadOrStore(key, &accountPolicyCache{})
	if !loaded {
		runtime.AddCleanup(c, func(k weak.Pointer[Client]) { policyCaches.Delete(k) }, key)
	}
	return v.(*accountPolicyCache)
}

// currentConn returns the client's connection (nil when not connected).
func (c *Client) currentConn() *goldap.Conn {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn
}

// beginPolicyRead starts the policy cache of one request on the client's
// own connection; maxAge 0 reads every policy fresh (write planning).
func (c *Client) beginPolicyRead(now time.Time, maxAge time.Duration) *policyRead {
	return c.policies().begin(c.currentConn(), now, maxAge)
}

// policyAttributeNames (lower case) are the attributes of password policy
// entries (OpenLDAP pwdPolicy, 389DS global/local policies, AD domain policy
// and PSOs) and of the configuration that selects a policy. A write that
// touches one of them may change an effective policy. Account attributes
// (pwdReset, pwdAccountLockedTime, passwordExpirationTime, lockoutTime, …)
// are not among them.
var policyAttributeNames = func() map[string]bool {
	m := map[string]bool{}
	for _, list := range [][]string{ppolicyPolicyAttrs, dsPolicyAttrs, adDomainPolicyAttrs, adPSOAttrs} {
		for _, a := range list {
			m[strings.ToLower(a)] = true
		}
	}
	delete(m, "cn")
	for _, a := range []string{
		"pwdCheckQuality", "pwdAllowUserChange", "pwdSafeModify", "pwdMinDelay", "pwdMaxDelay", "pwdMaxIdle", "pwdMaxRecordedFailure",
		"olcPPolicyDefault", "olcPPolicyHashCleartext", "olcPPolicyUseLockout",
		"msDS-PasswordSettingsPrecedence", "msDS-PSOAppliesTo",
	} {
		m[strings.ToLower(a)] = true
	}
	return m
}()

// policyObjectClasses (lower case) are the object classes of policy entries.
var policyObjectClasses = map[string]bool{
	"pwdpolicy": true, "passwordpolicy": true, "msds-passwordsettings": true, "olcppolicyconfig": true,
}

// isConfigDN reports whether dn is cn=config or below it (OpenLDAP
// olcPPolicyDefault, 389DS global policy and nsslapd-pwpolicy-local).
func isConfigDN(dn string) bool {
	return isDNUnder(dn, "cn=config")
}

// writeAffectsPolicies reports whether a write to dn that names attrs (and
// the objectClass values ocs) may change a password policy.
func (s *accountPolicyCache) writeAffectsPolicies(dn string, attrs, ocs []string) bool {
	if isConfigDN(dn) {
		return true
	}
	for _, a := range attrs {
		if policyAttributeNames[strings.ToLower(attrBaseName(a))] {
			return true
		}
	}
	for _, oc := range ocs {
		if policyObjectClasses[strings.ToLower(strings.TrimSpace(oc))] {
			return true
		}
	}
	return s.holdsPolicyDN(dn)
}

// notePolicyWriteChanges drops the shared policies after a modify of dn
// that may have changed one (see writeAffectsPolicies). It runs after the
// write, so a read that began before cannot bring the old policy back.
func (c *Client) notePolicyWriteChanges(dn string, changes []models.AttributeChange) {
	s := c.policies()
	attrs := make([]string, 0, len(changes))
	var ocs []string
	for _, ch := range changes {
		attrs = append(attrs, ch.Attribute)
		if strings.EqualFold(ch.Attribute, "objectClass") {
			ocs = append(ocs, ch.Values...)
		}
	}
	if s.writeAffectsPolicies(dn, attrs, ocs) {
		s.invalidate()
	}
}

// notePolicyWriteAdd is notePolicyWriteChanges for an add of dn.
func (c *Client) notePolicyWriteAdd(dn string, entryAttrs []models.LDAPAttribute) {
	s := c.policies()
	attrs := make([]string, 0, len(entryAttrs))
	var ocs []string
	for _, a := range entryAttrs {
		attrs = append(attrs, a.Name)
		if strings.EqualFold(a.Name, "objectClass") {
			ocs = append(ocs, a.Values...)
		}
	}
	if s.writeAffectsPolicies(dn, attrs, ocs) {
		s.invalidate()
	}
}

// notePolicyEntryWrite drops the shared policies after a delete or rename
// of dn when dn is a cached policy entry or below cn=config: the hook for
// the write paths outside AddEntry/ModifyEntry (DeleteEntryWithControls,
// RenameEntry in client.go; DeleteAttribute uses notePolicyWriteChanges).
func (c *Client) notePolicyEntryWrite(dn string) {
	s := c.policies()
	if isConfigDN(dn) || s.holdsPolicyDN(dn) {
		s.invalidate()
	}
}

// sameDN compares two DNs (case-insensitive, parsed when possible).
func sameDN(a, b string) bool {
	if strings.EqualFold(a, b) {
		return true
	}
	da, err1 := goldap.ParseDN(a)
	db, err2 := goldap.ParseDN(b)
	return err1 == nil && err2 == nil && da.EqualFold(db)
}
