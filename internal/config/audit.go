package config

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const auditDirName = "audit"

// AuditEntry represents a single auditable change operation.
type AuditEntry struct {
	Timestamp string `json:"timestamp"`
	Operation string `json:"operation"` // CREATE, MODIFY, DELETE, RENAME, ADD_ATTR, DEL_ATTR, MOVE
	DN        string `json:"dn"`
	Details   string `json:"details,omitempty"`
	Error     string `json:"error,omitempty"`
	User      string `json:"user,omitempty"` // bind DN of the user who performed the operation
}

// AuditStore manages persistent audit logs stored as JSONL files per connection profile.
type AuditStore struct{}

// NewAuditStore creates a new AuditStore.
func NewAuditStore() *AuditStore {
	return &AuditStore{}
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
	_, err = f.Write(data)
	return err
}

// GetEntries returns audit entries for a profile, newest first.
// If limit <= 0, all entries are returned.
func (a *AuditStore) GetEntries(profileID string, limit int) ([]AuditEntry, error) {
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

// Clear removes all audit entries for a profile.
func (a *AuditStore) Clear(profileID string) error {
	fp, err := auditFilePath(profileID)
	if err != nil {
		return err
	}
	return os.WriteFile(fp, []byte{}, 0600)
}
