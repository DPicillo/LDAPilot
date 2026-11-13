package ldap

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// Client wraps an LDAP connection with convenience methods.
//
// Operations run concurrently on the underlying go-ldap connection: mu only
// guards the connection pointer and lifecycle state and is never held during
// network I/O. A connection that died (idle timeout, network blip, server
// restart) is re-established transparently, see run.
type Client struct {
	logger *Logger

	// profMu guards profile. Its connection identity (host, port, TLS, bind
	// credentials) is fixed after NewClient; the settings applied by
	// applySettings (read-only, page size, timeout, referrals, name, base DN,
	// password storage policy) can change while connected. Read it through
	// Profile.
	profMu  sync.RWMutex
	profile models.ConnectionProfile

	mu           sync.Mutex
	conn         *goldap.Conn
	closed       bool                   // set by Close; disables auto-reconnect
	reconnecting *reconnectCall         // reconnect in progress, shared by concurrent callers
	serverInfo   *models.ServerInfo     // RootDSE capabilities of conn, see ServerInfo
	pwHashing    *serverPasswordHashing // cleartext password hashing of the server, see passwordHashing

	searchMu  sync.Mutex
	searches  map[uint64]context.CancelFunc
	searchSeq uint64

	// paging limits the concurrent paged searches, see pagedSearch.
	paging *pagingSlots
}

// NewClient creates a new Client for the given connection profile.
func NewClient(profile models.ConnectionProfile) *Client {
	return &Client{
		profile: profile,
		logger:  NewLogger(),
		paging:  newPagingSlots(maxPagedSearches),
	}
}

// Logger returns the client's operation logger.
func (c *Client) Logger() *Logger {
	return c.logger
}

// Profile returns a snapshot of the connection profile associated with this client.
func (c *Client) Profile() models.ConnectionProfile {
	c.profMu.RLock()
	defer c.profMu.RUnlock()
	return c.profile
}

// applySettings takes over the settings of profile that can change on a live
// connection: read-only flag, page size, timeout, referral following, name,
// base DN and the password storage policy. Connection identity fields (host,
// port, TLS, bind) are kept; they take effect with the next Pool.Connect.
func (c *Client) applySettings(profile models.ConnectionProfile) {
	c.profMu.Lock()
	c.profile.Name = profile.Name
	c.profile.BaseDN = profile.BaseDN
	c.profile.ReadOnly = profile.ReadOnly
	c.profile.PageSize = profile.PageSize
	c.profile.Timeout = profile.Timeout
	c.profile.DisableReferrals = profile.DisableReferrals
	c.profile.PasswordPolicy = profile.PasswordPolicy
	c.profile.PasswordScheme = profile.PasswordScheme
	timeout := profileTimeout(c.profile)
	c.profMu.Unlock()

	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn != nil {
		conn.SetTimeout(timeout)
	}
}

// pageSize returns the configured page size for paged searches.
func (c *Client) pageSize() int {
	if ps := c.Profile().PageSize; ps > 0 {
		return ps
	}
	return 500
}

// referralsDisabled reports whether referral following is turned off.
func (c *Client) referralsDisabled() bool {
	return c.Profile().DisableReferrals
}

// CheckWritable returns ErrReadOnly if the client's profile is read-only.
// Every write operation of the client checks it; code issuing its own
// modifying requests (e.g. extended operations) must call it first.
func (c *Client) CheckWritable() error {
	if c.Profile().ReadOnly {
		return ErrReadOnly
	}
	return nil
}

// Connect establishes a connection to the LDAP server, handles TLS, and performs bind.
// The profile timeout (default 10s) bounds the TCP dial, the TLS handshake and the bind.
func (c *Client) Connect() error {
	start := time.Now()
	conn, info, err := c.dialDetailed()
	if err != nil {
		return err
	}

	c.mu.Lock()
	old := c.conn
	c.conn = conn
	c.closed = false
	c.serverInfo = nil
	c.pwHashing = nil
	c.mu.Unlock()
	if old != nil {
		old.Close()
	}

	p := c.Profile()
	conn.SetTimeout(profileTimeout(p))
	c.logger.Log("CONNECT", fmt.Sprintf("Connected to %s (%s, %s)", c.address(), info.tlsDescription(p.TLSMode), info.authSummary), time.Since(start), nil)
	return nil
}

// Close cancels running searches and closes the LDAP connection.
// A closed client does not reconnect automatically.
func (c *Client) Close() {
	c.CancelSearches()

	c.mu.Lock()
	conn := c.conn
	c.conn = nil
	c.closed = true
	c.mu.Unlock()

	if conn != nil {
		conn.Close()
	}
}

