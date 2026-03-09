package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// ChatMsg represents a single message in a chat conversation.
type ChatMsg struct {
	Role       string `json:"role"`                 // system, user, assistant, tool
	Content    string `json:"content"`
	ToolCalls  string `json:"toolCalls,omitempty"`   // JSON string of tool calls (for replay)
	ToolCallID string `json:"toolCallId,omitempty"`
}

// ChatConversation represents a persisted chat conversation.
type ChatConversation struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt int64     `json:"createdAt"` // unix ms
	UpdatedAt int64     `json:"updatedAt"` // unix ms
	Messages  []ChatMsg `json:"messages"`
}

// ChatStore provides persistent storage for chat conversations.
// Each conversation is stored as a separate JSON file in the chats directory.
type ChatStore struct {
	mu      sync.RWMutex
	chatDir string
}

// NewChatStore creates a new ChatStore and ensures the chats directory exists.
func NewChatStore() (*ChatStore, error) {
	dir, err := ConfigDir()
	if err != nil {
		return nil, fmt.Errorf("failed to determine config dir: %w", err)
	}
	chatDir := filepath.Join(dir, "chats")
	if err := os.MkdirAll(chatDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create chats directory: %w", err)
	}
	return &ChatStore{chatDir: chatDir}, nil
}

// chatFilePath returns the file path for a given chat ID.
func (s *ChatStore) chatFilePath(id string) string {
	return filepath.Join(s.chatDir, id+".json")
}

// CreateChat creates a new empty conversation with the given title.
func (s *ChatStore) CreateChat(title string) (*ChatConversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UnixMilli()
	conv := &ChatConversation{
		ID:        uuid.New().String(),
		Title:     title,
		CreatedAt: now,
		UpdatedAt: now,
		Messages:  []ChatMsg{},
	}

	if err := s.saveUnlocked(conv); err != nil {
		return nil, err
	}
	return conv, nil
}

// GetChat loads a conversation by ID, including all messages.
func (s *ChatStore) GetChat(id string) (*ChatConversation, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.loadChat(id)
}

// SaveChat persists a conversation to disk.
func (s *ChatStore) SaveChat(conv *ChatConversation) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	conv.UpdatedAt = time.Now().UnixMilli()
	return s.saveUnlocked(conv)
}

// DeleteChat removes a conversation file from disk.
func (s *ChatStore) DeleteChat(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := s.chatFilePath(id)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to delete chat %s: %w", id, err)
	}
	return nil
}

// ListChats returns all conversations sorted by updatedAt descending,
// without loading messages (for performance).
func (s *ChatStore) ListChats() ([]ChatConversation, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	entries, err := os.ReadDir(s.chatDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []ChatConversation{}, nil
		}
		return nil, fmt.Errorf("failed to read chats directory: %w", err)
	}

	var chats []ChatConversation
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		id := entry.Name()[:len(entry.Name())-5] // strip .json
		conv, err := s.loadChat(id)
		if err != nil {
			continue // skip corrupt files
		}
		// Return without messages for performance
		chats = append(chats, ChatConversation{
			ID:        conv.ID,
			Title:     conv.Title,
			CreatedAt: conv.CreatedAt,
			UpdatedAt: conv.UpdatedAt,
		})
	}

	// Sort by updatedAt descending
	sort.Slice(chats, func(i, j int) bool {
		return chats[i].UpdatedAt > chats[j].UpdatedAt
	})

	return chats, nil
}

// loadChat reads a conversation from disk.
func (s *ChatStore) loadChat(id string) (*ChatConversation, error) {
	path := s.chatFilePath(id)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read chat %s: %w", id, err)
	}

	var conv ChatConversation
	if err := json.Unmarshal(data, &conv); err != nil {
		return nil, fmt.Errorf("failed to parse chat %s: %w", id, err)
	}
	return &conv, nil
}

// saveUnlocked writes a conversation to disk. Caller must hold the lock.
func (s *ChatStore) saveUnlocked(conv *ChatConversation) error {
	data, err := json.MarshalIndent(conv, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal chat: %w", err)
	}

	path := s.chatFilePath(conv.ID)
	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("failed to write chat: %w", err)
	}
	return nil
}
