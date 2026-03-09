# LDAPilot: Container, Security, Batch, Schema - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set up OpenLDAP demo container with 300+ entries, fix security issues from CVE audit, add batch operations, and implement schema validation.

**Architecture:** 4 independent work streams. Docker container first (testing foundation), then security fixes (quick wins), schema validation (backend enhancement), and batch operations (new service + UI). Each stream touches different files with minimal overlap.

**Tech Stack:** Docker/docker-compose (osixia/openldap), Go (services layer), React/TypeScript (frontend), Wails v2 (binding layer)

---

## Task 1: OpenLDAP Docker Compose Setup

**Files:**
- Create: `docker/docker-compose.yml`

**Step 1: Create docker-compose.yml**

```yaml
version: '3.8'

services:
  openldap:
    image: osixia/openldap:1.5.0
    container_name: ldapilot-demo
    hostname: ldap.demo.ldapilot.local
    environment:
      LDAP_ORGANISATION: "LDAPilot Demo"
      LDAP_DOMAIN: "demo.ldapilot.local"
      LDAP_ADMIN_PASSWORD: "admin"
      LDAP_CONFIG_PASSWORD: "config"
      LDAP_READONLY_USER: "true"
      LDAP_READONLY_USER_USERNAME: "readonly"
      LDAP_READONLY_USER_PASSWORD: "readonly"
      LDAP_TLS: "true"
      LDAP_TLS_VERIFY_CLIENT: "never"
      LDAP_SEED_INTERNAL_LDIF_PATH: "/seed"
    ports:
      - "389:389"
      - "636:636"
    volumes:
      - ./seed:/seed:ro
      - ldap-data:/var/lib/ldap
      - ldap-config:/etc/ldap/slapd.d
    restart: unless-stopped

  phpldapadmin:
    image: osixia/phpldapadmin:0.9.0
    container_name: ldapilot-admin
    environment:
      PHPLDAPADMIN_LDAP_HOSTS: openldap
      PHPLDAPADMIN_HTTPS: "false"
    ports:
      - "8080:80"
    depends_on:
      - openldap
    profiles:
      - admin

volumes:
  ldap-data:
  ldap-config:
```

**Step 2: Verify docker-compose is valid**

Run: `cd docker && docker compose config --quiet && echo "OK"`
Expected: `OK`

**Step 3: Commit**

```bash
git add docker/docker-compose.yml
git commit -m "feat: add OpenLDAP docker-compose for demo environment"
```

---

## Task 2: LDIF Seed Data - Base Structure

**Files:**
- Create: `docker/seed/01-base.ldif`

**Step 1: Create base OU structure**

The file must create OUs under the auto-created `dc=demo,dc=ldapilot,dc=local` base. osixia/openldap seeds internal LDIFs AFTER the base DN is created, so we only need the sub-entries.

```ldif
# Top-level OUs
dn: ou=People,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: People
description: All user accounts

dn: ou=Groups,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Groups
description: All groups

dn: ou=Services,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Services
description: Service and application accounts

dn: ou=Devices,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Devices
description: Network devices and printers

dn: ou=Policies,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Policies
description: Directory policies

# Sub-OUs under People
dn: ou=Engineering,ou=People,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Engineering
description: Software Engineering department

dn: ou=Sales,ou=People,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Sales
description: Sales department

dn: ou=Management,ou=People,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Management
description: Executive management

dn: ou=HR,ou=People,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: HR
description: Human Resources

dn: ou=IT,ou=People,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: IT
description: IT Operations and Support

dn: ou=Finance,ou=People,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Finance
description: Finance and Accounting

dn: ou=Contractors,ou=People,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Contractors
description: External contractors and consultants

# Sub-OUs under Groups
dn: ou=Teams,ou=Groups,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Teams
description: Project and department teams

dn: ou=Roles,ou=Groups,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Roles
description: Role-based access groups

dn: ou=Distribution,ou=Groups,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Distribution
description: Email distribution lists

dn: ou=Security,ou=Groups,dc=demo,dc=ldapilot,dc=local
objectClass: organizationalUnit
ou: Security
description: Security and access control groups
```

**Step 2: Commit**

```bash
git add docker/seed/01-base.ldif
git commit -m "feat: add base OU structure for demo LDAP"
```

---

## Task 3: LDIF Seed Data - Users (200 entries)

**Files:**
- Create: `docker/seed/02-users.ldif`

**Step 1: Create users LDIF**

Generate ~200 inetOrgPerson entries across the 7 department OUs. Use a script or write them manually. Each user should have:

- `objectClass: inetOrgPerson`
- `cn`, `sn`, `givenName`, `displayName`
- `mail` (some with multiple)
- `telephoneNumber` (some with multiple)
- `title`, `employeeNumber`
- `manager` (reference to another user DN)
- `description` for some users
- Mix of German and international names
- Some with `posixAccount` overlay (add `objectClass: posixAccount`, `uidNumber`, `gidNumber`, `homeDirectory`, `loginShell`)
- ~60 in Engineering, ~40 Sales, ~15 Management, ~20 HR, ~30 IT, ~15 Finance, ~20 Contractors

