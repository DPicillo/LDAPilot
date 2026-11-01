package ldif

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// This file implements an RFC 2849 LDIF parser for content and change
// records: version line, comments, line folding, base64 values (::), URL
// values (:<, through ParseOptions.ResolveURL) and the change types add,
// modify (add/delete/replace blocks separated by "-"), delete and
// modrdn/moddn (newrdn, deleteoldrdn, newsuperior). Control lines are
// rejected. Syntax errors carry 1-based line numbers; a record with an error
// does not stop parsing of the following records.

// SyntaxError is an LDIF syntax error at a 1-based line.
type SyntaxError struct {
	Line int
	Msg  string
}

func (e *SyntaxError) Error() string { return fmt.Sprintf("line %d: %s", e.Line, e.Msg) }

// ChangeRecord is one parsed LDIF record. Content records (no changetype)
// are returned as add records with Content set. Attribute values follow the
// binary contract of models.LDAPAttribute: values that are not valid UTF-8
// or contain control characters (and values of known binary attributes) are
// base64 encoded with Binary set.
type ChangeRecord struct {
	Line       int    // line of the dn: line
	EndLine    int    // last line of the record
	DN         string // as written (decoded if base64)
	ChangeType string // models.LDIFChange* ("moddn" is reported as "modrdn")
	Content    bool   // content record without changetype

	Attributes []models.LDAPAttribute   // add
	Changes    []models.AttributeChange // modify

	NewRDN       string // modrdn
	DeleteOldRDN bool   // modrdn
	NewSuperior  string // modrdn; empty when not given

	// URLs lists the "attr:< url" references whose content was loaded.
	URLs []string
	// Err is the syntax error of the record; the other fields are then
	// incomplete.
	Err *SyntaxError
}

// ParseOptions configure ParseChanges.
type ParseOptions struct {
	// ResolveURL loads the value of an "attr:< url" line. When nil, URL
	// values are rejected.
	ResolveURL func(rawURL string) ([]byte, error)
}

// ParseResult is the outcome of ParseChanges.
type ParseResult struct {
	Version int // 1 if a version line was present, else 0
	Records []ChangeRecord
	// Errors lists every syntax error (of records and of the file) in line
	// order.
	Errors []*SyntaxError
}

// logicalLine is an unfolded LDIF line with the number of its first
// physical line.
type logicalLine struct {
	text    string
	line    int
	comment bool
}

// ParseChanges parses LDIF content and change records.
func ParseChanges(content string, opts ParseOptions) *ParseResult {
	res := &ParseResult{}
	blocks, errs := splitRecords(content)
	res.Errors = append(res.Errors, errs...)

	for bi, block := range blocks {
		if bi == 0 && len(block) > 0 && isVersionLine(block[0].text) {
			v := strings.TrimSpace(block[0].text[strings.IndexByte(block[0].text, ':')+1:])
			if v != "1" {
				res.Errors = append(res.Errors, &SyntaxError{Line: block[0].line, Msg: fmt.Sprintf("unsupported LDIF version %q (only version 1 is supported)", v)})
			}
			res.Version = 1
			block = block[1:]
			if len(block) == 0 {
				continue
			}
		}
		rec := parseRecord(block, opts)
		if rec.Err != nil {
			res.Errors = append(res.Errors, rec.Err)
		}
		res.Records = append(res.Records, rec)
	}
	sortSyntaxErrors(res.Errors)
	return res
}

// isVersionLine reports whether an unfolded line is a "version:" line.
func isVersionLine(text string) bool {
	i := strings.IndexByte(text, ':')
	return i > 0 && strings.EqualFold(strings.TrimSpace(text[:i]), "version")
}

func sortSyntaxErrors(errs []*SyntaxError) {
	// insertion sort: lists are short and mostly sorted
	for i := 1; i < len(errs); i++ {
		for j := i; j > 0 && errs[j].Line < errs[j-1].Line; j-- {
			errs[j], errs[j-1] = errs[j-1], errs[j]
		}
	}
}

