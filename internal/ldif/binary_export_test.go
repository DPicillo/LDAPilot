package ldif

import (
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// Values that are not SAFE-STRINGs are written base64 and parse back
// unchanged; long lines are folded at 76 columns.
func TestBinaryExportUnsafeValuesAndFolding(t *testing.T) {
	values := []string{"trailing ", " leading", ":colon", "<angle", "a\nb", "cr\r", "Jürgen", "tab\there", strings.Repeat("x", 200)}
	entry := models.LDAPEntry{DN: "cn=Jürgen Weiß,dc=example", Attributes: []models.LDAPAttribute{{Name: "description", Values: values}}}
	out, err := Export([]models.LDAPEntry{entry})
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(out, "\n") {
		if len(line) > 76 {
			t.Errorf("line longer than 76 columns: %q", line)
		}
	}
	if !strings.Contains(out, "description:: dHJhaWxpbmcg\n") {
		t.Errorf("trailing space not base64 encoded:\n%s", out)
	}
	parsed, err := Parse(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed) != 1 || parsed[0].DN != entry.DN {
		t.Fatalf("parsed = %+v", parsed)
	}
	got := parsed[0].Attributes[0]
	if got.Binary || len(got.Values) != len(values) {
		t.Fatalf("parsed attribute = %+v", got)
	}
	for i, v := range values {
		if got.Values[i] != v {
			t.Errorf("value %d = %q, want %q", i, got.Values[i], v)
		}
	}
}
