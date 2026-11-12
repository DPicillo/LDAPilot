//go:build ignore

// generate.go writes the LDIF of the large OpenLDAP performance lab to stdout
// (the image pipes it into slapadd on first start, see entrypoint.sh).
// Run by hand: go run generate.go -users 1000 -groups 1000 -root-groups 400 | less
//
// Layout below the base DN (defaults: 100,000 users, 100,000 groups):
//
//	ou=Groups        -root-groups groupOfNames directly below (40,000: one flat container of groups)
//	ou=People        every user directly below (100,000 inetOrgPerson, 30 % also posixAccount)
//	ou=Departments   50 OUs, each with ou=Teams (posixGroup), ou=Projects (groupOfNames)
//	                 and ou=Roles (groupOfUniqueNames): the remaining groups, 200-600 per OU
//	ou=Sites         800 OUs with two devices each (a container full of containers)
//	ou=Contacts      2,000 inetOrgPerson without uid / userPassword (contacts)
//
// The output is deterministic for a given set of flags (-seed).
package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"unicode/utf8"
)

var firstNames = []string{
	"Anna", "Ben", "Clara", "David", "Emma", "Felix", "Greta", "Hannah", "Ida", "Jonas",
	"Karl", "Lena", "Max", "Nina", "Oskar", "Paula", "Quentin", "Rosa", "Simon", "Tessa",
	"Ulrich", "Vera", "Willi", "Xenia", "Yusuf", "Zoe", "Jürgen", "Björn", "Günther", "Käthe",
	"Søren", "Åsa", "René", "Chloé", "José", "María", "Łukasz", "Zoë", "Özlem", "Ayşe",
	"Mehmet", "Fatima", "Chen", "Mei", "Hiroshi", "Yuki", "Priya", "Arjun", "Olga", "Dmitri",
	"Giulia", "Marco", "Sofia", "Luca", "Elena", "Pablo", "Ines", "Tiago", "Freya", "Magnus",
	"Aoife", "Liam", "Niamh", "Sean", "Katarzyna", "Piotr", "Petra", "Tomáš", "Ilse", "Joris",
	"Amara", "Kwame", "Nia", "Tariq", "Leila", "Omar", "Noor", "Samir", "Hugo", "Léa",
	"Mats", "Lotte", "Finn", "Mia", "Paul", "Lea", "Tim", "Lina", "Jan", "Eva",
	"Tom", "Ella", "Nils", "Maja", "Erik", "Lara", "Jakob", "Nele", "Anton", "Marie",
}

var lastNames = []string{
	"Schmidt", "Müller", "Meyer", "Schulz", "Becker", "Hoffmann", "Schäfer", "Koch", "Bauer", "Richter",
	"Klein", "Wolf", "Schröder", "Neumann", "Schwarz", "Zimmermann", "Braun", "Krüger", "Hofmann", "Hartmann",
	"Lange", "Schmitt", "Werner", "Krause", "Meier", "Lehmann", "Köhler", "Herrmann", "König", "Walter",
	"Mayer", "Huber", "Kaiser", "Fuchs", "Peters", "Lang", "Scholz", "Möller", "Weiß", "Jung",
	"Hahn", "Schubert", "Vogel", "Friedrich", "Keller", "Günther", "Frank", "Berger", "Winkler", "Roth",
	"Beck", "Lorenz", "Baumann", "Franke", "Albrecht", "Schuster", "Simon", "Ludwig", "Böhm", "Winter",
	"Kraus", "Martin", "Schumacher", "Krämer", "Vogt", "Stein", "Jäger", "Otto", "Sommer", "Groß",
	"Seidel", "Heinrich", "Brandt", "Haas", "Schreiber", "Graf", "Schulte", "Dietrich", "Ziegler", "Kuhn",
	"Kühn", "Pohl", "Engel", "Horn", "Busch", "Bergmann", "Thomas", "Voigt", "Sauer", "Arnold",
	"Wolff", "Pfeiffer", "Garcia", "Rossi", "Dubois", "Nowak", "Jansen", "Andersson", "Novák", "Yılmaz",
	"Nguyen", "Kim", "Tanaka", "Singh", "Ivanov", "O'Brien", "van der Berg", "de la Cruz", "Østergaard", "Åkesson",
	"Papadopoulos", "Kowalski", "Fernández", "Silva", "Costa", "Moreau", "Lefèvre", "Bianchi", "Romano", "Horvat",
}

