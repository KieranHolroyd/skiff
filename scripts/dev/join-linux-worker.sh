#!/bin/sh
# Dev-only: turn this Linux box into a Skiff worker (agent + helper + Caddy + Podman) that joins
# the vite dev control plane on your Mac over the LAN. Plain HTTP, no WireGuard.
# Needs nothing from the Mac: it clones github.com/KieranHolroyd/skiff and builds there.
#
#   sudo sh join-linux-worker.sh <control-url> <join-token> [node-name] [this-box-lan-ip]
#
# Arch, Fedora, or Ubuntu 24.04 / Debian 13 (Podman >= 4.4 for Quadlet; Debian 12 is too old).
# No sudo needed on the box beyond running this as root (it uses runuser).
set -eu

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
[ $# -ge 2 ] || { echo "usage: join-linux-worker.sh <control-url> <join-token> [node-name] [lan-ip]" >&2; exit 1; }
CONTROL=$1 TOKEN=$2 NAME=${3:-linux-box}
CONTROL_HOST=$(echo "$CONTROL" | sed -E 's#^[a-z]+://([^:/]+).*#\1#')
LAN_IP=${4:-$(ip -4 route get "$CONTROL_HOST" | sed -n 's/.* src \([0-9.]*\).*/\1/p')}
[ -n "$LAN_IP" ] || { echo "could not detect this box's LAN IP; pass it as the 4th argument" >&2; exit 1; }
SRC=${SKIFF_SRC:-/opt/skiff/src}
REF=${SKIFF_REF:-main}
BUN_VERSION=1.4.4
BUN=/opt/skiff/runtime/bin/bun

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

say "checking $CONTROL is reachable"
curl -fsS -o /dev/null --max-time 5 "$CONTROL/" || { echo "cannot reach $CONTROL (is vite running with --host?)" >&2; exit 1; }

say "packages"
if command -v pacman >/dev/null 2>&1; then
	# No -y: syncing the db without -u is a partial upgrade. Run `pacman -Syu` first if this 404s.
	pacman -S --needed --noconfirm ca-certificates curl unzip git iproute2 caddy podman passt netavark aardvark-dns
elif command -v dnf >/dev/null 2>&1; then
	dnf install -y ca-certificates curl unzip git iproute caddy podman passt netavark aardvark-dns shadow-utils
elif command -v apt-get >/dev/null 2>&1; then
	apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		ca-certificates curl unzip git iproute2 caddy podman uidmap passt netavark aardvark-dns
else
	echo "no supported package manager (pacman, dnf, apt-get); install: curl unzip git caddy podman passt netavark aardvark-dns" >&2
	exit 1
fi
[ -x /usr/lib/systemd/system-generators/podman-system-generator ] ||
	echo "warning: Podman's Quadlet generator is missing; databases will not start" >&2
getent group caddy >/dev/null || { echo "the caddy package did not create a caddy group" >&2; exit 1; }

say "Bun $BUN_VERSION"
if [ ! -x "$BUN" ] || [ "$("$BUN" --version)" != "$BUN_VERSION" ]; then
	case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "bad arch" >&2; exit 1 ;; esac
	tmp=$(mktemp -d)
	curl -fsSL -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$arch.zip"
	unzip -q "$tmp/bun.zip" -d "$tmp"
	install -d -m 0755 /opt/skiff/runtime/bin
	install -m 0755 "$(find "$tmp" -type f -name bun | head -n1)" "$BUN"
	rm -rf "$tmp"
fi

say "source ($REF) in $SRC"
if [ -d "$SRC/.git" ]; then
	git -C "$SRC" fetch --depth 1 origin "$REF" && git -C "$SRC" reset --hard FETCH_HEAD
else
	git clone --depth 1 --branch "$REF" https://github.com/KieranHolroyd/skiff.git "$SRC"
fi

say "build agent + helper"
(cd "$SRC" && "$BUN" install --frozen-lockfile && \
	"$BUN" run --cwd apps/agent build && "$BUN" run --cwd apps/helper build)

say "users and directories"
getent group skiff >/dev/null || groupadd --system skiff
id skiff >/dev/null 2>&1 || useradd --system --gid skiff --home-dir /var/lib/skiff --shell "$(command -v nologin || echo /bin/false)" skiff
usermod -aG caddy skiff
install -d -m 0755 /opt/skiff/current/agent /opt/skiff/helper
install -d -m 0750 -o root -g skiff /etc/skiff
install -d -m 0751 -o skiff -g skiff /var/lib/skiff
install -d -m 0750 -o skiff -g skiff /var/lib/skiff/agent
install -d -m 0750 -o caddy -g caddy /var/lib/caddy
echo 'd /run/skiff 2770 root caddy -' > /etc/tmpfiles.d/skiff.conf
systemd-tmpfiles --create /etc/tmpfiles.d/skiff.conf
install -m 0755 "$SRC/apps/agent/dist/skiff-agent" /opt/skiff/current/agent/skiff-agent
install -m 0755 "$SRC/apps/helper/dist/skiff-helper" /opt/skiff/helper/skiff-helper

say "Caddy (admin on a unix socket only)"
install -d -m 0755 /etc/caddy /etc/systemd/system/caddy.service.d
printf '{\n\tadmin unix//var/lib/caddy/admin.sock|0660\n}\n' > /etc/caddy/Caddyfile
printf '[Service]\nSupplementaryGroups=skiff\n' > /etc/systemd/system/caddy.service.d/skiff.conf

say "helper (root; renders systemd units and Quadlets for databases)"
cat > /etc/skiff/helper.env <<EOF
SKIFF_HELPER_BUN_PATH=$BUN
SKIFF_HELPER_RELEASE_DIRS=/var/lib/skiff/agent/releases,/opt/skiff/releases
SKIFF_HELPER_CONTROL_SOCKET_GROUP=skiff
SKIFF_HELPER_WORKLOAD_SOCKET_GROUP=caddy
SKIFF_HELPER_WORKLOAD_SOCKET_MODE=0660
SKIFF_HELPER_QUADLET_DIR=/etc/containers/systemd
SKIFF_HELPER_APPARMOR_PROFILE=auto
EOF
chown root:skiff /etc/skiff/helper.env && chmod 0640 /etc/skiff/helper.env
cat > /etc/systemd/system/skiff-helper.service <<'EOF'
[Unit]
Description=Skiff privileged workload helper
After=network-online.target
Wants=network-online.target
ConditionPathExists=/etc/skiff/helper.env
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
User=root
ExecStartPre=+/usr/bin/install -d -o root -g skiff -m 0750 /run/skiff-helper
ExecStartPre=+/usr/bin/install -d -o root -g root -m 0755 /etc/containers/systemd
ExecStart=/opt/skiff/helper/skiff-helper
EnvironmentFile=/etc/skiff/helper.env
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

say "agent"
cat > /etc/skiff/skiff.env <<EOF
# development, not production: the agent refuses plain-HTTP control URLs in production.
NODE_ENV=development
SKIFF_AGENT_INSECURE_HTTP=1
SKIFF_DATA_DIR=/var/lib/skiff/agent
SKIFF_TLS=0
SKIFF_CADDY_LISTEN=$LAN_IP:8080
SKIFF_CERT_PROBE_ADDR=off
SKIFF_CADDY_ADMIN_SOCKET=/var/lib/caddy/admin.sock
SKIFF_AGENT_SOCKET=/run/skiff/agent.sock
EOF
chown root:skiff /etc/skiff/skiff.env && chmod 0640 /etc/skiff/skiff.env
cat > /etc/systemd/system/skiff-agent.service <<'EOF'
[Unit]
Description=Skiff node agent
After=network-online.target caddy.service skiff-helper.service
Wants=network-online.target skiff-helper.service
ConditionPathExists=/etc/skiff/agent.env
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=skiff
Group=skiff
SupplementaryGroups=caddy
UMask=0007
WorkingDirectory=/opt/skiff/current/agent
EnvironmentFile=/etc/skiff/skiff.env
EnvironmentFile=-/etc/skiff/agent.env
ExecStart=/opt/skiff/current/agent/skiff-agent
Restart=on-failure
RestartSec=2
TimeoutStopSec=20
LimitNOFILE=65535
TasksMax=128
MemoryMax=192M
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/skiff /run/skiff

[Install]
WantedBy=multi-user.target
EOF

say "join $CONTROL as $NAME ($LAN_IP:8080)"
runuser -u skiff -- env NODE_ENV=development SKIFF_AGENT_INSECURE_HTTP=1 \
	/opt/skiff/current/agent/skiff-agent join "$CONTROL" \
	--token "$TOKEN" --name "$NAME" --public-address "$LAN_IP:8080" --data-dir /var/lib/skiff/agent \
	> /etc/skiff/agent.env.new
mv /etc/skiff/agent.env.new /etc/skiff/agent.env
chown root:skiff /etc/skiff/agent.env && chmod 0640 /etc/skiff/agent.env

say "start"
systemctl daemon-reload
systemctl restart caddy
systemctl enable --now skiff-helper skiff-agent
sleep 3
systemctl --no-pager --lines=0 status caddy skiff-helper skiff-agent || true
ls -l /run/skiff-helper/helper.sock /var/lib/caddy/admin.sock
echo "Logs: journalctl -u skiff-agent -u skiff-helper -f"
