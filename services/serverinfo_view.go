package services

import (
	"github.com/dpicillo/LDAPilot/internal/models"
)

// GetRootDSEAll returns the complete RootDSE of the connected server (every
// user and operational attribute, plus the capability attributes by name)
// for the Server Info view: supported controls, extensions, features, SASL
// mechanisms, LDAP versions, vendor and current time on AD, OpenLDAP and
// 389DS alike. It is read fresh on every call (Refresh).
func (s *BrowserService) GetRootDSEAll(profileID string) (*models.LDAPEntry, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.GetRootDSEAll()
}
