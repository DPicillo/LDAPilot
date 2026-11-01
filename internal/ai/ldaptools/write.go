package ldaptools

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

type writeTool struct {
	def     *tools.Def
	prepare func(ctx context.Context, s *Session, c *Call) (*Prepared, *tools.Result)
}

func (t *writeTool) Def() *tools.Def { return t.def }
func (t *writeTool) Prepare(ctx context.Context, s *Session, c *Call) (*Prepared, *tools.Result) {
	return t.prepare(ctx, s, c)
}

var attrNameRe = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9-]*(;[A-Za-z0-9-]+)*|[0-9]+(\.[0-9]+)+)$`)

func attrNameSchema(desc string) *tools.Schema {
	return tools.Str(desc).WithPattern(attrNameRe, "an attribute name such as description, or a numeric OID")
}

func init() {
	register(&writeTool{def: &tools.Def{
		Name: "modify_entry", DisplayName: "Modify entry", Kind: tools.KindWrite, Directory: true, AllowChatGrant: true, BaseRisk: "medium",
		Description: "Change attributes of one existing entry in a single atomic modify operation. Each change is add (add values), delete (remove the given values, or the whole attribute if values is empty) or replace (set exactly these values; empty removes the attribute). LDAPilot shows the user the exact change and runs it only after approval. Do not use it for passwords (use reset_password), group members (prefer update_group_membership), renaming (move_or_rename_entry), or enabling and unlocking accounts (dedicated tools).",
		Params: tools.Obj(
			connectionProp(),
			tools.R("dn", tools.Str("Full DN of the entry to change.")),
			tools.R("changes", tools.Arr("The changes, applied atomically in this order.", tools.Obj(
				tools.R("operation", tools.Enum("add, delete or replace.", "", "add", "delete", "replace")),
				tools.R("attribute", attrNameSchema("Attribute name.")),
				tools.P("values", tools.Arr("Values (empty = whole attribute for delete/replace).", tools.Str("").WithMaxLength(65536), 100)),
			), 50).WithMinItems(1)),
			explanationProp(),
		),
	}, prepare: prepareModify})

	register(&writeTool{def: &tools.Def{
		Name: "create_entry", DisplayName: "Create entry", Kind: tools.KindWrite, Directory: true, AllowChatGrant: true, BaseRisk: "medium",
		Description: "Create one new entry. Give the full DN and all attributes, including objectClass and every attribute the object classes require (use get_schema_definition when unsure). The parent must already exist. LDAPilot shows the user the full entry and creates it only after approval. Passwords cannot be set here; for a new AD user, create it (it starts disabled), then use reset_password and set_account_enabled.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("dn", tools.Str("Full DN of the new entry, e.g. CN=Anna Meier,OU=Users,DC=example,DC=com.")),
			tools.R("attributes", tools.Arr("All attributes of the new entry, including objectClass.", tools.Obj(
				tools.R("attribute", attrNameSchema("Attribute name.")),
				tools.R("values", tools.Arr("Values.", tools.Str("").WithMaxLength(65536), 100).WithMinItems(1)),
			), 100).WithMinItems(1)),
			explanationProp(),
		),
	}, prepare: prepareCreate})

	register(&writeTool{def: &tools.Def{
		Name: "move_or_rename_entry", DisplayName: "Move or rename", Kind: tools.KindWrite, Directory: true, AllowChatGrant: true, BaseRisk: "medium",
		Description: "Rename an entry (new RDN) and/or move it under a different parent in one modify-DN operation; its children move with it. Renaming an AD user changes its cn/name and DN only, not sAMAccountName or userPrincipalName (use modify_entry for those). Runs only after the user approves.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("dn", tools.Str("Full DN of the entry to rename or move.")),
			tools.P("new_rdn", tools.Str("New RDN, e.g. CN=Anna Meier")),
			tools.P("new_parent_dn", tools.Str("DN of the new parent (to move the entry).")),
			tools.P("delete_old_rdn", tools.Bool("Remove the old RDN value from the entry.", true)),
			explanationProp(),
		),
	}, prepare: prepareMove})

	register(&writeTool{def: &tools.Def{
		Name: "delete_entry", DisplayName: "Delete entry", Kind: tools.KindWrite, Directory: true, BaseRisk: "high",
		Description: "Delete one leaf entry (an entry without children). Containers with content cannot be deleted through the assistant. The user sees what will be deleted and must confirm. LDAPilot cannot undo a deletion (in AD the object may be recoverable from the Recycle Bin if it is enabled). Only use this when the user explicitly asked to delete this entry.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("dn", tools.Str("Full DN of the entry to delete.")),
			explanationProp(),
		),
	}, prepare: prepareDelete})

	register(&writeTool{def: &tools.Def{
		Name: "update_group_membership", DisplayName: "Change group members", Kind: tools.KindWrite, Directory: true, AllowChatGrant: true, BaseRisk: "medium",
		Description: "Add and/or remove members of one group in a single atomic change. Give members as full DNs; LDAPilot uses the right member attribute for the group type (member, uniqueMember or memberUid), skips members that are already present or already absent, and shows the user the change for approval. Use get_membership first if you need the current members.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("group_dn", tools.Str("Full DN of the group.")),
			tools.P("add", tools.Arr("DNs of members to add.", tools.Str(""), 100)),
			tools.P("remove", tools.Arr("DNs of members to remove.", tools.Str(""), 100)),
			explanationProp(),
		),
	}, prepare: prepareGroupMembership})

	register(&writeTool{def: &tools.Def{
		Name: "unlock_account", DisplayName: "Unlock account", Kind: tools.KindWrite, Directory: true, AllowChatGrant: true, BaseRisk: "medium",
		Description: "Clear the lockout of an account that is locked after too many failed logons (AD: sets lockoutTime to 0; OpenLDAP ppolicy: removes pwdAccountLockedTime and pwdFailureTime; 389 DS: resets the retry counter and unlock time). Does not enable a disabled account or change the password. Runs after user approval. Check get_account_status first if unsure whether the account is locked.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("dn", tools.Str("Full DN of the account.")),
			explanationProp(),
		),
	}, prepare: func(ctx context.Context, s *Session, c *Call) (*Prepared, *tools.Result) {
		return prepareAccountAction(ctx, s, c, ActionUnlock)
	}})

	register(&writeTool{def: &tools.Def{
		Name: "set_account_enabled", DisplayName: "Enable/disable account", Kind: tools.KindWrite, Directory: true, AllowChatGrant: true, BaseRisk: "medium",
		Description: "Enable or disable an account (AD: the ACCOUNTDISABLE bit of userAccountControl, changed atomically; 389 DS: nsAccountLock; OpenLDAP ppolicy: an administrative pwdAccountLockedTime). Runs after user approval. Disabling does not end sessions that are already open.",
		Params: tools.Obj(
			connectionProp(),
			tools.R("dn", tools.Str("Full DN of the account.")),
			tools.R("enabled", tools.Bool("true = enable, false = disable.", true)),
			explanationProp(),
		),
	}, prepare: func(ctx context.Context, s *Session, c *Call) (*Prepared, *tools.Result) {
		action := ActionDisable
		if c.Args.Bool("enabled", true) {
			action = ActionEnable
		}
		return prepareAccountAction(ctx, s, c, action)
	}})

	register(&writeTool{def: &tools.Def{
		Name: "set_password_must_change", DisplayName: "Must change password", Kind: tools.KindWrite, Directory: true, AllowChatGrant: true, BaseRisk: "medium",
		Description: "Require (or stop requiring) the account to change its password at the next logon, without changing the password (AD: pwdLastSet 0 or -1; OpenLDAP ppolicy: pwdReset; 389 DS decides through its own policy and refuses). Runs after user approval. AD ignores it for accounts whose password never expires (get_account_status shows that).",
		Params: tools.Obj(
			connectionProp(),
			tools.R("dn", tools.Str("Full DN of the account.")),
			tools.R("must_change", tools.Bool("true = must change at next logon, false = clear it.", true)),
			explanationProp(),
		),
	}, prepare: func(ctx context.Context, s *Session, c *Call) (*Prepared, *tools.Result) {
		action := ActionClearMustChange
		if c.Args.Bool("must_change", true) {
			action = ActionMustChange
		}
		return prepareAccountAction(ctx, s, c, action)
	}})

	register(&writeTool{def: &tools.Def{
		Name: "reset_password", DisplayName: "Reset password", Kind: tools.KindWrite, Directory: true, BaseRisk: "high",
		Description: "Reset an account's password to a new random password that LDAPilot generates locally and shows only to the user after approval. You never see the password: do not ask for it, guess it or write one into the chat. Optionally forces a password change at next logon. Active Directory requires an encrypted connection (LDAPS or StartTLS).",
		Params: tools.Obj(
			connectionProp(),
			tools.R("dn", tools.Str("Full DN of the account.")),
			tools.P("must_change_at_next_logon", tools.Bool("Force a password change at next logon.", true)),
			tools.P("length", tools.Int("Password length.", 16, 64, 20)),
			explanationProp(),
		),
	}, prepare: prepareResetPassword})
}

// commonWriteChecks validates the DN and refuses protected areas.
func commonWriteChecks(ctx context.Context, c *Call, dns ...string) *tools.Result {
	for _, dn := range dns {
		if r := checkDN(c.Tool, dn); r != nil {
			return r
		}
		if area := protectedArea(ctx, c.Client, dn); area != "" {
			return protectedResult(c.Tool, area)
		}
	}
	return nil
}

func explanation(c *Call) string {
	e, _, _ := ai.SanitizeUntrusted(strings.TrimSpace(c.Args.Str("explanation")))
	return e
}

// --- modify_entry ---

func prepareModify(ctx context.Context, s *Session, c *Call) (*Prepared, *tools.Result) {
	dn := cleanDN(c.Args.Str("dn"))
	if r := commonWriteChecks(ctx, c, dn); r != nil {
		return nil, r
	}
	red := s.redactor(ctx, c.Client)
	var changes []models.AttributeChange
	var touched []string
	payload := 0
	rdnAttr := strings.ToLower(strings.TrimSpace(strings.SplitN(rdnOf(dn), "=", 2)[0]))
	for i, ch := range c.Args.Objects("changes") {
		op := ch.Str("operation")
		attr := strings.TrimSpace(ch.Str("attribute"))
		vals := ch.Strings("values")
		field := fmt.Sprintf("changes[%d]", i)
		if _, secret, bad := red.ResolveRequested(attr); bad != "" || secret {
			return nil, errf(c.Tool, tools.ErrRedactedAttribute, "Use reset_password for passwords. Secret attributes cannot be changed through the assistant.", "%s.attribute: %s is a secret attribute.", field, attr)
		}
		if internalldap.IsKnownBinaryAttribute(attr) || strings.Contains(strings.ToLower(attr), ";binary") {
			return nil, errf(c.Tool, tools.ErrInvalidArguments, "Binary attributes cannot be changed through the assistant; use LDAPilot's editor.", "%s.attribute: %s is a binary attribute.", field, attr)
		}
		if op == models.ChangeAdd && len(vals) == 0 {
			return nil, errf(c.Tool, tools.ErrInvalidArguments, `Example: {"operation":"add","attribute":"mail","values":["a@example.com"]}`, "%s.values: add needs at least one value.", field)
		}
		if strings.EqualFold(BaseAttr(attr), rdnAttr) && op != models.ChangeAdd {
			return nil, errf(c.Tool, tools.ErrInvalidArguments, "Use move_or_rename_entry to change the RDN.", "%s: %s is the naming (RDN) attribute of this entry.", field, attr)
		}
		for _, v := range vals {
			payload += len(v)
		}
		changes = append(changes, models.AttributeChange{Operation: op, Attribute: attr, Values: vals})
		touched = appendUniqueFold(touched, BaseAttr(attr))
	}
	if payload > maxWritePayload {
		return nil, errf(c.Tool, tools.ErrInvalidArguments, "Split the change.", "change too large for one approval (%d bytes; at most 256 KB).", payload)
	}
	cur, err := reread(ctx, c.Client, dn, append(append([]string{}, touched...), riskReadAttrs...))
	if err != nil {
		return nil, ErrorResult(c.Tool, err, dn)
	}
	if cur == nil {
		return nil, errf(c.Tool, tools.ErrNoSuchObject, "Use search_ldap to find the correct DN.", "No entry with DN %s.", dnOrDash(dn))
	}
	ad := serverType(ctx, c.Client) == models.ServerTypeAD
	risk := &riskAcc{}
	risk.add(protectionReason(cur, ad))
	risk.configArea(dn)
	uacAfter := ""
	var diffs []ai.AttrDiff
	for _, ch := range changes {
		before := attrValues(cur, ch.Attribute)
		after := applyChange(before, ch)
		if strings.EqualFold(ch.Attribute, "userAccountControl") && len(after) > 0 {
			uacAfter = after[0]
		}
		diffs = append(diffs, ai.AttrDiff{Attribute: ch.Attribute, Op: ch.Operation, Before: nz(before), After: nz(after), Values: nz(ch.Values)})
	}
	risk.attrs(touched, attrValue(cur, "userAccountControl"), uacAfter)
	si, _ := c.Client.ServerInfo(ctx)
	sch := red.Schema()
	hash := beforeHash(cur, touched)
	assert, useAssert := "", false
	if HasControl(si, oidAssertion) {
		assert, useAssert = assertionFilter(cur, touched, sch)
	}
	level := risk.level("medium")
	pv := &ai.ChangePreview{Operation: "modify", DN: dn, LDIF: LDIFModify(dn, changes, red), Changes: diffs, Risk: level, RiskReasons: nzs(risk.reasons),
		Warnings: nzs(invisibleWarning(append([]string{dn}, flatten(changes)...)...)), Explanation: explanation(c), BeforeHash: hash, Assertion: useAssert}
	if level != "high" {
		pv.GrantScope = grantScopeFor(c.Tool, c.Conn.Info.ProfileID, c.Conn.Label, parentOf(dn), "", "", lowerAll(touched))
	}
	p := &Prepared{Preview: pv, TargetDN: dn, Attributes: lowerAll(touched), AuditOp: "MODIFY", AuditDetail: describeChanges(changes, red),
		Write: &ai.WriteInfo{Op: "modify", DN: dn, ProfileID: c.Conn.Info.ProfileID}, PayloadBytes: payload}
	p.Execute = func(ctx context.Context) (*tools.Result, []byte) {
		if !useAssert {
			now, err := reread(ctx, c.Client, dn, touched)
			if err != nil {
				return ErrorResult(c.Tool, err, dn), nil
			}
			if now == nil || beforeHash(now, touched) != hash {
				return entryChanged(c.Tool), nil
			}
		}
		if err := c.Client.Modify(ctx, dn, changes, assert); err != nil {
			return ErrorResult(c.Tool, err, dn), nil
		}
		r := okWrite(c, true, fmt.Sprintf("Modified %d attribute(s) of the entry.", len(touched)))
		r.Fields.Add("dn", dn)
		r.DNs = []string{dn}
		r.Summary = "modified " + strings.Join(touched, ", ")
		return r, nil
	}
	return p, nil
}

func applyChange(before []string, ch models.AttributeChange) []string {
	switch ch.Operation {
	case models.ChangeReplace:
		return append([]string(nil), ch.Values...)
	case models.ChangeAdd:
		return append(append([]string(nil), before...), ch.Values...)
	case models.ChangeDelete:
		if len(ch.Values) == 0 {
			return nil
		}
		out := []string{}
		for _, v := range before {
			drop := false
			for _, d := range ch.Values {
				if strings.EqualFold(v, d) {
					drop = true
				}
			}
			if !drop {
				out = append(out, v)
			}
		}
		return out
	}
	return before
}

func nz(ss []string) []string {
	if ss == nil {
		return []string{}
	}
	return ss
}

func nzs(ss []string) []string { return nz(ss) }

func flatten(changes []models.AttributeChange) []string {
	var out []string
	for _, c := range changes {
		out = append(out, c.Attribute)
		out = append(out, c.Values...)
	}
	return out
}

// --- create_entry ---

func prepareCreate(ctx context.Context, s *Session, c *Call) (*Prepared, *tools.Result) {
	dn := cleanDN(c.Args.Str("dn"))
	if r := commonWriteChecks(ctx, c, dn); r != nil {
		return nil, r
	}
	parent := parentOf(dn)
	if parent == "" {
		return nil, errf(c.Tool, tools.ErrInvalidArguments, "Give the full DN including the parent.", "dn: %s has no parent.", dn)
	}
	red := s.redactor(ctx, c.Client)
	var attrs []models.LDAPAttribute
	payload := 0
	hasOC := false
	var ocs []string
	for i, a := range c.Args.Objects("attributes") {
		name := strings.TrimSpace(a.Str("attribute"))
		vals := a.Strings("values")
		if _, secret, bad := red.ResolveRequested(name); bad != "" || secret {
			return nil, errf(c.Tool, tools.ErrRedactedAttribute, "Passwords cannot be set here; create the entry, then use reset_password.", "attributes[%d]: %s is a secret attribute.", i, name)
		}
		if internalldap.IsKnownBinaryAttribute(name) {
			return nil, errf(c.Tool, tools.ErrInvalidArguments, "Binary attributes cannot be set through the assistant.", "attributes[%d]: %s is a binary attribute.", i, name)
		}
		if strings.EqualFold(name, "objectClass") {
			hasOC = true
			ocs = vals
		}
		for _, v := range vals {
			payload += len(v)
		}
		merged := false
		for j := range attrs {
			if strings.EqualFold(attrs[j].Name, name) {
				attrs[j].Values = append(attrs[j].Values, vals...)
				merged = true
			}
		}
		if !merged {
			attrs = append(attrs, models.LDAPAttribute{Name: name, Values: vals})
		}
	}
	if !hasOC {
		return nil, errf(c.Tool, tools.ErrInvalidArguments, `Add {"attribute":"objectClass","values":[…]}; use get_schema_definition for required attributes.`, "attributes: objectClass is required.")
	}
	if payload > maxWritePayload {
		return nil, errf(c.Tool, tools.ErrInvalidArguments, "Split the change.", "change too large for one approval (%d bytes; at most 256 KB).", payload)
	}
	rdnAttr, rdnVal, _ := strings.Cut(rdnOf(dn), "=")
	rdnAttr, rdnVal = strings.TrimSpace(rdnAttr), strings.TrimSpace(rdnVal)
	if p, err := goldap.ParseDN(dn); err == nil && len(p.RDNs) > 0 && len(p.RDNs[0].Attributes) > 0 {
		rdnAttr, rdnVal = p.RDNs[0].Attributes[0].Type, p.RDNs[0].Attributes[0].Value
	}
	found, named := false, false
	for _, a := range attrs {
		if strings.EqualFold(a.Name, rdnAttr) {
			named = true
			for _, v := range a.Values {
				if strings.EqualFold(v, rdnVal) {
					found = true
				}
			}
		}
	}
	if !found && !named && rdnAttr != "" && rdnVal != "" {
		// The naming attribute is implied by the DN; add it so the entry
		// is valid on every server (the preview shows it).
		attrs = append(attrs, models.LDAPAttribute{Name: rdnAttr, Values: []string{rdnVal}})
		payload += len(rdnVal)
		found = true
	}
	if !found {
		return nil, errf(c.Tool, tools.ErrInvalidArguments, fmt.Sprintf(`Add {"attribute":%q,"values":[%q]}.`, rdnAttr, rdnVal), "attributes: the RDN value %s=%s must be one of the entry's attributes.", rdnAttr, rdnVal)
	}
	if pe, err := reread(ctx, c.Client, parent, nil); err != nil {
		return nil, ErrorResult(c.Tool, err, parent)
	} else if pe == nil {
		return nil, errf(c.Tool, tools.ErrNoSuchObject, "Create the parent first or choose an existing parent.", "The parent %s does not exist.", dnOrDash(parent))
	}
	if ex, err := reread(ctx, c.Client, dn, nil); err == nil && ex != nil {
		return nil, errf(c.Tool, tools.ErrAlreadyExists, "Choose a different DN.", "An entry with DN %s already exists.", dnOrDash(dn))
	}
	risk := &riskAcc{}
	for _, oc := range ocs {
		switch strings.ToLower(oc) {
		case "computer", "trusteddomain", "grouppolicycontainer":
			risk.add("creates a " + oc + " object")
		}
	}
	risk.configArea(dn)
	var names []string
	var summary []ai.AttrValue
	for _, a := range attrs {
		names = append(names, a.Name)
		summary = append(summary, ai.AttrValue{Attribute: a.Name, Values: a.Values})
		l := strings.ToLower(a.Name)
		if l == "userprincipalname" {
			risk.add(upnCreateRisk(ctx, c.Client, dn, a.Values))
			continue
		}
		if highRiskAttrs[l] && l != "objectclass" {
			risk.add("sets " + a.Name)
		}
	}
	level := risk.level("medium")
	pv := &ai.ChangePreview{Operation: "create", DN: dn, LDIF: LDIFAdd(dn, attrs), Changes: []ai.AttrDiff{}, EntrySummary: summary, Risk: level,
		RiskReasons: nzs(risk.reasons), Warnings: nzs(invisibleWarning(append([]string{dn}, flattenAttrs(attrs)...)...)), Explanation: explanation(c),
		BeforeHash: beforeHash(nil, nil)}
	if note := adCreateNote(ctx, c.Client, ocs, attrs); note != "" {
		pv.Warnings = append(pv.Warnings, note)
	}
	if level != "high" {
		pv.GrantScope = grantScopeFor(c.Tool, c.Conn.Info.ProfileID, c.Conn.Label, parent, "", "", lowerAll(names))
	}
	p := &Prepared{Preview: pv, TargetDN: dn, Attributes: lowerAll(names), AuditOp: "CREATE", AuditDetail: "attrs: " + strings.Join(names, ", "),
		Write: &ai.WriteInfo{Op: "create", DN: dn, ParentDN: parent, ProfileID: c.Conn.Info.ProfileID}, PayloadBytes: payload}
	p.Execute = func(ctx context.Context) (*tools.Result, []byte) {
		if err := c.Client.Add(ctx, dn, attrs); err != nil {
			return ErrorResult(c.Tool, err, dn), nil
		}
		r := okWrite(c, true, "Created the entry.")
		r.Fields.Add("dn", dn)
		r.DNs = []string{dn}
		r.Summary = "created"
		return r, nil
	}
	return p, nil
}

func flattenAttrs(attrs []models.LDAPAttribute) []string {
	var out []string
	for _, a := range attrs {
		out = append(out, a.Name)
		out = append(out, a.Values...)
	}
	return out
}

// --- move_or_rename_entry ---

func prepareMove(ctx context.Context, s *Session, c *Call) (*Prepared, *tools.Result) {
	dn := cleanDN(c.Args.Str("dn"))
	newRDN := strings.TrimSpace(c.Args.Str("new_rdn"))
	newParent := cleanDN(c.Args.Str("new_parent_dn"))
	if newRDN == "" && newParent == "" {
		return nil, errf(c.Tool, tools.ErrInvalidArguments, "Give new_rdn, new_parent_dn or both.", "Nothing to do: neither new_rdn nor new_parent_dn was given.")
	}
	if r := commonWriteChecks(ctx, c, dn); r != nil {
		return nil, r
	}
	if newRDN == "" {
		newRDN = rdnOf(dn)
	}
	if !strings.Contains(newRDN, "=") {
		return nil, errf(c.Tool, tools.ErrInvalidArguments, "Example: CN=Anna Meier", "new_rdn: %q is not an RDN (attribute=value).", newRDN)
	}
	parent := parentOf(dn)
	target := newRDN + "," + parent
	if newParent != "" {
		if r := commonWriteChecks(ctx, c, newParent); r != nil {
			return nil, r
		}
		if pe, err := reread(ctx, c.Client, newParent, nil); err != nil {
			return nil, ErrorResult(c.Tool, err, newParent)
		} else if pe == nil {
			return nil, errf(c.Tool, tools.ErrNoSuchObject, "Choose an existing parent.", "The new parent %s does not exist.", dnOrDash(newParent))
		}
		target = newRDN + "," + newParent
	}
	if r := checkDN(c.Tool, target); r != nil {
		return nil, r
	}
	cur, err := reread(ctx, c.Client, dn, riskReadAttrs)
	if err != nil {
		return nil, ErrorResult(c.Tool, err, dn)
	}
	if cur == nil {
		return nil, errf(c.Tool, tools.ErrNoSuchObject, "Use search_ldap to find the correct DN.", "No entry with DN %s.", dnOrDash(dn))
	}
	if ex, err := reread(ctx, c.Client, target, nil); err == nil && ex != nil && !strings.EqualFold(normDN(target), normDN(dn)) {
		return nil, errf(c.Tool, tools.ErrAlreadyExists, "Choose a different name or parent.", "An entry with DN %s already exists.", dnOrDash(target))
	}
	deleteOld := c.Args.Bool("delete_old_rdn", true)
	ad := serverType(ctx, c.Client) == models.ServerTypeAD
	risk := &riskAcc{}
	risk.add(protectionReason(cur, ad))
	risk.configArea(dn)
	risk.configArea(target)
	hashAttrs := []string{"objectClass"}
	hash := beforeHash(cur, hashAttrs)
	var b strings.Builder
	ldifDN(&b, dn)
	b.WriteString("changetype: modrdn\n")
	ldifLine(&b, "newrdn", newRDN)
	fmt.Fprintf(&b, "deleteoldrdn: %d\n", map[bool]int{true: 1, false: 0}[deleteOld])
	if newParent != "" {
		ldifLine(&b, "newsuperior", newParent)
	}
	level := risk.level("medium")
	pv := &ai.ChangePreview{Operation: "rename", DN: dn, NewDN: target, LDIF: b.String(), Changes: []ai.AttrDiff{}, Risk: level, RiskReasons: nzs(risk.reasons),
		Warnings: nzs(invisibleWarning(dn, newRDN, newParent)), Explanation: explanation(c), BeforeHash: hash}
	op := "rename"
	if newParent != "" && !strings.EqualFold(normDN(newParent), normDN(parent)) {
		op = "move"
	}
	// Only an in-place rename can become a chat grant ("action rename",
	// entries strictly below the parent); a move to another parent is
	// always approved one by one, since the destination is part of the
	// change (§6.3).
	if level != "high" && op == "rename" {
		pv.GrantScope = grantScopeFor(c.Tool, c.Conn.Info.ProfileID, c.Conn.Label, parent, "", "rename", []string{"(dn)"})
	}
	p := &Prepared{Preview: pv, TargetDN: dn, Attributes: []string{"(dn)"}, Action: op, AuditOp: "RENAME",
		AuditDetail: fmt.Sprintf("%s to %s (deleteoldrdn=%v)", op, target, deleteOld),
		Write:       &ai.WriteInfo{Op: op, DN: dn, NewDN: target, ParentDN: parent, ProfileID: c.Conn.Info.ProfileID}}
	p.Execute = func(ctx context.Context) (*tools.Result, []byte) {
		now, err := reread(ctx, c.Client, dn, hashAttrs)
		if err != nil {
			return ErrorResult(c.Tool, err, dn), nil
		}
		if now == nil || beforeHash(now, hashAttrs) != hash {
			return entryChanged(c.Tool), nil
		}
		if err := c.Client.ModifyDN(ctx, dn, newRDN, deleteOld, newParent); err != nil {
			return ErrorResult(c.Tool, err, dn), nil
		}
		r := okWrite(c, true, "The entry was "+op+"d.")
		r.Fields.Add("old_dn", dn)
		r.Fields.Add("new_dn", target)
		r.DNs = []string{target}
		r.Summary = op + "d"
		return r, nil
	}
	return p, nil
}

// --- delete_entry ---

func prepareDelete(ctx context.Context, s *Session, c *Call) (*Prepared, *tools.Result) {
	dn := cleanDN(c.Args.Str("dn"))
	if r := commonWriteChecks(ctx, c, dn); r != nil {
		return nil, r
	}
	ad := serverType(ctx, c.Client) == models.ServerTypeAD
	summaryAttrs := []string{"objectClass", "cn", "name", "uid", "sAMAccountName", "displayName", "description", "member", "memberOf", "uSNChanged", "modifyTimestamp", "entryCSN"}
	cur, err := reread(ctx, c.Client, dn, append(summaryAttrs, riskReadAttrs...))
	if err != nil {
		return nil, ErrorResult(c.Tool, err, dn)
	}
	if cur == nil {
		return nil, errf(c.Tool, tools.ErrNoSuchObject, "Use search_ldap to find the correct DN.", "No entry with DN %s.", dnOrDash(dn))
	}
	kids, err := c.Client.Search(ctx, models.SearchParams{BaseDN: dn, Filter: "(objectClass=*)", Scope: models.ScopeOne, Attributes: []string{"1.1"}, SizeLimit: 1})
	if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
		return nil, ErrorResult(c.Tool, err, dn)
	}
	if kids != nil && len(kids.Entries) > 0 {
		return nil, errf(c.Tool, tools.ErrNotAllowedOnNonLeaf, "Containers with content cannot be deleted through the assistant.", "%s has child entries.", dnOrDash(dn))
	}
	risk := &riskAcc{}
	risk.add(protectionReason(cur, ad))
	risk.configArea(dn)
	var summary []ai.AttrValue
	for _, a := range []string{"objectClass", "cn", "name", "uid", "sAMAccountName", "displayName", "description"} {
		if v := attrValues(cur, a); len(v) > 0 {
			summary = append(summary, ai.AttrValue{Attribute: a, Values: v})
		}
	}
	for _, a := range []string{"member", "memberOf"} {
		if v := attrValues(cur, a); len(v) > 0 {
			summary = append(summary, ai.AttrValue{Attribute: a + " count", Values: []string{fmt.Sprint(len(v))}})
		}
	}
	marker := "modifyTimestamp"
	switch {
	case attrValue(cur, "uSNChanged") != "":
		marker = "uSNChanged"
	case attrValue(cur, "entryCSN") != "":
		marker = "entryCSN"
	}
	hash := beforeHash(cur, []string{marker})
	si, _ := c.Client.ServerInfo(ctx)
	assert, useAssert := "", false
	if HasControl(si, oidAssertion) && attrValue(cur, marker) != "" {
		assert, useAssert = "("+marker+"="+goldap.EscapeFilter(attrValue(cur, marker))+")", true
	}
	var b strings.Builder
	ldifDN(&b, dn)
	b.WriteString("changetype: delete\n")
	pv := &ai.ChangePreview{Operation: "delete", DN: dn, LDIF: b.String(), Changes: []ai.AttrDiff{}, EntrySummary: summary, Risk: "high",
		RiskReasons: nzs(append([]string{"deletes an entry (cannot be undone in LDAPilot)"}, risk.reasons...)), Warnings: nzs(invisibleWarning(dn)),
		Explanation: explanation(c), BeforeHash: hash, Assertion: useAssert}
	p := &Prepared{Preview: pv, TargetDN: dn, AuditOp: "DELETE", AuditDetail: "delete entry",
		Write: &ai.WriteInfo{Op: "delete", DN: dn, ParentDN: parentOf(dn), ProfileID: c.Conn.Info.ProfileID}}
	p.Execute = func(ctx context.Context) (*tools.Result, []byte) {
		if !useAssert {
			now, err := reread(ctx, c.Client, dn, []string{marker})
			if err != nil {
				return ErrorResult(c.Tool, err, dn), nil
			}
			if now == nil || beforeHash(now, []string{marker}) != hash {
				return entryChanged(c.Tool), nil
			}
		}
		if err := c.Client.Delete(ctx, dn, assert); err != nil {
			return ErrorResult(c.Tool, err, dn), nil
		}
		r := okWrite(c, true, "Deleted the entry.")
		r.Fields.Add("dn", dn)
		r.Summary = "deleted"
		return r, nil
	}
	return p, nil
}

// --- update_group_membership ---

func prepareGroupMembership(ctx context.Context, s *Session, c *Call) (*Prepared, *tools.Result) {
	g := cleanDN(c.Args.Str("group_dn"))
	if r := commonWriteChecks(ctx, c, g); r != nil {
		return nil, r
	}
	add, remove := c.Args.Strings("add"), c.Args.Strings("remove")
	if len(add) == 0 && len(remove) == 0 {
		return nil, errf(c.Tool, tools.ErrInvalidArguments, "Give add, remove or both.", "Nothing to do: add and remove are empty.")
	}
	for _, d := range append(append([]string{}, add...), remove...) {
		if r := checkDN(c.Tool, cleanDN(d)); r != nil {
			return nil, r
		}
	}
	mr := c.Client.Membership()
	info, err := mr.GroupInfo(ctx, g)
	if err != nil {
		if errors.Is(err, ErrNotApplicable) {
			return nil, errf(c.Tool, tools.ErrInvalidArguments, "", "%s is not a group.", dnOrDash(g))
		}
		return nil, ErrorResult(c.Tool, err, g)
	}
	ad := serverType(ctx, c.Client) == models.ServerTypeAD
	risk := &riskAcc{}
	risk.add(protectionReason(readForRisk(ctx, c.Client, g), ad))
	present := func(attr, v string) bool {
		for _, x := range info.Values[strings.ToLower(attr)] {
			if strings.EqualFold(normDN(x), normDN(v)) || strings.EqualFold(x, v) {
				return true
			}
		}
		return false
	}
	type op struct{ attr, value, dn string }
	var adds, dels []op
	var unchanged []string
	queued := map[string]bool{}
	queue := func(list *[]op, mv MemberValue, dn string) {
		k := strings.ToLower(mv.Attr) + "\x00" + strings.ToLower(mv.Value)
		if !queued[k] {
			queued[k] = true
			*list = append(*list, op{mv.Attr, mv.Value, dn})
		}
	}
	for _, m := range add {
		m = cleanDN(m)
		me := readForRisk(ctx, c.Client, m)
		if me == nil {
			return nil, errf(c.Tool, tools.ErrNoSuchObject, "Members to add must exist; use search_ldap to find them.", "No entry with DN %s.", dnOrDash(m))
		}
		if reason := protectionReason(me, ad); reason != "" {
			risk.add("member " + rdnOf(m) + ": " + reason)
		}
		// The membership track decides the values: the group's member
		// attribute first, then companions (RFC 2307bis memberUid).
		vals, err := mr.MemberValues(ctx, info, models.ChangeAdd, m)
		if err != nil {
			return nil, ErrorResult(c.Tool, err, m)
		}
		if len(vals) == 0 || present(vals[0].Attr, vals[0].Value) {
			unchanged = append(unchanged, m+" (already a member)")
			continue
		}
		for _, mv := range vals {
			if !present(mv.Attr, mv.Value) {
				queue(&adds, mv, m)
			}
		}
	}
	for _, m := range remove {
		m = cleanDN(m)
		me := readForRisk(ctx, c.Client, m)
		if me != nil {
			if reason := protectionReason(me, ad); reason != "" {
				risk.add("member " + rdnOf(m) + ": " + reason)
			}
			if ad && info.PrimaryToken > 0 && attrValue(me, "primaryGroupID") == fmt.Sprint(info.PrimaryToken) {
				return nil, errf(c.Tool, tools.ErrUnwillingToPerform, "Change the member's primary group first (primaryGroupID) in LDAPilot's editor.",
					"%s has this group as its primary group; it cannot be removed through member.", dnOrDash(m))
			}
		}
		vals, err := mr.MemberValues(ctx, info, models.ChangeDelete, m)
		if err != nil {
			if me == nil {
				unchanged = append(unchanged, m+" (not a member)")
				continue
			}
			return nil, ErrorResult(c.Tool, err, m)
		}
		found := false
		for _, mv := range vals {
			if present(mv.Attr, mv.Value) {
				found = true
				queue(&dels, mv, m)
			}
		}
		if !found {
			unchanged = append(unchanged, m+" (not a member)")
		}
	}
	members := func(ops []op) int {
		seen := map[string]bool{}
		for _, o := range ops {
			seen[strings.ToLower(o.dn)] = true
		}
		return len(seen)
	}
	nAdd, nDel := members(adds), members(dels)
	if len(adds) == 0 && len(dels) == 0 {
		r := okWrite(c, false, "Nothing to change: every member is already present or already absent.")
		r.Fields.Add("unchanged", unchanged)
		r.Summary = "no change"
		return nil, r
	}
	group := map[string][]string{}
	var order []string
	key := func(o, a string) string { return o + "\x00" + a }
	for _, a := range adds {
		k := key(models.ChangeAdd, a.attr)
		if _, ok := group[k]; !ok {
			order = append(order, k)
		}
		group[k] = append(group[k], a.value)
	}
	for _, d := range dels {
		k := key(models.ChangeDelete, d.attr)
		if _, ok := group[k]; !ok {
			order = append(order, k)
		}
		group[k] = append(group[k], d.value)
	}
	var changes []models.AttributeChange
	var diffs []ai.AttrDiff
	var touched []string
	for _, k := range order {
		o, a, _ := strings.Cut(k, "\x00")
		changes = append(changes, models.AttributeChange{Operation: o, Attribute: a, Values: group[k]})
		before := info.Values[strings.ToLower(a)]
		diffs = append(diffs, ai.AttrDiff{Attribute: a, Op: o, Before: nz(before), After: nz(applyChange(before, models.AttributeChange{Operation: o, Attribute: a, Values: group[k]})), Values: group[k]})
		touched = appendUniqueFold(touched, a)
	}
	sort.Strings(unchanged)
	cur, _ := reread(ctx, c.Client, g, touched)
	hash := beforeHash(cur, touched)
	si, _ := c.Client.ServerInfo(ctx)
	sch := s.Shared.Schema(ctx, c.Client)
	assert, useAssert := "", false
	if HasControl(si, oidAssertion) && cur != nil {
		// Only the values being changed are asserted: added values must
		// still be absent, removed values still present.
		var parts []string
		for _, ch := range changes {
			if sch != nil {
				if at := sch.Attr(ch.Attribute); at != nil && at.Equality == "" {
					continue
				}
			}
			for _, v := range ch.Values {
				f := "(" + ch.Attribute + "=" + goldap.EscapeFilter(v) + ")"
				if ch.Operation == models.ChangeAdd {
					f = "(!" + f + ")"
				}
				parts = append(parts, f)
			}
		}
		if len(parts) > 0 {
			assert, useAssert = "(&"+strings.Join(parts, "")+")", true
		}
	}
	red := s.redactor(ctx, c.Client)
	level := risk.level("medium")
	pv := &ai.ChangePreview{Operation: "group_membership", DN: g, LDIF: LDIFModify(g, changes, red), Changes: diffs, Risk: level, RiskReasons: nzs(risk.reasons),
		Warnings: nzs(invisibleWarning(append([]string{g}, append(add, remove...)...)...)), Explanation: explanation(c), BeforeHash: hash, Assertion: useAssert, Unchanged: unchanged}
	if level != "high" {
		pv.GrantScope = grantScopeFor(c.Tool, c.Conn.Info.ProfileID, c.Conn.Label, "", g, "", lowerAll(touched))
	}
	p := &Prepared{Preview: pv, TargetDN: g, GroupDN: g, Attributes: lowerAll(touched), AuditOp: "MODIFY",
		AuditDetail: fmt.Sprintf("group membership: +%d −%d (%s)", nAdd, nDel, describeChanges(changes, red)),
		Write:       &ai.WriteInfo{Op: "modify", DN: g, ProfileID: c.Conn.Info.ProfileID}}
	p.Execute = func(ctx context.Context) (*tools.Result, []byte) {
		if !useAssert {
			now, err := reread(ctx, c.Client, g, touched)
			if err != nil {
				return ErrorResult(c.Tool, err, g), nil
			}
			if now == nil || beforeHash(now, touched) != hash {
				return entryChanged(c.Tool), nil
			}
		}
		if err := c.Client.Modify(ctx, g, changes, assert); err != nil {
			return ErrorResult(c.Tool, err, g), nil
		}
		r := okWrite(c, true, fmt.Sprintf("Added %d and removed %d member(s).", nAdd, nDel))
		r.Fields.Add("group_dn", g)
		r.Fields.Add("added", nAdd)
		r.Fields.Add("removed", nDel)
		if len(unchanged) > 0 {
			r.Fields.Add("unchanged", unchanged)
		}
		r.DNs = []string{g}
		r.Summary = fmt.Sprintf("+%d −%d members", nAdd, nDel)
		return r, nil
	}
	return p, nil
}

// --- unlock_account / set_account_enabled ---

func prepareAccountAction(ctx context.Context, s *Session, c *Call, action string) (*Prepared, *tools.Result) {
	dn := cleanDN(c.Args.Str("dn"))
	if r := commonWriteChecks(ctx, c, dn); r != nil {
		return nil, r
	}
	plan, err := c.Client.Planner().Plan(ctx, dn, action)
	if err != nil {
		if errors.Is(err, ErrNotApplicable) {
			hint := ""
			if strings.Contains(err.Error(), "set_account_enabled") {
				hint = "Use set_account_enabled to enable the account."
			}
			return nil, errf(c.Tool, tools.ErrInvalidArguments, hint, "%s", strings.TrimSuffix(err.Error(), ": "+ErrNotApplicable.Error()))
		}
		return nil, ErrorResult(c.Tool, err, dn)
	}
	if plan.NoOp {
		r := okWrite(c, false, plan.Reason)
		if plan.Hint != "" {
			r.Note("%s", plan.Hint)
		}
		r.Fields.Add("dn", dn)
		r.Summary = "no change"
		return nil, r
	}
	ad := serverType(ctx, c.Client) == models.ServerTypeAD
	risk := &riskAcc{}
	risk.add(protectionReason(readForRisk(ctx, c.Client, dn), ad))
	var touched []string
	var diffs []ai.AttrDiff
	for _, ch := range plan.Changes {
		touched = appendUniqueFold(touched, ch.Attribute)
	}
	for _, a := range touched {
		before := plan.Before[a]
		after := before
		for _, ch := range plan.Changes {
			if strings.EqualFold(ch.Attribute, a) {
				after = applyChange(after, ch)
			}
		}
		op := models.ChangeReplace
		diffs = append(diffs, ai.AttrDiff{Attribute: a, Op: op, Before: nz(before), After: nz(after), Values: nz(after)})
	}
	red := s.redactor(ctx, c.Client)
	hash := beforeHash(&models.LDAPEntry{DN: dn, Attributes: beforeAttrs(plan.Before)}, touched)
	operation := accountOperation[action]
	level := risk.level("medium")
	pv := &ai.ChangePreview{Operation: operation, DN: dn, LDIF: LDIFModify(dn, plan.Changes, red), Changes: diffs, Risk: level, RiskReasons: nzs(risk.reasons),
		Warnings: nzs(append(invisibleWarning(dn), plan.Notes...)), Explanation: explanation(c), BeforeHash: hash}
	if level != "high" {
		pv.GrantScope = grantScopeFor(c.Tool, c.Conn.Info.ProfileID, c.Conn.Label, parentOf(dn), "", action, nil)
	}
	p := &Prepared{Preview: pv, TargetDN: dn, Action: action, Attributes: lowerAll(touched), AuditOp: "MODIFY",
		AuditDetail: accountAuditText[action] + " (" + describeChanges(plan.Changes, red) + ")",
		Write:       &ai.WriteInfo{Op: "modify", DN: dn, ProfileID: c.Conn.Info.ProfileID}}
	p.Execute = func(ctx context.Context) (*tools.Result, []byte) {
		// The approved state must still hold; the account track then plans
		// the action again from the server's state and sends it as one
		// atomic modify (AD userAccountControl as delete-old + add-new,
		// OpenLDAP pwdFailureTime with the Relax Rules control).
		now, err := reread(ctx, c.Client, dn, touched)
		if err != nil {
			return ErrorResult(c.Tool, err, dn), nil
		}
		if now == nil || beforeHash(now, touched) != hash {
			return entryChanged(c.Tool), nil
		}
		sent, err := c.Client.Planner().Apply(ctx, plan)
		if err != nil {
			if errors.Is(err, ErrAccountConflict) {
				return entryChanged(c.Tool), nil
			}
			return ErrorResult(c.Tool, err, dn), nil
		}
		r := okWrite(c, true, accountDoneText[action])
		r.Fields.Add("dn", dn)
		if !sameChanges(sent, plan.Changes) {
			// The audit records what was sent, not the approved plan
			// (the executor reads AuditDetail after Execute returns).
			p.AuditDetail = accountAuditText[action] + " (" + describeChanges(sent, red) + ")"
			if sameChanges(sent, withoutAttribute(plan.Changes, "pwdFailureTime")) {
				r.Note("The recorded failed logons (pwdFailureTime) could not be deleted: the server refused the Relax Rules control for this account. They stay until the next successful logon; LDAPilot sent: %s.", describeChanges(sent, red))
			} else {
				r.Note("The account changed after the approval, so LDAPilot planned the action again and sent: %s.", describeChanges(sent, red))
			}
		}
		r.DNs = []string{dn}
		r.Summary = accountSummary[action]
		return r, nil
	}
	return p, nil
}

var (
	accountOperation = map[string]string{ActionUnlock: "unlock", ActionEnable: "enable", ActionDisable: "disable",
		ActionMustChange: "must_change", ActionClearMustChange: "clear_must_change"}
	accountAuditText = map[string]string{ActionUnlock: "unlock account", ActionEnable: "enable account", ActionDisable: "disable account",
		ActionMustChange: "require password change at next logon", ActionClearMustChange: "clear password change at next logon"}
	accountDoneText = map[string]string{ActionUnlock: "The account was unlocked.", ActionEnable: "The account was enabled.", ActionDisable: "The account was disabled.",
		ActionMustChange: "The account must change its password at the next logon.", ActionClearMustChange: "The account no longer has to change its password at the next logon."}
	accountSummary = map[string]string{ActionUnlock: "unlocked", ActionEnable: "enabled", ActionDisable: "disabled",
		ActionMustChange: "must change password", ActionClearMustChange: "must-change cleared"}
)

// sameChanges reports whether two change lists are equal (order and
// values, case-insensitive attribute names).
// withoutAttribute returns changes without those of attribute attr.
func withoutAttribute(changes []models.AttributeChange, attr string) []models.AttributeChange {
	out := make([]models.AttributeChange, 0, len(changes))
	for _, ch := range changes {
		if !strings.EqualFold(ch.Attribute, attr) {
			out = append(out, ch)
		}
	}
	return out
}

func sameChanges(a, b []models.AttributeChange) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Operation != b[i].Operation || !strings.EqualFold(a[i].Attribute, b[i].Attribute) || strings.Join(a[i].Values, "\x00") != strings.Join(b[i].Values, "\x00") {
			return false
		}
	}
	return true
}

func beforeAttrs(m map[string][]string) []models.LDAPAttribute {
	var out []models.LDAPAttribute
	for k, v := range m {
		var vals []string
		for _, x := range v {
			if x != "" {
				vals = append(vals, x)
			}
		}
		if len(vals) > 0 {
			out = append(out, models.LDAPAttribute{Name: k, Values: vals})
		}
	}
	return out
}

// --- reset_password ---

func prepareResetPassword(ctx context.Context, s *Session, c *Call) (*Prepared, *tools.Result) {
	dn := cleanDN(c.Args.Str("dn"))
	if r := commonWriteChecks(ctx, c, dn); r != nil {
		return nil, r
	}
	cur := readForRisk(ctx, c.Client, dn)
	if cur == nil {
		if ex, err := reread(ctx, c.Client, dn, nil); err == nil && ex == nil {
			return nil, errf(c.Tool, tools.ErrNoSuchObject, "Use search_ldap to find the correct DN.", "No entry with DN %s.", dnOrDash(dn))
		}
	}
	must := c.Args.Bool("must_change_at_next_logon", true)
	length := c.Args.Int("length", 20)
	plan, err := c.Client.Passwords().Plan(ctx, dn, must)
	if err != nil {
		if errors.Is(err, ErrUnsupported) {
			return nil, errf(c.Tool, tools.ErrUnsupportedOnServer, "Explain the requirement to the user; LDAPilot's password dialog can be used instead.", "%s", strings.TrimSuffix(err.Error(), ": "+ErrUnsupported.Error()))
		}
		return nil, ErrorResult(c.Tool, err, dn)
	}
	ad := serverType(ctx, c.Client) == models.ServerTypeAD
	risk := &riskAcc{}
	risk.add(protectionReason(cur, ad))
	reasons := append([]string{"resets a password"}, risk.reasons...)
	if plan.AllowUnencrypted && (plan.Storage == nil || !plan.Storage.Unencrypted) {
		// The card states the cleartext risk once: in the red box under
		// "Password storage" (Storage.Unencrypted). Only a plan without
		// that preview puts it into the risk list (2b defect 4). The reset
		// stays high risk and needs the confirmation either way.
		reasons = append(reasons, "sends the new password in cleartext over an unencrypted connection")
	}
	pv := &ai.ChangePreview{Operation: "reset_password", DN: dn, LDIF: plan.LDIF, Changes: []ai.AttrDiff{}, Risk: "high", RiskReasons: reasons,
		Warnings: nzs(append(invisibleWarning(dn), plan.Notes...)), Explanation: explanation(c), BeforeHash: beforeHash(cur, []string{"objectClass"}),
		Password: plan.Storage}
	method := passwordMethodText(plan)
	detail := fmt.Sprintf("reset password (%s; value generated locally, not logged)", method)
	switch {
	case plan.MustChangeBy != "":
		detail += ", must change at next logon decided by the " + plan.MustChangeBy
	case plan.MustChange:
		detail += ", must change at next logon"
	}
	p := &Prepared{Preview: pv, TargetDN: dn, Attributes: []string{"(password)"}, AuditOp: "MODIFY", AuditDetail: detail,
		Write: &ai.WriteInfo{Op: "modify", DN: dn, ProfileID: c.Conn.Info.ProfileID}}
	p.Execute = func(ctx context.Context) (*tools.Result, []byte) {
		pw, err := GeneratePassword(length)
		if err != nil {
			return errf(c.Tool, tools.ErrLDAP, "", "The password could not be generated."), nil
		}
		out, err := c.Client.Passwords().Apply(ctx, plan, string(pw))
		if err != nil {
			for i := range pw {
				pw[i] = 0
			}
			return ErrorResult(c.Tool, err, dn), nil
		}
		r := okWrite(c, true, "Password reset. The new password was generated by LDAPilot and shown only to the user; it is not available to you.")
		r.Fields.Add("method", method)
		switch {
		case plan.MustChangeBy != "" && plan.MustChangeKnown:
			r.Fields.Add("must_change_at_next_logon", plan.MustChange)
			r.Fields.Add("must_change_decided_by", plan.MustChangeBy)
		case plan.MustChangeBy != "":
			r.Fields.Add("must_change_at_next_logon", "decided by the server's password policy")
			r.Fields.Add("must_change_decided_by", plan.MustChangeBy)
		default:
			r.Fields.Add("must_change_at_next_logon", plan.MustChange && (out == nil || !out.MustChangeIgnored))
		}
		if out != nil {
			if out.StoredSchemeLabel != "" {
				r.Fields.Add("stored_as", out.StoredSchemeLabel)
			}
			if out.Ineffective {
				r.Fields.Add("password_may_not_work", true)
			}
			if out.Unconfirmed {
				r.Fields.Add("password_unconfirmed", true)
			}
			r.Warnings = append(r.Warnings, out.Warnings...)
		}
		r.Notes = append(r.Notes, plan.Notes...)
		if plan.AllowUnencrypted {
			r.Note("The connection is not encrypted: the new password was sent to the server in cleartext (the user confirmed this on the approval card).")
		}
		r.DNs = []string{dn}
		r.Summary = "password reset"
		if out != nil && out.StoredSchemeLabel != "" {
			r.Summary += " (stored as " + out.StoredSchemeLabel + ")"
		}
		return r, pw
	}
	return p, nil
}

// passwordMethodText describes the reset method without values.
func passwordMethodText(plan *PasswordPlan) string {
	switch plan.Method {
	case PasswordAD:
		return "replace unicodePwd"
	case PasswordRFC3062:
		return "Password Modify extended operation (RFC 3062), hashed by the server"
	case PasswordUserPassword:
		if plan.Storage != nil && plan.Storage.SchemeLabel != "" {
			if strings.EqualFold(plan.Scheme, "CLEARTEXT") {
				return "replace userPassword with the cleartext value, hashed by the server"
			}
			return "replace userPassword, hashed by LDAPilot as " + plan.Storage.SchemeLabel
		}
		return "replace userPassword"
	}
	return plan.Method
}

// adCreateNote tells the approver how Active Directory creates a user
// account without a password (UX A-25): disabled, until the password is
// reset and the account enabled.
func adCreateNote(ctx context.Context, dc DirClient, ocs []string, attrs []models.LDAPAttribute) string {
	user := false
	for _, oc := range ocs {
		switch strings.ToLower(oc) {
		case "user", "inetorgperson":
			user = true
		case "computer":
			return ""
		}
	}
	if !user || serverType(ctx, dc) != models.ServerTypeAD {
		return ""
	}
	for _, a := range attrs {
		if strings.EqualFold(a.Name, "userAccountControl") && len(a.Values) > 0 {
			if v, ok := parseInt64(a.Values[0]); ok && v&int64(uacDisabled) == 0 {
				return "Active Directory refuses an enabled account without a password when a password policy applies; if the create fails, create it disabled, then reset the password (LDAPilot generates it) and enable it."
			}
		}
	}
	return "Active Directory creates this account disabled and without a password. Afterwards ask for a password reset (LDAPilot generates the password) and to enable the account."
}

// upnCreateRisk: a new account with its own userPrincipalName is the normal
// case and not high risk (UX A-25: every AD user create needed the "I have
// reviewed" tick). A UPN another entry already uses is: the new account
// could take over that account's logons or certificate mapping. UPNs are
// unique per forest, so the check searches the whole domain (never only the
// profile's base DN, which may be an OU) and stays high risk when the forest
// has other domains this connection cannot search, or when the check
// cannot be made at all. "" = not high risk.
func upnCreateRisk(ctx context.Context, dc DirClient, dn string, values []string) string {
	if len(values) != 1 {
		return "sets userPrincipalName (more than one value)"
	}
	v := strings.TrimSpace(values[0])
	if v == "" {
		return ""
	}
	const unchecked = "sets userPrincipalName (could not check whether another account uses it)"
	b, why := upnSearchBase(ctx, dc, dn)
	if why != "" {
		return why
	}
	if b == "" {
		return unchecked
	}
	res, err := dc.Search(ctx, models.SearchParams{BaseDN: b, Filter: "(userPrincipalName=" + goldap.EscapeFilter(v) + ")", Scope: models.ScopeSub,
		Attributes: []string{"cn"}, SizeLimit: 2})
	if res == nil || err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
		return unchecked
	}
	for _, e := range res.Entries {
		if !strings.EqualFold(cleanDN(e.DN), cleanDN(dn)) {
			return "sets userPrincipalName " + v + ", which " + e.DN + " already uses"
		}
	}
	return ""
}

// upnSearchBase returns the base that covers every entry whose UPN could
// clash: the domain (defaultNamingContext) on AD, else the naming context
// the new entry belongs to. why is a high-risk reason when the forest has
// more than this one domain or its domains cannot be listed.
func upnSearchBase(ctx context.Context, dc DirClient, dn string) (base, why string) {
	si, err := dc.ServerInfo(ctx)
	if err != nil || si == nil {
		return "", ""
	}
	if serverType(ctx, dc) != models.ServerTypeAD {
		ldn := strings.ToLower(cleanDN(dn))
		for _, nc := range si.NamingContexts {
			if l := strings.ToLower(cleanDN(nc)); l != "" && (ldn == l || strings.HasSuffix(ldn, ","+l)) {
				return nc, ""
			}
		}
		return baseDN(ctx, dc), ""
	}
	domain := si.DefaultNamingContext
	if domain == "" {
		return "", ""
	}
	const otherDomains = "sets userPrincipalName (the forest has other domains; LDAPilot could not check whether an account there uses it)"
	if root := si.RootDomainNamingContext; root != "" && !strings.EqualFold(cleanDN(root), cleanDN(domain)) {
		return "", otherDomains
	}
	if si.ConfigurationNamingContext == "" {
		return "", "sets userPrincipalName (could not list the domains of the forest)"
	}
	// Domain crossRefs carry FLAG_CR_NTDS_DOMAIN (2) in systemFlags.
	res, err := dc.Search(ctx, models.SearchParams{BaseDN: "CN=Partitions," + si.ConfigurationNamingContext, Filter: "(objectClass=crossRef)",
		Scope: models.ScopeOne, Attributes: []string{"nCName", "systemFlags"}, SizeLimit: 200})
	if res == nil || err != nil {
		return "", "sets userPrincipalName (could not list the domains of the forest)"
	}
	domains := 0
	for i := range res.Entries {
		if f, ok := parseInt64(attrValue(&res.Entries[i], "systemFlags")); ok && f&2 != 0 {
			domains++
		}
	}
	if domains > 1 {
		return "", otherDomains
	}
	return domain, ""
}
