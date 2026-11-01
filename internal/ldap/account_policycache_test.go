package ldap

import (
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	ber "github.com/go-asn1-ber/asn1-ber"
	goldap "github.com/go-ldap/ldap/v3"
)

// --- shared cache rules (pure) ------------------------------------------------

func readablePolicy(dn string) *models.AccountPolicy {
	return &models.AccountPolicy{DN: dn, Name: rdnValue(dn), Source: models.PolicySourceDefault, Readable: true, LockoutEnabled: true}
}

func TestPolicyCacheSeedTTLAndCopies(t *testing.T) {
	s := &accountPolicyCache{}
	conn := &goldap.Conn{}
	t0 := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)

	r := s.begin(conn, t0, policyCacheTTL)
	if len(r.cache) != 0 {
		t.Fatalf("empty cache seeded %d entries", len(r.cache))
	}
	r.cache["cn=pol,dc=test"] = readablePolicy("cn=pol,dc=test")
	r.cache["#ppolicy-default:dc=test"] = r.cache["cn=pol,dc=test"]
	r.cache["cn=secret,dc=test"] = &models.AccountPolicy{DN: "cn=secret,dc=test", Source: models.PolicySourceSubentry} // unreadable
	r.cache["#none"] = &models.AccountPolicy{Name: "No password policy", Source: models.PolicySourceNoPolicy, Readable: true}
	r.finish()

	r2 := s.begin(conn, t0.Add(30*time.Second), policyCacheTTL)
	if _, ok := r2.cache["cn=secret,dc=test"]; ok {
		t.Fatal("an unreadable policy must not be shared")
	}
	if len(r2.cache) != 3 || r2.cache["#none"] == nil || r2.cache["#ppolicy-default:dc=test"] == nil {
		t.Fatalf("seeded = %v", r2.cache)
	}
	// Copies: a request changing its policy does not change the shared one.
	r2.cache["cn=pol,dc=test"].LockoutEnabled = false
	if r2.cache["#ppolicy-default:dc=test"].LockoutEnabled != true {
		t.Fatal("keys of one request must not share a pointer with the shared cache")
	}
	r2.finish()
	r3 := s.begin(conn, t0.Add(31*time.Second), policyCacheTTL)
	if !r3.cache["cn=pol,dc=test"].LockoutEnabled {
		t.Fatal("a seeded policy changed by a request was merged back")
	}

	// Expired after the TTL (a seeded entry is not stamped anew by finish).
	if r := s.begin(conn, t0.Add(policyCacheTTL), policyCacheTTL); len(r.cache) != 0 {
		t.Fatalf("entries older than the TTL seeded: %v", r.cache)
	}
	// maxAge 0 (write planning) seeds nothing.
	if r := s.begin(conn, t0.Add(time.Second), 0); len(r.cache) != 0 {
		t.Fatal("write planning must read every policy fresh")
	}
}

func TestPolicyCacheInvalidateDuringRead(t *testing.T) {
	s := &accountPolicyCache{}
	conn := &goldap.Conn{}
	now := time.Now()
	old := s.begin(conn, now, policyCacheTTL) // a read that began before the write
	old.cache["cn=pol,dc=test"] = readablePolicy("cn=pol,dc=test")
	s.invalidate() // the write of the policy entry
	old.finish()
	if r := s.begin(conn, now, policyCacheTTL); len(r.cache) != 0 {
		t.Fatal("a read that began before an invalidation merged its old policy back")
	}

	// A planning read refreshes the cache for the status reads after it.
	plan := s.begin(conn, now, 0)
	plan.cache["cn=pol,dc=test"] = readablePolicy("cn=pol,dc=test")
	plan.finish()
	if r := s.begin(conn, now.Add(time.Second), policyCacheTTL); r.cache["cn=pol,dc=test"] == nil {
		t.Fatal("the fresh planning read was not shared")
	}
}

