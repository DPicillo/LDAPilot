// Package mcprelay connects Claude Code running inside WSL to LDAPilot's
// MCP server on the Windows loopback (CLAUDE.md › Claude Code engine, WSL
// mode). In WSL, Claude Code gets a stdio MCP server whose command is
// LDAPilot.exe itself with Flag and the path of the run's relay file;
// Claude Code starts it through the WSL interop, so the relay is a Windows
// process and reaches 127.0.0.1 whatever the WSL networking mode (NAT,
// mirrored, WSL 1). The relay passes every JSON-RPC message between its
// stdin/stdout and the Streamable HTTP endpoint unchanged; the tools,
// approvals, redaction and audit stay in the server.
//
// The bearer token is read from the relay file (private, removed with the
// run), never from the command line, and the relay talks to nothing but
// http://127.0.0.1:<port>/mcp.
package mcprelay

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Flag is the command-line flag that runs LDAPilot.exe as the relay:
//
//	LDAPilot.exe --ldapilot-mcp-relay <relay file>
const Flag = "--ldapilot-mcp-relay"

// Config is the relay file (written by the run, 0600, removed with it).
type Config struct {
	URL   string `json:"url"`   // http://127.0.0.1:<port>/mcp
	Token string `json:"token"` // bearer token of the run's server
}

// MaxLineBytes bounds one JSON-RPC message from Claude Code.
const MaxLineBytes = 32 << 20

// headers of the Streamable HTTP transport
const (
	hdrSession  = "Mcp-Session-Id"
	hdrVersion  = "Mcp-Protocol-Version"
	hdrMethod   = "Mcp-Method"
	hdrName     = "Mcp-Name"
	metaVersion = "io.modelcontextprotocol/protocolVersion"
	// versionStdHeaders is the first protocol version that requires the
	// Mcp-Method / Mcp-Name request headers.
	versionStdHeaders = "2026-07-28"
)

// Main runs the relay with the arguments after Flag and returns the exit
// code. Diagnostics go to stderr (Claude Code keeps an MCP server's stderr
// in its debug log); stdout carries only protocol messages.
func Main(args []string) int {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: LDAPilot "+Flag+" <relay file>")
		return 2
	}
	cfg, err := ReadConfig(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, "ldapilot mcp relay:", err)
		return 1
	}
	if err := Run(context.Background(), cfg, os.Stdin, os.Stdout, nil); err != nil {
		fmt.Fprintln(os.Stderr, "ldapilot mcp relay:", err)
		return 1
	}
	return 0
}

// ReadConfig reads and checks a relay file.
func ReadConfig(path string) (Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return Config{}, err
	}
	defer f.Close()
	var cfg Config
	if err := json.NewDecoder(io.LimitReader(f, 64<<10)).Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("invalid relay file: %w", err)
	}
	return cfg, cfg.Check()
}

// Check accepts only LDAPilot's own endpoint: plain HTTP to 127.0.0.1 on
// an explicit port, path /mcp, and a token.
func (c Config) Check() error {
	u, err := url.Parse(c.URL)
	if err != nil {
		return fmt.Errorf("invalid server URL: %w", err)
	}
	host, port, err := net.SplitHostPort(u.Host)
	if u.Scheme != "http" || err != nil || host != "127.0.0.1" || port == "" || u.Path != "/mcp" || u.User != nil || u.RawQuery != "" {
		return errors.New("the relay only connects to LDAPilot's server on http://127.0.0.1:<port>/mcp")
	}
	if n, err := strconv.Atoi(port); err != nil || n <= 0 || n > 65535 {
		return errors.New("invalid server port")
	}
	if strings.TrimSpace(c.Token) == "" || strings.ContainsAny(c.Token, " \r\n\t") {
		return errors.New("missing or invalid token")
	}
	return nil
}

