package chatstore

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/aitest"
	"github.com/dpicillo/LDAPilot/internal/config"
)

type keyCipher struct{ key []byte }

func (k keyCipher) Seal(p, aad []byte) ([]byte, error) { return config.SealWithKey(k.key, p, aad) }
func (k keyCipher) Open(s, aad []byte) ([]byte, error) { return config.OpenWithKey(k.key, s, aad) }

var testKey = bytes.Repeat([]byte{0x42}, 32)

func testOpts() Options {
	return Options{Cipher: keyCipher{testKey}, Clock: aitest.NewFakeClock(), IDs: &aitest.SeqIDs{}}
}

func openStore(t *testing.T, dir string) *Store {
	t.Helper()
	s, err := Open(dir, testOpts())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func TestValidateID(t *testing.T) {
	for _, bad := range []string{"../connections", `..\connections`, "", "a/b", "6F9619FF-8B86-D011-B42D-00C04FC964FF", "6f9619ff-8b86-4011-b42d-00c04fc964ff.json", " 6f9619ff-8b86-4011-b42d-00c04fc964ff", "/etc/passwd", "{6f9619ff-8b86-4011-b42d-00c04fc964ff}", "urn:uuid:6f9619ff-8b86-4011-b42d-00c04fc964ff"} {
		if ValidateID(bad) != ErrInvalidChatID {
			t.Errorf("%q accepted", bad)
		}
	}
	if ValidateID("6f9619ff-8b86-4011-b42d-00c04fc964ff") != nil {
		t.Fatal("valid ID rejected")
	}
}

func TestDeletePathTraversalPoC(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "chats")
	conn := filepath.Join(parent, "connections.json")
	os.WriteFile(conn, []byte(`[]`), 0o600)
	s := openStore(t, dir)
	for _, id := range []string{"../connections", "..%2Fconnections", "../connections.json"} {
		if err := s.Delete(id); !errors.Is(err, ErrInvalidChatID) {
			t.Fatalf("%s: %v", id, err)
		}
		if _, err := s.Get(id); !errors.Is(err, ErrInvalidChatID) {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(conn); err != nil {
		t.Fatal("connections.json deleted")
	}
}

func TestRoundTripEncryptedAndAAD(t *testing.T) {
	dir := t.TempDir()
	s := openStore(t, dir)
	c, err := s.Create("  Hello   world  ")
	if err != nil {
		t.Fatal(err)
	}
	if c.Title != "Hello world" {
		t.Fatalf("title %q", c.Title)
	}
	err = s.Update(c.ID, func(ch *Chat) error {
		ch.Messages = append(ch.Messages, ai.Message{ID: "m1", Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockText, Text: "secret question about CN=Alice"}}})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, c.ID+".chat"))
	if bytes.Contains(raw, []byte("secret question")) || !bytes.Contains(raw, []byte(`"format":"ldapilot-chat"`)) {
		t.Fatalf("not encrypted: %s", raw)
	}
	info, _ := os.Stat(filepath.Join(dir, c.ID+".chat"))
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode())
	}
	got, err := s.Get(c.ID)
	if err != nil || len(got.Messages) != 1 || got.Messages[0].Blocks[0].Text != "secret question about CN=Alice" {
		t.Fatalf("%+v %v", got, err)
	}
	// AAD binding: copying chat A to B's name makes B corrupt, listed (not skipped).
	b, _ := s.Create("B")
	os.WriteFile(filepath.Join(dir, b.ID+".chat"), raw, 0o600)
	s.Close()
	s2 := openStore(t, dir)
	list, _ := s2.List()
	var corrupt int
	for _, e := range list {
		if e.Corrupt {
			corrupt++
			if e.ID != b.ID {
				t.Fatal("wrong chat flagged")
			}
		}
	}
	if corrupt != 1 || len(list) != 2 {
		t.Fatalf("list %+v", list)
	}
	if _, err := s2.Get(b.ID); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("get copied chat: %v", err)
	}
}

