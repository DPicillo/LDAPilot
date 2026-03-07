package services

import (
	"context"
	"fmt"
	"sync"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// SchemaService handles schema-related operations.
type SchemaService struct {
	pool  *ldap.Pool
	ctx   context.Context
	cache map[string]*models.SchemaInfo
	mu    sync.RWMutex
}

// NewSchemaService creates a new SchemaService.
func NewSchemaService(pool *ldap.Pool) *SchemaService {
	return &SchemaService{
		pool:  pool,
		cache: make(map[string]*models.SchemaInfo),
	}
}

// SetContext sets the Wails context.
func (s *SchemaService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// GetSchema retrieves the schema for a connection, using cache.
func (s *SchemaService) GetSchema(profileID string) (*models.SchemaInfo, error) {
	// Check cache
	s.mu.RLock()
	if cached, ok := s.cache[profileID]; ok {
		s.mu.RUnlock()
		return cached, nil
	}
	s.mu.RUnlock()

	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, fmt.Errorf("not connected: %w", err)
	}

	schema, err := client.GetSchema()
	if err != nil {
		return nil, fmt.Errorf("failed to read schema: %w", err)
	}

	// Cache the result
	s.mu.Lock()
	s.cache[profileID] = schema
	s.mu.Unlock()

	return schema, nil
}

// RefreshSchema clears cached schema and re-reads it.
func (s *SchemaService) RefreshSchema(profileID string) (*models.SchemaInfo, error) {
	s.mu.Lock()
	delete(s.cache, profileID)
	s.mu.Unlock()

	return s.GetSchema(profileID)
}

// ClearCache removes the cached schema for a profile (e.g. on disconnect).
func (s *SchemaService) ClearCache(profileID string) {
	s.mu.Lock()
	delete(s.cache, profileID)
	s.mu.Unlock()
}

// GetObjectClass retrieves a single objectClass by name.
func (s *SchemaService) GetObjectClass(profileID string, name string) (*models.SchemaObjectClass, error) {
	schema, err := s.GetSchema(profileID)
	if err != nil {
		return nil, err
	}

	for _, oc := range schema.ObjectClasses {
		if oc.Name == name {
			return &oc, nil
		}
	}

	return nil, fmt.Errorf("objectClass %q not found", name)
}
