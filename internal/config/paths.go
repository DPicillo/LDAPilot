package config

import (
	"os"
	"path/filepath"
)

const appName = "LDAPilot"
const connectionsFileName = "connections.json"

// ConfigDir returns the path to the LDAPilot configuration directory.
// It creates the directory if it does not already exist.
func ConfigDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, appName)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return dir, nil
}

// ConnectionsFilePath returns the full path to the connections JSON file.
func ConnectionsFilePath() (string, error) {
	dir, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, connectionsFileName), nil
}
