package tools

import (
	"bytes"
	"encoding/json"
	"regexp"
)

// Schema is the JSON Schema subset used for tool parameters (§5.1): type,
// properties, required, enum, items, minimum/maximum, maxItems, maxLength,
// additionalProperties:false and default. Pattern is checked in Go only
// and never sent (gateways and Ollama's parser reject unknown keywords).
type Schema struct {
	Type        string // object | string | integer | boolean | array
	Description string
	Props       []Prop // object: properties in order
	Enum        []string
	Items       *Schema
	Min, Max    *int
	MinItems    int
	MaxItems    int
	MaxLength   int
	Default     any
	Pattern     *regexp.Regexp // validated in Go only
	PatternHelp string         // shown when Pattern does not match
}

// Prop is one object property.
type Prop struct {
	Name     string
	Required bool
	Schema   *Schema
}

// Obj builds an object schema.
func Obj(props ...Prop) *Schema { return &Schema{Type: "object", Props: props} }

// P is an optional property.
func P(name string, s *Schema) Prop { return Prop{Name: name, Schema: s} }

// R is a required property.
func R(name string, s *Schema) Prop { return Prop{Name: name, Required: true, Schema: s} }

// Str builds a string schema.
func Str(desc string) *Schema { return &Schema{Type: "string", Description: desc} }

// Int builds an integer schema with bounds and a default.
func Int(desc string, min, max, def int) *Schema {
	return &Schema{Type: "integer", Description: desc, Min: &min, Max: &max, Default: def}
}

// Bool builds a boolean schema with a default.
func Bool(desc string, def bool) *Schema {
	return &Schema{Type: "boolean", Description: desc, Default: def}
}

// Enum builds a string enum schema; def may be "".
func Enum(desc string, def string, values ...string) *Schema {
	s := &Schema{Type: "string", Description: desc, Enum: values}
	if def != "" {
		s.Default = def
	}
	return s
}

// Arr builds an array schema.
func Arr(desc string, items *Schema, maxItems int) *Schema {
	return &Schema{Type: "array", Description: desc, Items: items, MaxItems: maxItems}
}

// WithMaxLength sets maxLength and returns s.
func (s *Schema) WithMaxLength(n int) *Schema { s.MaxLength = n; return s }

// WithMinItems sets the minimum number of items (validated in Go).
func (s *Schema) WithMinItems(n int) *Schema { s.MinItems = n; return s }

// WithPattern sets a Go-only pattern.
func (s *Schema) WithPattern(re *regexp.Regexp, help string) *Schema {
	s.Pattern, s.PatternHelp = re, help
	return s
}

// Prop returns the property schema by name.
func (s *Schema) Prop(name string) *Schema {
	for _, p := range s.Props {
		if p.Name == name {
			return p.Schema
		}
	}
	return nil
}

// MarshalJSON renders the schema subset with properties in order.
func (s *Schema) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	first := true
	field := func(k string, v any) {
		if !first {
			b.WriteByte(',')
		}
		first = false
		kb, _ := json.Marshal(k)
		b.Write(kb)
		b.WriteByte(':')
		switch x := v.(type) {
		case json.RawMessage:
			b.Write(x)
		default:
			vb, _ := json.Marshal(x)
			b.Write(vb)
		}
	}
	field("type", s.Type)
	if s.Description != "" {
		field("description", s.Description)
	}
	if len(s.Enum) > 0 {
		field("enum", s.Enum)
	}
	if s.Min != nil {
		field("minimum", *s.Min)
	}
	if s.Max != nil {
		field("maximum", *s.Max)
	}
	if s.MaxLength > 0 {
		field("maxLength", s.MaxLength)
	}
	if s.Items != nil {
		ib, err := s.Items.MarshalJSON()
		if err != nil {
			return nil, err
		}
		field("items", json.RawMessage(ib))
	}
	if s.MaxItems > 0 {
		field("maxItems", s.MaxItems)
	}
	if s.Default != nil {
		field("default", s.Default)
	}
	if s.Type == "object" {
		var pb bytes.Buffer
		pb.WriteByte('{')
		var req []string
		for i, p := range s.Props {
			if i > 0 {
				pb.WriteByte(',')
			}
			kb, _ := json.Marshal(p.Name)
			pb.Write(kb)
			pb.WriteByte(':')
			vb, err := p.Schema.MarshalJSON()
			if err != nil {
				return nil, err
			}
			pb.Write(vb)
			if p.Required {
				req = append(req, p.Name)
			}
		}
		pb.WriteByte('}')
		field("properties", json.RawMessage(pb.Bytes()))
		if req == nil {
			req = []string{}
		}
		field("required", req)
		field("additionalProperties", false)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// JSON returns the marshalled schema.
func (s *Schema) JSON() json.RawMessage {
	b, err := s.MarshalJSON()
	if err != nil {
		panic(err)
	}
	return b
}
