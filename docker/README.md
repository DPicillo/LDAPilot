# LDAPilot Test Lab

Three directory servers for developing and testing LDAPilot, each seeded with
realistic data and the edge cases an LDAP admin tool has to cope with, plus an
optional large OpenLDAP for performance work (see
[Large OpenLDAP](#large-openldap-performance)).

| Server | Container | Ports (host) | Base DN |
|---|---|---|---|
| OpenLDAP 2.4 (osixia) | `ldapilot-openldap` | 389 (StartTLS), 636 (LDAPS) | `dc=demo,dc=ldapilot,dc=local` |
| 389 Directory Server | `ldapilot-389ds` | 4389 (StartTLS), 4636 (LDAPS) | `dc=dirsrv,dc=ldapilot,dc=lab` |
| Samba 4 AD DC | `ldapilot-samba-ad` | 2389 (StartTLS), 2636 (LDAPS), 3268/3269 (Global Catalog), 88 (Kerberos KDC, TCP/UDP) | `DC=ad,DC=ldapilot,DC=lab` |

## Quick Start

```bash
cd docker
docker compose up -d --build   # first start: ~1-2 min until Samba is provisioned and seeded
docker compose ps              # samba-ad turns "healthy" once seeding is done
docker compose logs seed       # OpenLDAP/389DS seed summary
docker compose logs samba-ad | grep seed
```

The `seed` service is a one-shot job: it seeds OpenLDAP and 389DS only while
they are empty, so re-running `docker compose up -d` is safe. Samba seeds itself
on first start (marker file in its volume).

## Credentials

| Server | Bind DN | Password |
|---|---|---|
| OpenLDAP admin | `cn=admin,dc=demo,dc=ldapilot,dc=local` | `admin` |
| OpenLDAP read-only | `cn=readonly,dc=demo,dc=ldapilot,dc=local` | `readonly` |
| OpenLDAP `cn=config` | `cn=admin,cn=config` | `config` |
| OpenLDAP users | `uid=<uid>,ou=<dept>,ou=People,...` | same as the uid |
| 389DS Directory Manager | `cn=Directory Manager` | `Admin12345` |
| Samba AD Administrator | `Administrator@ad.ldapilot.lab` (or `LDAPILOT\Administrator`) | `LDAPilot!2026` |
| Samba AD seeded users | `<sAMAccountName>@ad.ldapilot.lab` | `Passw0rd!2026` |

TLS certificates are self-signed (OpenLDAP, 389DS) or issued by a lab CA
(Samba, exported to `samba-ad/export/ca.pem`); in LDAPilot either pick
"Skip verification" under TLS trust, add that CA file, or use "Use as CA
certificate" in the test result. Samba accepts simple binds over plain LDAP
(host port 2389) for testing (`ldap server require strong auth = no`) – never
do that in production. Password writes on AD (`unicodePwd`) need StartTLS or LDAPS.

## Connecting LDAPilot

Host `localhost` for all three; the connection presets fill in the rest:

| Profile | Preset | Port / TLS | Bind |
|---|---|---|---|
| Samba AD | Active Directory | 2636 LDAPS (or 2389 + StartTLS) | `Administrator@ad.ldapilot.lab` |
| Samba AD Global Catalog | AD Global Catalog | 3269 LDAPS (read-only) | as above |
| Samba AD via Kerberos | Active Directory, Authentication Kerberos | 2636 | User name `Administrator`, Realm `AD.LDAPILOT.LAB`, KDC `localhost:88`, SPN `ldap/dc1.ad.ldapilot.lab` |
| Samba AD via NTLM | Active Directory, Authentication NTLM | 2636 | User name `Administrator`, Domain `LDAPILOT` |
| OpenLDAP | OpenLDAP | 389 (plain or StartTLS) or 636 LDAPS | `cn=admin,dc=demo,dc=ldapilot,dc=local` |
| OpenLDAP read-only | OpenLDAP, Read-only on | 389 | `cn=readonly,dc=demo,dc=ldapilot,dc=local` |
| 389DS | 389 Directory Server | 4389 (plain or StartTLS) or 4636 LDAPS | `cn=Directory Manager` |

Kerberos needs the SPN override because the DC's service principal is
`ldap/dc1.ad.ldapilot.lab`, not `ldap/localhost`; with a KDC set, LDAPilot
builds the Kerberos configuration itself (TCP, no `krb5.conf` needed). On a
plain connection LDAPilot asks before a cleartext password crosses the wire.

## Password and Lockout Policies

| Server | Policy | Lockout | Must change |
|---|---|---|---|
| OpenLDAP | ppolicy `cn=default-ppolicy,ou=Policies` (min. length 8, history 5, max. age 90 days; the overlay hashes cleartext `userPassword` values) | after 3 failed binds, **until an admin unlocks** | `pwdMustChange: TRUE` (after an admin reset) |
| 389DS | global policy (max. age 90 days) | after 3 failed binds, **until an admin unlocks** (`passwordUnlock: off`) | `passwordMustChange: on` |
| Samba AD | domain policy + PSOs: `PSO-Admins` (`GG-IT-Admins`: min. length 16, history 24), `PSO-Lockout-Test` (`GG-Lockout-Test`) | **only** members of `GG-Lockout-Test` (`test.locked`): 3 failures, 10 minutes; the domain itself has no lockout threshold | `pwdLastSet=0` |

Only ever fail binds with accounts you created yourself: a locked OpenLDAP or
389DS account stays locked until an administrator unlocks it.

## OpenLDAP and 389 Directory Server

Both get the same data from `seed/*.ldif` (389DS with the suffix rewritten):

```
<base>
├── ou=People (~200 inetOrgPerson users in 7 department OUs, ~40 with posixAccount)
├── ou=Groups (~50 groupOfNames: teams, roles, distribution, nested security groups)
├── ou=Services (service accounts) · ou=Devices · ou=Policies
```

Edge cases: a group with all ~200 users, nested groups, DNs with `,` `'` `+`,
umlauts (base64 in LDIF), a 1000+ character description, multi-valued
attributes and a `jpegPhoto`.

Server specifics added by `seed-ldap.sh`:

- **OpenLDAP**: memberOf overlay reconfigured for `groupOfNames`/`member`
  (osixia ships it for `groupOfUniqueNames`), refint, **ppolicy** overlay with
  `cn=default-ppolicy,ou=Policies` (see the policy table above). The first user
  in `ou=Contractors` is locked (`pwdAccountLockedTime`), the second has
  `pwdReset: TRUE`.
- **389DS**: memberOf and referential integrity plugins, global password policy
  with lockout, a **managed role** and a **filtered role**, a **pointer CoS**
  (virtual `postalAddress` below `ou=People`), one user in `ou=Sales` with
  `nsAccountLock: true` and the next one locked by failed binds.

## Samba Active Directory

Realm `AD.LDAPILOT.LAB`, NetBIOS `LDAPILOT`, schema 2019, functional level 2016.
Test data lives below `OU=LDAPilot` (generated by `samba-ad/seed.py`, orchestrated
by `samba-ad/seed.sh`):

```
OU=LDAPilot
├── OU=Users / Berlin, Hamburg, München, Köln   ~80 users, manager chain, phone/address,
│                                               RFC2307 attributes for IT/Engineering
├── OU=Groups / Departments, Locations, Resources, Distribution, Admin
├── OU=Service Accounts   SPNs (kerberoastable), constrained delegation, adm.mertens (Domain/Enterprise Admins)
├── OU=Computers / Workstations, Laptops, Servers   OS attributes, managedBy, disabled + EOL machines
├── OU=Contacts           external contacts
├── OU=Disabled Users     former employees
├── OU=Special Cases      one account per edge case (see below)
├── OU=Bulk               1500 contacts (more than AD's MaxPageSize of 1000)
├── OU=Empty OU
└── OU=Deep Structure     8 nested OUs with a user at the bottom
```

**Account states** in `OU=Special Cases`: disabled, expired, expiring in 5 days,
must change password (`pwdLastSet=0`), password never expires, **locked out**
(`test.locked`, via `PSO-Lockout-Test`), smartcard required, no Kerberos
pre-auth, not delegated, unconstrained delegation, never logged on, photo
(`thumbnailPhoto` + `jpegPhoto`), multi-valued attributes, long description.

**DN escaping**: `Schmidt, Anna`, `C++ Developer`, `#Hash User`,
`Quote "Q" User`, `Semi;Colon <Angle>`, `Back\Slash`, `Jürgen Weiß-Özdemir`,
`Zoë Ångström 日本`.

**Groups**: all six scope/type combinations (global/domain local/universal ×
security/distribution), AGDLP nesting, a 3-level nesting chain, a **circular**
membership (`GG-Circular-A` ⇄ `GG-Circular-B`), an empty group, a large group,
`managedBy`.

**Other AD features**: two fine-grained password policies (PSOs), an ACL
delegation (`GG-Helpdesk` may reset passwords below `OU=Users`), a GPO linked to
two OUs (`gPLink`), a KDS root key and a gMSA (`gmsa-web$`), tombstones in
`CN=Deleted Objects`, real logons (`lastLogon`, `logonCount`) and failed logons
(`badPwdCount`). The AD Recycle Bin is not enabled, so deleted objects are
tombstones: LDAPilot restores them with the attributes a tombstone keeps and
lists what was lost.

## Large OpenLDAP (performance)

A fourth server for performance work, **not** started by a plain `docker compose up`
(compose profile `perf`, own container, ports, volume and network):

```bash
docker compose --profile perf up -d --build openldap-perf   # first start: ~1 min bulk load
docker compose logs openldap-perf | grep '\[perf\]'          # "loaded in … s"
```

| Server | Container | Ports (host) | Base DN | Admin |
|---|---|---|---|---|
| OpenLDAP 2.6 (Debian trixie) | `ldapilot-openldap-perf` | 10389 (StartTLS), 10636 (LDAPS) | `dc=perf,dc=ldapilot,dc=lab` | `cn=admin,dc=perf,dc=ldapilot,dc=lab` / `admin` |

Also `cn=readonly,dc=perf,dc=ldapilot,dc=lab` / `readonly` (an ordinary bind: ACLs apply;
size and time limits are unlimited for every bind), `cn=admin,cn=config` / `config`, every user
with the password `password`. The certificate is self-signed (`perf.ldapilot.lab`, `localhost`).

```
dc=perf,dc=ldapilot,dc=lab
├── ou=Groups        40,000 groupOfNames directly below (one flat container: the reported case)
├── ou=People       100,000 inetOrgPerson directly below (30 % also posixAccount)
├── ou=Departments   50 OUs × ou=Teams (posixGroup) / ou=Projects (groupOfNames) /
│                    ou=Roles (groupOfUniqueNames): the other 60,000 groups
├── ou=Sites         800 OUs with two devices each
└── ou=Contacts      2,000 contacts ("Last, First": a comma in every RDN)
```

Group sizes follow a long tail (most 1–30 members, 1 % 500–2,000). The data comes from
`openldap-perf/generate.go` (deterministic for a seed) and is loaded with `slapadd` on the first
start; `PERF_USERS`, `PERF_GROUPS`, `PERF_ROOT_GROUPS`, `PERF_SITES`, `PERF_CONTACTS` and
`PERF_SEED` in the compose file change the size (then `docker compose --profile perf down -v`
and up again). slapd logs every operation with its duration (`loglevel stats`).

To test the "40,000 groups on the root level" case, create a profile with the base DN
`ou=Groups,dc=perf,dc=ldapilot,dc=lab`. Backend timings without the UI:
`go test -tags perflab -run TestPerfLab -v ./internal/ldap` (see `internal/ldap/perflab_test.go`
for the settings); measurements and findings in `docs/perf-large-directories.md`.

## Managing the Lab

```bash
docker compose down              # stop, keep data
docker compose down -v           # stop and delete all data (next start re-seeds)
docker compose --profile perf stop openldap-perf     # only the large OpenLDAP
docker compose --profile admin up -d phpldapadmin   # phpLDAPadmin on http://localhost:8080
```

To change the OpenLDAP/389DS seed, edit `generate-seed.go`, run
`go run generate-seed.go`, then `docker compose down -v && docker compose up -d`.
For Samba, edit `samba-ad/seed.py` / `seed.sh`, then
`docker compose down -v && docker compose up -d --build`.