// IsConnected returns true if the client has an active connection.
// A connection that dropped is still reported as connected because the next
// operation re-establishes it.
func (c *Client) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn != nil && !c.closed
}

// GetRootDSE reads the RootDSE entry and returns selected operational attributes.
// This provides AD forest information such as naming contexts.
func (c *Client) GetRootDSE() (*models.LDAPEntry, error) {
	searchReq := goldap.NewSearchRequest(
		"",
		goldap.ScopeBaseObject,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=*)",
		[]string{
			"namingContexts",
			"defaultNamingContext",
			"rootDomainNamingContext",
			"configurationNamingContext",
			"schemaNamingContext",
			"dnsHostName",
			"forestFunctionality",
			"domainFunctionality",
			"domainControllerFunctionality",
			"serverName",
		},
		nil,
	)

	var result *goldap.SearchResult
	err := c.read(func(conn *goldap.Conn) (err error) {
		result, err = conn.Search(searchReq)
		return err
	})
	if err != nil {
		return nil, searchError(err)
	}
	if len(result.Entries) == 0 {
		return nil, fmt.Errorf("%w: RootDSE", ErrNotFound)
	}

	return convertEntry(result.Entries[0]), nil
}

// GetForestPartitions queries CN=Partitions,CN=Configuration,... to discover all
// domains and partitions in the AD forest, including child domains hosted on other DCs.
// Returns a list of nCName values (the DN of each partition).
func (c *Client) GetForestPartitions(configNC string) ([]string, error) {
	partitionsDN := "CN=Partitions," + configNC

	searchReq := goldap.NewSearchRequest(
		partitionsDN,
		goldap.ScopeSingleLevel,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=crossRef)",
		[]string{"nCName", "dnsRoot", "systemFlags"},
		nil,
	)

	var result *goldap.SearchResult
	err := c.read(func(conn *goldap.Conn) (err error) {
		result, err = conn.Search(searchReq)
		return err
	})
	if err != nil {
		if errors.Is(err, ErrNotConnected) {
			return nil, err
		}
		// If referrals are disabled, still try to use partial results
		if c.referralsDisabled() && goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
			if result == nil {
				return nil, nil
			}
		} else {
			return nil, fmt.Errorf("%w: %s", ErrSearchFailed, ldapErrorDetail(err))
		}
	}

	var partitions []string
	for _, entry := range result.Entries {
		ncName := entry.GetAttributeValue("nCName")
		if ncName != "" {
			partitions = append(partitions, ncName)
		}
	}

	return partitions, nil
}

// GetChildren performs a one-level search under parentDN and returns tree nodes.
// Uses paged results to handle containers with large numbers of children.
// If the server returns a referral and referral following is enabled,
// it connects to the referred server to fetch the children.
func (c *Client) GetChildren(parentDN string) ([]models.TreeNode, error) {
	start := time.Now()
	childAttrs := treeChildAttrs()
	pageSize := c.pageSize()

	var allEntries []*goldap.Entry
	var referral string
	var referralNoURL bool

	searchReq := goldap.NewSearchRequest(
		parentDN,
		goldap.ScopeSingleLevel,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=*)",
		childAttrs,
		nil,
	)

	err := c.read(func(conn *goldap.Conn) error {
		allEntries, referral, referralNoURL = nil, "", false

		entries, err := c.pagedSearch(context.Background(), conn, searchReq, pageSize)
		if err != nil {
			if goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
				// Partial results are still useful
				allEntries = entries
				return nil
			}
			if goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
				if c.referralsDisabled() {
					allEntries = entries
					return nil
				}
				if refs := extractReferralURLs(err); len(refs) > 0 {
					referral = refs[0]
				} else {
					referralNoURL = true
				}
				return nil
			}
			return err
		}
		allEntries = entries
		return nil
	})
	if err != nil {
		c.logFailedRead("SEARCH", searchLogDetails(parentDN, goldap.ScopeSingleLevel, "(objectClass=*)", nil), start, err)
		return nil, searchError(err)
	}

	if referral != "" {
		return c.followReferralGetChildren(referral, parentDN)
	}
	if referralNoURL {
		return nil, fmt.Errorf("%w: %s (referral with no URL)", ErrSearchFailed, parentDN)
	}
	nodes := c.entriesToTreeNodes(allEntries)
	c.fillLoginAttributes(parentDN, nodes)
	return nodes, nil
}

// followReferralGetChildren follows a referral URL to fetch children from a remote server.
// parentDN is used when the referral URL names no DN.
func (c *Client) followReferralGetChildren(referralURL, parentDN string) ([]models.TreeNode, error) {
	childAttrs := treeChildAttrs()
	entries, err := c.followReferralSearch(context.Background(), referralURL, parentDN, goldap.ScopeSingleLevel, "(objectClass=*)", childAttrs, 0, nil)
	if err != nil {
		return nil, err
	}
	return c.entriesToTreeNodes(entries), nil
}

