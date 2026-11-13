package main

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// The setup (build/windows/setup/ldapilot.iss) checks these names to tell
// whether LDAPilot runs; the global one is what a setup in session 0
// (software distribution, a service) can see.
func TestAppMutexNames(t *testing.T) {
	want := []string{"LDAPilot.Running", `Global\LDAPilot.Running`}
	if !reflect.DeepEqual(appMutexNames, want) {
		t.Fatalf("appMutexNames = %q, want %q", appMutexNames, want)
	}
}

// File properties, inventory tools and file-version detection rules read
// the version resource; Wails fills the template from wails.json.
func TestWindowsVersionResource(t *testing.T) {
	data, err := os.ReadFile("build/windows/info.json")
	if err != nil {
		t.Fatal(err)
	}
	var res struct {
		Fixed map[string]string            `json:"fixed"`
		Info  map[string]map[string]string `json:"info"`
	}
	if err := json.Unmarshal(data, &res); err != nil {
		t.Fatal(err)
	}
	const want = "{{.Info.ProductVersion}}"
	for _, k := range []string{"file_version", "product_version"} {
		if res.Fixed[k] != want {
			t.Errorf("fixed.%s = %q, want %q", k, res.Fixed[k], want)
		}
	}
	for _, k := range []string{"FileVersion", "ProductVersion"} {
		if res.Info["0000"][k] != want {
			t.Errorf(`info."0000".%s = %q, want %q`, k, res.Info["0000"][k], want)
		}
	}
}

// A WSL relay (LDAPilot.exe --mcp-relay) runs while a Claude Code run is
// active; it must exit before the mutex exists, or every update would
// report "LDAPilot is running".
func TestRelayExitsBeforeMutex(t *testing.T) {
	src := mainSource(t)
	relay := strings.Index(src, "mcprelay.Flag")
	hold := strings.Index(src, "holdAppMutexes()")
	if relay < 0 || hold < 0 || relay > hold {
		t.Fatalf("main.go: relay branch at %d, holdAppMutexes() at %d; the relay must come first", relay, hold)
	}
}

// The Wayland app ID (and the X11 window name) is the program name; it has
// to equal the desktop entry's name so panels show the LDAPilot icon.
func TestLinuxProgramName(t *testing.T) {
	if appID != "io.github.dpicillo.LDAPilot" {
		t.Fatalf("appID = %q", appID)
	}
	if !strings.Contains(mainSource(t), "ProgramName: appID") {
		t.Fatal("main.go: linux.Options must set ProgramName: appID")
	}
}

// Desktop entry, AppStream file and package layout carry the app ID; a panel
// shows the LDAPilot icon only when the window's app ID / class (appID, see
// prgname_linux.go) names this desktop entry.
func TestLinuxPackagingIdentifiers(t *testing.T) {
	desktop := readFile(t, "build/linux/"+appID+".desktop")
	for _, line := range []string{"Exec=ldapilot", "Icon=" + appID, "StartupWMClass=" + appID, "Categories=Network;"} {
		if !strings.Contains(desktop, "\n"+line+"\n") {
			t.Errorf("desktop entry lacks %q", line)
		}
	}
	metainfo := readFile(t, "build/linux/"+appID+".metainfo.xml")
	for _, want := range []string{"<id>" + appID + "</id>", `<launchable type="desktop-id">` + appID + ".desktop</launchable>"} {
		if !strings.Contains(metainfo, want) {
			t.Errorf("metainfo lacks %q", want)
		}
	}
	nfpm := readFile(t, "build/linux/nfpm.yaml")
	for _, dst := range []string{"/usr/share/applications/" + appID + ".desktop", "/usr/share/metainfo/" + appID + ".metainfo.xml", "/usr/share/icons/hicolor/256x256/apps/" + appID + ".png", "/usr/bin/ldapilot"} {
		if !strings.Contains(nfpm, "dst: "+dst+"\n") {
			t.Errorf("nfpm.yaml does not install %s", dst)
		}
	}
}

// The README links to releases/latest/download/<file>, so every release file
// keeps one name without the version; the release job uploads exactly these.
func TestReleaseFileNames(t *testing.T) {
	linux := []string{"LDAPilot-linux-amd64.deb", "LDAPilot-linux-amd64.rpm", "LDAPilot-linux-amd64.el9.rpm", "LDAPilot-linux-amd64.tar.gz"}
	script := readFile(t, "scripts/package-linux.sh")
	for _, name := range linux {
		if !strings.Contains(script, `"$out/`+name+`"`) {
			t.Errorf("package-linux.sh does not write %s", name)
		}
	}
	ci := readFile(t, ".github/workflows/ci.yml")
	start := strings.Index(ci, "files=(")
	if start < 0 {
		t.Fatal("ci.yml: no files=(…) list in the release job")
	}
	end := strings.Index(ci[start:], ")")
	uploads := strings.Fields(ci[start+len("files=(") : start+end])
	readme := readFile(t, "README.md")
	for _, name := range append(linux, "LDAPilot-windows-amd64-installer.exe", "LDAPilot-windows-amd64.exe", "LDAPilot-macos-universal.zip") {
		if !slices.Contains(uploads, name) {
			t.Errorf("ci.yml uploads %q, not %s", uploads, name)
		}
		if !strings.Contains(readme, "/releases/latest/download/"+name) {
			t.Errorf("README.md does not link %s", name)
		}
	}
}

// The setup's identity never changes: the AppId names the uninstall key that
// detection rules point at, and the mutexes must be the ones LDAPilot holds.
func TestWindowsSetupIdentifiers(t *testing.T) {
	iss := readFile(t, "build/windows/setup/ldapilot.iss")
	for _, want := range []string{
		"AppId={{2216036E-00F6-49B8-9C8F-D331676AFF43}\n",
		`#define Mutexes "` + strings.Join(appMutexNames, ",") + `"` + "\n",
		`DefaultDirName={autopf}\LDAPilot` + "\n",
		"PrivilegesRequired=lowest\n",
		"PrivilegesRequiredOverridesAllowed=dialog commandline\n",
		`Source: "LDAPilot.exe"; DestDir: "{app}"; Flags: ignoreversion uninsrestartdelete` + "\n",
	} {
		if !strings.Contains(iss, want) {
			t.Errorf("ldapilot.iss lacks %q", strings.TrimSpace(want))
		}
	}
	// Where LDAPilot cannot open its window (no desktop), the smoke test holds them itself.
	smoke := readFile(t, "scripts/windows-setup-smoke.ps1")
	if want := "'" + strings.Join(appMutexNames, "', '") + "'"; !strings.Contains(smoke, want) {
		t.Errorf("windows-setup-smoke.ps1 does not hold %s", want)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func mainSource(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