// splitRecords unfolds the content into logical lines, drops comments and
// groups the lines into records separated by blank lines.
func splitRecords(content string) ([][]logicalLine, []*SyntaxError) {
	content = strings.TrimPrefix(content, "\uFEFF")
	physical := strings.Split(content, "\n")

	var (
		blocks  [][]logicalLine
		current []logicalLine
		errs    []*SyntaxError
	)
	flush := func() {
		var kept []logicalLine
		for _, l := range current {
			if !l.comment {
				kept = append(kept, l)
			}
		}
		if len(kept) > 0 {
			blocks = append(blocks, kept)
		}
		current = nil
	}

	for i, raw := range physical {
		lineNo := i + 1
		line := strings.TrimSuffix(raw, "\r")
		switch {
		case strings.TrimSpace(line) == "":
			flush()
		case line[0] == ' ':
			if len(current) == 0 {
				errs = append(errs, &SyntaxError{Line: lineNo, Msg: "continuation line (starting with a space) without a preceding line"})
				continue
			}
			current[len(current)-1].text += line[1:]
		case line[0] == '#':
			current = append(current, logicalLine{text: line, line: lineNo, comment: true})
		default:
			current = append(current, logicalLine{text: line, line: lineNo})
		}
	}
	flush()
	return blocks, errs
}

// attrDescRe matches an attribute description: a name or numeric OID with
// optional options (";lang-de", ";binary", ";range=0-1499").
var attrDescRe = regexp.MustCompile(`^(?:[A-Za-z][A-Za-z0-9-]*|[0-9]+(?:\.[0-9]+)*)(?:;[A-Za-z0-9=._-]+)*$`)

// ValidAttributeDescription reports whether s is a syntactically valid
// attribute description.
func ValidAttributeDescription(s string) bool {
	return attrDescRe.MatchString(s)
}

// attrTypeRe matches an attribute type in a DN (name or numeric OID).
var attrTypeRe = regexp.MustCompile(`^(?:[A-Za-z][A-Za-z0-9-]*|[0-9]+(?:\.[0-9]+)*)$`)

// ValidateDN checks the syntax of a DN (RFC 4514). The empty DN is rejected.
func ValidateDN(dn string) error {
	if strings.TrimSpace(dn) == "" {
		return fmt.Errorf("empty DN")
	}
	parsed, err := goldap.ParseDN(dn)
	if err != nil {
		return fmt.Errorf("invalid DN %q: %v", dn, err)
	}
	for _, rdn := range parsed.RDNs {
		for _, ava := range rdn.Attributes {
			if !attrTypeRe.MatchString(strings.TrimSpace(ava.Type)) {
				return fmt.Errorf("invalid DN %q: bad attribute type %q", dn, ava.Type)
			}
		}
	}
	return nil
}

// ValidateRDN checks that s is a single RDN such as "cn=John Smith".
func ValidateRDN(s string) error {
	if strings.TrimSpace(s) == "" {
		return fmt.Errorf("empty RDN")
	}
	if err := ValidateDN(s); err != nil {
		return fmt.Errorf("invalid RDN %q", s)
	}
	parsed, _ := goldap.ParseDN(s)
	if len(parsed.RDNs) != 1 {
		return fmt.Errorf("invalid RDN %q: must be a single RDN, not a DN", s)
	}
	return nil
}

// lineValue is a parsed "attr: value" line.
type lineValue struct {
	name  string
	value []byte
	url   string // set for "attr:< url"
	b64   bool
}

