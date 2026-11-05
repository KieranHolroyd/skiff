# 01 — Backups, PITR, and verified restore

**Priority:** P0 · **Effort:** M (dumps) / L (PITR) · **Lane:** A · **Wave:** 1
**Depends on:** F1 contracts, F2 streaming `ObjectStore`, F4 scheduler, 05 backup target (soft)
**Blocks:** 06 upgrade safety, 07 volume snapshots, 12 preview data, 17 portability, 20 agent tools
**Primary files:** `packages/contracts/src/backup.ts`, `packages/core/src/backups.ts`,
`apps/helper/src/backups.ts`, `apps/agent/src/backups.ts`,
`apps/control-plane/src/routes/api/v1/backups/**`, `docs/BACKUPS.md`

## Goal

Make managed Postgres and RustFS data recoverable with a restore that has actually been tested.
Ship in two phases: logical backups and restore-to-new first, then WAL-based PITR. A backup that
has never been restored is not a backup.

## Non-goals

- HA, read replicas, or automatic failover.
- Cross-region replication.
- Backup of platform SQLite (already covered by Litestream).
- A general-purpose backup scheduler for user files (that is 09; this plan uses the primitive).
- In-place restore by default. In-place is an explicit, typed-confirmed exception.

## Current state

- `docs/DATABASES.md` §8 lists `pg_dump → ObjectStore` as a follow-up; `docs/OBJECT-STORAGE.md` §10
  lists bucket replication as a follow-up.
- `MaintenanceService.run()` (`packages/core/src/maintenance.ts`) purges trash, expires uploads,
  checks nodes, rolls telemetry, and records platform backup runs. It has no data backup job.
- `backup_runs` (`packages/db/src/schema.ts`) is platform-level (`kind: backup | restore-drill`).
- `ObjectStore.put()` takes `Uint8Array` and buffers; `R2ObjectStore` reads the whole object into
  memory. This cannot carry a multi-GB dump.
- The control plane cannot reach node loopback (D57). Dumps and restores must execute on the node.
- Database credentials are sealed with the org key; `DatabaseService.credentials()` is human-only.
- The agent already samples Postgres (`apps/agent/src/database-stats.ts`) and runs a fixed-verb
  helper. There is no backup verb.

## Design

### Data model (new tables, one migration)

| Table | Columns |
|---|---|
| `backup_targets` | id, orgId nullable (null = platform), name, kind (`local`/`s3`), endpoint, bucket, region, pathPrefix, accessKeySealed, secretSealed, writeOnly, objectLock, status, lastCheckedAt, createdBy, timestamps |
| `data_backup_schedules` | id, orgId, resourceKind (`database`/`storage`/`volume`), resourceId, targetId, cron, timezone, retentionDays, keepDaily, keepWeekly, keepMonthly, enabled, encryption (`org`/`target`), createdBy, timestamps |
| `data_backup_artifacts` | id, scheduleId nullable, orgId, resourceKind, resourceId, targetId, objectKey, sizeBytes, checksum, format (`pg_dump`/`pgbackrest`/`tar`), engineVersion, encrypted, createdAt, expiresAt, pinned, restoreVerifiedAt, restoreRunId |
| `data_backup_runs` | id, scheduleId nullable, artifactId nullable, resourceKind, resourceId, targetId, kind (`backup`/`restore`/`drill`), status (`queued`/`running`/`ok`/`failed`), startedAt, finishedAt, bytes, error, detailJson |

Do not overload the platform `backup_runs` table; platform and managed-data runs have different
retention and UI.

### Contracts (`packages/contracts/src/backup.ts`)

- `backupTargetSchema` / `backupTargetView` (never returns secrets).
- `backupScheduleSchema`, `backupArtifactView`, `backupRunView`.
- `backupTaskSchema` (desired-state task): id, resourceKind, resourceId, target, format, compression,
  encryption, objectKey, credentialsRef.
