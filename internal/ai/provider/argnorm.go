package provider

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

// Tool-call error codes the executor turns into results.
const (
	ErrCodeInvalidArguments = "INVALID_ARGUMENTS"
	ErrCodeUnknownTool      = "UNKNOWN_TOOL"
)

const maxRawArgs = 2 << 10

// normalizedArgs is the outcome of argument normalization.
type normalizedArgs struct {
	Input    json.RawMessage // always a JSON object
	Warnings []string
	RawArgs  string // original text when unusable or rewritten (≤ 2 KB)
	Err      error  // non-nil: the call is invalid (INVALID_ARGUMENTS)
}

var emptyObject = json.RawMessage(`{}`)

// normalizeArgString normalizes OpenAI-style string arguments:
// "" / null / "null" → {}; JSON that is itself a JSON string holding JSON
// (double-encoded) is unwrapped at most twice; arrays and scalars are
// invalid.
func normalizeArgString(s string) normalizedArgs {
	t := strings.TrimSpace(s)
	if t == "" || t == "null" || t == `"null"` || t == `""` {
		return normalizedArgs{Input: emptyObject}
	}
	return normalizeArgJSON([]byte(t), s)
}

// normalizeArgValue normalizes object-typed arguments (Ollama native,
// Anthropic). Strings are treated like OpenAI arguments.
func normalizeArgValue(raw json.RawMessage) normalizedArgs {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || string(t) == "null" {
		return normalizedArgs{Input: emptyObject}
	}
	if t[0] == '"' {
		var s string
		if err := json.Unmarshal(t, &s); err == nil {
			out := normalizeArgString(s)
			if out.Err == nil && strings.TrimSpace(s) != "" {
				out.Warnings = appendUnique(out.Warnings, "double_encoded_arguments")
			}
			return out
		}
	}
	return normalizeArgJSON(t, string(raw))
}

func normalizeArgJSON(t []byte, original string) normalizedArgs {
	var warnings []string
	cur := t
	for depth := 0; ; depth++ {
		if !json.Valid(cur) {
			return invalidArgs(original, fmt.Errorf("arguments are not valid JSON"))
		}
		switch firstByte(cur) {
		case '{':
			var buf bytes.Buffer
			if err := json.Compact(&buf, cur); err != nil {
				return invalidArgs(original, err)
			}
			out := normalizedArgs{Input: json.RawMessage(buf.Bytes()), Warnings: warnings}
			if len(warnings) > 0 {
				out.RawArgs = capRaw(original)
			}
			return out
		case 'n':
			return normalizedArgs{Input: emptyObject, Warnings: warnings}
		case '"':
			if depth >= 2 {
				return invalidArgs(original, errors.New("arguments must be a JSON object"))
			}
			var inner string
			_ = json.Unmarshal(cur, &inner)
			inner = strings.TrimSpace(inner)
			if inner == "" || inner == "null" {
				return normalizedArgs{Input: emptyObject, Warnings: warnings}
			}
			warnings = appendUnique(warnings, "double_encoded_arguments")
			cur = []byte(inner)
		default:
			return invalidArgs(original, errors.New("arguments must be a JSON object"))
		}
	}
}

func firstByte(b []byte) byte {
	b = bytes.TrimSpace(b)
	if len(b) == 0 {
		return 0
	}
	return b[0]
}

func invalidArgs(original string, err error) normalizedArgs {
	return normalizedArgs{Input: emptyObject, RawArgs: capRaw(original), Err: err}
}

func capRaw(s string) string { return truncateRunes(s, maxRawArgs) }

func appendUnique(list []string, s string) []string {
	for _, x := range list {
		if x == s {
			return list
		}
	}
	return append(list, s)
}

// toolUseBlock builds a canonical tool_use block from a provider call:
// the name is normalized (unknown names are sanitized and flagged), the
// arguments are normalized (invalid ones become {} with RawArgs).
func toolUseBlock(providerKey, model, providerID, name string, args normalizedArgs, offered []tools.Spec) ai.Block {
	resolved, known := tools.Resolve(name, offered)
	b := ai.Block{
		Type:           ai.BlockToolUse,
		ProviderCallID: providerID,
		Name:           resolved,
		Input:          args.Input,
		Producer:       Producer(providerKey, model),
	}
	if b.Input == nil {
		b.Input = emptyObject
	}
	var meta ai.BlockMeta
	set := false
	if len(args.Warnings) > 0 {
		meta.Warnings = append(meta.Warnings, args.Warnings...)
		set = true
	}
	if args.RawArgs != "" {
		meta.RawArgs = args.RawArgs
		set = true
	}
	if args.Err != nil {
		meta.ErrorCode = ErrCodeInvalidArguments
		meta.Summary = args.Err.Error()
		set = true
	}
	if !known {
		meta.ErrorCode = ErrCodeUnknownTool
		meta.Summary = "unknown tool " + name
		set = true
	}
	if set {
		b.Meta = &meta
	}
	return b
}
