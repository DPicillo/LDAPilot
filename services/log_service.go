package services

import (
	"context"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// LogService provides operation log access.
type LogService struct {
	ctx  context.Context
	pool *ldap.Pool
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

// GetLogs returns all log entries for a connection.
func (s *LogService) GetLogs(profileID string) ([]ldap.LogEntry, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.Logger().GetEntries(), nil
}

// ClearLogs clears all log entries for a connection.
func (s *LogService) ClearLogs(profileID string) error {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return err
	}
	client.Logger().Clear()
	return nil
}

// StartLogStream starts forwarding log entries as Wails events.
func (s *LogService) StartLogStream(profileID string) error {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return err
	}

	client.Logger().SetListener(func(entry ldap.LogEntry) {
		if s.ctx != nil {
			wailsRuntime.EventsEmit(s.ctx, "operation:log", entry)
		}
	})

	return nil
}
