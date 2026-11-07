# Detailed plans from the paused agents (large packages)

These are the designs the first-wave agents worked out before stopping. Treat them as a strong
starting point, not gospel: verify against the code as it is now.

## A8 — Postgres read replicas

Done: `packages/contracts/src/database-replica.ts` (DatabaseReplicaView, `databaseReplicaReadable`,
workload id helpers `db_<replicaId>`, prefix `db_dbr_`), `database-replica-input.ts`
(`databaseReplicaPromoteSchema`), new `database-replication.ts` (NOT yet exported from contracts
index): `DATABASE_REPLICATION_USER='skiff_repl'`, slot-name pattern, max 8 slots, lag thresholds
30 s / 256 MB, promotion limits 64 MB / 60 s, task/activation/slot-status/report/link/promotion
schemas.

Plan:
- Export from contracts index. `workloadDatabaseSchema` (database.ts) gets optional
  `replica: { slot }`. agent.ts desired state: `databaseReplication`, `databaseReplicaLinks`,
  `databaseReplicaPromotions`; heartbeat: `databaseReplication`, `databaseReplicaPromotionResults`;
  capability `'database-replicas'`. `databaseEnvNames` gets `READ_*` names.
- Migration: columns on `database_replicas` (host_port, volume_id, mode, message, removing_at,
  purged_at, reported_at, sent_lsn) + table `database_replication` (database_id PK, sealed secret,
  applied_version, applied_at, error, timestamps).
- Core `database-replica-service.ts`: add (Postgres only, same node allowed, refuse `sync`, check
  capability, allocate port on replica node, admit memory); remove (mark removing, delete when
  replica node confirms purge and primary confirms slot dropped); desiredForNode, linksForNode,
  primaryTasksForNode, providersForNode, purgesForNode, activation (replication password in
  PGPASSWORD), heartbeat/report/purge/promotion handlers, promote via existing `database_failovers`
  table (fence old primary, then promote).
- Hooks: databases.ts allocatePort/reservedByNode count replicas; consumerEnv/consumerVersion add
  `<P>_READ_URL`, `_READ_URLS`, `_READ_HOST`, `_READ_PORT` while a replica is readable;
  desiredForNode skips a fenced db. workloads.ts routes replica ids before `isDatabaseId`.
  nodes.ts new desired-state fields, merge provider listeners by port, pass heartbeat data.
  service-endpoints.ts include replicas. service-moves.ts refuse move while replicas exist. New
  agent route `database-replication/:id`.
- Helper: validate.ts accept `replica`; units.ts replica variant of the db unit (helper-written start
  script: pg_basebackup retry loop over `/run/skiff-upstream`, touch standby.signal, exec image
  entrypoint; command-line primary_conninfo/primary_slot_name/hot_standby; bind-mount agent link dir
  read-only); systemd.ts verbs configure (role, pg_hba line, create/drop slots,
  wal_keep_size/max_slot_wal_keep_size), status (one JSON query), promote (pg_ctl promote, rename data
  dir); server.ts routes; `SKIFF_HELPER_REPLICATION_DIR` (default /var/lib/skiff/agent/replication).
- Agent: unix-socket forwarder for the link (to local port, or to primary's node over overlay with
  mTLS), replication runner (configure, sample every 30 s, promote), wire main.ts, forward `replica`
  in withOptionalSpec, helper-client methods.
- Surfaces: REST promote route; CLI `skif db replica list|add|remove|promote`; MCP list/create/delete
  (no promote); dashboard; docs (DATABASES.md, CLUSTERING.md, data/databases.md,
  self-hosting/clustering.md).
- Decisions: walreceiver reaches primary via agent-served unix socket bind-mounted by helper (not
  host networking); replica is its own workload `db_dbr_<hex>`; status/lag sampled on primary from
  pg_stat_replication ⋈ pg_replication_slots; same-node replicas allowed (read scaling); sync
  refused; other engines refused; `_READ_URL` only while streaming/lagging.
