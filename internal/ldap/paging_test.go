package ldap

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	ber "github.com/go-asn1-ber/asn1-ber"
	goldap "github.com/go-ldap/ldap/v3"
)

// waitDone reports whether ch delivers within d.
func waitDone(ch <-chan error, d time.Duration) (error, bool) {
	select {
	case err := <-ch:
		return err, true
	case <-time.After(d):
		return nil, false
	}
}

func acquireAsync(s *pagingSlots, ctx context.Context, n int) <-chan error {
	ch := make(chan error, 1)
	go func() { ch <- s.acquire(ctx, n) }()
	return ch
}

func TestPagingSlotsShared(t *testing.T) {
	s := newPagingSlots(3)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if err := s.acquire(ctx, 1); err != nil {
			t.Fatal(err)
		}
	}
	fourth := acquireAsync(s, ctx, 1)
	if _, ok := waitDone(fourth, 50*time.Millisecond); ok {
		t.Fatal("fourth shared acquire must wait")
	}
	s.release(1)
	if err, ok := waitDone(fourth, time.Second); !ok || err != nil {
		t.Fatalf("fourth acquire after release: ok=%v err=%v", ok, err)
	}
}

// An exclusive waiter blocks later shared acquires (no starvation) and gets
// the slots once the shared holders are done.
func TestPagingSlotsExclusiveFIFO(t *testing.T) {
	s := newPagingSlots(3)
	ctx := context.Background()
	if err := s.acquire(ctx, 1); err != nil {
		t.Fatal(err)
	}
	exclusive := acquireAsync(s, ctx, 3)
	time.Sleep(20 * time.Millisecond)
	shared := acquireAsync(s, ctx, 1)
	if _, ok := waitDone(shared, 50*time.Millisecond); ok {
		t.Fatal("shared acquire must queue behind the exclusive waiter")
	}
	s.release(1)
	if err, ok := waitDone(exclusive, time.Second); !ok || err != nil {
		t.Fatalf("exclusive acquire: ok=%v err=%v", ok, err)
	}
	if _, ok := waitDone(shared, 50*time.Millisecond); ok {
		t.Fatal("shared acquire must wait for the exclusive holder")
	}
	s.release(3)
	if err, ok := waitDone(shared, time.Second); !ok || err != nil {
		t.Fatalf("shared acquire after exclusive release: ok=%v err=%v", ok, err)
	}
}

// Cancelling waiters returns at once; a cancelled exclusive waiter lets the
// shared waiters behind it through.
func TestPagingSlotsCancel(t *testing.T) {
	s := newPagingSlots(2)
	if err := s.acquire(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	exCtx, exCancel := context.WithCancel(context.Background())
	exclusive := acquireAsync(s, exCtx, 2)
	time.Sleep(20 * time.Millisecond)

	shCtx, shCancel := context.WithCancel(context.Background())
	cancelled := acquireAsync(s, shCtx, 1)
	shared := acquireAsync(s, context.Background(), 1)
	time.Sleep(20 * time.Millisecond)

	shCancel()
	if err, ok := waitDone(cancelled, time.Second); !ok || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled shared waiter: ok=%v err=%v", ok, err)
	}
	exCancel()
	if err, ok := waitDone(exclusive, time.Second); !ok || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled exclusive waiter: ok=%v err=%v", ok, err)
	}
	if err, ok := waitDone(shared, time.Second); !ok || err != nil {
		t.Fatalf("shared waiter behind the cancelled exclusive one: ok=%v err=%v", ok, err)
	}
	s.release(1)
	s.release(1)
	if err := s.acquire(context.Background(), 2); err != nil {
		t.Fatalf("all slots must be free again: %v", err)
	}
}

// pagedSearch gives up waiting for a slot when its context ends.
func TestPagedSearchCancelWhileWaiting(t *testing.T) {
	c := NewClient(models.ConnectionProfile{ID: "p", Host: "127.0.0.1", Port: 1})
	if err := c.paging.acquire(context.Background(), maxPagedSearches); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := c.pagedSearch(ctx, nil, nil, 10); !errors.Is(err, ErrSearchCancelled) {
		t.Fatalf("err = %v, want ErrSearchCancelled", err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("cancel took %v", d)
	}
	if _, err := c.searchPagesPrivate(ctx, nil, 10); !errors.Is(err, ErrSearchCancelled) {
		t.Fatalf("searchPagesPrivate with a done context: err = %v, want ErrSearchCancelled", err)
	}
}

// fakePagingServer answers paged searches like Samba: it ignores the size
// limit and pages through `total` entries; a page size of 0 with a cookie
// abandons the result set (RFC 2696).
type fakePagingServer struct {
	total int
	mu    sync.Mutex
	sizes []int // requested page sizes, in order
	limit []int64
	// abandoned counts size-0 requests with a cookie.
	abandoned int
}

func (f *fakePagingServer) serve(conn net.Conn) {
	defer conn.Close()
	for {
		pkt, err := ber.ReadPacket(conn)
		if err != nil || len(pkt.Children) < 2 {
			return
		}
		id, _ := pkt.Children[0].Value.(int64)
		op := pkt.Children[1]
		if op.Tag != goldap.ApplicationSearchRequest {
			continue // abandon, unbind
		}
		size, cookie := 0, []byte(nil)
		if len(pkt.Children) > 2 {
			for _, c := range pkt.Children[2].Children {
				if ctrl, err := goldap.DecodeControl(c); err == nil {
					if p, ok := ctrl.(*goldap.ControlPaging); ok {
						size, cookie = int(p.PagingSize), p.Cookie
					}
				}
			}
		}
		sizeLimit, _ := op.Children[3].Value.(int64)
		offset := 0
		if len(cookie) > 0 {
			offset, _ = strconv.Atoi(string(cookie))
		}
		f.mu.Lock()
		f.sizes = append(f.sizes, size)
		f.limit = append(f.limit, sizeLimit)
		if size == 0 && len(cookie) > 0 {
			f.abandoned++
		}
		f.mu.Unlock()
		if size == 0 {
			conn.Write(fakeResponse(id, fakeDone()).Bytes())
			continue
		}
		end := min(offset+size, f.total)
		for i := offset; i < end; i++ {
			entry := ber.Encode(ber.ClassApplication, ber.TypeConstructed, goldap.ApplicationSearchResultEntry, nil, "entry")
			entry.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, fmt.Sprintf("cn=e%d,dc=test", i), "dn"))
			entry.AppendChild(ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "attributes"))
			conn.Write(fakeResponse(id, entry).Bytes())
		}
		next := goldap.NewControlPaging(uint32(size))
		if end < f.total {
			next.SetCookie([]byte(strconv.Itoa(end)))
		}
		conn.Write(fakeResponse(id, fakeDone(), next.Encode()).Bytes())
	}
}

