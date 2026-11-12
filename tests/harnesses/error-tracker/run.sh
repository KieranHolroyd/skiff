#!/usr/bin/env bash
#
# Run the JavaScript, PHP and Go Sentry SDK harnesses.
#
# By default a capture sink starts on 127.0.0.1:18080 and every event is written to ./captures/
# as JSON. Pass --dsn to send to a real Yoal or Sentry ingest endpoint instead.
#
#   ./run.sh                       # sink, all languages, one pass
#   ./run.sh --repeat 2            # two passes: check grouping by eye or in the UI
#   ./run.sh --only js             # just JavaScript
#   ./run.sh --dsn 'https://key@errors.example.com/ingest/prj_abc'
#   ./run.sh --install             # install deps first
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"

ONLY=""
REPEAT=1
INSTALL=0
KEEP=0
DSN="${ERROR_TRACKER_DSN:-}"
PORT="${SINK_PORT:-18080}"
CAPTURES_DIR="${CAPTURES_DIR:-$ROOT/captures}"
HARNESS_ENV="${HARNESS_ENV:-harness}"
SINK_PID=""
RUN_ID=""

usage() {
	cat <<'EOF'
usage: ./run.sh [options]

  --install          install missing dependencies first (runs ./setup.sh)
  --only LANG        js, php or go (default: all)
  --repeat N         run every harness N times (default: 1; use 2 for grouping)
  --dsn DSN          send to an existing ingest endpoint; do not start the sink
  --port PORT        sink port (default: 18080, or SINK_PORT)
  --keep             keep previous captures instead of clearing ./captures
  --env NAME         environment sent by the harnesses (default: harness)
  -h, --help         this text
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--install) INSTALL=1 ;;
		--only) ONLY="${2:-}"; shift ;;
		--repeat) REPEAT="${2:-}"; shift ;;
		--dsn) DSN="${2:-}"; shift ;;
		--port) PORT="${2:-}"; shift ;;
		--keep) KEEP=1 ;;
		--env) HARNESS_ENV="${2:-}"; shift ;;
		-h | --help) usage; exit 0 ;;
		*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
	esac
	shift
done

case "$REPEAT" in
	'' | *[!0-9]*) echo "--repeat must be a positive integer" >&2; exit 2 ;;
	0) echo "--repeat must be at least 1" >&2; exit 2 ;;
esac

if [ -n "$ONLY" ]; then
	case "$ONLY" in
		js | php | go) ;;
		*) echo "--only must be js, php or go" >&2; exit 2 ;;
	esac
fi

selected() {
	[ -z "$ONLY" ] || [ "$ONLY" = "$1" ]
}

if [ "$INSTALL" = 1 ]; then
	if [ -n "$ONLY" ]; then ./setup.sh "$ONLY"; else ./setup.sh; fi
fi

check_lang() {
	case "$1" in
		js) command -v node >/dev/null || { echo "node is required for the JS harness" >&2; exit 1; }
			[ -d js/node_modules ] || { echo "js dependencies missing; run ./setup.sh" >&2; exit 1; } ;;
		php) command -v php >/dev/null || { echo "php is required for the PHP harness" >&2; exit 1; }
			[ -f php/vendor/autoload.php ] || { echo "php dependencies missing; run ./setup.sh" >&2; exit 1; } ;;
		go) command -v go >/dev/null || { echo "go is required for the Go harness" >&2; exit 1; }
			[ -f go/go.sum ] || { echo "go dependencies missing; run ./setup.sh" >&2; exit 1; } ;;
	esac
}

for lang in js php go; do
	if selected "$lang"; then check_lang "$lang"; fi
done

cleanup() {
	if [ -n "$SINK_PID" ] && kill -0 "$SINK_PID" 2>/dev/null; then
		kill "$SINK_PID" 2>/dev/null || true
		wait "$SINK_PID" 2>/dev/null || true
	fi
}
trap cleanup EXIT INT TERM

if [ -z "$DSN" ]; then
	command -v bun >/dev/null || { echo "bun is required to run the capture sink" >&2; exit 1; }
	if [ "$KEEP" = 0 ]; then
		rm -rf "$CAPTURES_DIR"
	fi
	mkdir -p "$CAPTURES_DIR"
	RUN_ID="$(date -u +%Y%m%dT%H%M%S)-$$"
	SINK_PORT="$PORT" CAPTURES_DIR="$CAPTURES_DIR" CAPTURE_RUN_ID="$RUN_ID" bun run "$ROOT/sink/server.ts" >>"$CAPTURES_DIR/sink.log" 2>&1 &
	SINK_PID=$!
	ready=0
	for ((i = 0; i < 100; i++)); do
		if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ready=1; break; fi
		sleep 0.1
	done
	if [ "$ready" = 0 ]; then
		echo "sink did not start; log follows:" >&2
		cat "$CAPTURES_DIR/sink.log" >&2 || true
		exit 1
	fi
	echo "capture sink: http://127.0.0.1:$PORT (captures in $CAPTURES_DIR)"
else
	echo "using existing DSN: $DSN"
fi

project_id_for() {
	case "$1" in
		js) echo 1 ;;
		php) echo 2 ;;
		go) echo 3 ;;
	esac
}

dsn_for() {
	if [ -n "$DSN" ]; then
		printf '%s' "$DSN"
	else
		printf 'http://0123456789abcdef0123456789abcdef@127.0.0.1:%s/ingest/%s' "$PORT" "$(project_id_for "$1")"
	fi
}

run_lang() {
	local lang="$1"
	local where="project $(project_id_for "$lang") ($lang)"
	if [ -n "$DSN" ]; then where="existing DSN"; fi
	echo
	echo "=== $lang ($where)"
	case "$lang" in
		js) (cd js && ERROR_TRACKER_DSN="$(dsn_for js)" HARNESS_ENV="$HARNESS_ENV" node index.mjs) ;;
		php) (cd php && ERROR_TRACKER_DSN="$(dsn_for php)" HARNESS_ENV="$HARNESS_ENV" php index.php) ;;
		go) (cd go && ERROR_TRACKER_DSN="$(dsn_for go)" HARNESS_ENV="$HARNESS_ENV" go run .) ;;
	esac
}

for ((run = 1; run <= REPEAT; run++)); do
	if [ "$REPEAT" -gt 1 ]; then echo; echo "########## run $run/$REPEAT ##########"; fi
	for lang in js php go; do
		if selected "$lang"; then run_lang "$lang"; fi
	done
done

echo
if [ -z "$DSN" ]; then
	bun run "$ROOT/verify.ts" "$CAPTURES_DIR" "$RUN_ID" "$REPEAT" "$ONLY"
	echo
	count=$(find "$CAPTURES_DIR" -maxdepth 1 -name '*.json' ! -name 'manifest.jsonl' | wc -l | tr -d ' ')
	echo "captures: $count file(s) in $CAPTURES_DIR"
	echo "manifest: $CAPTURES_DIR/manifest.jsonl"
	echo
	echo "--- sink log (last 20)"
	tail -n 20 "$CAPTURES_DIR/sink.log" || true
else
	echo "done: events sent to $DSN"
fi
