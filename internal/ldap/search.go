package ldap

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"

	goldap "github.com/go-ldap/ldap/v3"
)

// searchBufferSize is the number of results SearchAsync may queue ahead of the reader.
const searchBufferSize = 64

// maxPagedSearches caps the paged searches running at once on a connection.
// AD (MaxResultSetsPerConn) and Samba keep at most 10 paged result sets per
// connection and drop the oldest beyond that.
const maxPagedSearches = 5

// ValidateFilter checks whether the given LDAP filter string is syntactically valid.
func ValidateFilter(filter string) error {
	_, err := goldap.CompileFilter(filter)
	if err != nil {
		return fmt.Errorf("invalid LDAP filter: %w", err)
	}
	return nil
}

// trackSearch derives a cancellable context for a search and registers it so
// that CancelSearches can stop it. The returned func must be called when the
// search has finished.
func (c *Client) trackSearch(parent context.Context) (context.Context, func()) {
	ctx, cancel := context.WithCancel(parent)

	c.searchMu.Lock()
	if c.searches == nil {
		c.searches = make(map[uint64]context.CancelFunc)
	}
	c.searchSeq++
	id := c.searchSeq
	c.searches[id] = cancel
	c.searchMu.Unlock()

	return ctx, func() {
		c.searchMu.Lock()
		delete(c.searches, id)
		c.searchMu.Unlock()
		cancel()
	}
}

// CancelSearches cancels all searches currently running through Search or
// SearchContext on this client and returns how many were cancelled. Each of
// them returns ErrSearchCancelled.
func (c *Client) CancelSearches() int {
	c.searchMu.Lock()
	defer c.searchMu.Unlock()
	for _, cancel := range c.searches {
		cancel()
	}
	return len(c.searches)
}

// searchPage sends one search request (one page of a paged search) and
// collects its entries and the controls of the final result. When ctx is
// done the request is abandoned on the client side and ErrSearchCancelled is
// returned together with the entries received so far.
func searchPage(ctx context.Context, conn *goldap.Conn, req *goldap.SearchRequest) ([]*goldap.Entry, []goldap.Control, error) {
	resp := conn.SearchAsync(ctx, req, searchBufferSize)

	var entries []*goldap.Entry
	var controls []goldap.Control
	for resp.Next() {
		if entry := resp.Entry(); entry != nil {
			entries = append(entries, entry)
		} else if resp.Referral() == "" {
			controls = append(controls, resp.Controls()...)
		}
	}
	if err := resp.Err(); err != nil {
		return entries, controls, err
	}
	if ctx.Err() != nil {
		return entries, controls, ErrSearchCancelled
	}
	if conn.IsClosing() {
		// SearchAsync silently ends without an error when the connection is
		// already closing, so the result may be incomplete.
		return entries, controls, goldap.NewError(goldap.ErrorNetwork, errors.New("ldap: connection lost during search"))
	}
	return entries, controls, nil
}

// pagedSearch runs req as a paged search on conn and returns all entries,
// including those received before an error. req is not modified.
//
// Up to maxPagedSearches paged searches run concurrently on a connection.
// Servers that keep fewer paged result sets per connection (OpenLDAP keeps
// one) discard the result set of a running paged search when another one
// starts. Such a search is repeated on a private connection, so it neither
// blocks nor gets disturbed by other operations; if that connection cannot be
// opened, it is repeated on conn while holding all paging slots. Waiting for
// a slot ends with ErrSearchCancelled as soon as ctx is done.
func (c *Client) pagedSearch(ctx context.Context, conn *goldap.Conn, req *goldap.SearchRequest, pageSize int) ([]*goldap.Entry, error) {
	if c.paging.acquire(ctx, 1) != nil {
		return nil, ErrSearchCancelled
	}
	entries, conflict, err := searchPages(ctx, conn, req, pageSize)
	c.paging.release(1)
	if !conflict {
		return entries, err
	}
	if ctx.Err() != nil {
		return entries, ErrSearchCancelled
	}

	if entries, err := c.searchPagesPrivate(ctx, req, pageSize); !errors.Is(err, errNoPrivateConn) {
		return entries, err
	}

	if c.paging.acquire(ctx, maxPagedSearches) != nil {
		return nil, ErrSearchCancelled
	}
	defer c.paging.release(maxPagedSearches)
	entries, _, err = searchPages(ctx, conn, req, pageSize)
	return entries, err
}

// errNoPrivateConn reports that searchPagesPrivate could not open its connection.
var errNoPrivateConn = errors.New("private search connection unavailable")

// privateConnError is a failure of the temporary connection of
// searchPagesPrivate, e.g. a reset or a closed socket. It says nothing about
// the client's own connection, so isConnDead ignores it: run neither replaces
// the healthy main connection nor retries the operation.
type privateConnError struct{ err error }

