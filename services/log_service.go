package services

import (
	"context"
	"sync"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// LogService provides operation log access.
type LogService struct {
	ctx  context.Context
	pool *ldap.Pool
	// batch coalesces the operation:log events of all profiles.
	batch     *eventBatcher
	batchOnce sync.Once
}

// NewLogService creates a new LogService.
func NewLogService(pool *ldap.Pool) *LogService {
	return &LogService{
		pool: pool,
	}
}

// SetContext sets the Wails context and starts log event forwarding.
func (s *LogService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// GetLogs returns all log entries for a connection. The pool keeps one log
// per profile across clients, so this also works while the profile is not
// connected: failed connects and re-dials stay visible (RW1-C-02).
func (s *LogService) GetLogs(profileID string) ([]ldap.LogEntry, error) {
	if profileID == "" {
		return nil, nil
	}
	return s.pool.Logger(profileID).GetEntries(), nil
}

// ClearLogs clears all log entries for a connection.
func (s *LogService) ClearLogs(profileID string) error {
	if profileID == "" {
		return nil
	}
	s.pool.Logger(profileID).Clear()
	return nil
}

// StartLogStream starts forwarding log entries as Wails events (entries
// carry their ProfileID). Works for a disconnected profile too.
func (s *LogService) StartLogStream(profileID string) error {
	if profileID == "" {
		return nil
	}
	s.batchOnce.Do(func() {
		s.batch = newEventBatcher(func(entries []any) {
			if s.ctx != nil {
				wailsRuntime.EventsEmit(s.ctx, "operation:log", entries...)
			}
		})
	})
	s.pool.Logger(profileID).SetListener(func(entry ldap.LogEntry) { s.batch.add(entry) })

	return nil
}
