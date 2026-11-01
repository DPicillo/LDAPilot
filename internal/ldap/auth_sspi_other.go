//go:build !windows

package ldap

import (
	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// SSPIAvailable reports whether Kerberos with the credentials of the
// logged-on Windows user (KrbCredSystem) is available.
const SSPIAvailable = false

// newSystemGSSAPIClient returns a GSSAPI client using the Kerberos
// credential cache of the current user (kinit).
func newSystemGSSAPIClient(_ *goldap.Conn, profile models.ConnectionProfile) (goldap.GSSAPIClient, func(), string, error) {
	client, who, err := newCCacheGSSAPIClient(profile)
	if err != nil {
		return nil, nil, who, err
	}
	return client, func() { _ = client.Close() }, who, nil
}
