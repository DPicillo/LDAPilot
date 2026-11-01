// Package tools defines the model-facing tool contract shared by providers
// and the tool registry: the tool spec sent to the model and tool-name
// normalization.
package tools

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

// Spec is a tool definition as sent to a provider.
type Spec struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"` // JSON Schema of the arguments (type object)
}

var namePrefixes = []string{"functions.", "function.", "mcp__ldapilot__", "ldapilot."}

// NormalizeName lower-cases a tool name the model sent, strips the prefixes
// "functions.", "function.", "mcp__ldapilot__" and "ldapilot.", and turns
// '-' and spaces into '_'.
func NormalizeName(name string) string {
	n := strings.ToLower(strings.TrimSpace(name))
	for changed := true; changed; {
		changed = false
		for _, p := range namePrefixes {
			if strings.HasPrefix(n, p) {
				n = n[len(p):]
				changed = true
			}
		}
	}
	n = strings.NewReplacer("-", "_", " ", "_").Replace(n)
	return n
}

var unsafeNameChars = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// SanitizeName makes an unknown tool name replayable to any provider:
// ^[A-Za-z0-9_-]{1,64}$.
func SanitizeName(name string) string {
	n := unsafeNameChars.ReplaceAllString(strings.TrimSpace(name), "_")
	if len(n) > 64 {
		n = n[:64]
	}
	if n == "" {
		n = "unknown_tool"
	}
	return n
}

// Resolve normalizes name and reports whether it matches one of the offered
// tools. For an unknown name it returns the sanitized original.
func Resolve(name string, offered []Spec) (string, bool) {
	n := NormalizeName(name)
	for _, s := range offered {
		if s.Name == n {
			return n, true
		}
	}
	return SanitizeName(name), false
}

// Names returns the names of the specs in order.
func Names(specs []Spec) []string {
	out := make([]string, 0, len(specs))
	for _, s := range specs {
		out = append(out, s.Name)
	}
	return out
}

// Kind of a tool.
type Kind string

const (
	KindRead  Kind = "read"
	KindWrite Kind = "write"
)

// ConnectionParam is the name of the connection argument.
const ConnectionParam = "connection"

// Def describes a tool (§5.1).
type Def struct {
	Name           string // ^[a-z_]{1,64}$
	DisplayName    string
	Description    string // model-facing
	Params         *Schema
	Kind           Kind
	Timeout        time.Duration
	AllowChatGrant bool
	BaseRisk       string // writes: medium | high
	// Directory is true for tools with a connection parameter.
	Directory bool
	// ConnectionOptional: the tool also works without a directory
	// (validate_filter); no access check unless a connection is given.
	ConnectionOptional bool
}

// ConnectionDescription is the model-facing description of `connection`.
const ConnectionDescription = "Directory to use (name from list_connections). May be omitted when only one directory is available; then the active connection is used."

// Spec returns the provider spec with the connection enum fixed to labels
// (the connections this tool may use in this run).
func (d *Def) Spec(labels []string) Spec {
	params := d.Params
	if d.Directory && params != nil {
		cp := *params
		cp.Props = make([]Prop, len(params.Props))
		copy(cp.Props, params.Props)
		for i, p := range cp.Props {
			if p.Name == ConnectionParam {
				s := *p.Schema
				s.Enum = append([]string(nil), labels...)
				cp.Props[i].Schema = &s
			}
		}
		params = &cp
	}
	return Spec{Name: d.Name, Description: d.Description, Parameters: params.JSON()}
}
