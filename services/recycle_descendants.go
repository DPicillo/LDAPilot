package services

import (
	"fmt"
	"strings"
)

// The first entries below a DN for the delete confirmation (DEF-20): the
// dialog shows the descendant count and lists the first ones, so a typed
// confirmation is made knowing what goes. One-level reads without
// attributes (ChildDNs), breadth first, not logged: a background read of the
// dialog.

// descendantListMax caps ListDescendants.
const descendantListMax = 200

// DescendantList is the first entries below DN (DN itself excluded).
type DescendantList struct {
	DN string `json:"dn"`
	// DNs in breadth-first order: the direct children first, then the next
	// level, each level in server order.
	DNs []string `json:"dns"`
	// Truncated: the walk stopped before it had read the whole subtree (the
	// limit was reached or a level could not be read), so there may be more
	// entries; the descendant count (CountDescendants) tells how many.
	Truncated bool `json:"truncated"`
}

// ListDescendants lists up to limit (1–200, default 50) entries below dn.
func (s *BrowserService) ListDescendants(profileID string, dn string, limit int) (*DescendantList, error) {
	dn = strings.TrimSpace(dn)
	if dn == "" {
		return nil, fmt.Errorf("DN must not be empty")
	}
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	dns, truncated, err := listDescendants(dn, limit, client.ChildDNs)
	if err != nil {
		return nil, err
	}
	return &DescendantList{DN: dn, DNs: dns, Truncated: truncated}, nil
}

// listDescendants walks the subtree of root breadth first with children
// (one-level reads of at most n DNs; more = the server has more) until
// limit DNs are collected. Every probed entry is root or a listed DN, so at
// most limit+1 reads are made. A failed read of root is an error; a failed
// read below it marks the list truncated.
func listDescendants(root string, limit int, children func(dn string, n int) ([]string, bool, error)) ([]string, bool, error) {
	if limit <= 0 {
		limit = 50
	}
	limit = min(limit, descendantListMax)
	out := []string{}
	queue := []string{root}
	truncated := false
	for len(queue) > 0 {
		dn := queue[0]
		queue = queue[1:]
		remaining := limit - len(out)
		if remaining <= 0 {
			// Entries are still waiting to be probed: they may have children.
			truncated = true
			break
		}
		kids, more, err := children(dn, remaining+1)
		if err != nil {
			if dn == root {
				return nil, false, err
			}
			truncated = true
			continue
		}
		if more || len(kids) > remaining {
			truncated = true
		}
		if len(kids) > remaining {
			kids = kids[:remaining]
		}
		out = append(out, kids...)
		queue = append(queue, kids...)
		if truncated && len(out) >= limit {
			break
		}
	}
	return out, truncated, nil
}
