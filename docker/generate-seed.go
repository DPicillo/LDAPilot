//go:build ignore

// generate-seed.go creates LDIF seed files for the LDAPilot demo OpenLDAP container.
// Run: go run generate-seed.go
// Output: seed/02-users.ldif, seed/03-groups.ldif, seed/04-services.ldif, seed/05-extended.ldif

package main

import (
	"encoding/base64"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
)

const baseDN = "dc=demo,dc=ldapilot,dc=local"

// Department OUs under ou=People
var departments = []string{
	"Engineering", "Sales", "Management", "HR", "IT", "Finance", "Contractors",
}

// departmentDistribution controls how many users each department gets (roughly).
var departmentDistribution = map[string]int{
	"Engineering": 55,
	"Sales":       35,
	"Management":  15,
	"HR":          20,
	"IT":          35,
	"Finance":     20,
	"Contractors": 20,
}

type user struct {
	uid            string
	givenName      string
	sn             string
	cn             string
	title          string
	department     string
	ou             string
	employeeNumber string
	dn             string
	mail           string
	hasPosix       bool
	uidNumber      int
	gidNumber      int
}

// German and international first/last names for realistic data
var firstNames = []string{
	"Thomas", "Michael", "Stefan", "Andreas", "Peter", "Klaus", "Hans", "Wolfgang",
	"Markus", "Christian", "Martin", "Frank", "Bernd", "Jens", "Tobias",
	"Alexander", "Daniel", "Matthias", "Florian", "Sebastian", "Jan", "Marco",
	"Lukas", "Felix", "Maximilian", "David", "Philipp", "Patrick", "Tim", "Nico",
	"Anna", "Maria", "Sabine", "Monika", "Petra", "Claudia", "Julia", "Laura",
	"Katharina", "Sarah", "Lisa", "Hannah", "Lena", "Nina", "Sandra", "Birgit",
	"Andrea", "Stefanie", "Nicole", "Christine", "Simone", "Heike", "Melanie",
	"Franziska", "Johanna", "Eva", "Martina", "Susanne", "Silke", "Anja",
	"Hiroshi", "Yuki", "Amir", "Fatima", "Carlos", "Elena", "Raj", "Priya",
	"Omar", "Leila", "Viktor", "Natalia", "Piotr", "Agnieszka", "Giuseppe", "Sofia",
}

var lastNames = []string{
	"Mueller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner",
	"Becker", "Schulz", "Hoffmann", "Schaefer", "Koch", "Bauer", "Richter",
	"Klein", "Wolf", "Schroeder", "Neumann", "Schwarz", "Zimmermann",
	"Braun", "Krueger", "Hofmann", "Hartmann", "Lange", "Schmitt", "Werner",
	"Schmitz", "Krause", "Meier", "Lehmann", "Schmid", "Schulze", "Maier",
	"Koehler", "Herrmann", "Koenig", "Walter", "Mayer", "Huber", "Kaiser",
	"Fuchs", "Peters", "Lang", "Scholz", "Moeller", "Weiss", "Jung",
	"Hahn", "Schubert", "Vogel", "Friedrich", "Keller", "Guenther", "Frank",
	"Berger", "Winkler", "Roth", "Beck", "Lorenz", "Baumann", "Franke",
	"Albrecht", "Schuster", "Simon", "Ludwig", "Boehm", "Winter", "Kraus",
	"Tanaka", "Sato", "Hassan", "Ali", "Garcia", "Lopez", "Patel", "Singh",
	"Ivanov", "Kowalski", "Rossi", "Andersson",
}

var titlesByDept = map[string][]string{
	"Engineering": {
		"Software Engineer", "Senior Software Engineer", "Staff Engineer",
		"Backend Developer", "Frontend Developer", "Full Stack Developer",
		"DevOps Engineer", "Site Reliability Engineer", "QA Engineer",
		"Test Automation Engineer", "Data Engineer", "ML Engineer",
		"Platform Engineer", "Security Engineer", "Embedded Developer",
	},
	"Sales": {
		"Sales Manager", "Account Executive", "Sales Representative",
		"Business Development Manager", "Key Account Manager",
		"Regional Sales Director", "Sales Engineer", "Pre-Sales Consultant",
		"Channel Partner Manager", "Inside Sales Representative",
	},
	"Management": {
		"CEO", "CTO", "CFO", "COO", "VP Engineering",
		"VP Sales", "VP Human Resources", "Director of Operations",
		"Head of Product", "Chief Information Security Officer",
		"Managing Director", "Head of Strategy",
	},
	"HR": {
		"HR Manager", "HR Business Partner", "Recruiter",
		"Senior Recruiter", "Talent Acquisition Lead", "HR Coordinator",
		"Compensation Analyst", "Training Manager", "People Operations Manager",
		"Diversity & Inclusion Lead",
	},
	"IT": {
		"System Administrator", "Senior System Administrator",
		"Network Engineer", "Database Administrator", "IT Support Specialist",
		"IT Manager", "Cloud Architect", "Infrastructure Engineer",
		"IT Security Analyst", "Help Desk Technician",
		"Endpoint Management Specialist", "Identity & Access Manager",
	},
	"Finance": {
		"Financial Analyst", "Senior Accountant", "Controller",
		"Accounts Payable Specialist", "Tax Specialist", "Auditor",
		"Financial Controller", "Budget Analyst", "Payroll Manager",
		"Treasury Analyst",
	},
	"Contractors": {
		"External Consultant", "Freelance Developer", "Contract Engineer",
		"IT Consultant", "Project Contractor", "Interim Manager",
		"External Auditor", "Freelance Designer", "Contract DBA",
		"Security Consultant",
	},
}