func TestUpdateMissingAndDelete(t *testing.T) {
	s := openStore(t, t.TempDir())
	c, _ := s.Create("x")
	if err := s.Delete(c.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Update(c.ID, func(*Chat) error { return nil }); !errors.Is(err, ErrNotFound) {
		t.Fatalf("update after delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.Dir(), c.ID+".chat")); !os.IsNotExist(err) {
		t.Fatal("chat resurrected")
	}
	if err := s.Delete(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	list, _ := s.List()
	if len(list) != 0 {
		t.Fatal("deleted chat listed")
	}
}

func TestRenameAndMessagesSince(t *testing.T) {
	s := openStore(t, t.TempDir())
	c, _ := s.Create("x")
	s.Update(c.ID, func(ch *Chat) error {
		for i := 1; i <= 3; i++ {
			ch.Messages = append(ch.Messages, ai.Message{ID: fmt.Sprintf("m%d", i), Role: ai.RoleUser})
		}
		return nil
	})
	long := strings.Repeat("ä", 80) + "​"
	if err := s.Rename(c.ID, long); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(c.ID)
	if got.TitleSource != "user" || !strings.HasSuffix(got.Title, "…") || strings.Contains(got.Title, "​") || len([]rune(got.Title)) != 61 {
		t.Fatalf("title %q", got.Title)
	}
	msgs, _ := s.Messages(c.ID, "m1")
	if len(msgs) != 2 || msgs[0].ID != "m2" {
		t.Fatalf("since %+v", msgs)
	}
}

func TestTempCleanupAndIgnore(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, ".0a7c1a8e-0000-4000-8000-000000000001.chat.tmp-abc")
	fresh := filepath.Join(dir, ".index.chat.tmp-def")
	os.WriteFile(old, []byte("partial"), 0o600)
	os.WriteFile(fresh, []byte("partial"), 0o600)
	opts := testOpts()
	past := opts.Clock.Now().Add(-2 * time.Hour)
	os.Chtimes(old, past, past)
	os.Chtimes(fresh, opts.Clock.Now(), opts.Clock.Now())
	s, err := Open(dir, opts)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("stale temp file not removed")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("fresh temp file removed")
	}
	list, _ := s.List()
	if len(list) != 0 {
		t.Fatalf("temp files listed: %+v", list)
	}
}

func TestDirectoryLockReadOnly(t *testing.T) {
	dir := t.TempDir()
	s1 := openStore(t, dir)
	c, _ := s1.Create("first")
	s2, err := Open(dir, testOpts())
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if !s2.ReadOnly() || s1.ReadOnly() {
		t.Fatal("second instance not read-only")
	}
	if _, err := s2.Create("x"); !errors.Is(err, ErrReadOnly) {
		t.Fatal(err)
	}
	if err := s2.Delete(c.ID); !errors.Is(err, ErrReadOnly) {
		t.Fatal(err)
	}
	if err := s2.Rename(c.ID, "y"); !errors.Is(err, ErrReadOnly) {
		t.Fatal(err)
	}
	if got, err := s2.Get(c.ID); err != nil || got.Title != "first" {
		t.Fatal("read-only get")
	}
	s1.Create("second")
	if list, _ := s2.List(); len(list) != 2 {
		t.Fatalf("read-only list does not see the other instance's chats: %d", len(list))
	}
	// After the first instance closes, a new Open gets the lock.
	s1.Close()
	s3, _ := Open(dir, testOpts())
	defer s3.Close()
	if s3.ReadOnly() {
		t.Fatal("lock not released")
	}
}

func TestIndexReconciliation(t *testing.T) {
	dir := t.TempDir()
	s := openStore(t, dir)
	a, _ := s.Create("a")
	b, _ := s.Create("b")
	s.Update(a.ID, func(c *Chat) error {
		c.Messages = []ai.Message{{ID: "m", Role: ai.RoleAssistant, Blocks: []ai.Block{{Type: ai.BlockToolUse, ID: "t", Name: "modify_entry", Meta: &ai.BlockMeta{Executing: true}}}}}
		return nil
	})
	before, _ := s.List()
	s.Close()

	// Rebuilt index equals the original.
	os.Remove(filepath.Join(dir, indexName))
	s2 := openStore(t, dir)
	rebuilt, _ := s2.List()
	bj, _ := json.Marshal(before)
	rj, _ := json.Marshal(rebuilt)
	if string(bj) != string(rj) {
		t.Fatalf("rebuilt index differs:\n%s\n%s", bj, rj)
	}
	if got := s2.PendingWriteChats(); len(got) != 1 || got[0] != a.ID {
		t.Fatalf("pending write lost: %v", got)
	}
	s2.Close()

	// Dangling entry dropped, missing entry added.
	os.Remove(filepath.Join(dir, b.ID+".chat"))
	extra := &Chat{ID: "0a7c1a8e-0000-4000-8000-0000000000ff", Title: "extra", Messages: []ai.Message{}}
	s3raw, _ := Open(dir, testOpts())
	s3raw.writeChat(extra)
	s3raw.Close()
	s4 := openStore(t, dir)
	list, _ := s4.List()
	ids := map[string]bool{}
	for _, e := range list {
		ids[e.ID] = true
	}
	if ids[b.ID] || !ids[extra.ID] || !ids[a.ID] || len(list) != 2 {
		t.Fatalf("reconciled list %+v", list)
	}
	if got := s4.PendingWriteChats(); len(got) != 1 {
		t.Fatal("PendingWrite did not survive reconciliation")
	}
}

func TestConcurrentUpdates(t *testing.T) {
	s := openStore(t, t.TempDir())
	c, _ := s.Create("x")
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			err := s.Update(c.ID, func(ch *Chat) error {
				ch.Messages = append(ch.Messages, ai.Message{ID: fmt.Sprint(i), Role: ai.RoleUser})
				return nil
			})
			if err != nil {
				t.Error(err)
			}
		}(i)
	}
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); s.List(); s.Create("y") }()
	}
	wg.Wait()
	got, _ := s.Get(c.ID)
	if len(got.Messages) != 20 {
		t.Fatalf("lost updates: %d", len(got.Messages))
	}
}

