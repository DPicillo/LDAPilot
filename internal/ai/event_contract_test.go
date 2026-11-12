package ai_test

// Go/TS drift guard (§12.10). The test builds one fully populated payload
// per event name and per facade view type (every field set, every optional
// field present, every slice with one element) and compares it with
// frontend/src/types/ai.events.golden.json. frontend/src/types/ai.contract.ts
// checks the same JSON against the TypeScript types at compile time, so a
// field added, removed, renamed or retyped on either side fails `tsc` or
// this test.
//
// Regenerate after an intended change:
//
//	go test ./internal/ai -run TestEventContractGolden -update

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/config"
)

var updateGolden = flag.Bool("update", false, "rewrite frontend/src/types/ai.events.golden.json")

const goldenPath = "../../frontend/src/types/ai.events.golden.json"

// contractEvents maps every event name to its payload type.
func contractEvents() map[string]any {
	return map[string]any{
		ai.EventRunStarted:       &ai.RunStartedEvent{},
		ai.EventMessageStarted:   &ai.MessageStartedEvent{},
		ai.EventTextDelta:        &ai.DeltaEvent{},
		ai.EventThinkingDelta:    &ai.DeltaEvent{},
		ai.EventTextReplaced:     &ai.DeltaEvent{},
		ai.EventStepDiscarded:    &ai.StepDiscardedEvent{},
		ai.EventToolStart:        &ai.ToolStartEvent{},
		ai.EventToolUpdate:       &ai.ToolUpdateEvent{},
		ai.EventToolEnd:          &ai.ToolEndEvent{},
		ai.EventApprovalRequest:  &ai.ApprovalRequest{},
		ai.EventApprovalResolved: &ai.ApprovalResolvedEvent{},
		ai.EventSecretAvailable:  &ai.SecretAvailableEvent{},
		ai.EventUsage:            &ai.UsageEvent{},
		ai.EventStatus:           &ai.StatusEvent{},
		ai.EventError:            &ai.ErrorEvent{},
		ai.EventDone:             &ai.DoneEvent{},
		ai.EventChatUpdated:      &ai.ChatUpdatedEvent{},
		ai.EventModelsUpdated:    &ai.ModelsUpdatedEvent{},
		ai.EventConfigUpdated:    &ai.ConfigUpdatedEvent{},
		ai.EventGrantsUpdated:    &ai.GrantsUpdatedEvent{},
	}
}

// contractViews maps the facade's argument and return types to their TS
// names.
func contractViews() map[string]any {
	return map[string]any{
		"Message":            &ai.Message{},
		"ChatSummary":        &ai.ChatSummary{},
		"ChatView":           &ai.ChatView{},
		"RunSnapshot":        &ai.RunSnapshot{},
		"ContextInfo":        &ai.ContextInfo{},
		"ModelDiscovery":     &ai.ModelDiscovery{},
		"ClaudeCodeHosts":    &ai.ClaudeCodeHosts{},
		"ProviderTestResult": &ai.ProviderTestResult{},
		"ApprovalResult":     &ai.ApprovalResult{},
		"SecretValue":        &ai.SecretValue{},
		"Grant":              &ai.Grant{},
		"SendRequest":        &ai.SendRequest{},
		"SendResult":         &ai.SendResult{},
		"AIConfig":           &config.AIConfig{},
	}
}

// fill sets every field of v (recursively) to a non-zero value.
func fill(v reflect.Value, depth int) {
	switch v.Kind() {
	case reflect.Pointer:
		if depth > 40 { // no AI type is recursive; this only guards against a future cycle
			return
		}
		if v.IsNil() {
			v.Set(reflect.New(v.Type().Elem()))
		}
		fill(v.Elem(), depth+1)
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				fill(v.Field(i), depth+1)
			}
		}
	case reflect.Slice:
		if v.Type() == reflect.TypeFor[json.RawMessage]() {
			v.Set(reflect.ValueOf(json.RawMessage(`{"key":"value"}`)))
			return
		}
		s := reflect.MakeSlice(v.Type(), 1, 1)
		fill(s.Index(0), depth+1)
		v.Set(s)
	case reflect.Map:
		m := reflect.MakeMap(v.Type())
		k := reflect.New(v.Type().Key()).Elem()
		fill(k, depth+1)
		e := reflect.New(v.Type().Elem()).Elem()
		fill(e, depth+1)
		m.SetMapIndex(k, e)
		v.Set(m)
	case reflect.String:
		v.SetString("x")
	case reflect.Bool:
		v.SetBool(true)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		v.SetInt(1)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		v.SetUint(1)
	case reflect.Float32, reflect.Float64:
		v.SetFloat(1.5)
	}
}

func buildGolden(t *testing.T) []byte {
	t.Helper()
	section := func(m map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range m {
			fill(reflect.ValueOf(v), 0)
			out[k] = v
		}
		return out
	}
	doc := map[string]any{"events": section(contractEvents()), "views": section(contractViews())}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return append(b, '\n')
}

func TestEventContractGolden(t *testing.T) {
	got := buildGolden(t)
	path := filepath.FromSlash(goldenPath)
	if *updateGolden {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden (run with -update to create it): %v", err)
	}
	if !bytes.Equal(bytes.ReplaceAll(want, []byte("\r\n"), []byte("\n")), got) {
		t.Fatalf("event/view contract changed: update frontend/src/types/ai.ts, then run `go test ./internal/ai -run TestEventContractGolden -update` and `npx tsc --noEmit` in frontend/")
	}
}

// Every payload must serialize every field (no field may be dropped by
// omitempty once set), otherwise the golden would not show it to tsc.
func TestEventContractCoversAllFields(t *testing.T) {
	var doc struct {
		Events map[string]map[string]any `json:"events"`
	}
	if err := json.Unmarshal(buildGolden(t), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Events) != len(contractEvents()) {
		t.Fatalf("events: got %d, want %d", len(doc.Events), len(contractEvents()))
	}
	for name, p := range doc.Events {
		switch name {
		case ai.EventChatUpdated, ai.EventModelsUpdated, ai.EventConfigUpdated, ai.EventGrantsUpdated:
			if _, ok := p["seq"]; ok {
				t.Errorf("%s must not carry the run envelope", name)
			}
		default:
			for _, k := range []string{"chatId", "runId", "seq", "ts"} {
				if _, ok := p[k]; !ok {
					t.Errorf("%s lacks envelope field %s", name, k)
				}
			}
		}
	}
}
