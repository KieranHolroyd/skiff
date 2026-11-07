#!/bin/sh
#
# Skiff bootstrap. Downloads Bun and the repository, then hands over to the Bun installer
# (scripts/install/main.ts) which does all system setup, builds, service installation and
# health checks. Keep this file small: it must run before anything else exists on the host.
#
#   curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/skiff/main/install.sh | sudo sh
#   curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/skiff/main/install.sh | sudo sh -s -- --canary
#
# By default it installs the newest stable release (the GitHub release marked Latest) and the
# host follows the stable channel. --canary installs the head of main instead and the host
# follows canary, which gets every release (docs/OPS.md §4.1, *Release channels*).
#
# Environment:
#   SKIFF_REPO           GitHub repo (default KieranHolroyd/skiff)
#   SKIFF_CHANNEL        stable or canary (default: the host's current channel, else stable)
#   SKIFF_REF            git ref/tag/branch to build (default: newest stable tag, or main on canary)
#   SKIFF_GITHUB_TOKEN   token for a private repo
#   SKIFF_BUN_VERSION    Bun version (default 1.4.0)
#   SKIFF_SOURCE_DIR     use an existing checkout instead of downloading
#   SKIFF_YES=1          non-interactive installer
#
set -eu

REPO="${SKIFF_REPO:-KieranHolroyd/skiff}"
BUN_VERSION="${SKIFF_BUN_VERSION:-1.4.0}"
OPT_DIR="${SKIFF_OPT_DIR:-/opt/skiff}"
BUN_DIR="${SKIFF_BUN_DIR:-$OPT_DIR/runtime}"
BUN="$BUN_DIR/bin/bun"

say() { printf '\033[1mSkiff\033[0m %s\n' "$*"; }
die() { printf '\033[31mSkiff bootstrap:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (curl … | sudo sh)"

# --- release channel --------------------------------------------------------
# --canary wins, then SKIFF_CHANNEL, then what this host already follows, then stable.
CHANNEL="${SKIFF_CHANNEL:-}"
for arg in "$@"; do
	case "$arg" in --canary) CHANNEL="canary" ;; esac
done
if [ -z "$CHANNEL" ] && [ -r /var/lib/skiff-update/channel ]; then
	CHANNEL="$(tr -d '[:space:]' < /var/lib/skiff-update/channel)"
fi
if [ -z "$CHANNEL" ] && [ -r /etc/skiff/skiff.env ]; then
	CHANNEL="$(sed -n 's/^SKIFF_UPDATE_CHANNEL=//p' /etc/skiff/skiff.env | tail -n 1 | tr -d "\"' ")"
fi
CHANNEL="${CHANNEL:-stable}"
case "$CHANNEL" in
	stable | canary) ;;
	*) die "SKIFF_CHANNEL must be stable or canary (got $CHANNEL)" ;;
esac

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
# The branch source builds track (meta.json `ref`); a stable install also records its tag.
TRACK_REF="${SKIFF_REF:-main}"
TAG=""
if [ -n "${SKIFF_SOURCE_DIR:-}" ]; then
	[ -f "$SKIFF_SOURCE_DIR/scripts/install/main.ts" ] || die "SKIFF_SOURCE_DIR does not look like Skiff"
	SRC="$SKIFF_SOURCE_DIR"
	say "using source at $SRC"
else
	if [ -n "${SKIFF_REF:-}" ]; then
		REF="$SKIFF_REF"
	elif [ "$CHANNEL" = "canary" ]; then
		REF="main"
	else
		say "finding the newest stable release of $REPO"
		if [ -n "${SKIFF_GITHUB_TOKEN:-}" ]; then
			latest="$(curl -fsSL --retry 3 --retry-delay 2 \
				-H "Authorization: Bearer $SKIFF_GITHUB_TOKEN" \
				-H "Accept: application/vnd.github+json" \
				"https://api.github.com/repos/$REPO/releases/latest")" || latest=""
		else
			latest="$(curl -fsSL --retry 3 --retry-delay 2 \
				-H "Accept: application/vnd.github+json" \
				"https://api.github.com/repos/$REPO/releases/latest")" || latest=""
		fi
		TAG="$(printf '%s' "$latest" | sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
		[ -n "$TAG" ] || die "no stable release of $REPO found; pass --canary to install main, or set SKIFF_REF"
		REF="$TAG"
	fi
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT HUP INT TERM
	say "downloading $REPO@$REF ($CHANNEL)"
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
export SKIFF_INSTALL_CHANNEL="$CHANNEL"
export SKIFF_SOURCE_REF="$TRACK_REF"
if [ -n "$TAG" ]; then export SKIFF_SOURCE_TAG="$TAG"; fi
say "starting the Bun installer"
if [ -t 0 ] || [ -t 1 ]; then
	exec "$BUN" run "$SRC/scripts/install/main.ts" "$@" < /dev/tty
fi
exec "$BUN" run "$SRC/scripts/install/main.ts" "$@"
