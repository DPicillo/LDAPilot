package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

var errReadOnly = fmt.Errorf("connection is read-only")

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
	if s.auditStore == nil {
		return
	}
	entry := config.AuditEntry{
		Operation: operation,
		DN:        dn,
		Details:   details,
	}
	if err != nil {
		entry.Error = err.Error()
	}
	// Get bind DN for the user field
	if client, cerr := s.pool.Get(profileID); cerr == nil {
		entry.User = client.Profile().BindDN
	}
	_ = s.auditStore.Append(profileID, entry)
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
	if client.Profile().ReadOnly {
		return nil, errReadOnly
	}
	return client, nil
}

// CreateEntry creates a new LDAP entry with the given DN and attributes.
func (s *EditorService) CreateEntry(profileID string, dn string, attributes []models.LDAPAttribute) error {
	if dn == "" {
		return fmt.Errorf("DN must not be empty")
	}
	if len(attributes) == 0 {
		return fmt.Errorf("entry must have at least one attribute")
	}
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	// Build attribute summary
	var attrNames []string
	for _, a := range attributes {
		attrNames = append(attrNames, a.Name)
	}
	result := client.AddEntry(dn, attributes)
	s.audit(profileID, "CREATE", dn, "attrs: "+strings.Join(attrNames, ", "), result)
	return result
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
	result := client.ModifyAttribute(dn, attrName, values)
	detail := fmt.Sprintf("attr=%s values=%d", attrName, len(values))
	if strings.EqualFold(attrName, "unicodePwd") || strings.EqualFold(attrName, "userPassword") {
		detail = fmt.Sprintf("attr=%s (password change)", attrName)
	}
	s.audit(profileID, "MODIFY", dn, detail, result)
	return result
}

// AddAttribute adds an attribute with values to an entry.
func (s *EditorService) AddAttribute(profileID string, dn string, attrName string, values []string) error {
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	result := client.AddAttribute(dn, attrName, values)
	s.audit(profileID, "ADD_ATTR", dn, fmt.Sprintf("attr=%s values=%d", attrName, len(values)), result)
	return result
}

// DeleteAttribute removes an attribute from an entry.
func (s *EditorService) DeleteAttribute(profileID string, dn string, attrName string) error {
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	result := client.DeleteAttribute(dn, attrName)
	s.audit(profileID, "DEL_ATTR", dn, fmt.Sprintf("attr=%s", attrName), result)
	return result
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

// RenameEntry renames or moves an LDAP entry.
func (s *EditorService) RenameEntry(profileID string, dn string, newRDN string, deleteOldRDN bool, newSuperior string) error {
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	result := client.RenameEntry(dn, newRDN, deleteOldRDN, newSuperior)
	detail := fmt.Sprintf("newRDN=%s", newRDN)
	if newSuperior != "" {
		detail += fmt.Sprintf(" newSuperior=%s", newSuperior)
	}
	s.audit(profileID, "RENAME", dn, detail, result)
	return result
}
