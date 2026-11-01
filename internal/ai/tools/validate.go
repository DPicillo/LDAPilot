package tools

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// Args are validated and coerced tool arguments. Values are string, int,
// bool, []any or map[string]any (objects inside arrays).
type Args map[string]any

// Str returns a string argument ("" if absent).
func (a Args) Str(k string) string {
	s, _ := a[k].(string)
	return s
}

// Has reports whether the argument was given.
func (a Args) Has(k string) bool {
	_, ok := a[k]
	return ok
}

// Int returns an integer argument or def.
func (a Args) Int(k string, def int) int {
	if v, ok := a[k].(int); ok {
		return v
	}
	return def
}

// Bool returns a boolean argument or def.
func (a Args) Bool(k string, def bool) bool {
	if v, ok := a[k].(bool); ok {
		return v
	}
	return def
}

// Strings returns a string-array argument.
func (a Args) Strings(k string) []string {
	arr, _ := a[k].([]any)
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// Objects returns an array-of-objects argument.
func (a Args) Objects(k string) []Args {
	arr, _ := a[k].([]any)
	out := make([]Args, 0, len(arr))
	for _, v := range arr {
		if m, ok := v.(map[string]any); ok {
			out = append(out, Args(m))
		}
	}
	return out
}

// Canonical returns the canonical JSON of the arguments (sorted keys), used
// by the repetition guard and for display.
func (a Args) Canonical() string {
	b, _ := json.Marshal(map[string]any(a)) // encoding/json sorts map keys
	return string(b)
}

// ValidationError is a field-level argument error.
type ValidationError struct {
	Field   string
	Message string
}

func (e *ValidationError) Error() string {
	if e.Field == "" {
		return e.Message
	}
	return e.Field + ": " + e.Message
}

// Validate checks raw arguments against the object schema s and coerces
// them (§5.1): "10" → 10, "true" → true, a single string where an array is
// expected → [string], null for an optional parameter → absent, unknown
// properties ignored with a note. U+2060 is stripped from every string.
func Validate(s *Schema, raw json.RawMessage) (Args, []string, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = json.RawMessage("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, nil, &ValidationError{Message: "arguments are not valid JSON: " + err.Error()}
	}
	if v == nil {
		v = map[string]any{}
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, nil, &ValidationError{Message: "arguments must be a JSON object"}
	}
	var notes []string
	out, err := validateObject(s, obj, "", &notes)
	if err != nil {
		return nil, notes, err
	}
	return Args(out), notes, nil
}

func validateObject(s *Schema, obj map[string]any, path string, notes *[]string) (map[string]any, error) {
	out := map[string]any{}
	known := map[string]bool{}
	for _, p := range s.Props {
		known[p.Name] = true
		raw, present := obj[p.Name]
		if present && raw == nil {
			present = false // null for an optional parameter → absent
		}
		if !present {
			if p.Required {
				return nil, &ValidationError{Field: join(path, p.Name), Message: "is required"}
			}
			continue
		}
		val, err := coerce(p.Schema, raw, join(path, p.Name), notes)
		if err != nil {
			return nil, err
		}
		if val == nil {
			if p.Required {
				return nil, &ValidationError{Field: join(path, p.Name), Message: "is required"}
			}
			continue
		}
		out[p.Name] = val
	}
	var unknown []string
	for k := range obj {
		if !known[k] {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		*notes = append(*notes, fmt.Sprintf("Ignored unknown argument(s): %s.", strings.Join(prefixAll(path, unknown), ", ")))
	}
	return out, nil
}

func prefixAll(path string, names []string) []string {
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = join(path, n)
	}
	return out
}

func join(path, name string) string {
	if path == "" {
		return name
	}
	return path + "." + name
}

func coerce(s *Schema, v any, field string, notes *[]string) (any, error) {
	switch s.Type {
	case "string":
		var str string
		switch x := v.(type) {
		case string:
			str = x
		case json.Number:
			str = x.String()
		case bool:
			str = strconv.FormatBool(x)
		default:
			return nil, &ValidationError{Field: field, Message: "must be a string"}
		}
		str = ai.StripWordJoiners(str)
		if !utf8.ValidString(str) {
			str = strings.ToValidUTF8(str, "�")
		}
		if s.MaxLength > 0 && utf8.RuneCountInString(str) > s.MaxLength {
			return nil, &ValidationError{Field: field, Message: fmt.Sprintf("is too long (at most %d characters)", s.MaxLength)}
		}
		if len(s.Enum) > 0 {
			match := ""
			for _, e := range s.Enum {
				if e == str {
					match = e
					break
				}
			}
			if match == "" {
				for _, e := range s.Enum {
					if strings.EqualFold(e, strings.TrimSpace(str)) {
						match = e
						break
					}
				}
			}
			if match == "" {
				return nil, &ValidationError{Field: field, Message: fmt.Sprintf("must be one of %s (got %q)", strings.Join(s.Enum, ", "), str)}
			}
			str = match
		}
		if s.Pattern != nil && !s.Pattern.MatchString(str) {
			msg := "has an invalid format"
			if s.PatternHelp != "" {
				msg += " (" + s.PatternHelp + ")"
			}
			return nil, &ValidationError{Field: field, Message: msg}
		}
		return str, nil
	case "integer":
		var n float64
		switch x := v.(type) {
		case json.Number:
			f, err := x.Float64()
			if err != nil {
				return nil, &ValidationError{Field: field, Message: "must be an integer"}
			}
			n = f
		case string:
			f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
			if err != nil {
				return nil, &ValidationError{Field: field, Message: "must be an integer"}
			}
			n = f
		default:
			return nil, &ValidationError{Field: field, Message: "must be an integer"}
		}
		if n != math.Trunc(n) || math.IsInf(n, 0) || math.IsNaN(n) || math.Abs(n) > 1e15 {
			return nil, &ValidationError{Field: field, Message: "must be an integer"}
		}
		i := int(n)
		if s.Min != nil && i < *s.Min {
			return nil, &ValidationError{Field: field, Message: fmt.Sprintf("must be at least %d", *s.Min)}
		}
		if s.Max != nil && i > *s.Max {
			return nil, &ValidationError{Field: field, Message: fmt.Sprintf("must be at most %d", *s.Max)}
		}
		return i, nil
	case "boolean":
		switch x := v.(type) {
		case bool:
			return x, nil
		case string:
			switch strings.ToLower(strings.TrimSpace(x)) {
			case "true", "yes", "1":
				return true, nil
			case "false", "no", "0":
				return false, nil
			}
		case json.Number:
			switch x.String() {
			case "1":
				return true, nil
			case "0":
				return false, nil
			}
		}
		return nil, &ValidationError{Field: field, Message: "must be true or false"}
	case "array":
		var arr []any
		switch x := v.(type) {
		case []any:
			arr = x
		case string:
			// A single string where an array is expected; also accept a
			// JSON array encoded as a string.
			t := strings.TrimSpace(x)
			if strings.HasPrefix(t, "[") {
				var inner []any
				d := json.NewDecoder(strings.NewReader(t))
				d.UseNumber()
				if d.Decode(&inner) == nil {
					arr = inner
					break
				}
			}
			arr = []any{x}
		default:
			if s.Items != nil && s.Items.Type == "object" {
				if m, ok := v.(map[string]any); ok {
					arr = []any{m}
					break
				}
			}
			return nil, &ValidationError{Field: field, Message: "must be an array"}
		}
		if s.MaxItems > 0 && len(arr) > s.MaxItems {
			return nil, &ValidationError{Field: field, Message: fmt.Sprintf("has too many items (at most %d)", s.MaxItems)}
		}
		if s.MinItems > 0 && len(arr) < s.MinItems {
			return nil, &ValidationError{Field: field, Message: fmt.Sprintf("needs at least %d item(s)", s.MinItems)}
		}
		out := make([]any, 0, len(arr))
		for i, item := range arr {
			if item == nil {
				continue
			}
			val, err := coerce(s.Items, item, fmt.Sprintf("%s[%d]", field, i), notes)
			if err != nil {
				return nil, err
			}
			out = append(out, val)
		}
		return out, nil
	case "object":
		m, ok := v.(map[string]any)
		if !ok {
			return nil, &ValidationError{Field: field, Message: "must be an object"}
		}
		return validateObject(s, m, field, notes)
	}
	return nil, &ValidationError{Field: field, Message: "unsupported schema type " + s.Type}
}

// Example renders a short example call for error messages: the required
// properties with placeholder values.
func Example(name string, s *Schema) string {
	parts := []string{}
	for _, p := range s.Props {
		if !p.Required {
			continue
		}
		parts = append(parts, fmt.Sprintf("%q:%s", p.Name, exampleValue(p.Name, p.Schema)))
	}
	return name + "({" + strings.Join(parts, ",") + "})"
}

func exampleValue(name string, s *Schema) string {
	switch s.Type {
	case "string":
		if len(s.Enum) > 0 {
			return strconv.Quote(s.Enum[0])
		}
		switch {
		case strings.Contains(name, "dn"):
			return `"CN=Anna Schmidt,OU=Users,DC=example,DC=com"`
		case name == "filter":
			return `"(sAMAccountName=jdoe)"`
		}
		return `"…"`
	case "integer":
		if s.Default != nil {
			return fmt.Sprint(s.Default)
		}
		return "1"
	case "boolean":
		return "true"
	case "array":
		if s.Items != nil && s.Items.Type == "object" {
			parts := []string{}
			for _, p := range s.Items.Props {
				if p.Required {
					parts = append(parts, fmt.Sprintf("%q:%s", p.Name, exampleValue(p.Name, p.Schema)))
				}
			}
			return "[{" + strings.Join(parts, ",") + "}]"
		}
		return `["…"]`
	case "object":
		return "{}"
	}
	return `"…"`
}
