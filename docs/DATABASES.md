# Skiff — Managed databases

Status: **implemented, 2026-11-05** (not yet exercised on a real Debian/Podman node; the container lockdown, monitor bootstrap, sampler SQL, backup/restore verbs and health probe were checked against `postgres:17-alpine`). Decisions are recorded in [DECISIONS.md](./DECISIONS.md) as D55–D61 and D83–D86.

A managed database is an org-owned database instance (PostgreSQL by default; MySQL, MariaDB,
MongoDB, Valkey or Redis on request, §17) that Skiff provisions, runs, observes and connects to apps. It is not a project: it has no releases, deployments or routes. It reuses the
tier-3 runtime (DESIGN §3.4): a rootful Quadlet container rendered by `skiff-helper`, inside
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
- **Engines** are a registry (`packages/contracts/src/database.ts`): `postgres` 16/17, `mysql`
  8.4/9.7, `mariadb` 11.4/11.8, `mongodb` 8.0/9.0, `valkey` 8.1/9.1 and `redis` 8.8/8.10. Each
  engine declares what it supports; see §17.
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

- **Connect as.** By default the app connects as the built-in owner. `attach` takes an optional
  `credential` (a `dbc_…` id, or `app`/`readonly`/`backup` when exactly one ready credential has
  that role; Postgres only, §16): `<P>_USER`/`<P>_PASSWORD` and the URLs then carry that role, so
  an app or BI tool gets only the rights it needs. The attachment records `credentialId`, and the
  credential cannot be revoked while any app is attached with it. PgBouncer's userlist carries
  only the owner, so such an attachment connects directly and gets no `<P>_POOL_*` variables.
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
- **Public URL is an operator-managed secret.** Skiff still keeps Postgres loopback-only (D56); an
  operator who exposes it through their own TCP proxy or tunnel can store the full public
  `postgres://…` URL. It is sealed with the org key, only its configured/updated metadata appears
  in `DatabaseView`, and the URL itself is decrypted only by `GET /databases/:name/public-url`
  (`database:credentials`), which is audited as `database.public-url.reveal`. Setting or clearing
  it needs `database:update` and is audited. It never enters desired state, agent memory, logs,
  MCP or the audit arguments.
- Named credentials (§16) are revealed one at a time by
  `GET /api/v1/databases/:name/credentials/named/:id` (dashboard row menu, `skif db credentials
  reveal`), gated the same way and audited as `database.credentials.reveal`. Listing, creating,
  rotating and revoking return metadata only, so those are also available over MCP.
- Rotation: §11 (owner/monitor) and §16 (named credentials).

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

- **Move to another node** (D97, `POST /databases/:name/move { node, storage? }`, dashboard
  Settings → Resources → Move): engines with backups only, and not while PITR is on. The move
  stops attached apps (`quiescing`), takes a final backup on the source once it has applied the
  stop (`dumping`), re-points the row at the target with fresh ports so it restores into an empty
  instance (`restoring`), then moves the attached apps, re-grants named credentials and purges the
  source copy (`purging` → `done`). Name, credentials and connection variables are unchanged; the
  host port may differ. A failed dump gives up with nothing changed; a failed restore puts the
  database back on the untouched source and purges the target's partial copy. Apps with app
  volumes or a persistent data dir block the move. An app that also uses another database or
  private storage on the old node still follows; the response warns that it cannot reach (or
  deploy against) that service until it moves too. Downtime is roughly one backup
  plus one restore. `GET /databases/:name/move` shows the latest move.
  A database that cannot be dumped (failed, stopped, or its node offline) moves with an explicit
  `from`: `latest-backup` restores its newest good backup (later writes are lost) and `empty`
  starts it fresh (its data is discarded). Every engine has backups, so every engine moves with its
  data. The dashboard asks for a confirmation for either.

**Data location.** A database goes on the storage target its create request names (`storage`:
`system`, `fast`, `bulk` or a disk name; CLI `--disk`), else the `databases` default in Settings →
Storage, else the system disk, where the data dir lives under the helper's state root. On a disk
its data lives at `<mount>/skiff/<id>` (D169, D78), and the node refuses to start it when the mount
is missing (D76). Replicas, moves and restores keep the database's tier unless they name another
target. See [STORAGE.md](./STORAGE.md).

## 7. Surfaces

