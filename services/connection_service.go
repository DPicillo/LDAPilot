package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// ConnectionService manages connection profiles and their active connections.
type ConnectionService struct {
	ctx           context.Context
	store         *config.Store
	pool          *ldap.Pool
	schemaService *SchemaService
	auditStore    *config.AuditStore
}

// NewConnectionService creates a new ConnectionService.
func NewConnectionService(store *config.Store, pool *ldap.Pool) *ConnectionService {
	return &ConnectionService{
		store: store,
		pool:  pool,
	}
}

// SetSchemaService sets a reference to the SchemaService for cache cleanup on disconnect.
func (s *ConnectionService) SetSchemaService(ss *SchemaService) {
	s.schemaService = ss
}

// SetAuditStore sets a reference to the AuditStore for cleanup on connection delete.
func (s *ConnectionService) SetAuditStore(store *config.AuditStore) {
	s.auditStore = store
}

// SetContext sets the Wails application context.
func (s *ConnectionService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// GetConnections returns all saved connection profiles.
func (s *ConnectionService) GetConnections() []models.ConnectionProfile {
	profiles := s.store.GetAll()
	// Mask passwords before returning to the frontend
	for i := range profiles {
		profiles[i].HasPassword = profiles[i].Password != ""
		profiles[i].Password = ""
	}
	return profiles
}

// GetConnection returns a single connection profile by ID.
func (s *ConnectionService) GetConnection(id string) (*models.ConnectionProfile, error) {
	profile, err := s.store.Get(id)
	if err != nil {
		return nil, err
	}
	return profile, nil
}

// SaveConnection creates or updates a connection profile.
// If the profile has an empty ID, a new profile is created.
// If the profile has an existing ID, it is updated.
func (s *ConnectionService) SaveConnection(profile models.ConnectionProfile) (*models.ConnectionProfile, error) {
	if profile.ID == "" {
		// Set defaults
		if profile.Port == 0 {
			profile.Port = 389
		}
		if profile.PageSize == 0 {
			profile.PageSize = 500
		}
		if profile.Timeout == 0 {
			profile.Timeout = 10
		}
		if profile.AuthMethod == "" {
			profile.AuthMethod = models.AuthSimple
		}
		if profile.TLSMode == "" {
			profile.TLSMode = models.TLSNone
		}
		return s.store.Add(profile)
	}

	// For updates, preserve password if not provided (empty string = keep existing)
	if profile.Password == "" {
		existing, err := s.store.Get(profile.ID)
		if err == nil {
			profile.Password = existing.Password
		}
	}

	return s.store.Update(profile)
}

// DeleteConnection removes a connection profile by ID and disconnects if active.
// Also removes associated audit logs.
func (s *ConnectionService) DeleteConnection(id string) error {
	s.pool.Disconnect(id)
	if s.schemaService != nil {
		s.schemaService.ClearCache(id)
	}
	if s.auditStore != nil {
		_ = s.auditStore.DeleteForProfile(id)
	}
	return s.store.Delete(id)
}

// Connect establishes an LDAP connection for the given profile ID.
func (s *ConnectionService) Connect(profileID string) error {
	profile, err := s.store.Get(profileID)
	if err != nil {
		return err
	}
	return s.pool.Connect(*profile)
}

// Disconnect closes the LDAP connection for the given profile ID.
func (s *ConnectionService) Disconnect(profileID string) error {
	s.pool.Disconnect(profileID)
	if s.schemaService != nil {
		s.schemaService.ClearCache(profileID)
	}
	return nil
}

// TestConnection creates a temporary connection to validate settings, then disconnects.
func (s *ConnectionService) TestConnection(profile models.ConnectionProfile) error {
	// If password is empty but the profile exists, use saved password for test
	if profile.Password == "" && profile.ID != "" {
		existing, err := s.store.Get(profile.ID)
		if err == nil {
			profile.Password = existing.Password
		}
	}
	client := ldap.NewClient(profile)
	err := client.Connect()
	if err != nil {
		return err
	}
	client.Close()
	return nil
}

// GetConnectionStatus returns whether a connection is currently active for the given profile ID.
func (s *ConnectionService) GetConnectionStatus(profileID string) bool {
	return s.pool.IsConnected(profileID)
}

// Reconnect attempts to re-establish a connection for the given profile ID.
// Useful when a connection has been lost due to timeout or network issues.
func (s *ConnectionService) Reconnect(profileID string) error {
	profile, err := s.store.Get(profileID)
	if err != nil {
		return err
	}
	// Disconnect cleanly first
	s.pool.Disconnect(profileID)
	// Reconnect
	return s.pool.Connect(*profile)
}

// PingConnection checks if the connection is still alive by performing a
// quick RootDSE read. Returns true if alive, false if dead.
func (s *ConnectionService) PingConnection(profileID string) bool {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return false
	}
	// Try a lightweight RootDSE read
	_, err = client.GetRootDSE()
	return err == nil
}

