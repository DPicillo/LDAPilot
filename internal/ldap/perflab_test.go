//go:build perflab

package ldap

// Timings of the tree listing against the large OpenLDAP of the test lab
// (docker compose --profile perf up -d --build openldap-perf, see
// docker/README.md). Not part of the normal test run:
//
//	go test -tags perflab -run TestPerfLab -v ./internal/ldap
//
// Settings (environment): PERFLAB_HOST (localhost), PERFLAB_PORT (10389),
// PERFLAB_TLS (none | ssl | starttls), PERFLAB_BIND, PERFLAB_PASSWORD,
// PERFLAB_BASE (dc=perf,dc=ldapilot,dc=lab), PERFLAB_PAGESIZE (500),
// PERFLAB_CONTAINERS (DNs separated by ";"), PERFLAB_RUNS (3).

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

func perfEnv(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func perfProfile() models.ConnectionProfile {
	base := perfEnv("PERFLAB_BASE", "dc=perf,dc=ldapilot,dc=lab")
	port, _ := strconv.Atoi(perfEnv("PERFLAB_PORT", "10389"))
	pageSize, _ := strconv.Atoi(perfEnv("PERFLAB_PAGESIZE", "500"))
	return models.ConnectionProfile{
		ID:            "perflab",
		Name:          "perflab",
		Host:          perfEnv("PERFLAB_HOST", "localhost"),
		Port:          port,
		BaseDN:        base,
		AuthMethod:    models.AuthSimple,
		BindDN:        perfEnv("PERFLAB_BIND", "cn=admin,"+base),
		Password:      perfEnv("PERFLAB_PASSWORD", "admin"),
		TLSMode:       models.TLSMode(perfEnv("PERFLAB_TLS", "none")),
		TLSSkipVerify: true,
		PageSize:      pageSize,
		Timeout:       120,
	}
}

func perfContainers(base string) []string {
	if v := os.Getenv("PERFLAB_CONTAINERS"); v != "" {
		return strings.Split(v, ";")
	}
	return []string{"ou=Groups," + base, "ou=People," + base}
}

// perfMedian runs fn PERFLAB_RUNS times and returns the median duration.
func perfMedian(fn func()) time.Duration {
	runs, _ := strconv.Atoi(perfEnv("PERFLAB_RUNS", "3"))
	if runs < 1 {
		runs = 1
	}
	times := make([]time.Duration, runs)
	for i := range times {
		start := time.Now()
		fn()
		times[i] = time.Since(start)
	}
	sort.Slice(times, func(a, b int) bool { return times[a] < times[b] })
	return times[len(times)/2]
}

func perfMS(d time.Duration) string {
	return strconv.FormatFloat(float64(d.Microseconds())/1000, 'f', 0, 64) + " ms"
}

// perfBridgeJSON encodes v the way the Wails bridge hands a call result to
// the webview: the result as JSON, then that JSON as a JavaScript string.
func perfBridgeJSON(t *testing.T, v any) (size int, took time.Duration) {
	start := time.Now()
	msg, err := json.Marshal(struct {
		Result     any    `json:"result"`
		Err        any    `json:"error"`
		CallbackID string `json:"callbackid"`
	}{Result: v, CallbackID: "x"})
	if err != nil {
		t.Fatal(err)
	}
	escaped, err := json.Marshal(string(msg))
	if err != nil {
		t.Fatal(err)
	}
	return len(escaped), time.Since(start)
}

func TestPerfLabListing(t *testing.T) {
	profile := perfProfile()
	c := NewClient(profile)
	if err := c.Connect(); err != nil {
		t.Skipf("perf lab not reachable: %v", err)
	}
	defer c.Close()
	t.Logf("server %s:%d tls=%s bind=%s page size %d", profile.Host, profile.Port, profile.TLSMode, profile.BindDN, c.pageSize())

	for _, dn := range perfContainers(profile.BaseDN) {
		// The search of the listing alone: server, network and BER decoding.
		req := goldap.NewSearchRequest(dn, goldap.ScopeSingleLevel, goldap.NeverDerefAliases, 0, 0, false, "(objectClass=*)", treeChildAttrs(), nil)
		var entries []*goldap.Entry
		search := perfMedian(func() {
			err := c.read(func(conn *goldap.Conn) error {
				var err error
				entries, err = c.pagedSearch(context.Background(), conn, req, c.pageSize())
				return err
			})
			if err != nil {
				t.Fatalf("%s: %v", dn, err)
			}
		})

		var nodes []models.TreeNode
		total := perfMedian(func() {
			var err error
			nodes, err = c.GetChildren(dn)
			if err != nil {
				t.Fatalf("%s: %v", dn, err)
			}
		})
		size, encode := perfBridgeJSON(t, nodes)
		t.Logf("%-45s %6d children | search %8s | GetChildren %8s | bridge JSON %5.1f MB in %7s",
			dn, len(entries), perfMS(search), perfMS(total), float64(size)/1e6, perfMS(encode))
	}
}
