package ldaptools

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/tools"
)

// Tool is a registered LDAP tool.
type Tool interface {
	Def() *tools.Def
}

// Reader is a read tool.
type Reader interface {
	Tool
	Run(ctx context.Context, s *Session, c *Call) *tools.Result
}

// Writer is a write tool. Prepare validates, reads the current state and
// builds the exact operation; Execute (on Prepared) runs exactly that.
// Prepare returns a Result instead of a Prepared when no approval card is
// needed: an error (validation, protected area, …) or a no-op.
type Writer interface {
	Tool
	Prepare(ctx context.Context, s *Session, c *Call) (*Prepared, *tools.Result)
}

// Prepared is a write ready for approval.
type Prepared struct {
	Preview *ai.ChangePreview
	// Grant scope matching (§6.3).
	TargetDN   string
	GroupDN    string
	Attributes []string // touched attributes (lower-case)
	Action     string   // unlock | enable | disable
	// Audit.
	AuditOp     string // CREATE | MODIFY | RENAME | DELETE
	AuditDetail string // without the "via AI (…): " prefix
	Write       *ai.WriteInfo
	// Execute runs exactly the prepared operation. secret is non-nil only
	// for reset_password (the generated value; never put into a result).
	Execute func(ctx context.Context) (res *tools.Result, secret []byte)
	// PayloadBytes is the sum of value bytes (256 KB cap).
	PayloadBytes int
}

// ConnectionProp is the `connection` property of directory tools.
func connectionProp() tools.Prop {
	return tools.P(tools.ConnectionParam, tools.Str(tools.ConnectionDescription))
}

// Timeouts (§5.1).
const (
	TimeoutLocal  = 5 * time.Second
	TimeoutRead   = 30 * time.Second
	TimeoutCount  = 60 * time.Second
	TimeoutWrite  = 0 // the profile timeout
	DelegateBound = 130 * time.Second
)

var registry = map[string]Tool{}

func register(t Tool) Tool {
	registry[t.Def().Name] = t
	return t
}

// Lookup returns a tool by (normalized) name.
func Lookup(name string) Tool { return registry[name] }

// All returns every tool, read tools first, in a deterministic order.
func All() []Tool {
	out := make([]Tool, 0, len(registry))
	for _, t := range registry {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i].Def(), out[j].Def()
		if a.Kind != b.Kind {
			return a.Kind == tools.KindRead
		}
		return order(a.Name) < order(b.Name)
	})
	return out
}

var toolOrder = []string{"list_connections", "get_server_info", "count_entries", "find_by_name", "search_ldap", "get_entry", "get_children",
	"get_schema_definition", "validate_filter", "decode_value", "get_membership", "get_account_status", "find_accounts", "list_deleted_objects",
	"modify_entry", "create_entry", "move_or_rename_entry", "delete_entry", "update_group_membership",
	"unlock_account", "set_account_enabled", "set_password_must_change", "reset_password"}

func order(name string) int {
	for i, n := range toolOrder {
		if n == name {
			return i
		}
	}
	return len(toolOrder)
}

// IsWrite reports whether the named tool is a write tool.
func IsWrite(name string) bool {
	t := Lookup(name)
	return t != nil && t.Def().Kind == tools.KindWrite
}

// newResult starts an ok result for a directory call.
func newResult(c *Call) *tools.Result {
	r := &tools.Result{OK: true, Tool: c.Tool, DataOrigin: "ldap_directory"}
	if c.Conn != nil {
		r.Connection = c.Conn.Label
		r.ConnectionID = c.Conn.Info.ProfileID
		if c.Defaulted {
			r.Fields.Add("connection_defaulted", true)
		}
	}
	r.Notes = append(r.Notes, c.Notes...)
	return r
}

// cleanDN strips U+2060 and surrounding whitespace from a model-supplied
// DN (validation already removed U+2060).
func cleanDN(dn string) string { return strings.TrimSpace(ai.StripWordJoiners(dn)) }
