package config

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"

	"github.com/dpicillo/LDAPilot/internal/models"
	"github.com/google/uuid"
)

// Store provides thread-safe, JSON file-based storage for connection profiles.
type Store struct {
	mu       sync.RWMutex
	profiles []models.ConnectionProfile
	filePath string
}

// NewStore creates a new Store and loads existing data from disk.
func NewStore() (*Store, error) {
	fp, err := ConnectionsFilePath()
	if err != nil {
		return nil, fmt.Errorf("failed to determine connections file path: %w", err)
	}
	s := &Store{
		filePath: fp,
		profiles: make([]models.ConnectionProfile, 0),
	}
	if err := s.Load(); err != nil {
		return nil, err
	}
	return s, nil
}

// Load reads connection profiles from the JSON file on disk.
// If the file does not exist, an empty list is initialized.
func (s *Store) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			s.profiles = make([]models.ConnectionProfile, 0)
			return nil
		}
		return fmt.Errorf("failed to read connections file: %w", err)
	}

	var profiles []models.ConnectionProfile
	if err := json.Unmarshal(data, &profiles); err != nil {
		return fmt.Errorf("failed to parse connections file: %w", err)
	}

	// Decrypt passwords
	for i := range profiles {
		if profiles[i].Password != "" {
			decrypted, err := DecryptPassword(profiles[i].Password)
			if err != nil {
				// Log but don't fail — password will need to be re-entered
				profiles[i].Password = ""
			} else {
				profiles[i].Password = decrypted
			}
		}
	}

	s.profiles = profiles
	return nil
}

// Save writes the current profiles to disk as JSON.
// Passwords are encrypted before writing.
func (s *Store) Save() error {
	// Caller must hold s.mu (at least RLock) before calling save.
	// Create a copy with encrypted passwords for serialization
	encrypted := make([]models.ConnectionProfile, len(s.profiles))
	copy(encrypted, s.profiles)

	for i := range encrypted {
		if encrypted[i].Password != "" {
			enc, err := EncryptPassword(encrypted[i].Password)
			if err != nil {
				return fmt.Errorf("failed to encrypt password for profile %q: %w", encrypted[i].Name, err)
			}
			encrypted[i].Password = enc
		}
	}

	data, err := json.MarshalIndent(encrypted, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal connections: %w", err)
	}
	if err := os.WriteFile(s.filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write connections file: %w", err)
	}
	return nil
}

// GetAll returns a copy of all connection profiles.
func (s *Store) GetAll() []models.ConnectionProfile {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]models.ConnectionProfile, len(s.profiles))
	copy(result, s.profiles)
	return result
}

// Get returns a single connection profile by ID, or an error if not found.
func (s *Store) Get(id string) (*models.ConnectionProfile, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, p := range s.profiles {
		if p.ID == id {
			cp := p
			return &cp, nil
		}
	}
	return nil, fmt.Errorf("connection profile with id %q not found", id)
}

// Add inserts a new connection profile, generating a UUID for it.
// It saves to disk automatically.
func (s *Store) Add(profile models.ConnectionProfile) (*models.ConnectionProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	profile.ID = uuid.New().String()
	s.profiles = append(s.profiles, profile)
	if err := s.Save(); err != nil {
		return nil, err
	}
	cp := profile
	return &cp, nil
}

// Update replaces an existing profile with matching ID.
// It saves to disk automatically.
func (s *Store) Update(profile models.ConnectionProfile) (*models.ConnectionProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i, p := range s.profiles {
		if p.ID == profile.ID {
			s.profiles[i] = profile
			if err := s.Save(); err != nil {
				return nil, err
			}
			cp := profile
			return &cp, nil
		}
	}
	return nil, fmt.Errorf("connection profile with id %q not found", profile.ID)
}

// Delete removes a profile by ID.
// It saves to disk automatically.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i, p := range s.profiles {
		if p.ID == id {
			s.profiles = append(s.profiles[:i], s.profiles[i+1:]...)
			return s.Save()
		}
	}
	return fmt.Errorf("connection profile with id %q not found", id)
}