| Surface | What |
|---|---|
| REST | `GET/POST /api/v1/databases`, `GET/PATCH/DELETE /api/v1/databases/:name`, `POST …/:name/restore`, `GET …/:name/credentials`, `GET/POST …/:name/credentials/named`, `GET/DELETE …/:name/credentials/named/:id`, `POST …/:name/credentials/named/:id/rotate`, `GET …/:name/metrics`, `GET …/:name/logs`, `GET/POST …/:name/backups`, `GET/DELETE …/:name/backups/:id`, `POST …/:name/backups/:id/restore`, `GET/PATCH …/:name/backup-policy`, `GET/POST …/:name/rotate`, `POST …/:name/restart`, `GET/POST/DELETE …/:name/studio`, `GET/POST …/:name/replicas`, `DELETE …/:name/replicas/:id`, `POST …/:name/replicas/:id/promote` (`If-Match: <primaryGeneration>`), `GET/POST /api/v1/projects/:slug/databases`, `DELETE …/databases/:name` |
| MCP | `list_databases`, `get_database`, `create_database`, `attach_database`, `detach_database`, `delete_database` (confirmed, soft), `list_database_backups`, `backup_database`, `restore_database`, `set_database_backup_policy`, `rotate_database_credentials`, `list_database_credentials`, `create_database_credential`, `rotate_database_credential`, `revoke_database_credential` (confirmed), `restart_database`, `update_database` (resize, pooler, extensions, forward version moves; the assistant asks first), `get_database_logs`, `list_database_replicas`, `create_database_replica` (the assistant asks first), `delete_database_replica` (confirmed); never promote |
| CLI | `skif db list\|create\|info\|update\|attach\|detach\|delete\|restore\|credentials [list\|create\|rotate\|revoke\|reveal]\|logs\|backups\|backup\|backup-delete\|restore-backup\|backup-policy\|rotate\|restart\|upgrade\|replica [list\|add\|remove\|promote]` |
| Dashboard | Databases list + create, detail (status, connection, pooler, attached projects, charts, tables, extensions/slow queries, backups/restore, rotate, restart, logs), **Studio** tab (native studio, read-only by default), attach from a project |

## 8. Backups and restore (D83)

Every database has a policy (`backup_enabled`, five-field UTC cron, `backup_retention_days`,
default daily 03:00 and 7 days). The maintenance sweep queues a `database_backups` row when
`next_backup_at` is due; a manual backup queues one immediately. A pending/running backup is never
duplicated.

- The node sees `databaseBackupTasks` in desired state with a **presigned PUT** URL. The agent
  calls the helper's fixed dump verb (`pg_dump -Fc` for Postgres; per-engine formats in §17), streams the dump straight to the object store while
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

**Where a backup lives (0053).** Target resolution (org's oldest backup target → platform target →
platform object store) only decides where the *next* backup goes. When a row is queued it records
`target_id` (null = the platform object store), `target_name` and `location_json`, a snapshot of the
target's kind, path or endpoint/bucket/region and prefix (never credentials). The presigned PUT,
the restore GET, retention, purge and `backup-delete` all open the store from that record, with
the location from the snapshot and credentials/region/write-only from the live target row, so
adding a target or switching the default never moves an existing backup. The view exposes it as
`target { id, name, kind, location, available, unavailableReason }`.

- A target that holds retained backups (`ok`, `pending`, `running`) **cannot be deleted**, and its
  `path`, `endpoint`, `bucket` and `pathPrefix` cannot change. The sealed credentials are the only
  way Skiff can reach those objects, so a mistaken delete would be unrecoverable; refusing costs one
  step. `DELETE /backup-targets/:id?force=1` (`skif backup-target remove --force`) overrides this
  when nothing is in flight or being restored. The backups stay listed as unavailable with the
  exact location; restore refuses them with that message, retention and purge skip them (the row
  is the only record of the object), and `backup-delete` drops the row and leaves the object.
- Adding a target with the same location (kind, directory or endpoint+bucket, prefix) in the same
  scope reconnects unavailable backups, which undoes a forced delete.
- The newest-good-backup rule counts only backups Skiff can still reach. A queued backup or restore
  whose target vanished out of band fails with the reason instead of staying pending.
- Migration 0053 backfills existing rows with the target that resolved for their org at migration
  time, which is where every read looked for them before. Rows a rolled-back release writes later
  leave `location_json` null and fall back to the current resolution.

The local filesystem object store buffers uploads and enforces the 500 MB artifact limit; R2 gets a
direct presigned PUT with no buffering. A production install should use R2 for large databases.

PITR (pgBackRest WAL archiving and restore-to-time) is a separate, flag-gated path documented in
[PITR.md](./PITR.md): PostgreSQL 18 on the standard image only, which then runs the Skiff-built
`skiff-postgres-pitr` image. `SKIFF_FEATURE_PITR` is on by default but needs the pgBackRest repository settings; logical
backups remain the proven restore path until the restore drill (`scripts/pitr-drill.sh`) passes on a
Linux node.
A PITR restore, like a logical one, always creates a new database on the source's node.

## 9. Extensions and slow queries (D84)

