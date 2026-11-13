package main

// appMutexNames are created at start-up on Windows (appmutex_windows.go) so
// the setup can tell that LDAPilot runs. The Global\ name is the one a setup
// in another session sees, e.g. software distribution in session 0.
var appMutexNames = []string{"LDAPilot.Running", `Global\LDAPilot.Running`}