func main() {
	rng := rand.New(rand.NewSource(42)) // fixed seed for reproducibility

	// Generate users
	users := generateUsers(rng)
	writeUsersLDIF(users)

	// Generate groups
	writeGroupsLDIF(users, rng)

	// Generate services, devices, policies
	writeServicesLDIF()

	// Generate extended/edge-case entries
	writeExtendedLDIF()

	fmt.Println("Seed LDIF files generated successfully in seed/")
}

func generateUsers(rng *rand.Rand) []user {
	var users []user
	usedUIDs := make(map[string]bool)
	empNum := 1
	uidNum := 10000
	posixCount := 0

	for _, dept := range departments {
		count := departmentDistribution[dept]
		for i := 0; i < count; i++ {
			fn := firstNames[rng.Intn(len(firstNames))]
			ln := lastNames[rng.Intn(len(lastNames))]

			uid := strings.ToLower(fmt.Sprintf("%s.%s", fn, ln))
			// Ensure unique uid
			origUID := uid
			for suffix := 2; usedUIDs[uid]; suffix++ {
				uid = fmt.Sprintf("%s%d", origUID, suffix)
			}
			usedUIDs[uid] = true

			cn := fmt.Sprintf("%s %s", fn, ln)
			titles := titlesByDept[dept]
			title := titles[rng.Intn(len(titles))]

			hasPosix := false
			if (dept == "Engineering" || dept == "IT") && posixCount < 40 && rng.Float64() < 0.55 {
				hasPosix = true
				posixCount++
			}

			u := user{
				uid:            uid,
				givenName:      fn,
				sn:             ln,
				cn:             cn,
				title:          title,
				department:     dept,
				ou:             dept,
				employeeNumber: fmt.Sprintf("EMP%05d", empNum),
				dn:             fmt.Sprintf("uid=%s,ou=%s,ou=People,%s", uid, dept, baseDN),
				mail:           fmt.Sprintf("%s@demo.ldapilot.local", uid),
				hasPosix:       hasPosix,
				uidNumber:      uidNum,
				gidNumber:      uidNum,
			}
			users = append(users, u)
			empNum++
			if hasPosix {
				uidNum++
			}
		}
	}

	return users
}

func writeUsersLDIF(users []user) {
	var sb strings.Builder
	rng := rand.New(rand.NewSource(99))

	// Collect managers (Management dept users) for manager references
	var managers []string
	for _, u := range users {
		if u.department == "Management" {
			managers = append(managers, u.dn)
		}
	}

	for i, u := range users {
		sb.WriteString(fmt.Sprintf("dn: %s\n", u.dn))
		if u.hasPosix {
			sb.WriteString("objectClass: inetOrgPerson\n")
			sb.WriteString("objectClass: posixAccount\n")
			sb.WriteString("objectClass: shadowAccount\n")
		} else {
			sb.WriteString("objectClass: inetOrgPerson\n")
		}
		sb.WriteString(fmt.Sprintf("uid: %s\n", u.uid))
		sb.WriteString(fmt.Sprintf("cn: %s\n", u.cn))
		sb.WriteString(fmt.Sprintf("givenName: %s\n", u.givenName))
		sb.WriteString(fmt.Sprintf("sn: %s\n", u.sn))
		sb.WriteString(fmt.Sprintf("mail: %s\n", u.mail))
		sb.WriteString(fmt.Sprintf("title: %s\n", u.title))
		sb.WriteString(fmt.Sprintf("ou: %s\n", u.ou))
		sb.WriteString(fmt.Sprintf("employeeNumber: %s\n", u.employeeNumber))
		sb.WriteString(fmt.Sprintf("employeeType: %s\n", u.department))
		sb.WriteString(fmt.Sprintf("departmentNumber: %s\n", u.department))

		// Display name
		sb.WriteString(fmt.Sprintf("displayName: %s\n", u.cn))

		// Initials
		sb.WriteString(fmt.Sprintf("initials: %s%s\n", string(u.givenName[0]), string(u.sn[0])))

		// userPassword (simple for demo)
		sb.WriteString(fmt.Sprintf("userPassword: %s\n", u.uid))

		// Phone number
		phoneArea := []string{"30", "40", "89", "69", "221", "211", "711", "511"}[rng.Intn(8)]
		phoneNum := fmt.Sprintf("+49 %s %07d", phoneArea, rng.Intn(10000000))
		sb.WriteString(fmt.Sprintf("telephoneNumber: %s\n", phoneNum))

		// Some users get a mobile number
		if rng.Float64() < 0.4 {
			mobilePrefix := []string{"170", "171", "172", "175", "176", "177", "178", "179"}[rng.Intn(8)]
			mobile := fmt.Sprintf("+49 %s %07d", mobilePrefix, rng.Intn(10000000))
			sb.WriteString(fmt.Sprintf("mobile: %s\n", mobile))
		}

		// Some users get a secondary email
		if rng.Float64() < 0.2 {
			sb.WriteString(fmt.Sprintf("mail: %s.%s@private-mail.example.com\n", strings.ToLower(u.givenName), strings.ToLower(u.sn)))
		}

		// Description for some users
		if rng.Float64() < 0.3 {
			sb.WriteString(fmt.Sprintf("description: %s in the %s department\n", u.title, u.department))
		}

		// Manager reference (not for Management themselves)
		if u.department != "Management" && len(managers) > 0 {
			mgr := managers[rng.Intn(len(managers))]
			sb.WriteString(fmt.Sprintf("manager: %s\n", mgr))
		}

		// Organization
		sb.WriteString("o: LDAPilot Demo GmbH\n")

		// Postal address for some
		if rng.Float64() < 0.25 {
			streets := []string{
				"Friedrichstrasse 123", "Hauptstrasse 45", "Bahnhofstrasse 7",
				"Berliner Allee 89", "Koenigsallee 12", "Maximilianstrasse 56",
				"Marienplatz 3", "Leopoldstrasse 99",
			}
			cities := []string{"Berlin", "Hamburg", "Munich", "Frankfurt", "Cologne", "Duesseldorf", "Stuttgart", "Hannover"}
			idx := rng.Intn(len(streets))
			sb.WriteString(fmt.Sprintf("postalAddress: %s\n", streets[idx]))
			sb.WriteString(fmt.Sprintf("l: %s\n", cities[idx]))
			sb.WriteString("st: Germany\n")
			postalCodes := []string{"10117", "20095", "80331", "60311", "50667", "40213", "70173", "30159"}
			sb.WriteString(fmt.Sprintf("postalCode: %s\n", postalCodes[idx]))
		}

		// Room number for some
		if rng.Float64() < 0.35 {
			floor := rng.Intn(5) + 1
			room := rng.Intn(50) + 1
			sb.WriteString(fmt.Sprintf("roomNumber: %d.%02d\n", floor, room))
		}

		// POSIX attributes
		if u.hasPosix {
			sb.WriteString(fmt.Sprintf("uidNumber: %d\n", u.uidNumber))
			sb.WriteString(fmt.Sprintf("gidNumber: %d\n", u.gidNumber))
			sb.WriteString(fmt.Sprintf("homeDirectory: /home/%s\n", u.uid))
			shells := []string{"/bin/bash", "/bin/zsh", "/bin/sh"}
			sb.WriteString(fmt.Sprintf("loginShell: %s\n", shells[rng.Intn(len(shells))]))
			sb.WriteString(fmt.Sprintf("gecos: %s\n", u.cn))
		}

		// Separator between entries
		if i < len(users)-1 {
			sb.WriteString("\n")
		}
	}

	writeFile("seed/02-users.ldif", sb.String())
	fmt.Printf("Generated %d users in seed/02-users.ldif\n", len(users))
}

