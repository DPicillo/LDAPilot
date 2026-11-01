package claudecode

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// Tolerant parser for the CLI's `--output-format stream-json` lines. Only
// the fields LDAPilot uses are decoded; unknown line types and fields are
// ignored, so newer CLI versions keep working.

// Line types (the "type" field).
const (
	LineSystem          = "system"
	LineStreamEvent     = "stream_event"
	LineAssistant       = "assistant"
	LineUser            = "user"
	LineResult          = "result"
	LineRateLimit       = "rate_limit_event"
	LineControlResponse = "control_response"
	LineControlRequest  = "control_request"
)

// Line is one decoded stream-json line.
type Line struct {
	Type    string
	Subtype string
	// SessionID is Claude Code's session (not LDAPilot's chat).
	SessionID string
	// ParentToolUseID is set for lines produced inside a subagent; LDAPilot
	// shows only the main conversation.
	ParentToolUseID string

	Init      *Init          // system/init
	Info      *Informational // system/informational (and other system lines with content)
	Stream    *StreamEvent   // stream_event
	Message   *Message       // assistant / user
	RateLimit *RateLimitInfo // rate_limit_event
	Result    *Result        // result
	Raw       []byte         // the line itself (tests and diagnostics)
}

// Init is the system/init line: the model actually used and the MCP
// server status.
type Init struct {
	Model          string
	CWD            string
	Tools          []string
	MCPServers     []MCPServerStatus
	PermissionMode string
	APIKeySource   string
	Version        string
}

// MCPServerStatus is one entry of init.mcp_servers.
type MCPServerStatus struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// Informational is a system line with a human-readable message.
type Informational struct {
	Level   string
	Content string
}

// StreamEvent is the Anthropic SSE event wrapped in a stream_event line.
type StreamEvent struct {
	Type       string // message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
	Index      int
	MessageID  string // message_start
	Model      string // message_start
	BlockType  string // content_block_start: text | thinking | tool_use | …
	ToolUseID  string // content_block_start (tool_use)
	ToolName   string // content_block_start (tool_use)
	DeltaType  string // content_block_delta: text_delta | thinking_delta | input_json_delta | signature_delta
	Text       string // text_delta / thinking_delta text
	JSON       string // input_json_delta partial_json
	StopReason string // message_delta
	Usage      *Usage // message_start (input side) and message_delta (output side)
}

// Message is the message of an assistant or user line.
type Message struct {
	ID         string
	Role       string
	Model      string
	Content    []Content
	StopReason string
	Usage      *Usage
}

// Content is one content block of a Message.
type Content struct {
	Type      string // text | thinking | tool_use | tool_result | …
	Text      string // text; thinking text; tool_result text (flattened)
	ID        string // tool_use
	Name      string // tool_use
	Input     json.RawMessage
	ToolUseID string // tool_result
	IsError   bool   // tool_result
}

// Usage is the token usage of a message or of the whole run.
type Usage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	ThinkingTokens           int `json:"-"`
}

// ContextTokens is the prompt size of a message (Anthropic reports cache
// reads and writes separately from input_tokens).
func (u Usage) ContextTokens() int {
	return u.InputTokens + u.CacheCreationInputTokens + u.CacheReadInputTokens
}

// RateLimitInfo is the payload of a rate_limit_event line.
type RateLimitInfo struct {
	Status        string  // allowed | allowed_warning | rejected | …
	ResetsAt      int64   // unix seconds
	RateLimitType string  // five_hour | seven_day | …
	Utilization   float64 // 0..1 of the reported window, when known
}

// Result is the final line of a run.
type Result struct {
	Subtype           string // success | error_max_turns | error_during_execution | error_max_budget_usd | …
	IsError           bool
	Result            string
	NumTurns          int
	DurationMs        int64
	DurationAPIMs     int64
	TotalCostUSD      float64
	SessionID         string
	StopReason        string
	TerminalReason    string
	APIErrorStatus    int
	Usage             Usage
	Errors            []string
	PermissionDenials []PermissionDenial
	ModelUsage        map[string]ModelUsage
}

