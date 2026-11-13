package services

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ldif"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// importSchema is a small OpenLDAP-like schema for the import planner.
func importSchema(serverType string) *schemaContext {
	return newSchemaContext(&models.SchemaInfo{
		Attributes: []models.SchemaAttribute{
			{Name: "objectClass"},
			{Name: "cn", Aliases: []string{"commonName"}},
			{Name: "sn", Aliases: []string{"surname"}},
			{Name: "mail", Aliases: []string{"rfc822Mailbox"}, SingleValue: serverType == models.ServerTypeAD},
			{Name: "description", Equality: "caseIgnoreMatch"},
			{Name: "ou"},
			{Name: "unicodePwd"},
			{Name: "uid"},
			{Name: "userPassword"},
			{Name: "manager", Syntax: syntaxDN},
			{Name: "member", Syntax: syntaxDN},
			{Name: "entryUUID", NoUserMod: true, Usage: "directoryOperation"},
			{Name: "createTimestamp", NoUserMod: true, Usage: "directoryOperation"},
			{Name: "structuralObjectClass", NoUserMod: true, Usage: "directoryOperation"},
			{Name: "memberOf", NoUserMod: true, Usage: "dSAOperation"},
			{Name: "pwdPolicySubentry", Usage: "directoryOperation"},
			{Name: "objectGUID", NoUserMod: true},
			{Name: "pwdLastSet"},
			{Name: "sAMAccountName"},
		},
		ObjectClasses: []models.SchemaObjectClass{
			{Name: "top", Must: []string{"objectClass"}},
			{Name: "organizationalUnit", SuperClass: []string{"top"}, Must: []string{"ou"}, May: []string{"description"}},
			{Name: "person", SuperClass: []string{"top"}, Must: []string{"cn", "sn"}, May: []string{"userPassword", "description"}},
			{Name: "inetOrgPerson", SuperClass: []string{"person"}, May: []string{"mail", "uid", "manager"}},
			{Name: "groupOfNames", SuperClass: []string{"top"}, Must: []string{"cn", "member"}},
			{Name: "user", SuperClass: []string{"person"}, May: []string{"mail", "manager", "sAMAccountName", "pwdLastSet", "objectGUID"}},
		},
	}, serverType)
}

func attrs(kv ...string) []models.LDAPAttribute {
	return entryOf("cn=x", kv...).Attributes
}

func adjustmentTexts(p ldifAddPlan) string {
	var out []string
	for _, a := range p.adjustments {
		out = append(out, a.Kind+": "+a.Text)
	}
	return strings.Join(out, "\n")
}

func sentNames(p ldifAddPlan) string {
	var out []string
	for _, a := range p.attrs {
		out = append(out, a.Name)
	}
	return strings.Join(out, ",")
}

