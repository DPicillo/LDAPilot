package ldap

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// defaultTimeout is used when a profile has no timeout configured.
const defaultTimeout = 10 * time.Second

// Valid ranges of the profile settings Timeout (seconds) and PageSize; the
// connection dialog validates the same ranges and SaveConnection clamps.
const (
	MinProfileTimeout  = 1
	MaxProfileTimeout  = 600
	MinProfilePageSize = 1
	MaxProfilePageSize = 5000
)

// profileTimeout returns the connect and per-request timeout of a profile
// (default when unset, at most MaxProfileTimeout).
func profileTimeout(profile models.ConnectionProfile) time.Duration {
	if profile.Timeout <= 0 {
		return defaultTimeout
	}
	return time.Duration(min(profile.Timeout, MaxProfileTimeout)) * time.Second
}

// dialServer opens a connection to host:port using the given TLS mode and the
// TLS settings of profile. The profile timeout bounds the TCP dial and the TLS
// handshake (LDAPS and StartTLS) and is set as per-request timeout on the
// returned connection, which therefore also bounds the bind. The connection is
// not bound yet. It is shared by the main connection, the temporary paging
// connections and referral following.
func dialServer(profile models.ConnectionProfile, host, port string, tlsMode models.TLSMode) (*goldap.Conn, error) {
	conn, _, err := dialServerTLS(profile, host, port, tlsMode)
	return conn, err
}

// dialServerTLS is dialServer that also returns the outcome of the server
// certificate verification (nil without TLS or when the TLS settings are
// invalid). An untrusted server certificate fails with *CertificateError
// (LDAPS and StartTLS alike), invalid TLS settings with *AuthConfigError.
func dialServerTLS(profile models.ConnectionProfile, host, port string, tlsMode models.TLSMode) (*goldap.Conn, *tlsOutcome, error) {
	if profile.AuthMethod == models.AuthNTLM {
		return dialServerNTLM(profile, host, port, tlsMode)
	}
	timeout := profileTimeout(profile)
	dialer := &net.Dialer{Timeout: timeout}
	address := net.JoinHostPort(host, port)

	var tlsConfig *tls.Config
	var out *tlsOutcome
	if tlsMode == models.TLSSSL || tlsMode == models.TLSStartTLS {
		var err error
		if tlsConfig, out, err = buildTLSConfig(profile, host); err != nil {
			return nil, nil, err
		}
	}
	// certFailure returns the certificate error recorded by the handshake,
	// which go-ldap does not keep in its error chain.
	certFailure := func(err error) error {
		if out != nil && out.certErr != nil {
			return out.certErr
		}
		return err
	}

	switch tlsMode {
	case models.TLSSSL:
		conn, err := goldap.DialURL("ldaps://"+address, goldap.DialWithDialer(dialer), goldap.DialWithTLSConfig(tlsConfig))
		if err != nil {
			return nil, out, certFailure(err)
		}
		conn.SetTimeout(timeout)
		return conn, out, nil

	case models.TLSStartTLS:
		// DialURL hides the socket, but the StartTLS handshake is only bounded
		// by a socket deadline, so dial the socket here and wrap it.
		raw, err := dialer.Dial("tcp", address)
		if err != nil {
			return nil, out, goldap.NewError(goldap.ErrorNetwork, err)
		}
		// The deadline bounds the StartTLS exchange and the handshake. The
		// per-request timeout is set only afterwards: its timer would block
		// go-ldap's message loop during a stalled handshake and delay the
		// error by another timeout.
		conn := goldap.NewConn(raw, false)
		conn.Start()
		_ = raw.SetDeadline(time.Now().Add(timeout))
		if err := conn.StartTLS(tlsConfig); err != nil {
			conn.Close()
			if cerr := certFailure(nil); cerr != nil {
				return nil, out, cerr
			}
			return nil, out, fmt.Errorf("StartTLS failed: %w", err)
		}
		_ = raw.SetDeadline(time.Time{})
		conn.SetTimeout(timeout)
		return conn, out, nil

	default:
		conn, err := goldap.DialURL("ldap://"+address, goldap.DialWithDialer(dialer))
		if err != nil {
			return nil, nil, err
		}
		conn.SetTimeout(timeout)
		return conn, nil, nil
	}
}

// dialErrorDetail describes a dialServer error, naming the timeout when the
// dial or handshake ran into it.
func dialErrorDetail(err error, profile models.ConnectionProfile) string {
	detail := ldapErrorDetail(err)
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		detail += fmt.Sprintf(" (timeout %s)", profileTimeout(profile))
	}
	return detail
}

// connectFailure wraps a dialServer error as ErrConnectionFailed. Certificate
// and settings errors stay reachable with errors.As.
func connectFailure(err error, profile models.ConnectionProfile) error {
	var certErr *CertificateError
	var cfgErr *AuthConfigError
	switch {
	case errors.As(err, &certErr):
		return fmt.Errorf("%w: %w", ErrConnectionFailed, certErr)
	case errors.As(err, &cfgErr):
		return fmt.Errorf("%w: %w", ErrConnectionFailed, cfgErr)
	}
	return fmt.Errorf("%w: %s", ErrConnectionFailed, dialErrorDetail(err, profile))
}