func writeGroupsLDIF(users []user, rng *rand.Rand) {
	var sb strings.Builder
	groupCount := 0

	// Helper to get users by department
	byDept := make(map[string][]user)
	for _, u := range users {
		byDept[u.department] = append(byDept[u.department], u)
	}

	// --- Team groups (one per department + some cross-functional) ---
	teamGroups := []struct {
		name string
		desc string
		dept string // if empty, cross-functional
	}{
		{"engineering-backend", "Backend Engineering Team", "Engineering"},
		{"engineering-frontend", "Frontend Engineering Team", "Engineering"},
		{"engineering-devops", "DevOps and Infrastructure Team", "Engineering"},
		{"engineering-qa", "Quality Assurance Team", "Engineering"},
		{"engineering-data", "Data Engineering Team", "Engineering"},
		{"sales-enterprise", "Enterprise Sales Team", "Sales"},
		{"sales-smb", "SMB Sales Team", "Sales"},
		{"sales-channel", "Channel Partner Sales Team", "Sales"},
		{"it-infrastructure", "IT Infrastructure Team", "IT"},
		{"it-helpdesk", "IT Help Desk Team", "IT"},
		{"it-security", "IT Security Team", "IT"},
		{"hr-recruiting", "Recruiting Team", "HR"},
		{"hr-operations", "HR Operations Team", "HR"},
		{"finance-accounting", "Accounting Team", "Finance"},
		{"finance-controlling", "Controlling Team", "Finance"},
		{"management-exec", "Executive Team", "Management"},
	}

	for _, tg := range teamGroups {
		dn := fmt.Sprintf("cn=%s,ou=Teams,ou=Groups,%s", tg.name, baseDN)
		sb.WriteString(fmt.Sprintf("dn: %s\n", dn))
		sb.WriteString("objectClass: groupOfNames\n")
		sb.WriteString(fmt.Sprintf("cn: %s\n", tg.name))
		sb.WriteString(fmt.Sprintf("description: %s\n", tg.desc))

		deptUsers := byDept[tg.dept]
		// Assign a subset of department users to each team
		memberCount := len(deptUsers) / 3
		if memberCount < 3 {
			memberCount = min(3, len(deptUsers))
		}
		perm := rng.Perm(len(deptUsers))
		for j := 0; j < memberCount && j < len(perm); j++ {
			sb.WriteString(fmt.Sprintf("member: %s\n", deptUsers[perm[j]].dn))
		}
		sb.WriteString("\n")
		groupCount++
	}

	// Cross-functional teams
	crossTeams := []struct {
		name  string
		desc  string
		depts []string
	}{
		{"cross-platform", "Cross-Platform Development Team", []string{"Engineering", "IT"}},
		{"cross-innovation", "Innovation Lab Team", []string{"Engineering", "Management", "Sales"}},
		{"cross-onboarding", "Onboarding Committee", []string{"HR", "IT", "Management"}},
		{"cross-budget", "Budget Planning Committee", []string{"Finance", "Management"}},
	}

	for _, ct := range crossTeams {
		dn := fmt.Sprintf("cn=%s,ou=Teams,ou=Groups,%s", ct.name, baseDN)
		sb.WriteString(fmt.Sprintf("dn: %s\n", dn))
		sb.WriteString("objectClass: groupOfNames\n")
		sb.WriteString(fmt.Sprintf("cn: %s\n", ct.name))
		sb.WriteString(fmt.Sprintf("description: %s\n", ct.desc))

		for _, dept := range ct.depts {
			deptUsers := byDept[dept]
			count := min(4, len(deptUsers))
			perm := rng.Perm(len(deptUsers))
			for j := 0; j < count; j++ {
				sb.WriteString(fmt.Sprintf("member: %s\n", deptUsers[perm[j]].dn))
			}
		}
		sb.WriteString("\n")
		groupCount++
	}

	// --- Role groups ---
	roleGroups := []struct {
		name  string
		desc  string
		depts []string
		count int
	}{
		{"role-admin", "System Administrators", []string{"IT"}, 5},
		{"role-developer", "Application Developers", []string{"Engineering"}, 15},
		{"role-dba", "Database Administrators", []string{"IT", "Engineering"}, 4},
		{"role-auditor", "Audit Access Role", []string{"Finance", "Management"}, 4},
		{"role-hr-admin", "HR Administration Role", []string{"HR"}, 5},
		{"role-vpn-access", "VPN Remote Access", []string{"Engineering", "IT", "Sales", "Management"}, 20},
		{"role-deploy", "Deployment Access", []string{"Engineering", "IT"}, 8},
		{"role-readonly-prod", "Production Read-Only Access", []string{"Engineering", "IT", "Management"}, 10},
		{"role-manager", "People Manager Role", []string{"Management", "Engineering", "Sales", "IT"}, 8},
		{"role-finance-viewer", "Financial Reports Viewer", []string{"Finance", "Management"}, 6},
	}

	for _, rg := range roleGroups {
		dn := fmt.Sprintf("cn=%s,ou=Roles,ou=Groups,%s", rg.name, baseDN)
		sb.WriteString(fmt.Sprintf("dn: %s\n", dn))
		sb.WriteString("objectClass: groupOfNames\n")
		sb.WriteString(fmt.Sprintf("cn: %s\n", rg.name))
		sb.WriteString(fmt.Sprintf("description: %s\n", rg.desc))

		added := 0
		for _, dept := range rg.depts {
			deptUsers := byDept[dept]
			perDept := rg.count / len(rg.depts)
			if perDept < 2 {
				perDept = 2
			}
			perm := rng.Perm(len(deptUsers))
			for j := 0; j < perDept && j < len(perm) && added < rg.count; j++ {
				sb.WriteString(fmt.Sprintf("member: %s\n", deptUsers[perm[j]].dn))
				added++
			}
		}
		sb.WriteString("\n")
		groupCount++
	}

	// --- Distribution lists ---
	distGroups := []struct {
		name  string
		desc  string
		depts []string
	}{
		{"dl-all-employees", "All Employees Distribution List", nil},              // all users
		{"dl-engineering", "Engineering Department Mailing List", []string{"Engineering"}},
		{"dl-sales", "Sales Department Mailing List", []string{"Sales"}},
		{"dl-management", "Management Distribution List", []string{"Management"}},
		{"dl-hr", "HR Department Mailing List", []string{"HR"}},
		{"dl-it", "IT Department Mailing List", []string{"IT"}},
		{"dl-finance", "Finance Department Mailing List", []string{"Finance"}},
		{"dl-project-phoenix", "Project Phoenix Team", []string{"Engineering", "Sales", "Management"}},
		{"dl-townhall", "Town Hall Meeting Attendees", nil},
		{"dl-social-committee", "Social Events Committee", []string{"HR", "Engineering", "Sales"}},
	}

	for _, dg := range distGroups {
		dn := fmt.Sprintf("cn=%s,ou=Distribution,ou=Groups,%s", dg.name, baseDN)
		sb.WriteString(fmt.Sprintf("dn: %s\n", dn))
		sb.WriteString("objectClass: groupOfNames\n")
		sb.WriteString(fmt.Sprintf("cn: %s\n", dg.name))
		sb.WriteString(fmt.Sprintf("description: %s\n", dg.desc))

		if dg.depts == nil {
			// All users - this is our large group (50+ members)
			for _, u := range users {
				sb.WriteString(fmt.Sprintf("member: %s\n", u.dn))
			}
		} else {
			for _, dept := range dg.depts {
				for _, u := range byDept[dept] {
					sb.WriteString(fmt.Sprintf("member: %s\n", u.dn))
				}
			}
		}
		sb.WriteString("\n")
		groupCount++
	}

	// --- Security groups ---
	secGroups := []struct {
		name  string
		desc  string
		depts []string
		count int
	}{
		{"sec-building-access", "Building Access Card Holders", nil, 50},
		{"sec-server-room", "Server Room Physical Access", []string{"IT"}, 5},
		{"sec-confidential", "Confidential Document Access", []string{"Management", "Finance", "HR"}, 10},
		{"sec-git-write", "Git Repository Write Access", []string{"Engineering", "IT"}, 20},
		{"sec-production-ssh", "Production Server SSH Access", []string{"IT", "Engineering"}, 8},
		{"sec-monitoring", "Monitoring Dashboard Access", []string{"IT", "Engineering"}, 12},
		{"sec-backup-operators", "Backup System Operators", []string{"IT"}, 3},
		{"sec-cert-managers", "Certificate Management", []string{"IT"}, 3},
	}

	for _, sg := range secGroups {
		dn := fmt.Sprintf("cn=%s,ou=Security,ou=Groups,%s", sg.name, baseDN)
		sb.WriteString(fmt.Sprintf("dn: %s\n", dn))
		sb.WriteString("objectClass: groupOfNames\n")
		sb.WriteString(fmt.Sprintf("cn: %s\n", sg.name))
		sb.WriteString(fmt.Sprintf("description: %s\n", sg.desc))

		if sg.depts == nil {
			// Random sampling from all users
			perm := rng.Perm(len(users))
			for j := 0; j < sg.count && j < len(perm); j++ {
				sb.WriteString(fmt.Sprintf("member: %s\n", users[perm[j]].dn))
			}
		} else {
			added := 0
			for _, dept := range sg.depts {
				deptUsers := byDept[dept]
				perDept := sg.count / len(sg.depts)
				if perDept < 2 {
					perDept = 2
				}
				perm := rng.Perm(len(deptUsers))
				for j := 0; j < perDept && j < len(perm) && added < sg.count; j++ {
					sb.WriteString(fmt.Sprintf("member: %s\n", deptUsers[perm[j]].dn))
					added++
				}
			}
		}
		sb.WriteString("\n")
		groupCount++
	}

	// --- Nested groups (group as member of another group) ---
	// Make sec-git-write a member of role-developer
	sb.WriteString(fmt.Sprintf("dn: cn=role-all-access,ou=Roles,ou=Groups,%s\n", baseDN))
	sb.WriteString("objectClass: groupOfNames\n")
	sb.WriteString("cn: role-all-access\n")
	sb.WriteString("description: Full access role (contains nested groups)\n")
	sb.WriteString(fmt.Sprintf("member: cn=role-admin,ou=Roles,ou=Groups,%s\n", baseDN))
	sb.WriteString(fmt.Sprintf("member: cn=role-developer,ou=Roles,ou=Groups,%s\n", baseDN))
	sb.WriteString(fmt.Sprintf("member: cn=role-dba,ou=Roles,ou=Groups,%s\n", baseDN))
	sb.WriteString(fmt.Sprintf("member: %s\n", users[0].dn)) // at least one real member
	sb.WriteString("\n")
	groupCount++

	// Near-empty group (only 1 member)
	sb.WriteString(fmt.Sprintf("dn: cn=grp-legacy-system,ou=Security,ou=Groups,%s\n", baseDN))
	sb.WriteString("objectClass: groupOfNames\n")
	sb.WriteString("cn: grp-legacy-system\n")
	sb.WriteString("description: Legacy system access - pending decommission\n")
	sb.WriteString(fmt.Sprintf("member: %s\n", users[0].dn))
	sb.WriteString("\n")
	groupCount++

	// Another nested group
	sb.WriteString(fmt.Sprintf("dn: cn=sec-all-security,ou=Security,ou=Groups,%s\n", baseDN))
	sb.WriteString("objectClass: groupOfNames\n")
	sb.WriteString("cn: sec-all-security\n")
	sb.WriteString("description: All security groups combined (nested)\n")
	sb.WriteString(fmt.Sprintf("member: cn=sec-building-access,ou=Security,ou=Groups,%s\n", baseDN))
	sb.WriteString(fmt.Sprintf("member: cn=sec-server-room,ou=Security,ou=Groups,%s\n", baseDN))
	sb.WriteString(fmt.Sprintf("member: cn=sec-confidential,ou=Security,ou=Groups,%s\n", baseDN))
	sb.WriteString(fmt.Sprintf("member: cn=sec-git-write,ou=Security,ou=Groups,%s\n", baseDN))
	sb.WriteString(fmt.Sprintf("member: %s\n", users[1].dn))
	sb.WriteString("\n")
	groupCount++

	writeFile("seed/03-groups.ldif", sb.String())
	fmt.Printf("Generated %d groups in seed/03-groups.ldif\n", groupCount)
}

