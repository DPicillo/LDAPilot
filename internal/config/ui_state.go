package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const uiStateFileName = "ui_state.json"

// UIState holds the few UI settings the backend needs before the frontend
// has loaded: the resolved colour theme of the last run, so the native
// window opens with the matching background colour (no dark flash on a
// light theme and vice versa). The frontend keeps its own preferences in
// localStorage; this file only mirrors what it resolved to.
type UIState struct {
	// Theme is "dark" or "light"; anything else means dark.
	Theme string `json:"theme"`
}

func uiStatePath() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, uiStateFileName), nil
}

// LoadUIState reads the UI state; a missing or unreadable file gives the
// zero value (dark).
func LoadUIState() UIState {
	path, err := uiStatePath()
	if err != nil {
		return UIState{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return UIState{}
	}
	var s UIState
	if json.Unmarshal(data, &s) != nil {
		return UIState{}
	}
	return s
}

// SaveUIState writes the UI state. Theme must be "dark" or "light".
func SaveUIState(s UIState) error {
	if s.Theme != "dark" && s.Theme != "light" {
		return fmt.Errorf("invalid theme %q", s.Theme)
	}
	path, err := uiStatePath()
	if err != nil {
		return err
	}
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}