// address returns host:port of the client's server.
func (c *Client) address() string {
	p := c.Profile()
	return net.JoinHostPort(p.Host, strconv.Itoa(p.Port))
}

// dialInfo describes how a connection was established (or how far it got).
type dialInfo struct {
	tls         *tlsOutcome // nil without TLS
	authSummary string      // see bindConnHost
	stage       string      // failure stage: "config", "tls", "connect" or "bind"
}

// dial opens and binds a new connection for the client's profile without
// touching the client's current connection.
func (c *Client) dial() (*goldap.Conn, error) {
	conn, _, err := c.dialDetailed()
	return conn, err
}

// dialDetailed is dial that also reports TLS verification and bind details.
func (c *Client) dialDetailed() (*goldap.Conn, *dialInfo, error) {
	start := time.Now()
	address := c.address()
	p := c.Profile()
	info := &dialInfo{}

	conn, out, err := dialServerTLS(p, p.Host, strconv.Itoa(p.Port), p.TLSMode)
	info.tls = out
	if err != nil {
		var certErr *CertificateError
		var cfgErr *AuthConfigError
		var pbe *preBindError
		switch {
		case errors.As(err, &pbe):
			// NTLM bound while dialing (see dialServerNTLM).
			info.stage, info.authSummary = "bind", pbe.summary
			bindErr := bindFailure(pbe.err, pbe.summary)
			c.logger.Log("BIND", fmt.Sprintf("%s to %s", pbe.summary, address), time.Since(start), bindErr)
			return nil, info, bindErr
		case errors.As(err, &cfgErr):
			info.stage = "config"
		case errors.As(err, &certErr):
			info.stage = "tls"
		default:
			info.stage = "connect"
			if rej := clientCertRejection(err, out); rej != nil {
				info.stage = "tls"
				return nil, info, fmt.Errorf("%w: %w", ErrConnectionFailed, rej)
			}
		}
		return nil, info, connectFailure(err, p)
	}

	summary, err := bindConnHost(conn, p, p.Host)
	info.authSummary = summary
	if err != nil {
		conn.Close()
		if rej := clientCertRejection(err, out); rej != nil {
			// TLS 1.3 servers reject a client certificate after the
			// handshake, so it surfaces on the first request (the bind).
			info.stage = "tls"
			rerr := fmt.Errorf("%w: %w", ErrConnectionFailed, rej)
			c.logger.Log("BIND", fmt.Sprintf("%s to %s", summary, address), time.Since(start), rerr)
			return nil, info, rerr
		}
		info.stage = "bind"
		var cfgErr *AuthConfigError
		if errors.As(err, &cfgErr) {
			info.stage = "config"
		}
		bindErr := bindFailure(err, summary)
		c.logger.Log("BIND", fmt.Sprintf("%s to %s", summary, address), time.Since(start), bindErr)
		return nil, info, bindErr
	}
	return conn, info, nil
}

// reconnectCall is a reconnect in progress; concurrent callers wait on done
// and share its result.
type reconnectCall struct {
	dead *goldap.Conn
	done chan struct{}
	conn *goldap.Conn
	err  error
}

// getConn returns the current connection. A connection that is already known
// to be dead is re-established before it is handed out.
func (c *Client) getConn(ctx context.Context) (*goldap.Conn, error) {
	c.mu.Lock()
	conn, closed := c.conn, c.closed
	c.mu.Unlock()

	if conn == nil || closed {
		return nil, ErrNotConnected
	}
	if !conn.IsClosing() {
		return conn, nil
	}
	return c.reconnectFrom(ctx, conn)
}