Write a Go script to generate the LDIF file:

**Create**: `docker/generate-users.go`

```go
//go:build ignore

package main

import (
	"fmt"
	"math/rand"
	"os"
	"strings"
)

var firstNames = []string{
	"Anna", "Thomas", "Maria", "Stefan", "Julia", "Michael", "Sandra", "Andreas",
	"Claudia", "Martin", "Petra", "Christian", "Monika", "Markus", "Sabine",
	"Daniel", "Nicole", "Wolfgang", "Gabriele", "Patrick", "Katharina", "Frank",
	"Susanne", "Matthias", "Birgit", "Jens", "Andrea", "Tobias", "Kerstin",
	"Oliver", "Heike", "Alexander", "Stefanie", "Florian", "Christine", "Jan",
	"Anja", "Sebastian", "Martina", "Robert", "Lisa", "David", "Laura",
	"Felix", "Sarah", "Maximilian", "Jennifer", "Lucas", "Melanie", "Philipp",
	"Vanessa", "Henrik", "Franziska", "Nils", "Johanna", "Tim", "Elena",
	"Jonas", "Sophia", "Lukas", "Emma", "Paul", "Lena", "Leon",
	"Hannah", "Ben", "Mia", "Elias", "Charlotte", "Noah", "Amelie",
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
}

var titles = []string{
	"Software Engineer", "Senior Developer", "Team Lead", "Product Manager",
	"DevOps Engineer", "QA Engineer", "Data Scientist", "UX Designer",
	"System Administrator", "Network Engineer", "Security Analyst",
	"Sales Manager", "Account Executive", "Business Development",
	"HR Manager", "Recruiter", "Financial Analyst", "Controller",
	"Project Manager", "Scrum Master", "Technical Writer", "Architect",
}

type dept struct {
	ou    string
	count int
}

func main() {
	depts := []dept{
		{"Engineering", 60}, {"Sales", 40}, {"Management", 15},
		{"HR", 20}, {"IT", 30}, {"Finance", 15}, {"Contractors", 20},
	}

	f, _ := os.Create("seed/02-users.ldif")
	defer f.Close()

	uid := 10000
	userDNs := []string{}
	baseDN := "dc=demo,dc=ldapilot,dc=local"

	for _, d := range depts {
		for i := 0; i < d.count; i++ {
			first := firstNames[rand.Intn(len(firstNames))]
			last := lastNames[rand.Intn(len(lastNames))]
			username := strings.ToLower(fmt.Sprintf("%s.%s%d", first, last, uid-10000))
			dn := fmt.Sprintf("uid=%s,ou=%s,ou=People,%s", username, d.ou, baseDN)
			userDNs = append(userDNs, dn)
			email := fmt.Sprintf("%s@demo.ldapilot.local", username)
			title := titles[rand.Intn(len(titles))]
			phone := fmt.Sprintf("+49 30 %d", 1000000+rand.Intn(9000000))

			fmt.Fprintf(f, "dn: %s\n", dn)
			fmt.Fprintf(f, "objectClass: inetOrgPerson\n")
			if uid%5 == 0 {
				fmt.Fprintf(f, "objectClass: posixAccount\n")
				fmt.Fprintf(f, "uidNumber: %d\n", uid)
				fmt.Fprintf(f, "gidNumber: %d\n", 5000+rand.Intn(10))
				fmt.Fprintf(f, "homeDirectory: /home/%s\n", username)
				fmt.Fprintf(f, "loginShell: /bin/bash\n")
			}
			fmt.Fprintf(f, "uid: %s\n", username)
			fmt.Fprintf(f, "cn: %s %s\n", first, last)
			fmt.Fprintf(f, "sn: %s\n", last)
			fmt.Fprintf(f, "givenName: %s\n", first)
			fmt.Fprintf(f, "displayName: %s %s\n", first, last)
			fmt.Fprintf(f, "mail: %s\n", email)
			if rand.Intn(3) == 0 {
				fmt.Fprintf(f, "mail: %s.%s@private.example.com\n", strings.ToLower(first), strings.ToLower(last))
			}
			fmt.Fprintf(f, "telephoneNumber: %s\n", phone)
			if rand.Intn(4) == 0 {
				fmt.Fprintf(f, "telephoneNumber: +49 170 %d\n", 1000000+rand.Intn(9000000))
			}
			fmt.Fprintf(f, "title: %s\n", title)
			fmt.Fprintf(f, "employeeNumber: EMP%05d\n", uid-10000)
			fmt.Fprintf(f, "o: LDAPilot Demo GmbH\n")
			fmt.Fprintf(f, "ou: %s\n", d.ou)
			if len(userDNs) > 5 && rand.Intn(2) == 0 {
				fmt.Fprintf(f, "manager: %s\n", userDNs[rand.Intn(len(userDNs)-1)])
			}
			if rand.Intn(5) == 0 {
				fmt.Fprintf(f, "description: %s in %s department since %d\n", title, d.ou, 2015+rand.Intn(11))
			}
			fmt.Fprintf(f, "userPassword: {SSHA}demo\n")
			fmt.Fprintf(f, "\n")

			uid++
		}
	}

	fmt.Printf("Generated %d users\n", uid-10000)
}
```

