package services

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// Batch modify with value templates, dry run and stoppable apply.

// bulkPreviewWorkers is the number of entries read in parallel by a preview.
const bulkPreviewWorkers = 4

// BatchPreview is the dry run of a batch modify: for every DN it reads the
// entry, expands the value templates (see bulk_template.go) and simulates the
// changes. It returns per entry the attribute diffs (current values ->
// resulting values), template errors and predicted failures (value to delete
// not present, value to add already present, single-valued attribute,
// NO-USER-MODIFICATION, naming value removed). Nothing is written.
//
// Errors of the request itself (unknown operation, bad attribute name,
// template syntax) are returned as error. The run can be stopped with
// StopBulkRun(options.RunID); the preview is then marked Stopped and lists
// only the processed entries. Progress is sent as "bulk:progress" events
// with phase "preview".
func (s *BatchService) BatchPreview(profileID string, dns []string, changes []models.AttributeChange, options models.BulkOptions) (*models.BulkPreview, error) {
	if len(dns) == 0 {
		return nil, fmt.Errorf("no entries selected")
	}
	compiled, err := compileBatchChanges(changes)
	if err != nil {
		return nil, err
	}
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	sc := loadSchemaContext(client, profileID)
	// The password storage policy is resolved once; a userPassword change
	// shows per entry how its values will be stored.
	var pwPolicy *models.EffectivePasswordPolicy
	if hasPasswordChange(changes) {
		if pwPolicy, err = client.PasswordPolicy(); err != nil {
			return nil, err
		}
	}

	ctx, done := bulkRuns.start(options.RunID)
	defer done()
	progress := newProgressEmitter(s.ctx, options.RunID, "preview", len(dns))

	entries := make([]models.BulkPreviewEntry, len(dns))
	processed := make([]bool, len(dns))
	var (
		mu      sync.Mutex
		count   int
		errorsN int
	)
	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < bulkPreviewWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				if ctx.Err() != nil {
					continue
				}
				dn := dns[i]
				var pe models.BulkPreviewEntry
				entry, err := client.GetEntry(dn)
				if err != nil {
					pe = models.BulkPreviewEntry{DN: dn, Status: models.BulkStatusError, Errors: []string{"cannot read entry: " + err.Error()},
						Warnings: []string{}, Notes: []string{}, Diffs: []models.BulkAttrDiff{}, Changes: []models.AttributeChange{}}
				} else {
					entry.DN = dn // keep the DN as selected
					var resolved []models.AttributeChange
					pe, resolved = planBatchEntry(entry, compiled, options, sc)
					if pwPolicy != nil && pe.Status == models.BulkStatusChange {
						addPasswordPlan(&pe, *pwPolicy, resolved, options.Passwords)
					}
				}
				mu.Lock()
				entries[i] = pe
				processed[i] = true
				count++
				if pe.Status == models.BulkStatusError {
					errorsN++
				}
				c, e := count, errorsN
				mu.Unlock()
				progress.emit(c, dn, c-e, e, 0)
			}
		}()
	}
	for i := range dns {
		if ctx.Err() != nil {
			break
		}
		jobs <- i
	}
	close(jobs)
	wg.Wait()

	preview := &models.BulkPreview{Entries: make([]models.BulkPreviewEntry, 0, len(dns)), Stopped: ctx.Err() != nil}
	for i, pe := range entries {
		if !processed[i] {
			continue
		}
		preview.Entries = append(preview.Entries, pe)
		switch pe.Status {
		case models.BulkStatusChange:
			preview.Changed++
		case models.BulkStatusUnchanged:
			preview.Unchanged++
		case models.BulkStatusSkipped:
			preview.Skipped++
		default:
			preview.Errors++
		}
	}
	preview.Total = len(preview.Entries)
	return preview, nil
}

