#!/bin/sh
# yoal-recover: out-of-band repair for when the updater itself cannot help.
#
# Published with every release, so it works even when nothing on the host can update:
#   curl -fsSL https://github.com/KieranHolroyd/yoal/releases/latest/download/yoal-recover.sh | sudo sh -s -- status
#
#   status                     releases, pointers, any interrupted update, the stage-0 updater
#   use <release|previous>     point `current` at a release on disk and restart the control plane
#   clear-verdicts             forget every recorded update failure (failed releases are retried)
#   install-updater [vX.Y.Z]   install the stage-0 updater from a published release (default: latest),
#                              verified against the signed manifest with the active release's keys
#   source-updater ARGS...     run the TypeScript updater from the current release (bypass stage-0)
#
# It never touches the database. Restoring data is `/opt/yoal/current/repo/scripts/restore.sh`.
set -eu

OPT=${YOAL_OPT_DIR:-/opt/yoal}
REPO=${YOAL_REPO:-KieranHolroyd/yoal}
UPDATER_DIR=${YOAL_UPDATER_DIR:-/usr/local/lib/yoal-updater}
BUN=${YOAL_BUN_BIN:-$OPT/runtime/bin/bun}
STATE=$OPT/update-state.json

say() { printf 'yoal-recover: %s\n' "$*"; }
die() { printf 'yoal-recover: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"

arch() {
	case "$(uname -m)" in
		x86_64 | amd64) echo amd64 ;;
		aarch64 | arm64) echo arm64 ;;
		*) die "unsupported architecture $(uname -m)" ;;
	esac
}

cmd=${1:-status}
[ $# -gt 0 ] && shift

case "$cmd" in
status)
	say "current  -> $(readlink -f "$OPT/current" 2>/dev/null || echo none)"
	say "previous -> $(readlink -f "$OPT/previous" 2>/dev/null || echo none)"
	say "standby  -> $(readlink -f "$OPT/standby" 2>/dev/null || echo none)"
	say "control.sock -> $(readlink /run/yoal/control.sock 2>/dev/null || echo 'not a symlink')"
	say "stage-0  -> $(readlink -f "$UPDATER_DIR/current" 2>/dev/null || echo 'not installed (source updater)')"
	say "releases on disk:"
	for dir in "$OPT"/releases/*/; do [ -d "$dir" ] && printf '  %s\n' "$(basename "$dir")"; done
	if [ -f "$STATE" ] && grep -q '"inProgress"' "$STATE"; then
		say "an update was interrupted; 'yoal-update-self recover' (or a reboot) resolves it"
	fi
	for unit in yoal-control-plane yoal-control-plane-standby yoal-update-guard; do
		say "$unit: $(systemctl is-active "$unit" 2>/dev/null || true)"
	done
	;;

use)
	target=${1:-}
	[ -n "$target" ] || die "usage: use <release-name|previous>"
	if [ "$target" = previous ]; then
		release=$(readlink -f "$OPT/previous") || die "no previous release"
	else
		release=$OPT/releases/$target
	fi
	[ -f "$release/repo/apps/control-plane/build/index.js" ] || die "$release is not a complete release"
	old=$(readlink -f "$OPT/current" 2>/dev/null || true)
	systemctl stop yoal-control-plane-standby.service 2>/dev/null || true
	if [ -n "$old" ] && [ "$old" != "$release" ]; then
		ln -sfn "$old" "$OPT/previous.tmp" && mv -Tf "$OPT/previous.tmp" "$OPT/previous"
	fi
	ln -sfn "$release" "$OPT/current.tmp" && mv -Tf "$OPT/current.tmp" "$OPT/current"
	rm -f "$OPT/standby"
	# An interrupted update would otherwise be "recovered" back over this choice.
	if [ -f "$STATE" ] && [ -x "$BUN" ]; then
		"$BUN" -e 'const f=process.argv[1];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));delete s.inProgress;require("fs").writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$STATE"
	fi
	systemctl restart yoal-control-plane.service
	say "current -> $release; control plane restarted (check: systemctl status yoal-control-plane)"
	;;

clear-verdicts)
	[ -f "$STATE" ] || { say "no update state"; exit 0; }
	[ -x "$BUN" ] || die "Bun not found at $BUN"
	"$BUN" -e 'const f=process.argv[1];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));s.failedCommits={};require("fs").writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$STATE"
	say "recorded update failures cleared"
	;;

install-updater)
	tag=${1:-}
	[ -x "$BUN" ] || die "Bun not found at $BUN"
	keys=$OPT/current/repo/scripts/update-self/signing.ts
	[ -f "$keys" ] || die "the active release has no signing keys ($keys); reinstall with install.sh"
	if [ -z "$tag" ]; then
		tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" |
			"$BUN" -e 'const r=JSON.parse(await Bun.stdin.text()).filter(x=>!x.draft&&!x.prerelease&&/^v\d+\.\d+\.\d+$/.test(x.tag_name)&&x.assets.some(a=>a.name==="manifest.json"));r.sort((a,b)=>Bun.semver.order(b.tag_name.slice(1),a.tag_name.slice(1)));console.log(r[0]?.tag_name??"")')
		[ -n "$tag" ] || die "no signed release of $REPO is published"
	fi
	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT
	base="https://github.com/$REPO/releases/download/$tag"
	curl -fsSL -o "$work/manifest.json" "$base/manifest.json"
	curl -fsSL -o "$work/manifest.json.sig" "$base/manifest.json.sig"
	file=$("$BUN" -e '
		const { verifyManifest, loadTrustedKeys } = await import(process.argv[1]);
		const fs = require("fs");
		const m = verifyManifest(fs.readFileSync(process.argv[2]), fs.readFileSync(process.argv[3], "utf8"), loadTrustedKeys());
		const a = m.artifacts["linux-" + process.argv[4]];
		if (!a) throw new Error("no artifact for this platform");
		console.log(a.file + " " + a.sha256);
	' "$keys" "$work/manifest.json" "$work/manifest.json.sig" "$(arch)")
	name=${file% *}
	sha=${file#* }
	say "downloading $name ($tag; manifest signature verified)"
	curl -fsSL -o "$work/$name" "$base/$name"
	echo "$sha  $work/$name" | sha256sum -c - >/dev/null || die "$name does not match its signed checksum"
	tar -xzf "$work/$name" -C "$work" updater/yoal-updated
	identity=$("$work/updater/yoal-updated" --version) || die "the updater in $tag does not run on this host"
	"$work/updater/yoal-updated" self-test || die "the updater in $tag failed its self-test"
	dir=$UPDATER_DIR/$(printf '%s' "$identity" | tr -c 'A-Za-z0-9.+_-' '_')
	mkdir -p "$dir"
	install -m 0755 "$work/updater/yoal-updated" "$dir/yoal-updated"
	ln -sfn "$dir" "$UPDATER_DIR/current.tmp" && mv -Tf "$UPDATER_DIR/current.tmp" "$UPDATER_DIR/current"
	say "stage-0 updater $identity installed from $tag"
	;;

source-updater)
	YOAL_UPDATER=source exec /usr/local/sbin/yoal-update-self "$@"
	;;

*)
	sed -n '2,15p' "$0" 2>/dev/null || true
	die "unknown command $cmd"
	;;
esac
