package ldap

import (
	"fmt"
	"sync"
	"time"
)

// LogEntry represents a single LDAP operation log entry.
type LogEntry struct {
	Timestamp string `json:"timestamp"`
	Operation string `json:"operation"`
	Details   string `json:"details"`
	Duration  string `json:"duration"`
	Error     string `json:"error,omitempty"`
	// ProfileID names the connection the operation ran on: every connected
	// profile streams "operation:log" events, so views filter on it (RW1-C-03).
	ProfileID string `json:"profileId,omitempty"`
	// Seq numbers the entries of one profile's log (1, 2, …; never reused
	// after Clear): a view merging GetLogs with the live stream drops the
	// entries it already has.
	Seq uint64 `json:"seq"`
	// At is the local date and time (RFC 3339 with milliseconds) for exports;
	// Timestamp is the time of day the log view shows.
	At string `json:"at"`
}

// Logger collects LDAP operation logs and notifies listeners.
type Logger struct {
	mu        sync.RWMutex
	entries   []LogEntry
	listener  func(LogEntry)
	maxSize   int
	profileID string
	seq       uint64
}

// NewLogger creates a new Logger.
func NewLogger() *Logger {
	return &Logger{
		maxSize: 1000,
	}
}

// setProfile names the profile whose operations the logger records (stamped
// on every entry as ProfileID).
func (l *Logger) setProfile(profileID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.profileID = profileID
}

// SetListener sets a callback for new log entries.
func (l *Logger) SetListener(fn func(LogEntry)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.listener = fn
}

// Log adds a log entry.
func (l *Logger) Log(operation, details string, duration time.Duration, err error) {
	now := time.Now()
	entry := LogEntry{
		Timestamp: now.Format("15:04:05.000"),
		Operation: operation,
		Details:   details,
		Duration:  fmt.Sprintf("%.1fms", float64(duration.Microseconds())/1000),
		At:        now.Format("2006-01-02T15:04:05.000Z07:00"),
	}
	if err != nil {
		entry.Error = ldapErrorDetail(err)
	}

	l.mu.Lock()
	l.seq++
	entry.Seq = l.seq
	entry.ProfileID = l.profileID
	l.entries = append(l.entries, entry)
	if len(l.entries) > l.maxSize {
		l.entries = l.entries[len(l.entries)-l.maxSize:]
	}
	listener := l.listener
	l.mu.Unlock()

	if listener != nil {
		listener(entry)
	}
}

// GetEntries returns all log entries.
func (l *Logger) GetEntries() []LogEntry {
	l.mu.RLock()
	defer l.mu.RUnlock()
	result := make([]LogEntry, len(l.entries))
	copy(result, l.entries)
	return result
}

// Clear removes all log entries.
func (l *Logger) Clear() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = nil
}