- Pre-existing bugs found: `ServiceEndpointService.reconcile` removes endpoints other projects use on
  the consumer node; `nodes.serviceProvidersForNode` yields duplicate listeners on one port for two
  consumer nodes; helper firewall opens only 8080 on the overlay.

## A10 — PITR

Done: `docker/postgres-pitr/Dockerfile` (pgvector PG18 by digest
`sha256:5895949dfcdf308eb0cd31c950c93c14895c77f33fbedfecf1fa511ab1d4bcd2` + pgBackRest
`2.60.0-1.pgdg13+1`, `/usr/local/bin/pgbackrest` symlink; built and smoke-tested locally on arm64).
Saved, not applied: `reports/fix-handoff/pitr/pitr.new.ts` (full rewrite of apps/helper/src/pitr.ts)
and `validate-pitr-image.snippet.ts` (image `ghcr.io/kieranholroyd/skiff-postgres-pitr:18-1`, digest
null until published).

Fixes in pitr.new.ts: `pg1-socket-path`+`pg1-user` instead of `pg1-host`; bare host +
`repo1-storage-port`, explicit `s3.<region>.amazonaws.com`, refuse plain http; spool in
`/data/pgbackrest-spool`, file logging off; restore target format `YYYY-MM-DD HH:MM:SS.mmm+00`;
command builders (podman exec backups/status; one-shot `pgbackrest restore` + detached recovery
Postgres); `renderPitrRenameSql` (rename owner role + db to target credentials);
`parsePgBackRestInfo`, `parseArchiverStats`, `computePitrWindow`.

Remaining: apply both; mount config dir `<runtimeDir>/<id>/pgbackrest:/etc/pgbackrest:ro,z`;
rewrite SystemdDriver.pitrConfigure/pitrBaseBackup/pitrStatus/pitrRestore and the apply site
(~systemd.ts:705, create dir owned by uid 70); pitr.test.ts; image workflow
`.github/workflows/postgres-pitr-image.yml` (multi-arch, smoke test, never overwrite a tag);
contracts `postgresPitrImage`; core: use PITR image when PITR on, only standard PG18 image, queue a
full backup on enable, status every ~15 min (rewrites config after reboot), store/report window
(migration: recoverable_from_at, recoverable_to_at, window_checked_at), validate restore time,
heartbeat must not mark restore target running early; agent runs a task only when source (and
target) running; MCP/CLI/dashboard; drill + docs. Keep flag off until a Linux drill passes.
Decisions: separate image repo `skiff-postgres-pitr`, tags `<major>-<rev>`; backups/status via podman
exec in the db container, restores via one-shot containers of the same image; mount dir not files;
recover with `promote` then rename; window = oldest retained backup stop → last archived WAL.
Bug: shared config mounted `:Z` should be `z`.

## A12 — Failover controller

Done: contracts failover.ts history/status types; lease.ts renewBeforeMs ≤ 299 000;
cluster-config.ts removed `controlPlane.autoPromote`; system-alerts `failover` kind; migration
0060_failover_events.sql + `failoverEvents` schema; core lease.ts `SqliteLeaseStore` (settings row,
CAS, `holdsSync`); workloads.ts `replicaCopies()`, `planReplicaMove()`, `moveReplica()`,
`rebalanceReplicas()` wrapper, heartbeat updates copy status, activation allows spread copies.

Plan for `packages/core/src/failover-service.ts`:
- `tick()` takes lease via ControlPlaneLease+SqliteLeaseStore (key `ha:failover_lease`, TTL
  `leaseTtlSeconds`, renew-before TTL − `renewSeconds`).
- Replica moves: copies on a node silent ≥ `replicas.failoverGraceSeconds` move only when
  `failover.enabled`; copies on a draining node always move. HTTP copies first, then lowest index.
  Rate limits: `maxPerMinute` fleet-wide, 2/min per target node, one in flight per workload. Queued
  actions expire after 10 min and alert. Never move onto a node that was a failover source in the
  last 30 min. Each move checked with `holdsSync` inside its transaction, one `ha.failover` audit row,
  stages via `canAdvance`, completes when copy reports running (10-min timeout).
