package config

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const auditDirName = "audit"

// AuditEntry represents a single auditable change operation.
type AuditEntry struct {
	Timestamp string `json:"timestamp"`
	Operation string `json:"operation"` // CREATE, MODIFY, DELETE, RENAME, ADD_ATTR, DEL_ATTR, MOVE, AUDIT_CLEARED, ...
	DN        string `json:"dn"`
	Details   string `json:"details,omitempty"`
	Error     string `json:"error,omitempty"`
	User      string `json:"user,omitempty"` // bind DN of the user who performed the operation
}

// AuditOperationCleared is the operation of the record ClearWithRecord
// leaves in an emptied audit log.
const AuditOperationCleared = "AUDIT_CLEARED"

// AuditStore manages persistent audit logs stored as JSONL files per connection profile.
type AuditStore struct {
	mu       sync.Mutex
	listener func(profileID string, entry AuditEntry)
}

// NewAuditStore creates a new AuditStore.
func NewAuditStore() *AuditStore {
	return &AuditStore{}
}

// SetListener sets a callback that receives every appended entry (the audit
// view updates live). It is called after the entry was written.
func (a *AuditStore) SetListener(fn func(profileID string, entry AuditEntry)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.listener = fn
}

func (a *AuditStore) notify(profileID string, entry AuditEntry) {
	a.mu.Lock()
	fn := a.listener
	a.mu.Unlock()
	if fn != nil {
		fn(profileID, entry)
	}
}

func auditDir() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	d := filepath.Join(dir, auditDirName)
	if err := os.MkdirAll(d, 0700); err != nil {
		return "", err
	}
	return d, nil
}

func auditFilePath(profileID string) (string, error) {
	dir, err := auditDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, profileID+".jsonl"), nil
}

// Append adds an audit entry for the given profile.
func (a *AuditStore) Append(profileID string, entry AuditEntry) error {
	if entry.Timestamp == "" {
		entry.Timestamp = time.Now().Format("2006-01-02 15:04:05")
	}

	fp, err := auditFilePath(profileID)
	if err != nil {
		return err
	}

	f, err := os.OpenFile(fp, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("open audit file: %w", err)
	}
	defer f.Close()

	data, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("marshal audit entry: %w", err)
	}
	data = append(data, '\n')
	if _, err = f.Write(data); err != nil {
		return err
	}
	a.notify(profileID, entry)
	return nil
}

// GetEntries returns audit entries for a profile, newest first.
// If limit <= 0, all entries are returned.
func (a *AuditStore) GetEntries(profileID string, limit int) ([]AuditEntry, error) {
	return a.GetEntriesBetween(profileID, "", "", limit)
}

// GetEntriesBetween returns the audit entries of a profile with from <=
// timestamp <= to, newest first (at most limit; limit <= 0 = all). from and
// to are timestamps in the log's format ("2006-01-02 15:04:05") or a prefix
// of one ("2026-10-31"): to matches every entry that starts with it, so
// "2026-10-31" includes that whole day. Empty bounds are open.
func (a *AuditStore) GetEntriesBetween(profileID, from, to string, limit int) ([]AuditEntry, error) {
	fp, err := auditFilePath(profileID)
	if err != nil {
		return nil, err
	}

	f, err := os.Open(fp)
	if err != nil {
		if os.IsNotExist(err) {
			return []AuditEntry{}, nil
		}
		return nil, err
	}
	defer f.Close()

	var entries []AuditEntry
	scanner := bufio.NewScanner(f)
	// Increase scanner buffer for long lines
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var entry AuditEntry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			continue // skip corrupt lines
		}
		if !auditInRange(entry.Timestamp, from, to) {
			continue
		}
		entries = append(entries, entry)
	}

	// Reverse to get newest first
	for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
		entries[i], entries[j] = entries[j], entries[i]
	}

	if limit > 0 && len(entries) > limit {
		entries = entries[:limit]
	}

	return entries, nil
}

// DeleteForProfile removes the audit log file for a profile.
func (a *AuditStore) DeleteForProfile(profileID string) error {
	fp, err := auditFilePath(profileID)
	if err != nil {
		return err
	}
	err = os.Remove(fp)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// auditInRange reports whether ts lies within [from, to] (see
// GetEntriesBetween). Timestamps compare as strings ("2006-01-02 15:04:05").
func auditInRange(ts, from, to string) bool {
	if from != "" && ts < from {
		return false
	}
	if to != "" && ts > to && !strings.HasPrefix(ts, to) {
		return false
	}
	return true
}

// Clear removes all audit entries for a profile.
func (a *AuditStore) Clear(profileID string) error {
	fp, err := auditFilePath(profileID)
	if err != nil {
		return err
	}
	return os.WriteFile(fp, []byte{}, 0600)
}

// ClearWithRecord replaces the audit log of a profile with one record that
// documents the clear (operation AUDIT_CLEARED, who and when; its Details
// get the number of removed entries appended). The file is replaced
// atomically, so a failed clear leaves the old log. Returns the number of
// removed entries.
func (a *AuditStore) ClearWithRecord(profileID string, record AuditEntry) (int, error) {
	fp, err := auditFilePath(profileID)
	if err != nil {
		return 0, err
	}
	old, err := a.GetEntries(profileID, 0)
	if err != nil {
		return 0, err
	}
	if record.Operation == "" {
		record.Operation = AuditOperationCleared
	}
	if record.Timestamp == "" {
		record.Timestamp = time.Now().Format("2006-01-02 15:04:05")
	}
	// "1 entry removed" / "n entries removed" (RW3-R-04).
	removed := fmt.Sprintf("%d entries removed", len(old))
	if len(old) == 1 {
		removed = "1 entry removed"
	}
	if record.Details == "" {
		record.Details = removed
	} else {
		record.Details += " (" + removed + ")"
	}
	data, err := json.Marshal(record)
	if err != nil {
		return 0, fmt.Errorf("marshal audit entry: %w", err)
	}
	tmp := fp + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0600); err != nil {
		return 0, err
	}
	if err := os.Rename(tmp, fp); err != nil {
		os.Remove(tmp)
		return 0, err
	}
	a.notify(profileID, record)
	return len(old), nil
}
