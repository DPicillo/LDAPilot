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
}

// Logger collects LDAP operation logs and notifies listeners.
type Logger struct {
	mu       sync.RWMutex
	entries  []LogEntry
	listener func(LogEntry)
	maxSize  int
}

// NewLogger creates a new Logger.
func NewLogger() *Logger {
	return &Logger{
		maxSize: 1000,
	}
}

// SetListener sets a callback for new log entries.
func (l *Logger) SetListener(fn func(LogEntry)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.listener = fn
}

// Log adds a log entry.
func (l *Logger) Log(operation, details string, duration time.Duration, err error) {
	entry := LogEntry{
		Timestamp: time.Now().Format("15:04:05.000"),
		Operation: operation,
		Details:   details,
		Duration:  fmt.Sprintf("%.1fms", float64(duration.Microseconds())/1000),
	}
	if err != nil {
		entry.Error = err.Error()
	}

	l.mu.Lock()
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