- Ingress rotation: feed IngressHealth from heartbeats; hold-down = max(2 × hold-down, 120 s); persist
  intended record set at `ha:ingress_rotation`; re-add at most once per 10 min; two withdrawals in 30
  min pin the node (auto-release after window). Events `manual` (no DNS driver writes today).
- Databases: primary node silent ≥ `failover.graceSeconds` with replicas → advanceFailover to decide,
  chooseReplicaForPromotion under maxLagBytes/maxLagSeconds; integration point
  `registerDatabaseHandler({ run(stage, plan) })` (A8 promote can plug in); without handler or with
  failover off record `manual` event + critical alert.
- `status(principal)`, `history()` with canViewPlatform; register `ctx.failover`.
- Add `applied_at INTEGER` to 0060 (uncommitted, may still change; regenerate); remove
  `rebalanceReplicas()` call from maintenance.ts (~68) and update replicas-multinode.test.ts.
- Loop in hooks.server.ts (setTimeout chain every renewSeconds, skipped when SKIFF_STANDBY=1).
- `replicas.healthIntervalSeconds`: optional `healthIntervalSeconds` on RouteSpec (nodes.ts ~1182) →
  apps/agent/src/caddy-config.ts → packages/site-config/src/compile.ts (hard-coded '5s').
- Surfaces: REST `GET /api/v1/ha/status`, MCP `get_ha_status`, CLI `skif ha status`, Settings → HA /
  Clustering panels + history. Tests (loop, lease timing, fencing, flapping). Docs CLUSTERING.md C8 /
  §8.3, self-hosting/clustering.md.
- Unread keys left alone: overlay.maxHubs, endpoints.requireMtls, endpoints.forwarder,
  shares.mountRoot (other owners); storage.syncIntervalMinutes (A11), database.defaultMode (A8).

## A13 — Jobs

Done: contracts job.ts rewritten (argv commands, policies forbid/allow/replace, triggers
schedule/manual/retry, statuses, `jobLimits`, `JOBS_CAPABILITY`, agent wire schemas with run ids
`jr_<32 hex>`, views), job.test.ts; agent.ts `'jobs'` capability; log.ts optional `jobRunId`;
migration 0061_jobs.sql (jobs, job_runs, log_events.job_run_id) + schema.

Plan:
- Core `jobs.ts` JobService (wire into context/index): CRUD (list `project:read`; create/update
  `project:update`+`deployment:create`; pause `project:update`; run/cancel `deployment:create`);
  runNow, runOneOff, cancel; `scheduleDue(now)` with conditional UPDATE on next_run_at + `nextRun`
  from scheduler.ts, never replays missed runs, applies concurrency policy; retries via
  `retryDelayMs`; node protocol lease/heartbeat/complete/appendLogs; `sweep()` from maintenance
  (unclaimed → failed, lost leases → failed, keep last 100 runs); logs.ts routes `batch.jobRunId` and
  excludes job lines from project queries. Quota: register counters `jobs`/`jobRunsPerDay` via
  `core.quota.registerCounter`, call `assertCanCreateJob` before insert and `assertCanRunJob` before
  every run; a refused scheduled run is recorded `skipped`.
- Helper `jobs.ts`: POST /v1/jobs {run, workload, activation} (process/container apps only), GET
  /v1/jobs/:id, GET logs, POST stop, DELETE. `systemd-run --unit=skiff-job-<id> --no-block`
  Type=exec, RemainAfterExit=yes, Restart=no, RuntimeMaxSec + the app's sandbox properties; process
  apps: env file, LoadCredential secrets, volume binds, argv[0] inside release dir; containers:
  `podman run --rm --cgroups=split --log-driver=passthrough`; status from `systemctl show`
  (ExecMainCode, ExecMainStatus, Result). Wire server.ts + main.ts.
