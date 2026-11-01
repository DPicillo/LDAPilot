package ldap

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// Limits of one membership resolution.
const (
	// MembershipMaxItems is the maximum number of items of one resolution;
	// larger results are truncated (MembershipResult.Truncated).
	MembershipMaxItems = 10000
	// MembershipMaxDepth is the maximum nesting depth that is followed.
	MembershipMaxDepth = 32

	membershipTimeout = 2 * time.Minute
	// membershipBatchSize is the number of assertions per OR filter when
	// looking up DNs by RDN, uids or RIDs.
	membershipBatchSize = 100
	// membershipFrontierBatch is the number of groups per OR filter when
	// searching for the parents of groups.
	membershipFrontierBatch = 50
	// membershipMaxLookups limits the base-object reads of objects the
	// batched searches did not find (outside the search base, dangling).
	membershipMaxLookups = 200
)

// Attributes read during a resolution.
var (
	memberOfRootAttrs = []string{"objectClass", "cn", "memberOf", "primaryGroupID", "objectSid", "gidNumber", "uid"}
	membersRootAttrs  = []string{"objectClass", "cn", "member", "uniqueMember", "memberUid", "objectSid", "gidNumber"}
	memberTypeAttrs   = []string{"objectClass", "cn", "objectSid", "gidNumber", "uid"}
	memberExpandAttrs = []string{"objectClass", "cn", "objectSid", "gidNumber", "uid", "member", "uniqueMember", "memberUid"}
	groupParentAttrs  = []string{"objectClass", "cn", "gidNumber", "member", "uniqueMember"}
)

// membershipRun is the state of one membership resolution.
type membershipRun struct {
	c            *Client
	ctx          context.Context
	isAD         bool
	base         string // subtree searches start here
	pageSize     int
	maxDepth     int
	queries      int
	lookups      int
	truncated    bool
	depthLimited bool
	searchDenied bool // a search was refused (no access to the base)
	warnings     []string
	g            *memGraph
	root         *memNode
	// ncs are the naming contexts of the server the run reads from; objects
	// outside them are held by other servers (see outsideNamingContexts).
	ncs []string
	// remote is the connection to a referral server while the run resolves
	// an entry held there (see resolveRemote); nil for the client's own.
	remote *goldap.Conn
}

// ResolveMemberOf returns the groups the entry dn belongs to. With effective
// it includes the groups inherited through nested groups (with depth and
// path) and the groups containing the primary group; otherwise only the
// direct groups and the primary group.
//
// On AD the effective groups come from one LDAP_MATCHING_RULE_IN_CHAIN
// search below the domain naming context; the primary group is resolved from
// primaryGroupID and the entry's objectSid. On other servers the groups are
// found with (member=…)/(uniqueMember=…)/(memberUid=…) searches level by
// level; the POSIX primary group is the group with the entry's gidNumber.
func (c *Client) ResolveMemberOf(dn string, effective bool) (*models.MembershipResult, error) {
	return c.ResolveMemberOfContext(context.Background(), dn, effective)
}

// ResolveMemberOfContext is ResolveMemberOf that stops with
// ErrSearchCancelled when ctx is done.
func (c *Client) ResolveMemberOfContext(ctx context.Context, dn string, effective bool) (*models.MembershipResult, error) {
	return c.resolveMembership(ctx, dn, models.MembershipDirectionMemberOf, effective)
}

// ResolveMembers returns the members of the group dn. With effective it
// includes the members of nested groups (with depth and path); otherwise only
// the direct members. Accounts whose primary group is the group (AD
// primaryGroupID, POSIX gidNumber) are included as direct members marked
// primary.
func (c *Client) ResolveMembers(dn string, effective bool) (*models.MembershipResult, error) {
	return c.ResolveMembersContext(context.Background(), dn, effective)
}

// ResolveMembersContext is ResolveMembers that stops with ErrSearchCancelled
// when ctx is done.
func (c *Client) ResolveMembersContext(ctx context.Context, dn string, effective bool) (*models.MembershipResult, error) {
	return c.resolveMembership(ctx, dn, models.MembershipDirectionMembers, effective)
}

