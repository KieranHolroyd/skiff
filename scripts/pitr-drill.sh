#!/usr/bin/env bash
# PITR restore drill (docs/PITR.md §Restore drill). Proves, against a real install, that a
# PITR-enabled Postgres database can be restored to a moment: the restored copy must contain a row
# written before that moment and must not contain one written after it.
#
# Run it ON THE DATABASE'S NODE (the connection URLs point at 127.0.0.1), with psql installed.
#
# Required:
#   SKIFF_CONTROL_URL          e.g. https://control.example.com (no trailing slash)
#   SKIFF_API_TOKEN            token with database:read, database:create, database:credentials
#                              (and database:delete unless SKIFF_PITR_DRILL_KEEP=1)
#   SKIFF_PITR_DRILL_DATABASE  source database name (PITR enabled, first base backup reported)
#
# Optional:
#   SKIFF_PITR_DRILL_TARGET       new database name (default: <source>-drill-<epoch>)
#   SKIFF_PITR_DRILL_TARGET_TIME  restore to this ISO 8601 time instead of writing markers; then
#                                 SKIFF_PITR_CANARY_SQL (default SELECT 1) is the only check
#   SKIFF_PITR_CANARY_SQL         SQL run against the restored database
#   SKIFF_PITR_DRILL_TIMEOUT      seconds to wait for the verified restore (default 3600)
#   SKIFF_PITR_DRILL_KEEP=1       keep the restored database (default: move it to the trash)
#
# Exit status 0 means PASS. It prints the time from queueing the restore to verification (RTO).

set -euo pipefail

: "${SKIFF_CONTROL_URL:?set SKIFF_CONTROL_URL}"
: "${SKIFF_API_TOKEN:?set SKIFF_API_TOKEN}"
: "${SKIFF_PITR_DRILL_DATABASE:?set SKIFF_PITR_DRILL_DATABASE}"

SOURCE="$SKIFF_PITR_DRILL_DATABASE"
TARGET="${SKIFF_PITR_DRILL_TARGET:-${SOURCE}-drill-$(date +%s)}"
CANARY_SQL="${SKIFF_PITR_CANARY_SQL:-SELECT 1}"
TIMEOUT="${SKIFF_PITR_DRILL_TIMEOUT:-3600}"
BASE="${SKIFF_CONTROL_URL%/}/api/v1/databases"

for tool in curl python3 psql; do
	command -v "$tool" >/dev/null || { echo "pitr-drill: $tool is required" >&2; exit 1; }
done

say() { echo "pitr-drill: $*"; }
fail() { echo "pitr-drill: FAIL: $*" >&2; exit 1; }

enc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

api() {
	local method="$1" path="$2" body="${3:-}"
	local args=(-sS -X "$method" -H "authorization: Bearer ${SKIFF_API_TOKEN}" -w '\n%{http_code}')
	[ -n "$body" ] && args+=(-H 'content-type: application/json' --data "$body")
	local out code
	out=$(curl "${args[@]}" "${BASE}${path}")
	code="${out##*$'\n'}"
	out="${out%$'\n'*}"
	if [ "$code" -ge 400 ]; then
		echo "pitr-drill: ${method} ${path} -> ${code}: ${out}" >&2
		return 1
	fi
	printf '%s' "$out"
}

# json_get <dotted.path>: prints the value, or "null".
json_get() {
	python3 -c '
import json, sys
d = json.load(sys.stdin)
for part in sys.argv[1].split("."):
    d = d.get(part) if isinstance(d, dict) else None
print("null" if d is None else d)
' "$1"
}

url_of() { api GET "/$(enc "$1")/credentials" | json_get 'credentials.url'; }

# 1. The source must have PITR on and a reported recoverable window.
STATUS=$(api GET "/$(enc "$SOURCE")/pitr")
[ "$(printf '%s' "$STATUS" | json_get 'pitr.enabled')" = "True" ] || fail "PITR is not enabled for ${SOURCE} (skif db pitr ${SOURCE} --enable)."
FROM=$(printf '%s' "$STATUS" | json_get 'pitr.recoverableFrom')
[ "$FROM" != "null" ] || fail "${SOURCE} has no recoverable window yet; wait for the first base backup and status check (skif db pitr ${SOURCE})."
ARCHIVE=$(printf '%s' "$STATUS" | json_get 'pitr.archiveStatus')
[ "$ARCHIVE" = "ok" ] || fail "WAL archive for ${SOURCE} is '${ARCHIVE}', not ok."
say "${SOURCE}: archive ok, recoverable from ${FROM}"

