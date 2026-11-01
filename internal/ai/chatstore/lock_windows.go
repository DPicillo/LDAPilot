//go:build windows

package chatstore

import (
	"errors"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

var errLocked = errors.New("chats directory is locked by another LDAPilot instance")

// dirLock is an exclusive lock (LockFileEx) on chats/.lock. The OS releases
// it when the process exits or crashes.
type dirLock struct{ f *os.File }

func acquireDirLock(path string) (*dirLock, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	ol := new(windows.Overlapped)
	err = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ol)
	if err != nil {
		f.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
			return nil, errLocked
		}
		return nil, err
	}
	return &dirLock{f: f}, nil
}

func (l *dirLock) release() {
	ol := new(windows.Overlapped)
	_ = windows.UnlockFileEx(windows.Handle(l.f.Fd()), 0, 1, 0, ol)
	_ = l.f.Close()
}

// renameWithRetry retries sharing violations caused by virus scanners and
// indexers (up to 5 times, 20–320 ms backoff).
func renameWithRetry(oldPath, newPath string) error {
	return retryRename(os.Rename, oldPath, newPath, time.Sleep)
}

func isSharingViolation(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_ACCESS_DENIED)
}
