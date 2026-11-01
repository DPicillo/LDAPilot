package ldap

import (
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// knownSyntaxes maps OIDs to human-readable syntax names.
var knownSyntaxes = map[string]string{
	"1.3.6.1.4.1.1466.115.121.1.3":  "Attribute Type Description",
	"1.3.6.1.4.1.1466.115.121.1.5":  "Binary",
	"1.3.6.1.4.1.1466.115.121.1.6":  "Bit String",
	"1.3.6.1.4.1.1466.115.121.1.7":  "Boolean",
	"1.3.6.1.4.1.1466.115.121.1.11": "Country String",
	"1.3.6.1.4.1.1466.115.121.1.12": "DN",
	"1.3.6.1.4.1.1466.115.121.1.14": "Delivery Method",
	"1.3.6.1.4.1.1466.115.121.1.15": "Directory String",
	"1.3.6.1.4.1.1466.115.121.1.22": "Facsimile Telephone Number",
	"1.3.6.1.4.1.1466.115.121.1.24": "Generalized Time",
	"1.3.6.1.4.1.1466.115.121.1.26": "IA5 String",
	"1.3.6.1.4.1.1466.115.121.1.27": "Integer",
	"1.3.6.1.4.1.1466.115.121.1.28": "JPEG",
	"1.3.6.1.4.1.1466.115.121.1.34": "Name And Optional UID",
	"1.3.6.1.4.1.1466.115.121.1.36": "Numeric String",
	"1.3.6.1.4.1.1466.115.121.1.37": "Object Class Description",
	"1.3.6.1.4.1.1466.115.121.1.38": "OID",
	"1.3.6.1.4.1.1466.115.121.1.39": "Other Mailbox",
	"1.3.6.1.4.1.1466.115.121.1.40": "Octet String",
	"1.3.6.1.4.1.1466.115.121.1.41": "Postal Address",
	"1.3.6.1.4.1.1466.115.121.1.44": "Printable String",
	"1.3.6.1.4.1.1466.115.121.1.50": "Telephone Number",
	"1.3.6.1.4.1.1466.115.121.1.53": "UTC Time",
	"1.3.6.1.4.1.1466.115.121.1.58": "Substring Assertion",
}

// GetSchema reads and parses the LDAP schema from the subschemaSubentry.
func (c *Client) GetSchema() (*models.SchemaInfo, error) {
	var entry *goldap.Entry
	err := c.read(func(conn *goldap.Conn) error {
		entry = nil

		// First, find the subschemaSubentry DN from the root DSE
		subschemadn, err := getSubschemaDN(conn)
		if err != nil {
			return err
		}

		// Read the subschema entry
		req := goldap.NewSearchRequest(
			subschemadn,
			goldap.ScopeBaseObject,
			goldap.NeverDerefAliases,
			0, 0, false,
			"(objectClass=*)",
			[]string{"objectClasses", "attributeTypes"},
			nil,
		)

		result, err := conn.Search(req)
		if err != nil {
			return err
		}
		if len(result.Entries) > 0 {
			entry = result.Entries[0]
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	if entry == nil {
		return nil, ErrNotFound
	}

	schema := &models.SchemaInfo{}

	// Parse objectClasses
	for _, raw := range entry.GetAttributeValues("objectClasses") {
		if oc := parseObjectClass(raw); oc != nil {
			schema.ObjectClasses = append(schema.ObjectClasses, *oc)
		}
	}

	// Parse attributeTypes
	for _, raw := range entry.GetAttributeValues("attributeTypes") {
		if at := parseAttributeType(raw); at != nil {
			schema.Attributes = append(schema.Attributes, *at)
		}
	}
	resolveSchemaNames(schema)
	resolveAttributeInheritance(schema.Attributes)

	return schema, nil
}

// resolveSchemaNames rewrites the references inside the schema to primary
// names (DEF-25): MUST / MAY of a class that name an attribute type by an
// alias or its OID (cosine's account: MUST userid; pilotPerson: MAY
// rfc822Mailbox) name it by its first NAME, so every consumer that compares
// names (required checks, the schema views, the New Entry form) treats an
// alias like the type itself; SUP of classes and attribute types the same.
// Unknown names are kept; duplicates (an alias and the name in one list)
// are dropped.
func resolveSchemaNames(schema *models.SchemaInfo) {
	// Primary names first: an alias never shadows another type's name.
	index := func(n int, each func(add func(name, oid string, aliases []string))) map[string]string {
		m := make(map[string]string, n*2)
		each(func(name, oid string, _ []string) {
			if _, ok := m[strings.ToLower(name)]; !ok {
				m[strings.ToLower(name)] = name
			}
			if oid != "" {
				m[oid] = name
			}
		})
		each(func(name, _ string, aliases []string) {
			for _, a := range aliases {
				if _, ok := m[strings.ToLower(a)]; !ok {
					m[strings.ToLower(a)] = name
				}
			}
		})
		return m
	}
	attrNames := index(len(schema.Attributes), func(add func(string, string, []string)) {
		for _, a := range schema.Attributes {
			add(a.Name, a.OID, a.Aliases)
		}
	})
	classNames := index(len(schema.ObjectClasses), func(add func(string, string, []string)) {
		for _, o := range schema.ObjectClasses {
			add(o.Name, o.OID, o.Aliases)
		}
	})
	primary := func(index map[string]string, n string) string {
		if p, ok := index[strings.ToLower(n)]; ok {
			return p
		}
		if p, ok := index[n]; ok {
			return p
		}
		return n
	}
	rewrite := func(index map[string]string, names []string) []string {
		if len(names) == 0 {
			return names
		}
		out := make([]string, 0, len(names))
		seen := make(map[string]bool, len(names))
		for _, n := range names {
			p := primary(index, n)
			if k := strings.ToLower(p); !seen[k] {
				seen[k] = true
				out = append(out, p)
			}
		}
		return out
	}
	for i := range schema.ObjectClasses {
		oc := &schema.ObjectClasses[i]
		oc.SuperClass = rewrite(classNames, oc.SuperClass)
		oc.Must = rewrite(attrNames, oc.Must)
		oc.May = rewrite(attrNames, oc.May)
	}
	for i := range schema.Attributes {
		if sup := schema.Attributes[i].SuperType; sup != "" {
			schema.Attributes[i].SuperType = primary(attrNames, sup)
		}
	}
}

// getSubschemaDN reads the subschemaSubentry from the root DSE.
func getSubschemaDN(conn *goldap.Conn) (string, error) {
	req := goldap.NewSearchRequest(
		"",
		goldap.ScopeBaseObject,
		goldap.NeverDerefAliases,
		0, 0, false,
		"(objectClass=*)",
		[]string{"subschemaSubentry"},
		nil,
	)

	result, err := conn.Search(req)
	if err != nil {
		return "", err
	}

	if len(result.Entries) > 0 {
		dn := result.Entries[0].GetAttributeValue("subschemaSubentry")
		if dn != "" {
			return dn, nil
		}
	}

	// Fallback for servers that don't expose it
	return "cn=Subschema", nil
}

// schemaDescription is a parsed RFC 4512 schema description:
// "( <oid> KEYWORD value KEYWORD ( a $ b ) FLAG ... )".
type schemaDescription struct {
	oid    string
	fields map[string][]string // keyword (upper case) -> values (quotes removed)
	flags  map[string]bool     // keywords without a value
}

// schemaFlags are the RFC 4512 keywords that take no value.
var schemaFlags = map[string]bool{
	"OBSOLETE": true, "SINGLE-VALUE": true, "COLLECTIVE": true, "NO-USER-MODIFICATION": true,
	"ABSTRACT": true, "STRUCTURAL": true, "AUXILIARY": true,
}

// tokenizeSchema splits a schema description into "(", ")", quoted strings
// (returned with their quotes) and bare words. Quoted strings may contain
// blanks and parentheses (DESC 'a (b)'); RFC 4512 escapes \27 and \5c are
// decoded.
func tokenizeSchema(raw string) []string {
	var tokens []string
	for i := 0; i < len(raw); {
		c := raw[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '(' || c == ')':
			tokens = append(tokens, string(c))
			i++
		case c == '\'':
			j := i + 1
			for j < len(raw) && raw[j] != '\'' {
				j++
			}
			val := raw[i+1 : min(j, len(raw))]
			val = strings.NewReplacer(`\27`, "'", `\5c`, `\`, `\5C`, `\`).Replace(val)
			tokens = append(tokens, "'"+val+"'")
			i = j + 1
		default:
			j := i
			for j < len(raw) && !strings.ContainsRune(" \t\n\r()'", rune(raw[j])) {
				j++
			}
			tokens = append(tokens, raw[i:j])
			i = j
		}
	}
	return tokens
}

// parseSchemaDescription parses an RFC 4512 objectClass / attributeType
// description. It understands every keyword generically (lists in
// parentheses separated by "$" or blanks, quoted or bare values, flags), so
// a keyword inside a quoted DESC never matches and quoted values (Samba's
// SYNTAX '1.3.6...') work. Returns nil for text that is not a description.
func parseSchemaDescription(raw string) *schemaDescription {
	tokens := tokenizeSchema(raw)
	if len(tokens) < 2 || tokens[0] != "(" {
		return nil
	}
	d := &schemaDescription{oid: unquoteSchema(tokens[1]), fields: map[string][]string{}, flags: map[string]bool{}}
	for i := 2; i < len(tokens); {
		kw := strings.ToUpper(tokens[i])
		i++
		if kw == ")" {
			break
		}
		if schemaFlags[kw] {
			d.flags[kw] = true
			continue
		}
		if i >= len(tokens) {
			break
		}
		if tokens[i] == "(" {
			var values []string
			for i++; i < len(tokens) && tokens[i] != ")"; i++ {
				if tokens[i] != "$" {
					values = append(values, unquoteSchema(tokens[i]))
				}
			}
			i++ // ")"
			d.fields[kw] = append(d.fields[kw], values...)
			continue
		}
		if tokens[i] == ")" {
			// A keyword the description ends with: treat it as a flag.
			d.flags[kw] = true
			continue
		}
		d.fields[kw] = append(d.fields[kw], unquoteSchema(tokens[i]))
		i++
	}
	return d
}

func unquoteSchema(t string) string {
	if len(t) >= 2 && t[0] == '\'' && t[len(t)-1] == '\'' {
		return t[1 : len(t)-1]
	}
	return t
}

func (d *schemaDescription) first(kw string) string {
	if v := d.fields[kw]; len(v) > 0 {
		return v[0]
	}
	return ""
}

// syntaxOID strips the length bound of a SYNTAX value
// ("1.3.6.1.4.1.1466.115.121.1.15{256}" -> "1.3.6.1.4.1.1466.115.121.1.15").
func syntaxOID(v string) string {
	if i := strings.IndexByte(v, '{'); i >= 0 {
		return v[:i]
	}
	return v
}

// parseObjectClass parses an RFC 4512 objectClass description.
func parseObjectClass(raw string) *models.SchemaObjectClass {
	d := parseSchemaDescription(raw)
	if d == nil || d.first("NAME") == "" {
		return nil
	}
	oc := &models.SchemaObjectClass{
		OID:         d.oid,
		Name:        d.first("NAME"),
		Description: d.first("DESC"),
		SuperClass:  d.fields["SUP"],
		Must:        d.fields["MUST"],
		May:         d.fields["MAY"],
	}
	if names := d.fields["NAME"]; len(names) > 1 {
		oc.Aliases = append([]string(nil), names[1:]...)
	}
	switch {
	case d.flags["ABSTRACT"]:
		oc.Kind = "abstract"
	case d.flags["AUXILIARY"]:
		oc.Kind = "auxiliary"
	default:
		oc.Kind = "structural"
	}
	return oc
}

// parseAttributeType parses an RFC 4512 attributeType description.
// Syntax and matching rules a type inherits from its SUP are filled in by
// resolveAttributeInheritance (they need the whole schema).
func parseAttributeType(raw string) *models.SchemaAttribute {
	d := parseSchemaDescription(raw)
	if d == nil || d.first("NAME") == "" {
		return nil
	}
	at := &models.SchemaAttribute{
		OID:         d.oid,
		Name:        d.first("NAME"),
		Description: d.first("DESC"),
		Syntax:      syntaxOID(d.first("SYNTAX")),
		SingleValue: d.flags["SINGLE-VALUE"],
		NoUserMod:   d.flags["NO-USER-MODIFICATION"],
		Usage:       d.first("USAGE"),
		SuperType:   d.first("SUP"),
		Equality:    d.first("EQUALITY"),
		Ordering:    d.first("ORDERING"),
		Substring:   d.first("SUBSTR"),
	}
	if at.Substring == "" {
		at.Substring = d.first("SUBSTRING") // non-standard spelling
	}
	if names := d.fields["NAME"]; len(names) > 1 {
		at.Aliases = append([]string(nil), names[1:]...)
	}
	if at.Usage == "" {
		at.Usage = "userApplications"
	}
	at.SyntaxName = knownSyntaxes[at.Syntax]
	return at
}

// resolveAttributeInheritance fills in the syntax and the equality,
// ordering and substring rules an attribute type inherits from its SUP chain
// (RFC 4512 4.1.2: e.g. sn SUP name). The SUP may be given by name or OID;
// cycles are ignored.
func resolveAttributeInheritance(attrs []models.SchemaAttribute) {
	byKey := make(map[string]int, len(attrs)*2)
	for i, a := range attrs {
		byKey[strings.ToLower(a.Name)] = i
		for _, alias := range a.Aliases {
			if _, ok := byKey[strings.ToLower(alias)]; !ok {
				byKey[strings.ToLower(alias)] = i
			}
		}
		if a.OID != "" {
			byKey[a.OID] = i
		}
	}
	for i := range attrs {
		a := &attrs[i]
		seen := map[int]bool{i: true}
		for sup := a.SuperType; sup != "" && (a.Syntax == "" || a.Equality == "" || a.Ordering == "" || a.Substring == ""); {
			j, ok := byKey[strings.ToLower(sup)]
			if !ok {
				j, ok = byKey[sup]
			}
			if !ok || seen[j] {
				break
			}
			seen[j] = true
			p := attrs[j]
			if a.Syntax == "" && p.Syntax != "" {
				a.Syntax, a.SyntaxName = p.Syntax, p.SyntaxName
			}
			if a.Equality == "" {
				a.Equality = p.Equality
			}
			if a.Ordering == "" {
				a.Ordering = p.Ordering
			}
			if a.Substring == "" {
				a.Substring = p.Substring
			}
			sup = p.SuperType
		}
		if a.SyntaxName == "" {
			a.SyntaxName = knownSyntaxes[a.Syntax]
		}
	}
}
