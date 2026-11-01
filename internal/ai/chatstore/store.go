// Package chatstore persists AI chats encrypted at rest (AES-256-GCM with
// the application key; the AAD binds each file to its chat ID). Files are
// written atomically, chat IDs are canonical lower-case UUIDs (so no path
// can escape the directory), an advisory lock makes a second app instance
// read-only, an encrypted index is reconciled at Open, and legacy plaintext
// chats (<uuid>.json) are migrated transparently.
package chatstore

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/config"
)

// Errors.
var (
	ErrInvalidChatID = errors.New("invalid chat ID")
	ErrNotFound      = errors.New("chat not found")
	ErrReadOnly      = errors.New("Chats are open in another LDAPilot window")
	ErrCorrupt       = errors.New("chat file is corrupt or cannot be decrypted")
)

const (
	fileExt        = ".chat"
	legacyExt      = ".json"
	indexName      = "index.chat"
	lockName       = ".lock"
	envelopeFormat = "ldapilot-chat"
	envelopeVer    = 2
	envelopeAlg    = "AES-256-GCM"
	chatAADPrefix  = "ldapilot-chat:v2:"
	indexAAD       = "ldapilot-chat-index:v2"
	tmpMaxAge      = time.Hour
	deletingExt    = ".deleting"
	titleMaxRunes  = 60
)

// Chat is the stored chat (plaintext of a <id>.chat file).
type Chat struct {
	ID              string                `json:"id"`
	Title           string                `json:"title"`
	TitleSource     string                `json:"titleSource"` // "auto" | "user" | "llm"
	CreatedAt       int64                 `json:"createdAt"`
	UpdatedAt       int64                 `json:"updatedAt"`
	PromptVersion   string                `json:"promptVersion,omitempty"`
	ModelOverride   string                `json:"modelOverride,omitempty"`
	Messages        []ai.Message          `json:"messages"`
	Compactions     []ai.CompactionMarker `json:"compactions,omitempty"`
	Usage           ai.Usage              `json:"usage"`
	Calibration     *ai.Calibration       `json:"calibration,omitempty"`
	Egress          []ai.EgressRecord     `json:"egress,omitempty"`
	LastContextHash string                `json:"lastContextHash,omitempty"`
	LastContextAt   int64                 `json:"lastContextAt,omitempty"`
	ClaudeSessionID string                `json:"claudeSessionId,omitempty"`
	// ClaudeSessionUpTo is the last message the Claude Code session has
	// seen; the session is resumed only while nothing else was added.
	ClaudeSessionUpTo string `json:"claudeSessionUpTo,omitempty"`
	// ClaudeWindows remembers the context window Claude Code reported per
	// model, so the context meter starts from it (not from a default).
	ClaudeWindows map[string]int `json:"claudeWindows,omitempty"`
	MigratedFrom  int            `json:"migratedFrom,omitempty"`
}

// Summary builds the list row of a chat.
func (c *Chat) Summary() ai.ChatSummary {
	s := ai.ChatSummary{ID: c.ID, Title: c.Title, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt, MessageCount: len(c.Messages), Usage: c.Usage, Model: c.ModelOverride}
	for i := len(c.Messages) - 1; i >= 0 && s.Model == ""; i-- {
		if c.Messages[i].Role == ai.RoleAssistant && c.Messages[i].Model != "" {
			s.Model = c.Messages[i].Model
		}
	}
	for _, m := range c.Messages {
		for _, b := range m.Blocks {
			if b.Type == ai.BlockToolUse && b.Meta != nil && b.Meta.Executing {
				s.PendingWrite = true
			}
		}
	}
	return s
}

// Cipher seals and opens store files.
type Cipher interface {
	Seal(plaintext, aad []byte) ([]byte, error)
	Open(sealed, aad []byte) ([]byte, error)
}

type appKeyCipher struct{}

