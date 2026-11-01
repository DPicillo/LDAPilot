package ldap

import (
	"context"
	"errors"
	"fmt"
	"time"

	goldap "github.com/go-ldap/ldap/v3"
)

// Size-capped paged searches for the deleted objects list and descendant
// counts. Samba ignores the size limit of a search request (with and without
// paging), so a cap that relies on the server would download the whole
// result. recycleSearchCapped enforces the cap on the client: it stops
// requesting pages once more than the limit has arrived.

// recycleSearchCapped runs req (with its controls) as a paged search and
// returns at most limit entries; capped reports that there are more (or
// that the server ended the search with sizeLimitExceeded). req.SizeLimit is
// set to limit+1 so that servers honouring it stop early as well; req itself
// is not modified. Like SearchWithControls the search is logged, uses the
// client's reconnect handling, does not follow referrals and can be stopped
// with CancelSearches. On error the entries received so far are returned
// with it.
func (c *Client) recycleSearchCapped(req *goldap.SearchRequest, limit int) (entries []*goldap.Entry, capped bool, err error) {
	if limit <= 0 {
		return nil, false, errors.New("recycleSearchCapped: limit must be positive")
	}
	ctx, done := c.trackSearch(context.Background())
	defer done()
	start := time.Now()

	capReq := *req
	capReq.SizeLimit = limit + 1
	pageSize := min(c.pageSize(), limit+1)

	err = c.run(ctx, false, func(conn *goldap.Conn) error {
		var err error
		entries, capped, err = c.recycleCappedPagedSearch(ctx, conn, &capReq, pageSize, limit)
		return err
	})
	if ctx.Err() != nil {
		err = ErrSearchCancelled
	}
	if errors.Is(err, ErrNotConnected) {
		return nil, false, err
	}
	if goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
		// Our limit+1, or a lower server-side limit: there is more.
		capped, err = true, nil
	}
	if len(entries) > limit {
		entries, capped = entries[:limit], true
	}

	logDetails := fmt.Sprintf("base=%s scope=%d filter=%s limit=%d", req.BaseDN, req.Scope, req.Filter, limit)
	if names := controlNames(req.Controls); names != "" {
		logDetails += " controls=" + names
	}
	result := EntriesText(len(entries))
	if capped {
		result += " (capped)"
	}
	c.logger.Log("SEARCH", logDetails+" -> "+result, time.Since(start), err)
	return entries, capped, searchError(err)
}

// recycleCappedPagedSearch is pagedSearch with a cap: it takes a paging slot and,
// when the server discarded the paged result set because another paged
// search started on the connection (OpenLDAP keeps one per connection),
// repeats the search holding all paging slots.
func (c *Client) recycleCappedPagedSearch(ctx context.Context, conn *goldap.Conn, req *goldap.SearchRequest, pageSize, limit int) ([]*goldap.Entry, bool, error) {
	if c.paging.acquire(ctx, 1) != nil {
		return nil, false, ErrSearchCancelled
	}
	entries, capped, conflict, err := recycleSearchPagesCapped(ctx, conn, req, pageSize, limit)
	c.paging.release(1)
	if !conflict {
		return entries, capped, err
	}
	if ctx.Err() != nil {
		return entries, capped, ErrSearchCancelled
	}
	if c.paging.acquire(ctx, maxPagedSearches) != nil {
		return nil, false, ErrSearchCancelled
	}
	defer c.paging.release(maxPagedSearches)
	entries, capped, _, err = recycleSearchPagesCapped(ctx, conn, req, pageSize, limit)
	return entries, capped, err
}

// recycleSearchPagesCapped requests the pages of base like searchPages, but stops
// as soon as more than limit entries have arrived and the server still has
// more pages (capped). The server's paged result set is then released with a
// page size 0 request (RFC 2696) instead of fetching the remaining pages.
// conflict reports that a follow-up page failed because the server
// discarded the paged result set.
func recycleSearchPagesCapped(ctx context.Context, conn *goldap.Conn, base *goldap.SearchRequest, pageSize, limit int) (entries []*goldap.Entry, capped, conflict bool, err error) {
	req := *base
	extra := withoutControl(base.Controls, goldap.ControlTypePaging)
	req.Controls = append(extra, goldap.NewControlPaging(uint32(pageSize)))
	for page := 0; ; page++ {
		pageEntries, controls, err := searchPage(ctx, conn, &req)
		entries = append(entries, pageEntries...)
		if err != nil {
			return entries, false, page > 0 && isPagingConflict(err), err
		}
		next := nextPageControls(controls, pageSize)
		if next == nil {
			return entries, len(entries) > limit, false, nil
		}
		req.Controls = append(extra[:len(extra):len(extra)], next...)
		if len(entries) > limit {
			recycleAbandonPagedSearch(ctx, conn, &req)
			return entries, true, false, nil
		}
	}
}

// recycleAbandonPagedSearch tells the server to release the paged result set of
// req (whose paging control carries the cookie) by requesting a page of size
// 0. Errors are ignored: servers also drop abandoned result sets on their own.
func recycleAbandonPagedSearch(ctx context.Context, conn *goldap.Conn, req *goldap.SearchRequest) {
	paging, ok := goldap.FindControl(req.Controls, goldap.ControlTypePaging).(*goldap.ControlPaging)
	if !ok || len(paging.Cookie) == 0 {
		return
	}
	stop := goldap.NewControlPaging(0)
	stop.SetCookie(paging.Cookie)
	abandon := *req
	abandon.Controls = append(withoutControl(req.Controls, goldap.ControlTypePaging), stop)
	_, _, _ = searchPage(ctx, conn, &abandon)
}
