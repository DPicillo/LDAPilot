package ldap

import "testing"

func TestIsLeafObjectClass(t *testing.T) {
	for _, tc := range []struct {
		ocs  []string
		want bool
	}{
		{[]string{"top", "classSchema"}, true},
		{[]string{"top", "attributeSchema"}, true},
		{[]string{"top", "subSchema"}, true},
		{[]string{"top", "dMD"}, false},
		{[]string{"top", "person", "contact"}, false},
		{nil, false},
	} {
		if got := isLeafObjectClass(tc.ocs); got != tc.want {
			t.Errorf("isLeafObjectClass(%v) = %v, want %v", tc.ocs, got, tc.want)
		}
	}
}

func TestDetermineIconSchemaObjects(t *testing.T) {
	for _, tc := range []struct {
		ocs  []string
		want string
	}{
		{[]string{"top", "classSchema"}, "schemaclass"},
		{[]string{"top", "attributeSchema"}, "schemaattr"},
		{[]string{"top", "dMD"}, "schema"},
		{[]string{"top", "sitesContainer"}, "landmark"},
		{[]string{"top", "organizationalUnit"}, "folder"},
		{[]string{"top", "somethingElse"}, "file"},
	} {
		if got := IconForObjectClasses(tc.ocs); got != tc.want {
			t.Errorf("IconForObjectClasses(%v) = %q, want %q", tc.ocs, got, tc.want)
		}
	}
}

func TestProbeChildrenNoWork(t *testing.T) {
	// Nothing to probe: must not touch the (unconnected) client.
	c := &Client{}
	c.probeChildren(nil, nil)
}
