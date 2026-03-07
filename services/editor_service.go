package services

import (
	"context"
	"fmt"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

var errReadOnly = fmt.Errorf("connection is read-only")

// EditorService provides LDAP entry editing capabilities.
type EditorService struct {
	ctx  context.Context
	pool *ldap.Pool
}

// NewEditorService creates a new EditorService.
func NewEditorService(pool *ldap.Pool) *EditorService {
	return &EditorService{
		pool: pool,
	}
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
	return client.AddEntry(dn, attributes)
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
	return client.ModifyAttribute(dn, attrName, values)
}

// AddAttribute adds an attribute with values to an entry.
func (s *EditorService) AddAttribute(profileID string, dn string, attrName string, values []string) error {
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	return client.AddAttribute(dn, attrName, values)
}

// DeleteAttribute removes an attribute from an entry.
func (s *EditorService) DeleteAttribute(profileID string, dn string, attrName string) error {
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	return client.DeleteAttribute(dn, attrName)
}

// DeleteEntry removes an LDAP entry by DN.
func (s *EditorService) DeleteEntry(profileID string, dn string) error {
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	return client.DeleteEntry(dn)
}

// RenameEntry renames or moves an LDAP entry.
func (s *EditorService) RenameEntry(profileID string, dn string, newRDN string, deleteOldRDN bool, newSuperior string) error {
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return err
	}
	return client.RenameEntry(dn, newRDN, deleteOldRDN, newSuperior)
}