`extensions` is an allowlist, defined with a description and category per entry in
`databaseExtensionCatalog` (`packages/contracts/src/database.ts`). It covers the contrib set the
pinned `postgres:{16,17}-alpine` image ships (observability such as `pg_stat_statements`,
`pg_buffercache`, `pgstattuple`, `amcheck`; text search such as `pg_trgm`, `unaccent`,
`fuzzystrmatch`; types such as `citext`, `hstore`, `ltree`, `isn`; `btree_gin`/`btree_gist`/`bloom`
indexing; `pgcrypto`, `uuid-ossp`, `tablefunc`, `earthdistance`; trigger helpers such as
`moddatetime` and `tcn`), plus `pg_cron`, `pgvector` and
`postgis`, which the stock image does not ship yet. **Postgres 18** runs the pgvector build of the
official image (`pgvector/pgvector:0.8.7-pg18-trixie`, Debian) instead, so `pgvector` works there
(D124). It runs as the same uid 70 as the alpine image (the entrypoint maps the unknown uid with
nss_wrapper), so data dirs, PITR files and restores keep one owner. 16 and 17 stay on alpine:
moving an existing cluster from musl to glibc would change collation order under its text
indexes, so getting pgvector on an older database is a dump/restore into a new 18 database.

**Image variants (D126).** `databases.variant` (`standard` by default) picks the image at create
and never changes. `postgis` and `pg_cron` are Skiff-built Postgres 18 images
(`ghcr.io/kieranholroyd/skiff-postgres:18-<variant>-<revision>`, from `docker/postgres/Dockerfile`
and `.github/workflows/postgres-images.yml`): the pinned pgvector image plus
`postgresql-18-postgis-3` or `postgresql-18-cron` from the PGDG apt repo the base already has.
Same uid 70, entrypoint and lockdown. Create adds the variant's extension; `postgis` and `pg_cron`
are refused on any other variant (create, update) instead of failing softly. The desired-state
profile carries `variant` only when it is not `standard`, and so does the activation hash, so
existing databases did not restart. The helper keeps its own copy of the image mapping (D61) and
rejects a variant on anything but Postgres 18. For `pg_cron` the helper also preloads `pg_cron`,
sets `cron.database_name` to the owner database (`POSTGRES_DB` from the workload env, checked as
an identifier) and `cron.host=/var/run/postgresql`, so jobs connect over the socket the image's
initdb trusts and no password is stored for them. On the first boot pg_cron logs one
`database "<name>" does not exist` from the entrypoint's temporary init server; it retries once
the database exists. Restores (logical and PITR) copy the variant, because a dump with PostGIS or
pg_cron objects only restores where the extension exists. Restored `cron.job` rows still name the
source database. The upgrade planner blocks a major the variant has no image for. Tags are
immutable: changing the Dockerfile or base means bumping the revision in the contract
(`SKIFF_POSTGRES_IMAGE_REVISION`), the helper and the workflow together.

Excluded on purpose: anything that reaches outside the container (`dblink`, `postgres_fdw`,
`file_fdw`, `adminpack`), procedural languages (the image ships `plperl`/`pltcl` control files
without the Perl/Tcl runtimes; the untrusted variants can escape the database), `pg_surgery`, and the deprecated `xml2`, `intagg` and `old_snapshot`.

The helper preloads `pg_stat_statements`; the agent runs `CREATE EXTENSION IF NOT EXISTS "<sql
name>" CASCADE` for each requested extension after the monitor role is bootstrapped (`pgvector`
maps to `vector`; `CASCADE` pulls in `cube` for `earthdistance`). An extension the pinned image does
not ship fails softly and is logged; it does not stop the database.

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

`SKIFF_FEATURE_DB_TLS` (default on) asks the helper to generate a per-database CA and server
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

The restart comes from the consumer's activation version (D56), which includes a hash of the
sealed secret the app connects with: always for a named credential, and for the owner once the
database has had its first confirmed owner rotation (so upgrading Skiff does not restart apps
whose password never changed). Named credentials rotate the same way through
`POST …/credentials/named/:id/rotate` (§16); only apps attached with that credential restart.

## 12. Restart controls (D87)

- **Restart database** bumps `databases.restart_generation`, which is folded into the activation
  version. The agent re-fetches the activation and re-applies the unit, so the container and its
  PgBouncer sidecar restart together without a config change.
- **Restart pooler** sets `pooler_restart_requested_at`; the node sees the id in
  `databasePoolerRestarts`, calls the helper's dedicated fixed verb (`systemctl restart` on the
  pooler unit only), and acknowledges it on the next heartbeat. Postgres connections are untouched.
- Both actions require `database:update`, are audited, and are exposed as
  `POST /databases/:name/restart` (`{ target: "database" | "pooler" }`), `skif db restart <name>
  [--pooler]`, the MCP `restart_database` tool, the per-row **Restart** action on the Databases
  list, and the dashboard Resources/Pooler controls.
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

## 14. Database studio (D96)

Each managed database has a native, built-in studio at `/databases/<name>/studio`: an object
tree, a data grid with filter/sort/paging and inline edits, and a query editor. Each engine is a
`@skiff/studio` plugin (Postgres, MySQL/MariaDB, MongoDB, Valkey/Redis) with declared
capabilities; the workspace reads the capabilities and never branches on the engine name. It is on
by default behind `SKIFF_FEATURE_DB_STUDIO` (set `0` to hide the Studio tab and the route). It
replaced D60's per-database sidecar studio, which was deleted at the cutover.

