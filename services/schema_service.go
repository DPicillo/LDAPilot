package services

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// SchemaService handles schema-related operations.
type SchemaService struct {
	pool  *ldap.Pool
	ctx   context.Context
	cache map[string]*models.SchemaInfo
	mu    sync.RWMutex
}

// NewSchemaService creates a new SchemaService.
func NewSchemaService(pool *ldap.Pool) *SchemaService {
	return &SchemaService{
		pool:  pool,
		cache: make(map[string]*models.SchemaInfo),
	}
}

// SetContext sets the Wails context.
func (s *SchemaService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// GetSchema retrieves the schema for a connection, using cache.
func (s *SchemaService) GetSchema(profileID string) (*models.SchemaInfo, error) {
	// Check cache
	s.mu.RLock()
	if cached, ok := s.cache[profileID]; ok {
		s.mu.RUnlock()
		return cached, nil
	}
	s.mu.RUnlock()

	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, fmt.Errorf("not connected: %w", err)
	}

	schema, err := client.GetSchema()
	if err != nil {
		return nil, fmt.Errorf("failed to read schema: %w", err)
	}

	// Cache the result
	s.mu.Lock()
	s.cache[profileID] = schema
	s.mu.Unlock()

	return schema, nil
}

// RefreshSchema clears cached schema and re-reads it.
func (s *SchemaService) RefreshSchema(profileID string) (*models.SchemaInfo, error) {
	s.mu.Lock()
	delete(s.cache, profileID)
	s.mu.Unlock()

	return s.GetSchema(profileID)
}

// ClearCache removes the cached schema for a profile (e.g. on disconnect).
func (s *SchemaService) ClearCache(profileID string) {
	s.mu.Lock()
	delete(s.cache, profileID)
	s.mu.Unlock()
}

// GetObjectClass retrieves a single objectClass by name.
func (s *SchemaService) GetObjectClass(profileID string, name string) (*models.SchemaObjectClass, error) {
	schema, err := s.GetSchema(profileID)
	if err != nil {
		return nil, err
	}

	for _, oc := range schema.ObjectClasses {
		if oc.Name == name {
			return &oc, nil
		}
	}

	return nil, fmt.Errorf("objectClass %q not found", name)
}

// GetObjectClassDetails returns detailed information about an objectClass,
// including its MUST/MAY attributes and type (structural/auxiliary/abstract).
func (s *SchemaService) GetObjectClassDetails(profileID string, name string) (*models.ObjectClassInfo, error) {
	schema, err := s.GetSchema(profileID)
	if err != nil {
		return nil, err
	}

	for _, oc := range schema.ObjectClasses {
		if strings.EqualFold(oc.Name, name) {
			return &models.ObjectClassInfo{
				Name:        oc.Name,
				OID:         oc.OID,
				Description: oc.Description,
				Superior:    oc.SuperClass,
				Must:        oc.Must,
				May:         oc.May,
				Type:        oc.Kind,
			}, nil
		}
	}

	return nil, fmt.Errorf("objectClass %q not found", name)
}

// GetRequiredAttributes collects all MUST attributes from the given objectClasses,
// walking the inheritance chain via SUP for each class.
func (s *SchemaService) GetRequiredAttributes(profileID string, objectClasses []string) ([]string, error) {
	schema, err := s.GetSchema(profileID)
	if err != nil {
		return nil, err
	}

	mustSet := make(map[string]bool)
	for _, ocName := range objectClasses {
		collectMustAttrs(schema, ocName, mustSet)
	}

	result := make([]string, 0, len(mustSet))
	for attr := range mustSet {
		result = append(result, attr)
	}
	return result, nil
}

// collectMustAttrs recursively walks the SUP chain of an objectClass and adds
// all MUST attributes to the provided set (case-insensitive key).
func collectMustAttrs(schema *models.SchemaInfo, ocName string, mustSet map[string]bool) {
	for _, oc := range schema.ObjectClasses {
		if strings.EqualFold(oc.Name, ocName) {
			for _, attr := range oc.Must {
				mustSet[attr] = true
			}
			// Walk the superclass chain
			for _, sup := range oc.SuperClass {
				collectMustAttrs(schema, sup, mustSet)
			}
			return
		}
	}
}

// ValidateEntry validates that an entry's attributes satisfy the schema
// requirements for the given objectClasses. It checks:
//   - At least one structural objectClass exists
//   - All MUST attributes (including inherited) are present and non-empty
func (s *SchemaService) ValidateEntry(profileID string, objectClasses []string, attributes map[string][]string) []models.ValidationError {
	var errors []models.ValidationError

	schema, err := s.GetSchema(profileID)
	if err != nil {
		errors = append(errors, models.ValidationError{
			Attribute: "",
			Message:   fmt.Sprintf("Failed to load schema: %v", err),
			Type:      "error",
		})
		return errors
	}

	// Check for at least one structural objectClass
	hasStructural := false
	for _, ocName := range objectClasses {
		for _, oc := range schema.ObjectClasses {
			if strings.EqualFold(oc.Name, ocName) && oc.Kind == "structural" {
				hasStructural = true
				break
			}
		}
		if hasStructural {
			break
		}
	}
	if !hasStructural {
		errors = append(errors, models.ValidationError{
			Attribute: "objectClass",
			Message:   "At least one structural objectClass is required",
			Type:      "error",
		})
	}

	// Collect all MUST attributes from all objectClasses (including inherited)
	mustSet := make(map[string]bool)
	for _, ocName := range objectClasses {
		collectMustAttrs(schema, ocName, mustSet)
	}

	// Build a case-insensitive lookup of provided attributes
	attrLower := make(map[string][]string)
	for name, values := range attributes {
		attrLower[strings.ToLower(name)] = values
	}

	// Check each required attribute is present and non-empty
	for mustAttr := range mustSet {
		lower := strings.ToLower(mustAttr)
		// Skip objectClass itself — it's handled separately
		if lower == "objectclass" {
			continue
		}

		values, exists := attrLower[lower]
		if !exists || len(values) == 0 {
			errors = append(errors, models.ValidationError{
				Attribute: mustAttr,
				Message:   fmt.Sprintf("Required attribute %q is missing", mustAttr),
				Type:      "error",
			})
			continue
		}

		// Check that at least one value is non-empty
		allEmpty := true
		for _, v := range values {
			if strings.TrimSpace(v) != "" {
				allEmpty = false
				break
			}
		}
		if allEmpty {
			errors = append(errors, models.ValidationError{
				Attribute: mustAttr,
				Message:   fmt.Sprintf("Required attribute %q must have a non-empty value", mustAttr),
				Type:      "error",
			})
		}
	}

	return errors
}
