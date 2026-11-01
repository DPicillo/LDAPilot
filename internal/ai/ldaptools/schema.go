package ldaptools

import (
	"regexp"
	"sort"
	"strings"
)

// AttrType is a parsed attribute type definition (RFC 4512).
type AttrType struct {
	OID         string
	Names       []string
	Desc        string
	Syntax      string
	SingleValue bool
	Sup         string
	Usage       string
	NoUserMod   bool
	Equality    string
}

// Name returns the primary name (or the OID).
func (a *AttrType) Name() string {
	if len(a.Names) > 0 {
		return a.Names[0]
	}
	return a.OID
}

// ObjClass is a parsed object class definition.
type ObjClass struct {
	OID   string
	Names []string
	Desc  string
	Sup   []string
	Kind  string // structural | auxiliary | abstract
	Must  []string
	May   []string
}

// Name returns the primary name (or the OID).
func (c *ObjClass) Name() string {
	if len(c.Names) > 0 {
		return c.Names[0]
	}
	return c.OID
}

// Schema is a parsed directory schema with name, alias and OID lookup.
type Schema struct {
	Attrs   []*AttrType
	Classes []*ObjClass
	attrs   map[string]*AttrType
	classes map[string]*ObjClass
}

var numericOID = regexp.MustCompile(`^[0-9]+(\.[0-9]+)+$`)

// IsNumericOID reports whether s is a dotted numeric OID.
func IsNumericOID(s string) bool { return numericOID.MatchString(s) }

// BaseAttr strips attribute options ("member;range=0-1499" → "member").
func BaseAttr(name string) string {
	if i := strings.IndexByte(name, ';'); i >= 0 {
		return name[:i]
	}
	return name
}

// ParseSchema parses attributeTypes and objectClasses values.
func ParseSchema(attrDefs, classDefs []string) *Schema {
	s := &Schema{attrs: map[string]*AttrType{}, classes: map[string]*ObjClass{}}
	for _, d := range attrDefs {
		if a := parseAttrType(d); a != nil {
			s.Attrs = append(s.Attrs, a)
			s.attrs[strings.ToLower(a.OID)] = a
			for _, n := range a.Names {
				s.attrs[strings.ToLower(n)] = a
			}
		}
	}
	for _, d := range classDefs {
		if c := parseObjClass(d); c != nil {
			s.Classes = append(s.Classes, c)
			s.classes[strings.ToLower(c.OID)] = c
			for _, n := range c.Names {
				s.classes[strings.ToLower(n)] = c
			}
		}
	}
	return s
}

// Attr looks up an attribute type by name, alias or OID (options are
// stripped). nil if unknown.
func (s *Schema) Attr(name string) *AttrType {
	if s == nil {
		return nil
	}
	return s.attrs[strings.ToLower(BaseAttr(strings.TrimSpace(name)))]
}

// Class looks up an object class by name or OID.
func (s *Schema) Class(name string) *ObjClass {
	if s == nil {
		return nil
	}
	return s.classes[strings.ToLower(strings.TrimSpace(name))]
}

// Inherited returns MUST and MAY of a class including all superior classes
// (de-duplicated, in order).
func (s *Schema) Inherited(c *ObjClass) (must, may []string, chain []string) {
	seenM, seenY, seenC := map[string]bool{}, map[string]bool{}, map[string]bool{}
	var walk func(*ObjClass)
	walk = func(x *ObjClass) {
		key := strings.ToLower(x.Name())
		if seenC[key] {
			return
		}
		seenC[key] = true
		chain = append(chain, x.Name())
		for _, m := range x.Must {
			if !seenM[strings.ToLower(m)] {
				seenM[strings.ToLower(m)] = true
				must = append(must, m)
			}
		}
		for _, m := range x.May {
			if !seenY[strings.ToLower(m)] {
				seenY[strings.ToLower(m)] = true
				may = append(may, m)
			}
		}
		for _, sup := range x.Sup {
			if sc := s.Class(sup); sc != nil {
				walk(sc)
			}
		}
	}
	walk(c)
	return
}

