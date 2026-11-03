#!/bin/sh
#
# Restore the Skiff control-plane SQLite database from Litestream/R2.
#
#   sudo skiff-restore --yes
#   sudo skiff-restore --yes --from offsite
#   sudo skiff-restore --recovery-kit /root/skiff-recovery-kit-edge-2026-11-03.age
#
# What it does:
#   0. With --recovery-kit: decrypts the kit (scripts/recovery-kit.ts) and installs its master key
#      (and skiff.env, if the kit has one) before anything else, so a fresh VPS gets the R2
#      credentials and the key the restored secrets are encrypted with. Replaced files are kept
#      as *.pre-recovery-<UTC>. Non-interactive: SKIFF_RECOVERY_PASSPHRASE_FILE=<file>.
#   1. Stops the control plane and Litestream (agents + Caddy keep serving cached state).
#   2. Snapshots the current SQLite database to /var/lib/skiff/backups/pre-restore-*.db.
#   3. Restores the latest Litestream snapshot + WAL frames from R2 to a temporary file.
#   4. Verifies SQLite integrity, swaps the database in, runs forward-only migrations.
#   5. Starts the control plane, waits for the unix socket, then restarts Litestream.
#   6. Automatically restores the pre-restore snapshot if the health check fails.
#
# It does NOT reinstall Caddy/the agent, re-key WireGuard, or re-issue certificates.
# Those steps are in docs/OPS.md if this is a fresh-VPS disaster recovery.

set -eu

ENV_FILE="${SKIFF_ENV_FILE:-/etc/skiff/skiff.env}"
LITESTREAM_CONFIG="${SKIFF_LITESTREAM_CONFIG:-/etc/skiff/litestream.yml}"
# Installer layout: /opt/skiff/current/{runtime/bun,repo/scripts,repo/packages/db/migrations}.
# Release-bundle layout: $SKIFF_APP_DIR/{runtime/bun,tools,migrations}. Both are supported.
ROOT="${SKIFF_ROOT:-/opt/skiff/current}"
APP_DIR="${SKIFF_APP_DIR:-$ROOT/control-plane}"
SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
CONTROL_SOCKET="${SKIFF_CONTROL_SOCKET:-/run/skiff/control.sock}"
BACKUP_DIR="${SKIFF_BACKUP_DIR:-/var/lib/skiff/backups}"

REPLICA=""
RECOVERY_KIT=""
ASSUME_YES="${SKIFF_RESTORE_YES:-0}"
NO_START=0

say() { printf '%s\n' "$*"; }
warn() { printf 'skiff-restore: warning: %s\n' "$*" >&2; }
die() { printf 'skiff-restore: error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Read only the named keys from the systemd EnvironmentFile and export them. The file is never
# executed: values such as `Skiff <noreply@…>` or passwords containing `$`, `;` or spaces are not
# shell syntax. Double-quoted values use systemd escapes (\" \\ \` \$).
load_env() {
	_file="$1"
	shift
	while IFS= read -r _line || [ -n "$_line" ]; do
		case "$_line" in '' | '#'* | ';'*) continue ;; esac
		_key=${_line%%=*}
		[ "$_key" != "$_line" ] || continue
		_val=${_line#*=}
		for _want in "$@"; do
			[ "$_key" = "$_want" ] || continue
			case "$_val" in
				\"*\")
					_val=${_val#\"}
					_val=${_val%\"}
					_val=$(printf '%s' "$_val" | sed 's/\\\(["\\`$]\)/\1/g')
					;;
				\'*\')
					_val=${_val#\'}
					_val=${_val%\'}
					;;
			esac
			export "$_key=$_val"
		done
	done <"$_file"
}

find_bun() {
	for _candidate in "${SKIFF_BUN:-}" "$ROOT/runtime/bun" "$ROOT/runtime/bin/bun" "$APP_DIR/runtime/bun"; do
		if [ -n "$_candidate" ] && [ -x "$_candidate" ]; then
			printf '%s\n' "$_candidate"
			return 0
		fi
	done
	command -v bun 2>/dev/null
}

usage() {
	cat <<'EOF'
Usage: skiff-restore [--yes] [--from <replica-name>] [--recovery-kit <file>] [--no-start]

  --yes                 do not prompt (required for non-interactive use)
  --from <replica>      Litestream replica name from litestream.yml (default: the only one)
  --recovery-kit <file> install the master key (and skiff.env, if included) from a recovery
                        kit first; for a fresh VPS (passphrase: prompt, or
                        SKIFF_RECOVERY_PASSPHRASE_FILE)
  --no-start            restore only; leave the control plane stopped
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--yes | -y)
			ASSUME_YES=1
			shift
			;;
		--no-start)
			NO_START=1
			shift
			;;
		--from)
			[ "$#" -ge 2 ] || die "--from needs a replica name"
			REPLICA="$2"
			shift 2
			;;
		--from=*)
			REPLICA="${1#*=}"
			shift
			;;
		--recovery-kit)
			[ "$#" -ge 2 ] || die "--recovery-kit needs a file"
			RECOVERY_KIT="$2"
			shift 2
			;;
		--recovery-kit=*)
			RECOVERY_KIT="${1#*=}"
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*) die "unknown argument '$1' (see --help)" ;;
	esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"

