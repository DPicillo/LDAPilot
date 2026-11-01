package services

import (
	"fmt"
	"slices"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// Password storage policy (GitHub issue #1): bindings for the connection
// dialog, the confirmation dialog of the write paths and the entry writes
// that take per-write decisions. The policy itself is applied in
// internal/ldap/password_policy.go on every client write.

// GetPasswordPolicyCatalog returns the client-side schemes and the default
// policy per server type for the connection dialog.
func (s *EditorService) GetPasswordPolicyCatalog() models.PasswordPolicyCatalog {
	schemes := []models.PasswordScheme{}
	for _, sc := range ldap.PasswordSchemes() {
		if sc.ID != ldap.SchemeCleartext {
			schemes = append(schemes, sc)
		}
	}
	return models.PasswordPolicyCatalog{Schemes: schemes, Defaults: ldap.PasswordPolicyDefaults()}
}

// GetPasswordPolicy returns the effective password storage policy of a
// connected profile.
func (s *EditorService) GetPasswordPolicy(profileID string) (*models.EffectivePasswordPolicy, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.PasswordPolicy()
}

// PlanPasswordWrite tells what the password storage policy will do with
// the userPassword values of a write (req.Attributes of an add,
// req.Changes of a modify, or the add/modify records of req.LDIF) with
// req.Options, without writing: whether the user has to decide ("ask") or
// confirm sending a cleartext password over an unencrypted connection.
// Template placeholders of a batch modify count as cleartext values.
func (s *EditorService) PlanPasswordWrite(profileID string, req models.PasswordWritePlanRequest) (*models.PasswordWritePlan, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	eff, err := client.PasswordPolicy()
	if err != nil {
		return nil, err
	}
	return planPasswordWrite(*eff, req)
}

// planPasswordWrite is PlanPasswordWrite for a resolved policy.
func planPasswordWrite(eff models.EffectivePasswordPolicy, req models.PasswordWritePlanRequest) (*models.PasswordWritePlan, error) {
	plan := models.PasswordWritePlan{Policy: eff, AsIs: req.Options.AsIs, Unencrypted: !eff.TLS, Actions: []string{}, Warnings: []string{}}
	merge := func(p models.PasswordWritePlan, err error) error {
		if err != nil {
			return err
		}
		policy := plan.Policy
		if p.HasPasswords {
			policy = p.Policy // carries a per-write decision
		}
		plan = ldap.MergePasswordPlans(plan, p)
		plan.Policy = policy
		return nil
	}
	if len(req.Attributes) > 0 {
		if err := merge(ldap.PlanPasswordAttributes(eff, req.Attributes, req.Options)); err != nil {
			return nil, err
		}
	}
	if len(req.Changes) > 0 {
		if err := merge(ldap.PlanPasswordChanges(eff, req.Changes, req.Options)); err != nil {
			return nil, err
		}
	}
	if req.LDIF != "" {
		parsed := parseLDIFChanges(req.LDIF)
		for i := range parsed.Records {
			rec := &parsed.Records[i]
			if rec.Err != nil {
				continue
			}
			var err error
			switch rec.ChangeType {
			case models.LDIFChangeAdd:
				err = merge(ldap.PlanPasswordAttributes(eff, rec.Attributes, req.Options))
			case models.LDIFChangeModify:
				err = merge(ldap.PlanPasswordChanges(eff, rec.Changes, req.Options))
			}
			if err != nil {
				return nil, err
			}
		}
	}
	return &plan, nil
}

// CreateEntryWithOptions creates an entry like CreateEntry with per-write
// password storage decisions (opts: "ask" answer, confirmation for an
// unencrypted connection). The report tells how the userPassword values
// were stored (nil without password values).
func (s *EditorService) CreateEntryWithOptions(profileID string, dn string, attributes []models.LDAPAttribute, opts models.PasswordWriteOptions) (*models.PasswordWriteReport, error) {
	if dn == "" {
		return nil, fmt.Errorf("DN must not be empty")
	}
	if len(attributes) == 0 {
		return nil, fmt.Errorf("entry must have at least one attribute")
	}
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return nil, err
	}
	report, err := client.AddEntryWithPasswordPolicy(dn, attributes, opts)
	s.audit(profileID, "CREATE", dn, describeAttributesForAudit(attributes)+describePasswordReport(report), err)
	return report, err
}

