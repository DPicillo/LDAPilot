package config

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"

	"github.com/dpicillo/LDAPilot/internal/models"
	"github.com/google/uuid"
)

// ErrExternalChange is returned by Update when connections.json was changed
// outside LDAPilot in a way that conflicts with the change (the same profile
// was edited or deleted there), or cannot be read any more. The store has
// re-read the file (when it could), so repeating the change works.
var ErrExternalChange = errors.New("connections.json changed outside LDAPilot")

// Store provides thread-safe, JSON file-based storage for connection profiles.
//
// connections.json may be edited by hand (or by a second LDAPilot) while the
// app runs. Every write first compares the file with what the store last
// read or wrote (SHA-256): a changed file is re-read and the write is applied
// on top of it, so an external edit is never overwritten; a write that
// conflicts with it (the same profile changed or deleted there) is refused
// with ErrExternalChange.
type Store struct {
	mu       sync.RWMutex
	profiles []models.ConnectionProfile
	filePath string
	// sealed holds the stored ciphertext of passwords that could not be
	// decrypted (e.g. the key file was briefly unreadable): Save writes it
	// back unchanged instead of erasing the password (profile ID → value).
	sealed map[string]string
	// diskSum is the SHA-256 of connections.json as last read or written
	// (zero when there was no file).
	diskSum [sha256.Size]byte
	// onExternalChange is called (without the lock) after a write found and
	// re-read an external change of the file.
	onExternalChange func()
}

// SetExternalChangeHandler sets a function called after a write found that
// connections.json had been changed outside LDAPilot and re-read it (the
// frontend should reload its profile list).
func (s *Store) SetExternalChangeHandler(fn func()) {
	s.mu.Lock()
	s.onExternalChange = fn
	s.mu.Unlock()
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
			s.diskSum = [sha256.Size]byte{}
			return nil
		}
		return fmt.Errorf("failed to read connections file: %w", err)
	}
	profiles, sealed, err := parseProfiles(data)
	if err != nil {
		return err
	}
	s.profiles = profiles
	s.sealed = sealed
	s.diskSum = sha256.Sum256(data)
	return nil
}

// syncFromDisk re-reads connections.json when it differs from what the
// store last read or wrote. It reports whether it did. Caller holds s.mu.
func (s *Store) syncFromDisk() (bool, error) {
	data, err := os.ReadFile(s.filePath)
	switch {
	case os.IsNotExist(err):
		data = nil
	case err != nil:
		return false, fmt.Errorf("failed to read connections file: %w", err)
	}
	var sum [sha256.Size]byte
	if data != nil {
		sum = sha256.Sum256(data)
	}
	if sum == s.diskSum {
		return false, nil
	}
	profiles, sealed := make([]models.ConnectionProfile, 0), map[string]string{}
	if len(bytes.TrimSpace(data)) > 0 {
		if profiles, sealed, err = parseProfiles(data); err != nil {
			return false, fmt.Errorf("%w and cannot be read (%v); fix the file, then use Reload Profiles", ErrExternalChange, err)
		}
	}
	s.profiles, s.sealed, s.diskSum = profiles, sealed, sum
	return true, nil
}

// notifyExternalChange calls the external change handler; caller must not
// hold s.mu.
func (s *Store) notifyExternalChange(changed bool) {
	if !changed {
		return
	}
	s.mu.RLock()
	fn := s.onExternalChange
	s.mu.RUnlock()
	if fn != nil {
		fn()
	}
}