**Step 2: Run generator**

Run: `cd docker && go run generate-users.go`
Expected: `Generated 200 users`

**Step 3: Verify LDIF count**

Run: `grep -c "^dn:" docker/seed/02-users.ldif`
Expected: `200`

**Step 4: Commit**

```bash
git add docker/seed/02-users.ldif docker/generate-users.go
git commit -m "feat: add 200 demo users for OpenLDAP container"
```

---

## Task 4: LDIF Seed Data - Groups, Services, Devices

**Files:**
- Create: `docker/seed/03-groups.ldif`
- Create: `docker/seed/04-services.ldif`

**Step 1: Create groups LDIF (~50 groups)**

Groups reference users created in Task 3. Use `groupOfNames` (requires at least one member). Create ~15 team groups, ~15 role groups, ~10 distribution, ~10 security groups. Include nested groups (group as member of another group).

Write these manually or extend the generator. Key patterns:
- Team groups: `cn=team-frontend,ou=Teams,...` with 5-15 members
- Role groups: `cn=role-admin,ou=Roles,...` with 3-10 members
- Nested: `cn=all-engineers,ou=Teams,...` containing other team groups as members
- Empty group edge case: one group with only the admin as member
- Large group: one group with 50+ members

**Step 2: Create services + devices LDIF (~35 entries)**

- ~15 service accounts (`objectClass: applicationProcess, inetOrgPerson`)
- ~15 device entries (`objectClass: device`)
- ~5 policy entries (`objectClass: organizationalRole`)

**Step 3: Commit**

```bash
git add docker/seed/03-groups.ldif docker/seed/04-services.ldif
git commit -m "feat: add groups, services, devices for demo LDAP"
```

---

## Task 5: LDIF Seed Data - Edge Cases

**Files:**
- Create: `docker/seed/05-extended.ldif`

**Step 1: Create edge case entries**

```ldif
# Entry with special characters in DN
dn: cn=O'Brien\, Patrick,ou=Engineering,ou=People,dc=demo,dc=ldapilot,dc=local
objectClass: inetOrgPerson
cn: O'Brien, Patrick
sn: O'Brien
givenName: Patrick
mail: patrick.obrien@demo.ldapilot.local
description: Tests DN with comma and apostrophe

# Entry with very long description
dn: uid=longdesc.user,ou=IT,ou=People,dc=demo,dc=ldapilot,dc=local
objectClass: inetOrgPerson
uid: longdesc.user
cn: Long Description User
sn: User
givenName: Long Description
mail: longdesc@demo.ldapilot.local
description: This is an extremely long description that spans well over one thousand characters to test how the application handles very long attribute values in the display and editing interfaces. It includes multiple sentences and various types of content to simulate real-world scenarios where administrators might paste lengthy notes, documentation references, or audit trail information into directory entries. The purpose is to verify that text wrapping, scrolling, truncation, and export functions all handle oversized attribute values correctly without causing UI glitches, performance issues, or data corruption during save operations.

# Entry with many objectClasses
dn: uid=multi.class,ou=IT,ou=People,dc=demo,dc=ldapilot,dc=local
objectClass: inetOrgPerson
objectClass: posixAccount
objectClass: shadowAccount
objectClass: ldapPublicKey
uid: multi.class
cn: Multi Class User
sn: Class
givenName: Multi
mail: multi.class@demo.ldapilot.local
uidNumber: 99999
gidNumber: 5000
homeDirectory: /home/multi.class
loginShell: /bin/zsh
shadowLastChange: 19000
shadowMax: 90
shadowWarning: 7

# Entry with UTF-8 (German umlauts)
dn: uid=mueller.juergen,ou=Management,ou=People,dc=demo,dc=ldapilot,dc=local
objectClass: inetOrgPerson
uid: mueller.juergen
cn:: SsO8cmdlbiBNw7xsbGVy
sn:: TcO8bGxlcg==
givenName:: SsO8cmdlbg==
mail: juergen.mueller@demo.ldapilot.local
description:: R2VzY2jDpGZ0c2bDvGhyZXIgLSBBYnRlaWx1bmcgRsO8aHJ1bmc=
title:: R2VzY2jDpGZ0c2bDvGhyZXI=
```

**Step 2: Commit**

