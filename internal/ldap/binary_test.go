package ldap

import (
	"encoding/base64"
	"errors"
	"reflect"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

func TestIsBinaryValue(t *testing.T) {
	tests := []struct {
		name string
		v    []byte
		want bool
	}{
		{"ascii", []byte("hello"), false},
		{"umlaut", []byte("Müller"), false},
		{"tab cr lf", []byte("a\tb\r\nc"), false},
		{"empty", nil, false},
		{"nul", []byte{'a', 0, 'b'}, true},
		{"control", []byte{'a', 0x01}, true},
		{"del", []byte{'a', 0x7f}, true},
		{"invalid utf8", []byte{0xff, 0xfe}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsBinaryValue(tt.v); got != tt.want {
				t.Errorf("IsBinaryValue(%q) = %v, want %v", tt.v, got, tt.want)
			}
		})
	}
}

func TestIsKnownBinaryAttribute(t *testing.T) {
	for _, name := range []string{"jpegPhoto", "THUMBNAILPHOTO", "userCertificate;binary", "foo;binary", "nTSecurityDescriptor", "logonHours", "mS-DS-ConsistencyGuid"} {
		if !IsKnownBinaryAttribute(name) {
			t.Errorf("IsKnownBinaryAttribute(%q) = false", name)
		}
	}
	for _, name := range []string{"cn", "mail", "binaryDescription", "member;range=0-1499"} {
		if IsKnownBinaryAttribute(name) {
			t.Errorf("IsKnownBinaryAttribute(%q) = true", name)
		}
	}
}

func TestConvertAttribute(t *testing.T) {
	guid := []byte{0x78, 0x56, 0x34, 0x12, 0x34, 0x12, 0x78, 0x56, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0}
	sid := []byte{1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 32, 2, 0, 0} // S-1-5-32-544
	photo := []byte{0xff, 0xd8, 0xff, 0xe0, 0, 0x10}

	tests := []struct {
		name   string
		attr   string
		values [][]byte
		want   models.LDAPAttribute
	}{
		{"text", "cn", [][]byte{[]byte("Max Müller")}, models.LDAPAttribute{Name: "cn", Values: []string{"Max Müller"}}},
		{"guid formatted", "objectGUID", [][]byte{guid}, models.LDAPAttribute{Name: "objectGUID", Values: []string{"12345678-1234-5678-1234-56789abcdef0"}}},
		{"sid formatted", "objectSid", [][]byte{sid}, models.LDAPAttribute{Name: "objectSid", Values: []string{"S-1-5-32-544"}}},
		{"guid wrong length is binary", "objectGUID", [][]byte{{1, 2, 3}}, models.LDAPAttribute{Name: "objectGUID", Values: []string{"AQID"}, Binary: true}},
		{"known binary", "jpegPhoto", [][]byte{photo}, models.LDAPAttribute{Name: "jpegPhoto", Values: []string{base64.StdEncoding.EncodeToString(photo)}, Binary: true}},
		{"known binary that looks like text", "logonHours", [][]byte{[]byte("abc")}, models.LDAPAttribute{Name: "logonHours", Values: []string{"YWJj"}, Binary: true}},
		{"binary option", "userCertificate;binary", [][]byte{[]byte("abc")}, models.LDAPAttribute{Name: "userCertificate;binary", Values: []string{"YWJj"}, Binary: true}},
		{"unknown non-utf8", "userParameters", [][]byte{[]byte("ok"), {0xff}}, models.LDAPAttribute{Name: "userParameters", Values: []string{"b2s=", "/w=="}, Binary: true}},
		{"security descriptor", "nTSecurityDescriptor", [][]byte{{1, 0, 4, 0x8c}}, models.LDAPAttribute{Name: "nTSecurityDescriptor", Values: []string{"AQAEjA=="}, Binary: true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			values := make([]string, len(tt.values))
			for i, v := range tt.values {
				values[i] = string(v)
			}
			got := convertAttribute(tt.attr, tt.values, values)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("convertAttribute(%s) = %+v, want %+v", tt.attr, got, tt.want)
			}
		})
	}
}