- **Sessions.** Opening creates a per-user session (several people can have a studio open on the
  same database). The control plane mints a sealed token and lists the live session ids for the
  database's node in desired state; the token itself never appears there. A session expires after
  60 minutes (configurable 5–480) and closes after 15 minutes idle (configurable 5–240); the
  maintenance sweep closes lapsed sessions. Deleting, moving or changing the mode of a database
  closes its open sessions.
- **Where queries run.** On the database's node, `skiff-studio.service` runs the agent binary's
  `studio` entrypoint in its own cgroup (`MemoryMax=256M`), on a unix socket only
  (`/run/skiff/studio.sock`) and with no node token. The helper starts it on demand through its
  fixed `POST /v1/studio/start` verb, and it exits after 5 idle minutes; a node that never opens a
  studio never runs it. The unit has no `[Install]` section, so nothing starts it at boot.
- **Reachability.** The agent fronts the studio process on one loopback port per node
  (`SKIFF_STUDIO_PORT`, default `8083`). The control plane reaches it only through the node's
  internal Caddy gateway (D82), on host `n-<label>.studio.internal` at
  `127.0.0.1:<SKIFF_DATABASE_GATEWAY_PORT>` (default `8082`); the edge forwards a worker's host
  over WireGuard. The agent front pulls each session's activation from
  `GET /api/agent/database-studio/:id` with the session token, so there is still no
  control-plane-to-agent command channel, and databases stay loopback-only (D56).
- **Permissions.** `database:console` is required to open or use a studio, and is never a default
  agent scope. Only interactive user sessions can use it: an API key cannot reuse a user's
  session. Write sessions also need `database:update`, are confirmed in the UI, and are
  re-checked on every call, so losing the role locks the user out mid-session.
- **Read-only by credential.** Read-only sessions connect as a per-database `skiff_studio_ro`
  principal (Postgres `pg_read_all_data`; MySQL/MariaDB `SELECT, SHOW VIEW`; Mongo `read`;
  Valkey/Redis a read-only ACL), so the database itself refuses writes. Session flags are a second
  layer: read-only transactions on SQL engines and a command check on Valkey/Redis. Write sessions
  use the owner credential.
  - **Creation:** the principal's password is sealed on the database row (migration 0032). The
    node applies it through the helper verb `POST /v1/workloads/:id/studio-principal`, after
    fetching it from `GET /api/agent/database-studio-principal/:id`. It is created with the
    database and re-applied after a restore, a PITR restore or a version change.
  - **Older databases:** opening a read-only session creates the principal if missing. The
    session shows "Preparing read-only access…" until the node confirms, and never falls back
    to the owner.
  - **Valkey/Redis persistence:** the ACL line is also written into the helper-generated
    `server.conf`, so it survives restarts.
  - **Connection limit:** the principal allows 4 connections, so about two read-only sessions
    per database can be open at once.
  - **Reserved name:** `skiff-studio-ro` (the database identifier `skiff_studio_ro`) is reserved
    on every engine.
- **Structure editing.** Write sessions can change structure from the workspace, through the
  typed `alter` op rather than free text. Each change runs as a dry run first and shows the
  exact statements for review; destructive changes (drop, truncate, drop column/field, drop
  index) also ask for the object's name. What each engine supports is listed in its
  `capabilities.structure`, and the UI shows only those controls:

  | Engine | Changes |
  |---|---|
  | Postgres | create schema; create/rename/drop/truncate tables (drop also for views, materialized views, foreign tables and schemas, optionally `CASCADE`); add, drop, rename and alter columns (type with `USING col::type`, nullability, default); create/drop indexes |
  | MySQL, MariaDB | the same, minus create schema; `MODIFY COLUMN` keeps the column's existing default, `AUTO_INCREMENT`, `ON UPDATE` and comment. DDL commits on its own here, so a failed step reports which earlier steps already ran |
  | MongoDB | create/rename/drop/truncate collections (drop also for views); rename or remove a field in every document; create/drop indexes |
  | Valkey, Redis | rename a key (`RENAMENX`, so an existing key is never overwritten) and delete it (`UNLINK`) |

  Column types must be plain type names (`varchar(255)`, `numeric(10,2)`, `integer[]`,
  `enum('a','b')`), and default expressions a keyword or a niladic call (`now()`,
  `CURRENT_TIMESTAMP(6)`); literals are quoted by the plugin. Anything else goes through the
  query editor. Postgres runs a change in one transaction. Read-only sessions refuse `alter`
  at the proxy, in the studio process and in each plugin, and the read-only principal cannot
  run DDL either.
- **Limits** (enforced in the studio process): 1,000 rows per result by default (up to 10,000),
  16 MiB per response (then `truncated: true`), a 30 s statement timeout, one run at a time per
  session, and 8 sessions per node. Results stream as NDJSON and are never buffered past one
  batch; closing the tab or pressing Stop cancels the query on the database.
