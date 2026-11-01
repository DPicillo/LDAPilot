#!/usr/bin/env python3
"""Generates LDIF seed data for the LDAPilot Samba AD test domain.

Usage: seed.py <base-dn> <output-dir>

Writes numbered LDIF files that seed.sh imports in order with ldbadd/ldbmodify.
The data is deterministic (fixed random seed) so every fresh container looks
the same, and it deliberately contains edge cases an AD admin tool must cope
with: umlauts and escaped characters in DNs, every userAccountControl state,
all group scopes/types, nested and circular group membership, deep OU trees,
more objects than one LDAP page (1000) and a few binary attributes.
"""
import base64
import os
import random
import sys
import time

BASE = sys.argv[1]
OUT = sys.argv[2]
DNS = ".".join(p.split("=", 1)[1] for p in BASE.split(",")).lower()
PASSWORD = os.environ.get("SEED_USER_PASSWORD", "Passw0rd!2026")
PHOTO = "/usr/local/share/ldapilot/photo.jpg"
ROOT = "OU=LDAPilot," + BASE
COMPANY = "LDAPilot Lab GmbH"
NOW = int(time.time())
rnd = random.Random(42)

# userAccountControl flags
UF_ACCOUNTDISABLE = 0x2
UF_NORMAL_ACCOUNT = 0x200
UF_WORKSTATION_TRUST_ACCOUNT = 0x1000
UF_DONT_EXPIRE_PASSWD = 0x10000
UF_SMARTCARD_REQUIRED = 0x40000
UF_TRUSTED_FOR_DELEGATION = 0x80000
UF_NOT_DELEGATED = 0x100000
UF_DONT_REQUIRE_PREAUTH = 0x400000
UF_TRUSTED_TO_AUTH_FOR_DELEGATION = 0x1000000

# groupType values
GLOBAL_SEC = -2147483646
DOMAIN_LOCAL_SEC = -2147483644
UNIVERSAL_SEC = -2147483640
GLOBAL_DIST = 2
DOMAIN_LOCAL_DIST = 4
UNIVERSAL_DIST = 8

TRANSLIT = str.maketrans({
    "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue",
    "é": "e", "è": "e", "ë": "e", "ç": "c", "ı": "i", "ğ": "g", "ş": "s",
    "ł": "l", "ó": "o", "á": "a", "ñ": "n", "ø": "o", "å": "a",
})


def filetime(unix_seconds):
    return (int(unix_seconds) + 11644473600) * 10_000_000


def unicode_pwd(pw):
    return ('"%s"' % pw).encode("utf-16-le")


def ldif_line(key, value):
    if isinstance(value, bytes):
        return "%s:: %s" % (key, base64.b64encode(value).decode())
    value = str(value)
    if (not value.isascii()) or value[:1] in (" ", ":", "<") or value.endswith(" ") or "\n" in value:
        return "%s:: %s" % (key, base64.b64encode(value.encode()).decode())
    return "%s: %s" % (key, value)