func TestPolicyCacheNewerEntryWins(t *testing.T) {
	s := &accountPolicyCache{}
	conn := &goldap.Conn{}
	t0 := time.Now()
	early := s.begin(conn, t0, policyCacheTTL)
	late := s.begin(conn, t0.Add(time.Second), 0)
	p := readablePolicy("cn=pol,dc=test")
	p.LockoutThreshold = 5
	late.cache["cn=pol,dc=test"] = p
	late.finish()
	q := readablePolicy("cn=pol,dc=test")
	q.LockoutThreshold = 3 // read before the later request's read
	early.cache["cn=pol,dc=test"] = q
	early.finish()
	r := s.begin(conn, t0.Add(2*time.Second), policyCacheTTL)
	if got := r.cache["cn=pol,dc=test"].LockoutThreshold; got != 5 {
		t.Fatalf("threshold = %d; the policy of the later read must win", got)
	}
}

func TestPolicyCacheReconnectStartsAfresh(t *testing.T) {
	s := &accountPolicyCache{}
	a, b := &goldap.Conn{}, &goldap.Conn{}
	now := time.Now()
	r := s.begin(a, now, policyCacheTTL)
	r.cache["cn=pol,dc=test"] = readablePolicy("cn=pol,dc=test")
	r.finish()
	inflight := s.begin(a, now, policyCacheTTL)
	if got := s.begin(b, now, policyCacheTTL); len(got.cache) != 0 {
		t.Fatal("policies of the old connection were served after a reconnect")
	}
	inflight.cache["cn=other,dc=test"] = readablePolicy("cn=other,dc=test")
	inflight.finish()
	if got := s.begin(b, now, policyCacheTTL); len(got.cache) != 0 {
		t.Fatal("a read on the old connection merged into the new one")
	}
}

func TestPolicyCacheBounded(t *testing.T) {
	s := &accountPolicyCache{}
	conn := &goldap.Conn{}
	now := time.Now()
	for i := 0; i < policyCacheMax+10; i++ {
		r := s.begin(conn, now, 0)
		dn := fmt.Sprintf("cn=pso%d,dc=test", i)
		r.cache[dn] = readablePolicy(dn)
		r.finish()
	}
	if n := len(s.entries); n == 0 || n > policyCacheMax {
		t.Fatalf("%d entries", n)
	}
}

func TestWriteAffectsPolicies(t *testing.T) {
	s := &accountPolicyCache{}
	conn := &goldap.Conn{}
	r := s.begin(conn, time.Now(), 0)
	r.cache["cn=default-ppolicy,ou=policies,dc=test"] = readablePolicy("cn=default-ppolicy,ou=Policies,dc=test")
	r.finish()
	cases := []struct {
		dn    string
		attrs []string
		ocs   []string
		want  bool
	}{
		{"CN=default-ppolicy, ou=Policies,DC=test", []string{"description"}, nil, true}, // a cached policy entry
		{"olcOverlay={0}ppolicy,olcDatabase={1}mdb,cn=config", []string{"olcPPolicyDefault"}, nil, true},
		{"cn=config", []string{"passwordMustChange"}, nil, true},
		{"cn=new,ou=policies,dc=test", []string{"objectClass", "pwdAttribute"}, []string{"pwdPolicy"}, true},
		{"cn=x,dc=test", []string{"pwdMaxAge;x-option"}, nil, true},
		{"DC=ad,DC=lab", []string{"lockoutThreshold"}, nil, true},
		{"uid=u1,ou=people,dc=test", []string{"pwdAccountLockedTime", "pwdFailureTime"}, nil, false},
		{"uid=u1,ou=people,dc=test", []string{"pwdReset", "userPassword"}, nil, false},
		{"uid=u1,ou=people,dc=test", []string{"passwordExpirationTime", "nsAccountLock"}, nil, false},
		{"CN=u1,DC=ad,DC=lab", []string{"lockoutTime", "pwdLastSet", "userAccountControl"}, nil, false},
		{"uid=u2,ou=people,dc=test", []string{"objectClass"}, []string{"inetOrgPerson"}, false},
	}
	for _, c := range cases {
		if got := s.writeAffectsPolicies(c.dn, c.attrs, c.ocs); got != c.want {
			t.Errorf("writeAffectsPolicies(%q, %v, %v) = %v, want %v", c.dn, c.attrs, c.ocs, got, c.want)
		}
	}
}

