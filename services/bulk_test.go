package services

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/ldif"
	"github.com/dpicillo/LDAPilot/internal/models"
)

func entryOf(dn string, kv ...string) *models.LDAPEntry {
	e := &models.LDAPEntry{DN: dn}
	idx := map[string]int{}
	for i := 0; i+1 < len(kv); i += 2 {
		name, value := kv[i], kv[i+1]
		if j, ok := idx[strings.ToLower(name)]; ok {
			e.Attributes[j].Values = append(e.Attributes[j].Values, value)
			continue
		}
		idx[strings.ToLower(name)] = len(e.Attributes)
		e.Attributes = append(e.Attributes, models.LDAPAttribute{Name: name, Values: []string{value}})
	}
	return e
}

func TestValueTemplates(t *testing.T) {
	entry := entryOf(`CN=Smith\, John,OU=Users,DC=x`, "givenName", "John", "sn", "Smith", "mail", "John.Smith@X.org", "cn", "Smith, John")
	te := newTemplateEntry(entry)
	cases := map[string]string{
		"Hello %givenName% %SN:upper%, 100%% sure": "Hello John SMITH, 100% sure",
		"%mail:lower%":          "john.smith@x.org",
		"%MAIL:Upper%":          "JOHN.SMITH@X.ORG",
		"%dn%":                  `CN=Smith\, John,OU=Users,DC=x`,
		"%rdn%":                 `CN=Smith\, John`,
		"moved from %parentdn%": "moved from OU=Users,DC=x",
		"plain":                 "plain",
		"%%%cn%%%":              "%Smith, John%",
	}
	for tpl, want := range cases {
		parsed, err := parseValueTemplate(tpl)
		if err != nil {
			t.Errorf("%q: %v", tpl, err)
			continue
		}
		got, empty, err := parsed.expand(te)
		if err != nil || len(empty) > 0 || got != want {
			t.Errorf("%q = %q (empty %v, err %v), want %q", tpl, got, empty, err, want)
		}
	}

	for _, bad := range []string{"50% off", "%bad name%", "%cn:title%", "%:lower%", "%"} {
		if _, err := parseValueTemplate(bad); err == nil {
			t.Errorf("%q: expected a syntax error", bad)
		}
	}

	parsed, _ := parseValueTemplate("%telephoneNumber% / %title%")
	if _, empty, err := parsed.expand(te); err != nil || !reflect.DeepEqual(empty, []string{"%telephoneNumber%", "%title%"}) {
		t.Errorf("empty placeholders = %v, %v", empty, err)
	}
	top, _ := parseValueTemplate("%parentdn%")
	if _, empty, _ := top.expand(newTemplateEntry(entryOf("dc=org"))); len(empty) != 1 {
		t.Errorf("parentdn of a top entry must be empty")
	}
	bin := &models.LDAPEntry{DN: "cn=a", Attributes: []models.LDAPAttribute{{Name: "jpegPhoto", Values: []string{"AP8="}, Binary: true}}}
	photo, _ := parseValueTemplate("%jpegPhoto%")
	if _, _, err := photo.expand(newTemplateEntry(bin)); err == nil {
		t.Errorf("binary placeholder must fail")
	}
}

func plan(t *testing.T, entry *models.LDAPEntry, changes []models.AttributeChange, opts models.BulkOptions, sc *schemaContext) (models.BulkPreviewEntry, []models.AttributeChange) {
	t.Helper()
	compiled, err := compileBatchChanges(changes)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if sc == nil {
		sc = newSchemaContext(nil, "")
	}
	return planBatchEntry(entry, compiled, opts, sc)
}

func ch(op, attr string, values ...string) models.AttributeChange {
	if values == nil {
		values = []string{}
	}
	return models.AttributeChange{Operation: op, Attribute: attr, Values: values}
}

func testSchema() *schemaContext {
	return newSchemaContext(&models.SchemaInfo{Attributes: []models.SchemaAttribute{
		{Name: "name", Equality: "caseIgnoreMatch"},
		{Name: "cn", SuperType: "name"},
		{Name: "description", Equality: "caseIgnoreMatch"},
		{Name: "employeeNumber", Equality: "caseIgnoreMatch", SingleValue: true},
		{Name: "uid", Equality: "caseExactMatch"},
		{Name: "memberOf", NoUserMod: true},
		{Name: "telephoneNumber", Equality: "telephoneNumberMatch"},
		{Name: "member", Syntax: "1.3.6.1.4.1.1466.115.121.1.12"},
	}}, models.ServerTypeOpenLDAP)
}

