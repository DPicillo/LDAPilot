# Samba 4 Active Directory domain controller for testing LDAPilot.
# Realm AD.LDAPILOT.LAB, NetBIOS domain LDAPILOT, base DN DC=ad,DC=ldapilot,DC=lab.
# LDAP 389 (StartTLS), LDAPS 636, Global Catalog 3268/3269.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      samba samba-ad-dc samba-ad-provision samba-dsdb-modules samba-vfs-modules \
      winbind krb5-user ldb-tools ldap-utils openssl ca-certificates procps \
      python3-samba \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/samba/smb.conf

COPY entrypoint.sh seed.sh seed.py /usr/local/bin/
COPY photo.jpg /usr/local/share/ldapilot/photo.jpg
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/seed.sh /usr/local/bin/seed.py

VOLUME ["/var/lib/samba", "/etc/samba", "/export"]
EXPOSE 389 636 3268 3269 88 53/tcp 53/udp

HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=12 \
  CMD test -f /var/lib/samba/.ldapilot-seeded && LDAPTLS_REQCERT=never ldapsearch -x -H ldaps://localhost -b "" -s base namingContexts >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