// Exercised with -race: requests, merges and invalidations from many
// goroutines (Wails calls run concurrently).
func TestPolicyCacheConcurrent(t *testing.T) {
	s := &accountPolicyCache{}
	conn := &goldap.Conn{}
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				now := time.Now()
				switch (g + i) % 5 {
				case 0:
					s.invalidate()
				case 1:
					_ = s.holdsPolicyDN("cn=pol,dc=test")
				default:
					r := s.begin(conn, now, policyCacheTTL)
					if p := r.cache["cn=pol,dc=test"]; p != nil {
						p.LockoutThreshold++ // requests own their copies
					} else {
						r.cache["cn=pol,dc=test"] = readablePolicy("cn=pol,dc=test")
					}
					r.finish()
				}
			}
		}(g)
	}
	wg.Wait()
}

// --- end to end on a fake OpenLDAP server ------------------------------------

// fakeDirectory answers base and subtree searches from in-memory entries,
// applies modifies, and refuses cn=config like an OpenLDAP whose admin may
// not read it (the lab). It records every search as "base|filter".
type fakeDirectory struct {
	mu       sync.Mutex
	entries  map[string]map[string][]string // lower DN -> attr -> values
	dns      map[string]string              // lower DN -> DN
	searches []string
}

func newFakeDirectory() *fakeDirectory {
	return &fakeDirectory{entries: map[string]map[string][]string{}, dns: map[string]string{}}
}

func (f *fakeDirectory) add(dn string, attrs map[string][]string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.entries[strings.ToLower(dn)] = attrs
	f.dns[strings.ToLower(dn)] = dn
}

func (f *fakeDirectory) count(base, filterPart string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, s := range f.searches {
		b, flt, _ := strings.Cut(s, "|")
		if strings.EqualFold(b, base) && strings.Contains(flt, filterPart) {
			n++
		}
	}
	return n
}

func (f *fakeDirectory) resetCounts() {
	f.mu.Lock()
	f.searches = nil
	f.mu.Unlock()
}

func ldapResult(app ber.Tag, code int64) *ber.Packet {
	p := ber.Encode(ber.ClassApplication, ber.TypeConstructed, app, nil, "result")
	p.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagEnumerated, code, "code"))
	p.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "matchedDN"))
	p.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "message"))
	return p
}

func (f *fakeDirectory) entryPacket(dn string, attrs map[string][]string) *ber.Packet {
	e := ber.Encode(ber.ClassApplication, ber.TypeConstructed, goldap.ApplicationSearchResultEntry, nil, "entry")
	e.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, dn, "dn"))
	list := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "attributes")
	for name, values := range attrs {
		a := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "attribute")
		a.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, name, "type"))
		set := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSet, nil, "values")
		for _, v := range values {
			set.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, v, "value"))
		}
		a.AppendChild(set)
		list.AppendChild(a)
	}
	e.AppendChild(list)
	return e
}

func fakeHasObjectClass(attrs map[string][]string, oc string) bool {
	for name, values := range attrs {
		if strings.EqualFold(name, "objectClass") {
			for _, v := range values {
				if strings.EqualFold(v, oc) {
					return true
				}
			}
		}
	}
	return false
}

