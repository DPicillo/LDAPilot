#!/bin/bash
# Seeds the LDAPilot test domain once (called by entrypoint.sh while samba runs).
# Bulk data comes from seed.py as LDIF; everything that needs samba-tool or a
# running DC (PSOs, ACLs, GPOs, gMSA, tombstones, real logons, lockout) is done here.
# Optional steps only log a warning on failure so one unsupported feature does
# not leave the whole domain empty.
set -uo pipefail

SAM=/var/lib/samba/private/sam.ldb
PW="${SEED_USER_PASSWORD:-Passw0rd!2026}"
ADMINPASS="${SAMBA_ADMIN_PASSWORD:?}"
BASE="$(ldbsearch -H "$SAM" -s base -b "" defaultNamingContext 2>/dev/null | sed -n 's/^defaultNamingContext: //p')"
DNSDOMAIN="$(echo "$BASE" | sed 's/DC=//g; s/,/./g' | tr '[:upper:]' '[:lower:]')"
ROOT="OU=LDAPilot,$BASE"
WORK=/tmp/seed
FAILED=0

log() { echo "[seed] $*"; }
warn() { echo "[seed] WARNING: $*"; }
optional() { # description command...
  local desc="$1"; shift
  if "$@" >/tmp/seed-step.log 2>&1; then log "$desc"; else warn "$desc failed: $(tail -n 3 /tmp/seed-step.log | tr '\n' ' ')"; fi
}

rm -rf "$WORK" && mkdir -p "$WORK"
SEED_USER_PASSWORD="$PW" python3 /usr/local/bin/seed.py "$BASE" "$WORK" || exit 1

for f in "$WORK"/[1-6]*.ldif; do
  out="$(ldbadd -H "$SAM" "$f" 2>&1)"
  if [ $? -eq 0 ] && ! echo "$out" | grep -q '^ERR'; then
    log "$(basename "$f"): $(echo "$out" | tail -n 1)"
  else
    warn "$(basename "$f"): $out"
    case "$(basename "$f")" in 25-*) ;; *) FAILED=1 ;; esac
  fi
done
optional "applied 90-modify.ldif" ldbmodify -H "$SAM" "$WORK/90-modify.ldif"

# Privileged membership
optional "GG-IT-Admins -> Domain Admins" samba-tool group addmembers "Domain Admins" GG-IT-Admins
optional "adm.mertens -> Enterprise Admins" samba-tool group addmembers "Enterprise Admins" adm.mertens
optional "svc-backup -> Backup Operators" samba-tool group addmembers "Backup Operators" svc-backup

# Fine-grained password policies
optional "PSO-Admins" samba-tool domain passwordsettings pso create PSO-Admins 1 \
  --min-pwd-length=16 --complexity=on --max-pwd-age=90 --history-length=24
optional "PSO-Admins applied" samba-tool domain passwordsettings pso apply PSO-Admins GG-IT-Admins
optional "PSO-Lockout-Test" samba-tool domain passwordsettings pso create PSO-Lockout-Test 10 \
  --account-lockout-threshold=3 --account-lockout-duration=600 --reset-account-lockout-after=600
optional "PSO-Lockout-Test applied" samba-tool domain passwordsettings pso apply PSO-Lockout-Test GG-Lockout-Test

# Delegation: GG-Helpdesk may reset passwords of users below OU=Users
HELPDESK_SID="$(ldbsearch -H "$SAM" "(sAMAccountName=GG-Helpdesk)" objectSid 2>/dev/null | sed -n 's/^objectSid: //p')"
if [ -n "$HELPDESK_SID" ]; then
  optional "ACL: GG-Helpdesk reset password on OU=Users" samba-tool dsacl set --objectdn="OU=Users,$ROOT" \
    --sddl="(OA;CIIO;CR;00299570-246d-11d0-a768-00aa006e0529;bf967aba-0de6-11d0-a285-00aa003049e2;$HELPDESK_SID)"
  optional "ACL: GG-Helpdesk write lockoutTime on OU=Users" samba-tool dsacl set --objectdn="OU=Users,$ROOT" \
    --sddl="(OA;CIIO;RPWP;28630ebf-41d5-11d1-a9c1-0000f80367c1;bf967aba-0de6-11d0-a285-00aa003049e2;$HELPDESK_SID)"
