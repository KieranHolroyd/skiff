# Skiff — Managed databases

Status: **implemented, 2026-11-05** (not yet exercised on a real Debian/Podman node; the container lockdown, monitor bootstrap, sampler SQL, backup/restore verbs and health probe were checked against `postgres:17-alpine`). Decisions are recorded in [DECISIONS.md](./DECISIONS.md) as D55–D61 and D83–D86.

A managed database is an org-owned Postgres instance that Skiff provisions, runs, observes and
connects to apps. It is not a project: it has no releases, deployments or routes. It reuses the
tier-3 runtime (DESIGN §3.4): a rootless-style Quadlet container rendered by `skiff-helper`, inside
`skiff-workloads.slice`, admitted against the node's memory budget (D41, D42).

Everything goes through `packages/core` (`DatabaseService`); REST, MCP, CLI and the dashboard stay
thin surfaces.

---

## 1. Model

| Table | Purpose |
|---|---|
| `databases` | One row per database: org, name, engine/version, resolved node, host port, memory/CPU, storage budget, status, sealed credentials, latest table snapshot, soft-delete columns. |
| `database_attachments` | Database ↔ project, with the env prefix the project receives (`DATABASE` → `DATABASE_URL`). |

- **Names** follow slug rules (3–40, `[a-z0-9-]`, no `--`) and are unique per org. The Postgres
  database and owner role are the name with `-` → `_`.
- **Engines** are a registry (`packages/contracts/src/database.ts`). v1 ships `postgres` 16 and 17.
  The registry is the seam for MySQL/Valkey later; nothing outside it hard-codes Postgres.
- **Ids** are `db_<32 hex>`. The id doubles as the workload id on the node, so the helper, the
  journal, logs and the heartbeat all use the same key.
- **Status** uses the workload vocabulary (`pending/starting/running/failed/stopped`) and is driven
  by heartbeats, like workloads.

## 2. Runtime (helper `database` profile)

The control plane sends the database to its node as a normal `WorkloadDesired` entry
(`runtime: "container"`) with an extra `database: { engine, version }` field. The helper switches
to a fixed render profile when that field is present; it never takes an image, user or mount from
the wire for a database:

