/**
 * The small public installer served at `/install/node.sh` (docs/CLUSTERING.md §4.1, C1).
 *
 * It is intentionally a POSIX script rather than a second installer implementation: the machine
 * must already have the signed `yoal-agent`/`yoal-helper` bundle (the normal release install).
 * The script only starts the helper, exchanges the single-use token for a node identity, writes
 * the environment file and enables the units. The control plane never runs code on the node.
 */
export function renderNodeScript(platformOrigin: string): string {
	const origin = shellQuote(platformOrigin.replace(/\/+$/, ''));
	return `#!/bin/sh
# Yoal node installer (managed overlay, C1). The signed agent/helper bundle must already be
# installed. One token, one machine; the token is consumed by yoal-agent join.
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
command -v yoal-agent >/dev/null 2>&1 || {
	echo "yoal-agent is not installed. Install the signed Yoal release bundle first." >&2
	exit 1
}

mkdir -p /etc/yoal
chmod 700 /etc/yoal
systemctl start yoal-helper >/dev/null 2>&1 || true

# Keep whatever environment file existed; a rerun repairs rather than destroys.
if [ -f /etc/yoal/agent.env ]; then
	cp /etc/yoal/agent.env "/etc/yoal/agent.env.bak.$(date +%s)"
fi

yoal-agent join "$ORIGIN" --token "$TOKEN" --name "$NAME" --network-mode yoal > /etc/yoal/agent.env
chmod 600 /etc/yoal/agent.env

systemctl enable --now yoal-helper >/dev/null 2>&1 || true
systemctl enable --now yoal-agent
echo "Node '$NAME' joined. It appears in Nodes after its first heartbeat."
`;
}

function shellQuote(value: string): string {
	if (!/^[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$/.test(value)) return `'${value.replaceAll("'", `'\\''`)}'`;
	return value;
}
