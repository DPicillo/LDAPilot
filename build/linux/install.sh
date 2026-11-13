#!/bin/sh
# LDAPilot: install for the current user, without root.
#   ./install.sh              install or update into ~/.local
#   ./install.sh --uninstall  remove it again (settings in ~/.config/LDAPilot stay)
# Exit codes: 0 done, 2 wrong usage, 3 WebKitGTK missing.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bin="${XDG_BIN_HOME:-$HOME/.local/bin}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
id=io.github.dpicillo.LDAPilot

case "${1:-}" in
--uninstall)
  rm -f "$bin/ldapilot" "$data/applications/$id.desktop" "$data/metainfo/$id.metainfo.xml"
  for s in 48 64 128 256; do rm -f "$data/icons/hicolor/${s}x${s}/apps/$id.png"; done
  echo "LDAPilot removed. Settings in ${XDG_CONFIG_HOME:-$HOME/.config}/LDAPilot were kept."
  exit 0 ;;
"") ;;
*) echo "usage: $0 [--uninstall]" >&2; exit 2 ;;
esac

has_lib() {
  for d in /usr/lib/x86_64-linux-gnu /usr/lib64 /usr/lib /lib/x86_64-linux-gnu /lib64; do
    [ -e "$d/$1" ] && return 0
  done
  return 1
}
if has_lib libwebkit2gtk-4.1.so.0; then variant=LDAPilot-linux-amd64-webkit2_41
elif has_lib libwebkit2gtk-4.0.so.37; then variant=LDAPilot-linux-amd64
else
  echo "WebKitGTK is not installed. Install libwebkit2gtk-4.1-0 (Debian, Ubuntu), webkit2gtk4.1 (Fedora, RHEL 10 with EPEL) or libwebkit2gtk-4_1-0 (openSUSE)." >&2
  exit 3
fi

install -D -m 755 "$here/$variant" "$bin/ldapilot"
mkdir -p "$data/applications"
sed "s|^Exec=.*|Exec=$bin/ldapilot|" "$here/$id.desktop" > "$data/applications/$id.desktop"
chmod 644 "$data/applications/$id.desktop"
install -D -m 644 "$here/$id.metainfo.xml" "$data/metainfo/$id.metainfo.xml"
for s in 48 64 128 256; do
  install -D -m 644 "$here/icons/$s.png" "$data/icons/hicolor/${s}x${s}/apps/$id.png"
done
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$data/applications" || true
echo "LDAPilot installed: $bin/ldapilot ($variant)"