- Agent `jobs.ts` JobRunner: lease, start via helper, poll, drain logs to /api/agent/logs with
  jobRunId, heartbeat 15 s, stop on cancel/timeout, report, cleanup, persist `jobs-state.json`.
  helper-client methods, main.ts.
- Control-plane agent routes jobs/lease, jobs/heartbeat, jobs/result.
- REST `api/v1/projects/[slug]/jobs/**`, MCP tools (+ assistant WRITE_PERMISSION/CONFIRM_TOOLS), CLI
  `skif jobs …` + `skif run`, dashboard Jobs tab (TanStack Query). Tests; docs SCHEDULER.md,
  compute/scheduled-jobs.md, client pages.
- Decisions: own run table + lease; UTC only; current release only; app's limits; logs in log_events
  source='runtime' + job_run_id; transient units; no feature flag (capability gate).

## A14 — Blueprints

Done: contracts blueprint.ts v1 (`apiVersion: skiff/v1`, name, maps projects/databases/storage
(with buckets)/brokers, attachments list; project fields; strict + superRefine cross-checks;
helpers; plan/apply request + view schemas). mcp-data.ts import aliased.

Plan: rewrite blueprint.test.ts; mcp-data.ts `planStackInputSchema {blueprint: string}`,
`applyStackInputSchema {planHash}`, get_task unchanged; operations: action `blueprint.apply` (kind
`bulk`, targets [stackName]), internal params stripped from OperationView, optional
`beforeApply(principal, params, input)` hook in OperationService.apply (flag check
SKIFF_FEATURE_BLUEPRINTS, recompute plan hash → conflict if changed, prune needs confirm ===
stack name), authorize requires blueprint params; core `blueprints.ts` (JSON or Bun.YAML.parse;
diff via services; step order projects → environments → databases → storage → buckets → brokers →
workload settings → domains → attachments, prune reverse; plan fails on missing permission, missing
secret ref, immutable runtime/engine/variant change, major version change, taken slug/domain; plan
stored as planned operation (1 h), up-to-date items as skip; apply re-reads live state per step,
stops at first failure, rest skipped, no rollback; co-locate attached db/broker with first project;
finish hook writes stack record); migration `blueprints` table (id, org_id, name unique per org,
document_json, document_hash, managed_json, last_operation_id, last_status, applied_plan_hash,
applied_at, applied_by, timestamps); REST `api/v1/blueprints/` (GET list, plan, apply, validate,
[name]); CLI `skif blueprint validate|plan|apply [--yes] [--prune]` reusing run-operation helpers;
MCP plan_stack (read-only), apply_stack (destructive, signed confirmation bound to
`stack:<name>:<planHash>`, prune refused), get_task; assistant WRITE_PERMISSION `apply_stack:
'project:update'`; dashboard `(dashboard)/new/blueprint`; docs; tests (parsing, diffs, re-apply
no-op, partial failure).

## A16 — App volume lifecycle

