#!/usr/bin/env sh
# Linux release files from the two LDAPilot binaries (nfpm must be on PATH):
#
#   scripts/package-linux.sh <version> <binary-webkit40> <binary-webkit41> <outdir>
#
#   LDAPilot-linux-amd64.deb        WebKitGTK 4.1: Debian 12+, Ubuntu 22.04+
#   LDAPilot-linux-amd64.rpm        WebKitGTK 4.1: Fedora, openSUSE, RHEL 10 (EPEL)
#   LDAPilot-linux-amd64.el9.rpm    WebKitGTK 4.0: RHEL / Rocky / Alma 9
#   LDAPilot-linux-amd64.tar.gz     both binaries + install.sh, per user into ~/.local
#
# The file names carry no version, so releases/latest/download/<name> links
# (README) always point at the newest release; the packages themselves are
# ldapilot <v>-1.
# The version is wails.json's info.productVersion without "v" (N.N.N only:
# packages and the Windows installers cannot carry a pre-release suffix).
set -eu
cd "$(dirname "$0")/.."

if [ $# -ne 4 ]; then
	echo "usage: $0 <version> <binary-webkit40> <binary-webkit41> <outdir>" >&2
	exit 2
fi
version=$1 bin40=$2 bin41=$3 out=$4
if ! echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
	echo "package-linux: version must be N.N.N, got '$version'" >&2
	exit 2
fi
id=io.github.dpicillo.LDAPilot
stage=dist/linux/stage
rm -rf dist/linux
mkdir -p "$stage" "$out"

# Release date from CHANGELOG.md ("## [0.5.0] - 2026-11-01"), else today.
date=$(sed -n "s/^## \[$version\] - \([0-9-]*\).*/\1/p" CHANGELOG.md | head -n 1)
[ -n "$date" ] || date=$(date -u +%Y-%m-%d)
sed -e "s/@VERSION@/$version/" -e "s/@DATE@/$date/" "build/linux/$id.metainfo.xml" >"$stage/$id.metainfo.xml"
cat >"$stage/changelog.yml" <<EOF
- semver: $version-1
  date: ${date}T00:00:00Z
  packager: David Picillo <58555256+DPicillo@users.noreply.github.com>
  deb:
    distributions:
      - stable
    urgency: medium
  changes:
    - note: See https://github.com/DPicillo/LDAPilot/blob/v$version/CHANGELOG.md
EOF

export VERSION="$version"
install -m 755 "$bin41" "$stage/ldapilot"
PKG_RELEASE=1 DEB_WEBKIT=libwebkit2gtk-4.1-0 RPM_WEBKIT='libwebkit2gtk-4.1.so.0()(64bit)' \
	nfpm package -f build/linux/nfpm.yaml -p deb -t "$out/LDAPilot-linux-amd64.deb"
PKG_RELEASE=1 DEB_WEBKIT=libwebkit2gtk-4.1-0 RPM_WEBKIT='libwebkit2gtk-4.1.so.0()(64bit)' \
	nfpm package -f build/linux/nfpm.yaml -p rpm -t "$out/LDAPilot-linux-amd64.rpm"
install -m 755 "$bin40" "$stage/ldapilot"
PKG_RELEASE=1.el9 DEB_WEBKIT=libwebkit2gtk-4.0-37 RPM_WEBKIT='libwebkit2gtk-4.0.so.37()(64bit)' \
	nfpm package -f build/linux/nfpm.yaml -p rpm -t "$out/LDAPilot-linux-amd64.el9.rpm"

# Per-user archive: install.sh picks the binary that matches the WebKitGTK found.
dir="$stage/LDAPilot-linux-amd64"
mkdir -p "$dir/icons"
install -m 755 "$bin41" "$dir/LDAPilot-linux-amd64-webkit2_41"
install -m 755 "$bin40" "$dir/LDAPilot-linux-amd64"
install -m 755 build/linux/install.sh "$dir/install.sh"
install -m 644 "build/linux/$id.desktop" "$stage/$id.metainfo.xml" LICENSE "$dir/"
install -m 644 build/linux/icons/48.png build/linux/icons/64.png build/linux/icons/128.png "$dir/icons/"
install -m 644 build/linux/icon.png "$dir/icons/256.png"
tar -C "$stage" --owner=0 --group=0 -czf "$out/LDAPilot-linux-amd64.tar.gz" LDAPilot-linux-amd64

ls -l "$out"