// Suggest returns up to 5 names close to name (case-insensitive prefix or
// Levenshtein distance ≤ 2), from attribute types or object classes.
func (s *Schema) Suggest(name string, classes bool) []string {
	q := strings.ToLower(name)
	type cand struct {
		n string
		d int
	}
	var cs []cand
	seen := map[string]bool{}
	add := func(n string) {
		l := strings.ToLower(n)
		if seen[l] {
			return
		}
		d := levenshtein(q, l)
		if strings.HasPrefix(l, q) || strings.HasPrefix(q, l) && len(l) > 3 {
			d = min(d, 1)
		}
		if d <= 2 {
			seen[l] = true
			cs = append(cs, cand{n, d})
		}
	}
	if classes {
		for _, c := range s.Classes {
			for _, n := range c.Names {
				add(n)
			}
		}
	} else {
		for _, a := range s.Attrs {
			for _, n := range a.Names {
				add(n)
			}
		}
	}
	sort.Slice(cs, func(i, j int) bool {
		if cs[i].d != cs[j].d {
			return cs[i].d < cs[j].d
		}
		return cs[i].n < cs[j].n
	})
	out := []string{}
	for i := 0; i < len(cs) && i < 5; i++ {
		out = append(out, cs[i].n)
	}
	return out
}

func levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	if len(ra) == 0 {
		return len(rb)
	}
	if len(rb) == 0 {
		return len(ra)
	}
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(rb)]
}

// --- RFC 4512 definition parsing ---

func tokenize(def string) []string {
	var toks []string
	i := 0
	for i < len(def) {
		c := def[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '(' || c == ')':
			toks = append(toks, string(c))
			i++
		case c == '\'':
			j := strings.IndexByte(def[i+1:], '\'')
			if j < 0 {
				toks = append(toks, def[i+1:])
				return toks
			}
			toks = append(toks, "'"+def[i+1:i+1+j])
			i += j + 2
		default:
			j := i
			for j < len(def) && !strings.ContainsRune(" \t\n\r()'", rune(def[j])) {
				j++
			}
			toks = append(toks, def[i:j])
			i = j
		}
	}
	return toks
}

// list reads either a single value or "( a $ b )" starting at toks[i];
// it returns the values and the next index.
func list(toks []string, i int) ([]string, int) {
	if i >= len(toks) {
		return nil, i
	}
	if toks[i] != "(" {
		return []string{strings.TrimPrefix(toks[i], "'")}, i + 1
	}
	var out []string
	i++
	for i < len(toks) && toks[i] != ")" {
		if toks[i] != "$" {
			out = append(out, strings.TrimPrefix(toks[i], "'"))
		}
		i++
	}
	return out, i + 1
}

func parseAttrType(def string) *AttrType {
	toks := tokenize(def)
	if len(toks) < 2 || toks[0] != "(" {
		return nil
	}
	a := &AttrType{OID: toks[1], Usage: "userApplications"}
	for i := 2; i < len(toks); {
		switch strings.ToUpper(toks[i]) {
		case "NAME":
			a.Names, i = list(toks, i+1)
		case "DESC":
			if i+1 < len(toks) {
				a.Desc = strings.TrimPrefix(toks[i+1], "'")
			}
			i += 2
		case "SYNTAX":
			if i+1 < len(toks) {
				a.Syntax = strings.TrimPrefix(toks[i+1], "'")
				if j := strings.IndexByte(a.Syntax, '{'); j >= 0 {
					a.Syntax = a.Syntax[:j]
				}
			}
			i += 2
		case "SUP":
			if i+1 < len(toks) {
				a.Sup = strings.TrimPrefix(toks[i+1], "'")
			}
			i += 2
		case "USAGE":
			if i+1 < len(toks) {
				a.Usage = toks[i+1]
			}
			i += 2
		case "SINGLE-VALUE":
			a.SingleValue = true
			i++
		case "NO-USER-MODIFICATION":
			a.NoUserMod = true
			i++
		case "EQUALITY":
			if i+1 < len(toks) {
				a.Equality = toks[i+1]
			}
			i += 2
		case "ORDERING", "SUBSTR", "X-ORIGIN", "X-ORDERED", "X-SCHEMA-FILE":
			_, i = list(toks, i+1)
		default:
			i++
		}
	}
	return a
}