func (c *Client) resolveMembership(parent context.Context, dn, direction string, effective bool) (*models.MembershipResult, error) {
	start := time.Now()
	if strings.TrimSpace(dn) == "" {
		return nil, errors.New("DN must not be empty")
	}
	ctx, cancel := context.WithTimeout(parent, membershipTimeout)
	defer cancel()
	ctx, done := c.trackSearch(ctx)
	defer done()

	info, err := c.ServerInfo()
	if err != nil {
		if errors.Is(err, ErrNotConnected) {
			return nil, err
		}
		// RootDSE not readable: treat the server as generic LDAP.
		info = &models.ServerInfo{ServerType: models.ServerTypeOther}
	}
	r := &membershipRun{
		c:        c,
		ctx:      ctx,
		isAD:     info.ServerType == models.ServerTypeAD,
		base:     membershipSearchBase(info, c.Profile().BaseDN, dn),
		pageSize: c.pageSize(),
		maxDepth: MembershipMaxDepth,
		ncs:      info.NamingContexts,
	}
	res := &models.MembershipResult{DN: dn, Direction: direction, Effective: effective}

	rootAttrs := memberOfRootAttrs
	if direction == models.MembershipDirectionMembers {
		rootAttrs = membersRootAttrs
	}
	rootEntry, refs, err := r.fetchEntry(dn, rootAttrs)
	switch {
	case err != nil:
	case refs != nil:
		err = r.resolveRemote(dn, refs, rootAttrs, res)
	case rootEntry == nil:
		err = fmt.Errorf("%w: %s", ErrNotFound, dn)
	default:
		err = r.resolve(rootEntry, res)
	}
	if err != nil {
		if ctx.Err() != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				err = fmt.Errorf("membership resolution of %s timed out after %s", dn, membershipTimeout)
			} else {
				err = ErrSearchCancelled
			}
		}
		outcome, logErr := membershipLogOutcome(err)
		c.logger.Log("MEMBERSHIP", fmt.Sprintf("dn=%s %s effective=%t -> %s%d queries", dn, direction, effective, outcome, r.queries), time.Since(start), logErr)
		return nil, err
	}

	res.Queries = r.queries
	res.DurationMs = time.Since(start).Milliseconds()
	c.logger.Log("MEMBERSHIP", fmt.Sprintf("dn=%s %s effective=%t method=%s -> %d items, %d queries",
		res.DN, direction, effective, res.Method, len(res.Items), r.queries), time.Since(start), nil)
	return res, nil
}

// membershipMaxContactChecks caps the login-attribute reads of classifyContacts.
const membershipMaxContactChecks = 200

// classifyContacts turns LDAP persons without a login into contacts, as the
// tree, the Contents list and the editor do (M-06: an OpenLDAP "Contact (no
// login)" was counted among a group's users): a person-like member without
// an account class and without uid gets one types-only base read of the
// login attribute names (no values); none = contact. Failed reads keep the
// user type. AD contacts have their own class and need none of this.
func (r *membershipRun) classifyContacts() {
	checked := 0
	for _, k := range r.g.order {
		n := r.g.nodes[k]
		if n == r.root || !n.personLike || n.hasLogin || n.dn == "" || n.external || n.objectType != models.MemberTypeUser {
			continue
		}
		if checked >= membershipMaxContactChecks || r.ctx.Err() != nil {
			return
		}
		checked++
		r.queries++
		req := goldap.NewSearchRequest(n.dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases, 1, 10, true, "(objectClass=*)", treeLoginAttrs, nil)
		var names []string
		err := r.exec(func(conn *goldap.Conn) error {
			names = nil
			res, err := conn.Search(req)
			if err != nil {
				return err
			}
			for _, e := range res.Entries {
				for _, a := range e.Attributes {
					names = append(names, a.Name)
				}
			}
			return nil
		})
		if err == nil && len(names) == 0 {
			n.objectType = models.MemberTypeContact
		}
	}
}

// membershipLogOutcome returns the operation log text and error of a failed
// resolution. A resolution stopped by the caller (CancelMembership: the
// membership view switched entry, view or mode, or was closed) is not a
// failure: it is logged as "cancelled" without error, so the operation log's
// error filter only shows real failures.
func membershipLogOutcome(err error) (outcome string, logErr error) {
	if errors.Is(err, ErrSearchCancelled) {
		return "cancelled after ", nil
	}
	return "", err
}