- `backupResultSchema` (heartbeat): taskId, status, artifact metadata, error.
- `restoreRequestSchema`: artifactId or target+objectKey, target resource name, mode
  (`new`/`in-place`), confirmation token, options (timestamp for PITR).
- `databaseBackupProfileSchema`: engine, version, format, pgBackRest stanza, WAL settings.

Keep the wire free of credentials. The agent fetches target and resource credentials through a new
`GET /api/agent/backup-tasks/:id/activation`, the same pattern as workload activation.

### Service (`packages/core/src/backups.ts`)

- `BackupService` with `listTargets`, `createTarget`, `testTarget`, `listSchedules`,
  `createSchedule`, `updateSchedule`, `deleteSchedule`, `runNow`, `listArtifacts`, `restore`,
  `drill`, `tick`.
- `tick()` is called from `MaintenanceService.run()` (or its own 60 s loop): claim due schedules,
  create `queued` runs, and expose pending tasks in `desiredState.backupTasks` for the node.
- Idempotency key: `scheduleId + scheduledMinute`; a retry does not create a duplicate artifact.
- Retention: compute keep set (daily/weekly/monthly, pinned always kept); delete artifacts and
  target objects; record GC.
- Restore: create a new resource by default; generate new credentials; run a verification query;
  return a `RestoreView` with connection details (no password). In-place requires
  `confirm: "<resource-name>"` plus a pre-restore artifact.
- Drill: restore the newest artifact into a throwaway database, run `pg_amcheck` and a canary
  query, record `restoreVerifiedAt`, drop the throwaway.

### Helper (`apps/helper/src/backups.ts`)

New fixed verbs, all validated, no shell:

| Verb | Behavior |
|---|---|
| `database.dump` | `podman exec <db-id> pg_dump -Fc -Z 6 -f /tmp/<run>.dump <db>`; stream the file out; remove it. Args are fixed; database name is validated. |
| `database.restore` | `podman exec -i <db-id> pg_restore --clean --if-exists --no-owner -d <db>`; stdin is the artifact stream. |
| `database.basebackup` | Start a `pgBackRest` sidecar with the data volume, `stanza-create`, `backup --type=full|diff`; write to the target via the sidecar's S3 config. |
| `database.pitr-restore` | Create a new database container from the base backup, run `pgbackrest restore --type=time --target=<ts>`, start, verify. |
| `storage.snapshot` | For RustFS: ask the agent to run bucket versioning/sync (see 02), or tar the data dir only with the container stopped (offline snapshot). Prefer bucket-level replication for online. |
| `volume.snapshot` | Quiesce optional, tar/rsync to a staging path, stream out; record checksum. |

Phase 1 only needs `database.dump` and `database.restore`. Phase 2 adds the pgBackRest verbs. The
helper never receives a target URL with credentials in the unit file; the agent streams to the
target itself, or writes a `0400` pgBackRest config file under `/run/skiff-workloads/<id>/`.

### Agent (`apps/agent/src/backups.ts`)

- Poll `desiredState.backupTasks` (or a dedicated `backupTasks` field) and execute one task at a time
  per node to bound I/O.
- Fetch activation credentials; call the helper verb; stream bytes to the target with the F2
  `putStream`; compute SHA-256 while streaming.
- Report `backupResults` in the heartbeat: status, bytes, checksum, duration, error (scrubbed of
  credentials).
- On restore: fetch the artifact via `getStream`, stream to the helper's restore verb, then run a
  verification query through the existing sampler connection.
- Never persist credentials; use the same in-memory activation pattern as D57.

### S3-first restore browser

The restore UI must list artifacts from the target, not from SQLite. Implement
`BackupService.listTargetArtifacts(targetId, prefix)` with `ObjectStore.list`, merge with known
metadata, and mark "unknown" artifacts as restorable with a manifest read. This directly fixes the
Coolify failure mode where a control-plane restore hides newer S3 backups.

### Surfaces

- REST: `/api/v1/backup-targets`, `/api/v1/backups/schedules`, `/api/v1/backups/artifacts`,
  `/api/v1/backups/runs`, `/api/v1/backups/restore`, `/api/v1/backups/drill`.
