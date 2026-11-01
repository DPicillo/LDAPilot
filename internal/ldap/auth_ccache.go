package ldap

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

// ccacheEnv is the part of the process environment that decides which
// Kerberos credential cache is the default (separate for tests).
type ccacheEnv struct {
	krb5ccname string // KRB5CCNAME
	krb5Conf   string // krb5.conf path (Krb5ConfigPath)
	goos       string
	uid        int
	username   string
}

func currentCCacheEnv() ccacheEnv {
	e := ccacheEnv{
		krb5ccname: os.Getenv("KRB5CCNAME"),
		krb5Conf:   Krb5ConfigPath(),
		goos:       runtime.GOOS,
		uid:        os.Getuid(),
	}
	if u, err := user.Current(); err == nil {
		e.username = u.Username
	}
	return e
}

// ccacheLocation is a resolved credential cache.
type ccacheLocation struct {
	// Name is the cache name in KRB5CCNAME syntax, e.g. "FILE:/tmp/krb5cc_1000" or "KCM:".
	Name string
	// Path is the cache file; empty for cache types that cannot be read.
	Path string
	// Source says where Name comes from, for messages: "set in the profile",
	// "from KRB5CCNAME", "from /etc/krb5.conf", "system default", ...
	Source string
}

// DefaultCCachePath describes the credential cache used for KrbCredSystem
// on Linux/macOS when the profile names none: its file (or, if unsupported,
// its name such as "KCM:"), where that comes from, and whether LDAPilot can
// read it (only MIT "FILE:" caches; KEYRING:, KCM:, API: and DIR: cannot).
func DefaultCCachePath() (path, source string, supported bool) {
	loc, err := resolveCCache("", currentCCacheEnv())
	if err != nil {
		return loc.Name, loc.Source, false
	}
	return loc.Path, loc.Source, true
}

// resolveCCache resolves the credential cache like MIT Kerberos: the
// profile's KrbCCache (override), else KRB5CCNAME, else default_ccache_name
// of krb5.conf (with %{uid} etc. expanded), else the platform default
// (FILE:/tmp/krb5cc_<uid>; on macOS API: unless that file exists). It fails
// with an AuthConfigError for cache types that cannot be read.
func resolveCCache(override string, e ccacheEnv) (ccacheLocation, error) {
	loc := ccacheName(override, e)
	name := loc.Name
	if i := strings.Index(name, ":"); i > 0 && !(e.goos == "windows" && i == 1) {
		typ := strings.ToUpper(name[:i])
		if typ != "FILE" {
			return loc, configErrorf(
				"Kerberos: the credential cache %s (%s) is of type %s, which LDAPilot cannot read; run \"kinit -c FILE:%s\" and enter that file as the credential cache in the profile (or start LDAPilot with KRB5CCNAME=FILE:<file>)",
				name, loc.Source, typ, fileCCacheDefault(e.uid))
		}
		name = name[i+1:]
	}
	if strings.TrimSpace(name) == "" {
		return loc, configErrorf("Kerberos: the credential cache name %q (%s) has no file", loc.Name, loc.Source)
	}
	loc.Path = expandHome(name)
	return loc, nil
}

func fileCCacheDefault(uid int) string {
	return fmt.Sprintf("/tmp/krb5cc_%d", uid)
}

const ccacheSourceProfile = "set in the profile"

// ccacheName returns the credential cache name and its source (see resolveCCache).
func ccacheName(override string, e ccacheEnv) ccacheLocation {
	if s := strings.TrimSpace(override); s != "" {
		return ccacheLocation{Name: s, Source: ccacheSourceProfile}
	}
	if s := strings.TrimSpace(e.krb5ccname); s != "" {
		return ccacheLocation{Name: s, Source: "from KRB5CCNAME"}
	}
	if v, file := krb5ConfLookup(e.krb5Conf, "libdefaults", "default_ccache_name", 0); v != "" {
		return ccacheLocation{Name: expandKrb5Tokens(v, e), Source: "from " + file}
	}
	def := fileCCacheDefault(e.uid)
	if e.goos == "darwin" {
		// The system (Heimdal) kinit of macOS keeps tickets in the API:
		// cache; MIT kinit (e.g. Homebrew) uses the file.
		if _, err := os.Stat(def); err != nil {
			return ccacheLocation{Name: "API:", Source: "macOS default"}
		}
	}
	return ccacheLocation{Name: "FILE:" + def, Source: "system default"}
}

var krb5TokenRE = regexp.MustCompile(`%\{([A-Za-z]+)\}`)

// expandKrb5Tokens expands the MIT path tokens %{uid}, %{euid}, %{USERID},
// %{username}, %{TEMP} and %{null} of a krb5.conf value; others are kept.
func expandKrb5Tokens(s string, e ccacheEnv) string {
	return krb5TokenRE.ReplaceAllStringFunc(s, func(tok string) string {
		switch krb5TokenRE.FindStringSubmatch(tok)[1] {
		case "uid", "euid", "USERID":
			return strconv.Itoa(e.uid)
		case "username":
			return e.username
		case "TEMP":
			if d := os.Getenv("TMPDIR"); d != "" {
				return d
			}
			return "/tmp"
		case "null":
			return ""
		}
		return tok
	})
}

// krb5IncludedName reports whether includedir includes a file, like MIT:
// names of only alphanumerics, dashes and underscores, or ending in ".conf"
// and not starting with ".".
var krb5IncludedName = regexp.MustCompile(`^([A-Za-z0-9_-]+|[^.].*\.conf)$`)

// krb5ConfLookup returns the first value of key in section of the krb5.conf
// at path and the file it was found in ("" if unset). Like the MIT profile
// library it follows "include FILE" and "includedir DIR" directives where
// they appear, and the first value wins. Values inside { } subsections are
// ignored.
func krb5ConfLookup(path, section, key string, depth int) (string, string) {
	if depth > 8 || path == "" {
		return "", ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", ""
	}
	cur, braces := "", 0
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		if f := strings.Fields(line); len(f) >= 2 && braces == 0 {
			arg := strings.TrimSpace(line[len(f[0]):])
			switch f[0] {
			case "include":
				if v, f := krb5ConfLookup(arg, section, key, depth+1); v != "" {
					return v, f
				}
				continue
			case "includedir":
				entries, err := os.ReadDir(arg)
				if err != nil {
					continue
				}
				for _, ent := range entries {
					if ent.IsDir() || !krb5IncludedName.MatchString(ent.Name()) {
						continue
					}
					if v, f := krb5ConfLookup(filepath.Join(arg, ent.Name()), section, key, depth+1); v != "" {
						return v, f
					}
				}
				continue
			}
		}
		if line[0] == '[' {
			if end := strings.Index(line, "]"); end > 0 {
				cur, braces = strings.TrimSpace(line[1:end]), 0
			}
			continue
		}
		if strings.HasPrefix(line, "}") {
			if braces > 0 {
				braces--
			}
			continue
		}
		name, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if strings.HasPrefix(value, "{") {
			braces++
			continue
		}
		if braces == 0 && cur == section && strings.TrimSpace(name) == key {
			value = strings.Trim(value, `"`)
			if value != "" {
				return value, path
			}
		}
	}
	return "", ""
}
