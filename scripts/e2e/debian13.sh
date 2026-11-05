#!/bin/sh
#
# Debian 13 + Podman >= 5 + netavark wrapper for the managed-data e2e lane.
#
#   ./scripts/e2e/debian13.sh                 # verify the host, then run the harness
#   ./scripts/e2e/debian13.sh --check-host    # only verify prerequisites
#   ./scripts/e2e/debian13.sh --print-checklist
#   ./scripts/e2e/debian13.sh --engine=docker # container-level lane with Docker instead
#
# The automated part is the container-level lane: Postgres, RustFS, backup/restore, S3 and the
# object browser. Per docs/TESTING.md, the helper/Quadlet/systemd path still needs a manual run
# on the real node; this script prints that checklist instead of pretending to install it.
set -eu

MODE=run
ENGINE=podman
SKIP_OS_CHECK="${SKIFF_E2E_SKIP_OS_CHECK:-0}"

usage() {
	cat <<'EOF'
Usage: scripts/e2e/debian13.sh [options]

Options:
  --check-host        Verify Debian 13, Podman >= 5, netavark, rootless user setup.
  --print-checklist   Print the manual helper/agent/Quadlet checklist.
  --engine=podman     Container engine for the harness (default: podman).
  --engine=docker     Use Docker for the container-level lane instead.
  -h, --help          Show this help.

Environment:
  SKIFF_E2E_SKIP_OS_CHECK=1   Allow the host check to pass off Debian 13.
  SKIFF_E2E_PODMAN_SUDO=1     Prefix podman with sudo (rootful podman).
EOF
}

for arg in "$@"; do
	case "$arg" in
		--check-host) MODE=check ;;
		--print-checklist) MODE=checklist ;;
		--engine=podman) ENGINE=podman ;;
		--engine=docker) ENGINE=docker ;;
		-h | --help) usage; exit 0 ;;
		*) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
	esac
done

say() { printf '  %s\n' "$*"; }
ok() { printf 'OK    %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

check_os() {
	if [ ! -r /etc/os-release ]; then
		if [ "$SKIP_OS_CHECK" = "1" ]; then
			warn "no /etc/os-release (SKIFF_E2E_SKIP_OS_CHECK=1)"
			return
		fi
		fail "no /etc/os-release; this is not a Linux host"
	fi
	# shellcheck disable=SC1091
	. /etc/os-release
	if [ "${ID:-}" != "debian" ] || [ "${VERSION_ID:-}" != "13" ]; then
		if [ "$SKIP_OS_CHECK" = "1" ]; then
			warn "expected Debian 13, found ${ID:-unknown} ${VERSION_ID:-unknown} (SKIFF_E2E_SKIP_OS_CHECK=1)"
		else
			fail "expected Debian 13 (trixie), found ${ID:-unknown} ${VERSION_ID:-unknown}"
		fi
	else
		ok "Debian ${VERSION_ID} (${VERSION_CODENAME:-trixie})"
	fi
}

check_podman() {
	command -v podman >/dev/null 2>&1 || fail "podman is not installed (apt-get install podman netavark aardvark-dns)"
	raw="$(podman --version)"
	major="$(printf '%s' "$raw" | sed -E 's/.*version ([0-9]+).*/\1/')"
	case "$major" in
		'' | *[!0-9]*) fail "could not parse Podman version from: $raw" ;;
	esac
	[ "$major" -ge 5 ] || fail "Podman >= 5 is required, found: $raw"
	ok "$raw"

	podman info >/dev/null 2>&1 || fail "podman info failed; run 'podman info' to see the rootless/network error"
	if podman info 2>/dev/null | grep -qi 'netavark'; then
		ok "network backend reports netavark"
	else
		fail "netavark is not the active network backend (install netavark/aardvark-dns and check containers.conf)"
	fi
}

check_rootless() {
	if [ "$(id -u)" -eq 0 ]; then
		warn "running as root; rootless uid mapping is not exercised"
		return
	fi
	user="$(id -un)"
	if grep -qE "^($(id -u)|$user):" /etc/subuid 2>/dev/null &&
		grep -qE "^($(id -u)|$user):" /etc/subgid 2>/dev/null; then
		ok "subuid/subgid entries exist for $user"
	else
		warn "no subuid/subgid entry for $user; install uidmap and run 'usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $user'"
	fi
	if podman unshare true >/dev/null 2>&1; then
		ok "podman unshare works (rootless user namespace)"
	else
		warn "podman unshare failed; rootless containers will not start"
	fi
	if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
		ok "systemd --user session is available (Quadlet cases can run)"
	else
		warn "no systemd --user session; the container lane still runs, but Quadlet/netavark cases need one"
	fi
	if command -v loginctl >/dev/null 2>&1 && loginctl show-user "$user" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
		ok "linger is enabled for $user"
	else
		warn "linger is off; run 'loginctl enable-linger $user' for user units to survive logout"
	fi
}