fi

# Group Policy objects linked to OUs (gPLink / gPOptions)
GPO_OUT="$(samba-tool gpo create "LDAPilot Workstation Baseline" -H "ldap://$(hostname -f)" -U Administrator --password="$ADMINPASS" 2>&1)"
GPO_GUID="$(echo "$GPO_OUT" | grep -o '{[0-9A-Fa-f-]*}' | head -1)"
if [ -n "$GPO_GUID" ]; then
  log "GPO $GPO_GUID created"
  optional "GPO linked to OU=Workstations" samba-tool gpo setlink "OU=Workstations,OU=Computers,$ROOT" "$GPO_GUID" \
    -H "ldap://$(hostname -f)" -U Administrator --password="$ADMINPASS"
  optional "GPO linked to OU=Laptops" samba-tool gpo setlink "OU=Laptops,OU=Computers,$ROOT" "$GPO_GUID" \
    -H "ldap://$(hostname -f)" -U Administrator --password="$ADMINPASS"
else
  warn "GPO create failed: $GPO_OUT"
fi

# Group managed service account (needs a KDS root key, Samba >= 4.20)
optional "KDS root key" samba-tool domain kds root-key create --use-start-time="2000-01-01T00:00:00"
optional "gMSA gmsa-web" samba-tool service-account create --name=gmsa-web --dns-host-name="gmsa-web.$DNSDOMAIN"
optional "gMSA password readers" samba-tool service-account group-msa-membership add --name='gmsa-web$' \
  --principal="CN=SRV-WEB01,OU=Servers,OU=Computers,$ROOT"

# Tombstones in CN=Deleted Objects
for n in 1 2 3; do
  optional "temp.deleted$n created" samba-tool user create "temp.deleted$n" "$PW" --userou="OU=Users,OU=LDAPilot" \
    --given-name=Temp --surname="Deleted $n" --description="Deleted during seeding"
  optional "temp.deleted$n deleted" samba-tool user delete "temp.deleted$n"
done
optional "OU=Old Project created" samba-tool ou add "OU=Old Project,OU=LDAPilot"
optional "OU=Old Project deleted" samba-tool ou delete "OU=Old Project,OU=LDAPilot"

# Real logons so lastLogon/lastLogonTimestamp/logonCount are populated
bind_as() { ldapwhoami -x -H ldap://localhost -D "$1@$DNSDOMAIN" -w "$2" >/dev/null 2>&1; }
LOGON_USERS="$(ldbsearch -H "$SAM" -b "OU=Users,$ROOT" "(&(objectClass=user)(sAMAccountName=*))" sAMAccountName 2>/dev/null \
  | sed -n 's/^sAMAccountName: //p' | awk 'NR % 3 == 1')"
n=0
for u in $LOGON_USERS adm.mertens svc-backup svc-sql test.photo; do
  bind_as "$u" "$PW" && n=$((n + 1))
done
log "$n successful logons"

# Failed logons: badPwdCount on one user, lockout on test.locked (PSO threshold 3)
for _ in 1 2; do bind_as test.multivalue wrong-password; done
for _ in 1 2 3 4; do bind_as test.locked wrong-password; done
LOCK="$(ldbsearch -H "$SAM" "(sAMAccountName=test.locked)" lockoutTime 2>/dev/null | sed -n 's/^lockoutTime: //p')"
if [ -n "$LOCK" ] && [ "$LOCK" != "0" ]; then log "test.locked is locked out"; else warn "test.locked is NOT locked (lockoutTime=$LOCK)"; fi

TOTAL="$(ldbsearch -H "$SAM" -b "$ROOT" "(objectClass=*)" dn 2>/dev/null | grep -c '^dn:')"
log "objects below $ROOT: $TOTAL"
exit $FAILED
