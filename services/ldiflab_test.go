//go:build ldiflab

package services

// LDIF export / import against the test lab (docker/README.md). Not part of
// the normal test run:
//
//	go test -tags ldiflab -run TestLDIFLab -v ./services
//
// Every run creates its own OU (ou=ldif-ie-<pid> / OU=ldif-ie-<pid>) below
// each server's base, imports into it and deletes it again.

import (
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

type labServer struct {
	key     string
	profile models.ConnectionProfile
	base    string
	// sample is the container exported as test data.
	sample string
}

func labServers() []labServer {
	return []labServer{
		{key: "ol", base: "dc=demo,dc=ldapilot,dc=local", sample: "ou=IT,ou=People,dc=demo,dc=ldapilot,dc=local",
			profile: models.ConnectionProfile{ID: "lab-ol", Name: "lab-ol", Host: "127.0.0.1", Port: 389, BaseDN: "dc=demo,dc=ldapilot,dc=local",
				AuthMethod: models.AuthSimple, BindDN: "cn=admin,dc=demo,dc=ldapilot,dc=local", Password: "admin",
				TLSMode: models.TLSStartTLS, TLSSkipVerify: true, PageSize: 500, Timeout: 60}},
		{key: "ds", base: "dc=dirsrv,dc=ldapilot,dc=lab", sample: "ou=IT,ou=People,dc=dirsrv,dc=ldapilot,dc=lab",
			profile: models.ConnectionProfile{ID: "lab-ds", Name: "lab-ds", Host: "127.0.0.1", Port: 4389, BaseDN: "dc=dirsrv,dc=ldapilot,dc=lab",
				AuthMethod: models.AuthSimple, BindDN: "cn=Directory Manager", Password: "Admin12345",
				TLSMode: models.TLSStartTLS, TLSSkipVerify: true, PageSize: 500, Timeout: 60}},
		{key: "ad", base: "DC=ad,DC=ldapilot,DC=lab", sample: "OU=Hamburg,OU=Users,OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab",
			profile: models.ConnectionProfile{ID: "lab-ad", Name: "lab-ad", Host: "127.0.0.1", Port: 2636, BaseDN: "DC=ad,DC=ldapilot,DC=lab",
				AuthMethod: models.AuthSimple, BindDN: "Administrator@ad.ldapilot.lab", Password: "LDAPilot!2026",
				TLSMode: models.TLSSSL, TLSSkipVerify: true, PageSize: 500, Timeout: 60}},
	}
}

// labRebase moves the DNs of an exported container below newParent (the
// sample container itself becomes newParent's child). Plain text replace of
// the old parent DN (case-insensitive), like the dialog's Rebase DNs.
func labRebase(content, oldParent, newParent string) string {
	lower := strings.ToLower(content)
	old := strings.ToLower(oldParent)
	var b strings.Builder
	i := 0
	for {
		j := strings.Index(lower[i:], old)
		if j < 0 {
			b.WriteString(content[i:])
			return b.String()
		}
		b.WriteString(content[i : i+j])
		b.WriteString(newParent)
		i += j + len(old)
	}
}

func labOU(srv labServer) string {
	if srv.key == "ad" {
		return fmt.Sprintf("OU=ldif-ie-%d,OU=LDAPilot,%s", os.Getpid(), srv.base)
	}
	return fmt.Sprintf("ou=ldif-ie-%d,%s", os.Getpid(), srv.base)
}

func labDeleteSubtree(t *testing.T, c *ldap.Client, dn string) {
	res, err := c.Search(models.SearchParams{BaseDN: dn, Scope: models.ScopeSub, Filter: "(objectClass=*)", Attributes: []string{"1.1"}})
	if err != nil {
		t.Logf("cleanup search %s: %v", dn, err)
		return
	}
	dns := make([]string, 0, len(res.Entries))
	for _, e := range res.Entries {
		dns = append(dns, e.DN)
	}
	sort.Slice(dns, func(a, b int) bool { return strings.Count(dns[a], ",") > strings.Count(dns[b], ",") })
	for _, d := range dns {
		if err := c.DeleteEntry(d); err != nil {
			t.Logf("cleanup delete %s: %v", d, err)
		}
	}
}

func labParent(dn string) string {
	_, p := splitRDN(dn)
	return p
}

// labReport prints a preview and an apply result compactly.
func labReport(t *testing.T, title string, prev *models.LDIFPreview, res *models.BulkApplyResult) {
	t.Logf("==== %s", title)
	if prev != nil {
		t.Logf("dry run: total %d byStatus %v", prev.Total, prev.ByStatus)
		for _, a := range prev.Adjustments {
			t.Logf("   ADJ %-15s %-24s %3d records: %s", a.Kind, a.Attribute, a.Records, a.Reason)
		}
		for _, n := range prev.Notes {
			t.Logf("   NOTE %s", n)
		}
		seen := map[string]int{}
		for _, r := range prev.Records {
			for _, e := range r.Errors {
				seen["E "+e]++
			}
			for _, w := range r.Warnings {
				seen["W "+w]++
			}
		}
		keys := make([]string, 0, len(seen))
		for k := range seen {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			t.Logf("   %3dx %s", seen[k], k)
		}
	}
	if res != nil {
		t.Logf("apply: total %d ok %d failed %d notProcessed %d stopped=%v %s", res.Total, res.Succeeded, res.Failed, res.NotProcessed, res.Stopped, res.StopReason)
		seen := map[string]int{}
		for _, it := range res.Items {
			if it.Status != models.BulkResultSuccess {
				seen[it.Status+": "+it.Message]++
			}
		}
		for k, n := range seen {
			t.Logf("   %3dx FAILED %s", n, k)
		}
	}
}

// labImportOptions are the import options of LDIFLAB_IMPORT
// ("serverAttributes=send,existing=update").
func labImportOptions() models.LDIFImportOptions {
	var o models.LDIFImportOptions
	for _, kv := range strings.Split(os.Getenv("LDIFLAB_IMPORT"), ",") {
		k, v, _ := strings.Cut(kv, "=")
		switch k {
		case "serverAttributes":
			o.ServerAttributes = v
		case "unknownSchema":
			o.UnknownSchema = v
		case "missingReferences":
			o.MissingReferences = v
		case "existing":
			o.Existing = v
		}
	}
	return o
}

func TestLDIFLabRepro(t *testing.T) {
	pool := ldap.NewPool()
	svc := NewExportService(pool)
	servers := labServers()
	for _, srv := range servers {
		if err := pool.Connect(srv.profile); err != nil {
			t.Fatalf("connect %s: %v", srv.key, err)
		}
		defer pool.Disconnect(srv.profile.ID)
	}
	// own OU per server
	for _, srv := range servers {
		c, _ := pool.Get(srv.profile.ID)
		ou := labOU(srv)
		rdn := strings.SplitN(strings.SplitN(ou, ",", 2)[0], "=", 2)[1]
		if err := c.AddEntry(ou, []models.LDAPAttribute{{Name: "objectClass", Values: []string{"top", "organizationalUnit"}}, {Name: "ou", Values: []string{rdn}}}); err != nil {
			t.Fatalf("create %s: %v", ou, err)
		}
		defer labDeleteSubtree(t, c, ou)
	}

	exports := map[string]string{}
	for _, src := range servers {
		for _, imp := range []bool{true, false} {
			res, err := svc.Export(src.profile.ID, models.ExportRequest{Format: "ldif", BaseDN: src.sample, Scope: models.ScopeSub, Importable: imp})
			if err != nil {
				t.Fatalf("export %s: %v", src.key, err)
			}
			exports[fmt.Sprintf("%s-imp=%v", src.key, imp)] = res.Content
			t.Logf("export %s importable=%v: %d entries, %d bytes", src.key, imp, res.Count, len(res.Content))
		}
	}
	if out := os.Getenv("LDIFLAB_DUMP"); out != "" {
		for k, v := range exports {
			_ = os.WriteFile(out+"/"+k+".ldif", []byte(v), 0o600)
		}
	}
	// slapcat style file of the OpenLDAP sample (read-only slapcat in the container).
	if raw, err := exec.Command("sudo", "-n", "docker", "exec", "ldapilot-openldap", "slapcat", "-b", servers[0].base,
		"-a", "(entryDN:dnSubtreeMatch:="+servers[0].sample+")").Output(); err == nil {
		exports["ol-slapcat"] = string(raw)
	} else {
		t.Logf("slapcat: %v", err)
	}

	for name, content := range exports {
		srcKey := strings.SplitN(name, "-", 2)[0]
		var src labServer
		for _, s := range servers {
			if s.key == srcKey {
				src = s
			}
		}
		for _, dst := range servers {
			target := labOU(dst)
			sub := fmt.Sprintf("ou=%s", strings.ReplaceAll(name, "=", ""))
			if dst.key == "ad" {
				sub = "OU=" + strings.ReplaceAll(name, "=", "")
			}
			c, _ := pool.Get(dst.profile.ID)
			if err := c.AddEntry(sub+","+target, []models.LDAPAttribute{{Name: "objectClass", Values: []string{"top", "organizationalUnit"}}, {Name: "ou", Values: []string{strings.ReplaceAll(name, "=", "")}}}); err != nil {
				t.Fatalf("create %s: %v", sub, err)
			}
			text := labRebase(content, labParent(src.sample), sub+","+target)
			opts := models.BulkOptions{ContinueOnError: true, Import: labImportOptions()}
			prev, err := svc.PreviewLDIFChanges(dst.profile.ID, text, opts)
			if err != nil {
				t.Logf("==== %s -> %s: preview error %v", name, dst.key, err)
				continue
			}
			res, err := svc.ApplyLDIFChanges(dst.profile.ID, text, opts)
			if err != nil {
				t.Logf("==== %s -> %s: apply error %v", name, dst.key, err)
				labReport(t, name+" -> "+dst.key, prev, nil)
				continue
			}
			labReport(t, name+" -> "+dst.key, prev, res)
		}
	}
}

// TestLDIFLabProbe adds one entry per server-maintained attribute (with and
// without the Relax Rules control) and reports what each server does.
func TestLDIFLabProbe(t *testing.T) {
	pool := ldap.NewPool()
	now := "20200102030405Z"
	type probe struct {
		attr  string
		value func(dn string) string
	}
	fixed := func(v string) func(string) string { return func(string) string { return v } }
	probes := map[string][]probe{
		"ol": {
			{"entryUUID", fixed("8c1f5a32-0d6e-4c1e-9f7a-0123456789ab")}, {"entryCSN", fixed("20200102030405.000000Z#000000#000#000000")},
			{"createTimestamp", fixed(now)}, {"creatorsName", fixed("cn=admin,dc=demo,dc=ldapilot,dc=local")},
			{"modifyTimestamp", fixed(now)}, {"modifiersName", fixed("cn=admin,dc=demo,dc=ldapilot,dc=local")},
			{"structuralObjectClass", fixed("person")}, {"entryDN", func(dn string) string { return dn }},
			{"hasSubordinates", fixed("FALSE")}, {"subschemaSubentry", fixed("cn=Subschema")},
			{"pwdChangedTime", fixed(now)}, {"pwdHistory", fixed(now + "#1.3.6.1.4.1.1466.115.121.1.40#38#{SSHA}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")},
			{"pwdFailureTime", fixed(now)}, {"pwdAccountLockedTime", fixed("000001010000Z")}, {"pwdGraceUseTime", fixed(now)},
			{"pwdReset", fixed("TRUE")}, {"pwdPolicySubentry", fixed("cn=default-ppolicy,ou=Policies,dc=demo,dc=ldapilot,dc=local")},
			{"memberOf", fixed("cn=it-infrastructure,ou=Teams,ou=Groups,dc=demo,dc=ldapilot,dc=local")},
			{"userPassword", fixed("{SSHA}Y8H34s/kg8wrhkNwYMi//0izXuD2OoUq")},
		},
		"ds": {
			{"nsUniqueId", fixed("11111111-22222222-33333333-44444444")}, {"entryUUID", fixed("8c1f5a32-0d6e-4c1e-9f7a-0123456789ab")},
			{"createTimestamp", fixed(now)}, {"creatorsName", fixed("cn=directory manager")},
			{"modifyTimestamp", fixed(now)}, {"modifiersName", fixed("cn=directory manager")},
			{"entryid", fixed("99999")}, {"parentid", fixed("2")}, {"numSubordinates", fixed("0")},
			{"dsEntryDN", func(dn string) string { return dn }}, {"entrydn", func(dn string) string { return strings.ToLower(dn) }},
			{"passwordExpirationTime", fixed("19700101000000Z")}, {"passwordHistory", fixed(now + "{SSHA}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")},
			{"passwordRetryCount", fixed("1")}, {"accountUnlockTime", fixed(now)}, {"nsAccountLock", fixed("true")},
			{"nsRoleDN", fixed("cn=managed-role,dc=dirsrv,dc=ldapilot,dc=lab")}, {"nsRole", fixed("cn=managed-role,dc=dirsrv,dc=ldapilot,dc=lab")},
			{"memberOf", fixed("cn=it-infrastructure,ou=Teams,ou=Groups,dc=dirsrv,dc=ldapilot,dc=lab")},
			{"pwdHistory", fixed(now + "#1.3.6.1.4.1.1466.115.121.1.40#38#{SSHA}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")},
			{"userPassword", fixed("{PBKDF2-SHA512}100000$KVCzb2PcOSxs90z1EPw9r63HpKDQgZ6D$5bEClGubdwlQ8zLTxiAs1Lrm653IuWfCvO18BJ18dmHxnw7UQrAIYW/D3BAcrJ5HQ161glhiPrvvmrcJMQDQRQ==")},
		},
		"ad": {
			{"objectGUID", fixed("8c1f5a32-0d6e-4c1e-9f7a-0123456789ab")}, {"whenCreated", fixed("20200102030405.0Z")},
			{"whenChanged", fixed("20200102030405.0Z")}, {"uSNCreated", fixed("12345")}, {"uSNChanged", fixed("12345")},
			{"instanceType", fixed("4")}, {"distinguishedName", func(dn string) string { return dn }}, {"name", fixed("probe")},
			{"objectCategory", fixed("CN=Person,CN=Schema,CN=Configuration,DC=ad,DC=ldapilot,DC=lab")},
			{"dSCorePropagationData", fixed("16010101000000.0Z")}, {"memberOf", fixed("CN=Domain Users,CN=Users,DC=ad,DC=ldapilot,DC=lab")},
			{"isCriticalSystemObject", fixed("FALSE")}, {"showInAdvancedViewOnly", fixed("FALSE")},
		},
	}
	for _, srv := range labServers() {
		if err := pool.Connect(srv.profile); err != nil {
			t.Fatalf("connect %s: %v", srv.key, err)
		}
		c, _ := pool.Get(srv.profile.ID)
		ou := labOU(srv)
		rdn := strings.SplitN(strings.SplitN(ou, ",", 2)[0], "=", 2)[1]
		if err := c.AddEntry(ou, []models.LDAPAttribute{{Name: "objectClass", Values: []string{"top", "organizationalUnit"}}, {Name: "ou", Values: []string{rdn}}}); err != nil {
			t.Fatalf("create %s: %v", ou, err)
		}
		for i, p := range probes[srv.key] {
			for _, relax := range []bool{false, true} {
				if relax && srv.key == "ad" && p.attr != "objectGUID" {
					continue
				}
				dn := fmt.Sprintf("cn=probe%d-%v,%s", i, relax, ou)
				attrs := []models.LDAPAttribute{{Name: "objectClass", Values: []string{"top", "person"}}, {Name: "cn", Values: []string{fmt.Sprintf("probe%d-%v", i, relax)}}, {Name: "sn", Values: []string{"probe"}}}
				if srv.key == "ad" {
					attrs[0].Values = []string{"top", "contact"}
					attrs = attrs[:2]
				}
				attrs = append(attrs, models.LDAPAttribute{Name: p.attr, Values: []string{p.value(dn)}})
				var err error
				if relax {
					_, err = c.AddEntryWithPasswordPolicy(dn, attrs, models.PasswordWriteOptions{AsIs: true}, goldap.NewControlString(ldap.RelaxRulesOID, true, ""))
				} else {
					_, err = c.AddEntryWithPasswordPolicy(dn, attrs, models.PasswordWriteOptions{AsIs: true})
				}
				stored := ""
				if err == nil {
					if e, rerr := c.ReadAttributes(dn, []string{p.attr}); rerr == nil {
						for _, a := range e {
							stored += strings.Join(a.Values, "|")
						}
					}
				}
				t.Logf("%s %-24s relax=%-5v -> %v stored=%q", srv.key, p.attr, relax, err, stored)
			}
		}
		labDeleteSubtree(t, c, ou)
		pool.Disconnect(srv.profile.ID)
	}
}

// TestLDIFLabProbeAD checks user adds on Samba AD.
func TestLDIFLabProbeAD(t *testing.T) {
	pool := ldap.NewPool()
	srv := labServers()[2]
	if err := pool.Connect(srv.profile); err != nil {
		t.Fatal(err)
	}
	c, _ := pool.Get(srv.profile.ID)
	ou := labOU(srv)
	rdn := strings.SplitN(strings.SplitN(ou, ",", 2)[0], "=", 2)[1]
	if err := c.AddEntry(ou, []models.LDAPAttribute{{Name: "objectClass", Values: []string{"top", "organizationalUnit"}}, {Name: "ou", Values: []string{rdn}}}); err != nil {
		t.Fatal(err)
	}
	defer labDeleteSubtree(t, c, ou)
	src, err := c.GetEntry("CN=Ana Wagner,OU=Hamburg,OU=Users,OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab")
	if err != nil {
		t.Fatal(err)
	}
	raw := func(name string) models.LDAPAttribute {
		for _, a := range src.Attributes {
			if strings.EqualFold(a.Name, name) {
				return ldap.RawADValues(a)
			}
		}
		return models.LDAPAttribute{}
	}
	cases := []struct {
		name  string
		extra []models.LDAPAttribute
		ctl   []goldap.Control
	}{
		{"plain 512 no password", []models.LDAPAttribute{{Name: "userAccountControl", Values: []string{"512"}}}, nil},
		{"plain 514 no password", []models.LDAPAttribute{{Name: "userAccountControl", Values: []string{"514"}}}, nil},
		{"512 + unicodePwd", []models.LDAPAttribute{{Name: "userAccountControl", Values: []string{"512"}}, {Name: "unicodePwd", Values: []string{"Passw0rd!2026x"}}}, nil},
		{"objectGUID raw", []models.LDAPAttribute{raw("objectGUID")}, nil},
		{"objectGUID raw + relax", []models.LDAPAttribute{raw("objectGUID")}, []goldap.Control{goldap.NewControlString(ldap.RelaxRulesOID, false, "")}},
		{"objectGUID raw + relax critical", []models.LDAPAttribute{raw("objectGUID")}, []goldap.Control{goldap.NewControlString(ldap.RelaxRulesOID, true, "")}},
		{"objectSid raw", []models.LDAPAttribute{raw("objectSid")}, nil},
		{"pwdLastSet 0", []models.LDAPAttribute{{Name: "pwdLastSet", Values: []string{"0"}}}, nil},
		{"pwdLastSet old", []models.LDAPAttribute{raw("pwdLastSet")}, nil},
		{"primaryGroupID 513", []models.LDAPAttribute{{Name: "primaryGroupID", Values: []string{"513"}}}, nil},
		{"nTSecurityDescriptor", []models.LDAPAttribute{raw("nTSecurityDescriptor")}, nil},
		{"sAMAccountType", []models.LDAPAttribute{raw("sAMAccountType")}, nil},
		{"badPwdCount", []models.LDAPAttribute{{Name: "badPwdCount", Values: []string{"0"}}}, nil},
		{"lastLogon", []models.LDAPAttribute{{Name: "lastLogon", Values: []string{"0"}}}, nil},
		{"logonCount", []models.LDAPAttribute{{Name: "logonCount", Values: []string{"0"}}}, nil},
		{"lockoutTime 0", []models.LDAPAttribute{{Name: "lockoutTime", Values: []string{"0"}}}, nil},
		{"directReports", []models.LDAPAttribute{{Name: "directReports", Values: []string{src.DN}}}, nil},
		{"manager existing", []models.LDAPAttribute{{Name: "manager", Values: []string{src.DN}}}, nil},
		{"manager missing", []models.LDAPAttribute{{Name: "manager", Values: []string{"CN=Nobody,OU=Hamburg,OU=Users,OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab"}}}, nil},
		{"userPassword ssha", []models.LDAPAttribute{{Name: "userPassword", Values: []string{"{SSHA}Y8H34s/kg8wrhkNwYMi//0izXuD2OoUq"}}}, nil},
	}
	for i, cs := range cases {
		dn := fmt.Sprintf("CN=probe-ad-%d,%s", i, ou)
		attrs := []models.LDAPAttribute{{Name: "objectClass", Values: []string{"top", "person", "organizationalPerson", "user"}},
			{Name: "cn", Values: []string{fmt.Sprintf("probe-ad-%d", i)}}, {Name: "sAMAccountName", Values: []string{fmt.Sprintf("probe-ad-%d-%d", os.Getpid()%1000, i)}}}
		attrs = append(attrs, cs.extra...)
		_, err := c.AddEntryWithPasswordPolicy(dn, attrs, models.PasswordWriteOptions{AsIs: true}, cs.ctl...)
		uac := ""
		if err == nil {
			if e, rerr := c.ReadAttributes(dn, []string{"userAccountControl", "objectGUID"}); rerr == nil {
				uac = fmt.Sprint(e["userAccountControl"].Values)
			}
		}
		t.Logf("ad %-32s -> %v uac=%s", cs.name, err, uac)
	}
	ex, _ := c.ServerInfo()
	t.Logf("supportedControl: %v", ex.SupportedControls)
}

// TestLDIFLabOptions checks "send server-maintained attributes", "update"
// and "skip" against the lab: an export of the sample re-imported into an
// own OU, then changed and imported again.
func TestLDIFLabOptions(t *testing.T) {
	pool := ldap.NewPool()
	svc := NewExportService(pool)
	for _, srv := range labServers() {
		if err := pool.Connect(srv.profile); err != nil {
			t.Fatal(err)
		}
		c, _ := pool.Get(srv.profile.ID)
		ou := labOU(srv)
		rdn := strings.SplitN(strings.SplitN(ou, ",", 2)[0], "=", 2)[1]
		if err := c.AddEntry(ou, []models.LDAPAttribute{{Name: "objectClass", Values: []string{"top", "organizationalUnit"}}, {Name: "ou", Values: []string{rdn}}}); err != nil {
			t.Fatal(err)
		}
		exp, err := svc.Export(srv.profile.ID, models.ExportRequest{Format: "ldif", BaseDN: srv.sample, Scope: models.ScopeSub})
		if err != nil {
			t.Fatal(err)
		}
		text := labRebase(exp.Content, labParent(srv.sample), ou)
		run := func(name string, o models.LDIFImportOptions, content string) {
			opts := models.BulkOptions{ContinueOnError: true, Import: o}
			prev, err := svc.PreviewLDIFChanges(srv.profile.ID, content, opts)
			if err != nil {
				t.Fatalf("%s preview: %v", name, err)
			}
			res, err := svc.ApplyLDIFChanges(srv.profile.ID, content, opts)
			if err != nil {
				t.Fatalf("%s apply: %v", name, err)
			}
			labReport(t, srv.key+": "+name, prev, res)
		}
		run("send", models.LDIFImportOptions{ServerAttributes: models.LDIFImportSend}, text)
		// read back IDs and timestamps of the first user
		src, _ := c.ReadAttributes(srv.sample, []string{"entryUUID", "createTimestamp", "creatorsName", "nsUniqueId", "whenCreated", "objectGUID"})
		dst, _ := c.ReadAttributes(labRebase(srv.sample, labParent(srv.sample), ou), []string{"entryUUID", "createTimestamp", "creatorsName", "nsUniqueId", "whenCreated", "objectGUID"})
		for _, n := range []string{"entryUUID", "createTimestamp", "creatorsName", "nsUniqueId", "whenCreated", "objectGUID"} {
			if a, ok := src[strings.ToLower(n)]; ok {
				t.Logf("%s %s: source %v  imported %v", srv.key, n, a.Values, dst[strings.ToLower(n)].Values)
			}
		}
		run("again (skip)", models.LDIFImportOptions{}, text)
		changed := strings.Replace(text, "\ndescription: ", "\ndescription: CHANGED ", 1)
		run("changed (update)", models.LDIFImportOptions{Existing: models.LDIFExistingUpdate}, changed)
		run("again (update, no change)", models.LDIFImportOptions{Existing: models.LDIFExistingUpdate}, changed)
		run("again (fail)", models.LDIFImportOptions{Existing: models.LDIFExistingFail}, changed)
		labDeleteSubtree(t, c, ou)
		pool.Disconnect(srv.profile.ID)
	}
}

// TestLDIFLabRestore: own users, a group and a manager reference are
// exported (not importable, so with every operational attribute), deleted
// and imported again with the default options.
func TestLDIFLabRestore(t *testing.T) {
	pool := ldap.NewPool()
	svc := NewExportService(pool)
	profiles := labServers()
	// plain LDAP to Samba as a fourth target (unicodePwd refused before sending)
	plainAD := profiles[2]
	plainAD.key = "ad-plain"
	plainAD.profile.ID, plainAD.profile.Port, plainAD.profile.TLSMode = "lab-ad-plain", 2389, models.TLSNone
	for _, srv := range append(profiles, plainAD) {
		if err := pool.Connect(srv.profile); err != nil {
			t.Fatal(err)
		}
		c, _ := pool.Get(srv.profile.ID)
		ou := labOU(srv)
		if srv.key == "ad-plain" {
			ou = strings.Replace(ou, "ldif-ie-", "ldif-ie-plain-", 1)
		}
		rdn := strings.SplitN(strings.SplitN(ou, ",", 2)[0], "=", 2)[1]
		if err := c.AddEntry(ou, []models.LDAPAttribute{{Name: "objectClass", Values: []string{"top", "organizationalUnit"}}, {Name: "ou", Values: []string{rdn}}}); err != nil {
			t.Fatal(err)
		}
		pid := os.Getpid() % 100000
		var users []string
		for i := 0; i < 3; i++ {
			name := fmt.Sprintf("rst%d-%d", pid, i)
			var dn string
			var attrs []models.LDAPAttribute
			if strings.HasPrefix(srv.key, "ad") {
				dn = "CN=" + name + "," + ou
				attrs = []models.LDAPAttribute{{Name: "objectClass", Values: []string{"top", "person", "organizationalPerson", "user"}}, {Name: "cn", Values: []string{name}},
					{Name: "sAMAccountName", Values: []string{name}}, {Name: "userAccountControl", Values: []string{"514"}}, {Name: "description", Values: []string{"restore test"}}}
			} else {
				dn = "uid=" + name + "," + ou
				attrs = []models.LDAPAttribute{{Name: "objectClass", Values: []string{"top", "person", "organizationalPerson", "inetOrgPerson"}}, {Name: "uid", Values: []string{name}},
					{Name: "cn", Values: []string{name}}, {Name: "sn", Values: []string{"Restore"}}, {Name: "userPassword", Values: []string{"{SSHA}Y8H34s/kg8wrhkNwYMi//0izXuD2OoUq"}}}
			}
			if i > 0 {
				attrs = append(attrs, models.LDAPAttribute{Name: "manager", Values: []string{users[0]}})
			}
			if _, err := c.AddEntryWithPasswordPolicy(dn, attrs, models.PasswordWriteOptions{AsIs: true}); err != nil {
				t.Fatalf("%s create %s: %v", srv.key, dn, err)
			}
			users = append(users, dn)
		}
		grp := []models.LDAPAttribute{{Name: "objectClass", Values: []string{"top", "groupOfNames"}}, {Name: "cn", Values: []string{"rstgroup"}}, {Name: "member", Values: users}}
		gdn := "cn=rstgroup," + ou
		if strings.HasPrefix(srv.key, "ad") {
			gdn = "CN=rstgroup," + ou
			grp = []models.LDAPAttribute{{Name: "objectClass", Values: []string{"top", "group"}}, {Name: "cn", Values: []string{"rstgroup"}},
				{Name: "sAMAccountName", Values: []string{fmt.Sprintf("rstgrp%d", pid)}}, {Name: "member", Values: users}}
		}
		if err := c.AddEntry(gdn, grp); err != nil {
			t.Fatalf("%s group: %v", srv.key, err)
		}
		exp, err := svc.Export(srv.profile.ID, models.ExportRequest{Format: "ldif", BaseDN: ou, Scope: models.ScopeOne})
		if err != nil {
			t.Fatal(err)
		}
		content := exp.Content
		if srv.key == "ad-plain" {
			content = strings.Replace(content, "\nsAMAccountName: "+fmt.Sprintf("rst%d-1", pid), "\nunicodePwd: Passw0rd!2026x\nsAMAccountName: "+fmt.Sprintf("rst%d-1", pid), 1)
		}
		// The group first (as other tools write it): its members come later.
		recs := strings.Split(strings.TrimSpace(content), "\n\n")
		for i, r := range recs {
			if i > 1 && strings.Contains(strings.SplitN(r, "\n", 2)[0], "rstgroup") {
				recs = append(recs[:1], append([]string{r}, append(recs[1:i], recs[i+1:]...)...)...)
				break
			}
		}
		content = strings.Join(recs, "\n\n") + "\n"
		t.Logf("%s first record: %s", srv.key, strings.SplitN(recs[1], "\n", 2)[0])
		// delete the children, then restore
		for _, d := range append([]string{gdn}, users...) {
			if err := c.DeleteEntry(d); err != nil {
				t.Fatalf("delete %s: %v", d, err)
			}
		}
		opts := models.BulkOptions{ContinueOnError: true}
		prev, err := svc.PreviewLDIFChanges(srv.profile.ID, content, opts)
		if err != nil {
			t.Fatal(err)
		}
		res, err := svc.ApplyLDIFChanges(srv.profile.ID, content, opts)
		if err != nil {
			t.Fatal(err)
		}
		labReport(t, srv.key+": restore of "+fmt.Sprint(exp.Count)+" entries", prev, res)
		if g, err := c.ReadAttributes(gdn, []string{"member"}); err == nil {
			t.Logf("%s group members after restore: %d", srv.key, len(g["member"].Values))
		}
		if m, err := c.ReadAttributes(users[1], []string{"manager", "userPassword"}); err == nil {
			t.Logf("%s user 1 after restore: manager %v userPassword %v", srv.key, m["manager"].Values, m["userpassword"].Values)
		}
		labDeleteSubtree(t, c, ou)
		pool.Disconnect(srv.profile.ID)
	}
}
