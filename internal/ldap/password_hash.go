package ldap

import (
	"crypto/md5"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"fmt"
	"hash"
	"strconv"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/models"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/bcrypt"
)

// Client-side userPassword storage schemes in RFC 2307 "{SCHEME}value"
// form, as verified by OpenLDAP (slapd + contrib/pwmods modules) and 389
// Directory Server.

// Scheme IDs accepted by HashPassword.
const (
	SchemeSSHA         = "SSHA"
	SchemeSSHA256      = "SSHA256"
	SchemeSSHA512      = "SSHA512"
	SchemeSHA          = "SHA"
	SchemeSHA256       = "SHA256"
	SchemeSHA512       = "SHA512"
	SchemeSMD5         = "SMD5"
	SchemeMD5          = "MD5"
	SchemeCryptSHA512  = "CRYPT-SHA512"
	SchemeCryptSHA256  = "CRYPT-SHA256"
	SchemePBKDF2SHA512 = "PBKDF2-SHA512"
	SchemePBKDF2SHA256 = "PBKDF2-SHA256"
	SchemeArgon2       = "ARGON2"
	// SchemeBcrypt is bcrypt in a {CRYPT} tag ("{CRYPT}$2b$10$..."),
	// verified by the server's system crypt(3).
	SchemeBcrypt    = "CRYPT-BCRYPT"
	SchemeCleartext = "CLEARTEXT"

	// DefaultPasswordScheme is the recommended client-side scheme: verified
	// by every OpenLDAP and 389DS installation without extra modules.
	DefaultPasswordScheme = SchemeSSHA
)

// Parameters of the generated hashes.
const (
	// digestSaltLen is the salt length of the salted digest schemes; the
	// value used by slappasswd (pw-sha2) and 389DS.
	digestSaltLen = 8
	// pbkdf2SaltLen: OpenLDAP's pw-pbkdf2 accepts exactly 16 salt bytes;
	// 389DS accepts any length.
	pbkdf2SaltLen    = 16
	pbkdf2Iterations = 100000 // 389DS default
	argon2SaltLen    = 16
	argon2KeyLen     = 32
	argon2Time       = 3
	argon2MemoryKiB  = 64 * 1024
	argon2Threads    = 1
	// bcryptCost is the bcrypt cost (2^10 rounds), the default of Go's
	// bcrypt package and of htpasswd -B.
	bcryptCost = 10
	// bcryptMaxPassword: bcrypt only uses the first 72 bytes of a
	// password; longer ones are refused instead of silently truncated.
	bcryptMaxPassword = 72
)

// adHashedUserPasswordNote is the AD support note of every hashing scheme:
// AD stores userPassword as given, and even with fUserPwdSupport the hash
// string itself would become the password.
const adHashedUserPasswordNote = "never verified: AD takes userPassword (with fUserPwdSupport) as the password itself; use unicodePwd"

// bcrypt389DSNote is the 389DS support note of {CRYPT} bcrypt.
const bcrypt389DSNote = "verified by the system crypt(3) of the {CRYPT} scheme: works with libxcrypt (lab: 389-Directory/3.1.2 on openSUSE binds with {CRYPT}$2b$); not with glibc's own libcrypt"