// entriesToTreeNodes converts raw LDAP entries to TreeNode slice.
func (c *Client) entriesToTreeNodes(entries []*goldap.Entry) []models.TreeNode {
	nodes := make([]models.TreeNode, 0, len(entries))
	var probe []int // nodes whose HasChildren must be probed (see probeChildren)
	now := time.Now()
	// OpenLDAP timed locks are checked against the entry's policy, only for
	// entries that have one (RW1-P-02); the evaluator is set up on first use.
	var olLock func(dn string, a accountAttrs) bool
	olLockReady := false
	for _, entry := range entries {
		objectClasses := entry.GetAttributeValues("objectClass")
		hasSubStr := entry.GetAttributeValue("hasSubordinates")
		approxChildren := entry.GetAttributeValue("msDS-Approx-Immed-Subordinates")

		hasChildren := false
		if strings.EqualFold(hasSubStr, "TRUE") {
			hasChildren = true
		} else if approxChildren != "" && approxChildren != "0" {
			hasChildren = true
		} else if hasSubStr == "" && approxChildren == "" && !isLeafObjectClass(objectClasses) {
			probe = append(probe, len(nodes))
		}

		icon := determineIcon(objectClasses)
		rdn := extractRDN(entry.DN)

		nodes = append(nodes, models.TreeNode{
			DN:          entry.DN,
			RDN:         rdn,
			HasChildren: hasChildren,
			ObjectClass: objectClasses,
			Icon:        icon,
			Status:      c.treeStatusOf(entry, objectClasses, now, &olLock, &olLockReady),
		})
	}
	c.probeChildren(nodes, probe)
	return nodes
}

// treeStatusOf derives a tree node's overlay states; an OpenLDAP entry with a
// timed pwdAccountLockedTime sets up the policy-aware lock evaluation once
// per listing (olLock / ready).
func (c *Client) treeStatusOf(entry *goldap.Entry, objectClasses []string, now time.Time, olLock *func(dn string, a accountAttrs) bool, ready *bool) []string {
	a := newAccountAttrs(entry)
	if v := strings.TrimSpace(a.first("pwdAccountLockedTime")); v != "" && v != ppolicyPermanentLock && isGenericAccount(objectClasses) {
		if !*ready {
			*ready = true
			*olLock = c.treeOpenLDAPLock()
		}
		if eval := *olLock; eval != nil {
			return treeNodeStatus(objectClasses, a, now, func(x accountAttrs) bool { return eval(entry.DN, x) })
		}
	}
	return treeNodeStatus(objectClasses, a, now)
}

// probeHasChildren checks whether a DN has any children by doing a size-limited one-level search.
func (c *Client) probeHasChildren(dn string) bool {
	searchReq := goldap.NewSearchRequest(
		dn,
		goldap.ScopeSingleLevel,
		goldap.NeverDerefAliases,
		1, 5, false,
		"(objectClass=*)",
		[]string{"dn"},
		nil,
	)

	found := false
	err := c.read(func(conn *goldap.Conn) error {
		found = false
		result, err := conn.Search(searchReq)
		if result != nil && len(result.Entries) > 0 {
			found = true
		}
		// With more than one child the size limit of 1 is exceeded, which
		// still proves that children exist.
		if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
			return err
		}
		return nil
	})
	return err == nil && found
}

// GetEntry retrieves a single entry by DN with all its attributes.
// If the server returns a referral and referral following is enabled,
// it connects to the referred server to fetch the entry.
func (c *Client) GetEntry(dn string) (*models.LDAPEntry, error) {
	start := time.Now()
	searchReq := goldap.NewSearchRequest(
		dn,
		goldap.ScopeBaseObject,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=*)",
		[]string{"*", "+"},
		nil,
	)

	var entry *goldap.Entry
	var referral string
	var referralNoURL bool

	err := c.read(func(conn *goldap.Conn) error {
		entry, referral, referralNoURL = nil, "", false

		result, err := conn.Search(searchReq)
		if err != nil {
			// Try to follow referral if not disabled
			if !c.referralsDisabled() && goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
				if refs := extractReferralURLs(err); len(refs) > 0 {
					referral = refs[0]
				} else {
					referralNoURL = true
				}
				return nil
			}
			return err
		}
		if len(result.Entries) == 0 {
			return nil
		}
		entry = result.Entries[0]
		return resolveRangedAttributes(conn, dn, entry)
	})
	if err != nil {
		c.logFailedRead("READ", "dn="+dn, start, err)
		return nil, searchError(err)
	}

	if referral != "" {
		return c.followReferralGetEntry(referral, dn)
	}
	if referralNoURL {
		err := fmt.Errorf("%w: %s (referral with no URL)", ErrSearchFailed, dn)
		c.logFailedRead("READ", "dn="+dn, start, err)
		return nil, err
	}
	if entry == nil {
		err := fmt.Errorf("%w: %s", ErrNotFound, dn)
		c.logFailedRead("READ", "dn="+dn, start, err)
		return nil, err
	}
	return convertEntry(entry), nil
}

