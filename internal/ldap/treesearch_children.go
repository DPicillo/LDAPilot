package ldap

import (
	"strings"
	"sync"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// probeWorkers bounds the probe searches one GetChildren call runs at once.
// Servers that return neither hasSubordinates nor
// msDS-Approx-Immed-Subordinates (e.g. Samba AD) need one probe per child;
// running them sequentially took ~1s for the 1769 entries of the Samba
// schema partition on localhost and scales with the network round trip.
const probeWorkers = 8

// leafObjectClasses are object classes whose entries never have children, so
// GetChildren does not probe them: AD schema objects (the schema partition
// holds ~1700 of them) and the subschema subentry.
var leafObjectClasses = map[string]bool{
	"attributeschema": true,
	"classschema":     true,
	"subschema":       true,
}

// isLeafObjectClass reports whether any of the object classes is a known leaf class.
func isLeafObjectClass(objectClasses []string) bool {
	for _, oc := range objectClasses {
		if leafObjectClasses[strings.ToLower(oc)] {
			return true
		}
	}
	return false
}

// probeChildren sets HasChildren of nodes[i] for every i in idx by probing
// the server, running at most probeWorkers probes at once.
func (c *Client) probeChildren(nodes []models.TreeNode, idx []int) {
	if len(idx) == 0 {
		return
	}
	workers := probeWorkers
	if len(idx) < workers {
		workers = len(idx)
	}
	next := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				// Each worker writes distinct elements; no further locking needed.
				nodes[i].HasChildren = c.probeHasChildren(nodes[i].DN)
			}
		}()
	}
	for _, i := range idx {
		next <- i
	}
	close(next)
	wg.Wait()
}

// IconForObjectClasses returns the tree icon hint the browser uses for
// entries with the given object classes.
func IconForObjectClasses(objectClasses []string) string {
	return determineIcon(objectClasses)
}

// extraIcon maps object classes that determineIcon does not know (AD
// schema/partition objects) to an icon hint, "file" otherwise.
func extraIcon(objectClasses []string) string {
	for _, oc := range objectClasses {
		switch strings.ToLower(oc) {
		case "classschema":
			return "schemaclass"
		case "attributeschema":
			return "schemaattr"
		case "dmd", "subschema":
			return "schema"
		case "configuration":
			return "settings"
		case "crossrefcontainer":
			return "database"
		case "sitescontainer":
			return "landmark"
		}
	}
	return "file"
}
