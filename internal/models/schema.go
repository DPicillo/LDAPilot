package models

// SchemaObjectClass represents an LDAP objectClass definition.
type SchemaObjectClass struct {
	OID         string   `json:"oid"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	SuperClass  []string `json:"superClass"`
	Kind        string   `json:"kind"` // "structural", "auxiliary", "abstract"
	Must        []string `json:"must"`
	May         []string `json:"may"`
}

// SchemaAttribute represents an LDAP attributeType definition.
type SchemaAttribute struct {
	OID          string `json:"oid"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	Syntax       string `json:"syntax"`
	SyntaxName   string `json:"syntaxName"`
	SingleValue  bool   `json:"singleValue"`
	NoUserMod    bool   `json:"noUserMod"`
	Usage        string `json:"usage"` // "userApplications", "directoryOperation", etc.
	SuperType    string `json:"superType"`
	Equality     string `json:"equality"`
	Ordering     string `json:"ordering"`
	Substring    string `json:"substring"`
}

// SchemaInfo contains the full schema of an LDAP directory.
type SchemaInfo struct {
	ObjectClasses []SchemaObjectClass `json:"objectClasses"`
	Attributes    []SchemaAttribute   `json:"attributes"`
}
