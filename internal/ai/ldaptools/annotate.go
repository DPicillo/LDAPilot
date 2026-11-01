package ldaptools

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Value annotation and decoding (§5.1, decode_value). Raw values come
// first so that filters can use them: "<raw> [<readable>]".

const filetimeUnixOffset = 116444736000000000 // 100-ns intervals 1601-01-01 → 1970-01-01

// NeverFILETIME is the "never" value of accountExpires.
const NeverFILETIME = int64(math.MaxInt64)

var filetimeAttrs = toSet("pwdLastSet", "lastLogonTimestamp", "lastLogon", "badPasswordTime", "lockoutTime",
	"accountExpires", "msDS-UserPasswordExpiryTimeComputed", "ms-Mcs-AdmPwdExpirationTime", "msLAPS-PasswordExpirationTime",
	"msDS-LastSuccessfulInteractiveLogonTime", "msDS-LastFailedInteractiveLogonTime")

var durationAttrs = toSet("maxPwdAge", "minPwdAge", "lockoutDuration", "lockOutObservationWindow",
	"msDS-MaximumPasswordAge", "msDS-MinimumPasswordAge", "msDS-LockoutDuration", "msDS-LockoutObservationWindow")

// FiletimeToTime converts a FILETIME to UTC time.
func FiletimeToTime(ft int64) time.Time {
	return time.Unix(0, (ft-filetimeUnixOffset)*100).UTC()
}

// TimeToFiletime converts a time to FILETIME.
func TimeToFiletime(t time.Time) int64 {
	return t.UnixNano()/100 + filetimeUnixOffset
}

// DescribeFiletime renders a FILETIME value for humans.
func DescribeFiletime(attr string, raw string) (string, bool) {
	v, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return "", false
	}
	l := strings.ToLower(attr)
	switch {
	case v == 0 && l == "pwdlastset":
		return "must change at next logon", true
	case v == 0 && l == "lockouttime":
		return "not locked", true
	case (v == 0 || v == NeverFILETIME) && l == "accountexpires":
		return "never", true
	case v == NeverFILETIME:
		return "never", true
	case v == 0:
		return "not set", true
	case v < 0:
		return "", false
	}
	return FiletimeToTime(v).Format(time.RFC3339), true
}

// DescribeDuration renders a negative AD interval.
func DescribeDuration(raw string) (string, bool) {
	v, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return "", false
	}
	if v == math.MinInt64 {
		return "never", true
	}
	if v == 0 {
		return "0 (none)", true
	}
	if v > 0 {
		v = -v
	}
	d := time.Duration(-v) * 100
	return humanDuration(d), true
}

func humanDuration(d time.Duration) string {
	switch {
	case d%(24*time.Hour) == 0:
		n := int(d / (24 * time.Hour))
		return plural(n, "day")
	case d%time.Hour == 0:
		return plural(int(d/time.Hour), "hour")
	case d%time.Minute == 0:
		return plural(int(d/time.Minute), "minute")
	}
	return d.String()
}

func plural(n int, unit string) string {
	if n == 1 {
		return "1 " + unit
	}
	return fmt.Sprintf("%d %ss", n, unit)
}

type flag struct {
	bit  uint64
	name string
}

var uacFlags = []flag{
	{0x1, "SCRIPT"}, {0x2, "ACCOUNTDISABLE"}, {0x8, "HOMEDIR_REQUIRED"}, {0x10, "LOCKOUT"},
	{0x20, "PASSWD_NOTREQD"}, {0x40, "PASSWD_CANT_CHANGE"}, {0x80, "ENCRYPTED_TEXT_PWD_ALLOWED"},
	{0x100, "TEMP_DUPLICATE_ACCOUNT"}, {0x200, "NORMAL_ACCOUNT"}, {0x800, "INTERDOMAIN_TRUST_ACCOUNT"},
	{0x1000, "WORKSTATION_TRUST_ACCOUNT"}, {0x2000, "SERVER_TRUST_ACCOUNT"}, {0x10000, "DONT_EXPIRE_PASSWORD"},
	{0x20000, "MNS_LOGON_ACCOUNT"}, {0x40000, "SMARTCARD_REQUIRED"}, {0x80000, "TRUSTED_FOR_DELEGATION"},
	{0x100000, "NOT_DELEGATED"}, {0x200000, "USE_DES_KEY_ONLY"}, {0x400000, "DONT_REQ_PREAUTH"},
	{0x800000, "PASSWORD_EXPIRED"}, {0x1000000, "TRUSTED_TO_AUTH_FOR_DELEGATION"}, {0x4000000, "PARTIAL_SECRETS_ACCOUNT"},
}

