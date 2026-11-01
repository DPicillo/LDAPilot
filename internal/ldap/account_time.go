package ldap

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Time encodings used by account attributes:
//   - AD stores points in time as FILETIME: 100 ns intervals since
//     1601-01-01 UTC (pwdLastSet, lockoutTime, accountExpires, lastLogon...),
//     and durations as negative 100 ns intervals (lockoutDuration, maxPwdAge).
//   - OpenLDAP and 389DS use Generalized Time (pwdChangedTime,
//     pwdAccountLockedTime, accountUnlockTime, passwordExpirationTime) and
//     durations in seconds.

// fileTimeEpochOffset is the number of 100 ns intervals between 1601-01-01
// and 1970-01-01.
const fileTimeEpochOffset int64 = 116444736000000000

// fileTimeNever is the largest FILETIME, AD's "never" for accountExpires and
// msDS-UserPasswordExpiryTimeComputed.
const fileTimeNever int64 = math.MaxInt64

// fileTimeToTime converts a FILETIME to a time. ok is false for 0 and the
// "never" value, which carry no point in time.
func fileTimeToTime(ft int64) (time.Time, bool) {
	if ft <= 0 || ft == fileTimeNever {
		return time.Time{}, false
	}
	unix100ns := ft - fileTimeEpochOffset
	return time.Unix(unix100ns/1e7, (unix100ns%1e7)*100).UTC(), true
}

// timeToFileTime converts a time to a FILETIME.
func timeToFileTime(t time.Time) int64 {
	return t.Unix()*1e7 + int64(t.Nanosecond())/100 + fileTimeEpochOffset
}

// adIntervalSeconds converts an AD duration attribute (negative 100 ns
// intervals, e.g. lockoutDuration, maxPwdAge) to seconds. 0 and the special
// value -2^63 ("never"/"forever") both return 0.
func adIntervalSeconds(v int64) int64 {
	if v == math.MinInt64 || v == 0 {
		return 0
	}
	if v < 0 {
		v = -v
	}
	return v / 1e7
}

// parseInt64 parses a decimal attribute value; ok is false when it is empty
// or not a number.
func parseInt64(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// generalizedTimeZero is the 389DS "no time" value (time_t 0), used for
// "locked forever" (accountUnlockTime) and "password must be changed"
// (passwordExpirationTime).
const generalizedTimeZero = "19700101000000Z"

// ppolicyPermanentLock is the OpenLDAP ppolicy pwdAccountLockedTime value of
// an account locked until an administrator unlocks it.
const ppolicyPermanentLock = "000001010000Z"

// PPolicyPermanentLock is ppolicyPermanentLock for other packages: the
// account panel uses it as "disabled" on OpenLDAP, and every password write
// keeps such accounts disabled (PermanentLockGuard, account_lockguard.go).
const PPolicyPermanentLock = ppolicyPermanentLock

// parseGeneralizedTime parses an LDAP Generalized Time value:
// YYYYMMDDHH[MM[SS[(.|,)fraction]]](Z|(+|-)HH[MM]).
func parseGeneralizedTime(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	bad := func() (time.Time, error) {
		return time.Time{}, fmt.Errorf("invalid generalized time %q", s)
	}
	if len(s) < 11 {
		return bad()
	}
	num := func(from, n int) (int, bool) {
		if from+n > len(s) {
			return 0, false
		}
		v := 0
		for _, ch := range s[from : from+n] {
			if ch < '0' || ch > '9' {
				return 0, false
			}
			v = v*10 + int(ch-'0')
		}
		return v, true
	}
	year, ok1 := num(0, 4)
	month, ok2 := num(4, 2)
	day, ok3 := num(6, 2)
	hour, ok4 := num(8, 2)
	if !(ok1 && ok2 && ok3 && ok4) {
		return bad()
	}
	pos := 10
	minute, sec, nsec := 0, 0, 0
	if v, ok := num(pos, 2); ok {
		minute = v
		pos += 2
		if v, ok := num(pos, 2); ok {
			sec = v
			pos += 2
		}
	}
	if pos < len(s) && (s[pos] == '.' || s[pos] == ',') {
		pos++
		start := pos
		for pos < len(s) && s[pos] >= '0' && s[pos] <= '9' {
			pos++
		}
		frac := s[start:pos]
		if frac == "" {
			return bad()
		}
		if len(frac) > 9 {
			frac = frac[:9]
		}
		f, _ := strconv.Atoi(frac + strings.Repeat("0", 9-len(frac)))
		nsec = f
	}
	if pos >= len(s) {
		return bad()
	}
	loc := time.UTC
	switch s[pos] {
	case 'Z', 'z':
		if pos != len(s)-1 {
			return bad()
		}
	case '+', '-':
		sign := 1
		if s[pos] == '-' {
			sign = -1
		}
		offH, ok := num(pos+1, 2)
		if !ok {
			return bad()
		}
		offM := 0
		rest := len(s) - (pos + 3)
		switch rest {
		case 0:
		case 2:
			if offM, ok = num(pos+3, 2); !ok {
				return bad()
			}
		default:
			return bad()
		}
		loc = time.FixedZone("", sign*(offH*3600+offM*60))
	default:
		return bad()
	}
	if month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || sec > 60 {
		return bad()
	}
	return time.Date(year, time.Month(month), day, hour, minute, sec, nsec, loc).UTC(), nil
}

// formatGeneralizedTime formats t as Generalized Time in UTC (seconds
// precision), e.g. 20261029205856Z.
func formatGeneralizedTime(t time.Time) string {
	return t.UTC().Format("20060102150405Z")
}

// isoTime formats t as RFC 3339 (UTC) for AccountStatus; the zero time gives "".
func isoTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
