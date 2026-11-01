package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// A profile that asks for the password on every connect (DEF-07) never has a
// password on disk: not one that could not be decrypted (sealed), not one
// written into the file by hand.
func TestStoreAskPasswordStoresNoPassword(t *testing.T) {
	dir := withTempConfig(t)
	st, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	a, _ := st.Add(models.ConnectionProfile{Name: "A", Password: "secret-a"})
	// Key briefly unreadable: A's password is sealed (kept as ciphertext).
	keyPath := filepath.Join(dir, keyFileName)
	key, _ := os.ReadFile(keyPath)
	if err := os.WriteFile(keyPath, key[:16], 0o600); err != nil {
		t.Fatal(err)
	}
	resetAppKeyCache()
	st2, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	pa, _ := st2.Get(a.ID)
	pa.AskPassword = true
	if _, err := st2.Update(*pa); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "connections.json"))
	if strings.Contains(string(raw), encPrefix) {
		t.Fatalf("sealed password written back for an ask-password profile:\n%s", raw)
	}
	if err := os.WriteFile(keyPath, key, 0o600); err != nil {
		t.Fatal(err)
	}
	resetAppKeyCache()

	// A password added to the file by hand is ignored and not written back.
	editConnectionsFile(t, dir, func(list []map[string]any) []map[string]any {
		for _, p := range list {
			p["password"] = "hand-written"
		}
		return list
	})
	st3, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	p, _ := st3.Get(a.ID)
	if p.Password != "" || !p.AskPassword {
		t.Fatalf("loaded = %+v", p)
	}
	p.PageSize = 42
	if _, err := st3.Update(*p); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(filepath.Join(dir, "connections.json"))
	if strings.Contains(string(raw), "hand-written") || strings.Contains(string(raw), encPrefix) {
		t.Fatalf("password kept:\n%s", raw)
	}
}