// parseValueLine parses "attr: value", "attr:: base64", "attr:< url" and
// "attr:" (empty value). "attr:value" without a space is accepted.
func parseValueLine(l logicalLine, opts ParseOptions) (lineValue, *SyntaxError) {
	idx := strings.IndexByte(l.text, ':')
	if idx <= 0 {
		return lineValue{}, &SyntaxError{Line: l.line, Msg: fmt.Sprintf("expected \"attribute: value\", found %q", shorten(l.text))}
	}
	name := l.text[:idx]
	if !ValidAttributeDescription(name) {
		return lineValue{}, &SyntaxError{Line: l.line, Msg: fmt.Sprintf("invalid attribute name %q", shorten(name))}
	}
	rest := l.text[idx+1:]
	switch {
	case strings.HasPrefix(rest, ":"):
		encoded := strings.TrimSpace(rest[1:])
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return lineValue{}, &SyntaxError{Line: l.line, Msg: fmt.Sprintf("invalid base64 value of %q: %v", name, err)}
		}
		return lineValue{name: name, value: decoded, b64: true}, nil
	case strings.HasPrefix(rest, "<"):
		u := strings.TrimSpace(rest[1:])
		if opts.ResolveURL == nil {
			return lineValue{}, &SyntaxError{Line: l.line, Msg: fmt.Sprintf("URL values (%s:< %s) are not supported here", name, shorten(u))}
		}
		data, err := opts.ResolveURL(u)
		if err != nil {
			return lineValue{}, &SyntaxError{Line: l.line, Msg: fmt.Sprintf("value of %q from %s: %v", name, shorten(u), err)}
		}
		return lineValue{name: name, value: data, url: u}, nil
	default:
		return lineValue{name: name, value: []byte(strings.TrimLeft(rest, " "))}, nil
	}
}

// textValue returns a value that must be text (DN, newrdn, changetype, ...).
func textValue(lv lineValue, l logicalLine, what string) (string, *SyntaxError) {
	if !utf8.Valid(lv.value) {
		return "", &SyntaxError{Line: l.line, Msg: fmt.Sprintf("%s is not valid UTF-8", what)}
	}
	return string(lv.value), nil
}

func shorten(s string) string {
	const max = 80
	if len([]rune(s)) > max {
		return string([]rune(s)[:max]) + "..."
	}
	return s
}

// parseRecord parses the logical lines of one record.
func parseRecord(lines []logicalLine, opts ParseOptions) ChangeRecord {
	rec := ChangeRecord{Line: lines[0].line, EndLine: lines[len(lines)-1].line}
	fail := func(l logicalLine, format string, args ...interface{}) ChangeRecord {
		rec.Err = &SyntaxError{Line: l.line, Msg: fmt.Sprintf(format, args...)}
		return rec
	}

	first, serr := parseValueLine(lines[0], opts)
	if serr != nil {
		rec.Err = serr
		return rec
	}
	if !strings.EqualFold(first.name, "dn") {
		return fail(lines[0], "record must start with a \"dn:\" line, found %q (records are separated by blank lines)", first.name)
	}
	dn, serr := textValue(first, lines[0], "DN")
	if serr != nil {
		rec.Err = serr
		return rec
	}
	rec.DN = dn
	if err := ValidateDN(dn); err != nil {
		return fail(lines[0], "%v", err)
	}

	idx := 1
	if idx < len(lines) {
		lv, serr := parseValueLine(lines[idx], opts)
		if serr == nil && strings.EqualFold(lv.name, "control") {
			return fail(lines[idx], "control lines are not supported (found \"control: %s\"); remove the control line or apply this record with another tool", shorten(string(lv.value)))
		}
	}

	rec.ChangeType = models.LDIFChangeAdd
	rec.Content = true
	if idx < len(lines) {
		lv, serr := parseValueLine(lines[idx], opts)
		if serr == nil && strings.EqualFold(lv.name, "changetype") {
			rec.Content = false
			ct := strings.ToLower(strings.TrimSpace(string(lv.value)))
			switch ct {
			case "add":
				rec.ChangeType = models.LDIFChangeAdd
			case "modify":
				rec.ChangeType = models.LDIFChangeModify
			case "delete":
				rec.ChangeType = models.LDIFChangeDelete
			case "modrdn", "moddn":
				rec.ChangeType = models.LDIFChangeModRDN
			default:
				rec.ChangeType = ""
				return fail(lines[idx], "unknown changetype %q (expected add, modify, delete, modrdn or moddn)", shorten(ct))
			}
			idx++
		}
	}

	body := lines[idx:]
	var err *SyntaxError
	switch rec.ChangeType {
	case models.LDIFChangeAdd:
		err = parseAddBody(&rec, body, opts)
	case models.LDIFChangeDelete:
		if len(body) > 0 {
			err = &SyntaxError{Line: body[0].line, Msg: "a delete record must not contain further lines"}
		}
	case models.LDIFChangeModRDN:
		err = parseModRDNBody(&rec, body, lines[0], opts)
	case models.LDIFChangeModify:
		err = parseModifyBody(&rec, body, lines[0], opts)
	}
	rec.Err = err
	return rec
}

