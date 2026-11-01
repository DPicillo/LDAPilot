package ldap

import (
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// Keeping OpenLDAP accounts disabled across password changes.
//
// The account panel disables an OpenLDAP account with the permanent ppolicy
// lock (pwdAccountLockedTime 000001010000Z). The ppolicy overlay deletes
// pwdAccountLockedTime on every change of the password attribute (admin
// reset, Password Modify, userPassword edit, bulk or LDIF modify), which
// would silently turn the disabled account back into a working login.
// Every write path that may change a password therefore wraps the change in
// a PermanentLockGuard:
//
//	guard := client.GuardPermanentLock(dn, changes) // before the change
//	err := client.ModifyEntry(dn, changes)
//	if err == nil { relock := guard.Restore() }   // after it succeeded

// lockGuardPasswordAttrs are the password attributes whose change makes the
// ppolicy overlay clear pwdAccountLockedTime (pwdAttribute is userPassword;
// authPassword is included for servers configured with it).
var lockGuardPasswordAttrs = []string{"userPassword", "authPassword", OIDUserPassword, OIDAuthPassword}

// ChangesClearPermanentLock reports whether changes modify a password
// attribute without touching pwdAccountLockedTime themselves, i.e. whether
// the ppolicy overlay would clear an existing permanent lock as a side
// effect. Changes that set or remove pwdAccountLockedTime explicitly (enable,
// unlock) are the caller's intent and are not guarded.
func ChangesClearPermanentLock(changes []models.AttributeChange) bool {
	password := false
	for _, ch := range changes {
		name := ch.Attribute
		if i := strings.IndexByte(name, ';'); i >= 0 {
			name = name[:i]
		}
		if strings.EqualFold(name, "pwdAccountLockedTime") {
			return false
		}
		for _, a := range lockGuardPasswordAttrs {
			if strings.EqualFold(name, a) {
				password = true
			}
		}
	}
	return password
}

// PermanentLockGuard remembers whether an entry was disabled with the
// permanent ppolicy lock before a password change. The zero value (and nil)
// guards nothing.
type PermanentLockGuard struct {
	c        *Client
	dn       string
	disabled bool
}

// PermanentLockRestore is the re-lock a guard sent after the change.
type PermanentLockRestore struct {
	// Changes is the modify that set the lock again.
	Changes []models.AttributeChange
	// Err is the failure of that modify: the change is applied, but the
	// account is enabled now.
	Err error
}

// GuardPermanentLock prepares changes of dn: on OpenLDAP, when changes clear
// a permanent lock (ChangesClearPermanentLock), it reads whether dn is
// disabled with it. Otherwise (other servers, changes without a password,
// unreadable entry) the guard does nothing.
func (c *Client) GuardPermanentLock(dn string, changes []models.AttributeChange) *PermanentLockGuard {
	if !ChangesClearPermanentLock(changes) {
		return &PermanentLockGuard{}
	}
	return c.GuardPasswordChange(dn)
}

// GuardPasswordChange is GuardPermanentLock for a password change that is
// not a modify request (Password Modify extended operation) or whose
// changes the caller checked itself.
func (c *Client) GuardPasswordChange(dn string) *PermanentLockGuard {
	g := &PermanentLockGuard{c: c, dn: dn}
	info, err := c.ServerInfo()
	if err != nil || info.ServerType != models.ServerTypeOpenLDAP {
		return g
	}
	locked, err := c.readPPolicyLockedTime(dn)
	g.disabled = err == nil && locked == ppolicyPermanentLock
	return g
}

// Disabled reports whether the entry carried the permanent lock before the
// change.
func (g *PermanentLockGuard) Disabled() bool {
	return g != nil && g.disabled
}

// Restore sets the permanent lock again after a successful change when the
// entry was disabled before and the lock is gone now (also when it cannot
// be read back). It returns nil when nothing had to be written.
func (g *PermanentLockGuard) Restore() *PermanentLockRestore {
	if !g.Disabled() {
		return nil
	}
	if locked, err := g.c.readPPolicyLockedTime(g.dn); err == nil && locked == ppolicyPermanentLock {
		return nil
	}
	changes := []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: "pwdAccountLockedTime", Values: []string{ppolicyPermanentLock}}}
	return &PermanentLockRestore{Changes: changes, Err: g.c.ModifyEntry(g.dn, changes)}
}

// readPPolicyLockedTime reads pwdAccountLockedTime (operational) of dn; ""
// when it is not set.
func (c *Client) readPPolicyLockedTime(dn string) (string, error) {
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases,
		1, 0, false, "(objectClass=*)", []string{"pwdAccountLockedTime"}, nil)
	entries, err := c.SearchWithControls(req, 0)
	if err != nil {
		return "", err
	}
	if len(entries) == 0 {
		return "", ErrNotFound
	}
	return entries[0].GetEqualFoldAttributeValue("pwdAccountLockedTime"), nil
}
