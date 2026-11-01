package tools

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

var testSchema = Obj(
	P("connection", Str("c")),
	R("dn", Str("dn")),
	P("limit", Int("l", 1, 200, 25)),
	P("flag", Bool("f", false)),
	P("attrs", Arr("a", Str(""), 3)),
	P("scope", Enum("s", "sub", "base", "one", "sub")),
)

func TestValidateCoercion(t *testing.T) {
	a, notes, err := Validate(testSchema, json.RawMessage(`{"dn":"CN=a⁠b","limit":"10","flag":"true","attrs":"cn","scope":"ONE","extra":1,"connection":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if a.Str("dn") != "CN=ab" || a.Int("limit", 0) != 10 || !a.Bool("flag", false) || a.Strings("attrs")[0] != "cn" || a.Str("scope") != "one" || a.Has("connection") {
		t.Fatalf("%+v", a)
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "extra") {
		t.Fatal(notes)
	}
	for _, bad := range []string{`{}`, `{"dn":"x","limit":0}`, `{"dn":"x","limit":1.5}`, `{"dn":"x","scope":"tree"}`, `{"dn":"x","attrs":["a","b","c","d"]}`, `[]`, `"x"`} {
		if _, _, err := Validate(testSchema, json.RawMessage(bad)); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
	if ex := Example("get_entry", testSchema); !strings.Contains(ex, `"dn":"CN=`) {
		t.Fatal(ex)
	}
}

func TestSchemaSubset(t *testing.T) {
	b, _ := json.Marshal(testSchema)
	s := string(b)
	for _, banned := range []string{"oneOf", "anyOf", "$ref", "format", "pattern"} {
		if strings.Contains(s, banned) {
			t.Fatalf("schema contains %s: %s", banned, s)
		}
	}
	if !strings.Contains(s, `"additionalProperties":false`) || !strings.Contains(s, `"required":["dn"]`) {
		t.Fatal(s)
	}
	spec := (&Def{Name: "x", Params: testSchema, Directory: true}).Spec([]string{"A", "B"})
	if !strings.Contains(string(spec.Parameters), `"enum":["A","B"]`) {
		t.Fatal(string(spec.Parameters))
	}
}

func TestRenderShorteningStaysValid(t *testing.T) {
	var items []any
	for i := 0; i < 50; i++ {
		items = append(items, Fs("dn", strings.Repeat("ü", 40), "n", i))
	}
	r := &Result{OK: true, Tool: "t", Fields: Fs("a", 1), List: &List{Key: "entries", Items: items, Total: -1}}
	full := r.Render(0)
	for _, capChars := range []int{4000, 1500, 600, 300} {
		out := r.Render(capChars)
		var v map[string]any
		if err := json.Unmarshal([]byte(out), &v); err != nil || !utf8.ValidString(out) {
			t.Fatalf("cap %d: invalid JSON %v", capChars, err)
		}
		if len(out) > capChars && !strings.Contains(out, "RESULT_TOO_LARGE") {
			t.Fatalf("cap %d exceeded: %d", capChars, len(out))
		}
	}
	if len(full) < 4000 {
		t.Fatal("test data too small")
	}
	if got := TruncateRunes(strings.Repeat("ä", 10), 3); got != "äää…(+7 chars)" {
		t.Fatal(got)
	}
}

func TestShownAfterBudgetRender(t *testing.T) {
	items := make([]any, 50)
	for i := range items {
		items[i] = Fs("dn", strings.Repeat("x", 80))
	}
	r := &Result{OK: true, Tool: "get_children", List: &List{Key: "children", Items: items, Total: -1}}
	r.Render(0)
	if shown, total, ok := r.Shown(); !ok || shown != 50 || total != 50 {
		t.Fatal(shown, total, ok)
	}
	out := r.Render(1200)
	shown, total, _ := r.Shown()
	if shown >= total || shown == 0 || !json.Valid([]byte(out)) || !strings.Contains(out, `"returned":`) {
		t.Fatalf("shown %d of %d: %s", shown, total, out)
	}
	if _, _, ok := Errorf("x", ErrLDAP, "", "boom").Shown(); ok {
		t.Fatal("error result reports a list")
	}
}