// parseProfiles decodes connections.json and decrypts the passwords.
func parseProfiles(data []byte) ([]models.ConnectionProfile, map[string]string, error) {
	var profiles []models.ConnectionProfile
	if err := json.Unmarshal(data, &profiles); err != nil {
		return nil, nil, fmt.Errorf("failed to parse connections file: %w", err)
	}
	if profiles == nil {
		profiles = make([]models.ConnectionProfile, 0)
	}

	// Decrypt passwords
	sealed := map[string]string{}
	for i := range profiles {
		if profiles[i].AskPassword {
			// Asks on every connect: a password in the file (edited by hand)
			// is never used and is not written back.
			profiles[i].Password = ""
			continue
		}
		if profiles[i].Password != "" {
			decrypted, err := DecryptPassword(profiles[i].Password)
			if err != nil {
				// Keep the ciphertext: the password must be re-entered to
				// use the profile, but a later save never erases it.
				sealed[profiles[i].ID] = profiles[i].Password
				profiles[i].Password = ""
			} else {
				profiles[i].Password = decrypted
			}
		}
	}
	return profiles, sealed, nil
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
		} else if c := s.sealed[encrypted[i].ID]; c != "" && !encrypted[i].AskPassword {
			// A profile that asks on every connect keeps no password, not
			// even one that could not be decrypted.
			encrypted[i].Password = c
		}
	}

	data, err := json.MarshalIndent(encrypted, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal connections: %w", err)
	}
	if err := os.WriteFile(s.filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write connections file: %w", err)
	}
	s.diskSum = sha256.Sum256(data)
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
	changed, err := s.syncFromDisk()
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	profile.ID = uuid.New().String()
	s.profiles = append(s.profiles, profile)
	err = s.Save()
	s.mu.Unlock()
	s.notifyExternalChange(changed)
	if err != nil {
		return nil, err
	}
	cp := profile
	return &cp, nil
}

// Update replaces an existing profile with matching ID.
// It saves to disk automatically.
func (s *Store) Update(profile models.ConnectionProfile) (*models.ConnectionProfile, error) {
	s.mu.Lock()
	before := s.find(profile.ID)
	changed, err := s.syncFromDisk()
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	saved, err := s.update(profile, before, changed)
	s.mu.Unlock()
	s.notifyExternalChange(changed)
	return saved, err
}

func (s *Store) update(profile models.ConnectionProfile, before *models.ConnectionProfile, changed bool) (*models.ConnectionProfile, error) {
	i := s.index(profile.ID)
	if i < 0 {
		if changed && before != nil {
			return nil, fmt.Errorf("%w: the profile %q was deleted there; the profiles were reloaded", ErrExternalChange, before.Name)
		}
		return nil, fmt.Errorf("connection profile with id %q not found", profile.ID)
	}
	if changed && before != nil && !sameProfile(*before, s.profiles[i]) {
		return nil, fmt.Errorf("%w: the profile %q was changed there too; the profiles were reloaded, repeat your change", ErrExternalChange, s.profiles[i].Name)
	}
	if profile.Password != "" || profile.AskPassword {
		// A new password replaces the sealed one; a profile that asks on
		// every connect stores none.
		delete(s.sealed, profile.ID)
	}
	s.profiles[i] = profile
	if err := s.Save(); err != nil {
		return nil, err
	}
	cp := profile
	return &cp, nil
}

// index returns the position of the profile with id, or -1. Caller holds s.mu.
func (s *Store) index(id string) int {
	for i, p := range s.profiles {
		if p.ID == id {
			return i
		}
	}
	return -1
}

// find returns a copy of the profile with id, or nil. Caller holds s.mu.
func (s *Store) find(id string) *models.ConnectionProfile {
	if i := s.index(id); i >= 0 {
		cp := s.profiles[i]
		return &cp
	}
	return nil
}

// sameProfile compares two profiles as they are stored (JSON, so nil and
// empty lists are equal).
func sameProfile(a, b models.ConnectionProfile) bool {
	ja, errA := json.Marshal(a)
	jb, errB := json.Marshal(b)
	return errA == nil && errB == nil && bytes.Equal(ja, jb)
}

// Delete removes a profile by ID.
// It saves to disk automatically.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	known := s.index(id) >= 0
	changed, err := s.syncFromDisk()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	i := s.index(id)
	switch {
	case i >= 0:
		s.profiles = append(s.profiles[:i], s.profiles[i+1:]...)
		delete(s.sealed, id)
		err = s.Save()
	case changed && known:
		// Already deleted outside LDAPilot: nothing left to do.
	default:
		err = fmt.Errorf("connection profile with id %q not found", id)
	}
	s.mu.Unlock()
	s.notifyExternalChange(changed)
	return err
}
