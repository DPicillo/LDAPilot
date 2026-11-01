package provider

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

// Text tool-call salvage (§4.1). When a server's tool parser fails,
// Qwen/Hermes, Mistral and Llama templates leak tool calls into content.
// Only these exact patterns are recognized, only in content (never in
// reasoning), only for tools offered in this run, never when the step has
// native tool calls, and never when the match contains U+2060 (inserted by
// the neutralizer into tags copied from directory data).

const (
	openToolCall   = "<tool_call>"
	closeToolCall  = "</tool_call>"
	openToolCalls  = "[TOOL_CALLS]"
	argsMarker     = "[ARGS]"
	openPythonTag  = "<|python_tag|>"
	openFunction   = "<function="
	closeFunction  = "</function>"
	bareJSONHold   = 8 << 10
	warnSalvaged   = "salvaged_text_tool_call"
	salvageWarning = "The model wrote a tool call as text that LDAPilot could not use. The 'Ollama (native)' preset or a model with native tool support usually fixes this."
)

var salvageOpeners = []string{openToolCall, openToolCalls, openPythonTag, openFunction}

// salvagedCall is one tool call recovered from text.
type salvagedCall struct {
	name string
	args json.RawMessage
}

// span is a byte range [start,end) of matched text.
type span struct{ start, end int }