# 0. Recovery kit first: on a fresh VPS it supplies skiff.env (R2 credentials) and the original
#    master key. The control plane only reads the key on start, which happens after the restore.
if [ -n "$RECOVERY_KIT" ]; then
	[ -r "$RECOVERY_KIT" ] || die "cannot read recovery kit $RECOVERY_KIT"
	KIT_SCRIPT=""
	for _candidate in "$SELF_DIR/recovery-kit.ts" "$APP_DIR/tools/recovery-kit.ts"; do
		if [ -f "$_candidate" ]; then
			KIT_SCRIPT="$_candidate"
			break
		fi
	done
	[ -n "$KIT_SCRIPT" ] || die "recovery-kit.ts not found next to this script or in $APP_DIR/tools"
	KIT_BUN=$(find_bun || true)
	[ -n "$KIT_BUN" ] || die "no Bun runtime found for the recovery kit (set SKIFF_BUN)"
	if [ "$ASSUME_YES" != "1" ]; then
		printf 'Replace the master key (and skiff.env, if in the kit) from %s, then the database from R2? Type "restore" to continue: ' "$RECOVERY_KIT"
		read -r _answer || die "aborted (no input)"
		[ "$_answer" = "restore" ] || die "aborted"
		ASSUME_YES=1
	fi
	say "Installing the master key from the recovery kit"
	# --force: the restored database's secrets are encrypted with the kit's key, so it must win
	# over whatever key a fresh install generated (the old one is kept as *.pre-recovery-*).
	SKIFF_ENV_FILE="$ENV_FILE" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
		"$KIT_BUN" "$KIT_SCRIPT" import "$RECOVERY_KIT" --force --restore-env ||
		die "recovery kit import failed; nothing else was changed"
fi

[ -r "$ENV_FILE" ] || die "missing $ENV_FILE (is Skiff installed?)"
[ -r "$LITESTREAM_CONFIG" ] || die "missing $LITESTREAM_CONFIG (is Litestream configured?)"
have litestream || die "litestream is not installed (see docs/OPS.md)"
have sqlite3 || die "sqlite3 is not installed"

load_env "$ENV_FILE" SKIFF_DATA_DIR R2_ACCOUNT_ID R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
# litestream.yml needs the endpoint; installs from before it was written only have the account id.
if [ -z "${R2_ENDPOINT:-}" ] && [ -n "${R2_ACCOUNT_ID:-}" ]; then
	export R2_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
fi

DB_PATH="${SKIFF_DATA_DIR:-/var/lib/skiff/data}/skiff.db"
DB_DIR=$(dirname "$DB_PATH")
[ -d "$DB_DIR" ] || die "database directory $DB_DIR does not exist"
[ -f "$DB_PATH" ] || warn "no current database at $DB_PATH; a restore will create it"

if [ "$ASSUME_YES" != "1" ]; then
	printf 'Replace %s from R2? Type "restore" to continue: ' "$DB_PATH"
	read -r _answer || die "aborted (no input)"
	[ "$_answer" = "restore" ] || die "aborted"
fi

LS_WAS_ACTIVE=0
SERVICES_STOPPED=0
TMP_DB=""
SNAPSHOT=""
RESTORE_DONE=0

# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
	rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"
	if [ "$SERVICES_STOPPED" = "1" ] && [ "$NO_START" != "1" ]; then
		systemctl start skiff-control-plane.service >/dev/null 2>&1 || true
		if [ "$LS_WAS_ACTIVE" = "1" ]; then
			systemctl start skiff-litestream.service >/dev/null 2>&1 || true
		fi
	fi
}
trap cleanup EXIT HUP INT TERM

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

restart_services_after_restore() {
	systemctl start skiff-control-plane.service
	if ! wait_for_control_plane; then
		return 1
	fi
	if [ "$LS_WAS_ACTIVE" = "1" ]; then
		systemctl start skiff-litestream.service
	fi
	SERVICES_STOPPED=0
	return 0
}

rollback_to_snapshot() {
	if [ "$RESTORE_DONE" != "1" ] || [ -z "$SNAPSHOT" ] || [ ! -f "$SNAPSHOT" ]; then
		warn "no pre-restore snapshot to roll back to"
		return 1
	fi
	warn "rolling back to $SNAPSHOT"
	systemctl stop skiff-control-plane.service >/dev/null 2>&1 || true
	rm -f "$DB_PATH-wal" "$DB_PATH-shm"
	cp "$SNAPSHOT" "$DB_PATH"
	chown skiff:skiff "$DB_PATH"
	chmod 0640 "$DB_PATH"
	RESTORE_DONE=0
	if [ "$NO_START" = "1" ]; then
		SERVICES_STOPPED=0
		warn "rolled back; services left stopped (--no-start)"
		return 0
	fi
	if restart_services_after_restore; then
		warn "rolled back; the original database is serving again"
	else
		warn "rollback also failed to become healthy"
	fi
}

