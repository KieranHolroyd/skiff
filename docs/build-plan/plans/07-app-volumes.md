# 07 — App volumes and snapshots

**Priority:** P1 · **Effort:** M · **Lane:** C · **Wave:** 2
**Depends on:** F1 contracts, F3 e2e, 01/05 for snapshots (soft)
**Blocks:** 12 preview data, 14 stacks, 19 process groups
**Primary files:** `packages/contracts/src/app-volume.ts`, `packages/core/src/app-volumes.ts`,
`packages/contracts/src/workload.ts`, `apps/helper/src/units.ts`, `docs/VOLUMES.md`

> **Status update (5 Nov 2026):** node volumes (D72–D80) are shipped for managed instances.
> Remaining: app volumes for workloads, snapshots, disk admission. Verify before implementing.
>
> **Since 8 Nov 2026 (D169)** node volumes are **disks** ([STORAGE.md](../../STORAGE.md)). An app
> volume takes a storage target (`storage`) instead of `backing`/`nodeVolume`; `node_volume` and
> `nodeVolumeId` survive only as wire names. The plan below keeps its original wording.

## Goal

Give process and container apps real persistent storage: multiple named volumes, a mount path,
size quota, attach/detach, single-writer enforcement, disk admission, and versioned snapshots.

## Non-goals

- Replacing the existing **node volumes** (D72–D80). Those are infrastructure mounts for managed
  databases/storage instances; app volumes are org/project resources backed by a node volume or
  the helper state dir.
- Block storage, iSCSI, or a distributed filesystem.
- Multi-writer shared volumes in v1.
- Automatic backup of every volume; snapshots are scheduled by the user (09).

## Current state

- `packages/contracts/src/volume.ts` and `packages/core/src/volumes.ts` implement node volumes:
  adopt a mount, verify it, place managed DB/storage data dirs, capacity guard (`assertRoom`).
- `WorkloadSpec.data` is a single optional `{ sizeMb }`; the helper mounts `/data`. `sizeMb` is not
  enforced; `admit()` checks memory only; `storageMb` is alert-only.
- `WorkloadDesired` has no `volumes` field.
- There is no app-volume table, API, snapshot, or UI.

## Design

### Model

| Table | Columns |
|---|---|
| `app_volumes` | id, orgId, projectId, name, nodeId, backing (`node_volume`/`state_dir`), nodeVolumeId nullable, sizeMb, usedBytes, mountPath, status (`pending`/`ready`/`missing`/`failed`), singleWriter, createdBy, timestamps, deletedAt |
| `app_volume_attachments` | id, volumeId, workloadId, environment, mountPath, readOnly, createdAt |
| `app_volume_snapshots` | id, volumeId, targetId, objectKey, sizeBytes, checksum, createdAt, expiresAt, restoreVerifiedAt |

- Backing path: `<nodeVolume.mountPath>/yoal/apps/<projectId>/<volumeId>` or
  `<helperStateDir>/apps/<projectId>/<volumeId>`. Only that subtree is created/chowned.
- Names follow slug rules and are unique per project.
- A volume pins the project to a node, like a managed instance. Moving a volume is a later
  follow-up (stop → copy → re-point → start).
- `sizeMb` is a quota and an admission input. Enforce with a helper `usage` check and a disk free
  check at create/attach; do not rely on the filesystem alone.

### Desired state

Extend `WorkloadDesired` (F1):

```ts
volumes?: Array<{ id: string; mountPath: string; readOnly: boolean }>;
```

- The helper renders one `BindPath`/`Volume` mount per entry for containers, and a
  `ReadWritePaths`/`StateDirectory` entry for processes. Validate `mountPath` (absolute, no `..`,
  not `/`, not a reserved path).
- Before start, verify the backing volume is mounted (D76) and the directory exists; fail closed,
  never fall back to the root disk.
- A read-only attachment uses `:ro`/`ReadOnlyPaths`.
- Single-writer: refuse two running workloads on one read-write volume; read-only attachments are
  allowed. Record the owner in `app_volume_attachments`.

### Disk admission

- Add `diskFreeBytes`/`diskTotalBytes` to node capacity (already in heartbeat stats) and a
  `reservedDiskBytes` estimate per node.
