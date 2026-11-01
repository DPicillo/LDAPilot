package ldaptools

import (
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// Helpers of the account tools. Account status, reports and actions come
// from the account track (Client.AccountStatus/AccountReport/
// PlanAccountChange/ApplyAccountChange, adapted in services/ai_backend.go);
// only the find_accounts states the track does not report are built here
// (ownAccountQuery, §5.4 gaps).

const (
	uacDisabled    = 0x2
	uacServerTrust = 0x2000
	// adminLockTime is OpenLDAP ppolicy's permanent lock ("disabled").
	adminLockTime = "000001010000Z"
)

func parseInt64(s string) (int64, bool) {
	v, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return v, err == nil
}

func ftString(v int64) string {
	if v <= 0 || v == math.MaxInt64 {
		return ""
	}
	return FiletimeToTime(v).Format(time.RFC3339)
}

// userFilter selects the accounts of a kind (users | computers | all).
func userFilter(st, kind string) string {
	if st == models.ServerTypeAD {
		switch kind {
		case "computers":
			return "(objectClass=computer)"
		case "all":
			return "(|(&(objectCategory=person)(objectClass=user))(objectClass=computer))"
		}
		return "(&(objectCategory=person)(objectClass=user))"
	}
	return "(|(objectClass=inetOrgPerson)(objectClass=posixAccount)(objectClass=person)(objectClass=account))"
}

// displayName is the entry's cn/name/uid/sAMAccountName, else its RDN value.
func displayName(e *models.LDAPEntry, dn string) string {
	for _, a := range []string{"cn", "name", "uid", "sAMAccountName"} {
		if v := attrValue(e, a); v != "" {
			return v
		}
	}
	return rdnValue(dn)
}
