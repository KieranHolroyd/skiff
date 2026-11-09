# Point-in-time recovery (PITR)

Status: **implemented end to end behind `YOAL_FEATURE_PITR`, on by default, not yet proven on
Linux.** It does nothing until the pgBackRest repository is configured; the restore drill below has
not yet passed on a Debian 13 node with Podman.
Logical dumps and restore-to-new remain the supported path ([DATABASES.md](./DATABASES.md) §8);
PITR does not replace them.

What has been verified: unit tests for every renderer, parser and verb (helper, agent, core, CLI),
and the exact archive → backup → time-restore → promote → rename → password-login sequence the
helper runs, reproduced by hand with Docker on arm64 against a local pgBackRest repository (the
restore to time T kept the 100 rows written before T and none of the 100 written after). What has
not: Podman + Quadlet + systemd on Debian 13, an S3 repository, SELinux/AppArmor labels, amd64.
See [What still needs a live check](#what-still-needs-a-live-check).

## Scope

- **PostgreSQL 18 on the standard image only.** 16/17 run the alpine image and the D126 variants
  (`postgis`, `pg_cron`) have no pgBackRest build; enabling PITR on them is refused with the reason
  (`pitrUnsupportedReason`). Upgrade first.
- **One S3-compatible repository per install**, from the control plane's environment.
- **Restores always create a new database on the source's node.** In-place restore and cross-node
  restore are out of scope.

## How it works

```text
             control plane                          node (agent + helper)
  ┌────────────────────────────────┐      ┌───────────────────────────────────────────────┐
  │ database_pitr (policy, window) │      │ yoal-workload-db_x  (yoal-postgres-pitr:18-1) │
  │ database_pitr_tasks            │ ───▶ │   archive_command → pgbackrest archive-push ──┼──▶ S3 repo
  │ tickPitr: full/diff schedule,  │ task │   RunInit=true, /etc/pgbackrest ← config dir  │
  │   status every 15 min          │      │ podman exec: stanza-create, backup, info, psql│
  │ restoreToTimestamp → new db    │ ◀─── │ restore: one-shot pgbackrest restore, then a  │
  └────────────────────────────────┘result│   one-shot Postgres that replays and promotes │
                                          └───────────────────────────────────────────────┘
```

### Image

`ghcr.io/kieranholroyd/yoal-postgres-pitr:<major>-<revision>` (`18-1` today), built from
`docker/postgres-pitr/Dockerfile`: the pinned pgvector Postgres 18 image (D124, by digest) plus the
PGDG `pgbackrest` package at an exact version, with `/usr/local/bin/pgbackrest` symlinked. Nothing
else changes (entrypoint, uid 70 via nss_wrapper, extensions), so switching a database between the
standard and the PITR image is a restart, not a migration.

`.github/workflows/postgres-pitr-image.yml` builds amd64 and arm64, smoke-tests both (binary as
uid 70 on a read-only root, Postgres major) and runs archive-push → stanza-create → check → full
backup → info → restore against a local repository on amd64 before pushing. **It never overwrites
a published tag**: a change to the Dockerfile, its base digest or the pgBackRest version bumps
`REVISION` in the workflow, `POSTGRES_PITR_IMAGE_REVISION` in `packages/contracts/src/database.ts`
and the helper's copy in `apps/helper/src/validate.ts`. The run prints the digest; pin it as
`POSTGRES_PITR_IMAGE_DIGEST` in both files (it is `null` until the first publish, so the helper
accepts the tag only).

Both registries (contract and helper) choose the image from `engine + version` and the presence of
`database.pitr`; the helper rejects any other image for a PITR workload, and rejects `pitr` on a
variant or on 16/17.

### The database unit

When desired state carries `database.pitr` (flag on, policy enabled, supported version) the Quadlet
unit gets, in addition to the normal Postgres profile:

- `Image=` the PITR image;
- `-c wal_level=replica -c archive_mode=on -c archive_timeout=60 -c archive_command=/usr/local/bin/pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=<stanza> archive-push %p`;
- `Volume=/run/yoal-workloads/<id>/pgbackrest:/etc/pgbackrest:ro,z`: the **directory** is
  mounted, so a rewritten config reaches the running container without a restart, and the label is
  shared (`z`) because the restore's one-shot containers mount the same directory while the
  database runs;
- `RunInit=true`. pgBackRest's async archive-push forks a background process and exits; that
  orphan is reparented to PID 1. With Postgres as PID 1, a non-zero exit of the orphan (no stanza
  yet, an S3 blip) is an "untracked child process" and the postmaster kills every backend and runs
  crash recovery. This was reproduced on the 18-1 image (a reset at start and every 60 s while the
  stanza was missing) and is gone with an init process.

The helper creates the config directory (0700, uid 70) before writing the unit, because a missing
bind-mount source fails the start. The spool (`/data/pgbackrest-spool`) lives on the data volume
beside `pgdata`, since the root filesystem is read-only.

### Generated config

`renderPgBackRestConfig` writes `pgbackrest.conf` and `pgpass` (0400, uid 70) on
`pitr/configure`. Postgres is reached over the container's Unix socket
(`pg1-socket-path=/var/run/postgresql`, `pg1-user=<owner>`): pgBackRest must run beside Postgres,
so backups are `podman exec` into the database container, never a sidecar. Repository settings:
`repo1-s3-endpoint` is the bare host (AWS S3 gets `s3.<region>.amazonaws.com`), a non-default port
goes to `repo1-storage-port`, plain `http://` endpoints are refused (pgBackRest's S3 client is
TLS-only), `repo1-path=/<prefix>/<stanza>` scopes each database, retention is 4 full / 7 diff
(count), `repo1-cipher-type=none` (bucket encryption and access control), `archive-async=y` with a
1 GiB push queue, zstd level 3, `process-max=2`, `start-fast=y`, file logging off (warnings go to the
journal through stderr; a busy archive would otherwise fill the 64 MB `/tmp`).

`/run` is a tmpfs: after a reboot the files are gone and archive-push fails until the next task. The
agent calls `pitr/configure` before **every** PITR task, and the control plane queues a `status`
task every 15 minutes, so the config is back within one interval.

### Helper verbs

Fixed verbs under `/v1/workloads/<db id>/pitr/…`; no argv or shell from the wire:

| Verb | What it runs |
|---|---|
| `configure` | Writes the two files into the config directory. Restarts nothing. |
| `basebackup` | `podman exec … pgbackrest --stanza=<s> stanza-create`, then `--type=<full\|diff\|incr> backup`. |
| `status` | `pgbackrest --output=json info` and `SELECT … FROM pg_stat_archiver` by `podman exec`, reduced to the window (`computePitrWindow`). |
| `restore` | See below. |

`restore` into a new database (the target must already be applied: env file, data dir, unit):

1. Validate both ids, the time (not future, ≤ 35 days), the source's `PG_VERSION` → PITR image, and
   the rename SQL. Nothing is touched if any of these fail.
2. Mark the target as restoring (the helper's `apply` refuses it until the end, so the agent's
   reconcile cannot restart it), stop its unit, empty its data dir, create `pgdata` and the spool.
3. One-shot `podman run --rm … pgbackrest restore --type=time --target='YYYY-MM-DD HH:MM:SS.mmm+00' --target-action=promote`
   (pgBackRest picks the backup set by parsing `--target` itself and does not understand ISO
   `T…Z`), with the target's data dir (`:Z`) and the source's config dir (`:ro,z`).
4. A detached one-shot Postgres (`--init`, the image entrypoint, `listen_addresses=`,
   `archive_mode=off` so it never pushes into the source's stanza) replays WAL; the helper polls
   `pg_is_in_recovery()` until it promotes. If the container exits (target past the archive, WAL
   missing) its last log lines are the error.
5. Hand the cluster over (`renderPitrRenameSql`, SQL on stdin): as the source owner create a
   temporary superuser; as that role rename the owner role and database to the target's, set the
   target's password and `ALTER SYSTEM RESET` the recovery settings; as the renamed owner drop the
   temporary role. Then stop the container cleanly.
6. Start the target unit and prove a **password login over TCP** as the target owner.

### Agent

`DatabasePitrRunner` runs a task only when every database it touches has been running on its
current activation (the stats sampler's targets) for 30 s: enabling PITR restarts the database on
the PITR image, and a task must not `podman exec` into the old container. A restore waits for both
the source and the target. Credentials come from `GET /api/agent/database-pitr/<task id>` just
before the task and never reach the desired-state cache. Status results carry the window.

### Control plane

- `setPitrPolicy(enabled)`: flag, capability, `pitrUnsupportedReason` and repository checks;
  enabling queues the first **full** backup immediately (a window needs one) besides the weekly full
  (Sunday 02:00 UTC) and daily diff (Monday–Saturday 02:00 UTC) schedule. Moving a database is
  refused while PITR is on.
- `tickPitr` (maintenance sweep): due full/diff slots through the durable scheduler, and a `status`
  task per enabled database every `PITR_STATUS_INTERVAL_MS` (15 min), never two waiting at once. A
  finished base backup queues a status check at once.
- **Window** (migration 0070: `recoverable_from_at`, `recoverable_to_at`, `window_checked_at`):
  opens at the oldest retained backup's stop time and closes at the archiver's last success
  (never before the newest backup's stop). A failing archive still reports the window up to its
  last success and records the error.
- `restoreToTimestamp`: rejects a time in the future or beyond 35 days, then against the window:
  before `recoverableFrom` is refused; after `recoverableTo` is refused unless the last check found
  a healthy archive, in which case the bound is `now − 2 × archive_timeout` (WAL keeps landing
  every 60 s). No window yet (no base backup reported) means no restore. The target is created with
  fresh credentials on the source's node, `pending`, scheduled dumps paused.
- **Heartbeat hold**: while the newest restore into a database is unfinished or failed, node
  heartbeats do not change its status. The node starts the empty target first (and may start an
  empty cluster again after a failed restore); without the hold it would look `running`. A
  successful restore marks it `running`, sets `verified_at` and resumes its dumps.

### Surfaces

| Surface | Status | Enable / disable | Base backup | Restore to a time |
|---|---|---|---|---|
| REST | `GET /api/v1/databases/:name/pitr` | `PATCH …/pitr {enabled}` | `POST …/pitr/backups {type}` | `POST …/pitr/restore {name, targetTime}` |
| CLI | `yoal db pitr <name>` | `--enable` / `--disable [--yes]` | `yoal db pitr-backup <name> [--type]` | `yoal db restore-to <name> --time <ISO> --as <new>` |
| MCP | `get_database_pitr` | `set_database_pitr` | `backup_database_pitr` | `restore_database_to_time` |
| Dashboard | Database → Backups → **Point-in-time recovery** panel (turn on/off, base backup, restore dialog with a local-time picker) | | | |

MCP tools and the dashboard panel are offered only while the flag is on. The assistant asks for a
click before `set_database_pitr` and `restore_database_to_time`. Permissions: status
`database:read`; policy and base backups `database:update`; restore `database:create`.

## Enable it

Do these in order; do not skip the drill.

1. **Publish the image.** Merge a change to `docker/postgres-pitr/**` (or run the workflow by
   hand) and pin the printed digest as `POSTGRES_PITR_IMAGE_DIGEST` in
   `packages/contracts/src/database.ts` and `apps/helper/src/validate.ts`. Ship that release to the
   control plane and every node.
2. **Configure the repository** on the control plane (a dedicated bucket or prefix per install):
   `YOAL_PITR_REPO_BUCKET`, `YOAL_PITR_ACCESS_KEY_ID`, `YOAL_PITR_SECRET_ACCESS_KEY`, and as needed
   `YOAL_PITR_REPO_ENDPOINT` (https only; AWS S3 when unset), `YOAL_PITR_REPO_REGION`
   (`us-east-1`), `YOAL_PITR_REPO_PREFIX` (`yoal/pitr`), `YOAL_PITR_REPO_FORCE_PATH_STYLE`
   (`true`; RustFS/MinIO/Garage need it). An incomplete set fails closed.
3. **Turn the flag on** for a test install: `YOAL_FEATURE_PITR=on`, restart the control plane.
4. **Run the drill** on a Debian 13 node (below) against a throwaway PostgreSQL 18 database. It must
   print `PASS`.
5. Only then enable PITR per database: `yoal db pitr <name> --enable` (or the dashboard). Watch
   `yoal db pitr <name>` until the first base backup and the recoverable window appear.

## RPO / RTO

| Metric | Expectation |
|---|---|
| **RPO** | WAL is pushed continuously; `archive_timeout=60` forces a segment switch after 60 s of low traffic. Expect ≤ 1 minute of lost transactions with a healthy archive. A failing archive shows as `archiveStatus: failing` with an error on the status (not yet alerted). |
| **RTO** | Download of the base backup plus WAL replay from S3: bandwidth and database size. The drill prints it. |
| **Retention** | 4 full backups (≈ 4 weeks) and 7 differentials, pruned by pgBackRest after each backup. |
| **Verification** | A restore is verified only after the target answers a password login as its new owner. |

## Restore drill

`scripts/pitr-drill.sh`, run **on the database's node** with `psql` (the connection URLs point at
`127.0.0.1`) and a token with `database:read`, `database:create`, `database:credentials` (and
`database:delete` to clean up):

```sh
YOAL_CONTROL_URL=https://control.example.com YOAL_API_TOKEN=… \
YOAL_PITR_DRILL_DATABASE=pitr-test ./scripts/pitr-drill.sh
```

It checks that PITR is on with a window and a healthy archive, writes a marker row, records the
time, writes a second marker, waits for the archive, restores to the recorded time into a new
database, waits for the verified restore, and requires the first marker present and the second
absent. It prints the RTO, moves the copy to the trash (`YOAL_PITR_DRILL_KEEP=1` keeps it) and
exits non-zero on any failure. `YOAL_PITR_DRILL_TARGET_TIME` restores to a given time instead, with
`YOAL_PITR_CANARY_SQL` as the only check. A scheduled monthly drill is not wired yet.

## What still needs a live check

On a Debian 13 node with the published image, Podman 5 and an S3 repository (the drill covers the
first six):

1. Quadlet accepts `RunInit=true` and Podman finds an init binary (`catatonit`); without one the
   unit fails to start.
2. Rootful Podman with `User=70:70` reads the 0700/0400 uid-70 config directory through the
   `:ro,z` mount, from both the database container and the restore one-shots, under AppArmor (and
   SELinux on a Fedora-family host).
3. archive-push and archive-get against a real S3 endpoint (AWS, R2, RustFS/MinIO), including
   `repo1-storage-port` and path-style addressing.
4. `stanza-create` + full backup via `podman exec` into the running unit; diff/incr backups.
5. The full restore on a volume-backed and a state-dir target, and the agent's settle/ready gating
   while the target restarts (the helper refusing `apply` mid-restore).
6. The 15-minute status task after a node reboot (tmpfs config rewritten, archive recovers).
7. amd64 (the local repro was arm64); the workflow's amd64 smoke test covers the image, not
   Podman.
8. Disk headroom: the 1 GiB archive-push queue on the data volume when S3 is down.

## Known gaps

- **Only PostgreSQL 18 on the standard image.** 16/17 and the D126 variants need their own PITR
  builds.
- **Same-node only.** The target is created on the source's node; cross-node restore and a target
  that has not been applied yet are not supported.
- **No alerting** for `archiveStatus: failing` or a missed base backup; the state and error are
  recorded and shown, not paged.
- **The restored cluster carries the source's other roles** (named credentials, `yoal_monitor`)
  with the source's passwords. Only the owner is renamed and re-keyed. Drop or re-key named roles
  on the copy before handing it out; the copy's metrics need its monitor role re-keyed (a live
  check: whether the agent's monitor bootstrap re-runs after the restore).
- **No repository encryption.** `repo1-cipher-type=none` relies on bucket encryption and access
  control; escrow for a pgBackRest cipher passphrase is not designed.
- **Disabling keeps the repository.** Turning PITR off stops archiving and switches back to the
  standard image; the stanza's backups and WAL stay in the bucket until removed by hand.
- **Backup-target integration is env-only.** Plan 05 (`0019_backup_targets.sql`) is expected to
  supply the target row; this slice reads the repository from the environment and does not join
  them yet. Logical backups record the target and location they were written to (0053,
  DATABASES.md §8); when PITR joins backup targets, `database_pitr` needs the same record (the
  repository a stanza was written to), so switching targets never points a restore at a
  repository that does not hold the stanza's WAL.
- **The image digest is not pinned** until the workflow has published `18-1`; until then the helper
  accepts the tag.
