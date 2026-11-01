//go:build windows

package ldap

import (
	"fmt"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
	"github.com/go-ldap/ldap/v3/gssapi"
)

// SSPIAvailable reports whether Kerberos with the credentials of the
// logged-on Windows user (KrbCredSystem) is available.
const SSPIAvailable = true

// newSystemGSSAPIClient returns a GSSAPI client for the logged-on Windows
// user (SSPI). On a TLS connection it adds channel binding to the server
// certificate (RFC 5929 tls-server-end-point), as required by domain
// controllers enforcing LDAP channel binding.
func newSystemGSSAPIClient(conn *goldap.Conn, _ models.ConnectionProfile) (goldap.GSSAPIClient, func(), string, error) {
	var (
		client *gssapi.SSPIClient
		err    error
	)
	who := "the logged-on Windows user (SSPI)"
	if state, ok := conn.TLSConnectionState(); ok && len(state.PeerCertificates) > 0 {
		client, err = gssapi.NewSSPIClientWithChannelBinding(state.PeerCertificates[0])
		who += " with channel binding"
	} else {
		client, err = gssapi.NewSSPIClient()
	}
	if err != nil {
		return nil, nil, who, fmt.Errorf("Windows integrated authentication (SSPI) failed: %v", err)
	}
	return client, func() { _ = client.Close() }, who, nil
}
