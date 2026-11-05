# Skiff — Managed databases

Status: **implemented, 2026-11-04** (not yet exercised on a real Debian/Podman node; the container lockdown, monitor bootstrap, sampler SQL and health probe were checked against `postgres:17-alpine`). Decisions are recorded in [DECISIONS.md](./DECISIONS.md) as D55–D61.

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

`<P>_URL`, `<P>_HOST`, `<P>_PORT`, `<P>_USER`, `<P>_PASSWORD`, `<P>_NAME`

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

## 4. Credentials (D58)

- The control plane generates an owner password and a monitor password on create, sealed with the
  org data key (envelope encryption, D18).
- `GET /api/v1/databases/:name/credentials` reveals the connection URL for humans and CLIs. It
  needs `database:credentials`, which is never pre-ticked for agents, and every read is audited.
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
| Gauges | `size_bytes`, `connections_active`, `connections_idle`, `connections_total`, `max_connections`, `memory_bytes` (container), `up` |
| Counters (per-minute deltas) | `xact_commit`, `xact_rollback`, `tup_returned`, `tup_fetched`, `tup_inserted`, `tup_updated`, `tup_deleted`, `blks_hit`, `blks_read`, `deadlocks`, `temp_bytes` |

Counters are sent as deltas the agent computes from `pg_stat_database`; a stats reset or restart
(negative delta) sends the raw value instead. Rollups sum counters, average connection gauges and
take the max of size and memory.

**Snapshot → SQLite**: every five minutes the agent also sends the top 50 tables (schema, name,
estimated rows, total bytes, sequential/index scans, last autovacuum/autoanalyze). Only the latest
snapshot is kept (`databases.stats_json`); history isn't needed for "what's in my database".

Both ride the existing `POST /api/agent/telemetry` batch as an additive `databases` field. The
control plane drops samples for databases that are not placed on the reporting node.

Surfaces: `GET /api/v1/databases/:name/metrics`, charts and a tables list on the dashboard,
`skiff_database_*` series on `/metrics`, and two alerts (size above 85% of the storage budget,
connections above 90% of `max_connections`).

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

## 7. Surfaces

| Surface | What |
|---|---|
| REST | `GET/POST /api/v1/databases`, `GET/PATCH/DELETE /api/v1/databases/:name`, `POST …/:name/restore`, `GET …/:name/credentials`, `GET …/:name/metrics`, `GET/POST /api/v1/projects/:slug/databases`, `DELETE …/databases/:name` |
| MCP | `list_databases`, `get_database`, `create_database`, `attach_database`, `detach_database`, `delete_database` (confirmed, soft) |
| CLI | `skif db list\|create\|info\|attach\|detach\|delete\|restore\|credentials` |
| Dashboard | Databases list + create, detail (status, connection, attached projects, charts, tables), attach from a project |

## 8. Follow-ups (on the roadmap)

- Backups: scheduled `pg_dump` → `ObjectStore`, retention, restore into a new database.
- On-demand SQL console: an open-source admin UI (pgweb or Adminer) as a short-lived container on
  the database's node, behind `platform` access, `database:console`, audited, idle-stopped (D60).
- Cross-node access via a node private address; credential rotation; `pg_stat_statements` slow
  queries; more engines (MySQL, Valkey); bulk actions and prune for databases.
