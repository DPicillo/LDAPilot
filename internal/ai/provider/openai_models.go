package provider

import (
	"strings"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// openAIModel is a static capability entry for api.openai.com models,
// keyed by id prefix (longest prefix wins). Values follow OpenAI's public
// model documentation as known at implementation time; they are only a
// fallback, the config override always wins. Verify periodically (§13.3).
type openAIModel struct {
	prefix                  string
	ctx, out                int
	tools, vision, thinking string
}

var openAIModels = []openAIModel{
	{"gpt-5", 400000, 128000, ai.CapYes, ai.CapYes, ai.CapYes},
	{"gpt-5-chat", 128000, 16384, ai.CapYes, ai.CapYes, ai.CapNo},
	{"gpt-4.1", 1047576, 32768, ai.CapYes, ai.CapYes, ai.CapNo},
	{"gpt-4o", 128000, 16384, ai.CapYes, ai.CapYes, ai.CapNo},
	{"gpt-4o-mini", 128000, 16384, ai.CapYes, ai.CapYes, ai.CapNo},
	{"chatgpt-4o", 128000, 16384, ai.CapNo, ai.CapYes, ai.CapNo},
	{"gpt-4-turbo", 128000, 4096, ai.CapYes, ai.CapYes, ai.CapNo},
	{"gpt-4", 8192, 8192, ai.CapYes, ai.CapNo, ai.CapNo},
	{"gpt-3.5-turbo", 16385, 4096, ai.CapYes, ai.CapNo, ai.CapNo},
	{"o1", 200000, 100000, ai.CapYes, ai.CapYes, ai.CapYes},
	{"o3", 200000, 100000, ai.CapYes, ai.CapYes, ai.CapYes},
	{"o4-mini", 200000, 100000, ai.CapYes, ai.CapYes, ai.CapYes},
	{"gpt-oss", 131072, 131072, ai.CapYes, ai.CapNo, ai.CapYes},
}

func openAIModelTable(id string) (openAIModel, bool) {
	best := -1
	for i, m := range openAIModels {
		if strings.HasPrefix(id, m.prefix) && (best < 0 || len(m.prefix) > len(openAIModels[best].prefix)) {
			best = i
		}
	}
	if best < 0 {
		return openAIModel{}, false
	}
	return openAIModels[best], true
}
