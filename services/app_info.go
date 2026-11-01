package services

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strings"

	"github.com/dpicillo/LDAPilot/internal/config"
)

// ReleaseVersion is the version this source tree declares. Keep it in step
// with wails.json (info.productVersion, without the "v") and
// frontend/package.json (TestReleaseVersionDeclarations checks both).
// scripts/build.sh stamps it; an unstamped build (`wails dev`, a plain
// `wails build`) reports ReleaseVersion + "-dev", which About shows as
// "v0.5.0 development build".
const ReleaseVersion = "v0.5.0"

// BuildInfo is what the build stamps into main.version/commit/date via
// -ldflags "-X main.version=v0.5.0 -X main.commit=… -X main.date=…".
type BuildInfo struct {
	Version string
	Commit  string
	Date    string
}

// AppInfo describes the running build and its environment (Help ▸ About,
// "Copy diagnostics", Report Issue).
type AppInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Commit  string `json:"commit"`
	// BuildDate is the build (or commit) time, RFC 3339 when known.
	BuildDate string `json:"buildDate"`
	// Modified: built from a working tree with uncommitted changes.
	Modified     bool   `json:"modified"`
	GoVersion    string `json:"goVersion"`
	WailsVersion string `json:"wailsVersion"`
	// WebView is the native web view library in use (Linux: the loaded
	// libwebkit2gtk, e.g. "libwebkit2gtk-4.1.so.0.16.6"); empty when unknown.
	WebView   string `json:"webView"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	ConfigDir string `json:"configDir"`
}

// SetBuildInfo records the ldflags values of main.go.
func (s *UIService) SetBuildInfo(version, commit, date string) {
	s.mu.Lock()
	s.build = BuildInfo{Version: version, Commit: commit, Date: date}
	s.mu.Unlock()
}

// GetAppInfo returns version, commit and build date (ldflags, else the Go
// build info of the module: VCS revision and time), the Go and Wails
// versions, the web view, the operating system and the config directory.
func (s *UIService) GetAppInfo() AppInfo {
	s.mu.Lock()
	build := s.build
	s.mu.Unlock()
	bi, _ := debug.ReadBuildInfo()
	info := appInfoFrom(build, bi)
	info.OS = osDescription()
	info.Arch = runtime.GOARCH
	info.WebView = webViewLibrary()
	if dir, err := config.ConfigDir(); err == nil {
		info.ConfigDir = dir
	}
	return info
}

// appInfoFrom merges the ldflags values with the Go build info (VCS stamp,
// module and Wails versions); ldflags win.
func appInfoFrom(build BuildInfo, bi *debug.BuildInfo) AppInfo {
	info := AppInfo{
		Name:      "LDAPilot",
		Version:   strings.TrimSpace(build.Version),
		Commit:    strings.TrimSpace(build.Commit),
		BuildDate: strings.TrimSpace(build.Date),
		GoVersion: runtime.Version(),
	}
	if bi != nil {
		if bi.GoVersion != "" {
			info.GoVersion = bi.GoVersion
		}
		for _, st := range bi.Settings {
			switch st.Key {
			case "vcs.revision":
				if info.Commit == "" {
					info.Commit = st.Value
				}
			case "vcs.time":
				if info.BuildDate == "" {
					info.BuildDate = st.Value
				}
			case "vcs.modified":
				info.Modified = st.Value == "true"
			}
		}
		if info.Version == "" && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
			info.Version = bi.Main.Version
		}
		for _, dep := range bi.Deps {
			if dep.Path == "github.com/wailsapp/wails/v2" {
				info.WailsVersion = dep.Version
				if dep.Replace != nil {
					info.WailsVersion = dep.Replace.Version
				}
			}
		}
	}
	if info.Version == "" {
		info.Version = ReleaseVersion + "-dev"
	}
	if len(info.Commit) > 12 {
		info.Commit = info.Commit[:12]
	}
	return info
}

// osDescription is GOOS, on Linux with the distribution's PRETTY_NAME.
func osDescription() string {
	if runtime.GOOS != "linux" {
		return runtime.GOOS
	}
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return runtime.GOOS
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), "PRETTY_NAME="); ok {
			return "linux (" + strings.Trim(v, `"'`) + ")"
		}
	}
	return runtime.GOOS
}

var webkitLib = regexp.MustCompile(`libwebkit2gtk-[0-9.]+\.so[0-9.]*`)

// webViewLibrary names the loaded WebKitGTK library on Linux ("" elsewhere,
// the frontend adds the engine from its user agent).
func webViewLibrary() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	data, err := os.ReadFile("/proc/self/maps")
	if err != nil {
		return ""
	}
	if m := webkitLib.Find(data); m != nil {
		return filepath.Base(string(m))
	}
	return ""
}
