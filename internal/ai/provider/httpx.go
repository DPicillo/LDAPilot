package provider

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// Timeouts (§3.7).
const (
	dialTimeout             = 10 * time.Second
	tlsHandshakeTimeout     = 10 * time.Second
	idleConnTimeout         = 90 * time.Second
	loopbackHeaderTimeout   = 10 * time.Minute
	defaultRemoteHeaderTime = 120 * time.Second
	streamIdleTimeout       = 120 * time.Second
	remoteCallCap           = 10 * time.Minute
	loopbackCallCap         = 20 * time.Minute
	maxLineBytes            = 8 << 20
	maxJSONBody             = 32 << 20
	discoveryTimeout        = 15 * time.Second
)

// HTTPOptions configure the HTTP client of a provider instance.
type HTTPOptions struct {
	BaseURL        string
	TLSSkipVerify  bool
	RequestTimeout time.Duration // remote response-header timeout (0 = 120 s)
}

// NewHTTPClient builds the provider HTTP client: dial/TLS timeouts of 10 s,
// a response-header timeout (10 min for loopback endpoints, which send
// headers only after loading the model; RequestTimeout otherwise), the
// environment proxy except for loopback hosts, and no overall
// Client.Timeout because streams are long-lived.
func NewHTTPClient(o HTTPOptions) *http.Client {
	loop := ai.IsLoopbackURL(o.BaseURL)
	header := o.RequestTimeout
	if header <= 0 {
		header = defaultRemoteHeaderTime
	}
	if loop {
		header = loopbackHeaderTimeout
	}
	proxy := http.ProxyFromEnvironment
	if loop {
		proxy = nil
	}
	tr := &http.Transport{
		Proxy:                 proxy,
		DialContext:           (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   tlsHandshakeTimeout,
		ResponseHeaderTimeout: header,
		IdleConnTimeout:       idleConnTimeout,
		MaxIdleConnsPerHost:   4,
		ForceAttemptHTTP2:     true,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: o.TLSSkipVerify}, //nolint:gosec // user opt-in, warned in settings
	}
	return &http.Client{Transport: tr}
}

// endpointKey returns scheme://host:port of a URL (the limiter key).
func endpointKey(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return strings.ToLower(u.Scheme + "://" + u.Hostname() + ":" + port)
}

// isOllamaEndpoint reports whether the URL is a typical Ollama port.
func isOllamaPort(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Port() == "11434"
}

// lineReader reads newline-terminated lines of up to maxLineBytes with a
// bufio.Reader (not a Scanner with its 64 KB default).
type lineReader struct {
	r   *bufio.Reader
	buf []byte
}

func newLineReader(r io.Reader) *lineReader {
	return &lineReader{r: bufio.NewReaderSize(r, 64<<10)}
}

var errLineTooLong = errors.New("stream line exceeds 8 MB")

// next returns the next line without the trailing "\n" / "\r\n". At EOF it
// returns the last unterminated line (if any) with a nil error, then io.EOF.
func (l *lineReader) next() ([]byte, error) {
	l.buf = l.buf[:0]
	for {
		chunk, err := l.r.ReadSlice('\n')
		l.buf = append(l.buf, chunk...)
		if len(l.buf) > maxLineBytes {
			return nil, errLineTooLong
		}
		if err == nil {
			line := bytes.TrimRight(l.buf, "\r\n")
			return line, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) && len(l.buf) > 0 {
			return bytes.TrimRight(l.buf, "\r\n"), nil
		}
		return nil, err
	}
}

// sseReader yields the data payloads of a Server-Sent Events stream. It
// accepts "data:" with or without a space and ignores event:, id:, retry:
// and comment lines. A data line holding complete JSON or [DONE] is
// dispatched immediately (some servers omit the blank separator line);
// otherwise data lines are joined until a blank line.
type sseReader struct {
	lr      *lineReader
	pending []byte
	has     bool
}

func newSSEReader(r io.Reader) *sseReader { return &sseReader{lr: newLineReader(r)} }

// next returns the next event payload, or io.EOF.
func (s *sseReader) next() ([]byte, error) {
	for {
		line, err := s.lr.next()
		if err != nil {
			if s.has {
				s.has = false
				return s.pending, nil
			}
			return nil, err
		}
		if len(line) == 0 {
			if s.has {
				s.has = false
				out := s.pending
				s.pending = nil
				return out, nil
			}
			continue
		}
		if line[0] == ':' {
			continue
		}
		field, value := line, []byte(nil)
		if i := bytes.IndexByte(line, ':'); i >= 0 {
			field, value = line[:i], line[i+1:]
			if len(value) > 0 && value[0] == ' ' {
				value = value[1:]
			}
		}
		if string(field) != "data" {
			continue
		}
		if !s.has {
			trimmed := bytes.TrimSpace(value)
			if string(trimmed) == "[DONE]" || (len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') && jsonComplete(trimmed)) {
				return append([]byte(nil), trimmed...), nil
			}
			s.pending = append(s.pending[:0], value...)
			s.has = true
			continue
		}
		s.pending = append(s.pending, '\n')
		s.pending = append(s.pending, value...)
	}
}

