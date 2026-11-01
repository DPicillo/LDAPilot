#!/usr/bin/env sh
# Production build with the version stamp (RW1-C-04). Wails always builds
# with -buildvcs=false, so the Go build info never carries the git revision:
# version, commit and build date have to be passed as ldflags.
#
#   scripts/build.sh                     # native build
#   scripts/build.sh -platform windows/amd64
#   scripts/build.sh -tags webkit2_41    # Debian 13+
#
# Extra arguments go to `wails build`. The version is the one wails.json
# declares (info.productVersion, also services.ReleaseVersion and
# frontend/package.json), e.g. v0.5.0; VERSION overrides it.
set -eu
cd "$(dirname "$0")/.."
declared="$(sed -n 's/.*"productVersion": *"\([^"]*\)".*/\1/p' wails.json | head -n 1)"
version="${VERSION:-${declared:+v${declared}}}"
version="${version:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
commit="$(git rev-parse --short HEAD 2>/dev/null || echo '')"
date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
exec wails build -ldflags "-X main.version=${version} -X main.commit=${commit} -X main.date=${date}" "$@"
