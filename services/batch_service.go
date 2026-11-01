package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/ldap"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// BatchService provides batch LDAP operations: move, and bulk modify with
// preview/apply (bulk_batch.go). Deletes go through EditorService
// (DeleteEntry, DeleteSubtree). All operations are refused on read-only
// connections and every applied change is written to the audit log.
type BatchService struct {
	ctx        context.Context
	pool       *ldap.Pool
	logger     *LogService
	auditStore *config.AuditStore
}

// NewBatchService creates a new BatchService.
func NewBatchService(pool *ldap.Pool, logger *LogService) *BatchService {
	return &BatchService{pool: pool, logger: logger}
}

// SetAuditStore sets the audit store for persistent change logging.
func (s *BatchService) SetAuditStore(store *config.AuditStore) {
	s.auditStore = store
}

func (s *BatchService) audit(profileID, operation, dn, details string, err error) {
	writeAudit(s.auditStore, s.pool, profileID, operation, dn, details, err)
}

// writableClient returns the client of profileID, or a result that fails all
// total entries when the profile is not connected or read-only.
func (s *BatchService) writableClient(profileID string, total int) (*ldap.Client, *BatchResult) {
	client, err := s.pool.Get(profileID)
	if err == nil {
		err = client.CheckWritable()
	}
	if err != nil {
		return nil, &BatchResult{
			Total:  total,
			Failed: total,
			Errors: []BatchError{{DN: "", Message: fmt.Sprintf("connection error: %v", err)}},
		}
	}
	return client, nil
}

// emitProgress sends a batch:progress event to the frontend. Without a Wails
// context (tests) nothing is sent.
func (s *BatchService) emitProgress(data map[string]interface{}) {
	if s.ctx == nil {
		return
	}
	wailsRuntime.EventsEmit(s.ctx, "batch:progress", data)
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
	// Unchanged counts entries that needed no change (BatchMove: already in
	// the target container).
	Unchanged int `json:"unchanged,omitempty"`
	// Moved lists the old and new DN of every entry BatchMove moved.
	Moved []BatchMoved `json:"moved,omitempty"`
	// Refused is set when BatchMove ran nothing because the target is
	// unusable (does not exist, is one of the entries or below one); the
	// reason is in Errors.
	Refused bool `json:"refused,omitempty"`
}

// BatchMoved is one entry moved by BatchMove.
type BatchMoved struct {
	DN    string `json:"dn"`
	NewDN string `json:"newDN"`
}

// BatchError describes a single failure within a batch operation.
type BatchError struct {
	DN      string `json:"dn"`
	Message string `json:"message"`
}

