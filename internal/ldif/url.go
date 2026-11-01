package ldif

import (
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// DefaultMaxURLValueSize is the size cap of a single "attr:< file://" value.
const DefaultMaxURLValueSize = 10 << 20 // 10 MiB

// FileURLPath converts a file:// URL to a local path. Only local files are
// supported: the host must be empty or "localhost" and the path absolute.
// Network and device paths are refused, also when written into the path
// (file:////host/share/x, file://localhost//host/share/x, backslashes,
// Windows \\host\share, \\.\pipe\x, \\?\UNC\…, \??\UNC\…): opening a UNC path
// on Windows connects to that SMB server and authenticates as the logged-on
// user, and reading an LDIF (also its dry run) must never do that.
func FileURLPath(rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("invalid URL %q: %v", rawURL, err)
	}
	if !strings.EqualFold(u.Scheme, "file") {
		return "", fmt.Errorf("only file:// URLs are supported, not %q", rawURL)
	}
	if u.Host != "" && !strings.EqualFold(u.Host, "localhost") {
		return "", fmt.Errorf("only local file:// URLs are supported (host %q)", u.Host)
	}
	if u.Opaque != "" {
		return "", fmt.Errorf("file URL %q must contain an absolute path (file:///...)", rawURL)
	}
	p := u.Path
	if p == "" {
		return "", fmt.Errorf("file URL %q has no path", rawURL)
	}
	if strings.HasPrefix(p, "//") || strings.ContainsRune(p, '\\') {
		return "", fmt.Errorf("file URL %q names a network or device path; only local files are supported", rawURL)
	}
	// file:///C:/dir/x.jpg -> C:/dir/x.jpg on Windows
	if len(p) >= 3 && p[0] == '/' && p[2] == ':' && isLetter(p[1]) {
		p = p[1:]
	}
	p = filepath.FromSlash(p)
	// Windows: the only local volume form is "C:"; a volume starting with a
	// separator is UNC or a device/NT namespace (\\host\share, \\.\, \\?\, \??\UNC\…).
	if vol := filepath.VolumeName(p); vol != "" && (vol[0] == '\\' || vol[0] == '/') {
		return "", fmt.Errorf("file URL %q names a network or device path; only local files are supported", rawURL)
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("file URL %q must contain an absolute path", rawURL)
	}
	return p, nil
}

func isLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// FileURLResolver returns a ParseOptions.ResolveURL function that reads
// local file:// URLs up to maxSize bytes each and up to maxTotal bytes over
// all values (0 means no total limit). Other URL schemes are rejected.
func FileURLResolver(maxSize, maxTotal int64) func(string) ([]byte, error) {
	var total int64
	return func(rawURL string) ([]byte, error) {
		p, err := FileURLPath(rawURL)
		if err != nil {
			return nil, err
		}
		// Only regular files: opening a FIFO blocks (parsing runs before a
		// run can be stopped), devices never end.
		if info, err := os.Stat(p); err != nil {
			return nil, fmt.Errorf("cannot open %s: %v", p, err)
		} else if !info.Mode().IsRegular() {
			return nil, notRegularFile(p, info)
		}
		f, err := os.Open(p)
		if err != nil {
			return nil, fmt.Errorf("cannot open %s: %v", p, err)
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return nil, fmt.Errorf("cannot read %s: %v", p, err)
		}
		if !info.Mode().IsRegular() { // replaced since the check above
			return nil, notRegularFile(p, info)
		}
		if info.Size() > maxSize {
			return nil, fmt.Errorf("%s is too large (%d bytes, limit %d bytes)", p, info.Size(), maxSize)
		}
		data, err := io.ReadAll(io.LimitReader(f, maxSize+1))
		if err != nil {
			return nil, fmt.Errorf("cannot read %s: %v", p, err)
		}
		if int64(len(data)) > maxSize {
			return nil, fmt.Errorf("%s is too large (limit %d bytes)", p, maxSize)
		}
		total += int64(len(data))
		if maxTotal > 0 && total > maxTotal {
			return nil, fmt.Errorf("URL values exceed the total limit of %d bytes", maxTotal)
		}
		return data, nil
	}
}

// notRegularFile is the error for a URL value that is not a regular file.
func notRegularFile(p string, info os.FileInfo) error {
	if info.IsDir() {
		return fmt.Errorf("%s is a directory", p)
	}
	return fmt.Errorf("%s is not a regular file", p)
}
