/**
 * The small public installer served at `/install/node.sh` (docs/CLUSTERING.md §4.1, C1).
 *
 * It is intentionally a POSIX script rather than a second installer implementation: the machine
 * must already have the signed `skiff-agent`/`skiff-helper` bundle (the normal release install).
 * The script only starts the helper, exchanges the single-use token for a node identity, writes
 * the environment file and enables the units. The control plane never runs code on the node.
 */
export function renderNodeScript(platformOrigin: string): string {
	const origin = shellQuote(platformOrigin.replace(/\/+$/, ''));
	return `#!/bin/sh
# Skiff node installer (managed overlay, C1). The signed agent/helper bundle must already be
# installed. One token, one machine; the token is consumed by skiff-agent join.
set -eu

ORIGIN=${origin}
TOKEN=''
NAME=''

usage() {
	echo "usage: node.sh --token <join-token> --name <node-name>" >&2
	exit 2
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--token) [ "$#" -ge 2 ] || usage; TOKEN=$2; shift 2 ;;
		--name) [ "$#" -ge 2 ] || usage; NAME=$2; shift 2 ;;
		-h|--help) usage ;;
		*) echo "unknown argument: $1" >&2; usage ;;
	esac
done

[ -n "$TOKEN" ] || usage
[ -n "$NAME" ] || usage
[ "$(id -u)" = "0" ] || { echo "run as root (sudo sh -s -- ...)" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "systemd is required" >&2; exit 1; }
command -v skiff-agent >/dev/null 2>&1 || {
	echo "skiff-agent is not installed. Install the signed Skiff release bundle first." >&2
	exit 1
}

mkdir -p /etc/skiff
chmod 700 /etc/skiff
systemctl start skiff-helper >/dev/null 2>&1 || true

# Keep whatever environment file existed; a rerun repairs rather than destroys.
if [ -f /etc/skiff/agent.env ]; then
	cp /etc/skiff/agent.env "/etc/skiff/agent.env.bak.$(date +%s)"
fi

skiff-agent join "$ORIGIN" --token "$TOKEN" --name "$NAME" --network-mode skiff > /etc/skiff/agent.env
chmod 600 /etc/skiff/agent.env

systemctl enable --now skiff-helper >/dev/null 2>&1 || true
systemctl enable --now skiff-agent
echo "Node '$NAME' joined. It appears in Nodes after its first heartbeat."
`;
}

function shellQuote(value: string): string {
	if (!/^[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$/.test(value)) return `'${value.replaceAll("'", `'\\''`)}'`;
	return value;
}