func (appKeyCipher) Seal(p, aad []byte) ([]byte, error) { return config.SealWithAppKey(p, aad) }
func (appKeyCipher) Open(s, aad []byte) ([]byte, error) { return config.OpenWithAppKey(s, aad) }

// Options configure Open. Zero values use the application key, the real
// clock and random UUIDs.
type Options struct {
	Cipher   Cipher
	KeyCheck func() error // nil = config.AppKey
	Clock    ai.Clock
	IDs      ai.IDGen
	Logf     func(format string, args ...any)
	Rename   func(oldPath, newPath string) error // nil = os.Rename (+ Windows retries)
}

// Store is an open chat directory.
type Store struct {
	dir      string
	opts     Options
	readOnly bool
	lock     *dirLock

	chatLocks sync.Map // id → *sync.Mutex
	idxMu     sync.Mutex
	index     map[string]indexEntry

	// chats deleted with Undo time (DeleteLater): hidden from List, removed
	// by Delete, at Close (LDAPilot quits) or at the next Open (a marker
	// file <id>.deleting survives a crash)
	pendingMu sync.Mutex
	pending   map[string]bool
}

// indexEntry is one index row: the summary plus the size and modification
// time of the chat file it was built from, so that a file changed behind
// the index (copied, restored, edited) is re-read at reconciliation.
type indexEntry struct {
	ai.ChatSummary
	FileSize int64 `json:"fileSize,omitempty"`
	FileMod  int64 `json:"fileMod,omitempty"`
}

// UnavailableError explains why the store cannot be opened (degraded mode).
type UnavailableError struct{ Reason string }

func (e *UnavailableError) Error() string { return e.Reason }

// ValidateID accepts only canonical lower-case UUID text.
func ValidateID(id string) error {
	u, err := uuid.Parse(id)
	if err != nil || u.String() != id {
		return ErrInvalidChatID
	}
	return nil
}

