---
title: Configuration reference
description: Every environment variable the control plane, node agent, privileged helper and builder read, where they live on a host, and how to change them.
---

This page lists every environment variable that a Skiff process reads when it starts, grouped by process, with its default and what it does. Use it when you are setting up a host, changing a value in `/etc/skiff`, or checking what a default is. For the install itself, see [installation](/self-hosting/installation). Many of the same settings can be changed from the dashboard instead; [Dashboard-managed settings](#dashboard-managed-settings) explains which ones, and how that differs from editing the file.

## Where configuration lives on a host

An installed host keeps its configuration in `/etc/skiff`. Each service reads its own environment file through a systemd `EnvironmentFile=` line.

| Path | Read by | Notes |
|---|---|---|
| `/etc/skiff/skiff.env` | `skiff-control-plane.service`, `skiff-agent.service`, `skiff-litestream.service`, `skiff-restore-drill.service` | The platform-wide file. Owned `root:skiff`, mode `0640`. |
| `/etc/skiff/agent.env` | `skiff-agent.service` (optional), `skiff-builder.service` | Node identity (`SKIFF_NODE_ID`, `SKIFF_NODE_TOKEN`) and the edge's Caddy settings. Written when a node joins. |
| `/etc/skiff/helper.env` | `skiff-helper.service` | Socket, path and tool settings for the privileged helper. |
| `/etc/skiff/master.key.cred` | `skiff-control-plane.service` | The 32-byte master key, sealed with `systemd-creds` so it only opens on this server. Owned by root, mode `0400`. |
| `/etc/skiff/master.key` | `skiff-control-plane.service` | The same key as plain base64, owned by root, mode `0400`. Only on systems whose systemd is older than 250. |
| `/etc/skiff/setup-token` | control plane | The one-time token that the first sign-in link uses. |
| `/etc/skiff/cloudflare.token` | agent | The Cloudflare API token for DNS-01 certificates, when one is configured. |

The files use one `KEY=value` pair per line. Values that contain spaces or shell characters are double-quoted, for example `SKIFF_SMTP_FROM="Skiff <noreply@example.com>"`. The installer writes the files in this format, so edit them in the same way.

> [!WARNING]
> The master key encrypts every stored secret. If you lose it, a restore cannot decrypt those secrets. Keep a [recovery kit](/self-hosting/platform-backups#recovery-kit) somewhere safe, and do not paste the key into `skiff.env`. A copy of the sealed `master.key.cred` is not a backup, because it only opens on the server that sealed it.

## Changing a value

Each process reads its environment once, at start-up. After you edit an environment file, restart the services that read it. The unit names are fixed:

| Process | Unit | Environment files |
|---|---|---|
| Control plane | `skiff-control-plane.service` | `skiff.env` |
| Node agent | `skiff-agent.service` | `skiff.env`, `agent.env` |
| Builder | `skiff-builder.service` | `agent.env` (restarts with the agent) |
| Privileged helper | `skiff-helper.service` | `helper.env` |

For example, after changing an SMTP setting in `skiff.env`:

```sh
sudo systemctl restart skiff-control-plane.service skiff-agent.service
```

Restart only the units whose files you changed. Changes made from the dashboard are applied for you, as described below.

## Secrets and file-based values

Four settings have a `_FILE` variant, which names a file that holds the value. Use it to keep a secret out of `skiff.env`. Where both are set, the inline value wins.

| Setting | File variant | Process | Notes |
|---|---|---|---|
| `SKIFF_MASTER_KEY` | `SKIFF_MASTER_KEY_FILE` | control plane | The file holds the base64 key. |
| `SKIFF_CLOUDFLARE_API_TOKEN` | `SKIFF_CLOUDFLARE_API_TOKEN_FILE` | node agent | The installer points this at `/etc/skiff/cloudflare.token`. |

`SKIFF_SETUP_TOKEN_FILE` is a file path in its own right: the control plane reads the one-time setup token from it, and it defaults to `/etc/skiff/setup-token` in production.

On an installed host the master key does not sit in any environment file. The installer seals it with `systemd-creds` into `/etc/skiff/master.key.cred`, bound to the server's TPM2 chip and host key, or the host key alone when there is no TPM2. A drop-in, `/etc/systemd/system/skiff-control-plane.service.d/skiff-master-key.conf`, makes the unit load it with systemd's `LoadCredentialEncrypted=` directive, so systemd decrypts it only into the service's private credential directory. On a system without `systemd-creds` the key stays a plain root-only file loaded with `LoadCredential=`. Either way the unit sets `SKIFF_MASTER_KEY_FILE` to the credential's path. You do not need to run any extra command for this. To replace the key, use `skiff-rotate-master-key` (see [platform backups](/self-hosting/platform-backups#rotating-secrets)).

## Control plane

The control plane is the dashboard, API, MCP endpoint and sign-in service. It reads `/etc/skiff/skiff.env`. The defaults in the tables apply when `NODE_ENV` is not `production`. In production, the settings marked as required must be set, or the process refuses to start.

### Core

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | unset | Set to `production` on an installed host. Turns on the production checks and turns off the development defaults. |
| `SKIFF_DATA_DIR` | `.data` (installer: `/var/lib/skiff/data`) | Directory for the SQLite database (`skiff.db`), local object storage and other local state. Required in production. |
| `BETTER_AUTH_SECRET` | dev-only value (required in production) | Secret for sign-in sessions and tokens. It is also the fallback for `SKIFF_SITE_COOKIE_SECRET` and `SKIFF_OBJECT_STORE_SECRET`. |
| `SKIFF_MASTER_KEY` | none (see note) | Base64-encoded 32-byte key that encrypts stored secrets. The process refuses to start if it does not decode to 32 bytes. If neither this nor `SKIFF_MASTER_KEY_FILE` is set, a key is derived from `BETTER_AUTH_SECRET`. Installed hosts always provide a key file. |
| `SKIFF_MASTER_KEY_FILE` | unset | Path to a file holding the master key. Used when `SKIFF_MASTER_KEY` is unset. |
| `SKIFF_SETUP_TOKEN_FILE` | `/etc/skiff/setup-token` in production | Path to the one-time setup token that the first sign-in link checks. |
| `SKIFF_EDGE_NODE_ID` | unset | Identifies the edge node on this host. The installer writes it. |
| `SKIFF_STORAGE_GATEWAY_PORT` | `8081` | Port of the edge's internal S3 gateway that the control plane calls. |
| `SKIFF_STORAGE_GATEWAY_URL` | unset | Full URL of the storage gateway. Use it when the control plane does not share a host with the edge Caddy. |
| `SKIFF_STORAGE_OBJECT_MAX_BYTES` | `104857600` (100 MiB) | Largest single object that one dashboard or API upload may send. Larger files need a presigned upload or `skif storage objects put`. |
| `SKIFF_DATABASE_GATEWAY_PORT` | `8082` | Loopback port of the edge's internal database gateway, which the control plane calls for the database studio. The edge agent learns the port from the control plane. |
| `SKIFF_STUDIO_PORT` | `8083` | Loopback port of the database studio front on every node. Nodes learn it from the control plane, so set it only here. |
| `SKIFF_CONTAINER_CONSOLE_PORT` | `8084` | Loopback port of the container console front on every node. Nodes learn it from the control plane, so set it only here. |
| `SKIFF_STANDBY` | unset | Set to `1` to make this process serve requests only. Background work stays with the primary. Used during zero-downtime updates. |

### Domains

| Variable | Default | Description |
|---|---|---|
| `SKIFF_PLATFORM_ORIGIN` | `http://localhost:5173` in development | The public address of the dashboard, API, MCP endpoint and sign-in, for example `https://control.example.com`. A trailing slash is removed. Required in production. |
| `SKIFF_CONTENT_DOMAIN` | `localhost` in development | The domain that deployed sites are served from, for example `example.com`. Required in production. |

Setting these by hand is rarely needed. Settings → Domains changes the dashboard host, the content domain and HTTPS together, and then restarts the affected services. See [domains and environments](/deploying/domains-and-environments) for how sites use the content domain.

### Object store

| Variable | Default | Description |
|---|---|---|
| `SKIFF_OBJECT_STORE` | `local` | Where release artifacts and object-storage data live: `local` (on this host) or `r2` (Cloudflare R2). |
| `SKIFF_OBJECT_STORE_SECRET` | `BETTER_AUTH_SECRET` | Signs the download and upload links that the local object store issues. |
| `SKIFF_SITE_COOKIE_SECRET` | `BETTER_AUTH_SECRET` | Keys the access tokens and visitor hashes for deployed sites. |
| `R2_ACCOUNT_ID` | unset | Cloudflare account ID (32 hex characters). Required when `SKIFF_OBJECT_STORE=r2`. |
| `R2_BUCKET` | unset | R2 bucket name. Required when `SKIFF_OBJECT_STORE=r2`. |
| `R2_ACCESS_KEY_ID` | unset | R2 access key ID. Required when `SKIFF_OBJECT_STORE=r2`. |
| `R2_SECRET_ACCESS_KEY` | unset | R2 secret access key. Required when `SKIFF_OBJECT_STORE=r2`. |
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | Override for the R2 endpoint. The installer writes it. |

The same `R2_*` values are used for database backups when they are set in **Settings → Backups**. See [platform backups](/self-hosting/platform-backups).

### Point-in-time recovery repository

These are read only when the `PITR` feature flag is on. The first three are required: if any is missing, turning PITR on for a database fails with an error. The credentials stay in the control plane and are passed to a node only when it needs them.

| Variable | Default | Description |
|---|---|---|
| `SKIFF_PITR_REPO_BUCKET` | unset | S3-compatible bucket that holds the WAL archive and base backups. |
| `SKIFF_PITR_ACCESS_KEY_ID` | unset | Access key ID for the bucket. |
| `SKIFF_PITR_SECRET_ACCESS_KEY` | unset | Secret access key for the bucket. |
| `SKIFF_PITR_REPO_ENDPOINT` | unset (AWS S3) | S3 endpoint for R2, MinIO, RustFS or another provider: an `https://` origin with an optional port and no path. Plain `http://` is refused. |
| `SKIFF_PITR_REPO_REGION` | `us-east-1` | Bucket region. |
| `SKIFF_PITR_REPO_PREFIX` | `skiff/pitr` | Key prefix inside the bucket. |
| `SKIFF_PITR_REPO_FORCE_PATH_STYLE` | `true` | Path-style bucket addressing. Set to `false` for providers that need virtual-hosted style. |

Turn the flag on only after the restore drill passes on one of your nodes. See [turn PITR on for an install](/data/backups-and-pitr#turn-pitr-on-for-an-install).

### Email (SMTP)

These settings let the platform send email through an SMTP server you already run, and they are what alert email uses. Skiff's own mail service is configured separately, through [email](/data/email).

| Variable | Default | Description |
|---|---|---|
| `SKIFF_SMTP_HOST` | unset (SMTP off) | Hostname of the SMTP server. Setting it turns SMTP on. |
| `SKIFF_SMTP_PORT` | `587` | SMTP port. |
| `SKIFF_SMTP_USER` | empty | SMTP username. |
| `SKIFF_SMTP_PASSWORD` | empty | SMTP password. |
| `SKIFF_SMTP_FROM` | `Skiff <noreply@<content domain>>` | The From address, with an optional display name. |
| `SKIFF_SMTP_SECURE` | unset | Set to `1` to use TLS from the first byte (usually port 465). Otherwise leave it unset. |

### Alerts and notifications

Alerts go to every destination that is set. None are required. Settings → Notifications sets the same keys.

| Variable | Default | Description |
|---|---|---|
| `SKIFF_ALERT_WEBHOOK` | unset | Generic HTTP or HTTPS webhook. A Discord or Slack URL placed here is sent in that service's format. |
| `SKIFF_ALERT_EMAIL` | unset | Address that receives alert email. Needs SMTP. |
| `SKIFF_ALERT_SMS` | unset | Comma-separated list of up to five phone numbers in international format (`+447700900123`). Needs Twilio. |
| `SKIFF_ALERT_DISCORD_WEBHOOK` | unset | Discord channel webhook URL. |
| `SKIFF_ALERT_SLACK_WEBHOOK` | unset | Slack incoming-webhook URL. |
| `SKIFF_ALERT_TELEGRAM_BOT_TOKEN` | unset | Telegram bot token. Set it together with the chat ID. |
| `SKIFF_ALERT_TELEGRAM_CHAT_ID` | unset | Telegram chat ID, or `@channelname`. |
| `SKIFF_ALERT_NTFY_URL` | unset | ntfy topic URL, for example `https://ntfy.sh/my-skiff-alerts`. |
| `SKIFF_ALERT_NTFY_TOKEN` | unset | Access token for a protected ntfy topic. |
| `SKIFF_TWILIO_ACCOUNT_SID` | unset | Twilio Account SID. SMS needs all three Twilio settings. |
| `SKIFF_TWILIO_AUTH_TOKEN` | unset | Twilio Auth Token. |
| `SKIFF_TWILIO_FROM` | unset | A Twilio number, a Messaging Service SID (`MG…`) or an alphanumeric sender ID. |
| `SKIFF_VAPID_PUBLIC_KEY` | generated by the installer | Public half of the Web Push key pair. Changing it orphans every subscribed browser. |
| `SKIFF_VAPID_PRIVATE_KEY` | generated by the installer | Private half of the Web Push key pair. |
| `SKIFF_VAPID_SUBJECT` | the platform origin if it is `https://`, otherwise `mailto:skiff@<content domain>` | Contact URI sent to push services. Use an `https://` or `mailto:` address. |

Alert destinations are also covered in [alerts](/observe/alerts).

### Auth providers and sign-in

| Variable | Default | Description |
|---|---|---|
| `GITHUB_CLIENT_ID` | unset | GitHub OAuth app client ID. GitHub sign-in is on only when both GitHub values are set. |
| `GITHUB_CLIENT_SECRET` | unset | GitHub OAuth app client secret. |
| `SKIFF_OPEN_SIGNUP` | `0` | Set to `1` to allow anyone to create an account. Production is invite-only by default. |
| `SKIFF_OWNER_2FA` | `1` in production | Set to `0` to turn off the second factor for owners. |
| `SKIFF_MCP_ALLOW_DCR` | `1` | Accept Dynamic Client Registration from older MCP clients, alongside the newer client metadata method. Set to `0` to refuse it. |

Sign-in and two-factor behaviour is described in [sign in and 2FA](/accounts/sign-in-and-2fa).

### Telemetry (ClickHouse)

Telemetry needs an optional ClickHouse server. Without `SKIFF_CLICKHOUSE_URL`, the dashboard reports telemetry as not installed. Settings → Telemetry installs or removes the server and writes these values.

| Variable | Default | Description |
|---|---|---|
| `SKIFF_CLICKHOUSE_URL` | unset | HTTP URL of the ClickHouse server. Setting it turns telemetry on. |
| `SKIFF_CLICKHOUSE_USER` | `skiff` | User for writes. |
| `SKIFF_CLICKHOUSE_PASSWORD` | empty | Password for the write user. |
| `SKIFF_CLICKHOUSE_DATABASE` | `skiff` | Database that holds the telemetry tables. |
| `SKIFF_CLICKHOUSE_READER_USER` | unset | Optional read-only user for queries. |
| `SKIFF_CLICKHOUSE_READER_PASSWORD` | empty | Password for the read-only user. |

### Assistant

The assistant is on when `SKIFF_ASSISTANT_MODEL` is set and `SKIFF_ASSISTANT_DISABLED` is not `1`. Settings → Assistant sets the same keys.

| Variable | Default | Description |
|---|---|---|
| `SKIFF_ASSISTANT_PROVIDER` | `openai-compatible` | One of `openai`, `openai-compatible`, `openrouter` or `ollama`. |
| `SKIFF_ASSISTANT_BASE_URL` | set by the provider | API base URL. Defaults are `https://api.openai.com/v1` for OpenAI and compatible servers, `https://openrouter.ai/api/v1` for OpenRouter, and `http://127.0.0.1:11434/v1` for Ollama. |
| `SKIFF_ASSISTANT_MODEL` | unset | Model ID to use. Setting it turns the assistant on. |
| `SKIFF_ASSISTANT_API_KEY` | unset | API key for the provider. Optional for a local Ollama server. |
| `SKIFF_ASSISTANT_DISABLED` | unset | Set to `1` to turn the assistant off, even when it is configured. |

### Feature flags

Each flag is set with `SKIFF_FEATURE_<NAME>`. Accepted values are `1`, `true`, `on` or `yes` to enable, and `0`, `false`, `off` or `no` to disable. Any other value is ignored and the default applies. Flags are read at start-up, so restart the control plane after a change. Every flag defaults on; set one to `0` to turn that feature off. `SKIFF_FEATURE_DB_CONSOLE` was removed; the control plane logs a warning and ignores it.

| Flag | Default | What it controls |
|---|---|---|
| `FUNCTIONS` | on | Deploy functions on the pinned workerd runtime. |
| `BROKERS` | on | Create managed queue brokers and attach them to apps. |
| `EMAIL` | on | Send and receive email on verified domains through Skiff's mail service. |
| `BACKUPS_RESTORE` | on | Create, restore and delete managed database backups. |
| `PITR` | on | Point-in-time recovery for PostgreSQL 18 databases. Needs the `SKIFF_PITR_REPO_*` repository settings; without them PITR requests are refused. |
| `OBJECT_BROWSER` | on | Browse, upload, download and delete objects in storage buckets. |
| `POOLER` | on | Run a PgBouncer sidecar and publish a pooled connection port. |
| `DB_STUDIO` | on | Open the native database studio. Set to `0` to hide it. |
| `CONTAINER_CONSOLE` | on | Show the container console for container projects: Overview, Files and Shell. Set to `0` to hide it and close the node listeners. |
| `DB_TLS` | on | Accept TLS connections to managed databases. |
| `ORG_NETWORKS` | on | Private per-organisation networks across nodes. |
| `MULTI_NODE_REPLICAS` | on | Spread HTTP workload replicas across nodes. |
| `SERVICE_ENDPOINTS` | on | Cross-node database attachments through loopback service endpoints. |
| `DB_AUTO_PROMOTE` | off | Let automatic failover promote a PostgreSQL read replica when its primary's node goes silent. Needs `failover.enabled`; see [clustering](/self-hosting/clustering#automatic-failover). |
| `APP_VOLUMES` | on | Attach persistent volumes to deployed workloads. |
| `JOBS` | on | Cron jobs and one-off commands on process and container apps. See [app jobs](/compute/scheduled-jobs#app-jobs). |
| `PREVIEW_DATA` | on | Clone database and bucket data into preview environments. This can copy production data. |
| `AGENT_DATA_WRITE` | on | Let MCP and agent tools write or delete user data, not only read it. |
| `QUOTAS` | on | Enforce per-organisation project, storage and upload quotas. |
| `UPGRADE_ROLLBACK` | on | Reserved for automatic rollback after a failed readiness check. Use the CLI rollback instead. |
| `BLUEPRINTS` | on | Plan and apply blueprint files that declare a whole stack, including pruning what they manage. See [blueprints](/compute/apps-and-containers#blueprints). |
| `MEDIA` | on | Image and video uploads, transforms and delivery. |

### Dev-only

These settings exist for local development and tests. The control plane refuses the first one in production.

| Variable | Default | Description |
|---|---|---|
| `SKIFF_DEV_PASSWORD_LOGIN` | `0` | Set to `1` to allow open sign-up with email and password and turn off the owner second factor. The process refuses to start with this set and `NODE_ENV=production`. |

A development server, started without an installed release, uses these defaults: `SKIFF_PLATFORM_ORIGIN` of `http://localhost:5173`, `SKIFF_CONTENT_DOMAIN` of `localhost`, and `SKIFF_DATA_DIR` of `.data`. It creates its own Web Push keys in `.data/vapid.json`. It also reads settings saved from the dashboard from `.data/platform-settings.json`, which takes effect after a restart.

If `.data/clickhouse` exists, `NODE_ENV` is not `production` and no `SKIFF_CLICKHOUSE_URL` is set, the development server uses the local ClickHouse started by `bun run dev:clickhouse`, on `127.0.0.1:18123`.

## Node agent

The node agent runs on every edge and worker node. It reads `skiff.env` and `agent.env`. A node that has joined has `SKIFF_CONTROL_URL`, `SKIFF_NODE_ID` and `SKIFF_NODE_TOKEN` in `agent.env`. If those three are missing, the agent reads them from `node.json` in `SKIFF_DATA_DIR`, which `skiff-agent join` writes.

### Identity and paths

| Variable | Default | Description |
|---|---|---|
| `SKIFF_CONTROL_URL` | from `node.json` | Control-plane origin, for example `https://control.example.com`. Required unless `node.json` supplies it. |
| `SKIFF_NODE_ID` | from `node.json` | This node's ID (`nod_…`). |
| `SKIFF_NODE_TOKEN` | from `node.json` | Bearer token for this node. Treat it as a secret. |
| `SKIFF_CONTROL_SOCKET` | unset | Edge only. A Unix socket path (absolute) that the agent uses to reach the control plane without going through Caddy. |
| `SKIFF_DATA_DIR` | `/var/lib/skiff-agent` (installed unit: `/var/lib/skiff/agent`) | Root for cached state and releases, and the location of `node.json`. |
| `SKIFF_AGENT_SOCKET` | `/run/skiff-agent/agent.sock` | Unix socket for the forward-auth and metrics endpoints. |
| `SKIFF_STORAGE_STATE_FILE` | `/etc/skiff/storage.json` | Where the storage service records the paths it last applied. |
| `SKIFF_STORAGE_REQUEST_FILE` | `/run/skiff/storage.request` | File the agent writes to ask the storage service to apply new paths. |
| `SKIFF_HELPER_SOCKET` | `/run/skiff-helper/helper.sock` | The privileged helper's socket. See the [helper section](#privileged-helper). |

### Edge, Caddy and TLS

These settings matter on an edge node, which terminates HTTPS for the platform and for deployed sites.

| Variable | Default | Description |
|---|---|---|
| `SKIFF_CADDY_ADMIN_SOCKET` | `/var/lib/caddy/admin.sock` | Caddy's admin API socket. Caddy is never reachable over TCP. The installed unit sets its own path. |
| `SKIFF_CADDY_LISTEN` | `:443,:80` | Comma-separated addresses that Caddy listens on. |
| `SKIFF_CADDY_ACCESS_LOG` | unset | Path to Caddy's JSON access log. When set, the agent aggregates it into telemetry. |
| `SKIFF_SITE_COOKIE_COOKIE_NAME` | `__skiff_s` | Name of the session cookie on deployed sites. |
| `SKIFF_PLATFORM_HOST` | unset | Host name for the dashboard, served by Caddy, for example `control.example.com`. |
| `SKIFF_PLATFORM_UPSTREAM` | `unix//run/skiff/control.sock` | Where Caddy forwards dashboard requests. |
| `SKIFF_CONTENT_DOMAIN` | from desired state | Overrides the content domain that the control plane sent. |
| `SKIFF_TLS` | `1` when `SKIFF_ACME_EMAIL` is set, otherwise `0` | Terminate TLS in Caddy with certificates from ACME. |
| `SKIFF_ACME_EMAIL` | unset | Account email for the ACME provider. Required in production when TLS is on. |
| `SKIFF_ACME_CA` | Caddy's default directory | ACME directory URL. Set it to use a staging or private CA. |
| `SKIFF_CLOUDFLARE_API_TOKEN` | unset | Cloudflare token for DNS-01 challenges. Prefer the `_FILE` variant. |
| `SKIFF_CLOUDFLARE_API_TOKEN_FILE` | unset (installer: `/etc/skiff/cloudflare.token`) | File that holds the Cloudflare token. |
| `SKIFF_CERT_PROBE_ADDR` | loopback on the TLS listen port | `host:port` that the agent reads certificates from to check their expiry, or `off`. |

### Workloads and logs

| Variable | Default | Description |
|---|---|---|
| `SKIFF_WORKLOAD_SLICE_MB` | `1024` | Memory budget, in MiB, for the workload slice. Allowed range 32 to 1048576. |
| `SKIFF_WORKLOAD_SOCKET_DIR` | `/run/skiff-workloads` | Directory where socket-activated workloads expose their sockets. |
| `SKIFF_WORKLOAD_HEALTH_TIMEOUT_MS` | `30000` | How long to wait for a workload's health check before reporting it as starting. Allowed range 1000 to 600000. |
| `SKIFF_LOG_DRAIN` | `1` | Set to `0` to stop sending workload logs to the control plane. |
| `SKIFF_LOG_DRAIN_INTERVAL_MS` | `2000` | How often the agent asks for new log lines. Allowed range 500 to 60000. |
| `SKIFF_AGENT_INSECURE_HTTP` | `0` | Development only. Emits non-Secure cookies and `http` return URLs. The agent refuses it when `NODE_ENV=production`. |

## Privileged helper

The helper runs as root and does the work that needs root: it writes systemd units and Quadlet files, manages databases and the workload sockets, and applies node updates. Only members of the group named in `SKIFF_HELPER_CONTROL_SOCKET_GROUP` (by default `skiff`, the group the agent runs as) can connect to it. The helper reads `/etc/skiff/helper.env`, and its unit does not start unless that file exists.

The installer writes these values into `helper.env`, and they override the defaults below: `SKIFF_HELPER_BUN_PATH=/opt/skiff/runtime/bin/bun`, `SKIFF_HELPER_RELEASE_DIRS=/var/lib/skiff/agent/releases,/opt/skiff/releases`, `SKIFF_HELPER_WORKLOAD_SOCKET_GROUP=caddy`, `SKIFF_HELPER_WORKLOAD_SOCKET_MODE=0660` and `SKIFF_HELPER_APPARMOR_PROFILE=auto`.

### Sockets and directories

| Variable | Default | Description |
|---|---|---|
| `SKIFF_HELPER_SOCKET` | `/run/skiff-helper/helper.sock` | The helper's control socket. It must not be inside the workload runtime directory. |
| `SKIFF_HELPER_CONTROL_SOCKET_GROUP` | `skiff` | Group allowed to connect to the control socket. |
| `SKIFF_HELPER_CONTROL_SOCKET_MODE` | `0660` | Mode of the control socket. It must not grant access to other users. |
| `SKIFF_HELPER_RUNTIME_DIR` | `/run/skiff-workloads` | Root-owned runtime directory for env files, secret files and workload sockets. |
| `SKIFF_HELPER_WORKLOAD_SOCKET_GROUP` | unset | Group that can connect to workload sockets, for example the Caddy group. |
| `SKIFF_HELPER_WORKLOAD_SOCKET_MODE` | `0666` | Mode of workload sockets. |
| `SKIFF_HELPER_STATE_DIR` | `/var/lib/skiff-workloads` | Persistent data for containers. |
| `SKIFF_HELPER_UNIT_DIR` | `/etc/systemd/system` | Where generated unit files are written. |
| `SKIFF_HELPER_QUADLET_DIR` | `/etc/containers/systemd` | Where Quadlet `.container` and `.network` files are written. |
| `SKIFF_HELPER_RELEASE_DIRS` | `/srv/skiff/releases,/var/lib/skiff/agent/releases` | Comma-separated release roots, searched in order. |
| `SKIFF_HELPER_WORKERD_DIR` | `/usr/lib/skiff/workerd` | Root of the pinned workerd installations. |

### Tool paths and update

| Variable | Default | Description |
|---|---|---|
| `SKIFF_HELPER_BUN_PATH` | `/usr/local/bin/bun` | Bun binary for the default `bun run start` process command. |
| `SKIFF_HELPER_NODE_PATH` | `/usr/local/bin/node` | Node.js binary for the default `node --run start` process command. |
| `SKIFF_HELPER_SYSTEMCTL` | `/usr/bin/systemctl` | systemctl binary. |
| `SKIFF_HELPER_JOURNALCTL` | `/usr/bin/journalctl` | journalctl binary, used to read workload logs. |
| `SKIFF_HELPER_PODMAN` | `/usr/bin/podman` | Podman binary, used for database dump and restore. |
| `SKIFF_HELPER_OPENSSL` | `/usr/bin/openssl` | openssl binary, used to create per-database TLS certificates. |
| `SKIFF_HELPER_APPARMOR_PROFILE` | `auto` | AppArmor profile for container workloads. `auto` disables AppArmor for containers only on kernels that restrict unprivileged profile changes. `none` keeps the runtime default. Any other value is used as a profile name. |
| `SKIFF_HELPER_AGENT_BINARY` | `/opt/skiff/current/agent/skiff-agent` | Agent binary that a node update replaces. |
| `SKIFF_HELPER_SELF_BINARY` | `/opt/skiff/helper/skiff-helper` | Helper binary that a node update replaces. |
| `SKIFF_HELPER_RELEASE_LINK` | `/opt/skiff/current` | Symlink that points at the active release. |
| `SKIFF_HELPER_UPDATE_DIR` | `/var/lib/skiff-helper/node-update` | Working directory for node updates. |

Every path must be absolute. The helper refuses to start otherwise.

## Builder

The builder builds Git-based deployments. It runs as `skiff-builder.service` on any node that has been given the builder role, and it reads `agent.env`. Where systemd is available, each build runs as the `skiff-build` user in its own transient unit, with its own memory and CPU limits.

| Variable | Default | Description |
|---|---|---|
| `SKIFF_CONTROL_URL` | required | Control-plane origin. |
| `SKIFF_NODE_TOKEN` | required | Token of a node that has the builder role. |
| `SKIFF_BUILD_DIR` | required (unit: `/var/lib/skiff-builder`) | Scratch directory for clones and build output. |
| `SKIFF_GIT_TOKEN` | unset | Credential for private HTTPS repositories. It is sent only to the hosts in `SKIFF_GIT_TOKEN_HOSTS`, is never written to a URL or to `.git/config`, and is never logged. |
| `SKIFF_GIT_TOKEN_HOSTS` | `github.com` | Comma-separated hosts (`host` or `host:port`) that may receive `SKIFF_GIT_TOKEN`. |
| `SKIFF_GIT_SSH_KEY` | unset | Absolute path to a private deploy key, readable only by root, for `ssh://` and `git@host:path` repositories. It is used only while the Builder clones, and builds cannot read it. |
| `SKIFF_GIT_SSH_KNOWN_HOSTS` | unset | Absolute path to a pinned `known_hosts` file for SSH clones, which turns on strict host key checking. When unset, the first clone from a host records its key in `$SKIFF_BUILD_DIR/known_hosts`. |
| `SKIFF_BUILDER_SYSTEMD` | `true` on Linux when `systemd-run` is present | Set to `false` to run builds as a plain child process. Use this on a development workstation. |
| `SKIFF_BUILDER_USER` | `skiff-build` when running as root under systemd | User that builds run as. Set to `none` to run as the daemon's own user, which is not allowed when the daemon runs as root. |
| `SKIFF_BUILDER_TIMEOUT_SECONDS` | `600` | Time limit for one build. |
| `SKIFF_BUILDER_MEMORY_MAX` | `2G` | Memory limit for one build. |
| `SKIFF_BUILDER_CPU_QUOTA` | `200%` | CPU limit for one build. |
| `SKIFF_BUILDER_PATH` | Skiff's Bun first, then the system paths | `PATH` inside a build. |
| `SKIFF_BUILDER_POLL_MS` | `5000` | How often the builder asks for work. |
| `SKIFF_BUILDER_IDLE_POLL_MS` | `30000` | How often it checks again while its node does not have the builder role. |

## Dashboard-managed settings

Some settings can be changed in the dashboard, under **Settings**, instead of by editing a file. The dashboard validates the change, then asks a root-owned helper, `skiff-platform-config`, to write the values into `skiff.env` or `agent.env`. That helper restarts the services it changed, and it reports the outcome on the settings page. You do not need to run `systemctl` yourself.

| Settings page | Keys it writes |
|---|---|
| **Settings → Backups** | `R2_*` (the backup bucket and credentials), and enables or disables Litestream replication and the restore drill. |
| **Settings → Notifications** | `SKIFF_SMTP_*`, the Twilio keys, the `SKIFF_ALERT_*` channels, and the Web Push keys. |
| **Settings → Assistant** | `SKIFF_ASSISTANT_*`. |
| **Settings → Telemetry** | Installs or removes ClickHouse and writes the `SKIFF_CLICKHOUSE_*` values. |
| **Settings → Domains** | The dashboard host, content domain and HTTPS settings, and the Cloudflare token. |

The rules that apply to these pages are:

- Only the keys listed for each section can be changed from the dashboard. Other variables, such as `SKIFF_MASTER_KEY` or `SKIFF_DATA_DIR`, must be edited in the file.
- Secret values are never shown again after they are saved. Leaving a secret field empty keeps the current value.
- A section must be complete before it takes effect. For example, SMTP needs a host, a port and a From address, and Twilio needs all three of its keys.

Email → Mail server is a different thing. It configures Skiff's own mail service, and it does not write any of the variables above.

> [!NOTE]
> On a development server, dashboard changes are saved to `.data/platform-settings.json` in the data directory, and they take effect after a restart of the dev server.
