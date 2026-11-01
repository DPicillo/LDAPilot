package services

import (
	"reflect"
	"strings"
	"testing"
)

func TestPlanNonADRoots(t *testing.T) {
	tests := []struct {
		name      string
		baseDN    string
		ncs       []string
		defaultNC string
		want      nonADRootPlan
	}{
		{
			name: "empty base DN, one naming context: that NC (never the RootDSE)",
			ncs:  []string{"dc=demo,dc=ldapilot,dc=local"},
			want: nonADRootPlan{Mode: nonADSingle, RootDN: "dc=demo,dc=ldapilot,dc=local"},
		},
		{
			name: "empty base DN, several naming contexts: forest path",
			ncs:  []string{"dc=example,dc=com", "o=netscaperoot"},
			want: nonADRootPlan{Mode: nonADForest, NamingContexts: []string{"dc=example,dc=com", "o=netscaperoot"}},
		},
		{
			name:   "explicit base DN with one naming context",
			baseDN: " ou=People,dc=demo,dc=ldapilot,dc=local ",
			ncs:    []string{"dc=demo,dc=ldapilot,dc=local"},
			want:   nonADRootPlan{Mode: nonADSingle, RootDN: "ou=People,dc=demo,dc=ldapilot,dc=local"},
		},
		{
			name:   "explicit base DN with several naming contexts keeps the forest path",
			baseDN: "dc=example,dc=com",
			ncs:    []string{"dc=example,dc=com", "dc=other,dc=com"},
			want:   nonADRootPlan{Mode: nonADForest, NamingContexts: []string{"dc=example,dc=com", "dc=other,dc=com"}},
		},
		{
			name: "duplicates and blanks do not make a forest",
			ncs:  []string{"dc=a,dc=b", " DC=a, DC=b ", ""},
			want: nonADRootPlan{Mode: nonADSingle, RootDN: "dc=a,dc=b"},
		},
		{
			name:      "no naming contexts: defaultNamingContext",
			defaultNC: "dc=fallback,dc=com",
			want:      nonADRootPlan{Mode: nonADSingle, RootDN: "dc=fallback,dc=com"},
		},
		{
			name: "nothing known: no root at all",
			want: nonADRootPlan{Mode: nonADNone},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := planNonADRoots(tt.baseDN, tt.ncs, tt.defaultNC)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("planNonADRoots() = %+v, want %+v", got, tt.want)
			}
			if got.Mode == nonADSingle && got.RootDN == "" {
				t.Error("a single root must never be the RootDSE (empty DN)")
			}
		})
	}
}

func TestClassifyStatsEntry(t *testing.T) {
	tests := []struct {
		oc   []string
		want string
	}{
		// Active Directory
		{[]string{"top", "person", "organizationalPerson", "user"}, "Users"},
		{[]string{"top", "person", "organizationalPerson", "contact"}, "Contacts"},
		{[]string{"top", "person", "organizationalPerson", "user", "computer"}, "Computers"},
		{[]string{"top", "person", "organizationalPerson", "user", "computer", "msDS-GroupManagedServiceAccount"}, "Service accounts"},
		{[]string{"top", "person", "organizationalPerson", "user", "computer", "msDS-ManagedServiceAccount"}, "Service accounts"},
		{[]string{"top", "group"}, "Groups"},
		{[]string{"top", "organizationalUnit"}, "OUs"},
		{[]string{"top", "container"}, "Containers"},
		{[]string{"top", "builtinDomain"}, "Containers"},
		{[]string{"top", "domain", "domainDNS"}, "Domains"},
		// OpenLDAP / 389DS
		{[]string{"top", "person", "organizationalPerson", "inetOrgPerson"}, "Users"},
		{[]string{"top", "posixAccount", "shadowAccount", "account"}, "Users"},
		{[]string{"top", "device", "ipHost"}, "Computers"},
		{[]string{"top", "device"}, "Computers"},
		{[]string{"top", "groupOfNames"}, "Groups"},
		{[]string{"top", "posixGroup"}, "Groups"},
		{[]string{"top", "dcObject", "organization"}, "Domains"},
		{[]string{"top", "organization"}, "OUs"},
		{[]string{"top", "organizationalRole"}, "Other"},
		{[]string{"TOP", "INETORGPERSON"}, "Users"},
		{nil, "Other"},
	}
	for _, tt := range tests {
		if got := classifyStatsEntry(tt.oc); got != tt.want {
			t.Errorf("classifyStatsEntry(%v) = %q, want %q", tt.oc, got, tt.want)
		}
	}
}

