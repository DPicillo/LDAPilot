package chatstore

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// legacyChat is the v1 plaintext format (config.ChatConversation).
type legacyChat struct {
	ID        string      `json:"id"`
	Title     string      `json:"title"`
	CreatedAt int64       `json:"createdAt"`
	UpdatedAt int64       `json:"updatedAt"`
	Messages  []legacyMsg `json:"messages"`
}

type legacyMsg struct {
	Role       string `json:"role"`
	Content    string `json:"content"`
	ToolCalls  string `json:"toolCalls,omitempty"`
	ToolCallID string `json:"toolCallId,omitempty"`
}

func readLegacy(path string) (*legacyChat, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var lc legacyChat
	if err := json.Unmarshal(data, &lc); err != nil {
		return nil, err
	}
	return &lc, nil
}

// migrateLegacy converts every <uuid>.json in the directory (§8.6). Other
// files are never touched. A chat is written as <id>.chat, read back,
// decrypted and compared before the plaintext file is removed. On any
// failure the .json stays and is listed as corrupt.
func (s *Store) migrateLegacy() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, legacyExt) {
			continue
		}
		id := strings.TrimSuffix(n, legacyExt)
		if ValidateID(id) != nil {
			s.opts.Logf("chatstore: leaving %s untouched (not a chat ID)", n)
			continue
		}
		legacyPath := filepath.Join(s.dir, n)
		if err := s.migrateOne(id, legacyPath); err != nil {
			s.opts.Logf("chatstore: legacy chat %s could not be migrated: %v", id, err)
		}
	}
}

func (s *Store) migrateOne(id, legacyPath string) error {
	mu := s.chatLock(id)
	mu.Lock()
	defer mu.Unlock()

	if _, err := s.readChat(id); err == nil {
		// Already migrated (crash between write and remove): drop the plaintext.
		return os.Remove(legacyPath)
	} else if !errors.Is(err, ErrNotFound) {
		return err // a corrupt .chat exists: keep both files
	}
	lc, err := readLegacy(legacyPath)
	if err != nil {
		return err
	}
	c := s.convertLegacy(id, lc)
	// readChat masks typed passwords; mask before the write so the check
	// below compares like with like (and the plaintext never reaches the
	// encrypted file either)
	maskTypedPasswords(c)
	if err := s.writeChat(c); err != nil {
		return err
	}
	back, err := s.readChat(id)
	if err != nil {
		s.removeChatFile(id)
		return err
	}
	want, _ := json.Marshal(c)
	got, _ := json.Marshal(back)
	if !bytes.Equal(want, got) {
		s.removeChatFile(id)
		return errors.New("verification after migration failed")
	}
	if err := os.Remove(legacyPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	syncDir(s.dir)
	s.opts.Logf("chatstore: migrated legacy chat %s", id)
	return nil
}

func (s *Store) removeChatFile(id string) {
	if p, err := s.path(id); err == nil {
		_ = os.Remove(p)
	}
}

// convertLegacy keeps user text and non-empty assistant text, drops system
// and tool messages and tool-call-only assistant messages, and merges
// neighbouring messages of the same role so the history stays valid.
func (s *Store) convertLegacy(id string, lc *legacyChat) *Chat {
	created := lc.CreatedAt
	if created == 0 {
		created = s.opts.Clock.Now().UnixMilli()
	}
	updated := lc.UpdatedAt
	if updated == 0 {
		updated = created
	}
	c := &Chat{ID: id, CreatedAt: created, UpdatedAt: updated, MigratedFrom: 1, Messages: []ai.Message{}}
	for _, m := range lc.Messages {
		var role ai.Role
		switch m.Role {
		case "user":
			role = ai.RoleUser
		case "assistant":
			role = ai.RoleAssistant
		default:
			continue
		}
		text := strings.ToValidUTF8(m.Content, "�")
		if strings.TrimSpace(text) == "" {
			continue
		}
		if n := len(c.Messages); n > 0 && c.Messages[n-1].Role == role {
			c.Messages[n-1].Blocks = append(c.Messages[n-1].Blocks, ai.Block{Type: ai.BlockText, Text: text})
			continue
		}
		c.Messages = append(c.Messages, ai.Message{
			ID:        s.newMessageID(),
			Role:      role,
			Blocks:    []ai.Block{{Type: ai.BlockText, Text: text}},
			CreatedAt: created,
		})
	}
	c.Title = repairTitle(lc.Title, lc.Messages)
	c.TitleSource = "auto"
	if first := firstUserText(lc.Messages); first != "" {
		base := strings.TrimSuffix(c.Title, "…")
		if !strings.HasPrefix(CleanTitle(first), strings.TrimSpace(base)) {
			c.TitleSource = "user"
		}
	}
	return c
}

func (s *Store) newMessageID() string {
	id := strings.ToLower(s.opts.IDs.NewID())
	if ValidateID(id) != nil {
		id = ai.NewUUID()
	}
	return id
}

func firstUserText(msgs []legacyMsg) string {
	for _, m := range msgs {
		if m.Role == "user" && strings.TrimSpace(m.Content) != "" {
			return m.Content
		}
	}
	return ""
}

// repairTitle fixes titles cut in the middle of a UTF-8 sequence by the
// legacy byte-based truncation (stored as U+FFFD followed by "...").
func repairTitle(title string, msgs []legacyMsg) string {
	t := strings.ReplaceAll(strings.ToValidUTF8(title, ""), "\uFFFD", "")
	t = strings.TrimSpace(t)
	if strings.HasSuffix(t, "...") {
		t = strings.TrimSpace(strings.TrimSuffix(t, "...")) + "…"
	}
	t = CleanTitle(t)
	if t == "" || t == "…" {
		t = CleanTitle(firstUserText(msgs))
	}
	if t == "" {
		t = "Migrated chat"
	}
	return t
}