var groupTypeFlags = []flag{
	{0x1, "BUILTIN_LOCAL"}, {0x2, "GLOBAL"}, {0x4, "DOMAIN_LOCAL"}, {0x8, "UNIVERSAL"},
	{0x10, "APP_BASIC"}, {0x20, "APP_QUERY"}, {0x80000000, "SECURITY"},
}

var encTypeFlags = []flag{
	{0x1, "DES-CBC-CRC"}, {0x2, "DES-CBC-MD5"}, {0x4, "RC4-HMAC"}, {0x8, "AES128-CTS-HMAC-SHA1-96"},
	{0x10, "AES256-CTS-HMAC-SHA1-96"}, {0x20, "AES256-CTS-HMAC-SHA1-96-SK"},
}

var samAccountTypes = map[uint64]string{
	0x0: "DOMAIN_OBJECT", 0x10000000: "GROUP_OBJECT (security group)", 0x10000001: "NON_SECURITY_GROUP_OBJECT",
	0x20000000: "ALIAS_OBJECT (domain local security group)", 0x20000001: "NON_SECURITY_ALIAS_OBJECT",
	0x30000000: "USER_OBJECT", 0x30000001: "MACHINE_ACCOUNT", 0x30000002: "TRUST_ACCOUNT",
	0x40000000: "APP_BASIC_GROUP", 0x40000001: "APP_QUERY_GROUP",
}

func parseFlags(raw string) (uint64, bool) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(raw), "0x") {
		v, err := strconv.ParseUint(raw[2:], 16, 64)
		return v, err == nil
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, false
	}
	return uint64(uint32(int32(v))), true // AD stores these as signed 32-bit
}

func describeFlags(v uint64, flags []flag) string {
	var names []string
	rest := v
	for _, f := range flags {
		if v&f.bit != 0 {
			names = append(names, f.name)
			rest &^= f.bit
		}
	}
	if rest != 0 {
		names = append(names, fmt.Sprintf("0x%X", rest))
	}
	if len(names) == 0 {
		return "none"
	}
	return strings.Join(names, " | ")
}

// DescribeGroupType adds the scope/security summary.
func DescribeGroupType(v uint64) string {
	kind := "distribution"
	if v&0x80000000 != 0 {
		kind = "security"
	}
	scope := ""
	switch {
	case v&0x2 != 0:
		scope = "global"
	case v&0x4 != 0:
		scope = "domain local"
	case v&0x8 != 0:
		scope = "universal"
	case v&0x1 != 0:
		scope = "builtin local"
	}
	return strings.TrimSpace(scope+" "+kind) + " (" + describeFlags(v, groupTypeFlags) + ")"
}