// resolve fills res for the root entry.
func (r *membershipRun) resolve(rootEntry *goldap.Entry, res *models.MembershipResult) error {
	res.DN = rootEntry.DN
	classes := attrValues(rootEntry, "objectClass")
	res.IsGroup = isGroupClass(classes)
	members := res.Direction == models.MembershipDirectionMembers
	if members {
		res.MemberAttribute = groupMemberAttribute(classes)
	}

	run := func(ad bool) error {
		r.g = newMemGraph(MembershipMaxItems)
		r.root = r.g.node(rootEntry.DN)
		r.root.applyEntry(rootEntry)
		switch {
		case ad && members:
			return r.adMembers(rootEntry, res.Effective)
		case ad:
			return r.adMemberOf(rootEntry, res.Effective)
		case members:
			return r.searchMembers(rootEntry, res.Effective)
		default:
			return r.searchMemberOf(rootEntry, res.Effective)
		}
	}

	ad := r.isAD
	err := run(ad)
	if err != nil && ad && r.ctx.Err() == nil && !errors.Is(err, ErrNotConnected) {
		// In-chain searches are not supported everywhere (e.g. AD LDS
		// configurations, proxies); fall back to nested searches.
		r.warnings = append(r.warnings, fmt.Sprintf("AD in-chain search failed (%s); nested groups were resolved with individual searches instead", ldapErrorDetail(err)))
		r.truncated, r.depthLimited, r.lookups, r.searchDenied = false, false, 0, false
		ad = false
		err = run(false)
	}
	if err != nil {
		return err
	}
	if !ad {
		r.classifyContacts()
	}

	switch {
	case ad && res.Effective:
		res.Method = "ad-chain"
	case ad:
		res.Method = "ad-direct"
	case res.Effective:
		res.Method = "search"
	default:
		res.Method = "search-direct"
	}

	// Reported nodes in direct mode are groups the server lists in memberOf
	// that no search explains (see searchMemberOf); they are kept with
	// unknown path (depth 0) in both modes.
	lay := layoutMembership(r.g, r.root, r.maxDepth, true)
	res.Items = lay.items
	if !res.Effective {
		direct := res.Items[:0]
		for _, it := range res.Items {
			if it.Direct || it.Depth == 0 {
				direct = append(direct, it)
			}
		}
		res.Items = direct
	}
	if res.Items == nil {
		res.Items = []models.MembershipItem{}
	}
	res.Cycles = lay.cycles
	if res.Cycles == nil {
		res.Cycles = []models.MembershipCycle{}
	}
	if lay.depthLimited || r.depthLimited {
		r.truncated = true
		r.warnings = append(r.warnings, fmt.Sprintf("Nesting deeper than %d levels was not followed", r.maxDepth))
	}
	if r.g.full {
		r.truncated = true
		r.warnings = append(r.warnings, fmt.Sprintf("Only the first %d objects were resolved", MembershipMaxItems))
	} else if r.truncated && !lay.depthLimited && !r.depthLimited {
		r.warnings = append(r.warnings, "The server's size limit was reached; the list is incomplete")
	}
	if r.lookups >= membershipMaxLookups {
		r.warnings = append(r.warnings, fmt.Sprintf("Object types were looked up for the first %d objects outside the search base only", membershipMaxLookups))
	}
	res.Truncated = r.truncated
	res.Warnings = r.warnings
	if res.Warnings == nil {
		res.Warnings = []string{}
	}
	summarizeItems(res)
	return nil
}

// --- LDAP access ---

// exec runs op on the connection of the run: the client's connection
// (reconnecting as needed), or the referral server's while resolving there.
func (r *membershipRun) exec(op func(conn *goldap.Conn) error) error {
	if r.remote != nil {
		return op(r.remote)
	}
	return r.c.run(r.ctx, false, op)
}

// pagedSearch runs a paged search on conn (see exec).
func (r *membershipRun) pagedSearch(conn *goldap.Conn, req *goldap.SearchRequest) ([]*goldap.Entry, error) {
	if r.remote != nil {
		// The referral connection belongs to this run alone, so paged
		// searches on it cannot conflict.
		entries, _, err := searchPages(r.ctx, conn, req, r.pageSize)
		return entries, err
	}
	return r.c.pagedSearch(r.ctx, conn, req, r.pageSize)
}

// fetch reads one entry with attrs (ranged attributes completed). It returns
// nil without error if the entry does not exist or is not on this server.
func (r *membershipRun) fetch(dn string, attrs []string) (*goldap.Entry, error) {
	entry, _, err := r.fetchEntry(dn, attrs)
	return entry, err
}

// fetchEntry is fetch that also reports a referral: refs is non-nil
// (possibly empty) when the server refers the entry to another server.
func (r *membershipRun) fetchEntry(dn string, attrs []string) (entry *goldap.Entry, refs []string, err error) {
	if r.ctx.Err() != nil {
		return nil, nil, ErrSearchCancelled
	}
	r.queries++
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases,
		0, 0, false, "(objectClass=*)", attrs, nil)
	err = r.exec(func(conn *goldap.Conn) error {
		entry = nil
		entries, _, err := searchPage(r.ctx, conn, req)
		if err != nil {
			return err
		}
		if len(entries) == 0 {
			return nil
		}
		entry = entries[0]
		return resolveRangedAttributes(conn, entry.DN, entry)
	})
	switch {
	case r.ctx.Err() != nil:
		return nil, nil, ErrSearchCancelled
	case err == nil:
		return entry, nil, nil
	case errors.Is(err, ErrNotConnected):
		return nil, nil, err
	case goldap.IsErrorWithCode(err, goldap.LDAPResultReferral):
		refs = extractReferralURLs(err)
		if refs == nil {
			refs = []string{}
		}
		return nil, refs, nil
	case goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject),
		goldap.IsErrorWithCode(err, goldap.LDAPResultInvalidDNSyntax):
		return nil, nil, nil
	}
	return nil, nil, searchError(err)
}