```bash
git add docker/seed/05-extended.ldif
git commit -m "feat: add edge case entries (special chars, UTF-8, long values)"
```

---

## Task 6: Test Container Startup

**Step 1: Start container**

Run: `cd docker && docker compose up -d`
Expected: Container starts without errors

**Step 2: Verify LDAP connectivity**

Run: `ldapsearch -x -H ldap://localhost:389 -D "cn=admin,dc=demo,dc=ldapilot,dc=local" -w admin -b "dc=demo,dc=ldapilot,dc=local" "(objectClass=organizationalUnit)" dn | grep "^dn:" | wc -l`
Expected: 13 (all OUs)

**Step 3: Verify user count**

Run: `ldapsearch -x -H ldap://localhost:389 -D "cn=admin,dc=demo,dc=ldapilot,dc=local" -w admin -b "ou=People,dc=demo,dc=ldapilot,dc=local" "(objectClass=inetOrgPerson)" dn | grep "^dn:" | wc -l`
Expected: ~200

**Step 4: Verify total entry count**

Run: `ldapsearch -x -H ldap://localhost:389 -D "cn=admin,dc=demo,dc=ldapilot,dc=local" -w admin -b "dc=demo,dc=ldapilot,dc=local" "(objectClass=*)" dn | grep "^dn:" | wc -l`
Expected: 300+ entries

**Step 5: Add README for docker setup**

Create: `docker/README.md` with startup instructions

**Step 6: Commit**

```bash
git add docker/README.md
git commit -m "docs: add Docker demo environment README"
```

---

## Task 7: Security Fix - Export File Permissions

**Files:**
- Modify: `services/export_service.go:185,219`

**Step 1: Fix CSV export permissions**

In `services/export_service.go` line 185, change `0644` to `0600`:

```go
// Before:
return os.WriteFile(filePath, []byte(csvContent), 0644)
// After:
return os.WriteFile(filePath, []byte(csvContent), 0600)
```

**Step 2: Fix LDIF export permissions**

In `services/export_service.go` line 219, change `0644` to `0600`:

```go
// Before:
return os.WriteFile(filePath, []byte(ldifContent), 0644)
// After:
return os.WriteFile(filePath, []byte(ldifContent), 0600)
```

**Step 3: Verify with grep**

Run: `grep -n "0644" services/export_service.go`
Expected: No matches

**Step 4: Commit**

```bash
git add services/export_service.go
git commit -m "fix: use 0600 file permissions for LDIF/CSV exports"
```

---

## Task 8: Security Fix - Password Export Warning

**Files:**
- Modify: `services/connection_service.go` (ExportConnections method, ~line 201-248)

**Step 1: Add password warning dialog**

Before the export file dialog, check if any profile has a password and warn via Wails runtime:

```go
// In ExportConnections, after building the export list but before SaveFileDialog:
// Check if any profile has a password
hasPasswords := false
for _, p := range profiles {
    if p.Password != "" {
        hasPasswords = true
        break
    }
}

if hasPasswords {
    result, err := runtime.MessageDialog(s.ctx, runtime.MessageDialogOptions{
        Type:          runtime.WarningDialog,
        Title:         "Security Warning",
        Message:       "The export file will contain passwords in plaintext.\n\nStore the exported file securely and delete it after import.",
        Buttons:       []string{"Continue", "Cancel"},
        DefaultButton: "Cancel",
    })
    if err != nil || result == "Cancel" {
        return ""
    }
}
```

**Step 2: Verify compilation**

Run: `cd /home/dpicillo/git/LDAPilot && go build ./...`
Expected: No errors

**Step 3: Commit**

```bash
git add services/connection_service.go
git commit -m "fix: warn users when exporting connections with plaintext passwords"
```

---

## Task 9: Security Fix - TLS Skip-Verify Warning

**Files:**
- Modify: `frontend/src/components/connection/ConnectionDialog.tsx:218-228`

**Step 1: Add warning icon and tooltip**

In the TLS Skip Verify section (~line 218-228), add a visual warning when checked:

After the existing checkbox label, add a warning message that shows conditionally:

```tsx
{form.tlsSkipVerify && (
  <div className="flex items-center gap-1.5 mt-1 text-yellow-500 text-xs">
    <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
    </svg>
    <span>Certificate validation disabled - connection vulnerable to MITM attacks</span>
  </div>
)}
```

**Step 2: Verify frontend builds**

Run: `cd frontend && npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add frontend/src/components/connection/ConnectionDialog.tsx
git commit -m "fix: show TLS skip-verify security warning in connection dialog"
```

---

## Task 10: Schema Validation - Backend

**Files:**
- Modify: `services/schema_service.go` (add new methods after existing ones)
- Modify: `internal/models/connection.go` (add new types)

**Step 1: Add validation types to models**

In `internal/models/connection.go`, add at the end:

