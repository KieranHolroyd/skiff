# Skiff — Operations

Version: v1. This is the runbook for the single-VPS install: install, upgrade, recovery from a
stuck or failed update, restore, backups, monitoring, the monthly restore drill, and master-key
rotation.

Design context: [DESIGN.md](./DESIGN.md) §10–§12, [DECISIONS.md](./DECISIONS.md)
D107 (clustering and HA, [CLUSTERING.md](./CLUSTERING.md)), D25 (object store), D28
(product-grade releases) and D37 (unix socket behind Caddy).

---

## 1. Host layout

| Path | Owner / mode | Purpose |
|---|---|---|
| `/opt/skiff/current` | symlink | Active release. Atomic swap is the upgrade/rollback primitive. |
| `/opt/skiff/previous` | symlink | Last known-good release, kept until the next successful update (`skiff-update-self rollback` target). |
| `/var/lib/skiff/update/` | `skiff:skiff 0750` | Dashboard update requests (the control plane writes `request`). |
| `/var/lib/skiff-update/status.json` | `root:skiff 0640` | Updater progress/outcome, read by the dashboard. |
| `/var/lib/skiff-update/update.log` | `root:skiff 0640` | JSON Lines update log (phases, commands, build output), tailed by the dashboard. |
| `/var/lib/skiff/platform-config/` | `skiff:skiff 0750` | Dashboard settings requests (Settings → Backups / Notifications, §4.3). |
| `/var/lib/skiff-config/status.json` | `root:skiff 0640` | `skiff-platform-config` progress/outcome, read by the dashboard. |
| `/etc/skiff/skiff.env.previous` | `root:skiff 0640` | The env file before the last dashboard change (automatic revert). |
| `/opt/skiff/update-state.json` | `root:root 0600` | Self-updater state: last switch + its DB snapshot, in-flight switch, commits that failed. |
| `/opt/skiff/releases/<version>/control-plane` | `root:root 0755` | SvelteKit build, bundled Bun runtime, units, scripts, migrations. |
| `/opt/skiff/releases/<version>/agent` | `root:root 0755` | `skiff-agent` compiled binary. |
| `/opt/skiff/helper/skiff-helper` | `root:root 0755` | Privileged runtime helper installed from the active release (one binary, swapped by the updater). |
| `/etc/skiff/helper.env` | `root:skiff 0640` | Helper environment (socket groups, release roots, AppArmor mode). |
| `/opt/skiff/releases/<version>/caddy/caddy` | `root:root 0755` | Caddy 2.11.8 + `caddy-dns/cloudflare`; installed by the updater. |
| `/etc/skiff/skiff.env` | `root:skiff 0640` | Runtime environment and secrets (see §2). |
| `/etc/skiff/master.key` | `root:root 0400` | Master key, delivered via `LoadCredential=`, never sourced by shell. |
| `/etc/skiff/setup-token` | `root:skiff 0640` | Single-use setup URL token. |
| `/etc/skiff/litestream.yml` | `root:skiff 0640` | R2 replication config. |
| `/etc/caddy/Caddyfile` | `root:caddy 0640` | Caddy bootstrap/wizard-managed config. |
| `/etc/caddy/cloudflare.token` | `root:caddy 0640` | DNS-01 token, read with `{file./etc/caddy/cloudflare.token}`. |
| `/etc/skiff/cloudflare.token` | `root:skiff 0640` | DNS-01 token saved from **Settings → Domains** (read by the edge agent). |
| `/var/lib/skiff` | `skiff:skiff 0751` | Data root; other-traverse lets Caddy reach its own subdirectory without listing Skiff data. |
| `/var/lib/skiff/data/skiff.db` | `skiff:skiff 0640` | SQLite (platform state). |
| `/var/lib/skiff/clickhouse` | `skiff-clickhouse:skiff-clickhouse 0750` | Hot telemetry (ClickHouse data). Not backed up; see §3.6. |
| `/opt/skiff/clickhouse/<version>/clickhouse` | `root:root 0755` | ClickHouse server binary (pinned, sha512-verified); the previous version is kept until the new one serves. |
| `/etc/skiff/clickhouse/{config,users}.xml` | `root:skiff-clickhouse 0640` | Generated ClickHouse config; rewritten on every install/update (§3.6). |
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
| `SKIFF_PLATFORM_ORIGIN` | `http://<server-ip>` without a domain | no | Canonical platform origin, e.g. `https://control.example.com` or `http://203.0.113.7`. Used for auth, MCP audience, CSRF, cookies and passkeys. Change it in **Settings → Domains** (§3.7), never by hand alone: the edge agent's `agent.env` must change with it. |
| `SKIFF_CONTENT_DOMAIN` | `<ip-with-dashes>.sslip.io` without a domain | no | Wildcard content zone, e.g. `examplecloud.com`; sites are `<slug>.<domain>`. Changed with the platform origin in **Settings → Domains**; stored preview/storage hosts follow on the next boot (D105). |
| `SKIFF_DATA_DIR` | `/var/lib/skiff/data` | no | SQLite database and local object store. |
| `SKIFF_SETUP_TOKEN_FILE` | `/etc/skiff/setup-token` (production) | no | File containing the one-time setup token for `/setup` (D102). Must be readable by `skiff`; when it is missing or unreadable the control plane generates `$SKIFF_DATA_DIR/setup-token` instead and logs the link on every boot until an owner exists. |
| `SKIFF_AGENT_SOCKET` | `/run/skiff/agent.sock` | no | Agent unix socket (`forward_auth` and local control-plane calls). |
| `SKIFF_CADDY_ADMIN_SOCKET` | `/var/lib/caddy/admin.sock` | no | Caddy admin unix socket. |
| `SKIFF_AGENT_VERSION` | empty | no | Optional desired agent version; normally set by the control plane. |
| `SKIFF_RELEASE_CHANNEL` | `stable` | no | `stable` or `edge`. Edge is reported as a preflight warning (shorter support window). |
| `SKIFF_UPDATE_METHOD` | `auto` | no | Initial choice on Settings → Updates: `auto`, `download` or `build`. Security-sensitive hosts can default it to `build`; the CLI still accepts `--source`. |
| `SKIFF_EDGE_NODE_ID` | empty | no | Node identity for single-node mode. |
| `SKIFF_CONTROL_URL` | — | no | Agent only (`/etc/skiff/agent.env`): control-plane origin, `http(s)://…`. |
| `SKIFF_CONTROL_SOCKET` | `/run/skiff/control.sock` on the control-plane host | no | Agent only: send control-plane requests to this unix socket instead of through Caddy (D105). Set for the edge agent by the installer and by Settings → Domains; leave unset on worker nodes. |
| `SKIFF_NODE_ID` | — | no | Agent only: node id from `skiff-agent join`. |
| `SKIFF_NODE_TOKEN` | — | **yes** | Agent only: bearer token from the single-use join token. |
| `SKIFF_CADDY_LISTEN` | `:443,:80` | no | Agent only: listeners Caddy should bind. |
| `SKIFF_CADDY_ACCESS_LOG` | installer: `/var/log/caddy/skiff-access.log` | no | Agent only: Caddy JSON access log (0640, read via the `caddy` group). The agent adds it to the Caddy config and aggregates it into 1-minute buckets. |
| `SKIFF_CERT_PROBE_ADDR` | loopback on the TLS listen port (when TLS is on) | no | Agent only: where the agent handshakes to read served certificate expiry (every 6 h) for the cert-expiry alert; `off` disables it. |
| `SKIFF_LOG_DRAIN` | `1` | no | Agent only: drain workload stdout/stderr through the helper into the control plane for the dashboard's live Logs tab. `0` disables the drain. |
| `SKIFF_LOG_DRAIN_INTERVAL_MS` | `2000` | no | Agent only: how often the log drain asks the helper for new journal lines (500–60000 ms). |
| `SKIFF_MCP_ALLOW_DCR` | `1` | no | Keep legacy Dynamic Client Registration alongside CIMD. |
| `SKIFF_OPEN_SIGNUP` | unset | no | `1` allows open sign-up (the first user becomes platform admin). Production is invite-only (D10): the owner is created by the setup wizard, and no sign-up method works before that (D102). |
| `SKIFF_DEV_PASSWORD_LOGIN` | unset | no | Development only; refused in production. Opens sign-up (including public email+password sign-up) and turns off the owner second factor for headless tests. Password sign-in itself is always on (D103). |
| `SKIFF_OWNER_2FA` | `1` (`0` only in dev password mode) | no | Org owners must prove a passkey or authenticator code per session before using the dashboard/API (D10). Password, GitHub and magic-link sign-ins are single-factor. |
| `SKIFF_ACME_EMAIL` | empty | no | Agent only: ACME account email. Enables TLS/DNS-01 when set. |
| `SKIFF_CLOUDFLARE_API_TOKEN` | empty | **yes** | Agent only: scoped DNS token for `caddy-dns/cloudflare` (Zone.DNS edit on the content zone). |
| `SKIFF_ACME_CA` | Let's Encrypt | no | Agent only: ACME directory URL (use the staging URL while testing). |
| `SKIFF_TLS` | auto | no | Agent only: `1` forces TLS, `0` disables it (dev). Defaults to enabled when `SKIFF_ACME_EMAIL` is set. |
| `SOCKET_PATH` | `/run/skiff/control.sock` | no | adapter-bun unix socket (D37), set by the unit. |
| `PROTOCOL_HEADER` | `x-forwarded-proto` | no | Trust Caddy's forwarded protocol, set by the unit. |
| `HOST_HEADER` | `x-forwarded-host` | no | Trust Caddy's forwarded host, set by the unit. |
| `BODY_SIZE_LIMIT` | `520M` | no | adapter-bun request body cap, set by the unit. Its 512 KB default would reject artifact uploads with a bare 413; 520M covers the 500 MiB artifact limit, which the upload route enforces. |
| `SKIFF_STORAGE_GATEWAY_PORT` | `8081` | no | Loopback port of the edge's internal S3 gateway (D82). The agent listens on `127.0.0.1:<port>`; the control plane connects there to browse bucket contents. Must match on both processes. |
| `SKIFF_STORAGE_GATEWAY_URL` | — | no | Dev only: full URL of the S3 gateway, overriding `http://127.0.0.1:$SKIFF_STORAGE_GATEWAY_PORT`. Use it when the control plane is not on the edge host, pointing at a node's Caddy listener (e.g. `http://192.168.0.9:8080`); that node must hold the instance or be the edge. |
| `SKIFF_DATABASE_GATEWAY_PORT` | `8082` | no | Loopback port of the edge's internal database gateway (D82, D96). The agent listens on `127.0.0.1:<port>` and routes each node's `n-<label>.studio.internal` host to that node's studio front; the control plane connects there for the studio's `/databases/:name/studio/api/*` calls. Must match on both processes. |
| `SKIFF_STUDIO_PORT` | `8083` | no | Loopback port of the agent's studio front on every node (D96). The gateway routes studio hosts to `127.0.0.1:<port>`; the front forwards to `skiff-studio.service` over `/run/skiff/studio.sock`. Must match on the control plane and every agent. |
| `SKIFF_STORAGE_OBJECT_MAX_BYTES` | `104857600` | no | Largest single object uploaded through the dashboard/API (100 MiB). Larger files need a presigned upload (public instances) or `skif storage objects put`. |

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
| `SKIFF_PUBLIC_HOST` | detected (`hostname -I`) | Installer (`--public-address`): this server's IPv4 for an install without a dashboard domain. Used for `http://<ip>` and `<ip>.sslip.io`. |
| `SKIFF_ALERT_WEBHOOK` | unset | `skiff-alert` (backup/drill `OnFailure=`): webhook URL; SMTP settings are reused for email. Receives `{title, message, severity, key}`, except that a Discord or Slack URL gets that service's own payload. |
| `SKIFF_ALERT_DISCORD_WEBHOOK` | unset | Discord channel webhook (`https://discord.com/api/webhooks/<id>/<token>`). Alerts are sent as embeds coloured by severity, with mentions disabled. Secret. |
| `SKIFF_ALERT_SLACK_WEBHOOK` | unset | Slack incoming-webhook URL, or any Slack-compatible one (Mattermost, Rocket.Chat). Only `text` is sent. Secret. |
| `SKIFF_ALERT_TELEGRAM_BOT_TOKEN` / `SKIFF_ALERT_TELEGRAM_CHAT_ID` | unset | Telegram bot token (from @BotFather; secret) and the chat, group (`-100…`) or `@channel` it posts to. Both are needed. |
| `SKIFF_ALERT_NTFY_URL` / `SKIFF_ALERT_NTFY_TOKEN` | unset | ntfy topic URL (ntfy.sh or self-hosted), published as JSON with priority 3–5 by severity. The token is optional (`tk_…`, secret) and is for protected topics. |
| `SKIFF_ALERT_SMS` | unset | Comma-separated E.164 numbers (at most 5) that get alerts by SMS through Twilio. Sent only when `SKIFF_TWILIO_*` is set too. Each new number is sent a test SMS before it is saved. |
| `SKIFF_TWILIO_ACCOUNT_SID` / `SKIFF_TWILIO_AUTH_TOKEN` / `SKIFF_TWILIO_FROM` | unset | Twilio credentials for SMS alerts (Settings → Notifications → SMS), checked against Twilio's account endpoint before they are saved (no message is sent). `FROM` takes a Twilio number, a Messaging Service SID (`MG…`) or an alphanumeric sender ID. Each text is folded to GSM-7 and capped at 2 segments. |
| `SKIFF_VAPID_PUBLIC_KEY` / `SKIFF_VAPID_PRIVATE_KEY` | generated | Web Push (VAPID, P-256, base64url) key pair for push alerts to the dashboard installed as an app (Settings → Notifications → Push notifications, D108). The installer generates it, and any `skiff-update-self` run adds it to hosts that lack it; `sudo skiff-platform-config push-keys` (or **Set up push** on that page) does the same and restarts the control plane. Never rotated automatically: a new pair orphans every subscribed device. Private key is a secret. |
| `SKIFF_VAPID_SUBJECT` | platform origin | Optional `mailto:` or `https:` contact sent to push services in the VAPID token. Defaults to the dashboard origin over HTTPS, else `mailto:skiff@<content domain>`. |