print_checklist() {
	cat <<'EOF'

Manual Debian 13 checklist — helper / agent / Quadlet
====================================================

The container-level harness in this repository proves Postgres, RustFS, pg_dump/pg_restore and
the S3/object-browser wire path. The privileged systemd path is deliberately not faked; run it on
a disposable Debian 13 node after the container lane is green:

1. Host packages and user session
   apt-get update
   apt-get install -y podman uidmap passt netavark aardvark-dns dbus-user-session
   loginctl enable-linger skiff
   systemctl --user status >/dev/null   # must work for the skiff user

2. Build the two binaries from this checkout
   bun install --frozen-lockfile
   (cd apps/helper && bun run build)    # dist/skiff-helper
   (cd apps/agent && bun run build)     # dist/skiff-agent

3. Install and start the helper (root, unix socket only)
   install -d -m 0755 /opt/skiff/helper /opt/skiff/agent
   install -m 0755 apps/helper/dist/skiff-helper /opt/skiff/helper/skiff-helper
   install -m 0755 apps/agent/dist/skiff-agent /opt/skiff/agent/skiff-agent
   # Run /opt/skiff/helper/skiff-helper as root with:
   #   SKIFF_HELPER_SOCKET=/run/skiff-helper/helper.sock
   #   SKIFF_HELPER_QUADLET_DIR=/etc/containers/systemd
   #   SKIFF_HELPER_STATE_DIR=/var/lib/skiff-workloads
   #   SKIFF_HELPER_CONTROL_SOCKET_GROUP=skiff
   # and /usr/bin/systemctl + /usr/bin/podman present.
   # The binary creates /run/skiff-helper/helper.sock 0660 root:skiff and exits if uid != 0.

4. Enrol the agent and point it at the helper
   bun run scripts/dev/enroll-agent.ts --node <id>   # writes SKIFF_HELPER_SOCKET and agent.env
   # Add the node to the control plane, start skiff-agent as the skiff user, then verify:
   systemctl status skiff-helper skiff-agent
   ls -l /run/skiff-helper/helper.sock
   crontab-less smoke: create a database in the dashboard/CLI and watch
   journalctl -u skiff-helper -u skiff-agent -f
   podman ps --filter label=skiff
   systemctl list-units 'skiff-workload-*'
   ls /etc/containers/systemd

5. What this is meant to catch (and the container lane cannot)
   - Quadlet generation, `systemctl daemon-reload`, and the skiff-workloads.slice.
   - Rootless uid mapping and ownership of the database/storage data dirs.
   - netavark alias resolution between apps and db-<id>/s3-<id>.
   - The helper's fixed pg_dump/pg_restore verbs and the agent's presigned streaming.
   - systemd restart/stop semantics for a managed database after a failed health check.

Record the exact Podman version, kernel and `podman info` output with the run. A failure here is
a release blocker for the managed-data flag; it is not covered by the container-level CI lane.
EOF
}

check_tools() {
	command -v bun >/dev/null 2>&1 || fail "bun is not on PATH (install Bun 1.4.x)"
	ok "bun $(bun --version)"

	root="$(CDPATH="" cd -- "$(dirname -- "$0")/../.." && pwd)"
	[ -f "$root/tests/e2e/managed-data.e2e.ts" ] || fail "run this from the Skiff checkout"
	ok "checkout: $root"
}

printf '\nSkiff managed-data e2e — Debian 13 / Podman\n\n'
if [ "$MODE" = "checklist" ]; then
	print_checklist
	exit 0
fi

check_os
check_tools
if [ "$ENGINE" = "podman" ]; then
	check_podman
	check_rootless
fi

if [ "$MODE" = "check" ]; then
	print_checklist
	exit 0
fi

print_checklist

printf '\nRunning the container-level lane with %s...\n\n' "$ENGINE"
cd "$(CDPATH="" cd -- "$(dirname -- "$0")/../.." && pwd)"
SKIFF_E2E_ENGINE="$ENGINE" exec bun tests/e2e/managed-data.e2e.ts
