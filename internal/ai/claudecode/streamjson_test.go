package claudecode

import (
	"io"
	"os"
	"strings"
	"testing"
)

func readAll(t *testing.T, path string) []*Line {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	r := NewReader(f)
	var out []*Line
	for {
		l, err := r.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, l)
	}
}

// The real capture of a tool-less run (claude 2.1.285, trimmed of local
// paths and skill names).
func TestParseCapturedStream(t *testing.T) {
	lines := readAll(t, "testdata/stream-2.1.285.jsonl")
	if len(lines) != 13 {
		t.Fatalf("%d lines", len(lines))
	}
	var text strings.Builder
	var init *Init
	var res *Result
	var info *Informational
	var rl *RateLimitInfo
	var start, delta *StreamEvent
	for _, l := range lines {
		switch {
		case l.Init != nil:
			init = l.Init
		case l.Info != nil:
			info = l.Info
		case l.Result != nil:
			res = l.Result
		case l.RateLimit != nil:
			rl = l.RateLimit
		case l.Stream != nil:
			switch l.Stream.Type {
			case "message_start":
				start = l.Stream
			case "message_delta":
				delta = l.Stream
			case "content_block_delta":
				text.WriteString(l.Stream.Text)
			}
		}
	}
	if init == nil || init.Model != "claude-opus-5-5" || init.Version != "2.1.285" || init.APIKeySource != "none" || len(init.MCPServers) != 0 {
		t.Fatalf("init %+v", init)
	}
	if info == nil || info.Level != "warning" || !strings.Contains(info.Content, "restricted") {
		t.Fatalf("informational %+v", info)
	}
	if text.String() != "pong" {
		t.Fatalf("text %q", text.String())
	}
	if start == nil || start.MessageID != "msg_011CgXKhKhpFdyh3cg36bXyV" || start.Usage == nil || start.Usage.CacheCreationInputTokens != 1942 {
		t.Fatalf("message_start %+v", start)
	}
	if delta == nil || delta.StopReason != "end_turn" || delta.Usage.OutputTokens != 4 {
		t.Fatalf("message_delta %+v", delta)
	}
	if rl == nil || rl.Status != "allowed" || rl.RateLimitType != "five_hour" || rl.Utilization != 0.37 {
		t.Fatalf("rate limit %+v", rl)
	}
	if res == nil || res.IsError || res.Subtype != "success" || res.Result != "pong" || res.NumTurns != 1 || res.TotalCostUSD != 0.015731 ||
		res.Usage.ContextTokens() != 2+1942+535 || res.ModelUsage["claude-opus-5-5"].ContextWindow != 1000000 || res.SessionID == "" {
		t.Fatalf("result %+v", res)
	}
}

func TestParseToolFlow(t *testing.T) {
	lines := readAll(t, "testdata/stream-tools-synthetic.jsonl")
	var toolStart, jsonParts []string
	var assistantTool *Content
	var toolResult *Content
	sub := 0
	thinking := ""
	for _, l := range lines {
		if l.ParentToolUseID != "" {
			sub++
			continue
		}
		if s := l.Stream; s != nil {
			if s.Type == "content_block_start" && s.BlockType == "tool_use" {
				toolStart = append(toolStart, s.ToolUseID+" "+s.ToolName)
			}
			if s.DeltaType == "input_json_delta" {
				jsonParts = append(jsonParts, s.JSON)
			}
			if s.DeltaType == "thinking_delta" {
				thinking += s.Text
			}
		}
		if l.Type == LineAssistant && l.Message != nil {
			for i := range l.Message.Content {
				if l.Message.Content[i].Type == "tool_use" {
					assistantTool = &l.Message.Content[i]
				}
			}
		}
		if l.Type == LineUser && l.Message != nil {
			toolResult = &l.Message.Content[0]
		}
	}
	if strings.Join(toolStart, ",") != "toolu_01 mcp__ldapilot__find_accounts" || strings.Join(jsonParts, "") != `{"status": "locked_out"}` {
		t.Fatalf("tool stream %v %v", toolStart, jsonParts)
	}
	if assistantTool == nil || assistantTool.ID != "toolu_01" || string(assistantTool.Input) != `{"status":"locked_out"}` {
		t.Fatalf("assistant tool_use %+v", assistantTool)
	}
	if toolResult == nil || toolResult.ToolUseID != "toolu_01" || toolResult.Text != `{"ok":true}` || toolResult.IsError {
		t.Fatalf("tool_result %+v", toolResult)
	}
	if sub != 1 || thinking != "One account." {
		t.Fatalf("subagent lines %d thinking %q", sub, thinking)
	}
	init := lines[0].Init
	if init.MCPServers[0] != (MCPServerStatus{Name: "ldapilot", Status: "connected"}) || init.Tools[0] != "mcp__ldapilot__find_accounts" {
		t.Fatalf("init %+v", init)
	}
	last := lines[len(lines)-1]
	if last.RateLimit != nil || last.Result == nil || last.Result.TotalCostUSD != 0.0123 {
		t.Fatalf("last %+v", last)
	}
	rl := lines[len(lines)-2].RateLimit
	if rl == nil || rl.Status != "allowed_warning" || rl.Utilization != 0.91 || rl.ResetsAt != 1793320200 {
		t.Fatalf("rate limit %+v", rl)
	}
}

