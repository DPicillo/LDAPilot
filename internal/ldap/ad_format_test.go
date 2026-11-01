package ldap

import (
	"bytes"
	"encoding/base64"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// The text of objectGUID / objectSid goes back to exactly the raw bytes.
func TestRawADValuesRoundTrip(t *testing.T) {
	guid := []byte{0x7e, 0xd5, 0x60, 0x9c, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x01, 0x02, 0x03, 0x04}
	sid := []byte{1, 5, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xe9, 0x03, 0, 0}
	gs, ok := formatGUID(guid)
	if !ok {
		t.Fatal("formatGUID")
	}
	ss, ok := formatSID(sid)
	if !ok || ss != "S-1-5-21-1144201745-2289526357-3434850969-1001" {
		t.Fatalf("formatSID = %q", ss)
	}
	for _, tc := range []struct {
		name string
		text string
		raw  []byte
	}{{"objectGUID", gs, guid}, {"objectSid", ss, sid}, {"msExchMailboxGuid", gs, guid}} {
		got := RawADValues(models.LDAPAttribute{Name: tc.name, Values: []string{tc.text}})
		if !got.Binary || len(got.Values) != 1 {
			t.Fatalf("%s: %+v", tc.name, got)
		}
		raw, err := base64.StdEncoding.DecodeString(got.Values[0])
		if err != nil || !bytes.Equal(raw, tc.raw) {
			t.Fatalf("%s: raw %x, want %x", tc.name, raw, tc.raw)
		}
	}
	// Unparsable text, binary values and other attributes stay as they are.
	for _, a := range []models.LDAPAttribute{
		{Name: "objectGUID", Values: []string{"not-a-guid"}},
		{Name: "objectGUID", Values: []string{"AAEC"}, Binary: true},
		{Name: "cn", Values: []string{gs}},
		{Name: "objectSid", Values: []string{"S-1-x"}},
	} {
		if got := RawADValues(a); got.Binary != a.Binary || got.Values[0] != a.Values[0] {
			t.Errorf("%+v changed to %+v", a, got)
		}
	}
}
