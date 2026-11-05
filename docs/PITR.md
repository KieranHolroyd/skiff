# Point-in-time recovery (PITR)

Status: **foundation implemented behind `SKIFF_FEATURE_PITR`, not production-ready.** The flag is
off by default. Logical `pg_dump` backups and restore-to-new remain the supported path
([DATABASES.md](./DATABASES.md) §8); PITR does not replace them.

This document covers the pgBackRest profile, the helper verbs, the agent task loop, the
control-plane state and the restore drill. Read the **Known gaps** section before enabling it.

## What is implemented

- A pinned pgBackRest sidecar profile (`docker.io/woblerr/pgbackrest:2.59.3@sha256:…`) that gets
  read/write access to one database's data volume plus read-only config files.
- Repository config and `.pgpass` written by the helper as `0400` files under
  `/run/skiff-workloads/<database id>/`. Credentials never enter desired state, SQLite or a view.
- WAL archive settings (`wal_level=replica`, `archive_mode=on`, `archive_command=… archive-push
  %p`, `archive_timeout=60`) rendered into the Postgres container at create/update **when PITR is
  enabled for that database**.
- Weekly full (Sunday 02:00 UTC) and daily differential (Monday–Saturday 02:00 UTC) base backups
  driven by the durable scheduler (`kind: database.pitr.basebackup`).
- Fixed helper verbs, no shell strings: `pitr/configure`, `pitr/basebackup`,
  `pitr/restore`, `pitr/status`.
- Agent task loop (`databasePitrTasks` → result on the next heartbeat) additive to
  `databaseBackupTasks`; logical backup tasks keep working unchanged.
- Migration `0020_database_pitr.sql`: `database_pitr` (stanza, credential-free repo, last base
  backup, archive status, last restore target, `verified_at`) and `database_pitr_tasks`.
- A **scriptable** restore drill (below).

## Prerequisites

1. **A Postgres image that ships pgBackRest.** The stock `docker.io/library/postgres:<version>-alpine`
   image used by the database profile does **not** include `pgbackrest`. Build and pin a custom
   image that adds the `pgbackrest` binary at `/usr/local/bin/pgbackrest` (and the AWS CLI/S3
   dependencies pgBackRest needs), then point `SKIFF_DATABASE_IMAGE_*`/the helper registry at it.
   Until that image exists, WAL archiving will fail and `archive_mode=on` will retain WAL on the
   data volume. This is the main integration gap; do not enable PITR without it.
2. **An S3-compatible repository.** The control plane needs:
   - `SKIFF_PITR_REPO_BUCKET`
   - `SKIFF_PITR_ACCESS_KEY_ID`
   - `SKIFF_PITR_SECRET_ACCESS_KEY`
   - optional `SKIFF_PITR_REPO_ENDPOINT` (AWS S3 when unset)
   - optional `SKIFF_PITR_REPO_REGION` (default `us-east-1`)
   - optional `SKIFF_PITR_REPO_PREFIX` (default `skiff/pitr`)
   - optional `SKIFF_PITR_REPO_FORCE_PATH_STYLE` (default `true`; RustFS/MinIO/Garage need it)

   An incomplete set fails closed with `PITR is enabled but no pgBackRest repository is
   configured`. A dedicated bucket/prefix per install is recommended; the stanza name is derived
   from the database id and `repo1-path` is scoped to it.
3. **Same-node restore target.** The target database is created on the source database's node so
   the helper can resolve both data dirs. The sidecar can read from S3, but the new instance and
   the source must share a node in this slice.
4. **A retention window.** Full backups are kept for 4 weeks, differentials for 7 days. Restore
   timestamps older than `4 × 7 + 7 = 35` days are rejected by the helper and the service.
5. **Disk headroom** for at least one base backup and the WAL spool on the node.

## Enable

```sh
SKIFF_FEATURE_PITR=on
```

Then enable it for a database with the REST surface (MCP/CLI/dashboard are not wired yet):

| Method | Path | Body |
|---|---|---|
| `GET` | `/api/v1/databases/:name/pitr` | — (status, includes `verifiedAt`) |
| `PATCH` | `/api/v1/databases/:name/pitr` | `{ "enabled": true }` |
| `POST` | `/api/v1/databases/:name/pitr/backups` | `{ "type": "full" }` |
| `POST` | `/api/v1/databases/:name/pitr/restore` | `{ "name": "new-db", "targetTime": "2026-11-05T09:30:00.000Z" }` |