func (f *fakeDirectory) serve(conn net.Conn) {
	defer conn.Close()
	// net.Pipe is synchronous: the answers of a request are written by their
	// own goroutine, so reading the next request never waits for the client
	// to read an answer (go-ldap sends and receives on one connection).
	var wmu sync.Mutex
	reply := func(id int64, ops ...*ber.Packet) {
		go func() {
			wmu.Lock()
			defer wmu.Unlock()
			for _, op := range ops {
				conn.Write(fakeResponse(id, op).Bytes())
			}
		}()
	}
	for {
		pkt, err := ber.ReadPacket(conn)
		if err != nil || len(pkt.Children) < 2 {
			return
		}
		id, _ := pkt.Children[0].Value.(int64)
		op := pkt.Children[1]
		switch op.Tag {
		case goldap.ApplicationSearchRequest:
			base := op.Children[0].Data.String()
			scope, _ := op.Children[1].Value.(int64)
			filter, _ := goldap.DecompileFilter(op.Children[6])
			f.mu.Lock()
			f.searches = append(f.searches, base+"|"+filter)
			var out []*ber.Packet
			code := int64(goldap.LDAPResultSuccess)
			lbase := strings.ToLower(base)
			if lbase == "cn=config" || strings.HasSuffix(lbase, ",cn=config") {
				code = goldap.LDAPResultNoSuchObject
			} else if scope == int64(goldap.ScopeBaseObject) {
				if a, ok := f.entries[lbase]; ok {
					out = append(out, f.entryPacket(f.dns[lbase], a))
				} else {
					code = goldap.LDAPResultNoSuchObject
				}
			} else {
				oc := ""
				if strings.HasPrefix(strings.ToLower(filter), "(objectclass=") && !strings.HasSuffix(filter, "=*)") {
					oc = filter[len("(objectClass=") : len(filter)-1]
				}
				for k, a := range f.entries {
					if (k == lbase || strings.HasSuffix(k, ","+lbase)) && (oc == "" || fakeHasObjectClass(a, oc)) {
						out = append(out, f.entryPacket(f.dns[k], a))
					}
				}
			}
			f.mu.Unlock()
			reply(id, append(out, ldapResult(goldap.ApplicationSearchResultDone, code))...)
		case goldap.ApplicationModifyRequest:
			dn := strings.ToLower(op.Children[0].Data.String())
			f.mu.Lock()
			a, ok := f.entries[dn]
			if ok {
				for _, ch := range op.Children[1].Children {
					opCode, _ := ch.Children[0].Value.(int64)
					name := ch.Children[1].Children[0].Data.String()
					var values []string
					for _, v := range ch.Children[1].Children[1].Children {
						values = append(values, v.Data.String())
					}
					switch opCode {
					case 0: // add
						a[name] = append(a[name], values...)
					case 1: // delete
						delete(a, name)
					case 2: // replace
						a[name] = values
					}
				}
			}
			f.mu.Unlock()
			code := int64(goldap.LDAPResultSuccess)
			if !ok {
				code = goldap.LDAPResultNoSuchObject
			}
			reply(id, ldapResult(goldap.ApplicationModifyResponse, code))
		}
	}
}

const (
	fakePolicyDN = "cn=default-ppolicy,ou=Policies,dc=test"
	fakeUserDN   = "uid=u1,ou=people,dc=test"
)

// fakeOpenLDAPClient returns a connected client on a fake OpenLDAP with one
// default policy (cn=config not readable: the only pwdPolicy entry is
// assumed, like the lab) and one locked user.
func fakeOpenLDAPClient(t *testing.T) (*Client, *fakeDirectory) {
	t.Helper()
	f := newFakeDirectory()
	f.add("dc=test", map[string][]string{"objectClass": {"dcObject", "organization"}})
	f.add(fakePolicyDN, map[string][]string{
		"objectClass": {"organizationalRole", "pwdPolicy"}, "cn": {"default-ppolicy"}, "pwdAttribute": {"userPassword"},
		"pwdLockout": {"TRUE"}, "pwdLockoutDuration": {"0"}, "pwdMaxFailure": {"3"}, "pwdMustChange": {"TRUE"},
	})
	f.add(fakeUserDN, map[string][]string{
		"objectClass": {"inetOrgPerson"}, "uid": {"u1"}, "pwdAccountLockedTime": {"20260101000000Z"}, "userPassword": {"{SSHA}x"},
	})
	cli, srv := net.Pipe()
	go f.serve(srv)
	conn := goldap.NewConn(cli, false)
	conn.Start()
	t.Cleanup(func() { conn.Close() })
	c := NewClient(models.ConnectionProfile{ID: "fake", Host: "fake", Port: 389})
	c.conn = conn
	c.serverInfo = &models.ServerInfo{
		ServerType: models.ServerTypeOpenLDAP, NamingContexts: []string{"dc=test"},
		SupportedControls: []string{OIDPasswordPolicyControl},
	}
	return c, f
}

