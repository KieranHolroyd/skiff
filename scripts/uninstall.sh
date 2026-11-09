#!/bin/sh
#
# Yoal uninstaller.
#
#   sudo yoal-uninstall              # remove binaries + units, KEEP data and config
#   sudo yoal-uninstall --purge --yes # remove everything on this host (R2 is untouched)
#
# The default is deliberately conservative: /var/lib/yoal and /etc/yoal are kept so a
# reinstall can reuse the database, master key and recovery material.

set -eu

OPT_DIR="${YOAL_OPT_DIR:-/opt/yoal}"
VAR_DIR="${YOAL_VAR_DIR:-/var/lib/yoal}"
SRV_DIR="${YOAL_SRV_DIR:-/srv/yoal}"
ETC_DIR="${YOAL_ETC_DIR:-/etc/yoal}"
CADDY_ETC_DIR="${YOAL_CADDY_ETC_DIR:-/etc/caddy}"

PURGE=0
YES=0

say() { printf '%s\n' "$*"; }
warn() { printf 'yoal: warning: %s\n' "$*" >&2; }
die() { printf 'yoal: error: %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<'EOF'
Usage: yoal-uninstall [--purge] [--yes]

  --purge  also remove /var/lib/yoal, /srv/yoal, /etc/yoal, the system users and
           installed configuration. Requires --yes because it destroys the local
           database. R2 buckets, releases and backups are NEVER touched.
  --yes    confirm a --purge
EOF
}

for _arg in "$@"; do
	case "$_arg" in
		--purge) PURGE=1 ;;
		--yes | -y) YES=1 ;;
		-h | --help)
			usage
			exit 0
			;;
		*) die "unknown argument '$_arg' (see --help)" ;;
	esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"
if [ "$PURGE" = "1" ] && [ "$YES" != "1" ]; then
	die "--purge destroys the local database; re-run with --purge --yes if that is intended"
fi

# Every unit the installer and the updater write (scripts/uninstall.test.ts keeps this in step).
# Workload units the helper renders (yoal-w-*, Quadlet files) go with their apps, not here.
UNITS="
yoal-update-self.path
yoal-update-self.service
yoal-update-guard.service
yoal-platform-config.path
yoal-platform-config.service
yoal-restore-drill.timer
yoal-restore-drill.service
yoal-litestream.service
yoal-alert@.service
yoal-builder.service
yoal-storage.path
yoal-storage.service
yoal-studio.service
yoal-mail.service
yoal-identity.service
yoal-litestream-identity.service
yoal-agent.service
yoal-helper.service
yoal-control-plane-standby.service
yoal-control-plane.service
yoal-clickhouse.service
yoal-caddy.service
"

# Operator commands the installer puts on the host (scripts/install/commands.ts). The running
# copy of this script is open already, so removing its wrapper and release is safe.
COMMANDS="
/usr/local/bin/yoal
/usr/local/bin/yoal
/usr/local/sbin/yoal-update-self
/usr/local/sbin/yoal-platform-config
/usr/local/sbin/yoal-restore
/usr/local/sbin/yoal-restore-drill
/usr/local/sbin/yoal-alert
/usr/local/sbin/yoal-recovery-kit
/usr/local/sbin/yoal-rotate-master-key
/usr/local/sbin/yoal-uninstall
/usr/local/bin/yoal-restore
/usr/local/bin/yoal-restore-drill
/usr/local/bin/yoal-uninstall
"

say "Stopping and disabling Yoal services"
for _unit in $UNITS; do
	systemctl disable --now "$_unit" >/dev/null 2>&1 || true
done

for _unit in $UNITS; do
	rm -f "/etc/systemd/system/$_unit"
done
rm -rf /etc/systemd/system/yoal-*.service.d /etc/systemd/system/yoal-*.timer.d
rm -f /etc/tmpfiles.d/yoal.conf
systemctl daemon-reload
systemctl reset-failed >/dev/null 2>&1 || true

