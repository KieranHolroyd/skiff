#!/bin/sh
#
# Yoal bootstrap. Downloads Bun and the repository, then hands over to the Bun installer
# (scripts/install/main.ts) which does all system setup, builds, service installation and
# health checks. Keep this file small: it must run before anything else exists on the host.
#
#   curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/yoal/main/install.sh | sudo sh
#   curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/yoal/main/install.sh | sudo sh -s -- --canary
#
# By default it installs the newest stable release (the GitHub release marked Latest) and the
# host follows the stable channel. --canary installs the head of main instead and the host
# follows canary, which gets every release (docs/OPS.md §4.1, *Release channels*).
#
# Environment:
#   YOAL_REPO           GitHub repo (default KieranHolroyd/yoal)
#   YOAL_CHANNEL        stable or canary (default: the host's current channel, else stable)
#   YOAL_REF            git ref/tag/branch to build (default: newest stable tag, or main on canary)
#   YOAL_GITHUB_TOKEN   token for a private repo
#   YOAL_BUN_VERSION    Bun version (default 1.4.0)
#   YOAL_SOURCE_DIR     use an existing checkout instead of downloading
#   YOAL_YES=1          non-interactive installer
#
set -eu

REPO="${YOAL_REPO:-KieranHolroyd/yoal}"
BUN_VERSION="${YOAL_BUN_VERSION:-1.4.0}"
OPT_DIR="${YOAL_OPT_DIR:-/opt/yoal}"
BUN_DIR="${YOAL_BUN_DIR:-$OPT_DIR/runtime}"
BUN="$BUN_DIR/bin/bun"

say() { printf '\033[1mYoal\033[0m %s\n' "$*"; }
die() { printf '\033[31mYoal bootstrap:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (curl … | sudo sh)"

# --- release channel --------------------------------------------------------
# --canary wins, then YOAL_CHANNEL, then what this host already follows, then stable.
CHANNEL="${YOAL_CHANNEL:-}"
for arg in "$@"; do
	case "$arg" in --canary) CHANNEL="canary" ;; esac
done
if [ -z "$CHANNEL" ] && [ -r /var/lib/yoal-update/channel ]; then
	CHANNEL="$(tr -d '[:space:]' < /var/lib/yoal-update/channel)"
fi
if [ -z "$CHANNEL" ] && [ -r /etc/yoal/yoal.env ]; then
	CHANNEL="$(sed -n 's/^YOAL_UPDATE_CHANNEL=//p' /etc/yoal/yoal.env | tail -n 1 | tr -d "\"' ")"
fi
CHANNEL="${CHANNEL:-stable}"
case "$CHANNEL" in
	stable | canary) ;;
	*) die "YOAL_CHANNEL must be stable or canary (got $CHANNEL)" ;;
esac

case "$(uname -s)" in
	Linux) ;;
	*) die "Yoal installs on Linux only." ;;
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
TRACK_REF="${YOAL_REF:-main}"
TAG=""
if [ -n "${YOAL_SOURCE_DIR:-}" ]; then
	[ -f "$YOAL_SOURCE_DIR/scripts/install/main.ts" ] || die "YOAL_SOURCE_DIR does not look like Yoal"
	SRC="$YOAL_SOURCE_DIR"
	say "using source at $SRC"
else
	if [ -n "${YOAL_REF:-}" ]; then
		REF="$YOAL_REF"
	elif [ "$CHANNEL" = "canary" ]; then
		REF="main"
	else
		say "finding the newest stable release of $REPO"
		if [ -n "${YOAL_GITHUB_TOKEN:-}" ]; then
			latest="$(curl -fsSL --retry 3 --retry-delay 2 \
				-H "Authorization: Bearer $YOAL_GITHUB_TOKEN" \
				-H "Accept: application/vnd.github+json" \
				"https://api.github.com/repos/$REPO/releases/latest")" || latest=""
		else
			latest="$(curl -fsSL --retry 3 --retry-delay 2 \
				-H "Accept: application/vnd.github+json" \
				"https://api.github.com/repos/$REPO/releases/latest")" || latest=""
		fi
		TAG="$(printf '%s' "$latest" | sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
		[ -n "$TAG" ] || die "no stable release of $REPO found; pass --canary to install main, or set YOAL_REF"
		REF="$TAG"
	fi
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT HUP INT TERM
	say "downloading $REPO@$REF ($CHANNEL)"
	if [ -n "${YOAL_GITHUB_TOKEN:-}" ]; then
		curl -fsSL --retry 3 --retry-delay 2 \
			-H "Authorization: Bearer $YOAL_GITHUB_TOKEN" \
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
export YOAL_SOURCE_DIR="$SRC"
export YOAL_REPO="$REPO"
export YOAL_INSTALL_CHANNEL="$CHANNEL"
export YOAL_SOURCE_REF="$TRACK_REF"
if [ -n "$TAG" ]; then export YOAL_SOURCE_TAG="$TAG"; fi
say "starting the Bun installer"
if [ -t 0 ] || [ -t 1 ]; then
	exec "$BUN" run "$SRC/scripts/install/main.ts" "$@" < /dev/tty
fi
exec "$BUN" run "$SRC/scripts/install/main.ts" "$@"
