#!/bin/bash
# One-shot seeder for the OpenLDAP and 389 Directory Server lab containers.
# Runs inside the 389ds image (it ships ldap-utils and dsconf). Idempotent:
# a server whose base DN already has children is left alone.
set -uo pipefail

SEED_DIR=/lab/seed
SEED_FILES="01-base.ldif 02-users.ldif 03-groups.ldif 04-services.ldif 05-extended.ldif"

OL_URI="ldap://openldap:389"
OL_BASE="dc=demo,dc=ldapilot,dc=local"
OL_ADMIN="cn=admin,$OL_BASE"
OL_ADMIN_PW="admin"
OL_CONFIG="cn=admin,cn=config"
OL_CONFIG_PW="config"

DS_URI="ldap://dirsrv:3389"
DS_BASE="dc=dirsrv,dc=ldapilot,dc=lab"
DS_DM="cn=Directory Manager"
DS_DM_PW="Admin12345"

log() { echo "[seed] $*"; }

wait_for() { # uri binddn password
  for _ in $(seq 1 90); do
    ldapsearch -x -H "$1" -D "$2" -w "$3" -b "" -s base >/dev/null 2>&1 && return 0
    sleep 2
  done
  log "ERROR: $1 not reachable"
  return 1
}

child_count() { # uri binddn password base
  ldapsearch -x -H "$1" -D "$2" -w "$3" -b "$4" -s one dn 2>/dev/null | grep -c '^dn:'
}

total_count() { # uri binddn password base
  ldapsearch -x -H "$1" -D "$2" -w "$3" -b "$4" -E pr=500/noprompt dn 2>/dev/null | grep -c '^dn:'
}

import_seed() { # uri binddn password sed-expression
  local f out
  for f in $SEED_FILES; do
    out="$(sed -e "$4" "$SEED_DIR/$f" | ldapadd -x -c -H "$1" -D "$2" -w "$3" 2>&1)"
    log "  $f: $(echo "$out" | grep -c '^adding new entry') added, $(echo "$out" | grep -c '^ldap_add:') errors"
    echo "$out" | grep -A2 '^ldap_add:' | head -6
  done
}

ldapmod() { # uri binddn password  (LDIF on stdin)
  ldapmodify -x -c -H "$1" -D "$2" -w "$3" 2>&1 | grep -vE '^(modifying|adding new) entry|^$' || true
}

fail_binds() { # uri dn count
  for _ in $(seq 1 "$3"); do ldapwhoami -x -H "$1" -D "$2" -w wrong-password >/dev/null 2>&1; done
  return 0
}

# --- OpenLDAP ------------------------------------------------------------------