// jsonComplete is a cheap validity check used to dispatch single-line
// events early.
func jsonComplete(b []byte) bool {
	depth := 0
	inStr, esc := false, false
	for _, c := range b {
		if inStr {
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{', '[':
			depth++
		case '}', ']':
			depth--
		}
	}
	return depth == 0 && !inStr
}

// watchdog aborts a stream when no body byte arrives for idle, and caps the
// whole call at hard. It cancels the request context with a cause.
type watchdog struct {
	clock  ai.Clock
	idle   time.Duration
	last   atomic.Int64 // unix nanos of the last activity
	stopCh chan struct{}
	once   sync.Once
	done   chan struct{}
}

var (
	errIdleTimeout = errors.New("no data from the model for too long")
	errCallTimeout = errors.New("the model call took too long")
)

func startWatchdog(ctx context.Context, cancel context.CancelCauseFunc, clock ai.Clock, idle, hard time.Duration) *watchdog {
	w := &watchdog{clock: clock, idle: idle, stopCh: make(chan struct{}), done: make(chan struct{})}
	w.last.Store(clock.Now().UnixNano())
	idleT := clock.NewTimer(idle)
	hardT := clock.NewTimer(hard)
	go func() {
		defer close(w.done)
		defer idleT.Stop()
		defer hardT.Stop()
		for {
			select {
			case <-w.stopCh:
				return
			case <-ctx.Done():
				return
			case <-hardT.C():
				cancel(errCallTimeout)
				return
			case <-idleT.C():
				since := clock.Now().Sub(time.Unix(0, w.last.Load()))
				if since >= idle {
					cancel(errIdleTimeout)
					return
				}
				idleT.Reset(idle - since)
			}
		}
	}()
	return w
}

func (w *watchdog) touch() { w.last.Store(w.clock.Now().UnixNano()) }

func (w *watchdog) stop() {
	w.once.Do(func() { close(w.stopCh) })
	<-w.done
}

// activityReader marks the watchdog on every successful read.
type activityReader struct {
	r io.Reader
	w *watchdog
}

func (a *activityReader) Read(p []byte) (int, error) {
	n, err := a.r.Read(p)
	if n > 0 {
		a.w.touch()
	}
	return n, err
}

// call is one in-flight streaming HTTP request with watchdog and cleanup.
type call struct {
	resp   *http.Response
	body   io.Reader
	ctx    context.Context
	cancel context.CancelCauseFunc
	wd     *watchdog
}

func (c *call) close() {
	if c.wd != nil {
		c.wd.stop()
	}
	if c.resp != nil {
		_ = c.resp.Body.Close()
	}
	c.cancel(nil)
}

// streamErr converts a read error into the right error: context
// cancellation by the caller, watchdog timeouts, or an interrupted stream.
func (c *call) streamErr(parent context.Context, err error, scrub Scrubber) error {
	if parent.Err() != nil {
		return parent.Err()
	}
	if cause := context.Cause(c.ctx); cause != nil && (errors.Is(cause, errIdleTimeout) || errors.Is(cause, errCallTimeout)) {
		return &Error{Code: ai.CodeTimeout, Message: cause.Error() + ".", Retryable: true, err: cause}
	}
	return interruptedError(err, scrub)
}

// doer is the part of the provider shared by the HTTP adapters.
type httpBase struct {
	baseURL string
	client  *http.Client
	clock   ai.Clock
	scrub   Scrubber
	loop    bool
}

// do sends req and returns the response once headers arrived. Non-2xx
// responses are converted to *Error (body read and closed). The returned
// call owns a derived context, a watchdog and the response body.
func (h *httpBase) do(parent context.Context, build func(ctx context.Context) (*http.Request, error), beforeHeaders func() func()) (*call, error) {
	ctx, cancel := context.WithCancelCause(parent)
	req, err := build(ctx)
	if err != nil {
		cancel(nil)
		return nil, err
	}
	var stopStatus func()
	if beforeHeaders != nil {
		stopStatus = beforeHeaders()
	}
	resp, err := h.client.Do(req)
	if stopStatus != nil {
		stopStatus()
	}
	if err != nil {
		cancel(nil)
		return nil, transportError(parent, err, h.baseURL, h.scrub)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		body := readErrorBody(resp.Body)
		_ = resp.Body.Close()
		cancel(nil)
		return nil, newHTTPError(resp, body, h.scrub, h.clock)
	}
	hard := remoteCallCap
	if h.loop {
		hard = loopbackCallCap
	}
	c := &call{resp: resp, ctx: ctx, cancel: cancel}
	c.wd = startWatchdog(ctx, cancel, h.clock, streamIdleTimeout, hard)
	c.body = &activityReader{r: resp.Body, w: c.wd}
	return c, nil
}

// getJSON performs a GET (or POST when body != nil) for discovery and
// decodes a JSON response of at most 32 MB.
func (h *httpBase) getJSON(ctx context.Context, method, u string, body []byte, headers map[string]string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, discoveryTimeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return transportError(ctx, err, h.baseURL, h.scrub)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return newHTTPError(resp, readErrorBody(resp.Body), h.scrub, h.clock)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONBody))
	if err != nil {
		return transportError(ctx, err, h.baseURL, h.scrub)
	}
	if err := jsonUnmarshal(data, out); err != nil {
		return &Error{Code: ai.CodeBadRequest, Message: fmt.Sprintf("Unexpected response from %s: %v", u, err)}
	}
	return nil
}
