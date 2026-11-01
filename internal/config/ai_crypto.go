package config

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// SealWithAppKey encrypts plaintext with AES-256-GCM under the application
// key. The result is nonce||ciphertext. aad binds the ciphertext to its
// context (for chats: the chat ID), so a file copied to another name fails
// to open.
func SealWithAppKey(plaintext, aad []byte) ([]byte, error) {
	key, err := AppKey()
	if err != nil {
		return nil, err
	}
	return SealWithKey(key, plaintext, aad)
}

// OpenWithAppKey decrypts a value produced by SealWithAppKey.
func OpenWithAppKey(sealed, aad []byte) ([]byte, error) {
	key, err := AppKey()
	if err != nil {
		return nil, err
	}
	return OpenWithKey(key, sealed, aad)
}

// SealWithKey is SealWithAppKey with an explicit 32-byte key.
func SealWithKey(key, plaintext, aad []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("failed to generate nonce: %w", err)
	}
	return gcm.Seal(nonce, nonce, plaintext, aad), nil
}

// ErrDecrypt is returned when a sealed value cannot be authenticated (wrong
// key, wrong AAD, or corrupted data).
var ErrDecrypt = errors.New("decryption failed")

// OpenWithKey is OpenWithAppKey with an explicit 32-byte key.
func OpenWithKey(key, sealed, aad []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize()+gcm.Overhead() {
		return nil, fmt.Errorf("%w: ciphertext too short", ErrDecrypt)
	}
	nonce, ct := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ct, aad)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrDecrypt, err)
	}
	return plain, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != appKeySize {
		return nil, fmt.Errorf("invalid key length %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("failed to create cipher: %w", err)
	}
	return cipher.NewGCM(block)
}

// writeFileAtomic writes data to path via a temp file in the same directory
// (mode 0600, fsync, rename, directory fsync), so readers never see a
// partially written file.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	suffix := make([]byte, 6)
	if _, err := io.ReadFull(rand.Reader, suffix); err != nil {
		return err
	}
	tmp := filepath.Join(dir, "."+filepath.Base(path)+".tmp-"+hex.EncodeToString(suffix))
	if err := writeNewFile(tmp, data); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	syncDir(dir)
	return nil
}