// Open opens (and if needed creates) the chat directory: it checks the
// application key (fail closed), takes the directory lock (a second
// instance opens read-only), removes stale temp files, migrates legacy
// plaintext chats and reconciles the index.
func Open(dir string, opts Options) (*Store, error) {
	if opts.Cipher == nil {
		opts.Cipher = appKeyCipher{}
		if opts.KeyCheck == nil {
			opts.KeyCheck = func() error { _, err := config.AppKey(); return err }
		}
	}
	if opts.Clock == nil {
		opts.Clock = ai.SystemClock()
	}
	if opts.IDs == nil {
		opts.IDs = ai.UUIDGen()
	}
	if opts.Logf == nil {
		opts.Logf = func(string, ...any) {}
	}
	if opts.Rename == nil {
		opts.Rename = renameWithRetry
	}
	if opts.KeyCheck != nil {
		if err := opts.KeyCheck(); err != nil {
			return nil, &UnavailableError{Reason: fmt.Sprintf("LDAPilot cannot read its encryption key (%v). Chats are unavailable so that no data is lost. Fix the file's permissions or restore it from a backup.", err)}
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, &UnavailableError{Reason: fmt.Sprintf("Cannot create the chats directory %s: %v", dir, err)}
	}
	s := &Store{dir: filepath.Clean(dir), opts: opts, index: map[string]indexEntry{}}
	lock, err := acquireDirLock(filepath.Join(s.dir, lockName))
	switch {
	case err == nil:
		s.lock = lock
	case errors.Is(err, errLocked):
		s.readOnly = true
	default:
		return nil, &UnavailableError{Reason: fmt.Sprintf("Cannot lock the chats directory: %v", err)}
	}
	if !s.readOnly {
		s.cleanupTemp()
		s.purgeDeleting()
		s.migrateLegacy()
	}
	if err := s.reconcile(); err != nil {
		s.Close()
		return nil, &UnavailableError{Reason: fmt.Sprintf("Cannot read the chats directory: %v", err)}
	}
	return s, nil
}

// Close deletes the chats still waiting for their Undo time (LDAPilot
// quits) and releases the directory lock.
func (s *Store) Close() {
	s.PurgePending()
	if s.lock != nil {
		s.lock.release()
		s.lock = nil
	}
}

// Dir returns the chats directory.
func (s *Store) Dir() string { return s.dir }

// ReadOnly reports whether another instance holds the lock.
func (s *Store) ReadOnly() bool { return s.readOnly }

func (s *Store) path(id string) (string, error) {
	if err := ValidateID(id); err != nil {
		return "", err
	}
	p := filepath.Clean(filepath.Join(s.dir, id+fileExt))
	if !strings.HasPrefix(p, s.dir+string(filepath.Separator)) {
		return "", ErrInvalidChatID
	}
	return p, nil
}

func (s *Store) chatLock(id string) *sync.Mutex {
	m, _ := s.chatLocks.LoadOrStore(id, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// --- envelope ---

type envelope struct {
	Format  string `json:"format"`
	Version int    `json:"version"`
	Alg     string `json:"alg"`
	Data    string `json:"data"`
}

func (s *Store) seal(v any, aad string) ([]byte, error) {
	plain, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	sealed, err := s.opts.Cipher.Seal(plain, []byte(aad))
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope{Format: envelopeFormat, Version: envelopeVer, Alg: envelopeAlg, Data: base64.StdEncoding.EncodeToString(sealed)})
}

func (s *Store) open(data []byte, aad string, v any) error {
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil || env.Format != envelopeFormat || env.Version != envelopeVer || env.Alg != envelopeAlg {
		return ErrCorrupt
	}
	sealed, err := base64.StdEncoding.DecodeString(env.Data)
	if err != nil {
		return ErrCorrupt
	}
	plain, err := s.opts.Cipher.Open(sealed, []byte(aad))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	if err := json.Unmarshal(plain, v); err != nil {
		return fmt.Errorf("%w: %v", ErrCorrupt, err)
	}
	return nil
}

func (s *Store) readChat(id string) (*Chat, error) {
	p, err := s.path(id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var c Chat
	if err := s.open(data, chatAADPrefix+id, &c); err != nil {
		return nil, err
	}
	if c.ID != id {
		return nil, fmt.Errorf("%w: ID mismatch", ErrCorrupt)
	}
	maskTypedPasswords(&c)
	return &c, nil
}

// maskTypedPasswords removes passwords the user typed into chats from
// before the composer refused them (UX A-13): the title and the user's own
// text. In a chat where that found one, the same values are also removed
// wherever the model repeated them (answers, thinking, the inputs of tool
// calls, conversation summaries and compaction summaries, which go back to
// the provider), values of password attributes in tool inputs are masked,
// and a Claude Code session to resume is dropped (it still holds the text).
// Other chats are left alone: an answer never contains a password LDAPilot
// generated, and masking it could only garble Markdown. A chat read here is
// shown, exported and sent to the provider with "[password removed]"
// instead, and the next write stores it so. It is idempotent.
func maskTypedPasswords(c *Chat) {
	var values []string
	collect := func(s string) string {
		values = append(values, ai.PasswordValues(s)...)
		return ai.MaskPasswords(s)
	}
	c.Title = collect(c.Title)
	userText := func(m *ai.Message, b *ai.Block) bool {
		return m.Role == ai.RoleUser && b.Type == ai.BlockText && (b.Meta == nil || b.Meta.Kind == "")
	}
	for i := range c.Messages {
		m := &c.Messages[i]
		for j := range m.Blocks {
			if b := &m.Blocks[j]; userText(m, b) && b.Text != "" {
				b.Text = collect(b.Text)
			}
		}
	}
	values = typedValues(values)
	if len(values) == 0 {
		return
	}
	replace := func(s string) string {
		for _, v := range values {
			s = strings.ReplaceAll(s, v, ai.PasswordPlaceholder)
		}
		return s
	}
	scrub := func(s string) string { return ai.MaskPasswords(replace(s)) }
	for i := range c.Messages {
		m := &c.Messages[i]
		for j := range m.Blocks {
			b := &m.Blocks[j]
			switch b.Type {
			case ai.BlockText:
				switch {
				case userText(m, b):
				case b.Meta != nil && b.Meta.Kind == "context":
					b.Text = replace(b.Text)
				default:
					b.Text = scrub(b.Text)
				}
			case ai.BlockThinking:
				if t := scrub(b.Thinking); t != b.Thinking {
					// a changed thinking block cannot be replayed signed;
					// unsigned ones are not replayed at all
					b.Thinking, b.Signature = t, ""
				}
			case ai.BlockToolUse:
				b.Input = maskToolInput(b.Input, replace)
				if b.Meta != nil && b.Meta.RawArgs != "" {
					b.Meta.RawArgs = replace(b.Meta.RawArgs)
				}
			}
		}
	}
	for i := range c.Compactions {
		c.Compactions[i].Summary = scrub(c.Compactions[i].Summary)
	}
	c.ClaudeSessionID, c.ClaudeSessionUpTo = "", ""
}

// typedValues drops duplicates and values too short to be replaced
// elsewhere without garbling other words; longest first.
func typedValues(vs []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range vs {
		if utf8.RuneCountInString(v) >= 4 && v != ai.PasswordPlaceholder && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool { return len(out[i]) > len(out[j]) })
	return out
}

// passwordAttr: attribute names whose values in a tool input are passwords.
func passwordAttr(n string) bool {
	l := strings.ToLower(strings.TrimSpace(n))
	if i := strings.IndexByte(l, ';'); i >= 0 {
		l = l[:i]
	}
	switch l {
	case "2.5.4.35", "1.2.840.113556.1.4.90", "authpassword", "password", "new_password", "newpassword":
		return true
	}
	return strings.HasSuffix(l, "password") || strings.HasSuffix(l, "pwd") || strings.HasSuffix(l, "passwd")
}

// maskToolInput removes typed password values from a tool call's input
// (the model may have copied them into create_entry/modify_entry) and
// masks the values of password attributes; unchanged input is returned as is.
func maskToolInput(in json.RawMessage, replace func(string) string) json.RawMessage {
	if len(in) == 0 {
		return in
	}
	var v any
	if err := json.Unmarshal(in, &v); err != nil {
		if r := replace(string(in)); r != string(in) {
			b, _ := json.Marshal(map[string]string{"input": r})
			return b
		}
		return in
	}
	changed := false
	var walk func(x any, secret bool) any
	walk = func(x any, secret bool) any {
		switch t := x.(type) {
		case string:
			r := replace(t)
			if secret && r != "" && r != ai.PasswordPlaceholder {
				r = ai.PasswordPlaceholder
			}
			if r != t {
				changed = true
			}
			return r
		case []any:
			for i := range t {
				t[i] = walk(t[i], secret)
			}
			return t
		case map[string]any:
			sec := secret
			for _, k := range []string{"attribute", "name", "attr"} {
				if a, ok := t[k].(string); ok && passwordAttr(a) {
					sec = true
				}
			}
			for k, val := range t {
				switch {
				case k == "attribute" || k == "name" || k == "attr" || k == "operation" || k == "dn":
					if s, ok := val.(string); ok {
						if r := replace(s); r != s {
							t[k], changed = r, true
						}
					}
				default:
					t[k] = walk(val, sec || passwordAttr(k))
				}
			}
			return t
		}
		return x
	}
	v = walk(v, false)
	if !changed {
		return in
	}
	b, err := json.Marshal(v)
	if err != nil {
		return in
	}
	return b
}

func (s *Store) writeChat(c *Chat) error {
	p, err := s.path(c.ID)
	if err != nil {
		return err
	}
	data, err := s.seal(c, chatAADPrefix+c.ID)
	if err != nil {
		return err
	}
	return s.writeAtomic(p, data)
}

// writeAtomic: temp file (0600) → fsync → close → rename → dir fsync.
func (s *Store) writeAtomic(path string, data []byte) error {
	suffix := make([]byte, 6)
	if _, err := rand.Read(suffix); err != nil {
		return err
	}
	tmp := filepath.Join(s.dir, "."+filepath.Base(path)+".tmp-"+hex.EncodeToString(suffix))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := s.opts.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	syncDir(s.dir)
	return nil
}

func syncDir(dir string) {
	if runtime.GOOS == "windows" {
		return
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
}

// cleanupTemp removes leftover temp files older than one hour.
func (s *Store) cleanupTemp() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	now := s.opts.Clock.Now()
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !strings.HasPrefix(n, ".") || !strings.Contains(n, ".tmp-") {
			continue
		}
		info, err := e.Info()
		if err != nil || now.Sub(info.ModTime()) < tmpMaxAge {
			continue
		}
		if err := os.Remove(filepath.Join(s.dir, n)); err == nil {
			s.opts.Logf("chatstore: removed stale temp file %s", n)
		}
	}
}

// --- index ---

func (s *Store) indexPath() string { return filepath.Join(s.dir, indexName) }

func (s *Store) readIndex() (map[string]indexEntry, error) {
	data, err := os.ReadFile(s.indexPath())
	if err != nil {
		return nil, err
	}
	var list []indexEntry
	if err := s.open(data, indexAAD, &list); err != nil {
		return nil, err
	}
	m := make(map[string]indexEntry, len(list))
	for _, e := range list {
		if ValidateID(e.ID) == nil {
			m[e.ID] = e
		}
	}
	return m, nil
}

// writeIndexLocked persists the index (idxMu held).
func (s *Store) writeIndexLocked() error {
	if s.readOnly {
		return nil
	}
	list := make([]indexEntry, 0, len(s.index))
	for _, e := range s.index {
		e.Running = false
		list = append(list, e)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	data, err := s.seal(list, indexAAD)
	if err != nil {
		return err
	}
	return s.writeAtomic(s.indexPath(), data)
}

// chatFileIDs lists valid <uuid>.chat files.
func (s *Store) chatFileIDs() (map[string]os.FileInfo, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	out := map[string]os.FileInfo{}
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, fileExt) {
			continue
		}
		id := strings.TrimSuffix(n, fileExt)
		if ValidateID(id) != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out[id] = info
	}
	return out, nil
}

// reconcile builds the in-memory index from index.chat and the files:
// files missing from the index are decrypted and added (or listed as
// corrupt), entries without a file are dropped, corrupt entries are
// re-checked. The index is rewritten if anything changed.
func (s *Store) reconcile() error {
	files, err := s.chatFileIDs()
	if err != nil {
		return err
	}
	idx, ierr := s.readIndex()
	changed := false
	if ierr != nil {
		if !errors.Is(ierr, fs.ErrNotExist) {
			s.opts.Logf("chatstore: index unreadable (%v); rebuilding", ierr)
		}
		idx = map[string]indexEntry{}
		changed = true
	}
	for id := range idx {
		if _, ok := files[id]; !ok && !idx[id].Corrupt {
			delete(idx, id)
			changed = true
		}
	}
	for id, info := range files {
		e, ok := idx[id]
		if ok && !e.Corrupt && e.FileSize == info.Size() && e.FileMod == info.ModTime().UnixNano() {
			continue
		}
		c, err := s.readChat(id)
		if err != nil {
			if ok && e.Corrupt && e.FileSize == info.Size() && e.FileMod == info.ModTime().UnixNano() {
				continue
			}
			idx[id] = indexEntry{ChatSummary: ai.ChatSummary{ID: id, Title: "Unreadable chat", Corrupt: true, Note: "The chat file is corrupt or was encrypted with another key.", UpdatedAt: info.ModTime().UnixMilli(), CreatedAt: info.ModTime().UnixMilli()}, FileSize: info.Size(), FileMod: info.ModTime().UnixNano()}
			changed = true
			continue
		}
		idx[id] = indexEntry{ChatSummary: c.Summary(), FileSize: info.Size(), FileMod: info.ModTime().UnixNano()}
		changed = true
	}
	// Legacy files that failed to migrate stay listed as corrupt.
	if entries, err := os.ReadDir(s.dir); err == nil {
		for _, e := range entries {
			n := e.Name()
			if e.IsDir() || !strings.HasSuffix(n, legacyExt) {
				continue
			}
			id := strings.TrimSuffix(n, legacyExt)
			if ValidateID(id) != nil {
				continue
			}
			if _, ok := files[id]; ok {
				continue
			}
			title := "Legacy chat"
			var created, updated int64
			if lc, err := readLegacy(filepath.Join(s.dir, n)); err == nil {
				title, created, updated = repairTitle(lc.Title, lc.Messages), lc.CreatedAt, lc.UpdatedAt
			}
			want := indexEntry{ChatSummary: ai.ChatSummary{ID: id, Title: title, CreatedAt: created, UpdatedAt: updated, Corrupt: true, Note: "legacy chat could not be migrated"}}
			if old, ok := idx[id]; !ok || old != want {
				idx[id] = want
				changed = true
			}
		}
	}
	// Drop corrupt entries whose files are all gone.
	for id, e := range idx {
		if !e.Corrupt {
			continue
		}
		_, chat := files[id]
		_, lerr := os.Stat(filepath.Join(s.dir, id+legacyExt))
		if !chat && lerr != nil {
			delete(idx, id)
			changed = true
		}
	}
	s.idxMu.Lock()
	s.index = idx
	var werr error
	if changed {
		werr = s.writeIndexLocked()
	}
	s.idxMu.Unlock()
	if werr != nil {
		s.opts.Logf("chatstore: cannot write index: %v", werr)
	}
	return nil
}

// setIndex records a chat that was just written.
func (s *Store) setIndex(sum ai.ChatSummary) {
	e := indexEntry{ChatSummary: sum}
	if p, err := s.path(sum.ID); err == nil {
		if info, err := os.Stat(p); err == nil {
			e.FileSize, e.FileMod = info.Size(), info.ModTime().UnixNano()
		}
	}
	s.idxMu.Lock()
	s.index[sum.ID] = e
	if err := s.writeIndexLocked(); err != nil {
		s.opts.Logf("chatstore: cannot write index: %v", err)
	}
	s.idxMu.Unlock()
}

func (s *Store) dropIndex(id string) {
	s.idxMu.Lock()
	delete(s.index, id)
	if err := s.writeIndexLocked(); err != nil {
		s.opts.Logf("chatstore: cannot write index: %v", err)
	}
	s.idxMu.Unlock()
}

// --- operations ---

// List returns all chats, most recently updated first. Corrupt chats are
// listed with Corrupt:true, never skipped. A read-only store re-reads the
// index written by the other instance.
func (s *Store) List() ([]ai.ChatSummary, error) {
	if s.readOnly {
		if err := s.reconcile(); err != nil {
			return nil, err
		}
	}
	s.idxMu.Lock()
	out := make([]ai.ChatSummary, 0, len(s.index))
	for id, e := range s.index {
		if s.isPending(id) {
			continue
		}
		cs := e.ChatSummary
		cs.Title = ai.MaskPasswords(cs.Title)
		out = append(out, cs)
	}
	s.idxMu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt != out[j].UpdatedAt {
			return out[i].UpdatedAt > out[j].UpdatedAt
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// Get returns a chat.
func (s *Store) Get(id string) (*Chat, error) {
	if err := ValidateID(id); err != nil {
		return nil, err
	}
	mu := s.chatLock(id)
	mu.Lock()
	defer mu.Unlock()
	return s.readChat(id)
}

// Messages returns the messages after sinceID ("" = all). An unknown
// sinceID returns all messages.
func (s *Store) Messages(id, sinceID string) ([]ai.Message, error) {
	c, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if sinceID == "" {
		return c.Messages, nil
	}
	for i, m := range c.Messages {
		if m.ID == sinceID {
			return append([]ai.Message(nil), c.Messages[i+1:]...), nil
		}
	}
	return c.Messages, nil
}

// Create makes a new empty chat.
func (s *Store) Create(title string) (*Chat, error) {
	if s.readOnly {
		return nil, ErrReadOnly
	}
	now := s.opts.Clock.Now().UnixMilli()
	c := &Chat{ID: s.newChatID(), Title: CleanTitle(title), TitleSource: "auto", CreatedAt: now, UpdatedAt: now, Messages: []ai.Message{}}
	if c.Title == "" {
		c.Title = "New chat"
	}
	mu := s.chatLock(c.ID)
	mu.Lock()
	defer mu.Unlock()
	if err := s.writeChat(c); err != nil {
		return nil, err
	}
	s.setIndex(c.Summary())
	return c, nil
}

func (s *Store) newChatID() string {
	for {
		id := strings.ToLower(s.opts.IDs.NewID())
		if ValidateID(id) != nil {
			id = ai.NewUUID()
		}
		if p, err := s.path(id); err == nil {
			if _, err := os.Stat(p); errors.Is(err, fs.ErrNotExist) {
				return id
			}
		}
	}
}

// Update runs fn on the chat under its lock and persists the result. A
// missing chat returns ErrNotFound (no re-creation). fn's error aborts the
// update.
func (s *Store) Update(id string, fn func(*Chat) error) error {
	if err := ValidateID(id); err != nil {
		return err
	}
	if s.readOnly {
		return ErrReadOnly
	}
	mu := s.chatLock(id)
	mu.Lock()
	defer mu.Unlock()
	c, err := s.readChat(id)
	if err != nil {
		return err
	}
	if err := fn(c); err != nil {
		return err
	}
	c.ID = id
	c.UpdatedAt = s.opts.Clock.Now().UnixMilli()
	if err := s.writeChat(c); err != nil {
		return err
	}
	s.setIndex(c.Summary())
	return nil
}

// Rename sets a user title (never overwritten by generated titles).
func (s *Store) Rename(id, title string) error {
	t := CleanTitle(title)
	if t == "" {
		return fmt.Errorf("the title must not be empty")
	}
	return s.Update(id, func(c *Chat) error {
		c.Title, c.TitleSource = t, "user"
		return nil
	})
}

// Delete removes a chat. Deleting a missing chat returns ErrNotFound.
func (s *Store) Delete(id string) error {
	if err := ValidateID(id); err != nil {
		return err
	}
	if s.readOnly {
		return ErrReadOnly
	}
	mu := s.chatLock(id)
	mu.Lock()
	defer mu.Unlock()
	p, _ := s.path(id)
	err := os.Remove(p)
	legacy := filepath.Join(s.dir, id+legacyExt)
	lerr := os.Remove(legacy)
	if err != nil && errors.Is(err, fs.ErrNotExist) && lerr != nil {
		s.dropIndex(id)
		return ErrNotFound
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	_ = os.Remove(filepath.Join(s.dir, id+deletingExt))
	s.pendingMu.Lock()
	delete(s.pending, id)
	s.pendingMu.Unlock()
	syncDir(s.dir)
	s.dropIndex(id)
	return nil
}

// DeleteLater hides a chat for the Undo time of "Delete chat" (A-07): it
// leaves the list at once and is deleted by Delete, Restore brings it back.
// If LDAPilot quits or crashes first, it is deleted at Close or at the
// next Open, never shown again.
func (s *Store) DeleteLater(id string) error {
	if err := ValidateID(id); err != nil {
		return err
	}
	if s.readOnly {
		return ErrReadOnly
	}
	p, _ := s.path(id)
	if _, err := os.Stat(p); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	if err := os.WriteFile(filepath.Join(s.dir, id+deletingExt), nil, 0o600); err != nil {
		return err
	}
	s.pendingMu.Lock()
	if s.pending == nil {
		s.pending = map[string]bool{}
	}
	s.pending[id] = true
	s.pendingMu.Unlock()
	return nil
}

// Restore undoes DeleteLater; ErrNotFound when the chat is already deleted.
func (s *Store) Restore(id string) error {
	if err := ValidateID(id); err != nil {
		return err
	}
	if s.readOnly {
		return ErrReadOnly
	}
	s.pendingMu.Lock()
	ok := s.pending[id]
	delete(s.pending, id)
	s.pendingMu.Unlock()
	if !ok {
		return ErrNotFound
	}
	_ = os.Remove(filepath.Join(s.dir, id+deletingExt))
	return nil
}

// PurgePending deletes every chat waiting for its Undo time.
func (s *Store) PurgePending() {
	if s.readOnly {
		return
	}
	s.pendingMu.Lock()
	ids := make([]string, 0, len(s.pending))
	for id := range s.pending {
		ids = append(ids, id)
	}
	s.pendingMu.Unlock()
	for _, id := range ids {
		if err := s.Delete(id); err != nil && !errors.Is(err, ErrNotFound) {
			s.opts.Logf("chatstore: deleting chat %s failed: %v", id, err)
		}
	}
}

// purgeDeleting deletes the chats a crashed instance left waiting.
func (s *Store) purgeDeleting() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), deletingExt)
		if !ok || e.IsDir() || ValidateID(id) != nil {
			continue
		}
		if err := s.Delete(id); err != nil && !errors.Is(err, ErrNotFound) {
			s.opts.Logf("chatstore: deleting chat %s failed: %v", id, err)
			continue
		}
		_ = os.Remove(filepath.Join(s.dir, e.Name()))
	}
}