The same methods exist on the service: `DatabaseService.setPitrPolicy`, `pitrBackup`,
`restoreToTimestamp` and `pitrStatus`.

The first base backup also runs `stanza-create`, so an empty repository needs no manual setup.

## RPO / RTO expectations

| Metric | This slice |
|---|---|
| **RPO** | WAL is pushed continuously; `archive_timeout=60` forces a segment switch after 60 s of low traffic. Expect **≤ 1 minute** of lost transactions after a healthy archive, plus the time of the last failed push. Archive failures are surfaced through `pitr/status` (`archiveStatus: failing`) but are not yet alerted. |
| **RTO** | Restore downloads the base backup and replays WAL from S3. It is **dominated by network bandwidth and database size**. A same-node restore additionally stops the target, replaces its data dir and starts Postgres. There is no measured RTO yet; the drill below records it. |
| **Retention** | 4 full backups (≈4 weeks) and 7 differentials. The repository is pruned by pgBackRest on each backup. |
| **Verification** | A restore is marked verified only after the target container answers `SELECT 1`. The monthly drill builds on the same path. |

## Restore procedure

1. Confirm the backup repository is healthy:
   ```sh
   skiff-helper … /v1/workloads/db_<id>/pitr/status   # via the helper socket
   ```
   `configured: true` and `archiveStatus: ok` are the minimum. `failing` means WAL is not landing;
   do not promise a low RPO until it recovers.
2. Pick a timestamp inside the retention window, with an offset or `Z`:
   `2026-11-05T09:30:00.000Z`.
3. Queue the restore:
   `DatabaseService.restoreToTimestamp(principal, 'source-name', { name: 'source-pitr', targetTime })`.
   The control plane creates a **new** database with new credentials on the source node, pauses
   its scheduled dumps and records `last_restore_target_at`.
4. The node fetches `GET /api/agent/database-pitr/<task id>` for the repository credentials, writes
   them as `0400` files, stops the new target, runs
   `pgbackrest --type=time --target=<ts> --target-action=promote restore`, starts the target and
   runs the canary query.
5. On heartbeat success the control plane sets `verified_at`, marks the target `running` and
   resumes its logical backup schedule. On failure the target stays `failed` with the node's error.
6. Attach the new database to an app or compare rows before switching traffic. **In-place restore
   is not supported.**

## Restore drill

`scripts/pitr-drill.sh` is a scriptable drill wrapper (no automation is wired into the maintenance
sweep yet). It:

1. Reads `SKIFF_PITR_DRILL_DATABASE` and `SKIFF_PITR_DRILL_TARGET_TIME`.
2. Calls the control plane's service through the CLI/API to queue `restoreToTimestamp`.
3. Polls `pitrStatus` until `verifiedAt` is set or a timeout expires.
4. Runs a canary query against the restored database (default: `SELECT 1` plus an optional
   table/row assertion via `SKIFF_PITR_CANARY_SQL`).
5. Prints the elapsed time and exits non-zero on failure.

Until the custom Postgres image and an S3 repository exist on a Debian 13 node, the drill has not
been run. `verified_at` in this slice is therefore only produced by a successful node restore, not
by a production drill.

## Known gaps

- **No custom Postgres image is shipped.** WAL archiving cannot work with the current pinned
  `postgres:*-alpine` image. The sidecar image is pinned, but the archive writer runs inside the
  Postgres container. This is the blocking integration point.
- **No real restore drill has run.** Do not enable PITR on an install until the drill in this
  document passes on a Debian 13 node.
- **No MCP/CLI/dashboard surface yet.** The service methods, minimal REST routes and helper verbs
  exist; the broader backup UI still shows logical backups only.
- **No alerting** for `archiveStatus: failing` or a missed base backup. The state is recorded but
  not paged.
- **Same-node only.** Cross-node restore and volume-registry resolution for a target that has not
  been applied yet are not implemented.
- **No repository encryption.** `repo1-cipher-type=none` relies on bucket encryption and access
  control; escrow for a pgBackRest cipher passphrase is not designed.
- **Backup-target integration is env-only.** Plan 05 (`0019_backup_targets.sql`) is expected to
  supply the target row; this slice reads the repository from the environment and does not join
  them yet.
- **Restore target time validation is fixed at 35 days** and does not parse the repository's
  actual retention metadata.