func TestKeyUnavailableDegraded(t *testing.T) {
	opts := testOpts()
	opts.KeyCheck = func() error { return errors.New("permission denied") }
	_, err := Open(t.TempDir(), opts)
	var ue *UnavailableError
	if !errors.As(err, &ue) || !strings.Contains(ue.Reason, "encryption key") {
		t.Fatalf("err %v", err)
	}
}

func TestRenameRetry(t *testing.T) {
	calls := 0
	var slept []time.Duration
	fail := errors.New("sharing violation")
	rename := func(a, b string) error {
		calls++
		if calls < 4 {
			return &os.LinkError{Op: "rename", Old: a, New: b, Err: fail}
		}
		return nil
	}
	// On non-Windows, isSharingViolationErr is false: no retry.
	err := retryRename(rename, "a", "b", func(d time.Duration) { slept = append(slept, d) })
	if isSharingViolationErr(fail) {
		if err != nil || calls != 4 || len(slept) != 3 || slept[2] != 80*time.Millisecond {
			t.Fatalf("calls %d slept %v err %v", calls, slept, err)
		}
	} else if err == nil || calls != 1 {
		t.Fatalf("non-windows: calls %d err %v", calls, err)
	}
}

func TestDefaultOptionsUseAppKey(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)
	t.Setenv("HOME", base)
	dir := filepath.Join(base, "LDAPilot", "chats")
	s, err := Open(dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, err := s.Create("hello")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := s.Get(c.ID); err != nil || got.Title != "hello" {
		t.Fatal(err)
	}
}

