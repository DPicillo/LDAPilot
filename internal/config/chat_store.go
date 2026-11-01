package config

import (
	"fmt"
	"os"
	"path/filepath"
)

// ChatStore holds the location of the AI chats directory. The chats
// themselves are stored encrypted by internal/ai/chatstore (opened on
// Dir()); legacy plaintext <uuid>.json chats in the same directory are
// migrated there.
type ChatStore struct {
	chatDir string
}

// NewChatStore ensures the chats directory exists (mode 0700).
func NewChatStore() (*ChatStore, error) {
	dir, err := ConfigDir()
	if err != nil {
		return nil, fmt.Errorf("failed to determine config dir: %w", err)
	}
	chatDir := filepath.Join(dir, "chats")
	if err := os.MkdirAll(chatDir, 0o700); err != nil {
		return nil, fmt.Errorf("failed to create chats directory: %w", err)
	}
	return &ChatStore{chatDir: chatDir}, nil
}

// Dir returns the chats directory.
func (s *ChatStore) Dir() string { return s.chatDir }