Done: migration 0064 (app_volumes used_at, purge_requested_at, restore_snapshot_id; snapshots label,
method, quiesce, created_by, finished_at); contracts (snapshot id prefix `avs_`, methods
reflink|paused|idle|live, usage warn 90 %, views, `appVolumeRestoreSchema {name, sizeMb?}`, node
protocol schemas); agent.ts desired `appVolumes`/`appVolumePurges`/`appVolumeTasks`, heartbeat
`purgedAppVolumes`/`appVolumeUsage`/`appVolumeTaskResults`, capability `app-volumes`; helper
`app-volumes.ts` verbs usage (du -B1), purge, snapshot (systemctl freeze, reflink else frozen tar,
15-min cap), restore (into empty volume, clean on failure), routes POST /v1/app-volumes/*; core
toView/snapshots fill new fields; nodes.ts sends empty arrays (placeholder).

Plan: core `app-volume-lifecycle.ts` (`core.appVolumes.lifecycle`): snapshot create (resolve backup
target, refuse without capability, one pending per volume), list, delete (object too), restore into
new volume via `create()` (quotas apply); node side: tasks for node (presigned PUT/GET), apply usage,
task results, purge reports; `tick()` in maintenance (purge after trash window, fail tasks no node ran
in 6 h); usage alert (storageAlertPercent), gauges `skiff_app_volume_used_bytes` /
`skiff_app_volume_size_bytes` in metrics-export.ts; attach refuses a volume being restored. nodes.ts
real values + heartbeat handling. Agent runner `apps/agent/src/app-volumes.ts`, helper-client, main.ts
loop. REST, MCP, CLI (`skif volume snapshot|snapshots|restore|show`, near-quota warning, drop "not
implemented yet"), dashboard VolumesCard.svelte; docs VOLUMES.md §14, compute/volumes.md. Object key
`app-volumes/<org>/<volume>/<snapshot>.tar.gz`. Purging a volume deletes its snapshots.

## A11 — Object storage (remaining)

Done: migration 0059, contracts, core storage-replication-service.ts rewrite (per-rule keys, target
bucket rows, node-side methods, refusals), storage-instances.ts (link users/links in desired state,
`effectiveRoot()`, staged `rotateRootKey`/cancel/`applyRootKeyReports`, 10-min rollback,
`revealKey` via requireCredentialReveal, `mintStorageKeyPair` exported), nodes.ts/maintenance.ts
hooks; storage-replication-service.test.ts written (never run).

Remaining: agent copier `apps/agent/src/storage-replicator.ts` (list both sides; copy when missing /
size differs / source newer; etag compare only when neither multipart; multipart with ranged reads
> ~16 MiB, copy content-type and x-amz-meta-*; mirror deletes only after a complete source listing;
resume point JSON in agent data dir; report via heartbeat `storageReplication`; reach peer through
its node gateway signing for the peer's internal host sent as Host, with the link's key); root-key
accepted/rejected reports from storage-admin.ts reconciler (accepted when the activation's root key
works, rejected after 3 consecutive auth failures per key change); REST keys
(GET/POST /storage/:name/keys, DELETE …/keys/:id, POST …/keys/:id/reveal) and rotate-root
(POST/DELETE); MCP keys list/create/revoke (no reveal); CLI `storage keys list|create|reveal|revoke`,
`storage move <name> --node <node> [--yes]` (send `from: "empty"`), `storage rotate-root` (+cancel),
api.ts methods; dashboard Keys section, rotate/cancel buttons, Replication panel detail (error,
buckets, totals; hide Remove on target page), fix `addReplica` success text; docs.

## A15 — Log drains and audit (remaining)

Done: webhook signing (`webhook-signature.ts`, notify.ts payload with status/url/labels,
`SKIFF_ALERT_WEBHOOK_SECRET`, settings UI); audit.ts `page()` with cursor + `parseAuditTime`;
contracts log-drain.ts; core log-drains.ts `LogDrainService` (written, untested, unregistered);
migration 0063 (raw SQL table, no Drizzle schema).

Remaining: register `logDrains: new LogDrainService(ctx, options.version)` in createCore/Core; tests
(cursors, retry/dead-letter, signature, OTLP shape, egress block, permissions); core check; delivery
loop in hooks.server.ts (`setInterval(… deliverDue, 5000)`, primary only); REST
`/api/v1/log-drains`, `[id]`, `[id]/test`; CLI `skif log-drain`; MCP list/create (CONFIRM_TOOLS)/
test/delete (destructive, confirmation); `settings/log-drains` page + sections.ts entry
(organisation, `logs:read`); audit: REST `/api/v1/audit` branch in `routes/api/v1/[...path]` with
from/to/cursor → nextCursor, MCP `get_audit_log` params, dashboard date inputs + paging; `skif audit`
if it fits; docs (ALERTS.md §3, observe/alerts.md — still says unsigned —,
observe/dashboards-and-logs.md, DESIGN §8, client pages).
