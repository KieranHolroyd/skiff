# Skiff — Roadmap

> **Execution plans:** the data-platform work is broken into 20 independently assignable plans with
> a dependency graph, file ownership, and a parallel build order in
> [docs/build-plan/README.md](./build-plan/README.md).

## v0: Spikes (de-risk first). Results: [SPIKES.md](./SPIKES.md)
- [x] DuckDB (`@duckdb/node-api`) under Bun: ingest + time-bucket query + Parquet export
- [x] Better Auth MCP/OAuth provider: CIMD + DCR, PKCE, consent with permission subsets, scope step-up (e2e 15/15)
- [x] MCP human confirmation via multi-round-trip input (2026-07-28); dashboard hand-off for 2025-era clients
- [x] Caddy admin API over a unix socket: route upsert, `forward_auth` → agent, `precompressed br gzip`
- [x] SvelteKit 3 + adapter-bun (unix socket behind Caddy) + shadcn-svelte
- [ ] Litestream → R2 + scripted restore (needs R2 credentials)
- [ ] Re-measure RSS on Debian 13; connect real Claude Code / Claude.ai to a deployed instance

## v1: Static platform
**Foundation**
- [x] Monorepo: `control-plane`, `agent`, `cli`, `contracts`, `core`, `site-config`, `db`
- [x] Drizzle schema: orgs, members, roles, projects, uploads, releases, config snapshots, deployments, nodes, share links, audit log, quotas, domains (table only)
- [x] Service layer with RBAC checks used by every surface

**Nodes**
- [x] Agent: desired-state pull, on-disk cache, heartbeat, static driver (atomic release symlinks)
- [x] Caddy management via admin API (unix socket), wildcard DNS-01 cert
- [x] Node join flow (`skiff-agent join`), single-node mode over a unix socket; WireGuard itself is host provisioned
- [x] Edge proxy failures serve a branded 503 + `Retry-After` (active health checks and static mirror remain v2)

**Deploy**
- [x] Upload sessions: inline `deploy_files` (≤5 MB) and presigned R2 upload
- [x] Finalize: limits, `_redirects` / `_headers` / `skiff.json` parse + compile, sha256, precompress
- [x] Deployments with preview URLs, production pointer, promote/rollback, retention GC
- [x] Slug rules, reserved names, collision suggestions, rename redirects

**Access**
- [x] Better Auth: passkeys, GitHub, 2FA, orgs + access control, admin, API keys, OAuth provider
- [x] Owners must prove a passkey or TOTP per session, including after GitHub / magic-link sign-in (D10)
- [x] Settings → Members: invite, cancel, change role, remove (last owner protected)
- [x] Protected sites (`public / password / platform`) via `forward_auth` → agent
- [x] Share links with limits + revocation push
- [x] Two-domain and shared-domain modes (with mandatory hardening)

**MCP & CLI**
- [x] MCP server: tools per DESIGN §6.3, annotations, resources/guides, elicitation for deletes
- [x] `skif` CLI (npm `skif`, commands `skif` + `skiff`): login, deploy (presigned), status

