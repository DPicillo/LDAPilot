//go:build windows

package main

import (
	"log"
	"unsafe"

	"golang.org/x/sys/windows"
)

// appMutexes keeps the handles open for the life of the process; Windows
// closes them when it exits.
var appMutexes []windows.Handle

// mutexSDDL lets everyone open the mutexes for SYNCHRONIZE (0x100000), which is
// all a setup or another LDAPilot needs. With the default DACL only the
// creator, administrators and SYSTEM could: on a terminal server the LDAPilot
// of a second user would get no Global\ mutex, and a setup would miss it once
// the first user quits.
const mutexSDDL = "D:(A;;0x100000;;;WD)"

// holdAppMutexes creates the named mutexes the setup checks. A second
// instance gets ERROR_ALREADY_EXISTS with a valid handle, which is fine.
func holdAppMutexes() {
	var sa *windows.SecurityAttributes
	if sd, err := windows.SecurityDescriptorFromString(mutexSDDL); err == nil {
		sa = &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	}
	for _, name := range appMutexNames {
		ptr, err := windows.UTF16PtrFromString(name)
		if err != nil {
			continue
		}
		h, err := windows.CreateMutexEx(sa, ptr, 0, windows.SYNCHRONIZE)
		if h == 0 {
			log.Printf("mutex %s: %v", name, err)
			continue
		}
		appMutexes = append(appMutexes, h)
	}
}
