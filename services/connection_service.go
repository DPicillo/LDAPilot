package services

import (
	"context"

	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
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
