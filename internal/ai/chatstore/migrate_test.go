package chatstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

const legacyID = "3f2c1a8e-1111-4222-8333-444455556666"

func legacyFixture() map[string]any {
	return map[string]any{
		"id": legacyID, "title": "Which users are locked \xc3...", "createdAt": 1700000000000, "updatedAt": 1700000005000,
		"messages": []map[string]string{
			{"role": "system", "content": "You are an LDAP assistant."},
			{"role": "user", "content": "Which users are locked out?"},
			{"role": "assistant", "content": "", "toolCalls": `[{"id":"call_1","type":"function","function":{"name":"search_ldap","arguments":"{}"}}]`},
			{"role": "tool", "content": `{"entries":[]}`, "toolCallId": "call_1"},
			{"role": "assistant", "content": "Let me check."},
			{"role": "assistant", "content": "No locked users found."},
			{"role": "user", "content": "Thanks"},
		},
	}
}

func TestLegacyMigration(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, v any) {
		b, _ := json.Marshal(v)
		os.WriteFile(filepath.Join(dir, name), b, 0o600)
	}
	write(legacyID+".json", legacyFixture())
	corruptID := "3f2c1a8e-1111-4222-8333-000000000002"
	os.WriteFile(filepath.Join(dir, corruptID+".json"), []byte("{not json"), 0o600)
	os.WriteFile(filepath.Join(dir, "notes.json"), []byte(`{"keep":"me"}`), 0o600)

	s := openStore(t, dir)
	// Plaintext removed only for the migrated chat.
	if _, err := os.Stat(filepath.Join(dir, legacyID+".json")); !os.IsNotExist(err) {
		t.Fatal("plaintext chat not removed")
	}
	if _, err := os.Stat(filepath.Join(dir, corruptID+".json")); err != nil {
		t.Fatal("failed file removed")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "notes.json")); string(b) != `{"keep":"me"}` {
		t.Fatal("non-UUID file touched")
	}
	c, err := s.Get(legacyID)
	if err != nil {
		t.Fatal(err)
	}
	if c.MigratedFrom != 1 || c.CreatedAt != 1700000000000 || c.UpdatedAt != 1700000005000 {
		t.Fatalf("chat %+v", c)
	}
	if c.Title != "Which users are locked…" || c.TitleSource != "auto" {
		t.Fatalf("title %q (%s)", c.Title, c.TitleSource)
	}
	var shape []string
	for _, m := range c.Messages {
		var texts []string
		for _, b := range m.Blocks {
			if b.Type != ai.BlockText {
				t.Fatalf("non-text block %+v", b)
			}
			texts = append(texts, b.Text)
		}
		shape = append(shape, string(m.Role)+":"+strings.Join(texts, "|"))
		if ValidateID(m.ID) != nil {
			t.Fatalf("message ID %q", m.ID)
		}
	}
	want := "user:Which users are locked out?,assistant:Let me check.|No locked users found.,user:Thanks"
	if strings.Join(shape, ",") != want {
		t.Fatalf("messages %s", strings.Join(shape, ","))
	}
	list, _ := s.List()
	var corrupt *ai.ChatSummary
	for i := range list {
		if list[i].ID == corruptID {
			corrupt = &list[i]
		}
	}
	if len(list) != 2 || corrupt == nil || !corrupt.Corrupt || corrupt.Note != "legacy chat could not be migrated" {
		t.Fatalf("list %+v", list)
	}
	// Reopen: no double migration, still listed.
	s.Close()
	s2 := openStore(t, dir)
	list2, _ := s2.List()
	if len(list2) != 2 {
		t.Fatalf("reopen %+v", list2)
	}
	// Crash between write and remove: a .json next to a valid .chat is dropped.
	b, _ := json.Marshal(legacyFixture())
	os.WriteFile(filepath.Join(dir, legacyID+".json"), b, 0o600)
	s2.Close()
	s3 := openStore(t, dir)
	if _, err := os.Stat(filepath.Join(dir, legacyID+".json")); !os.IsNotExist(err) {
		t.Fatal("leftover plaintext not removed")
	}
	if got, _ := s3.Get(legacyID); len(got.Messages) != 3 {
		t.Fatal("migrated chat changed")
	}
}

func TestLegacyMigrationReadOnlyInstanceDoesNothing(t *testing.T) {
	dir := t.TempDir()
	_ = openStore(t, dir) // holds the lock
	b, _ := json.Marshal(legacyFixture())
	os.WriteFile(filepath.Join(dir, legacyID+".json"), b, 0o600)
	s2, err := Open(dir, testOpts())
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if _, err := os.Stat(filepath.Join(dir, legacyID+".json")); err != nil {
		t.Fatal("read-only instance migrated")
	}
}

// A legacy chat with a typed password migrates (readChat masks it, so the
// check after the write must compare the masked chat).
func TestLegacyMigrationWithTypedPassword(t *testing.T) {
	dir := t.TempDir()
	fx := legacyFixture()
	fx["messages"] = append(fx["messages"].([]map[string]string), map[string]string{"role": "user", "content": "Set the password of jdoe to Sommer2026!"})
	b, _ := json.Marshal(fx)
	os.WriteFile(filepath.Join(dir, legacyID+".json"), b, 0o600)
	s := openStore(t, dir)
	if _, err := os.Stat(filepath.Join(dir, legacyID+".json")); !os.IsNotExist(err) {
		t.Fatal("plaintext chat not removed (migration failed)")
	}
	c, err := s.Get(legacyID)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(c)
	if strings.Contains(string(raw), "Sommer2026") || !strings.Contains(string(raw), ai.PasswordPlaceholder) {
		t.Fatalf("%s", raw)
	}
}