// reconnectFrom replaces the dead connection with a freshly dialed and bound
// one. Concurrent callers share a single reconnect. The dial runs detached
// from ctx so that one caller giving up does not fail the others.
func (c *Client) reconnectFrom(ctx context.Context, dead *goldap.Conn) (*goldap.Conn, error) {
	c.mu.Lock()
	if c.closed || c.conn == nil {
		c.mu.Unlock()
		return nil, ErrNotConnected
	}
	if c.conn != dead && !c.conn.IsClosing() {
		// Someone else already replaced the dead connection.
		conn := c.conn
		c.mu.Unlock()
		return conn, nil
	}
	call := c.reconnecting
	if call == nil {
		call = &reconnectCall{dead: c.conn, done: make(chan struct{})}
		c.reconnecting = call
		go c.runReconnect(call)
	}
	c.mu.Unlock()

	select {
	case <-call.done:
		return call.conn, call.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// runReconnect performs the dial and bind for call and publishes the result.
func (c *Client) runReconnect(call *reconnectCall) {
	start := time.Now()
	conn, err := c.dial()

	var stale *goldap.Conn
	c.mu.Lock()
	c.reconnecting = nil
	switch {
	case err != nil:
	case c.closed || c.conn == nil:
		// Closed while dialing: do not resurrect the connection.
		stale, conn, err = conn, nil, ErrNotConnected
	case c.conn != call.dead && !c.conn.IsClosing():
		// Connect installed a fresh connection meanwhile; keep that one.
		stale, conn = conn, c.conn
	default:
		stale = c.conn
		c.conn = conn
		c.serverInfo = nil
		c.pwHashing = nil
	}
	call.conn, call.err = conn, err
	close(call.done)
	c.mu.Unlock()

	if stale != nil {
		stale.Close()
	}
	if errors.Is(err, ErrNotConnected) {
		return
	}
	if err != nil {
		c.logger.Log("RECONNECT", fmt.Sprintf("Connection to %s lost, reconnect failed", c.address()), time.Since(start), err)
		return
	}
	p := c.Profile()
	// The timeout may have changed while dialing (applySettings).
	conn.SetTimeout(profileTimeout(p))
	c.logger.Log("RECONNECT", fmt.Sprintf("Connection to %s lost, reconnected (TLS: %s, Auth: %s)", c.address(), p.TLSMode, p.AuthMethod), time.Since(start), nil)
}

// run executes op on the current connection. If op fails because the
// connection died, the connection is re-established and op is retried once:
// always for reads, for writes only when the request provably never reached
// the server. op must return go-ldap errors unwrapped so they can be
// classified, and must reset any state it accumulates when it starts.
func (c *Client) run(ctx context.Context, write bool, op func(conn *goldap.Conn) error) error {
	conn, err := c.getConn(ctx)
	if err != nil {
		return err
	}
	err = op(conn)
	if !isConnDead(conn, err) || ctx.Err() != nil {
		return err
	}
	if write && !requestNotSent(err) {
		// The server may already have applied the change, so it is not
		// repeated. Close the broken connection so that the next operation
		// re-dials instead of failing the same way.
		go conn.Close()
		return err
	}
	conn, rerr := c.reconnectFrom(ctx, conn)
	if rerr != nil {
		return rerr
	}
	return op(conn)
}

// read runs a read-only operation, see run.
func (c *Client) read(op func(conn *goldap.Conn) error) error {
	return c.run(context.Background(), false, op)
}

// write runs a modifying operation, see run. It fails with ErrReadOnly
// without contacting the server if the profile is read-only.
func (c *Client) write(op func(conn *goldap.Conn) error) error {
	if err := c.CheckWritable(); err != nil {
		return err
	}
	return c.run(context.Background(), true, op)
}

// deadConnMessages are error texts go-ldap produces when the connection is gone.
var deadConnMessages = []string{
	"ldap: connection closed",             // request issued on a closing connection
	"ldap: connection is closed",          // unbind on a closed connection
	"response channel closed",             // connection torn down while waiting
	"unable to read LDAP response packet", // reader hit EOF or a reset
	"unable to send request",              // socket write failed
	"could not send message",
	"broken pipe",
	"connection reset",
}

// isConnDead reports whether err, returned by an operation on conn, means
// that conn is unusable and has to be re-established.
func isConnDead(conn *goldap.Conn, err error) bool {
	if err == nil {
		return false
	}
	var privErr *privateConnError
	if errors.As(err, &privErr) {
		// Failed on a temporary connection; conn itself is fine.
		return false
	}
	var ldapErr *goldap.Error
	if errors.As(err, &ldapErr) && ldapErr.ResultCode < goldap.ErrorNetwork {
		// The server answered; the result is genuine.
		return false
	}
	msg := err.Error()
	if strings.Contains(msg, "connection timed out") || strings.Contains(msg, "size limit exceeded") {
		// Reported as network errors by go-ldap, but the connection survives.
		return false
	}
	if conn != nil && conn.IsClosing() {
		return true
	}
	if goldap.IsErrorWithCode(err, goldap.ErrorNetwork) || errors.Is(err, goldap.ErrNilConnection) {
		return true
	}
	for _, s := range deadConnMessages {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// requestNotSent reports whether err guarantees that the request never
// reached the server, which makes even a non-idempotent write safe to retry.
func requestNotSent(err error) bool {
	if errors.Is(err, goldap.ErrNilConnection) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "ldap: connection closed") ||
		strings.Contains(msg, "unable to send request") ||
		strings.Contains(msg, "could not send message")
}

// tlsDescription describes the transport security of a connection made
// with mode, e.g. "TLS: ssl, certificate pinned".
func (i *dialInfo) tlsDescription(mode models.TLSMode) string {
	if mode == "" {
		mode = models.TLSNone
	}
	s := "TLS: " + string(mode)
	if i.tls != nil && i.tls.verification != "" {
		s += ", certificate " + verificationLabel(i.tls.verification)
	}
	return s
}

// verificationLabel describes a models.TLSVerify* mode.
func verificationLabel(v string) string {
	switch v {
	case models.TLSVerifySystem:
		return "verified (system trust store)"
	case models.TLSVerifyCustomCA:
		return "verified (custom CA)"
	case models.TLSVerifyPinned:
		return "pinned"
	case models.TLSVerifySkipped:
		return "NOT verified (verification disabled)"
	}
	return v
}
