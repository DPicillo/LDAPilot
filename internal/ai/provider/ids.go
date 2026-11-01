package provider

import (
	"crypto/sha256"
	"regexp"
	"strconv"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// idStyle is the tool-call ID format a wire protocol accepts.
type idStyle int

const (
	idStyleOpenAI    idStyle = iota // printable ASCII, 1–64 chars
	idStyleAnthropic                // ^[a-zA-Z0-9_-]{1,64}$
	idStyleAlnum9                   // ^[A-Za-z0-9]{9}$ (Mistral templates)
)

var (
	mistralModelRe = regexp.MustCompile(`(?i)mistral|mixtral|devstral|magistral|ministral|codestral|pixtral`)
	anthropicIDRe  = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
	alnum9Re       = regexp.MustCompile(`^[A-Za-z0-9]{9}$`)
)

// idStyleFor picks the wire-ID style for a request.
func idStyleFor(kind, model, configured string) idStyle {
	if kind == KindAnthropic {
		return idStyleAnthropic
	}
	switch configured {
	case "alnum9":
		return idStyleAlnum9
	case "openai":
		return idStyleOpenAI
	}
	if mistralModelRe.MatchString(model) {
		return idStyleAlnum9
	}
	return idStyleOpenAI
}

func (s idStyle) valid(id string) bool {
	switch s {
	case idStyleAnthropic:
		return anthropicIDRe.MatchString(id)
	case idStyleAlnum9:
		return alnum9Re.MatchString(id)
	default:
		if len(id) == 0 || len(id) > 64 {
			return false
		}
		for i := 0; i < len(id); i++ {
			if id[i] < 0x21 || id[i] > 0x7e {
				return false
			}
		}
		return true
	}
}

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// derive builds a deterministic wire ID from a harness ID.
func (s idStyle) derive(harnessID string, salt int) string {
	in := harnessID
	if salt > 0 {
		in += "#" + strconv.Itoa(salt)
	}
	sum := sha256.Sum256([]byte(in))
	n := 24
	prefix := "call_"
	switch s {
	case idStyleAnthropic:
		prefix = "toolu_"
	case idStyleAlnum9:
		n, prefix = 9, ""
	}
	b := make([]byte, 0, len(prefix)+n)
	b = append(b, prefix...)
	for i := 0; i < n; i++ {
		b = append(b, base62[int(sum[i])%62])
	}
	return string(b)
}

// wireIDs maps harness tool-call IDs to wire IDs for one request. The same
// history always maps to the same wire IDs (cache-friendly). A provider ID
// is reused when it came from the same provider key, fits the style and is
// unique in this request; index-like IDs that repeat across steps are
// therefore replaced.
type wireIDs struct {
	style idStyle
	m     map[string]string
	used  map[string]bool
}

func buildWireIDs(msgs []ai.Message, style idStyle, providerKey string) *wireIDs {
	w := &wireIDs{style: style, m: map[string]string{}, used: map[string]bool{}}
	for mi, m := range msgs {
		if m.Role != ai.RoleAssistant {
			continue
		}
		for bi, b := range m.Blocks {
			if b.Type != ai.BlockToolUse {
				continue
			}
			key := toolUseKey(b, mi, bi)
			if _, ok := w.m[key]; ok {
				continue
			}
			id := ""
			if b.ProviderCallID != "" && ProducerKey(b.Producer) == providerKey && style.valid(b.ProviderCallID) && !w.used[b.ProviderCallID] {
				id = b.ProviderCallID
			} else {
				id = w.fresh(key)
			}
			w.m[key] = id
			w.used[id] = true
		}
	}
	return w
}

func (w *wireIDs) fresh(key string) string {
	for salt := 0; ; salt++ {
		id := w.style.derive(key, salt)
		if !w.used[id] {
			return id
		}
	}
}

// toolUseKey is the harness ID of a tool_use block, or a positional
// fallback for blocks that never got one.
func toolUseKey(b ai.Block, mi, bi int) string {
	if b.ID != "" {
		return b.ID
	}
	if b.ProviderCallID != "" {
		return "provider:" + b.ProviderCallID
	}
	return "pos:" + strconv.Itoa(mi) + ":" + strconv.Itoa(bi)
}

// forUse returns the wire ID of a tool_use block.
func (w *wireIDs) forUse(b ai.Block, mi, bi int) string {
	return w.m[toolUseKey(b, mi, bi)]
}

// forResult returns the wire ID for a tool_result's ToolUseID. Unknown IDs
// (orphans; normally repaired before) get a deterministic fresh ID.
func (w *wireIDs) forResult(toolUseID string) string {
	if id, ok := w.m[toolUseID]; ok {
		return id
	}
	if id, ok := w.m["provider:"+toolUseID]; ok {
		return id
	}
	id := w.fresh(toolUseID)
	w.m[toolUseID] = id
	w.used[id] = true
	return id
}
