//go:build windows

package main

import (
	"os"
	"runtime"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func releaseAppMutexes() {
	for _, h := range appMutexes {
		windows.CloseHandle(h)
	}
	appMutexes = nil
}

// On a terminal server every user's LDAPilot must hold Global\LDAPilot.Running,
// also the ones started after the first: the mutex has to let everybody open it.
func TestGlobalMutexOpenToEveryone(t *testing.T) {
	holdAppMutexes()
	defer releaseAppMutexes()
	if len(appMutexes) != len(appMutexNames) {
		t.Fatalf("holds %d of %d mutexes", len(appMutexes), len(appMutexNames))
	}
	// The held handles only have SYNCHRONIZE; the owner may always read the DACL.
	name, _ := windows.UTF16PtrFromString(appMutexNames[1])
	h, err := windows.OpenMutex(windows.READ_CONTROL, false, name)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	sd, err := windows.GetSecurityInfo(h, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if dacl == nil {
		return // no DACL at all: everybody may open it
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if ace.Header.AceType == windows.ACCESS_ALLOWED_ACE_TYPE && ace.Mask&windows.SYNCHRONIZE != 0 && sid.IsWellKnown(windows.WinWorldSid) {
			return
		}
	}
	t.Errorf("Global mutex DACL does not let everyone open it: %s", sd)
}

var (
	advapi32                = windows.NewLazySystemDLL("advapi32.dll")
	procLogonUserW          = advapi32.NewProc("LogonUserW")
	procImpersonateLoggedOn = advapi32.NewProc("ImpersonateLoggedOnUser")
)

// The real case, opt-in: LDAPILOT_MUTEX_USER / LDAPILOT_MUTEX_PASSWORD name a
// second local user. Its LDAPilot creates the mutexes first, then this user's
// LDAPilot (and a setup) must still be able to open the global one.
func TestGlobalMutexOfAnotherUser(t *testing.T) {
	user, password := os.Getenv("LDAPILOT_MUTEX_USER"), os.Getenv("LDAPILOT_MUTEX_PASSWORD")
	if user == "" {
		t.Skip("set LDAPILOT_MUTEX_USER and LDAPILOT_MUTEX_PASSWORD to run it")
	}
	u, _ := windows.UTF16PtrFromString(user)
	d, _ := windows.UTF16PtrFromString(".")
	p, _ := windows.UTF16PtrFromString(password)
	var token windows.Token
	const logonInteractive, providerDefault = 2, 0
	if r, _, err := procLogonUserW.Call(uintptr(unsafe.Pointer(u)), uintptr(unsafe.Pointer(d)), uintptr(unsafe.Pointer(p)),
		logonInteractive, providerDefault, uintptr(unsafe.Pointer(&token))); r == 0 {
		t.Fatalf("LogonUser %s: %v", user, err)
	}
	defer token.Close()

	runtime.LockOSThread()
	if r, _, err := procImpersonateLoggedOn.Call(uintptr(token)); r == 0 {
		runtime.UnlockOSThread()
		t.Fatalf("ImpersonateLoggedOnUser: %v", err)
	}
	holdAppMutexes() // as the other user
	theirs := appMutexes
	appMutexes = nil
	windows.RevertToSelf()
	runtime.UnlockOSThread()
	defer func() { appMutexes = theirs; releaseAppMutexes() }()
	if len(theirs) != len(appMutexNames) {
		t.Fatalf("the other user holds %d of %d mutexes", len(theirs), len(appMutexNames))
	}

	name, _ := windows.UTF16PtrFromString(appMutexNames[1])
	h, err := windows.OpenMutex(windows.SYNCHRONIZE, false, name)
	if err != nil {
		t.Fatalf("open the other user's %s: %v", appMutexNames[1], err)
	}
	windows.CloseHandle(h)

	holdAppMutexes() // this user's LDAPilot
	defer releaseAppMutexes()
	if len(appMutexes) != len(appMutexNames) {
		t.Errorf("this user's LDAPilot holds %d of %d mutexes", len(appMutexes), len(appMutexNames))
	}
}