var deptNames = []string{
	"Engineering", "Sales", "Marketing", "Finance", "Human Resources", "IT Operations", "Legal", "Procurement", "Logistics", "Support",
	"Research", "Quality", "Facilities", "Security", "Compliance", "Controlling", "Design", "Production", "Service", "Training",
	"Audit", "Treasury", "Purchasing", "Planning", "Export", "Import", "Retail", "Wholesale", "E-Commerce", "Data Office",
	"Platform", "Network", "Workplace", "Identity", "Cloud", "Analytics", "Product", "Partner", "Field Service", "Customer Care",
	"Public Relations", "Sustainability", "Real Estate", "Fleet", "Payroll", "Tax", "Risk", "Strategy", "Innovation", "Works Council",
}

var cities = []string{
	"Berlin", "Hamburg", "München", "Köln", "Frankfurt", "Stuttgart", "Düsseldorf", "Leipzig", "Dortmund", "Essen",
	"Bremen", "Dresden", "Hannover", "Nürnberg", "Duisburg", "Bochum", "Wuppertal", "Bielefeld", "Bonn", "Münster",
	"Wien", "Zürich", "Graz", "Basel", "Linz", "Bern", "Salzburg", "Genf", "Innsbruck", "Luzern",
	"Praha", "Warszawa", "Budapest", "Milano", "Lyon", "Rotterdam", "Göteborg", "Aarhus", "Kraków", "Bratislava",
}

var groupSystems = []string{
	"sap", "crm", "erp", "vpn", "wiki", "git", "jira", "mail", "file", "print",
	"wlan", "citrix", "sql", "web", "shop", "pos", "dwh", "bi", "hr", "pim",
}

var groupRoles = []string{"users", "admins", "readers", "writers", "owners", "operators", "auditors", "approvers", "guests", "developers"}

var titles = []string{"Sachbearbeiter", "Teamleiter", "Engineer", "Consultant", "Analyst", "Administrator", "Manager", "Auszubildende", "Werkstudent", "Director"}

// Flags.
var (
	baseDN     = flag.String("base", "dc=perf,dc=ldapilot,dc=lab", "base DN (its first RDN must be dc=...)")
	users      = flag.Int("users", 100000, "users directly below ou=People")
	groups     = flag.Int("groups", 100000, "groups in total")
	rootGroups = flag.Int("root-groups", 40000, "groups directly below ou=Groups (the rest goes into the department OUs)")
	sites      = flag.Int("sites", 800, "OUs below ou=Sites")
	contacts   = flag.Int("contacts", 2000, "contacts below ou=Contacts")
	seed       = flag.Int64("seed", 20261112, "seed of the random generator")
	password   = flag.String("password", "password", "userPassword of every user (stored as {SSHA})")
	roPassword = flag.String("readonly-password", "readonly", "password of cn=readonly")
)

var (
	out *bufio.Writer
	rng *rand.Rand
)

// ldifSafe reports whether v can be written as "attr: v" (RFC 2849 SAFE-STRING).
func ldifSafe(v string) bool {
	if v == "" {
		return true
	}
	if v[0] == ' ' || v[0] == ':' || v[0] == '<' || v[len(v)-1] == ' ' {
		return false
	}
	for i := 0; i < len(v); i++ {
		if c := v[i]; c >= 0x80 || c == 0 || c == '\n' || c == '\r' {
			return false
		}
	}
	return true
}