// logFailedRead logs a failed read the user asked for (open an entry, expand
// a container) as an error in the operation log. Successful reads are not
// logged (they would replace the status bar's last operation on every
// click); a lost connection is reported by the reconnect handling instead.
func (c *Client) logFailedRead(op, details string, start time.Time, err error) {
	if err == nil || errors.Is(err, ErrNotConnected) || errors.Is(err, ErrSearchCancelled) {
		return
	}
	c.logger.Log(op, details+" -> failed", time.Since(start), err)
}

// ReadAttributes reads the named attributes of one entry (base search) and
// returns them keyed by lower-case attribute name (options such as ;binary
// or ;range=... stripped); attributes the entry lacks are missing from the
// map. It is a background read (e.g. the values an audit entry shows before
// a write): it is not logged, so it never becomes the status bar's last
// operation, and ranged values are not followed.
func (c *Client) ReadAttributes(dn string, names []string) (map[string]models.LDAPAttribute, error) {
	if len(names) == 0 {
		return map[string]models.LDAPAttribute{}, nil
	}
	req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases, 1, 0, false, "(objectClass=*)", names, nil)
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
		return nil, searchError(err)
	}
	out := make(map[string]models.LDAPAttribute)
	if entry == nil {
		return out, nil
	}
	for _, a := range convertEntry(entry).Attributes {
		out[strings.ToLower(attrBaseName(a.Name))] = a
	}
	return out, nil
}

// resolveRangedAttributes detects AD range-retrieved attributes (e.g. member;range=0-1499)
// and fetches all remaining chunks on conn, merging them into a single attribute.
// Failed chunk requests are skipped; only an error that killed the connection
// is returned so that the caller can retry on a fresh connection.
func resolveRangedAttributes(conn *goldap.Conn, dn string, entry *goldap.Entry) error {
	for i, attr := range entry.Attributes {
		baseName, _, endVal, isFinal, ok := parseRangeAttr(attr.Name)
		if !ok || isFinal {
			continue
		}

		// Collect all values starting with what we already have
		allValues := make([]string, len(attr.Values))
		copy(allValues, attr.Values)
		allByteValues := make([][]byte, len(attr.ByteValues))
		copy(allByteValues, attr.ByteValues)

		currentEnd := endVal
		done := false
		for iter := 0; iter < 1000 && !done; iter++ {
			nextStart := currentEnd + 1
			rangeAttr := fmt.Sprintf("%s;range=%d-*", baseName, nextStart)

			req := goldap.NewSearchRequest(
				dn,
				goldap.ScopeBaseObject,
				goldap.NeverDerefAliases,
				0, 0, false,
				"(objectClass=*)",
				[]string{rangeAttr},
				nil,
			)

			res, err := conn.Search(req)
			if err != nil && isConnDead(conn, err) {
				return err
			}
			if err != nil || len(res.Entries) == 0 {
				break
			}

			// Find the returned range attribute
			found := false
			for _, a := range res.Entries[0].Attributes {
				_, _, nextEnd, nextFinal, isRange := parseRangeAttr(a.Name)
				if !isRange && strings.EqualFold(a.Name, baseName) {
					// Server returned the bare attribute name — this is the final chunk
					allValues = append(allValues, a.Values...)
					allByteValues = append(allByteValues, a.ByteValues...)
					found = true
					done = true
					break
				}
				if isRange {
					allValues = append(allValues, a.Values...)
					allByteValues = append(allByteValues, a.ByteValues...)
					found = true
					if nextFinal {
						done = true
					} else {
						currentEnd = nextEnd
					}
					break
				}
			}

			if !found {
				break
			}
		}

		// Replace the ranged attribute with the merged result
		entry.Attributes[i].Name = baseName
		entry.Attributes[i].Values = allValues
		entry.Attributes[i].ByteValues = allByteValues
	}
	return nil
}

