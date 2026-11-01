package ldap

import (
	"bytes"
	"testing"
)

func TestEncodeUnicodePwd(t *testing.T) {
	tests := []struct {
		name     string
		password string
		want     []byte
	}{
		{"ascii", "Ab1!", []byte{'"', 0, 'A', 0, 'b', 0, '1', 0, '!', 0, '"', 0}},
		{"umlaut", "ä", []byte{'"', 0, 0xE4, 0x00, '"', 0}},
		{"bmp beyond latin1", "€", []byte{'"', 0, 0xAC, 0x20, '"', 0}},
		{"surrogate pair", "😀", []byte{'"', 0, 0x3D, 0xD8, 0x00, 0xDE, '"', 0}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := encodeUnicodePwd(tt.password); !bytes.Equal(got, tt.want) {
				t.Errorf("encodeUnicodePwd(%q) = % x, want % x", tt.password, got, tt.want)
			}
		})
	}
}