// passwordSchemes is the catalog shown in the password dialog, strongest
// first within each group. Support notes reflect the lab verification
// (OpenLDAP 2.4.57, 389-Directory/3.1.2) and the servers' documentation.
var passwordSchemes = []models.PasswordScheme{
	{
		ID: SchemeSSHA, Label: "{SSHA} salted SHA-1", Security: "good",
		Description: "Salted SHA-1 with an 8-byte salt. Understood by every OpenLDAP and 389DS installation; the most compatible choice.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemeSSHA512, Label: "{SSHA512} salted SHA-512", Security: "good",
		Description: "Salted SHA-512 with an 8-byte salt.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportModule, Note: "needs the pw-sha2 module (moduleload pw-sha2)"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemeSSHA256, Label: "{SSHA256} salted SHA-256", Security: "good",
		Description: "Salted SHA-256 with an 8-byte salt.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportModule, Note: "needs the pw-sha2 module (moduleload pw-sha2)"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemePBKDF2SHA512, Label: "{PBKDF2-SHA512} 100000 rounds", Security: "strong",
		Description: "PBKDF2-HMAC-SHA512, 100000 iterations, 16-byte salt, in the 389DS/OpenLDAP pw-pbkdf2 format {PBKDF2-SHA512}<iterations>$<salt>$<hash>. Slow to brute-force.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportModule, Note: "needs the pw-pbkdf2 module (moduleload pw-pbkdf2)"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "built in (pwdchan plugin, 389DS 1.4.3+)"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemePBKDF2SHA256, Label: "{PBKDF2-SHA256} 100000 rounds", Security: "strong",
		Description: "PBKDF2-HMAC-SHA256, 100000 iterations, 16-byte salt, in the 389DS/OpenLDAP pw-pbkdf2 format.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportModule, Note: "needs the pw-pbkdf2 module (moduleload pw-pbkdf2)"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "built in (pwdchan plugin, 389DS 1.4.3+)"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemeArgon2, Label: "{ARGON2} argon2id", Security: "strong",
		Description: "Argon2id (m=64 MiB, t=3, p=1) in the OpenLDAP pw-argon2 format {ARGON2}$argon2id$v=19$m=...,t=...,p=...$salt$hash. Memory-hard; verifying costs the server 64 MiB per bind.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportModule, Note: "needs the argon2 password module (OpenLDAP 2.5+: moduleload argon2; 2.4: contrib pw-argon2)"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNone, Note: "not supported"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemeBcrypt, Label: "{CRYPT} bcrypt ($2b$)", Security: "strong",
		Description: "bcrypt with cost 10 (1024 rounds) and a 16-byte salt as {CRYPT}$2b$10$<salt><hash>. Verified by the server's system crypt(3), so it only works where that library has bcrypt (libxcrypt: Debian 11+, Ubuntu 20.04+, RHEL/Rocky 9, Fedora, openSUSE; *BSD); glibc's own libcrypt (Debian 10, RHEL 7) has none. Passwords longer than 72 bytes are refused.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportSystem, Note: "verified by the system crypt(3): needs libxcrypt or a BSD libc (lab: OpenLDAP 2.4.57 on Debian 10 with glibc 2.28 cannot verify it)"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportSystem, Note: bcrypt389DSNote},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemeCryptSHA512, Label: "{CRYPT} SHA-512-crypt ($6$)", Security: "good",
		Description: "crypt(3) SHA-512-crypt, 5000 rounds, 16-character salt. Also usable by PAM/NSS (nss_ldap, sssd) clients.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportNative, Note: "built in via the system crypt(3) (glibc/libxcrypt)"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemeCryptSHA256, Label: "{CRYPT} SHA-256-crypt ($5$)", Security: "good",
		Description: "crypt(3) SHA-256-crypt, 5000 rounds, 16-character salt.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportNative, Note: "built in via the system crypt(3) (glibc/libxcrypt)"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemeSHA512, Label: "{SHA512} unsalted SHA-512", Security: "weak",
		Description: "Unsalted SHA-512: identical passwords give identical hashes. Only for compatibility.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportModule, Note: "needs the pw-sha2 module (moduleload pw-sha2)"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemeSHA256, Label: "{SHA256} unsalted SHA-256", Security: "weak",
		Description: "Unsalted SHA-256. Only for compatibility.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportModule, Note: "needs the pw-sha2 module (moduleload pw-sha2)"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemeSHA, Label: "{SHA} unsalted SHA-1", Security: "weak",
		Description: "Unsalted SHA-1. Only for compatibility with old clients.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemeSMD5, Label: "{SMD5} salted MD5", Security: "weak",
		Description: "Salted MD5. Only for compatibility with old clients.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemeMD5, Label: "{MD5} unsalted MD5", Security: "weak",
		Description: "Unsalted MD5. Trivially crackable; only for compatibility.",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "built in"},
			{Server: models.ServerTypeAD, Level: models.SchemeSupportNone, Note: adHashedUserPasswordNote},
		},
	},
	{
		ID: SchemeCleartext, Label: "Cleartext (no hashing)", Security: "none",
		Description: "Sends the password as is. The server stores it in cleartext unless it hashes cleartext values itself (OpenLDAP ppolicy olcPPolicyHashCleartext, 389DS always).",
		Support: []models.PasswordSchemeSupport{
			{Server: models.ServerTypeOpenLDAP, Level: models.SchemeSupportNative, Note: "stored in cleartext unless ppolicy hashes cleartext (olcPPolicyHashCleartext)"},
			{Server: models.ServerType389DS, Level: models.SchemeSupportNative, Note: "always hashed with the server's passwordStorageScheme"},
		},
	},
}

