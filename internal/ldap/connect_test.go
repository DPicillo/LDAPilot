package ldap

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

func TestIsConnDead(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"server result", goldap.NewError(goldap.LDAPResultNoSuchObject, errors.New("no such object")), false},
		{"server unavailable", goldap.NewError(goldap.LDAPResultUnavailable, errors.New("shutting down")), false},
		{"request timeout", goldap.NewError(goldap.ErrorNetwork, errors.New("ldap: connection timed out")), false},
		{"enforced size limit", goldap.ErrSizeLimitExceeded, false},
		{"cancelled", ErrSearchCancelled, false},
		{"not connected", ErrNotConnected, false},
		{"closing before send", goldap.NewError(goldap.ErrorNetwork, errors.New("ldap: connection closed")), true},
		{"response channel closed", goldap.NewError(goldap.ErrorNetwork, errors.New("ldap: response channel closed")), true},
		{"reader eof", errors.New("unable to read LDAP response packet: EOF"), true},
		{"write failed", errors.New("unable to send request: write tcp: broken pipe"), true},
		{"unbound", goldap.ErrConnUnbound, true},
		{"nil connection", goldap.ErrNilConnection, true},
		{"wrapped network", fmt.Errorf("x: %w", goldap.NewError(goldap.ErrorNetwork, errors.New("read: connection reset by peer"))), true},
		{"other", errors.New("something else"), false},
		// Failures of the temporary paging connection never count against the main one.
		{"temporary connection", &privateConnError{err: goldap.NewError(goldap.ErrorNetwork, errors.New("ldap: response channel closed"))}, false},
		{"wrapped temporary connection", searchError(&privateConnError{err: errors.New("unable to read LDAP response packet: EOF")}), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isConnDead(nil, tt.err); got != tt.want {
				t.Errorf("isConnDead(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

func TestRequestNotSent(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"closing before send", goldap.NewError(goldap.ErrorNetwork, errors.New("ldap: connection closed")), true},
		{"write failed", errors.New("unable to send request: write tcp: broken pipe"), true},
		{"enqueue failed", goldap.NewError(goldap.ErrorNetwork, errors.New("ldap: could not send message for unknown reason")), true},
		{"nil connection", goldap.ErrNilConnection, true},
		{"lost after send", errors.New("unable to read LDAP response packet: EOF"), false},
		{"response channel closed", goldap.NewError(goldap.ErrorNetwork, errors.New("ldap: response channel closed")), false},
		{"lost during search", goldap.NewError(goldap.ErrorNetwork, errors.New("ldap: connection lost during search")), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := requestNotSent(tt.err); got != tt.want {
				t.Errorf("requestNotSent(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

func TestNextPageControls(t *testing.T) {
	withCookie := goldap.NewControlPaging(100)
	withCookie.SetCookie([]byte("cookie"))

	next := nextPageControls([]goldap.Control{withCookie}, 50)
	if len(next) != 1 {
		t.Fatalf("expected one control, got %d", len(next))
	}
	paging, ok := next[0].(*goldap.ControlPaging)
	if !ok || string(paging.Cookie) != "cookie" || paging.PagingSize != 50 {
		t.Errorf("unexpected next page control: %#v", next[0])
	}

	if got := nextPageControls([]goldap.Control{goldap.NewControlPaging(100)}, 50); got != nil {
		t.Errorf("empty cookie: expected nil, got %v", got)
	}
	if got := nextPageControls(nil, 50); got != nil {
		t.Errorf("no controls: expected nil, got %v", got)
	}
}

func TestCancelSearches(t *testing.T) {
	c := NewClient(models.ConnectionProfile{})

	ctx1, done1 := c.trackSearch(context.Background())
	ctx2, done2 := c.trackSearch(context.Background())
	if n := c.CancelSearches(); n != 2 {
		t.Fatalf("CancelSearches() = %d, want 2", n)
	}
	if ctx1.Err() == nil || ctx2.Err() == nil {
		t.Fatal("tracked contexts were not cancelled")
	}
	done1()
	done2()
	if n := c.CancelSearches(); n != 0 {
		t.Fatalf("CancelSearches() after done = %d, want 0", n)
	}

	ctx3, done3 := c.trackSearch(context.Background())
	defer done3()
	if ctx3.Err() != nil {
		t.Fatal("new search must not inherit an earlier cancel")
	}
}

func TestClientNotConnected(t *testing.T) {
	c := NewClient(models.ConnectionProfile{ID: "p"})
	check := func(stage string) {
		t.Helper()
		if _, err := c.GetEntry("dc=example"); !errors.Is(err, ErrNotConnected) {
			t.Errorf("%s: GetEntry err = %v", stage, err)
		}
		if _, err := c.GetChildren("dc=example"); !errors.Is(err, ErrNotConnected) {
			t.Errorf("%s: GetChildren err = %v", stage, err)
		}
		if _, err := c.Search(models.SearchParams{BaseDN: "dc=example"}); !errors.Is(err, ErrNotConnected) {
			t.Errorf("%s: Search err = %v", stage, err)
		}
		if _, err := c.GetSchema(); !errors.Is(err, ErrNotConnected) {
			t.Errorf("%s: GetSchema err = %v", stage, err)
		}
		if err := c.AddEntry("cn=x,dc=example", nil); !errors.Is(err, ErrNotConnected) {
			t.Errorf("%s: AddEntry err = %v", stage, err)
		}
		if c.IsConnected() {
			t.Errorf("%s: IsConnected = true", stage)
		}
	}
	check("new")
	c.Close()
	check("closed")
}

func TestClientConcurrentStateAccess(t *testing.T) {
	// Exercised with -race: lifecycle calls and operations on a client
	// without connection must not race on the guarded state.
	c := NewClient(models.ConnectionProfile{ID: "p"})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				_ = c.IsConnected()
				_, _ = c.Search(models.SearchParams{})
				_ = c.CancelSearches()
				c.Close()
			}
		}()
	}
	wg.Wait()
}

func TestPoolNotConnected(t *testing.T) {
	p := NewPool()
	if _, err := p.Get("missing"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Get err = %v", err)
	}
	if p.IsConnected("missing") {
		t.Error("IsConnected = true for unknown profile")
	}
	p.Disconnect("missing")
	p.DisconnectAll()
	if got := p.GetConnected(); len(got) != 0 {
		t.Errorf("GetConnected = %v", got)
	}
}

func TestIsPagingConflict(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"openldap invalid cookie", goldap.NewError(goldap.LDAPResultUnwillingToPerform, errors.New("paged results cookie is invalid or old")), true},
		{"samba dropped result set", goldap.NewError(goldap.LDAPResultUnwillingToPerform, errors.New("error in module dsdb_paged_results")), true},
		{"size limit", goldap.NewError(goldap.LDAPResultSizeLimitExceeded, errors.New("")), false},
		{"referral", goldap.NewError(goldap.LDAPResultReferral, errors.New("")), false},
		{"network error", goldap.NewError(goldap.ErrorNetwork, errors.New("bad cookie")), false},
		{"plain error", errors.New("cookie"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isPagingConflict(tt.err); got != tt.want {
				t.Errorf("isPagingConflict(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

// A failed connect is logged as a CONNECT error in the profile's operation
// log, which survives the failed client (and is dropped by Forget).
func TestPoolLogsFailedConnect(t *testing.T) {
	p := NewPool()
	// Port 1 on localhost: refused at once (no network needed).
	profile := models.ConnectionProfile{ID: "p1", Host: "127.0.0.1", Port: 1, Timeout: 2, AuthMethod: models.AuthNone, TLSMode: models.TLSNone}
	var streamed []LogEntry
	p.Logger("p1").SetListener(func(e LogEntry) { streamed = append(streamed, e) })
	if err := p.Connect(profile); err == nil {
		t.Skip("something listens on 127.0.0.1:1")
	}
	entries := p.Logger("p1").GetEntries()
	if len(entries) != 1 || entries[0].Operation != "CONNECT" || entries[0].Error == "" || entries[0].Details != "Connection to 127.0.0.1:1 failed" {
		t.Fatalf("log = %+v", entries)
	}
	if len(streamed) != 1 {
		t.Fatalf("listener got %d entries", len(streamed))
	}
	p.Forget("p1")
	if n := len(p.Logger("p1").GetEntries()); n != 0 {
		t.Fatalf("log kept after Forget: %d", n)
	}
}

func TestProfileTimeoutClamped(t *testing.T) {
	for in, want := range map[int]time.Duration{0: defaultTimeout, -5: defaultTimeout, 30: 30 * time.Second, 9999: MaxProfileTimeout * time.Second} {
		if got := profileTimeout(models.ConnectionProfile{Timeout: in}); got != want {
			t.Errorf("profileTimeout(%d) = %v, want %v", in, got, want)
		}
	}
}

func TestRootDSEDedupe(t *testing.T) {
	e := &goldap.Entry{Attributes: []*goldap.EntryAttribute{
		{Name: "supportedControl", Values: []string{"1.2", "1.3", "1.2"}, ByteValues: [][]byte{[]byte("1.2"), []byte("1.3"), []byte("1.2")}},
		{Name: "SupportedControl", Values: []string{"1.3", "1.4"}, ByteValues: [][]byte{[]byte("1.3"), []byte("1.4")}},
		{Name: "vendorName", Values: []string{"X"}, ByteValues: [][]byte{[]byte("X")}},
	}}
	rootDSEDedupe(e)
	if len(e.Attributes) != 2 {
		t.Fatalf("attributes = %d", len(e.Attributes))
	}
	if got := fmt.Sprint(e.Attributes[0].Values); got != "[1.2 1.3 1.4]" || len(e.Attributes[0].ByteValues) != 3 {
		t.Fatalf("supportedControl = %s (%d byte values)", got, len(e.Attributes[0].ByteValues))
	}
}
