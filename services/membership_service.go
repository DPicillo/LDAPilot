package services

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// --- BrowserService: reading group membership ---

// ResolveMemberOf returns the groups the entry dn belongs to: the direct
// groups and the primary group (AD primaryGroupID, POSIX gidNumber), with
// effective also the groups inherited through nested groups, each with its
// nesting depth and path. Circular nestings are reported in Cycles.
// requestID (may be empty) identifies the call for CancelMembership.
func (s *BrowserService) ResolveMemberOf(profileID string, dn string, effective bool, requestID string) (*models.MembershipResult, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	ctx, done := membershipCalls.track(profileID, requestID)
	defer done()
	return client.ResolveMemberOfContext(ctx, dn, effective)
}

// ResolveGroupMembers returns the members of the group groupDN: the direct
// members (including accounts whose primary group it is), with effective
// also the members of nested groups, each with its nesting depth and path.
// requestID (may be empty) identifies the call for CancelMembership.
func (s *BrowserService) ResolveGroupMembers(profileID string, groupDN string, effective bool, requestID string) (*models.MembershipResult, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	ctx, done := membershipCalls.track(profileID, requestID)
	defer done()
	return client.ResolveMembersContext(ctx, groupDN, effective)
}

// CancelMembership stops the running ResolveMemberOf / ResolveGroupMembers
// call of profileID that was given requestID, or all of the profile's
// running membership resolutions when requestID is empty. The stopped calls
// fail with ldap.ErrSearchCancelled ("search cancelled"). A call that has
// not arrived yet (calls are dispatched concurrently) is cancelled when it
// starts. Returns the number of calls stopped.
func (s *BrowserService) CancelMembership(profileID string, requestID string) int {
	return membershipCalls.cancel(profileID, requestID)
}

// membershipCalls tracks the running membership resolutions. It is package
// level so that BrowserService (shared with the tree) needs no new field;
// the app has a single BrowserService.
var membershipCalls = newCallRegistry()

// earlyCancelTTL is how long a cancel for a call that has not started yet is
// remembered.
const earlyCancelTTL = time.Minute

// callRegistry holds the cancel funcs of running calls per profile, keyed by
// an internal sequence number, with the caller's request ID.
type callRegistry struct {
	mu      sync.Mutex
	seq     uint64
	running map[string]map[uint64]trackedCall
	// early holds cancels (profile + "\x00" + request ID) that arrived
	// before their call.
	early map[string]time.Time
	now   func() time.Time
}

type trackedCall struct {
	requestID string
	cancel    context.CancelFunc
}

func newCallRegistry() *callRegistry {
	return &callRegistry{
		running: map[string]map[uint64]trackedCall{},
		early:   map[string]time.Time{},
		now:     time.Now,
	}
}

// track registers a cancellable context for a call of profileID. The
// returned func must be called when the call has finished.
func (r *callRegistry) track(profileID, requestID string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(context.Background())
	r.mu.Lock()
	key := profileID + "\x00" + requestID
	if at, ok := r.early[key]; ok && requestID != "" {
		delete(r.early, key)
		if r.now().Sub(at) < earlyCancelTTL {
			cancel()
		}
	}
	r.seq++
	id := r.seq
	if r.running[profileID] == nil {
		r.running[profileID] = map[uint64]trackedCall{}
	}
	r.running[profileID][id] = trackedCall{requestID: requestID, cancel: cancel}
	r.mu.Unlock()

	return ctx, func() {
		r.mu.Lock()
		delete(r.running[profileID], id)
		if len(r.running[profileID]) == 0 {
			delete(r.running, profileID)
		}
		r.mu.Unlock()
		cancel()
	}
}

// cancel cancels the calls of profileID with requestID (all of the
// profile's calls for ""). A cancel for a request ID that is not running is
// remembered for a while, see track.
func (r *callRegistry) cancel(profileID, requestID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, call := range r.running[profileID] {
		if requestID == "" || call.requestID == requestID {
			call.cancel()
			n++
		}
	}
	now := r.now()
	for k, at := range r.early {
		if now.Sub(at) >= earlyCancelTTL {
			delete(r.early, k)
		}
	}
	if n == 0 && requestID != "" {
		r.early[profileID+"\x00"+requestID] = now
	}
	return n
}

// --- EditorService: changing group membership ---

// AddGroupMembers adds each of memberDNs to the group groupDN with its own
// single-value modify request (add member/uniqueMember/memberUid), so the
// existing member list is never rewritten. Members that already belong to
// the group are reported as unchanged. Every request is audited. For a
// posixGroup a value without "=" is added to memberUid as is (with a warning
// in the result when no account has that uid); adding a DN to an RFC 2307bis
// group that keeps memberUid values adds the member's uid there as well.
func (s *EditorService) AddGroupMembers(profileID string, groupDN string, memberDNs []string) (*models.MembershipChangeResult, error) {
	return s.changeMembership(profileID, models.ChangeAdd, []string{groupDN}, memberDNs, false)
}

// RemoveGroupMembers removes each of memberDNs from the group groupDN with
// its own single-value modify request (delete of that value only). For a
// posixGroup, a value without "=" is taken as memberUid as is, and removing
// a DN from an RFC 2307bis group also removes the member's memberUid.
// Removing a uniqueMember DN also removes its values with an optional UID
// ("dn#'0101'B").
func (s *EditorService) RemoveGroupMembers(profileID string, groupDN string, memberDNs []string) (*models.MembershipChangeResult, error) {
	return s.changeMembership(profileID, models.ChangeDelete, []string{groupDN}, memberDNs, false)
}

