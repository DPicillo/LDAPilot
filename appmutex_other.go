//go:build !windows

package main

// holdAppMutexes is Windows-only: Linux and macOS package managers replace
// the file of a running program without needing to know.
func holdAppMutexes() {}