func TestPlanBatchEntry(t *testing.T) {
	base := func() *models.LDAPEntry {
		return entryOf("cn=Alice,ou=People,dc=x",
			"cn", "Alice", "sn", "Liddell", "description", "Old", "description", "Keep",
			"mail", "alice@x.org", "employeeNumber", "7", "uid", "alice",
			"member", "cn=Bob,ou=People,dc=x", "telephoneNumber", "+49 89 123-4")
	}
	sc := testSchema()

	t.Run("templates and atomic diff", func(t *testing.T) {
		pe, sent := plan(t, base(), []models.AttributeChange{
			ch("delete", "description", "Old"),
			ch("add", "description", "Mail %mail:upper%"),
			ch("replace", "title", "%sn% (%rdn%)"),
		}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusChange || len(pe.Errors) != 0 {
			t.Fatalf("status %s errors %v", pe.Status, pe.Errors)
		}
		want := []models.AttributeChange{
			{Operation: "delete", Attribute: "description", Values: []string{"Old"}},
			{Operation: "add", Attribute: "description", Values: []string{"Mail ALICE@X.ORG"}},
			{Operation: "replace", Attribute: "title", Values: []string{"Liddell (cn=Alice)"}},
		}
		if !reflect.DeepEqual(sent, want) {
			t.Errorf("sent = %+v", sent)
		}
		d := pe.Diffs[0]
		if d.Attribute != "description" || !reflect.DeepEqual(d.Before, []string{"Old", "Keep"}) || !reflect.DeepEqual(d.After, []string{"Keep", "Mail ALICE@X.ORG"}) ||
			!reflect.DeepEqual(d.Added, []string{"Mail ALICE@X.ORG"}) || !reflect.DeepEqual(d.Removed, []string{"Old"}) || !reflect.DeepEqual(d.Operations, []string{"delete", "add"}) {
			t.Errorf("description diff = %+v", d)
		}
		if t2 := pe.Diffs[1]; t2.BeforeCount != 0 || !reflect.DeepEqual(t2.After, []string{"Liddell (cn=Alice)"}) || !t2.Changed {
			t.Errorf("title diff = %+v", t2)
		}
	})

	t.Run("delete missing value fails", func(t *testing.T) {
		pe, sent := plan(t, base(), []models.AttributeChange{ch("delete", "description", "Nope"), ch("replace", "title", "x")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusError || sent != nil || !strings.Contains(pe.Errors[0], "not present") {
			t.Errorf("got %s %v", pe.Status, pe.Errors)
		}
	})

	t.Run("ignore no-ops", func(t *testing.T) {
		pe, sent := plan(t, base(), []models.AttributeChange{ch("delete", "description", "Nope"), ch("add", "mail", "alice@x.org")}, models.BulkOptions{IgnoreNoOps: true}, sc)
		if pe.Status != models.BulkStatusUnchanged || sent != nil || len(pe.Notes) != 2 {
			t.Errorf("got %s %v %v", pe.Status, pe.Notes, sent)
		}
	})

	t.Run("add present value fails, case-insensitive rule", func(t *testing.T) {
		pe, _ := plan(t, base(), []models.AttributeChange{ch("add", "description", "KEEP")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusError {
			t.Errorf("caseIgnoreMatch: got %s", pe.Status)
		}
		pe, _ = plan(t, base(), []models.AttributeChange{ch("add", "uid", "ALICE")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusChange || len(pe.Warnings) != 0 {
			t.Errorf("caseExactMatch: got %s %v", pe.Status, pe.Warnings)
		}
		pe, _ = plan(t, base(), []models.AttributeChange{ch("add", "mail", "ALICE@x.org")}, models.BulkOptions{}, newSchemaContext(nil, ""))
		if pe.Status != models.BulkStatusChange || len(pe.Warnings) != 1 {
			t.Errorf("unknown rule: got %s %v", pe.Status, pe.Warnings)
		}
		pe, _ = plan(t, base(), []models.AttributeChange{ch("add", "mail", "ALICE@x.org")}, models.BulkOptions{}, newSchemaContext(nil, models.ServerTypeAD))
		if pe.Status != models.BulkStatusError {
			t.Errorf("AD: got %s", pe.Status)
		}
		pe, _ = plan(t, base(), []models.AttributeChange{ch("delete", "telephoneNumber", "+4989123 4")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusChange {
			t.Errorf("telephoneNumberMatch: got %s %v", pe.Status, pe.Errors)
		}
		pe, _ = plan(t, base(), []models.AttributeChange{ch("delete", "member", "CN=bob, OU=people,DC=X")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusChange {
			t.Errorf("DN match: got %s %v", pe.Status, pe.Errors)
		}
	})

	t.Run("no-op attribute removal and identical replace", func(t *testing.T) {
		pe, sent := plan(t, base(), []models.AttributeChange{ch("delete", "title"), ch("replace", "sn", "Liddell")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusUnchanged || sent != nil || len(pe.Notes) != 2 {
			t.Errorf("got %s %v", pe.Status, pe.Notes)
		}
	})

	t.Run("schema predictions", func(t *testing.T) {
		pe, _ := plan(t, base(), []models.AttributeChange{ch("add", "employeeNumber", "8")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusError || !strings.Contains(pe.Errors[0], "single-valued") {
			t.Errorf("single-valued: %v", pe.Errors)
		}
		pe, _ = plan(t, base(), []models.AttributeChange{ch("replace", "memberOf", "cn=g,dc=x")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusError || !strings.Contains(pe.Errors[0], "NO-USER-MODIFICATION") {
			t.Errorf("no-user-mod: %v", pe.Errors)
		}
		pe, _ = plan(t, base(), []models.AttributeChange{ch("replace", "cn", "Alicia")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusError || !strings.Contains(strings.Join(pe.Errors, ";"), "naming value") {
			t.Errorf("rdn: %v", pe.Errors)
		}
		pe, _ = plan(t, base(), []models.AttributeChange{ch("add", "cn", "Alicia")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusChange {
			t.Errorf("adding a second cn must be fine: %v", pe.Errors)
		}
		bin := base()
		bin.Attributes = append(bin.Attributes, models.LDAPAttribute{Name: "jpegPhoto", Values: []string{"AP8="}, Binary: true})
		pe, _ = plan(t, bin, []models.AttributeChange{ch("replace", "jpegPhoto", "text")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusError {
			t.Errorf("binary: %v", pe.Status)
		}
		pe, _ = plan(t, bin, []models.AttributeChange{ch("delete", "jpegPhoto")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusChange || !pe.Diffs[0].Binary || pe.Diffs[0].Before[0] != "<binary 2 bytes>" {
			t.Errorf("binary removal: %s %+v", pe.Status, pe.Diffs)
		}
	})

	t.Run("empty placeholders", func(t *testing.T) {
		changes := []models.AttributeChange{ch("replace", "description", "Phone %mobile%")}
		pe, _ := plan(t, base(), changes, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusError || !strings.Contains(pe.Errors[0], "%mobile%") {
			t.Errorf("got %s %v", pe.Status, pe.Errors)
		}
		pe, _ = plan(t, base(), changes, models.BulkOptions{SkipEmptyPlaceholders: true}, sc)
		if pe.Status != models.BulkStatusSkipped {
			t.Errorf("got %s", pe.Status)
		}
	})

	t.Run("passwords masked", func(t *testing.T) {
		pe, sent := plan(t, base(), []models.AttributeChange{ch("replace", "userPassword", "Secret-%uid%")}, models.BulkOptions{}, sc)
		if pe.Status != models.BulkStatusChange || sent[0].Values[0] != "Secret-alice" {
			t.Fatalf("got %s %+v", pe.Status, sent)
		}
		if pe.Changes[0].Values[0] != "***" || pe.Diffs[0].After[0] != "***" || !pe.Diffs[0].Masked {
			t.Errorf("not masked: %+v %+v", pe.Changes, pe.Diffs)
		}
	})

	t.Run("compile errors", func(t *testing.T) {
		for _, bad := range [][]models.AttributeChange{
			{},
			{ch("frob", "cn", "x")},
			{ch("add", "", "x")},
			{ch("add", "bad name", "x")},
			{ch("add", "description")},
			{ch("replace", "description", "50% off")},
		} {
			if _, err := compileBatchChanges(bad); err == nil {
				t.Errorf("%+v: expected error", bad)
			}
		}
	})
}

// fakeDirectory implements entryReader over a fixed set of entries.
type fakeDirectory struct {
	entries map[string]*models.LDAPEntry
	reads   int
}

func newFakeDirectory(entries ...*models.LDAPEntry) *fakeDirectory {
	d := &fakeDirectory{entries: map[string]*models.LDAPEntry{}}
	for _, e := range entries {
		d.entries[bulkDNKey(e.DN)] = e
	}
	return d
}

func (d *fakeDirectory) EntryExists(dn string) (bool, error) {
	d.reads++
	_, ok := d.entries[bulkDNKey(dn)]
	return ok, nil
}

func (d *fakeDirectory) GetEntry(dn string) (*models.LDAPEntry, error) {
	d.reads++
	e, ok := d.entries[bulkDNKey(dn)]
	if !ok {
		return nil, fmt.Errorf("no such object %s", dn)
	}
	cp := *e
	return &cp, nil
}

func (d *fakeDirectory) ChildDNs(dn string, limit int) ([]string, bool, error) {
	d.reads++
	var out []string
	for _, e := range d.entries {
		if dnEqual(bulkParentDN(e.DN), dn) {
			out = append(out, e.DN)
		}
	}
	sort.Strings(out)
	if len(out) > limit {
		return out[:limit], true, nil
	}
	return out, false, nil
}

// ldifRecordStatus runs a dry run and returns "line status errors" per record.
func ldifRecordStatus(t *testing.T, dir entryReader, sc *schemaContext, lines ...string) []string {
	t.Helper()
	parsed := ldif.ParseChanges(strings.Join(lines, "\n"), ldif.ParseOptions{})
	preview, _ := buildLDIFPreview(parsed, newLDIFSimulator(dir, sc, ldifImportSettings{}), nil)
	out := make([]string, len(preview.Records))
	for i, r := range preview.Records {
		out[i] = fmt.Sprintf("%d %s %s%s", r.Line, r.Status, strings.Join(r.Errors, ";"), strings.Join(r.Warnings, ";"))
	}
	return out
}

func expectStatuses(t *testing.T, got []string, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d records %q, want %d", len(got), got, len(want))
	}
	for i := range want {
		if !strings.HasPrefix(got[i], want[i]) {
			t.Errorf("record %d = %q, want prefix %q", i, got[i], want[i])
		}
	}
}

func TestLDIFPreviewDeleteNonLeaf(t *testing.T) {
	newDir := func() *fakeDirectory {
		return newFakeDirectory(
			entryOf("dc=x", "dc", "x"),
			entryOf("ou=P,dc=x", "ou", "P"),
			entryOf("ou=Staff,dc=x", "ou", "Staff"),
			entryOf("cn=a,ou=P,dc=x", "cn", "a"),
		)
	}

	t.Run("top-down order", func(t *testing.T) {
		got := ldifRecordStatus(t, newDir(), nil,
			"dn: ou=P,dc=x", "changetype: delete", "",
			"dn: cn=a,ou=P,dc=x", "changetype: delete", "")
		expectStatuses(t, got, "1 error entry has child entries", "4 ok")
	})
	t.Run("bottom-up order", func(t *testing.T) {
		got := ldifRecordStatus(t, newDir(), nil,
			"dn: cn=a,ou=P,dc=x", "changetype: delete", "",
			"dn: ou=P,dc=x", "changetype: delete", "")
		expectStatuses(t, got, "1 ok", "4 ok")
	})
	t.Run("child added by the file", func(t *testing.T) {
		got := ldifRecordStatus(t, newDir(), nil,
			"dn: ou=Q,dc=x", "changetype: add", "objectClass: organizationalUnit", "ou: Q", "",
			"dn: cn=c,ou=Q,dc=x", "changetype: add", "objectClass: person", "cn: c", "sn: c", "",
			"dn: ou=Q,dc=x", "changetype: delete", "")
		expectStatuses(t, got, "1 ok", "6 ok", "12 error entry has child entries")
	})
	t.Run("child moved away", func(t *testing.T) {
		got := ldifRecordStatus(t, newDir(), nil,
			"dn: cn=a,ou=P,dc=x", "changetype: moddn", "newrdn: cn=a", "deleteoldrdn: 1", "newsuperior: ou=Staff,dc=x", "",
			"dn: ou=P,dc=x", "changetype: delete", "",
			"dn: ou=Staff,dc=x", "changetype: delete", "")
		expectStatuses(t, got, "1 ok", "7 ok", "10 error entry has child entries")
	})
	t.Run("child renamed in place", func(t *testing.T) {
		got := ldifRecordStatus(t, newDir(), nil,
			"dn: cn=a,ou=P,dc=x", "changetype: modrdn", "newrdn: cn=b", "deleteoldrdn: 1", "",
			"dn: ou=P,dc=x", "changetype: delete", "")
		expectStatuses(t, got, "1 ok", "6 error entry has child entries")
	})
	t.Run("parent renamed with its child", func(t *testing.T) {
		got := ldifRecordStatus(t, newDir(), nil,
			"dn: ou=P,dc=x", "changetype: modrdn", "newrdn: ou=P2", "deleteoldrdn: 1", "",
			"dn: ou=P2,dc=x", "changetype: delete", "",
			"dn: cn=a,ou=P2,dc=x", "changetype: delete", "",
			"dn: ou=P2,dc=x", "changetype: delete", "")
		expectStatuses(t, got, "1 ok", "6 error entry has child entries", "9 ok", "12 ok")
	})
	t.Run("more children than earlier records", func(t *testing.T) {
		dir := newDir()
		for _, cn := range []string{"b", "c", "d"} {
			e := entryOf("cn="+cn+",ou=P,dc=x", "cn", cn)
			dir.entries[bulkDNKey(e.DN)] = e
		}
		got := ldifRecordStatus(t, dir, nil,
			"dn: cn=a,ou=P,dc=x", "changetype: delete", "",
			"dn: cn=b,ou=P,dc=x", "changetype: delete", "",
			"dn: ou=P,dc=x", "changetype: delete", "")
		expectStatuses(t, got, "1 ok", "4 ok", "7 error entry has child entries")
	})
}

func TestLDIFPreviewNamingContextAdd(t *testing.T) {
	sc := newSchemaContext(nil, models.ServerTypeOpenLDAP)
	sc.namingContexts = []string{"dc=demo,dc=local"}
	lines := []string{
		"dn: dc=demo,dc=local", "changetype: add", "objectClass: dcObject", "objectClass: organization", "dc: demo", "o: Demo", "",
		"dn: ou=People,dc=demo,dc=local", "changetype: add", "objectClass: organizationalUnit", "ou: People", "",
		"dn: cn=x,ou=Missing,dc=demo,dc=local", "changetype: add", "objectClass: person", "cn: x", "sn: x", "",
		"dn: dc=other,dc=org", "changetype: add", "objectClass: dcObject", "dc: other", "",
	}
	got := ldifRecordStatus(t, newFakeDirectory(), sc, lines...)
	expectStatuses(t, got, "1 ok", "8 ok", "13 error parent entry ou=Missing", "19 warning parent entry dc=org does not exist")

	// naming contexts unknown: a missing parent stays an error
	got = ldifRecordStatus(t, newFakeDirectory(), nil, lines...)
	expectStatuses(t, got, "1 error parent entry", "8 error parent entry", "13 error parent entry", "19 error parent entry")
}

func TestLDIFPreviewSimulation(t *testing.T) {
	dir := newFakeDirectory(
		entryOf("dc=x", "dc", "x"),
		entryOf("ou=People,dc=x", "ou", "People"),
		entryOf("ou=Staff,dc=x", "ou", "Staff"),
		entryOf("cn=a,ou=People,dc=x", "cn", "a", "sn", "A", "description", "d"),
		entryOf("cn=child,cn=a,ou=People,dc=x", "cn", "child"),
	)
	content := strings.Join([]string{
		"version: 1",
		"",
		"dn: cn=b,ou=People,dc=x", // 3: ok
		"changetype: add",
		"objectClass: person",
		"cn: b",
		"sn: B",
		"",
		"dn: cn=a,ou=People,dc=x", // 9: exists
		"objectClass: person",
		"cn: a",
		"sn: A",
		"",
		"dn: cn=z,ou=Missing,dc=x", // 14: parent missing
		"cn: z",
		"",
		"dn: cn=b,ou=People,dc=x", // 17: modify of an entry created above
		"changetype: modify",
		"replace: sn",
		"sn: Bee",
		"-",
		"",
		"dn: cn=nope,ou=People,dc=x", // 23: missing
		"changetype: modify",
		"replace: sn",
		"sn: x",
		"",
		"dn: cn=b,ou=People,dc=x", // 28: delete of the created entry
		"changetype: delete",
		"",
		"dn: cn=b,ou=People,dc=x", // 31: deleted above
		"changetype: delete",
		"",
		"dn: cn=a,ou=People,dc=x", // 34: move + rename
		"changetype: modrdn",
		"newrdn: cn=a2",
		"deleteoldrdn: 1",
		"newsuperior: ou=Staff,dc=x",
		"",
		"dn: cn=a2,ou=Staff,dc=x", // 40: modify at the new DN
		"changetype: modify",
		"delete: description",
		"description: d",
		"-",
		"replace: cn",
		"cn: a2",
		"-",
		"",
		"dn: cn=child,cn=a2,ou=Staff,dc=x", // 49: child moved along
		"changetype: delete",
		"",
		"dn: cn=child,cn=a,ou=People,dc=x", // 52: gone (moved)
		"changetype: delete",
		"",
		"dn: cn=a,ou=People,dc=x", // 55: free again
		"changetype: add",
		"objectClass: person",
		"cn: a",
		"sn: A",
		"",
		"dn: cn=a2,ou=Staff,dc=x", // 61: target exists
		"changetype: modrdn",
		"newrdn: cn=a",
		"deleteoldrdn: 0",
		"newsuperior: ou=People,dc=x",
		"",
		"dn: cn=a2,ou=Staff,dc=x", // 67: value not present
		"changetype: modify",
		"delete: sn",
		"sn: nope",
		"-",
		"",
		"dn: cn=bad,dc=x", // 73: invalid
		"changetype: frobnicate",
		"",
	}, "\n")

	parsed := ldif.ParseChanges(content, ldif.ParseOptions{})
	preview, stopped := buildLDIFPreview(parsed, newLDIFSimulator(dir, nil, ldifImportSettings{opts: models.LDIFImportOptions{Existing: models.LDIFExistingFail}}), nil)
	if stopped {
		t.Fatal("stopped")
	}
	want := []struct {
		line   int
		status string
		msg    string
	}{
		{3, "ok", ""},
		{9, "error", "already exists"},
		{14, "error", "parent entry"},
		{17, "ok", ""},
		{23, "error", "does not exist"},
		{28, "ok", ""},
		{31, "error", "does not exist"},
		{34, "ok", ""},
		{40, "ok", ""},
		{49, "ok", ""},
		{52, "error", "does not exist"},
		{55, "ok", ""},
		{61, "error", "already exists"},
		{67, "error", "not present"},
		{73, "invalid", "unknown changetype"},
	}
	if len(preview.Records) != len(want) {
		t.Fatalf("got %d records", len(preview.Records))
	}
	for i, w := range want {
		r := preview.Records[i]
		if r.Line != w.line || r.Status != w.status || (w.msg != "" && !strings.Contains(strings.Join(r.Errors, ";"), w.msg)) {
			t.Errorf("record %d (line %d): status %s errors %v warnings %v, want %s %q", i, r.Line, r.Status, r.Errors, r.Warnings, w.status, w.msg)
		}
	}
	if d := preview.Records[3].Diffs; len(d) != 1 || !reflect.DeepEqual(d[0].Before, []string{"B"}) || !reflect.DeepEqual(d[0].After, []string{"Bee"}) {
		t.Errorf("modify diff of the created entry = %+v", d)
	}
	if r := preview.Records[7]; r.NewDN != "cn=a2,ou=Staff,dc=x" {
		t.Errorf("modrdn new DN = %q", r.NewDN)
	}
	if preview.ByChangeType["add"] != 4 || preview.ByChangeType["modify"] != 4 || preview.ByChangeType["delete"] != 4 || preview.ByChangeType["modrdn"] != 2 {
		t.Errorf("by change type = %v", preview.ByChangeType)
	}
	if preview.ByStatus["ok"] != 7 || preview.ByStatus["error"] != 7 || preview.ByStatus["invalid"] != 1 || preview.Applicable {
		t.Errorf("by status = %v applicable %v", preview.ByStatus, preview.Applicable)
	}
	if len(preview.SyntaxErrors) != 1 || preview.SyntaxErrors[0].Line != 74 {
		t.Errorf("syntax errors = %+v", preview.SyntaxErrors)
	}
}

func TestBulkRunRegistry(t *testing.T) {
	ctx, done := bulkRuns.start("run-1")
	if !bulkRuns.stop("run-1") || ctx.Err() == nil {
		t.Fatal("stop did not cancel the run")
	}
	done()
	if bulkRuns.stop("run-1") {
		t.Error("finished run must be gone")
	}
	_, done2 := bulkRuns.start("")
	done2()
}

func TestShouldStop(t *testing.T) {
	failed := models.BulkResultItem{Status: models.BulkResultFailed}
	if stop, _ := shouldStop(failed, fmt.Errorf("x"), models.BulkOptions{ContinueOnError: true}); stop {
		t.Error("continue on error must not stop")
	}
	if stop, _ := shouldStop(failed, fmt.Errorf("x"), models.BulkOptions{}); !stop {
		t.Error("must stop without continue on error")
	}
	if stop, _ := shouldStop(models.BulkResultItem{Status: models.BulkResultSuccess}, nil, models.BulkOptions{}); stop {
		t.Error("success must not stop")
	}
}

func TestLDIFPreviewKeptRDN(t *testing.T) {
	dir := newFakeDirectory(
		entryOf("dc=x", "dc", "x"),
		entryOf("employeeNumber=7,dc=x", "employeeNumber", "7"),
		entryOf("cn=a,dc=x", "cn", "a"),
	)
	content := "dn: employeeNumber=7,dc=x\nchangetype: modrdn\nnewrdn: employeeNumber=8\ndeleteoldrdn: 0\n\n" +
		"dn: cn=a,dc=x\nchangetype: modrdn\nnewrdn: cn=b\ndeleteoldrdn: 0\n"
	parsed := ldif.ParseChanges(content, ldif.ParseOptions{})

	preview, _ := buildLDIFPreview(parsed, newLDIFSimulator(dir, testSchema(), ldifImportSettings{}), nil)
	if r := preview.Records[0]; r.Status != "error" || !strings.Contains(strings.Join(r.Errors, ";"), "single-valued") {
		t.Errorf("single-valued naming attribute kept: %+v", r)
	}
	if r := preview.Records[1]; r.Status != "ok" {
		t.Errorf("multi-valued naming attribute kept: %+v", r)
	}

	ad := newSchemaContext(nil, models.ServerTypeAD)
	preview, _ = buildLDIFPreview(parsed, newLDIFSimulator(newFakeDirectory(entryOf("cn=a,dc=x", "cn", "a"), entryOf("employeeNumber=7,dc=x")), ad, ldifImportSettings{}), nil)
	if r := preview.Records[1]; r.Status != "error" || !strings.Contains(strings.Join(r.Errors, ";"), "Active Directory") {
		t.Errorf("AD deleteoldrdn 0: %+v", r)
	}
}

// A bulk password change of an OpenLDAP account disabled in the account
// panel is announced in the dry run (apply keeps it disabled).
func TestPlanBatchEntryDisabledAccountPassword(t *testing.T) {
	disabled := entryOf("uid=leaver,ou=People,dc=x", "uid", "leaver", "userPassword", "{SSHA}x", "pwdAccountLockedTime", ldap.PPolicyPermanentLock)
	pe, _ := plan(t, disabled, []models.AttributeChange{ch("replace", "userPassword", "Secret-%uid%")}, models.BulkOptions{}, nil)
	if pe.Status != models.BulkStatusChange || !strings.Contains(strings.Join(pe.Warnings, "\n"), "the account is disabled") {
		t.Errorf("status %s warnings %v", pe.Status, pe.Warnings)
	}
	// no warning: other attributes, an explicit enable, or a temporary lock
	for name, tc := range map[string]struct {
		entry   *models.LDAPEntry
		changes []models.AttributeChange
	}{
		"description":  {disabled, []models.AttributeChange{ch("replace", "description", "x")}},
		"enable":       {disabled, []models.AttributeChange{ch("replace", "userPassword", "x"), ch("delete", "pwdAccountLockedTime")}},
		"temporary":    {entryOf("uid=a,dc=x", "uid", "a", "pwdAccountLockedTime", "20260101000000Z"), []models.AttributeChange{ch("replace", "userPassword", "x")}},
		"not disabled": {entryOf("uid=a,dc=x", "uid", "a"), []models.AttributeChange{ch("replace", "userPassword", "x")}},
	} {
		pe, _ := plan(t, tc.entry, tc.changes, models.BulkOptions{}, nil)
		if strings.Contains(strings.Join(pe.Warnings, "\n"), "the account is disabled") {
			t.Errorf("%s: unexpected warning %v", name, pe.Warnings)
		}
	}
}

func TestLDIFRunTagAndAuditDetails(t *testing.T) {
	a := ldifRunTag("550e8400-e29b-41d4-a716-446655440000")
	if len(a) != 8 || a != ldifRunTag("550e8400-e29b-41d4-a716-446655440000") {
		t.Fatalf("tag %q: want 8 hex digits, the same for the same run ID", a)
	}
	if a == ldifRunTag("550e8400-e29b-41d4-a716-446655440001") {
		t.Fatal("two run IDs gave the same tag")
	}
	if r := ldifRunTag(""); len(r) != 8 {
		t.Fatalf("tag without run ID = %q, want 8 hex digits", r)
	}
	cases := map[string]string{
		ldifAuditDetails("import", "1a2b3c4d", ", cn=a"):                        "LDIF import [run 1a2b3c4d], cn=a",
		ldifAuditDetails("modify", "1a2b3c4d", ": description: x"):              "LDIF modify [run 1a2b3c4d]: description: x",
		ldifAuditDetails("delete", "1a2b3c4d", ""):                              "LDIF delete [run 1a2b3c4d]",
		ldifAuditDetails("modrdn", "1a2b3c4d", ": newRDN=cn=b newDN=cn=b,dc=x"): "LDIF modrdn [run 1a2b3c4d]: newRDN=cn=b newDN=cn=b,dc=x",
		ldifAuditDetails("delete", "", ""):                                      "LDIF delete",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("details = %q, want %q", got, want)
		}
	}
}

type fakeExistence map[string]bool

func (f fakeExistence) EntryExists(dn string) (bool, error) {
	if dn == "ou=broken,dc=x" {
		return false, errors.New("timeout")
	}
	return f[batchDNKey(dn)], nil
}

func TestPlanBatchMove(t *testing.T) {
	dir := fakeExistence{
		"ou=target,dc=x": true, "cn=a,ou=one,dc=x": true, "cn=b,ou=one,dc=x": true, "cn=a,ou=two,dc=x": true,
		"cn=c,ou=one,dc=x": true, "cn=c,ou=target,dc=x": true, "cn=d,ou=target,dc=x": true,
	}
	plan := planBatchMove(dir, []string{"cn=a,ou=one,dc=x", "cn=b,ou=one,dc=x", "cn=a,ou=two,dc=x", "cn=c,ou=one,dc=x", "cn=d,ou=target,dc=x", "cn=gone,ou=one,dc=x"}, " OU=Target,dc=x ")
	if plan.Refused || plan.Total != 6 || plan.Ready != 2 || plan.Unchanged != 1 || plan.Failing != 3 {
		t.Fatalf("plan = %+v", plan)
	}
	want := []string{"move", "move", "fail", "fail", "unchanged", "fail"}
	for i, it := range plan.Items {
		if it.Status != want[i] {
			t.Errorf("item %d (%s) = %s %q, want %s", i, it.DN, it.Status, it.Message, want[i])
		}
	}
	if plan.Items[0].NewDN != "cn=a,OU=Target,dc=x" {
		t.Errorf("new DN = %q", plan.Items[0].NewDN)
	}
	if !strings.Contains(plan.Items[2].Message, "cn=a,ou=one,dc=x takes the same name") {
		t.Errorf("duplicate name: %q", plan.Items[2].Message)
	}
	if !strings.Contains(plan.Items[3].Message, "already exists") || !strings.Contains(plan.Items[5].Message, "does not exist") {
		t.Errorf("messages: %q / %q", plan.Items[3].Message, plan.Items[5].Message)
	}

	for _, tc := range []struct{ target, want string }{
		{"ou=missing,dc=x", "does not exist"},
		{"ou=broken,dc=x", "could not be checked"},
		{"cn=a,ou=one,dc=x", "is one of the entries"},
		{"ou=sub,cn=a,ou=one,dc=x", "lies below"},
		{"", "no target container"},
	} {
		p := planBatchMove(dir, []string{"cn=a,ou=one,dc=x"}, tc.target)
		if !p.Refused || !strings.Contains(p.Reason, tc.want) || len(p.Items) != 0 {
			t.Errorf("target %q: %+v, want refused with %q", tc.target, p, tc.want)
		}
	}
}