// AddToGroups adds the entry dn to each of groupDNs (one single-value modify
// request per group). The result lists the group DNs.
func (s *EditorService) AddToGroups(profileID string, dn string, groupDNs []string) (*models.MembershipChangeResult, error) {
	return s.changeMembership(profileID, models.ChangeAdd, groupDNs, []string{dn}, true)
}

// RemoveFromGroups removes the entry dn from each of groupDNs (one
// single-value modify request per group). The result lists the group DNs.
func (s *EditorService) RemoveFromGroups(profileID string, dn string, groupDNs []string) (*models.MembershipChangeResult, error) {
	return s.changeMembership(profileID, models.ChangeDelete, groupDNs, []string{dn}, true)
}

// changeMembership adds (removes) every member to (from) every group, one
// value per modify request. byGroup selects whether the result lists the
// group DNs (one member, several groups) or the member DNs.
func (s *EditorService) changeMembership(profileID, op string, groupDNs, memberDNs []string, byGroup bool) (*models.MembershipChangeResult, error) {
	groupDNs = uniqueNonEmpty(groupDNs)
	memberDNs = uniqueNonEmpty(memberDNs)
	if len(groupDNs) == 0 {
		return nil, fmt.Errorf("no group given")
	}
	if len(memberDNs) == 0 {
		return nil, fmt.Errorf("no member given")
	}
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return nil, err
	}

	res := &models.MembershipChangeResult{
		Changed:   []string{},
		Unchanged: []string{},
		Failed:    []models.MembershipChangeFailure{},
		Warnings:  []string{},
	}
	for _, groupDN := range groupDNs {
		gm, err := client.GroupMembership(groupDN)
		if err != nil {
			if !byGroup {
				return nil, err
			}
			res.Failed = append(res.Failed, models.MembershipChangeFailure{DN: groupDN, Error: err.Error()})
			continue
		}
		for _, member := range memberDNs {
			key := member
			if byGroup {
				key = groupDN
			}
			changed, warning, err := s.changeOneMembership(client, profileID, gm, op, groupDN, member)
			switch {
			case err != nil:
				res.Failed = append(res.Failed, models.MembershipChangeFailure{DN: key, Error: err.Error()})
			case changed:
				res.Changed = append(res.Changed, key)
			default:
				res.Unchanged = append(res.Unchanged, key)
			}
			if warning != "" {
				res.Warnings = append(res.Warnings, warning)
			}
		}
	}
	return res, nil
}

// changeOneMembership adds/removes one member to/from one group with
// single-value modify requests and audits each of them. It reports whether
// something changed (otherwise the membership was already as requested) and
// a warning for a change that may not be what was meant.
//
//   - Removing a uniqueMember DN also removes the stored values that carry an
//     optional UID ("dn#'0101'B"), which the plain DN does not match.
//   - RFC 2307bis groups (posixGroup with member/uniqueMember) may list
//     members by uid as well: removing a DN also removes the member's
//     memberUid, so it does not stay a member by uid; adding a DN adds its
//     memberUid when the group keeps memberUid values, so that clients that
//     read memberUid see the new member too.
//   - Adding a plain uid (memberUid) for which no account exists is done,
//     but reported as a warning.
func (s *EditorService) changeOneMembership(client *ldap.Client, profileID string, gm *ldap.GroupMembership, op, groupDN, member string) (changed bool, warning string, err error) {
	change, err := client.MembershipChange(gm, op, member)
	if err != nil {
		return false, "", err
	}
	apply := func(ch models.AttributeChange) (bool, error) {
		err := client.ModifyEntry(groupDN, []models.AttributeChange{ch})
		if ldap.IsMembershipNoop(op, err) {
			return false, nil
		}
		s.audit(profileID, "MODIFY", groupDN, describeChangesForAudit([]models.AttributeChange{ch}), err)
		if err != nil {
			if hint := ldap.MembershipErrorHint(op, ch.Attribute, err); hint != "" {
				err = fmt.Errorf("%w (%s)", err, hint)
			}
			return false, err
		}
		return true, nil
	}
	changed, err = apply(change)
	if err != nil {
		return false, "", err
	}
	isUID := strings.EqualFold(change.Attribute, "memberUid")

	if !changed && op == models.ChangeDelete && strings.EqualFold(change.Attribute, "uniqueMember") {
		if values, verr := client.MatchingMemberValues(groupDN, change.Attribute, member); verr == nil {
			for _, v := range values {
				ok, err := apply(models.AttributeChange{Operation: op, Attribute: change.Attribute, Values: []string{v}})
				if err != nil {
					return changed, "", err
				}
				changed = changed || ok
			}
		}
	}

	switch {
	case isUID && op == models.ChangeAdd && changed && !strings.Contains(member, "="):
		if dn, base, ferr := client.FindUIDAccount(member); ferr == nil && dn == "" {
			warning = fmt.Sprintf("memberUid %q was added to %s, but no account with this uid exists below %s", member, groupDN, base)
		}
	case gm.POSIX && !isUID && (op == models.ChangeDelete || gm.MemberUIDs):
		uid, uerr := client.MembershipValue("memberUid", member)
		if uerr != nil {
			// e.g. a nested group or an entry without uid
			break
		}
		ok, uerr := apply(models.AttributeChange{Operation: op, Attribute: "memberUid", Values: []string{uid}})
		if uerr != nil {
			return changed, "", fmt.Errorf("%s of memberUid %q failed: %w", op, uid, uerr)
		}
		changed = changed || ok
	}
	return changed, warning, nil
}

// uniqueNonEmpty returns the trimmed, non-empty values without
// case-insensitive duplicates, in their original order.
func uniqueNonEmpty(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, v := range values {
		v = strings.TrimSpace(v)
		k := strings.ToLower(v)
		if v == "" || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, v)
	}
	return out
}