- Image is derived by the helper from `engine` + `version` (`docker.io/library/postgres:<v>-alpine`).
- `User=70:70` (the image's `postgres` user); the helper creates and `chown`s the data dir. The
  container still runs with `DropCapability=all`, `NoNewPrivileges`, `ReadOnly=true`.
- `PGDATA=/data/pgdata`, `Tmpfs=/var/run/postgresql` for the socket, `TimeoutStartSec=600` for the
  first image pull.
- `PublishPort=127.0.0.1:<hostPort>:5432` only. Nothing listens on a public or WireGuard address.
- `Network=skiff-workloads.network` with `NetworkAlias=db-<id hex>`. Container apps join the same
  Podman network, so they reach the database by name.
- `MemoryMax`, `CPUQuota`, `Slice=skiff-workloads.slice` as for any workload. Databases count
  toward the node's reserved memory (admission, D42).
- The fixed `Exec=` starts Postgres with `shared_preload_libraries=pg_stat_statements` so slow
  queries work without a manual restart (D84); when pooling is enabled, a second Quadlet unit runs
  PgBouncer beside the database (D85).

The agent's health probe for a database is TCP, not HTTP: it connects to `127.0.0.1:<hostPort>`
and sends a Postgres `SSLRequest`, because Podman's port forwarder accepts connections before the
server is up. Quadlet files (`.container`, `.network`) go to `/etc/containers/systemd`
(`SKIFF_HELPER_QUADLET_DIR`); systemd units stay in `/etc/systemd/system`. Desired state always
asks for a database to run; the observed status is never echoed back, so a reported `stopped`
can't make the agent remove the unit.

Host ports are allocated per node from `15432–16431`, lowest free first, including soft-deleted
databases (a restore must get its port back).

## 3. Connecting apps (D56)

`attach` links a database to a project with an env prefix (default `DATABASE`, UPPER_SNAKE,
unique per project). At activation the consumer workload receives:

`<P>_URL`, `<P>_HOST`, `<P>_PORT`, `<P>_USER`, `<P>_PASSWORD`, `<P>_NAME`,
`<P>_SSL_MODE`, `<P>_CA_CERT` (TLS), and `<P>_POOL_URL`, `<P>_POOL_HOST`, `<P>_POOL_PORT` (pooler).
`<P>_URL` is the direct connection; the pooled URL is a separate variable so an app can choose per
query path (Prisma uses `url = _POOL_URL`, `directUrl = _URL`).

- Process app on the database's node → `127.0.0.1:<hostPort>`.
- Container app on the database's node → `db-<id hex>:5432` over `skiff-workloads` network.
- **Same node only in v1.** A project with attachments is placed on the database's node at deploy
  time (this overrides `auto`; an explicit placement on another node is rejected, as are
  attachments that live on different nodes). Cross-node access waits for a dedicated node
  private-address field, so a database never binds to an address an operator meant for something
  else (for example the edge's public IP).
- Values are injected at activation only (D18, D43): they never enter desired state, its disk
  cache, or the project's spec. The consumer's activation version includes a hash of its
  attachments, so attach/detach re-activates (restarts) the app without a redeploy.
- **Suggestions and one-click linking.** The runtime editor lazily loads the dashboard route
  `GET /projects/:slug/env-suggestions`, which merges the names above with organisation secrets
  and names found in the deployment's `.env*` files and source. Injected names are marked as such
  (adding them to the spec would shadow the real value). If the code expects a name like
  `DATABASE_URL`, the editor offers to link an unattached database under the inferred
  `DATABASE` prefix; the attach action then makes the whole `<P>_*` group available at the next
  start. Only names are scanned and returned, never `.env` values.

## 4. Credentials (D58)

- The control plane generates an owner password and a monitor password on create, sealed with the
  org data key (envelope encryption, D18).
- `GET /api/v1/databases/:name/credentials` reveals the direct URL, the pooled URL (when enabled),
  `sslmode`, the public CA PEM (never the private key) and copy-paste snippets for psql, Prisma,
  Drizzle, Kysely, Django, Rails, Go `pgx` and node-postgres. It needs `database:credentials`,
  which is never pre-ticked for agents, and every read is audited.
- **MCP never returns credentials.** Agents get the URL injected into the apps they deploy, which
  is all they need.
- Rotation is a follow-up (needs `ALTER ROLE` from the agent plus a re-activation of consumers).

## 5. Observability (D57)

The agent samples every running database once a minute with Bun's built-in Postgres client,
connecting as `skiff_monitor` (`pg_monitor` only). On the first healthy start the agent creates that
role with the owner credentials from the activation payload, then keeps only the monitor
credentials, in memory. Credentials are never written to the agent's disk.

**Time series → DuckDB** (`db_metrics_1m`, rolled up hourly into `db_metrics_1h`, same retention
and pruning as traffic): per database and minute,

| Kind | Fields |
|---|---|
| Gauges | `size_bytes`, `connections_active`, `connections_idle`, `connections_total`, `max_connections`, `memory_bytes` (container), `up`, `pooler_up`, `pool_active`, `pool_idle`, `pool_waiting`, `pool_saturation`, `pool_avg_wait_ms` |
| Counters (per-minute deltas) | `xact_commit`, `xact_rollback`, `tup_returned`, `tup_fetched`, `tup_inserted`, `tup_updated`, `tup_deleted`, `blks_hit`, `blks_read`, `deadlocks`, `temp_bytes` |

Counters are sent as deltas the agent computes from `pg_stat_database`; a stats reset or restart
(negative delta) sends the raw value instead. Rollups sum counters, average connection gauges and
take the max of size and memory.

**Snapshot → SQLite**: every five minutes the agent also sends the top 50 tables (schema, name,
estimated rows, total bytes, sequential/index scans, last autovacuum/autoanalyze). Only the latest
snapshot is kept (`databases.stats_json`); history isn't needed for "what's in my database".

Both ride the existing `POST /api/agent/telemetry` batch as an additive `databases` field. The
control plane drops samples for databases that are not placed on the reporting node.

When the pooler is enabled, the same one-minute sample also opens a short-lived connection to
PgBouncer's admin console on loopback and runs `SHOW POOLS` and `SHOW STATS` (the database owner
is an `admin_users` entry). A failed pooler sample records `pooler_up=0` and leaves the Postgres
sample intact. Pool saturation is `(active + waiting) / max_client_conn` (200).

Surfaces: `GET /api/v1/databases/:name/metrics`, charts and a tables list on the dashboard,
`skiff_database_*` series on `/metrics`, and three alerts (size above 85% of the storage budget,
connections above 90% of `max_connections`, pool saturation above 90%).

## 6. Lifecycle

- **Create** resolves placement once (`auto` → the node with the most free budget, like apps) and
  allocates the host port. The node pulls the image and initialises the cluster.
- **Update** changes memory, CPUs or storage budget (admission re-checked). Engine major version
  changes are not supported in place (needs dump/restore).
- **Delete** is soft for 7 days (D29). It is refused while projects are attached. The container
  stops; the data dir stays on the node so **restore** brings it back intact.
- **Purge** (after 7 days, or explicitly with `database:delete` from the dashboard/CLI): desired
  state lists the id under `databasePurges`; the agent calls the helper's fixed `purge` verb, which
  removes only `<stateDir>/<id>`, then reports it, and the control plane deletes the row.

**Data location.** By default the data dir lives under the helper's state root. A database can
instead be placed on a node volume (`volume` on create, or the node's default volume); its data
then lives at `<mount>/skiff/<id>` (D74, D78), and the node refuses to start it when the mount is
missing (D76). See [VOLUMES.md](./VOLUMES.md).

## 7. Surfaces

| Surface | What |
|---|---|
| REST | `GET/POST /api/v1/databases`, `GET/PATCH/DELETE /api/v1/databases/:name`, `POST …/:name/restore`, `GET …/:name/credentials`, `GET …/:name/metrics`, `GET …/:name/logs`, `GET/POST …/:name/backups`, `GET/DELETE …/:name/backups/:id`, `POST …/:name/backups/:id/restore`, `GET/PATCH …/:name/backup-policy`, `GET/POST …/:name/rotate`, `POST …/:name/restart`, `GET/POST /api/v1/projects/:slug/databases`, `DELETE …/databases/:name` |
| MCP | `list_databases`, `get_database`, `create_database`, `attach_database`, `detach_database`, `delete_database` (confirmed, soft), `list_database_backups`, `backup_database`, `restore_database`, `set_database_backup_policy`, `rotate_database_credentials`, `restart_database`, `get_database_logs` |
| CLI | `skif db list\|create\|info\|attach\|detach\|delete\|restore\|credentials\|logs\|backups\|backup\|backup-delete\|restore-backup\|backup-policy\|rotate\|restart` |
| Dashboard | Databases list + create, detail (status, connection, pooler, attached projects, charts, tables, extensions/slow queries, backups/restore, rotate, restart, logs), attach from a project |

## 8. Backups and restore (D83)

Every database has a policy (`backup_enabled`, five-field UTC cron, `backup_retention_days`,
default daily 03:00 and 7 days). The maintenance sweep queues a `database_backups` row when
`next_backup_at` is due; a manual backup queues one immediately. A pending/running backup is never
duplicated.

- The node sees `databaseBackupTasks` in desired state with a **presigned PUT** URL. The agent
  calls the helper's fixed `pg_dump -Fc` verb, streams the dump straight to the object store while
  hashing it, and reports size + SHA-256 on its next heartbeat. The dump never touches the
  control plane and never enters desired state.
- Restore is **always into a new database** (`POST /databases/:name/backups/:id/restore`), with new
  credentials, a fresh port, and the same placement rules as create. The target is marked
  `pendingRestoreId`; the node streams the artifact into `pg_restore --clean --if-exists
  --no-owner --exit-on-error` and runs `SELECT 1` before reporting success. Only then is the
  backup marked verified (`verified_at`, `restored_database_id`) and scheduled backups resume.
- Retention deletes expired artifacts and their objects, but never a pinned backup or the newest
  good backup. `skif db backups|backup|restore-backup|backup-policy` and the dashboard Backups panel
  expose the same service methods as REST/MCP.

The local filesystem object store buffers uploads and enforces the 500 MB artifact limit; R2 gets a
direct presigned PUT with no buffering. A production install should use R2 for large databases.

PITR (pgBackRest WAL archiving and restore-to-time) is a separate, flag-gated path documented in
[PITR.md](./PITR.md). It is not enabled by default and logical backups remain the supported restore
path until a real restore drill passes.

## 9. Extensions and slow queries (D84)

`extensions` is an allowlist (`pg_stat_statements`, `pg_trgm`, `pgcrypto`, `citext`, `hstore`,
`unaccent`, `pg_cron`, `pgvector`, `postgis`). The helper preloads `pg_stat_statements`; the agent
creates requested extensions idempotently after the monitor role is bootstrapped. An extension the
pinned image does not ship fails softly and is logged; it does not stop the database.

The five-minute snapshot also carries the top 50 `pg_stat_statements` rows (query id, normalized
SQL, calls, total/mean time, rows, shared/temp blocks) when the extension is enabled. The control
plane keeps the latest snapshot in SQLite; the dashboard shows it in **Extensions & slow queries**.
Removing an extension from the list never drops it automatically.

## 10. Connection pooling and TLS (D85)

New databases get a transaction-mode PgBouncer sidecar by default. The helper renders a second
Quadlet unit with a loopback-only `PublishPort`, the `skiff-workloads` network, a 0600 config and
userlist owned by the image's uid 70, and the fixed `edoburu/pgbouncer` digest. It is deliberately
separate from the Postgres unit: a pooler crash leaves direct connections working.

Attachments receive `<PREFIX>_POOL_URL`, `<PREFIX>_POOL_HOST` and `<PREFIX>_POOL_PORT` in addition
to the direct values. `<PREFIX>_URL` / `<PREFIX>_DIRECT_URL` always point at Postgres directly.

**Pooler limitations.** Transaction mode is wrong for anything that needs one session:
migrations and schema tools, `pg_dump`/`pg_restore`, logical replication, `LISTEN`/`NOTIFY`,
advisory locks, cursors held across transactions, `SET`/temp tables used across statements, and
prepared statements. Use the direct URL for those. The credentials response and the dashboard show
both URLs and a "use direct for migrations" note.

### TLS

`SKIFF_FEATURE_DB_TLS` (default off) asks the helper to generate a per-database CA and server
certificate with the host's fixed `openssl` argv. Files live at
`/run/skiff-workloads/<id>/tls/{ca.crt,server.crt,server.key}`, are `0400`, and are handed to the
image's uid/gid 70. The Postgres unit mounts that directory read-only at `/run/skiff-tls` and starts
with `ssl=on`, `ssl_cert_file`, `ssl_key_file` and `ssl_min_protocol_version=TLSv1.2`.

- `<PREFIX>_URL` / `<PREFIX>_POOL_URL` carry `?sslmode=require`. PgBouncer mounts the same
  certificate and requires client TLS (`client_tls_sslmode = require`), so the pooled hop is
  encrypted too; it still connects to Postgres inside the private container network.
- `<PREFIX>_CA_CERT` carries the public CA PEM for process apps; `<PREFIX>_SSL_MODE` is `require`.
  Container env files cannot carry multi-line values, so container apps use `sslmode=require` or
  read the CA from the credentials response (the PEM is public).
- `GET /credentials` returns `sslmode`, `caPem` (not a secret), `directUrl`, `poolerUrl` and
  snippets. Use `sslmode=verify-full` with `sslrootcert=ca.pem` when the client supports hostname
  verification; `require` is the compatible default because clients reach the database by loopback
  or the container alias.
- If certificate generation fails, the helper logs the error in `tls/error`, starts Postgres without
  TLS, and the database view shows a warning. A certificate bug never blocks startup.
- The private key never enters desired state, heartbeats, logs or the credentials response; only
  the CA PEM is relayed. TLS state is derived from the helper's files, so there is no schema column.

The pinned Postgres image does not generate certificates, so Debian's `openssl` is a helper
dependency (`SKIFF_HELPER_OPENSSL`, default `/usr/bin/openssl`).

## 11. Credential rotation (D86)

`POST /databases/:name/rotate` (owner or monitor) generates a new password, seals it in a
`database_rotations` row and puts a `databaseRotations` task in desired state. The agent fetches
the new value from the node-authenticated endpoint just before `ALTER ROLE` (SQL over stdin, never
argv) and verifies a fresh connection. Only after the node reports success does the control plane
replace the live secret and bump the activation version, which restarts attached apps with the new
value. A failed rotation leaves the old secret in place and records the error.

## 12. Restart controls (D87)

- **Restart database** bumps `databases.restart_generation`, which is folded into the activation
  version. The agent re-fetches the activation and re-applies the unit, so the container and its
  PgBouncer sidecar restart together without a config change.
- **Restart pooler** sets `pooler_restart_requested_at`; the node sees the id in
  `databasePoolerRestarts`, calls the helper's dedicated fixed verb (`systemctl restart` on the
  pooler unit only), and acknowledges it on the next heartbeat. Postgres connections are untouched.
- Both actions require `database:update`, are audited, and are exposed as
  `POST /databases/:name/restart` (`{ target: "database" | "pooler" }`), `skif db restart <name>
  [--pooler]`, the MCP `restart_database` tool, and the dashboard Resources/Pooler controls.
- **Bulk actions** are on the Databases page header: **Restart all services** (databases and
  storage), **Restart all databases**, and **Back up all databases**. They fan out to the same
  per-item methods and return per-item skips. REST: `POST /services/restart`
  (`{ scope: "all" | "databases" | "storage", databases?, storage? }`) and
  `POST /services/backup-databases`; MCP: `restart_services`, `backup_all_databases`; CLI:
  `skif db restart --all`, `skif db backup --all`, `skif storage restart --all`.

## 13. Logs

The agent already drains every workload's journald output, including managed database units. The
control plane stores those lines in `service_log_events` (`kind = database`, scoped to the
database id, org and node) with the same 7-day retention as runtime logs. Lifecycle breadcrumbs
(restart and rotation requests) are written into the same stream.

Surfaces: `GET /api/v1/databases/:name/logs` (`after`, `limit`, `level`, `q`), the dashboard live
tail at `/databases/:name/logs` (pause, level filter, search, download, clear view), `skif db logs
<name> [--follow]`, and the MCP `get_database_logs` tool. Reading needs `logs:read` plus
`database:read`; the API route resolves the database through the normal service permission check.

## 14. Follow-ups (on the roadmap)

- On-demand SQL console: an open-source admin UI (pgweb or Adminer) as a short-lived container on
  the database's node, behind `platform` access, `database:console`, audited, idle-stopped (D60).
- Cross-node access via a node private address; more engines (MySQL, Valkey); bulk actions and
  prune for databases; fully automated PITR drills (see [PITR.md](./PITR.md) for the current
  foundation and remaining gaps).