// parseRangeAttr parses "member;range=0-1499" into ("member", 0, 1499, false, true).
// For the terminal form "member;range=1500-*", isFinal is true.
// Returns ok=false if the attribute name has no range option.
func parseRangeAttr(name string) (baseName string, start int, end int, isFinal bool, ok bool) {
	idx := strings.Index(strings.ToLower(name), ";range=")
	if idx < 0 {
		return name, 0, 0, false, false
	}

	baseName = name[:idx]
	rangeSpec := name[idx+7:] // after ";range="

	parts := strings.SplitN(rangeSpec, "-", 2)
	if len(parts) != 2 {
		return baseName, 0, 0, false, false
	}

	var s int
	fmt.Sscanf(parts[0], "%d", &s)

	if parts[1] == "*" {
		return baseName, s, 0, true, true
	}

	var e int
	fmt.Sscanf(parts[1], "%d", &e)
	return baseName, s, e, false, true
}

// Search performs a full LDAP search with the given parameters.
// If the server returns a referral and referral following is enabled,
// it connects to the referred server to perform the search there.
// A running search can be stopped with CancelSearches, in which case
// ErrSearchCancelled is returned.
func (c *Client) Search(params models.SearchParams) (*models.SearchResult, error) {
	return c.SearchContext(context.Background(), params)
}

// SearchContext is Search bound to ctx: the search also stops with
// ErrSearchCancelled when ctx is done. Cancellation abandons the outstanding
// request on the client side and requests no further pages, so the server
// finishes at most the page it is working on.
func (c *Client) SearchContext(ctx context.Context, params models.SearchParams) (*models.SearchResult, error) {
	ctx, done := c.trackSearch(ctx)
	defer done()
	searchStart := time.Now()

	if params.Filter == "" {
		params.Filter = "(objectClass=*)"
	}

	attrs := params.Attributes
	if len(attrs) == 0 {
		attrs = []string{"*"}
	}

	pageSize := c.pageSize()
	controls := searchControls(params)

	var allEntries []*goldap.Entry
	var truncated bool
	var referral string

	searchReq := goldap.NewSearchRequest(
		params.BaseDN,
		int(params.Scope),
		goldap.NeverDerefAliases,
		params.SizeLimit,
		params.TimeLimit,
		false,
		params.Filter,
		attrs,
		controls,
	)

	err := c.run(ctx, false, func(conn *goldap.Conn) error {
		allEntries, truncated, referral = nil, false, ""

		entries, err := c.pagedSearch(ctx, conn, searchReq, pageSize)
		allEntries = entries
		if err != nil {
			// Check for size limit exceeded - partial results are still useful
			if goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
				truncated = true
				return nil
			}
			if goldap.IsErrorWithCode(err, goldap.LDAPResultReferral) {
				if !c.referralsDisabled() {
					if refs := extractReferralURLs(err); len(refs) > 0 {
						referral = refs[0]
					}
				}
				return nil
			}
			return err
		}
		return nil
	})

	if err == nil && referral != "" {
		// Follow referral; entries collected so far are kept
		refEntries, refErr := c.followReferralSearch(ctx, referral, params.BaseDN, int(params.Scope), params.Filter, attrs, params.SizeLimit, controls)
		if refErr == nil {
			allEntries = append(allEntries, refEntries...)
		}
	}
	// The size limit holds for the whole result (servers that ignore it in
	// paged searches are capped in searchPages; referred entries count too).
	if params.SizeLimit > 0 && len(allEntries) > params.SizeLimit {
		allEntries, truncated = allEntries[:params.SizeLimit], true
	}

	logDetails := searchLogDetails(params.BaseDN, int(params.Scope), params.Filter, controls)
	if ctx.Err() != nil {
		// Not an error: the user stopped it (the log shows "Cancelled").
		c.logger.Log("SEARCH", fmt.Sprintf("%s -> cancelled after %s", logDetails, EntriesText(len(allEntries))), time.Since(searchStart), nil)
		return nil, ErrSearchCancelled
	}
	if err != nil {
		if !errors.Is(err, ErrNotConnected) {
			c.logger.Log("SEARCH", logDetails+" -> failed", time.Since(searchStart), err)
		}
		return nil, c.searchBaseError(params.BaseDN, err)
	}

	entries := make([]models.LDAPEntry, 0, len(allEntries))
	for _, e := range allEntries {
		entries = append(entries, *convertEntry(e))
	}

	result := fmt.Sprintf("%s -> %s", logDetails, EntriesText(len(entries)))
	if truncated {
		result += " (size limit reached)"
	}
	c.logger.Log("SEARCH", result, time.Since(searchStart), nil)

	return &models.SearchResult{
		Entries:    entries,
		TotalCount: len(entries),
		Truncated:  truncated,
	}, nil
}