func TestRawValues(t *testing.T) {
	got, err := rawValues("jpegPhoto", []string{"/9j/", "AA=="}, true)
	if err != nil || !reflect.DeepEqual(got, []string{"\xff\xd8\xff", "\x00"}) {
		t.Errorf("binary: got %q, %v", got, err)
	}
	if _, err := rawValues("jpegPhoto", []string{"not base64!"}, true); err == nil {
		t.Error("invalid base64: expected error")
	}
	got, err = rawValues("unicodePwd", []string{"Ab1!"}, false)
	if err != nil || got[0] != string(encodeUnicodePwd("Ab1!")) {
		t.Errorf("unicodePwd: got %q, %v", got, err)
	}
	encoded := base64.StdEncoding.EncodeToString(encodeUnicodePwd("Ab1!"))
	got, err = rawValues("unicodePwd", []string{encoded}, true)
	if err != nil || got[0] != string(encodeUnicodePwd("Ab1!")) {
		t.Errorf("binary unicodePwd must be sent as is: got %q, %v", got, err)
	}
	got, err = rawValues("cn", []string{"x"}, false)
	if err != nil || got[0] != "x" {
		t.Errorf("text: got %q, %v", got, err)
	}
}

func TestBuildModifyRequest(t *testing.T) {
	photo := base64.StdEncoding.EncodeToString([]byte{0xff, 0xd8})
	req, err := buildModifyRequest("cn=u,dc=x", []models.AttributeChange{
		{Operation: "replace", Attribute: "mail", Values: []string{"a@x"}},
		{Operation: "DELETE", Attribute: "description"},
		{Operation: "delete", Attribute: "member", Values: []string{"cn=a"}},
		{Operation: "delete", Attribute: "unicodePwd", Values: []string{"old"}},
		{Operation: "add", Attribute: "unicodePwd", Values: []string{"new"}},
		{Operation: "add", Attribute: "jpegPhoto", Values: []string{photo}, Binary: true},
	}, []goldap.Control{goldap.NewControlManageDsaIT(false)})
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Controls) != 1 {
		t.Errorf("controls not passed: %v", req.Controls)
	}
	want := []goldap.Change{
		{Operation: goldap.ReplaceAttribute, Modification: goldap.PartialAttribute{Type: "mail", Vals: []string{"a@x"}}},
		{Operation: goldap.DeleteAttribute, Modification: goldap.PartialAttribute{Type: "description", Vals: []string{}}},
		{Operation: goldap.DeleteAttribute, Modification: goldap.PartialAttribute{Type: "member", Vals: []string{"cn=a"}}},
		{Operation: goldap.DeleteAttribute, Modification: goldap.PartialAttribute{Type: "unicodePwd", Vals: []string{string(encodeUnicodePwd("old"))}}},
		{Operation: goldap.AddAttribute, Modification: goldap.PartialAttribute{Type: "unicodePwd", Vals: []string{string(encodeUnicodePwd("new"))}}},
		{Operation: goldap.AddAttribute, Modification: goldap.PartialAttribute{Type: "jpegPhoto", Vals: []string{"\xff\xd8"}}},
	}
	if !reflect.DeepEqual(req.Changes, want) {
		t.Errorf("changes = %+v\nwant %+v", req.Changes, want)
	}

	bad := [][]models.AttributeChange{
		nil,
		{{Operation: "increment", Attribute: "x", Values: []string{"1"}}},
		{{Operation: "add", Attribute: "x"}},
		{{Operation: "replace", Attribute: ""}},
		{{Operation: "add", Attribute: "jpegPhoto", Values: []string{"%%%"}, Binary: true}},
	}
	for i, changes := range bad {
		if _, err := buildModifyRequest("cn=u", changes, nil); err == nil {
			t.Errorf("bad[%d]: expected error", i)
		}
	}
}

