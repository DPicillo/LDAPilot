package services

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// rootSummary renders a plan as "DN[kind]{children}" lines for comparisons.
func rootSummary(nodes []ncNode) []string {
	var out []string
	for _, n := range nodes {
		s := n.DN + "[" + string(n.Kind) + "]"
		if n.Primary {
			s += "*"
		}
		if len(n.Children) > 0 {
			s += "{" + strings.Join(rootSummary(n.Children), " ") + "}"
		}
		out = append(out, s)
	}
	return out
}

func crossRef(dn string, flags int) ldap.CrossRef {
	return ldap.CrossRef{NCName: dn, SystemFlags: flags, HasFlags: true, Enabled: true}
}

// sambaLab mirrors the RootDSE and CN=Partitions of the Samba lab domain.
func sambaLab(baseDN string) adRootInput {
	return adRootInput{
		BaseDN:       baseDN,
		DefaultNC:    "DC=ad,DC=ldapilot,DC=lab",
		RootDomainNC: "DC=ad,DC=ldapilot,DC=lab",
		ConfigNC:     "CN=Configuration,DC=ad,DC=ldapilot,DC=lab",
		SchemaNC:     "CN=Schema,CN=Configuration,DC=ad,DC=ldapilot,DC=lab",
		NamingContexts: []string{
			"DC=ad,DC=ldapilot,DC=lab",
			"CN=Configuration,DC=ad,DC=ldapilot,DC=lab",
			"CN=Schema,CN=Configuration,DC=ad,DC=ldapilot,DC=lab",
			"DC=DomainDnsZones,DC=ad,DC=ldapilot,DC=lab",
			"DC=ForestDnsZones,DC=ad,DC=ldapilot,DC=lab",
		},
		CrossRefs: []ldap.CrossRef{
			crossRef("CN=Configuration,DC=ad,DC=ldapilot,DC=lab", 1),
			crossRef("DC=DomainDnsZones,DC=ad,DC=ldapilot,DC=lab", 5),
			crossRef("DC=ForestDnsZones,DC=ad,DC=ldapilot,DC=lab", 5),
			crossRef("DC=ad,DC=ldapilot,DC=lab", 3),
			crossRef("CN=Schema,CN=Configuration,DC=ad,DC=ldapilot,DC=lab", 1),
		},
	}
}

func TestPlanADRootsSingleDomain(t *testing.T) {
	want := []string{
		"DC=ad,DC=ldapilot,DC=lab[domain]*",
		"DC=DomainDnsZones,DC=ad,DC=ldapilot,DC=lab[domainDns]",
		"DC=ForestDnsZones,DC=ad,DC=ldapilot,DC=lab[forestDns]",
		"CN=Configuration,DC=ad,DC=ldapilot,DC=lab[configuration]",
		"CN=Schema,CN=Configuration,DC=ad,DC=ldapilot,DC=lab[schema]",
	}
	for _, baseDN := range []string{"DC=ad,DC=ldapilot,DC=lab", "", "dc=ad, dc=ldapilot, dc=lab"} {
		plan := planADRoots(sambaLab(baseDN))
		if got := rootSummary(plan.Roots); !reflect.DeepEqual(got, want) {
			t.Errorf("baseDN %q roots:\n got %q\nwant %q", baseDN, got, want)
		}
		if want := []string{"DC=ad,DC=ldapilot,DC=lab"}; !reflect.DeepEqual(plan.SearchBases, want) {
			t.Errorf("baseDN %q search bases = %q, want %q", baseDN, plan.SearchBases, want)
		}
	}

	// Without CN=Partitions (read failed) the RootDSE alone gives the same roots.
	in := sambaLab("")
	in.CrossRefs = nil
	if got := rootSummary(planADRoots(in).Roots); !reflect.DeepEqual(got, want) {
		t.Errorf("without crossRefs:\n got %q\nwant %q", got, want)
	}
}

