package services

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// Value templates of the batch modify. A template is literal text with
// placeholders:
//
//	%attr%        first value of the entry's attribute attr (case-insensitive name)
//	%attr:lower%  the same, lower-cased
//	%attr:upper%  the same, upper-cased
//	%dn%          the entry DN
//	%rdn%         the first RDN as written in the DN, e.g. "CN=Smith\, John"
//	%parentdn%    the DN of the parent entry
//	%%            a literal "%"
//
// The modifiers work on every placeholder. An empty placeholder (attribute
// missing or empty, %parentdn% of a top-level entry) is reported separately,
// so that the caller can fail or skip the entry.

// templatePart is a literal or a placeholder of a valueTemplate.
type templatePart struct {
	literal  string
	name     string // lowercase placeholder name; empty for a literal
	modifier string // "", "lower" or "upper"
	text     string // placeholder as written, e.g. "%mail:lower%"
}

// valueTemplate is a parsed value template.
type valueTemplate struct {
	raw   string
	parts []templatePart
}

// placeholderNameRe matches attribute descriptions and the special names.
var placeholderNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9;._=-]*$`)

// parseValueTemplate parses a template; syntax errors name the position.
func parseValueTemplate(s string) (*valueTemplate, error) {
	t := &valueTemplate{raw: s}
	var lit strings.Builder
	flushLiteral := func() {
		if lit.Len() > 0 {
			t.parts = append(t.parts, templatePart{literal: lit.String()})
			lit.Reset()
		}
	}
	for i := 0; i < len(s); {
		c := s[i]
		if c != '%' {
			lit.WriteByte(c)
			i++
			continue
		}
		if i+1 < len(s) && s[i+1] == '%' {
			lit.WriteByte('%')
			i += 2
			continue
		}
		end := strings.IndexByte(s[i+1:], '%')
		if end < 0 {
			return nil, fmt.Errorf("unterminated placeholder at position %d in %q (write %%%% for a literal %%)", i+1, s)
		}
		inner := s[i+1 : i+1+end]
		text := s[i : i+end+2]
		name, modifier, _ := strings.Cut(inner, ":")
		if !placeholderNameRe.MatchString(name) {
			return nil, fmt.Errorf("invalid placeholder %s in %q (write %%%% for a literal %%)", text, s)
		}
		modifier = strings.ToLower(modifier)
		if modifier != "" && modifier != "lower" && modifier != "upper" {
			return nil, fmt.Errorf("unknown modifier %q in %s (use lower or upper)", modifier, text)
		}
		flushLiteral()
		t.parts = append(t.parts, templatePart{name: strings.ToLower(name), modifier: modifier, text: text})
		i += end + 2
	}
	flushLiteral()
	return t, nil
}

// hasPlaceholders reports whether the template contains any placeholder.
func (t *valueTemplate) hasPlaceholders() bool {
	for _, p := range t.parts {
		if p.name != "" {
			return true
		}
	}
	return false
}

// templateEntry is the data placeholders are resolved against.
type templateEntry struct {
	dn    string
	attrs map[string]models.LDAPAttribute // lowercase attribute description
}

func newTemplateEntry(entry *models.LDAPEntry) *templateEntry {
	te := &templateEntry{dn: entry.DN, attrs: make(map[string]models.LDAPAttribute, len(entry.Attributes))}
	for _, a := range entry.Attributes {
		te.attrs[strings.ToLower(a.Name)] = a
	}
	return te
}

// lookup returns the value of a placeholder name.
func (te *templateEntry) lookup(name string) (string, error) {
	switch name {
	case "dn":
		return te.dn, nil
	case "rdn":
		rdn, _ := splitRDN(te.dn)
		return rdn, nil
	case "parentdn":
		_, parent := splitRDN(te.dn)
		return parent, nil
	}
	a, ok := te.attrs[name]
	if !ok || len(a.Values) == 0 {
		return "", nil
	}
	if a.Binary {
		return "", fmt.Errorf("attribute %s is binary and cannot be used in a template", a.Name)
	}
	return a.Values[0], nil
}

// expand resolves the template for an entry. empty lists the placeholders
// that resolved to an empty string (as written); the value is then not
// meaningful.
func (t *valueTemplate) expand(te *templateEntry) (value string, empty []string, err error) {
	var sb strings.Builder
	for _, p := range t.parts {
		if p.name == "" {
			sb.WriteString(p.literal)
			continue
		}
		v, lerr := te.lookup(p.name)
		if lerr != nil {
			return "", nil, fmt.Errorf("%s: %v", p.text, lerr)
		}
		if v == "" {
			empty = append(empty, p.text)
			continue
		}
		switch p.modifier {
		case "lower":
			v = strings.ToLower(v)
		case "upper":
			v = strings.ToUpper(v)
		}
		sb.WriteString(v)
	}
	return sb.String(), empty, nil
}

// splitRDN splits a DN at its first unescaped comma (or semicolon) into the
// first RDN and the parent DN, both trimmed. Escapes are kept as written.
func splitRDN(dn string) (rdn, parent string) {
	escaped := false
	for i := 0; i < len(dn); i++ {
		c := dn[i]
		switch {
		case escaped:
			escaped = false
		case c == '\\':
			escaped = true
		case c == ',' || c == ';':
			return strings.TrimSpace(dn[:i]), strings.TrimSpace(dn[i+1:])
		}
	}
	return strings.TrimSpace(dn), ""
}