// resolveRemote resolves the membership of dn, which this server refers to
// another one with refs (e.g. an entry of another domain of an AD forest,
// which the tree and the editor reach through referral following). The
// whole resolution runs on a connection to the referral server, below the
// naming context that holds the entry there.
func (r *membershipRun) resolveRemote(dn string, refs []string, rootAttrs []string, res *models.MembershipResult) error {
	if r.c.referralsDisabled() {
		return fmt.Errorf("%w: %s is held by another server (referral), and referral following is disabled for this connection", ErrSearchFailed, dn)
	}
	if len(refs) == 0 {
		return fmt.Errorf("%w: %s (referral with no URL)", ErrSearchFailed, dn)
	}
	host := refs[0]
	if t, err := parseReferralURL(refs[0]); err == nil {
		host = t.host
	}
	return r.c.withReferralConn(r.ctx, refs[0], dn, func(conn *goldap.Conn, targetDN string) error {
		r.remote = conn
		defer func() { r.remote = nil }()

		if info := r.remoteServerInfo(); info != nil {
			r.ncs = info.NamingContexts
			r.base = membershipSearchBase(info, "", targetDN)
			if info.ServerType != models.ServerTypeOther {
				r.isAD = info.ServerType == models.ServerTypeAD
			}
		} else {
			r.ncs, r.base = nil, targetDN
		}
		root, more, err := r.fetchEntry(targetDN, rootAttrs)
		switch {
		case err != nil:
			return err
		case more != nil:
			return fmt.Errorf("%w: %s (the referral server %s refers it on again)", ErrSearchFailed, dn, host)
		case root == nil:
			return fmt.Errorf("%w: %s (on %s)", ErrNotFound, dn, host)
		}
		r.warnings = append(r.warnings, fmt.Sprintf("The entry is held by another server; it was resolved on %s (referral) below %s. Groups and members held by other servers are not included.", host, r.base))
		return r.resolve(root, res)
	})
}

// remoteServerInfo reads the RootDSE of the referral server, or returns nil.
func (r *membershipRun) remoteServerInfo() *models.ServerInfo {
	r.queries++
	req := goldap.NewSearchRequest("", goldap.ScopeBaseObject, goldap.NeverDerefAliases,
		0, 0, false, "(objectClass=*)", rootDSECapabilityAttrs, nil)
	entries, _, err := searchPage(r.ctx, r.remote, req)
	if err != nil || len(entries) == 0 {
		return nil
	}
	return serverInfoFromRootDSE(entries[0])
}

// search runs a paged subtree search below r.base. Hitting sizeLimit (0 =
// server limit) marks the run truncated and returns the entries received.
func (r *membershipRun) search(filter string, attrs []string, sizeLimit int) ([]*goldap.Entry, error) {
	if r.ctx.Err() != nil {
		return nil, ErrSearchCancelled
	}
	r.queries++
	req := goldap.NewSearchRequest(r.base, goldap.ScopeWholeSubtree, goldap.NeverDerefAliases,
		sizeLimit, 0, false, filter, attrs, nil)
	var entries []*goldap.Entry
	err := r.exec(func(conn *goldap.Conn) error {
		var err error
		entries, err = r.pagedSearch(conn, req)
		if err == nil || goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
			for _, e := range entries {
				if rerr := resolveRangedAttributes(conn, e.DN, e); rerr != nil {
					return rerr
				}
			}
		}
		return err
	})
	switch {
	case r.ctx.Err() != nil:
		return nil, ErrSearchCancelled
	case err == nil:
		return entries, nil
	case goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded):
		r.truncated = true
		return entries, nil
	case goldap.IsErrorWithCode(err, goldap.LDAPResultReferral):
		return entries, nil
	case goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject),
		goldap.IsErrorWithCode(err, goldap.LDAPResultInsufficientAccessRights):
		// The bound user may not see the search base, e.g. with an ACL that
		// grants access to its own entry only: nothing found, but what the
		// entry's own attributes (memberOf, member) show is still listed.
		if !r.searchDenied {
			r.searchDenied = true
			r.warnings = append(r.warnings, fmt.Sprintf("Searches below %s are not possible for the bound user (no access, or the base does not exist); only what the entry's own attributes show is listed", r.base))
		}
		return entries, nil
	case errors.Is(err, ErrNotConnected), errors.Is(err, ErrSearchCancelled):
		return nil, err
	}
	return nil, searchError(err)
}

// remaining returns the size limit for a search that may add nodes: one
// more than still fits, so that hitting it is noticed. 0 means the graph is
// full.
func (r *membershipRun) remaining() int {
	n := MembershipMaxItems + 1 - len(r.g.nodes)
	if n <= 0 {
		r.g.full = true
		return 0
	}
	return n + 1
}

// --- Active Directory ---

// adMemberOf resolves the groups of root with AD's in-chain matching rule.
func (r *membershipRun) adMemberOf(root *goldap.Entry, effective bool) error {
	g := r.g
	for _, v := range attrValues(root, "memberOf") {
		n := g.node(v)
		if n == nil {
			break
		}
		n.objectType, n.isGroup = models.MemberTypeGroup, true
		g.addEdge(r.root, n, "")
	}

	primary, err := r.adPrimaryGroup(root)
	if err != nil {
		return err
	}
	if primary != nil {
		if p := g.node(primary.DN); p != nil {
			p.applyEntry(primary)
			g.addEdge(r.root, p, models.PrimaryGroupAD)
		}
	}
	if !effective {
		return nil
	}

	attrs := []string{"objectClass", "cn", "memberOf"}
	entries, err := r.search(chainFilter("member", root.DN), attrs, MembershipMaxItems+1)
	if err != nil {
		return err
	}
	if primary != nil {
		// The in-chain rule does not follow primary group membership.
		more, err := r.search(chainFilter("member", primary.DN), attrs, MembershipMaxItems+1)
		if err != nil {
			return err
		}
		entries = append(append(entries, primary), more...)
	}
	r.addReported(entries)
	for _, e := range entries {
		from := g.lookup(e.DN)
		for _, v := range attrValues(e, "memberOf") {
			g.addEdge(from, g.lookup(v), "")
		}
	}
	return nil
}

