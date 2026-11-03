#!/bin/sh
#
# Skiff bootstrap. Downloads Bun and the repository, then hands over to the Bun installer
# (scripts/install/main.ts) which does all system setup, builds, service installation and
# health checks. Keep this file small: it must run before anything else exists on the host.
#
#   curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/skiff/main/install.sh | sudo sh
#
# Environment:
#   SKIFF_REPO           GitHub repo (default KieranHolroyd/skiff)
#   SKIFF_REF            git ref/tag/branch (default main)
#   SKIFF_GITHUB_TOKEN   token for a private repo
#   SKIFF_BUN_VERSION    Bun version (default 1.4.0)
#   SKIFF_SOURCE_DIR     use an existing checkout instead of downloading
#   SKIFF_YES=1          non-interactive installer
#
set -eu

REPO="${SKIFF_REPO:-KieranHolroyd/skiff}"
REF="${SKIFF_REF:-main}"
BUN_VERSION="${SKIFF_BUN_VERSION:-1.4.0}"
OPT_DIR="${SKIFF_OPT_DIR:-/opt/skiff}"
BUN_DIR="${SKIFF_BUN_DIR:-$OPT_DIR/runtime}"
BUN="$BUN_DIR/bin/bun"

say() { printf '\033[1mSkiff\033[0m %s\n' "$*"; }
die() { printf '\033[31mSkiff bootstrap:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (curl … | sudo sh)"

case "$(uname -s)" in
	Linux) ;;
	*) die "Skiff installs on Linux only." ;;
esac
case "$(uname -m)" in
	x86_64 | amd64) ARCH="x64" ;;
	aarch64 | arm64) ARCH="arm64" ;;
	*) die "unsupported architecture $(uname -m)" ;;
esac

missing=""
for cmd in curl tar unzip; do
	command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
done
if [ -n "$missing" ]; then
	command -v apt-get >/dev/null 2>&1 || die "missing:$missing and apt-get is unavailable"
	say "installing:$missing"
	apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl tar unzip
fi

# --- Bun ------------------------------------------------------------------
if [ -x "$BUN" ]; then
	HAVE="$("$BUN" --version 2>/dev/null || true)"
	say "using Bun $HAVE at $BUN"
else
	say "downloading Bun v$BUN_VERSION for linux-$ARCH"
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT HUP INT TERM
	url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${ARCH}.zip"
	curl -fsSL --retry 3 --retry-delay 2 -o "$tmp/bun.zip" "$url" || die "failed to download Bun from $url"
	unzip -q "$tmp/bun.zip" -d "$tmp"
	bin="$(find "$tmp" -type f -name bun -perm -u+x | head -n 1)"
	[ -n "$bin" ] || die "Bun archive did not contain a bun binary"
	install -d -m 0755 "$BUN_DIR/bin"
	install -m 0755 "$bin" "$BUN"
	rm -rf "$tmp"
	trap - EXIT HUP INT TERM
	say "installed Bun $("$BUN" --version) at $BUN"
fi

# --- repository -----------------------------------------------------------
if [ -n "${SKIFF_SOURCE_DIR:-}" ]; then
	[ -f "$SKIFF_SOURCE_DIR/scripts/install/main.ts" ] || die "SKIFF_SOURCE_DIR does not look like Skiff"
	SRC="$SKIFF_SOURCE_DIR"
	say "using source at $SRC"
else
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT HUP INT TERM
	say "downloading $REPO@$REF"
	if [ -n "${SKIFF_GITHUB_TOKEN:-}" ]; then
		curl -fsSL --retry 3 --retry-delay 2 \
			-H "Authorization: Bearer $SKIFF_GITHUB_TOKEN" \
			-H "Accept: application/vnd.github+json" \
			"https://api.github.com/repos/$REPO/tarball/$REF" \
			-o "$tmp/repo.tar.gz" || die "failed to download repository (token/ref?)"
	else
		curl -fsSL --retry 3 --retry-delay 2 \
			"https://codeload.github.com/$REPO/tar.gz/$REF" \
			-o "$tmp/repo.tar.gz" || die "failed to download repository"
	fi
	mkdir -p "$tmp/src"
	tar -xzf "$tmp/repo.tar.gz" -C "$tmp/src" --strip-components=1
	[ -f "$tmp/src/scripts/install/main.ts" ] || die "repository archive is missing the installer"
	SRC="$tmp/src"
fi

# --- hand over ------------------------------------------------------------
export SKIFF_SOURCE_DIR="$SRC"
export SKIFF_REPO="$REPO"
export SKIFF_SOURCE_REF="$REF"
say "starting the Bun installer"
if [ -t 0 ] || [ -t 1 ]; then
	exec "$BUN" run "$SRC/scripts/install/main.ts" "$@" < /dev/tty
fi
exec "$BUN" run "$SRC/scripts/install/main.ts" "$@"