// searchControls returns the request controls selected in params. They are
// sent as critical, so a server that does not support one rejects the search
// (unavailableCriticalExtension) instead of silently ignoring it; check
// ServerInfo().SupportedControls before offering them.
func searchControls(params models.SearchParams) []goldap.Control {
	var controls []goldap.Control
	if params.ShowDeleted {
		controls = append(controls, goldap.NewControlString(goldap.ControlTypeMicrosoftShowDeleted, true, ""))
	}
	if params.ShowRecycled {
		controls = append(controls, goldap.NewControlString(goldap.ControlTypeMicrosoftShowRecycled, true, ""))
	}
	if params.ManageDsaIT {
		controls = append(controls, goldap.NewControlManageDsaIT(true))
	}
	return controls
}

// controlNames returns a short description of controls for the operation log.
func controlNames(controls []goldap.Control) string {
	names := make([]string, 0, len(controls))
	for _, ctrl := range controls {
		name := goldap.ControlTypeMap[ctrl.GetControlType()]
		if name == "" {
			name = ctrl.GetControlType()
		}
		names = append(names, name)
	}
	return strings.Join(names, ",")
}

// SearchWithControls runs req as is, including its controls, on the client's
// connection with the usual reconnect handling and returns the raw entries.
// With pageSize > 0 the search is paged; the paging control is added next to
// req.Controls (req itself is not modified). Referrals are not followed. On
// error the entries received so far are returned with it; the error unwraps
// to ErrSearchFailed and to the go-ldap error, so goldap.IsErrorWithCode works
// (e.g. LDAPResultSizeLimitExceeded, LDAPResultReferral). The search can be
// stopped with CancelSearches (ErrSearchCancelled).
func (c *Client) SearchWithControls(req *goldap.SearchRequest, pageSize uint32) ([]*goldap.Entry, error) {
	ctx, done := c.trackSearch(context.Background())
	defer done()
	start := time.Now()

	var entries []*goldap.Entry
	err := c.run(ctx, false, func(conn *goldap.Conn) error {
		var err error
		if pageSize > 0 {
			entries, err = c.pagedSearch(ctx, conn, req, int(pageSize))
		} else {
			entries, _, err = searchPage(ctx, conn, req)
		}
		return err
	})
	if ctx.Err() != nil {
		err = ErrSearchCancelled
	}
	if errors.Is(err, ErrNotConnected) {
		return nil, err
	}

	logDetails := searchLogDetails(req.BaseDN, req.Scope, req.Filter, req.Controls)
	c.logger.Log("SEARCH", fmt.Sprintf("%s -> %s", logDetails, EntriesText(len(entries))), time.Since(start), err)
	return entries, searchError(err)
}

// searchLogDetails describes a search for the operation log:
// "base=<dn> scope=base|one|sub filter=<f> [controls=<names>]".
func searchLogDetails(baseDN string, scope int, filter string, controls []goldap.Control) string {
	details := fmt.Sprintf("base=%s scope=%s filter=%s", baseDN, scopeName(scope), filter)
	if names := controlNames(controls); names != "" {
		details += " controls=" + names
	}
	return details
}

// searchBaseError is searchError for a search below baseDN: a base that does
// not exist (noSuchObject) names the base and the connection, so the user
// sees which server the base DN was sent to (e.g. a base DN of another
// connection).
func (c *Client) searchBaseError(baseDN string, err error) error {
	if !goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject) {
		return searchError(err)
	}
	where := c.Profile().Name
	if where == "" {
		where = c.address()
	}
	msg := fmt.Sprintf("%s: the base DN %q does not exist on %q", ErrSearchFailed.Error(), baseDN, where)
	if detail := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(ldapErrorDetail(err)), ":")); detail != "" {
		msg += " (" + detail + ")"
	}
	return &opError{msg: msg, sentinel: ErrSearchFailed, cause: err}
}

// AddEntry creates a new LDAP entry with the given DN and attributes.
// Binary attributes carry base64 values (see models.LDAPAttribute); a
// plain-text unicodePwd is encoded for AD. userPassword values follow the
// connection's password storage policy (AddEntryWithPasswordPolicy with
// default options: an "ask" policy or a cleartext password on an
// unencrypted connection is refused).
func (c *Client) AddEntry(dn string, attrs []models.LDAPAttribute) error {
	_, err := c.AddEntryWithPasswordPolicy(dn, attrs, models.PasswordWriteOptions{})
	return err
}

// addEntry sends the Add request as given, with controls.
func (c *Client) addEntry(dn string, attrs []models.LDAPAttribute, controls []goldap.Control) error {
	start := time.Now()
	addReq := goldap.NewAddRequest(dn, controls)
	for _, attr := range attrs {
		values, err := rawValues(attr.Name, attr.Values, attr.Binary)
		if err != nil {
			return fmt.Errorf("add entry failed: %w", err)
		}
		addReq.Attribute(attr.Name, values)
	}

	err := c.write(func(conn *goldap.Conn) error {
		return conn.Add(addReq)
	})
	if errors.Is(err, ErrNotConnected) || errors.Is(err, ErrReadOnly) {
		return err
	}
	c.logger.Log("ADD", fmt.Sprintf("dn=%s", dn), time.Since(start), err)
	return writeError("add entry", err)
}