// rawAttr collects the values of one attribute in input order.
type rawAttr struct {
	name   string
	values [][]byte
}

// buildAttributes applies the binary contract to collected attributes.
func buildAttributes(order []string, attrs map[string]*rawAttr) []models.LDAPAttribute {
	out := make([]models.LDAPAttribute, 0, len(order))
	for _, key := range order {
		ra := attrs[key]
		values, binary := encodeValues(ra.name, ra.values)
		out = append(out, models.LDAPAttribute{Name: ra.name, Values: values, Binary: binary})
	}
	return out
}

// encodeValues returns the values as text or, when the attribute is binary
// (known binary attribute or any value not text), as base64.
func encodeValues(name string, raw [][]byte) ([]string, bool) {
	binary := ldap.IsKnownBinaryAttribute(name)
	for _, v := range raw {
		if binary {
			break
		}
		binary = ldap.IsBinaryValue(v)
	}
	values := make([]string, len(raw))
	for i, v := range raw {
		if binary {
			values[i] = base64.StdEncoding.EncodeToString(v)
		} else {
			values[i] = string(v)
		}
	}
	return values, binary
}

func parseAddBody(rec *ChangeRecord, body []logicalLine, opts ParseOptions) *SyntaxError {
	attrs := make(map[string]*rawAttr)
	var order []string
	for _, l := range body {
		if strings.TrimRight(l.text, " ") == "-" {
			return &SyntaxError{Line: l.line, Msg: "unexpected \"-\" line in an add record"}
		}
		lv, serr := parseValueLine(l, opts)
		if serr != nil {
			return serr
		}
		switch strings.ToLower(lv.name) {
		case "dn":
			return &SyntaxError{Line: l.line, Msg: "unexpected second \"dn:\" line; separate records with a blank line"}
		case "changetype":
			return &SyntaxError{Line: l.line, Msg: "\"changetype:\" must directly follow the dn: line"}
		case "control":
			return &SyntaxError{Line: l.line, Msg: "control lines are not supported"}
		}
		if lv.url != "" {
			rec.URLs = append(rec.URLs, lv.url)
		}
		key := strings.ToLower(lv.name)
		if ra, ok := attrs[key]; ok {
			ra.values = append(ra.values, lv.value)
		} else {
			attrs[key] = &rawAttr{name: lv.name, values: [][]byte{lv.value}}
			order = append(order, key)
		}
	}
	if len(order) == 0 {
		return &SyntaxError{Line: rec.Line, Msg: "add record has no attributes"}
	}
	rec.Attributes = buildAttributes(order, attrs)
	return nil
}

