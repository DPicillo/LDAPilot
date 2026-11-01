package models

// TreeNode represents a node in the LDAP directory tree for the browser UI.
type TreeNode struct {
	DN          string     `json:"dn"`
	RDN         string     `json:"rdn"`
	HasChildren bool       `json:"hasChildren"`
	ObjectClass []string   `json:"objectClass"`
	Icon        string     `json:"icon"`
	Children    []TreeNode `json:"children,omitempty"`
	// Status lists account states that a one-level read can tell reliably
	// ("disabled", "expired", "locked"); empty when unknown or not an
	// account. "locked" only for 389DS accountUnlockTime lockouts and OpenLDAP
	// pwdAccountLockedTime checked against the entry's policy, never on AD
	// (needs the constructed msDS-User-Account-Control-Computed of a
	// base-scope read); see internal/ldap/tree_status.go.
	Status []string `json:"status,omitempty"`
	// LoginAttributes lists which of uid / userPassword / authPassword /
	// krbPrincipalName / sambaNTPassword an LDAP person (no account class)
	// has: [] = none (a contact), null = unknown or not a person (M-06).
	LoginAttributes []string `json:"loginAttributes"`
}

// LDAPAttribute represents a single LDAP attribute with its values.
//
// Binary contract: when Binary is true, every value is the standard base64
// encoding (RFC 4648 StdEncoding, padded) of the raw attribute bytes. When
// Binary is false, values are text (valid UTF-8). This holds for attributes
// read from the server and for attributes passed to write operations.
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

// Attribute change operations of an AttributeChange.
const (
	ChangeAdd     = "add"
	ChangeDelete  = "delete"
	ChangeReplace = "replace"
)

// AttributeChange is one change of a modify operation. All changes passed to
// a single modify are applied atomically by the server.
//
// Operation is "add", "delete" or "replace". A delete with empty Values
// removes the whole attribute, otherwise only the given values; a replace
// with empty Values removes the attribute as well. When Binary is true, Values
// are base64 encoded raw bytes (see LDAPAttribute). unicodePwd values are
// plain-text passwords unless Binary is true; they are encoded for AD
// automatically.
type AttributeChange struct {
	Operation string   `json:"operation"`
	Attribute string   `json:"attribute"`
	Values    []string `json:"values"`
	Binary    bool     `json:"binary"`
}
