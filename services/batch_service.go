package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// BatchService provides batch LDAP operations (delete, modify, move).
type BatchService struct {
	ctx    context.Context
	pool   *ldap.Pool
	logger *LogService
}

// NewBatchService creates a new BatchService.
func NewBatchService(pool *ldap.Pool, logger *LogService) *BatchService {
	return &BatchService{pool: pool, logger: logger}
}

// SetContext stores the Wails application context (called from OnStartup).
func (s *BatchService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// BatchResult contains the outcome of a batch operation.
type BatchResult struct {
	Total     int          `json:"total"`
	Succeeded int          `json:"succeeded"`
	Failed    int          `json:"failed"`
	Errors    []BatchError `json:"errors"`
}

// BatchError describes a single failure within a batch operation.
type BatchError struct {
	DN      string `json:"dn"`
	Message string `json:"message"`
}

// BatchModifyChange describes a single attribute modification to apply.
type BatchModifyChange struct {
	Operation string   `json:"operation"` // "add", "replace", "delete"
	Attribute string   `json:"attribute"`
	Values    []string `json:"values"`
}

// BatchDelete deletes multiple LDAP entries. Entries are processed in reverse
// order (children-first) so that child entries are removed before their parents.
// The operation continues on individual failures and collects all errors.
func (s *BatchService) BatchDelete(profileID string, dns []string) BatchResult {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return BatchResult{
			Total:  len(dns),
			Failed: len(dns),
			Errors: []BatchError{{DN: "", Message: fmt.Sprintf("connection error: %v", err)}},
		}
	}

	total := len(dns)
	result := BatchResult{Total: total}

	// Process in reverse order so children are deleted before parents
	for i := total - 1; i >= 0; i-- {
		dn := dns[i]

		// Emit progress event
		wailsRuntime.EventsEmit(s.ctx, "batch:progress", map[string]interface{}{
			"current":   total - i,
			"total":     total,
			"currentDN": dn,
			"operation": "delete",
		})

		if err := client.DeleteEntry(dn); err != nil {
			result.Failed++
			result.Errors = append(result.Errors, BatchError{
				DN:      dn,
				Message: err.Error(),
			})
		} else {
			result.Succeeded++
		}
	}

	return result
}

// BatchModify applies attribute changes to multiple LDAP entries.
// Supported operations: "add" (AddAttribute), "replace" (ModifyAttribute),
// "delete" (DeleteAttribute).
func (s *BatchService) BatchModify(profileID string, dns []string, changes []BatchModifyChange) BatchResult {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return BatchResult{
			Total:  len(dns),
			Failed: len(dns),
			Errors: []BatchError{{DN: "", Message: fmt.Sprintf("connection error: %v", err)}},
		}
	}

	total := len(dns)
	result := BatchResult{Total: total}

	for i, dn := range dns {
		// Emit progress event
		wailsRuntime.EventsEmit(s.ctx, "batch:progress", map[string]interface{}{
			"current":   i + 1,
			"total":     total,
			"currentDN": dn,
			"operation": "modify",
		})

		var opErr error
		for _, change := range changes {
			switch strings.ToLower(change.Operation) {
			case "add":
				opErr = client.AddAttribute(dn, change.Attribute, change.Values)
			case "replace":
				opErr = client.ModifyAttribute(dn, change.Attribute, change.Values)
			case "delete":
				opErr = client.DeleteAttribute(dn, change.Attribute)
			default:
				opErr = fmt.Errorf("unknown operation: %s", change.Operation)
			}
			if opErr != nil {
				break
			}
		}

		if opErr != nil {
			result.Failed++
			result.Errors = append(result.Errors, BatchError{
				DN:      dn,
				Message: opErr.Error(),
			})
		} else {
			result.Succeeded++
		}
	}

	return result
}

// BatchMove moves multiple LDAP entries to a new parent container.
// Each entry's RDN is extracted from its current DN and used to construct
// the ModifyDN (rename/move) request.
func (s *BatchService) BatchMove(profileID string, dns []string, newParentDN string) BatchResult {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return BatchResult{
			Total:  len(dns),
			Failed: len(dns),
			Errors: []BatchError{{DN: "", Message: fmt.Sprintf("connection error: %v", err)}},
		}
	}

	total := len(dns)
	result := BatchResult{Total: total}

	for i, dn := range dns {
		// Emit progress event
		wailsRuntime.EventsEmit(s.ctx, "batch:progress", map[string]interface{}{
			"current":   i + 1,
			"total":     total,
			"currentDN": dn,
			"operation": "move",
		})

		// Extract the RDN (first component) from the DN
		rdn := extractFirstRDN(dn)
		if rdn == "" {
			result.Failed++
			result.Errors = append(result.Errors, BatchError{
				DN:      dn,
				Message: "could not extract RDN from DN",
			})
			continue
		}

		// RenameEntry(dn, newRDN, deleteOldRDN, newSuperior)
		if err := client.RenameEntry(dn, rdn, true, newParentDN); err != nil {
			result.Failed++
			result.Errors = append(result.Errors, BatchError{
				DN:      dn,
				Message: err.Error(),
			})
		} else {
			result.Succeeded++
		}
	}

	return result
}

// extractFirstRDN extracts the first RDN component from a DN string,
// handling escaped commas correctly.
func extractFirstRDN(dn string) string {
	parts := splitDN(dn)
	if len(parts) == 0 {
		return ""
	}
	return parts[0]
}

// splitDN splits a DN by unescaped commas into its RDN components.
func splitDN(dn string) []string {
	var parts []string
	var current strings.Builder
	escaped := false

	for _, ch := range dn {
		if escaped {
			current.WriteRune(ch)
			escaped = false
			continue
		}
		if ch == '\\' {
			current.WriteRune(ch)
			escaped = true
			continue
		}
		if ch == ',' {
			part := strings.TrimSpace(current.String())
			if part != "" {
				parts = append(parts, part)
			}
			current.Reset()
			continue
		}
		current.WriteRune(ch)
	}

	// Don't forget the last component
	part := strings.TrimSpace(current.String())
	if part != "" {
		parts = append(parts, part)
	}

	return parts
}
