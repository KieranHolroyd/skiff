---
title: Configuration reference
description: Every environment variable the control plane, node agent, privileged helper and builder read, where they live on a host, and how to change them.
---

This page lists every environment variable that a Yoal process reads when it starts, grouped by process, with its default and what it does. Use it when you are setting up a host, changing a value in `/etc/yoal`, or checking what a default is. For the install itself, see [installation](/self-hosting/installation). Many of the same settings can be changed from the dashboard instead; [Dashboard-managed settings](#dashboard-managed-settings) explains which ones, and how that differs from editing the file.

## Where configuration lives on a host

An installed host keeps its configuration in `/etc/yoal`. Each service reads its own environment file through a systemd `EnvironmentFile=` line.

| Path | Read by | Notes |
|---|---|---|
| `/etc/yoal/yoal.env` | `yoal-control-plane.service`, `yoal-agent.service`, `yoal-litestream.service`, `yoal-restore-drill.service` | The platform-wide file. Owned `root:yoal`, mode `0640`. |
| `/etc/yoal/agent.env` | `yoal-agent.service` (optional), `yoal-builder.service` | Node identity (`YOAL_NODE_ID`, `YOAL_NODE_TOKEN`) and the edge's Caddy settings. Written when a node joins. |
| `/etc/yoal/helper.env` | `yoal-helper.service` | Socket, path and tool settings for the privileged helper. |
| `/etc/yoal/master.key.cred` | `yoal-control-plane.service` | The 32-byte master key, sealed with `systemd-creds` so it only opens on this server. Owned by root, mode `0400`. |
| `/etc/yoal/master.key` | `yoal-control-plane.service` | The same key as plain base64, owned by root, mode `0400`. Only on systems whose systemd is older than 250. |
| `/etc/yoal/setup-token` | control plane | The one-time token that the first sign-in link uses. |
| `/etc/yoal/cloudflare.token` | agent | The Cloudflare API token for DNS-01 certificates, when one is configured. |

The files use one `KEY=value` pair per line. Values that contain spaces or shell characters are double-quoted, for example `YOAL_SMTP_FROM="Yoal <noreply@example.com>"`. The installer writes the files in this format, so edit them in the same way.

> [!WARNING]
> The master key encrypts every stored secret. If you lose it, a restore cannot decrypt those secrets. Keep a [recovery kit](/self-hosting/platform-backups#recovery-kit) somewhere safe, and do not paste the key into `yoal.env`. A copy of the sealed `master.key.cred` is not a backup, because it only opens on the server that sealed it.

## Changing a value

Each process reads its environment once, at start-up. After you edit an environment file, restart the services that read it. The unit names are fixed:

| Process | Unit | Environment files |
|---|---|---|
| Control plane | `yoal-control-plane.service` | `yoal.env` |
| Node agent | `yoal-agent.service` | `yoal.env`, `agent.env` |
| Builder | `yoal-builder.service` | `agent.env` (restarts with the agent) |
| Privileged helper | `yoal-helper.service` | `helper.env` |

For example, after changing an SMTP setting in `yoal.env`:

```sh
sudo systemctl restart yoal-control-plane.service yoal-agent.service
```

Restart only the units whose files you changed. Changes made from the dashboard are applied for you, as described below.

## Secrets and file-based values

Four settings have a `_FILE` variant, which names a file that holds the value. Use it to keep a secret out of `yoal.env`. Where both are set, the inline value wins.

| Setting | File variant | Process | Notes |
|---|---|---|---|
| `YOAL_MASTER_KEY` | `YOAL_MASTER_KEY_FILE` | control plane | The file holds the base64 key. |
| `YOAL_CLOUDFLARE_API_TOKEN` | `YOAL_CLOUDFLARE_API_TOKEN_FILE` | node agent | The installer points this at `/etc/yoal/cloudflare.token`. |

`YOAL_SETUP_TOKEN_FILE` is a file path in its own right: the control plane reads the one-time setup token from it, and it defaults to `/etc/yoal/setup-token` in production.

On an installed host the master key does not sit in any environment file. The installer seals it with `systemd-creds` into `/etc/yoal/master.key.cred`, bound to the server's TPM2 chip and host key, or the host key alone when there is no TPM2. A drop-in, `/etc/systemd/system/yoal-control-plane.service.d/yoal-master-key.conf`, makes the unit load it with systemd's `LoadCredentialEncrypted=` directive, so systemd decrypts it only into the service's private credential directory. On a system without `systemd-creds` the key stays a plain root-only file loaded with `LoadCredential=`. Either way the unit sets `YOAL_MASTER_KEY_FILE` to the credential's path. You do not need to run any extra command for this. To replace the key, use `yoal-rotate-master-key` (see [platform backups](/self-hosting/platform-backups#rotating-secrets)).

## Control plane

The control plane is the dashboard, API, MCP endpoint and sign-in service. It reads `/etc/yoal/yoal.env`. The defaults in the tables apply when `NODE_ENV` is not `production`. In production, the settings marked as required must be set, or the process refuses to start.

### Core

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | unset | Set to `production` on an installed host. Turns on the production checks and turns off the development defaults. |
| `YOAL_DATA_DIR` | `.data` (installer: `/var/lib/yoal/data`) | Directory for the SQLite database (`yoal.db`), local object storage and other local state. Required in production. |
| `BETTER_AUTH_SECRET` | dev-only value (required in production) | Secret for sign-in sessions and tokens. It is also the fallback for `YOAL_SITE_COOKIE_SECRET` and `YOAL_OBJECT_STORE_SECRET`. |
| `YOAL_MASTER_KEY` | none (see note) | Base64-encoded 32-byte key that encrypts stored secrets. The process refuses to start if it does not decode to 32 bytes. If neither this nor `YOAL_MASTER_KEY_FILE` is set, a key is derived from `BETTER_AUTH_SECRET`. Installed hosts always provide a key file. |
| `YOAL_MASTER_KEY_FILE` | unset | Path to a file holding the master key. Used when `YOAL_MASTER_KEY` is unset. |
| `YOAL_SETUP_TOKEN_FILE` | `/etc/yoal/setup-token` in production | Path to the one-time setup token that the first sign-in link checks. |
| `YOAL_EDGE_NODE_ID` | unset | Identifies the edge node on this host. The installer writes it. |
| `YOAL_STORAGE_GATEWAY_PORT` | `8081` | Port of the edge's internal S3 gateway that the control plane calls. |
| `YOAL_STORAGE_GATEWAY_URL` | unset | Full URL of the storage gateway. Use it when the control plane does not share a host with the edge Caddy. |
| `YOAL_STORAGE_OBJECT_MAX_BYTES` | `104857600` (100 MiB) | Largest single object that one dashboard or API upload may send. Larger files need a presigned upload or `yoal storage objects put`. |
| `YOAL_DATABASE_GATEWAY_PORT` | `8082` | Loopback port of the edge's internal database gateway, which the control plane calls for the database studio. The edge agent learns the port from the control plane. |
| `YOAL_STUDIO_PORT` | `8083` | Loopback port of the database studio front on every node. Nodes learn it from the control plane, so set it only here. |
| `YOAL_CONTAINER_CONSOLE_PORT` | `8084` | Loopback port of the container console front on every node. Nodes learn it from the control plane, so set it only here. |
| `YOAL_STANDBY` | unset | Set to `1` to make this process serve requests only. Background work stays with the primary. Used during zero-downtime updates. |

### Usage analytics

| Variable | Default | Description |
|---|---|---|
| `YOAL_USAGE_ANALYTICS_ENDPOINT` | unset | Pins the collector endpoint and overrides the dashboard field. Must be an absolute `http(s)` URL with no credentials. The built-in default is `https://yoal-analytics-engine.kierancloud.dev/api/v1/ping`; nothing is sent unless an owner opts in under **Settings → Usage analytics**. |

The opt-in itself, the install id and the endpoint chosen in the dashboard live in the platform
database under the `usage.analytics` key, not in this file. See
[usage analytics](/self-hosting/usage-analytics) for what a ping contains and how to run the
collector yourself.

### Domains

| Variable | Default | Description |
|---|---|---|
| `YOAL_PLATFORM_ORIGIN` | `http://localhost:5173` in development | The public address of the dashboard, API, MCP endpoint and sign-in, for example `https://control.example.com`. A trailing slash is removed. Required in production. |
| `YOAL_CONTENT_DOMAIN` | `localhost` in development | The domain that deployed sites are served from, for example `example.com`. Required in production. |

Setting these by hand is rarely needed. Settings → Domains changes the dashboard host, the content domain and HTTPS together, and then restarts the affected services. See [domains and environments](/deploying/domains-and-environments) for how sites use the content domain.

### Object store

| Variable | Default | Description |
|---|---|---|
| `YOAL_OBJECT_STORE` | `local` | Where release artifacts and object-storage data live: `local` (on this host) or `r2` (Cloudflare R2). |
| `YOAL_OBJECT_STORE_SECRET` | `BETTER_AUTH_SECRET` | Signs the download and upload links that the local object store issues. |
| `YOAL_SITE_COOKIE_SECRET` | `BETTER_AUTH_SECRET` | Keys the access tokens and visitor hashes for deployed sites. |
| `R2_ACCOUNT_ID` | unset | Cloudflare account ID (32 hex characters). Required when `YOAL_OBJECT_STORE=r2`. |
| `R2_BUCKET` | unset | R2 bucket name. Required when `YOAL_OBJECT_STORE=r2`. |
| `R2_ACCESS_KEY_ID` | unset | R2 access key ID. Required when `YOAL_OBJECT_STORE=r2`. |
| `R2_SECRET_ACCESS_KEY` | unset | R2 secret access key. Required when `YOAL_OBJECT_STORE=r2`. |
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | Override for the R2 endpoint. The installer writes it. |

The same `R2_*` values are used for database backups when they are set in **Settings → Backups**. See [platform backups](/self-hosting/platform-backups).

### Point-in-time recovery repository

These are read only when the `PITR` feature flag is on. The first three are required: if any is missing, turning PITR on for a database fails with an error. The credentials stay in the control plane and are passed to a node only when it needs them.

| Variable | Default | Description |
|---|---|---|
| `YOAL_PITR_REPO_BUCKET` | unset | S3-compatible bucket that holds the WAL archive and base backups. |
| `YOAL_PITR_ACCESS_KEY_ID` | unset | Access key ID for the bucket. |
| `YOAL_PITR_SECRET_ACCESS_KEY` | unset | Secret access key for the bucket. |
| `YOAL_PITR_REPO_ENDPOINT` | unset (AWS S3) | S3 endpoint for R2, MinIO, RustFS or another provider: an `https://` origin with an optional port and no path. Plain `http://` is refused. |
| `YOAL_PITR_REPO_REGION` | `us-east-1` | Bucket region. |
| `YOAL_PITR_REPO_PREFIX` | `yoal/pitr` | Key prefix inside the bucket. |
| `YOAL_PITR_REPO_FORCE_PATH_STYLE` | `true` | Path-style bucket addressing. Set to `false` for providers that need virtual-hosted style. |

Turn the flag on only after the restore drill passes on one of your nodes. See [turn PITR on for an install](/data/backups-and-pitr#turn-pitr-on-for-an-install).

### Email (SMTP)

These settings let the platform send email through an SMTP server you already run, and they are what alert email uses. Yoal's own mail service is configured separately, through [email](/data/email).

| Variable | Default | Description |
|---|---|---|
| `YOAL_SMTP_HOST` | unset (SMTP off) | Hostname of the SMTP server. Setting it turns SMTP on. |
| `YOAL_SMTP_PORT` | `587` | SMTP port. |
| `YOAL_SMTP_USER` | empty | SMTP username. |
| `YOAL_SMTP_PASSWORD` | empty | SMTP password. |
| `YOAL_SMTP_FROM` | `Yoal <noreply@<content domain>>` | The From address, with an optional display name. |
| `YOAL_SMTP_SECURE` | unset | Set to `1` to use TLS from the first byte (usually port 465). Otherwise leave it unset. |

### Alerts and notifications

Alerts go to every destination that is set. None are required. Settings → Notifications sets the same keys.

| Variable | Default | Description |
|---|---|---|
| `YOAL_ALERT_WEBHOOK` | unset | Generic HTTP or HTTPS webhook. A Discord or Slack URL placed here is sent in that service's format. |
| `YOAL_ALERT_EMAIL` | unset | Address that receives alert email. Needs SMTP. |
| `YOAL_ALERT_SMS` | unset | Comma-separated list of up to five phone numbers in international format (`+447700900123`). Needs Twilio. |
| `YOAL_ALERT_DISCORD_WEBHOOK` | unset | Discord channel webhook URL. |
| `YOAL_ALERT_SLACK_WEBHOOK` | unset | Slack incoming-webhook URL. |
| `YOAL_ALERT_TELEGRAM_BOT_TOKEN` | unset | Telegram bot token. Set it together with the chat ID. |
| `YOAL_ALERT_TELEGRAM_CHAT_ID` | unset | Telegram chat ID, or `@channelname`. |
| `YOAL_ALERT_NTFY_URL` | unset | ntfy topic URL, for example `https://ntfy.sh/my-yoal-alerts`. |
| `YOAL_ALERT_NTFY_TOKEN` | unset | Access token for a protected ntfy topic. |
| `YOAL_TWILIO_ACCOUNT_SID` | unset | Twilio Account SID. SMS needs all three Twilio settings. |
| `YOAL_TWILIO_AUTH_TOKEN` | unset | Twilio Auth Token. |
| `YOAL_TWILIO_FROM` | unset | A Twilio number, a Messaging Service SID (`MG…`) or an alphanumeric sender ID. |
| `YOAL_VAPID_PUBLIC_KEY` | generated by the installer | Public half of the Web Push key pair. Changing it orphans every subscribed browser. |
| `YOAL_VAPID_PRIVATE_KEY` | generated by the installer | Private half of the Web Push key pair. |
| `YOAL_VAPID_SUBJECT` | the platform origin if it is `https://`, otherwise `mailto:yoal@<content domain>` | Contact URI sent to push services. Use an `https://` or `mailto:` address. |

Alert destinations are also covered in [alerts](/observe/alerts).

### Auth providers and sign-in

| Variable | Default | Description |
|---|---|---|
| `GITHUB_CLIENT_ID` | unset | GitHub OAuth app client ID. GitHub sign-in is on only when both GitHub values are set. |
| `GITHUB_CLIENT_SECRET` | unset | GitHub OAuth app client secret. |
| `YOAL_OPEN_SIGNUP` | `0` | Set to `1` to allow anyone to create an account. Production is invite-only by default. |
| `YOAL_OWNER_2FA` | `1` in production | Set to `0` to turn off the second factor for owners. |
| `YOAL_MCP_ALLOW_DCR` | `1` | Accept Dynamic Client Registration from older MCP clients, alongside the newer client metadata method. Set to `0` to refuse it. |

Sign-in and two-factor behaviour is described in [sign in and 2FA](/accounts/sign-in-and-2fa).

### Telemetry (ClickHouse)

Telemetry needs an optional ClickHouse server. Without `YOAL_CLICKHOUSE_URL`, the dashboard reports telemetry as not installed. Settings → Telemetry installs or removes the server and writes these values.

| Variable | Default | Description |
|---|---|---|
| `YOAL_CLICKHOUSE_URL` | unset | HTTP URL of the ClickHouse server. Setting it turns telemetry on. |
| `YOAL_CLICKHOUSE_USER` | `yoal` | User for writes. |
| `YOAL_CLICKHOUSE_PASSWORD` | empty | Password for the write user. |
| `YOAL_CLICKHOUSE_DATABASE` | `yoal` | Database that holds the telemetry tables. |
| `YOAL_CLICKHOUSE_READER_USER` | unset | Optional read-only user for queries. |
| `YOAL_CLICKHOUSE_READER_PASSWORD` | empty | Password for the read-only user. |

### Assistant

The assistant is on when `YOAL_ASSISTANT_MODEL` is set and `YOAL_ASSISTANT_DISABLED` is not `1`. Settings → Assistant sets the same keys.

| Variable | Default | Description |
|---|---|---|
| `YOAL_ASSISTANT_PROVIDER` | `openai-compatible` | One of `openai`, `openai-compatible`, `openrouter` or `ollama`. |
| `YOAL_ASSISTANT_BASE_URL` | set by the provider | API base URL. Defaults are `https://api.openai.com/v1` for OpenAI and compatible servers, `https://openrouter.ai/api/v1` for OpenRouter, and `http://127.0.0.1:11434/v1` for Ollama. |
| `YOAL_ASSISTANT_MODEL` | unset | Model ID to use. Setting it turns the assistant on. |
| `YOAL_ASSISTANT_API_KEY` | unset | API key for the provider. Optional for a local Ollama server. |
| `YOAL_ASSISTANT_DISABLED` | unset | Set to `1` to turn the assistant off, even when it is configured. |

### Feature flags

Each flag is set with `YOAL_FEATURE_<NAME>`. Accepted values are `1`, `true`, `on` or `yes` to enable, and `0`, `false`, `off` or `no` to disable. Any other value is ignored and the default applies. Flags are read at start-up, so restart the control plane after a change. Every flag defaults on; set one to `0` to turn that feature off. `YOAL_FEATURE_DB_CONSOLE` was removed; the control plane logs a warning and ignores it.

| Flag | Default | What it controls |
|---|---|---|
| `FUNCTIONS` | on | Deploy functions on the pinned workerd runtime. |
| `BROKERS` | on | Create managed queue brokers and attach them to apps. |
| `EMAIL` | on | Send and receive email on verified domains through Yoal's mail service. |
| `BACKUPS_RESTORE` | on | Create, restore and delete managed database backups. |
| `PITR` | on | Point-in-time recovery for PostgreSQL 18 databases. Needs the `YOAL_PITR_REPO_*` repository settings; without them PITR requests are refused. |
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
| `YOAL_DEV_PASSWORD_LOGIN` | `0` | Set to `1` to allow open sign-up with email and password and turn off the owner second factor. The process refuses to start with this set and `NODE_ENV=production`. |

A development server, started without an installed release, uses these defaults: `YOAL_PLATFORM_ORIGIN` of `http://localhost:5173`, `YOAL_CONTENT_DOMAIN` of `localhost`, and `YOAL_DATA_DIR` of `.data`. It creates its own Web Push keys in `.data/vapid.json`. It also reads settings saved from the dashboard from `.data/platform-settings.json`, which takes effect after a restart.

If `.data/clickhouse` exists, `NODE_ENV` is not `production` and no `YOAL_CLICKHOUSE_URL` is set, the development server uses the local ClickHouse started by `bun run dev:clickhouse`, on `127.0.0.1:18123`.

## Node agent

The node agent runs on every edge and worker node. It reads `yoal.env` and `agent.env`. A node that has joined has `YOAL_CONTROL_URL`, `YOAL_NODE_ID` and `YOAL_NODE_TOKEN` in `agent.env`. If those three are missing, the agent reads them from `node.json` in `YOAL_DATA_DIR`, which `yoal-agent join` writes.

### Identity and paths

| Variable | Default | Description |
|---|---|---|
| `YOAL_CONTROL_URL` | from `node.json` | Control-plane origin, for example `https://control.example.com`. Required unless `node.json` supplies it. |
| `YOAL_NODE_ID` | from `node.json` | This node's ID (`nod_…`). |
| `YOAL_NODE_TOKEN` | from `node.json` | Bearer token for this node. Treat it as a secret. |
| `YOAL_CONTROL_SOCKET` | unset | Edge only. A Unix socket path (absolute) that the agent uses to reach the control plane without going through Caddy. |
| `YOAL_DATA_DIR` | `/var/lib/yoal-agent` (installed unit: `/var/lib/yoal/agent`) | Root for cached state and releases, and the location of `node.json`. |
| `YOAL_AGENT_SOCKET` | `/run/yoal-agent/agent.sock` | Unix socket for the forward-auth and metrics endpoints. |
| `YOAL_STORAGE_STATE_FILE` | `/etc/yoal/storage.json` | Where the storage service records the paths it last applied. |
| `YOAL_STORAGE_REQUEST_FILE` | `/run/yoal/storage.request` | File the agent writes to ask the storage service to apply new paths. |
| `YOAL_HELPER_SOCKET` | `/run/yoal-helper/helper.sock` | The privileged helper's socket. See the [helper section](#privileged-helper). |

### Edge, Caddy and TLS

These settings matter on an edge node, which terminates HTTPS for the platform and for deployed sites.

| Variable | Default | Description |
|---|---|---|
| `YOAL_CADDY_ADMIN_SOCKET` | `/var/lib/caddy/admin.sock` | Caddy's admin API socket. Caddy is never reachable over TCP. The installed unit sets its own path. |
| `YOAL_CADDY_LISTEN` | `:443,:80` | Comma-separated addresses that Caddy listens on. |
| `YOAL_CADDY_ACCESS_LOG` | unset | Path to Caddy's JSON access log. When set, the agent aggregates it into telemetry. |
| `YOAL_SITE_COOKIE_COOKIE_NAME` | `__yoal_s` | Name of the session cookie on deployed sites. |
| `YOAL_PLATFORM_HOST` | unset | Host name for the dashboard, served by Caddy, for example `control.example.com`. |
| `YOAL_PLATFORM_UPSTREAM` | `unix//run/yoal/control.sock` | Where Caddy forwards dashboard requests. |
| `YOAL_CONTENT_DOMAIN` | from desired state | Overrides the content domain that the control plane sent. |
| `YOAL_TLS` | `1` when `YOAL_ACME_EMAIL` is set, otherwise `0` | Terminate TLS in Caddy with certificates from ACME. |
| `YOAL_ACME_EMAIL` | unset | Account email for the ACME provider. Required in production when TLS is on. |
| `YOAL_ACME_CA` | Caddy's default directory | ACME directory URL. Set it to use a staging or private CA. |
| `YOAL_CLOUDFLARE_API_TOKEN` | unset | Cloudflare token for DNS-01 challenges. Prefer the `_FILE` variant. |
| `YOAL_CLOUDFLARE_API_TOKEN_FILE` | unset (installer: `/etc/yoal/cloudflare.token`) | File that holds the Cloudflare token. |
| `YOAL_CERT_PROBE_ADDR` | loopback on the TLS listen port | `host:port` that the agent reads certificates from to check their expiry, or `off`. |

### Workloads and logs

| Variable | Default | Description |
|---|---|---|
| `YOAL_WORKLOAD_SLICE_MB` | `1024` | Memory budget, in MiB, for the workload slice. Allowed range 32 to 1048576. |
| `YOAL_WORKLOAD_SOCKET_DIR` | `/run/yoal-workloads` | Directory where socket-activated workloads expose their sockets. |
| `YOAL_WORKLOAD_HEALTH_TIMEOUT_MS` | `30000` | How long to wait for a workload's health check before reporting it as starting. Allowed range 1000 to 600000. |
| `YOAL_LOG_DRAIN` | `1` | Set to `0` to stop sending workload logs to the control plane. |
| `YOAL_LOG_DRAIN_INTERVAL_MS` | `2000` | How often the agent asks for new log lines. Allowed range 500 to 60000. |
| `YOAL_AGENT_INSECURE_HTTP` | `0` | Development only. Emits non-Secure cookies and `http` return URLs. The agent refuses it when `NODE_ENV=production`. |

## Privileged helper

The helper runs as root and does the work that needs root: it writes systemd units and Quadlet files, manages databases and the workload sockets, and applies node updates. Only members of the group named in `YOAL_HELPER_CONTROL_SOCKET_GROUP` (by default `yoal`, the group the agent runs as) can connect to it. The helper reads `/etc/yoal/helper.env`, and its unit does not start unless that file exists.

The installer writes these values into `helper.env`, and they override the defaults below: `YOAL_HELPER_BUN_PATH=/opt/yoal/runtime/bin/bun`, `YOAL_HELPER_RELEASE_DIRS=/var/lib/yoal/agent/releases,/opt/yoal/releases`, `YOAL_HELPER_WORKLOAD_SOCKET_GROUP=caddy`, `YOAL_HELPER_WORKLOAD_SOCKET_MODE=0660` and `YOAL_HELPER_APPARMOR_PROFILE=auto`.

### Sockets and directories

| Variable | Default | Description |
|---|---|---|
| `YOAL_HELPER_SOCKET` | `/run/yoal-helper/helper.sock` | The helper's control socket. It must not be inside the workload runtime directory. |
| `YOAL_HELPER_CONTROL_SOCKET_GROUP` | `yoal` | Group allowed to connect to the control socket. |
| `YOAL_HELPER_CONTROL_SOCKET_MODE` | `0660` | Mode of the control socket. It must not grant access to other users. |
| `YOAL_HELPER_RUNTIME_DIR` | `/run/yoal-workloads` | Root-owned runtime directory for env files, secret files and workload sockets. |
| `YOAL_HELPER_WORKLOAD_SOCKET_GROUP` | unset | Group that can connect to workload sockets, for example the Caddy group. |
| `YOAL_HELPER_WORKLOAD_SOCKET_MODE` | `0666` | Mode of workload sockets. |
| `YOAL_HELPER_STATE_DIR` | `/var/lib/yoal-workloads` | Persistent data for containers. |
| `YOAL_HELPER_UNIT_DIR` | `/etc/systemd/system` | Where generated unit files are written. |
| `YOAL_HELPER_QUADLET_DIR` | `/etc/containers/systemd` | Where Quadlet `.container` and `.network` files are written. |
| `YOAL_HELPER_RELEASE_DIRS` | `/srv/yoal/releases,/var/lib/yoal/agent/releases` | Comma-separated release roots, searched in order. |
| `YOAL_HELPER_WORKERD_DIR` | `/usr/lib/yoal/workerd` | Root of the pinned workerd installations. |

### Tool paths and update

| Variable | Default | Description |
|---|---|---|
| `YOAL_HELPER_BUN_PATH` | `/usr/local/bin/bun` | Bun binary for the default `bun run start` process command. |
| `YOAL_HELPER_NODE_PATH` | `/usr/local/bin/node` | Node.js binary for the default `node --run start` process command. |
| `YOAL_HELPER_SYSTEMCTL` | `/usr/bin/systemctl` | systemctl binary. |
| `YOAL_HELPER_JOURNALCTL` | `/usr/bin/journalctl` | journalctl binary, used to read workload logs. |
| `YOAL_HELPER_PODMAN` | `/usr/bin/podman` | Podman binary, used for database dump and restore. |
| `YOAL_HELPER_OPENSSL` | `/usr/bin/openssl` | openssl binary, used to create per-database TLS certificates. |
| `YOAL_HELPER_APPARMOR_PROFILE` | `auto` | AppArmor profile for container workloads. `auto` disables AppArmor for containers only on kernels that restrict unprivileged profile changes. `none` keeps the runtime default. Any other value is used as a profile name. |
| `YOAL_HELPER_AGENT_BINARY` | `/opt/yoal/current/agent/yoal-agent` | Agent binary that a node update replaces. |
| `YOAL_HELPER_SELF_BINARY` | `/opt/yoal/helper/yoal-helper` | Helper binary that a node update replaces. |
| `YOAL_HELPER_RELEASE_LINK` | `/opt/yoal/current` | Symlink that points at the active release. |
| `YOAL_HELPER_UPDATE_DIR` | `/var/lib/yoal-helper/node-update` | Working directory for node updates. |

Every path must be absolute. The helper refuses to start otherwise.

## Builder

The builder builds Git-based deployments. It runs as `yoal-builder.service` on any node that has been given the builder role, and it reads `agent.env`. Where systemd is available, each build runs as the `yoal-build` user in its own transient unit, with its own memory and CPU limits.

| Variable | Default | Description |
|---|---|---|
| `YOAL_CONTROL_URL` | required | Control-plane origin. |
| `YOAL_NODE_TOKEN` | required | Token of a node that has the builder role. |
| `YOAL_BUILD_DIR` | required (unit: `/var/lib/yoal-builder`) | Scratch directory for clones and build output. |
| `YOAL_GIT_TOKEN` | unset | Credential for private HTTPS repositories. It is sent only to the hosts in `YOAL_GIT_TOKEN_HOSTS`, is never written to a URL or to `.git/config`, and is never logged. |
| `YOAL_GIT_TOKEN_HOSTS` | `github.com` | Comma-separated hosts (`host` or `host:port`) that may receive `YOAL_GIT_TOKEN`. |
| `YOAL_GIT_SSH_KEY` | unset | Absolute path to a private deploy key, readable only by root, for `ssh://` and `git@host:path` repositories. It is used only while the Builder clones, and builds cannot read it. |
| `YOAL_GIT_SSH_KNOWN_HOSTS` | unset | Absolute path to a pinned `known_hosts` file for SSH clones, which turns on strict host key checking. When unset, the first clone from a host records its key in `$YOAL_BUILD_DIR/known_hosts`. |
| `YOAL_BUILDER_SYSTEMD` | `true` on Linux when `systemd-run` is present | Set to `false` to run builds as a plain child process. Use this on a development workstation. |
| `YOAL_BUILDER_USER` | `yoal-build` when running as root under systemd | User that builds run as. Set to `none` to run as the daemon's own user, which is not allowed when the daemon runs as root. |
| `YOAL_BUILDER_TIMEOUT_SECONDS` | `600` | Time limit for one build. |
| `YOAL_BUILDER_MEMORY_MAX` | `2G` | Memory limit for one build. |
| `YOAL_BUILDER_CPU_QUOTA` | `200%` | CPU limit for one build. |
| `YOAL_BUILDER_PATH` | Yoal's Bun first, then the system paths | `PATH` inside a build. |
| `YOAL_BUILDER_POLL_MS` | `5000` | How often the builder asks for work. |
| `YOAL_BUILDER_IDLE_POLL_MS` | `30000` | How often it checks again while its node does not have the builder role. |

## Dashboard-managed settings

Some settings can be changed in the dashboard, under **Settings**, instead of by editing a file. The dashboard validates the change, then asks a root-owned helper, `yoal-platform-config`, to write the values into `yoal.env` or `agent.env`. That helper restarts the services it changed, and it reports the outcome on the settings page. You do not need to run `systemctl` yourself.

| Settings page | Keys it writes |
|---|---|
| **Settings → Backups** | `R2_*` (the backup bucket and credentials), and enables or disables Litestream replication and the restore drill. |
| **Settings → Notifications** | `YOAL_SMTP_*`, the Twilio keys, the `YOAL_ALERT_*` channels, and the Web Push keys. |
| **Settings → Assistant** | `YOAL_ASSISTANT_*`. |
| **Settings → Telemetry** | Installs or removes ClickHouse and writes the `YOAL_CLICKHOUSE_*` values. |
| **Settings → Domains** | The dashboard host, content domain and HTTPS settings, and the Cloudflare token. |
| **Settings → Usage analytics** | Nothing in a file: the opt-in, install id and optional endpoint are database settings. `YOAL_USAGE_ANALYTICS_ENDPOINT` still overrides the endpoint. |

The rules that apply to these pages are:

- Only the keys listed for each section can be changed from the dashboard. Other variables, such as `YOAL_MASTER_KEY` or `YOAL_DATA_DIR`, must be edited in the file.
- Secret values are never shown again after they are saved. Leaving a secret field empty keeps the current value.
- A section must be complete before it takes effect. For example, SMTP needs a host, a port and a From address, and Twilio needs all three of its keys.

Email → Mail server is a different thing. It configures Yoal's own mail service, and it does not write any of the variables above.

> [!NOTE]
> On a development server, dashboard changes are saved to `.data/platform-settings.json` in the data directory, and they take effect after a restart of the dev server.
