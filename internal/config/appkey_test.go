package config

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// withTempConfig points ConfigDir at a temp directory and clears the key
// cache.
func withTempConfig(t *testing.T) string {
	t.Helper()
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", base)
	t.Setenv("HOME", base)
	resetAppKeyCache()
	t.Cleanup(resetAppKeyCache)
	dir, err := ConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestAppKeyConcurrentCreate(t *testing.T) {
	dir := withTempConfig(t)
	var wg sync.WaitGroup
	keys := make([][]byte, 16)
	for i := range keys {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Bypass the cache: every goroutine runs the create path.
			k, err := loadOrCreateKey(dir)
			if err != nil {
				t.Error(err)
			}
			keys[i] = k
		}(i)
	}
	wg.Wait()
	onDisk, _ := os.ReadFile(filepath.Join(dir, keyFileName))
	for i, k := range keys {
		if !bytes.Equal(k, onDisk) || len(k) != 32 {
			t.Fatalf("goroutine %d got a different key", i)
		}
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != keyFileName {
			t.Fatalf("leftover %s", e.Name())
		}
	}
}

func TestAppKeyOtherProcessWinsRace(t *testing.T) {
	dir := withTempConfig(t)
	theirs := bytes.Repeat([]byte{7}, 32)
	beforeKeyPublish = func(path string) { _ = os.WriteFile(path, theirs, 0o600) }
	t.Cleanup(func() { beforeKeyPublish = func(string) {} })
	k, err := AppKey()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(k, theirs) {
		t.Fatal("our key replaced the other process's key")
	}
	if onDisk, _ := os.ReadFile(filepath.Join(dir, keyFileName)); !bytes.Equal(onDisk, theirs) {
		t.Fatal("key file overwritten")
	}
}

func TestAppKeyFailsClosed(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read mode 000 files")
	}
	old := shortKeyWait
	shortKeyWait = 100 * time.Millisecond
	t.Cleanup(func() { shortKeyWait = old })

	dir := withTempConfig(t)
	path := filepath.Join(dir, keyFileName)

	// Wrong length.
	short := []byte("too short")
	os.WriteFile(path, short, 0o600)
	if _, err := AppKey(); !errors.Is(err, ErrKeyUnavailable) {
		t.Fatalf("short key: %v", err)
	}
	if b, _ := os.ReadFile(path); !bytes.Equal(b, short) {
		t.Fatal("short key file changed")
	}
	// EncryptPassword now fails closed instead of regenerating.
	if _, err := EncryptPassword("pw"); !errors.Is(err, ErrKeyUnavailable) {
		t.Fatalf("EncryptPassword: %v", err)
	}
	if b, _ := os.ReadFile(path); !bytes.Equal(b, short) {
		t.Fatal("EncryptPassword regenerated the key")
	}

	// Unreadable key.
	good := bytes.Repeat([]byte{9}, 32)
	os.WriteFile(path, good, 0o600)
	os.Chmod(path, 0)
	t.Cleanup(func() { os.Chmod(path, 0o600) })
	resetAppKeyCache()
	if _, err := AppKey(); !errors.Is(err, ErrKeyUnavailable) {
		t.Fatalf("unreadable key: %v", err)
	}
	os.Chmod(path, 0o600)
	if b, _ := os.ReadFile(path); !bytes.Equal(b, good) {
		t.Fatal("unreadable key file changed")
	}
	// Readable again → works, and passwords round-trip.
	resetAppKeyCache()
	enc, err := EncryptPassword("secret")
	if err != nil {
		t.Fatal(err)
	}
	if dec, err := DecryptPassword(enc); err != nil || dec != "secret" {
		t.Fatalf("%q %v", dec, err)
	}
}

func TestSealOpenAAD(t *testing.T) {
	withTempConfig(t)
	sealed, err := SealWithAppKey([]byte("hello"), []byte("aad-1"))
	if err != nil {
		t.Fatal(err)
	}
	if p, err := OpenWithAppKey(sealed, []byte("aad-1")); err != nil || string(p) != "hello" {
		t.Fatal(err)
	}
	if _, err := OpenWithAppKey(sealed, []byte("aad-2")); !errors.Is(err, ErrDecrypt) {
		t.Fatalf("wrong AAD accepted: %v", err)
	}
}