- `admit()` checks memory **and** disk: `reservedDisk + volumeSizeMb ≤ freeDisk * 0.9`. Reject with
  the numbers.
- `sizeMb` is enforced by a helper `usage` call at create/attach and a periodic check; alert at 85%.
- The dashboard shows node disk, volume usage, and the top consumers.

### Snapshots

- Helper verb `volume.snapshot(id, target, quiesce)`:
  - Optional `quiesce` stops the owning workload (or asks it to flush) before the copy.
  - `tar --xattrs --acls --numeric-owner` or `rsync -aHAX` to a staging dir, stream to the target
    with the 01/F2 streaming API.
  - Checksum while streaming; record size/checksum.
- Snapshots are **versioned**, never a mirror. Restore creates a new volume and attaches it; never
  overwrite in place by default.
- Consistency caveat: a running writer can produce a torn snapshot. Default to quiesce for
  databases/SQLite; allow `--no-quiesce` with a warning.
- Retention: keep N daily/weekly; pinned snapshots never GC.

### Surfaces

- REST: `/api/v1/projects/:slug/volumes`, `/volumes/:name`, `/volumes/:name/attach`,
  `/volumes/:name/snapshots`, `/snapshots/:id/restore`.
- MCP: `list_volumes`, `create_volume`, `attach_volume`, `snapshot_volume`, `restore_volume`
  (confirmed). No host path or device.
- CLI: `yoal volume create|list|attach|detach|snapshot|restore`.
- Dashboard: project Volumes tab, create wizard (name, size, backing), attach to a workload,
  usage, snapshots, restore.
- Permissions: `project:update` or a new `volume:*`; platform admin for backing node volumes.

## Implementation order

1. Contracts + tables + migration (contract PR).
2. `AppVolumeService` create/list/attach/detach + disk admission.
3. `WorkloadDesired.volumes` + helper mount rendering + unit tests.
4. Backing path creation/chown + fail-closed mount verification.
5. Usage checks + alerts + dashboard.
6. Snapshot/restore via 01/05.
7. Migration between volumes (follow-up).

## Acceptance criteria

- [ ] An app mounts two named volumes at different paths; both survive redeploy/restart.
- [ ] A read-only attachment cannot write; a second read-write attach is refused.
- [ ] Creating a volume that would exceed 90% of free disk is rejected with the numbers.
- [ ] A missing backing mount fails the workload start; it never writes to the root disk.
- [ ] A snapshot of a quiesced SQLite volume restores into a new volume with identical checksums.
- [ ] Deleting a volume is refused while attached; soft delete keeps the data for 7 days.
- [ ] `sizeMb` is enforced and an 85% alert fires.

## Tests

- Unit: path validation, size/quota math, single-writer rules, snapshot retention.
- Integration: create/attach/restart/detach; read-only; missing mount; snapshot/restore.
- Real node: node volume + helper; bind mount; process `ReadWritePaths`; disk full.
- Security: no host path in the API; `..` rejected; `0400`/ownership correct.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Disk exhaustion | Admission, quota, 85% alert, reject create |
| Torn snapshot | Quiesce by default; warning; restore verification |
| Mount falls back to root | Fail-closed check every start; test a missing mount |
| Single-writer confusion | Explicit attach owner; UI warning; reject second RW |
| Volume move downtime | Later feature; document stop/copy/start |

## Rollout

`YOAL_FEATURE_APP_VOLUMES` off by default. Enable for new projects; existing `data` continues to
work. Snapshots ship after 01/05 are stable.

## Open questions

- Should app volumes be org-scoped or project-scoped? Project-scoped is simpler; sharing is a
  follow-up.
- Do we need per-volume encryption? Inherit the node volume's LUKS; document the gap.
- Can we use the existing `node_volumes` table for app backing without exposing admin APIs? Yes,
  via a read-only backing reference; do not make app users platform admins.

## File ownership

Own: `packages/contracts/src/app-volume.ts`, `packages/core/src/app-volumes.ts` + test,
`packages/contracts/src/workload.ts` (volumes field only), `apps/helper/src/units.ts` (mount
rendering), `docs/VOLUMES.md`.

Integration-owned: schema/migration, core context/index, helper server/systemd, agent main,
dashboard project layout, MCP/CLI registration, e2e harness.
