package models

// TreeNode represents a node in the LDAP directory tree for the browser UI.
type TreeNode struct {
	DN          string     `json:"dn"`
	RDN         string     `json:"rdn"`
	HasChildren bool       `json:"hasChildren"`
	ObjectClass []string   `json:"objectClass"`
	Icon        string     `json:"icon"`
	Children    []TreeNode `json:"children,omitempty"`
}

// LDAPAttribute represents a single LDAP attribute with its values.
type LDAPAttribute struct {
	Name   string   `json:"name"`
	Values []string `json:"values"`
	Binary bool     `json:"binary"`
}

// LDAPEntry represents a single LDAP directory entry.
type LDAPEntry struct {
	DN         string          `json:"dn"`
	Attributes []LDAPAttribute `json:"attributes"`
}
