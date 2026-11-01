package ldif

import (
	"encoding/base64"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestParseChangesAllTypes(t *testing.T) {
	in := strings.Join([]string{
		"# leading comment",
		"#  folded comment",
		" continued here",
		"version: 1",
		"",
		"# add record",
		"dn: cn=Alice,ou=People,dc=example,dc=org",
		"changetype: add",
		"objectClass: inetOrgPerson",
		"objectClass:person",
		"cn: Alice",
		"sn:Liddell",
		"description: a very long",
		"  value folded", // fold: the first space is removed, the second kept
		"description:: " + b64("Jörg"),
		"",
		"",
		"dn:: " + b64("cn=Bob,ou=People,dc=example,dc=org"),
		"changetype: modify",
		"add: mail",
		"mail: bob@example.org",
		"mail: b@example.org",
		"-",
		"delete: description",
		"-",
		"delete: telephoneNumber",
		"telephoneNumber: +49 1",
		"-",
		"replace: title",
		"title: Boss",
		"", // final "-" missing: tolerated
		"dn: cn=Carol,ou=People,dc=example,dc=org",
		"changetype: delete",
		"",
		"dn: cn=Dave,ou=People,dc=example,dc=org",
		"changetype: modrdn",
		"newrdn: cn=David",
		"deleteoldrdn: 1",
		"newsuperior: ou=Staff,dc=example,dc=org",
		"",
		"dn: cn=Eve,ou=People,dc=example,dc=org",
		"changetype: moddn",
		"newrdn: cn=Eva",
		"deleteoldrdn: 0",
		"",
		"dn: cn=Frank,dc=example,dc=org",
		"objectClass: person",
		"cn: Frank",
		"sn: F",
		"",
	}, "\r\n")

	res := ParseChanges(in, ParseOptions{})
	if len(res.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", res.Errors)
	}
	if res.Version != 1 {
		t.Errorf("version = %d", res.Version)
	}
	if len(res.Records) != 6 {
		t.Fatalf("got %d records", len(res.Records))
	}

	add := res.Records[0]
	if add.ChangeType != models.LDIFChangeAdd || add.Content || add.Line != 7 || add.DN != "cn=Alice,ou=People,dc=example,dc=org" {
		t.Errorf("add record = %+v", add)
	}
	wantAttrs := []models.LDAPAttribute{
		{Name: "objectClass", Values: []string{"inetOrgPerson", "person"}},
		{Name: "cn", Values: []string{"Alice"}},
		{Name: "sn", Values: []string{"Liddell"}},
		{Name: "description", Values: []string{"a very long value folded", "Jörg"}},
	}
	if !reflect.DeepEqual(add.Attributes, wantAttrs) {
		t.Errorf("add attributes = %+v", add.Attributes)
	}

	mod := res.Records[1]
	if mod.ChangeType != models.LDIFChangeModify || mod.DN != "cn=Bob,ou=People,dc=example,dc=org" || mod.Line != 18 {
		t.Errorf("modify record = %+v", mod)
	}
	wantChanges := []models.AttributeChange{
		{Operation: "add", Attribute: "mail", Values: []string{"bob@example.org", "b@example.org"}},
		{Operation: "delete", Attribute: "description", Values: []string{}},
		{Operation: "delete", Attribute: "telephoneNumber", Values: []string{"+49 1"}},
		{Operation: "replace", Attribute: "title", Values: []string{"Boss"}},
	}
	if !reflect.DeepEqual(mod.Changes, wantChanges) {
		t.Errorf("modify changes = %+v", mod.Changes)
	}

	if del := res.Records[2]; del.ChangeType != models.LDIFChangeDelete || del.DN != "cn=Carol,ou=People,dc=example,dc=org" {
		t.Errorf("delete record = %+v", del)
	}
	mr := res.Records[3]
	if mr.ChangeType != models.LDIFChangeModRDN || mr.NewRDN != "cn=David" || !mr.DeleteOldRDN || mr.NewSuperior != "ou=Staff,dc=example,dc=org" {
		t.Errorf("modrdn record = %+v", mr)
	}
	md := res.Records[4]
	if md.ChangeType != models.LDIFChangeModRDN || md.NewRDN != "cn=Eva" || md.DeleteOldRDN || md.NewSuperior != "" {
		t.Errorf("moddn record = %+v", md)
	}
	content := res.Records[5]
	if content.ChangeType != models.LDIFChangeAdd || !content.Content || len(content.Attributes) != 3 {
		t.Errorf("content record = %+v", content)
	}
}

func TestParseChangesBinaryContract(t *testing.T) {
	jpeg := []byte{0xff, 0xd8, 0xff, 0xe0}
	in := "dn: cn=a,dc=x\nchangetype: modify\n" +
		"replace: jpegPhoto\njpegPhoto:: " + base64.StdEncoding.EncodeToString(jpeg) + "\n-\n" +
		"replace: description\ndescription:: " + b64("plain text") + "\n-\n" +
		"add: info\ninfo:: " + b64("bell\x07") + "\n-\n" +
		"add: userCertificate;binary\nuserCertificate;binary:: " + b64("textlike") + "\n-\n" +
		"replace: unicodePwd\nunicodePwd:: " + base64.StdEncoding.EncodeToString([]byte{'"', 0, 'x', 0, '"', 0}) + "\n-\n"
	res := ParseChanges(in, ParseOptions{})
	if len(res.Errors) != 0 {
		t.Fatal(res.Errors)
	}
	got := res.Records[0].Changes
	want := []models.AttributeChange{
		{Operation: "replace", Attribute: "jpegPhoto", Values: []string{"/9j/4A=="}, Binary: true},
		{Operation: "replace", Attribute: "description", Values: []string{"plain text"}},
		{Operation: "add", Attribute: "info", Values: []string{b64("bell\x07")}, Binary: true},
		{Operation: "add", Attribute: "userCertificate;binary", Values: []string{b64("textlike")}, Binary: true},
		{Operation: "replace", Attribute: "unicodePwd", Values: []string{"IgB4ACIA"}, Binary: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("changes = %+v\nwant %+v", got, want)
	}
}

func TestParseChangesValueForms(t *testing.T) {
	in := "dn:cn=a,dc=x\n" +
		"description:value without space\n" +
		"title: with:: colons inside\n" +
		"l:\n" + // empty value
		"street:   leading spaces trimmed, trailing kept  \n"
	res := ParseChanges(in, ParseOptions{})
	if len(res.Errors) != 0 {
		t.Fatal(res.Errors)
	}
	want := []models.LDAPAttribute{
		{Name: "description", Values: []string{"value without space"}},
		{Name: "title", Values: []string{"with:: colons inside"}},
		{Name: "l", Values: []string{""}},
		{Name: "street", Values: []string{"leading spaces trimmed, trailing kept  "}},
	}
	if res.Records[0].DN != "cn=a,dc=x" || !reflect.DeepEqual(res.Records[0].Attributes, want) {
		t.Errorf("record = %+v", res.Records[0])
	}
}

func TestParseChangesErrors(t *testing.T) {
	cases := []struct {
		name string
		in   string
		line int
		msg  string
	}{
		{"unknown changetype", "dn: cn=a,dc=x\nchangetype: frobnicate\n", 2, "unknown changetype"},
		{"control line", "dn: cn=a,dc=x\ncontrol: 1.2.840.113556.1.4.805 true\nchangetype: delete\n", 2, "control lines are not supported"},
		{"missing separator", "dn: cn=a,dc=x\nchangetype: modify\nreplace: cn\ncn: b\nreplace: sn\nsn: c\n", 5, "missing \"-\" line"},
		{"bad base64", "\n\ndn: cn=a,dc=x\ncn:: %%%\n", 4, "invalid base64"},
		{"no dn", "cn: a\nsn: b\n", 1, "must start with a \"dn:\" line"},
		{"continuation at start", " folded\ndn: cn=a,dc=x\ncn: a\n", 1, "continuation line"},
		{"bad version", "version: 2\n\ndn: cn=a,dc=x\ncn: a\n", 1, "unsupported LDIF version"},
		{"invalid dn", "dn: not a dn\ncn: a\n", 1, "invalid DN"},
		{"empty dn", "dn:\ncn: a\n", 1, "empty DN"},
		{"delete with body", "dn: cn=a,dc=x\nchangetype: delete\ncn: a\n", 3, "must not contain further lines"},
		{"modrdn missing deleteoldrdn", "dn: cn=a,dc=x\nchangetype: modrdn\nnewrdn: cn=b\n", 1, "deleteoldrdn"},
		{"modrdn bad deleteoldrdn", "dn: cn=a,dc=x\nchangetype: modrdn\nnewrdn: cn=b\ndeleteoldrdn: yes\n", 4, "must be 0 or 1"},
		{"modrdn newrdn is dn", "dn: cn=a,dc=x\nchangetype: modrdn\nnewrdn: cn=b,dc=x\ndeleteoldrdn: 1\n", 3, "single RDN"},
		{"add without values", "dn: cn=a,dc=x\nchangetype: modify\nadd: mail\n-\n", 3, "needs at least one value"},
		{"increment", "dn: cn=a,dc=x\nchangetype: modify\nincrement: uidNumber\nuidNumber: 1\n-\n", 3, "increment"},
		{"url without resolver", "dn: cn=a,dc=x\njpegPhoto:< file:///tmp/x.jpg\n", 2, "URL values"},
		{"bad attribute name", "dn: cn=a,dc=x\nbad name: x\n", 2, "invalid attribute name"},
		{"second dn", "dn: cn=a,dc=x\ncn: a\ndn: cn=b,dc=x\ncn: b\n", 3, "second \"dn:\" line"},
		{"add record without attributes", "dn: cn=a,dc=x\nchangetype: add\n", 1, "no attributes"},
		{"modify without changes", "dn: cn=a,dc=x\nchangetype: modify\n", 1, "no changes"},
		{"stray dash", "dn: cn=a,dc=x\nchangetype: modify\n-\n", 3, "unexpected \"-\""},
	}
	for _, c := range cases {
		res := ParseChanges(c.in, ParseOptions{})
		if len(res.Errors) == 0 {
			t.Errorf("%s: expected an error", c.name)
			continue
		}
		e := res.Errors[0]
		if e.Line != c.line || !strings.Contains(e.Msg, c.msg) {
			t.Errorf("%s: error = %q at line %d, want %q at line %d", c.name, e.Msg, e.Line, c.msg, c.line)
		}
	}
}

func TestParseChangesContinuesAfterError(t *testing.T) {
	in := "dn: cn=a,dc=x\nchangetype: bogus\n\ndn: cn=b,dc=x\nchangetype: delete\n\ndn: cn=c,dc=x\ncn:: !!\n\ndn: cn=d,dc=x\nchangetype: delete\n"
	res := ParseChanges(in, ParseOptions{})
	if len(res.Records) != 4 || len(res.Errors) != 2 {
		t.Fatalf("records=%d errors=%v", len(res.Records), res.Errors)
	}
	if res.Records[0].Err == nil || res.Records[1].Err != nil || res.Records[2].Err == nil || res.Records[3].Err != nil {
		t.Errorf("record errors: %v %v %v %v", res.Records[0].Err, res.Records[1].Err, res.Records[2].Err, res.Records[3].Err)
	}
	if res.Errors[0].Line != 2 || res.Errors[1].Line != 8 {
		t.Errorf("error lines: %d %d", res.Errors[0].Line, res.Errors[1].Line)
	}
	if res.Records[3].Line != 10 || res.Records[3].DN != "cn=d,dc=x" {
		t.Errorf("last record = %+v", res.Records[3])
	}
}

func TestParseChangesURLValues(t *testing.T) {
	dir := t.TempDir()
	photo := filepath.Join(dir, "photo.jpg")
	if err := os.WriteFile(photo, []byte{0xff, 0xd8, 0x00, 0x01}, 0600); err != nil {
		t.Fatal(err)
	}
	text := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(text, []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	big := filepath.Join(dir, "big.bin")
	if err := os.WriteFile(big, make([]byte, 100), 0600); err != nil {
		t.Fatal(err)
	}
	fileURL := testFileURL

	opts := ParseOptions{ResolveURL: FileURLResolver(50, 0)}
	in := "dn: cn=a,dc=x\nchangetype: modify\nreplace: jpegPhoto\njpegPhoto:< " + fileURL(photo) + "\n-\nreplace: description\ndescription:<" + fileURL(text) + "\n-\n"
	res := ParseChanges(in, opts)
	if len(res.Errors) != 0 {
		t.Fatal(res.Errors)
	}
	ch := res.Records[0].Changes
	if !ch[0].Binary || ch[0].Values[0] != base64.StdEncoding.EncodeToString([]byte{0xff, 0xd8, 0x00, 0x01}) {
		t.Errorf("photo change = %+v", ch[0])
	}
	if ch[1].Binary || ch[1].Values[0] != "hello" {
		t.Errorf("text change = %+v", ch[1])
	}
	if len(res.Records[0].URLs) != 2 {
		t.Errorf("URLs = %v", res.Records[0].URLs)
	}

	for name, u := range map[string]string{
		"too large": fileURL(big),
		"missing":   fileURL(filepath.Join(dir, "nope")),
		"http":      "http://example.org/x.jpg",
		"remote":    "file://server/share/x.jpg",
		"relative":  "file:x.jpg",
		"directory": fileURL(dir),
	} {
		res := ParseChanges("dn: cn=a,dc=x\njpegPhoto:< "+u+"\n", opts)
		if len(res.Errors) != 1 || res.Errors[0].Line != 2 {
			t.Errorf("%s: errors = %v", name, res.Errors)
		}
	}

	// total limit
	total := ParseOptions{ResolveURL: FileURLResolver(50, 6)}
	res = ParseChanges("dn: cn=a,dc=x\ndescription:< "+fileURL(text)+"\ninfo:< "+fileURL(text)+"\n", total)
	if len(res.Errors) != 1 || !strings.Contains(res.Errors[0].Msg, "total limit") {
		t.Errorf("total limit: %v", res.Errors)
	}
}

func TestFileURLPath(t *testing.T) {
	cases := map[string]string{
		"file:///tmp/a%20b.jpg":       "/tmp/a b.jpg",
		"file://localhost/tmp/x.jpg":  "/tmp/x.jpg",
		"FILE:///tmp/upper-scheme.jp": "/tmp/upper-scheme.jp",
	}
	if runtime.GOOS == "windows" {
		cases = map[string]string{
			"file:///C:/dir/a%20b.jpg":        `C:\dir\a b.jpg`,
			"file://localhost/c:/Users/x.jpg": `c:\Users\x.jpg`,
		}
	}
	for in, want := range cases {
		got, err := FileURLPath(in)
		if err != nil || got != filepath.FromSlash(want) {
			t.Errorf("FileURLPath(%q) = %q, %v", in, got, err)
		}
	}
}

// testFileURL is the file:// URL of the local path p (file:///C:/... on Windows).
func testFileURL(p string) string {
	slash := filepath.ToSlash(p)
	if !strings.HasPrefix(slash, "/") {
		slash = "/" + slash
	}
	return (&url.URL{Scheme: "file", Path: slash}).String()
}

// Network and device paths must never be opened: on Windows a UNC path
// connects to the SMB server and authenticates as the logged-on user, and
// URL values are resolved already by the dry run.
func TestFileURLPathRejectsNetworkAndDevicePaths(t *testing.T) {
	bad := []string{
		"file:////attacker.example/share/x.jpg",
		"file://localhost//attacker.example/share/x.jpg",
		"file:///%5C%5Cattacker.example%5Cshare%5Cx.jpg",
		"file:///%5C%5C.%5Cpipe%5Cx",
		"file:////./pipe/x",
		"file:////?/UNC/attacker.example/share/x",
		"file://attacker.example/share/x.jpg",
		"file:x.jpg",
	}
	if runtime.GOOS == "windows" {
		// local POSIX paths elsewhere; NT object namespace paths on Windows
		bad = append(bad, "file:///%3F%3F/UNC/attacker.example/share/x", "file:///%3F%3F/C:/x.jpg", "file:///x.jpg")
	}
	for _, in := range bad {
		if p, err := FileURLPath(in); err == nil {
			t.Errorf("FileURLPath(%q) = %q, want an error", in, p)
		}
	}
}

func TestFileURLResolverRegularFilesOnly(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "photo.jpg")
	if err := os.WriteFile(file, []byte("JPEG"), 0o600); err != nil {
		t.Fatal(err)
	}
	fileURL := testFileURL
	resolve := FileURLResolver(1<<20, 0)
	if data, err := resolve(fileURL(file)); err != nil || string(data) != "JPEG" {
		t.Errorf("regular file: %q, %v", data, err)
	}
	if _, err := resolve(fileURL(dir)); err == nil || !strings.Contains(err.Error(), "directory") {
		t.Errorf("directory: %v", err)
	}
}

func TestParseRejectsChangeRecords(t *testing.T) {
	_, err := Parse("dn: cn=a,dc=x\nchangetype: delete\n")
	if err == nil || !strings.Contains(err.Error(), "line 1") {
		t.Errorf("Parse of a delete record: %v", err)
	}
}
