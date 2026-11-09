# Skiff — App volumes

Status: **MVP built (plan 07)**. An app volume is a project-owned directory with a size quota that a
process or container workload mounts at an absolute path. Where its data lives is chosen like any
other service's storage: the system disk or a disk ([STORAGE.md](./STORAGE.md), D169).
Enabled by `SKIFF_FEATURE_APP_VOLUMES` (off by default); it never replaces the legacy `/data`
mount.

## Model and backing

| Table | Purpose |
|---|---|
| `app_volumes` | Project, name, node, backing (`node_volume`/`state_dir`), disk id (`node_volume_id`), quota, usage (`used_bytes`, `used_at`), last mount path, status, single-writer flag, soft-delete timestamps (`deleted_at`, `purge_at`, `purge_requested_at`), `restore_snapshot_id` while it is being filled from a snapshot. |
| `app_volume_attachments` | Volume, workload, environment, sandbox mount path, read-only flag. |
| `app_volume_snapshots` | Snapshot metadata: recorded target (`target_id`, `target_name`, `location_json`), object key, size, sha256, status, error, label, method, quiesce, pinned, creator, created/finished, restore-verified time. |

A volume pins its project to one node. Create takes `storage` like every other service
(`system`, `fast`, `bulk` or a disk name; default from Settings → Storage). On a disk the row
stores `backing: node_volume` (the stored and wire value) with the disk id, and the helper
resolves `<disk mount>/skiff/apps/<projectId>/<volumeId>`.
With `backing: state_dir` it uses `<helper state dir>/apps/<projectId>/<volumeId>`. Only that
subtree is created; the host path is derived on the node and is never stored or returned by the
API. A project-facing view contains the volume name, size, usage, status, attachments and — for a
disk backing — only `disk: { id, name, tier, remote }`.

## Mount rendering and fail-closed starts

`WorkloadDesired.volumes` carries `{ id, mountPath, readOnly, backing, nodeVolumeId? }`; it never
carries a host path or device. Before writing a unit the helper:

1. resolves each mount through its own disk registry or its state directory;
2. verifies a disk backing with `findmnt` and the registered stable source key;
3. refuses the start if the registry entry or mount is missing — it never creates the directory
   under an empty mountpoint or falls back to the root disk;
4. creates only the per-volume subtree.

Process units render `BindPaths=<host>:<mountPath>` (or `BindReadOnlyPaths`) plus
`ReadWritePaths`; container units render `Volume=<host>:<mountPath>[:ro]:Z`. Mount points are
validated by the same rules as the contract: absolute, normalized, no traversal, not a system
tree, not `/data`, not `/var/lib/skiff`.

## Size quota, disk admission and single writer

`sizeMb` is the quota and the disk-admission input. The org quotas `appVolumes` and
`appVolumeBytes` (docs/QUOTAS.md) are checked first, against live (not trashed) volumes and their
configured `sizeMb`; growth checks only the delta. Create and grow are then refused when
`reserved + requested > 90% of free`, naming the free, reserved and requested megabytes; a node
that has not reported `diskFreeBytes` yet is refused instead of guessed at. State-dir volumes
reserve against the node's data-disk free space; disk-backed volumes reserve against that
volume's reported `freeBytes`. Usage is measured on the node (see *Usage* below); the dashboard
shows used vs quota and the top-level capacity view exposes `diskFreeBytes`, `diskTotalBytes` and
`reservedDiskBytes`. The quota is a reservation, not a filesystem limit: nothing stops a writer
past it.

A single-writer volume accepts one read-write attachment. Additional attachments must be
read-only. Mount paths are unique per workload and environment, and a volume can be attached once
per environment.

## Surfaces

| Surface | What |
|---|---|
| REST | `GET/POST /api/v1/projects/:slug/volumes`, `GET/PATCH/DELETE /…/volumes/:name`, `POST/DELETE /…/volumes/:name/attach`, `GET/POST /…/volumes/:name/snapshots`, `GET/DELETE /…/snapshots/:id`, `POST /…/snapshots/:id/restore`. |
| MCP | `list_volumes`, `create_volume`, `attach_volume`, `detach_volume`, `list_volume_snapshots`, `snapshot_volume`, `restore_volume` (snapshot delete is not exposed). |
| CLI | `skif volume list|show|create|attach|detach|delete|snapshot|snapshots|restore|snapshot-delete`. |
| Dashboard | Project **Volumes** card: create, attach/detach, usage with a near-quota flag, snapshot now, latest five snapshots with restore/delete, delete. |

