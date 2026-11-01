package ldap

import (
	"fmt"

	goldap "github.com/go-ldap/ldap/v3"
)

// EntryExists reports whether an entry with the DN exists, using a base
// search that returns no attributes. A noSuchObject result means false; any
// other failure (including a referral) is returned as error. It does not
// write to the operation log, so dry runs over many entries stay quiet.
func (c *Client) EntryExists(dn string) (bool, error) {
	req := goldap.NewSearchRequest(
		dn,
		goldap.ScopeBaseObject,
		goldap.NeverDerefAliases,
		1, 0, false,
		"(objectClass=*)",
		[]string{"1.1"},
		nil,
	)
	var found bool
	err := c.read(func(conn *goldap.Conn) error {
		found = false
		res, err := conn.Search(req)
		if err != nil {
			if goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject) {
				return nil
			}
			return err
		}
		found = len(res.Entries) > 0
		return nil
	})
	if err != nil {
		if goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
			return false, fmt.Errorf("%w: %s is on another server (referral)", ErrSearchFailed, dn)
		}
		return false, searchError(err)
	}
	return found, nil
}

// ChildDNs returns the DNs of up to limit direct children of dn (one-level
// search without attributes). truncated is true when the server has more
// children than were returned. An entry that does not exist has no
// children (no error). Continuation references (AD) are ignored.
// Like EntryExists it does not write to the operation log.
func (c *Client) ChildDNs(dn string, limit int) (dns []string, truncated bool, err error) {
	if limit < 1 {
		limit = 1
	}
	req := goldap.NewSearchRequest(
		dn,
		goldap.ScopeSingleLevel,
		goldap.NeverDerefAliases,
		limit, 0, false,
		"(objectClass=*)",
		[]string{"1.1"},
		nil,
	)
	err = c.read(func(conn *goldap.Conn) error {
		dns, truncated = nil, false
		res, err := conn.Search(req)
		if goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject) {
			return nil
		}
		if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
			return err
		}
		if err != nil {
			truncated = true
		}
		if res != nil {
			for _, e := range res.Entries {
				dns = append(dns, e.DN)
			}
		}
		if len(dns) > limit {
			dns, truncated = dns[:limit], true
		}
		return nil
	})
	if err != nil {
		if goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
			return nil, false, fmt.Errorf("%w: %s is on another server (referral)", ErrSearchFailed, dn)
		}
		return nil, false, searchError(err)
	}
	return dns, truncated, nil
}

// AttributesPresent reports which of the attributes the entry has, with one
// base-scope, types-only read (attribute names come back, no values: a photo
// is not transferred). It does not write to the operation log: the menus
// probe it in the background (Download Photo / Certificate are offered only
// for entries that have such a value), which is not an operation of the user.
func (c *Client) AttributesPresent(dn string, attributes []string) ([]string, error) {
	if len(attributes) == 0 {
		return nil, nil
	}
	req := goldap.NewSearchRequest(
		dn,
		goldap.ScopeBaseObject,
		goldap.NeverDerefAliases,
		1, 10, true,
		"(objectClass=*)",
		attributes,
		nil,
	)
	var present []string
	err := c.read(func(conn *goldap.Conn) error {
		present = nil
		res, err := conn.Search(req)
		if err != nil {
			return err
		}
		for _, e := range res.Entries {
			for _, a := range e.Attributes {
				present = append(present, a.Name)
			}
		}
		return nil
	})
	if err != nil {
		return nil, searchError(err)
	}
	return present, nil
}

// DNsWithValue returns the DNs of up to limit entries below base that have
// attr=value (subtree search without attributes, equality match, the value
// escaped). Continuation references are ignored. Like EntryExists it does
// not write to the operation log: the LDIF dry run checks values that AD
// keeps unique (sAMAccountName) with it, once per add record.
func (c *Client) DNsWithValue(base, attr, value string, limit int) ([]string, error) {
	if limit < 1 {
		limit = 1
	}
	req := goldap.NewSearchRequest(
		base,
		goldap.ScopeWholeSubtree,
		goldap.NeverDerefAliases,
		limit, 0, false,
		fmt.Sprintf("(%s=%s)", attr, goldap.EscapeFilter(value)),
		[]string{"1.1"},
		nil,
	)
	var dns []string
	err := c.read(func(conn *goldap.Conn) error {
		dns = nil
		res, err := conn.Search(req)
		if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) && !goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject) {
			return err
		}
		if res != nil {
			for _, e := range res.Entries {
				dns = append(dns, e.DN)
			}
		}
		return nil
	})
	if err != nil {
		return nil, searchError(err)
	}
	return dns, nil
}