func (e *privateConnError) Error() string {
	return "paged search on temporary connection failed: " + ldapErrorDetail(e.err)
}

// searchPagesPrivate runs a paged search on a temporary connection of its own.
// Cancelling ctx closes the connection, which also stops the search on the
// server, and returns ErrSearchCancelled. Returns errNoPrivateConn if the
// connection could not be opened. Server results (size limit, referral, ...)
// are returned unchanged; connection failures as *privateConnError.
func (c *Client) searchPagesPrivate(ctx context.Context, req *goldap.SearchRequest, pageSize int) ([]*goldap.Entry, error) {
	conn, err := c.dialPrivate(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()

	entries, _, err := searchPages(ctx, conn, req, pageSize)
	var ldapErr *goldap.Error
	switch {
	case ctx.Err() != nil:
		return entries, ErrSearchCancelled
	case err != nil && !(errors.As(err, &ldapErr) && ldapErr.ResultCode < goldap.ErrorNetwork):
		return entries, &privateConnError{err: err}
	}
	return entries, err
}

// dialPrivate opens and binds a temporary connection with the client's
// profile. It returns ErrSearchCancelled as soon as ctx is done (a dial still
// in progress is closed once it completes) and errNoPrivateConn if the
// connection cannot be established.
func (c *Client) dialPrivate(ctx context.Context) (*goldap.Conn, error) {
	if ctx.Err() != nil {
		return nil, ErrSearchCancelled
	}
	profile := c.Profile()
	result := make(chan *goldap.Conn, 1)
	go func() {
		conn, err := dialServer(profile, profile.Host, strconv.Itoa(profile.Port), profile.TLSMode)
		if err == nil {
			if err = bindConn(conn, profile); err != nil {
				conn.Close()
				conn = nil
			}
		}
		result <- conn
	}()

	select {
	case conn := <-result:
		if conn == nil {
			return nil, errNoPrivateConn
		}
		return conn, nil
	case <-ctx.Done():
		go func() {
			if conn := <-result; conn != nil {
				conn.Close()
			}
		}()
		return nil, ErrSearchCancelled
	}
}

// pagingSlots limits the paged searches running at once on a client: a
// search takes one slot, a search repeated after a paging conflict takes all
// of them. Waiters are served in FIFO order, so a waiting exclusive search is
// not starved by a stream of shared ones, and stop waiting when their context
// is done.
type pagingSlots struct {
	mu      sync.Mutex
	free    int
	waiters []*pagingWaiter
}

type pagingWaiter struct {
	n     int
	ready chan struct{} // closed when the slots have been granted
}

func newPagingSlots(n int) *pagingSlots {
	return &pagingSlots{free: n}
}

// acquire takes n slots, waiting until they are free or ctx is done.
func (s *pagingSlots) acquire(ctx context.Context, n int) error {
	s.mu.Lock()
	if len(s.waiters) == 0 && s.free >= n {
		s.free -= n
		s.mu.Unlock()
		return nil
	}
	w := &pagingWaiter{n: n, ready: make(chan struct{})}
	s.waiters = append(s.waiters, w)
	s.mu.Unlock()

	select {
	case <-w.ready:
		return nil
	case <-ctx.Done():
		s.mu.Lock()
		select {
		case <-w.ready:
			// Granted at the same time: hand the slots back.
			s.free += n
		default:
			s.waiters = slices.DeleteFunc(s.waiters, func(x *pagingWaiter) bool { return x == w })
		}
		// Waiters queued behind w may fit now.
		s.grant()
		s.mu.Unlock()
		return ctx.Err()
	}
}

// release returns n slots taken by acquire.
func (s *pagingSlots) release(n int) {
	s.mu.Lock()
	s.free += n
	s.grant()
	s.mu.Unlock()
}

// grant hands free slots to the waiters at the head of the queue. s.mu must be held.
func (s *pagingSlots) grant() {
	for len(s.waiters) > 0 && s.free >= s.waiters[0].n {
		w := s.waiters[0]
		s.waiters = s.waiters[1:]
		s.free -= w.n
		close(w.ready)
	}
}

// searchPages requests all pages of req. The controls of req are sent with
// every page next to the paging control. conflict reports that a follow-up
// page failed because the server discarded the paged result set.
//
// The size limit of req is enforced here as well: AD and Samba apply it per
// page (or not at all) in a paged search, so once more than req.SizeLimit
// entries have arrived no further page is requested, the server's result set
// is released (RFC 2696: a page size of 0 abandons the search), and the first
// SizeLimit entries are returned with errClientSizeLimit, which callers see as
// an ordinary sizeLimitExceeded (goldap.IsErrorWithCode). A server that
// enforces the limit itself ends with sizeLimitExceeded as before.
func searchPages(ctx context.Context, conn *goldap.Conn, base *goldap.SearchRequest, pageSize int) (entries []*goldap.Entry, conflict bool, err error) {
	req := *base
	limit := base.SizeLimit
	pageSize = pageSizeForLimit(pageSize, limit)
	extra := withoutControl(base.Controls, goldap.ControlTypePaging)
	req.Controls = append(extra, goldap.NewControlPaging(uint32(pageSize)))
	for page := 0; ; page++ {
		pageEntries, controls, err := searchPage(ctx, conn, &req)
		entries = append(entries, pageEntries...)
		if err != nil {
			if limit > 0 && len(entries) > limit {
				entries = entries[:limit]
			}
			return entries, page > 0 && isPagingConflict(err), err
		}
		next := nextPageControls(controls, pageSize)
		if limit > 0 && len(entries) > limit {
			if cookie := pagingCookie(controls); cookie != nil {
				abandonPagedSearch(ctx, conn, &req, extra, cookie)
			}
			return entries[:limit], false, errClientSizeLimit
		}
		if next == nil {
			return entries, false, nil
		}
		req.Controls = append(extra[:len(extra):len(extra)], next...)
	}
}

// errClientSizeLimit ends a paged search whose server returned more entries
// than the request's size limit (see searchPages). It is a goldap error with
// result code sizeLimitExceeded, so existing size-limit handling applies.
var errClientSizeLimit = goldap.NewError(goldap.LDAPResultSizeLimitExceeded, errors.New("size limit reached"))

// pageSizeForLimit returns the page size to request for a search with the
// given size limit: one more than the limit when that is smaller than the
// configured page size (so a server ignoring the limit sends little more
// than needed and the client still learns that there are more entries).
func pageSizeForLimit(pageSize, sizeLimit int) int {
	if sizeLimit > 0 && sizeLimit < pageSize {
		return sizeLimit + 1
	}
	return pageSize
}

// pagingCookie returns the cookie of the paging control in controls, or nil
// when there is none (no further page).
func pagingCookie(controls []goldap.Control) []byte {
	paging, ok := goldap.FindControl(controls, goldap.ControlTypePaging).(*goldap.ControlPaging)
	if !ok || len(paging.Cookie) == 0 {
		return nil
	}
	return paging.Cookie
}

// abandonPagedSearch tells the server that no further page of req is needed
// (RFC 2696: the cookie with a page size of 0), so it can release the result
// set. Best effort: the answer and errors are ignored.
func abandonPagedSearch(ctx context.Context, conn *goldap.Conn, req *goldap.SearchRequest, extra []goldap.Control, cookie []byte) {
	if ctx.Err() != nil {
		return
	}
	stop := goldap.NewControlPaging(0)
	stop.SetCookie(cookie)
	r := *req
	r.Controls = append(extra[:len(extra):len(extra)], stop)
	_, _, _ = searchPage(ctx, conn, &r)
}

// scopeName is the name of a search scope in the operation log.
func scopeName(scope int) string {
	switch scope {
	case goldap.ScopeBaseObject:
		return "base"
	case goldap.ScopeSingleLevel:
		return "one"
	case goldap.ScopeWholeSubtree:
		return "sub"
	}
	return strconv.Itoa(scope)
}

// withoutControl returns a copy of controls without those of controlType.
func withoutControl(controls []goldap.Control, controlType string) []goldap.Control {
	out := make([]goldap.Control, 0, len(controls)+1)
	for _, ctrl := range controls {
		if ctrl.GetControlType() != controlType {
			out = append(out, ctrl)
		}
	}
	return out
}

// isPagingConflict reports whether the server refused to continue a paged
// search, typically because it discarded the result set: OpenLDAP answers
// "paged results cookie is invalid or old", Samba "Unwilling To Perform".
func isPagingConflict(err error) bool {
	var ldapErr *goldap.Error
	if !errors.As(err, &ldapErr) || ldapErr.ResultCode >= goldap.ErrorNetwork {
		return false
	}
	switch ldapErr.ResultCode {
	case goldap.LDAPResultOperationsError, goldap.LDAPResultProtocolError, goldap.LDAPResultUnwillingToPerform:
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "cookie")
}

// nextPageControls returns the request controls for the next page of a paged
// search, or nil when the server signalled that there are no more pages.
func nextPageControls(resultControls []goldap.Control, pageSize int) []goldap.Control {
	paging, ok := goldap.FindControl(resultControls, goldap.ControlTypePaging).(*goldap.ControlPaging)
	if !ok || len(paging.Cookie) == 0 {
		return nil
	}
	next := goldap.NewControlPaging(uint32(pageSize))
	next.SetCookie(paging.Cookie)
	return []goldap.Control{next}
}
