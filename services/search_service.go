package services

import (
	"context"

	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// SearchService provides LDAP search capabilities.
type SearchService struct {
	ctx  context.Context
	pool *internalldap.Pool
}

// NewSearchService creates a new SearchService.
func NewSearchService(pool *internalldap.Pool) *SearchService {
	return &SearchService{
		pool: pool,
	}
}

// SetContext sets the Wails application context.
func (s *SearchService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// Search performs an LDAP search with the given parameters.
func (s *SearchService) Search(profileID string, params models.SearchParams) (*models.SearchResult, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.Search(params)
}

// ValidateFilter checks whether the given LDAP filter string is syntactically valid.
func (s *SearchService) ValidateFilter(filter string) error {
	return internalldap.ValidateFilter(filter)
}