func TestReadOnlyClient(t *testing.T) {
	c := NewClient(models.ConnectionProfile{ID: "p", ReadOnly: true})
	checks := map[string]error{
		"CheckWritable":   c.CheckWritable(),
		"AddEntry":        c.AddEntry("cn=x", []models.LDAPAttribute{{Name: "cn", Values: []string{"x"}}}),
		"ModifyEntry":     c.ModifyEntry("cn=x", []models.AttributeChange{{Operation: "replace", Attribute: "cn", Values: []string{"y"}}}),
		"ModifyAttribute": c.ModifyAttribute("cn=x", "cn", []string{"y"}),
		"AddAttribute":    c.AddAttribute("cn=x", "cn", []string{"y"}),
		"DeleteAttribute": c.DeleteAttribute("cn=x", "cn"),
		"DeleteEntry":     c.DeleteEntry("cn=x"),
		"DeleteEntryWithControls": c.DeleteEntryWithControls("cn=x",
			goldap.NewControlString(goldap.ControlTypeMicrosoftTreeDelete, true, "")),
		"RenameEntry": c.RenameEntry("cn=x", "cn=y", true, ""),
	}
	for name, err := range checks {
		if !errors.Is(err, ErrReadOnly) {
			t.Errorf("%s: err = %v, want ErrReadOnly", name, err)
		}
	}

	// Turning read-only off on the live client lets writes through to the
	// connection check.
	c.applySettings(models.ConnectionProfile{ReadOnly: false, PageSize: 7, Timeout: 3})
	if err := c.DeleteEntry("cn=x"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("after applySettings: err = %v, want ErrNotConnected", err)
	}
	if c.pageSize() != 7 || c.Profile().Timeout != 3 {
		t.Errorf("settings not applied: %+v", c.Profile())
	}
}

func TestPoolUpdateProfile(t *testing.T) {
	p := NewPool()
	// Unknown profile: nothing to update, nothing remembered.
	p.UpdateProfile(models.ConnectionProfile{ID: "x", ReadOnly: true})
	if len(p.settings) != 0 {
		t.Errorf("settings remembered for unconnected profile: %v", p.settings)
	}

	c := NewClient(models.ConnectionProfile{ID: "a", Host: "h1"})
	p.clients["a"] = c
	p.UpdateProfile(models.ConnectionProfile{ID: "a", Host: "h2", ReadOnly: true, PageSize: 10})
	got := c.Profile()
	if !got.ReadOnly || got.PageSize != 10 {
		t.Errorf("settings not applied: %+v", got)
	}
	if got.Host != "h1" {
		t.Errorf("identity changed on live client: host = %q", got.Host)
	}
}

func TestSearchControls(t *testing.T) {
	if got := searchControls(models.SearchParams{}); len(got) != 0 {
		t.Errorf("no flags: %v", got)
	}
	got := searchControls(models.SearchParams{ShowDeleted: true, ShowRecycled: true, ManageDsaIT: true})
	var types []string
	for _, c := range got {
		types = append(types, c.GetControlType())
	}
	want := []string{"1.2.840.113556.1.4.417", "1.2.840.113556.1.4.2064", "2.16.840.1.113730.3.4.2"}
	if !reflect.DeepEqual(types, want) {
		t.Errorf("control types = %v, want %v", types, want)
	}
}

func TestWithoutControl(t *testing.T) {
	base := []goldap.Control{goldap.NewControlManageDsaIT(true), goldap.NewControlPaging(10)}
	got := withoutControl(base, goldap.ControlTypePaging)
	if len(got) != 1 || got[0].GetControlType() != goldap.ControlTypeManageDsaIT {
		t.Errorf("withoutControl = %v", got)
	}
	if len(base) != 2 {
		t.Error("input modified")
	}
}

func TestDetectServerType(t *testing.T) {
	tests := []struct {
		name string
		info models.ServerInfo
		ocs  []string
		want string
	}{
		{"ad", models.ServerInfo{SupportedCapabilities: []string{"1.2.840.113556.1.4.800", "1.2.840.113556.1.4.1670"}}, nil, models.ServerTypeAD},
		{"389ds", models.ServerInfo{VendorName: "389 Project"}, []string{"top"}, models.ServerType389DS},
		{"red hat", models.ServerInfo{VendorName: "Red Hat, Inc."}, nil, models.ServerType389DS},
		{"openldap", models.ServerInfo{}, []string{"top", "OpenLDAProotDSE"}, models.ServerTypeOpenLDAP},
		{"other", models.ServerInfo{VendorName: "Example"}, []string{"top"}, models.ServerTypeOther},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := detectServerType(&tt.info, tt.ocs); got != tt.want {
				t.Errorf("detectServerType = %q, want %q", got, tt.want)
			}
		})
	}
}