// adMembers resolves the members of the group root: direct members from
// (memberOf=root), effective ones with the in-chain rule, plus the accounts
// whose primaryGroupID points to root (or, effective, to a nested group).
func (r *membershipRun) adMembers(root *goldap.Entry, effective bool) error {
	g := r.g
	for _, v := range attrValues(root, "member") {
		n := g.node(v)
		if n == nil {
			break
		}
		g.addEdge(r.root, n, "")
	}

	// Direct members need only their types; effective ones also their
	// memberOf values (the nesting edges) and SIDs (nested primary groups).
	filter := "(memberOf=" + goldap.EscapeFilter(root.DN) + ")"
	attrs := []string{"objectClass", "cn"}
	if effective {
		filter = chainFilter("memberOf", root.DN)
		attrs = []string{"objectClass", "cn", "memberOf", "objectSid"}
	}
	entries, err := r.search(filter, attrs, MembershipMaxItems+1)
	if err != nil {
		return err
	}
	if effective {
		r.addReported(entries)
		for _, e := range entries {
			child := g.lookup(e.DN)
			for _, v := range attrValues(e, "memberOf") {
				g.addEdge(g.lookup(v), child, "")
			}
		}
	} else {
		for _, e := range entries {
			n := g.node(e.DN)
			if n == nil {
				break
			}
			n.applyEntry(e)
			g.addEdge(r.root, n, "")
		}
	}

	groups := []*memNode{r.root}
	if effective {
		for _, k := range g.order {
			if n := g.nodes[k]; n != r.root && n.isGroup {
				groups = append(groups, n)
			}
		}
	}
	if err := r.adPrimaryMembers(groups); err != nil {
		return err
	}
	return r.resolveUntyped(false)
}

// addReported adds the entries a server search reported as belonging to the
// result (except the root) and records their types.
func (r *membershipRun) addReported(entries []*goldap.Entry) {
	for _, e := range entries {
		n := r.g.node(e.DN)
		if n == nil {
			return
		}
		n.applyEntry(e)
		if n != r.root {
			n.reported = true
		}
	}
}

// adPrimaryGroup returns the primary group of root (primaryGroupID resolved
// against the domain SID of root's objectSid), or nil.
func (r *membershipRun) adPrimaryGroup(root *goldap.Entry) (*goldap.Entry, error) {
	v := attrValue(root, "primaryGroupID")
	if v == "" {
		return nil, nil
	}
	rid, ok := parseRID(v)
	sid, sidOK := sidWithRID(attrBytes(root, "objectSid"), rid)
	if !ok || !sidOK {
		r.warnings = append(r.warnings, fmt.Sprintf("Primary group %s could not be resolved (no valid objectSid)", v))
		return nil, nil
	}
	entries, err := r.search("(objectSid="+escapeBinaryFilter(sid)+")", []string{"objectClass", "cn", "memberOf", "objectSid"}, 2)
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		r.warnings = append(r.warnings, fmt.Sprintf("Primary group with RID %d not found below %s", rid, r.base))
		return nil, nil
	}
	return entries[0], nil
}

// adPrimaryMembers adds the accounts whose primaryGroupID is the RID of one
// of groups (groups of the root's domain only) as primary members.
func (r *membershipRun) adPrimaryMembers(groups []*memNode) error {
	// primaryGroupID is a RID of the account domain. The root may be a
	// builtin group (S-1-5-32-…), so take the domain from the naming
	// context head, falling back to the root's SID.
	domainSID := r.root.sid
	if head, err := r.fetch(r.base, []string{"objectSid"}); err != nil {
		return err
	} else if head != nil {
		if sid := attrBytes(head, "objectSid"); len(sid) > 0 {
			// The domain head carries the domain SID itself.
			domainSID = sidAppendRID(sid, 0)
		}
	}
	byRID := map[uint32]*memNode{}
	var rids []uint32
	for _, n := range groups {
		rid, ok := sidRID(n.sid)
		if !ok || !sameDomain(n.sid, domainSID) {
			continue
		}
		if _, dup := byRID[rid]; !dup {
			byRID[rid] = n
			rids = append(rids, rid)
		}
	}
	sort.Slice(rids, func(i, j int) bool { return rids[i] < rids[j] })
	for _, batch := range chunks(rids, membershipBatchSize) {
		limit := r.remaining()
		if limit == 0 {
			return nil
		}
		parts := make([]string, len(batch))
		for i, rid := range batch {
			parts[i] = fmt.Sprintf("(primaryGroupID=%d)", rid)
		}
		entries, err := r.search(orFilter(parts), []string{"objectClass", "cn", "primaryGroupID", "objectSid"}, limit)
		if err != nil {
			return err
		}
		for _, e := range entries {
			rid, _ := parseRID(attrValue(e, "primaryGroupID"))
			parent := byRID[rid]
			n := r.g.node(e.DN)
			if parent == nil || n == nil {
				continue
			}
			n.applyEntry(e)
			r.g.addEdge(parent, n, models.PrimaryGroupAD)
		}
	}
	return nil
}