seed_openldap() {
  wait_for "$OL_URI" "$OL_ADMIN" "$OL_ADMIN_PW" || return 1
  if [ "$(child_count "$OL_URI" "$OL_ADMIN" "$OL_ADMIN_PW" "$OL_BASE")" -gt 1 ]; then
    log "OpenLDAP already seeded"
    return 0
  fi
  log "OpenLDAP: configuring memberOf for groupOfNames and the ppolicy overlay"
  # osixia configures memberOf for groupOfUniqueNames only; the seed uses groupOfNames.
  ldapmod "$OL_URI" "$OL_CONFIG" "$OL_CONFIG_PW" <<EOF
dn: olcOverlay={0}memberof,olcDatabase={1}mdb,cn=config
changetype: modify
replace: olcMemberOfGroupOC
olcMemberOfGroupOC: groupOfNames
-
replace: olcMemberOfMemberAD
olcMemberOfMemberAD: member

dn: cn=module{0},cn=config
changetype: modify
add: olcModuleLoad
olcModuleLoad: ppolicy

dn: olcOverlay=ppolicy,olcDatabase={1}mdb,cn=config
changetype: add
objectClass: olcOverlayConfig
objectClass: olcPPolicyConfig
olcOverlay: ppolicy
olcPPolicyDefault: cn=default-ppolicy,ou=Policies,$OL_BASE
olcPPolicyUseLockout: TRUE
olcPPolicyHashCleartext: TRUE
EOF

  log "OpenLDAP: importing seed"
  import_seed "$OL_URI" "$OL_ADMIN" "$OL_ADMIN_PW" "s/^//"

  ldapmod "$OL_URI" "$OL_ADMIN" "$OL_ADMIN_PW" <<EOF
dn: cn=default-ppolicy,ou=Policies,$OL_BASE
changetype: add
objectClass: organizationalRole
objectClass: pwdPolicy
cn: default-ppolicy
description: Default ppolicy: lockout after 3 failures until an admin unlocks
pwdAttribute: userPassword
pwdMaxFailure: 3
pwdLockout: TRUE
pwdLockoutDuration: 0
pwdMaxAge: 7776000
pwdExpireWarning: 1209600
pwdInHistory: 5
pwdMinLength: 8
pwdCheckQuality: 1
pwdMustChange: TRUE
pwdAllowUserChange: TRUE
pwdGraceAuthNLimit: 3
EOF

  # A locked account (pwdAccountLockedTime) and one that must change its password (pwdReset)
  local locked reset
  locked="$(ldapsearch -x -H "$OL_URI" -D "$OL_ADMIN" -w "$OL_ADMIN_PW" -b "ou=Contractors,ou=People,$OL_BASE" \
    -s one "(uid=*)" dn 2>/dev/null | sed -n 's/^dn: //p' | head -1)"
  reset="$(ldapsearch -x -H "$OL_URI" -D "$OL_ADMIN" -w "$OL_ADMIN_PW" -b "ou=Contractors,ou=People,$OL_BASE" \
    -s one "(uid=*)" dn 2>/dev/null | sed -n 's/^dn: //p' | sed -n 2p)"
  [ -n "$locked" ] && fail_binds "$OL_URI" "$locked" 4 && log "OpenLDAP: locked $locked"
  if [ -n "$reset" ]; then
    printf 'dn: %s\nchangetype: modify\nreplace: pwdReset\npwdReset: TRUE\n' "$reset" | ldapmod "$OL_URI" "$OL_ADMIN" "$OL_ADMIN_PW"
    log "OpenLDAP: pwdReset on $reset"
  fi
  log "OpenLDAP: $(total_count "$OL_URI" "$OL_ADMIN" "$OL_ADMIN_PW" "$OL_BASE") entries"
}

# --- 389 Directory Server ------------------------------------------------------

