# LDAPilot Docker Demo Environment

A self-contained OpenLDAP demo environment with 300+ pre-seeded entries for testing and developing LDAPilot.

## Quick Start

```bash
cd docker

# Generate seed LDIF files (only needed once, or after modifying generate-seed.go)
go run generate-seed.go

# Start the OpenLDAP container
docker compose up -d

# Verify it's running
docker compose ps
```

## Connection Details

| Parameter       | Value                                        |
|-----------------|----------------------------------------------|
| Host            | `localhost`                                  |
| LDAP Port       | `389`                                        |
| LDAPS Port      | `636`                                        |
| Base DN         | `dc=demo,dc=ldapilot,dc=local`              |
| Admin DN        | `cn=admin,dc=demo,dc=ldapilot,dc=local`     |
| Admin Password  | `admin`                                      |
| Readonly DN     | `cn=readonly,dc=demo,dc=ldapilot,dc=local`  |
| Readonly Pass   | `readonly`                                   |
| TLS             | Self-signed certificate (accept in LDAPilot) |

## Connecting with LDAPilot

1. Launch LDAPilot
2. Click **New Connection**
3. Fill in:
   - **Name**: Demo OpenLDAP
   - **Host**: localhost
   - **Port**: 389
   - **Bind DN**: `cn=admin,dc=demo,dc=ldapilot,dc=local`
   - **Password**: `admin`
   - **Base DN**: `dc=demo,dc=ldapilot,dc=local`
4. Click **Connect**

For read-only testing, use the readonly credentials instead.

## What's Included

The seed data provides a realistic directory structure:

```
dc=demo,dc=ldapilot,dc=local
├── ou=People (~200 users)
│   ├── ou=Engineering (55 users)
│   ├── ou=Sales (35 users)
│   ├── ou=Management (15 users)
│   ├── ou=HR (20 users)
│   ├── ou=IT (35 users)
│   ├── ou=Finance (20 users)
│   └── ou=Contractors (20 users)
├── ou=Groups (~50 groups)
│   ├── ou=Teams (20 team groups)
│   ├── ou=Roles (11 role groups, including nested)
│   ├── ou=Distribution (10 mailing lists, one with all users)
│   └── ou=Security (10 security groups, including nested)
├── ou=Services (16 service accounts)
├── ou=Devices (15 device entries)
└── ou=Policies (8 policy entries)
```

### Notable Test Entries

- **Large group**: `dl-all-employees` has all ~200 users as members
- **Near-empty group**: `grp-legacy-system` has only 1 member
- **Nested groups**: `role-all-access` and `sec-all-security` contain other groups as members
- **Special characters in DN**: `Meier, Dr. Hans-Peter` (comma), `Patrick O'Brien` (apostrophe), `C++ Build Service` (plus)
- **Very long description**: `policy-data-governance` has a 1000+ character description
- **UTF-8/German umlauts**: Entries with base64-encoded umlauts (ue, ae, oe, ss)
- **Multi-valued attributes**: `multi.value` user has 3 emails, 3 phones, 3 descriptions
- **POSIX users**: ~40 users have posixAccount overlay (uidNumber, gidNumber, homeDirectory, loginShell)
- **Binary attribute**: `photo.test` user has a jpegPhoto attribute

## phpLDAPadmin (Optional)

To also start the phpLDAPadmin web UI:

```bash
docker compose --profile admin up -d
```

Then open http://localhost:8080 and log in with the admin credentials.

## Managing the Container

```bash
# Stop the container (data persists in volumes)
docker compose down

# Stop and remove all data (fresh start)
docker compose down -v

# View logs
docker compose logs -f openldap

# Restart
docker compose restart
```

## Regenerating Seed Data

To modify the seed data:

1. Edit `generate-seed.go`
2. Run `go run generate-seed.go`
3. Remove volumes and restart: `docker compose down -v && docker compose up -d`

The LDIF files in `seed/` are only loaded on first container start. To reload, you must remove the volumes.

## Seed Files

| File                  | Contents                                          |
|-----------------------|---------------------------------------------------|
| `seed/01-base.ldif`   | OU hierarchy (manually created)                  |
| `seed/02-users.ldif`  | ~200 inetOrgPerson users                         |
| `seed/03-groups.ldif` | ~50 groupOfNames groups                          |
| `seed/04-services.ldif` | Service accounts, devices, policies             |
| `seed/05-extended.ldif` | Edge cases: special chars, umlauts, long values |
