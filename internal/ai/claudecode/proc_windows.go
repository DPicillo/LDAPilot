//go:build windows

package claudecode

import (
	"os/exec"
	"strconv"
	"syscall"
)

// prepareProcess keeps a console window from flashing up for the CLI.
func prepareProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

// killProcess kills the CLI and its children (claude.cmd starts node):
// taskkill /T walks the process tree; Process.Kill is the fallback.
func killProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	tk := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
	tk.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := tk.Run(); err == nil {
		return nil
	}
	return cmd.Process.Kill()
}

// interruptProcess kills the CLI: a hidden child has no console to receive
// a Ctrl+C event (CLAUDE-CODE-MODE.md: "Windows: Process.Kill").
func interruptProcess(cmd *exec.Cmd) error { return killProcess(cmd) }
