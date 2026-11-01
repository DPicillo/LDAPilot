package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// A password that cannot be decrypted (key briefly unreadable) is kept as
// ciphertext and written back on the next save, never erased.
func TestStoreKeepsUndecryptablePasswords(t *testing.T) {
	dir := withTempConfig(t)
	st, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	a, _ := st.Add(models.ConnectionProfile{Name: "A", Password: "secret-a"})
	b, _ := st.Add(models.ConnectionProfile{Name: "B", Password: "secret-b"})
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
	pb, _ := st2.Get(b.ID)
	if pb.Password != "" {
		t.Fatal("undecryptable password returned")
	}
	pb.PageSize = 77
	if _, err := st2.Update(*pb); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "connections.json"))
	if n := strings.Count(string(raw), encPrefix); n != 2 {
		t.Fatalf("ciphertexts after save: %d\n%s", n, raw)
	}
	if err := os.WriteFile(keyPath, key, 0o600); err != nil {
		t.Fatal(err)
	}
	resetAppKeyCache()
	st3, _ := NewStore()
	for id, want := range map[string]string{a.ID: "secret-a", b.ID: "secret-b"} {
		p, _ := st3.Get(id)
		if p.Password != want {
			t.Fatalf("%s: password %q after the key came back", id, p.Password)
		}
	}
}

// editConnectionsFile changes connections.json like a text editor would
// (encrypted passwords stay as they are).
func editConnectionsFile(t *testing.T, dir string, edit func(list []map[string]any) []map[string]any) {
	t.Helper()
	path := filepath.Join(dir, "connections.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var list []map[string]any
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	out, _ := json.MarshalIndent(edit(list), "", "  ")
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatal(err)
	}
}

func renameInFile(id, name string) func([]map[string]any) []map[string]any {
	return func(list []map[string]any) []map[string]any {
		for _, p := range list {
			if p["id"] == id {
				p["name"] = name
			}
		}
		return list
	}
}

// An external edit (rename of B) followed by a delete in the app (A) keeps
// the edit, and the change handler is told about the reload.
func TestStoreKeepsExternalEditOnDelete(t *testing.T) {
	dir := withTempConfig(t)
	st, err := NewStore()
	if err != nil {
		t.Fatal(err)
	}
	notified := 0
	st.SetExternalChangeHandler(func() { notified++ })
	a, _ := st.Add(models.ConnectionProfile{Name: "A", Password: "secret-a"})
	b, _ := st.Add(models.ConnectionProfile{Name: "B", Password: "secret-b"})
	if notified != 0 {
		t.Fatalf("own writes reported as external: %d", notified)
	}
	editConnectionsFile(t, dir, renameInFile(b.ID, "B (edited)"))

	if err := st.Delete(a.ID); err != nil {
		t.Fatal(err)
	}
	if notified != 1 {
		t.Fatalf("external change notifications: %d", notified)
	}
	fresh, _ := NewStore()
	all := fresh.GetAll()
	if len(all) != 1 || all[0].ID != b.ID || all[0].Name != "B (edited)" || all[0].Password != "secret-b" {
		t.Fatalf("after delete: %+v", all)
	}
	if p, _ := st.Get(b.ID); p == nil || p.Name != "B (edited)" {
		t.Fatalf("store not reloaded: %+v", p)
	}
}

// An external edit of another profile does not block an update; the update
// is applied on top of it. An external edit of the same profile is refused
// (and reloaded), so repeating the change works.
func TestStoreUpdateAfterExternalEdit(t *testing.T) {
	dir := withTempConfig(t)
	st, _ := NewStore()
	a, _ := st.Add(models.ConnectionProfile{Name: "A"})
	b, _ := st.Add(models.ConnectionProfile{Name: "B"})

	editConnectionsFile(t, dir, renameInFile(b.ID, "B2"))
	upd := *a
	upd.PageSize = 77
	if _, err := st.Update(upd); err != nil {
		t.Fatalf("update of another profile: %v", err)
	}
	fresh, _ := NewStore()
	if pa, _ := fresh.Get(a.ID); pa.PageSize != 77 {
		t.Fatalf("update lost: %+v", pa)
	}
	if pb, _ := fresh.Get(b.ID); pb.Name != "B2" {
		t.Fatalf("external edit lost: %+v", pb)
	}

	editConnectionsFile(t, dir, renameInFile(a.ID, "A (edited)"))
	upd.PageSize = 88
	if _, err := st.Update(upd); !errors.Is(err, ErrExternalChange) {
		t.Fatalf("conflicting update: %v", err)
	}
	if pa, _ := st.Get(a.ID); pa.Name != "A (edited)" || pa.PageSize != 77 {
		t.Fatalf("not reloaded after the conflict: %+v", pa)
	}
	again, _ := st.Get(a.ID)
	again.PageSize = 88
	if _, err := st.Update(*again); err != nil {
		t.Fatalf("repeated update: %v", err)
	}

	// Deleted outside: an update is refused, a delete is a no-op.
	removeFromFile := func(id string) func([]map[string]any) []map[string]any {
		return func(list []map[string]any) []map[string]any {
			var out []map[string]any
			for _, p := range list {
				if p["id"] != id {
					out = append(out, p)
				}
			}
			return out
		}
	}
	editConnectionsFile(t, dir, removeFromFile(a.ID))
	if _, err := st.Update(*again); !errors.Is(err, ErrExternalChange) {
		t.Fatalf("update of an externally deleted profile: %v", err)
	}
	if _, err := st.Get(a.ID); err == nil {
		t.Fatal("externally deleted profile still in the store")
	}
	editConnectionsFile(t, dir, removeFromFile(b.ID))
	if err := st.Delete(b.ID); err != nil {
		t.Fatalf("delete of an externally deleted profile: %v", err)
	}
}

// A file that cannot be parsed any more is never overwritten.
func TestStoreRefusesToOverwriteBrokenFile(t *testing.T) {
	dir := withTempConfig(t)
	st, _ := NewStore()
	st.Add(models.ConnectionProfile{Name: "A"})
	path := filepath.Join(dir, "connections.json")
	if err := os.WriteFile(path, []byte("[{ broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Add(models.ConnectionProfile{Name: "B"}); !errors.Is(err, ErrExternalChange) {
		t.Fatalf("add over a broken file: %v", err)
	}
	if raw, _ := os.ReadFile(path); string(raw) != "[{ broken" {
		t.Fatalf("broken file overwritten: %s", raw)
	}
}