// PasswordSchemes returns the catalog of client-side userPassword schemes.
func PasswordSchemes() []models.PasswordScheme {
	out := make([]models.PasswordScheme, len(passwordSchemes))
	for i, s := range passwordSchemes {
		s.Support = append([]models.PasswordSchemeSupport(nil), s.Support...)
		out[i] = s
	}
	return out
}

// HashPassword returns the userPassword value for password stored with
// scheme (a Scheme* constant, case-insensitive), with a fresh random salt.
// SchemeCleartext returns the password unchanged.
func HashPassword(scheme, password string) (string, error) {
	switch strings.ToUpper(scheme) {
	case SchemeCleartext:
		return password, nil
	case SchemeSHA:
		return digestHash("{SHA}", sha1.New, password, nil), nil
	case SchemeSHA256:
		return digestHash("{SHA256}", sha256.New, password, nil), nil
	case SchemeSHA512:
		return digestHash("{SHA512}", sha512.New, password, nil), nil
	case SchemeMD5:
		return digestHash("{MD5}", md5.New, password, nil), nil
	case SchemeSSHA:
		return saltedDigestHash("{SSHA}", sha1.New, password)
	case SchemeSSHA256:
		return saltedDigestHash("{SSHA256}", sha256.New, password)
	case SchemeSSHA512:
		return saltedDigestHash("{SSHA512}", sha512.New, password)
	case SchemeSMD5:
		return saltedDigestHash("{SMD5}", md5.New, password)
	case SchemeCryptSHA512, SchemeCryptSHA256:
		salt, err := randomCryptSalt(shaCryptMaxSaltLen)
		if err != nil {
			return "", err
		}
		v := sha512Crypt
		if strings.EqualFold(scheme, SchemeCryptSHA256) {
			v = sha256Crypt
		}
		return "{CRYPT}" + shaCrypt(v, password, salt, 0), nil
	case SchemePBKDF2SHA512, SchemePBKDF2SHA256:
		salt, err := randomBytes(pbkdf2SaltLen)
		if err != nil {
			return "", err
		}
		h, prefix := sha512.New, "{PBKDF2-SHA512}"
		if strings.EqualFold(scheme, SchemePBKDF2SHA256) {
			h, prefix = sha256.New, "{PBKDF2-SHA256}"
		}
		return pbkdf2Hash(prefix, h, password, salt, pbkdf2Iterations)
	case SchemeBcrypt:
		return bcryptHash(password)
	case SchemeArgon2:
		salt, err := randomBytes(argon2SaltLen)
		if err != nil {
			return "", err
		}
		return "{ARGON2}" + argon2idEncode(password, salt, argon2Time, argon2MemoryKiB, argon2Threads, argon2KeyLen), nil
	}
	return "", fmt.Errorf("unknown password scheme %q", scheme)
}

// passwordTag returns the storage scheme tag of a userPassword value (the
// name between the leading braces, as written) and the rest. ok is false
// for a value without a syntactically valid tag: the name must be 1-32
// letters, digits, '-', '_', '.' or '+', and at least one character must
// follow the closing brace. "{SSHA}...", "{crypt}$6$...",
// "{PBKDF2-SHA512}...", "{SASL}user@REALM" have a tag; "{}x",
// "{my secret}x", "{SSHA}" do not. A tag alone does not make a value a
// hash: see classifyPasswordValue.
func passwordTag(value string) (tag, rest string, ok bool) {
	if !strings.HasPrefix(value, "{") {
		return "", "", false
	}
	end := strings.IndexByte(value, '}')
	if end < 2 || end > 33 || end == len(value)-1 {
		return "", "", false
	}
	for _, r := range value[1:end] {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.', r == '+':
		default:
			return "", "", false
		}
	}
	return value[1:end], value[end+1:], true
}

// passwordValueKind classifies a userPassword value (classifyPasswordValue).
type passwordValueKind int