func TestPlanADRootsScopedBaseDN(t *testing.T) {
	// An OU or container as base DN scopes the tree: it is the only root.
	for _, baseDN := range []string{
		"OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab",
		"CN=Sites,CN=Configuration,DC=ad,DC=ldapilot,DC=lab",
		"OU=Unknown,DC=elsewhere",
	} {
		plan := planADRoots(sambaLab(baseDN))
		if got, want := rootSummary(plan.Roots), []string{baseDN + "[]*"}; !reflect.DeepEqual(got, want) {
			t.Errorf("baseDN %q roots:\n got %q\nwant %q", baseDN, got, want)
		}
		if want := []string{baseDN}; !reflect.DeepEqual(plan.SearchBases, want) {
			t.Errorf("baseDN %q search bases = %q, want %q", baseDN, plan.SearchBases, want)
		}
	}

	// A non-domain NC head as base DN is the only root as well.
	plan := planADRoots(sambaLab("cn=schema,cn=configuration,dc=ad,dc=ldapilot,dc=lab"))
	want := []string{"CN=Schema,CN=Configuration,DC=ad,DC=ldapilot,DC=lab[schema]*"}
	if got := rootSummary(plan.Roots); !reflect.DeepEqual(got, want) {
		t.Errorf("schema base roots:\n got %q\nwant %q", got, want)
	}
	if want := []string{"CN=Schema,CN=Configuration,DC=ad,DC=ldapilot,DC=lab"}; !reflect.DeepEqual(plan.SearchBases, want) {
		t.Errorf("schema base search bases = %q, want %q", plan.SearchBases, want)
	}

	// NC heads below the base DN are not one-level children of it: they are
	// injected (Schema below Configuration).
	plan = planADRoots(sambaLab("CN=Configuration,DC=ad,DC=ldapilot,DC=lab"))
	want = []string{"CN=Configuration,DC=ad,DC=ldapilot,DC=lab[configuration]*{CN=Schema,CN=Configuration,DC=ad,DC=ldapilot,DC=lab[schema]}"}
	if got := rootSummary(plan.Roots); !reflect.DeepEqual(got, want) {
		t.Errorf("configuration base roots:\n got %q\nwant %q", got, want)
	}
	layout := layoutFromPlan(plan)
	if got := layout.injected["cn=configuration,dc=ad,dc=ldapilot,dc=lab"]; len(got) != 1 || got[0].Icon != "schema" {
		t.Errorf("injected below configuration = %+v", got)
	}

	// A domain NC head as base DN shows every NC (see TestPlanADRootsSingleDomain);
	// in a forest an explicit child-domain base DN works like its DC's default NC.
	byBase := forest("DC=corp,DC=com")
	byBase.BaseDN = "DC=a,DC=corp,DC=com"
	if got, want := rootSummary(planADRoots(byBase).Roots), rootSummary(planADRoots(forest("DC=a,DC=corp,DC=com")).Roots); !reflect.DeepEqual(got, want) {
		t.Errorf("child-domain base DN roots:\n got %q\nwant %q", got, want)
	}

	// An OU of the forest root scopes the tree; child domains are not below it.
	byBase.BaseDN = "OU=Sales,DC=corp,DC=com"
	if got, want := rootSummary(planADRoots(byBase).Roots), []string{"OU=Sales,DC=corp,DC=com[]*"}; !reflect.DeepEqual(got, want) {
		t.Errorf("forest OU base DN roots:\n got %q\nwant %q", got, want)
	}
}

// forest is a forest with root corp.com, child a.corp.com, grandchild
// x.a.corp.com and a second tree other.net, as seen from a DC of dc.
func forest(defaultNC string) adRootInput {
	return adRootInput{
		DefaultNC:    defaultNC,
		RootDomainNC: "DC=corp,DC=com",
		ConfigNC:     "CN=Configuration,DC=corp,DC=com",
		SchemaNC:     "CN=Schema,CN=Configuration,DC=corp,DC=com",
		NamingContexts: []string{
			defaultNC,
			"CN=Configuration,DC=corp,DC=com",
			"CN=Schema,CN=Configuration,DC=corp,DC=com",
			"DC=ForestDnsZones,DC=corp,DC=com",
			"DC=DomainDnsZones," + defaultNC,
		},
		CrossRefs: []ldap.CrossRef{
			crossRef("DC=other,DC=net", 3),
			crossRef("DC=x,DC=a,DC=corp,DC=com", 3),
			crossRef("DC=a,DC=corp,DC=com", 3),
			crossRef("DC=corp,DC=com", 3),
			crossRef("DC=DomainDnsZones,DC=corp,DC=com", 5),
			crossRef("DC=DomainDnsZones,DC=a,DC=corp,DC=com", 5),
			crossRef("DC=DomainDnsZones,DC=other,DC=net", 5),
			crossRef("DC=ForestDnsZones,DC=corp,DC=com", 5),
			crossRef("CN=Configuration,DC=corp,DC=com", 1),
			crossRef("CN=Schema,CN=Configuration,DC=corp,DC=com", 1),
			crossRef("CN=AppData,DC=corp,DC=com", 5),
			// An external directory and a pre-created partition: not shown.
			crossRef("o=partner,c=de", 0),
			{NCName: "DC=new,DC=corp,DC=com", SystemFlags: 3, HasFlags: true, Enabled: false},
		},
	}
}

