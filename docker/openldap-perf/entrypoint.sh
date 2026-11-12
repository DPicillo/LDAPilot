#!/bin/bash
# Entrypoint of the LDAPilot performance OpenLDAP: on the first start (empty
# data volume) it generates the test data and bulk-loads it with slapadd, then
# runs slapd in the foreground. The data set is kept in the volume; change the
# PERF_* settings and recreate the volume to get another size.
set -euo pipefail

: "${PERF_BASE_DN:=dc=perf,dc=ldapilot,dc=lab}"
: "${PERF_ADMIN_PASSWORD:=admin}"
: "${PERF_CONFIG_PASSWORD:=config}"
: "${PERF_USERS:=100000}"
: "${PERF_GROUPS:=100000}"
: "${PERF_ROOT_GROUPS:=40000}"
: "${PERF_SITES:=800}"
: "${PERF_CONTACTS:=2000}"
: "${PERF_SEED:=20261112}"
# 256 = stats: one line per operation with its duration (etime) and entry count.
: "${PERF_LOGLEVEL:=256}"

DATA=/var/lib/ldap
CONF=/etc/ldap/slapd.d
MARKER="$DATA/.ldapilot-perf-seeded"

log() { echo "[perf] $*"; }

mkdir -p "$DATA/tls" /run/slapd
if [ ! -f "$DATA/tls/server.crt" ]; then
  log "creating a self-signed certificate"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=perf.ldapilot.lab" \
    -addext "subjectAltName=DNS:perf.ldapilot.lab,DNS:localhost,IP:127.0.0.1" \
    -keyout "$DATA/tls/server.key" -out "$DATA/tls/server.crt" >/dev/null 2>&1
fi

sed -e "s|@BASE_DN@|$PERF_BASE_DN|g" \
    -e "s|@ADMIN_PW@|$(slappasswd -s "$PERF_ADMIN_PASSWORD")|" \
    -e "s|@CONFIG_PW@|$(slappasswd -s "$PERF_CONFIG_PASSWORD")|" \
    /etc/ldap/slapd.conf.tmpl > /etc/ldap/slapd.conf
# slapd.conf -> cn=config. slaptest writes the directory and then tries to open
# the database, which fails while the volume is still empty: only the written
# configuration counts here.
rm -rf "$CONF"
mkdir -p "$CONF"
slaptest -f /etc/ldap/slapd.conf -F "$CONF" >/dev/null 2>&1 || true
if [ ! -f "$CONF/cn=config.ldif" ]; then
  log "ERROR: slapd.conf could not be converted:"
  slaptest -u -f /etc/ldap/slapd.conf || true
  exit 1
fi

if [ ! -f "$MARKER" ]; then
  log "loading $PERF_USERS users and $PERF_GROUPS groups ($PERF_ROOT_GROUPS directly below ou=Groups) ..."
  rm -f "$DATA"/*.mdb
  start=$(date +%s)
  perf-generate -base "$PERF_BASE_DN" -users "$PERF_USERS" -groups "$PERF_GROUPS" \
      -root-groups "$PERF_ROOT_GROUPS" -sites "$PERF_SITES" -contacts "$PERF_CONTACTS" -seed "$PERF_SEED" \
    | slapadd -q -F "$CONF" -b "$PERF_BASE_DN"
  echo "users=$PERF_USERS groups=$PERF_GROUPS root-groups=$PERF_ROOT_GROUPS sites=$PERF_SITES contacts=$PERF_CONTACTS seed=$PERF_SEED" > "$MARKER"
  log "loaded in $(( $(date +%s) - start )) s"
else
  log "data volume already loaded: $(cat "$MARKER")"
fi

chown -R openldap:openldap "$DATA" "$CONF" /run/slapd
log "starting slapd"
exec slapd -F "$CONF" -u openldap -g openldap -h "ldap:/// ldaps:///" -d "$PERF_LOGLEVEL"
