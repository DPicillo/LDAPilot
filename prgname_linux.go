//go:build linux

package main

/*
#cgo pkg-config: glib-2.0
#include <stdlib.h>
#include <glib.h>
*/
import "C"

import "unsafe"

// Wails applies linux.Options.ProgramName only after it has created the
// window, too late for the X11 window class (WM_CLASS), which then follows
// the binary name ("ldapilot"). Setting the program name here, before GTK
// starts, gives the Wayland app ID and the X11 class the app ID, so docks
// and panels match the window to io.github.dpicillo.LDAPilot.desktop.
func init() {
	name := C.CString(appID)
	defer C.free(unsafe.Pointer(name))
	C.g_set_prgname(name)
}

// currentProgramName is GLib's program name, for the test.
func currentProgramName() string {
	return C.GoString(C.g_get_prgname())
}