// exportProfile is a copy of ConnectionProfile without the encrypted password,
// used for JSON export. Passwords are exported in plain text.
type exportProfile struct {
	Name             string `json:"name"`
	Host             string `json:"host"`
	Port             int    `json:"port"`
	BaseDN           string `json:"baseDN"`
	AuthMethod       string `json:"authMethod"`
	BindDN           string `json:"bindDN"`
	Password         string `json:"password,omitempty"`
	TLSMode          string `json:"tlsMode"`
	TLSSkipVerify    bool   `json:"tlsSkipVerify"`
	PageSize         int    `json:"pageSize"`
	Timeout          int    `json:"timeout"`
	ReadOnly         bool   `json:"readOnly"`
	DisableReferrals bool   `json:"disableReferrals"`
}

// ExportConnections opens a save dialog and exports all connection profiles to a JSON file.
// Passwords are included in plain text so they can be re-imported.
func (s *ConnectionService) ExportConnections() error {
	profiles := s.store.GetAll()
	exports := make([]exportProfile, 0, len(profiles))
	for _, p := range profiles {
		exports = append(exports, exportProfile{
			Name:             p.Name,
			Host:             p.Host,
			Port:             p.Port,
			BaseDN:           p.BaseDN,
			AuthMethod:       string(p.AuthMethod),
			BindDN:           p.BindDN,
			Password:         p.Password,
			TLSMode:          string(p.TLSMode),
			TLSSkipVerify:    p.TLSSkipVerify,
			PageSize:         p.PageSize,
			Timeout:          p.Timeout,
			ReadOnly:         p.ReadOnly,
			DisableReferrals: p.DisableReferrals,
		})
	}

	hasPasswords := false
	for _, ep := range exports {
		if ep.Password != "" {
			hasPasswords = true
			break
		}
	}

	if hasPasswords {
		result, err := runtime.MessageDialog(s.ctx, runtime.MessageDialogOptions{
			Type:          runtime.WarningDialog,
			Title:         "Security Warning",
			Message:       "The export file will contain passwords in plaintext.\n\nStore the exported file securely and delete it after import.",
			Buttons:       []string{"Continue", "Cancel"},
			DefaultButton: "Cancel",
		})
		if err != nil || result == "Cancel" {
			return nil
		}
	}

	filePath, err := runtime.SaveFileDialog(s.ctx, runtime.SaveDialogOptions{
		Title:                "Export Connections",
		DefaultFilename:      "ldapilot-connections.json",
		CanCreateDirectories: true,
		Filters: []runtime.FileFilter{
			{DisplayName: "JSON Files (*.json)", Pattern: "*.json"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return fmt.Errorf("dialog failed: %w", err)
	}
	if filePath == "" {
		return nil // user cancelled
	}

	data, err := json.MarshalIndent(exports, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal connections: %w", err)
	}

	if err := os.WriteFile(filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}

	return nil
}

// ImportConnections opens a file dialog and imports connection profiles from a JSON file.
// Returns the number of connections imported.
func (s *ConnectionService) ImportConnections() (int, error) {
	filePath, err := runtime.OpenFileDialog(s.ctx, runtime.OpenDialogOptions{
		Title: "Import Connections",
		Filters: []runtime.FileFilter{
			{DisplayName: "JSON Files (*.json)", Pattern: "*.json"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return 0, fmt.Errorf("dialog failed: %w", err)
	}
	if filePath == "" {
		return 0, nil // user cancelled
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return 0, fmt.Errorf("failed to read file: %w", err)
	}

	var imports []exportProfile
	if err := json.Unmarshal(data, &imports); err != nil {
		return 0, fmt.Errorf("invalid JSON format: %w", err)
	}

	count := 0
	for _, imp := range imports {
		profile := models.ConnectionProfile{
			Name:             imp.Name,
			Host:             imp.Host,
			Port:             imp.Port,
			BaseDN:           imp.BaseDN,
			AuthMethod:       models.AuthMethod(imp.AuthMethod),
			BindDN:           imp.BindDN,
			Password:         imp.Password,
			TLSMode:          models.TLSMode(imp.TLSMode),
			TLSSkipVerify:    imp.TLSSkipVerify,
			PageSize:         imp.PageSize,
			Timeout:          imp.Timeout,
			ReadOnly:         imp.ReadOnly,
			DisableReferrals: imp.DisableReferrals,
		}
		// Set defaults
		if profile.Port == 0 {
			profile.Port = 389
		}
		if profile.PageSize == 0 {
			profile.PageSize = 500
		}
		if profile.Timeout == 0 {
			profile.Timeout = 10
		}
		if profile.AuthMethod == "" {
			profile.AuthMethod = models.AuthSimple
		}
		if profile.TLSMode == "" {
			profile.TLSMode = models.TLSNone
		}

		if _, err := s.store.Add(profile); err != nil {
			continue // skip duplicates or errors
		}
		count++
	}

	return count, nil
}
