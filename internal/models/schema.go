package models

import "strings"

// SchemaObjectClass represents an LDAP objectClass definition. SuperClass,
// Must and May hold the primary names of the classes / attribute types they
// refer to, also when the definition used an alias or an OID (cosine's
// account: MUST userid -> uid).
type SchemaObjectClass struct {
	OID         string   `json:"oid"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	SuperClass  []string `json:"superClass"`
	Kind        string   `json:"kind"` // "structural", "auxiliary", "abstract"
	Must        []string `json:"must"`
	May         []string `json:"may"`
	// Aliases are the further NAMEs of the class (newPilotPerson for
	// pilotPerson).
	Aliases []string `json:"aliases,omitempty"`
}

// SchemaAttribute represents an LDAP attributeType definition.
type SchemaAttribute struct {
	OID         string `json:"oid"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Syntax      string `json:"syntax"`
	SyntaxName  string `json:"syntaxName"`
	SingleValue bool   `json:"singleValue"`
	NoUserMod   bool   `json:"noUserMod"`
	Usage       string `json:"usage"` // "userApplications", "directoryOperation", etc.
	SuperType   string `json:"superType"`
	Equality    string `json:"equality"`
	Ordering    string `json:"ordering"`
	Substring   string `json:"substring"`
	// Aliases are the further NAMEs of the type ("surname" for sn,
	// "rfc822Mailbox" for mail): accepted wherever a name is typed.
	Aliases []string `json:"aliases,omitempty"`
}

// HasName reports whether name (case-insensitive) or oid is the attribute
// type's name, one of its aliases or its OID.
func (a *SchemaAttribute) HasName(name string) bool {
	return hasSchemaName(name, a.OID, a.Name, a.Aliases)
}

// HasName reports whether name (case-insensitive) or oid is the class's
// name, one of its aliases or its OID.
func (o *SchemaObjectClass) HasName(name string) bool {
	return hasSchemaName(name, o.OID, o.Name, o.Aliases)
}

func hasSchemaName(name, oid, primary string, aliases []string) bool {
	name = strings.TrimSpace(name)
	if name == "" {
		return false
	}
	if name == oid || strings.EqualFold(name, primary) {
		return true
	}
	for _, a := range aliases {
		if strings.EqualFold(name, a) {
			return true
		}
	}
	return false
}

// SchemaInfo contains the full schema of an LDAP directory.
type SchemaInfo struct {
	ObjectClasses []SchemaObjectClass `json:"objectClasses"`
	Attributes    []SchemaAttribute   `json:"attributes"`
}

// FindAttribute returns the attribute type with the name, alias or OID
// (attribute options such as ";binary" ignored), nil when unknown.
func (s *SchemaInfo) FindAttribute(name string) *SchemaAttribute {
	if s == nil {
		return nil
	}
	if i := strings.IndexByte(name, ';'); i >= 0 {
		name = name[:i]
	}
	name = strings.TrimSpace(name)
	// A primary name or OID first: an alias never shadows another type.
	for i := range s.Attributes {
		if a := &s.Attributes[i]; name != "" && (strings.EqualFold(a.Name, name) || a.OID == name) {
			return a
		}
	}
	for i := range s.Attributes {
		if s.Attributes[i].HasName(name) {
			return &s.Attributes[i]
		}
	}
	return nil
}

// FindObjectClass returns the object class with the name, alias or OID, nil
// when unknown.
func (s *SchemaInfo) FindObjectClass(name string) *SchemaObjectClass {
	if s == nil {
		return nil
	}
	name = strings.TrimSpace(name)
	for i := range s.ObjectClasses {
		if o := &s.ObjectClasses[i]; name != "" && (strings.EqualFold(o.Name, name) || o.OID == name) {
			return o
		}
	}
	for i := range s.ObjectClasses {
		if s.ObjectClasses[i].HasName(name) {
			return &s.ObjectClasses[i]
		}
	}
	return nil
}

// AttributeName returns the primary name of the attribute type with the
// name, alias or OID, or name itself when the schema does not know it.
func (s *SchemaInfo) AttributeName(name string) string {
	if a := s.FindAttribute(name); a != nil {
		return a.Name
	}
	return name
}
