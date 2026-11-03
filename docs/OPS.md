# Skiff — Operations

Version: v1. This is the runbook for the single-VPS install: install, upgrade, restore,
backups, monitoring, the monthly restore drill, and master-key rotation.

Design context: [DESIGN.md](./DESIGN.md) §10–§12, [DECISIONS.md](./DECISIONS.md)
D24 (the VPS is an accepted single point of failure), D25 (R2 is canonical), D28
(product-grade releases) and D37 (unix socket behind Caddy).

---

## 1. Host layout

| Path | Owner / mode | Purpose |
|---|---|---|
| `/opt/skiff/current` | symlink | Active release. Atomic swap is the upgrade/rollback primitive. |
| `/opt/skiff/previous` | symlink | Last known-good release, kept until the next successful update (`skiff-update-self rollback` target). |
| `/var/lib/skiff/update/` | `skiff:skiff 0750` | Dashboard update requests (the control plane writes `request`). |
| `/var/lib/skiff-update/status.json` | `root:skiff 0640` | Updater progress/outcome, read by the dashboard. |
| `/var/lib/skiff/platform-config/` | `skiff:skiff 0750` | Dashboard settings requests (Settings → Backups / Notifications, §4.3). |
| `/var/lib/skiff-config/status.json` | `root:skiff 0640` | `skiff-platform-config` progress/outcome, read by the dashboard. |
| `/etc/skiff/skiff.env.previous` | `root:skiff 0640` | The env file before the last dashboard change (automatic revert). |
| `/opt/skiff/update-state.json` | `root:root 0600` | Self-updater state: last switch + its DB snapshot, in-flight switch, commits that failed. |
| `/opt/skiff/releases/<version>/control-plane` | `root:root 0755` | SvelteKit build, bundled Bun runtime, units, scripts, migrations. |
| `/opt/skiff/releases/<version>/agent` | `root:root 0755` | `skiff-agent` compiled binary. |
| `/opt/skiff/releases/<version>/caddy` | `root:root 0755` | Caddy 2.11.7 + `caddy-dns/cloudflare`. |
| `/etc/skiff/skiff.env` | `root:skiff 0640` | Runtime environment and secrets (see §2). |
| `/etc/skiff/master.key` | `root:root 0400` | Master key, delivered via `LoadCredential=`, never sourced by shell. |
| `/etc/skiff/setup-token` | `root:skiff 0640` | Single-use setup URL token. |
| `/etc/skiff/litestream.yml` | `root:skiff 0640` | R2 replication config. |
| `/etc/caddy/Caddyfile` | `root:caddy 0640` | Caddy bootstrap/wizard-managed config. |
| `/etc/caddy/cloudflare.token` | `root:caddy 0640` | DNS-01 token, read with `{file./etc/caddy/cloudflare.token}`. |
| `/var/lib/skiff` | `skiff:skiff 0751` | Data root; other-traverse lets Caddy reach its own subdirectory without listing Skiff data. |
| `/var/lib/skiff/data/skiff.db` | `skiff:skiff 0640` | SQLite (platform state). |
| `/var/lib/skiff/backups` | `skiff:skiff 0750` | Pre-upgrade / pre-restore snapshots. |
| `/var/lib/skiff/drill` | `skiff:skiff 0750` | Restore-drill scratch dirs + `status.json`. |
| `/var/lib/caddy` | `caddy:caddy 0700` | Caddy data/config/certificates; not readable by the control plane. |
| `/srv/skiff/releases` | `skiff:skiff 0755` | Static release cache served by Caddy. |
| `/run/skiff` | `root:caddy 2770` (setgid) | Unix sockets only. |
| `/run/skiff/control.sock` | `0660` | Control plane (Caddy reverse-proxies to it). |
| `/run/skiff/agent.sock` | `0660` | Agent (`forward_auth` target for protected sites). |
| `/var/lib/caddy/admin.sock` | `0660` | Caddy admin API; no TCP `:2019`. |

Why the runtime directory is setgid: files created in a setgid directory inherit the
directory's group. That lets the `skiff` processes create sockets owned by
`caddy`, so Caddy can connect without joining the `skiff` group (and without being
able to read the database or `/etc/skiff`). The agent gets the same group through
`SupplementaryGroups=caddy` in its unit.

The repository copies of the units live in [`scripts/systemd/`](../scripts/systemd). The
installer extracts the versions from the release bundle, so units and binaries are
versioned together.

---

## 2. Environment reference

`/etc/skiff/skiff.env` is read by systemd (`EnvironmentFile=`), not by a shell. Values are
`KEY=value`, comments start with `#`. Quote values containing spaces. Keep it `0640
root:skiff`.