// Run relays until in ends (Claude Code closed the server's stdin) or ctx
// ends. Notifications and responses are sent in order (the server answers
// them at once); requests run concurrently, so a tool call that waits for
// the user's approval holds up nothing else. client nil = a client without
// proxy and without overall timeout (approval waits are long).
func Run(ctx context.Context, cfg Config, in io.Reader, out io.Writer, client *http.Client) error {
	if err := cfg.Check(); err != nil {
		return err
	}
	if client == nil {
		client = &http.Client{Transport: &http.Transport{
			Proxy:               nil,
			DialContext:         (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
			MaxIdleConnsPerHost: 8,
			IdleConnTimeout:     90 * time.Second,
		}}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	r := &relay{cfg: cfg, client: client, out: out}
	var wg sync.WaitGroup
	defer wg.Wait()
	defer cancel() // runs before wg.Wait: in-flight requests end with the relay

	br := bufio.NewReaderSize(in, 64<<10)
	for {
		line, err := readLine(br)
		if len(bytes.TrimSpace(line)) > 0 {
			msg, perr := parseMessage(line)
			switch {
			case perr != nil:
				r.writeError(nil, -32700, "LDAPilot relay: "+perr.Error())
			case msg.isRequest() && msg.Method != "initialize":
				wg.Add(1)
				go func() {
					defer wg.Done()
					r.post(ctx, msg)
				}()
			default:
				r.post(ctx, msg) // initialize, notifications, responses: in order
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				r.endSession()
				return nil
			}
			return err
		}
	}
}

func readLine(br *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := br.ReadSlice('\n')
		if len(buf)+len(chunk) > MaxLineBytes {
			for errors.Is(err, bufio.ErrBufferFull) {
				_, err = br.ReadSlice('\n')
			}
			if err != nil {
				return nil, err
			}
			return nil, nil // dropped (too long)
		}
		buf = append(buf, chunk...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return buf, err
	}
}

// message is the part of a JSON-RPC message the relay looks at.
type message struct {
	raw    []byte
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func parseMessage(line []byte) (*message, error) {
	m := &message{}
	trimmed := bytes.TrimSpace(line)
	if err := json.Unmarshal(trimmed, m); err != nil {
		return nil, fmt.Errorf("invalid JSON-RPC message: %v", err)
	}
	m.raw = trimmed
	return m, nil
}

func (m *message) hasID() bool {
	return len(m.ID) > 0 && string(m.ID) != "null"
}

func (m *message) isRequest() bool { return m.Method != "" && m.hasID() }

// version is the protocol version the message names in its _meta.
func (m *message) version() string {
	var p struct {
		Meta map[string]any `json:"_meta"`
	}
	if len(m.Params) == 0 || json.Unmarshal(m.Params, &p) != nil {
		return ""
	}
	v, _ := p.Meta[metaVersion].(string)
	return v
}

// name is the Mcp-Name header value of tools/call, prompts/get and
// resources/read.
func (m *message) name() string {
	var p struct {
		Name string `json:"name"`
		URI  string `json:"uri"`
	}
	if len(m.Params) == 0 || json.Unmarshal(m.Params, &p) != nil {
		return ""
	}
	switch m.Method {
	case "tools/call", "prompts/get":
		return p.Name
	case "resources/read":
		return p.URI
	}
	return ""
}

type relay struct {
	cfg    Config
	client *http.Client

	outMu sync.Mutex
	out   io.Writer

	mu      sync.Mutex
	session string
	version string // negotiated protocol version (initialize result)
	initID  string // id of the initialize request in flight
}

// write sends one message to Claude Code (one line).
func (r *relay) write(msg []byte) {
	var buf bytes.Buffer
	if err := json.Compact(&buf, msg); err != nil {
		return
	}
	buf.WriteByte('\n')
	r.outMu.Lock()
	defer r.outMu.Unlock()
	_, _ = r.out.Write(buf.Bytes())
}

// writeError answers request id with a JSON-RPC error.
func (r *relay) writeError(id json.RawMessage, code int, msg string) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": msg}})
	r.write(b)
}

func (r *relay) post(ctx context.Context, m *message) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.cfg.URL, bytes.NewReader(m.raw))
	if err != nil {
		r.fail(m, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+r.cfg.Token)
	r.mu.Lock()
	session, version := r.session, r.version
	if m.Method == "initialize" && m.hasID() {
		r.initID = string(m.ID)
	}
	r.mu.Unlock()
	if v := m.version(); v != "" {
		version = v
	}
	if session != "" {
		req.Header.Set(hdrSession, session)
	}
	if version != "" && m.Method != "initialize" {
		req.Header.Set(hdrVersion, version)
	}
	if version >= versionStdHeaders && m.isRequest() {
		req.Header.Set(hdrMethod, m.Method)
		if n := m.name(); n != "" {
			req.Header.Set(hdrName, n)
		}
	}
	resp, err := r.client.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			r.fail(m, err)
		}
		return
	}
	defer resp.Body.Close()
	if s := resp.Header.Get(hdrSession); s != "" {
		r.mu.Lock()
		r.session = s
		r.mu.Unlock()
	}
	switch {
	case resp.StatusCode == http.StatusAccepted:
		return
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		ct := strings.ToLower(resp.Header.Get("Content-Type"))
		if strings.HasPrefix(ct, "text/event-stream") {
			r.readEvents(resp.Body)
			return
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, MaxLineBytes))
		r.forwardJSON(body)
	default:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		if r.forwardJSON(body) || !m.isRequest() {
			return
		}
		text := strings.TrimSpace(string(body))
		if len(text) > 300 {
			text = text[:300] + "…"
		}
		r.writeError(m.ID, -32603, fmt.Sprintf("LDAPilot's tool server answered HTTP %d: %s", resp.StatusCode, text))
	}
}

