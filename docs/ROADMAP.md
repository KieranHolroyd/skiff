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
- [x] Agent telemetry: pre-aggregated access buckets → DuckDB; rollups + Parquet to R2 (OTLP wire export remains)
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
- [ ] Browser setup wizard (first-user sign-up and `/api/setup/status` are backend-complete)
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
- [x] Stats: agent sampler → telemetry batch → DuckDB `db_metrics_1m/1h`, table snapshot, `/metrics`, size/connection alerts (D57)
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
- [x] On-demand DBGate 7.3.4 studio: loopback sidecar, internal gateway + platform proxy, `database:console`, read-only default, write mode with `database:update`, audited and idle-stopped (D60)
- [ ] Native table editor and query history beyond the embedded studio
- [ ] Database metrics in the Parquet archive; bulk actions and prune for databases; `restore_database` over MCP
- [ ] Cross-node access via a node private address; PITR (pgBackRest/WAL-G); MySQL/Valkey

## Managed object storage ([OBJECT-STORAGE.md](./OBJECT-STORAGE.md))
- [x] RustFS 1.0 as a tier-3 container: create, resize, soft delete, restore, purge (D62, D69)
- [x] Buckets as desired state, `public-read` policies, force delete reported through heartbeats (D65)
- [x] Attachments with scoped `SKF*` IAM users and `<PREFIX>_*` env injected at activation (D66)
- [x] Sealed root credentials, reveal for humans only (`storage:credentials`, D67); console off (D63)
- [x] Public endpoints on `<name>--s3.<contentDomain>` as byte-for-byte SigV4-only Caddy routes (D64)
- [x] Stats: agent sampler → telemetry → DuckDB `storage_metrics_1m/1h`, bucket snapshots, `/metrics`, disk alert (D68)
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

## Node volumes ([VOLUMES.md](./VOLUMES.md))
- [x] P0: `node_volumes`, per-instance `volume_id`, node default, inventory heartbeat, adopt an existing mount, fail-closed mount verification (D72, D74, D76, D78)
- [x] P0: helper `volumes.inventory`/`volumes.verify`, `<mount>/skiff/<id>` data dirs, storage/database create `volume`, REST
- [ ] P0: dashboard volumes page (adopt/set default/usage) and `--volume` on the CLI
- [ ] P1: guided local format (GPT + ext4/xfs) with plan/confirm/apply (D73, D75)
- [ ] P2: LVM and mdadm provisioning; array/pool health alerts
- [ ] P3: ZFS pools/datasets; LUKS2 with keyfile/TPM2
- [ ] P4: native NFS/CIFS creation with sealed credentials; migration between volumes (D77, D79); multi-drive RustFS
- [ ] Volume snapshots/backups, quota per volume, SMART health, instance move UI

## Later / maybe
- Backup ingress (Cloudflare Tunnel from the homelab + DNS failover)
- Importing external Prometheus datasources
- Custom roles UI
- Templates/scaffolding tool for agents