func (s *Store) isPending(id string) bool {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	return s.pending[id]
}

// PruneEmpty deletes chats that were never used: no messages, the default
// title, no model override, last changed before before (Unix ms). "New
// chat", Ctrl+Shift+N and /clear used to leave one such chat each, so the
// history filled with identical "New chat" rows. It returns how many were
// deleted; a read-only store (second instance) deletes nothing.
func (s *Store) PruneEmpty(before int64) int {
	if s.readOnly {
		return 0
	}
	list, err := s.List()
	if err != nil {
		return 0
	}
	n := 0
	for _, c := range list {
		if c.MessageCount != 0 || c.Title != "New chat" || c.Model != "" || c.Corrupt || c.PendingWrite || c.UpdatedAt >= before {
			continue
		}
		// Re-check the file itself: the index may lag behind a write.
		if full, err := s.Get(c.ID); err != nil || len(full.Messages) != 0 || len(full.Compactions) != 0 || full.ModelOverride != "" {
			continue
		}
		if s.Delete(c.ID) == nil {
			n++
		}
	}
	return n
}

// PendingWriteChats returns the IDs of chats whose index entry says a
// write may have been interrupted (outcome-unknown recovery).
func (s *Store) PendingWriteChats() []string {
	s.idxMu.Lock()
	defer s.idxMu.Unlock()
	var out []string
	for id, e := range s.index {
		if e.PendingWrite {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// CleanTitle collapses whitespace, removes invalid UTF-8 and invisible
// characters, and truncates to 60 runes plus "…" (rune-safe).
func CleanTitle(t string) string {
	t = strings.ToValidUTF8(t, "")
	var b strings.Builder
	for _, r := range t {
		if ai.IsInvisibleRune(r) || r == '�' {
			continue
		}
		b.WriteRune(r)
	}
	t = strings.Join(strings.Fields(b.String()), " ")
	if utf8.RuneCountInString(t) > titleMaxRunes {
		r := []rune(t)
		t = strings.TrimSpace(string(r[:titleMaxRunes])) + "…"
	}
	return t
}