// fail answers a request whose HTTP call failed (notifications are dropped).
func (r *relay) fail(m *message, err error) {
	if m.isRequest() {
		r.writeError(m.ID, -32603, "LDAPilot's tool server is not reachable (the run may have ended): "+err.Error())
	}
}

// forwardJSON passes a JSON body (one message or a batch) to Claude Code;
// it reports whether the body held JSON-RPC messages.
func (r *relay) forwardJSON(body []byte) bool {
	body = bytes.TrimSpace(body)
	if len(body) == 0 {
		return false
	}
	if body[0] == '[' {
		var batch []json.RawMessage
		if json.Unmarshal(body, &batch) != nil {
			return false
		}
		ok := false
		for _, m := range batch {
			ok = r.forward(m) || ok
		}
		return ok
	}
	return r.forward(body)
}

// forward passes one server message on and learns the negotiated protocol
// version from the initialize result.
func (r *relay) forward(msg []byte) bool {
	var m struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Result  struct {
			ProtocolVersion string `json:"protocolVersion"`
		} `json:"result"`
	}
	if json.Unmarshal(msg, &m) != nil || m.JSONRPC != "2.0" {
		return false
	}
	if len(m.ID) > 0 && m.Result.ProtocolVersion != "" {
		r.mu.Lock()
		if r.initID != "" && string(m.ID) == r.initID {
			r.version = m.Result.ProtocolVersion
			r.initID = ""
		}
		r.mu.Unlock()
	}
	r.write(msg)
	return true
}

// readEvents forwards the data of every server-sent event.
func (r *relay) readEvents(body io.Reader) {
	br := bufio.NewReaderSize(body, 64<<10)
	var data bytes.Buffer
	dispatch := func() {
		if data.Len() > 0 {
			r.forwardJSON(data.Bytes())
			data.Reset()
		}
	}
	for {
		line, err := readLine(br)
		l := bytes.TrimRight(line, "\r\n")
		switch {
		case len(l) == 0 && line != nil:
			dispatch()
		case bytes.HasPrefix(l, []byte("data:")):
			v := bytes.TrimPrefix(l[5:], []byte(" "))
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.Write(v)
		}
		if err != nil {
			dispatch()
			return
		}
	}
}

// endSession ends the server session (best effort) when Claude Code is
// done.
func (r *relay) endSession() {
	r.mu.Lock()
	session := r.session
	r.mu.Unlock()
	if session == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, r.cfg.URL, nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+r.cfg.Token)
	req.Header.Set(hdrSession, session)
	if resp, err := r.client.Do(req); err == nil {
		resp.Body.Close()
	}
}