// statsFilterMatches evaluates the subset of LDAP filters statsCategoryFilter
// produces ((&...), (|...), (!...), (objectClass=x)) against object classes.
func statsFilterMatches(t *testing.T, filter string, oc []string) bool {
	t.Helper()
	have := make(map[string]bool)
	for _, c := range oc {
		have[statsLower(c)] = true
	}
	pos := 0
	var parse func() bool
	parse = func() bool {
		if filter[pos] != '(' {
			t.Fatalf("bad filter %q at %d", filter, pos)
		}
		pos++
		switch filter[pos] {
		case '&', '|', '!':
			op := filter[pos]
			pos++
			var results []bool
			for filter[pos] == '(' {
				results = append(results, parse())
			}
			pos++ // ')'
			switch op {
			case '!':
				return !results[0]
			case '&':
				for _, r := range results {
					if !r {
						return false
					}
				}
				return true
			default:
				for _, r := range results {
					if r {
						return true
					}
				}
				return false
			}
		}
		end := pos
		for filter[end] != ')' {
			end++
		}
		item := filter[pos:end]
		pos = end + 1
		const prefix = "objectClass="
		if len(item) <= len(prefix) || item[:len(prefix)] != prefix {
			t.Fatalf("unexpected item %q", item)
		}
		return have[statsLower(item[len(prefix):])]
	}
	return parse()
}

func statsLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// Every category filter finds exactly the entries the classifier counts in it.
func TestStatsCategoryFiltersMatchClassifier(t *testing.T) {
	samples := [][]string{
		{"top", "person", "organizationalPerson", "user"},
		{"top", "person", "organizationalPerson", "contact"},
		{"top", "person", "organizationalPerson", "user", "computer"},
		{"top", "person", "organizationalPerson", "user", "computer", "msDS-GroupManagedServiceAccount"},
		{"top", "group"},
		{"top", "organizationalUnit"},
		{"top", "container"},
		{"top", "domain", "domainDNS"},
		{"top", "inetOrgPerson"},
		{"top", "device", "ipHost"},
		{"top", "dcObject", "organization"},
		{"top", "organizationalRole"},
		{"top", "groupOfUniqueNames"},
	}
	categories := []string{statsOtherCategory}
	for _, r := range statsRules {
		categories = append(categories, r.Category)
	}
	for _, oc := range samples {
		want := classifyStatsEntry(oc)
		for _, category := range categories {
			f := statsCategoryFilter(category, nil)
			if f == "" {
				t.Fatalf("no filter for %q", category)
			}
			if got := statsFilterMatches(t, f, oc); got != (category == want) {
				t.Errorf("%v: filter of %q matches=%v, but the classifier says %q", oc, category, got, want)
			}
		}
	}
	if statsCategoryFilter("Unknown", nil) != "" {
		t.Error("unknown category must have no filter")
	}
	if got := statsCategoryFilter("Service accounts", nil); got != "(|(objectClass=msDS-GroupManagedServiceAccount)(objectClass=msDS-ManagedServiceAccount)(objectClass=msDS-DelegatedManagedServiceAccount))" {
		t.Errorf("service account filter = %q", got)
	}
}

// With the classes seen below the base, the filters name only those classes
// (OpenLDAP: an unknown class in (!...) would make the filter Undefined), and
// they still find exactly the classified entries.
func TestStatsCategoryFiltersSeenClasses(t *testing.T) {
	entries := [][]string{
		{"top", "person", "organizationalPerson", "inetOrgPerson", "posixAccount"},
		{"top", "organizationalUnit"},
		{"top", "device", "ipHost"},
		{"top", "groupOfNames"},
		{"top", "dcObject", "organization"},
		{"top", "organizationalRole"},
	}
	seen := map[string]string{}
	for _, oc := range entries {
		for _, c := range oc {
			seen[statsLower(c)] = c
		}
	}
	if got, want := statsCategoryFilter("Users", seen), "(&(|(objectClass=inetOrgPerson)(objectClass=posixAccount)(objectClass=person)(objectClass=organizationalPerson))(!(|(objectClass=device)(objectClass=ipHost)(objectClass=groupOfNames))))"; got != want {
		t.Errorf("Users filter = %q, want %q", got, want)
	}
	if got := statsCategoryFilter("Computers", seen); got != "(|(objectClass=device)(objectClass=ipHost))" {
		t.Errorf("Computers filter = %q", got)
	}
	if got := statsCategoryFilter("Contacts", seen); got != "" {
		t.Errorf("no contacts below the base: no filter, got %q", got)
	}
	for _, oc := range entries {
		want := classifyStatsEntry(oc)
		for _, category := range []string{"Users", "Computers", "Groups", "Domains", "OUs", "Other"} {
			f := statsCategoryFilter(category, seen)
			if f == "" {
				continue
			}
			if strings.Contains(f, "msDS-") || strings.Contains(f, "contact") {
				t.Errorf("%s filter names a class no entry has: %s", category, f)
			}
			if got := statsFilterMatches(t, f, oc); got != (category == want) {
				t.Errorf("%v: %s filter matches=%v, classifier says %q", oc, category, got, want)
			}
		}
	}
	if got := statsCategoryFilter(statsOtherCategory, map[string]string{"top": "top"}); got != "(objectClass=*)" {
		t.Errorf("Other without any rule class = %q", got)
	}
}
