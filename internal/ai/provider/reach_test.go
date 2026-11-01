package provider

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// closedAddr returns a loopback address nothing listens on.
func closedAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	return addr
}

// UX A-19: an unreachable endpoint is reported as such (host:port and the
// cause), and ModelCaps returns that error instead of guessed caps.
func TestReachabilityErrorsAreSpecific(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	addr := closedAddr(t)
	for _, kind := range []string{KindOllama, KindOpenAI} {
		p, err := NewUnwrapped(Options{Kind: kind, Flavor: FlavorCustom, BaseURL: "http://" + addr})
		if err != nil {
			t.Fatal(err)
		}
		_, err = p.ListModels(ctx)
		var pe *Error
		if !errors.As(err, &pe) || pe.Code != ai.CodeProviderUnreachable || !IsReachabilityError(err) {
			t.Fatalf("%s: %v", kind, err)
		}
		if !strings.Contains(pe.Message, addr) || !strings.Contains(pe.Message, "connection refused") {
			t.Errorf("%s: message %q", kind, pe.Message)
		}
		if _, err := p.ModelCaps(ctx, "some-model"); !IsReachabilityError(err) {
			t.Errorf("%s: ModelCaps hid the error: %v", kind, err)
		}
	}
	p, _ := NewUnwrapped(Options{Kind: KindOllama, BaseURL: "http://ldapilot-test.invalid:11434"})
	if _, err := p.ListModels(ctx); err == nil || !strings.Contains(err.Error(), "could not be resolved") || !strings.Contains(err.Error(), "ldapilot-test.invalid:11434") {
		t.Errorf("dns: %v", err)
	}
}

func TestAuthErrorIsReachabilityError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}`))
	}))
	defer srv.Close()
	p, _ := NewUnwrapped(Options{Kind: KindOpenAI, Flavor: FlavorCustom, BaseURL: srv.URL + "/v1", APIKey: "sk-test-123456"})
	_, err := p.ModelCaps(context.Background(), "gpt-x")
	var pe *Error
	if !errors.As(err, &pe) || pe.Code != ai.CodeAuthFailed || pe.Status != 401 {
		t.Fatalf("%v", err)
	}
}

func TestHostPort(t *testing.T) {
	for in, want := range map[string]string{
		"http://localhost:11434": "localhost:11434", "https://api.openai.com/v1": "api.openai.com:443",
		"http://10.0.0.5/v1": "10.0.0.5:80", "http://[::1]:8080": "[::1]:8080",
	} {
		if got := hostPort(in); got != want {
			t.Errorf("hostPort(%q) = %q, want %q", in, got, want)
		}
	}
}

// UX A-19: a discovery that runs into its deadline (a hanging connect)
// names host:port instead of only "timed out".
func TestDiscoverTimeoutNamesHost(t *testing.T) {
	cache := OpenDiscoveryCache("", nil)
	d := Discover(context.Background(), cache, DiscoverRequest{CacheKey: "k", ProviderKey: "ollama", BaseURL: "http://localhost:11999", Kind: KindOllama,
		List: func(ctx context.Context) ([]ai.ModelInfo, error) { return nil, context.DeadlineExceeded }})
	if !strings.Contains(d.Error, "localhost:11999") || !strings.Contains(d.Error, "timed out") {
		t.Fatalf("error %q", d.Error)
	}
}

// A dial timeout reaches discovery as the transport error, with its words.
func TestDiscoverDialTimeoutWords(t *testing.T) {
	cache := OpenDiscoveryCache("", nil)
	terr := transportError(context.Background(), &net.OpError{Op: "dial", Net: "tcp", Err: timeoutErr{}}, "http://localhost:11999", Scrubber{})
	d := Discover(context.Background(), cache, DiscoverRequest{CacheKey: "k2", ProviderKey: "ollama", BaseURL: "http://localhost:11999", Kind: KindOllama,
		List: func(ctx context.Context) ([]ai.ModelInfo, error) { return nil, terr }})
	if !strings.Contains(d.Error, "No connection to localhost:11999") {
		t.Fatalf("error %q", d.Error)
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

// A-19 review: Discover classifies its error, so the composer blocks a run
// only when the endpoint did not answer (a 403 on /models, e.g. a key
// without permission for the model list, does not block).
func TestDiscoverErrorCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(403)
		_, _ = w.Write([]byte(`{"error":{"message":"You have insufficient permissions for this operation. Missing scopes: api.model.read","type":"invalid_request_error"}}`))
	}))
	defer srv.Close()
	cache := OpenDiscoveryCache("", nil)
	discover := func(base string) ai.ModelDiscovery {
		p, _ := NewUnwrapped(Options{Kind: KindOpenAI, Flavor: FlavorCustom, BaseURL: base, APIKey: "sk-test-123456"})
		return Discover(context.Background(), cache, DiscoverRequest{CacheKey: base, ProviderKey: p.Key(), BaseURL: base, Kind: KindOpenAI, Refresh: true, List: p.ListModels})
	}
	if d := discover(srv.URL + "/v1"); d.Error == "" || d.ErrorCode != ai.CodeAuthFailed {
		t.Errorf("403: %q %q", d.Error, d.ErrorCode)
	}
	if d := discover("http://" + closedAddr(t) + "/v1"); d.ErrorCode != ai.CodeProviderUnreachable {
		t.Errorf("closed port: %q %q", d.Error, d.ErrorCode)
	}
}