```go
// Schema validation types
type ObjectClassInfo struct {
	Name        string   `json:"name"`
	OID         string   `json:"oid"`
	Description string   `json:"description"`
	Superior    []string `json:"superior"`
	Must        []string `json:"must"`
	May         []string `json:"may"`
	Type        string   `json:"type"` // structural, auxiliary, abstract
}

type ValidationError struct {
	Attribute string `json:"attribute"`
	Message   string `json:"message"`
	Type      string `json:"type"` // missing_required, unknown_attribute, no_structural
}
```

**Step 2: Add GetObjectClassDetails to SchemaService**

In `services/schema_service.go`, add after the existing `GetObjectClass` method:

```go
func (s *SchemaService) GetObjectClassDetails(profileID, name string) (*models.ObjectClassInfo, error) {
	schema, err := s.GetSchema(profileID)
	if err != nil {
		return nil, err
	}

	for _, oc := range schema.ObjectClasses {
		if strings.EqualFold(oc.Name, name) {
			info := &models.ObjectClassInfo{
				Name:        oc.Name,
				OID:         oc.OID,
				Description: oc.Description,
				Must:        oc.Must,
				May:         oc.May,
				Superior:    oc.Superior,
			}
			// Determine type
			if oc.Structural {
				info.Type = "structural"
			} else if oc.Auxiliary {
				info.Type = "auxiliary"
			} else {
				info.Type = "abstract"
			}
			return info, nil
		}
	}
	return nil, fmt.Errorf("objectClass %s not found", name)
}

func (s *SchemaService) GetRequiredAttributes(profileID string, objectClasses []string) ([]string, error) {
	schema, err := s.GetSchema(profileID)
	if err != nil {
		return nil, err
	}

	mustSet := map[string]bool{}
	for _, ocName := range objectClasses {
		s.collectMustAttrs(schema, ocName, mustSet)
	}

	result := make([]string, 0, len(mustSet))
	for attr := range mustSet {
		result = append(result, attr)
	}
	sort.Strings(result)
	return result, nil
}

func (s *SchemaService) collectMustAttrs(schema *ldap.Schema, ocName string, mustSet map[string]bool) {
	for _, oc := range schema.ObjectClasses {
		if strings.EqualFold(oc.Name, ocName) {
			for _, m := range oc.Must {
				mustSet[m] = true
			}
			// Walk inheritance chain
			for _, sup := range oc.Superior {
				s.collectMustAttrs(schema, sup, mustSet)
			}
			return
		}
	}
}

func (s *SchemaService) ValidateEntry(profileID string, objectClasses []string, attributes map[string][]string) []models.ValidationError {
	var errors []models.ValidationError

	schema, err := s.GetSchema(profileID)
	if err != nil {
		errors = append(errors, models.ValidationError{
			Attribute: "",
			Message:   "Could not load schema: " + err.Error(),
			Type:      "schema_error",
		})
		return errors
	}

	// Check for at least one structural objectClass
	hasStructural := false
	for _, ocName := range objectClasses {
		for _, oc := range schema.ObjectClasses {
			if strings.EqualFold(oc.Name, ocName) && oc.Structural {
				hasStructural = true
				break
			}
		}
	}
	if !hasStructural {
		errors = append(errors, models.ValidationError{
			Attribute: "objectClass",
			Message:   "At least one structural objectClass is required",
			Type:      "no_structural",
		})
	}

	// Collect all MUST attributes
	mustSet := map[string]bool{}
	for _, ocName := range objectClasses {
		s.collectMustAttrs(schema, ocName, mustSet)
	}

	// Check MUST attributes are present with non-empty values
	for attr := range mustSet {
		if strings.EqualFold(attr, "objectClass") {
			continue // objectClass itself is always present
		}
		vals, exists := attributes[attr]
		if !exists || len(vals) == 0 || (len(vals) == 1 && vals[0] == "") {
			// Check case-insensitive
			found := false
			for k, v := range attributes {
				if strings.EqualFold(k, attr) && len(v) > 0 && v[0] != "" {
					found = true
					break
				}
			}
			if !found {
				errors = append(errors, models.ValidationError{
					Attribute: attr,
					Message:   fmt.Sprintf("Required attribute '%s' is missing or empty", attr),
					Type:      "missing_required",
				})
			}
		}
	}

	return errors
}
```

**Step 3: Add imports**

Add `"fmt"`, `"sort"`, `"strings"` to the import block of `schema_service.go` if not present.

**Step 4: Verify compilation**

Run: `go build ./...`
Expected: No errors

**Step 5: Commit**

```bash
git add services/schema_service.go internal/models/connection.go
git commit -m "feat: add schema validation with MUST attribute checks"
```

---

## Task 11: Schema Validation - Frontend Wails Bindings

**Files:**
- Modify: `frontend/src/lib/wails.ts` (add new schema methods)
- Modify: `frontend/src/types/ldap.ts` (add validation types)

