#!/usr/bin/env bash
# CI: run a built release's own canary hook exactly as the updater does on a host — as root, via
# systemd-run, as the yoal user under the production sandbox (ProtectSystem=strict, ProtectHome)
# — against a fresh database. A release that cannot boot like this is never published.
#
#   sudo scripts/release/ci-canary.sh <checkout-with-built-apps>
set -euo pipefail
src="$(cd "$1" && pwd)"
release=/opt/yoal-ci/release
bun_bin="${BUN_BIN:-$(command -v bun)}"

id yoal >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/yoal --shell /usr/sbin/nologin yoal
rm -rf /opt/yoal-ci && mkdir -p "$release/runtime" /etc/yoal /var/lib/yoal/update-canary
# ProtectHome hides the runner's workspace from the sandbox, so stage the release like a host does.
cp -a "$src" "$release/repo"
cp "$bun_bin" "$release/runtime/bun"
chmod -R a+rX /opt/yoal-ci

head -c 32 /dev/urandom | base64 > /etc/yoal/master.key
chmod 0600 /etc/yoal/master.key
cat > /etc/yoal/yoal.env <<ENV
YOAL_PLATFORM_ORIGIN=https://control.ci.invalid
YOAL_CONTENT_DOMAIN=ci.invalid
BETTER_AUTH_SECRET=$(head -c 32 /dev/urandom | base64)
YOAL_OBJECT_STORE=local
ENV
# Containers without systemd credentials (LoadCredential) cannot hand the canary its key file;
# CI runners are VMs and use the real path. Opt-in only.
if [ "${YOAL_CI_INLINE_MASTER_KEY:-0}" = 1 ]; then echo "YOAL_MASTER_KEY=$(cat /etc/yoal/master.key)" >> /etc/yoal/yoal.env; fi

scratch=/var/lib/yoal/update-canary/ci
rm -rf "$scratch" && mkdir -p "$scratch"
out="$("$release/runtime/bun" "$release/repo/scripts/release/hooks.ts" canary \
	--release "$release" --scratch "$scratch" --db /var/lib/yoal/data/none.db --origin https://control.ci.invalid)"
echo "$out"
verdict="$(printf '%s\n' "$out" | sed -n 's/^YOAL_HOOK_RESULT //p' | tail -1)"
rm -rf "$scratch"
if [ -z "$verdict" ]; then echo "::error::the canary hook gave no verdict"; exit 1; fi
if ! printf '%s' "$verdict" | grep -q '"ok":true'; then
	echo "::error::the release failed its own canary: $verdict"
	exit 1
fi
echo "canary passed under the production sandbox"
