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

	// ShowDeleted sends the AD Show Deleted control (1.2.840.113556.1.4.417)
	// so that deleted objects (tombstones) are returned.
	ShowDeleted bool `json:"showDeleted,omitempty"`
	// ShowRecycled sends the AD Show Recycled control (1.2.840.113556.1.4.2064)
	// so that recycled objects are returned as well.
	ShowRecycled bool `json:"showRecycled,omitempty"`
	// ManageDsaIT sends the ManageDsaIT control (2.16.840.1.113730.3.4.2) so
	// that referral objects are returned as entries instead of referrals.
	ManageDsaIT bool `json:"manageDsaIT,omitempty"`
}

// SearchResult holds the results of an LDAP search operation.
type SearchResult struct {
	Entries    []LDAPEntry `json:"entries"`
	TotalCount int         `json:"totalCount"`
	Truncated  bool        `json:"truncated"`
}