// salvageText looks for leaked tool calls in content. It returns the calls,
// the content with the matched text removed (not trimmed), and whether an
// opener was present that could not be salvaged.
func salvageText(content string, offered []tools.Spec) (calls []salvagedCall, rest string, failed bool) {
	if len(offered) == 0 || strings.TrimSpace(content) == "" {
		return nil, content, false
	}
	var spans []span
	var all []salvagedCall
	ok := true

	// Qwen / Hermes: <tool_call>{...}</tool_call>
	for i := 0; ; {
		j := strings.Index(content[i:], openToolCall)
		if j < 0 {
			break
		}
		start := i + j
		k := strings.Index(content[start+len(openToolCall):], closeToolCall)
		if k < 0 {
			ok = false
			break
		}
		end := start + len(openToolCall) + k + len(closeToolCall)
		inner := strings.TrimSpace(content[start+len(openToolCall) : start+len(openToolCall)+k])
		cs, good := parseCallObjects(inner, offered, false)
		if !good || strings.Contains(content[start:end], ai.WordJoiner) {
			ok = false
		} else {
			all = append(all, cs...)
			spans = append(spans, span{start, end})
		}
		i = end
	}

	// Mistral: [TOOL_CALLS][{...}] or [TOOL_CALLS]name[ARGS]{...}
	for i := 0; ; {
		j := strings.Index(content[i:], openToolCalls)
		if j < 0 {
			break
		}
		start := i + j
		after := content[start+len(openToolCalls):]
		trimmed := strings.TrimLeft(after, " \t\r\n")
		lead := len(after) - len(trimmed)
		if strings.HasPrefix(trimmed, "[") {
			n, val := decodeOne(trimmed)
			if n < 0 {
				ok = false
				break
			}
			cs, good := parseCallObjects(string(val), offered, false)
			end := start + len(openToolCalls) + lead + n
			if !good || strings.Contains(content[start:end], ai.WordJoiner) {
				ok = false
			} else {
				all = append(all, cs...)
				spans = append(spans, span{start, end})
			}
			i = end
			continue
		}
		a := strings.Index(trimmed, argsMarker)
		if a <= 0 {
			ok = false
			break
		}
		name := strings.TrimSpace(trimmed[:a])
		argText := strings.TrimLeft(trimmed[a+len(argsMarker):], " \t")
		n, val := decodeOne(argText)
		if n < 0 || name == "" || strings.ContainsAny(name, " \n{") {
			ok = false
			break
		}
		end := start + len(openToolCalls) + lead + a + len(argsMarker) + (len(trimmed[a+len(argsMarker):]) - len(argText)) + n
		resolved, known := tools.Resolve(name, offered)
		if !known || firstByte(val) != '{' || strings.Contains(content[start:end], ai.WordJoiner) {
			ok = false
		} else {
			all = append(all, salvagedCall{name: resolved, args: val})
			spans = append(spans, span{start, end})
		}
		i = end
	}

	// Llama 3.x: <|python_tag|>{...}
	for i := 0; ; {
		j := strings.Index(content[i:], openPythonTag)
		if j < 0 {
			break
		}
		start := i + j
		after := content[start+len(openPythonTag):]
		trimmed := strings.TrimLeft(after, " \t\r\n")
		n, val := decodeOne(trimmed)
		if n < 0 {
			ok = false
			break
		}
		end := start + len(openPythonTag) + (len(after) - len(trimmed)) + n
		cs, good := parseCallObjects(string(val), offered, true)
		if !good || strings.Contains(content[start:end], ai.WordJoiner) {
			ok = false
		} else {
			all = append(all, cs...)
			spans = append(spans, span{start, end})
		}
		i = end
	}

	// Llama 3.x: <function=NAME>{...}</function>
	for i := 0; ; {
		j := strings.Index(content[i:], openFunction)
		if j < 0 {
			break
		}
		start := i + j
		gt := strings.Index(content[start:], ">")
		if gt < 0 {
			ok = false
			break
		}
		name := content[start+len(openFunction) : start+gt]
		k := strings.Index(content[start+gt+1:], closeFunction)
		if k < 0 {
			ok = false
			break
		}
		end := start + gt + 1 + k + len(closeFunction)
		body := strings.TrimSpace(content[start+gt+1 : start+gt+1+k])
		resolved, known := tools.Resolve(name, offered)
		if !known || !json.Valid([]byte(body)) || firstByte([]byte(body)) != '{' || strings.Contains(content[start:end], ai.WordJoiner) {
			ok = false
		} else {
			all = append(all, salvagedCall{name: resolved, args: json.RawMessage(body)})
			spans = append(spans, span{start, end})
		}
		i = end
	}

	// Bare JSON: the whole trimmed content (optionally one ```json fence).
	if len(spans) == 0 && ok {
		t := strings.TrimSpace(content)
		inner := t
		if strings.HasPrefix(inner, "```json") && strings.HasSuffix(inner, "```") && len(inner) >= len("```json```") {
			inner = strings.TrimSpace(inner[len("```json") : len(inner)-3])
		}
		if strings.HasPrefix(inner, "{") || strings.HasPrefix(inner, "[{") {
			if json.Valid([]byte(inner)) && !strings.Contains(inner, ai.WordJoiner) {
				if cs, good := parseCallObjects(inner, offered, true); good {
					return cs, "", false
				}
			}
		}
	}

	if len(spans) == 0 {
		return nil, content, hasOpener(content)
	}
	sort.Slice(spans, func(a, b int) bool { return spans[a].start < spans[b].start })
	var b strings.Builder
	pos := 0
	for _, s := range spans {
		if s.start < pos {
			continue
		}
		b.WriteString(content[pos:s.start])
		pos = s.end
	}
	b.WriteString(content[pos:])
	return all, b.String(), !ok
}

func hasOpener(s string) bool {
	for _, o := range salvageOpeners {
		if strings.Contains(s, o) {
			return true
		}
	}
	return false
}

// decodeOne decodes the first JSON value at the start of s and returns the
// number of bytes it used (-1 if it is not valid JSON).
func decodeOne(s string) (int, json.RawMessage) {
	dec := json.NewDecoder(strings.NewReader(s))
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		return -1, nil
	}
	return int(dec.InputOffset()), raw
}