func TestPlanLDIFAddServerAttributes(t *testing.T) {
	rec := attrs("objectClass", "inetOrgPerson", "objectClass", "nsMemberOf", "cn", "a", "sn", "A",
		"entryUUID", "8c1f5a32-0d6e-4c1e-9f7a-0123456789ab", "createTimestamp", "20200102030405Z",
		"structuralObjectClass", "inetOrgPerson", "entryCSN", "x", "memberOf", "cn=g,dc=x",
		"pwdPolicySubentry", "cn=p,dc=x", "nsUniqueId", "1-2-3-4")

	// OpenLDAP, default: every server-maintained attribute is left out.
	set := ldifImportSettings{serverType: models.ServerTypeOpenLDAP, tls: true}
	set.opts, _ = normalizeLDIFImportOptions(models.LDIFImportOptions{})
	p := planLDIFAdd(rec, set, importSchema(models.ServerTypeOpenLDAP), false, nil)
	if got := sentNames(p); got != "objectClass,cn,sn,pwdPolicySubentry" {
		t.Errorf("sent %s\n%s", got, adjustmentTexts(p))
	}
	if p.relax || len(p.errors) > 0 {
		t.Errorf("relax %v errors %v", p.relax, p.errors)
	}
	text := adjustmentTexts(p)
	for _, want := range []string{
		"serverOmitted: Left out entryUUID, createTimestamp: maintained by the server",
		"serverOmitted: Left out structuralObjectClass, entryCSN: OpenLDAP does not let an import set it",
		"serverOmitted: Left out memberOf: the server derives it",
		"serverOmitted: Left out nsUniqueId: maintained by the directory the file comes from",
		"classOmitted: Left out object class nsMemberOf: not defined in this server's schema",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in\n%s", want, text)
		}
	}

	// OpenLDAP, send: IDs and timestamps with Relax Rules, the rest still out.
	set.opts.ServerAttributes = models.LDIFImportSend
	p = planLDIFAdd(rec, set, importSchema(models.ServerTypeOpenLDAP), false, nil)
	if got := sentNames(p); got != "objectClass,cn,sn,entryUUID,createTimestamp,pwdPolicySubentry" || !p.relax {
		t.Errorf("send: sent %s relax %v\n%s", got, p.relax, adjustmentTexts(p))
	}
	if c := ldifRelaxControls(p.relax); len(c) != 1 || c[0].GetControlType() != "1.3.6.1.4.1.4203.666.5.12" {
		t.Errorf("relax controls %v", c)
	}

	// 389 DS, send: it assigns IDs and timestamps itself.
	set.serverType = models.ServerType389DS
	p = planLDIFAdd(rec, set, importSchema(models.ServerType389DS), false, nil)
	if got := sentNames(p); got != "objectClass,cn,sn,pwdPolicySubentry" || p.relax {
		t.Errorf("389ds send: sent %s relax %v", got, p.relax)
	}
	if !strings.Contains(adjustmentTexts(p), "Left out entryUUID, createTimestamp, structuralObjectClass: 389 Directory Server assigns it itself") {
		t.Errorf("389ds reasons:\n%s", adjustmentTexts(p))
	}

	// Update of an existing entry: never server attributes.
	set.serverType = models.ServerTypeOpenLDAP
	p = planLDIFAdd(rec, set, importSchema(models.ServerTypeOpenLDAP), true, nil)
	if got := sentNames(p); got != "objectClass,cn,sn,pwdPolicySubentry" || p.relax {
		t.Errorf("update: sent %s relax %v", got, p.relax)
	}
}

func TestPlanLDIFAddUnknownAndClassRules(t *testing.T) {
	sc := importSchema(models.ServerTypeOpenLDAP)
	set := ldifImportSettings{serverType: models.ServerTypeOpenLDAP, tls: true}
	set.opts, _ = normalizeLDIFImportOptions(models.LDIFImportOptions{})
	// department is unknown; uid is known but person does not allow it; the
	// alias surname is known; rfc822Mailbox is mail (not allowed by person).
	rec := attrs("objectClass", "top", "objectClass", "person", "cn", "a", "surname", "A", "department", "IT", "uid", "a", "rfc822Mailbox", "a@x")
	p := planLDIFAdd(rec, set, sc, false, nil)
	if got := sentNames(p); got != "objectClass,cn,surname" || len(p.errors) > 0 {
		t.Errorf("sent %s errors %v\n%s", got, p.errors, adjustmentTexts(p))
	}
	text := adjustmentTexts(p)
	if !strings.Contains(text, "unknownOmitted: Left out department: not defined in this server's schema") ||
		!strings.Contains(text, "unknownOmitted: Left out uid, rfc822Mailbox: not allowed by the entry's object classes (top, person)") {
		t.Errorf("adjustments:\n%s", text)
	}

	// "send": predicted errors instead.
	set.opts.UnknownSchema = models.LDIFImportSend
	p = planLDIFAdd(rec, set, sc, false, nil)
	if len(p.errors) != 3 || len(p.adjustments) != 0 {
		t.Errorf("send: errors %v adjustments %v", p.errors, p.adjustments)
	}

	// A missing MUST and an unknown structural class are predicted errors.
	set.opts.UnknownSchema = models.LDIFImportOmit
	p = planLDIFAdd(attrs("objectClass", "person", "cn", "a"), set, sc, false, nil)
	if len(p.errors) != 1 || !strings.Contains(p.errors[0], "has no sn") {
		t.Errorf("must: %v", p.errors)
	}
	p = planLDIFAdd(attrs("objectClass", "account", "cn", "a"), set, sc, false, nil)
	if len(p.errors) != 1 || !strings.Contains(p.errors[0], "none of the object classes account") {
		t.Errorf("no class: %v", p.errors)
	}

	// Without a schema nothing is left out.
	p = planLDIFAdd(rec, set, newSchemaContext(nil, models.ServerTypeOpenLDAP), false, nil)
	if got := sentNames(p); got != "objectClass,cn,surname,department,uid,rfc822Mailbox" {
		t.Errorf("no schema: sent %s", got)
	}
}

