package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

const (
	maxErrorBodyRead = 64 << 10
	maxErrorShown    = 2 << 10
)

// Scrubber removes secrets from strings before they are logged or shown.
type Scrubber struct{ secrets []string }

// NewScrubber returns a scrubber for the given secrets (empty ones ignored).
func NewScrubber(secrets ...string) Scrubber {
	var s Scrubber
	for _, x := range secrets {
		if len(x) >= 4 {
			s.secrets = append(s.secrets, x)
		}
	}
	return s
}

var userinfoRe = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]+(:[^/\s@]*)?@`)
var bearerRe = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}`)

// Scrub replaces secrets and URL userinfo with "***".
func (s Scrubber) Scrub(text string) string {
	for _, x := range s.secrets {
		text = strings.ReplaceAll(text, x, "***")
	}
	text = userinfoRe.ReplaceAllString(text, "${1}***@")
	text = bearerRe.ReplaceAllString(text, "${1}***")
	return text
}

// truncateRunes cuts s to at most n bytes on a rune boundary.
func truncateRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

// readErrorBody reads at most 64 KB of an error response body.
func readErrorBody(r io.Reader) []byte {
	b, _ := io.ReadAll(io.LimitReader(r, maxErrorBodyRead))
	return b
}

// errorFields is the union of the error envelopes we understand:
// OpenAI/LiteLLM/vLLM/Anthropic {"error":{...}}, Ollama {"error":"..."}.
type errorFields struct {
	Message string
	Type    string
	Code    string
	Param   string
	Detail  string // Anthropic error.details.error_code
}

func parseErrorFields(body []byte) (errorFields, bool) {
	var env struct {
		Error   json.RawMessage `json:"error"`
		Message string          `json:"message"`
		Detail  json.RawMessage `json:"detail"`
	}
	trimmed := strings.TrimSpace(string(body))
	if !strings.HasPrefix(trimmed, "{") || json.Unmarshal([]byte(trimmed), &env) != nil {
		return errorFields{}, false
	}
	var f errorFields
	if len(env.Error) > 0 {
		var s string
		if json.Unmarshal(env.Error, &s) == nil {
			f.Message = s
			return f, true
		}
		var obj struct {
			Message string          `json:"message"`
			Type    string          `json:"type"`
			Code    json.RawMessage `json:"code"`
			Param   json.RawMessage `json:"param"`
			Details struct {
				ErrorCode string `json:"error_code"`
			} `json:"details"`
		}
		if json.Unmarshal(env.Error, &obj) == nil {
			f.Message, f.Type, f.Detail = obj.Message, obj.Type, obj.Details.ErrorCode
			f.Code = rawScalar(obj.Code)
			f.Param = rawScalar(obj.Param)
			return f, true
		}
	}
	if env.Message != "" {
		f.Message = env.Message
		return f, true
	}
	if len(env.Detail) > 0 { // FastAPI style (vLLM, some gateways)
		var s string
		if json.Unmarshal(env.Detail, &s) == nil {
			f.Message = s
		} else {
			f.Message = string(env.Detail)
		}
		return f, true
	}
	return f, false
}

func rawScalar(r json.RawMessage) string {
	if len(r) == 0 || string(r) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(r, &s) == nil {
		return s
	}
	return strings.Trim(string(r), `"`)
}

var (
	contextTokensRe   = regexp.MustCompile(`request \((\d+) tokens\)`)
	contextPatternsRe = regexp.MustCompile(`(?i)exceeds the available context size|context_length_exceeded|maximum context length|context window|prompt is too long|too many tokens|input is too long|reduce the length`)
)

// newHTTPError builds an *Error from a non-2xx response.
func newHTTPError(resp *http.Response, body []byte, scrub Scrubber, clock ai.Clock) *Error {
	f, ok := parseErrorFields(body)
	msg := f.Message
	if !ok || msg == "" {
		msg = strings.TrimSpace(string(body))
	}
	msg = truncateRunes(scrub.Scrub(msg), maxErrorShown)
	e := &Error{
		Status:    resp.StatusCode,
		Type:      f.Type,
		Message:   msg,
		Param:     f.Param,
		RequestID: requestID(resp.Header),
		Body:      truncateRunes(scrub.Scrub(string(body)), maxErrorBodyRead),
	}
	e.RetryAfter = parseRetryAfter(resp.Header, clock)
	classify(e, f)
	return e
}