- **Audit.** Lifecycle keeps the `database.console.*` names: `database.console.open`,
  `database.console.close` (with a reason) and `database.console.expired` (expired or idle).
  Editor runs are `database.studio.run`, grid edits `database.studio.write`, and applied
  structure changes `database.studio.alter` (the object path and the change kind, such as
  `add-column`). None of them record SQL text, column types or values; runs record a statement
  fingerprint and writes record counts. Dry runs are not audited.

Surfaces: `GET/POST/DELETE /api/v1/databases/:name/studio` (the caller's session), the
session-only `/databases/:name/studio/api/:op` calls the workspace makes (not part of the public
API), and the **Studio** tab on the database pages. Query history lives in the browser
(IndexedDB, last 200 runs per database).

## 15. Follow-ups (on the roadmap)

- Cross-node access via a node private address; bulk prune for databases; a scheduled PITR drill
  (the drill itself is `scripts/pitr-drill.sh`; see [PITR.md](./PITR.md) for the remaining gaps).
- Engine parity (§17): metrics samplers, TLS and named credentials for the newer engines, Valkey/Redis
  backups (RDB), and a studio plugin and backups (`BACKUP … TO File`) for ClickHouse.

## 16. Per-org networks and named credentials (plan 04b)

When `SKIFF_FEATURE_ORG_NETWORKS` is on, each workload carries `orgId` and `networkName` in desired
state and the helper renders `skiff-org-<orgId>.network`. Only that org's containers join it, so
aliases such as `db-<id>` resolve only inside the org. Workloads without `orgId` keep the legacy
`skiff-workloads` network, so old desired state and running installs continue to converge unchanged.
Caddy still proxies to `127.0.0.1:<port>`; it never joins a tenant network. Database ports remain
loopback-only.

`database_credentials` stores named `owner`, `app`, `monitor`, `readonly` and `backup` roles. Owner
and monitor rows are created with the database; app/read-only/backup rows are opt-in. A new or
rotated secret is sealed in `pending_secret_sealed` until the node confirms the Postgres role
change, so a failed apply never locks an app out. Attachments reference the built-in owner
credential row unless they were attached with `credential` (§3).

- **Roles.** `app` reads and writes tables in the `public` schema, `readonly` can only `SELECT`,
  `backup` reads what a dump needs. Usernames are generated (`skiff_<role>_<hex>`); a purpose and
  an expiry are optional. Creating needs `database:credentials` and `database:update` and the
  engine's `namedCredentials` capability (Postgres).
- **Lifecycle.** A credential is `pending` until the node confirms the `CREATE/ALTER ROLE`, then
  `ready`; a failed apply is `failed` and keeps any previous secret. Rotate seals a new pending
  secret the same way; apps attached with that credential restart once it is live (§11). Revoke
  marks it `revoking` until the node disables the login, then `revoked`; it is refused while an
  app is attached with it (detach first). Owner and monitor are rotated with §11 and cannot be
  revoked.
- **Reveal.** Needs `database:credentials` from the dashboard session or the CLI's API key; MCP
  principals are refused in core (`requireCredentialReveal`), so agents never see a password.
  Every reveal sets `lastUsedAt` and writes `database.credentials.reveal`. Creates, rotations and
  revocations are audited as `database.credential.create|rotate|revoke`.
- **Surfaces.** REST `GET/POST /databases/:name/credentials/named`, `GET/DELETE …/named/:id`
  (reveal/revoke), `POST …/named/:id/rotate`; MCP `list_database_credentials`,
  `create_database_credential`, `rotate_database_credential`, `revoke_database_credential`
  (confirmed); CLI `skif db credentials list|create|rotate|revoke|reveal` and
  `skif db attach --credential`; the dashboard's Credentials panel on the database overview and the
  "Connect as" choice in the attach dialog.

**Rollback / existing installs:** the network name is derived, not stored, so turning the flag off
returns every workload to `skiff-workloads` on its next activation. The migration is additive
(`0022_org_networks.sql`); existing databases are backfilled with owner/monitor credential rows and
existing attachments stay NULL (they keep using their current secret). Reverting the release is a
pre-restore snapshot/rollback; no table or column is dropped.

## 17. Database engines (D95)

Seven engines, all from the vendors' official images, chosen from the most-used self-hostable
databases (Stack Overflow 2025, DB-Engines 2026), plus ClickHouse for analytics. Oracle and SQL Server (proprietary, heavy) and
SQLite (embedded, not a server) are out of scope.

| Engine | Versions (default) | Image | Port | Default prefix | URL |
|---|---|---|---|---|---|
| PostgreSQL | 17, 16 (17) | `postgres:<v>-alpine` | 5432 | `DATABASE` | `postgres://u:p@h:5432/name` |
| MySQL | 9.7, 8.4 (8.4) | `mysql:<v>` | 3306 | `DATABASE` | `mysql://u:p@h:3306/name` |
| MariaDB | 11.8, 11.4 (11.8) | `mariadb:<v>` | 3306 | `DATABASE` | `mysql://u:p@h:3306/name` |
| MongoDB | 9.0, 8.0 (8.0) | `mongo:<v>` | 27017 | `MONGODB` | `mongodb://u:p@h:27017/name?authSource=admin` |
| Valkey | 9.1, 8.1 (9.1) | `valkey/valkey:<v>-alpine` | 6379 | `REDIS` | `redis://u:p@h:6379/0` |
| Redis | 8.10, 8.8 (8.10) | `redis:<v>-alpine` | 6379 | `REDIS` | `redis://u:p@h:6379/0` |
| ClickHouse | 26.8, 26.3 (26.8) | `clickhouse/clickhouse-server:<v>` | 8123 (HTTP) | `CLICKHOUSE` | `http://u:p@h:8123/name` |

Valkey is the BSD-licensed Linux Foundation fork of Redis and the recommended choice for caches and
queues (BullMQ, Sidekiq, Celery). Redis 8 is AGPLv3; pick it only for Redis-only modules.

**Capabilities.** Every engine supports create, attach, the credentials reveal and snippets, the
public URL secret, logs, restart, resize, volumes and delete/restore/purge. The rest is declared per
engine in `databaseEngineRegistry[engine].capabilities`, exposed on `DatabaseView.capabilities`,
enforced by `DatabaseService` (a clear `ValidationError`), and used by the dashboard to hide tabs and
panels:

| Capability | Postgres | MySQL | MariaDB | MongoDB | Valkey | Redis | ClickHouse |
|---|---|---|---|---|---|---|---|
| Owner password rotation | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (live, no restart) |
| Studio (native, D96) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| Backups + restore into a new database | ✓ `pg_dump -Fc` | ✓ `mysqldump` | ✓ `mariadb-dump` | ✓ `mongodump --archive --gzip` | ✓ RDB (`valkey-cli --rdb`) | ✓ RDB (`redis-cli --rdb`) | ✓ `BACKUP DATABASE … TO File(zip)` |
| Pooler, extensions, metrics/tables/slow queries, TLS, PITR, named credentials, upgrade planner | ✓ | – | – | – | – | – | – |

**Runtime profile.** The helper keeps its own copy of the registry (D61) and renders the same
lockdown as Postgres: the image's uid (999 for all four; Valkey/Redis group 1000), read-only root,
`DropCapability=all`, `NoNewPrivileges`, loopback-only `PublishPort`, the org network alias. The
image entrypoint initialises the data dir under `/data` on first start; the helper passes fixed
arguments sized from the unit's `MemoryMax`:

- MySQL: `--datadir=/data/mysql`, InnoDB buffer pool 40%, performance schema and X Protocol off
  (≈250 MB less at idle), `--skip-name-resolve --host-cache-size=0` so the handshake-only health probe
  can never get the forwarder's address blocked by `max_connect_errors`. Socket tmpfs `/var/run/mysqld`.
- MariaDB: the same, without the MySQL-only flags; `MARIADB_AUTO_UPGRADE=1` upgrades the system
  tables after a version change. Socket tmpfs `/run/mysqld`.
- MongoDB: `--dbpath /data/db --bind_ip_all`, WiredTiger cache 40% (min 0.25 GB). The owner is the
  image's root user in `admin`, hence `authSource=admin`.
- Valkey/Redis: a helper-written 0600 config (owned by the container uid, mounted read-only)
  disables the `default` user, defines the owner as the only ACL user, turns on AOF and sets
  `maxmemory` to 75% with `noeviction`, so a full instance refuses writes instead of being OOM-killed
  or dropping keys. Clients authenticate with `user:password`.
- ClickHouse (uid/gid 101): no server arguments. The helper writes a standalone `config.xml` and
  `users.xml` into a 0700 directory (owned by 101) mounted read-only at `/etc/skiff/clickhouse`, and
  fixes `CLICKHOUSE_CONFIG`, `CLICKHOUSE_SKIP_USER_SETUP=1` and `CLICKHOUSE_WATCHDOG_ENABLE=0`, so
  the image entrypoint only creates the owner's database on first start. Data lives under
  `/data/clickhouse/`; logs go to stderr only (journald). `max_server_memory_usage` is 75% of the
  unit's limit, merges get a 25% soft limit, caches are small and fixed, and every system log table
  is off except a 7-day `query_log`. The owner is a config user with a SHA-256 password and
  `access_management`, so it can create SQL users and roles (stored under the data dir); `default`
  exists only because the entrypoint reads it, with an all-zero hash nobody can log in with, on
  loopback only. HTTP 8123 is published on loopback; native TCP 9000 is reachable from containers on
  the org network only. Minimum memory 1 GB, default 2 GB.

MySQL and MariaDB keep `root` on the owner's password but bound to `localhost`, i.e. the container's
own socket; that is how the helper's fixed dump/restore/rotate verbs authenticate (`MYSQL_PWD` in
podman's environment, never argv). The helper marks non-Postgres env files with `SKIFF_DB_ENGINE`;
a file without it is Postgres, so existing env files and units are unchanged.

**Health.** The agent's TCP probe performs each engine's smallest handshake and needs an answer
only the server gives (Podman's forwarder accepts before the server is up): the Postgres
`SSLRequest`, the MySQL/MariaDB protocol-10 greeting, MongoDB `OP_MSG { hello: 1 }`, and RESP
`PING` (a `-NOAUTH` reply counts; `-LOADING` does not), and ClickHouse's `GET /ping` (only a
`200` counts; during the entrypoint's first-start init the server listens on its own loopback, so
the probe waits it out). No credentials are sent.

**Attachments.** Apps receive the usual `<PREFIX>_URL/_HOST/_PORT/_USER/_PASSWORD/_NAME`; MongoDB
attachments also get `<PREFIX>_URI` (what MongoDB drivers and most apps read). `<PREFIX>_NAME` is
`0` for Valkey/Redis. ClickHouse URLs point at the HTTP interface; `@clickhouse/client`,
`clickhouse-connect` and `clickhouse-go` read the path as the default database, but the server answers
queries at `/`, so raw HTTP (curl) passes `?database=<NAME>` instead. `_SSL_MODE` and the pooler
variables exist only for Postgres. The env
suggestions recognise `REDIS_*`, `VALKEY_*`, `MONGODB_*`/`MONGO_*`, `MYSQL_*` and `MARIADB_*` and
offer a one-click link under that prefix.

**Versions.** Postgres majors go through the upgrade planner (§6). For MySQL, MariaDB, Valkey,
Redis and ClickHouse (LTS to LTS) a plain update may move *forward* to a newer listed version in place (the image upgrades the
data dir on start); downgrades are refused. MongoDB needs feature-compatibility steps between
majors, so its version never changes in place: back up and restore into a new database.

**Backups.** The backup task's `format` follows the engine (`pg_dump-custom`, `mysqldump-sql`,
`mariadb-dump-sql`, `mongodump-archive-gzip`, `valkey-rdb`, `redis-rdb`, `clickhouse-backup-zip`);
the rest of the pipeline (schedule, presigned PUT, SHA-256, restore into a new database,
verification, retention, moves) is unchanged. MongoDB restores rename the archive's namespaces into
the target database (`--nsFrom '$db$.$coll$'`); the tools read the password from a `--config` file
written over stdin into the container's `/tmp` tmpfs and removed afterwards.

