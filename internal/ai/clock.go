package ai

import (
	"crypto/rand"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"
)

// Clock abstracts time so that retries, watchdogs and timeouts can be tested
// with a fake clock. Code below the Wails facade never calls time.Now or
// time.Sleep directly.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
	NewTimer(d time.Duration) Timer
}

// Timer is the subset of *time.Timer used by the harness.
type Timer interface {
	C() <-chan time.Time
	Stop() bool
	Reset(d time.Duration) bool
}

// IDGen creates IDs for runs, messages, tool calls, approvals and grants.
type IDGen interface {
	NewID() string
}

type systemClock struct{}

// SystemClock returns the real clock.
func SystemClock() Clock { return systemClock{} }

func (systemClock) Now() time.Time                         { return time.Now() }
func (systemClock) After(d time.Duration) <-chan time.Time { return time.After(d) }
func (systemClock) NewTimer(d time.Duration) Timer         { return &realTimer{t: time.NewTimer(d)} }

type realTimer struct{ t *time.Timer }

func (r *realTimer) C() <-chan time.Time        { return r.t.C }
func (r *realTimer) Stop() bool                 { return r.t.Stop() }
func (r *realTimer) Reset(d time.Duration) bool { return r.t.Reset(d) }

type uuidGen struct{}

// UUIDGen returns an IDGen producing random lower-case UUIDv4 strings.
func UUIDGen() IDGen { return uuidGen{} }

func (uuidGen) NewID() string { return NewUUID() }

// NewUUID returns a random lower-case canonical UUIDv4.
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// IsLoopbackHost reports whether host is a literal loopback name or address:
// "localhost", 127.0.0.0/8 or ::1. A host name that only resolves to a
// loopback address counts as remote.
func IsLoopbackHost(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(strings.Trim(host, "[]"), "."))
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// URLHost returns the lower-case host name of a URL ("" if unparsable).
func URLHost(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// IsLoopbackURL reports whether the URL's host is a literal loopback host.
func IsLoopbackURL(raw string) bool {
	h := URLHost(raw)
	return h != "" && IsLoopbackHost(h)
}
