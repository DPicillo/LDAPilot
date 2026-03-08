package services

import (
	"context"

	"github.com/dpicillo/LDAPilot/internal/config"
)

// AuditService provides persistent audit log access.
type AuditService struct {
	ctx   context.Context
	store *config.AuditStore
}

// NewAuditService creates a new AuditService.
func NewAuditService(store *config.AuditStore) *AuditService {
	return &AuditService{
		store: store,
	}
}

// SetContext sets the Wails application context.
func (s *AuditService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// Store returns the underlying audit store (for use by other services).
func (s *AuditService) Store() *config.AuditStore {
	return s.store
}

// GetAuditLog returns audit entries for a connection, newest first.
func (s *AuditService) GetAuditLog(profileID string, limit int) ([]config.AuditEntry, error) {
	if limit <= 0 {
		limit = 500
	}
	return s.store.GetEntries(profileID, limit)
}

// ClearAuditLog removes all audit entries for a connection.
func (s *AuditService) ClearAuditLog(profileID string) error {
	return s.store.Clear(profileID)
}