Valkey/Redis and ClickHouse dumps are files the server writes itself, so they are staged in a 0700
`skiff-dumps/` directory inside the database's own data dir (owned by the engine's uid; `/data/skiff-dumps/`
in the container) rather than the helper's runtime tmpfs. The helper returns the file from there
(0400); the HTTP layer's cleanup timer deletes it, and leftovers older than an hour are pruned
before the next dump or restore. Staging names are fixed (`dump-|restore-<uuid>.rdb|zip`) and every
identifier is validated before it reaches argv or SQL; passwords travel only in podman's
environment (`REDISCLI_AUTH`, `CLICKHOUSE_PASSWORD`).

- **Valkey/Redis**: `<engine>-cli --rdb` as the owner (the server forks a snapshot and sends it
  over the replication protocol, so writes continue), then `<engine>-check-rdb` must accept the whole
  file before the dump is reported. All logical databases (0–15) are in the snapshot; ACL users are
  not (they live in the helper-written config). Restore: the artifact is staged and `check-rdb` must
  accept it while the new instance still runs; the unit is then stopped, `appendonlydir/` is replaced
  by the snapshot as the AOF base (`appendonly.aof.1.base.rdb` plus a one-line manifest), since with
  `appendonly yes` the server would ignore a bare `dump.rdb`; the unit is started again (also when
  the swap fails), and `PING` must return `PONG`, which it only does once the dataset has loaded
  (up to ~10 minutes). A snapshot from a newer server version than the target's cannot load; restores
  always use the source's version.
