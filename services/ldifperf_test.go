//go:build ldiflab

package services

// Timings of LDIF export and import with many entries (docs/ldif-import-export-notes.md):
// the large lab OpenLDAP (ldapilot-openldap-perf, 10389) as the source and a
// throwaway, empty OpenLDAP with the same base as the target, e.g.
//
//	sudo -n docker run -d --name ldifie-perf-ol -p 127.0.0.1:11389:389 -e LDAP_ORGANISATION=perf \
//	  -e LDAP_DOMAIN=perf.ldapilot.lab -e LDAP_ADMIN_PASSWORD=admin -e LDAP_TLS=false osixia/openldap:1.5.0
//	LDIFPERF_N=10000 go test -tags ldiflab -run TestLDIFPerf -v ./services

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// TestLDIFPerf measures an export from the large lab OpenLDAP and the dry
// run and apply of that file on a throwaway OpenLDAP (LDIFPERF_TARGET_PORT,
// same base, empty). LDIFPERF_N: 10000 or 100000. LDIFPERF_PHASES:
// "export,preview,apply" (default all).
func TestLDIFPerf(t *testing.T) {
	n := os.Getenv("LDIFPERF_N")
	if n == "" {
		n = "10000"
	}
	phases := os.Getenv("LDIFPERF_PHASES")
	if phases == "" {
		phases = "export,preview,apply"
	}
	base := "dc=perf,dc=ldapilot,dc=lab"
	src := models.ConnectionProfile{ID: "perf-src", Name: "perf-src", Host: "127.0.0.1", Port: 10389, BaseDN: base, AuthMethod: models.AuthSimple,
		BindDN: "cn=admin," + base, Password: "admin", TLSMode: models.TLSNone, PageSize: 500, Timeout: 120}
	dst := src
	dst.ID, dst.Name, dst.Port = "perf-dst", "perf-dst", 11389
	if p := os.Getenv("LDIFPERF_TARGET_PORT"); p != "" {
		fmt.Sscan(p, &dst.Port)
	}
	pool := ldap.NewPool()
	for _, p := range []models.ConnectionProfile{src, dst} {
		if err := pool.Connect(p); err != nil {
			t.Fatal(err)
		}
	}
	svc := NewExportService(pool)
	if os.Getenv("LDIFPERF_NOAUDIT") == "" {
		svc.SetAuditStore(config.NewAuditStore())
	}
	req := models.ExportRequest{Format: "ldif", BaseDN: "ou=People," + base, Scope: models.ScopeSub, Importable: true}
	if n == "10000" {
		req.Filter = "(employeeNumber=00*)"
	}
	file := os.Getenv("LDIFPERF_FILE")
	ms := func(d time.Duration) string { return fmt.Sprintf("%.2f s", d.Seconds()) }
	var content string
	if strings.Contains(phases, "export") {
		c, _ := pool.Get(src.ID)
		start := time.Now()
		res, err := c.Search(models.SearchParams{BaseDN: req.BaseDN, Scope: req.Scope, Filter: "(&" + strings.TrimSuffix(strings.TrimPrefix(orAll(req.Filter), ""), "") + ")", Attributes: []string{"*", "+"}})
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("export: Go search alone %s (%d entries)", ms(time.Since(start)), len(res.Entries))
		start = time.Now()
		exp, err := svc.Export(src.ID, req)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("export: ExportService.Export %s (%d entries, %d bytes)", ms(time.Since(start)), exp.Count, len(exp.Content))
		start = time.Now()
		js, _ := json.Marshal(exp)
		t.Logf("export: result as JSON for the bridge %s (%d bytes)", ms(time.Since(start)), len(js))
		content = exp.Content
		if file != "" {
			_ = os.WriteFile(file, []byte(content), 0o600)
		}
		if os.Getenv("LDIFPERF_TOFILE") != "" {
			start = time.Now()
			fr, err := exportToPath(c, req, file+".direct")
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("export: straight to the file %s (%d entries, %d bytes)", ms(time.Since(start)), fr.Count, fr.Bytes)
			start = time.Now()
			pv, err := svc.Export(src.ID, models.ExportRequest{Format: req.Format, BaseDN: req.BaseDN, Scope: req.Scope, Filter: req.Filter, Importable: true, Limit: 200})
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("export: preview of the first %d entries %s (%d bytes)", pv.Count, ms(time.Since(start)), len(pv.Content))
		}
	} else {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		content = string(data)
	}
	if !strings.Contains(content, "\ndn: ou=People,") {
		content = strings.Replace(content, "version: 1\n", "version: 1\n\ndn: ou=People,"+base+"\nobjectClass: organizationalUnit\nou: People\n", 1)
	}
	opts := models.BulkOptions{ContinueOnError: true, RunID: os.Getenv("LDIFPERF_RUNID")}
	if strings.Contains(phases, "preview") {
		start := time.Now()
		prev, err := svc.PreviewLDIFChanges(dst.ID, content, opts)
		if err != nil {
			t.Fatal(err)
		}
		d := time.Since(start)
		start = time.Now()
		js, _ := json.Marshal(prev)
		t.Logf("dry run: %s for %d records %v; JSON %s (%d bytes)", ms(d), prev.Total, prev.ByStatus, ms(time.Since(start)), len(js))
	}
	if strings.Contains(phases, "apply") {
		start := time.Now()
		res, err := svc.ApplyLDIFChanges(dst.ID, content, opts)
		if err != nil {
			t.Fatal(err)
		}
		d := time.Since(start)
		start = time.Now()
		js, _ := json.Marshal(res)
		t.Logf("apply: %s for %d records (ok %d, failed %d, skipped %d); JSON %s (%d bytes)", ms(d), res.Total, res.Succeeded, res.Failed, res.Skipped, ms(time.Since(start)), len(js))
	}
}

func orAll(f string) string {
	if f == "" {
		return "(objectClass=*)"
	}
	return f
}
