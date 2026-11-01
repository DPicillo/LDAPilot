package ldap

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// OIDs relevant for password changes.
const (
	// OIDPasswordModify is the Password Modify extended operation (RFC 3062).
	OIDPasswordModify = "1.3.6.1.4.1.4203.1.11.1"
	// OIDPasswordPolicyControl is the password policy control of
	// draft-behera-ldap-password-policy (OpenLDAP ppolicy, 389DS).
	OIDPasswordPolicyControl = goldap.ControlTypeBeheraPasswordPolicy
)

// ErrPasswordNeedsTLS is returned when a password write can only succeed
// over an encrypted connection and is therefore refused before anything is
// sent: Active Directory (and AD LDS) reject unicodePwd without LDAPS or
// StartTLS, so confirming an unencrypted send would only put the password
// on the wire for nothing.
var ErrPasswordNeedsTLS = errors.New("the password can only be set over an encrypted connection (LDAPS or StartTLS)")

// PasswordModify sets the password of dn with the Password Modify extended
// operation (RFC 3062) as an administrative reset (no old password). The
// server hashes it according to its own policy. The password is never
// logged.
func (c *Client) PasswordModify(dn, newPassword string) error {
	if newPassword == "" {
		return errors.New("password modify failed: the new password must not be empty")
	}
	start := time.Now()
	req := goldap.NewPasswordModifyRequest(dn, "", newPassword)
	err := c.write(func(conn *goldap.Conn) error {
		_, err := conn.PasswordModify(req)
		return err
	})
	if errors.Is(err, ErrNotConnected) || errors.Is(err, ErrReadOnly) {
		return err
	}
	c.logger.Log("PASSWD_MODIFY", fmt.Sprintf("dn=%s (RFC 3062 extended operation)", dn), time.Since(start), err)
	return writeError("password modify", err)
}

// BindCheck is the outcome of CheckBind.
type BindCheck struct {
	// MustChange: the server accepted the password but requires a change
	// (OpenLDAP ppolicy changeAfterReset, AD data 773/532).
	MustChange bool
	// Detail describes server responses worth showing ("password accepted,
	// account disabled (AD data 533)").
	Detail string
}

// adBindCode describes an AD bind error sub-code ("data NNN" in the
// diagnostic message) that AD only returns after it has checked the
// password successfully; a wrong password gives data 52e instead.
type adBindCode struct {
	why        string
	mustChange bool
}

var adBindAcceptedCodes = map[string]adBindCode{
	"773": {"user must change the password at next logon", true},
	"532": {"password expired", true},
	"533": {"account disabled", false},
	"701": {"account expired", false},
	"530": {"logon not permitted at this time (logon hours)", false},
	"531": {"logon not permitted from this workstation", false},
}

// acceptedADBindError reports whether err is an AD invalidCredentials error
// whose sub-code proves that the password itself was correct (the account
// is disabled, expired, restricted or must change the password), and
// returns the matching BindCheck.
func acceptedADBindError(err error) (*BindCheck, bool) {
	if err == nil || !goldap.IsErrorWithCode(err, goldap.LDAPResultInvalidCredentials) {
		return nil, false
	}
	code := adDataCode(err.Error())
	c, ok := adBindAcceptedCodes[code]
	if !ok {
		return nil, false
	}
	return &BindCheck{
		MustChange: c.mustChange,
		Detail:     fmt.Sprintf("password accepted, %s (AD data %s)", c.why, code),
	}, true
}

// CheckBind proves that dn can authenticate with password: it opens a new
// connection with the profile's host, port and TLS settings, performs a
// simple bind with the password policy control, and closes it. The client's
// own connection is not touched. A bind that AD rejects only for reasons it
// checks after the password (must change, expired, disabled, logon hours,
// workstation) counts as success with Detail set. The password is never
// logged; on an unencrypted profile it crosses the network in cleartext.
func (c *Client) CheckBind(dn, password string) (*BindCheck, error) {
	start := time.Now()
	p := bindCheckProfile(c.Profile())
	conn, err := dialServer(p, p.Host, strconv.Itoa(p.Port), p.TLSMode)
	if err != nil {
		err = fmt.Errorf("%w: %s", ErrConnectionFailed, dialErrorDetail(err, p))
		c.logger.Log("BIND_CHECK", fmt.Sprintf("dn=%s", dn), time.Since(start), err)
		return nil, err
	}
	defer conn.Close()

	res, err := conn.SimpleBind(&goldap.SimpleBindRequest{
		Username: dn,
		Password: password,
		Controls: []goldap.Control{goldap.NewControlBeheraPasswordPolicy()},
	})
	check := &BindCheck{}
	if err != nil {
		if accepted, ok := acceptedADBindError(err); ok {
			c.logger.Log("BIND_CHECK", fmt.Sprintf("dn=%s -> %s", dn, accepted.Detail), time.Since(start), nil)
			return accepted, nil
		}
		err = &opError{msg: "bind with the new password failed: " + ldapErrorDetail(err), cause: err}
		c.logger.Log("BIND_CHECK", fmt.Sprintf("dn=%s", dn), time.Since(start), err)
		return nil, err
	}
	if res != nil {
		if ctrl, ok := goldap.FindControl(res.Controls, goldap.ControlTypeBeheraPasswordPolicy).(*goldap.ControlBeheraPasswordPolicy); ok && ctrl != nil {
			if ctrl.Error == 2 { // changeAfterReset
				check.MustChange = true
				check.Detail = "password accepted, must be changed after reset (ppolicy changeAfterReset)"
			} else if ctrl.Error >= 0 && ctrl.ErrorString != "" {
				check.Detail = "password policy: " + ctrl.ErrorString
			}
		}
	}
	details := fmt.Sprintf("dn=%s -> ok", dn)
	if check.Detail != "" {
		details += " (" + check.Detail + ")"
	}
	c.logger.Log("BIND_CHECK", details, time.Since(start), nil)
	return check, nil
}

// bindCheckProfile is profile without its own credentials, for CheckBind's
// connection: server, port, timeout and TLS settings (trust, pinning, client
// certificate) stay, the bind method becomes anonymous. An NTLM profile
// would otherwise authenticate as the profile's user while dialing
// (dialServerNTLM, Samba) and leave the connection in preBound, which only
// bindConnHost consumes; a failure of that bind would also be reported as
// a failure of the new password.
func bindCheckProfile(profile models.ConnectionProfile) models.ConnectionProfile {
	profile.AuthMethod = models.AuthNone
	profile.BindDN, profile.Password, profile.NTLMDomain = "", "", ""
	profile.KrbCredSource, profile.KrbCCache = "", ""
	return profile
}

// adDataCode extracts NNN from an AD diagnostic message such as
// "80090308: LdapErr: DSID-0C09041C, comment: AcceptSecurityContext error,
// data 773, v4563"; "" when there is none.
func adDataCode(msg string) string {
	i := strings.Index(msg, "data ")
	if i < 0 {
		return ""
	}
	rest := msg[i+len("data "):]
	end := 0
	for end < len(rest) && ((rest[end] >= '0' && rest[end] <= '9') || (rest[end] >= 'a' && rest[end] <= 'f')) {
		end++
	}
	return rest[:end]
}