// ModifyEntry applies all changes to the entry in a single Modify request,
// so the server applies them atomically. Values of binary changes are base64
// (see models.AttributeChange); plain-text unicodePwd values are encoded for
// AD in every operation, so a delete of the old plus an add of the new
// password performs a user's own password change, a replace an admin reset.
// controls are sent with the request. userPassword values follow the
// connection's password storage policy (ModifyEntryWithPasswordPolicy with
// default options).
func (c *Client) ModifyEntry(dn string, changes []models.AttributeChange, controls ...goldap.Control) error {
	_, err := c.modifyWithPolicy(dn, changes, models.PasswordWriteOptions{}, controls, "MODIFY", "modify entry")
	return err
}

// modify sends changes as one Modify request, logging it as logOp and
// reporting failures as "<what> failed: ...".
func (c *Client) modify(dn string, changes []models.AttributeChange, controls []goldap.Control, logOp, what string) error {
	start := time.Now()
	modReq, err := buildModifyRequest(dn, changes, controls)
	if err != nil {
		return fmt.Errorf("%s failed: %w", what, err)
	}

	err = c.write(func(conn *goldap.Conn) error {
		return conn.Modify(modReq)
	})
	if errors.Is(err, ErrNotConnected) || errors.Is(err, ErrReadOnly) {
		return err
	}
	c.logger.Log(logOp, fmt.Sprintf("dn=%s %s", dn, describeChanges(changes)), time.Since(start), err)
	return writeError(what, err)
}

// buildModifyRequest validates changes and converts them to a Modify request.
func buildModifyRequest(dn string, changes []models.AttributeChange, controls []goldap.Control) (*goldap.ModifyRequest, error) {
	if len(changes) == 0 {
		return nil, errors.New("no changes")
	}
	modReq := goldap.NewModifyRequest(dn, controls)
	for _, ch := range changes {
		if ch.Attribute == "" {
			return nil, errors.New("attribute name must not be empty")
		}
		values, err := rawValues(ch.Attribute, ch.Values, ch.Binary)
		if err != nil {
			return nil, err
		}
		switch strings.ToLower(ch.Operation) {
		case models.ChangeAdd:
			if len(values) == 0 {
				return nil, fmt.Errorf("add of %q needs at least one value", ch.Attribute)
			}
			modReq.Add(ch.Attribute, values)
		case models.ChangeDelete:
			modReq.Delete(ch.Attribute, values)
		case models.ChangeReplace:
			modReq.Replace(ch.Attribute, values)
		default:
			return nil, fmt.Errorf("unknown operation %q for attribute %q", ch.Operation, ch.Attribute)
		}
	}
	return modReq, nil
}

// describeChanges summarizes changes for the operation log, without values.
func describeChanges(changes []models.AttributeChange) string {
	parts := make([]string, 0, len(changes))
	for _, ch := range changes {
		parts = append(parts, fmt.Sprintf("%s:%s(%d)", strings.ToLower(ch.Operation), ch.Attribute, len(ch.Values)))
	}
	return "changes=" + strings.Join(parts, ",")
}

// ModifyAttribute replaces the values of an attribute on an entry.
// For AD unicodePwd, the value is automatically encoded as UTF-16LE with quotes.
func (c *Client) ModifyAttribute(dn string, attrName string, values []string) error {
	_, err := c.modifyWithPolicy(dn, []models.AttributeChange{{Operation: models.ChangeReplace, Attribute: attrName, Values: values}},
		models.PasswordWriteOptions{}, nil, "MODIFY", fmt.Sprintf("modify %q", attrName))
	return err
}

// encodeUnicodePwd encodes a password for AD's unicodePwd attribute.
// AD expects the password enclosed in quotes and encoded as UTF-16LE.
func encodeUnicodePwd(password string) []byte {
	units := utf16.Encode([]rune("\"" + password + "\""))
	encoded := make([]byte, len(units)*2)
	for i, u := range units {
		binary.LittleEndian.PutUint16(encoded[i*2:], u)
	}
	return encoded
}

// AddAttribute adds values to an attribute on an entry.
func (c *Client) AddAttribute(dn string, attrName string, values []string) error {
	_, err := c.modifyWithPolicy(dn, []models.AttributeChange{{Operation: models.ChangeAdd, Attribute: attrName, Values: values}},
		models.PasswordWriteOptions{}, nil, "ADD_ATTR", fmt.Sprintf("add attribute %q", attrName))
	return err
}

