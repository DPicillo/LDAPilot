//go:build windows

package chatstore

func isSharingViolationErr(err error) bool { return isSharingViolation(err) }