func TestPlanLDIFAddActiveDirectory(t *testing.T) {
	sc := importSchema(models.ServerTypeAD)
	set := ldifImportSettings{serverType: models.ServerTypeAD, tls: true}
	set.opts, _ = normalizeLDIFImportOptions(models.LDIFImportOptions{})
	refs := map[string]ldifRefState{"cn=boss,dc=x": ldifRefExists, "cn=gone,dc=x": ldifRefMissing, "cn=later,dc=x": ldifRefLater}
	ref := func(dn string) ldifRefState { return refs[dn] }
	rec := attrs("objectClass", "user", "cn", "a", "sn", "A", "sAMAccountName", "a", "objectGUID", "x", "pwdLastSet", "0",
		"manager", "cn=boss,dc=x", "member", "cn=gone,dc=x", "member", "cn=later,dc=x", "member", "cn=boss,dc=x", "mail", "a@x", "mail", "b@x")
	p := planLDIFAdd(rec, set, sc, false, ref)
	if got := sentNames(p); got != "objectClass,cn,sn,sAMAccountName,pwdLastSet,manager,member,mail" {
		t.Errorf("sent %s\n%s", got, adjustmentTexts(p))
	}
	for _, a := range p.attrs {
		if a.Name == "member" && strings.Join(a.Values, "|") != "cn=boss,dc=x" {
			t.Errorf("member sent %v", a.Values)
		}
	}
	if len(p.deferred) != 1 || p.deferred[0].Attribute != "member" || strings.Join(p.deferred[0].Values, "|") != "cn=later,dc=x" {
		t.Errorf("deferred %+v", p.deferred)
	}
	// mail is single-valued on AD: predicted, not adapted.
	if len(p.errors) != 1 || !strings.Contains(p.errors[0], "mail is single-valued") {
		t.Errorf("errors %v", p.errors)
	}
	text := adjustmentTexts(p)
	for _, want := range []string{
		"serverOmitted: Left out objectGUID: Active Directory assigns or maintains it itself",
		"refOmitted: Left out member value cn=gone,dc=x: the entry does not exist on this server",
		"refDeferred: member value cn=later,dc=x set at the end of the run",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in\n%s", want, text)
		}
	}
	// pwdLastSet other than 0 / -1 is left out.
	p = planLDIFAdd(attrs("objectClass", "user", "cn", "a", "pwdLastSet", "133000000000000000"), set, sc, false, ref)
	if !strings.Contains(adjustmentTexts(p), "Left out pwdLastSet: Active Directory accepts only 0") {
		t.Errorf("pwdLastSet: %s", adjustmentTexts(p))
	}
	// References to missing entries sent on request: predicted error.
	set.opts.MissingReferences = models.LDIFImportSend
	p = planLDIFAdd(attrs("objectClass", "user", "cn", "a", "manager", "cn=gone,dc=x"), set, sc, false, ref)
	if len(p.errors) != 1 || !strings.Contains(p.errors[0], "manager: cn=gone,dc=x does not exist") {
		t.Errorf("send refs: %v", p.errors)
	}
	// unicodePwd over an unencrypted connection is never sent.
	set.tls = false
	p = planLDIFAdd(attrs("objectClass", "user", "cn", "a", "unicodePwd", "Secret1!"), set, sc, false, ref)
	if !ldifUnicodePwdBlocked(p.errors) {
		t.Errorf("unicodePwd: %v", p.errors)
	}
}

func TestNormalizeLDIFImportOptions(t *testing.T) {
	o, err := normalizeLDIFImportOptions(models.LDIFImportOptions{Existing: "UPDATE"})
	if err != nil || o.Existing != "update" || o.ServerAttributes != "omit" || o.UnknownSchema != "omit" || o.MissingReferences != "omit" {
		t.Errorf("got %+v %v", o, err)
	}
	if _, err := normalizeLDIFImportOptions(models.LDIFImportOptions{ServerAttributes: "keep"}); err == nil {
		t.Error("unknown value accepted")
	}
}