const (
	pwValueEmpty passwordValueKind = iota
	// pwValueCleartext: no "{SCHEME}" prefix.
	pwValueCleartext
	// pwValueHashed: a known storage scheme with a plausible value; kept
	// as is by every write path.
	pwValueHashed
	// pwValueCleartextTag: an explicit cleartext tag ({CLEAR}, {CLEARTEXT},
	// {PLAIN}): the server stores (or compares) the value in cleartext.
	pwValueCleartextTag
	// pwValueUnknownTag: "{word}..." where word is no known storage
	// scheme, e.g. a typed password "{Summer}2026!".
	pwValueUnknownTag
	// pwValueMalformed: a known scheme tag, but the rest is not a value of
	// that scheme ("{SSHA}garbage", "{CRYPT}hunter2").
	pwValueMalformed
)

// cleartextPasswordTags are tags that store the password in cleartext:
// 389DS {CLEAR}, OpenLDAP's {CLEARTEXT} pseudo scheme, {PLAIN} (Dovecot
// and others).
var cleartextPasswordTags = map[string]bool{"CLEAR": true, "CLEARTEXT": true, "PLAIN": true}

// knownPasswordSchemes are the storage schemes a value may carry to count
// as already hashed (upper-case tag → format check, nil = any non-empty
// rest): OpenLDAP built-ins and contrib modules (sha2, pbkdf2, argon2,
// apr1, totp, radius, kerberos, netscape), 389DS (pwdstorage, pwdchan),
// OpenDJ/ForgeRock and ApacheDS. Values with any other tag are treated as
// cleartext passwords: the tag may be part of a typed password, and
// echoing it into labels or logs would leak part of the password.
var knownPasswordSchemes = map[string]func(rest string) bool{
	"SHA": digestValue(20), "SSHA": digestValue(20),
	"SHA256": digestValue(32), "SSHA256": digestValue(32),
	"SHA384": digestValue(48), "SSHA384": digestValue(48),
	"SHA512": digestValue(64), "SSHA512": digestValue(64),
	"MD5": digestValue(16), "SMD5": digestValue(16),
	"CRYPT": cryptValue, "CRYPT-MD5": cryptValue, "CRYPT-SHA256": cryptValue, "CRYPT-SHA512": cryptValue,
	"CRYPT-YESCRYPT": cryptValue, "GOST_YESCRYPT": cryptValue,
	"ARGON2": func(rest string) bool { return strings.HasPrefix(rest, "$argon2") },
	"PBKDF2": nil, "PBKDF2-SHA1": nil, "PBKDF2-SHA256": nil, "PBKDF2-SHA512": nil, "PBKDF2_SHA256": nil,
	"PBKDF2-HMAC-SHA256": nil, "PBKDF2-HMAC-SHA512": nil, "PKCS5S2": nil,
	"BCRYPT": nil, "SCRYPT": nil, "NS-MTA-MD5": nil, "APR1": nil, "BSDMD5": nil, "LANMAN": nil,
	"SASL": nil, "KERBEROS": nil, "K5KEY": nil, "UNIX": nil, "RADIUS": nil,
	"TOTP1": nil, "TOTP256": nil, "TOTP512": nil, "TOTP1ANDPW": nil, "TOTP256ANDPW": nil, "TOTP512ANDPW": nil,
	"AES": nil, "3DES": nil, "BLOWFISH": nil, "RC4": nil,
}

// digestValue checks a {SHA}-family value: base64 of at least size bytes
// (the digest, followed by the salt for the salted variants).
func digestValue(size int) func(string) bool {
	return func(rest string) bool {
		if strings.Trim(rest, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") != "" {
			return false
		}
		raw, err := base64.StdEncoding.DecodeString(rest)
		if err != nil {
			if raw, err = base64.RawStdEncoding.DecodeString(rest); err != nil {
				return false
			}
		}
		return len(raw) >= size
	}
}

// cryptAlphabetChars reports whether s only has crypt(3) salt/hash characters.
func cryptAlphabetChars(s string) bool {
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '/') {
			return false
		}
	}
	return true
}

