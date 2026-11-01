package ldaptools

import (
	"context"
	"errors"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ai/tools"
	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
)

// list_deleted_objects is served by the recycle track
// (Client.ListDeletedObjects / RecycleBinInfo). Restoring stays a non-goal
// of the assistant (AI-SPEC §13.2): the model points the user to
// LDAPilot's Deleted Objects view.

func init() {
	register(&readTool{def: &tools.Def{
		Name: "list_deleted_objects", DisplayName: "Deleted objects", Kind: tools.KindRead, Timeout: TimeoutCount, Directory: true,
		Description: "List deleted Active Directory objects (the Deleted Objects container, newest first) with their original name, object class, last known parent, deletion time and whether they can still be restored (deleted with the Recycle Bin, tombstone without it, or recycled = not restorable). Active Directory only. You cannot restore objects: tell the user to use LDAPilot's Deleted Objects view (Restore / Restore to…).",
		Params: tools.Obj(
			connectionProp(),
			tools.P("name_contains", tools.Str("Only objects whose name, last known RDN or sAMAccountName contains this text.")),
			tools.P("naming_context", tools.Str("Naming context to list (default: the domain).")),
			tools.P("limit", tools.Int("Maximum objects to return.", 1, 200, 50)),
		),
	}, run: runListDeletedObjects})
}

func runListDeletedObjects(ctx context.Context, s *Session, c *Call) *tools.Result {
	nc := cleanDN(c.Args.Str("naming_context"))
	if nc != "" {
		if r := checkDN(c.Tool, nc); r != nil {
			return r
		}
	}
	text := strings.TrimSpace(c.Args.Str("name_contains"))
	limit := c.Args.Int("limit", 50)
	rec := c.Client.Recycle()
	list, err := rec.List(ctx, nc, text, limit)
	if err != nil {
		if errors.Is(err, internalldap.ErrDeletedObjectsUnsupported) || errors.Is(err, ErrUnsupported) {
			return errf(c.Tool, tools.ErrUnsupportedOnServer, "Deleted objects exist only on Active Directory (Show Deleted control).", "This server does not offer deleted objects.")
		}
		return ErrorResult(c.Tool, err, nc)
	}
	z := NewSanitizer(false)
	r := newResult(c)
	r.Fields.Add("container_dn", list.ContainerDN)
	if info, err := rec.Info(ctx); err == nil && info != nil && info.RecycleBinKnown {
		r.Fields.Add("recycle_bin_enabled", info.RecycleBinEnabled)
		if !info.RecycleBinEnabled {
			r.Note("The AD Recycle Bin is not enabled: deleted objects are tombstones; a restore brings back only the kept attributes, without group memberships.")
		}
	}
	items := []any{}
	for _, o := range list.Objects {
		f := tools.Fs("name", z.Text(o.Name, "name", o.DN), "object_class", o.StructuralClass, "state", o.State, "restorable", o.Restorable)
		if o.SAMAccountName != "" {
			f.Add("login", z.Text(o.SAMAccountName, "sAMAccountName", o.DN))
		}
		if o.LastKnownParent != "" {
			f.Add("last_known_parent", z.DN(o.LastKnownParent))
		}
		if o.ParentDeleted {
			f.Add("parent_deleted", true)
		}
		if o.DeletedAt != "" {
			f.Add("deleted_at", o.DeletedAt)
		}
		items = append(items, f)
	}
	r.List = &tools.List{Key: "objects", Items: items, Offset: 0, More: list.Truncated, Total: -1}
	if !list.Truncated {
		r.List.Total = len(items)
	}
	r.Note("Restoring is done by the user in LDAPilot's Deleted Objects view; you cannot restore objects.")
	r.Warnings = append(r.Warnings, z.Warnings()...)
	r.Summary = Plural(len(items), "deleted object", "deleted objects")
	if list.Truncated {
		r.Summary += " (has more)"
	}
	return r
}
