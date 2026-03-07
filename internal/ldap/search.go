package ldap

import (
	"fmt"

	goldap "github.com/go-ldap/ldap/v3"
)

// ValidateFilter checks whether the given LDAP filter string is syntactically valid.
func ValidateFilter(filter string) error {
	_, err := goldap.CompileFilter(filter)
	if err != nil {
		return fmt.Errorf("invalid LDAP filter: %w", err)
	}
	return nil
}
