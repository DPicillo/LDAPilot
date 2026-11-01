package services

import (
	"context"
	"fmt"

	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// EditorService provides LDAP entry editing capabilities.
type EditorService struct {
	ctx        context.Context
	pool       *ldap.Pool
	auditStore *config.AuditStore
}

// NewEditorService creates a new EditorService.
func NewEditorService(pool *ldap.Pool) *EditorService {
	return &EditorService{
		pool: pool,
	}
}

// SetAuditStore sets the audit store for persistent change logging.
func (s *EditorService) SetAuditStore(store *config.AuditStore) {
	s.auditStore = store
}

func (s *EditorService) audit(profileID, operation, dn, details string, err error) {
	writeAudit(s.auditStore, s.pool, profileID, operation, dn, details, err)
}

// SetContext sets the Wails application context.
func (s *EditorService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

func (s *EditorService) getWritableClient(profileID string) (*ldap.Client, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	if err := client.CheckWritable(); err != nil {
		return nil, err
	}
	return client, nil
}

// CreateEntry creates a new LDAP entry with the given DN and attributes.
// userPassword values follow the connection's password storage policy;
// writes that need a decision ("ask") or a confirmation (cleartext password
// on an unencrypted connection) are refused - use CreateEntryWithOptions.
func (s *EditorService) CreateEntry(profileID string, dn string, attributes []models.LDAPAttribute) error {
	_, err := s.CreateEntryWithOptions(profileID, dn, attributes, models.PasswordWriteOptions{})
	return err
}

// ModifyEntry applies all changes to an entry in one atomic modify request.
// Each change is "add", "delete" or "replace"; a delete without values
// removes the whole attribute. Binary changes carry base64 values;
// unicodePwd values are plain-text passwords (delete old + add new changes a
// user's own password, replace resets it); userPassword values follow the
// password storage policy (see CreateEntry, ModifyEntryWithOptions). An
// OpenLDAP account disabled in the account panel stays disabled when the
// changes touch its password (keepAccountDisabled); a failed re-lock is
// returned as an error although the changes are applied.
func (s *EditorService) ModifyEntry(profileID string, dn string, changes []models.AttributeChange) error {
	_, err := s.ModifyEntryWithOptions(profileID, dn, changes, models.PasswordWriteOptions{})
	return err
}

// keepDisabled is keepAccountDisabled for the attribute editor's writes.
func (s *EditorService) keepDisabled(profileID, dn string, guard *ldap.PermanentLockGuard) error {
	_, err := keepAccountDisabled(guard, func(op, dn, details string, err error) {
		s.audit(profileID, op, dn, details, err)
	}, dn, "password change")
	return err
}

// ModifyAttribute replaces the values of an attribute on an entry.
func (s *EditorService) ModifyAttribute(profileID string, dn string, attrName string, values []string) error {
	if dn == "" {
		return fmt.Errorf("DN must not be empty")
	}
	if attrName == "" {
		return fmt.Errorf("attribute name must not be empty")
	}
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	change := []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: attrName, Values: values}}
	guard := client.GuardPermanentLock(dn, change)
	// The audit shows what changed: the values before the write → after.
	before := auditBefore(client, dn, change)
	result := client.ModifyAttribute(dn, attrName, values)
	detail := describeChangesWithBefore(change, before)
	if isSensitiveAttribute(attrName) {
		detail = fmt.Sprintf("attr=%s (password change)", attrName)
	}
	s.audit(profileID, "MODIFY", dn, detail, result)
	if result != nil {
		return result
	}
	return s.keepDisabled(profileID, dn, guard)
}

// AddAttribute adds an attribute with values to an entry.
func (s *EditorService) AddAttribute(profileID string, dn string, attrName string, values []string) error {
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	change := []models.AttributeChange{{Operation: models.ChangeAdd, Attribute: attrName, Values: values}}
	guard := client.GuardPermanentLock(dn, change)
	result := client.AddAttribute(dn, attrName, values)
	s.audit(profileID, "ADD_ATTR", dn, describeChangesWithBefore(change, map[string]models.LDAPAttribute{}), result)
	if result != nil {
		return result
	}
	return s.keepDisabled(profileID, dn, guard)
}

// DeleteAttribute removes an attribute from an entry.
func (s *EditorService) DeleteAttribute(profileID string, dn string, attrName string) error {
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	change := []models.AttributeChange{{Operation: models.ChangeDelete, Attribute: attrName}}
	guard := client.GuardPermanentLock(dn, change)
	before := auditBefore(client, dn, change)
	result := client.DeleteAttribute(dn, attrName)
	detail := fmt.Sprintf("attr=%s", attrName)
	if before != nil {
		detail = describeChangesWithBefore(change, before)
	}
	s.audit(profileID, "DEL_ATTR", dn, detail, result)
	if result != nil {
		return result
	}
	return s.keepDisabled(profileID, dn, guard)
}

// DeleteEntry removes an LDAP entry by DN.
func (s *EditorService) DeleteEntry(profileID string, dn string) error {
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	result := client.DeleteEntry(dn)
	s.audit(profileID, "DELETE", dn, "", result)
	return result
}

// RenameEntry renames or moves an LDAP entry. It is audited as MOVE when
// newSuperior is another parent, else as RENAME; the details carry newDN=.
func (s *EditorService) RenameEntry(profileID string, dn string, newRDN string, deleteOldRDN bool, newSuperior string) error {
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	result := client.RenameEntry(dn, newRDN, deleteOldRDN, newSuperior)
	// A new parent is a move (Rename/Move dialog, drag and drop).
	s.audit(profileID, renameAuditOperation(dn, newSuperior), dn, describeRenameForAudit(dn, newRDN, deleteOldRDN, newSuperior), result)
	return result
}