**Step 1: Add TypeScript types**

In `frontend/src/types/ldap.ts`, add:

```typescript
export interface ObjectClassInfo {
  name: string;
  oid: string;
  description: string;
  superior: string[];
  must: string[];
  may: string[];
  type: string; // structural, auxiliary, abstract
}

export interface ValidationError {
  attribute: string;
  message: string;
  type: string; // missing_required, unknown_attribute, no_structural
}
```

**Step 2: Add wails bindings**

In `frontend/src/lib/wails.ts`, add in the SchemaService section:

```typescript
GetObjectClassDetails: async (profileID: string, name: string): Promise<ObjectClassInfo | null> => {
  const svc = getBinding('SchemaService');
  if (svc?.GetObjectClassDetails) return svc.GetObjectClassDetails(profileID, name);
  return null;
},

GetRequiredAttributes: async (profileID: string, objectClasses: string[]): Promise<string[]> => {
  const svc = getBinding('SchemaService');
  if (svc?.GetRequiredAttributes) return svc.GetRequiredAttributes(profileID, objectClasses);
  return [];
},

ValidateEntry: async (profileID: string, objectClasses: string[], attributes: Record<string, string[]>): Promise<ValidationError[]> => {
  const svc = getBinding('SchemaService');
  if (svc?.ValidateEntry) return svc.ValidateEntry(profileID, objectClasses, attributes);
  return [];
},
```

**Step 3: Commit**

```bash
git add frontend/src/lib/wails.ts frontend/src/types/ldap.ts
git commit -m "feat: add schema validation wails bindings and types"
```

---

## Task 12: Schema Validation - Frontend Integration

**Files:**
- Modify: `frontend/src/components/editor/NewEntryDialog.tsx`
- Modify: `frontend/src/components/editor/EditEntryDialog.tsx`

**Step 1: Add validation to NewEntryDialog**

In the submit handler (`handleCreate`, ~line 79), add validation call before `CreateEntry`:

```typescript
// Before the CreateEntry call, add:
const validationAttrs: Record<string, string[]> = {};
for (const attr of attributes) {
  validationAttrs[attr.name] = attr.values;
}
const validationErrors = await wails.ValidateEntry(activeProfileId, objectClasses, validationAttrs);
if (validationErrors && validationErrors.length > 0) {
  setErrors(validationErrors); // Need to add state: const [errors, setErrors] = useState<ValidationError[]>([]);
  return;
}
```

Add error display in the JSX, showing validation errors above the submit button:

```tsx
{errors.length > 0 && (
  <div className="bg-red-500/10 border border-red-500/30 rounded p-2 text-xs text-red-400 space-y-1">
    {errors.map((e, i) => (
      <div key={i}>
        <span className="font-medium">{e.attribute}:</span> {e.message}
      </div>
    ))}
  </div>
)}
```

**Step 2: Add required attribute indicators**

When objectClass changes, fetch required attributes and mark them with a red asterisk in the attribute name column.

**Step 3: Similarly update EditEntryDialog**

Add validation call before the save operations in `handleSave` (~line 335).

**Step 4: Verify frontend builds**

Run: `cd frontend && npm run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add frontend/src/components/editor/NewEntryDialog.tsx frontend/src/components/editor/EditEntryDialog.tsx
git commit -m "feat: integrate schema validation in entry dialogs"
```

---

## Task 13: Batch Operations - Backend Service

**Files:**
- Create: `services/batch_service.go`
- Modify: `main.go:45-53,87-97` (register service)

**Step 1: Create BatchService**