// Review 2b: unused "New chat" chats of earlier sessions are pruned; used,
// renamed, model-pinned and recent ones stay.
func TestPruneEmpty(t *testing.T) {
	s := openStore(t, t.TempDir())
	empty, _ := s.Create("")
	used, _ := s.Create("")
	_ = s.Update(used.ID, func(c *Chat) error {
		c.Messages = append(c.Messages, ai.Message{ID: "m1", Role: ai.RoleUser})
		return nil
	})
	named, _ := s.Create("Kept on purpose")
	pinned, _ := s.Create("")
	_ = s.Update(pinned.ID, func(c *Chat) error { c.ModelOverride = "qwen3"; return nil })
	now := s.opts.Clock.Now().UnixMilli()
	if n := s.PruneEmpty(now - 1); n != 0 {
		t.Fatalf("recent chats pruned: %d", n)
	}
	if n := s.PruneEmpty(now + 1); n != 1 {
		t.Fatalf("pruned %d", n)
	}
	list, _ := s.List()
	ids := map[string]bool{}
	for _, c := range list {
		ids[c.ID] = true
	}
	if ids[empty.ID] || !ids[used.ID] || !ids[named.ID] || !ids[pinned.ID] {
		t.Fatalf("left %v", ids)
	}
}

// UX A-13: a password typed into a chat before the composer refused it is
// masked when the chat is read (shown, exported, sent to the provider) and
// in the chat list.
func TestOlderChatsMaskTypedPasswords(t *testing.T) {
	dir := t.TempDir()
	s := openStore(t, dir)
	c, err := s.Create("Set the password of jdoe to Sommer2026!")
	if err != nil {
		t.Fatal(err)
	}
	err = s.Update(c.ID, func(ch *Chat) error {
		ch.Title = "Set the password of jdoe to Sommer2026!"
		ch.Messages = append(ch.Messages,
			ai.Message{ID: "m1", Role: ai.RoleUser, Blocks: []ai.Block{
				{Type: ai.BlockText, Text: "<ldapilot_context>password: keep-me</ldapilot_context>", Meta: &ai.BlockMeta{Kind: "context"}},
				{Type: ai.BlockText, Text: "Kennwort auf Sommer2026! setzen"},
			}},
			ai.Message{ID: "m2", Role: ai.RoleAssistant, Blocks: []ai.Block{{Type: ai.BlockText, Text: "The password is hunter2"}}})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Set the password of jdoe to [password removed]" {
		t.Errorf("title %q", got.Title)
	}
	if b := got.Messages[0].Blocks[1].Text; b != "Kennwort auf [password removed] setzen" {
		t.Errorf("user text %q", b)
	}
	if b := got.Messages[0].Blocks[0].Text; !strings.Contains(b, "keep-me") {
		t.Errorf("context block changed: %q", b)
	}
	if b := got.Messages[1].Blocks[0].Text; b != "The password is [password removed]" {
		t.Errorf("assistant text %q", b)
	}
	list, _ := s.List()
	for _, cs := range list {
		if strings.Contains(cs.Title, "Sommer2026") {
			t.Errorf("list title %q", cs.Title)
		}
	}
}

// Answers of chats without a typed password are never rewritten (Markdown
// like "**Password generated**:" stays as it is).
func TestAnswersWithoutTypedPasswordUntouched(t *testing.T) {
	s := openStore(t, t.TempDir())
	c, _ := s.Create("Reset jdoe")
	answer := "✅ **Password status**: The password is Sommer2026!"
	s.Update(c.ID, func(ch *Chat) error {
		ch.Messages = append(ch.Messages,
			ai.Message{ID: "m1", Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockText, Text: "Reset the password of jdoe."}}},
			ai.Message{ID: "m2", Role: ai.RoleAssistant, Blocks: []ai.Block{{Type: ai.BlockText, Text: answer}}})
		return nil
	})
	got, _ := s.Get(c.ID)
	if b := got.Messages[1].Blocks[0].Text; b != answer {
		t.Errorf("answer changed: %q", b)
	}
}