seed_389ds() {
  wait_for "$DS_URI" "$DS_DM" "$DS_DM_PW" || return 1
  local dsconf=(dsconf -D "$DS_DM" -w "$DS_DM_PW" "$DS_URI")
  if ! "${dsconf[@]}" backend suffix list 2>/dev/null | grep -qi "$DS_BASE"; then
    log "389DS: creating backend userroot for $DS_BASE"
    "${dsconf[@]}" backend create --suffix "$DS_BASE" --be-name userroot --create-suffix || return 1
  fi
  if [ "$(child_count "$DS_URI" "$DS_DM" "$DS_DM_PW" "$DS_BASE")" -gt 0 ]; then
    log "389DS already seeded"
    return 0
  fi
  log "389DS: enabling dynamic plugins, memberOf, referential integrity and a lockout policy"
  "${dsconf[@]}" config replace nsslapd-dynamic-plugins=on >/dev/null
  "${dsconf[@]}" plugin memberof enable >/dev/null
  "${dsconf[@]}" plugin referential-integrity enable >/dev/null
  "${dsconf[@]}" pwpolicy set --pwdlockout on --pwdmaxfailures 3 --pwdlockoutduration 3600 \
    --pwdunlock off --pwdmaxage 7776000 --pwdwarning 1209600 --pwdmustchange on >/dev/null \
    || log "389DS: WARNING: pwpolicy set failed"

  log "389DS: importing seed"
  import_seed "$DS_URI" "$DS_DM" "$DS_DM_PW" \
    "s/dc=demo,dc=ldapilot,dc=local/$DS_BASE/g; s/demo\.ldapilot\.local/dirsrv.ldapilot.lab/g"

  log "389DS: adding roles, class of service and account states"
  ldapmod "$DS_URI" "$DS_DM" "$DS_DM_PW" <<EOF
dn: cn=Engineering Managed Role,ou=Groups,$DS_BASE
changetype: add
objectClass: top
objectClass: LDAPsubentry
objectClass: nsRoleDefinition
objectClass: nsSimpleRoleDefinition
objectClass: nsManagedRoleDefinition
cn: Engineering Managed Role
description: Managed role, users opt in via nsRoleDN

dn: cn=Sales Filtered Role,ou=Groups,$DS_BASE
changetype: add
objectClass: top
objectClass: LDAPsubentry
objectClass: nsRoleDefinition
objectClass: nsComplexRoleDefinition
objectClass: nsFilteredRoleDefinition
cn: Sales Filtered Role
nsRoleFilter: (ou=Sales)
description: Filtered role: every entry with ou=Sales

dn: cn=Office Template,ou=People,$DS_BASE
changetype: add
objectClass: top
objectClass: extensibleObject
objectClass: cosTemplate
objectClass: LDAPsubentry
cn: Office Template
postalAddress: LDAPilot Lab GmbH\$Hauptstrasse 1\$20095 Hamburg
cosPriority: 1

dn: cn=Office CoS,ou=People,$DS_BASE
changetype: add
objectClass: top
objectClass: LDAPsubentry
objectClass: cosSuperDefinition
objectClass: cosPointerDefinition
cn: Office CoS
cosTemplateDn: cn=Office Template,ou=People,$DS_BASE
cosAttribute: postalAddress default
description: Pointer CoS: virtual postalAddress for everyone below ou=People
EOF

  local eng sales
  eng="$(ldapsearch -x -H "$DS_URI" -D "$DS_DM" -w "$DS_DM_PW" -b "ou=Engineering,ou=People,$DS_BASE" -s one "(uid=*)" dn 2>/dev/null \
    | sed -n 's/^dn: //p' | head -5)"
  for dn in $eng; do
    printf 'dn: %s\nchangetype: modify\nadd: nsRoleDN\nnsRoleDN: cn=Engineering Managed Role,ou=Groups,%s\n' "$dn" "$DS_BASE" \
      | ldapmod "$DS_URI" "$DS_DM" "$DS_DM_PW"
  done
  sales="$(ldapsearch -x -H "$DS_URI" -D "$DS_DM" -w "$DS_DM_PW" -b "ou=Sales,ou=People,$DS_BASE" -s one "(uid=*)" dn 2>/dev/null \
    | sed -n 's/^dn: //p' | head -2)"
  local admin_locked policy_locked
  admin_locked="$(echo "$sales" | sed -n 1p)"
  policy_locked="$(echo "$sales" | sed -n 2p)"
  if [ -n "$admin_locked" ]; then
    printf 'dn: %s\nchangetype: modify\nreplace: nsAccountLock\nnsAccountLock: true\n' "$admin_locked" \
      | ldapmod "$DS_URI" "$DS_DM" "$DS_DM_PW"
    log "389DS: nsAccountLock on $admin_locked"
  fi
  [ -n "$policy_locked" ] && fail_binds "$DS_URI" "$policy_locked" 4 && log "389DS: lockout policy triggered on $policy_locked"
  log "389DS: $(total_count "$DS_URI" "$DS_DM" "$DS_DM_PW" "$DS_BASE") entries"
}

rc=0
seed_openldap || rc=1
seed_389ds || rc=1
exit $rc
