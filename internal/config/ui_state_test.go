package config

import (
	"os"
	"path/filepath"
	"testing"
)

func useTempConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	t.Setenv("APPDATA", dir)
	return dir
}

func TestUIStateRoundTrip(t *testing.T) {
	useTempConfigDir(t)
	if got := LoadUIState(); got.Theme != "" {
		t.Fatalf("missing file: got %+v, want zero value", got)
	}
	if err := SaveUIState(UIState{Theme: "light"}); err != nil {
		t.Fatalf("save: %v", err)
	}
	if got := LoadUIState(); got.Theme != "light" {
		t.Fatalf("got %q, want light", got.Theme)
	}
	if err := SaveUIState(UIState{Theme: "purple"}); err == nil {
		t.Fatal("invalid theme accepted")
	}
	if got := LoadUIState(); got.Theme != "light" {
		t.Fatalf("invalid save changed the file: %q", got.Theme)
	}
}

func TestUIStateBadFile(t *testing.T) {
	useTempConfigDir(t)
	dir, err := ConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, uiStateFileName), []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := LoadUIState(); got.Theme != "" {
		t.Fatalf("bad JSON: got %+v, want zero value", got)
	}
}
