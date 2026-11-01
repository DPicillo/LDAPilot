package ldif

import (
	"encoding/base64"
	"reflect"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

func TestBinaryRoundTrip(t *testing.T) {
	photo := []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'J', 'F', 'I', 'F'}
	photoB64 := base64.StdEncoding.EncodeToString(photo)
	entries := []models.LDAPEntry{{
		DN: "cn=Jörg,dc=x",
		Attributes: []models.LDAPAttribute{
			{Name: "cn", Values: []string{"Jörg"}},
			{Name: "description", Values: []string{" leading space", "plain"}},
			{Name: "jpegPhoto", Values: []string{photoB64}, Binary: true},
		},
	}}

	out, err := Export(entries)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "jpegPhoto:: "+photoB64+"\n") {
		t.Errorf("binary value not written as is (double encoded?):\n%s", out)
	}

	parsed, err := Parse(out)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(parsed, entries) {
		t.Errorf("round trip mismatch:\n got %+v\nwant %+v", parsed, entries)
	}
}

func TestParseBinaryClassification(t *testing.T) {
	in := "version: 1\n\n" +
		"dn: cn=a,dc=x\n" +
		"changetype: add\n" +
		"CN: a\n" +
		"cn: b\n" +
		"description: value with:: inside\n" +
		"userCertificate;binary:: AAEC\n" +
		"logonHours:: YWJj\n" +
		"title:: w6Q=\n" + // "ä" base64 encoded only for LDIF safety
		"mixed: text\n" +
		"mixed:: AP8=\n"
	entries, err := Parse(in)
	if err != nil {
		t.Fatal(err)
	}
	want := []models.LDAPAttribute{
		{Name: "CN", Values: []string{"a", "b"}},
		{Name: "description", Values: []string{"value with:: inside"}},
		{Name: "userCertificate;binary", Values: []string{"AAEC"}, Binary: true},
		{Name: "logonHours", Values: []string{"YWJj"}, Binary: true},
		{Name: "title", Values: []string{"ä"}},
		{Name: "mixed", Values: []string{"dGV4dA==", "AP8="}, Binary: true},
	}
	if len(entries) != 1 || !reflect.DeepEqual(entries[0].Attributes, want) {
		t.Errorf("attributes = %+v\nwant %+v", entries[0].Attributes, want)
	}
}

func TestParseRejects(t *testing.T) {
	for name, in := range map[string]string{
		"modify record": "dn: cn=a\nchangetype: modify\nreplace: cn\ncn: b\n",
		"url value":     "dn: cn=a\njpegPhoto:< file:///tmp/x.jpg\n",
		"bad base64":    "dn: cn=a\ncn:: %%%\n",
	} {
		if _, err := Parse(in); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestExportCSVBinary(t *testing.T) {
	out, err := ExportCSV([]models.LDAPEntry{{DN: "cn=a", Attributes: []models.LDAPAttribute{
		{Name: "jpegPhoto", Values: []string{"AP8="}, Binary: true},
	}}}, []string{"jpegPhoto"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "cn=a,AP8=") {
		t.Errorf("CSV must carry the base64 value: %q", out)
	}
}