func parseModRDNBody(rec *ChangeRecord, body []logicalLine, dnLine logicalLine, opts ParseOptions) *SyntaxError {
	var haveRDN, haveDelete, haveSuperior bool
	for _, l := range body {
		lv, serr := parseValueLine(l, opts)
		if serr != nil {
			return serr
		}
		name := strings.ToLower(lv.name)
		switch name {
		case "newrdn":
			if haveRDN {
				return &SyntaxError{Line: l.line, Msg: "duplicate newrdn line"}
			}
			v, serr := textValue(lv, l, "newrdn")
			if serr != nil {
				return serr
			}
			if err := ValidateRDN(v); err != nil {
				return &SyntaxError{Line: l.line, Msg: err.Error()}
			}
			rec.NewRDN, haveRDN = v, true
		case "deleteoldrdn":
			if haveDelete {
				return &SyntaxError{Line: l.line, Msg: "duplicate deleteoldrdn line"}
			}
			switch strings.TrimSpace(string(lv.value)) {
			case "0":
				rec.DeleteOldRDN = false
			case "1":
				rec.DeleteOldRDN = true
			default:
				return &SyntaxError{Line: l.line, Msg: fmt.Sprintf("deleteoldrdn must be 0 or 1, found %q", shorten(string(lv.value)))}
			}
			haveDelete = true
		case "newsuperior":
			if haveSuperior {
				return &SyntaxError{Line: l.line, Msg: "duplicate newsuperior line"}
			}
			v, serr := textValue(lv, l, "newsuperior")
			if serr != nil {
				return serr
			}
			if err := ValidateDN(v); err != nil {
				return &SyntaxError{Line: l.line, Msg: "newsuperior: " + err.Error()}
			}
			rec.NewSuperior, haveSuperior = v, true
		default:
			return &SyntaxError{Line: l.line, Msg: fmt.Sprintf("unexpected line %q in a modrdn record (expected newrdn, deleteoldrdn or newsuperior)", shorten(lv.name))}
		}
	}
	if !haveRDN {
		return &SyntaxError{Line: dnLine.line, Msg: "modrdn record needs a \"newrdn:\" line"}
	}
	if !haveDelete {
		return &SyntaxError{Line: dnLine.line, Msg: "modrdn record needs a \"deleteoldrdn: 0|1\" line"}
	}
	return nil
}

func parseModifyBody(rec *ChangeRecord, body []logicalLine, dnLine logicalLine, opts ParseOptions) *SyntaxError {
	i := 0
	for i < len(body) {
		opLine := body[i]
		if strings.TrimRight(opLine.text, " ") == "-" {
			return &SyntaxError{Line: opLine.line, Msg: "unexpected \"-\" line (expected add:, delete: or replace:)"}
		}
		lv, serr := parseValueLine(opLine, opts)
		if serr != nil {
			return serr
		}
		op := strings.ToLower(lv.name)
		switch op {
		case models.ChangeAdd, models.ChangeDelete, models.ChangeReplace:
		case "increment":
			return &SyntaxError{Line: opLine.line, Msg: "increment: (RFC 4525) is not supported"}
		case "control":
			return &SyntaxError{Line: opLine.line, Msg: "control lines are not supported"}
		case "dn":
			return &SyntaxError{Line: opLine.line, Msg: "unexpected second \"dn:\" line; separate records with a blank line"}
		default:
			return &SyntaxError{Line: opLine.line, Msg: fmt.Sprintf("expected add:, delete: or replace: line, found %q", shorten(lv.name))}
		}
		attr := strings.TrimSpace(string(lv.value))
		if !ValidAttributeDescription(attr) {
			return &SyntaxError{Line: opLine.line, Msg: fmt.Sprintf("invalid attribute name %q in %s: line", shorten(attr), op)}
		}
		i++

		var values [][]byte
		for i < len(body) && strings.TrimRight(body[i].text, " ") != "-" {
			l := body[i]
			vl, serr := parseValueLine(l, opts)
			if serr != nil {
				return serr
			}
			if !strings.EqualFold(vl.name, attr) {
				return &SyntaxError{Line: l.line, Msg: fmt.Sprintf("expected a value of %q in the %s: block, found %q (missing \"-\" line?)", attr, op, shorten(vl.name))}
			}
			if vl.url != "" {
				rec.URLs = append(rec.URLs, vl.url)
			}
			values = append(values, vl.value)
			i++
		}
		if i < len(body) {
			i++ // the "-" separator; a missing one at the end of the record is tolerated
		}
		if op == models.ChangeAdd && len(values) == 0 {
			return &SyntaxError{Line: opLine.line, Msg: fmt.Sprintf("add: %s needs at least one value", attr)}
		}
		encoded, binary := encodeValues(attr, values)
		rec.Changes = append(rec.Changes, models.AttributeChange{Operation: op, Attribute: attr, Values: encoded, Binary: binary})
	}
	if len(rec.Changes) == 0 {
		return &SyntaxError{Line: dnLine.line, Msg: "modify record has no changes"}
	}
	return nil
}