// ldifPlanAll runs the simulator over content like apply does, failing the
// writes of the lines in fail, and returns "line action status" per record.
func ldifPlanAll(t *testing.T, dir entryReader, set ldifImportSettings, fail map[int]bool, lines ...string) []string {
	t.Helper()
	parsed := ldif.ParseChanges(strings.Join(lines, "\n"), ldif.ParseOptions{})
	sim := newLDIFSimulator(dir, importSchema(set.serverType), set)
	sim.prepare(parsed.Records)
	var out []string
	for i := range parsed.Records {
		rec := &parsed.Records[i]
		rp, w := sim.plan(i, rec)
		if fail[rec.Line] && w.undo != nil {
			w.undo()
		}
		if w.action == ldifWriteBlocked && w.undo != nil {
			w.undo()
		}
		out = append(out, strings.TrimSpace(fmt.Sprintf("%02d %s %s %s", rec.Line, w.action, rp.Status, strings.Join(rp.Errors, ";"))))
	}
	return out
}

func TestLDIFExistingEntries(t *testing.T) {
	dir := func() *fakeDirectory {
		return newFakeDirectory(entryOf("dc=x"), entryOf("cn=a,dc=x", "objectClass", "person", "cn", "a", "sn", "A", "description", "old"))
	}
	content := []string{
		"dn: cn=a,dc=x", // 1
		"objectClass: person",
		"objectClass: inetOrgPerson",
		"cn: a",
		"sn: A",
		"description: new",
		"entryUUID: 1",
		"",
		"dn: cn=b,dc=x", // 9
		"objectClass: person",
		"cn: b",
		"sn: B",
	}
	set := ldifImportSettings{serverType: models.ServerTypeOpenLDAP, tls: true}

	set.opts = models.LDIFImportOptions{}
	expectStatuses(t, ldifPlanAll(t, dir(), set, nil, content...), "01 skip skip", "09  ok")

	set.opts = models.LDIFImportOptions{Existing: models.LDIFExistingFail}
	expectStatuses(t, ldifPlanAll(t, dir(), set, nil, content...), "01 blocked error entry already exists", "09  ok")

	set.opts = models.LDIFImportOptions{Existing: models.LDIFExistingUpdate}
	parsed := ldif.ParseChanges(strings.Join(content, "\n"), ldif.ParseOptions{})
	sim := newLDIFSimulator(dir(), importSchema(set.serverType), set)
	sim.prepare(parsed.Records)
	rp, w := sim.plan(0, &parsed.Records[0])
	if w.action != ldifWriteUpdate || rp.Status != models.LDIFRecordOK {
		t.Fatalf("update: %s %s %v", w.action, rp.Status, rp.Errors)
	}
	var got []string
	for _, ch := range w.changes {
		got = append(got, ch.Operation+" "+ch.Attribute+"="+strings.Join(ch.Values, "|"))
	}
	if strings.Join(got, "; ") != "add objectClass=inetOrgPerson; replace description=new" {
		t.Errorf("update changes %v", got)
	}
	if !strings.Contains(adjustmentsText(rp.Adjustments), "updated with the record's attributes (2 changes)") ||
		!strings.Contains(adjustmentsText(rp.Adjustments), "Left out entryUUID: maintained by the server; an existing entry keeps its own values") {
		t.Errorf("update adjustments %s", adjustmentsText(rp.Adjustments))
	}

	// The entry has the file's values already: nothing to send.
	same := []string{"dn: cn=a,dc=x", "objectClass: person", "cn: a", "sn: A", "description: OLD"}
	expectStatuses(t, ldifPlanAll(t, dir(), set, nil, same...), "01 unchanged skip")
}

func adjustmentsText(adjs []models.LDIFAdjustment) string {
	var out []string
	for _, a := range adjs {
		out = append(out, a.Text)
	}
	return strings.Join(out, "\n")
}

func TestLDIFFailedParentBlocksChildren(t *testing.T) {
	dir := newFakeDirectory(entryOf("dc=x"))
	set := ldifImportSettings{serverType: models.ServerTypeOpenLDAP, tls: true}
	got := ldifPlanAll(t, dir, set, map[int]bool{1: true},
		"dn: ou=a,dc=x", // 1: the server refuses it
		"objectClass: organizationalUnit",
		"ou: a",
		"",
		"dn: cn=b,ou=a,dc=x", // 5
		"objectClass: person",
		"cn: b",
		"sn: B",
		"",
		"dn: cn=c,cn=b,ou=a,dc=x", // 10
		"objectClass: person",
		"cn: c",
		"sn: C",
		"",
		"dn: ou=a,dc=x", // 15
		"changetype: modify",
		"replace: description",
		"description: x",
		"",
		"dn: ou=z,dc=x", // 20
		"objectClass: organizationalUnit",
		"ou: z",
	)
	expectStatuses(t, got,
		"01  ok",
		"05 blocked error not sent: the parent entry ou=a,dc=x was not created (the add record at line 1 failed)",
		"10 blocked error not sent: the parent entry cn=b,ou=a,dc=x was not created (the add record at line 5 failed)",
		"15 blocked error not sent: the entry was not created (the add record at line 1 failed)",
		"20  ok",
	)
}

