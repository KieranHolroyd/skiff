#!/bin/sh
#
# Skiff -> Yoal host converter bootstrap.
#
#   curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/yoal/main/scripts/migrate/skiff-to-yoal.sh \
#     | sudo sh -s -- --dry-run
#
# Finds the Bun binary the old Skiff install already carries, then runs the self-contained
# TypeScript converter (scripts/migrate/skiff-to-yoal.ts). Arguments are passed through.
#
# Environment:
#   YOAL_RAW_BASE   raw GitHub base URL (default the yoal main branch)
#   YOAL_BUN        explicit Bun binary to use
#
set -eu

RAW="${YOAL_RAW_BASE:-https://raw.githubusercontent.com/KieranHolroyd/yoal/main}"
LOCAL=""
case "$0" in
	*/*)
		HERE="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || pwd)"
		LOCAL="$HERE/skiff-to-yoal.ts"
		;;
esac

say() { printf 'skiff-to-yoal: %s\n' "$*"; }
die() { say "$*" >&2; exit 1; }

find_bun() {
	if [ -n "${YOAL_BUN:-}" ]; then
		[ -x "$YOAL_BUN" ] || die "YOAL_BUN=$YOAL_BUN is not executable"
		printf '%s\n' "$YOAL_BUN"
		return
	fi
	for candidate in \
		/opt/yoal/runtime/bin/bun \
		/opt/skiff/runtime/bin/bun \
		"$(command -v bun 2>/dev/null || true)" \
		"${HOME:-/root}/.bun/bin/bun"; do
		if [ -n "$candidate" ] && [ -x "$candidate" ]; then
			printf '%s\n' "$candidate"
			return
		fi
	done
	die "Bun was not found; set YOAL_BUN to a Bun binary and run again"
}

BUN="$(find_bun)"

if [ -f "$LOCAL" ]; then
	SRC="$LOCAL"
else
	SRC="$(mktemp "${TMPDIR:-/tmp}/skiff-to-yoal.XXXXXX.ts")"
	trap 'rm -f "$SRC"' EXIT HUP INT TERM
	say "downloading the converter from $RAW"
	curl -fsSL --retry 3 --retry-delay 2 "$RAW/scripts/migrate/skiff-to-yoal.ts" -o "$SRC" \
		|| die "could not download $RAW/scripts/migrate/skiff-to-yoal.ts"
fi

exec "$BUN" "$SRC" "$@"