- **ClickHouse**: `BACKUP DATABASE <db> AS skiff_backup TO File('/data/skiff-dumps/…zip')` (the
  native format: schema, parts and checksums; `backups.allowed_path` in the generated config allows
  only the staging dir). Storing it under a fixed name lets `RESTORE DATABASE skiff_backup AS
  <target> … SETTINGS allow_different_database_def = 1` restore it into the new instance's own
  (empty, entrypoint-created) database on the running server, which re-checks every checksum; a
  `system.databases` lookup as the owner is the verification query. SQL-created users and roles are
  not part of a database backup.

**Schema.** SQLite cannot change the Postgres-only `CHECK` on `databases.engine` without a table
rebuild, which the additive-migration rule (OPS §4.2.2) and the updater's preflight refuse. Migration
`0028_database_engines.sql` therefore adds an unconstrained `engine_name` column (default
`postgres`), which the service layer reads and writes; the old column stays at its default. A
release rolled back with `--keep-db` reads the old column and sees every database as Postgres.

**Verified.** Every engine and version above was exercised against the real images with Docker
standing in for Podman (`podman exec` and `docker exec` share a CLI): the rendered server flags and
env under a read-only root with no capabilities, the agent probe, and the helper's own dump,
restore-into-a-new-database, rotation and verification verbs. Each engine's studio plugin passes the
studio conformance suite against the same images (plan 22). ClickHouse is covered by unit tests
(rendered unit and config, probe, service) and its config follows the telemetry store's, which runs
26.8 in production (D101); it has not yet been run under the database lockdown against the real
image (first start, rotation reload).