// BatchMove moves multiple LDAP entries to a new parent container.
// Each entry's RDN is extracted from its current DN and used to construct
// the ModifyDN (rename/move) request. Nothing is moved when the target
// container does not exist (or cannot be checked) or is one of the entries
// or lies below one of them: the result is Refused with the reason, so a
// typo in the target never runs. Entries already in the target count as
// Unchanged; moved entries are listed in Moved with their new DN.
func (s *BatchService) BatchMove(profileID string, dns []string, newParentDN string) BatchResult {
	client, failed := s.writableClient(profileID, len(dns))
	if failed != nil {
		return *failed
	}

	total := len(dns)
	newParentDN = strings.TrimSpace(newParentDN)
	if reason := batchMoveTargetProblem(dns, newParentDN); reason == "" {
		exists, err := client.EntryExists(newParentDN)
		switch {
		case err != nil:
			return refusedBatch(total, fmt.Sprintf("the target container %s could not be checked: %v", newParentDN, err))
		case !exists:
			return refusedBatch(total, fmt.Sprintf("the target container %s does not exist", newParentDN))
		}
	} else {
		return refusedBatch(total, reason)
	}

	result := BatchResult{Total: total, Errors: []BatchError{}, Moved: []BatchMoved{}}

	for i, dn := range dns {
		// Emit progress event
		s.emitProgress(map[string]interface{}{
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
		if batchSameDN(batchParentDN(dn), newParentDN) {
			result.Unchanged++
			continue
		}

		// RenameEntry(dn, newRDN, deleteOldRDN, newSuperior)
		err := client.RenameEntry(dn, rdn, true, newParentDN)
		s.audit(profileID, "MOVE", dn, fmt.Sprintf("batch move: newRDN=%s newSuperior=%s", rdn, newParentDN), err)
		if err != nil {
			result.Failed++
			result.Errors = append(result.Errors, BatchError{
				DN:      dn,
				Message: err.Error(),
			})
		} else {
			result.Succeeded++
			result.Moved = append(result.Moved, BatchMoved{DN: dn, NewDN: rdn + "," + newParentDN})
		}
	}

	return result
}

// BatchMovePlan is the dry run of BatchMove (BatchMovePreview).
type BatchMovePlan struct {
	Total int `json:"total"`
	// Ready counts the entries that will be moved.
	Ready int `json:"ready"`
	// Unchanged counts the entries already in the target container.
	Unchanged int `json:"unchanged"`
	// Failing counts the entries predicted to fail (Items say why).
	Failing int `json:"failing"`
	// Refused is set when nothing can move (target missing, one of the
	// entries or below one, read-only or lost connection); Reason says why.
	Refused bool                `json:"refused,omitempty"`
	Reason  string              `json:"reason,omitempty"`
	Items   []BatchMovePlanItem `json:"items"`
}

// BatchMovePlanItem is the prediction for one entry: status "move" (with
// the new DN), "unchanged" (already there) or "fail" (Message says why).
type BatchMovePlanItem struct {
	DN      string `json:"dn"`
	NewDN   string `json:"newDN,omitempty"`
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

// BatchMovePreview checks a batch move without writing anything: the
// target the same way BatchMove does (exists, not one of the entries or
// below one), then per entry whether it still exists, is already in the
// target, or whose name is taken there (by an existing entry or by another
// entry of the same move). The results / batch Move flow shows it as the
// confirmation step (RW3-S-07).
func (s *BatchService) BatchMovePreview(profileID string, dns []string, newParentDN string) BatchMovePlan {
	client, failed := s.writableClient(profileID, len(dns))
	if failed != nil {
		return BatchMovePlan{Total: len(dns), Refused: true, Reason: failed.Errors[0].Message, Items: []BatchMovePlanItem{}}
	}
	return planBatchMove(client, dns, newParentDN)
}

// entryExistence is the read access the move dry run needs (*ldap.Client).
type entryExistence interface {
	EntryExists(dn string) (bool, error)
}

func planBatchMove(c entryExistence, dns []string, newParentDN string) BatchMovePlan {
	target := strings.TrimSpace(newParentDN)
	plan := BatchMovePlan{Total: len(dns), Items: []BatchMovePlanItem{}}
	refuse := func(reason string) BatchMovePlan {
		plan.Refused, plan.Reason = true, reason
		return plan
	}
	if reason := batchMoveTargetProblem(dns, target); reason != "" {
		return refuse(reason)
	}
	switch exists, err := c.EntryExists(target); {
	case err != nil:
		return refuse(fmt.Sprintf("the target container %s could not be checked: %v", target, err))
	case !exists:
		return refuse(fmt.Sprintf("the target container %s does not exist", target))
	}
	// New DNs taken by an earlier entry of this move (two "cn=a" from different containers).
	taken := map[string]string{}
	for _, dn := range dns {
		item := BatchMovePlanItem{DN: dn}
		rdn := extractFirstRDN(dn)
		switch {
		case rdn == "":
			item.Status, item.Message = "fail", "could not extract RDN from DN"
		case batchSameDN(batchParentDN(dn), target):
			item.Status, item.Message = "unchanged", "already in the target container"
		default:
			item.NewDN = rdn + "," + target
			key := batchDNKey(item.NewDN)
			if other, dup := taken[key]; dup {
				item.Status, item.Message = "fail", fmt.Sprintf("%s takes the same name in the target container", other)
				break
			}
			if ok, err := c.EntryExists(dn); err != nil {
				item.Status, item.Message = "fail", fmt.Sprintf("could not be checked: %v", err)
				break
			} else if !ok {
				item.Status, item.Message = "fail", "the entry does not exist (any more)"
				break
			}
			if ok, err := c.EntryExists(item.NewDN); err != nil {
				item.Status, item.Message = "fail", fmt.Sprintf("the new name could not be checked: %v", err)
				break
			} else if ok {
				item.Status, item.Message = "fail", "an entry with this name already exists in the target container"
				break
			}
			taken[key] = dn
			item.Status = "move"
		}
		switch item.Status {
		case "move":
			plan.Ready++
		case "unchanged":
			plan.Unchanged++
		default:
			plan.Failing++
		}
		plan.Items = append(plan.Items, item)
	}
	return plan
}

// refusedBatch fails all total entries of a batch that did not run.
func refusedBatch(total int, reason string) BatchResult {
	return BatchResult{Total: total, Failed: total, Refused: true, Errors: []BatchError{{DN: "", Message: reason}}}
}

// batchMoveTargetProblem returns why newParentDN cannot take the entries
// (empty, one of them, or below one of them), or "".
func batchMoveTargetProblem(dns []string, newParentDN string) string {
	if newParentDN == "" {
		return "no target container given"
	}
	target := batchDNKey(newParentDN)
	for _, dn := range dns {
		k := batchDNKey(dn)
		if k == "" {
			continue
		}
		if target == k {
			return fmt.Sprintf("the target container %s is one of the entries to move", newParentDN)
		}
		if strings.HasSuffix(target, ","+k) {
			return fmt.Sprintf("the target container %s lies below %s, one of the entries to move", newParentDN, dn)
		}
	}
	return ""
}

// batchDNKey is a comparison key of a DN: RDNs trimmed and lowercased
// (escape-aware split).
func batchDNKey(dn string) string {
	parts := splitDN(dn)
	for i, p := range parts {
		if typ, val, ok := strings.Cut(p, "="); ok {
			parts[i] = strings.ToLower(strings.TrimSpace(typ)) + "=" + strings.ToLower(strings.TrimSpace(val))
		} else {
			parts[i] = strings.ToLower(p)
		}
	}
	return strings.Join(parts, ",")
}

// batchParentDN is the DN without its first RDN.
func batchParentDN(dn string) string {
	parts := splitDN(dn)
	if len(parts) < 2 {
		return ""
	}
	return strings.Join(parts[1:], ",")
}

func batchSameDN(a, b string) bool {
	return a != "" && batchDNKey(a) == batchDNKey(b)
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
