//go:build unix

package ldif

import (
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A FIFO would block the parser (which runs before a bulk run can be
// stopped); the resolver must refuse it without opening it.
func TestFileURLResolverRefusesFIFO(t *testing.T) {
	fifo := filepath.Join(t.TempDir(), "pipe")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Skipf("mkfifo: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := FileURLResolver(1<<20, 0)(testFileURL(fifo))
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "not a regular file") {
			t.Errorf("FIFO: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("resolver blocked on a FIFO")
	}
}
