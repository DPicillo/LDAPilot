package agent

import (
	"errors"
	"fmt"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/chatstore"
	"github.com/dpicillo/LDAPilot/internal/ai/contextmgr"
)

var auditOps = map[string]string{
	"modify_entry": "MODIFY", "update_group_membership": "MODIFY", "unlock_account": "MODIFY", "set_account_enabled": "MODIFY", "set_password_must_change": "MODIFY",
	"reset_password": "MODIFY", "create_entry": "CREATE", "move_or_rename_entry": "RENAME", "delete_entry": "DELETE",
}

// Recover repairs chats whose last write may have been interrupted by a
// crash or exit (§3.6): every tool_use still marked Executing without a
// result gets a synthetic OUTCOME_UNKNOWN result and one audit entry. It
// returns the number of repaired calls.
func (m *Manager) Recover() int {
	if m.d.Store == nil || m.d.Store.ReadOnly() {
		return 0
	}
	total := 0
	for _, id := range m.d.Store.PendingWriteChats() {
		var repaired []ai.Block
		err := m.d.Store.Update(id, func(c *chatstore.Chat) error {
			repaired = repairExecuting(c)
			if len(repaired) == 0 {
				return errNothing
			}
			return nil
		})
		if err != nil && !errors.Is(err, errNothing) {
			m.d.Logf("ai: outcome-unknown recovery of chat %s failed: %v", id, err)
			continue
		}
		for _, tu := range repaired {
			total++
			if m.d.Auditor != nil {
				pid := ""
				if tu.Meta != nil {
					pid = tu.Meta.ConnectionID
				}
				op := auditOps[tu.Name]
				if op == "" {
					op = "MODIFY"
				}
				m.d.Auditor.Record(pid, op, contextmgr.DNFromInput(tu.Input),
					fmt.Sprintf("via AI (chat %s, %s) outcome unknown (app exited during the write)", id8(id), tu.Name), errors.New("outcome unknown"))
			}
		}
		if c, err := m.d.Store.Get(id); err == nil {
			m.emit(ai.EventChatUpdated, ai.ChatUpdatedEvent{ChatID: id, UpdatedAt: c.UpdatedAt, PendingWrite: false})
		}
	}
	return total
}

var errNothing = errors.New("nothing to repair")

// repairExecuting adds OUTCOME_UNKNOWN results for executing tool_uses
// without a result and clears the flags. It returns the repaired calls.
func repairExecuting(c *chatstore.Chat) []ai.Block {
	var repaired []ai.Block
	changed := false
	for mi := 0; mi < len(c.Messages); mi++ {
		msg := c.Messages[mi]
		if msg.Role != ai.RoleAssistant {
			continue
		}
		var missing []ai.Block
		for bi := range msg.Blocks {
			b := &c.Messages[mi].Blocks[bi]
			if b.Type != ai.BlockToolUse || b.Meta == nil || !b.Meta.Executing {
				continue
			}
			changed = true
			if !hasResult(c.Messages, mi, b.ID) {
				cp := *b
				meta := *b.Meta
				cp.Meta = &meta
				missing = append(missing, cp)
			}
			b.Meta.Executing, b.Meta.ExecutingSince = false, 0
		}
		if len(missing) == 0 {
			continue
		}
		var results []ai.Block
		for _, tu := range missing {
			results = append(results, contextmgr.SyntheticResult(tu))
			repaired = append(repaired, tu)
		}
		if mi+1 < len(c.Messages) && c.Messages[mi+1].Role == ai.RoleUser {
			next := &c.Messages[mi+1]
			next.Blocks = append(results, next.Blocks...)
		} else {
			um := ai.Message{ID: ai.NewUUID(), Role: ai.RoleUser, Blocks: results, CreatedAt: msg.CreatedAt}
			c.Messages = append(c.Messages[:mi+1], append([]ai.Message{um}, c.Messages[mi+1:]...)...)
		}
	}
	if !changed {
		return nil
	}
	if repaired == nil {
		repaired = []ai.Block{}
	}
	return repaired
}

func hasResult(msgs []ai.Message, assistantIdx int, id string) bool {
	if assistantIdx+1 >= len(msgs) || msgs[assistantIdx+1].Role != ai.RoleUser {
		return false
	}
	for _, b := range msgs[assistantIdx+1].Blocks {
		if b.Type == ai.BlockToolResult && b.ToolUseID == id {
			return true
		}
	}
	return false
}
