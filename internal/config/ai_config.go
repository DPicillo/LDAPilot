package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const aiConfigFileName = "ai_config.json"

// AIConfig holds the configuration for the AI chat provider.
type AIConfig struct {
	Provider string `json:"provider"` // "litellm" or "ollama"
	URL      string `json:"url"`
	APIKey   string `json:"apiKey"`
	Model    string `json:"model"`
	HasKey   bool   `json:"hasKey"` // frontend-only: true if an API key is stored
}

// AIConfigStore provides thread-safe, encrypted storage for AI provider configuration.
type AIConfigStore struct {
	mu       sync.RWMutex
	config   AIConfig
	filePath string
}

// NewAIConfigStore creates a new store and loads existing config from disk.
func NewAIConfigStore() (*AIConfigStore, error) {
	dir, err := ConfigDir()
	if err != nil {
		return nil, fmt.Errorf("failed to determine config dir: %w", err)
	}
	s := &AIConfigStore{
		filePath: filepath.Join(dir, aiConfigFileName),
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// load reads the config from disk and decrypts the API key.
func (s *AIConfigStore) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			s.config = AIConfig{}
			return nil
		}
		return fmt.Errorf("failed to read AI config: %w", err)
	}

	var cfg AIConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("failed to parse AI config: %w", err)
	}

	// Decrypt API key
	if cfg.APIKey != "" {
		decrypted, err := DecryptPassword(cfg.APIKey)
		if err != nil {
			// If decryption fails, keep the raw value (might be plaintext from old version)
			decrypted = cfg.APIKey
		}
		cfg.APIKey = decrypted
	}

	s.config = cfg
	return nil
}

// save writes the config to disk with the API key encrypted.
func (s *AIConfigStore) save() error {
	// Create a copy for serialization with encrypted key
	cfg := s.config
	if cfg.APIKey != "" {
		encrypted, err := EncryptPassword(cfg.APIKey)
		if err != nil {
			return fmt.Errorf("failed to encrypt API key: %w", err)
		}
		cfg.APIKey = encrypted
	}

	// Don't persist the HasKey field
	cfg.HasKey = false

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal AI config: %w", err)
	}

	if err := os.WriteFile(s.filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write AI config: %w", err)
	}

	return nil
}

// Get returns the current AI config (with plaintext API key for internal use).
func (s *AIConfigStore) Get() AIConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config
}

// GetMasked returns the config with API key removed and HasKey flag set.
// This is safe to send to the frontend.
func (s *AIConfigStore) GetMasked() AIConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cfg := s.config
	cfg.HasKey = cfg.APIKey != ""
	cfg.APIKey = ""
	return cfg
}

// Set updates the AI config and saves to disk.
// If apiKey is empty and an existing key is stored, the existing key is preserved.
func (s *AIConfigStore) Set(cfg AIConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Preserve existing API key if not provided
	if cfg.APIKey == "" && s.config.APIKey != "" {
		cfg.APIKey = s.config.APIKey
	}

	s.config = cfg
	return s.save()
}