func TestLDIFDeferredReferenceDryRun(t *testing.T) {
	dir := newFakeDirectory(entryOf("DC=x"))
	set := ldifImportSettings{serverType: models.ServerTypeAD, tls: true}
	parsed := ldif.ParseChanges(strings.Join([]string{
		"dn: CN=g,DC=x",
		"objectClass: groupOfNames",
		"cn: g",
		"member: CN=u,DC=x",
		"member: CN=nobody,DC=x",
		"",
		"dn: CN=u,DC=x",
		"objectClass: person",
		"cn: u",
		"sn: U",
	}, "\n"), ldif.ParseOptions{})
	preview, _ := buildLDIFPreview(parsed, newLDIFSimulator(dir, importSchema(models.ServerTypeAD), set), nil)
	text := adjustmentsText(preview.Records[0].Adjustments)
	if !strings.Contains(text, "member value CN=u,DC=x set at the end of the run") || !strings.Contains(text, "Left out member value CN=nobody,DC=x") {
		t.Errorf("adjustments %s", text)
	}
	if len(preview.Adjustments) != 2 || preview.Adjustments[0].Records != 1 {
		t.Errorf("totals %+v", preview.Adjustments)
	}
}

func TestLDIFPreviewPaging(t *testing.T) {
	var records []models.LDIFRecordPreview
	for i := 0; i < 1000; i++ {
		st := models.LDIFRecordOK
		if i%100 == 7 {
			st = models.LDIFRecordError
		}
		records = append(records, models.LDIFRecordPreview{Index: i, Status: st})
	}
	preview := &models.LDIFPreview{Records: records}
	keepLDIFPreview("run-paging", preview, "content")
	if !preview.Partial || preview.RunID != "run-paging" {
		t.Fatalf("partial %v run %q", preview.Partial, preview.RunID)
	}
	// the first 200 of the file, the first 200 ok ones (2 more) and every error (10)
	if len(preview.Records) != 210 || preview.Records[209].Index != 907 {
		t.Fatalf("inline records %d, last %d", len(preview.Records), preview.Records[len(preview.Records)-1].Index)
	}
	svc := &ExportService{}
	page, err := svc.GetLDIFPreviewRecords("run-paging", "ok", 195, 10)
	if err != nil || page.Total != 990 || len(page.Records) != 10 || page.Records[0].Index != 197 {
		t.Fatalf("page %+v %v", page, err)
	}
	page, _ = svc.GetLDIFPreviewRecords("run-paging", "all", 995, 10)
	if page.Total != 1000 || len(page.Records) != 5 {
		t.Fatalf("all page %d of %d", len(page.Records), page.Total)
	}
	if _, err := svc.GetLDIFPreviewRecords("gone", "all", 0, 10); err == nil {
		t.Fatal("unknown run")
	}
	if c, ok := keptLDIFContent("run-paging"); !ok || c != "content" {
		t.Fatal("the newest dry run keeps its file")
	}
	small := &models.LDIFPreview{Records: records[:10]}
	keepLDIFPreview("run-small", small, "")
	if small.Partial || len(small.Records) != 10 {
		t.Fatal("a small dry run is sent whole")
	}
}

// A record waits for running writes of its own entry and its parents, not
// for unrelated ones.
func TestLDIFApplyRunWaitsForParents(t *testing.T) {
	run := newLDIFApplyRun(3, 4)
	release := make(chan struct{})
	started := make(chan struct{})
	run.dispatch("ou=A,dc=x", func() { close(started); <-release })
	<-started
	sibling := make(chan struct{})
	go func() { run.waitFor("ou=b,dc=x"); close(sibling) }()
	select {
	case <-sibling:
	case <-time.After(2 * time.Second):
		t.Fatal("an unrelated record waited")
	}
	child := make(chan struct{})
	go func() { run.waitFor("cn=c,ou=a,dc=X"); close(child) }()
	select {
	case <-child:
		t.Fatal("the child did not wait for its parent")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case <-child:
	case <-time.After(2 * time.Second):
		t.Fatal("the child kept waiting")
	}
	run.waitAll()
}
