package ldap

import (
	"errors"
	"fmt"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// ErrNotAGroup is returned by GroupMembership for an entry that is not a
// group.
var ErrNotAGroup = errors.New("entry is not a group")

// readAttrs reads attrs of the entry dn (base-object search). It returns
// ErrNotFound if the entry does not exist.
func (c *Client) readAttrs(dn string, attrs []string) (*goldap.Entry, error) {
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases,
		0, 0, false, "(objectClass=*)", attrs, nil)
	var entry *goldap.Entry
	err := c.read(func(conn *goldap.Conn) error {
		entry = nil
		res, err := conn.Search(req)
		if err != nil {
			return err
		}
		if len(res.Entries) > 0 {
			entry = res.Entries[0]
		}
		return nil
	})
	if err != nil {
		if goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject) {
			return nil, fmt.Errorf("%w: %s", ErrNotFound, dn)
		}
		return nil, searchError(err)
	}
	if entry == nil {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, dn)
	}
	return entry, nil
}

// GroupMembership describes how a group stores its members.
type GroupMembership struct {
	// Attribute holds member DNs (or uids): "member" (AD group,
	// groupOfNames), "uniqueMember" (groupOfUniqueNames) or "memberUid"
	// (posixGroup without DN members).
	Attribute string
	// POSIX is true for posixGroup groups, which may (also) list members by
	// uid in memberUid (RFC 2307bis groups have both).
	POSIX bool
	// MemberUIDs is true for an RFC 2307bis group (POSIX, Attribute member
	// or uniqueMember) that currently has memberUid values, i.e. keeps its
	// members in both attributes: adding a member DN then adds its uid too.
	MemberUIDs bool
}

// GroupMembership reads the object classes of groupDN and returns how it
// stores its members. It fails with ErrNotAGroup for other entries.
func (c *Client) GroupMembership(groupDN string) (*GroupMembership, error) {
	entry, err := c.readAttrs(groupDN, []string{"objectClass"})
	if err != nil {
		return nil, err
	}
	classes := attrValues(entry, "objectClass")
	if !isGroupClass(classes) {
		return nil, fmt.Errorf("%w: %s", ErrNotAGroup, groupDN)
	}
	gm := &GroupMembership{Attribute: groupMemberAttribute(classes)}
	for _, oc := range classes {
		gm.POSIX = gm.POSIX || strings.EqualFold(oc, "posixGroup")
	}
	if gm.POSIX && !strings.EqualFold(gm.Attribute, "memberUid") {
		// Without memberUid values the group is member-only; it stays so.
		gm.MemberUIDs, _ = c.hasValues(groupDN, "memberUid")
	}
	return gm, nil
}

// hasValues reports whether the entry dn has a value of attr (base-object
// search with a presence filter, no values transferred).
func (c *Client) hasValues(dn, attr string) (bool, error) {
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases,
		0, 0, false, "("+attr+"=*)", []string{"1.1"}, nil)
	found := false
	err := c.read(func(conn *goldap.Conn) error {
		res, err := conn.Search(req)
		if err != nil {
			return err
		}
		found = len(res.Entries) > 0
		return nil
	})
	if err != nil {
		return false, searchError(err)
	}
	return found, nil
}

// MatchingMemberValues returns the values of the member attribute attr of
// groupDN that stand for member although they differ from it: uniqueMember
// values with an optional UID ("dn#'0101'B", RFC 4517 NameAndOptionalUID),
// which a single-value delete of the plain DN does not match.
func (c *Client) MatchingMemberValues(groupDN, attr, member string) ([]string, error) {
	if !strings.EqualFold(attr, "uniqueMember") {
		return nil, nil
	}
	entry, err := c.readAttrs(groupDN, []string{attr})
	if err != nil {
		return nil, err
	}
	return matchingMemberValues(attrValues(entry, attr), member), nil
}

// matchingMemberValues returns the values whose DN (without the optional
// UID) equals member's and that differ from member itself.
func matchingMemberValues(values []string, member string) []string {
	want := normDN(stripOptionalUID(strings.TrimSpace(member)))
	var out []string
	for _, v := range values {
		if v != member && normDN(stripOptionalUID(strings.TrimSpace(v))) == want {
			out = append(out, v)
		}
	}
	return out
}