### 2.1 Core

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `NODE_ENV` | `production` | no | Must be `production` on a real install. |
| `SKIFF_PLATFORM_ORIGIN` | bootstrap `http://<ip>` | no | Canonical platform origin, e.g. `https://control.kieran.dev`. Used for auth, MCP audience, CSRF. The wizard replaces the bootstrap value. |
| `SKIFF_CONTENT_DOMAIN` | empty | no | Wildcard content zone, e.g. `kierancloud.dev`. |
| `SKIFF_DATA_DIR` | `/var/lib/skiff/data` | no | SQLite/DuckDB directory. |
| `SKIFF_SETUP_MODE` | `1` until the wizard completes | no | Serves only the setup flow on `:80`. |
| `SKIFF_SETUP_TOKEN_FILE` | `/etc/skiff/setup-token` | no | File containing the one-time setup token. |
| `SKIFF_AGENT_SOCKET` | `/run/skiff/agent.sock` | no | Agent unix socket (`forward_auth` and local control-plane calls). |
| `SKIFF_CADDY_ADMIN_SOCKET` | `/var/lib/caddy/admin.sock` | no | Caddy admin unix socket. |
| `SKIFF_AGENT_VERSION` | empty | no | Optional desired agent version; normally set by the control plane. |
| `SKIFF_EDGE_NODE_ID` | empty | no | Node identity for single-node mode. |
| `SKIFF_CONTROL_URL` | — | no | Agent only (`/etc/skiff/agent.env`): control-plane origin, `http(s)://…`. |
| `SKIFF_NODE_ID` | — | no | Agent only: node id from `skiff-agent join`. |
| `SKIFF_NODE_TOKEN` | — | **yes** | Agent only: bearer token from the single-use join token. |
| `SKIFF_CADDY_LISTEN` | `:443,:80` | no | Agent only: listeners Caddy should bind. |
| `SKIFF_CADDY_ACCESS_LOG` | installer: `/var/log/caddy/skiff-access.log` | no | Agent only: Caddy JSON access log (0640, read via the `caddy` group). The agent adds it to the Caddy config and aggregates it into 1-minute buckets. |
| `SKIFF_MCP_ALLOW_DCR` | `1` | no | Keep legacy Dynamic Client Registration alongside CIMD. |
| `SKIFF_OPEN_SIGNUP` | unset | no | `1` allows open sign-up. Production is invite-only (D10); the first user is always allowed so setup can create the owner. |
| `SKIFF_DEV_PASSWORD_LOGIN` | unset | no | Development only; refused in production. |
| `SKIFF_ACME_EMAIL` | empty | no | Agent only: ACME account email. Enables TLS/DNS-01 when set. |
| `SKIFF_CLOUDFLARE_API_TOKEN` | empty | **yes** | Agent only: scoped DNS token for `caddy-dns/cloudflare` (Zone.DNS edit on the content zone). |
| `SKIFF_ACME_CA` | Let's Encrypt | no | Agent only: ACME directory URL (use the staging URL while testing). |
| `SKIFF_TLS` | auto | no | Agent only: `1` forces TLS, `0` disables it (dev). Defaults to enabled when `SKIFF_ACME_EMAIL` is set. |
| `SOCKET_PATH` | `/run/skiff/control.sock` | no | adapter-bun unix socket (D37), set by the unit. |
| `PROTOCOL_HEADER` | `x-forwarded-proto` | no | Trust Caddy's forwarded protocol, set by the unit. |
| `HOST_HEADER` | `x-forwarded-host` | no | Trust Caddy's forwarded host, set by the unit. |
| `BODY_SIZE_LIMIT` | `520M` | no | adapter-bun request body cap, set by the unit. Its 512 KB default would reject artifact uploads with a bare 413; 520M covers the 500 MiB artifact limit, which the upload route enforces. |

### 2.2 Secrets

| Variable | Generated by | Meaning |
|---|---|---|
| `BETTER_AUTH_SECRET` | installer (48 random bytes, base64) | Better Auth signing/encryption key. Rotating it invalidates sessions. |
| `SKIFF_SITE_COOKIE_SECRET` | installer (32 random bytes) | HMAC key for host-only protected-site cookies. |
| `SKIFF_OBJECT_STORE_SECRET` | installer (32 random bytes) | Server-side encryption/derivation material for the object store layer. |
| `/etc/skiff/master.key` | installer (32 random bytes, base64) | KEK for per-org data keys. Supplied to the control plane only as the `master-key` systemd credential (`SKIFF_MASTER_KEY_FILE=%d/master-key`). |
| `R2_ACCESS_KEY_ID` | installer flag / wizard | R2 access key. |
| `R2_SECRET_ACCESS_KEY` | installer flag / wizard | R2 secret key. |

### 2.3 Cloudflare R2

| Variable | Example | Meaning |
|---|---|---|
| `R2_ACCOUNT_ID` | `abc123…` | Cloudflare account ID. |
| `R2_BUCKET` | `skiff-prod` | Bucket for SQLite, artifacts and Parquet. |
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | S3-compatible endpoint. Written by the installer from the account ID; Litestream requires the explicit URL. |

Object key layout in the bucket is fixed: `skiff/sqlite` (Litestream replica, see
`litestream.yml`), `releases/<sha256>.zip` (canonical release artifacts) and
`telemetry/day=YYYY-MM-DD/…` (cold Parquet partitions). The installer still accepts the older
`SKIFF_R2_*` names as input and writes the `R2_*` names above.

R2 credentials need Object Read & Write on the bucket. Use a bucket-scoped token, not an
account-wide key. Presigned uploads use the same credentials through the control plane.

### 2.4 Restore / drill / installer

| Variable | Default | Meaning |
|---|---|---|
| `SKIFF_RESTORE_DRILL_DIR` | `/var/lib/skiff/drill` | Scratch root for the monthly drill. |
| `SKIFF_RESTORE_DRILL_KEEP` | `3` | Number of successful run directories kept. |
| `SKIFF_DRILL_NO_QUIESCE` | `0` | `1` skips stopping services (best-effort comparison; can false-fail). |
| `SKIFF_RESTORE_YES` | `0` | Non-interactive restore. `--yes` is equivalent. |
| `SKIFF_HEALTH_TIMEOUT` | `60` | Seconds to wait for the control-plane socket after start/restore. |
| `SKIFF_ENV_FILE` | `/etc/skiff/skiff.env` | Override for ops scripts. |
| `SKIFF_LITESTREAM_CONFIG` | `/etc/skiff/litestream.yml` | Override for ops scripts. |
| `SKIFF_APP_DIR` | `/opt/skiff/current/control-plane` | Bundled runtime/tools location. |
| `SKIFF_BUN` | bundled Bun | Override runtime for the fingerprint/migration helpers. |
| `SKIFF_VERSION` | latest GitHub release | Installer: pin a version. |
| `SKIFF_REPO` | `kieranholroyd/private-cloud-deploys` | Installer: repo used for "latest" and cosign identity. |
| `SKIFF_PUBLIC_HOST` | auto-detected | Installer: host printed in the setup URL. |
| `SKIFF_ALERT_WEBHOOK` | unset | `skiff-alert` (backup/drill `OnFailure=`): webhook URL; SMTP settings are reused for email. |

> **Not yet implemented:** the installer builds from the source tarball and does not consume the
> signed release bundle, so there is no `SKIFF_RELEASE_URL` / minisign / cosign verification at
> install time yet. `litestream.yml` is always rewritten by the installer.
| `SKIFF_FORCE_OS` | `0` | Installer: override the Debian 13 check. |

