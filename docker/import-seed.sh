#!/bin/bash
# Import seed LDIF files into the running OpenLDAP container
# Usage: ./import-seed.sh

CONTAINER="ldapilot-openldap"
ADMIN_DN="cn=admin,dc=demo,dc=ldapilot,dc=local"
ADMIN_PW="admin"

echo "Waiting for OpenLDAP to be ready..."
for i in $(seq 1 30); do
    if docker exec $CONTAINER ldapsearch -x -H ldap://localhost:389 -D "$ADMIN_DN" -w "$ADMIN_PW" -b "dc=demo,dc=ldapilot,dc=local" -s base "(objectClass=*)" dn > /dev/null 2>&1; then
        echo "OpenLDAP is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "ERROR: OpenLDAP did not start in time"
        exit 1
    fi
    sleep 1
done

echo ""
for ldif in seed/01-base.ldif seed/02-users.ldif seed/03-groups.ldif seed/04-services.ldif seed/05-extended.ldif; do
    if [ ! -f "$ldif" ]; then
        echo "SKIP: $ldif not found"
        continue
    fi
    echo "Importing $ldif..."
    # Copy file into container and import
    docker cp "$ldif" "$CONTAINER:/tmp/import.ldif"
    result=$(docker exec $CONTAINER ldapadd -x -H ldap://localhost:389 -D "$ADMIN_DN" -w "$ADMIN_PW" -c -f /tmp/import.ldif 2>&1)
    added=$(echo "$result" | grep -c "adding new entry")
    errors=$(echo "$result" | grep -c "ldap_add:")
    echo "  -> $added entries added, $errors errors"
done

echo ""
total=$(docker exec $CONTAINER ldapsearch -x -H ldap://localhost:389 -D "$ADMIN_DN" -w "$ADMIN_PW" -b "dc=demo,dc=ldapilot,dc=local" "(objectClass=*)" dn 2>/dev/null | grep -c "^dn:")
echo "Total entries in directory: $total"
