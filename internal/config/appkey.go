package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// ErrKeyUnavailable is returned (wrapped, with the reason) when the
// application's encryption key cannot be read. LDAPilot then fails closed:
// the key is never regenerated, because a new key would make every stored
// connection password, API key and chat permanently unreadable.
var ErrKeyUnavailable = errors.New("encryption key unavailable")

const appKeySize = 32

var (
	appKeyMu     sync.Mutex
	appKeyCached []byte
)

// AppKey returns a copy of the 32-byte application key stored in
// <ConfigDir>/key. It is the single accessor for every secret LDAPilot
// encrypts at rest (connection passwords, AI API keys, chats).
//
//   - An existing key file of exactly 32 bytes is loaded and cached.
//   - Any read error or a wrong length returns ErrKeyUnavailable. The file is
//     never touched in that case.
//   - Only a missing file (fs.ErrNotExist) leads to creating a new key. The
//     key is published with os.Link from an O_EXCL temp file, so a key that
//     another process created in the meantime is never replaced; the file
//     on disk is re-read and used afterwards.
func AppKey() ([]byte, error) {
	appKeyMu.Lock()
	defer appKeyMu.Unlock()
	if appKeyCached != nil {
		return append([]byte(nil), appKeyCached...), nil
	}
	dir, err := ConfigDir()
	if err != nil {
		return nil, fmt.Errorf("%w (config directory: %v)", ErrKeyUnavailable, err)
	}
	key, err := loadOrCreateKey(dir)
	if err != nil {
		return nil, err
	}
	appKeyCached = key
	return append([]byte(nil), key...), nil
}

// AppKeyPath returns the path of the key file (for error messages).
func AppKeyPath() string {
	dir, err := ConfigDir()
	if err != nil {
		return keyFileName
	}
	return filepath.Join(dir, keyFileName)
}

// resetAppKeyCache drops the cached key. Tests only.
func resetAppKeyCache() {
	appKeyMu.Lock()
	appKeyCached = nil
	appKeyMu.Unlock()
}

// beforeKeyPublish is a test hook that runs between generating a new key
// and publishing it (simulates another process winning the race).
var beforeKeyPublish = func(path string) {}

// shortKeyWait bounds how long a reader waits for a key file that is still
// being written by another process (O_EXCL fallback path).
var shortKeyWait = time.Second

func loadOrCreateKey(dir string) ([]byte, error) {
	path := filepath.Join(dir, keyFileName)
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		return checkKeyLength(path, data)
	case !errors.Is(err, fs.ErrNotExist):
		return nil, fmt.Errorf("%w (%s: %v)", ErrKeyUnavailable, path, err)
	}

	// The key does not exist yet: create it without ever replacing a file
	// that another process may have published in the meantime.
	if err := createKeyFile(dir, path); err != nil {
		return nil, err
	}
	data, err = os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%w (%s: %v)", ErrKeyUnavailable, path, err)
	}
	return checkKeyLength(path, data)
}

// checkKeyLength accepts exactly 32 bytes. A shorter file may be a key that
// another process is still writing (filesystems without hard links), so the
// read is retried for up to shortKeyWait before failing closed.
func checkKeyLength(path string, data []byte) ([]byte, error) {
	deadline := time.Now().Add(shortKeyWait)
	for len(data) < appKeySize && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		again, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("%w (%s: %v)", ErrKeyUnavailable, path, err)
		}
		data = again
	}
	if len(data) != appKeySize {
		return nil, fmt.Errorf("%w (%s: the file has %d bytes, expected %d)", ErrKeyUnavailable, path, len(data), appKeySize)
	}
	return data, nil
}

func createKeyFile(dir, path string) error {
	key := make([]byte, appKeySize)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return fmt.Errorf("%w (generating a key: %v)", ErrKeyUnavailable, err)
	}
	suffix := make([]byte, 8)
	if _, err := io.ReadFull(rand.Reader, suffix); err != nil {
		return fmt.Errorf("%w (generating a key: %v)", ErrKeyUnavailable, err)
	}
	tmp := path + ".tmp-" + hex.EncodeToString(suffix)
	if err := writeNewFile(tmp, key); err != nil {
		return fmt.Errorf("%w (%s: %v)", ErrKeyUnavailable, tmp, err)
	}
	beforeKeyPublish(path)
	linkErr := os.Link(tmp, path)
	_ = os.Remove(tmp)
	if linkErr != nil && !errors.Is(linkErr, fs.ErrExist) {
		// No hard links on this filesystem: create the key file itself with
		// O_EXCL. That still never replaces an existing key.
		if err := writeNewFile(path, key); err != nil && !errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("%w (%s: %v)", ErrKeyUnavailable, path, err)
		}
	}
	syncDir(dir)
	return nil
}

// writeNewFile creates name exclusively (0600), writes data and fsyncs it.
func writeNewFile(name string, data []byte) error {
	f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		_ = os.Remove(name)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		_ = os.Remove(name)
		return err
	}
	return f.Close()
}

// syncDir fsyncs a directory so that a rename or link is durable. It is a
// no-op on Windows, where directories cannot be opened for syncing.
func syncDir(dir string) {
	if runtime.GOOS == "windows" {
		return
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
}