say "Removing binaries and operator commands"
# Releases, the runtime and the helper binary go; the ClickHouse binary (/opt/yoal/clickhouse)
# stays with its data unless --purge, so a reinstall does not download it again (OPS §4.2).
if [ -d "$OPT_DIR" ]; then
	for _entry in "$OPT_DIR"/* "$OPT_DIR"/.[!.]*; do
		[ -e "$_entry" ] || [ -L "$_entry" ] || continue
		[ "$PURGE" != "1" ] && [ "$_entry" = "$OPT_DIR/clickhouse" ] && continue
		rm -rf "$_entry"
	done
	rmdir "$OPT_DIR" 2>/dev/null || true
fi
for _command in $COMMANDS; do
	rm -f "$_command"
done
rm -rf /run/yoal /run/yoal-helper

if [ "$PURGE" != "1" ]; then
	say ""
	say "Removed the Yoal installation. Kept:"
	say "  $VAR_DIR   (SQLite, backups, drill results, agent cache)"
	say "  $SRV_DIR   (release cache)"
	say "  $ETC_DIR   (environment, master key, setup token)"
	[ -d "$OPT_DIR/clickhouse" ] && say "  $OPT_DIR/clickhouse   (ClickHouse binary; its data is in $VAR_DIR/clickhouse)"
	say "  $CADDY_ETC_DIR/Caddyfile   (Yoal's bootstrap config; --purge restores the original)"
	say ""
	say "A reinstall will reuse these. To remove them later: yoal-uninstall --purge --yes"
	exit 0
fi

say "Purging local data and configuration"
# Storage moved from the dashboard (D48) lives outside the default paths; never guess-delete it.
if [ -f "$ETC_DIR/storage.json" ]; then
	warn "node storage was relocated; remove these by hand if they are no longer needed:"
	grep -E '"(dataDir|buildDir)"' "$ETC_DIR/storage.json" | sed 's/^/    /' >&2 || true
fi
# The master key (master.key or the systemd-creds sealed master.key.cred) goes with $ETC_DIR:
# after this only a recovery kit (yoal-recovery-kit export) can open backups in R2.
say "Destroying the master key; R2 backups can only be restored with a recovery kit from now on"
rm -rf "$VAR_DIR" "$SRV_DIR" "$ETC_DIR" /var/lib/yoal-builder
rm -f "$CADDY_ETC_DIR/yoal.Caddyfile" "$CADDY_ETC_DIR/cloudflare.token"
# The installer replaces /etc/caddy/Caddyfile, keeping the package's version as Caddyfile.dist
# (bootstrap) or Caddyfile.pre-yoal (when it only patched an existing one). Caddy stays
# installed, so put the original back rather than leave it pointing at removed Yoal sockets.
if [ -f "$CADDY_ETC_DIR/Caddyfile.dist" ]; then
	mv -f "$CADDY_ETC_DIR/Caddyfile.dist" "$CADDY_ETC_DIR/Caddyfile"
	say "Restored the Caddy package's Caddyfile"
elif [ -f "$CADDY_ETC_DIR/Caddyfile.pre-yoal" ]; then
	mv -f "$CADDY_ETC_DIR/Caddyfile.pre-yoal" "$CADDY_ETC_DIR/Caddyfile"
	say "Restored the Caddyfile from before Yoal"
fi
rm -f "$CADDY_ETC_DIR/Caddyfile.pre-yoal"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet caddy 2>/dev/null; then
	systemctl reload caddy >/dev/null 2>&1 || warn "could not reload caddy; restart it after checking $CADDY_ETC_DIR/Caddyfile"
fi
rm -rf /run/yoal

for _user in yoal yoal-build yoal-clickhouse caddy; do
	if id -u "$_user" >/dev/null 2>&1; then
		userdel "$_user" >/dev/null 2>&1 || warn "could not remove user $_user (a process may still be running)"
	fi
done
for _group in yoal-caddy yoal-build yoal-clickhouse yoal; do
	if getent group "$_group" >/dev/null 2>&1; then
		groupdel "$_group" >/dev/null 2>&1 || warn "could not remove group $_group"
	fi
done

say ""
say "Local Yoal state removed."
say "Cloudflare R2 is untouched. Releases, Litestream snapshots and Parquet remain in the bucket;"
say "delete them separately only after you are sure you no longer need backups."