func TestParseErrorResults(t *testing.T) {
	lines := readAll(t, "testdata/results-errors-synthetic.jsonl")
	if len(lines) != 6 {
		t.Fatalf("%d", len(lines))
	}
	b := lines[0].Result
	if b.Subtype != "error_max_budget_usd" || !b.IsError || b.Errors[0] != "Reached maximum budget ($0.25)" || b.TotalCostUSD != 0.2531 {
		t.Fatalf("budget %+v", b)
	}
	if a := lines[1].Result; a.APIErrorStatus != 401 || !strings.Contains(a.Result, "/login") {
		t.Fatalf("auth %+v", a)
	}
	if d := lines[5].Result; len(d.PermissionDenials) != 1 || d.PermissionDenials[0].ToolName != "Bash" {
		t.Fatalf("denials %+v", d)
	}
}

func TestReaderToleratesGarbage(t *testing.T) {
	in := "\n  \nnot json\n{\"type\":\"future_type\",\"x\":1}\n{broken\n" + `{"type":"user","message":{"role":"user","content":"plain"}}` + "\n" +
		`{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"hi"},{"type":"server_tool_use","id":"s"}]}}`
	r := NewReader(strings.NewReader(in))
	var types []string
	for {
		l, err := r.Next()
		if err != nil {
			break
		}
		types = append(types, l.Type)
		if l.Type == LineUser && (l.Message == nil || l.Message.Content[0].Text != "plain") {
			t.Fatalf("string content %+v", l.Message)
		}
		if l.Type == LineAssistant && (len(l.Message.Content) != 2 || l.Message.Content[0].Text != "hi") {
			t.Fatalf("assistant %+v", l.Message)
		}
	}
	if strings.Join(types, ",") != "future_type,user,assistant" {
		t.Fatalf("types %v", types)
	}
}

func TestReaderSkipsHugeLine(t *testing.T) {
	big := `{"type":"assistant","x":"` + strings.Repeat("a", MaxLineBytes+10) + `"}`
	in := big + "\n" + `{"type":"result","subtype":"success","result":"ok"}` + "\n"
	r := NewReader(strings.NewReader(in))
	l, err := r.Next()
	if err != nil || l.Result == nil || l.Result.Result != "ok" {
		t.Fatalf("%+v %v", l, err)
	}
}

// A real run with an MCP tool call (claude 2.1.308, haiku, LDAPilot's MCP
// server; trimmed of local paths): the shapes the engine relies on.
func TestParseRealMCPRun(t *testing.T) {
	lines := readAll(t, "testdata/stream-mcp-2.1.308.jsonl")
	if len(lines) != 68 {
		t.Fatalf("%d lines", len(lines))
	}
	init := lines[0].Init
	if init == nil || init.Model != "claude-haiku-5-5" || len(init.MCPServers) != 1 || init.MCPServers[0].Status != "connected" || len(init.Tools) != 11 {
		t.Fatalf("init %+v", init)
	}
	var toolStart *StreamEvent
	var args strings.Builder
	var assistantUse, result *Content
	var text strings.Builder
	for _, l := range lines {
		if s := l.Stream; s != nil {
			switch {
			case s.Type == "content_block_start" && s.BlockType == "tool_use":
				toolStart = s
			case s.DeltaType == "input_json_delta":
				args.WriteString(s.JSON)
			case s.DeltaType == "text_delta":
				text.WriteString(s.Text)
			}
		}
		if l.Message != nil {
			for i, c := range l.Message.Content {
				switch c.Type {
				case "tool_use":
					assistantUse = &l.Message.Content[i]
				case "tool_result":
					result = &l.Message.Content[i]
				}
			}
		}
	}
	if toolStart == nil || toolStart.ToolName != "mcp__ldapilot__find_accounts" || args.String() != `{"status": "locked_out", "connection": "Lab AD"}` {
		t.Fatalf("tool use %+v %q", toolStart, args.String())
	}
	if assistantUse == nil || assistantUse.ID != toolStart.ToolUseID || !strings.Contains(string(assistantUse.Input), `"locked_out"`) {
		t.Fatalf("assistant tool_use %+v", assistantUse)
	}
	if result == nil || result.ToolUseID != toolStart.ToolUseID || !strings.HasPrefix(result.Text, `{"ok":true,"tool":"find_accounts"`) {
		t.Fatalf("tool result %+v", result)
	}
	if !strings.Contains(text.String(), "test.locked") {
		t.Fatalf("text %q", text.String())
	}
	res := lines[len(lines)-1].Result
	if res == nil || res.IsError || res.TotalCostUSD != 0.00250727 || res.NumTurns != 2 || res.Usage.OutputTokens != 490 {
		t.Fatalf("result %+v", res)
	}
}
