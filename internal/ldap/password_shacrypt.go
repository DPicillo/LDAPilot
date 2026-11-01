package ldap

import (
	"crypto/sha256"
	"crypto/sha512"
	"fmt"
	"hash"
	"strconv"
	"strings"
)

// SHA-crypt ($5$ SHA-256-crypt and $6$ SHA-512-crypt) as specified by
// Ulrich Drepper ("Unix crypt using SHA-256 and SHA-512", the algorithm of
// glibc/libxcrypt crypt(3)). Used for {CRYPT} userPassword values.

const (
	shaCryptDefaultRounds = 5000
	shaCryptMinRounds     = 1000
	shaCryptMaxRounds     = 999999999
	shaCryptMaxSaltLen    = 16
	// cryptAlphabet is the crypt(3) base64 alphabet, also the salt alphabet.
	cryptAlphabet = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
)

// shaCryptVariant holds the per-hash parameters of SHA-crypt.
type shaCryptVariant struct {
	magic string // "$5$" or "$6$"
	size  int    // digest size in bytes
	hash  func() hash.Hash
	// order lists the digest bytes in output order, three per base64 group
	// (most significant first); the final, partial group is handled by the
	// encoder.
	order []int
}

var (
	sha256Crypt = shaCryptVariant{
		magic: "$5$", size: sha256.Size, hash: sha256.New,
		order: []int{
			0, 10, 20, 21, 1, 11, 12, 22, 2, 3, 13, 23, 24, 4, 14,
			15, 25, 5, 6, 16, 26, 27, 7, 17, 18, 28, 8, 9, 19, 29,
			// final group: 0, 31, 30 (3 characters)
			31, 30,
		},
	}
	sha512Crypt = shaCryptVariant{
		magic: "$6$", size: sha512.Size, hash: sha512.New,
		order: []int{
			0, 21, 42, 22, 43, 1, 44, 2, 23, 3, 24, 45, 25, 46, 4,
			47, 5, 26, 6, 27, 48, 28, 49, 7, 50, 8, 29, 9, 30, 51,
			31, 52, 10, 53, 11, 32, 12, 33, 54, 34, 55, 13, 56, 14, 35,
			15, 36, 57, 37, 58, 16, 59, 17, 38, 18, 39, 60, 40, 61, 19,
			62, 20, 41,
			// final group: 0, 0, 63 (2 characters)
			63,
		},
	}
)

// shaCrypt computes a SHA-crypt hash of password. salt is truncated to 16
// characters. rounds 0 means the default (5000, not written to the output);
// other values are clamped to [1000, 999999999] and written as "rounds=N$".
func shaCrypt(v shaCryptVariant, password, salt string, rounds int) string {
	if len(salt) > shaCryptMaxSaltLen {
		salt = salt[:shaCryptMaxSaltLen]
	}
	customRounds := rounds != 0
	if !customRounds {
		rounds = shaCryptDefaultRounds
	}
	rounds = max(shaCryptMinRounds, min(rounds, shaCryptMaxRounds))

	key, s := []byte(password), []byte(salt)

	// Digest B = H(key salt key).
	alt := v.hash()
	alt.Write(key)
	alt.Write(s)
	alt.Write(key)
	altResult := alt.Sum(nil)

	// Digest A = H(key salt B... bits-of-len(key)).
	ctx := v.hash()
	ctx.Write(key)
	ctx.Write(s)
	cnt := len(key)
	for ; cnt > v.size; cnt -= v.size {
		ctx.Write(altResult)
	}
	ctx.Write(altResult[:cnt])
	for cnt = len(key); cnt > 0; cnt >>= 1 {
		if cnt&1 != 0 {
			ctx.Write(altResult)
		} else {
			ctx.Write(key)
		}
	}
	altResult = ctx.Sum(nil)

	// Sequence P: H(key repeated len(key) times), stretched to len(key).
	dp := v.hash()
	for range len(key) {
		dp.Write(key)
	}
	pBytes := repeatToLen(dp.Sum(nil), len(key))

	// Sequence S: H(salt repeated 16+A[0] times), stretched to len(salt).
	ds := v.hash()
	for range 16 + int(altResult[0]) {
		ds.Write(s)
	}
	sBytes := repeatToLen(ds.Sum(nil), len(s))

	for r := range rounds {
		c := v.hash()
		if r&1 != 0 {
			c.Write(pBytes)
		} else {
			c.Write(altResult)
		}
		if r%3 != 0 {
			c.Write(sBytes)
		}
		if r%7 != 0 {
			c.Write(pBytes)
		}
		if r&1 != 0 {
			c.Write(altResult)
		} else {
			c.Write(pBytes)
		}
		altResult = c.Sum(nil)
	}

	var b strings.Builder
	b.WriteString(v.magic)
	if customRounds {
		b.WriteString("rounds=" + strconv.Itoa(rounds) + "$")
	}
	b.WriteString(salt)
	b.WriteByte('$')
	b.WriteString(shaCryptEncode(v, altResult))
	return b.String()
}

// repeatToLen returns digest repeated (and truncated) to n bytes.
func repeatToLen(digest []byte, n int) []byte {
	out := make([]byte, 0, n)
	for len(out) < n {
		out = append(out, digest[:min(len(digest), n-len(out))]...)
	}
	return out
}

// shaCryptEncode encodes the final digest with the crypt base64 alphabet in
// the byte order of the variant.
func shaCryptEncode(v shaCryptVariant, d []byte) string {
	var b strings.Builder
	emit := func(w uint32, n int) {
		for range n {
			b.WriteByte(cryptAlphabet[w&0x3f])
			w >>= 6
		}
	}
	o := v.order
	// SHA-256: 10 full groups and a 2-byte tail (3 characters);
	// SHA-512: 21 full groups and a 1-byte tail (2 characters).
	full := v.size / 3 * 3
	for i := 0; i < full; i += 3 {
		emit(uint32(d[o[i]])<<16|uint32(d[o[i+1]])<<8|uint32(d[o[i+2]]), 4)
	}
	if v.size%3 == 2 {
		emit(uint32(d[o[full]])<<8|uint32(d[o[full+1]]), 3)
	} else {
		emit(uint32(d[o[full]]), 2)
	}
	return b.String()
}

// parseShaCrypt splits a "$5$[rounds=N$]salt$hash" or "$6$..." string into
// its variant, salt and rounds (0 when not given).
func parseShaCrypt(s string) (v shaCryptVariant, salt string, rounds int, err error) {
	switch {
	case strings.HasPrefix(s, "$5$"):
		v = sha256Crypt
	case strings.HasPrefix(s, "$6$"):
		v = sha512Crypt
	default:
		return v, "", 0, fmt.Errorf("not a SHA-crypt hash")
	}
	rest := s[3:]
	if strings.HasPrefix(rest, "rounds=") {
		end := strings.IndexByte(rest, '$')
		if end < 0 {
			return v, "", 0, fmt.Errorf("malformed rounds")
		}
		rounds, err = strconv.Atoi(rest[len("rounds="):end])
		if err != nil {
			return v, "", 0, fmt.Errorf("malformed rounds: %v", err)
		}
		rest = rest[end+1:]
	}
	end := strings.IndexByte(rest, '$')
	if end < 0 {
		return v, "", 0, fmt.Errorf("missing hash")
	}
	return v, rest[:end], rounds, nil
}