// FindUIDAccount returns the DN of an entry with the given uid below the
// naming context that holds the profile's base DN (the base the membership
// views search, see membershipSearchBase), or "" if there is none. base is
// the DN searched.
func (c *Client) FindUIDAccount(uid string) (dn, base string, err error) {
	info, ierr := c.ServerInfo()
	if ierr != nil {
		info = &models.ServerInfo{}
	}
	base = membershipSearchBase(info, c.Profile().BaseDN, "")
	req := goldap.NewSearchRequest(base, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
		1, 0, false, "(uid="+goldap.EscapeFilter(uid)+")", []string{"1.1"}, nil)
	err = c.read(func(conn *goldap.Conn) error {
		dn = ""
		res, err := conn.Search(req)
		if res != nil && len(res.Entries) > 0 {
			dn = res.Entries[0].DN
		}
		if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
			return err
		}
		return nil
	})
	if err != nil {
		return "", base, searchError(err)
	}
	return dn, base, nil
}

// MembershipChange returns the single-value change that adds (op "add") or
// removes (op "delete") member to/from a group stored as g. member is a DN,
// or for POSIX groups a plain uid (no "="), which always goes into
// memberUid. For memberUid the uid of a member DN is looked up.
func (c *Client) MembershipChange(g *GroupMembership, op, member string) (models.AttributeChange, error) {
	member = strings.TrimSpace(member)
	attr := g.Attribute
	switch {
	case member == "":
		return models.AttributeChange{}, errors.New("member must not be empty")
	case !strings.Contains(member, "="):
		if !g.POSIX {
			return models.AttributeChange{}, fmt.Errorf("%q is not a DN", member)
		}
		attr = "memberUid"
	}
	value, err := c.MembershipValue(attr, member)
	if err != nil {
		return models.AttributeChange{}, err
	}
	return models.AttributeChange{Operation: op, Attribute: attr, Values: []string{value}}, nil
}

// MembershipValue returns the value that stands for member in the member
// attribute attr of a group: the DN itself for member/uniqueMember, the uid
// of the entry for memberUid. For memberUid, a member without "=" is taken
// as uid as is.
func (c *Client) MembershipValue(attr, member string) (string, error) {
	member = strings.TrimSpace(member)
	if member == "" {
		return "", errors.New("member must not be empty")
	}
	if !strings.EqualFold(attr, "memberUid") {
		return member, nil
	}
	if !strings.Contains(member, "=") {
		return member, nil
	}
	entry, err := c.readAttrs(stripOptionalUID(member), []string{"uid"})
	if err != nil {
		return "", err
	}
	uid := attrValue(entry, "uid")
	if uid == "" {
		return "", fmt.Errorf("%s has no uid, it cannot be a member of a posixGroup", member)
	}
	return uid, nil
}

// IsMembershipNoop reports whether err of a single-value membership change
// means that nothing had to be changed: on add the value was already present
// (attributeOrValueExists; AD answers entryAlreadyExists, also for a member
// whose primary group it is), on delete it was not present (noSuchAttribute;
// AD and Samba answer unwillingToPerform with a specific message).
func IsMembershipNoop(operation string, err error) bool {
	if err == nil {
		return false
	}
	switch strings.ToLower(operation) {
	case models.ChangeAdd:
		return goldap.IsErrorWithCode(err, goldap.LDAPResultAttributeOrValueExists) ||
			goldap.IsErrorWithCode(err, goldap.LDAPResultEntryAlreadyExists)
	case models.ChangeDelete:
		if goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchAttribute) {
			return true
		}
		// AD: 00000561 ERROR_MEMBER_NOT_IN_GROUP (WILL_NOT_PERFORM); Samba:
		// "Attribute member already deleted for target GUID ...".
		msg := strings.ToLower(err.Error())
		return goldap.IsErrorWithCode(err, goldap.LDAPResultUnwillingToPerform) &&
			(strings.Contains(msg, "00000561") || strings.Contains(msg, "already deleted"))
	}
	return false
}

// MembershipErrorHint returns an explanation for common membership change
// errors, or "".
func MembershipErrorHint(operation, attr string, err error) string {
	switch {
	case err == nil:
		return ""
	case strings.EqualFold(operation, models.ChangeDelete) && goldap.IsErrorWithCode(err, goldap.LDAPResultObjectClassViolation):
		return fmt.Sprintf("the group's schema requires at least one %s value; add another member first", attr)
	case strings.EqualFold(operation, models.ChangeAdd) && goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject):
		return "the member does not exist"
	case strings.EqualFold(operation, models.ChangeAdd) && goldap.IsErrorWithCode(err, goldap.LDAPResultInvalidAttributeSyntax):
		return "the value is not a valid DN"
	}
	return ""
}