// BatchApply applies a batch modify. Each entry is re-read and re-planned
// exactly like in BatchPreview, so the result matches the dry run of the
// current directory state; entries with template errors or predicted
// failures are not sent and count as failed, skipped and unchanged entries
// are not written. The changes of one entry are sent as one modify request
// (atomic per entry). Every write is audited as MODIFY.
//
// With options.ContinueOnError false the run stops at the first failed
// entry; StopBulkRun(options.RunID) stops it as well. Remaining entries are
// reported as notProcessed. Progress is sent as "bulk:progress" events with
// phase "apply". Read-only connections are refused with ldap.ErrReadOnly.
func (s *BatchService) BatchApply(profileID string, dns []string, changes []models.AttributeChange, options models.BulkOptions) (*models.BulkApplyResult, error) {
	if len(dns) == 0 {
		return nil, fmt.Errorf("no entries selected")
	}
	compiled, err := compileBatchChanges(changes)
	if err != nil {
		return nil, err
	}
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	if err := client.CheckWritable(); err != nil {
		return nil, err
	}
	sc := loadSchemaContext(client, profileID)

	ctx, done := bulkRuns.start(options.RunID)
	defer done()
	progress := newProgressEmitter(s.ctx, options.RunID, "apply", len(dns))

	res := &models.BulkApplyResult{RunID: options.RunID, Total: len(dns), Items: make([]models.BulkResultItem, 0, len(dns))}
	for i, dn := range dns {
		if ctx.Err() != nil {
			markNotProcessed(res, dns[i:], "modify", "stopped by user")
			break
		}
		start := time.Now()
		item := models.BulkResultItem{DN: dn, Operation: "modify"}
		var writeErr error

		entry, err := client.GetEntry(dn)
		if err != nil {
			item.Status = models.BulkResultFailed
			item.Message = "cannot read entry: " + err.Error()
			writeErr = err
		} else {
			entry.DN = dn
			pe, resolved := planBatchEntry(entry, compiled, options, sc)
			switch pe.Status {
			case models.BulkStatusError:
				item.Status = models.BulkResultFailed
				item.Message = "not sent: " + strings.Join(pe.Errors, "; ")
			case models.BulkStatusSkipped:
				item.Status = models.BulkResultSkipped
				item.Message = strings.Join(pe.Notes, "; ")
			case models.BulkStatusUnchanged:
				item.Status = models.BulkResultUnchanged
				item.Message = strings.Join(pe.Notes, "; ")
			default:
				item.Details = describeChangesForAudit(resolved)
				guard := client.GuardPermanentLock(dn, resolved)
				var report *models.PasswordWriteReport
				report, writeErr = client.ModifyEntryWithPasswordPolicy(dn, resolved, options.Passwords)
				item.Details += describePasswordReport(report)
				// The audit shows the values read for the plan → the new ones.
				s.audit(profileID, "MODIFY", dn, "bulk modify: "+describeChangesWithBefore(resolved, auditBeforeFromEntry(entry, resolved))+describePasswordReport(report), writeErr)
				if writeErr == nil {
					// password warnings first: they are what needs attention
					writeErr = keepDisabledAfterBulk(&item, append(passwordReportMessages(report), pe.Warnings...), guard, func(op, dn, details string, err error) {
						s.audit(profileID, op, dn, details, err)
					})
					item.PasswordWarning = passwordReportWarning(report)
				} else {
					item.Status = models.BulkResultFailed
					item.Message = writeErr.Error()
				}
			}
		}
		item.DurationMs = time.Since(start).Milliseconds()
		addResultItem(res, item)
		progress.emit(i+1, dn, res.Succeeded, res.Failed, res.Skipped+res.Unchanged)

		if stop, reason := shouldStop(item, writeErr, options); stop && i+1 < len(dns) {
			res.Stopped = true
			res.StopReason = reason
			markNotProcessed(res, dns[i+1:], "modify", reason)
			break
		}
	}
	return res, nil
}

// hasPasswordChange reports whether a batch writes userPassword values.
func hasPasswordChange(changes []models.AttributeChange) bool {
	for _, ch := range changes {
		if ldap.IsPasswordAttribute(ch.Attribute) && len(ch.Values) > 0 && !strings.EqualFold(ch.Operation, models.ChangeDelete) {
			return true
		}
	}
	return false
}

// addPasswordPlan adds to a preview entry how the password storage policy
// stores the userPassword values of its resolved changes.
func addPasswordPlan(pe *models.BulkPreviewEntry, eff models.EffectivePasswordPolicy, resolved []models.AttributeChange, opts models.PasswordWriteOptions) {
	plan, err := ldap.PlanPasswordChanges(eff, resolved, opts)
	if err != nil {
		pe.Errors = append(pe.Errors, err.Error())
		pe.Status = models.BulkStatusError
		return
	}
	notes, warnings := passwordPlanMessages(plan)
	pe.Notes = append(pe.Notes, notes...)
	pe.Warnings = append(pe.Warnings, warnings...)
}

// shouldStop decides whether a run ends after item: on a lost connection or
// read-only switch always, on other failures unless ContinueOnError.
func shouldStop(item models.BulkResultItem, err error, options models.BulkOptions) (bool, string) {
	if item.Status != models.BulkResultFailed {
		return false, ""
	}
	if errors.Is(err, ldap.ErrReadOnly) {
		return true, "connection became read-only"
	}
	if errors.Is(err, ldap.ErrNotConnected) {
		return true, "connection lost"
	}
	if !options.ContinueOnError {
		return true, "stopped at the first failure (continue on error is off)"
	}
	return false, ""
}

// addResultItem appends item and updates the counters.
func addResultItem(res *models.BulkApplyResult, item models.BulkResultItem) {
	res.Items = append(res.Items, item)
	switch item.PasswordWarning {
	case "":
	case models.PasswordWarningIneffective:
		res.PasswordIneffective++
	case models.PasswordWarningCleartext:
		res.PasswordCleartext++
	default:
		res.PasswordWarnings++
	}
	switch item.Status {
	case models.BulkResultSuccess:
		res.Succeeded++
	case models.BulkResultFailed:
		res.Failed++
	case models.BulkResultSkipped:
		res.Skipped++
	case models.BulkResultUnchanged:
		res.Unchanged++
	case models.BulkResultNotProcessed:
		res.NotProcessed++
	}
}

// markNotProcessed reports the remaining DNs of a stopped batch run.
func markNotProcessed(res *models.BulkApplyResult, dns []string, op, reason string) {
	res.Stopped = true
	if res.StopReason == "" {
		res.StopReason = reason
	}
	for _, dn := range dns {
		addResultItem(res, models.BulkResultItem{DN: dn, Operation: op, Status: models.BulkResultNotProcessed, Message: reason})
	}
}

// keepDisabledAfterBulk completes item after a successful bulk write:
// success with the planner's warnings, plus the re-lock of an OpenLDAP
// account disabled in the account panel (keepAccountDisabled). A failed
// re-lock fails the item (the change is applied, but the account is enabled
// now) and is returned so that the run can stop on it.
func keepDisabledAfterBulk(item *models.BulkResultItem, warnings []string, guard *ldap.PermanentLockGuard, audit func(operation, dn, details string, err error)) error {
	note, err := keepAccountDisabled(guard, audit, item.DN, "bulk modify")
	if err != nil {
		item.Status = models.BulkResultFailed
		item.Message = err.Error()
		return err
	}
	item.Status = models.BulkResultSuccess
	msgs := append([]string(nil), warnings...)
	if note != "" {
		msgs = append(msgs, note)
	}
	item.Message = strings.Join(msgs, "; ")
	return nil
}
