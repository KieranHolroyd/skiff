#!/bin/sh
# Dev-only: turn this Linux box into a Yoal worker (agent + helper + Caddy + Podman) that joins
# the vite dev control plane on your Mac over the LAN. Plain HTTP, no WireGuard.
# Needs nothing from the Mac: it clones github.com/KieranHolroyd/yoal and builds there.
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
SRC=${YOAL_SRC:-/opt/yoal/src}
REF=${YOAL_REF:-main}
BUN_VERSION=1.4.4
BUN=/opt/yoal/runtime/bin/bun

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
	install -d -m 0755 /opt/yoal/runtime/bin
	install -m 0755 "$(find "$tmp" -type f -name bun | head -n1)" "$BUN"
	rm -rf "$tmp"
fi

say "source ($REF) in $SRC"
if [ -d "$SRC/.git" ]; then
	git -C "$SRC" fetch --depth 1 origin "$REF" && git -C "$SRC" reset --hard FETCH_HEAD
else
	git clone --depth 1 --branch "$REF" https://github.com/KieranHolroyd/yoal.git "$SRC"
fi

say "build agent + helper"
(cd "$SRC" && "$BUN" install --frozen-lockfile && \
	"$BUN" run --cwd apps/agent build && "$BUN" run --cwd apps/helper build)

say "users and directories"
getent group yoal >/dev/null || groupadd --system yoal
id yoal >/dev/null 2>&1 || useradd --system --gid yoal --home-dir /var/lib/yoal --shell "$(command -v nologin || echo /bin/false)" yoal
usermod -aG caddy yoal
install -d -m 0755 /opt/yoal/current/agent /opt/yoal/helper
install -d -m 0750 -o root -g yoal /etc/yoal
install -d -m 0751 -o yoal -g yoal /var/lib/yoal
install -d -m 0750 -o yoal -g yoal /var/lib/yoal/agent
install -d -m 0750 -o caddy -g caddy /var/lib/caddy
echo 'd /run/yoal 2770 root caddy -' > /etc/tmpfiles.d/yoal.conf
systemd-tmpfiles --create /etc/tmpfiles.d/yoal.conf
install -m 0755 "$SRC/apps/agent/dist/yoal-agent" /opt/yoal/current/agent/yoal-agent
install -m 0755 "$SRC/apps/helper/dist/yoal-helper" /opt/yoal/helper/yoal-helper

say "Caddy (admin on a unix socket only)"
install -d -m 0755 /etc/caddy /etc/systemd/system/caddy.service.d
printf '{\n\tadmin unix//var/lib/caddy/admin.sock|0660\n}\n' > /etc/caddy/Caddyfile
printf '[Service]\nSupplementaryGroups=yoal\n' > /etc/systemd/system/caddy.service.d/yoal.conf

say "helper (root; renders systemd units and Quadlets for databases)"
cat > /etc/yoal/helper.env <<EOF
YOAL_HELPER_BUN_PATH=$BUN
YOAL_HELPER_RELEASE_DIRS=/var/lib/yoal/agent/releases,/opt/yoal/releases
YOAL_HELPER_CONTROL_SOCKET_GROUP=yoal
YOAL_HELPER_WORKLOAD_SOCKET_GROUP=caddy
YOAL_HELPER_WORKLOAD_SOCKET_MODE=0660
YOAL_HELPER_QUADLET_DIR=/etc/containers/systemd
YOAL_HELPER_APPARMOR_PROFILE=auto
EOF
chown root:yoal /etc/yoal/helper.env && chmod 0640 /etc/yoal/helper.env
cat > /etc/systemd/system/yoal-helper.service <<'EOF'
[Unit]
Description=Yoal privileged workload helper
After=network-online.target
Wants=network-online.target
ConditionPathExists=/etc/yoal/helper.env
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
User=root
ExecStartPre=+/usr/bin/install -d -o root -g yoal -m 0750 /run/yoal-helper
ExecStartPre=+/usr/bin/install -d -o root -g root -m 0755 /etc/containers/systemd
ExecStart=/opt/yoal/helper/yoal-helper
EnvironmentFile=/etc/yoal/helper.env
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

say "agent"
cat > /etc/yoal/yoal.env <<EOF
# development, not production: the agent refuses plain-HTTP control URLs in production.
NODE_ENV=development
YOAL_AGENT_INSECURE_HTTP=1
YOAL_DATA_DIR=/var/lib/yoal/agent
YOAL_TLS=0
YOAL_CADDY_LISTEN=$LAN_IP:8080
YOAL_CERT_PROBE_ADDR=off
YOAL_CADDY_ADMIN_SOCKET=/var/lib/caddy/admin.sock
YOAL_AGENT_SOCKET=/run/yoal/agent.sock
EOF
chown root:yoal /etc/yoal/yoal.env && chmod 0640 /etc/yoal/yoal.env
cat > /etc/systemd/system/yoal-agent.service <<'EOF'
[Unit]
Description=Yoal node agent
After=network-online.target caddy.service yoal-helper.service
Wants=network-online.target yoal-helper.service
ConditionPathExists=/etc/yoal/agent.env
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=yoal
Group=yoal
SupplementaryGroups=caddy
UMask=0007
WorkingDirectory=/opt/yoal/current/agent
EnvironmentFile=/etc/yoal/yoal.env
EnvironmentFile=-/etc/yoal/agent.env
ExecStart=/opt/yoal/current/agent/yoal-agent
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
ReadWritePaths=/var/lib/yoal /run/yoal

[Install]
WantedBy=multi-user.target
EOF

say "join $CONTROL as $NAME ($LAN_IP:8080)"
runuser -u yoal -- env NODE_ENV=development YOAL_AGENT_INSECURE_HTTP=1 \
	/opt/yoal/current/agent/yoal-agent join "$CONTROL" \
	--token "$TOKEN" --name "$NAME" --public-address "$LAN_IP:8080" --data-dir /var/lib/yoal/agent \
	> /etc/yoal/agent.env.new
# Join echoes the control plane's own origin, which is http://localhost:5173 on a dev server:
# keep the URL this box actually reached instead.
sed -i "s#^YOAL_CONTROL_URL=.*#YOAL_CONTROL_URL=$CONTROL#" /etc/yoal/agent.env.new
mv /etc/yoal/agent.env.new /etc/yoal/agent.env
chown root:yoal /etc/yoal/agent.env && chmod 0640 /etc/yoal/agent.env

say "start"
systemctl daemon-reload
systemctl restart caddy
systemctl enable --now yoal-helper yoal-agent
sleep 3
systemctl --no-pager --lines=0 status caddy yoal-helper yoal-agent || true
ls -l /run/yoal-helper/helper.sock /var/lib/caddy/admin.sock
echo "Logs: journalctl -u yoal-agent -u yoal-helper -f"
