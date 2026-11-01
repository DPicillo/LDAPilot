//go:build !windows

package chatstore

func isSharingViolationErr(error) bool { return false }
