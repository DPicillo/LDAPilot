# Large OpenLDAP for performance work on LDAPilot: 100,000 users, 100,000 groups
# (40,000 of them directly below ou=Groups) and about 1,000 OUs, generated and
# bulk-loaded with slapadd on first start. Base DN dc=perf,dc=ldapilot,dc=lab.
# LDAP 389 (StartTLS), LDAPS 636.
FROM golang:1.26-alpine AS generator
WORKDIR /src
COPY generate.go .
RUN CGO_ENABLED=0 go build -o /perf-generate generate.go

FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends slapd ldap-utils openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* /etc/ldap/slapd.d /var/lib/ldap/*

COPY --from=generator /perf-generate /usr/local/bin/perf-generate
COPY slapd.conf.tmpl /etc/ldap/slapd.conf.tmpl
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

VOLUME ["/var/lib/ldap"]
EXPOSE 389 636

# The bulk load of the default data set takes about a minute.
HEALTHCHECK --interval=10s --timeout=5s --start-period=300s --retries=6 \
  CMD test -f /var/lib/ldap/.ldapilot-perf-seeded && ldapsearch -x -H ldap://localhost -b "" -s base namingContexts >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