class Ldif:
    def __init__(self, name):
        self.path = os.path.join(OUT, name)
        self.chunks = []

    def add(self, dn, attrs):
        lines = [ldif_line("dn", dn)]
        for key, value in attrs:
            if value is None or value == "" or value == []:
                continue
            for v in value if isinstance(value, (list, tuple)) else [value]:
                lines.append(ldif_line(key, v))
        self.chunks.append("\n".join(lines) + "\n")

    def modify(self, dn, op, attr, values):
        lines = [ldif_line("dn", dn), "changetype: modify", "%s: %s" % (op, attr)]
        lines += [ldif_line(attr, v) for v in values]
        lines.append("-")
        self.chunks.append("\n".join(lines) + "\n")

    def write(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("\n".join(self.chunks))


def esc_rdn(value):
    """Escapes an RDN value per RFC 4514."""
    out = ""
    for i, ch in enumerate(value):
        if ch in ',+"\\<>;=' or (i == 0 and ch in "# ") or (i == len(value) - 1 and ch == " "):
            out += "\\" + ch
        else:
            out += ch
    return out


def ou_dn(*path):
    """ou_dn("Users", "Berlin") -> OU=Berlin,OU=Users,OU=LDAPilot,<base>"""
    return ",".join("OU=" + esc_rdn(p) for p in reversed(path)) + "," + ROOT


# --- OUs ---------------------------------------------------------------------

CITIES = [
    # name, state, zip, street, phone prefix
    ("Berlin", "BE", "10117", "Unter den Linden 1", "+49 30 4000"),
    ("Hamburg", "HH", "20095", "Mönckebergstraße 7", "+49 40 5000"),
    ("München", "BY", "80331", "Marienplatz 8", "+49 89 6000"),
    ("Köln", "NW", "50667", "Domkloster 4", "+49 221 7000"),
]

ous = Ldif("10-ous.ldif")
ous.add(ROOT, [("objectClass", "organizationalUnit"), ("description", "LDAPilot test data root")])
OU_TREE = [
    (("Users",), "Employees grouped by location"),
    *[(("Users", c[0]), "Employees in %s" % c[0]) for c in CITIES],
    (("Groups",), "All groups"),
    (("Groups", "Departments"), "Global security groups per department"),
    (("Groups", "Locations"), "Global security groups per location"),
    (("Groups", "Resources"), "Domain local groups for resource permissions (AGDLP)"),
    (("Groups", "Distribution"), "Mail distribution lists"),
    (("Groups", "Admin"), "Administrative and test groups"),
    (("Service Accounts",), "Service and application accounts"),
    (("Computers",), "Domain joined machines"),
    (("Computers", "Workstations"), "Desktop PCs"),
    (("Computers", "Laptops"), "Notebooks"),
    (("Computers", "Servers"), "Member servers"),
    (("Contacts",), "External contacts"),
    (("Disabled Users",), "Former employees, disabled accounts"),
    (("Special Cases",), "Accounts covering every userAccountControl / naming edge case"),
    (("Bulk",), "1500 contacts to exercise paged searches (> MaxPageSize 1000)"),
    (("Empty OU",), "Intentionally empty"),
    (("Deep Structure",), "8 nested OUs with a user at the bottom"),
]
for path, desc in OU_TREE:
    ous.add(ou_dn(*path), [("objectClass", "organizationalUnit"), ("description", desc)])
deep = ["Deep Structure"]
for level in range(1, 9):
    deep.append("Level %d" % level)
    ous.add(ou_dn(*deep), [("objectClass", "organizationalUnit"), ("description", "Nesting level %d" % level)])
ous.write()

# --- Users -------------------------------------------------------------------

FIRST = ["Anna", "Lukas", "Sophie", "Jonas", "Marie", "Felix", "Lea", "Paul", "Emma", "Leon",
         "Mia", "Maximilian", "Hannah", "Noah", "Lena", "Elias", "Laura", "Finn", "Julia", "Ben",
         "Sarah", "Tim", "Johanna", "Jan", "Nina", "Moritz", "Clara", "Tobias", "Jürgen", "Björn",
         "Özlem", "Mehmet", "Ana", "Luis", "Chen", "Priya", "Olaf", "Søren", "Zoë", "René"]
LAST = ["Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner", "Becker",
        "Schulz", "Hoffmann", "Schäfer", "Koch", "Bauer", "Richter", "Klein", "Wolf", "Schröder",
        "Neumann", "Schwarz", "Braun", "Krüger", "Hartmann", "Lange", "Werner", "Krause",
        "Lehmann", "Köhler", "Weiß", "Yılmaz", "Kowalski", "Rossi", "Nguyen", "García", "Jensen"]
DEPTS = {
    "IT": ["System Administrator", "Network Engineer", "IT Support Specialist", "Security Analyst", "Cloud Architect"],
    "Engineering": ["Software Engineer", "Senior Software Engineer", "QA Engineer", "DevOps Engineer", "Product Owner"],
    "Sales": ["Account Manager", "Sales Representative", "Key Account Manager", "Inside Sales"],
    "Marketing": ["Marketing Manager", "Content Creator", "SEO Specialist", "Brand Manager"],
    "Finance": ["Accountant", "Controller", "Payroll Specialist", "Financial Analyst"],
    "HR": ["HR Business Partner", "Recruiter", "Training Coordinator"],
}
PER_DEPT = {"IT": 12, "Engineering": 16, "Sales": 12, "Marketing": 8, "Finance": 8, "HR": 6}

users_ldif = Ldif("20-users.ldif")
used_sams = set()
users = []  # dicts: dn, sam, dept, city, head
employee_no = [1000]


def make_sam(first, last):
    base = ("%s.%s" % (first, last)).translate(TRANSLIT).lower().replace(" ", "")
    base = "".join(ch for ch in base if ch.isascii())[:20]
    sam, n = base, 2
    while sam in used_sams:
        suffix = str(n)
        sam, n = base[: 20 - len(suffix)] + suffix, n + 1
    used_sams.add(sam)
    return sam


def add_user(ldif, first, last, ou, *, title="", dept="", city=None, manager=None, uac=UF_NORMAL_ACCOUNT,
             cn=None, sam=None, description=None, extra=(), password=PASSWORD):
    sam = sam or make_sam(first, last)
    used_sams.add(sam)
    cn = cn or ("%s %s" % (first, last)).strip()
    dn = "CN=%s,%s" % (esc_rdn(cn), ou)
    employee_no[0] += 1
    attrs = [
        ("objectClass", "user"),
        ("cn", cn),
        ("givenName", first),
        ("sn", last),
        ("displayName", cn),
        ("sAMAccountName", sam),
        ("userPrincipalName", "%s@%s" % (sam, DNS)),
        ("mail", "%s@%s" % (sam, DNS)),
        ("title", title),
        ("department", dept),
        ("company", COMPANY if dept else ""),
        ("employeeID", "E%05d" % employee_no[0] if dept else ""),
        ("description", description if description is not None else (title and "%s, %s" % (title, dept))),
        ("manager", manager),
        ("userAccountControl", uac),
        ("unicodePwd", unicode_pwd(password)),
    ]
    if city:
        name, state, zipc, street, phone = city
        attrs += [
            ("physicalDeliveryOfficeName", name), ("l", name), ("st", state), ("postalCode", zipc),
            ("streetAddress", street), ("c", "DE"), ("co", "Germany"), ("countryCode", 276),
            ("telephoneNumber", "%s-%03d" % (phone, employee_no[0] % 1000)),
            ("mobile", "+49 15%d %07d" % (rnd.randint(1, 9), rnd.randint(0, 9999999))),
        ]
    attrs += list(extra)
    ldif.add(dn, attrs)
    user = {"dn": dn, "sam": sam, "dept": dept, "city": city[0] if city else None, "uac": uac}
    users.append(user)
    return user


ceo = add_user(users_ldif, "Katharina", "Zimmermann", ou_dn("Users", "Berlin"), title="Chief Executive Officer",
               dept="Management", city=CITIES[0])
cto = add_user(users_ldif, "Florian", "Hofmann", ou_dn("Users", "München"), title="Chief Technology Officer",
               dept="Management", city=CITIES[2], manager=ceo["dn"])
cfo = add_user(users_ldif, "Sabine", "Lorenz", ou_dn("Users", "Hamburg"), title="Chief Financial Officer",
               dept="Management", city=CITIES[1], manager=ceo["dn"])
heads = {}
for dept, titles in DEPTS.items():
    boss = cto if dept in ("IT", "Engineering") else (cfo if dept == "Finance" else ceo)
    city = CITIES[len(heads) % len(CITIES)]
    first, last = rnd.choice(FIRST), rnd.choice(LAST)
    heads[dept] = add_user(users_ldif, first, last, ou_dn("Users", city[0]), title="Head of %s" % dept,
                           dept=dept, city=city, manager=boss["dn"])
    for i in range(PER_DEPT[dept]):
        city = CITIES[rnd.randrange(len(CITIES))]
        first, last = rnd.choice(FIRST), rnd.choice(LAST)
        sam = make_sam(first, last)
        extra = []
        if dept in ("IT", "Engineering"):  # RFC2307 attributes for Linux logins
            extra = [("uidNumber", 10000 + len(users)), ("gidNumber", 10000),
                     ("unixHomeDirectory", "/home/%s" % sam), ("loginShell", "/bin/bash")]
        add_user(users_ldif, first, last, ou_dn("Users", city[0]), title=titles[i % len(titles)], dept=dept,
                 city=city, manager=heads[dept]["dn"], sam=sam, extra=extra)

# IT administrator account (added to Domain Admins by seed.sh)
it_admin = add_user(users_ldif, "Admin", "Mertens", ou_dn("Service Accounts"), cn="Admin Mertens (Tier 0)",
                    sam="adm.mertens", title="Domain Administrator", dept="IT",
                    description="Personal admin account, member of Domain Admins")

# Former employees
for first, last, left in [("Gerhard", "Vogel", "2023-06-30"), ("Ingrid", "Sommer", "2024-02-29"),
                          ("Dieter", "Brandt", "2025-09-15"), ("Ulrike", "Fuchs", "2026-01-31")]:
    add_user(users_ldif, first, last, ou_dn("Disabled Users"), title="Former employee", dept="",
             uac=UF_NORMAL_ACCOUNT | UF_ACCOUNTDISABLE, description="Left the company on %s" % left)

# Service accounts
svc = ou_dn("Service Accounts")
NEVER = UF_NORMAL_ACCOUNT | UF_DONT_EXPIRE_PASSWD
add_user(users_ldif, "", "", svc, cn="svc-backup", sam="svc-backup", uac=NEVER,
         description="Nightly backup jobs (Veeam)")
add_user(users_ldif, "", "", svc, cn="svc-sql", sam="svc-sql", uac=NEVER,
         description="SQL Server service account (kerberoastable: has SPN)",
         extra=[("servicePrincipalName", ["MSSQLSvc/srv-sql01.%s:1433" % DNS, "MSSQLSvc/srv-sql01.%s" % DNS])])
add_user(users_ldif, "", "", svc, cn="svc-web", sam="svc-web", uac=NEVER | UF_TRUSTED_TO_AUTH_FOR_DELEGATION,
         description="IIS app pool, constrained delegation to SRV-APP01",
         extra=[("servicePrincipalName", "HTTP/intranet.%s" % DNS),  # HOST/srv-web01 already implies HTTP/
                ("msDS-AllowedToDelegateTo", ["HTTP/srv-app01.%s" % DNS, "HTTP/srv-app01"])])
add_user(users_ldif, "", "", svc, cn="svc-ldap-reader", sam="svc-ldap-reader", uac=NEVER,
         description="Read-only bind account for applications")
add_user(users_ldif, "", "", svc, cn="svc-legacy", sam="svc-legacy", uac=NEVER | UF_ACCOUNTDISABLE,
         description="Decommissioned ERP interface")

# Special cases
sp = ou_dn("Special Cases")
add_user(users_ldif, "Test", "Disabled", sp, sam="test.disabled", uac=UF_NORMAL_ACCOUNT | UF_ACCOUNTDISABLE,
         description="userAccountControl 514 (ACCOUNTDISABLE)")
add_user(users_ldif, "Test", "Expired", sp, sam="test.expired",
         description="accountExpires in the past (2024-01-01)",
         extra=[("accountExpires", filetime(1704067200))])
add_user(users_ldif, "Test", "Expiring", sp, sam="test.expiring",
         description="accountExpires in 5 days", extra=[("accountExpires", filetime(NOW + 5 * 86400))])
add_user(users_ldif, "Test", "MustChange", sp, sam="test.mustchange",
         description="pwdLastSet = 0 (must change password at next logon)")
add_user(users_ldif, "Test", "NeverExpires", sp, sam="test.neverexpires", uac=NEVER,
         description="DONT_EXPIRE_PASSWORD")
add_user(users_ldif, "Test", "Locked", sp, sam="test.locked",
         description="Locked out by failed binds (PSO-Lockout-Test: threshold 3)")
add_user(users_ldif, "Test", "Smartcard", sp, sam="test.smartcard", uac=UF_NORMAL_ACCOUNT | UF_SMARTCARD_REQUIRED,
         description="SMARTCARD_REQUIRED")
add_user(users_ldif, "Test", "NoPreauth", sp, sam="test.nopreauth", uac=UF_NORMAL_ACCOUNT | UF_DONT_REQUIRE_PREAUTH,
         description="DONT_REQ_PREAUTH (AS-REP roastable)")
add_user(users_ldif, "Test", "NotDelegated", sp, sam="test.notdelegated", uac=UF_NORMAL_ACCOUNT | UF_NOT_DELEGATED,
         description="NOT_DELEGATED (account is sensitive)")
add_user(users_ldif, "Test", "Delegation", sp, sam="test.delegation",
         uac=UF_NORMAL_ACCOUNT | UF_TRUSTED_FOR_DELEGATION, description="TRUSTED_FOR_DELEGATION (unconstrained)")
add_user(users_ldif, "Test", "Stale", sp, sam="test.stale",
         description="Never logged on, intended for stale-account reports")
add_user(users_ldif, "Test", "Photo", sp, sam="test.photo", description="Has thumbnailPhoto and jpegPhoto",
         extra=[("thumbnailPhoto", open(PHOTO, "rb").read()), ("jpegPhoto", open(PHOTO, "rb").read())]
         if os.path.exists(PHOTO) else [])
add_user(users_ldif, "Test", "MultiValue", sp, sam="test.multivalue", city=CITIES[1],
         description="Multi-valued attributes",
         extra=[("otherTelephone", ["+49 40 111111", "+49 40 222222", "+49 40 333333"]),
                ("otherMobile", ["+49 151 1111111", "+49 160 2222222"]),
                ("proxyAddresses", ["SMTP:test.multivalue@%s" % DNS, "smtp:tmv@%s" % DNS, "smtp:alias@ldapilot.example"]),
                ("url", ["https://ldapilot.example", "https://github.com/DPicillo/LDAPilot"]),
                ("info", "Notes field\nwith a second line\nand a third one.")])
add_user(users_ldif, "Test", "LongDescription", sp, sam="test.longdesc",
         description=" ".join(["Dieser Beschreibungstext ist absichtlich sehr lang, um Zeilenumbrüche, "
                               "Tooltips und abgeschnittene Tabellenzellen zu testen."] * 7).strip())  # AD caps description at 1024
deep_user = add_user(users_ldif, "Deep", "User", ou_dn(*deep), sam="deep.user",
                     description="Lives 9 OUs deep to test long DNs and breadcrumbs")
users_ldif.write()

# Names that need RFC 4514 escaping go into their own file so a parser problem
# with one of them cannot block the rest of the seed.
special = Ldif("25-special-names.ldif")
for first, last, cn, sam in [
    ("Anna", "Schmidt", "Schmidt, Anna", "anna.schmidt.comma"),
    ("Jürgen", "Weiß-Özdemir", "Jürgen Weiß-Özdemir", "juergen.weiss"),
    ("Patrick", "O'Brien", "Patrick O'Brien", "patrick.obrien"),
    ("C++", "Developer", "C++ Developer", "cpp.developer"),
    ("Hash", "User", "#Hash User", "hash.user"),
    ("Quote", "User", 'Quote "Q" User', "quote.user"),
    ("Semi", "Colon", "Semi;Colon <Angle>", "semi.colon"),
    ("Back", "Slash", "Back\\Slash", "back.slash"),
    ("Zoë", "Ångström", "Zoë Ångström 日本", "zoe.angstrom"),
]:
    add_user(special, first, last, sp, cn=cn, sam=sam, description="DN escaping test: %s" % cn)
special.write()

# --- Groups ------------------------------------------------------------------

groups_ldif = Ldif("30-groups.ldif")
group_dns = {}


def add_group(ldif, name, ou, gtype, *, members=(), description="", managed_by=None, mail=None):
    dn = "CN=%s,%s" % (esc_rdn(name), ou)
    ldif.add(dn, [("objectClass", "group"), ("cn", name), ("sAMAccountName", name), ("groupType", gtype),
                  ("description", description), ("managedBy", managed_by), ("mail", mail),
                  ("member", list(members))])
    group_dns[name] = dn
    return dn


all_staff = [u for u in users if u["dept"] and u["uac"] & UF_ACCOUNTDISABLE == 0]
for dept in ["Management", *DEPTS]:
    add_group(groups_ldif, "GG-Dept-%s" % dept, ou_dn("Groups", "Departments"), GLOBAL_SEC,
              members=[u["dn"] for u in all_staff if u["dept"] == dept], description="Department %s" % dept,
              managed_by=heads.get(dept, ceo)["dn"], mail="dept-%s@%s" % (dept.lower(), DNS))
for city in CITIES:
    add_group(groups_ldif, "GG-Loc-%s" % city[0].translate(TRANSLIT), ou_dn("Groups", "Locations"), GLOBAL_SEC,
              members=[u["dn"] for u in all_staff if u["city"] == city[0]], description="Location %s" % city[0])
add_group(groups_ldif, "GG-All-Users", ou_dn("Groups", "Admin"), GLOBAL_SEC,
          members=[u["dn"] for u in users if u["uac"] & UF_ACCOUNTDISABLE == 0 and u["dept"]],
          description="Every active employee as a direct member (large group)")
add_group(groups_ldif, "GG-Managers", ou_dn("Groups", "Admin"), GLOBAL_SEC,
          members=[ceo["dn"], cto["dn"], cfo["dn"], *[h["dn"] for h in heads.values()]], description="All managers")
it_users = [u["dn"] for u in users if u["dept"] == "IT"]
add_group(groups_ldif, "GG-IT-Admins", ou_dn("Groups", "Admin"), GLOBAL_SEC, members=[it_admin["dn"], *it_users[:2]],
          description="Nested into Domain Admins")
add_group(groups_ldif, "GG-Helpdesk", ou_dn("Groups", "Admin"), GLOBAL_SEC, members=it_users[2:6],
          description="Delegated: reset passwords on OU=Users (see ACL)")
add_group(groups_ldif, "GG-Lockout-Test", ou_dn("Groups", "Admin"), GLOBAL_SEC,
          members=[u["dn"] for u in users if u["sam"] == "test.locked"], description="PSO-Lockout-Test applies here")
add_group(groups_ldif, "GG-Empty", ou_dn("Groups", "Admin"), GLOBAL_SEC, description="Has no members")
add_group(groups_ldif, "GG-Nested-Level3", ou_dn("Groups", "Admin"), GLOBAL_SEC, members=[deep_user["dn"]],
          description="Innermost of a 3-level nesting chain")
add_group(groups_ldif, "GG-Nested-Level2", ou_dn("Groups", "Admin"), GLOBAL_SEC,
          members=[group_dns["GG-Nested-Level3"]], description="Contains GG-Nested-Level3")
add_group(groups_ldif, "GG-Nested-Level1", ou_dn("Groups", "Admin"), GLOBAL_SEC,
          members=[group_dns["GG-Nested-Level2"]], description="Contains GG-Nested-Level2")
add_group(groups_ldif, "GG-Circular-A", ou_dn("Groups", "Admin"), GLOBAL_SEC,
          description="Member of GG-Circular-B which is member of this group (cycle)")
add_group(groups_ldif, "GG-Circular-B", ou_dn("Groups", "Admin"), GLOBAL_SEC,
          members=[group_dns["GG-Circular-A"]], description="Cycle partner of GG-Circular-A")
# AGDLP: domain local resource groups contain global groups
res = ou_dn("Groups", "Resources")
add_group(groups_ldif, "DL-FS-Projects-RW", res, DOMAIN_LOCAL_SEC,
          members=[group_dns["GG-Dept-Engineering"], group_dns["GG-Dept-IT"]], description="\\\\srv-fs01\\projects modify")
add_group(groups_ldif, "DL-FS-Projects-RO", res, DOMAIN_LOCAL_SEC,
          members=[group_dns["GG-Dept-Sales"], group_dns["GG-Dept-Marketing"]], description="\\\\srv-fs01\\projects read")
add_group(groups_ldif, "DL-FS-Finance-RW", res, DOMAIN_LOCAL_SEC,
          members=[group_dns["GG-Dept-Finance"], group_dns["GG-Managers"]], description="\\\\srv-fs01\\finance modify")
add_group(groups_ldif, "DL-Printer-Berlin-Color", res, DOMAIN_LOCAL_SEC,
          members=[group_dns["GG-Loc-Berlin"]], description="Color printer 3rd floor Berlin")
add_group(groups_ldif, "DL-App-SAP-Users", res, DOMAIN_LOCAL_SEC,
          members=[group_dns["GG-Dept-Finance"], group_dns["GG-Dept-Sales"]], description="SAP GUI access")
add_group(groups_ldif, "UG-All-Staff", ou_dn("Groups", "Admin"), UNIVERSAL_SEC,
          members=[group_dns["GG-Dept-%s" % d] for d in ["Management", *DEPTS]],
          description="Universal group nesting all department groups")
dist = ou_dn("Groups", "Distribution")
add_group(groups_ldif, "Newsletter", dist, UNIVERSAL_DIST, members=[u["dn"] for u in all_staff[::3]],
          description="Monthly newsletter (universal distribution)", mail="newsletter@%s" % DNS)
add_group(groups_ldif, "Sales Team Hamburg", dist, GLOBAL_DIST,
          members=[u["dn"] for u in all_staff if u["dept"] == "Sales" and u["city"] == "Hamburg"],
          description="Global distribution group", mail="sales-hh@%s" % DNS)
add_group(groups_ldif, "Event-Team", dist, DOMAIN_LOCAL_DIST, members=[u["dn"] for u in all_staff[5:12]],
          description="Domain local distribution group", mail="events@%s" % DNS)
groups_ldif.write()

# --- Computers ---------------------------------------------------------------

computers = Ldif("40-computers.ldif")
it_head = heads["IT"]["dn"]


def add_computer(name, ou, os_name, os_version, *, description="", location="", disabled=False, managed_by=None):
    fqdn = "%s.%s" % (name.lower(), DNS)
    uac = UF_WORKSTATION_TRUST_ACCOUNT | (UF_ACCOUNTDISABLE if disabled else 0)
    computers.add("CN=%s,%s" % (name, ou), [
        ("objectClass", "computer"), ("cn", name), ("sAMAccountName", name + "$"), ("userAccountControl", uac),
        ("dNSHostName", fqdn), ("operatingSystem", os_name), ("operatingSystemVersion", os_version),
        ("servicePrincipalName", ["HOST/%s" % name, "HOST/%s" % fqdn]), ("description", description),
        ("location", location), ("managedBy", managed_by),
        ("unicodePwd", unicode_pwd("Mach!ne-%s-%08d" % (name, rnd.randrange(10 ** 8))))])


for i in range(1, 13):
    city = CITIES[i % len(CITIES)]
    add_computer("WS-%s-%03d" % (city[0][:3].translate(TRANSLIT).upper(), i), ou_dn("Computers", "Workstations"),
                 "Windows 11 Enterprise", "10.0 (22631)", location=city[0], description="Desktop %s" % city[0])
for i in range(1, 9):
    add_computer("NB-%03d" % i, ou_dn("Computers", "Laptops"), "Windows 11 Pro" if i % 3 else "Windows 10 Enterprise",
                 "10.0 (22631)" if i % 3 else "10.0 (19045)", description="Notebook", disabled=(i == 8))
for name, os_name, ver, desc, disabled in [
    ("SRV-FS01", "Windows Server 2022 Standard", "10.0 (20348)", "File server", False),
    ("SRV-SQL01", "Windows Server 2022 Datacenter", "10.0 (20348)", "SQL Server 2022", False),
    ("SRV-WEB01", "Windows Server 2019 Standard", "10.0 (17763)", "IIS frontend", False),
    ("SRV-APP01", "Windows Server 2025 Standard", "10.0 (26100)", "Application server", False),
    ("SRV-LNX01", "Ubuntu", "24.04", "Linux joined via sssd", False),
    ("SRV-LEGACY01", "Windows Server 2008 R2 Enterprise", "6.1 (7601)", "End of life, disabled", True),
]:
    add_computer(name, ou_dn("Computers", "Servers"), os_name, ver, description=desc, disabled=disabled,
                 location="Datacenter Frankfurt", managed_by=it_head)
computers.write()

# --- Contacts ----------------------------------------------------------------

contacts = Ldif("50-contacts.ldif")
for i, (first, last, company) in enumerate([
    ("Thomas", "Berger", "Contoso Ltd."), ("Elena", "Petrova", "Fabrikam Inc."), ("John", "Smith", "Northwind Traders"),
    ("Marta", "Nowak", "Adventure Works"), ("Henrik", "Larsen", "Tailspin Toys"), ("Yuki", "Tanaka", "Wide World Importers"),
    ("Fatma", "Demir", "Litware Inc."), ("Pierre", "Dubois", "Proseware"), ("Sven", "Johansson", "Woodgrove Bank"),
    ("Lucía", "Fernández", "Alpine Ski House"), ("Grace", "O'Neill", "Coho Winery"), ("Ahmed", "Hassan", "Fourth Coffee"),
]):
    cn = "%s %s" % (first, last)
    domain = company.split()[0].lower().rstrip(".,") + ".example"
    contacts.add("CN=%s,%s" % (esc_rdn(cn), ou_dn("Contacts")), [
        ("objectClass", "contact"), ("cn", cn), ("givenName", first), ("sn", last), ("displayName", cn),
        ("mail", "%s.%s@%s" % (first.lower(), last.lower().replace("'", ""), domain)), ("company", company),
        ("telephoneNumber", "+%d %d %07d" % (rnd.choice([1, 31, 33, 44, 46, 81]), rnd.randint(10, 99), rnd.randrange(10 ** 7))),
        ("description", "External partner at %s" % company)])
contacts.write()

bulk = Ldif("60-bulk.ldif")
for i in range(1, 1501):
    bulk.add("CN=Bulk Contact %04d,%s" % (i, ou_dn("Bulk")), [
        ("objectClass", "contact"), ("cn", "Bulk Contact %04d" % i), ("sn", "Contact %04d" % i),
        ("givenName", "Bulk"), ("mail", "bulk%04d@bulk.example" % i), ("description", "Paging test object %d" % i)])
bulk.write()

# --- Modifications that need existing objects ----------------------------------

mods = Ldif("90-modify.ldif")
mods.modify(group_dns["GG-Circular-A"], "add", "member", [group_dns["GG-Circular-B"]])
for u in users:
    if u["sam"] == "test.mustchange":
        mods.modify(u["dn"], "replace", "pwdLastSet", ["0"])
mods.write()

print("generated %d users, %d groups in %s" % (len(users), len(group_dns), OUT))