func writeServicesLDIF() {
	var sb strings.Builder
	entryCount := 0

	// --- Service accounts (applicationProcess) ---
	services := []struct {
		cn   string
		desc string
	}{
		{"svc-monitoring", "Nagios/Prometheus monitoring service account"},
		{"svc-backup", "Backup system service account"},
		{"svc-ci-runner", "CI/CD pipeline runner service account"},
		{"svc-deploy-bot", "Automated deployment service"},
		{"svc-ldap-sync", "LDAP directory synchronization service"},
		{"svc-mail-relay", "SMTP mail relay service account"},
		{"svc-sso-gateway", "Single Sign-On gateway service"},
		{"svc-log-collector", "Centralized log collection service"},
		{"svc-cert-manager", "TLS certificate management service"},
		{"svc-dns-updater", "Dynamic DNS update service"},
		{"svc-inventory", "IT asset inventory scanner"},
		{"svc-audit-logger", "Security audit logging service"},
		{"svc-api-gateway", "API gateway proxy service"},
		{"svc-redis-cache", "Redis cache connector service"},
		{"svc-kafka-consumer", "Kafka message consumer service"},
	}

	for _, svc := range services {
		sb.WriteString(fmt.Sprintf("dn: cn=%s,ou=Services,%s\n", svc.cn, baseDN))
		sb.WriteString("objectClass: applicationProcess\n")
		sb.WriteString("objectClass: top\n")
		sb.WriteString(fmt.Sprintf("cn: %s\n", svc.cn))
		sb.WriteString(fmt.Sprintf("description: %s\n", svc.desc))
		sb.WriteString("\n")
		entryCount++
	}

	// --- Device entries ---
	devices := []struct {
		cn   string
		desc string
		sn   string
	}{
		{"srv-web-01", "Primary web server", "Dell PowerEdge R740"},
		{"srv-web-02", "Secondary web server", "Dell PowerEdge R740"},
		{"srv-db-01", "Primary database server", "Dell PowerEdge R940"},
		{"srv-db-02", "Database replica server", "Dell PowerEdge R940"},
		{"srv-app-01", "Application server node 1", "HPE ProLiant DL380"},
		{"srv-app-02", "Application server node 2", "HPE ProLiant DL380"},
		{"srv-mail-01", "Mail server", "HPE ProLiant DL360"},
		{"srv-ldap-01", "LDAP directory server", "Dell PowerEdge R640"},
		{"srv-backup-01", "Backup storage server", "Synology RS4021xs+"},
		{"fw-edge-01", "Edge firewall", "Palo Alto PA-3260"},
		{"sw-core-01", "Core network switch", "Cisco Catalyst 9500"},
		{"sw-access-01", "Access layer switch floor 1", "Cisco Catalyst 9300"},
		{"sw-access-02", "Access layer switch floor 2", "Cisco Catalyst 9300"},
		{"ap-wifi-01", "Wireless access point lobby", "Cisco Meraki MR56"},
		{"ap-wifi-02", "Wireless access point floor 2", "Cisco Meraki MR56"},
	}

	for _, dev := range devices {
		sb.WriteString(fmt.Sprintf("dn: cn=%s,ou=Devices,%s\n", dev.cn, baseDN))
		sb.WriteString("objectClass: device\n")
		sb.WriteString("objectClass: top\n")
		sb.WriteString(fmt.Sprintf("cn: %s\n", dev.cn))
		sb.WriteString(fmt.Sprintf("description: %s\n", dev.desc))
		sb.WriteString(fmt.Sprintf("serialNumber: %s\n", dev.sn))
		sb.WriteString("\n")
		entryCount++
	}

	// --- Policy / organizational role entries ---
	policies := []struct {
		cn   string
		desc string
	}{
		{"policy-password", "Password policy: min 12 chars, complexity required, 90-day rotation"},
		{"policy-access-review", "Quarterly access review policy for all systems"},
		{"policy-data-retention", "Data retention policy: 7 years financial, 3 years operational"},
		{"policy-incident-response", "Security incident response procedure"},
		{"policy-acceptable-use", "IT acceptable use policy for all employees"},
	}

	for _, pol := range policies {
		sb.WriteString(fmt.Sprintf("dn: cn=%s,ou=Policies,%s\n", pol.cn, baseDN))
		sb.WriteString("objectClass: organizationalRole\n")
		sb.WriteString("objectClass: top\n")
		sb.WriteString(fmt.Sprintf("cn: %s\n", pol.cn))
		sb.WriteString(fmt.Sprintf("description: %s\n", pol.desc))
		sb.WriteString("\n")
		entryCount++
	}

	writeFile("seed/04-services.ldif", sb.String())
	fmt.Printf("Generated %d service/device/policy entries in seed/04-services.ldif\n", entryCount)
}