func parseObjClass(def string) *ObjClass {
	toks := tokenize(def)
	if len(toks) < 2 || toks[0] != "(" {
		return nil
	}
	c := &ObjClass{OID: toks[1], Kind: "structural"}
	for i := 2; i < len(toks); {
		switch strings.ToUpper(toks[i]) {
		case "NAME":
			c.Names, i = list(toks, i+1)
		case "DESC":
			if i+1 < len(toks) {
				c.Desc = strings.TrimPrefix(toks[i+1], "'")
			}
			i += 2
		case "SUP":
			c.Sup, i = list(toks, i+1)
		case "MUST":
			c.Must, i = list(toks, i+1)
		case "MAY":
			c.May, i = list(toks, i+1)
		case "STRUCTURAL":
			c.Kind = "structural"
			i++
		case "AUXILIARY":
			c.Kind = "auxiliary"
			i++
		case "ABSTRACT":
			c.Kind = "abstract"
			i++
		default:
			i++
		}
	}
	return c
}

// syntaxNames maps common syntax OIDs to names.
var syntaxNames = map[string]string{
	"1.3.6.1.4.1.1466.115.121.1.5":  "Binary",
	"1.3.6.1.4.1.1466.115.121.1.7":  "Boolean",
	"1.3.6.1.4.1.1466.115.121.1.12": "DN",
	"1.3.6.1.4.1.1466.115.121.1.15": "Directory String",
	"1.3.6.1.4.1.1466.115.121.1.24": "Generalized Time",
	"1.3.6.1.4.1.1466.115.121.1.26": "IA5 String",
	"1.3.6.1.4.1.1466.115.121.1.27": "Integer",
	"1.3.6.1.4.1.1466.115.121.1.28": "JPEG",
	"1.3.6.1.4.1.1466.115.121.1.36": "Numeric String",
	"1.3.6.1.4.1.1466.115.121.1.38": "OID",
	"1.3.6.1.4.1.1466.115.121.1.40": "Octet String",
	"1.3.6.1.4.1.1466.115.121.1.41": "Postal Address",
	"1.3.6.1.4.1.1466.115.121.1.44": "Printable String",
	"1.3.6.1.4.1.1466.115.121.1.50": "Telephone Number",
	"1.3.6.1.4.1.1466.115.121.1.53": "UTC Time",
	"1.3.6.1.4.1.1466.115.121.1.8":  "Certificate",
	"1.3.6.1.4.1.1466.115.121.1.34": "Name And Optional UID",
	"1.2.840.113556.1.4.903":        "DN-Binary (AD)",
	"1.2.840.113556.1.4.904":        "DN-String (AD)",
	"1.2.840.113556.1.4.906":        "Large Integer (AD)",
	"1.2.840.113556.1.4.907":        "NT Security Descriptor (AD)",
	"1.2.840.113556.1.4.1221":       "Case-insensitive String (AD)",
	"1.2.840.113556.1.4.1362":       "Case-sensitive String (AD)",
	"2.5.5.1":                       "DN (AD)",
}

// IsDNSyntax reports whether the attribute holds DNs.
func (s *Schema) IsDNSyntax(name string) bool {
	if a := s.Attr(name); a != nil {
		if a.Syntax == "1.3.6.1.4.1.1466.115.121.1.12" || a.Syntax == "2.5.5.1" {
			return true
		}
		if a.Sup != "" && !strings.EqualFold(a.Sup, name) {
			if sup := s.Attr(a.Sup); sup != nil && sup != a {
				return sup.Syntax == "1.3.6.1.4.1.1466.115.121.1.12"
			}
		}
		return false
	}
	return knownDNAttrs[strings.ToLower(BaseAttr(name))]
}

var knownDNAttrs = map[string]bool{
	"member": true, "memberof": true, "uniquemember": true, "manager": true, "directreports": true,
	"distinguishedname": true, "managedby": true, "owner": true, "seealso": true, "secretary": true,
	"objectcategory": true, "defaultobjectcategory": true, "roleoccupant": true, "pwdpolicysubentry": true,
	"creatorsname": true, "modifiersname": true, "subschemasubentry": true,
}