// --- Other servers: searches level by level ---

// searchMemberOf resolves the groups of root with (member=…) searches,
// following parents level by level when effective.
func (r *membershipRun) searchMemberOf(root *goldap.Entry, effective bool) error {
	g := r.g
	attrs := []string{"objectClass", "cn", "gidNumber"}
	parts := []string{
		"(member=" + goldap.EscapeFilter(root.DN) + ")",
		"(uniqueMember=" + goldap.EscapeFilter(root.DN) + ")",
	}
	if uid := attrValue(root, "uid"); uid != "" {
		parts = append(parts, "(memberUid="+goldap.EscapeFilter(uid)+")")
	}
	entries, err := r.search(orFilter(parts), attrs, MembershipMaxItems+1)
	if err != nil {
		return err
	}
	var frontier []*memNode
	add := func(e *goldap.Entry, primary string) {
		n, created := g.nodeNew(e.DN)
		if n == nil {
			return
		}
		n.applyEntry(e)
		g.addEdge(r.root, n, primary)
		if created {
			frontier = append(frontier, n)
		}
	}
	for _, e := range entries {
		add(e, "")
	}

	// POSIX primary group.
	if gid := attrValue(root, "gidNumber"); gid != "" && !r.root.isGroup {
		filter := "(&(gidNumber=" + goldap.EscapeFilter(gid) + ")(|(objectClass=posixGroup)(objectClass=group)))"
		pe, err := r.search(filter, attrs, 10)
		if err != nil {
			return err
		}
		if len(pe) == 0 {
			r.warnings = append(r.warnings, fmt.Sprintf("No group with gidNumber %s (the POSIX primary group) was found below %s", gid, r.base))
		}
		for _, e := range pe {
			add(e, models.PrimaryGroupPOSIX)
		}
	}

	if effective {
		if err := r.expandParents(frontier); err != nil {
			return err
		}
	}

	// Groups the server lists in memberOf (memberOf overlay/plugin) that the
	// searches did not find, e.g. because the bound user may read its own
	// memberOf but not search member, or the group lies outside the search
	// base: listed with unknown path (depth 0), in direct mode as well.
	var reported []*memNode
	for _, v := range attrValues(root, "memberOf") {
		if g.lookup(v) != nil {
			continue
		}
		n := g.node(v)
		if n == nil {
			break
		}
		n.objectType, n.isGroup, n.reported = models.MemberTypeGroup, true, true
		reported = append(reported, n)
	}
	if !effective && len(reported) > 0 {
		return r.hideNestedReported()
	}
	return nil
}

// hideNestedReported unmarks the reported groups that are inherited through
// nesting, so that direct mode does not list them. 389DS lists nested groups
// in memberOf too; in effective mode they are found by expandParents, in
// direct mode they would remain reported. A reported group that contains one
// of the entry's groups (direct or reported) is nested: memberOf lists all
// ancestors, so every nesting chain consists of these groups. Reported groups
// that contain none of them (hidden from searches, outside the search base)
// stay listed. If the check fails, all stay listed.
func (r *membershipRun) hideNestedReported() error {
	var known []*memNode
	for _, k := range r.g.order {
		if n := r.g.nodes[k]; n != r.root && n.dn != "" && n.isGroup {
			known = append(known, n)
		}
	}
	var nested []*memNode
	for _, batch := range chunks(known, membershipFrontierBatch) {
		parts := make([]string, 0, 2*len(batch))
		for _, n := range batch {
			esc := goldap.EscapeFilter(n.dn)
			parts = append(parts, "(member="+esc+")", "(uniqueMember="+esc+")")
		}
		entries, err := r.search(orFilter(parts), []string{"1.1"}, 0)
		if err != nil {
			if errors.Is(err, ErrSearchCancelled) || errors.Is(err, ErrNotConnected) {
				return err
			}
			return nil
		}
		for _, e := range entries {
			if n := r.g.lookup(e.DN); n != nil && n.reported {
				nested = append(nested, n)
			}
		}
	}
	for _, n := range nested {
		n.reported = false
	}
	return nil
}