# 2. Markers: one row before the target time, one after. Restoring to the time must keep only the first.
BEFORE="before-$(date +%s)-$$"
AFTER="after-$(date +%s)-$$"
if [ -n "${SKIFF_PITR_DRILL_TARGET_TIME:-}" ]; then
	TARGET_TIME="$SKIFF_PITR_DRILL_TARGET_TIME"
	MARKERS=0
else
	MARKERS=1
	SOURCE_URL=$(url_of "$SOURCE")
	psql "$SOURCE_URL" -X -v ON_ERROR_STOP=1 -qc \
		"CREATE TABLE IF NOT EXISTS skiff_pitr_drill (marker text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now()); INSERT INTO skiff_pitr_drill (marker) VALUES ('${BEFORE}')"
	sleep 2
	TARGET_TIME=$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))')
	sleep 2
	psql "$SOURCE_URL" -X -v ON_ERROR_STOP=1 -qc "INSERT INTO skiff_pitr_drill (marker) VALUES ('${AFTER}')"
	# The control plane accepts a target up to two archive timeouts (2 x 60 s) behind now while the
	# archive is healthy; wait that out, then force a segment switch so the WAL is in the repository.
	say "markers written around ${TARGET_TIME}; waiting 150 s for the archive"
	sleep 150
	psql "$SOURCE_URL" -X -qtAc 'SELECT pg_switch_wal()' >/dev/null
	sleep 10
fi

# 3. Restore to the time into a new database and wait for the node to verify it.
BODY=$(python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "targetTime": sys.argv[2]}))' "$TARGET" "$TARGET_TIME")
START=$(date +%s)
say "restoring ${SOURCE} to ${TARGET_TIME} into ${TARGET}"
TARGET_ID=$(api POST "/$(enc "$SOURCE")/pitr/restore" "$BODY" | json_get 'database.id')
say "queued ${TARGET_ID}; waiting up to ${TIMEOUT}s for the verified restore"
while :; do
	STATUS=$(api GET "/$(enc "$SOURCE")/pitr")
	if [ "$(printf '%s' "$STATUS" | json_get 'pitr.lastRestoreDatabaseId')" = "$TARGET_ID" ] &&
		[ "$(printf '%s' "$STATUS" | json_get 'pitr.verifiedAt')" != "null" ] &&
		[ "$(api GET "/$(enc "$TARGET")" | json_get 'database.status')" = "running" ]; then
		break
	fi
	DB=$(api GET "/$(enc "$TARGET")")
	if [ "$(printf '%s' "$DB" | json_get 'database.status')" = "failed" ]; then
		fail "the node reported: $(printf '%s' "$DB" | json_get 'database.message')"
	fi
	[ $(( $(date +%s) - START )) -lt "$TIMEOUT" ] || fail "timed out after ${TIMEOUT}s; last status: ${STATUS}"
	sleep 5
done
RTO=$(( $(date +%s) - START ))
say "restore verified in ${RTO}s"

# 4. Check the contents.
TARGET_URL=$(url_of "$TARGET")
if [ "$MARKERS" = 1 ]; then
	HAS_BEFORE=$(psql "$TARGET_URL" -X -tAc "SELECT count(*) FROM skiff_pitr_drill WHERE marker = '${BEFORE}'")
	HAS_AFTER=$(psql "$TARGET_URL" -X -tAc "SELECT count(*) FROM skiff_pitr_drill WHERE marker = '${AFTER}'")
	[ "$HAS_BEFORE" = 1 ] || fail "the row written before ${TARGET_TIME} is missing from ${TARGET}"
	[ "$HAS_AFTER" = 0 ] || fail "the row written after ${TARGET_TIME} is present in ${TARGET}; recovery did not stop at the target"
	say "markers: before present, after absent"
fi
say "canary: $(psql "$TARGET_URL" -X -v ON_ERROR_STOP=1 -tAc "$CANARY_SQL")"

if [ "${SKIFF_PITR_DRILL_KEEP:-0}" != 1 ]; then
	api DELETE "/$(enc "$TARGET")" >/dev/null && say "moved ${TARGET} to the trash"
fi
say "PASS (RTO ${RTO}s)"