// DeleteAttribute removes an attribute from an entry.
func (c *Client) DeleteAttribute(dn string, attrName string) error {
	changes := []models.AttributeChange{{Operation: models.ChangeDelete, Attribute: attrName}}
	// A removed policy attribute (pwdMaxAge, …) must not be served from the shared policy cache.
	defer c.notePolicyWriteChanges(dn, changes)
	return c.modify(dn, changes, nil, "DEL_ATTR", fmt.Sprintf("delete attribute %q", attrName))
}

// DeleteEntry removes an entry by DN.
func (c *Client) DeleteEntry(dn string) error {
	return c.DeleteEntryWithControls(dn)
}

// DeleteEntryWithControls removes an entry by DN, sending controls with the
// request (e.g. the tree delete control 1.2.840.113556.1.4.805).
func (c *Client) DeleteEntryWithControls(dn string, controls ...goldap.Control) error {
	// A deleted policy entry must not be served from the shared policy cache.
	defer c.notePolicyEntryWrite(dn)
	start := time.Now()
	delReq := goldap.NewDelRequest(dn, controls)

	err := c.write(func(conn *goldap.Conn) error {
		return conn.Del(delReq)
	})
	if errors.Is(err, ErrNotConnected) || errors.Is(err, ErrReadOnly) {
		return err
	}
	details := fmt.Sprintf("dn=%s", dn)
	if names := controlNames(controls); names != "" {
		details += " controls=" + names
	}
	c.logger.Log("DELETE", details, time.Since(start), err)
	return writeError("delete entry", err)
}

// RenameEntry renames or moves an LDAP entry.
func (c *Client) RenameEntry(dn string, newRDN string, deleteOldRDN bool, newSuperior string) error {
	// A renamed policy entry (pwdPolicySubentry values now point nowhere) is read again.
	defer c.notePolicyEntryWrite(dn)
	start := time.Now()
	modDNReq := goldap.NewModifyDNRequest(dn, newRDN, deleteOldRDN, newSuperior)

	err := c.write(func(conn *goldap.Conn) error {
		return conn.ModifyDN(modDNReq)
	})
	if errors.Is(err, ErrNotConnected) || errors.Is(err, ErrReadOnly) {
		return err
	}
	c.logger.Log("RENAME", fmt.Sprintf("dn=%s newRDN=%s newSuperior=%s", dn, newRDN, newSuperior), time.Since(start), err)
	return writeError("rename entry", err)
}

// convertEntry converts a go-ldap Entry to our models.LDAPEntry, applying
// the binary contract (see convertAttribute).
func convertEntry(entry *goldap.Entry) *models.LDAPEntry {
	attrs := make([]models.LDAPAttribute, 0, len(entry.Attributes))
	for _, a := range entry.Attributes {
		attrs = append(attrs, convertAttribute(a.Name, a.ByteValues, a.Values))
	}
	return &models.LDAPEntry{
		DN:         entry.DN,
		Attributes: attrs,
	}
}

// determineIcon returns an icon name based on objectClass values.
func determineIcon(objectClasses []string) string {
	for _, oc := range objectClasses {
		lower := strings.ToLower(oc)
		switch lower {
		case "person", "inetorgperson", "user", "organizationalperson":
			return "user"
		case "group", "groupofnames", "groupofuniquenames", "posixgroup":
			return "users"
		case "organizationalunit":
			return "folder"
		case "organization":
			return "building"
		case "domain", "domaindns", "dcobject":
			return "globe"
		case "computer":
			return "monitor"
		case "container", "builtindomain", "lostandfound":
			return "box"
		case "grouppolicycontainer":
			return "settings"
		case "printqueue":
			return "printer"
		case "volume":
			return "harddrive"
		case "server":
			return "server"
		case "contact":
			return "contact"
		case "foreignsecurityprincipal":
			return "shield"
		case "subnet":
			return "network"
		case "site", "sitelink":
			return "landmark"
		case "ntsdsservice", "ntdsdsa":
			return "database"
		case "msds-managedserviceaccount", "msds-groupmanagedserviceaccount":
			return "usercog"
		}
	}
	return extraIcon(objectClasses)
}

// extractRDN extracts the first RDN component from a full DN.
func extractRDN(dn string) string {
	parsed, err := goldap.ParseDN(dn)
	if err != nil || len(parsed.RDNs) == 0 {
		// Fallback: just take everything before the first unescaped comma
		parts := strings.SplitN(dn, ",", 2)
		return parts[0]
	}
	// Reconstruct the first RDN from its attributes
	parts := make([]string, 0, len(parsed.RDNs[0].Attributes))
	for _, attr := range parsed.RDNs[0].Attributes {
		parts = append(parts, fmt.Sprintf("%s=%s", attr.Type, attr.Value))
	}
	return strings.Join(parts, "+")
}