// ModifyEntryWithOptions is ModifyEntry with per-write password storage
// decisions (see CreateEntryWithOptions).
func (s *EditorService) ModifyEntryWithOptions(profileID string, dn string, changes []models.AttributeChange, opts models.PasswordWriteOptions) (*models.PasswordWriteReport, error) {
	if dn == "" {
		return nil, fmt.Errorf("DN must not be empty")
	}
	if len(changes) == 0 {
		return nil, fmt.Errorf("no changes to apply")
	}
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return nil, err
	}
	guard := client.GuardPermanentLock(dn, changes)
	// Old values of replaced / removed attributes for the audit entry
	// ("replace description: [old] → [new]"); secrets are never read.
	before := auditBefore(client, dn, changes)
	report, err := client.ModifyEntryWithPasswordPolicy(dn, changes, opts)
	s.audit(profileID, "MODIFY", dn, describeChangesWithBefore(changes, before)+describePasswordReport(report), err)
	if err != nil {
		return nil, err
	}
	note, err := keepAccountDisabled(guard, func(op, dn, details string, err error) {
		s.audit(profileID, op, dn, details, err)
	}, dn, "password change")
	return withLockKeptNote(report, note), err
}

// withLockKeptNote adds the note of a successful re-lock (lockKeptNote) to
// the write report, so the toast can say that the account stays disabled
// ("" = nothing re-locked: report unchanged).
func withLockKeptNote(report *models.PasswordWriteReport, note string) *models.PasswordWriteReport {
	if note == "" {
		return report
	}
	if report == nil {
		report = &models.PasswordWriteReport{Actions: []string{}, Warnings: []string{}, StoredSchemes: []string{}}
	}
	if !slices.Contains(report.Actions, note) {
		report.Actions = append(report.Actions, note)
	}
	return report
}

// describePasswordReport summarizes what the policy did for the audit log
// ("" without a report); it never contains password values.
func describePasswordReport(r *models.PasswordWriteReport) string {
	if r == nil || len(r.Actions) == 0 {
		return ""
	}
	return " [password storage: " + strings.Join(r.Actions, "; ") + "]"
}

// passwordReportWarning is the BulkResultItem.PasswordWarning of a write
// report ("" when the passwords need no attention).
func passwordReportWarning(r *models.PasswordWriteReport) string {
	switch {
	case r == nil:
		return ""
	case r.Ineffective:
		return models.PasswordWarningIneffective
	case r.Cleartext:
		return models.PasswordWarningCleartext
	case r.Unconfirmed:
		return models.PasswordWarningUnconfirmed
	case len(r.Warnings) > 0:
		return models.PasswordWarningOther
	}
	return ""
}

// passwordReportMessages returns the report's warnings and, for result
// messages of bulk runs, its actions.
func passwordReportMessages(r *models.PasswordWriteReport) []string {
	if r == nil {
		return nil
	}
	out := append([]string{}, r.Warnings...)
	return append(out, r.Actions...)
}

// passwordPlanMessages turns a dry-run plan into preview notes (actions)
// and warnings (including what apply will ask for).
func passwordPlanMessages(plan models.PasswordWritePlan) (notes, warnings []string) {
	if !plan.HasPasswords {
		return nil, nil
	}
	notes = append(notes, plan.Actions...)
	warnings = append(warnings, plan.Warnings...)
	if plan.NeedsDecision {
		warnings = append(warnings, "The password storage policy is \"ask\": apply asks how to store the userPassword values.")
	}
	if plan.NeedsConfirm {
		warnings = append(warnings, "Apply asks to confirm sending the password over the unencrypted connection.")
	}
	return notes, warnings
}

// normalizePasswordPolicySettings validates and normalizes the password
// storage settings of a profile before it is saved.
func normalizePasswordPolicySettings(p *models.ConnectionProfile) error {
	policy, err := ldap.NormalizePasswordPolicy(p.PasswordPolicy)
	if err != nil {
		return err
	}
	p.PasswordPolicy = policy
	if policy != models.PasswordPolicyClient {
		p.PasswordScheme = ""
		return nil
	}
	scheme, err := ldap.ValidateClientScheme(p.PasswordScheme)
	if err != nil {
		return err
	}
	p.PasswordScheme = scheme
	return nil
}