**Ops**
- [x] Agent telemetry: pre-aggregated access buckets → ClickHouse (DuckDB until D101); rollups + Parquet to R2 (OTLP wire export remains)
- [x] Observability dashboards (D101): see [Observability & dashboards](#observability--dashboards-d101-opsmd-36)
- [x] Dashboard: fleet, projects, deployments, traffic/errors, audit log (live logs arrive with v2 runtime)
- [x] Prometheus `/metrics` on control plane and agents (optional OTLP exporter remains)
- [x] Alerts: email (SES SMTP) + webhook; node offline > 2 min, disk > 85%, backup/drill failure (`OnFailure=` → `skiff-alert`)
- [x] Cert expiring < 14 d (agent TLS probe) and 5xx spike after promote; drill results in Settings → Backups
- [x] Backups: Litestream → R2, restore script, monthly restore drill, installed and enabled by the installer when R2 + the `litestream` binary are present
- [x] Recovery kit: `skiff-recovery-kit` (age passphrase format), offered at install, `skiff-restore --recovery-kit`

**Release**
- [x] CI: signed releases (control plane, agent, prebuilt Caddy)
- [x] `install.sh` (builds from the source tarball on the host; snapshots the DB and keeps existing settings on re-run)
- [ ] Installer consumes and verifies the signed release bundle with a pinned key (today the signed artifacts are published but not used at install time)
- [x] Browser setup wizard: token-gated owner creation, instance checks, passkey or authenticator enrolment (D102; domains/Cloudflare/R2/SMTP stay in the installer and Settings)
- [x] Optional domains: IP + sslip.io installs over HTTP, and Settings → Domains to add or change domains and HTTPS with verify-or-revert (D105)
- [ ] Self-update with snapshot, migrations, health check, auto-rollback (installer upgrade path + rollback exist; in-process updater pending)

## v2
- [ ] Tier 2 process apps (sandboxed systemd units, privileged helper, socket activation), placeable on any node including the edge (D41)
- [ ] `skiff-workloads.slice` budget per node, deploy-time admission, runtime-aware `auto` placement
- [ ] Env vars & secrets UI/API/MCP (design already in place)
- [ ] Tier 3 containers (Podman Quadlet)
- [ ] Git builds on the homelab Builder + GitHub webhooks
- [ ] Custom domains (TXT verify, on-demand TLS, Cloudflare auto-records, apex↔www)
- [ ] `ObjectStore`: local fs, Garage/MinIO, multi-target replication
- [ ] Optional `docker` runtime driver
- [ ] Named environments (staging, …)
- [x] Dashboard surfaces for environments, workloads, builds, domains and fleet capacity

## Mass actions & prune ([OPERATIONS.md](./OPERATIONS.md))
- [x] Trash cascade fixes: owned rows, domains + Cloudflare records, stale workload reservations, snapshot GC, `cleanupRows` wired
- [x] Operation primitive (plan → apply, resumable, SSE progress) with bulk delete / restore / purge
- [x] Prune (org + platform scope, incl. unreferenced stored objects via `ObjectStore.list`)
- [x] Dashboard: bulk selection, Trash, Undo, Settings → Maintenance, operation detail
- [x] CLI: `projects delete|restore|trash|purge`, `prune`, `operations`
- [x] MCP: `delete_projects`, `restore_projects`, `get_operation`
- [ ] More bulk actions: pause/resume, set access, set placement, redeploy (§3.1)
- [ ] Scheduled plan-only prune with a notification when it finds something
- [ ] Agent-side release cache prune (`node_caches`)

## Managed databases ([DATABASES.md](./DATABASES.md))
- [x] Postgres 16/17 as tier-3 containers: create, resize, soft delete, restore, purge (D55, D59, D61)
- [x] Attach to projects with `<PREFIX>_URL` injected at activation; same-node placement (D56)
- [x] Sealed credentials, reveal for humans only (`database:credentials`, D58)
- [x] Stats: agent sampler → telemetry batch → ClickHouse `db_metrics_1m/1h`, table snapshot, `/metrics`, size/connection alerts (D57)
- [x] REST, MCP, CLI (`skif db`), dashboard list/detail/charts/attach
- [ ] End-to-end on a Debian 13 node: Quadlet `.container`/`.network` from `/etc/containers/systemd`, installer installs/checks Podman ≥ 5 with netavark
- [ ] Per-org Podman networks (today every container on a node shares `skiff-workloads`; databases still need a password)
- [x] Backups: scheduled/manual `pg_dump -Fc` → `ObjectStore`, retention, restore into a new database with verification (D83)
- [x] Extensions allowlist (`pgvector`, PostGIS, `pg_trgm`, `pgcrypto`, `citext`, `hstore`, `unaccent`, `pg_cron`) and `pg_stat_statements` slow queries (D84)
- [x] PgBouncer transaction pooler sidecar with `<PREFIX>_POOL_URL` (D85)
- [x] Owner/monitor credential rotation with node-side `ALTER ROLE` and verified swap (D86)
- [x] Restart controls for the database (container + pooler) and the pooler alone (D87)
- [x] Bulk actions: restart all services/databases/storage and back up all databases
- [x] Database container logs: drained journal, `GET /databases/:name/logs`, dashboard tail, `skif db logs`, MCP `get_database_logs`
- [ ] TLS in transit with a per-node CA and `sslmode=require` URLs
- [x] On-demand studio: `database:console`, read-only default, write mode with `database:update`, audited and idle-stopped (D60's sidecar, replaced by D96)
- [x] Native table editor and query history: per-engine studio plugins in the on-demand `skiff-studio` process, grid edits with conflict checks, read-only principal, browser query history; the D60 sidecar removed (plan 22, D96)
- [x] Structure editing in the studio: typed `alter` op with dry-run review for tables, columns, indexes, collections, fields and keys on all six engines (plan 22, DATABASES.md §14)
- [ ] Database metrics in the Parquet archive; bulk actions and prune for databases; `restore_database` over MCP
- [x] More engines: MySQL, MariaDB, MongoDB, Valkey and Redis with create/attach/credentials/rotation/studio/logs; logical backups for MySQL, MariaDB and MongoDB (D95)
- [ ] Engine parity: metrics samplers, TLS, named credentials and backups for Valkey/Redis (RDB), ClickHouse as a seventh engine
- [ ] Cross-node access via a node private address; PITR (pgBackRest/WAL-G)

## Managed object storage ([OBJECT-STORAGE.md](./OBJECT-STORAGE.md))
- [x] RustFS 1.0 as a tier-3 container: create, resize, soft delete, restore, purge (D62, D69)
- [x] Buckets as desired state, `public-read` policies, force delete reported through heartbeats (D65)
- [x] Attachments with scoped `SKF*` IAM users and `<PREFIX>_*` env injected at activation (D66)
- [x] Sealed root credentials, reveal for humans only (`storage:credentials`, D67); console off (D63)
- [x] Public endpoints on `<name>--s3.<contentDomain>` as byte-for-byte SigV4-only Caddy routes (D64)
- [x] Stats: agent sampler → telemetry → ClickHouse `storage_metrics_1m/1h`, bucket snapshots, `/metrics`, disk alert (D68)
- [x] REST, MCP, CLI (`skif storage`), dashboard list/detail/charts/buckets/attach
- [x] Explicit restart control: dashboard, REST (`POST /storage/:name/restart`), `skif storage restart`, MCP `restart_storage` (D82)
- [x] RustFS logs: agent journal drain → `service_log_events`, live dashboard tail, `GET /storage/:name/logs`, `skif storage logs --follow`, MCP `get_storage_logs`
- [ ] Database logs surface (the drain and storage are shared; only the UI/API are missing)
- [x] Control-plane object browser: list, upload, download, delete, folder markers, presigned links for public instances, REST + dashboard + `skif storage objects` (D82)
- [x] MCP object tools: `list_objects`, `presign_object`, `create_object_folder`
- [ ] Object delete over MCP (confirmed) and bulk folder delete in the dashboard
- [ ] End-to-end on a Debian 13 node: RustFS container under Quadlet, health probe, SigV4 through edge → WireGuard → worker
- [ ] Backups: bucket replication/sync to the platform `ObjectStore`, retention, restore into a new instance (D70, S9)
- [ ] Human access keys with bucket grants and rotation in the dashboard
- [ ] Per-bucket quotas, lifecycle rules, CORS, custom domains for public instances, Garage as a second engine
- [ ] Bulk actions and prune for storage; `S3ObjectStore` replication target (D71)

## Managed queue brokers ([BROKERS.md](./BROKERS.md), D111)
- [x] NATS 2.12/2.11 with JetStream as a tier-3 container: create, resize, forward-only upgrade, restart, soft delete, restore, purge
- [x] Helper-owned profile: own registry, `mq_` ids, helper-written config (single ACL user, capped stores), `GOMEMLIMIT`, loopback-only port
- [x] Agent: `brokers` capability, NATS `INFO` health probe, `brokerPurges`/`purgedBrokers`
- [x] Attachments inject `<PREFIX>_URL/_HOST/_PORT/_USER/_PASSWORD` (default `NATS`) and pin the app's node
- [x] REST, MCP (`list/get/create/update/restart/attach/detach_broker`, `get_broker_logs`), CLI (`skif broker`), dashboard Queues pages, logs
- [ ] End-to-end on a Debian 13 node: NATS under Quadlet with a read-only root as uid 4222, JetStream publish/consume through an attached app
- [x] Function queues on brokers (D112): JetStream-backed `queue` bindings and `triggers.queues` consumers, agent delivery with per-message verdicts, retries, delays and dead-letter queues; replaces the node-local Durable Object broker
- [ ] Queue view: streams, backlog and dead letters per broker in the dashboard; a `skif broker queues` command
- [ ] RabbitMQ as the second engine (registry entry + helper profile; AMQP probe; management UI off)
- [ ] Metrics sampler (`/varz`, `/jsz` on a loopback monitor port) → ClickHouse, stream/consumer listing in the dashboard, store-full alert
- [ ] Per-attachment users with subject permissions; cross-node endpoints (C2); backups (stream snapshots); bulk actions and prune; project-page attach panel

## Languages ([FUNCTIONS.md §4.13](./FUNCTIONS.md), D121)
- [x] WebAssembly languages on functions (Rust/workers-rs, Go/TinyGo, C/C++, Zig): a JS entry importing `.wasm`, bundled as `CompiledWasm`
- [x] Python Workers on the pinned workerd: `.py` main, `python_modules/` vendoring, `skiff-shim` Worker over a `USER` binding (`fetch`, cron and queue events), 384 MB default
- [x] Pyodide cache warmed by the installer and convergence; `functions-python` capability gates placement
- [x] Process apps scale to zero (`idleStopSeconds`, socket activation, dashboard field)
- [x] PHP via FrankenPHP on an inherited socket: pinned, digest-checked, opt-in `--with-php`; `examples/php-frankenphp`
- [ ] Verify on a Linux node under the helper sandbox: a FrankenPHP process app through its idle stop and cold start, and a Python function host
- [ ] Python memory snapshots (`--python-load-snapshot`) to cut the ~1.2 s cold start
- [ ] `skif` command for the workload spec (command, memory, idle stop); today it is the dashboard or `PUT /projects/:slug/workload`
- [ ] A socket adapter for servers that cannot adopt fd 3 (Bun today), so they can scale to zero too

## Email ([EMAIL.md](./EMAIL.md), D114–D120)
- [x] E0 spike: `smtp-server` STARTTLS/465/AUTH, `mailauth` DKIM and `mailparser` under Bun 1.4; port 25 egress from the prod IP (SPIKES.md §6); KumoMTA dropped for Skiff's own MTA (D115)
- [ ] E0 delivery check: PTR for the prod IP, then DKIM/SPF/DMARC pass at Gmail and Outlook
- [x] E1 MTA: `packages/mail` (`skiff-agent mail`): spool, retries/expiry, MX delivery, shaping, classification, DKIM signing, submission 587/465, port 25 for bounces and ARF, control socket; static `skiff-mail.service`; helper start/stop/cert verbs
- [x] E1 control plane: migration 0050, `EmailService` (domains + DKIM + Cloudflare TXT/MX, platform records, outbox, send, credentials + `SMTP_*` attach env, suppression incl. platform list, sandbox/limits/auto-pause, message log, sweeps), agent routes, agent bridge, Caddy certificates for `smtp.`/`mx.`
- [x] E1 surfaces: REST, MCP, CLI (`skif email`), dashboard Email pages and Settings → Email
- [ ] E1 remaining: automated preflight (port 25, FCrDNS, blocklists), ClickHouse `email_events`, built-in alert kinds in Settings → Alerts, an admin list of org email states
- [ ] E2: inbound routes (function `email()` handler synchronous in `DATA`, webhook, bucket), `send_email` binding, tenant webhooks, address identities
- [ ] E3: custom MAIL FROM, ed25519, MTA-STS/TLS-RPT, DMARC reports, smarthost relay (SES BYODKIM), rspamd, templates, tracking, hosted unsubscribe
- [ ] E4: several mail nodes, weighted MX, spool handover

## Observability & dashboards (D101, [OPS.md §3.6](./OPS.md))
**Telemetry store**
- [x] ClickHouse replaces embedded DuckDB: HTTP client (no native addon), ReplacingMergeTree tables, `*_hourly` views, same retention/rollups/Parquet archive
- [x] Optional and off by default: Settings → Telemetry install/remove (root helper action `telemetry`), installer Yes/No prompt after the domains (`--clickhouse`), updater only maintains an installed store
- [x] Calm "not installed" states on traffic, database and storage pages; owners get a link to Settings → Telemetry
- [ ] Measure idle/peak RSS on a 4 GB Linux VPS and tune `max_server_memory_usage`, caches and merge pools from real numbers
- [ ] Run the installer/updater/helper ClickHouse paths in the systemd e2e harness (OrbStack container) in CI
- [ ] Query the R2 Parquet archive from dashboards (`s3()` table function) for ranges past 90 days

**Dashboards**
- [x] Saved, org-scoped, versioned dashboards; REST `/api/v1/observability/*` (API.md)
- [x] Query builder (datasets, measures, group-by, filters, auto interval) scoped to the caller's projects/databases/storage; admin-only SQL with Grafana-style macros as the read-only `skiff_reader`
- [x] Grafana-style UI: 24-column grid, time/refresh pickers, variables, panel editor, Explore, starter templates
- [ ] Shared templates: the UI's "new from template" uses `dashboardTemplates` from @skiff/contracts (one source with the agent tools)
- [x] Alert rules (D109, [ALERTS.md](./ALERTS.md)): builder/SQL query + threshold + `for`/keep-firing/no-data, per-series state, grouped notifications through the existing notifiers, silences, acks, history, outage templates, "Create alert" on panels, MCP tools
- [ ] Draw firing periods as annotations on dashboard time series; per-org notification channels
- [ ] Dashboard links and drill-downs (panel → project/database page, click a host to filter)
- [ ] Annotations: deploys, promotions and rollbacks drawn on time series
- [ ] Public/read-only share links for a dashboard (reuse share-link machinery)
- [ ] Grafana JSON import for simple panels

**Agents (MCP + dashboard assistant)**
- [x] Tools: `describe_telemetry`, `query_telemetry`, `list_dashboards`, `get_dashboard`, `create_dashboard`, `add_dashboard_panels`, `update_dashboard_panel`, `remove_dashboard_panels`, `update_dashboard`, `delete_dashboard` (DESIGN §6.3)
- [x] One-call creation: templates (`traffic`, `databases`, `storage`) plus panel drafts `{title, viz, query, unit, size}`; panels are laid out automatically, so agents never place grid cells
- [x] Every query is checked against the catalog before saving (errors name the panel), and results include a link plus a per-panel data preview
- [x] Dashboards and panels addressable by id or exact title; read-modify-write with one automatic retry on a version conflict
- [x] The assistant's Platform agent has the tools and a build recipe; the router sends "make me a dashboard" there; `delete_dashboard` needs a click (chat) or elicitation (MCP)
- [ ] `suggest_dashboard`: propose panels for a project/database from what it actually reports (no hand-written queries at all)
- [ ] Natural-language panel edits in the panel editor ("show this per host", "make it p95") through the assistant
- [ ] MCP resource `skiff://dashboards/{id}` and a prompt template for "build a dashboard for …"
- [ ] Per-panel `explain` tool: summarise what a panel shows over a range (trends, spikes) for incident triage

## Node volumes ([VOLUMES.md](./VOLUMES.md))
- [x] P0: `node_volumes`, per-instance `volume_id`, node default, inventory heartbeat, adopt an existing mount, fail-closed mount verification (D72, D74, D76, D78)
- [x] P0: helper `volumes.inventory`/`volumes.verify`, `<mount>/skiff/<id>` data dirs, storage/database create `volume`, REST
- [ ] P0: dashboard volumes page (adopt/set default/usage) and `--volume` on the CLI
- [ ] P1: guided local format (GPT + ext4/xfs) with plan/confirm/apply (D73, D75)
- [ ] P2: LVM and mdadm provisioning; array/pool health alerts
- [ ] P3: ZFS pools/datasets; LUKS2 with keyfile/TPM2
- [ ] P4: native NFS/CIFS creation with sealed credentials; migration between volumes (D77, D79); multi-drive RustFS
- [ ] Volume snapshots/backups, quota per volume, SMART health, instance move UI

## Clustering & HA ([CLUSTERING.md](./CLUSTERING.md), D107)
- [ ] C0: hardware report and derived labels, zones/roles/labels, volume classes, constraint placement with explained refusals, CPU budget, Topology page and blast radius
- [ ] C1: Skiff-managed overlay (plan 23) generalised to hubs + LAN mesh; `private_address`; peer health
- [ ] C2: node CA + mTLS, loopback service endpoints (`caddy-l4` or Bun forwarder), cross-node database/storage attachments
- [ ] C3: cluster shares (NFS/SMB) mounted on demand, `backing: share`, blast-radius inheritance
- [ ] C4: HTTP replicas across nodes, spread, health-checked load balancing, rolling deploys, drain, opt-in failover, singletons with run leases
- [ ] C5: every ingress node a full edge, `dns-failover` driver, distributed certificates
- [ ] C6: control-plane warm standby, Litestream follow, lease + epoch fencing, manual promote
- [ ] C7: Postgres streaming replicas, read URLs, lag, manual promote/switchover, replica-based moves
- [ ] C8: automatic failover (control plane, Postgres), self-fencing, failover drills, chaos harness
- [ ] C9: RustFS bucket replication, Litestream for SQLite apps, app-volume snapshot shipping, Skiff-served NFS
- [ ] C10: MongoDB replica sets, Valkey/Redis and MySQL/MariaDB replicas
- [ ] Ingress drivers `cloudflare-lb` and `cloudflare-tunnel` (homelab as an ingress behind CGNAT)

## Later / maybe
- Importing external Prometheus datasources
- Custom roles UI
- Templates/scaffolding tool for agents