// parseCallObjects parses {"name","arguments"} (or "parameters" when
// allowParams) or an array of them. All names must be offered tools.
func parseCallObjects(s string, offered []tools.Spec, allowParams bool) ([]salvagedCall, bool) {
	s = strings.TrimSpace(s)
	var objs []json.RawMessage
	switch firstByte([]byte(s)) {
	case '{':
		objs = []json.RawMessage{json.RawMessage(s)}
	case '[':
		if err := json.Unmarshal([]byte(s), &objs); err != nil || len(objs) == 0 {
			return nil, false
		}
	default:
		return nil, false
	}
	var out []salvagedCall
	for _, o := range objs {
		var c map[string]json.RawMessage
		if err := json.Unmarshal(o, &c); err != nil {
			return nil, false
		}
		var name string
		if err := json.Unmarshal(c["name"], &name); err != nil || name == "" {
			return nil, false
		}
		args, has := c["arguments"]
		if !has && allowParams {
			args, has = c["parameters"]
		}
		if !has {
			args = emptyObject
		}
		for k := range c {
			if k != "name" && k != "arguments" && k != "parameters" && k != "id" && k != "type" {
				return nil, false
			}
		}
		resolved, known := tools.Resolve(name, offered)
		if !known {
			return nil, false
		}
		out = append(out, salvagedCall{name: resolved, args: bytes.TrimSpace(args)})
	}
	return out, true
}

// holdBack is the streaming filter that keeps possible tool-call text from
// flickering into the UI. Content from any opener on is held until the
// step ends. Content whose first non-blank characters are "{", "[{" or
// "```json" is held up to 8 KB, then flushed.
type holdBack struct {
	enabled  bool
	emit     func(string) // flushes text to the builder
	flushed  strings.Builder
	held     strings.Builder
	holdAll  bool
	jsonMode bool
	decided  bool // leading-JSON decision made
}

func newHoldBack(enabled bool, emit func(string)) *holdBack {
	return &holdBack{enabled: enabled, emit: emit}
}

func (h *holdBack) push(s string) {
	if s == "" {
		return
	}
	if !h.enabled {
		h.flushed.WriteString(s)
		h.emit(s)
		return
	}
	if h.holdAll {
		h.held.WriteString(s)
		return
	}
	h.held.WriteString(s)
	cur := h.held.String()
	if !h.decided && h.flushed.Len() == 0 {
		lead := strings.TrimLeft(cur, " \t\r\n")
		switch {
		case lead == "":
			return // only whitespace so far
		case strings.HasPrefix(lead, "{"), strings.HasPrefix(lead, "[{"), strings.HasPrefix(lead, "```json"):
			h.jsonMode = true
			h.decided = true
		case lead == "[" || strings.HasPrefix("```json", lead):
			return // could still become "[{" or "```json"
		default:
			h.decided = true
		}
	}
	if h.jsonMode {
		if i := firstOpener(cur); i >= 0 {
			h.holdAll = true
			return
		}
		if h.held.Len() < bareJSONHold {
			return
		}
		h.jsonMode = false
	}
	if i := firstOpener(cur); i >= 0 {
		h.release(cur[:i])
		rest := cur[i:]
		h.held.Reset()
		h.held.WriteString(rest)
		h.holdAll = true
		return
	}
	keep := 0
	for _, o := range salvageOpeners {
		if k := partialSuffix(cur, o); k > keep {
			keep = k
		}
	}
	h.release(cur[:len(cur)-keep])
	tail := cur[len(cur)-keep:]
	h.held.Reset()
	h.held.WriteString(tail)
}

func (h *holdBack) release(s string) {
	if s == "" {
		return
	}
	h.flushed.WriteString(s)
	h.emit(s)
}

func firstOpener(s string) int {
	best := -1
	for _, o := range salvageOpeners {
		if i := strings.Index(s, o); i >= 0 && (best < 0 || i < best) {
			best = i
		}
	}
	return best
}

// finish returns what was flushed and what is still held.
func (h *holdBack) finish() (flushed, held string) {
	return h.flushed.String(), h.held.String()
}
