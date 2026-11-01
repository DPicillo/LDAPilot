package config

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
)

const keyFileName = "key"
const encPrefix = "ENC:"

// getOrCreateKey returns the application key. It delegates to AppKey, the
// single fail-closed accessor: an unreadable key is never regenerated.
func getOrCreateKey() ([]byte, error) {
	return AppKey()
}

// EncryptPassword encrypts a plaintext password using AES-256-GCM.
// Returns a base64-encoded ciphertext string.
func EncryptPassword(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}

	key, err := getOrCreateKey()
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("failed to create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("failed to create GCM: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("failed to generate nonce: %w", err)
	}

	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return encPrefix + base64.StdEncoding.EncodeToString(ciphertext), nil
}

// DecryptPassword decrypts a password encrypted by EncryptPassword.
// If the value is not encrypted (no ENC: prefix), it is returned as-is
// for backwards compatibility with existing plaintext passwords.
func DecryptPassword(encrypted string) (string, error) {
	if encrypted == "" {
		return "", nil
	}

	// Not encrypted — return as plaintext (backwards compat)
	if len(encrypted) < len(encPrefix) || encrypted[:len(encPrefix)] != encPrefix {
		return encrypted, nil
	}

	data, err := base64.StdEncoding.DecodeString(encrypted[len(encPrefix):])
	if err != nil {
		return "", fmt.Errorf("failed to decode encrypted password: %w", err)
	}

	key, err := getOrCreateKey()
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("failed to create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("failed to create GCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("failed to decrypt password: %w", err)
	}

	return string(plaintext), nil
}