// attr writes one attribute line (base64 when needed; slapadd reads long lines, so no folding).
func attr(name, value string) {
	if ldifSafe(value) {
		out.WriteString(name)
		out.WriteString(": ")
		out.WriteString(value)
	} else {
		out.WriteString(name)
		out.WriteString(":: ")
		out.WriteString(base64.StdEncoding.EncodeToString([]byte(value)))
	}
	out.WriteByte('\n')
}

func entry(dn string, classes ...string) {
	attr("dn", dn)
	for _, c := range classes {
		attr("objectClass", c)
	}
}

func end() { out.WriteByte('\n') }

// escapeRDN escapes an RDN value (RFC 4514).
func escapeRDN(v string) string {
	var b strings.Builder
	for i, r := range v {
		switch {
		case strings.ContainsRune(`,+"\<>;=`, r), i == 0 && (r == '#' || r == ' '), i == len(v)-1 && r == ' ':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// ascii folds a name to a lowercase ASCII login part ("Jürgen" -> "juergen").
func ascii(s string) string {
	repl := strings.NewReplacer(
		"ä", "ae", "ö", "oe", "ü", "ue", "ß", "ss", "Ä", "ae", "Ö", "oe", "Ü", "ue",
		"ø", "o", "Ø", "o", "å", "a", "Å", "a", "é", "e", "è", "e", "ë", "e", "á", "a", "í", "i", "ó", "o",
		"ł", "l", "Ł", "l", "ş", "s", "ı", "i", "š", "s", "ñ", "n", "'", "", " ", "",
	)
	s = strings.ToLower(repl.Replace(s))
	var b strings.Builder
	for _, r := range s {
		if r < utf8.RuneSelf && (r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ssha returns a {SSHA} userPassword value with a salt drawn from rng.
func ssha(pw string) string {
	salt := make([]byte, 4)
	rng.Read(salt)
	h := sha1.New()
	h.Write([]byte(pw))
	h.Write(salt)
	return "{SSHA}" + base64.StdEncoding.EncodeToString(append(h.Sum(nil), salt...))
}

// memberCount draws the size of a group: most are small, a few are big.
func memberCount(max int) int {
	n := 0
	switch p := rng.Intn(1000); {
	case p < 600:
		n = 1 + rng.Intn(5)
	case p < 900:
		n = 6 + rng.Intn(25)
	case p < 990:
		n = 31 + rng.Intn(170)
	default:
		n = 500 + rng.Intn(1500)
	}
	if n > max {
		n = max
	}
	if n < 1 {
		n = 1
	}
	return n
}

// pickUsers returns n distinct user indexes.
func pickUsers(n, total int) []int {
	if n >= total {
		all := make([]int, total)
		for i := range all {
			all[i] = i
		}
		return all
	}
	seen := make(map[int]bool, n)
	picked := make([]int, 0, n)
	for len(picked) < n {
		i := rng.Intn(total)
		if !seen[i] {
			seen[i] = true
			picked = append(picked, i)
		}
	}
	return picked
}

func main() {
	flag.Parse()
	if *rootGroups > *groups {
		*rootGroups = *groups
	}
	rng = rand.New(rand.NewSource(*seed))
	out = bufio.NewWriterSize(os.Stdout, 1<<20)
	defer out.Flush()

	base := *baseDN
	dc := strings.TrimPrefix(strings.SplitN(base, ",", 2)[0], "dc=")

	entry(base, "top", "dcObject", "organization")
	attr("dc", dc)
	attr("o", "LDAPilot Performance Lab")
	attr("description", fmt.Sprintf("%d users, %d groups (%d directly below ou=Groups)", *users, *groups, *rootGroups))
	end()

	entry("cn=readonly,"+base, "top", "organizationalRole", "simpleSecurityObject")
	attr("cn", "readonly")
	attr("description", "Read-only bind account (not the rootdn: ACLs and limits apply)")
	attr("userPassword", ssha(*roPassword))
	end()

	for _, ou := range []struct{ name, desc string }{
		{"Groups", fmt.Sprintf("%d groups directly below this OU", *rootGroups)},
		{"People", fmt.Sprintf("%d users directly below this OU", *users)},
		{"Departments", "Department OUs with their team, project and role groups"},
		{"Sites", fmt.Sprintf("%d site OUs", *sites)},
		{"Contacts", fmt.Sprintf("%d contacts (inetOrgPerson without uid)", *contacts)},
	} {
		entry("ou="+ou.name+","+base, "top", "organizationalUnit")
		attr("ou", ou.name)
		attr("description", ou.desc)
		end()
	}

	// --- Users ---------------------------------------------------------------------
	uids := make([]string, *users)
	userDNs := make([]string, *users)
	seenUID := map[string]int{}
	userPw := ssha(*password) // one hash for all: hashing 100,000 passwords adds nothing to the test
	for i := 0; i < *users; i++ {
		given := firstNames[rng.Intn(len(firstNames))]
		sn := lastNames[rng.Intn(len(lastNames))]
		uid := ascii(given) + "." + ascii(sn)
		seenUID[uid]++
		if n := seenUID[uid]; n > 1 {
			uid = fmt.Sprintf("%s%d", uid, n)
		}
		uids[i] = uid
		dn := "uid=" + uid + ",ou=People," + base
		userDNs[i] = dn
		posix := rng.Intn(100) < 30
		dept := deptNames[rng.Intn(len(deptNames))]

		classes := []string{"top", "person", "organizationalPerson", "inetOrgPerson"}
		if posix {
			classes = append(classes, "posixAccount", "shadowAccount")
		}
		entry(dn, classes...)
		attr("uid", uid)
		attr("cn", given+" "+sn)
		attr("sn", sn)
		attr("givenName", given)
		attr("displayName", sn+", "+given)
		attr("mail", uid+"@perf.ldapilot.lab")
		attr("employeeNumber", fmt.Sprintf("%06d", i+1))
		attr("ou", dept)
		attr("title", titles[rng.Intn(len(titles))])
		attr("l", cities[rng.Intn(len(cities))])
		attr("telephoneNumber", fmt.Sprintf("+49 30 %07d", rng.Intn(10000000)))
		if rng.Intn(100) < 20 {
			attr("description", fmt.Sprintf("%s, Personalnummer %06d", dept, i+1))
		}
		attr("userPassword", userPw)
		if posix {
			attr("uidNumber", fmt.Sprint(10000+i))
			attr("gidNumber", fmt.Sprint(5000+rng.Intn(50)))
			attr("homeDirectory", "/home/"+uid)
			attr("loginShell", "/bin/bash")
		}
		end()
	}

	// --- Groups directly below ou=Groups ----------------------------------------------
	for i := 0; i < *rootGroups; i++ {
		var cn string
		switch i % 10 {
		case 7:
			cn = fmt.Sprintf("Team %s %d", lastNames[rng.Intn(len(lastNames))], i+1)
		case 9:
			cn = fmt.Sprintf("%s %s %05d", deptNames[rng.Intn(len(deptNames))], cities[rng.Intn(len(cities))], i+1)
		default:
			cn = fmt.Sprintf("%s-%s-%05d", groupSystems[rng.Intn(len(groupSystems))], groupRoles[rng.Intn(len(groupRoles))], i+1)
		}
		entry("cn="+escapeRDN(cn)+",ou=Groups,"+base, "top", "groupOfNames")
		attr("cn", cn)
		if rng.Intn(100) < 50 {
			attr("description", fmt.Sprintf("Berechtigungsgruppe %d (%s)", i+1, deptNames[rng.Intn(len(deptNames))]))
		}
		if *users == 0 {
			attr("member", "cn=readonly,"+base)
		}
		for _, u := range pickUsers(memberCount(*users), *users) {
			attr("member", userDNs[u])
		}
		end()
	}

	// --- Department OUs with the remaining groups ----------------------------------
	rest := *groups - *rootGroups
	perDept := rest / len(deptNames)
	extra := rest % len(deptNames)
	gid := 20000
	for d, name := range deptNames {
		deptDN := fmt.Sprintf("ou=%02d %s,ou=Departments,%s", d+1, name, base)
		entry(deptDN, "top", "organizationalUnit")
		attr("ou", fmt.Sprintf("%02d %s", d+1, name))
		attr("description", "Department "+name)
		end()
		n := perDept
		if d < extra {
			n++
		}
		// Half teams, a third projects, the rest roles (600 / 400 / 200 of 1,200).
		counts := map[string]int{"Teams": n / 2, "Projects": n / 3}
		counts["Roles"] = n - counts["Teams"] - counts["Projects"]
		for _, sub := range []string{"Teams", "Projects", "Roles"} {
			subDN := "ou=" + sub + "," + deptDN
			entry(subDN, "top", "organizationalUnit")
			attr("ou", sub)
			end()
			for i := 0; i < counts[sub]; i++ {
				members := pickUsers(memberCount(*users), *users)
				switch sub {
				case "Teams":
					cn := fmt.Sprintf("team-%s-%04d", ascii(name), i+1)
					entry("cn="+cn+","+subDN, "top", "posixGroup")
					attr("cn", cn)
					attr("gidNumber", fmt.Sprint(gid))
					gid++
					for _, u := range members {
						attr("memberUid", uids[u])
					}
				case "Projects":
					cn := fmt.Sprintf("Projekt %s %04d", cities[rng.Intn(len(cities))], i+1)
					entry("cn="+escapeRDN(cn)+","+subDN, "top", "groupOfNames")
					attr("cn", cn)
					attr("description", "Projektgruppe der Abteilung "+name)
					if len(members) == 0 {
						attr("member", "cn=readonly,"+base)
					}
					for _, u := range members {
						attr("member", userDNs[u])
					}
				default:
					cn := fmt.Sprintf("role-%s-%s-%04d", ascii(name), groupRoles[rng.Intn(len(groupRoles))], i+1)
					entry("cn="+cn+","+subDN, "top", "groupOfUniqueNames")
					attr("cn", cn)
					if len(members) == 0 {
						attr("uniqueMember", "cn=readonly,"+base)
					}
					for _, u := range members {
						attr("uniqueMember", userDNs[u])
					}
				}
				end()
			}
		}
	}

	// --- Sites: a container full of containers ----------------------------------------
	for i := 0; i < *sites; i++ {
		name := fmt.Sprintf("%04d %s", i+1, cities[rng.Intn(len(cities))])
		siteDN := "ou=" + name + ",ou=Sites," + base
		entry(siteDN, "top", "organizationalUnit")
		attr("ou", name)
		attr("l", strings.SplitN(name, " ", 2)[1])
		end()
		for _, dev := range []string{"printer", "switch"} {
			cn := fmt.Sprintf("%s-%04d", dev, i+1)
			entry("cn="+cn+","+siteDN, "top", "device")
			attr("cn", cn)
			attr("serialNumber", fmt.Sprintf("SN%08d", rng.Intn(100000000)))
			end()
		}
	}

	// --- Contacts: persons without a login ----------------------------------------------
	seenCN := map[string]int{}
	for i := 0; i < *contacts; i++ {
		given := firstNames[rng.Intn(len(firstNames))]
		sn := lastNames[rng.Intn(len(lastNames))]
		cn := sn + ", " + given // a comma in the RDN, as "Last, First" directories have
		seenCN[cn]++
		if n := seenCN[cn]; n > 1 {
			cn = fmt.Sprintf("%s (%d)", cn, n)
		}
		entry("cn="+escapeRDN(cn)+",ou=Contacts,"+base, "top", "person", "organizationalPerson", "inetOrgPerson")
		attr("cn", cn)
		attr("sn", sn)
		attr("givenName", given)
		attr("mail", fmt.Sprintf("%s.%s%d@example.org", ascii(given), ascii(sn), i+1))
		attr("o", "Extern")
		end()
	}
}
