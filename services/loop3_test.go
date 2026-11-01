package services

import (
	"path/filepath"
	"testing"
)

func TestParseXDGDocumentsDir(t *testing.T) {
	home := filepath.FromSlash("/home/anna")
	content := "# comment\nXDG_DESKTOP_DIR=\"$HOME/Schreibtisch\"\nXDG_DOCUMENTS_DIR=\"$HOME/Dokumente\"\n"
	if got := parseXDGDocumentsDir(content, home); got != filepath.Join(home, "Dokumente") {
		t.Errorf("got %q", got)
	}
	if got := parseXDGDocumentsDir("XDG_DOCUMENTS_DIR=\"$HOME/\"\n", home); got != "" {
		t.Errorf("$HOME itself: %q", got)
	}
	if got := parseXDGDocumentsDir("XDG_MUSIC_DIR=\"$HOME/Musik\"\n", home); got != "" {
		t.Errorf("unset: %q", got)
	}
}

func TestExportStartDirectoryPrefersLastFolder(t *testing.T) {
	dir := t.TempDir()
	if got := exportStartDirectory(dir); got != dir {
		t.Errorf("last folder: %q", got)
	}
	if got := exportStartDirectory(filepath.Join(dir, "gone")); got == filepath.Join(dir, "gone") {
		t.Errorf("a missing last folder is not used")
	}
}