func requestID(h http.Header) string {
	for _, k := range []string{"request-id", "x-request-id", "anthropic-request-id"} {
		if v := h.Get(k); v != "" {
			return v
		}
	}
	return ""
}

// classify sets Code and Retryable from the status and the error fields.
func classify(e *Error, f errorFields) {
	text := e.Message + " " + f.Type + " " + f.Code
	switch {
	case e.Status == 400 || e.Status == 413 || f.Code == "context_length_exceeded":
		if contextPatternsRe.MatchString(text) {
			e.Code = ai.CodeContextExceeded
			if m := contextTokensRe.FindStringSubmatch(e.Message); m != nil {
				e.ContextTokens, _ = strconv.Atoi(m[1])
			}
			return
		}
		e.Code = ai.CodeBadRequest
		if e.Status == 0 {
			e.Status = 400
		}
	case e.Status == 401 || e.Status == 403:
		e.Code = ai.CodeAuthFailed
		if e.Message == "" {
			e.Message = "The provider rejected the API key."
		}
	case e.Status == 404:
		if strings.Contains(strings.ToLower(text), "model") {
			e.Code = ai.CodeModelNotFound
		} else {
			e.Code = ai.CodeBadRequest
			e.Message = fmt.Sprintf("The server returned 404 (%s). Check the URL; OpenAI-compatible endpoints usually end in /v1.", e.Message)
		}
	case e.Status == 408:
		e.Code, e.Retryable = ai.CodeTimeout, true
	case e.Status == 409:
		e.Code, e.Retryable = ai.CodeOverloaded, true
	case e.Status == 429:
		e.Code, e.Retryable = ai.CodeRateLimited, true
		if f.Detail == "enforced_spend_limit_reached" || strings.Contains(e.Body, "enforced_spend_limit_reached") {
			e.Retryable = false
		}
	case e.Status == 503 || e.Status == 529:
		e.Code, e.Retryable = ai.CodeOverloaded, true
	case e.Status == 500 || e.Status == 502 || e.Status == 504:
		e.Code, e.Retryable = ai.CodeProviderUnreachable, true
	case e.Status == 402:
		e.Code = ai.CodeBadRequest
	default:
		switch f.Type {
		case "overloaded_error":
			e.Code, e.Retryable = ai.CodeOverloaded, true
		case "api_error":
			e.Code, e.Retryable = ai.CodeProviderUnreachable, true
		case "rate_limit_error":
			e.Code, e.Retryable = ai.CodeRateLimited, true
		case "authentication_error", "permission_error":
			e.Code = ai.CodeAuthFailed
		case "not_found_error":
			e.Code = ai.CodeModelNotFound
		default:
			if contextPatternsRe.MatchString(text) {
				e.Code = ai.CodeContextExceeded
				if m := contextTokensRe.FindStringSubmatch(e.Message); m != nil {
					e.ContextTokens, _ = strconv.Atoi(m[1])
				}
			} else if e.Code == "" {
				e.Code = ai.CodeBadRequest
			}
		}
	}
	if e.Code == ai.CodeModelNotFound && e.Message == "" {
		e.Message = "The model was not found on the server."
	}
}

// streamError builds an *Error from an error object received inside a
// stream (HTTP status 200 already sent).
func streamError(raw []byte, scrub Scrubber, reqID string) *Error {
	f, _ := parseErrorFields(raw)
	if f.Message == "" {
		f.Message = strings.TrimSpace(string(raw))
	}
	e := &Error{Type: f.Type, Message: truncateRunes(scrub.Scrub(f.Message), maxErrorShown), Param: f.Param, RequestID: reqID, Body: truncateRunes(scrub.Scrub(string(raw)), maxErrorBodyRead)}
	if n, err := strconv.Atoi(f.Code); err == nil && n >= 400 && n < 600 {
		e.Status = n
	}
	classify(e, f)
	return e
}

