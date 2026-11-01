package ldaptools

import (
	"crypto/rand"
	"math/big"
)

// PasswordPlaceholder is shown in previews instead of the value.
const PasswordPlaceholder = "<generated locally after approval>"

// Password alphabet without ambiguous characters (0 O 1 l I).
const (
	pwUpper   = "ABCDEFGHJKLMNPQRSTUVWXYZ"
	pwLower   = "abcdefghijkmnopqrstuvwxyz"
	pwDigits  = "23456789"
	pwSymbols = "!#%+-=?@_"
)

// GeneratePassword returns a random password of length n (16..64) from
// crypto/rand with at least one upper, lower, digit and symbol.
func GeneratePassword(n int) ([]byte, error) {
	if n < 16 {
		n = 16
	}
	if n > 64 {
		n = 64
	}
	all := pwUpper + pwLower + pwDigits + pwSymbols
	pick := func(set string) (byte, error) {
		i, err := rand.Int(rand.Reader, big.NewInt(int64(len(set))))
		if err != nil {
			return 0, err
		}
		return set[i.Int64()], nil
	}
	out := make([]byte, n)
	for i, set := range []string{pwUpper, pwLower, pwDigits, pwSymbols} {
		c, err := pick(set)
		if err != nil {
			return nil, err
		}
		out[i] = c
	}
	for i := 4; i < n; i++ {
		c, err := pick(all)
		if err != nil {
			return nil, err
		}
		out[i] = c
	}
	// Fisher-Yates shuffle.
	for i := n - 1; i > 0; i-- {
		j, err := rand.Int(rand.Reader, big.NewInt(int64(i+1)))
		if err != nil {
			return nil, err
		}
		out[i], out[j.Int64()] = out[j.Int64()], out[i]
	}
	return out, nil
}
