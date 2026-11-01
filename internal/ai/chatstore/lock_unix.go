//go:build !windows

package chatstore

import (
	"errors"
	"os"
	"syscall"
)

var errLocked = errors.New("chats directory is locked by another LDAPilot instance")

// dirLock is an exclusive advisory lock (flock) on chats/.lock. The OS
// releases it when the process exits or crashes.
type dirLock struct{ f *os.File }

func acquireDirLock(path string) (*dirLock, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, errLocked
		}
		return nil, err
	}
	return &dirLock{f: f}, nil
}

func (l *dirLock) release() {
	_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	_ = l.f.Close()
}

func renameWithRetry(oldPath, newPath string) error { return os.Rename(oldPath, newPath) }