// parseRetryAfter reads retry-after-ms or Retry-After (seconds or HTTP date).
func parseRetryAfter(h http.Header, clock ai.Clock) time.Duration {
	if v := strings.TrimSpace(h.Get("retry-after-ms")); v != "" {
		if ms, err := strconv.ParseFloat(v, 64); err == nil && ms >= 0 {
			return time.Duration(ms * float64(time.Millisecond))
		}
	}
	v := strings.TrimSpace(h.Get("Retry-After"))
	if v == "" {
		return 0
	}
	if secs, err := strconv.ParseFloat(v, 64); err == nil && secs >= 0 {
		return time.Duration(secs * float64(time.Second))
	}
	if t, err := http.ParseTime(v); err == nil {
		now := time.Now()
		if clock != nil {
			now = clock.Now()
		}
		if d := t.Sub(now); d > 0 {
			return d
		}
		return 0
	}
	return 0
}

// transportError maps an error from http.Client.Do (before any response
// byte) to a retryable *Error. Context cancellation is returned unchanged.
// The message names host:port and the cause in words (UX A-19: "connection
// refused" must not read like a stopped answer or a context problem).
func transportError(ctx context.Context, err error, base string, scrub Scrubber) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	host := hostPort(base)
	e := &Error{Code: ai.CodeProviderUnreachable, Retryable: true, err: err}
	cause := scrub.Scrub(rootCause(err))
	var ne net.Error
	var dnsErr *net.DNSError
	low := strings.ToLower(cause)
	switch {
	case errors.As(err, &dnsErr) || strings.Contains(low, "no such host"):
		e.Message = fmt.Sprintf("The AI provider's host name in %s could not be resolved (%s). Check the URL in the AI settings.", host, cause)
	case strings.Contains(low, "connection refused"):
		e.Message = fmt.Sprintf("Nothing is listening at %s (connection refused). Check that the AI server is running and the URL in the AI settings is right.", host)
	case errors.As(err, &ne) && ne.Timeout():
		e.Code = ai.CodeTimeout
		if strings.Contains(low, "dial") || strings.Contains(low, "connect") {
			e.Message = fmt.Sprintf("No connection to %s: the connection attempt timed out (%s). Check the URL, the network and firewalls.", host, cause)
		} else {
			e.Message = fmt.Sprintf("No response from %s in time (%s).", host, cause)
		}
	case strings.Contains(low, "network is unreachable") || strings.Contains(low, "no route to host") || strings.Contains(low, "host is unreachable"):
		e.Message = fmt.Sprintf("%s is not reachable from this computer (%s).", host, cause)
	case strings.Contains(low, "certificate") || strings.Contains(low, "x509") || strings.Contains(low, "tls:"):
		e.Message = fmt.Sprintf("The TLS connection to %s failed: %s", host, cause)
	case strings.Contains(low, "connection reset") || strings.Contains(low, "eof"):
		e.Message = fmt.Sprintf("%s closed the connection (%s). Is the URL pointing at the AI server (http vs https, port)?", host, cause)
	default:
		e.Message = fmt.Sprintf("Cannot reach %s: %s", host, cause)
	}
	return e
}

// hostPort returns host:port of a base URL, with the scheme's default port
// when the URL names none.
func hostPort(base string) string {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return base
	}
	if u.Port() != "" {
		return u.Host
	}
	switch strings.ToLower(u.Scheme) {
	case "http":
		return net.JoinHostPort(u.Hostname(), "80")
	case "https":
		return net.JoinHostPort(u.Hostname(), "443")
	}
	return u.Host
}

// IsReachabilityError reports provider errors that every request to the
// endpoint would hit (not reachable, timed out, credentials rejected): a
// run reports them instead of guessing model capabilities.
func IsReachabilityError(err error) bool {
	var pe *Error
	if !errors.As(err, &pe) {
		return false
	}
	switch pe.Code {
	case ai.CodeProviderUnreachable, ai.CodeTimeout, ai.CodeAuthFailed:
		return true
	}
	return false
}

func rootCause(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err.Error()
	}
	return err.Error()
}

// interruptedError reports a stream that ended without a terminal marker.
func interruptedError(cause error, scrub Scrubber) *Error {
	msg := "The response stream ended unexpectedly."
	if cause != nil && !errors.Is(cause, io.EOF) {
		msg = "The response stream was interrupted: " + scrub.Scrub(cause.Error())
	}
	return &Error{Code: ai.CodeStreamInterrupted, Message: msg, Retryable: true, err: cause}
}