// cryptValue checks a {CRYPT} value: a modular crypt string "$id$...",
// traditional DES (13 characters), BSDi extended DES ("_" + 19), or a
// locked/disabled marker ("*", "!" or "!" before a hash).
func cryptValue(rest string) bool {
	s := strings.TrimLeft(rest, "!*")
	switch {
	case s == "":
		return true // "*" / "!": locked, never matches
	case s[0] == '$':
		end := strings.IndexByte(s[1:], '$')
		if end < 1 || end > 16 || len(s) <= end+2 {
			return false
		}
		for _, r := range s[1 : end+1] {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
				return false
			}
		}
		return true
	case s[0] == '_':
		return len(s) == 20 && cryptAlphabetChars(s[1:])
	}
	return len(s) == 13 && cryptAlphabetChars(s)
}

// classifyPasswordValue classifies a userPassword value and returns its
// upper-cased tag ("" without one).
func classifyPasswordValue(value string) (passwordValueKind, string) {
	if value == "" {
		return pwValueEmpty, ""
	}
	tag, rest, ok := passwordTag(value)
	if !ok {
		return pwValueCleartext, ""
	}
	tag = strings.ToUpper(tag)
	if cleartextPasswordTags[tag] {
		return pwValueCleartextTag, tag
	}
	check, known := knownPasswordSchemes[tag]
	switch {
	case !known:
		return pwValueUnknownTag, tag
	case check != nil && !check(rest):
		return pwValueMalformed, tag
	}
	return pwValueHashed, tag
}

// IsHashedPasswordValue reports whether a userPassword value already
// carries a storage scheme: a known scheme tag (knownPasswordSchemes,
// case-insensitive: {SSHA}, {crypt}$6$, {CRYPT}$2b$, {PBKDF2-SHA512},
// {SASL}, ...) with a plausible value. Such values are stored as they are
// by every write path. Explicit cleartext tags ({CLEAR}, {CLEARTEXT},
// {PLAIN}), unknown tags ("{Summer}2026!") and malformed values
// ("{SSHA}garbage") are not hashed: they are cleartext passwords.
func IsHashedPasswordValue(value string) bool {
	kind, _ := classifyPasswordValue(value)
	return kind == pwValueHashed
}

// PasswordSchemeOf returns the scheme of a stored userPassword value: the
// upper-cased tag ("SSHA", "PBKDF2-SHA512"), "CRYPT-SHA512"/"CRYPT-SHA256"
// for SHA-crypt and "CRYPT-BCRYPT" for bcrypt values in a {CRYPT} tag,
// "CLEARTEXT" for a value that is not hashed (see IsHashedPasswordValue)
// and "" for an empty value.
func PasswordSchemeOf(value string) string {
	kind, scheme := classifyPasswordValue(value)
	switch kind {
	case pwValueEmpty:
		return ""
	case pwValueHashed:
	default:
		return SchemeCleartext
	}
	if scheme == "CRYPT" {
		_, rest, _ := passwordTag(value)
		if id := cryptVariant(rest); id != "" {
			return id
		}
	}
	return scheme
}

// cryptVariant returns the catalog scheme of a crypt(3) string: SHA-crypt
// ($6$, $5$) or bcrypt ($2a$, $2b$, $2y$); "" for others.
func cryptVariant(s string) string {
	switch {
	case strings.HasPrefix(s, "$6$"):
		return SchemeCryptSHA512
	case strings.HasPrefix(s, "$5$"):
		return SchemeCryptSHA256
	case strings.HasPrefix(s, "$2a$"), strings.HasPrefix(s, "$2b$"), strings.HasPrefix(s, "$2y$"):
		return SchemeBcrypt
	}
	return ""
}

// Labels of stored userPassword values that are not hashed.
const (
	PasswordLabelCleartext     = "cleartext"
	PasswordLabelUnknownScheme = "unknown scheme"
)