Units also set `SOCKET_PATH=/run/skiff/control.sock`, `PROTOCOL_HEADER=x-forwarded-proto`
and `HOST_HEADER=x-forwarded-host` (D37), `BODY_SIZE_LIMIT=520M` (so artifact uploads
are not capped at adapter-bun's 512 KB default), plus
`SKIFF_MASTER_KEY_FILE=%d/master-key` (the systemd credential path).

---

## 3. Install

### 3.1 Prerequisites

- Debian 13 or Ubuntu 24.04+ on x86_64/aarch64, systemd, root access.
- Ports 80/443 free, DNS for the platform and content domains pointing at this machine.
- **Caddy 2.7+ with `caddy-dns/cloudflare`** already installed. The installer verifies the
  module and fails with a clear message if it is missing. Caddy is driven only through its
  admin unix socket; the installer fixes the socket mode and group access.
- At least 2 GB free disk. The installer downloads Bun and builds the control plane on the host.

### 3.2 Bootstrap

```sh
curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/skiff/main/install.sh | sudo sh
```

The `install.sh` bootstrap is deliberately tiny: it installs `curl`/`tar`/`unzip` if needed,
downloads Bun to `/opt/skiff/runtime`, downloads the repo tarball, and hands over to
`scripts/install/main.ts` (Bun). All deployment logic is in that Bun program.

Non-interactive:

```sh
curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/skiff/main/install.sh | sudo env \
  SKIFF_YES=1 \
  sh -s -- \
  --platform-host control.example.com \
  --content-domain example.com \
  --acme-email ops@example.com \
  --admin-email owner@example.com
```

Private repo: add `SKIFF_GITHUB_TOKEN=…`. Pin a ref with `SKIFF_REF=v1.2.3`. Use an existing
checkout with `SKIFF_SOURCE_DIR=/path/to/skiff`.

### 3.3 What the Bun installer does

1. **Preflight** — OS/arch/systemd, Caddy + DNS module, Caddy admin socket, disk, domains.
2. **Users/dirs** — `skiff` user (member of `caddy`), `/opt/skiff`, `/var/lib/skiff`,
   `/etc/skiff`, `/run/skiff` (2770 root:caddy).
3. **Secrets** — generates `/etc/skiff/master.key` (0400), `BETTER_AUTH_SECRET`,
   `SKIFF_SITE_COOKIE_SECRET`, `SKIFF_OBJECT_STORE_SECRET`; preserves them on upgrade.
4. **Build** — copies the repo to a new immutable release, runs `bun install --frozen-lockfile`,
   `vite build` (adapter-bun), and `bun build --compile` for the agent.
5. **Activate** — atomically switches `/opt/skiff/current` to the new release.
6. **Services** — writes hardened units, fixes Caddy's admin socket mode (`0660`, group `caddy`),
   adds the `skiff` supplementary group to Caddy so it can read release artifacts, and starts
   the control plane.
7. **Caddy bootstrap fix** — points the platform vhost at `unix//run/skiff/control.sock`, then the
   agent takes over the whole Caddy config (platform + content routes) via the admin API.
8. **Node enrolment** — creates the edge node (or reuses it), rotates its token, writes
   `/etc/skiff/agent.env`, bumps the desired-state watermark, and starts the agent.
9. **Health** — waits for the public platform URL, then prints a one-time magic-link sign-in URL.
   With SMTP configured it is emailed instead.

The installer is idempotent; re-running builds a new release and rolls back the symlink if the
health check fails. `--dry-run` prints the plan, `--uninstall [--purge]` removes services/data.

### 3.4 Verify

```sh
systemctl status caddy skiff-control-plane skiff-agent --no-pager
curl -sS https://control.example.com/api/setup/status
curl -sS -o /dev/null -w '%{http_code}\n' https://anything.example.com/
ls -l /run/skiff /var/lib/caddy/admin.sock   # sockets 0660, group caddy
```

The first magic link creates the owner (the database hook only allows the first user; afterwards
the platform is invite-only). Create an API key in **Settings → API keys** for `skif`.

The installer also puts `skif` and `skiff` in `/usr/local/bin`. They run the CLI bundled with the
active release (`/opt/skiff/current/cli/skif.js`) on Skiff's own Bun, so the host needs no Node.js
and the CLI upgrades and rolls back with the platform. Sign in with `skif login --url
https://control.example.com`. On other machines install it from npm (`npm i -g skif`).

## 4. Upgrade

Re-run the bootstrap with `--upgrade` (or just re-run it; it reuses `/etc/skiff` and the data
directory). It builds a new immutable release, snapshots SQLite, swaps the `current` symlink,
restarts the services, bumps the desired-state watermark and health-checks the platform. A failed
health check restores the previous release automatically.

```sh
curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/skiff/main/install.sh | sudo env \
  SKIFF_REF=v1.2.3 sh -s -- --upgrade --yes \
  --platform-host control.example.com --content-domain example.com \
  --acme-email ops@example.com
```

The installer is the updater. On an existing install it:

1. Snapshots SQLite to `/var/lib/skiff/backups/pre-upgrade-<UTC>.db` with
   `sqlite3 .backup` whenever `skiff.db` exists (with or without `--upgrade`). Settings
   not given as flags are kept from the existing `skiff.env`.
2. Stops the control plane, agent and Caddy (sites are briefly unavailable on the edge;
   homelab-placed projects with cached state keep serving).
3. Downloads the source tarball, builds the release on the host, then atomically repoints
   `/opt/skiff/current`. (Signature verification against the signed release bundle is not
   wired into the installer yet.)
4. Restarts Caddy, control plane and agent. Forward-only migrations run on control-plane
   start; the explicit migrator is available for restores.
5. Health-checks the unix socket. On failure it stops the control plane, restores the
   pre-upgrade SQLite snapshot, repoints `current` at the previous release, restarts, and
   exits non-zero. This matters because migrations are forward-only: code rollback alone
   is not enough if the schema moved.

Rollback manually if needed:

```sh
readlink -f /opt/skiff/current
sudo ln -sfn /opt/skiff/releases/<previous-version> /opt/skiff/current
sudo systemctl restart caddy skiff-control-plane skiff-agent
```

The installer prunes release directories, keeping the active one and the previous target.
A failed upgrade stays in `/var/lib/skiff/backups` for inspection.

Policy (D28): patch releases may auto-apply in a maintenance window; minor/major releases
notify you first. Never upgrade across a database backup window without confirming
Litestream is current.

### 4.1 Self-update from GitHub

```sh
sudo skiff-update-self              # install the newer VERSION, if any (rolls back on failure)
sudo skiff-update-self check        # running vs latest version; changes nothing
sudo skiff-update-self --dry-run    # show the commit and the plan
sudo skiff-update-self status       # current / previous / last switch / failed commits
sudo skiff-update-self rollback     # back to previous; run again to undo the rollback
```

Or use **Settings → Updates** in the dashboard (platform owners and admins only).

**Versioning.** The platform version is the repository-root [`VERSION`](../VERSION) file, a
[semantic version](https://semver.org) such as `1.4.0` or `1.5.0-rc.1`. To ship an update, bump
it on `main`. The updater reads `VERSION` at the exact commit it would build, and installs it
only when that version is **newer by semver precedence** than the running release (so
`0.10.0 > 0.9.0` and `1.0.0-rc.2 < 1.0.0`). Commits that do not bump `VERSION` are never
installed, and it never downgrades. Use `rollback` to go back, or `--force` to rebuild or
deliberately downgrade.

Bumping is mostly automatic. `bun install` sets `core.hooksPath` to `.githooks`, and its
`pre-commit` hook (`scripts/version.ts auto`) patch-bumps `VERSION` in the first commit after a
release that changes shipped code. Later commits in the same batch keep that version. Commits that
touch only docs, tests, CI or the separately versioned CLI never bump. Minor and major bumps are
always manual: run `bun run version:minor` or `bun run version:major` in the commit that adds
the feature or breaking change, and the hook then leaves it alone. Use `bun run version:show`
to see what is released and what is pending. To skip the hook, use `git commit --no-verify` or
`SKIFF_NO_VERSION_BUMP=1`. The hook compares against your local `origin/main`, so `git fetch`
before a batch. The build bakes `VERSION` in, so the dashboard always shows the version
of the code that is actually running.

**From the dashboard.** The control plane is unprivileged and sandboxed, so it cannot update or
restart itself. The button drops `/var/lib/skiff/update/request`. A root path unit
(`skiff-update-self.path`) notices it and starts `skiff-update-self.service`, which deletes the
request and runs `skiff-update-self update --trigger dashboard`. The updater treats the request
purely as a trigger: it re-checks GitHub itself and never reads the file. Progress goes to
`/var/lib/skiff-update/status.json` (`root:skiff 0640`), which the page polls through the
restart. Every request is recorded in the audit log as `platform.update`. The installer creates
both units, and so does any `sudo skiff-update-self` run, which is how existing hosts get the
button. Logs: `journalctl -u skiff-update-self`.

`skiff-update-self` (source: [`scripts/update-self/`](../scripts/update-self)) pulls the
ref the current release was built from (default `main`; `--ref` to pin a tag), and keeps
a known-good control plane serving at every step:

1. **Build beside the running release.** The commit is downloaded and built into
   `/opt/skiff/releases/<UTC>-<sha12>`. Nothing that serves is touched; a failed build leaves
   no trace.
2. **Canary.** The new build boots as a transient systemd unit with the production user and
   sandbox, its own socket, and a `VACUUM INTO` copy of the live database in
   `/var/lib/skiff/update-canary/`. Migrations therefore run against real data before the swap.
   SMTP, alerts, R2 and backups are stripped from the canary's environment. If it does not
   answer `/api/setup/status` and render `/login`, the release is deleted and the commit is
   remembered as failed (skipped until `--force`).
3. **Swap.** Stop the control plane, snapshot SQLite to
   `/var/lib/skiff/backups/pre-update-<release>.db`, repoint `previous` → old release, then
   `current` → new release (each an atomic rename), start.
4. **Verify.** The socket must answer health checks, then stay up without crash-restarts for
   10 s. If the public URL answered before the update, it must answer after
   (`--require-public` / `--no-public-check` to override).
5. **Keep or revert.** On success, releases other than `current` and `previous` are pruned,
   as are superseded snapshots. On failure the old release, the old `previous` link and the
   pre-update database are restored (Litestream is paused for the swap so it starts a clean
   generation), the old release is verified, and the commit is marked failed.

The swap is a restart, so the control plane is unavailable for a few seconds; Caddy and the
agent keep serving sites. Downtime does not cover the build or the canary. `--with-agent` also
restarts `skiff-agent` on the new binary (the agent otherwise picks it up on its next restart).
Run it under `systemd-run --unit=skiff-update-self --wait sudo skiff-update-self` or `tmux` on
flaky SSH. If the process dies mid-swap anyway, the next `skiff-update-self` invocation keeps
the new release when it is healthy and reverts it otherwise.

**Rollback and the database.** Every switch records the database exactly as the outgoing
release left it. `rollback` takes a fresh snapshot, then swaps `current` and `previous`:

- no flag: allowed only when the previous release knows every applied migration;
- `--restore-db`: also restore the snapshot from the switch (writes since then are lost, but
  the pre-rollback snapshot makes this undoable: `rollback --restore-db` again goes forward);
- `--keep-db`: run the old code against the newer schema (fine for purely additive migrations).

Exit codes: `0` updated or nothing to do, `1` nothing changed or rolled back (old release
serving), `2` the old release did not come back healthy (look at
`journalctl -u skiff-control-plane` now). The updater does not rewrite systemd units: it refuses
a release that lacks a path the installed unit references, and unit changes still go through
`install.sh --upgrade`. Private repositories need `SKIFF_GITHUB_TOKEN` or
`/etc/skiff/github.token` (`0600`).

### 4.2 Uninstall

```sh
sudo skiff-uninstall                 # remove binaries/units; keep data + config
sudo skiff-uninstall --purge --yes   # remove local state too (R2 is never touched)
```

The default keeps `/var/lib/skiff`, `/etc/skiff` and `/etc/caddy/Caddyfile` so a
reinstall can reuse the database and master key. `--purge` also removes the system users.
Backups and releases in R2 survive both modes by design.

### 4.3 Platform settings from the dashboard

**Settings → Backups** (R2 credentials, turning Litestream and the monthly restore drill on and off,
running a drill, downloading a database snapshot) and **Settings → Notifications** (SMTP for
sign-in links, invites and email alerts, plus the alert webhook and alert email address) change
`/etc/skiff/skiff.env` without SSH.

Both tabs are **owner-only**: you must be a platform admin (§6.2 of DESIGN, the admin-plugin role)
*and* the owner of the org you're signed in to, in your own dashboard session. Org admins, platform
admins who are not owners, API keys and MCP tokens get 403. On a single-user install that is the
bootstrap user.

It works like the update button. The control plane can't write `/etc/skiff`, so:

1. The dashboard validates the form and *tests it for real* before queueing anything: R2 credentials
   must write, read and delete a probe object (`skiff/healthcheck/…`); SMTP must send a test email to
   you; a new webhook must accept a test alert.
2. It writes `/var/lib/skiff/platform-config/request.json` (`0600 skiff`). The audit log records the
   request as `platform.config` / `platform.backups` / `platform.restoreDrill` with key names only,
   never values.
3. `skiff-platform-config.path` (root) starts `skiff-platform-config.service`, which runs
   `skiff-platform-config apply-request`. The helper claims the request (no symlinks or FIFOs,
   regular files only, at most 64 KiB, deleted once read) and validates it again with the same rules
   (`packages/contracts/src/platform-config.ts`). Only these keys can ever be written:
   `R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ENDPOINT`,
   `SKIFF_SMTP_HOST/PORT/USER/PASSWORD/FROM/SECURE`, `SKIFF_ALERT_WEBHOOK SKIFF_ALERT_EMAIL`. Values
   are pattern-checked (single line; nothing that could change the meaning of `litestream.yml`,
   which expands `${VAR}` before parsing).
4. It saves the old file as `skiff.env.previous`, writes the new one (`root:skiff 0640`), and
   restarts the control plane. If the control plane is not healthy within 60 s, it restores
   `skiff.env.previous`, restarts again and reports `reverted`.
5. Saving R2 credentials also turns backups on. If `/usr/local/bin/litestream` is missing, the helper
   installs Litestream v0.3.13 from GitHub, checked against a **pinned sha256** (amd64/arm64;
   `scripts/platform-config/helper.ts`). It then writes `litestream.yml` (only when missing or
   still on the old `SKIFF_R2_*` names; operator edits are kept, with a `.bak`), installs the backup
   units, the `skiff-restore` / `skiff-restore-drill` / `skiff-alert` commands and `sqlite3`, enables
   Litestream and the drill timer, and checks that Litestream stays running.
   This works whether or not `SKIFF_OBJECT_STORE` is `r2`. When artifacts do live in R2, the
   dashboard refuses to remove the credentials or change the bucket.

Progress is in `/var/lib/skiff-config/status.json` (`root:skiff 0640`). The page polls it through the
restart. The Backups page reads the replica state from `litestream generations` (so a running
process with nothing in R2 shows as failing), the drill result from
`/var/lib/skiff/drill/status.json`, and unit states over `systemctl show`.

The installer creates the wrapper and units, and so does any `sudo skiff-update-self` run (e.g.
`sudo skiff-update-self check`), which is how existing hosts get these tabs. The same operations
work from the shell:

```sh
sudo skiff-platform-config backups on    # or off
sudo skiff-platform-config drill
sudo skiff-platform-config status
journalctl -u skiff-platform-config
```

On a development server (no installed release) the tabs are read-only and explain why.

---

## 5. Restore

### 5.1 When to use it

- SQLite corruption or an accidental destructive migration.
- Rebuilding a lost VPS (with the same release, environment and recovery kit).

Agents and Caddy keep serving the last desired state during a control-plane restore, so
static sites stay up. Restores do not reinstall Caddy/the agent or re-key WireGuard; see
§5.4 for a fresh VPS.

### 5.2 Same-host restore

```sh
sudo skiff-restore --yes
# or select a named replica from litestream.yml
sudo skiff-restore --yes --from offsite
```

Steps performed:

1. Stops `skiff-control-plane` and `skiff-litestream` (agents/Caddy remain up).
2. Snapshots the current database to `/var/lib/skiff/backups/pre-restore-<UTC>.db`.
3. Runs `litestream restore -config /etc/skiff/litestream.yml -o <tmp> <db>` to fetch the
   latest snapshot plus WAL frames from R2.
4. Runs `PRAGMA integrity_check`; refuses to swap in a corrupt file.
5. Atomically moves the restored file into place and removes stale `-wal`/`-shm`.
6. Runs the bundled forward-only migrator as `skiff` (`tools/skiff-migrate.ts`).
7. Starts the control plane, waits for `/run/skiff/control.sock`, then starts Litestream.
8. On health failure, restores the pre-restore snapshot automatically and exits non-zero.

Check afterwards:

```sh
systemctl status skiff-control-plane skiff-litestream --no-pager
journalctl -u skiff-control-plane -n 100 --no-pager
curl -sS --unix-socket /run/skiff/control.sock http://localhost/ -o /dev/null -w '%{http_code}\n'
```

### 5.3 Fresh-VPS disaster recovery (target < 15 min)

1. Provision Debian 13 at the same address or update DNS.
2. Run the installer with the **same version** as the lost host.
3. Restore `/etc/skiff/skiff.env` and `/etc/skiff/master.key` from your offline copy
   (password manager + recovery kit). Do this **before** the control plane starts:
   `systemctl stop skiff-control-plane`.
   - `BETTER_AUTH_SECRET` may be regenerated, but every session and MCP token is
     invalidated. The master key must be the original or existing secrets cannot decrypt.
   - R2 credentials must be present or the restore cannot reach the backups. Keep an
     encrypted copy of the env file with the recovery kit.
4. Install Litestream (`/usr/local/bin/litestream`) and re-run the installer (or enable
   `skiff-litestream.service`) once R2 is configured.
5. Run `skiff-restore --yes`.
6. Re-issue certificates: Caddy obtains them automatically via DNS-01 on first start;
   confirm the Cloudflare token is in `/etc/caddy/cloudflare.token`.
7. Re-key WireGuard (control plane + homelab); the homelab dials out and agents reconcile.
8. Run the verification in §5.2 and the checks in §7.

### 5.4 What restore does not do

- It does not restore release artifacts; R2 is canonical and agents cache them.
- It does not restore hot DuckDB telemetry (by design); cold Parquet remains in R2.
- It does not restore Caddy certificate files; they are re-issued.
- It does not touch R2; backups are never deleted by restore or uninstall.

---

## 6. Backup policy

| Data | Mechanism | Frequency / retention | RPO |
|---|---|---|---|
| SQLite | Litestream → R2 (`skiff-litestream.service`) | WAL sync ~1 s; snapshot every 24 h; 30-day retention | ≤ ~1 s |
| Release artifacts | Canonical in R2 (`SKIFF_R2_ARTIFACT_PREFIX`) | Lifecycle per project; last 10 + pinned in DB | n/a |
| Telemetry | Daily Parquet partitions in R2 (`SKIFF_R2_PARQUET_PREFIX`) | 48 h 1-minute + 90 d 1-hour in DuckDB; Parquet long-lived | 24 h |
| Master key | Recovery kit: `age`-encrypted with a passphrase, shown once at install | Offline; re-export on rotation | n/a |
| Config/secrets | Offline encrypted copy of `/etc/skiff/skiff.env` + recovery kit | On change | n/a |
| Caddy config/token | `/etc/caddy/Caddyfile`, Cloudflare token | On change | n/a |

Notes:

- Enable R2 object versioning and a lifecycle rule for the SQLite prefix. Litestream
  retention (`720h`) is a floor; versioning protects against a bad snapshot.
- Keep the recovery kit and the env copy in different places. Losing the master key means
  losing every encrypted secret, even if the database restores.
- Verify the bucket is not in a different jurisdiction/lifecycle that expires objects
  early. R2 has no egress fees, so there is no reason to shorten retention aggressively.
- The restore drill (§8) is the only proof that the backup is usable. A green Litestream
  process is not evidence.

### 6.1 Installing Litestream

The release workflow does not compile Litestream. Install the upstream binary at
`/usr/local/bin/litestream` (see <https://litestream.io/install/>), verify its checksum,
then enable replication:

```sh
sudo systemctl enable --now skiff-litestream.service
sudo systemctl enable --now skiff-restore-drill.timer
sudo journalctl -u skiff-litestream -n 50 --no-pager
```

With R2 configured, the installer always writes `/etc/skiff/litestream.yml`, the Litestream
and restore-drill units, `skiff-alert@.service`, and the `skiff-restore` /
`skiff-restore-drill` / `skiff-alert` commands. It enables the units only when `litestream`
is on `PATH`; otherwise it warns and leaves them disabled, so nothing crash-loops at boot.
Only the binary has to be installed by hand, or let **Settings → Backups** (§4.3) install the
pinned Litestream release and enable everything when you save the R2 credentials.

### 6.2 Recovery kit

> **Not yet implemented.** The `age`-encrypted recovery kit (DESIGN §10) is not produced yet.
> Until it is, keep an offline copy of `/etc/skiff/master.key` and `/etc/skiff/skiff.env` in a
> password manager. Losing the master key means existing secrets cannot be decrypted.

---

## 7. Monitoring and alerts

### 7.1 Signals

- Control plane and agent expose Prometheus `/metrics`; OTLP export is optional.
- `journalctl -u skiff-control-plane|skiff-agent|caddy|skiff-litestream`.
- The drill writes `/var/lib/skiff/drill/status.json` (`ok`, timestamp, reason).
- `systemd-analyze security <unit>` for sandbox drift.
- Litestream: check R2 object age under `skiff/sqlite` (the newest WAL segment
  should be seconds old). A running process with no recent objects is a silent failure.

### 7.2 Default alerts (DESIGN §8)

| Condition | Severity | First response |
|---|---|---|
| Node offline > 2 min | page | Check WireGuard, agent unit, control-plane connectivity. |
| Disk > 85% | warn | Find release cache growth / logs; GC old deployments. |
| Certificate expiring < 14 d (**not yet implemented**) | warn | Check Cloudflare token and DNS-01; `caddy reload`. |
| 5xx spike after promote (**not yet implemented**) | page | Roll back the production pointer; inspect the release. |
| Failed backup or restore drill | page | Run §5.2 / §8.3; do not assume the backup is good. |
| Litestream restart loop | warn | Check R2 credentials/endpoint and bucket permissions. |

Wire email (SES SMTP) and/or a webhook (ntfy, Discord, Home Assistant) through the
`Notifier` interface. `skiff-restore-drill.service` and `skiff-litestream.service` ship with
`OnFailure=skiff-alert@%n.service`, which sends the alert through `SKIFF_ALERT_WEBHOOK` and/or
SMTP directly (it works with the control plane down) and includes the drill's
`status.json` reason. Drill results are not yet recorded in the dashboard.

Quick checks:

```sh
systemctl list-timers 'skiff-*'
journalctl -u skiff-restore-drill -n 100 --no-pager
cat /var/lib/skiff/drill/status.json
journalctl -u skiff-litestream -n 100 --no-pager
```

---

## 8. Restore drill

The timer runs `skiff-restore-drill.service` on the 1st of each month at 04:17 with up to
30 minutes of jitter (`Persistent=true`). It is enabled by the installer only once R2 is
configured.

### 8.1 Procedure

1. Quiesce: stop `skiff-litestream` and `skiff-control-plane`. Agents/Caddy keep serving.
2. `litestream restore` the latest snapshot + WAL frames into
   `/var/lib/skiff/drill/run-<UTC>/restored.db`.
3. `PRAGMA integrity_check`.
4. Fingerprint both databases: table list, row counts, and a SHA-256 over every row ordered
   by primary key (`scripts/skiff-db-fingerprint.ts`).
5. Compare the two JSON documents byte-for-byte. Any difference is a failure.
6. Restart services, verify the control plane socket, then prune old successful runs
   (keep `SKIFF_RESTORE_DRILL_KEEP`, default 3). Failed runs are kept for inspection.

Manual run:

```sh
sudo skiff-restore-drill
sudo journalctl -u skiff-restore-drill -n 100 --no-pager
```

### 8.2 Why the brief stop

Comparing a live WAL while writes are in flight produces false mismatches. Stopping
Litestream lets it flush its final frames; stopping the control plane removes new writes.
The window is seconds and sites continue to serve cached state. If a zero-downtime check
is required, `SKIFF_DRILL_NO_QUIESCE=1` compares best-effort but may fail spuriously.

### 8.3 Failure handling

A non-zero exit means the backup is not currently restorable or not identical. Do not
ignore it:

1. Read `status.json` and the retained run directory (`restored.json`, `live.json`, logs).
2. Check R2 reachability, credentials, bucket lifecycle/versioning and Litestream logs.
3. Run a manual restore into a scratch directory and inspect table differences.
4. If the live DB is corrupt but R2 is good, run `skiff-restore --yes`.
5. If both are bad, use the newest pre-upgrade/pre-restore snapshot in
   `/var/lib/skiff/backups` and open a postmortem; adjust retention.

The drill never deletes the live database. Its only production side effect is the brief
service stop and a scratch directory under `/var/lib/skiff/drill`.

---

## 9. Single point of failure (accepted)

Per D24, the VPS is an accepted single point of failure in v1. There is no automatic
ingress failover, no second control plane, and no synchronously replicated SQLite.

Consequences:

- **VPS lost** → control plane, Caddy ingress and edge-placed sites are down. Homelab
  nodes keep their cached state but have no public ingress. Recovery is the §5.3 runbook,
  targeting under 15 minutes.
- **Control plane crash** → dashboard/API/MCP down; agents keep serving the last desired
  state and systemd restarts the app.
- **R2 unreachable** → new deploys/uploads fail; existing sites are unaffected.
- **Homelab offline** → homelab-placed projects return a branded 503 after health checks;
  edge-placed projects keep serving.

Keep DNS TTLs low enough that repointing the A/AAAA records to a replacement VPS is
minutes, not hours. Cloudflare Tunnel backup ingress and DNS failover are future work
(ROADMAP, "Later / maybe").

---

## 10. systemd sandboxing rationale

| Directive | Why |
|---|---|
| `ProtectSystem=strict` | `/usr`, `/boot`, `/etc`, `/opt` become read-only. The only writable paths are explicit `ReadWritePaths=`; a compromised Bun process cannot persist in `/usr` or edit its own units. |
| `ReadWritePaths=` | Least-privilege allowlist: control plane `/var/lib/skiff` + `/run/skiff`; agent adds `/srv/skiff`; Caddy only its data dir; drill its scratch dir. |
| `NoNewPrivileges=yes` | No setuid escalation from a compromised service. v1 needs no runtime root (D26). |
| `PrivateTmp=yes` | Private `/tmp` and `/var/tmp`, so services cannot signal or poison each other through shared temp files. The drill's scratch lives under `/var/lib/skiff`, not `/tmp`. |
| `PrivateDevices=yes` | No raw device access. Caddy binds 80/443 with `CAP_NET_BIND_SERVICE`, not root. |
| `ProtectHome=yes` | Home directories are empty/inaccessible. |
| `ProtectKernel*`, `ProtectClock`, `ProtectHostname`, `ProtectControlGroups` | Blocks kernel module loading, sysctl changes, clock/hostname tampering and cgroup escapes. |
| `RestrictAddressFamilies=` | Control plane: `AF_UNIX AF_INET AF_INET6` (R2/SES/Cloudflare). Caddy: same. Agent: adds `AF_NETLINK` for interface stats. No packet sockets. |
| `RestrictNamespaces=yes` | No unprivileged namespace creation. |
| `RestrictSUIDSGID=yes` | Files created by the service cannot gain setuid/setgid bits. |
| `LockPersonality=yes`, `SystemCallArchitectures=native` | No 32-bit ABI or personality switching. |
| `SystemCallFilter=@system-service + io_uring` | Removes privileged/mount/obsolete syscalls. Bun needs the io_uring syscalls on some kernels; they are explicitly allowed. If a future Bun release adds a syscall, add it here rather than dropping the filter. |
| `MemoryMax=` | Control plane 1 GB (room to buffer a full 500 MiB artifact upload), agent 192 MB, Caddy 256 MB, Litestream 256 MB, drill 1 GB. Bounds a runaway DuckDB/Bun/Caddy process on a 4 GB VPS. |
| `TasksMax=`, `LimitNOFILE=` | Prevents fork/descriptor exhaustion. |
| `LoadCredential=master-key:…` | The master key is placed in the service's credential directory (`%d`), not the environment, and is not readable by other services. `/etc/skiff/master.key` stays `0400 root`. |
| `CapabilityBoundingSet=` (empty) | Control plane, agent, Litestream and drill have no capabilities. Only Caddy keeps `CAP_NET_BIND_SERVICE`. |
| `ProtectProc=invisible` (control plane) | Hides other processes. `ProcSubset=pid` is deliberately not set because Bun/DuckDB read `/proc/cpuinfo` and `/proc/meminfo`; the agent also needs `/proc` for node metrics. |
| Setgid `/run/skiff` | The alternative to a root socket helper: socket ownership is controlled by directory group inheritance, and no service joins another's primary group. |

Caddy's admin API is never on TCP `:2019` (D7). It is reachable only at
`/var/lib/caddy/admin.sock` with group `caddy`; the agent is the only consumer.
The external edge as configured in [EDGE.md](./EDGE.md) uses
`/var/lib/caddy/admin.sock`; if you adopt these units on that host, point
`SKIFF_CADDY_ADMIN_SOCKET` and the unit at that path and grant `caddy` access
instead of running Caddy as `caddy`.

Review drift with:

```sh
systemd-analyze security skiff-control-plane.service
systemd-analyze security skiff-agent.service
systemd-analyze security caddy.service
```

---

## 11. Master key rotation

The master key is a key-encryption key (KEK). It does **not** encrypt deployment data
directly: each org has a data key (DEK), and the master key wraps those DEKs. Rotation
therefore re-wraps a small number of DEKs; it does not re-encrypt every secret or release.
Replacing `/etc/skiff/master.key` with a new random file **without re-wrapping** makes
existing secrets undecryptable.

### 11.1 Prepare

1. Confirm the latest Litestream snapshot is current and a drill has passed recently.
2. Take a manual snapshot: `sudo sqlite3 /var/lib/skiff/data/skiff.db ".backup '/var/lib/skiff/backups/pre-key-rotation.db'"`.
3. Copy `/etc/skiff/master.key` (old) and `/etc/skiff/skiff.env` to offline recovery media.
4. Announce a short maintenance window: control plane down; sites keep serving.

### 11.2 Rotate

Use the control-plane admin operation (v1 owner/admin only). It must decrypt every org DEK
with the old key and re-encrypt with the new one in a single transaction before the
credential is swapped:

```sh
sudo systemctl stop skiff-control-plane
sudo skif admin keys rotate \
  --old /etc/skiff/master.key \
  --new /etc/skiff/master.key.new
```

If the admin command is not present in your build, **do not hand-edit the database or swap
the file**. Defer rotation until the command is available; the operation must be atomic
and re-wrap every DEK.

Then install the new credential and restart:

```sh
sudo install -m 0400 -o root -g root /etc/skiff/master.key.new /etc/skiff/master.key
sudo rm -f /etc/skiff/master.key.new
sudo systemctl start skiff-control-plane
```

`LoadCredential=` reads the file at unit start, so no `daemon-reload` is required for a key
change; a restart is.

### 11.3 Verify and re-export

1. Open the dashboard and confirm an existing secret-backed deployment still activates.
2. Create and read a throwaway secret (write-only API) to prove new writes work.
3. Re-export the recovery kit with the new key and store it offline.
4. Keep the old key offline for one rollback window; destroy it after a successful drill
   and a few days of normal operation.

Rotating `BETTER_AUTH_SECRET` (sessions) or `SKIFF_SITE_COOKIE_SECRET` (protected-site
cookies) is independent: replace the value in `/etc/skiff/skiff.env`, restart the control
plane (and agent for the site-cookie secret), and expect existing sessions/cookies to be
invalidated. Rotate R2 keys in Cloudflare, update the env file, then restart Litestream and
the control plane.

---

## 12. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Control plane won't start | `journalctl -u skiff-control-plane -n 100` | Usually missing `SKIFF_PLATFORM_ORIGIN`/`BETTER_AUTH_SECRET` in the env file, or `/etc/skiff/master.key` missing. |
| Caddy can't reach the control plane | `ls -l /run/skiff`, `namei -l /run/skiff/control.sock` | `/run/skiff` must be `2770 root:caddy`; control plane needs `SupplementaryGroups=caddy`. |
| Agent can't use Caddy admin | `ls -l /var/lib/caddy/admin.sock` | Socket must be `0660` and group `caddy`; agent needs that supplementary group. Never expose `:2019` as a workaround. |
| Litestream exits immediately | `journalctl -u skiff-litestream` | Missing/incorrect `SKIFF_R2_*`; endpoint must be the R2 S3 URL, region `auto`. |
| Restore says "no snapshots" | R2 prefix/lifecycle, credentials | Check `SKIFF_R2_SQLITE_PREFIX`; confirm objects exist; run a drill. |
| Restore fails health check | Journal + `status` | The pre-restore snapshot was restored automatically; inspect the release/migrations. |
| Drill fails with table differences | `diff` of `live.json` / `restored.json` | R2 lag, wrong bucket, or writes during a no-quiesce run. Re-run with quiescing. |
| Disk > 85% | `du -sh /srv/skiff /var/lib/skiff /var/log` | GC releases, rotate journald, prune drill runs/backups. |
| `systemd-analyze security` score regressed | Unit diff | Reinstall the release units; local drop-ins may weaken sandboxing. |

Emergency access: SSH is key-only; on the edge prefer SSH over WireGuard and keep a
key-only break-glass path. Do not open the Caddy admin API or the control plane to the
internet while debugging.

---

## 13. Assumptions in this delivery

- The systemd units are checked in at `scripts/systemd/` (the release bundle ships them as
  `systemd/`); the installer is the only writer of `/etc/systemd/system/skiff-*.service`.
- The release bundle includes the matching Bun runtime, a production-only hoisted
  `node_modules` tree (adapter-bun externalises dependencies), migrations, ops scripts,
  `litestream.yml` and units, so a `curl | sh` install is self-contained. The DuckDB
  native binding is selected for the tarball's architecture in CI.
- Litestream is installed separately (`/usr/local/bin/litestream`); the installer detects
  it and enables replication only when R2 is configured. It is not compiled by the release
  workflow.
- Bun `1.4.0`, Caddy `2.11.7` and `caddy-dns/cloudflare` `v0.2.4` are pinned in the release
  workflow. Bump them together and re-run the drill.
- The browser setup wizard and the `skif admin keys rotate` command are product surfaces
  described by DESIGN §12 and §11.2; this delivery defines their contracts (setup token,
  `setup-complete`, credential path) but does not implement them.
- `BETTER_AUTH_SECRET` can be regenerated on a fresh-VPS restore at the cost of invalidating
  sessions; the master key cannot, so the recovery kit and an encrypted env copy are part of
  the backup policy.
