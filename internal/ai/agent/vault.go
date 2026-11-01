package agent

import (
	"errors"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// SecretTTL is how long a generated password can be revealed (§6.7).
const SecretTTL = 10 * time.Minute

// ErrSecretGone is returned for a secret that was revealed, expired or
// never existed.
var ErrSecretGone = errors.New("the password is no longer available (already revealed or expired)")

type secret struct {
	chatID, kind, dn string
	value            []byte
	expires          time.Time
}

// Vault keeps generated passwords in memory until they are revealed once.
// Values are zeroed on reveal, expiry, chat deletion and shutdown.
type Vault struct {
	mu    sync.Mutex
	clock ai.Clock
	m     map[string]*secret // toolCallID → secret
}

// NewVault creates a vault.
func NewVault(clock ai.Clock) *Vault {
	return &Vault{clock: clock, m: map[string]*secret{}}
}

// Put stores a secret (the vault takes ownership of value) and returns
// its expiry.
func (v *Vault) Put(toolCallID, chatID, kind, dn string, value []byte) time.Time {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.pruneLocked()
	exp := v.clock.Now().Add(SecretTTL)
	v.m[toolCallID] = &secret{chatID: chatID, kind: kind, dn: dn, value: value, expires: exp}
	return exp
}

// Reveal returns the value once and zeroes it.
func (v *Vault) Reveal(toolCallID string) (ai.SecretValue, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.pruneLocked()
	s := v.m[toolCallID]
	if s == nil {
		return ai.SecretValue{}, ErrSecretGone
	}
	out := ai.SecretValue{Kind: s.kind, DN: s.dn, Value: string(s.value), ExpiresAt: s.expires.UnixMilli()}
	zero(s.value)
	delete(v.m, toolCallID)
	return out, nil
}

// DropChat zeroes the secrets of a chat.
func (v *Vault) DropChat(chatID string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	for id, s := range v.m {
		if s.chatID == chatID {
			zero(s.value)
			delete(v.m, id)
		}
	}
}

// Clear zeroes everything (shutdown).
func (v *Vault) Clear() {
	v.mu.Lock()
	defer v.mu.Unlock()
	for id, s := range v.m {
		zero(s.value)
		delete(v.m, id)
	}
}

func (v *Vault) pruneLocked() {
	now := v.clock.Now()
	for id, s := range v.m {
		if !now.Before(s.expires) {
			zero(s.value)
			delete(v.m, id)
		}
	}
}

func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