// PasswordSchemeLabel describes the scheme of a stored userPassword value
// for display: crypt(3) values in a {CRYPT} tag get the label of the
// matching catalog scheme ("{CRYPT} SHA-512-crypt ($6$)", "{CRYPT} bcrypt
// ($2b$)"), because PasswordSchemeOf returns the internal ids
// CRYPT-SHA512/CRYPT-SHA256/CRYPT-BCRYPT for them; every other hashed
// value shows its tag as stored ("{SSHA}", 389DS's own "{CRYPT-SHA512}").
// "cleartext" for a value without a scheme or with a cleartext tag
// ({CLEAR}, {CLEARTEXT}, {PLAIN}), "unknown scheme" for an unknown tag
// (never the tag itself: it may be part of a typed password), "invalid
// {SSHA}" for a known tag with a value that is not of that scheme, "" for
// an empty value.
func PasswordSchemeLabel(value string) string {
	kind, tag := classifyPasswordValue(value)
	switch kind {
	case pwValueEmpty:
		return ""
	case pwValueCleartext, pwValueCleartextTag:
		return PasswordLabelCleartext
	case pwValueUnknownTag:
		return PasswordLabelUnknownScheme
	case pwValueMalformed:
		return "invalid {" + tag + "}"
	}
	scheme := PasswordSchemeOf(value)
	if tag == "CRYPT" && scheme != "CRYPT" {
		if label := SchemeLabel(scheme); label != "" {
			return label
		}
	}
	return "{" + tag + "}"
}

// SchemeLabel returns the catalog label of a scheme ID ("" when unknown).
func SchemeLabel(id string) string {
	for _, s := range passwordSchemes {
		if strings.EqualFold(s.ID, id) {
			return s.Label
		}
	}
	return ""
}

// bcryptHash returns "{CRYPT}$2b$<cost>$<salt><hash>". Go's bcrypt writes
// the "$2a$" prefix; for passwords up to 72 bytes $2a$ (as implemented by
// Go, without the OpenBSD wrap-around bug) and $2b$ compute the same hash,
// and $2b$ is the prefix libxcrypt and OpenBSD generate today.
func bcryptHash(password string) (string, error) {
	if len(password) > bcryptMaxPassword {
		return "", fmt.Errorf("bcrypt uses at most %d bytes of a password; this one has %d (choose another scheme)", bcryptMaxPassword, len(password))
	}
	h, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", fmt.Errorf("bcrypt: %w", err)
	}
	s := string(h)
	if strings.HasPrefix(s, "$2a$") {
		s = "$2b$" + s[len("$2a$"):]
	}
	return "{CRYPT}" + s, nil
}

// digestHash returns prefix + base64(H(password || salt) || salt).
func digestHash(prefix string, h func() hash.Hash, password string, salt []byte) string {
	d := h()
	d.Write([]byte(password))
	d.Write(salt)
	sum := d.Sum(nil)
	return prefix + base64.StdEncoding.EncodeToString(append(sum, salt...))
}

// saltedDigestHash is digestHash with a random digestSaltLen-byte salt.
func saltedDigestHash(prefix string, h func() hash.Hash, password string) (string, error) {
	salt, err := randomBytes(digestSaltLen)
	if err != nil {
		return "", err
	}
	return digestHash(prefix, h, password, salt), nil
}

// pbkdf2Hash returns prefix + "<iterations>$<b64 salt>$<b64 key>" with
// standard, padded base64 (as written by 389DS; OpenLDAP's pw-pbkdf2 also
// reads it) and a key as long as the digest.
func pbkdf2Hash(prefix string, h func() hash.Hash, password string, salt []byte, iterations int) (string, error) {
	key, err := pbkdf2.Key(h, password, salt, iterations, h().Size())
	if err != nil {
		return "", fmt.Errorf("pbkdf2: %w", err)
	}
	return prefix + strconv.Itoa(iterations) + "$" +
		base64.StdEncoding.EncodeToString(salt) + "$" +
		base64.StdEncoding.EncodeToString(key), nil
}

// argon2idEncode returns the PHC string "$argon2id$v=19$m=..,t=..,p=..$salt$hash"
// with unpadded standard base64, the format of libargon2 and OpenLDAP's
// pw-argon2.
func argon2idEncode(password string, salt []byte, t, mKiB uint32, p uint8, keyLen uint32) string {
	key := argon2.IDKey([]byte(password), salt, t, mKiB, p, keyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, mKiB, t, p,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
}

// randomBytes returns n bytes from the system CSPRNG.
func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, fmt.Errorf("random salt: %w", err)
	}
	return b, nil
}

// randomCryptSalt returns n random characters of the crypt alphabet. The
// alphabet has 64 characters, so the low 6 bits of a random byte are
// uniform.
func randomCryptSalt(n int) (string, error) {
	b, err := randomBytes(n)
	if err != nil {
		return "", err
	}
	for i := range b {
		b[i] = cryptAlphabet[b[i]&0x3f]
	}
	return string(b), nil
}