// PermissionDenial is a tool call Claude Code refused.
type PermissionDenial struct {
	ToolName  string          `json:"tool_name"`
	ToolUseID string          `json:"tool_use_id"`
	ToolInput json.RawMessage `json:"tool_input"`
}

// ModelUsage is the per-model part of the result.
type ModelUsage struct {
	InputTokens              int     `json:"inputTokens"`
	OutputTokens             int     `json:"outputTokens"`
	CacheReadInputTokens     int     `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int     `json:"cacheCreationInputTokens"`
	CostUSD                  float64 `json:"costUSD"`
	ContextWindow            int     `json:"contextWindow"`
	MaxOutputTokens          int     `json:"maxOutputTokens"`
}

// ErrNotJSON is returned for a line that is not a JSON object.
var ErrNotJSON = errors.New("not a stream-json line")

type rawLine struct {
	Type            string          `json:"type"`
	Subtype         string          `json:"subtype"`
	SessionID       string          `json:"session_id"`
	ParentToolUseID *string         `json:"parent_tool_use_id"`
	Event           json.RawMessage `json:"event"`
	Message         json.RawMessage `json:"message"`
	RateLimitInfo   json.RawMessage `json:"rate_limit_info"`

	// system/init
	Model          string            `json:"model"`
	CWD            string            `json:"cwd"`
	Tools          []json.RawMessage `json:"tools"`
	MCPServers     []json.RawMessage `json:"mcp_servers"`
	PermissionMode string            `json:"permissionMode"`
	APIKeySource   string            `json:"apiKeySource"`
	Version        string            `json:"claude_code_version"`
	// system/informational
	Level   string          `json:"level"`
	Content json.RawMessage `json:"content"`
	// result
	IsError           bool                  `json:"is_error"`
	Result            json.RawMessage       `json:"result"`
	NumTurns          int                   `json:"num_turns"`
	DurationMs        int64                 `json:"duration_ms"`
	DurationAPIMs     int64                 `json:"duration_api_ms"`
	TotalCostUSD      float64               `json:"total_cost_usd"`
	StopReason        string                `json:"stop_reason"`
	TerminalReason    string                `json:"terminal_reason"`
	APIErrorStatus    json.RawMessage       `json:"api_error_status"`
	Usage             json.RawMessage       `json:"usage"`
	Errors            []json.RawMessage     `json:"errors"`
	PermissionDenials []json.RawMessage     `json:"permission_denials"`
	ModelUsage        map[string]ModelUsage `json:"modelUsage"`
}

// ParseLine decodes one stream-json line. Unknown types yield a Line with
// only Type/Subtype set.
func ParseLine(b []byte) (*Line, error) {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || b[0] != '{' {
		return nil, ErrNotJSON
	}
	var r rawLine
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	l := &Line{Type: r.Type, Subtype: r.Subtype, SessionID: r.SessionID, Raw: b}
	if r.ParentToolUseID != nil {
		l.ParentToolUseID = *r.ParentToolUseID
	}
	switch r.Type {
	case LineSystem:
		switch r.Subtype {
		case "init":
			in := &Init{Model: r.Model, CWD: r.CWD, PermissionMode: r.PermissionMode, APIKeySource: r.APIKeySource, Version: r.Version}
			for _, t := range r.Tools {
				var name string
				if json.Unmarshal(t, &name) == nil {
					in.Tools = append(in.Tools, name)
					continue
				}
				var obj struct {
					Name string `json:"name"`
				}
				if json.Unmarshal(t, &obj) == nil && obj.Name != "" {
					in.Tools = append(in.Tools, obj.Name)
				}
			}
			for _, s := range r.MCPServers {
				var st MCPServerStatus
				if json.Unmarshal(s, &st) == nil && st.Name != "" {
					in.MCPServers = append(in.MCPServers, st)
				}
			}
			l.Init = in
		default:
			if txt := textOf(r.Content); txt != "" {
				l.Info = &Informational{Level: r.Level, Content: txt}
			}
		}
	case LineStreamEvent:
		l.Stream = parseStreamEvent(r.Event)
	case LineAssistant, LineUser:
		l.Message = parseMessage(r.Message)
	case LineRateLimit:
		l.RateLimit = parseRateLimit(r.RateLimitInfo)
	case LineResult:
		res := &Result{Subtype: r.Subtype, IsError: r.IsError, NumTurns: r.NumTurns, DurationMs: r.DurationMs, DurationAPIMs: r.DurationAPIMs,
			TotalCostUSD: r.TotalCostUSD, SessionID: r.SessionID, StopReason: r.StopReason, TerminalReason: r.TerminalReason, ModelUsage: r.ModelUsage}
		res.Result = textOf(r.Result)
		var status int
		if json.Unmarshal(r.APIErrorStatus, &status) == nil {
			res.APIErrorStatus = status
		}
		if u := parseUsage(r.Usage); u != nil {
			res.Usage = *u
		}
		for _, e := range r.Errors {
			if s := textOf(e); s != "" {
				res.Errors = append(res.Errors, s)
			}
		}
		for _, d := range r.PermissionDenials {
			var pd PermissionDenial
			if json.Unmarshal(d, &pd) == nil {
				res.PermissionDenials = append(res.PermissionDenials, pd)
			}
		}
		l.Result = res
	}
	return l, nil
}

// textOf returns a JSON string, the "text"/"message" of an object, or the
// joined text of an array of blocks.
func textOf(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var arr []json.RawMessage
	if json.Unmarshal(raw, &arr) == nil {
		var parts []string
		for _, a := range arr {
			if t := textOf(a); t != "" {
				parts = append(parts, t)
			}
		}
		return strings.Join(parts, "\n")
	}
	var obj struct {
		Type    string          `json:"type"`
		Text    *string         `json:"text"`
		Message *string         `json:"message"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		switch {
		case obj.Text != nil:
			return *obj.Text
		case obj.Message != nil:
			return *obj.Message
		case len(obj.Content) > 0:
			return textOf(obj.Content)
		}
	}
	return ""
}