// Annotate returns the human-readable form of a well-known AD value ("" if
// none applies).
func Annotate(attr, raw string) string {
	l := strings.ToLower(BaseAttr(attr))
	switch {
	case filetimeAttrs[l]:
		if s, ok := DescribeFiletime(attr, raw); ok {
			return s
		}
	case durationAttrs[l] || strings.HasPrefix(l, "msds-") && strings.HasSuffix(l, "passwordage"):
		if s, ok := DescribeDuration(raw); ok {
			return s
		}
	case l == "useraccountcontrol" || l == "msds-user-account-control-computed":
		if v, ok := parseFlags(raw); ok {
			return describeFlags(v, uacFlags)
		}
	case l == "grouptype":
		if v, ok := parseFlags(raw); ok {
			return DescribeGroupType(v)
		}
	case l == "samaccounttype":
		if v, ok := parseFlags(raw); ok {
			if s, ok := samAccountTypes[v]; ok {
				return s
			}
		}
	case l == "msds-supportedencryptiontypes":
		if v, ok := parseFlags(raw); ok {
			return describeFlags(v, encTypeFlags)
		}
	}
	return ""
}

// --- decode_value ---

// DecodeValue converts a value of the given kind. now is used for
// relative dates ("now-90d").
func DecodeValue(kind, value string, now time.Time) (map[string]any, error) {
	value = strings.TrimSpace(value)
	switch kind {
	case "filetime":
		v, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("a FILETIME is a decimal number such as 133748928000000000")
		}
		out := map[string]any{"raw": value}
		switch {
		case v == 0:
			out["readable"] = "0 (not set; pwdLastSet 0 = must change at next logon; accountExpires 0 = never; lockoutTime 0 = not locked)"
		case v == NeverFILETIME:
			out["readable"] = "never"
		case v < 0:
			if s, ok := DescribeDuration(value); ok {
				out["readable"] = "interval: " + s
			}
		default:
			t := FiletimeToTime(v)
			out["utc"] = t.Format(time.RFC3339)
			out["readable"] = t.Format(time.RFC3339)
		}
		return out, nil
	case "generalized_time":
		t, err := ParseGeneralizedTime(value)
		if err != nil {
			return nil, err
		}
		return map[string]any{"raw": value, "utc": t.UTC().Format(time.RFC3339)}, nil
	case "duration":
		s, ok := DescribeDuration(value)
		if !ok {
			return nil, fmt.Errorf("a duration is a (negative) decimal number of 100-ns intervals, e.g. -36288000000000")
		}
		return map[string]any{"raw": value, "readable": s}, nil
	case "user_account_control", "ms_ds_uac_computed":
		v, ok := parseFlags(value)
		if !ok {
			return nil, fmt.Errorf("expected a decimal or 0x hex number")
		}
		return map[string]any{"raw": value, "flags": describeFlags(v, uacFlags)}, nil
	case "group_type":
		v, ok := parseFlags(value)
		if !ok {
			return nil, fmt.Errorf("expected a decimal or 0x hex number")
		}
		return map[string]any{"raw": value, "readable": DescribeGroupType(v)}, nil
	case "sam_account_type":
		v, ok := parseFlags(value)
		if !ok {
			return nil, fmt.Errorf("expected a decimal or 0x hex number")
		}
		name, ok := samAccountTypes[v]
		if !ok {
			name = fmt.Sprintf("unknown (0x%X)", v)
		}
		return map[string]any{"raw": value, "readable": name}, nil
	case "supported_encryption_types":
		v, ok := parseFlags(value)
		if !ok {
			return nil, fmt.Errorf("expected a decimal or 0x hex number")
		}
		return map[string]any{"raw": value, "readable": describeFlags(v, encTypeFlags)}, nil
	case "sid":
		if strings.HasPrefix(strings.ToUpper(value), "S-1-") {
			return map[string]any{"sid": value}, nil
		}
		b, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			return nil, fmt.Errorf("expected base64 binary or S-1-… text")
		}
		sid, err := SIDString(b)
		if err != nil {
			return nil, err
		}
		return map[string]any{"sid": sid}, nil
	case "guid":
		b, err := base64.StdEncoding.DecodeString(value)
		if err != nil || len(b) != 16 {
			return nil, fmt.Errorf("expected base64 of 16 bytes")
		}
		return map[string]any{"guid": GUIDString(b)}, nil
	case "to_filetime":
		t, err := ParseDate(value, now)
		if err != nil {
			return nil, err
		}
		return map[string]any{"input": value, "utc": t.UTC().Format(time.RFC3339), "filetime": strconv.FormatInt(TimeToFiletime(t), 10)}, nil
	case "to_generalized_time":
		t, err := ParseDate(value, now)
		if err != nil {
			return nil, err
		}
		return map[string]any{"input": value, "utc": t.UTC().Format(time.RFC3339), "generalized_time": t.UTC().Format("20060102150405Z")}, nil
	}
	return nil, fmt.Errorf("unknown kind %q", kind)
}

