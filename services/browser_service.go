package services

import (
	"context"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// BrowserService provides directory tree browsing capabilities.
type BrowserService struct {
	ctx  context.Context
	pool *ldap.Pool
}

// NewBrowserService creates a new BrowserService.
func NewBrowserService(pool *ldap.Pool) *BrowserService {
	return &BrowserService{
		pool: pool,
	}
}

// SetContext sets the Wails application context.
func (s *BrowserService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// GetRootEntries returns the top-level entries for a connected profile.
// It performs a base-scope search on the BaseDN to get the root node,
// then retrieves its children.
func (s *BrowserService) GetRootEntries(profileID string) ([]models.TreeNode, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}

	// Get the root entry itself as a tree node
	entry, err := client.GetEntry(client.Profile().BaseDN)
	if err != nil {
		return nil, err
	}

	// Build the root node
	objectClasses := getObjectClasses(entry)
	rootNode := models.TreeNode{
		DN:          entry.DN,
		RDN:         entry.DN,
		HasChildren: true,
		ObjectClass: objectClasses,
		Icon:        "globe",
	}

	// Get children of root
	children, err := client.GetChildren(entry.DN)
	if err != nil {
		// Return root without children on error
		return []models.TreeNode{rootNode}, nil
	}

	rootNode.Children = children
	return []models.TreeNode{rootNode}, nil
}

// GetChildren returns the child entries under the given parent DN.
func (s *BrowserService) GetChildren(profileID string, parentDN string) ([]models.TreeNode, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.GetChildren(parentDN)
}

// GetEntry retrieves a single LDAP entry with all its attributes.
func (s *BrowserService) GetEntry(profileID string, dn string) (*models.LDAPEntry, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.GetEntry(dn)
}

// getObjectClasses extracts objectClass values from an LDAPEntry.
func getObjectClasses(entry *models.LDAPEntry) []string {
	for _, attr := range entry.Attributes {
		if attr.Name == "objectClass" {
			return attr.Values
		}
	}
	return nil
}
