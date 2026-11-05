#!/usr/bin/env bash
# PID 1 for the Skiff node image.
#
# Caddy and the agent share one container: the agent drives Caddy's admin API
# over the unix socket in /run/skiff, and Caddy serves the agent's release
# cache, so both need the same filesystem and user. A supervisor keeps the pair
# together — if either exits, the container exits and the restart policy runs
# both again from the same persisted state.
#
# Any argument bypasses the supervisor, so one-off commands work:
#   docker compose run --rm --entrypoint /opt/skiff/skiff-agent node join ...

set -euo pipefail

if [ "$#" -gt 0 ]; then
	exec "$@"
fi

/opt/skiff/caddy run \
	--resume \
	--config /etc/caddy/skiff.Caddyfile \
	--adapter caddyfile &
caddy_pid=$!

/opt/skiff/skiff-agent &
agent_pid=$!

stop() {
	kill -TERM "$agent_pid" "$caddy_pid" 2>/dev/null || true
}
trap stop TERM INT

# Exit as soon as either process does; the other is stopped below.
set +e
wait -n "$caddy_pid" "$agent_pid"
status=$?
set -e

stop
wait 2>/dev/null || true
exit "$status"