const policySearch = "(objectClass=pwdPolicy)"

func TestAccountStatusSharesPolicyReads(t *testing.T) {
	c, f := fakeOpenLDAPClient(t)
	for i := 0; i < 3; i++ {
		st, err := c.AccountStatus(fakeUserDN)
		if err != nil {
			t.Fatal(err)
		}
		if !st.Locked || st.Policy == nil || !st.Policy.LockoutEnabled || st.Policy.Source != models.PolicySourceAssumed {
			t.Fatalf("status %d: %+v (policy %+v)", i, st, st.Policy)
		}
		if st.PolicyNote == "" {
			t.Fatalf("status %d lost the assumed-policy note", i)
		}
	}
	if n := f.count(fakeUserDN, ""); n != 3 {
		t.Errorf("user entry read %d times, want 3", n)
	}
	if n := f.count("dc=test", policySearch); n != 1 {
		t.Errorf("default policy lookup ran %d times, want 1", n)
	}
	if n := f.count(fakePolicyDN, ""); n != 1 {
		t.Errorf("policy entry read %d times, want 1", n)
	}

	// The password dialog's context: one read of the entry, no policy read.
	f.resetCounts()
	st, entry, err := c.AccountStatusAndEntry(fakeUserDN, "userPassword", "cn")
	if err != nil || st == nil || entry == nil || entry.GetAttributeValue("userPassword") != "{SSHA}x" {
		t.Fatalf("AccountStatusAndEntry: %v %+v %v", err, st, entry)
	}
	if n, p := f.count(fakeUserDN, ""), f.count(fakePolicyDN, "")+f.count("dc=test", policySearch); n != 1 || p != 0 {
		t.Errorf("password context: %d entry reads, %d policy reads; want 1 and 0", n, p)
	}

	// The New User dialog asks for the default policy: cached as well.
	pol, err := c.NewAccountPolicy("ou=people,dc=test")
	if err != nil || pol == nil || !pol.MustChangeEnforced {
		t.Fatalf("NewAccountPolicy: %v %+v", err, pol)
	}
	if n := f.count(fakePolicyDN, "") + f.count("dc=test", policySearch); n != 0 {
		t.Errorf("NewAccountPolicy read the policy %d times", n)
	}
}

func TestPlanAccountChangeReadsPolicyFresh(t *testing.T) {
	c, f := fakeOpenLDAPClient(t)
	if _, err := c.AccountStatus(fakeUserDN); err != nil {
		t.Fatal(err)
	}
	// Changed outside the app: the cache still has pwdLockout TRUE.
	f.mu.Lock()
	f.entries[strings.ToLower(fakePolicyDN)]["pwdLockout"] = []string{"FALSE"}
	f.mu.Unlock()
	if st, _ := c.AccountStatus(fakeUserDN); !st.Policy.LockoutEnabled {
		t.Fatal("status reads should use the cached policy within the TTL")
	}
	f.resetCounts()
	// Write planning must see pwdLockout FALSE (OpenLDAP would ignore the
	// permanent lock, so "disabled" would be a lie).
	if _, err := c.PlanAccountChange(fakeUserDN, AccountChange{Action: models.AccountActionDisable}); err == nil ||
		!strings.Contains(err.Error(), "pwdLockout FALSE") {
		t.Fatalf("planned with a stale policy: err = %v", err)
	}
	if n := f.count(fakePolicyDN, ""); n != 1 {
		t.Errorf("planning read the policy entry %d times, want 1 (fresh)", n)
	}
	// The fresh read refreshed the cache for the status reads after it.
	f.resetCounts()
	st, _ := c.AccountStatus(fakeUserDN)
	if st.Policy.LockoutEnabled || f.count(fakePolicyDN, "") != 0 {
		t.Fatalf("status after planning: lockout %v, %d policy reads", st.Policy.LockoutEnabled, f.count(fakePolicyDN, ""))
	}
}