Deleting a volume is refused while it is attached or being restored. The soft delete keeps the
data and sets `purge_at` (the trash period, seven days by default).

All lifecycle work lives in `AppVolumeLifecycle` (`core.appVolumes.lifecycle`,
`packages/core/src/app-volume-lifecycle.ts`). The node side is desired state answered in the
heartbeat, and needs the agent capability `app-volumes`; snapshot and restore are refused for a
node that does not declare it.

| Desired state | Heartbeat answer |
|---|---|
| `appVolumes`: live volumes on the node (ids, project, backing) | `appVolumeUsage`: `{ id, usedBytes }` per measured volume |
| `appVolumePurges`: trashed volumes with `purge_requested_at` | `purgedAppVolumes`: ids whose directory was deleted |
| `appVolumeTasks`: snapshots and restores with presigned URLs (1 h, re-minted each pull) | `appVolumeTaskResults`: outcome, size, sha256, method |

## Usage

The agent asks the helper to measure every volume on the node every five minutes
(`du --summarize --block-size=1 --one-file-system`, allocated bytes) and sends the latest sample
per volume once. A disk backing that is not mounted yields no sample. Views carry
`usedBytes`, `usedAt` and `nearQuota` (at or above `APP_VOLUME_USAGE_WARN_PERCENT`, 90 %). The
maintenance sweep raises the `storage_usage:<volume id>` system alert at the platform's
`storageAlertPercent` (critical at 95 %), routed with object-storage usage; the
`skiff_project_volume_used_bytes` / `_size_bytes` gauges export the same numbers.

## Snapshots

A snapshot is a gzip tar of the volume directory written to a plan-05 backup target. Creating one
(`project:update`) resolves the target (named, or org → platform → platform object store), records
it on the row as database backups do (0053), so a later default change never moves it, and queues
it. One snapshot runs per volume; object key `app-volumes/<org>/<volume>/<snapshot>.tar.gz`.

On the node the agent names the writers: workloads in desired state with a read-write mount of the
volume. The helper (`/v1/app-volumes/snapshot`):

1. with no running writer, archives directly (`idle`);
2. with `quiesce: false`, archives while the writer runs (`live`; tar's "file changed" exit is
   accepted);
3. otherwise freezes each running writer's unit (`systemctl freeze`, a cgroup v2 freeze, not a
   stop), tries `cp --archive --reflink=always` into a staging directory beside the volumes,
   thaws as soon as the clone exists and archives the clone (`reflink`); without reflink support
   the writers stay frozen while the archive streams (`paused`), bounded at 15 minutes.

The agent streams the archive to the presigned PUT, hashing it, and reports size, sha256 and
method. Nothing touches the agent's disk.

## Restore into a new volume

Restore (`project:update`) needs a completed snapshot whose recorded target still exists. It
creates a new volume in the same project through the normal create path (org quotas and disk
admission apply), on the source's backing, with at least the source's quota, and sets
`restore_snapshot_id`. Such a volume is `pending` and cannot be attached, deleted or snapshotted.
The node streams the presigned GET into the helper (`/v1/app-volumes/restore`), which extracts
into the empty volume with GNU tar (numeric owners, no traversal); the agent checks the recorded
sha256 while streaming and fails the stream before its end on a mismatch. A failure empties the
volume again; the row becomes `failed` with the reason and stays unattachable until deleted. A
success clears `restore_snapshot_id` and sets the snapshot's `restore_verified_at`. Snapshots of a
trashed volume can still be listed and restored until it is purged.

## Purge and timeouts

`tick()` in the maintenance sweep:

- sets `purge_requested_at` on trashed volumes past `purge_at`; their node deletes the directory
  (and any staging clone) and reports it, then the row and its attachments are deleted;
- deletes the snapshots of purged volumes: the archive from its recorded target, then the row (a
  deleted target or a write-only one leaves the object behind);
- fails snapshots and restores no node finished within 6 hours.

Deleting a single snapshot deletes the archive first and is refused while it runs, while a volume
is restored from it, or on a write-only target.

On demand, `skif volume prune` (or `skif prune --only volume_snapshots`) removes unpinned finished
snapshots older than `volumeSnapshotRetentionDays` (default 30, Settings → Retention & defaults)
and snapshots whose volume is gone. Pinned snapshots and one a restore is reading are always
kept. It uses the same plan-then-apply flow as every prune, so nothing is deleted unseen.