```go
package services

import (
	"context"
	"fmt"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type BatchService struct {
	ctx    context.Context
	pool   *ldap.Pool
	logger *LogService
}

func NewBatchService(pool *ldap.Pool, logger *LogService) *BatchService {
	return &BatchService{pool: pool, logger: logger}
}

func (s *BatchService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

type BatchResult struct {
	Total     int          `json:"total"`
	Succeeded int          `json:"succeeded"`
	Failed    int          `json:"failed"`
	Errors    []BatchError `json:"errors"`
}

type BatchError struct {
	DN      string `json:"dn"`
	Message string `json:"message"`
}

type BatchModifyChange struct {
	Operation string   `json:"operation"` // add, replace, delete
	Attribute string   `json:"attribute"`
	Values    []string `json:"values"`
}

func (s *BatchService) BatchDelete(profileID string, dns []string) BatchResult {
	result := BatchResult{Total: len(dns)}

	client, err := s.pool.Get(profileID)
	if err != nil {
		result.Failed = len(dns)
		for _, dn := range dns {
			result.Errors = append(result.Errors, BatchError{DN: dn, Message: err.Error()})
		}
		return result
	}

	// Delete in reverse order (children first)
	for i := len(dns) - 1; i >= 0; i-- {
		dn := dns[i]
		wailsRuntime.EventsEmit(s.ctx, "batch:progress", map[string]interface{}{
			"current":   result.Total - i,
			"total":     result.Total,
			"currentDN": dn,
			"operation": "delete",
		})

		if err := client.DeleteEntry(dn); err != nil {
			result.Failed++
			result.Errors = append(result.Errors, BatchError{DN: dn, Message: err.Error()})
		} else {
			result.Succeeded++
		}
	}

	return result
}

func (s *BatchService) BatchModify(profileID string, dns []string, changes []BatchModifyChange) BatchResult {
	result := BatchResult{Total: len(dns)}

	client, err := s.pool.Get(profileID)
	if err != nil {
		result.Failed = len(dns)
		for _, dn := range dns {
			result.Errors = append(result.Errors, BatchError{DN: dn, Message: err.Error()})
		}
		return result
	}

	for i, dn := range dns {
		wailsRuntime.EventsEmit(s.ctx, "batch:progress", map[string]interface{}{
			"current":   i + 1,
			"total":     result.Total,
			"currentDN": dn,
			"operation": "modify",
		})

		var entryErr error
		for _, change := range changes {
			switch change.Operation {
			case "add":
				entryErr = client.AddAttribute(dn, change.Attribute, change.Values)
			case "replace":
				entryErr = client.ModifyAttribute(dn, change.Attribute, change.Values)
			case "delete":
				entryErr = client.DeleteAttribute(dn, change.Attribute)
			default:
				entryErr = fmt.Errorf("unknown operation: %s", change.Operation)
			}
			if entryErr != nil {
				break
			}
		}

		if entryErr != nil {
			result.Failed++
			result.Errors = append(result.Errors, BatchError{DN: dn, Message: entryErr.Error()})
		} else {
			result.Succeeded++
		}
	}

	return result
}

func (s *BatchService) BatchMove(profileID string, dns []string, newParentDN string) BatchResult {
	result := BatchResult{Total: len(dns)}

	client, err := s.pool.Get(profileID)
	if err != nil {
		result.Failed = len(dns)
		for _, dn := range dns {
			result.Errors = append(result.Errors, BatchError{DN: dn, Message: err.Error()})
		}
		return result
	}

	for i, dn := range dns {
		wailsRuntime.EventsEmit(s.ctx, "batch:progress", map[string]interface{}{
			"current":   i + 1,
			"total":     result.Total,
			"currentDN": dn,
			"operation": "move",
		})

		// Extract RDN from DN
		parts := splitDN(dn)
		if len(parts) == 0 {
			result.Failed++
			result.Errors = append(result.Errors, BatchError{DN: dn, Message: "invalid DN"})
			continue
		}
		rdn := parts[0]

		if err := client.RenameEntry(dn, rdn, newParentDN, true); err != nil {
			result.Failed++
			result.Errors = append(result.Errors, BatchError{DN: dn, Message: err.Error()})
		} else {
			result.Succeeded++
		}
	}

	return result
}

// splitDN splits a DN into its RDN components
func splitDN(dn string) []string {
	var parts []string
	var current string
	escaped := false
	for _, c := range dn {
		if escaped {
			current += string(c)
			escaped = false
			continue
		}
		if c == '\\' {
			current += string(c)
			escaped = true
			continue
		}
		if c == ',' {
			parts = append(parts, current)
			current = ""
			continue
		}
		current += string(c)
	}
	if current != "" {
		parts = append(parts, current)
	}
	return parts
}
```

**Step 2: Register in main.go**

Add to service creation block (~line 45-53):
```go
batchService := services.NewBatchService(pool, logService)
```

Add to `OnStartup` context setters:
```go
batchService.SetContext(ctx)
```

Add to Bind list (~line 87-97):
```go
batchService,
```

**Step 3: Verify compilation**

Run: `go build ./...`
Expected: No errors

**Step 4: Commit**

```bash
git add services/batch_service.go main.go
git commit -m "feat: add BatchService with delete, modify, move operations"
```

---

## Task 14: Batch Operations - Frontend Bindings & Types

**Files:**
- Modify: `frontend/src/types/ldap.ts`
- Modify: `frontend/src/lib/wails.ts`

**Step 1: Add batch types**

In `frontend/src/types/ldap.ts`:

```typescript
export interface BatchResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: BatchError[];
}

export interface BatchError {
  dn: string;
  message: string;
}

export interface BatchModifyChange {
  operation: 'add' | 'replace' | 'delete';
  attribute: string;
  values: string[];
}
```

**Step 2: Add wails bindings**

In `frontend/src/lib/wails.ts`, add BatchService section:

