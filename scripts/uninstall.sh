#!/bin/sh
#
# Skiff uninstaller.
#
#   sudo skiff-uninstall              # remove binaries + units, KEEP data and config
#   sudo skiff-uninstall --purge --yes # remove everything on this host (R2 is untouched)
#
# The default is deliberately conservative: /var/lib/skiff and /etc/skiff are kept so a
# reinstall can reuse the database, master key and recovery material.

set -eu

OPT_DIR="${SKIFF_OPT_DIR:-/opt/skiff}"
VAR_DIR="${SKIFF_VAR_DIR:-/var/lib/skiff}"
SRV_DIR="${SKIFF_SRV_DIR:-/srv/skiff}"
ETC_DIR="${SKIFF_ETC_DIR:-/etc/skiff}"
CADDY_ETC_DIR="${SKIFF_CADDY_ETC_DIR:-/etc/caddy}"

PURGE=0
YES=0

say() { printf '%s\n' "$*"; }
warn() { printf 'skiff: warning: %s\n' "$*" >&2; }
die() { printf 'skiff: error: %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<'EOF'
Usage: skiff-uninstall [--purge] [--yes]

  --purge  also remove /var/lib/skiff, /srv/skiff, /etc/skiff, the system users and
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

UNITS="
skiff-platform-config.path
skiff-platform-config.service
skiff-restore-drill.timer
skiff-restore-drill.service
skiff-litestream.service
skiff-builder.service
skiff-storage.path
skiff-storage.service
skiff-agent.service
skiff-control-plane.service
skiff-caddy.service
"

say "Stopping and disabling Skiff services"
for _unit in $UNITS; do
	systemctl disable --now "$_unit" >/dev/null 2>&1 || true
done

for _unit in $UNITS; do
	rm -f "/etc/systemd/system/$_unit"
done
rm -rf /etc/systemd/system/skiff-*.service.d /etc/systemd/system/skiff-*.timer.d
rm -f /etc/tmpfiles.d/skiff.conf
systemctl daemon-reload
systemctl reset-failed >/dev/null 2>&1 || true

say "Removing binaries and operator commands"
rm -rf "$OPT_DIR"
rm -f /usr/local/bin/skiff-restore /usr/local/bin/skiff-restore-drill /usr/local/bin/skiff-uninstall
rm -f /usr/local/bin/skif /usr/local/bin/skiff /usr/local/sbin/skiff-update-self /usr/local/sbin/skiff-platform-config
rm -f /usr/local/sbin/skiff-restore /usr/local/sbin/skiff-restore-drill /usr/local/sbin/skiff-alert
rm -rf /run/skiff

if [ "$PURGE" != "1" ]; then
	say ""
	say "Removed the Skiff installation. Kept:"
	say "  $VAR_DIR   (SQLite, backups, drill results, agent cache)"
	say "  $SRV_DIR   (release cache)"
	say "  $ETC_DIR   (environment, master key, setup token)"
	say "  $CADDY_ETC_DIR/skiff.Caddyfile"
	say ""
	say "A reinstall will reuse these. To remove them later: skiff-uninstall --purge --yes"
	exit 0
fi

say "Purging local data and configuration"
# Storage moved from the dashboard (D48) lives outside the default paths; never guess-delete it.
if [ -f "$ETC_DIR/storage.json" ]; then
	warn "node storage was relocated; remove these by hand if they are no longer needed:"
	grep -E '"(dataDir|buildDir)"' "$ETC_DIR/storage.json" | sed 's/^/    /' >&2 || true
fi
rm -rf "$VAR_DIR" "$SRV_DIR" "$ETC_DIR" /var/lib/skiff-builder
rm -f "$CADDY_ETC_DIR/skiff.Caddyfile" "$CADDY_ETC_DIR/cloudflare.token"
rm -rf /run/skiff

for _user in skiff skiff-build caddy; do
	if id -u "$_user" >/dev/null 2>&1; then
		userdel "$_user" >/dev/null 2>&1 || warn "could not remove user $_user (a process may still be running)"
	fi
done
for _group in skiff-caddy skiff-build skiff; do
	if getent group "$_group" >/dev/null 2>&1; then
		groupdel "$_group" >/dev/null 2>&1 || warn "could not remove group $_group"
	fi
done

say ""
say "Local Skiff state removed."
say "Cloudflare R2 is untouched. Releases, Litestream snapshots and Parquet remain in the bucket;"
say "delete them separately only after you are sure you no longer need backups."
