//go:build linux

package main

import "testing"

// Wails sets linux.Options.ProgramName only after the window exists, so the
// X11 window class would still follow the binary name ("ldapilot"); the
// program name is therefore set before GTK starts.
func TestProgramNameSetBeforeGTK(t *testing.T) {
	if got := currentProgramName(); got != appID {
		t.Fatalf("g_get_prgname() = %q, want %q", got, appID)
	}
}