// expandParents follows the parents of the groups in frontier level by level.
func (r *membershipRun) expandParents(frontier []*memNode) error {
	g := r.g
	for depth := 2; len(frontier) > 0; depth++ {
		if depth > r.maxDepth {
			r.depthLimited = true
			return nil
		}
		var next []*memNode
		for _, batch := range chunks(frontier, membershipFrontierBatch) {
			byKey := map[string]*memNode{}
			parts := make([]string, 0, 2*len(batch))
			for _, n := range batch {
				byKey[n.key] = n
				esc := goldap.EscapeFilter(n.dn)
				parts = append(parts, "(member="+esc+")", "(uniqueMember="+esc+")")
			}
			entries, err := r.search(orFilter(parts), groupParentAttrs, 0)
			if err != nil {
				return err
			}
			for _, e := range entries {
				p, created := g.nodeNew(e.DN)
				if p == nil {
					return nil
				}
				p.applyEntry(e)
				for _, v := range append(attrValues(e, "member"), attrValues(e, "uniqueMember")...) {
					if child := byKey[normDN(stripOptionalUID(v))]; child != nil {
						g.addEdge(child, p, "")
					}
				}
				if created {
					next = append(next, p)
				}
			}
		}
		frontier = next
	}
	return nil
}

// searchMembers resolves the members of the group root from its member,
// uniqueMember and memberUid values, following nested groups level by level
// when effective. Object types come from batched searches by RDN.
func (r *membershipRun) searchMembers(root *goldap.Entry, effective bool) error {
	level := []*goldap.Entry{root}
	expanded := map[string]bool{r.root.key: true}
	for depth := 1; len(level) > 0; depth++ {
		var created []*memNode
		for _, e := range level {
			nodes, err := r.addMemberValues(r.g.lookup(e.DN), e)
			if err != nil {
				return err
			}
			created = append(created, nodes...)
		}

		expand := effective && depth < r.maxDepth
		attrs := memberTypeAttrs
		if expand {
			attrs = memberExpandAttrs
		}
		var untyped []*memNode
		for _, n := range created {
			if n.objectType == "" {
				untyped = append(untyped, n)
			}
		}
		found, err := r.resolveNodes(untyped, attrs, true)
		if err != nil {
			return err
		}
		if !effective || r.g.full {
			return nil
		}

		level = nil
		for _, n := range created {
			if !n.isGroup || expanded[n.key] {
				continue
			}
			if !expand {
				r.depthLimited = true
				break
			}
			expanded[n.key] = true
			e := found[n.key]
			if e == nil {
				// Typed by a uid/primary search without member values.
				if e, err = r.fetch(n.dn, memberExpandAttrs); err != nil {
					return err
				}
			}
			if e != nil {
				level = append(level, e)
			}
		}
	}
	return nil
}

// addMemberValues adds the members of group e (node from) to the graph and
// returns the nodes created: DN values of member/uniqueMember, memberUid
// values resolved to accounts, and accounts with the group's gidNumber
// (POSIX primary group).
func (r *membershipRun) addMemberValues(from *memNode, e *goldap.Entry) ([]*memNode, error) {
	g := r.g
	var created []*memNode
	add := func(n *memNode, isNew bool, primary string) {
		if n == nil {
			return
		}
		g.addEdge(from, n, primary)
		if isNew {
			created = append(created, n)
		}
	}
	for _, v := range append(attrValues(e, "member"), attrValues(e, "uniqueMember")...) {
		v = stripOptionalUID(strings.TrimSpace(v))
		if v == "" {
			continue
		}
		n, isNew := g.nodeNew(v)
		if n == nil {
			return created, nil
		}
		add(n, isNew, "")
	}

	if uids := attrValues(e, "memberUid"); len(uids) > 0 {
		accounts, err := r.resolveUIDs(uids)
		if err != nil {
			return created, err
		}
		for _, uid := range uids {
			if acc := accounts[strings.ToLower(uid)]; acc != nil {
				n, isNew := g.nodeNew(acc.DN)
				if n != nil {
					n.applyEntry(acc)
				}
				add(n, isNew, "")
			} else {
				_, exists := g.nodes["\x00uid:"+strings.ToLower(uid)]
				add(g.uidNode(uid), !exists, "")
			}
		}
	}

	if from.gid != "" && from.isGroup && hasObjectClass(e, "posixGroup") {
		limit := r.remaining()
		if limit == 0 {
			return created, nil
		}
		filter := "(&(objectClass=posixAccount)(gidNumber=" + goldap.EscapeFilter(from.gid) + "))"
		entries, err := r.search(filter, memberTypeAttrs, limit)
		if err != nil {
			return created, err
		}
		for _, acc := range entries {
			n, isNew := g.nodeNew(acc.DN)
			if n != nil {
				n.applyEntry(acc)
			}
			add(n, isNew, models.PrimaryGroupPOSIX)
		}
	}
	return created, nil
}