func writeExtendedLDIF() {
	var sb strings.Builder
	entryCount := 0

	// --- DN with special characters (comma in CN) ---
	sb.WriteString(fmt.Sprintf("dn: cn=Meier\\, Dr. Hans-Peter,ou=Management,ou=People,%s\n", baseDN))
	sb.WriteString("objectClass: inetOrgPerson\n")
	sb.WriteString("cn: Meier, Dr. Hans-Peter\n")
	sb.WriteString("givenName: Hans-Peter\n")
	sb.WriteString("sn: Meier\n")
	sb.WriteString("title: Chief Medical Officer (Advisory)\n")
	sb.WriteString("mail: hans-peter.meier@demo.ldapilot.local\n")
	sb.WriteString("uid: hans-peter.meier\n")
	sb.WriteString("employeeNumber: EMP90001\n")
	sb.WriteString("userPassword: hans-peter.meier\n")
	sb.WriteString("o: LDAPilot Demo GmbH\n")
	sb.WriteString("\n")
	entryCount++

	// --- DN with apostrophe ---
	sb.WriteString(fmt.Sprintf("dn: cn=Patrick O'Brien,ou=Contractors,ou=People,%s\n", baseDN))
	sb.WriteString("objectClass: inetOrgPerson\n")
	sb.WriteString("cn: Patrick O'Brien\n")
	sb.WriteString("givenName: Patrick\n")
	sb.WriteString("sn: O'Brien\n")
	sb.WriteString("title: External Security Consultant\n")
	sb.WriteString("mail: patrick.obrien@demo.ldapilot.local\n")
	sb.WriteString("uid: patrick.obrien\n")
	sb.WriteString("employeeNumber: EMP90002\n")
	sb.WriteString("userPassword: patrick.obrien\n")
	sb.WriteString("o: LDAPilot Demo GmbH\n")
	sb.WriteString("\n")
	entryCount++

	// --- DN with plus sign ---
	sb.WriteString(fmt.Sprintf("dn: cn=C++ Build Service,ou=Services,%s\n", baseDN))
	sb.WriteString("objectClass: applicationProcess\n")
	sb.WriteString("objectClass: top\n")
	sb.WriteString("cn: C++ Build Service\n")
	sb.WriteString("description: Build service for C++ projects\n")
	sb.WriteString("\n")
	entryCount++

	// --- Entry with very long description (1000+ characters) ---
	longDesc := "This entry represents the comprehensive data governance and compliance framework " +
		"that was established in Q3 2023 to address the increasing regulatory requirements " +
		"across multiple jurisdictions including GDPR (EU), BDSG (Germany), CCPA (California), " +
		"and various industry-specific standards such as ISO 27001, SOC 2 Type II, and PCI DSS. " +
		"The framework encompasses data classification policies (public, internal, confidential, " +
		"strictly confidential), data retention schedules aligned with legal hold requirements, " +
		"cross-border data transfer mechanisms including Standard Contractual Clauses (SCCs) and " +
		"Binding Corporate Rules (BCRs), incident response procedures with defined escalation paths " +
		"and notification timelines (72 hours for GDPR supervisory authority notification), " +
		"regular privacy impact assessments (PIAs/DPIAs) for new processing activities, " +
		"employee training programs on data protection awareness, vendor risk management " +
		"procedures including data processing agreements (DPAs) review, technical and " +
		"organizational measures (TOMs) documentation, records of processing activities (ROPA), " +
		"and annual compliance audits conducted by both internal audit teams and external " +
		"certified auditors. Contact the Data Protection Officer for questions."

	sb.WriteString(fmt.Sprintf("dn: cn=policy-data-governance,ou=Policies,%s\n", baseDN))
	sb.WriteString("objectClass: organizationalRole\n")
	sb.WriteString("objectClass: top\n")
	sb.WriteString("cn: policy-data-governance\n")
	sb.WriteString(fmt.Sprintf("description: %s\n", longDesc))
	sb.WriteString("\n")
	entryCount++

	// --- Entry with many objectClasses ---
	sb.WriteString(fmt.Sprintf("dn: cn=multi-class-test,ou=Services,%s\n", baseDN))
	sb.WriteString("objectClass: top\n")
	sb.WriteString("objectClass: applicationProcess\n")
	sb.WriteString("objectClass: labeledURIObject\n")
	sb.WriteString("cn: multi-class-test\n")
	sb.WriteString("description: Test entry with multiple objectClasses\n")
	sb.WriteString("labeledURI: https://ldapilot.example.com LDAPilot Homepage\n")
	sb.WriteString("labeledURI: https://docs.ldapilot.example.com Documentation\n")
	sb.WriteString("\n")
	entryCount++

	// --- Entries with UTF-8/German umlauts (base64 encoded) ---
	// "Juergen Muenchen-Gruenwald" with proper umlauts
	cnUmlaut := "J\u00fcrgen M\u00fcnchen-Gr\u00fcnwald"
	snUmlaut := "M\u00fcnchen-Gr\u00fcnwald"
	gnUmlaut := "J\u00fcrgen"
	titleUmlaut := "Gesch\u00e4ftsf\u00fchrer"
	descUmlaut := "Zust\u00e4ndig f\u00fcr \u00dcberpr\u00fcfung der Qualit\u00e4tssicherungsma\u00dfnahmen"

	sb.WriteString(fmt.Sprintf("dn: uid=juergen.muenchen,ou=Management,ou=People,%s\n", baseDN))
	sb.WriteString("objectClass: inetOrgPerson\n")
	sb.WriteString("uid: juergen.muenchen\n")
	sb.WriteString(fmt.Sprintf("cn:: %s\n", b64(cnUmlaut)))
	sb.WriteString(fmt.Sprintf("givenName:: %s\n", b64(gnUmlaut)))
	sb.WriteString(fmt.Sprintf("sn:: %s\n", b64(snUmlaut)))
	sb.WriteString(fmt.Sprintf("title:: %s\n", b64(titleUmlaut)))
	sb.WriteString(fmt.Sprintf("description:: %s\n", b64(descUmlaut)))
	sb.WriteString("mail: juergen.muenchen@demo.ldapilot.local\n")
	sb.WriteString("employeeNumber: EMP90003\n")
	sb.WriteString("userPassword: juergen.muenchen\n")
	sb.WriteString("o: LDAPilot Demo GmbH\n")
	sb.WriteString("\n")
	entryCount++

	// Another umlaut entry
	cn2 := "B\u00e4rbel Sch\u00f6nefeld"
	sn2 := "Sch\u00f6nefeld"
	gn2 := "B\u00e4rbel"
	title2 := "Leiterin f\u00fcr \u00d6ffentlichkeitsarbeit"

	sb.WriteString(fmt.Sprintf("dn: uid=baerbel.schoenefeld,ou=HR,ou=People,%s\n", baseDN))
	sb.WriteString("objectClass: inetOrgPerson\n")
	sb.WriteString("uid: baerbel.schoenefeld\n")
	sb.WriteString(fmt.Sprintf("cn:: %s\n", b64(cn2)))
	sb.WriteString(fmt.Sprintf("givenName:: %s\n", b64(gn2)))
	sb.WriteString(fmt.Sprintf("sn:: %s\n", b64(sn2)))
	sb.WriteString(fmt.Sprintf("title:: %s\n", b64(title2)))
	sb.WriteString("mail: baerbel.schoenefeld@demo.ldapilot.local\n")
	sb.WriteString("employeeNumber: EMP90004\n")
	sb.WriteString("userPassword: baerbel.schoenefeld\n")
	sb.WriteString("o: LDAPilot Demo GmbH\n")
	sb.WriteString("\n")
	entryCount++

	// Strasse with sharp-s
	cn3 := "Stra\u00dfe Test-Eintrag"
	desc3 := "Stra\u00dfenverzeichnis f\u00fcr Fu\u00dfg\u00e4ngerzonen"

	sb.WriteString(fmt.Sprintf("dn: cn=strasse-test,ou=Policies,%s\n", baseDN))
	sb.WriteString("objectClass: organizationalRole\n")
	sb.WriteString("objectClass: top\n")
	sb.WriteString(fmt.Sprintf("cn:: %s\n", b64(cn3)))
	sb.WriteString(fmt.Sprintf("description:: %s\n", b64(desc3)))
	sb.WriteString("\n")
	entryCount++

	// --- Entry with binary-like attribute (photo placeholder, base64) ---
	// Small placeholder "photo" (just a few bytes to simulate jpegPhoto)
	fakePhoto := make([]byte, 64)
	for i := range fakePhoto {
		fakePhoto[i] = byte(i)
	}
	sb.WriteString(fmt.Sprintf("dn: uid=photo.test,ou=IT,ou=People,%s\n", baseDN))
	sb.WriteString("objectClass: inetOrgPerson\n")
	sb.WriteString("uid: photo.test\n")
	sb.WriteString("cn: Photo Test User\n")
	sb.WriteString("givenName: Photo\n")
	sb.WriteString("sn: Test\n")
	sb.WriteString("mail: photo.test@demo.ldapilot.local\n")
	sb.WriteString("employeeNumber: EMP90005\n")
	sb.WriteString("userPassword: photo.test\n")
	sb.WriteString("title: Test User with Photo\n")
	sb.WriteString(fmt.Sprintf("jpegPhoto:: %s\n", base64.StdEncoding.EncodeToString(fakePhoto)))
	sb.WriteString("o: LDAPilot Demo GmbH\n")
	sb.WriteString("\n")
	entryCount++

	// --- Entry with many attribute values (multi-valued) ---
	sb.WriteString(fmt.Sprintf("dn: uid=multi.value,ou=Engineering,ou=People,%s\n", baseDN))
	sb.WriteString("objectClass: inetOrgPerson\n")
	sb.WriteString("uid: multi.value\n")
	sb.WriteString("cn: Multi Value Test\n")
	sb.WriteString("givenName: Multi\n")
	sb.WriteString("sn: Value\n")
	sb.WriteString("mail: multi.value@demo.ldapilot.local\n")
	sb.WriteString("mail: multi.value@secondary.example.com\n")
	sb.WriteString("mail: multi.value@tertiary.example.com\n")
	sb.WriteString("telephoneNumber: +49 30 1234567\n")
	sb.WriteString("telephoneNumber: +49 40 7654321\n")
	sb.WriteString("telephoneNumber: +49 89 1112233\n")
	sb.WriteString("mobile: +49 170 1234567\n")
	sb.WriteString("mobile: +49 171 7654321\n")
	sb.WriteString("description: User with many multi-valued attributes for testing\n")
	sb.WriteString("description: This is a second description value\n")
	sb.WriteString("description: And a third description value for good measure\n")
	sb.WriteString("employeeNumber: EMP90006\n")
	sb.WriteString("userPassword: multi.value\n")
	sb.WriteString("title: Multi-Value Test Engineer\n")
	sb.WriteString("o: LDAPilot Demo GmbH\n")
	sb.WriteString("ou: Engineering\n")
	sb.WriteString("ou: Research\n")
	sb.WriteString("ou: Special Projects\n")
	sb.WriteString("\n")
	entryCount++

	// --- Empty-ish entry (minimal attributes) ---
	sb.WriteString(fmt.Sprintf("dn: cn=minimal-entry,ou=Services,%s\n", baseDN))
	sb.WriteString("objectClass: applicationProcess\n")
	sb.WriteString("objectClass: top\n")
	sb.WriteString("cn: minimal-entry\n")
	sb.WriteString("\n")
	entryCount++

	// --- Entry with labeledURI ---
	sb.WriteString(fmt.Sprintf("dn: cn=web-links,ou=Policies,%s\n", baseDN))
	sb.WriteString("objectClass: organizationalRole\n")
	sb.WriteString("objectClass: labeledURIObject\n")
	sb.WriteString("objectClass: top\n")
	sb.WriteString("cn: web-links\n")
	sb.WriteString("description: Collection of important web links\n")
	sb.WriteString("labeledURI: https://intranet.demo.ldapilot.local Company Intranet\n")
	sb.WriteString("labeledURI: https://wiki.demo.ldapilot.local Internal Wiki\n")
	sb.WriteString("labeledURI: https://jira.demo.ldapilot.local Issue Tracker\n")
	sb.WriteString("labeledURI: https://git.demo.ldapilot.local Git Repository\n")
	sb.WriteString("\n")
	entryCount++

	writeFile("seed/05-extended.ldif", sb.String())
	fmt.Printf("Generated %d extended/edge-case entries in seed/05-extended.ldif\n", entryCount)
}

func b64(s string) string {
	return base64.StdEncoding.EncodeToString([]byte(s))
}

func writeFile(path string, content string) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "Error creating directory %s: %v\n", dir, err)
		os.Exit(1)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing %s: %v\n", path, err)
		os.Exit(1)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