say "Checking service state"
systemctl is-active --quiet skiff-litestream.service && LS_WAS_ACTIVE=1

say "Stopping skiff-control-plane and skiff-litestream (agents and Caddy stay up)"
systemctl stop skiff-control-plane.service >/dev/null 2>&1 || true
systemctl stop skiff-litestream.service >/dev/null 2>&1 || true
SERVICES_STOPPED=1

# 1. Snapshot the current database. .backup is safe even with WAL pages present.
if [ -f "$DB_PATH" ]; then
	mkdir -p "$BACKUP_DIR"
	SNAPSHOT="$BACKUP_DIR/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).db"
	say "Snapshotting current database to $SNAPSHOT"
	sqlite3 "$DB_PATH" ".backup '$SNAPSHOT'" || die "could not snapshot $DB_PATH"
	chown skiff:skiff "$SNAPSHOT"
	chmod 0640 "$SNAPSHOT"
fi

# 2. Restore latest snapshot + WALs into a scratch file next to the target, so the final
#    move is on the same filesystem and atomic.
TMP_DB="$DB_PATH.restore.$$"
rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm"
say "Downloading the latest Litestream snapshot + WAL frames from R2"
if [ -n "$REPLICA" ]; then
	litestream restore -config "$LITESTREAM_CONFIG" -replica "$REPLICA" -o "$TMP_DB" "$DB_PATH"
else
	litestream restore -config "$LITESTREAM_CONFIG" -o "$TMP_DB" "$DB_PATH"
fi
[ -s "$TMP_DB" ] || die "Litestream produced an empty database"

CHECK=$(sqlite3 "$TMP_DB" 'PRAGMA integrity_check;' 2>&1 || true)
[ "$CHECK" = "ok" ] || die "restored database failed integrity_check: $CHECK"
say "Restored database passed integrity_check"

# The integrity check can leave a WAL/shm sidecar. Collapse it so the final move is a
# single self-contained file; if the checkpoint failed, take a safe .backup instead of
# deleting WAL frames.
sqlite3 "$TMP_DB" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true
if [ -s "$TMP_DB-wal" ]; then
	say "Collapsing the restored WAL into a single database file"
	sqlite3 "$TMP_DB" ".backup '$TMP_DB.copy'" || die "could not collapse the restored WAL"
	mv "$TMP_DB.copy" "$TMP_DB"
fi
rm -f "$TMP_DB-wal" "$TMP_DB-shm"

# 3. Swap it in. Remove stale WAL/SHM from the old database first.
chown skiff:skiff "$TMP_DB"
chmod 0640 "$TMP_DB"
rm -f "$DB_PATH-wal" "$DB_PATH-shm"
mv "$TMP_DB" "$DB_PATH"
RESTORE_DONE=1

# 4. Forward-only migrations. packages/db applies them on open, but running the migrator before
#    start makes the restore deterministic and fails early. If they fail, put the pre-restore
#    database back rather than starting the control plane on a half-migrated restore.
MIGRATOR=""
MIGRATIONS=""
if [ -f "$SELF_DIR/skiff-migrate.ts" ] && [ -d "$SELF_DIR/../packages/db/migrations" ]; then
	MIGRATOR="$SELF_DIR/skiff-migrate.ts"
	MIGRATIONS="$SELF_DIR/../packages/db/migrations"
elif [ -f "$APP_DIR/tools/skiff-migrate.ts" ] && [ -d "$APP_DIR/migrations" ]; then
	MIGRATOR="$APP_DIR/tools/skiff-migrate.ts"
	MIGRATIONS="$APP_DIR/migrations"
fi
BUN=$(find_bun || true)
if [ -n "$MIGRATOR" ] && [ -n "$BUN" ] && have runuser; then
	say "Applying migrations"
	if ! runuser -u skiff -- env BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
		"$BUN" "$MIGRATOR" "$DB_PATH" "$MIGRATIONS"; then
		warn "migrations failed on the restored database"
		rollback_to_snapshot || true
		die "restore aborted: migrations failed"
	fi
else
	warn "migrator, Bun or runuser not found; the control plane will apply migrations on start"
fi

if [ "$NO_START" = "1" ]; then
	say "Restore complete; services left stopped (--no-start)."
	SERVICES_STOPPED=0
	exit 0
fi

# 5. Start and verify. Roll back automatically if the control plane cannot serve.
say "Starting the control plane"
if restart_services_after_restore; then
	say "Restore complete. Database: $DB_PATH"
	say "Pre-restore snapshot kept at: ${SNAPSHOT:-<none>}"
	exit 0
fi

warn "control plane did not become healthy after restore"
systemctl status skiff-control-plane.service --no-pager >&2 || true
journalctl -u skiff-control-plane.service -n 50 --no-pager >&2 || true

rollback_to_snapshot || true
exit 1
