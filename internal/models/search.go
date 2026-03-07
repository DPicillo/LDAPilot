package models

// SearchScope represents the scope of an LDAP search operation.
type SearchScope int

const (
	// ScopeBase searches only the base object.
	ScopeBase SearchScope = 0
	// ScopeOne searches one level below the base.
	ScopeOne SearchScope = 1
	// ScopeSub searches the entire subtree.
	ScopeSub SearchScope = 2
)

// SearchParams holds the parameters for an LDAP search operation.
type SearchParams struct {
	BaseDN     string      `json:"baseDN"`
	Filter     string      `json:"filter"`
	Scope      SearchScope `json:"scope"`
	Attributes []string    `json:"attributes"`
	SizeLimit  int         `json:"sizeLimit"`
	TimeLimit  int         `json:"timeLimit"`
}

// SearchResult holds the results of an LDAP search operation.
type SearchResult struct {
	Entries    []LDAPEntry `json:"entries"`
	TotalCount int         `json:"totalCount"`
	Truncated  bool        `json:"truncated"`
}