var relDate = regexp.MustCompile(`^now\s*([+-])\s*(\d+)\s*([dhmwy])$`)

// ParseDate parses "now", "now-90d", "2026-07-31", RFC 3339 or a
// GeneralizedTime.
func ParseDate(s string, now time.Time) (time.Time, error) {
	l := strings.ToLower(strings.TrimSpace(s))
	if l == "now" {
		return now.UTC(), nil
	}
	if m := relDate.FindStringSubmatch(l); m != nil {
		n, _ := strconv.Atoi(m[2])
		var d time.Duration
		switch m[3] {
		case "h":
			d = time.Duration(n) * time.Hour
		case "m":
			d = time.Duration(n) * time.Minute
		case "d":
			d = time.Duration(n) * 24 * time.Hour
		case "w":
			d = time.Duration(n) * 7 * 24 * time.Hour
		case "y":
			d = time.Duration(n) * 365 * 24 * time.Hour
		}
		if m[1] == "-" {
			d = -d
		}
		return now.Add(d).UTC(), nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), nil
		}
	}
	if t, err := ParseGeneralizedTime(s); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("unrecognized date %q (use 2026-07-31, an RFC 3339 time, now, or now-90d)", s)
}

// ParseGeneralizedTime parses LDAP GeneralizedTime.
func ParseGeneralizedTime(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{"20060102150405Z0700", "20060102150405Z", "20060102150405.0Z", "20060102150405.0Z0700", "200601021504Z", "2006010215Z"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), nil
		}
	}
	if i := strings.IndexAny(s, ".,"); i > 0 {
		end := strings.IndexAny(s[i:], "Z+-")
		if end > 0 {
			if t, err := time.Parse("20060102150405Z0700", s[:i]+s[i+end:]); err == nil {
				return t.UTC(), nil
			}
			if t, err := time.Parse("20060102150405Z", s[:i]+s[i+end:]); err == nil {
				return t.UTC(), nil
			}
		}
	}
	return time.Time{}, fmt.Errorf("not a GeneralizedTime (e.g. 20261029120000Z)")
}

// SIDString renders a binary SID.
func SIDString(b []byte) (string, error) {
	if len(b) < 8 || int(b[1])*4+8 != len(b) {
		return "", fmt.Errorf("invalid SID length")
	}
	var auth uint64
	for i := 2; i < 8; i++ {
		auth = auth<<8 | uint64(b[i])
	}
	s := fmt.Sprintf("S-%d-%d", b[0], auth)
	for i := 0; i < int(b[1]); i++ {
		s += fmt.Sprintf("-%d", binary.LittleEndian.Uint32(b[8+4*i:]))
	}
	return s, nil
}

// GUIDString renders a binary GUID (mixed-endian, as AD shows it).
func GUIDString(b []byte) string {
	return fmt.Sprintf("%08x-%04x-%04x-%x-%x", binary.LittleEndian.Uint32(b[0:4]), binary.LittleEndian.Uint16(b[4:6]),
		binary.LittleEndian.Uint16(b[6:8]), b[8:10], b[10:16])
}

// SIDRID returns the last sub-authority of a SID string.
func SIDRID(sid string) (uint32, bool) {
	i := strings.LastIndexByte(sid, '-')
	if i < 0 {
		return 0, false
	}
	v, err := strconv.ParseUint(sid[i+1:], 10, 32)
	return uint32(v), err == nil
}