```typescript
// --- BatchService ---
BatchDelete: async (profileID: string, dns: string[]): Promise<BatchResult> => {
  const svc = getBinding('BatchService');
  if (svc?.BatchDelete) return svc.BatchDelete(profileID, dns);
  return { total: 0, succeeded: 0, failed: 0, errors: [] };
},

BatchModify: async (profileID: string, dns: string[], changes: BatchModifyChange[]): Promise<BatchResult> => {
  const svc = getBinding('BatchService');
  if (svc?.BatchModify) return svc.BatchModify(profileID, dns, changes);
  return { total: 0, succeeded: 0, failed: 0, errors: [] };
},

BatchMove: async (profileID: string, dns: string[], newParentDN: string): Promise<BatchResult> => {
  const svc = getBinding('BatchService');
  if (svc?.BatchMove) return svc.BatchMove(profileID, dns, newParentDN);
  return { total: 0, succeeded: 0, failed: 0, errors: [] };
},
```

**Step 3: Commit**

```bash
git add frontend/src/types/ldap.ts frontend/src/lib/wails.ts
git commit -m "feat: add batch operation frontend bindings and types"
```

---

## Task 15: Batch Operations - BatchOperationDialog Component

**Files:**
- Create: `frontend/src/components/editor/BatchOperationDialog.tsx`

**Step 1: Create the dialog component**

Build a dialog with 3 tabs (Delete, Modify, Move):
- Delete tab: Shows list of selected DNs, confirm button
- Modify tab: Attribute name input + value input + operation dropdown (Add/Replace/Delete)
- Move tab: Target parent DN input (text field)
- Progress section: Progress bar with current/total counter and current DN
- Result section: Green/red success/failure count + expandable error list
- Cancel button that works during operation (sets a ref flag)

Listen for `batch:progress` Wails events to update the progress bar.

Key patterns from the existing codebase:
- Dialog styling: Follow `EditEntryDialog.tsx` pattern (dark theme, rounded borders)
- Wails events: `import { EventsOn, EventsOff } from '@wailsio/runtime'` or use window runtime
- State management: Local useState, not Zustand (dialog-scoped state)

**Step 2: Verify frontend builds**

Run: `cd frontend && npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add frontend/src/components/editor/BatchOperationDialog.tsx
git commit -m "feat: add BatchOperationDialog with delete, modify, move tabs"
```

---

## Task 16: Batch Operations - Tree Context Menu Integration

**Files:**
- Modify: `frontend/src/components/tree/TreeContextMenu.tsx:68-73`

**Step 1: Add batch operations to multi-select context menu**

In the batch menu section (~lines 68-73), add entries for Batch Modify and Batch Move, and wire the existing Delete to use the batch dialog:

```typescript
// In the multi-select menu items array, add:
{ label: 'Batch Modify...', icon: 'edit', action: () => onBatchOperation?.('modify') },
{ label: 'Batch Move...', icon: 'move', action: () => onBatchOperation?.('move') },
```

Add `onBatchOperation` prop to the component interface.

**Step 2: Wire up in DirectoryTree**

In `DirectoryTree.tsx`, add state for batch dialog and pass the callback:

```typescript
const [batchMode, setBatchMode] = useState<'delete' | 'modify' | 'move' | null>(null);
```

Open `BatchOperationDialog` when batchMode is set.

**Step 3: Verify frontend builds and commit**

```bash
git add frontend/src/components/tree/TreeContextMenu.tsx frontend/src/components/tree/DirectoryTree.tsx
git commit -m "feat: integrate batch operations into tree context menu"
```

---

## Task 17: Final Integration Test

**Step 1: Start the demo container**

Run: `cd docker && docker compose up -d`

**Step 2: Start the app**

Run: `wails dev -s -tags webkit2_41`

**Step 3: Manual verification checklist**

- [ ] Connect to demo LDAP (localhost:389, admin/admin)
- [ ] Browse tree - verify 300+ entries load
- [ ] Test edge case entries (special chars, UTF-8)
- [ ] Export LDIF - verify file has 0600 permissions
- [ ] Export connections with password - verify warning dialog appears
- [ ] Test TLS skip-verify warning in connection dialog
- [ ] Create new entry - verify required attributes are marked
- [ ] Try to create entry missing required attrs - verify validation error
- [ ] Multi-select entries - right-click - verify batch operations menu
- [ ] Batch delete 2-3 test entries - verify progress + result
- [ ] Batch modify (add description) on 2-3 entries - verify

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete demo container, security fixes, batch ops, schema validation"
```

---

## Implementation Order Summary

| Task | Area | Estimated Complexity |
|------|------|---------------------|
| 1-6 | Docker Container + Seed Data | Medium |
| 7-9 | Security Fixes | Low |
| 10-12 | Schema Validation | Medium |
| 13-16 | Batch Operations | High |
| 17 | Integration Test | Low |

**Dependencies:**
- Tasks 1-6 are independent (container setup)
- Tasks 7-9 are independent (security fixes)
- Tasks 10-12 are sequential (backend → bindings → frontend)
- Tasks 13-16 are sequential (backend → bindings → dialog → integration)
- Task 17 depends on all others