func TestPolicyWriteInvalidatesCache(t *testing.T) {
	c, f := fakeOpenLDAPClient(t)
	if _, err := c.AccountStatus(fakeUserDN); err != nil {
		t.Fatal(err)
	}
	// An account action on the user keeps the cache.
	if err := c.ModifyEntry(fakeUserDN, []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "pwdReset", Values: []string{"TRUE"}}}); err != nil {
		t.Fatal(err)
	}
	f.resetCounts()
	if _, err := c.AccountStatus(fakeUserDN); err != nil || f.count(fakePolicyDN, "") != 0 {
		t.Fatalf("a user write dropped the policy cache (err %v)", err)
	}
	// Editing the policy entry in the app drops it.
	if err := c.ModifyEntry(fakePolicyDN, []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "pwdMustChange", Values: []string{"FALSE"}}}); err != nil {
		t.Fatal(err)
	}
	f.resetCounts()
	st, err := c.AccountStatus(fakeUserDN)
	if err != nil {
		t.Fatal(err)
	}
	if st.Policy.MustChangeEnforced || st.MustChangePassword || f.count(fakePolicyDN, "") != 1 {
		t.Fatalf("after the policy write: mustChangeEnforced %v, mustChange %v, %d policy reads",
			st.Policy.MustChangeEnforced, st.MustChangePassword, f.count(fakePolicyDN, ""))
	}
	// Delete / rename hook (client.go's DeleteEntry and RenameEntry).
	c.notePolicyEntryWrite(fakeUserDN)
	f.resetCounts()
	c.AccountStatus(fakeUserDN)
	if f.count(fakePolicyDN, "") != 0 {
		t.Fatal("a delete of a user dropped the policy cache")
	}
	c.notePolicyEntryWrite("CN=default-ppolicy,OU=Policies,DC=test")
	f.resetCounts()
	c.AccountStatus(fakeUserDN)
	if f.count(fakePolicyDN, "") != 1 {
		t.Fatal("a delete of the policy entry kept the cache")
	}
}

// Exercised with -race: status reads, planning and policy writes at the same
// time; after the last write every read sees the last value.
func TestPolicyCacheConcurrentClient(t *testing.T) {
	c, _ := fakeOpenLDAPClient(t)
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 15; i++ {
				switch (g + i) % 4 {
				case 0:
					v := []string{"3", "4", "5"}[(g+i)%3]
					if err := c.ModifyEntry(fakePolicyDN, []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "pwdMaxFailure", Values: []string{v}}}); err != nil {
						errs <- err
					}
				case 1:
					if _, err := c.PlanAccountChange(fakeUserDN, AccountChange{Action: models.AccountActionUnlock}); err != nil {
						errs <- err
					}
				default:
					if _, err := c.AccountStatus(fakeUserDN); err != nil {
						errs <- err
					}
				}
			}
		}(g)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if err := c.ModifyEntry(fakePolicyDN, []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "pwdMaxFailure", Values: []string{"7"}}}); err != nil {
		t.Fatal(err)
	}
	st, err := c.AccountStatus(fakeUserDN)
	if err != nil || st.Policy.LockoutThreshold != 7 {
		t.Fatalf("after the last write: %v, threshold %d", err, st.Policy.LockoutThreshold)
	}
}