func TestPlanADRootsForestRoot(t *testing.T) {
	plan := planADRoots(forest("DC=corp,DC=com"))
	want := []string{
		"DC=corp,DC=com[domain]*{DC=a,DC=corp,DC=com[domain]{DC=x,DC=a,DC=corp,DC=com[domain] DC=DomainDnsZones,DC=a,DC=corp,DC=com[domainDns]}}",
		"DC=other,DC=net[domain]{DC=DomainDnsZones,DC=other,DC=net[domainDns]}",
		"DC=DomainDnsZones,DC=corp,DC=com[domainDns]",
		"DC=ForestDnsZones,DC=corp,DC=com[forestDns]",
		"CN=AppData,DC=corp,DC=com[application]",
		"CN=Configuration,DC=corp,DC=com[configuration]",
		"CN=Schema,CN=Configuration,DC=corp,DC=com[schema]",
	}
	if got := rootSummary(plan.Roots); !reflect.DeepEqual(got, want) {
		t.Errorf("roots:\n got %q\nwant %q", got, want)
	}
	wantBases := []string{"DC=corp,DC=com", "DC=a,DC=corp,DC=com", "DC=x,DC=a,DC=corp,DC=com", "DC=other,DC=net"}
	if !reflect.DeepEqual(plan.SearchBases, wantBases) {
		t.Errorf("search bases = %q, want %q", plan.SearchBases, wantBases)
	}
}

func TestPlanADRootsChildDomainDC(t *testing.T) {
	// Connected to a DC of the child domain: it is the first root, the forest
	// root follows as its own root and keeps its other children.
	plan := planADRoots(forest("DC=a,DC=corp,DC=com"))
	want := []string{
		"DC=a,DC=corp,DC=com[domain]*{DC=x,DC=a,DC=corp,DC=com[domain]}",
		"DC=corp,DC=com[domain]{DC=DomainDnsZones,DC=corp,DC=com[domainDns]}",
		"DC=other,DC=net[domain]{DC=DomainDnsZones,DC=other,DC=net[domainDns]}",
		"DC=DomainDnsZones,DC=a,DC=corp,DC=com[domainDns]",
		"DC=ForestDnsZones,DC=corp,DC=com[forestDns]",
		"CN=AppData,DC=corp,DC=com[application]",
		"CN=Configuration,DC=corp,DC=com[configuration]",
		"CN=Schema,CN=Configuration,DC=corp,DC=com[schema]",
	}
	if got := rootSummary(plan.Roots); !reflect.DeepEqual(got, want) {
		t.Errorf("roots:\n got %q\nwant %q", got, want)
	}
	wantBases := []string{"DC=a,DC=corp,DC=com", "DC=x,DC=a,DC=corp,DC=com", "DC=corp,DC=com", "DC=other,DC=net"}
	if !reflect.DeepEqual(plan.SearchBases, wantBases) {
		t.Errorf("search bases = %q, want %q", plan.SearchBases, wantBases)
	}
}

func TestPlanADRootsADLDS(t *testing.T) {
	// AD LDS: no domain, no default NC; the application partition holds the data.
	plan := planADRoots(adRootInput{
		ConfigNC: "CN=Configuration,CN={A1B2}",
		SchemaNC: "CN=Schema,CN=Configuration,CN={A1B2}",
		NamingContexts: []string{
			"O=App,C=US",
			"CN=Configuration,CN={A1B2}",
			"CN=Schema,CN=Configuration,CN={A1B2}",
		},
	})
	want := []string{
		"O=App,C=US[application]",
		"CN=Configuration,CN={A1B2}[configuration]",
		"CN=Schema,CN=Configuration,CN={A1B2}[schema]",
	}
	if got := rootSummary(plan.Roots); !reflect.DeepEqual(got, want) {
		t.Errorf("roots:\n got %q\nwant %q", got, want)
	}
	if want := []string{"O=App,C=US"}; !reflect.DeepEqual(plan.SearchBases, want) {
		t.Errorf("search bases = %q, want %q", plan.SearchBases, want)
	}
}

