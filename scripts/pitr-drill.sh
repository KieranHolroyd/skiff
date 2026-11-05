#!/usr/bin/env bash
# Scriptable PITR restore drill (docs/PITR.md). Queues a restore to a chosen timestamp through the
# control-plane REST surface, waits for the node to verify it, then runs a canary query.
#
# Required:
#   SKIFF_CONTROL_URL          e.g. https://control.example.com (no trailing slash)
#   SKIFF_API_TOKEN            bearer token with database:create and database:credentials
#   SKIFF_PITR_DRILL_DATABASE  source database name
#   SKIFF_PITR_DRILL_TARGET    new database name for the drill
#   SKIFF_PITR_DRILL_TARGET_TIME  ISO 8601 timestamp, e.g. 2026-11-05T09:30:00.000Z
#
# Optional:
#   SKIFF_PITR_CANARY_SQL      SQL run against the restored database (default: SELECT 1)
#   SKIFF_PITR_DRILL_TIMEOUT   seconds to wait for verified_at (default: 3600)
#
# This script is the documented remaining step towards a fully automated drill: it needs a node
# with the custom pgBackRest-enabled Postgres image and a reachable S3 repository.

set -euo pipefail

: "${SKIFF_CONTROL_URL:?set SKIFF_CONTROL_URL}"
: "${SKIFF_API_TOKEN:?set SKIFF_API_TOKEN}"
: "${SKIFF_PITR_DRILL_DATABASE:?set SKIFF_PITR_DRILL_DATABASE}"
: "${SKIFF_PITR_DRILL_TARGET:?set SKIFF_PITR_DRILL_TARGET}"
: "${SKIFF_PITR_DRILL_TARGET_TIME:?set SKIFF_PITR_DRILL_TARGET_TIME}"

CANARY_SQL="${SKIFF_PITR_CANARY_SQL:-SELECT 1}"
TIMEOUT="${SKIFF_PITR_DRILL_TIMEOUT:-3600}"
BASE="${SKIFF_CONTROL_URL%/}/api/v1/databases"

command -v curl >/dev/null || { echo "pitr-drill: curl is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "pitr-drill: python3 is required" >&2; exit 1; }

api() {
	local method="$1" path="$2" body="${3:-}"
	if [ -n "$body" ]; then
		curl -sS -f -X "$method" \
			-H "authorization: Bearer ${SKIFF_API_TOKEN}" \
			-H 'content-type: application/json' \
			--data "$body" "${BASE}${path}"
	else
		curl -sS -f -X "$method" \
			-H "authorization: Bearer ${SKIFF_API_TOKEN}" \
			"${BASE}${path}"
	fi
}

json_get() {
	python3 -c '
import json, sys
d = json.load(sys.stdin)
for part in sys.argv[1].split("."):
    if part:
        d = d[part]
print(d)
' "$1"
}

BODY=$(python3 -c '
import json,sys
print(json.dumps({"name": sys.argv[1], "targetTime": sys.argv[2]}))
' "$SKIFF_PITR_DRILL_TARGET" "$SKIFF_PITR_DRILL_TARGET_TIME")

START=$(date +%s)
echo "pitr-drill: restoring ${SKIFF_PITR_DRILL_DATABASE} to ${SKIFF_PITR_DRILL_TARGET_TIME} into ${SKIFF_PITR_DRILL_TARGET}"
CREATED=$(api POST "/$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$SKIFF_PITR_DRILL_DATABASE")/pitr/restore" "$BODY")
TARGET_ID=$(printf '%s' "$CREATED" | json_get 'database.id')
echo "pitr-drill: queued ${TARGET_ID}; waiting for verified_at (timeout ${TIMEOUT}s)"

while :; do
	STATUS=$(api GET "/$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$SKIFF_PITR_DRILL_DATABASE")/pitr")
	VERIFIED=$(printf '%s' "$STATUS" | json_get 'pitr.verifiedAt')
	RESTORED=$(printf '%s' "$STATUS" | json_get 'pitr.lastRestoreDatabaseId')
	if [ "$VERIFIED" != "None" ] && [ "$RESTORED" = "$TARGET_ID" ]; then
		break
	fi
	ERR=$(printf '%s' "$STATUS" | json_get 'pitr.error')
	if [ "$ERR" != "None" ]; then
		echo "pitr-drill: node reported failure: ${ERR}" >&2
		exit 1
	fi
	NOW=$(date +%s)
	if [ $((NOW - START)) -ge "$TIMEOUT" ]; then
		echo "pitr-drill: timed out after ${TIMEOUT}s; last status: ${STATUS}" >&2
		exit 1
	fi
	sleep 5
done

ELAPSED=$(( $(date +%s) - START ))
echo "pitr-drill: restore verified in ${ELAPSED}s"

if command -v psql >/dev/null; then
	CREDS=$(api GET "/$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$SKIFF_PITR_DRILL_TARGET")/credentials")
	URL=$(printf '%s' "$CREDS" | json_get 'credentials.url')
	RESULT=$(psql "$URL" -X -tAc "$CANARY_SQL")
	echo "pitr-drill: canary result: ${RESULT}"
else
	echo "pitr-drill: psql not installed; skipped canary SQL" >&2
fi

echo "pitr-drill: PASS"
