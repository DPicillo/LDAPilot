package services

import (
	"context"
	"os"
	"os/user"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/config"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// AuditEntryEvent is the Wails event sent for every appended audit entry
// (arguments: profile ID, entry), so an open audit view updates live.
const AuditEntryEvent = "audit:entry"

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

// SetContext sets the Wails application context and forwards new audit
// entries as AuditEntryEvent events.
func (s *AuditService) SetContext(ctx context.Context) {
	s.ctx = ctx
	if s.store != nil && ctx != nil {
		s.store.SetListener(func(profileID string, entry config.AuditEntry) {
			wailsRuntime.EventsEmit(ctx, AuditEntryEvent, profileID, entry)
		})
	}
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

// GetAuditLogRange returns the audit entries of a connection between from
// and to (timestamps "2006-01-02 15:04:05" or a prefix such as a date; a
// date as to includes that day; empty = open), newest first, at most limit
// (limit <= 0 = all, e.g. for an export).
func (s *AuditService) GetAuditLogRange(profileID, from, to string, limit int) ([]config.AuditEntry, error) {
	return s.store.GetEntriesBetween(profileID, from, to, limit)
}

// ClearAuditLog removes all audit entries for a connection. The log keeps
// one AUDIT_CLEARED record with the local user who cleared it and the
// number of removed entries, so a clear never goes unnoticed.
func (s *AuditService) ClearAuditLog(profileID string) error {
	_, err := s.store.ClearWithRecord(profileID, config.AuditEntry{
		Operation: config.AuditOperationCleared,
		Details:   "audit log cleared",
		User:      localUserName(),
	})
	return err
}

// localUserName names the operating system user running LDAPilot (who
// performed a local action such as clearing the audit log), with the host.
func localUserName() string {
	name := ""
	if u, err := user.Current(); err == nil {
		name = u.Username
	}
	if name == "" {
		name = os.Getenv("USER")
		if name == "" {
			name = os.Getenv("USERNAME")
		}
	}
	if host, err := os.Hostname(); err == nil && host != "" && !strings.Contains(name, "\\") {
		if name == "" {
			return "@" + host
		}
		return name + "@" + host
	}
	return name
}