func TestDNHelpers(t *testing.T) {
	if got := dnKey(" DC=A , dc=B,DC=c "); got != "dc=a,dc=b,dc=c" {
		t.Errorf("dnKey = %q", got)
	}
	if got := dnKey(`CN=Back\,Slash, DC=x`); got != `cn=back\,slash,dc=x` {
		t.Errorf("dnKey with escaped comma = %q", got)
	}
	for _, tc := range []struct {
		dn, ancestor string
		want         bool
	}{
		{"dc=a,dc=b", "dc=b", true},
		{"dc=b", "dc=b", false},
		{"dc=ab", "b", false},
		{`cn=x\,dc=b`, "dc=b", false},
		{"dc=a,dc=b", "", false},
	} {
		if got := isUnderDN(tc.dn, tc.ancestor); got != tc.want {
			t.Errorf("isUnderDN(%q, %q) = %v, want %v", tc.dn, tc.ancestor, got, tc.want)
		}
	}
	if got := parentDNOf(`CN=a\,b,DC=x, DC=y`); got != "DC=x, DC=y" {
		t.Errorf("parentDNOf = %q", got)
	}
	if got := parentDNOf("DC=x"); got != "" {
		t.Errorf("parentDNOf single RDN = %q", got)
	}
	for _, tc := range []struct {
		dn       string
		flags    int
		hasFlags bool
		want     ncKind
	}{
		{"CN=Configuration,DC=x", 1, true, ncKindConfiguration},
		{"CN=Schema,CN=Configuration,DC=x", 1, true, ncKindSchema},
		{"DC=DomainDnsZones,DC=x", 5, true, ncKindDomainDNS},
		{"dc=forestdnszones,dc=x", 0, false, ncKindForestDNS},
		{"DC=x", 3, true, ncKindDomain},
		{"DC=app,DC=x", 5, true, ncKindApplication},
		{"DC=x", 0, false, ncKindDomain},
		{"O=App,C=US", 0, false, ncKindApplication},
	} {
		if got := classifyNC(tc.dn, tc.flags, tc.hasFlags, "CN=Configuration,DC=x", "CN=Schema,CN=Configuration,DC=x"); got != tc.want {
			t.Errorf("classifyNC(%q) = %q, want %q", tc.dn, got, tc.want)
		}
	}
}

func TestInjectedChildren(t *testing.T) {
	plan := planADRoots(forest("DC=corp,DC=com"))
	s := &BrowserService{}
	s.layouts.set("p1", layoutFromPlan(plan))

	ldapChildren := []models.TreeNode{{DN: "OU=Sales,DC=corp,DC=com"}, {DN: "dc=a,dc=corp,dc=com"}}
	got, err := s.withInjectedChildren("p1", "dc=corp, dc=com", ldapChildren, nil)
	if err != nil {
		t.Fatal(err)
	}
	var dns []string
	for _, n := range got {
		dns = append(dns, n.DN)
	}
	// The child domain the server already returned is not added twice.
	if want := []string{"OU=Sales,DC=corp,DC=com", "dc=a,dc=corp,dc=com"}; !reflect.DeepEqual(dns, want) {
		t.Errorf("merged children = %q, want %q", dns, want)
	}

	// Below a child domain: its grandchild domain and DomainDnsZones are injected.
	got, err = s.withInjectedChildren("p1", "DC=a,DC=corp,DC=com", nil, nil)
	if err != nil || len(got) != 2 || got[0].DN != "DC=x,DC=a,DC=corp,DC=com" || got[0].Icon != "globe" || !got[0].HasChildren ||
		got[1].DN != "DC=DomainDnsZones,DC=a,DC=corp,DC=com" || got[1].Icon != "database" {
		t.Errorf("injected = %+v, %v", got, err)
	}

	// A failed LDAP read is reported, also for nodes with injected NCs (the
	// tree keeps what it had and shows the error instead of a near-empty node).
	readErr := errors.New("referral failed")
	for _, parent := range []string{"DC=a,DC=corp,DC=com", "OU=Sales,DC=corp,DC=com"} {
		if got, err := s.withInjectedChildren("p1", parent, nil, readErr); err != readErr || got != nil {
			t.Errorf("%s: got %+v, %v; want nil, %v", parent, got, err, readErr)
		}
	}

	// Other profiles pass through unchanged.
	if got, _ := s.withInjectedChildren("p2", "DC=corp,DC=com", ldapChildren, nil); len(got) != 2 {
		t.Errorf("other profile got %d children", len(got))
	}
}