// resolveUIDs looks up the accounts of memberUid values; the result maps
// lowercase uid to entry, preferring posixAccount entries.
func (r *membershipRun) resolveUIDs(uids []string) (map[string]*goldap.Entry, error) {
	out := map[string]*goldap.Entry{}
	seen := map[string]bool{}
	var parts []string
	for _, uid := range uids {
		k := strings.ToLower(uid)
		if !seen[k] {
			seen[k] = true
			parts = append(parts, "(uid="+goldap.EscapeFilter(uid)+")")
		}
	}
	for _, batch := range chunks(parts, membershipBatchSize) {
		entries, err := r.search(orFilter(batch), memberTypeAttrs, 0)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			for _, uid := range attrValues(e, "uid") {
				k := strings.ToLower(uid)
				if !seen[k] {
					continue
				}
				if prev := out[k]; prev == nil || (!hasObjectClass(prev, "posixAccount") && hasObjectClass(e, "posixAccount")) {
					out[k] = e
				}
			}
		}
	}
	return out, nil
}

// resolveNodes reads attrs of nodes, with batched searches by RDN when
// batched (one search per membershipBatchSize nodes) and base-object reads
// for the rest, and records their types. Nodes that do not exist are marked
// unresolved. It returns the entries found by node key.
func (r *membershipRun) resolveNodes(nodes []*memNode, attrs []string, batched bool) (map[string]*goldap.Entry, error) {
	found := map[string]*goldap.Entry{}
	if len(nodes) == 0 {
		return found, nil
	}
	if batched {
		want := map[string]bool{}
		seen := map[string]bool{}
		var parts []string
		for _, n := range nodes {
			want[n.key] = true
			if f, ok := rdnFilter(n.dn); ok && !seen[f] {
				seen[f] = true
				parts = append(parts, f)
			}
		}
		for _, batch := range chunks(parts, membershipBatchSize) {
			entries, err := r.search(orFilter(batch), attrs, 0)
			if err != nil {
				if errors.Is(err, ErrSearchCancelled) || errors.Is(err, ErrNotConnected) {
					return nil, err
				}
				// e.g. an RDN attribute the server cannot search: use lookups.
				continue
			}
			for _, e := range entries {
				if k := normDN(e.DN); want[k] {
					found[k] = e
				}
			}
		}
	}
	for _, n := range nodes {
		if found[n.key] != nil || n.dn == "" {
			continue
		}
		if r.lookups >= membershipMaxLookups {
			if outsideNamingContexts(n.dn, r.ncs) {
				n.external, n.objectType = true, models.MemberTypeUnknown
			}
			continue
		}
		r.lookups++
		e, refs, err := r.fetchEntry(n.dn, attrs)
		if err != nil {
			if errors.Is(err, ErrSearchCancelled) || errors.Is(err, ErrNotConnected) {
				return nil, err
			}
			continue
		}
		if e == nil {
			// Held by another server (e.g. another domain of the forest):
			// not resolved here, but not missing either.
			if refs != nil || outsideNamingContexts(n.dn, r.ncs) {
				n.external = true
			} else {
				n.unresolved = true
			}
			n.objectType = models.MemberTypeUnknown
			continue
		}
		found[n.key] = e
	}
	for k, e := range found {
		r.g.nodes[k].applyEntry(e)
	}
	return found, nil
}

// resolveUntyped looks up the type of all nodes whose type is still unknown.
func (r *membershipRun) resolveUntyped(batched bool) error {
	var nodes []*memNode
	for _, k := range r.g.order {
		if n := r.g.nodes[k]; n != r.root && n.objectType == "" && n.dn != "" {
			nodes = append(nodes, n)
		}
	}
	_, err := r.resolveNodes(nodes, memberTypeAttrs, batched)
	return err
}

// nodeNew is node that also reports whether the node was created.
func (g *memGraph) nodeNew(dn string) (*memNode, bool) {
	_, exists := g.nodes[normDN(dn)]
	return g.node(dn), !exists
}

// hasObjectClass reports whether e has objectClass oc.
func hasObjectClass(e *goldap.Entry, oc string) bool {
	for _, v := range attrValues(e, "objectClass") {
		if strings.EqualFold(v, oc) {
			return true
		}
	}
	return false
}

// outsideNamingContexts reports whether dn lies outside all of the naming
// contexts ncs a server announces (false when it announces none).
func outsideNamingContexts(dn string, ncs []string) bool {
	known := false
	for _, nc := range ncs {
		if nc == "" {
			continue
		}
		known = true
		if dnUnder(dn, nc) {
			return false
		}
	}
	return known
}

// membershipSearchBase returns the base of the subtree searches of a
// resolution: the naming context that contains the profile's base DN (or,
// without base DN, the entry), else the base DN, the default naming context
// or the first naming context.
func membershipSearchBase(info *models.ServerInfo, baseDN, entryDN string) string {
	ref := baseDN
	if ref == "" {
		ref = entryDN
	}
	best := ""
	for _, nc := range info.NamingContexts {
		if nc != "" && dnUnder(ref, nc) && len(normDN(nc)) > len(normDN(best)) {
			best = nc
		}
	}
	switch {
	case best != "":
		return best
	case baseDN != "":
		return baseDN
	case info.DefaultNamingContext != "":
		return info.DefaultNamingContext
	case len(info.NamingContexts) > 0:
		return info.NamingContexts[0]
	}
	return ""
}