func parseUsage(raw json.RawMessage) *Usage {
	if len(bytes.TrimSpace(raw)) == 0 || string(raw) == "null" {
		return nil
	}
	var u struct {
		Usage
		Details struct {
			ThinkingTokens int `json:"thinking_tokens"`
		} `json:"output_tokens_details"`
	}
	if json.Unmarshal(raw, &u) != nil {
		return nil
	}
	out := u.Usage
	out.ThinkingTokens = u.Details.ThinkingTokens
	return &out
}

func parseStreamEvent(raw json.RawMessage) *StreamEvent {
	var e struct {
		Type    string `json:"type"`
		Index   int    `json:"index"`
		Message struct {
			ID    string          `json:"id"`
			Model string          `json:"model"`
			Usage json.RawMessage `json:"usage"`
		} `json:"message"`
		ContentBlock struct {
			Type string `json:"type"`
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"content_block"`
		Delta struct {
			Type        string `json:"type"`
			Text        string `json:"text"`
			Thinking    string `json:"thinking"`
			PartialJSON string `json:"partial_json"`
			StopReason  string `json:"stop_reason"`
		} `json:"delta"`
		Usage json.RawMessage `json:"usage"`
	}
	if json.Unmarshal(raw, &e) != nil || e.Type == "" {
		return nil
	}
	se := &StreamEvent{Type: e.Type, Index: e.Index}
	switch e.Type {
	case "message_start":
		se.MessageID, se.Model = e.Message.ID, e.Message.Model
		se.Usage = parseUsage(e.Message.Usage)
	case "content_block_start":
		se.BlockType, se.ToolUseID, se.ToolName = e.ContentBlock.Type, e.ContentBlock.ID, e.ContentBlock.Name
	case "content_block_delta":
		se.DeltaType = e.Delta.Type
		switch e.Delta.Type {
		case "text_delta":
			se.Text = e.Delta.Text
		case "thinking_delta":
			se.Text = e.Delta.Thinking
		case "input_json_delta":
			se.JSON = e.Delta.PartialJSON
		}
	case "message_delta":
		se.StopReason = e.Delta.StopReason
		se.Usage = parseUsage(e.Usage)
	}
	return se
}

func parseMessage(raw json.RawMessage) *Message {
	var m struct {
		ID         string          `json:"id"`
		Role       string          `json:"role"`
		Model      string          `json:"model"`
		Content    json.RawMessage `json:"content"`
		StopReason string          `json:"stop_reason"`
		Usage      json.RawMessage `json:"usage"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	out := &Message{ID: m.ID, Role: m.Role, Model: m.Model, StopReason: m.StopReason, Usage: parseUsage(m.Usage)}
	var s string
	if json.Unmarshal(m.Content, &s) == nil {
		out.Content = []Content{{Type: "text", Text: s}}
		return out
	}
	var blocks []json.RawMessage
	if json.Unmarshal(m.Content, &blocks) != nil {
		return out
	}
	for _, b := range blocks {
		var c struct {
			Type      string          `json:"type"`
			Text      string          `json:"text"`
			Thinking  string          `json:"thinking"`
			ID        string          `json:"id"`
			Name      string          `json:"name"`
			Input     json.RawMessage `json:"input"`
			ToolUseID string          `json:"tool_use_id"`
			Content   json.RawMessage `json:"content"`
			IsError   bool            `json:"is_error"`
		}
		if json.Unmarshal(b, &c) != nil {
			continue
		}
		cc := Content{Type: c.Type, ID: c.ID, Name: c.Name, Input: c.Input, ToolUseID: c.ToolUseID, IsError: c.IsError}
		switch c.Type {
		case "text":
			cc.Text = c.Text
		case "thinking":
			cc.Text = c.Thinking
		case "tool_result":
			cc.Text = textOf(c.Content)
		}
		out.Content = append(out.Content, cc)
	}
	return out
}

func parseRateLimit(raw json.RawMessage) *RateLimitInfo {
	var r struct {
		Status         string   `json:"status"`
		ResetsAt       int64    `json:"resetsAt"`
		RateLimitType  string   `json:"rateLimitType"`
		Utilization    *float64 `json:"utilization"`
		UnifiedWindows map[string]struct {
			Utilization float64 `json:"utilization"`
			ResetsAt    int64   `json:"resetsAt"`
		} `json:"unifiedWindows"`
	}
	if json.Unmarshal(raw, &r) != nil {
		return nil
	}
	out := &RateLimitInfo{Status: r.Status, ResetsAt: r.ResetsAt, RateLimitType: r.RateLimitType}
	if r.Utilization != nil {
		out.Utilization = *r.Utilization
	} else if w, ok := r.UnifiedWindows[r.RateLimitType]; ok {
		out.Utilization = w.Utilization
	}
	return out
}

// MaxLineBytes bounds one stream-json line (a tool result can be large).
const MaxLineBytes = 32 << 20

// ErrLineTooLong is returned for a line longer than MaxLineBytes.
var ErrLineTooLong = errors.New("stream-json line too long")

// Reader reads stream-json lines.
type Reader struct {
	br *bufio.Reader
}

// NewReader wraps r.
func NewReader(r io.Reader) *Reader { return &Reader{br: bufio.NewReaderSize(r, 256<<10)} }

// Next returns the next decodable line. Blank lines, lines that are not
// JSON objects (stray log output) and lines over MaxLineBytes are skipped;
// io.EOF ends the stream.
func (r *Reader) Next() (*Line, error) {
	for {
		b, err := r.readLine()
		if errors.Is(err, ErrLineTooLong) {
			continue // skipped; the run goes on
		}
		if len(bytes.TrimSpace(b)) > 0 {
			if l, perr := ParseLine(b); perr == nil {
				return l, nil
			}
		}
		if err != nil {
			return nil, err
		}
	}
}

func (r *Reader) readLine() ([]byte, error) {
	var buf []byte
	for {
		chunk, err := r.br.ReadSlice('\n')
		if len(buf)+len(chunk) > MaxLineBytes {
			// Drain the rest of the line, then report it.
			for errors.Is(err, bufio.ErrBufferFull) {
				_, err = r.br.ReadSlice('\n')
			}
			if err != nil && !errors.Is(err, io.EOF) {
				return nil, err
			}
			return nil, ErrLineTooLong
		}
		buf = append(buf, chunk...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return buf, err
	}
}