func fakeDone() *ber.Packet {
	done := ber.Encode(ber.ClassApplication, ber.TypeConstructed, goldap.ApplicationSearchResultDone, nil, "done")
	done.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagEnumerated, int64(goldap.LDAPResultSuccess), "code"))
	done.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "matchedDN"))
	done.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "message"))
	return done
}

func fakeResponse(id int64, op *ber.Packet, controls ...*ber.Packet) *ber.Packet {
	p := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "LDAP Response")
	p.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, id, "MessageID"))
	p.AppendChild(op)
	if len(controls) > 0 {
		c := ber.Encode(ber.ClassContext, ber.TypeConstructed, 0, nil, "Controls")
		for _, ctl := range controls {
			c.AppendChild(ctl)
		}
		p.AppendChild(c)
	}
	return p
}

func fakePagingConn(t *testing.T, total int) (*goldap.Conn, *fakePagingServer) {
	t.Helper()
	cli, srv := net.Pipe()
	f := &fakePagingServer{total: total}
	go f.serve(srv)
	conn := goldap.NewConn(cli, false)
	conn.Start()
	t.Cleanup(func() { conn.Close() })
	return conn, f
}

func pagedReq(sizeLimit int) *goldap.SearchRequest {
	return goldap.NewSearchRequest("dc=test", goldap.ScopeWholeSubtree, goldap.NeverDerefAliases, sizeLimit, 0, false, "(objectClass=*)", []string{"1.1"}, nil)
}

// A server that ignores the size limit in paged searches (Samba, AD):
// the client stops after the limit, releases the result set and reports
// sizeLimitExceeded with exactly sizeLimit entries.
func TestSearchPagesEnforcesSizeLimit(t *testing.T) {
	conn, f := fakePagingConn(t, 30)
	entries, conflict, err := searchPages(context.Background(), conn, pagedReq(10), 500)
	if !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) || conflict {
		t.Fatalf("err = %v, conflict = %v; want sizeLimitExceeded", err, conflict)
	}
	if len(entries) != 10 || entries[9].DN != "cn=e9,dc=test" {
		t.Fatalf("got %d entries", len(entries))
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sizes) != 2 || f.sizes[0] != 11 || f.sizes[1] != 0 || f.abandoned != 1 {
		t.Fatalf("page sizes = %v, abandoned = %d; want [11 0], 1", f.sizes, f.abandoned)
	}
	if f.limit[0] != 10 {
		t.Fatalf("size limit sent = %d", f.limit[0])
	}
}

// Without a limit every page is read; exactly `limit` entries are not truncated.
func TestSearchPagesWithoutOrAtLimit(t *testing.T) {
	conn, f := fakePagingConn(t, 30)
	entries, _, err := searchPages(context.Background(), conn, pagedReq(0), 7)
	if err != nil || len(entries) != 30 {
		t.Fatalf("unlimited: %d entries, err %v", len(entries), err)
	}
	if len(f.sizes) != 5 || f.abandoned != 0 {
		t.Fatalf("unlimited pages = %v, abandoned %d", f.sizes, f.abandoned)
	}

	conn2, f2 := fakePagingConn(t, 10)
	c := NewClient(models.ConnectionProfile{ID: "p", Host: "127.0.0.1", Port: 1})
	entries, err = c.pagedSearch(context.Background(), conn2, pagedReq(10), 4)
	if err != nil || len(entries) != 10 {
		t.Fatalf("at limit: %d entries, err %v", len(entries), err)
	}
	if f2.abandoned != 0 {
		t.Fatal("a complete result set must not be abandoned")
	}
}

func TestScopeNameAndPageSizeForLimit(t *testing.T) {
	if scopeName(0) != "base" || scopeName(1) != "one" || scopeName(2) != "sub" || scopeName(7) != "7" {
		t.Fatal("scopeName")
	}
	if pageSizeForLimit(500, 0) != 500 || pageSizeForLimit(500, 50) != 51 || pageSizeForLimit(500, 2000) != 500 {
		t.Fatal("pageSizeForLimit")
	}
	if got := searchLogDetails("dc=x", 1, "(cn=a)", nil); got != "base=dc=x scope=one filter=(cn=a)" {
		t.Fatalf("searchLogDetails = %q", got)
	}
}