- MCP: `list_backups`, `get_backup_health`, `restore_backup` (confirmed, human-only for in-place),
  `run_backup_drill` (platform admin). Never return target secrets.
- CLI: `skif backup target|schedule|list|run|restore|drill`.
- Dashboard: resource "Backups" tab, target picker, schedule editor, artifact list, restore wizard,
  drill badge, "last verified restore" timestamp.
- Alerts: missed schedule, backup older than SLO, upload/checksum failure, drill failure, target
  unreachable.

## Implementation order

1. Contracts + tables + migration (contract PR, no behavior).
2. `ObjectStore.putStream/getStream` (F2) and a fake target for tests.
3. `BackupService` with local target, manual dump, restore-to-new, artifact list.
4. Helper `database.dump` / `database.restore` + agent task loop + heartbeat result.
5. UI/CLI/MCP for manual backup and restore.
6. Scheduler (`F4`) + retention + failure alerts.
7. Restore drill + verification.
8. S3 target (05) + encryption + object lock.
9. PITR phase: pgBackRest sidecar, WAL archive, timestamp restore, retention window.
10. RustFS bucket snapshots/versioning; volume snapshots (07).

## Acceptance criteria

- [ ] A manual backup of a 1 GB Postgres database completes without loading the dump into control-plane
      memory; the artifact is in the target with a checksum.
- [ ] Restore creates a new database with new credentials; a canary row matches; the source is
      untouched.
- [ ] A restore from a target works after the control-plane SQLite is replaced with an older copy
      (S3-first listing).
- [ ] A missed schedule and a failed upload each fire an alert within two sweeps.
- [ ] A monthly drill records `restoreVerifiedAt` and is visible in the UI and `get_backup_health`.
- [ ] PITR restores to a chosen minute within the retention window and passes the canary query.
- [ ] No target secret appears in logs, desired state, MCP output, or the dashboard.
- [ ] The feature is off by default until the drill passes on a Debian 13 node.

## Tests

- Unit: retention math, idempotency, encryption/decryption, artifact metadata, restore target
  validation.
- Integration: fake helper + fake S3; dump/restore round-trip; failure on checksum mismatch; target
  unreachable; duplicate cron tick.
- Real node: Debian 13 + Podman, 1 GB fixture, stop the container mid-dump (failure), restore into a
  new database, pgBackRest PITR to T-5m.
- Security: no credential in logs; target key is write-only; object lock prevents delete.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Restore is wrong | Restore-to-new default, verification query, monthly drill, canary table |
| Dump buffers in memory | F2 streaming; test with 1 GB; reject non-stream path |
| Scheduler stops silently | Missed-run alert, last-success badge, external heartbeat |
| PITR complexity | Ship dumps first; PITR behind its own flag; do not claim it until tested |
| Cross-node transfer | Run on the database's node; agent streams to target; no control-plane proxy |
| Encryption key loss | Recovery kit covers the org key; document the target key escrow |

## Rollout

`SKIFF_FEATURE_BACKUPS_RESTORE` off by default. Enable for dev, then a single-node staging install,
then the Debian 13 node. `SKIFF_FEATURE_PITR` remains off for one release after dumps are stable.

## Open questions

- pgBackRest vs WAL-G: pick pgBackRest for its S3 support and restore-to-time; WAL-G is a fallback.
- Do we keep a local artifact copy for fast restore, or always stream from the target?
- How long do we retain verified drills? Default 12 months of drill *records*, not artifacts.

## File ownership

Own: `packages/contracts/src/backup.ts`, `packages/core/src/backups.ts` + test,
`apps/helper/src/backups.ts` + test, `apps/agent/src/backups.ts` + test,
`apps/control-plane/src/routes/api/v1/backups/**`, `docs/BACKUPS.md`.

Integration-owned (one-line registrations): contracts index, schema, migrations, core context/index,
agent main, helper server/systemd, MCP registry, CLI main, dashboard layout, e2e harness.
