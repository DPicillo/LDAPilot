#!/bin/bash
# Samba AD DC entrypoint: provisions the domain on first start, installs a TLS
# certificate with proper SANs (Samba's self-signed default has none, which Go
# clients reject), starts samba, seeds test data once and keeps samba running.
set -euo pipefail

REALM="${SAMBA_REALM:-AD.LDAPILOT.LAB}"
DOMAIN="${SAMBA_DOMAIN:-LDAPILOT}"
HOST_NAME="${SAMBA_HOSTNAME:-dc1}"
ADMINPASS="${SAMBA_ADMIN_PASSWORD:?SAMBA_ADMIN_PASSWORD must be set}"
DNS_FORWARDER="${SAMBA_DNS_FORWARDER:-1.1.1.1}"
DNSDOMAIN="$(echo "$REALM" | tr '[:upper:]' '[:lower:]')"
PRIV=/var/lib/samba/private
TLSDIR="$PRIV/ldapilot-tls"
EXPORT=/export
SEED_MARKER=/var/lib/samba/.ldapilot-seeded

log() { echo "[samba-ad] $*"; }

if [ ! -f "$PRIV/sam.ldb" ]; then
  log "provisioning domain $REALM ($DOMAIN) on host $HOST_NAME"
  rm -f /etc/samba/smb.conf
  samba-tool domain provision \
    --realm="$REALM" \
    --domain="$DOMAIN" \
    --server-role=dc \
    --dns-backend=SAMBA_INTERNAL \
    --host-name="$HOST_NAME" \
    --adminpass="$ADMINPASS" \
    --use-rfc2307 \
    --base-schema=2019 \
    --function-level=2016 \
    --option="ad dc functional level = 2016" \
    --option="dns forwarder = $DNS_FORWARDER"
  rm -f "$SEED_MARKER"
fi

# TLS certificate signed by a lab CA, with SANs for the host names clients use.
if [ ! -s "$TLSDIR/cert.pem" ]; then
  log "creating lab CA and LDAPS certificate"
  mkdir -p "$TLSDIR" && chmod 700 "$TLSDIR"
  openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
    -keyout "$TLSDIR/ca-key.pem" -out "$TLSDIR/ca.pem" \
    -subj "/O=LDAPilot Lab/CN=LDAPilot Lab Samba CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  openssl req -newkey rsa:3072 -sha256 -nodes \
    -keyout "$TLSDIR/key.pem" -out "$TLSDIR/server.csr" \
    -subj "/O=LDAPilot Lab/CN=${HOST_NAME}.${DNSDOMAIN}" 2>/dev/null
  cat > "$TLSDIR/ext.cnf" <<EOF
subjectAltName=DNS:${HOST_NAME}.${DNSDOMAIN},DNS:${DNSDOMAIN},DNS:${HOST_NAME},DNS:samba-ad,DNS:localhost,IP:127.0.0.1
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
  openssl x509 -req -in "$TLSDIR/server.csr" -CA "$TLSDIR/ca.pem" -CAkey "$TLSDIR/ca-key.pem" \
    -CAcreateserial -out "$TLSDIR/cert.pem" -days 1825 -sha256 -extfile "$TLSDIR/ext.cnf" 2>/dev/null
  chmod 600 "$TLSDIR/key.pem" "$TLSDIR/ca-key.pem"
fi

# Add a [global] option unless it is already configured (idempotent).
ensure_global() {
  if ! grep -qE "^[[:space:]]*$1[[:space:]]*=" /etc/samba/smb.conf; then
    log "smb.conf: $1 = $2"
    sed -i "/^\[global\]/a \\\\t$1 = $2" /etc/samba/smb.conf
  fi
}
ensure_global "tls enabled" "yes"
ensure_global "tls keyfile" "$TLSDIR/key.pem"
ensure_global "tls certfile" "$TLSDIR/cert.pem"
ensure_global "tls cafile" "$TLSDIR/ca.pem"
# Allow simple binds over plain LDAP (port 389 without StartTLS) so every
# LDAPilot connection mode can be tested. Never do this in production.
ensure_global "ldap server require strong auth" "no"
# The container does not resolve its own zone; dynamic DNS updates only spam the log.
ensure_global "dns update command" "/bin/true"

mkdir -p "$EXPORT"
cp "$TLSDIR/ca.pem" "$EXPORT/ca.pem"
chmod 0644 "$EXPORT/ca.pem"

cp -f "$PRIV/krb5.conf" /etc/krb5.conf 2>/dev/null || true

log "starting samba"
samba --foreground --no-process-group --debug-stdout --debuglevel="${SAMBA_DEBUG_LEVEL:-1}" &
SAMBA_PID=$!
trap 'kill -TERM "$SAMBA_PID" 2>/dev/null; wait "$SAMBA_PID"' TERM INT

if [ ! -f "$SEED_MARKER" ]; then
  for _ in $(seq 1 60); do
    LDAPTLS_REQCERT=never ldapsearch -x -H ldaps://localhost -b "" -s base namingContexts >/dev/null 2>&1 && break
    sleep 1
  done
  log "seeding test data"
  if /usr/local/bin/seed.sh; then
    touch "$SEED_MARKER"
    log "seed complete"
  else
    log "seed FAILED (container stays up for debugging)"
  fi
fi

wait "$SAMBA_PID"
