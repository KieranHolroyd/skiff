#!/bin/sh
#
# Skiff monthly restore drill.
#
#   sudo skiff-restore-drill           # normal, drives the systemd timer too
#   sudo skiff-restore-drill --quiet   # what skiff-restore-drill.service runs
#
# Restores the latest Litestream snapshot + WAL frames from R2 into a scratch directory,
# then compares it with the live database: table list, row counts and a SHA-256 over every
# row (ordered by primary key). Any difference, a missing backup, or an integrity failure
# exits non-zero (which is what the timer's failure alert keys off).
#
# The control plane and Litestream are briefly stopped so the comparison is deterministic
# (Litestream flushes its final WAL frames on SIGTERM). Agents and Caddy keep serving the
# last desired state, so sites stay up. Set SKIFF_DRILL_NO_QUIESCE=1 for a best-effort
# comparison while everything keeps running (it can produce false mismatches).

set -eu

ENV_FILE="${SKIFF_ENV_FILE:-/etc/skiff/skiff.env}"
LITESTREAM_CONFIG="${SKIFF_LITESTREAM_CONFIG:-/etc/skiff/litestream.yml}"
APP_DIR="${SKIFF_APP_DIR:-/opt/skiff/current/control-plane}"
CONTROL_SOCKET="${SKIFF_CONTROL_SOCKET:-/run/skiff/control.sock}"
DRILL_DIR="${SKIFF_RESTORE_DRILL_DIR:-/var/lib/skiff/drill}"
KEEP="${SKIFF_RESTORE_DRILL_KEEP:-3}"
STATUS_FILE="$DRILL_DIR/status.json"

QUIET=0
NO_QUIESCE="${SKIFF_DRILL_NO_QUIESCE:-0}"

say() { [ "$QUIET" = "1" ] || printf '%s\n' "$*"; }
warn() { printf 'skiff-drill: warning: %s\n' "$*" >&2; }
die() { printf 'skiff-drill: error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

for _arg in "$@"; do
	case "$_arg" in
		--quiet | -q) QUIET=1 ;;
		--no-quiesce) NO_QUIESCE=1 ;;
		-h | --help)
			cat <<'EOF'
Usage: skiff-restore-drill [--quiet] [--no-quiesce]

  --quiet       only print on failure (used by the systemd timer)
  --no-quiesce  do not stop the control plane/Litestream; comparison is best-effort
EOF
			exit 0
			;;
		*) die "unknown argument '$_arg'" ;;
	esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -r "$ENV_FILE" ] || die "missing $ENV_FILE"
[ -r "$LITESTREAM_CONFIG" ] || die "missing $LITESTREAM_CONFIG"
have litestream || die "litestream is not installed"
have sqlite3 || die "sqlite3 is not installed"
have cmp || die "cmp is not installed"
have curl || die "curl is not installed"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

DB_PATH="${SKIFF_DATA_DIR:-/var/lib/skiff/data}/skiff.db"
[ -f "$DB_PATH" ] || die "live database $DB_PATH does not exist"

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
FINGERPRINT="$SELF_DIR/skiff-db-fingerprint.ts"
if [ ! -f "$FINGERPRINT" ]; then
	# Release bundles put shared helpers in control-plane/tools/.
	FINGERPRINT="$APP_DIR/tools/skiff-db-fingerprint.ts"
fi
[ -f "$FINGERPRINT" ] || die "missing fingerprint helper (looked in $SELF_DIR and $APP_DIR/tools)"

BUN="${SKIFF_BUN:-$APP_DIR/runtime/bun}"
if [ ! -x "$BUN" ]; then
	have bun || die "no Bun runtime (expected $APP_DIR/runtime/bun)"
	BUN=$(command -v bun)
fi

mkdir -p "$DRILL_DIR"
RUN_DIR="$DRILL_DIR/run-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$RUN_DIR"

CP_WAS_ACTIVE=0
LS_WAS_ACTIVE=0
SERVICES_STOPPED=0

wait_for_control_plane() {
	_i=0
	while [ "$_i" -lt "${SKIFF_HEALTH_TIMEOUT:-60}" ]; do
		_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
			--unix-socket "$CONTROL_SOCKET" http://localhost/ 2>/dev/null || true)
		case "$_code" in
			2* | 3* | 4*) return 0 ;;
		esac
		_i=$((_i + 1))
		sleep 1
	done
	return 1
}

# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
	if [ "$SERVICES_STOPPED" = "1" ]; then
		if [ "$CP_WAS_ACTIVE" = "1" ]; then
			systemctl start skiff-control-plane.service >/dev/null 2>&1 || true
			wait_for_control_plane >/dev/null 2>&1 || true
		fi
		if [ "$LS_WAS_ACTIVE" = "1" ]; then
			systemctl start skiff-litestream.service >/dev/null 2>&1 || true
		fi
	fi
}
trap cleanup EXIT HUP INT TERM

write_status() {
	_ok="$1"
	_reason="$2"
	_tmp="$STATUS_FILE.tmp.$$"
	printf '{"ok":%s,"at":"%s","live":"%s","restored":"%s","reason":"%s"}\n' \
		"$_ok" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DB_PATH" "$RUN_DIR/restored.db" "$_reason" \
		>"$_tmp"
	mv "$_tmp" "$STATUS_FILE"
}

say "Restore drill starting; scratch directory: $RUN_DIR"

systemctl is-active --quiet skiff-control-plane.service && CP_WAS_ACTIVE=1
systemctl is-active --quiet skiff-litestream.service && LS_WAS_ACTIVE=1

if [ "$NO_QUIESCE" = "1" ]; then
	warn "SKIFF_DRILL_NO_QUIESCE=1: the comparison may differ because writes are in flight"
else
	say "Quiescing control plane and Litestream for a consistent comparison"
	systemctl stop skiff-control-plane.service >/dev/null 2>&1 || true
	systemctl stop skiff-litestream.service >/dev/null 2>&1 || true
	SERVICES_STOPPED=1
fi

say "Restoring the latest snapshot from R2"
if ! litestream restore -config "$LITESTREAM_CONFIG" -o "$RUN_DIR/restored.db" "$DB_PATH"; then
	write_status false "litestream restore failed"
	die "litestream restore failed (is R2 reachable and configured?)"
fi
[ -s "$RUN_DIR/restored.db" ] || {
	write_status false "restored database is empty"
	die "restored database is empty"
}

CHECK=$(sqlite3 "$RUN_DIR/restored.db" 'PRAGMA integrity_check;' 2>&1 || true)
[ "$CHECK" = "ok" ] || {
	write_status false "integrity_check failed"
	die "restored database failed integrity_check: $CHECK"
}

say "Fingerprinting live and restored databases"
"$BUN" "$FINGERPRINT" "$DB_PATH" >"$RUN_DIR/live.json" ||
	{
		write_status false "live fingerprint failed"
		die "could not fingerprint the live database"
	}
"$BUN" "$FINGERPRINT" "$RUN_DIR/restored.db" >"$RUN_DIR/restored.json" ||
	{
		write_status false "restored fingerprint failed"
		die "could not fingerprint the restored database"
	}

if ! cmp -s "$RUN_DIR/live.json" "$RUN_DIR/restored.json"; then
	write_status false "table counts/checksum differ"
	if have diff; then
		diff -u "$RUN_DIR/live.json" "$RUN_DIR/restored.json" >&2 || true
	fi
	die "restore drill FAILED: restored data does not match the live database (artifacts in $RUN_DIR)"
fi

TABLES=$(grep -c '"rows"' "$RUN_DIR/live.json" || true)
CHECKSUM=$(grep '"sha256"' "$RUN_DIR/live.json" | tail -n 1 | sed -E 's/.*"sha256": *"([0-9a-f]+)".*/\1/')
write_status true "ok"
say "Restore drill PASSED: $TABLES tables, checksum $CHECKSUM"

# Restart services now rather than waiting for the EXIT trap so the health check can fail
# the drill if the control plane does not come back.
if [ "$SERVICES_STOPPED" = "1" ]; then
	if [ "$CP_WAS_ACTIVE" = "1" ]; then
		say "Restarting the control plane"
		systemctl start skiff-control-plane.service
		if ! wait_for_control_plane; then
			write_status false "control plane unhealthy after drill"
			die "control plane did not become healthy after the drill"
		fi
	fi
	if [ "$LS_WAS_ACTIVE" = "1" ]; then
		systemctl start skiff-litestream.service
	fi
	SERVICES_STOPPED=0
fi

# Keep the newest N run directories. Failures are kept regardless by returning above.
if [ "$KEEP" -gt 0 ]; then
	_i=0
	for _dir in $(ls -1dt "$DRILL_DIR"/run-* 2>/dev/null || true); do
		_i=$((_i + 1))
		[ "$_i" -le "$KEEP" ] && continue
		rm -rf "$_dir"
	done
fi

exit 0