## 18. Read replicas (C7, [CLUSTERING.md §9.2–9.3](./CLUSTERING.md))

Postgres only, `async` only (sync is refused: there is no downgrade path yet), at most
`database.maxReplicas` (≤ 8) per database, none for a PITR database.

- **Shape.** A replica is a row in `database_replicas` and its own container workload,
  `db_dbr_<hex>`, on its node: the database's image and limits, its own loopback host port (from the
  database range, counted by `allocatePort`) and optional disk, and `database.replica.slot`
  in desired state. It reserves the database's memory on its node. A replica on the primary's own
  node is allowed (read scaling) but is never promoted.
- **Link.** The walreceiver connects to a unix socket, `<agent data dir>/replication/<id>/.s.PGSQL.5432`,
  which the helper bind-mounts read-only at `/run/skiff-upstream`; the agent pipes it to the
  primary's loopback port (same node) or the primary node's pinned-mTLS provider listener (another
  node; the provider merges replica and C2 consumer fingerprints on the database's host port).
- **Primary.** `databaseReplication` tasks (version = hash of slots + secret) make the agent fetch the
  `skiff_repl` password from `GET /api/agent/database-replication/:id` and call the helper's fixed
  `replication/configure` verb: a managed `host replication skiff_repl all scram-sha-256` block in
  `pg_hba.conf`, the role, `wal_keep_size = 512MB`, `max_slot_wal_keep_size = 2GB`,
  `wal_sender_timeout = 60s` (ALTER SYSTEM + reload, no restart), exactly the listed `skiff_*`
  physical slots (others dropped, walsender terminated first). An empty list tears it all down.
  Every 30 s the agent samples `pg_replication_slots ⟕ pg_stat_replication` (`replication/status`);
  the sample is the replica's status (`streaming`, `lagging` past 30 s / 256 MB, `stopped`, `lost`
  when `wal_status = lost`), LSNs and lag.
- **Replica.** The helper-written start script runs `pg_basebackup -X stream -c fast --max-rate=50M
  --slot=<slot>` through the link into `pgdata.partial` (retrying every 10 s) when there is no
  `PG_VERSION`, always touches `standby.signal`, then execs the image entrypoint with
  `hot_standby=on`, `hot_standby_feedback=on`, `primary_conninfo=host=/run/skiff-upstream …`,
  `primary_slot_name`. The replication password is `PGPASSWORD` in its env file (activation only).
- **Read URLs.** While a replica the consumer can reach is `streaming` or `lagging`, attachments get
  `<P>_READ_URL`, `_READ_URLS`, `_READ_HOST`, `_READ_PORT` (same credentials): same-node replicas
  directly (`db-dbr<hex>:5432` for containers), remote ones through a C2 endpoint keyed by the
  replica id (process apps with `SERVICE_ENDPOINTS`). The read target is folded into the consumer
  version, so the app restarts when it changes. The stable 22000–22999 read port of §9.2 is not built.
- **Remove.** Leaves desired state, the replica's node purges `db_dbr_<hex>` (`databasePurges`), the
  primary drops the slot; the row goes once both are confirmed.
- **Promote** (`database_failovers`): fence (the primary leaves its node's desired state; confirmed
  when that node heartbeats at or past the fence version without it, or skipped when the node is
  unreachable, which then needs `acceptDataLoss`; abandoned after 10 min) → the replica's node holds
  the replica workload and runs the helper's `replica/promote` (`pg_ctl promote`, wait for
  `pg_is_in_recovery() = false`, checkpoint, stop, rename `<root>/db_dbr_<hex>` to `<root>/<db id>`;
  refused before anything when the target exists) → re-point (the row takes the replica's node, port
  and volume, a new pooler port, `primary_generation + 1`; other replicas are rebuilt from scratch)
  → completed when the database reports running there. The old primary's data dir is purged when
  its node returns. Lag budget 64 MB / 60 s, report ≤ 2 min old and the primary's node online, else
  `acceptDataLoss`. The failover controller's database handler (`failoverHandler()`) drives the
  same steps and is registered only with `SKIFF_FEATURE_DB_AUTO_PROMOTE`.
- Moves and Postgres major upgrades are refused while replicas exist.
