package ai

import (
	"encoding/json"
	"os"
	"testing"
)

// The vectors are shared with the composer (frontend/src/lib/aiPassword.ts,
// frontend/tests/ai/password.test.mjs).
func TestMaskPasswordsSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../frontend/tests/ai/password-phrases.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			Text   string  `json:"text"`
			Masked string  `json:"masked"`
			Sure   *string `json:"sure"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) < 30 {
		t.Fatalf("only %d cases", len(f.Cases))
	}
	for _, c := range f.Cases {
		sure := c.Masked
		if c.Sure != nil {
			sure = *c.Sure
		}
		if got := MaskPasswordsAll(c.Text); got != c.Masked {
			t.Errorf("MaskPasswordsAll(%q)\n got  %q\n want %q", c.Text, got, c.Masked)
		}
		if got := MaskPasswords(c.Text); got != sure {
			t.Errorf("MaskPasswords(%q)\n got  %q\n want %q", c.Text, got, sure)
		}
		if got := HasPasswordValue(c.Text); got != (sure != c.Text) {
			t.Errorf("HasPasswordValue(%q) = %v", c.Text, got)
		}
		if got := MaskPasswordsAll(c.Masked); got != c.Masked {
			t.Errorf("not idempotent: %q → %q", c.Masked, got)
		}
	}
}

func TestLooksRandomToken(t *testing.T) {
	for s, want := range map[string]bool{
		"use aB3dE5fG7hJ9kL1mN3pQ for the bind":              true,
		"objectGUID 6f9619ff-8b86-d011-b42d-00cf4fc964ff":    false,
		"CN=Anna Schmidt,OU=Users,DC=corp,DC=example,DC=com": false,
		"short Passw0rd!": false,
	} {
		if got := LooksRandomToken(s); got != want {
			t.Errorf("LooksRandomToken(%q) = %v", s, got)
		}
	}
}

func TestPasswordValues(t *testing.T) {
	got := PasswordValues(`Reset the password of jdoe to Sommer2026!, and of anna to 'Herbst 26!' (PW: geheim)`)
	if len(got) != 2 || got[0] != "Sommer2026!" || got[1] != "Herbst 26!" {
		t.Fatalf("%q", got)
	}
	if v := PasswordValues("PW: geheim"); len(v) != 0 {
		t.Fatalf("a plain word after a label is not sure: %q", v)
	}
	if MaskPasswordsAll("PW: geheim") != "PW: [password removed]" || MaskPasswords("PW: geheim") != "PW: geheim" {
		t.Fatal("MaskPasswordsAll / MaskPasswords")
	}
}