> **Not yet implemented:** the installer builds from the source tarball and does not consume the
> signed release bundle, so there is no `SKIFF_RELEASE_URL` / minisign / cosign verification at
> install time yet. `litestream.yml` is always rewritten by the installer.
| `SKIFF_FORCE_OS` | `0` | Installer: override the Debian 13 check. |

Units also set `SOCKET_PATH=/run/skiff/control.sock`, `PROTOCOL_HEADER=x-forwarded-proto`
and `HOST_HEADER=x-forwarded-host` (D37), `BODY_SIZE_LIMIT=520M` (so artifact uploads
are not capped at adapter-bun's 512 KB default), plus
`SKIFF_MASTER_KEY_FILE=%d/master-key` (the systemd credential path).

### 2.5 Feature flags

Risky features ship dark. Each flag is read once at startup from
`SKIFF_FEATURE_<NAME>` in `/etc/skiff/skiff.env`; the resolved booleans are exposed by
`GET /api/setup/status` under `features` (never the raw environment). Accepted values are
`1/true/on/yes` and `0/false/off/no`, case-insensitive. An unset **or malformed** value keeps
the default below, so a typo cannot turn a destructive feature on. Change a flag, then restart
`skiff-control-plane`.

| Variable | Default | Area | Meaning |
|---|---|---|---|
| `SKIFF_FEATURE_BACKUPS_RESTORE` | off | backups | Create, restore and delete managed database backups. Requires a passing restore drill before enabling on new installs. |
| `SKIFF_FEATURE_PITR` | off | backups | Point-in-time recovery (WAL archiving and replay) for managed databases. |
| `SKIFF_FEATURE_OBJECT_BROWSER` | off | storage | Browse, upload, download and delete objects in managed buckets. |
| `SKIFF_FEATURE_POOLER` | off | databases | PgBouncer sidecar and pooled connection port for a managed database. |
| `SKIFF_FEATURE_DB_STUDIO` | **on** | databases | Native database studio (D96): the Studio tab, `/api/v1/databases/:name/studio` and the session-only studio calls. Permission-gated (`database:console`; writes also need `database:update`). Set `0` as a kill switch: the tab and routes disappear and desired state stops listing studio sessions. |
| `SKIFF_FEATURE_DB_TLS` | off | databases | TLS-only managed database connections (`sslmode=require`). |
| `SKIFF_FEATURE_ORG_NETWORKS` | off | networking | Private per-org networks connecting workloads and databases. |
| `SKIFF_FEATURE_SERVICE_ENDPOINTS` | off | networking | Cross-node database attachments through consumer loopback endpoints (CLUSTERING.md C2). |
| `SKIFF_FEATURE_MULTI_NODE_REPLICAS` | off | workloads | Spread HTTP workload replicas across nodes behind a load-balanced route (CLUSTERING.md C4). |
| `SKIFF_FEATURE_APP_VOLUMES` | off | workloads | Persistent application volumes attached to deployed workloads. |
| `SKIFF_FEATURE_JOBS` | off | automation | Scheduled one-off and cron jobs. |
| `SKIFF_FEATURE_PREVIEW_DATA` | off | automation | Clone database and bucket data into previews (can copy production data). |
| `SKIFF_FEATURE_AGENT_DATA_WRITE` | off | agents | Let MCP/agent tools mutate user data instead of read-only access. |
| `SKIFF_FEATURE_QUOTAS` | **on** | platform | Enforce per-org project, storage and upload quotas. Set `0` only to lift limits temporarily. |
| `SKIFF_FEATURE_UPGRADE_ROLLBACK` | off | platform | Reserved for dashboard-triggered automatic rollback after `/readyz` fails. The CLI updater rollback path is the tested default. |
| `SKIFF_FEATURE_BLUEPRINTS` | off | automation | Plan and apply `skiff.yaml` blueprints, including `--prune`. |
| `SKIFF_FEATURE_MEDIA` | off | storage | Image/video uploads, transforms and delivery. |

`SKIFF_FEATURE_DB_CONSOLE` (the DBGate studio, D60) is retired. It is ignored if still set, and
the control plane logs a warning at startup; remove it from `skiff.env`. An unknown
`SKIFF_FEATURE_*` is never an error.

Rollout order is dev → single-node test → Debian 13 node → installer default. Never enable a
destructive feature by default in the release that introduces it, and never enable
`PREVIEW_DATA`, `AGENT_DATA_WRITE` or `BLUEPRINTS` on a host whose data you are not prepared to
have copied, changed or pruned.

### 2.5.1 PITR repository

`SKIFF_FEATURE_PITR` also reads the pgBackRest repository from the control-plane environment
(see [PITR.md](./PITR.md)): `SKIFF_PITR_REPO_BUCKET`, `SKIFF_PITR_ACCESS_KEY_ID`,
`SKIFF_PITR_SECRET_ACCESS_KEY`, optional `SKIFF_PITR_REPO_ENDPOINT`, `SKIFF_PITR_REPO_REGION`,
`SKIFF_PITR_REPO_PREFIX` and `SKIFF_PITR_REPO_FORCE_PATH_STYLE`. An incomplete set fails closed;
the credentials are handed to nodes through the authenticated activation endpoint, never through
desired state or SQLite.

> **Migration note for already-shipped surfaces.** Database backups/restores, credential
> rotation, the object browser and the pooler are already shipped in this release. Their flags
> are registered and default off, but the current code deliberately does **not** hide those
> existing surfaces behind them. A later release that starts gating them must either default the
> flag on for existing installs or call the behaviour change out in the release notes/upgrade
> checklist; silently turning shipped functionality off would be a regression, not a rollout.

### 2.6 Privileged helper

`/etc/skiff/helper.env` configures `skiff-helper` (created by the installer, preserved on upgrade):

| Variable | Default | Meaning |
|---|---|---|
| `SKIFF_HELPER_RELEASE_DIRS` | `/var/lib/skiff/agent/releases,/opt/skiff/releases` | Release roots probed for process workloads. |
| `SKIFF_HELPER_QUADLET_DIR` | `/etc/containers/systemd` | Where `.container`/`.network` files are written for Podman's Quadlet generator. |
| `SKIFF_HELPER_CONTROL_SOCKET_GROUP` | `skiff` | Group allowed to connect to the helper socket. |
| `SKIFF_HELPER_WORKLOAD_SOCKET_GROUP` | `caddy` | Group for socket-activated workload sockets. |
| `SKIFF_HELPER_APPARMOR_PROFILE` | `auto` | `auto` sets `apparmor=unconfined` on containers only when `kernel.apparmor_restrict_unprivileged_unconfined=1` (Ubuntu 26.04 and newer kernels stack the container profile, which denies a process signalling its own children, so Postgres cannot start). `none` keeps the runtime default; any other value is passed as the profile name. |

#### Database studio unit (D96)

`skiff-studio.service` runs the native database studio's query engine: the agent binary's
`studio` entrypoint (`/opt/skiff/current/agent/skiff-agent studio`) as `skiff`, in its own
cgroup (`MemoryMax=256M`, separate from the agent's 192 MB) and listening only on
`/run/skiff/studio.sock`. It holds no node token. The unit is installed by the installer and
updater but has no `[Install]` section: nothing starts it at boot, and `systemctl enable`
refuses it. The agent asks the helper to start it (`POST /v1/studio/start`) when a studio session
arrives for that node, and the process exits after 5 idle minutes. The agent fronts it on
`127.0.0.1:$SKIFF_STUDIO_PORT` (default `8083`), which only the internal database gateway
reaches. An agent update runs `systemctl try-restart skiff-studio.service`, so a running studio
moves to the new binary and a stopped one stays stopped. Logs are in
`journalctl -u skiff-studio`.

**DBGate removal.** The DBGate sidecar (D60) and its pinned image are gone. A node upgraded while
a DBGate session was open can keep a `skiff-workload-<db>-console.container` Quadlet, its
container and a `console.env` under the workload runtime directory. The helper removes these
once, at start: it stops and disables each leftover unit, deletes its file, force-removes any
matching container and deletes the env file, then runs `daemon-reload` only if a unit file was
removed. It logs the database ids it cleaned up. The step is idempotent and best effort, so a
failure is logged and retried on the next helper start. The DBGate image is not deleted; remove it
with `podman image prune` if you need the space.

A helper update is installed from the active release at `/opt/skiff/helper/skiff-helper` and
restarted by the installer/updater. Existing container units are re-rendered on their next apply,
so after a helper upgrade use **Restart** on each managed service (or redeploy an app) to pick up
unit changes.

### 2.7 Telemetry store (ClickHouse)

Installing the optional store (§3.6) adds any of these that are missing to `skiff.env` (passwords
are 32 random bytes, base64url); removing it deletes them again. Without them telemetry reports
"not installed". Existing values are never overwritten, so you can rotate a
password by editing it and running `sudo skiff-update-self`, which regenerates
`/etc/skiff/clickhouse/users.xml` from these values and restarts ClickHouse (§3.6).

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `SKIFF_CLICKHOUSE_URL` | `http://127.0.0.1:18123` | no | ClickHouse HTTP endpoint (loopback only). |
| `SKIFF_CLICKHOUSE_DATABASE` | `skiff` | no | Database the control plane creates and writes. |
| `SKIFF_CLICKHOUSE_USER` | `skiff` | no | Writer: all privileges on the telemetry database only. |
| `SKIFF_CLICKHOUSE_PASSWORD` | generated | yes | Writer password (stored in `users.xml` as SHA-256 only). |
| `SKIFF_CLICKHOUSE_READER_USER` | `skiff_reader` | no | Read-only user for ad-hoc SQL from the dashboard. |
| `SKIFF_CLICKHOUSE_READER_PASSWORD` | generated | yes | Reader password. |

---

## 3. Install

### 3.1 Prerequisites

- Debian 13 or Ubuntu 24.04+ on x86_64/aarch64, systemd, root access.
- Ports 80/443 free. Domains are optional (§3.7); when you use them, point their DNS at this machine.
- **Caddy and Podman are installed for you** (skip with `--skip-deps` / `SKIFF_SKIP_DEPS=1` if you
  manage packages yourself):
  - **Caddy**, when `caddy` is not on `PATH`: from the official Caddy apt repository
    (`dl.cloudsmith.io/public/caddy/stable`, verified by apt), then `caddy add-package
    github.com/caddy-dns/cloudflare` (built by caddyserver.com) for the wildcard HTTPS certificate,
    and `apt-mark hold caddy` so upgrades keep the module. The package's Caddyfile is kept as
    `Caddyfile.dist` and replaced with a bootstrap that puts the admin API on
    `unix//var/lib/caddy/admin.sock|0660` (never TCP); the agent pushes the real config through it.
    If the module download fails the install continues (HTTP works); HTTPS needs it later. An
    existing Caddy is used as is: HTTPS installs need it built with `caddy-dns/cloudflare`.
  - **Podman** (agent installs only): `podman uidmap passt netavark aardvark-dns`. Managed
    Postgres and RustFS run as rootful Quadlet containers (Podman 4.4+). On releases that lack a
    package the installer installs the rest and warns.

- **Port 53 for Podman DNS.** A DNS daemon such as BIND must not listen on `0.0.0.0:53`: Podman's
  per-network DNS (aardvark-dns) binds the bridge gateway (for example `10.89.0.1:53`) and fails
  every container start with `Address already in use`. Bind only the host's real addresses in
  `named.conf.options` (`listen-on { 127.0.0.1; <public-ip>; };`) before enabling managed services.
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

Without domains (dashboard at `http://<server-ip>`, sites at `*.<ip-with-dashes>.sslip.io`, plain
HTTP; add domains and HTTPS later in **Settings → Domains**, §3.7):

```sh
curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/skiff/main/install.sh | sudo env SKIFF_YES=1 sh
```

Pass `--public-address <ipv4>` when the detected address is wrong (for example behind NAT).

Private repo: add `SKIFF_GITHUB_TOKEN=…`. Pin a ref with `SKIFF_REF=v1.2.3`. Use an existing
checkout with `SKIFF_SOURCE_DIR=/path/to/skiff`.

### 3.3 What the Bun installer does

1. **Preflight** — OS/arch/systemd, then installs missing prerequisites (Caddy, Podman; §3.1),
   then checks Caddy + DNS module, the Caddy admin socket, disk and domains.
   Then a **DNS check** (fresh installs only): it resolves the platform host, the content apex and
   a random `*.<content domain>` name against public resolvers (`dig @1.1.1.1` when installed,
   Bun's resolver otherwise). It shows each name as resolving to this server, resolving elsewhere
   (normal behind a Cloudflare proxy), or not resolving. If records are missing, an interactive
   run offers **re-check / continue anyway / quit**, so you can wait for propagation without
   restarting. `--yes` warns and continues; `--skip-dns-check` skips it. The installer never
   asks for a DNS API token. A `--cloudflare-token-file` (default
   `/etc/caddy/cloudflare.token`) is used for DNS-01 only if that file already exists.
2. **Users/dirs** — `skiff` user (member of `caddy`), `/opt/skiff`, `/var/lib/skiff`,
   `/etc/skiff`, `/run/skiff` (2770 root:caddy).
3. **Secrets** — generates `/etc/skiff/master.key` (0400), `BETTER_AUTH_SECRET`,
   `SKIFF_SITE_COOKIE_SECRET`, `SKIFF_OBJECT_STORE_SECRET`; preserves them on upgrade.
4. **Build** — copies the repo to a new immutable release, runs `bun install --frozen-lockfile`,
   `vite build` (adapter-bun), and `bun build --compile` for the agent and the privileged helper.
5. **Activate** — atomically switches `/opt/skiff/current` to the new release and installs the
   release's helper binary at `/opt/skiff/helper/skiff-helper`.
6. **Telemetry store (optional)** — only when asked for: right after the domain questions the
   installer shows a Yes / No toggle (default **No**), or pass `--clickhouse` / `--no-clickhouse`
   (`--yes` means no). When chosen it installs and starts `skiff-clickhouse.service` (§3.6) before
   the control plane, so its `SKIFF_CLICKHOUSE_*` settings are in place when it boots. A failed
   download or start prints a warning and the install carries on. `--upgrade` keeps an installed
   store current and never adds one unless `--clickhouse` is given.
7. **Services** — writes hardened units (control plane, agent, helper), fixes Caddy's admin socket
   mode (`0660`, group `caddy`), adds the `skiff` supplementary group to Caddy so it can read
   release artifacts, starts the helper, then the control plane.
8. **Caddy bootstrap fix** — points the platform vhost at `unix//run/skiff/control.sock`, then the
   agent takes over the whole Caddy config (platform + content routes) via the admin API.
9. **Node enrolment** — creates the edge node (or reuses it), rotates its token, writes
   `/etc/skiff/agent.env`, bumps the desired-state watermark, and starts the agent.
   It also installs `skiff-builder.service` and the `skiff-build` account. The Builder idles until
   you give the node the Builder role (**Nodes → Edit node**). It then claims one git build at a
   time and runs it with `systemd-run` as `skiff-build`: 2 GB, 200% CPU, 10 minutes, writable
   checkout only, no access to Skiff state or the node token (D47). Workers get the same unit from
   the WireGuard guide. Builds use the toolchains on the node (Skiff's Bun is on `PATH`; install
   Node or anything else the build command needs). For private repositories set `SKIFF_GIT_TOKEN`
   in `/etc/skiff/agent.env`. It is sent only to the hosts in `SKIFF_GIT_TOKEN_HOSTS`
   (comma-separated, default `github.com`), as a header in the clone's environment, never in the
   remote URL, so the build can't read it from `.git/config`. This needs git 2.31 or later. `.git`
   directories and the build's scratch `HOME` are never included in the artifact.
10. **Health** — waits for the public platform URL, then, while no owner exists, prints the
   one-time setup link (`https://<platform>/setup?token=…`, §3.5). `--admin-email` only prefills
   the wizard's email field.

The installer is idempotent; re-running builds a new release and rolls back the symlink if the
health check fails. `--dry-run` prints the plan, `--uninstall [--purge]` removes services/data.

### 3.4 Verify

```sh
systemctl status caddy skiff-control-plane skiff-agent --no-pager
curl -sS https://control.example.com/api/setup/status
curl -sS -o /dev/null -w '%{http_code}\n' https://anything.example.com/
ls -l /run/skiff /var/lib/caddy/admin.sock   # sockets 0660, group caddy
```

Then open the setup link (§3.5) to create the owner. Create an API key in **Settings → API keys**
for `skif`.

The installer also puts `skif` and `skiff` in `/usr/local/bin`. They run the CLI bundled with the
active release (`/opt/skiff/current/cli/skif.js`) on Skiff's own Bun, so the host needs no Node.js
and the CLI upgrades and rolls back with the platform. Sign in with `skif login --url
https://control.example.com`. On other machines install it from npm (`npm i -g @skiffy/skiff`).

### 3.5 First-run setup

A fresh install has no users, and nothing can create one except the setup wizard (D102). Password,
magic-link, GitHub and passkey sign-up are refused until it has run, so whoever finds the URL first
cannot claim the instance.

1. Open the link the installer printed: `https://<platform>/setup?token=…`. Lost it? Run
   `sudo cat /etc/skiff/setup-token` (paste it into `/setup`) or
   `journalctl -u skiff-control-plane | grep setup`. The control plane logs the full link on every
   boot until an owner exists.
2. **Check** lists what the install looks like: HTTPS, whether this browser can make a passkey
   here, email (SMTP or server log), storage and enrolled nodes. Warnings don't block setup.
3. **Account**: your name, email, a password (12+ characters, D103) and the organisation name.
   This creates the owner (platform admin and organisation owner) in one transaction and signs you
   in.
4. **Secure**: owners need a second factor on top of the password. Add a passkey, or an
   authenticator app when passkeys can't work (plain HTTP, an IP address instead of the platform
   host, or an unsupported browser). Adding the app asks for the password again.
5. **Finish**: optionally add an authenticator app as a backup to the passkey (it also issues
   backup codes), then follow the links to email, backups, members and API keys.

Setup must run on the platform origin (`SKIFF_PLATFORM_ORIGIN`): sign-in cookies, CSRF checks and
passkeys are bound to it. Opening `/setup` on another host (for example the server's IP) shows a
link to the right address. Once an owner exists the token is dead: `/setup` sends visitors to
`/login`.

**Signing in later.** Use your email and password, then your passkey or authenticator code (the
login page asks for the code straight after the password when an app is set up). A passkey alone
also works on HTTPS. "Forgot your password" sends a magic link; with no SMTP configured it is
written to the control-plane log (`journalctl -u skiff-control-plane | grep magic-link`). Anyone
can add or change a password under **Settings → Account**; changing it signs out every other
device. There is no public password sign-up: invitees accept with a magic link (or GitHub), then
set a password.

**Recovering an install whose owner can't sign in** (lost passkey, authenticator and backup codes):
add another owner straight to the database with `create-user`, then sign in as them with that
email and password and enrol a new factor. On installer-built releases the script is in the release's source copy:

```sh
cd /opt/skiff/current/repo/apps/control-plane
sudo -u skiff env SKIFF_DATA_DIR=/var/lib/skiff/data /opt/skiff/runtime/bin/bun scripts/create-user.ts \
  you@example.com "Your Name" --org <org-slug> --role owner --platform-admin
```

The script prompts for the password (12+ characters).

### 3.6 Telemetry store (ClickHouse, optional)

Traffic, database and storage telemetry (48 h of 1-minute rollups, 90 d of 1-hour rollups) lives
in a small ClickHouse server on the control-plane host. Daily Parquet partitions still go to R2
(§6).

**It is optional and off by default (D101)**, because it is the heaviest piece of a Skiff host
(~240 MB download, ~750 MB on disk, 300–800 MB of RAM). Without it everything else works; traffic
charts, the database/storage stats tabs and Dashboards say the store is not installed. Ways to
add or remove it:

- **Settings → Telemetry** (platform owner): *Install ClickHouse*, *Remove* (keeps the data for a
  reinstall) or *Remove and delete data*. The control plane drops a request for the root helper
  (§4.3, action `telemetry`), which installs or removes it and restarts the control plane.
- **CLI on the server:** `sudo skiff-platform-config telemetry on`, `… telemetry off`, or
  `… telemetry off --purge`.
- **Installer:** the Yes / No prompt after the domain questions, or `--clickhouse` (§3.3).

`skiff-update-self` only maintains an installed store (version bumps, config); it never installs
one. If an installed ClickHouse is down, the dashboard says so and nothing else is affected: the
control-plane units `Wants=` it but do not require it.

| | |
|---|---|
| Unit | `skiff-clickhouse.service`, user `skiff-clickhouse` (system user, no login, no home) |
| Version | ClickHouse 26.8.34.13 LTS, the official static build, pinned with its sha512 in `scripts/systemd/clickhouse.ts` |
| Listens | HTTP on `127.0.0.1:18123` only. No native TCP (`9000` belongs to object storage), MySQL, PostgreSQL, interserver or gRPC ports |
| Files | binary `/opt/skiff/clickhouse/<version>/clickhouse`, config `/etc/skiff/clickhouse/config.xml` + `users.xml`, data `/var/lib/skiff/clickhouse` |
| Logs | stderr at `warning` level, so `journalctl -u skiff-clickhouse`. System log tables (`query_log`, `part_log`, `trace_log`, `metric_log`, `text_log`, …) are disabled |
| Memory | `max_server_memory_usage` 768 MiB under the unit's `MemoryMax=1G`; writer queries 512 MiB, reader queries 256 MiB; mark cache 64 MiB, no uncompressed cache |
| CPU | 2 threads per query, 20 concurrent queries, 2 merge threads; `CPUWeight=50`/`IOWeight=50` so workloads win under contention |
| Disk | The binary is about 750 MB. An upgrade needs about 1.3 GB free under `/opt/skiff` while it downloads (218 MB archive) and extracts |

**Users** (`users.xml`; there is no `default` user, and both users can only connect from
`127.0.0.1`/`::1`):

- `skiff` (writer): all privileges on database `skiff`, `SELECT` on `system.parts`, `disks`,
  `merges`, `mutations`, `metrics` and `asynchronous_metrics`, temporary tables, and nothing else.
  It cannot manage users.
- `skiff_reader` (dashboard SQL): `SELECT` on `skiff.*` only, profile `readonly` with
  `readonly=2`. It can set per-query output settings (for example
  `output_format_json_quote_64bit_integers`), but profile constraints cap
  `max_execution_time` 30 s, `max_memory_usage` 256 MiB, `max_result_rows` 100 000 (results
  past that are cut off, `result_overflow_mode=break`), `max_rows_to_read` 500 M,
  `max_bytes_to_read` 20 GiB and `max_threads` 2. `readonly` cannot be changed. Reads use
  `final=1`, so ReplacingMergeTree tables are deduplicated without writing `FINAL`.

**Install and updates.** The installer runs it as its own step. On existing installs, the
release's `converge` hook (§4.1, *Host convergence*) keeps it current on every update, using the
pin and config of the release being installed (control-plane hosts only: those with
`/etc/skiff/skiff.env`). A rollback never moves it to an older pin. Each run is idempotent. It downloads the
archive only when the pinned binary is missing, verifies the sha512, and checks that the binary
runs. It then rewrites the config and unit only when they changed, restarts only on a change, and
waits up to 60 s for `/ping`. If a new version does not come up, the previous unit is put back.
Older version directories are deleted only once the new one serves. Every failure (no network,
hash mismatch, low disk, server not answering) is a warning: neither the install nor the update
fails because of it.

Because `/etc/skiff` is `0750 root:skiff`, the server never reads it: systemd passes
`config.xml` and `users.xml` in as credentials (`LoadCredential=`), and the server runs with
`--config-file=%d/config.xml`. Edit nothing in `/etc/skiff/clickhouse` by hand; the next run
overwrites it.

```sh
systemctl status skiff-clickhouse --no-pager
journalctl -u skiff-clickhouse -n 100
curl -s 127.0.0.1:18123/ping                      # Ok.

# Query as the reader (the password is in /etc/skiff/skiff.env)
P=$(sudo sed -n 's/^SKIFF_CLICKHOUSE_READER_PASSWORD=//p' /etc/skiff/skiff.env)
curl -s --user "skiff_reader:$P" 'http://127.0.0.1:18123/?query=SELECT+1'

# Disk used per table needs the writer (only it may read system.parts)
W=$(sudo sed -n 's/^SKIFF_CLICKHOUSE_PASSWORD=//p' /etc/skiff/skiff.env)
curl -s --user "skiff:$W" http://127.0.0.1:18123/ \
  --data-binary "SELECT table, formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE database = 'skiff' AND active GROUP BY table"
```

**Reset.** Hot telemetry is not backed up and can be rebuilt from nothing: deleting it loses only
the last 90 days of charts (older data is in the R2 Parquet archive, if R2 is configured). The
control plane recreates its tables on the next start.

```sh
sudo systemctl stop skiff-control-plane skiff-clickhouse
sudo rm -rf /var/lib/skiff/clickhouse
sudo skiff-platform-config telemetry on        # recreates the directory and starts ClickHouse
# or, without updating: sudo install -d -m 0750 -o skiff-clickhouse -g skiff-clickhouse /var/lib/skiff/clickhouse
#   && sudo systemctl start skiff-clickhouse skiff-control-plane
```

**Local development.** `bun run dev:clickhouse` runs the same config against
`apps/control-plane/.data/clickhouse` with the dev passwords `skiff-dev` / `skiff-dev-reader`.
The dev control plane connects to it without any env vars once that directory exists, and runs
without telemetry otherwise, like a default host. It needs `clickhouse`
on `PATH` (`brew install --cask clickhouse`, or `curl https://clickhouse.com/ | sh`).
`--background` detaches (log and pid in that directory), `--stop` stops it and `--reset` deletes
the dev data.

### 3.7 Domains (Settings → Domains)

Domains are optional at install time (D105). Without them:

- the dashboard, API and MCP are at `http://<server-ip>`;
- sites are at `http://<slug>.<ip-with-dashes>.sslip.io`. [sslip.io](https://sslip.io) is a public
  wildcard DNS service that answers `anything.203-0-113-7.sslip.io` with `203.0.113.7`, so no
  records are needed. Some routers block DNS answers with private addresses ("rebinding
  protection"); on a LAN, use your own domain instead;
- everything is plain HTTP. Owners sign in with a password and an authenticator app (passkeys need
  HTTPS). Password-protected sites and share links need HTTPS and do not work yet.

**Settings → Domains** (owner-only, like §4.3) changes the dashboard address, the sites domain and
HTTPS later:

1. Create the records first: an A record for the dashboard host and a wildcard `*.<domain>` A
   record, both pointing at the server. **Check DNS** looks them up on public resolvers.
2. HTTPS needs real domains for both, a Let's Encrypt email, and a Cloudflare API token with
   **Zone → DNS → Edit** on the sites domain (the wildcard certificate is issued over DNS-01).
3. **Apply** refuses a dashboard name that does not resolve (nobody could reach the dashboard
   afterwards), asks for confirmation when it resolves elsewhere (fine behind a proxy), and, when
   the dashboard address changes, requires the owner to have an authenticator app: passkeys are
   bound to the address they were made on and stop working after the move.
4. `skiff-platform-config` rewrites `skiff.env` and the edge agent's `agent.env` together, saves
   the token to `/etc/skiff/cloudflare.token`, restarts the control plane and the agent, and waits
   for the new address to answer through Caddy on this host (90 s, or 4 min with HTTPS while the
   certificate is issued). If it doesn't, both files go back and both services restart on the old
   address (`reverted`).
5. On boot the control plane rewrites stored preview and storage hostnames to the new sites domain
   and bumps desired state, so every node pulls the new routes. Custom domains are unaffected.

After a dashboard move, everyone signs in again at the new address (sessions are per host), passkeys
must be added again, and `skif login --url <new>` / MCP clients need re-authorising. API keys keep
working. The edge agent reaches the control plane on `/run/skiff/control.sock`
(`SKIFF_CONTROL_SOCKET`), so it never depends on the old or new public name while it switches.

**Worker nodes** keep the control URL they joined with. After moving the dashboard, set
`SKIFF_CONTROL_URL=<new origin>` in each worker's `/etc/skiff/agent.env` and run
`sudo systemctl restart skiff-agent`.

**Recovering from a bad change** (for example DNS removed later): on the server,

```sh
sudo skiff-platform-config domains --platform-host <server-ip>             # back to http://<ip> + sslip.io
sudo skiff-platform-config domains --platform-host control.example.com --content-domain example.com \
  --acme-email ops@example.com --cloudflare-token-file /path/to/token      # or straight to HTTPS
```

It runs the same apply-and-verify-or-revert flow as the dashboard.

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

1. Writes a sealed pre-upgrade bundle to `/var/lib/skiff/backups/upgrade-<UTC>-v<version>/`
   (control SQLite, `.env`, `AGENT.env`, master key and platform settings), whenever `skiff.db`
   exists (with or without `--upgrade`). Settings not given as flags are kept from the existing
   `skiff.env`.
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
sudo skiff-update-self                     # automatic: signed release if published, else source
sudo skiff-update-self --source download   # signed release only; never builds on the host
sudo skiff-update-self --source build      # build the configured ref from source only
sudo skiff-update-self check               # running vs latest version; changes nothing
sudo skiff-update-self plan                # preflight without changing anything (disk, target, migrations)
sudo skiff-update-self --dry-run           # show the release and the plan
sudo skiff-update-self status              # current / previous / last switch / recorded failures
sudo skiff-update-self rollback            # back to previous; run again to undo the rollback
sudo skiff-update-self recover             # resolve an interrupted update now (also automatic)
```

Or use **Settings → Updates** in the dashboard (platform owners and admins only).

The goal is an updater that cannot leave the host broken and cannot block its own future: a bad
release, a crash mid-update, a power cut or a bug in the updater itself all end with the last
committed release serving and the next release still installable. The design and the research
behind it are in [`reports/Failsafe self update architecture.md`](../reports/Failsafe%20self%20update%20architecture.md).

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

The same hooks path has a `pre-push` hook that runs a GitGuardian secret scan
(`ggshield secret scan pre-push`) over the commits being pushed and blocks the push if it finds
a secret. Set it up once with `brew install ggshield` (or `pipx install ggshield`) and
`ggshield auth login`. Without ggshield installed the hook warns and lets the push through. To
skip it, use `git push --no-verify` or `SKIFF_NO_SECRET_SCAN=1`. If a finding is a false
positive, `ggshield secret ignore --last-found` records it in `.gitguardian.yaml`.

**Releases are built and signed in CI, never on the host.** Every push to `main` whose `VERSION`
has no release yet runs [`.github/workflows/publish.yml`](../.github/workflows/publish.yml):
tests, one build per architecture (native amd64 and arm64 runners), the stage-0 updater compiled
with `bun build --compile`, Caddy built with `caddy-dns/cloudflare`, and the release's own canary
hook run as the `skiff` user under the production systemd sandbox
([`scripts/release/ci-canary.sh`](../scripts/release/ci-canary.sh)).
Only then is `manifest.json` written and signed with Ed25519
([`scripts/release/manifest.ts`](../scripts/release/manifest.ts); the workflow refuses to
publish a signature the updater would not accept) and the GitHub release `v<VERSION>` created
with `skiff-<version>-linux-<arch>.tar.gz`, `manifest.json`, `manifest.json.sig` and
`skiff-recover.sh`. The signing key is the `SKIFF_RELEASE_SIGNING_KEY` repository secret; its
public half is compiled into the updater ([`signing.ts`](../scripts/update-self/signing.ts)),
and extra trusted keys can be dropped into `/etc/skiff/updater/keys/*.pub` for rotation.

The updater installs the newest non-draft, non-prerelease `v<semver>` release whose manifest
verifies, after checking the artifact's size and sha256 against it. Network, signature and
checksum problems never mark a release bad; they are retried.

**Choose how to install.** The dashboard (Settings → Updates) and the CLI expose the same choice,
so a host can avoid running prebuilt binaries if that matters to it:

| Method | CLI | What it trusts | Trade-off |
|---|---|---|---|
| Automatic (default) | `--source auto` | The signed release when one exists, otherwise the source ref | No choice needed; follows the published channel |
| Download signed release | `--source download` (alias `artifact`) | The Ed25519-signed manifest, the artifact's SHA-256 and the release key compiled into the updater | Fast; nothing is compiled on the host. Needs a published release. |
| Build from source | `--source build` (alias `source`, or `--ref <ref>`) | GitHub and the exact commit/ref it checks out; no CI binary is executed | Slower and needs disk/CPU; useful when you do not want to trust a prebuilt artifact |

`SKIFF_UPDATE_SOURCE` sets the CLI default. The dashboard writes the choice to an allowlisted
sidecar next to the update request (`request.mode`); the root updater consumes and deletes it,
with `--source` taking precedence. A request from an older control plane has no sidecar and
falls back to `auto`, which is also why the *first* update after this change still uses the
installed updater's old default: the new choice applies from the following run and from the
first CLI invocation. With `--source download`, a missing signed release is an error rather
than a silent fallback to a source build.

**Caddy is part of the release.** CI builds the pinned Caddy (`CADDY_VERSION` in
[`publish.yml`](../.github/workflows/publish.yml)) with `caddy-dns/cloudflare` and puts it at
`caddy/caddy` in the release tarball. At commit the updater validates it (`caddy version` and
`caddy list-modules`), installs it at the binary path the running unit executes, and restarts
that unit. A stock `caddy.service` keeps its config and admin socket; the old binary is saved as
`<path>.skiff-previous` and restored if the restart or the post-update health checks fail. A
host running `skiff-caddy.service` already resolves `/opt/skiff/current/caddy/caddy`, so only
the restart is needed. On the first update to a Caddy-bearing release the updater adds the same
binary to `previous`, so a later rollback stays bootable. The release's Caddy is skipped when
`caddy/caddy` is absent (an older artifact or a source ref that predates it). If the unit executes
a package-managed path such as `/usr/bin/caddy`, the updater replaces that file (keeping
`.skiff-previous`); a distro package upgrade can overwrite it, and the next Skiff update puts the
release build back. Moving the host to `skiff-caddy.service` avoids that. As with the install
method, the updater that *installs* this feature predates it, so Caddy is managed from the
following run onward.

**From the dashboard.** The control plane is unprivileged and sandboxed, so it cannot update or
restart itself. The button drops `/var/lib/skiff/update/request`. A root path unit
(`skiff-update-self.path`) notices it and starts `skiff-update-self.service`, which deletes the
request and runs `skiff-update-self update --trigger dashboard`. The updater treats the request
purely as a trigger: it re-checks GitHub itself and never reads the request file. The chosen
install method is the one exception, carried in the allowlisted `request.mode` sidecar described
above. Progress goes to
`/var/lib/skiff-update/status.json` (`root:skiff 0640`), which the page polls, and the same run
appends a JSON Lines log to `/var/lib/skiff-update/update.log` (`root:skiff 0640`). The page
tails it into **Live log**. Every request is recorded in the audit log as `platform.update`.
Logs: the page, `/var/lib/skiff-update/update.log`, and `journalctl -u skiff-update-self`.

**The update, step by step** (source: [`scripts/update-self/`](../scripts/update-self)):

1. **Stage beside the running release.** The signed artifact is downloaded, verified and
   unpacked into `/opt/skiff/releases/<UTC>-<sha12>` (or built there from source). Nothing that
   serves is touched; a failed stage leaves no trace.
2. **Canary, judged by the release itself.** Stage-0 hands the new release an empty scratch
   directory and runs *that release's* hook,
   [`scripts/release/hooks.ts canary`](../scripts/release/hooks.ts), with its own Bun. The hook
   lays out the data dir (directories first, then ownership), takes a `VACUUM INTO` copy of the
   live database, and boots the release as a transient unit with the production user and
   sandbox, its own socket and no outbound side effects (SMTP, alerts, R2 and backups stripped;
   `SKIFF_STANDBY=1`). It must pass `/api/setup/status`, `/login` and `/readyz`, stay up 3 s
   more, and report a verdict whose reason is the failing `/readyz` check or the crash line from
   its journal. Because the data-layout knowledge ships *in the release*, a bug in it can only
   fail the release that contains it; the next release brings its own fixed copy. (This is the
   lesson of 2026-11-05, when a bug in the installed updater's canary rejected every new
   release.) Releases from before hooks existed use stage-0's bundled copy of the same canary.
3. **Cut over with zero downtime.** The incoming release starts as
   `skiff-control-plane-standby.service` on `/run/skiff/control-standby.sock` while the primary
   keeps serving. Once it is healthy on its own socket, `/run/skiff/control.sock` (a symlink
   that Caddy, the agent, the CLI and every script use) is renamed to point at it: one atomic
   rename, new connections follow, open ones finish on the old process.
4. **Bake.** The new release serves real traffic for 60 s (`--bake <seconds>`), probed every
   second through `control.sock`. If it stops, crash-restarts or stops answering, `control.sock`
   is pointed back at the untouched primary and the standby stops: a code-only revert, no
   restart, no database restore, no lost writes.
5. **Commit.** `previous` → old release, `current` → new release, then the primary restarts on
   it while the standby keeps serving (`control.sock` is re-pointed at the standby between stop
   and start, so even a primary that unlinks the path on shutdown drops nothing). When the
   primary answers, `control.sock` points back at it, the standby drains and stops, the helper
   restarts, and the live checks of the old design run once more (health, `/readyz`, 10 s
   without crash-restarts, the public URL if it answered before).
6. **Keep or revert.** On success, releases other than `current` and `previous` are pruned, as
   are superseded snapshots, and the release's own stage-0 updater is qualified (below).

**Host convergence: the release installs everything outside itself.** A release directory only
holds code. The units, the helper binary, host commands, workerd and the telemetry store live
outside it, and the release that changes them must be the one that installs them. Stage-0 is the
*previous* release's updater, so it cannot render them: its templates are one release behind.
Each release therefore ships two more hooks in
[`scripts/release/hooks.ts`](../scripts/release/hooks.ts)
([`converge.ts`](../scripts/release/converge.ts)), run with the release's own Bun:

- `prepare`, after staging and before the canary: additive `skiff.env` defaults the release needs
  to boot (today the Web Push key pair). The running release keeps serving with them.
- `converge`, after `current` moves and before the primary, helper and agent restart on the new
  release: the control-plane, standby and guard units, the dashboard update and platform-config
  triggers, `/usr/local/sbin/skiff-update-self`, the studio unit, the helper binary, unit and env,
  and, on hosts with an agent, `skiff-agent.service`, the builder and storage units, the
  `skiff-builder`/`skiff-storage` links and the pinned workerd. Then the `skif`/`skiff` and
  `skiff-restore`/`-drill`/`-alert`/`-recovery-kit` commands, the backup units (refreshed only
  where the installer added them; Litestream restarts if its unit changed) and an installed
  ClickHouse. Each step is idempotent and only writes what differs.

Every update run also converges the release that is serving before it looks for a newer one, so
drift is repaired and an up-to-date host still picks up a missed change. A rollback or revert runs
the *target* release's `converge` with `--mode rollback`, which puts its own units back but never
moves ClickHouse to an older pin. A failed step is a warning in the log and never fails the
update. Stage-0's built-in helper install is the fallback when the hook fails or the release
predates it (its `protocol` hook does not list `converge`). Those releases also get stage-0's ClickHouse upkeep. The
first update to a release with the hook is driven by an older stage-0 that knows nothing about
it, so that release's host side converges on the next `skiff-update-self` run or **Update** click,
even one that finds nothing newer. To converge by hand:

```sh
sudo /opt/skiff/current/runtime/bun /opt/skiff/current/repo/scripts/release/hooks.ts converge \
  --release "$(readlink -f /opt/skiff/current)"
```

**Releases with migrations are fenced.** Two releases may share the SQLite file only if the old
one understands the schema. When the new release ships migrations the database has not applied,
the old release is stopped first (a few seconds of downtime, as before), a sealed upgrade bundle
is written to `/var/lib/skiff/backups/upgrade-<UTC>-v<version>/`, and only then does the new
release start and migrate. Any failure before commit restores that bundle's database (Litestream
is paused so it starts a clean generation) and restarts the old release. Code-only releases
always get the zero-downtime path. `--no-zero-downtime` forces the old stop/swap/start behaviour.

Exactly one process owns background work. The standby (and the canary) run with
`SKIFF_STANDBY=1`, which skips the maintenance loop and the resumption of interrupted mass
operations; the primary keeps them throughout.

**Failures are attributed, not just recorded.** A release is marked bad only when its own hook
returns a well-formed failing verdict, or it fails while serving (standby health or bake). It is
then skipped until `--force`, and only by the same updater build: a verdict is stamped with the
updater identity (`skiff-update-self --version`), so installing a fixed updater automatically
retries releases an older one blamed. A hook that crashes, times out or gives no verdict, an
interrupted update and a release that served fine on the standby but not on the primary are
`inconclusive` and always retried. If two *different* releases fail at the same step for the same
reason, neither is blamed (`suspect`) and the log says the updater or host is the likely cause.
`status` lists every verdict with its cause.

**Stage-0 updater.** `/usr/local/sbin/skiff-update-self` runs
`/usr/local/lib/skiff-updater/current/skiff-updated`, a self-contained compiled binary that does
not use any release's Bun or `node_modules`. If it is missing or does not answer `--version`,
the wrapper falls back to the TypeScript updater in `current`, then `previous`
(`SKIFF_UPDATER=source` forces that). Each release carries its own `updater/skiff-updated`.
After the release commits, never in the same transaction, that binary is installed side by side,
must pass `skiff-updated self-test` (state readable, release keys trusted, the active release's
hooks callable), and only then becomes `current`; a candidate that fails is discarded.

**Crashes, reboots and power cuts.** `skiff-update-guard.service` runs at boot before the control
plane and Litestream. If an update was in flight and not committed, it restores the committed
pointers (and, for a fenced update, the pre-update database), removes the standby link and
records the attempt as `inconclusive`. It touches only files, so it can never wait on the units it
precedes. The standby unit is never enabled, so a reboot always comes up on `current`, and the
primary's pre-start creates `control.sock` → `control-primary.sock`. Without a reboot, the next
`skiff-update-self` invocation finishes or reverts the interrupted switch. The updater's own unit
ignores SIGINT/SIGTERM/SIGHUP while a switch is in flight.

**When nothing else works: `skiff-recover`.** A break-glass script published with every
platform release, independent of the updater. It never touches the database. The full procedure
is in [§4.1.1](#411-recovering-a-stuck-or-failed-update).

**Rollback and the database.** Every switch records the database exactly as the outgoing
release left it. `rollback` takes a fresh snapshot, then swaps `current` and `previous`:

- no flag: allowed only when the previous release knows every applied migration;
- `--restore-db`: also restore the snapshot from the switch (writes since then are lost, but
  the pre-rollback snapshot makes this undoable: `rollback --restore-db` again goes forward);
- `--keep-db`: run the old code against the newer schema (fine for purely additive migrations).

Exit codes: `0` updated or nothing to do, `1` nothing changed or rolled back (old release
serving), `2` the old release did not come back healthy (look at
`journalctl -u skiff-control-plane` now). Units and host commands come from the same templates
as the installer ([`scripts/systemd/`](../scripts/systemd), [`scripts/install/commands.ts`](../scripts/install/commands.ts)),
written by the release's `converge` hook (*Host convergence* above), so `install.sh --upgrade` is
only needed for what the installer alone does: OS packages, users, Caddy's admin-socket drop-in
and turning backups on. Private repositories need `SKIFF_GITHUB_TOKEN`
or `/etc/skiff/github.token` (`0600`).

### 4.1.1 Recovering a stuck or failed update

The updater is designed to fail back to a serving release, so most incidents need nothing but
a look at what it recorded. Start there, never by moving symlinks:

```sh
sudo skiff-update-self status              # current/previous, in-flight switch, recorded verdicts
sudo skiff-update-self check               # running vs newest release; changes nothing
sudo skiff-update-self version             # which updater build is judging releases
sudo journalctl -u skiff-update-self -n 200 --no-pager
sudo tail -n 50 /var/lib/skiff-update/update.log   # JSON Lines: phases, commands, build output
cat /var/lib/skiff-update/status.json              # exactly what the dashboard is showing
```

| What you see | What it means | What to do |
|---|---|---|
| Dashboard stuck on **Test boot** (`phase: "canary"`) with no new log output | The updater process died or was killed mid-canary; `status.json` still holds the last phase it wrote. The running release is untouched and serving. | `sudo systemctl stop skiff-update-self`, then `sudo skiff-update-self recover`, then update again. |
| `status` prints `interrupted update` | A switch started and did not commit (crash, reboot, power cut). | `sudo skiff-update-self recover`. The boot guard also does this automatically, filesystem-only, before the control plane starts. |
| The release is listed under `failed` | Its own canary returned a failing verdict, or it failed while serving. This updater build skips it until `--force`. | Fix the release, or `sudo skiff-update-self update --force` to retry it. `skiff-recover clear-verdicts` forgets *all* verdicts, not just one. |
| The new release never took traffic and the old one is still serving | The updater reverted automatically (canary, standby or bake). | Read the reason in `status` and the journal. Nothing else is required; the next release is still installable. |
| Exit code `2`, neither release healthy | Recovery itself failed. This is the only case that needs a human immediately. | `journalctl -u skiff-control-plane -n 200`, then `skiff-recover status` and `skiff-recover use previous` (below). |
| `skiff-update-self` missing, segfaulting or answering `--version` with garbage | Stage-0 is broken. The wrapper should already fall back to the TypeScript updater in `current`. | `skiff-recover install-updater`, or `skiff-recover source-updater update`. |

**The one-time `--no-canary` bootstrap (installs older than 0.6.7).** The 0.6.1-era installed
updater ran its canary from the host, and that canary laid out `data/objects` as root *after*
the chown, so every candidate failed `/readyz` with `objects not writable` and was recorded as
bad. Releases from 0.6.7 onward ship the canary inside the release itself, so this failure mode
cannot recur; but the old installed updater must be replaced first. Do that with exactly one run
that skips the host canary:

```sh
sudo skiff-update-self plan --no-canary     # confirm the target release and preflight
sudo skiff-update-self update --no-canary   # one time only
```

`--no-canary` skips only the isolated test boot. The preflight, sealed database snapshot,
stop/swap, live health check and automatic rollback still run, so this is the old stop-and-swap
path with a few seconds of downtime. Add `--force` only if `plan`/`status` says the target
commit is already listed under `failed`. Do not use the dashboard's **Update** button for this
run: it invokes the updater with no flags and will hang on the same canary. Once the run
completes, the new release's own updater is in `current`, and later updates need no flags and
are zero-downtime.

**Interrupted switches.** `skiff-update-guard.service` runs at boot, before the control plane and
Litestream, and restores the committed pointers if an update was in flight (for a fenced update
it also restores the pre-update database) and records the attempt as `inconclusive`. It only
touches files, so it can never wait on the units it precedes. The standby unit is never enabled,
so a reboot always comes up on `current`. Without a reboot, the next `skiff-update-self`
invocation finishes or reverts the switch. A switch in progress ignores SIGINT, SIGTERM and
SIGHUP; do not kill it deliberately. A SIGKILL during the canary or bake phase leaves the last
committed release serving, because nothing was committed yet, but run `skiff-update-self
recover` afterwards to clear the in-flight marker.

**Rollback is the first remedy, and it is reversible.** `sudo skiff-update-self rollback` swaps
`current`/`previous`; run it again to undo. Without a flag it refuses when the previous release
does not understand the applied schema. `--restore-db` also restores the database to the moment
the current release was activated (writes since then are lost, but the pre-rollback snapshot
makes a second `rollback --restore-db` go forward again); `--keep-db` runs old code against the
newer schema. Real data recovery is separate: `/opt/skiff/current/repo/scripts/restore.sh` and
[§5](#5-restore).

**`skiff-recover` reference.** Download it from a platform release and run it as root:

```sh
curl -fsSL https://github.com/KieranHolroyd/skiff/releases/latest/download/skiff-recover.sh \
  | sudo sh -s -- status
```

`/releases/latest` is GitHub's newest release, which can be a CLI release (`cli-v*`) rather than
a platform release; when that happens this URL returns **404** even though the asset exists on
the platform tag. Pin the platform tag instead:

```sh
curl -fsSL https://github.com/KieranHolroyd/skiff/releases/download/v<VERSION>/skiff-recover.sh \
  | sudo sh -s -- status
```

Replace `<VERSION>` with the running version (`cat /opt/skiff/current/repo/VERSION`) or the
newest platform release from `gh release list --repo KieranHolroyd/skiff`. The same file is
attached to every platform release and can be downloaded from the release page.

| Command | Effect |
|---|---|
| `status` | Read-only: `current`/`previous`/`standby` targets, where `control.sock` points, the stage-0 updater, releases on disk, interrupted-update marker, unit states. Run this first. |
| `use <release\|previous>` | Points `current` at a complete release already on disk (sets `previous` to the outgoing one), removes the standby link and any `inProgress` marker, then restarts the control plane. Refuses an incomplete release. |
| `clear-verdicts` | Wipes `failedCommits` in `/opt/skiff/update-state.json`, so previously rejected releases are retried. Prefer `update --force` for one release; use this only when the updater itself was at fault. |
| `install-updater [vX.Y.Z]` | Downloads a platform release's `manifest.json`/`.sig`, verifies them against the running release's trusted keys, checks the artifact's sha256, runs `self-test`, and installs that binary as stage-0. Defaults to the newest signed release. |
| `source-updater ARGS...` | Runs the TypeScript updater from `current` with `ARGS`, bypassing stage-0 (for example `source-updater update --no-canary`). |

It never touches the database. `install-updater` fails loudly if the active release has no
signing keys or the manifest does not verify; it will not install an unsigned or unverified
updater.

**Last resort: repointing by hand.** Prefer `skiff-recover use`. If the script cannot run, a
release is a directory under `/opt/skiff/releases/<UTC>-<sha12>`; `current` and `previous` are
symlinks to it, and `control.sock` is a symlink to `control-primary.sock` or
`control-standby.sock`. Repoint `current` atomically (write a temporary symlink, then
`mv -Tf`), stop the standby unit, restart `skiff-control-plane`, and check `/readyz`. Never edit
`update-state.json` while an update is in flight; run `skiff-update-self recover` first.

**Recording the incident.** `update.log` (JSON Lines) and `status.json` are the primary record;
the updater's identity (`skiff-update-self version`) matters because verdicts are stamped with
it, so a fixed updater retries releases an older one blamed. The dashboard's **Settings →
Updates** page shows the same status and live log, and each request is in the audit log as
`platform.update`.

### 4.1.2 Updating worker nodes

The control plane's own host (and its agent) updates with `skiff-update-self` (§4.1). Every
other node updates from the dashboard (D99):

1. **Nodes**: a node whose agent is older than the control plane shows **`<version>` available**
   on its card. Choose **Update node** (on the card or in the `…` menu) and confirm.
2. On its next desired-state pull the agent asks `skiff-helper` to install that version. The
   helper downloads the signed `manifest.json` for `v<version>` from GitHub, verifies the
   signature with the release keys built into it, downloads
   `skiff-node-<version>-linux-<arch>.tar.gz`, checks its size and sha256, and replaces
   `/opt/skiff/current/agent/skiff-agent` and `/opt/skiff/helper/skiff-helper`. It then restarts
   `skiff-agent` and `skiff-helper`, plus `skiff-builder` and `skiff-studio` if they are running.
3. The card shows **updating to `<version>`** until the agent's heartbeat reports the new version,
   usually within a minute or two. A failure (no signed release, a bad checksum, no outbound
   HTTPS to GitHub, no helper) shows its reason on the card; **Retry update** tries again.

Requirements on the node: `skiff-helper` running as root, outbound HTTPS to `github.com` and
`objects.githubusercontent.com`, and an agent new enough to update itself. The helper refuses a
downgrade and refuses a control-plane host (`/opt/skiff/current` is a release symlink there).
Sites and workloads keep running; the node shows offline only while its agent restarts.

A node update replaces only the two binaries. Unlike a control-plane update (§4.1, *Host
convergence*), it does not rewrite the worker's systemd units (agent, builder, storage, studio,
helper) or install a new workerd pin. A release that changes those needs the worker's setup
re-run by hand until the helper learns to converge.

**Rolling back a node by hand.** The previous binaries are kept next to the new ones:

```sh
sudo install -m 0755 /opt/skiff/current/agent/skiff-agent.previous /opt/skiff/current/agent/skiff-agent
sudo install -m 0755 /opt/skiff/helper/skiff-helper.previous /opt/skiff/helper/skiff-helper
sudo systemctl restart skiff-helper skiff-agent
```

**First update of an older agent.** An agent from before dashboard updates says so on its card
("update it by hand once"). Install the node bundle by hand once; later updates work from the
dashboard. Set `V` to the control plane's version and `ARCH` to the node's (`amd64` or `arm64`):

```sh
sudo bash -euo pipefail <<'SCRIPT'
V=0.0.0 ARCH=amd64 REPO=KieranHolroyd/skiff
cd "$(mktemp -d)"
curl -fsSLO "https://github.com/$REPO/releases/download/v$V/manifest.json"
curl -fsSLO "https://github.com/$REPO/releases/download/v$V/skiff-node-$V-linux-$ARCH.tar.gz"
grep -q "$(sha256sum "skiff-node-$V-linux-$ARCH.tar.gz" | cut -d' ' -f1)" manifest.json \
  || { echo "checksum does not match manifest.json" >&2; exit 1; }
tar -xzf "skiff-node-$V-linux-$ARCH.tar.gz"
install -m 0755 skiff-agent /opt/skiff/current/agent/skiff-agent
install -m 0755 skiff-helper /opt/skiff/helper/skiff-helper
systemctl restart skiff-helper skiff-agent
SCRIPT
```

This checks the bundle against `manifest.json` only; the dashboard path also verifies the
manifest's signature. Workers joined with `scripts/dev/join-linux-worker.sh` can instead rebuild
from `/opt/skiff/src`. Run neither on the control-plane host: use `skiff-update-self` there.

### 4.2 Uninstall

```sh
sudo skiff-uninstall                 # remove binaries/units; keep data + config
sudo skiff-uninstall --purge --yes   # remove local state too (R2 is never touched)
```

The default keeps `/var/lib/skiff`, `/etc/skiff` and `/etc/caddy/Caddyfile` so a
reinstall can reuse the database and master key. `skiff-clickhouse.service` is stopped and
removed; its data (`/var/lib/skiff/clickhouse`) and binary (`/opt/skiff/clickhouse`) stay unless
you purge. `--purge` also removes the system users.
Backups and releases in R2 survive both modes by design.

**Retiring a worker node.** Move or delete what it hosts (projects placed on it, app workloads,
databases, storage instances, app volumes). Apps move from the project's **Details → Move**, and
databases and storage instances from **Settings/Resources → Move**, which takes their attached
apps along (D97). Storage moves empty (objects are not copied), and app volumes cannot move yet.
Then use **Nodes → ⋯ → Remove node** (or
`DELETE /api/v1/nodes/:id`). The token is revoked immediately, volume registrations go, and any
build it had claimed is requeued for another Builder. The edge node cannot be removed. Removal
does not touch the machine: run `sudo skiff-uninstall` there (or `docker compose down -v` for the
container node), otherwise the agent keeps serving its last config and logs `Unknown node token`.

**Changing the edge node.** **Nodes → ⋯ → Make this the edge** (or `POST /api/v1/nodes/:id/edge`)
hands the role to another online node (D98); the old edge becomes a worker and keeps its apps and
databases (give it a public address first if it hosts any). Skiff only swaps the roles. If the new
edge is a different machine: point DNS for the platform and content domains at it, give its
`agent.env` the edge settings (`SKIFF_TLS`, ACME/Cloudflare, `SKIFF_PLATFORM_HOST` and an upstream
that reaches the control plane), restart its agent, and only then retire the old edge.

### 4.2.1 Moving node storage to another disk

**Nodes → Edit node → Storage** sets where a node keeps its release cache and agent state (what
Caddy serves sites from) and its build scratch. Leave a field blank for the default
(`/var/lib/skiff/agent`, `/var/lib/skiff-builder`). The change reaches the agent in desired state,
and the agent asks `skiff-storage.path` to apply it. The root `skiff-storage.service` re-reads the
paths from the control plane, checks them, and then:

1. waits if a build is running (the node card says so; it retries every minute);
2. for the data directory: stops the agent (and with it the Builder), runs `cp -a` into the new
   directory, re-points `sites/` links, sets `SKIFF_DATA_DIR` in `/etc/skiff/agent.env`, adds
   `ReadWritePaths=` in `skiff-agent.service.d/skiff-storage.conf`, and starts the agent. Caddy
   keeps serving the old copy until the agent re-applies its config; the old copy is deleted about
   20 s after the agent is back. If the agent does not stay up, everything is put back;
3. for the build directory: writes `skiff-builder.service.d/skiff-storage.conf` and restarts an
   idle Builder. Nothing is copied.

Prepare the target first: mount the disk (add it to `/etc/fstab` so it survives a reboot), and make
sure every parent directory can be traversed by the `skiff` user. The target must be empty or new.
Paths under `/etc`, `/usr`, `/home`, `/tmp`, `/run`, `/opt/skiff`, the control-plane data and bare
mount roots such as `/mnt` are refused. Use `/mnt/data/skiff` rather than `/mnt/data`.

The result is in `/etc/skiff/storage.json` and on the node card; details are in
`journalctl -u skiff-storage`. The control plane's own data (`/var/lib/skiff/data`, database,
objects and backups) is not moved by this; stop the services and relocate it by hand.

### 4.2.2 Migration safety and rollback protocol

Migrations are **forward-only and append-only**. The schema is the only state that a code
rollback cannot undo, so these rules are enforced before merge and repeated here for operators.

**Rules for a migration**

1. One migration file per feature/Task, named `NNNN_short_description.sql` with the next unused
   four-digit prefix (`0015_...`). The prefix stream must stay sequential with no duplicates or
   gaps.
2. Additive only: `CREATE TABLE`/`CREATE INDEX`, or `ALTER TABLE … ADD COLUMN` (with a safe
   default when the column is `NOT NULL`). Do not `DROP TABLE`, `DROP COLUMN`, rename a column,
   or `ALTER COLUMN … TYPE`. Those need a separate, reviewed encode/backfill/swap migration plan.
3. Never edit, rename or delete a migration that has shipped. Fix a bad migration with a new,
   higher-numbered file. Editing history makes a restored snapshot and a rolled-back release
   disagree about what has run.
4. Do not put secrets, environment-specific values or large data backfills in a migration.
5. A migration that changes data must be idempotent or guarded, because the migrator records
   the file only after it succeeds.

The repository check is:

```sh
bun run check:migrations
# or, in CI: SKIFF_MIGRATION_BASE_REF=<base-sha> bun scripts/check-migrations.ts
```

It fails on a non-sequential/duplicate prefix or on a modified/renamed/deleted existing
migration. It prints `DROP TABLE`, `DROP COLUMN` and `ALTER COLUMN TYPE` for manual review; run
with `--strict` to make those fail. CI runs it as its own step on every PR and push.

A destructive migration that passed review is listed, with its decision, in
`REVIEWED_DESTRUCTIVE_MIGRATIONS` (`scripts/check-migrations.ts`); its statements print as notes
and `--strict` does not fail on them. The only one so far is
`0033_drop_database_console.sql` (D96), which drops the retired DBGate `console_*` columns from
`databases`. A release that has applied it cannot be rolled back with `--keep-db` to a release
that still reads those columns; restore the pre-update snapshot instead.

**Pre-update snapshot**

The installer and self-updater write a sealed bundle before running migrations
(`/var/lib/skiff/backups/upgrade-<UTC>-v<version>/`, §4.2.4). Before a manual migration or a
hand-run restore, take the same three things:

| State | What to keep | Why |
|---|---|---|
| Control DB | `sqlite3 /var/lib/skiff/data/skiff.db ".backup '/var/lib/skiff/backups/pre-migrate-<UTC>.db'"` | The only undo for a bad schema change. |
| Config + keys | `/etc/skiff/skiff.env` (`BETTER_AUTH_SECRET`, `SKIFF_*`) and `/etc/skiff/master.key` (the APP_KEY used to seal org secrets), offline encrypted | A restored DB is unreadable without the same master key; sessions/tokens need the same auth secret. |
| Managed data | R2 object versioning/Litestream, managed database backups, volume snapshots | The control DB does **not** contain user database rows, bucket objects, volumes or release artifacts. |

The app-level backup/restore surfaces (Settings → Backups, `skiff-restore`) cover the control
DB. They do not replace an infrastructure snapshot of managed data, and they never touch R2.

**Rollback a bad migration**

1. Stop `skiff-control-plane` and `skiff-litestream`.
2. If the migration already applied and the new release is healthy enough to serve, prefer a
   **forward fix**: write the next-numbered corrective migration, review it, deploy. This keeps
   history intact and is always the first choice for additive changes.
3. If you must go back, restore the pre-migration control DB snapshot, then start the previous
   release (`skiff-update-self rollback --restore-db`, or the manual symlink + restart in §4).
   Never delete rows from `skiff_migrations` or edit the SQL file to force a re-run.
4. Restore `.env`/`master.key` from the same point in time. A snapshot restored under a different
   master key will not decrypt database credentials, storage keys or other sealed secrets.
5. Managed data is **not** restored automatically. Recover R2 from versioning/Litestream, managed
   databases from their own backups, and volumes from their own snapshots deliberately, after
   checking which writes would be lost. The restore command restores the control DB only;
   nothing in this protocol makes a destructive data restore happen on its own.
6. Record the incident and the snapshot names in the audit/ops log. A schema downgrade without a
   snapshot is not a supported rollback path.

### 4.2.3 Readiness (`/readyz`)

`GET /readyz` is the public health document used by the updater and by load balancers. It never
contains secrets:

```json
{
  "ok": true,
  "status": "ok",
  "version": "1.4.0",
  "schema": { "latest": "0017_scheduler.sql", "expected": "0017_scheduler.sql", "applied": 17, "pending": [] },
  "agent": { "desiredVersion": "1.4.0", "nodes": [{ "id": "nod_…", "name": "edge", "version": "1.4.0" }] },
  "dataDirs": [{ "name": "data", "path": "/var/lib/skiff/data", "exists": true, "writable": true }],
  "disk": { "freeBytes": 18446744073, "requiredBytes": 2097152, "headroom": true },
  "backupTarget": { "kind": "r2", "reachable": true, "checkedAt": "…" },
  "helper": { "version": "1.4.0" }
}
```

It answers **200** while the control plane can serve. It answers **503** when the database or
schema is not usable, a data directory is missing, or migrations the running release ships are
pending; that is the signal the self-updater uses before it keeps a new release. An unreachable
backup target or low disk is reported as `degraded` but does not take a serving platform down
(upgrades are refused instead).

```sh
curl -fsS --unix-socket /run/skiff/control.sock http://localhost/readyz | jq
```

### 4.2.4 Upgrade preflight and sealed snapshots

`UpgradeService.preflight()` (and `sudo skiff-update-self plan`, or **Settings → Updates**) refuses
an upgrade when it cannot be undone:

| Check | Refusal |
|---|---|
| Backup target | unreachable: fix Settings → Backups / `SKIFF_OBJECT_STORE` / `R2_*` first |
| Disk | less than **2×** the control DB size free for the snapshot |
| Data dirs | `data`, `objects` or `backups` missing or not writable |
| Migrations | a destructive `DROP TABLE` / `DROP COLUMN` / `ALTER COLUMN TYPE` without explicit approval, or an applied migration the target does not ship (a downgrade) |
| PostgreSQL | any managed database major-version change; use `skif db upgrade` |
| Release | target older than the running version (`--force` turns this into a warning) |

Before the release switch the updater writes a sealed bundle under
`/var/lib/skiff/backups/upgrade-<UTC>-v<version>/`:

```
manifest.json          # versions, migration ids, sha256 per file, pinned flag
db/control.db          # VACUUM INTO snapshot of the control SQLite
config/skiff.env       # 0600/0400, includes APP_KEY/master key
config/agent.env
config/master.key
config/platform-settings.json
```

The directory is `0700` and every file is `0600` (the master key is `0400`); only root can read it.
`sudo skiff-update-self status` lists the retained bundles and `sudo cp -a` is the download path;
the dashboard shows the count it can inspect. The pre-update bundle is **pinned until the next
successful upgrade**, and the last three successful bundles are retained. A failed update keeps
its bundle for inspection.

Restoring a bundle is always a human decision:

```sh
sudo systemctl stop skiff-control-plane
sudo cp /var/lib/skiff/backups/upgrade-…/db/control.db /var/lib/skiff/data/skiff.db
sudo chown skiff:skiff /var/lib/skiff/data/skiff.db
# Only from the same point in time, and only if the master key changed:
sudo cp /var/lib/skiff/backups/upgrade-…/config/master.key /etc/skiff/master.key
sudo systemctl start skiff-control-plane
```

Managed database rows, buckets, app volumes and release artifacts are **not** in this bundle and
are never restored automatically.

The self-updater runs: `preflight → sealed snapshot → release switch → /readyz + health smoke →
automatic control-plane rollback`. The automatic rollback covers the release symlink, the control
SQLite and the services. It does **not** restore `.env`/APP_KEY or any managed data; those remain
manual so a bad update cannot silently rewind user data. `SKIFF_FEATURE_UPGRADE_ROLLBACK` is
reserved for the dashboard control; the CLI path is the tested default.

### 4.2.5 Postgres major upgrades

Changing `databases.version` across majors (for example 16 → 17) is refused by
`PATCH /api/v1/databases/:name`. The error points at the wizard:

```sh
skif db upgrade main --to 17 --plan     # backup, disk, extensions, pg_upgrade/dump-restore plan
skif db upgrade main --to 17 --apply    # queues a pinned backup + returns the same runbook
```

`--apply` does **not** switch the data directory. It queues a pinned logical backup and records
the plan. Follow the printed steps on the node:

1. stop attached consumers (the plan lists them);
2. wait for the pinned backup to reach `ok`;
3. run `pg_upgrade --check` inside the target image, or `pg_dump --format=custom` and verify a
   restore into a scratch instance of the new major;
4. start the new major against a **new** data directory (or restore the dump) and verify row counts
   and extensions;
5. attach one non-production consumer as a canary before production;
6. keep the old data directory until the canary passes. Re-point the old directory to roll back.

The helper image is the official `postgres:<major>-alpine`; `pg_upgrade` availability varies by
image, so dump/restore is the supported fallback with planned downtime. Never point a new major at
a data directory written by an older major, and never let an image tag change perform the switch.

### 4.3 Platform settings from the dashboard

**Settings → Backups** (R2 credentials, turning Litestream and the monthly restore drill on and off,
running a drill, downloading a database snapshot), **Settings → Notifications** (SMTP for
sign-in links, invites and email alerts, plus the alert webhook and alert email address) and
**Settings → Assistant** (the optional in-dashboard chat's OpenAI-compatible endpoint) change
`/etc/skiff/skiff.env` without SSH. **Settings → Domains** (§3.7) also rewrites the edge agent's
`/etc/skiff/agent.env` and restarts the agent, and verifies the new address before keeping it. **Settings → Telemetry** installs or removes the optional
ClickHouse store (§3.6) the same way; installing takes a few minutes (a ~240 MB download).

These tabs are **owner-only**: you must be a platform admin (§6.2 of DESIGN, the admin-plugin role)
*and* the owner of the org you're signed in to, in your own dashboard session. Org admins, platform
admins who are not owners, API keys and MCP tokens get 403. On a single-user install that is the
bootstrap user.

It works like the update button. The control plane can't write `/etc/skiff`, so:

1. The dashboard validates the form and *tests it for real* before queueing anything: R2 credentials
   must write, read and delete a probe object (`skiff/healthcheck/…`); SMTP must send a test email to
   you; a new webhook must accept a test alert.
2. It writes `/var/lib/skiff/platform-config/request.json` (`0600 skiff`). The audit log records the
   request as `platform.config` / `platform.backups` / `platform.restoreDrill` / `platform.pushKeys` with key names only,
   never values.
3. `skiff-platform-config.path` (root) starts `skiff-platform-config.service`, which runs
   `skiff-platform-config apply-request`. The helper claims the request (no symlinks or FIFOs,
   regular files only, at most 64 KiB, deleted once read) and validates it again with the same rules
   (`packages/contracts/src/platform-config.ts`). Only these keys can ever be written:
   `R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ENDPOINT`,
   `SKIFF_SMTP_HOST/PORT/USER/PASSWORD/FROM/SECURE`, `SKIFF_TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM`,
   `SKIFF_ALERT_WEBHOOK SKIFF_ALERT_EMAIL SKIFF_ALERT_SMS`,
   `SKIFF_ALERT_DISCORD_WEBHOOK SKIFF_ALERT_SLACK_WEBHOOK SKIFF_ALERT_TELEGRAM_BOT_TOKEN/CHAT_ID SKIFF_ALERT_NTFY_URL/TOKEN`, and
   (Settings → Assistant, optional) `SKIFF_ASSISTANT_PROVIDER/BASE_URL/MODEL/API_KEY`. Values are pattern-checked (single line; nothing that could change the meaning of
   `litestream.yml`, which expands `${VAR}` before parsing).
4. It saves the old file as `skiff.env.previous`, writes the new one (`root:skiff 0640`), and
   restarts the control plane. If the control plane is not healthy within 60 s, it restores
   `skiff.env.previous`, restarts again and reports `reverted`.
   A `push-keys` request (Settings → Notifications → **Set up push**, D108) writes nothing but a
   missing `SKIFF_VAPID_PUBLIC_KEY`/`SKIFF_VAPID_PRIVATE_KEY` pair, generated by the helper itself;
   an existing valid pair is never replaced.
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
sudo skiff-platform-config push-keys   # Web Push keys, if this host has none
sudo skiff-platform-config status
journalctl -u skiff-platform-config
```

On a development server (`bun run dev`, no installed release) the same forms work, with the same
owner gate and the same tests before saving, but there is no root helper. Values are saved to
`<SKIFF_DATA_DIR>/platform-settings.json` (`.data/`, gitignored, `0600`). `config.ts` loads that file
over the shell environment at startup, so restart the dev server to apply. Litestream and the
restore drill only run on an installed server.

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
3. Copy the recovery kit to the new host (skip the export prompt at the end of the install).
   - The master key must be the original or existing secrets cannot decrypt.
   - `BETTER_AUTH_SECRET` comes back with the env file if the kit included it; if it is
     regenerated instead, every session and MCP token is invalidated.
4. Install Litestream (`/usr/local/bin/litestream`).
5. Run `skiff-restore --yes --recovery-kit <kit.age>`. It decrypts the kit (asking for the
   passphrase), installs the original `master.key` and, if included, `skiff.env` with the R2
   credentials, then restores the database. Without a kit, put both files in place by hand
   first (`systemctl stop skiff-control-plane`) and run `skiff-restore --yes`.
6. Re-issue certificates: Caddy obtains them automatically via DNS-01 on first start;
   confirm the Cloudflare token is in `/etc/caddy/cloudflare.token`.
7. Re-key WireGuard (control plane + homelab); the homelab dials out and agents reconcile.
8. Run the verification in §5.2 and the checks in §7.

### 5.4 What restore does not do

- It does not restore release artifacts; R2 is canonical and agents cache them.
- It does not restore hot ClickHouse telemetry (by design); cold Parquet remains in R2.
- It does not restore Caddy certificate files; they are re-issued.
- It does not touch R2; backups are never deleted by restore or uninstall.

---

## 6. Backup policy

| Data | Mechanism | Frequency / retention | RPO |
|---|---|---|---|
| SQLite | Litestream → R2 (`skiff-litestream.service`) | WAL sync ~1 s; snapshot every 24 h; 30-day retention | ≤ ~1 s |
| Release artifacts | Canonical in R2 (`SKIFF_R2_ARTIFACT_PREFIX`) | Lifecycle per project; last 10 + pinned in DB | n/a |
| Telemetry | Daily Parquet partitions in R2 (`SKIFF_R2_PARQUET_PREFIX`) | 48 h 1-minute + 90 d 1-hour in ClickHouse (not backed up, §3.6); Parquet long-lived | 24 h |
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

`skiff-recovery-kit` (`scripts/recovery-kit.ts`) writes a standard armored **age** file in
passphrase mode, so stock `age -d` can also open it. The kit holds the master key, its
fingerprint (first 16 hex of its sha256) and, with `--include-env`, `skiff.env`.

```sh
sudo skiff-recovery-kit export --include-env     # /root/skiff-recovery-kit-<host>-<date>.age, 0600
sudo skiff-recovery-kit verify <file>            # decrypts in memory, compares the fingerprint
sudo skiff-recovery-kit import <file> [--restore-env] [--force]
```

- The installer offers an export at the end of a fresh interactive install.
- An empty passphrase generates one and prints it once; typed passphrases need 12+ characters.
  `--passphrase-file` (or `SKIFF_RECOVERY_PASSPHRASE_FILE`) for automation.
- Copy the kit off the server, then delete it there (`shred -u`). Keep the passphrase apart
  from the file. Re-export after every master-key rotation (§11).
- `import` refuses to replace a different master key without `--force` and keeps any replaced
  file as `*.pre-recovery-<UTC>`.

---

## 7. Monitoring and alerts

### 7.1 Signals

- Control plane and agent expose Prometheus `/metrics`; OTLP export is optional.
- `journalctl -u skiff-control-plane|skiff-agent|caddy|skiff-litestream`.
- Workload stdout/stderr is drained to the dashboard's Logs tab (7-day retention, 500k-row ceiling)
  and `skif logs <project>` reads the same ordered events. Raw Caddy access logs stay on the node.
- The drill writes `/var/lib/skiff/drill/status.json` (`ok`, timestamp, reason).
- `systemd-analyze security <unit>` for sandbox drift.
- Litestream: check R2 object age under `skiff/sqlite` (the newest WAL segment
  should be seconds old). A running process with no recent objects is a silent failure.

### 7.2 Default alerts (DESIGN §8)

| Condition | Severity | First response |
|---|---|---|
| Node offline > 2 min | page | Check WireGuard, agent unit, control-plane connectivity. |
| Disk > 85% | warn | Find release cache growth / logs; GC old deployments. |
| Certificate expiring < 14 d (critical < 3 d) | warn | Check Cloudflare token and DNS-01; `caddy reload`. |
| 5xx spike after promote (≥ 20 requests, ≥ 5% 5xx and ≥ 2× the pre-promote rate, within 30 min) | page | Roll back the production pointer; inspect the release. |
| Failed backup or restore drill | page | Run §5.2 / §8.3; do not assume the backup is good. |
| Litestream restart loop | warn | Check R2 credentials/endpoint and bucket permissions. |

Wire email (SES SMTP), a generic webhook (Home Assistant, anything that takes JSON) and/or the chat
channels (Discord, Slack, Telegram, ntfy; Settings → Notifications → Chat & push channels) through the
`Notifier` interface (`packages/core/src/notify.ts`, `notify-chat.ts`). Each chat channel is sent a test
alert before it is saved, and every request times out after 10 s so a dead endpoint cannot stall the
maintenance loop. `skiff-restore-drill.service` and `skiff-litestream.service` ship with
`OnFailure=skiff-alert@%n.service`, which sends the alert through `SKIFF_ALERT_WEBHOOK`, the chat channels and/or
SMTP directly (it works with the control plane down) and includes the drill's
`status.json` reason. Settings → Backups shows the latest drill result and unit states.

Each built-in alert can be turned off, routed to particular channels and given its own threshold
on Alerts → System alerts (thresholds above are the defaults). Beyond these built-in alerts, org owners can define **metric alert rules** over the ClickHouse
telemetry (site down, error rate, latency, database/storage down, traffic stopped) on the Alerts
page; they use the same notifiers and show in one history with the system alerts. See
[ALERTS.md](./ALERTS.md).

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

## 9. Single point of failure (today)

Until the HA work in [CLUSTERING.md](./CLUSTERING.md) ships (D107), a one-VPS install has no
automatic ingress failover, no second control plane, and no replicated SQLite beyond Litestream.

Consequences today:

- **VPS lost** → control plane, Caddy ingress and edge-placed sites are down. Homelab
  nodes keep their cached state but have no public ingress. Recovery is the §5.3 runbook,
  targeting under 15 minutes.
- **Control plane crash** → dashboard/API/MCP down; agents keep serving the last desired
  state and systemd restarts the app.
- **R2 unreachable** → new deploys/uploads fail; existing sites are unaffected.
- **Homelab offline** → homelab-placed projects return a branded 503 after health checks;
  edge-placed projects keep serving.

Keep DNS TTLs low enough that repointing the A/AAAA records to a replacement VPS is
minutes, not hours. Multi-ingress (DNS failover, Cloudflare Load Balancing or Tunnel), a
control-plane standby and database replicas are planned in CLUSTERING.md §6–§9 (ROADMAP,
"Clustering & HA").

---

## 10. systemd sandboxing rationale

| Directive | Why |
|---|---|
| `ProtectSystem=strict` | `/usr`, `/boot`, `/etc`, `/opt` become read-only. The only writable paths are explicit `ReadWritePaths=`; a compromised Bun process cannot persist in `/usr` or edit its own units. |
| `ReadWritePaths=` | Least-privilege allowlist: control plane `/var/lib/skiff` + `/run/skiff`; agent adds `/srv/skiff`; Caddy only its data dir; ClickHouse only `/var/lib/skiff/clickhouse`; drill its scratch dir. |
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
| `MemoryMax=` | Control plane 1 GB (room to buffer a full 500 MiB artifact upload), agent 192 MB, Caddy 256 MB, ClickHouse 1 GB (its own `max_server_memory_usage` stops it at 768 MiB first), Litestream 256 MB, drill 1 GB. Bounds a runaway Bun/ClickHouse/Caddy process on a 4 GB VPS. |
| `TasksMax=`, `LimitNOFILE=` | Prevents fork/descriptor exhaustion. |
| `LoadCredential=master-key:…` | The master key is placed in the service's credential directory (`%d`), not the environment, and is not readable by other services. `/etc/skiff/master.key` stays `0400 root`. ClickHouse gets its `config.xml`/`users.xml` the same way, so `skiff-clickhouse` never needs to traverse `/etc/skiff`. |
| `CapabilityBoundingSet=` (empty) | Control plane, agent, ClickHouse, Litestream and drill have no capabilities (ClickHouse logs that it lacks `CAP_SYS_NICE`/`CAP_IPC_LOCK`/`CAP_NET_ADMIN`; it works without them). Only Caddy keeps `CAP_NET_BIND_SERVICE`. |
| `skiff-builder.service` | Root, because only root can start a transient unit as another user. It keeps only `CAP_CHOWN`/`CAP_DAC_*`/`CAP_FOWNER` (hand a checkout to `skiff-build`, then read and delete it). Each build unit runs as `skiff-build` with `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=` its checkout, `InaccessiblePaths=` for `/etc/skiff`, `/var/lib/skiff`, `/run/skiff`, `/srv/skiff` and `/run/skiff-workloads`, no capabilities, and `TasksMax=1024`. The build gets only `HOME`, `PATH` and `CI`, never the daemon's environment. |
| `ProtectProc=invisible` (control plane, ClickHouse) | Hides other processes. `ProcSubset=pid` is deliberately not set because Bun and ClickHouse read `/proc/cpuinfo` and `/proc/meminfo`; the agent also needs `/proc` for node metrics. |
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
systemd-analyze security skiff-builder.service
systemd-analyze security skiff-clickhouse.service
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
| Telemetry unavailable | `systemctl status skiff-clickhouse`, `curl -s 127.0.0.1:18123/ping`, `journalctl -u skiff-clickhouse -n 100` | Re-run `sudo skiff-platform-config telemetry on` (it repairs and restarts ClickHouse and prints why it could not). Not installed at all is normal: install it from Settings → Telemetry. `Authentication failed` in the control-plane log means `users.xml` and `skiff.env` disagree; the same command regenerates `users.xml`. |
| Restore says "no snapshots" | R2 prefix/lifecycle, credentials | Check `SKIFF_R2_SQLITE_PREFIX`; confirm objects exist; run a drill. |
| Update stuck at **Test boot** / canary | `skiff-update-self status`, `journalctl -u skiff-update-self -n 200` | Stop the unit, `skiff-update-self recover`, retry. Installs older than 0.6.7 need one `update --no-canary` bootstrap: [§4.1.1](#411-recovering-a-stuck-or-failed-update). |
| `skiff-recover.sh` download returns 404 | `gh release list --repo KieranHolroyd/skiff` | `/releases/latest` can resolve to a CLI release; pin the platform tag instead: [§4.1.1](#411-recovering-a-stuck-or-failed-update). |
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
  `litestream.yml` and units, so a `curl | sh` install is self-contained. ClickHouse is not
  in the bundle: the installer/updater downloads the pinned official build from GitHub (§3.6).
- Litestream is installed separately (`/usr/local/bin/litestream`); the installer detects
  it and enables replication only when R2 is configured. It is not compiled by the release
  workflow.
- Bun `1.4.4`, Caddy `2.11.8` and `caddy-dns/cloudflare` `v0.2.4` are pinned in the release
  workflow. Bump them together and re-run the drill.
- The `skif admin keys rotate` command is a product surface described by DESIGN §11.2; this
  delivery defines its contract (credential path) but does not implement it. The setup wizard
  (DESIGN §12) is implemented for the owner account and instance checks (§3.5, D102); domains,
  Cloudflare, R2 and SMTP are still configured by the installer and Settings.
- `BETTER_AUTH_SECRET` can be regenerated on a fresh-VPS restore at the cost of invalidating
  sessions; the master key cannot, so the recovery kit and an encrypted env copy are part of
  the backup policy.