// A typed password is also removed where the model repeated it: thinking,
// tool-call inputs, summaries and compaction summaries (review of A-13);
// a Claude Code session to resume is dropped.
func TestTypedPasswordMaskedEverywhere(t *testing.T) {
	s := openStore(t, t.TempDir())
	c, _ := s.Create("x")
	s.Update(c.ID, func(ch *Chat) error {
		ch.ClaudeSessionID = "sess"
		ch.Messages = append(ch.Messages,
			ai.Message{ID: "m1", Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockText, Text: "Set the password of jdoe to Sommer2026!"}}},
			ai.Message{ID: "m2", Role: ai.RoleAssistant, Blocks: []ai.Block{
				{Type: ai.BlockThinking, Thinking: "The user wants Sommer2026! as the password.", Signature: "sig"},
				{Type: ai.BlockToolUse, ID: "t1", Name: "modify_entry", Input: json.RawMessage(`{"dn":"uid=jdoe,dc=x","changes":[{"operation":"replace","attribute":"userPassword","values":["Other#2026"]}],"explanation":"set Sommer2026!"}`)},
				{Type: ai.BlockText, Text: "I set Sommer2026! for jdoe."},
			}},
			ai.Message{ID: "m3", Role: ai.RoleUser, Blocks: []ai.Block{{Type: ai.BlockText, Text: "Summary: jdoe gets Sommer2026!", Meta: &ai.BlockMeta{Kind: "summary"}}}})
		ch.Compactions = []ai.CompactionMarker{{ID: "c1", Summary: "The user set Sommer2026! for jdoe."}}
		return nil
	})
	got, err := s.Get(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(got)
	for _, leak := range []string{"Sommer2026", "Other#2026"} {
		if strings.Contains(string(b), leak) {
			t.Errorf("%s still in the chat: %s", leak, b)
		}
	}
	if th := got.Messages[1].Blocks[0]; th.Signature != "" || !strings.Contains(th.Thinking, ai.PasswordPlaceholder) {
		t.Errorf("thinking %+v", th)
	}
	if got.ClaudeSessionID != "" {
		t.Error("Claude Code session kept")
	}
	// a second read changes nothing (idempotent)
	again, _ := s.Get(c.ID)
	b2, _ := json.Marshal(again)
	if string(b) != string(b2) {
		t.Errorf("not idempotent:\n%s\n%s", b, b2)
	}
}

// A-07 review: a chat deleted with Undo time is hidden at once, comes back
// with Restore, and is deleted when the store closes (LDAPilot quits) or at
// the next Open after a crash — never shown again.
func TestDeleteLater(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, testOpts())
	if err != nil {
		t.Fatal(err)
	}
	a, _ := s.Create("a")
	b, _ := s.Create("b")
	listed := func(st *Store, id string) bool {
		l, _ := st.List()
		for _, c := range l {
			if c.ID == id {
				return true
			}
		}
		return false
	}
	if err := s.DeleteLater(a.ID); err != nil {
		t.Fatal(err)
	}
	if listed(s, a.ID) {
		t.Fatal("pending chat listed")
	}
	if err := s.Restore(a.ID); err != nil || !listed(s, a.ID) {
		t.Fatalf("restore: %v", err)
	}
	if err := s.Restore(a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second restore: %v", err)
	}
	// quit within the Undo time
	s.DeleteLater(a.ID)
	s.Close()
	s2 := openStore(t, dir)
	if _, err := s2.Get(a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pending chat survived the close: %v", err)
	}
	// crash within the Undo time: the marker deletes it at the next Open
	s2.DeleteLater(b.ID)
	s2.pendingMu.Lock()
	s2.pending = nil // as if the process died
	s2.pendingMu.Unlock()
	s2.Close()
	s3 := openStore(t, dir)
	if _, err := s3.Get(b.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pending chat survived a crash: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, b.ID+deletingExt)); !os.IsNotExist(err) {
		t.Fatal("marker left")
	}
}
