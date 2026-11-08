# Skiff — Node volumes and drive setup

Status: **designed 2026-11-05; P0 backend implemented.** Managed databases and object storage
([DATABASES.md](./DATABASES.md), [OBJECT-STORAGE.md](./OBJECT-STORAGE.md)) currently live under
the helper's fixed state directory (`/var/lib/skiff-workloads/<id>`), so there is no supported way
to put an S3 instance on another disk. This document defines **volumes**: node-scoped storage that
an instance can be placed on, plus the guided setup for the common ways of adding a drive.

Volumes are grouped into named **storage pools** and chosen per kind of data by storage rules —
see [STORAGE.md](./STORAGE.md) (D144). Decisions are recorded as **D72–D80** in [DECISIONS.md](./DECISIONS.md). The implementation is
phased (§12); the destructive verbs are only added once the safety rails in §6 exist and are
tested.

---

## 1. Model

| Table | Purpose |
|---|---|
| `node_volumes` | Node, name, kind, mount path, filesystem UUID/`source_key`, fs type, mount options, size/free, remote flag, status, the stack it was built from (`stack_json`), timestamps. |
| `nodes.default_volume_id` | Volume new managed instances use when they don't name one. |
| `storage_instances.volume_id` / `databases.volume_id` | Per-instance placement; `null` keeps the helper state dir. |

A **volume** is the mounted endpoint, not the raw disk. The disk, partition table, LVM stack, md
array, zpool, LUKS mapper or network export behind it is recorded in `stack_json` so the dashboard
can show it and the applier can reproduce/remove it. One volume is one filesystem at one mount
path; an instance uses exactly one volume in v1.

**Identity.** Volumes are addressed by a stable `source_key`, never by `/dev/sdX`:

| Kind | `source_key` |
|---|---|
| Local filesystem | `fs:<filesystem UUID>` |
| LVM | `lvm:<vg>/<lv>` (plus the filesystem UUID) |
| mdadm | `md:<array UUID>` |
| ZFS | `zfs:<pool>/<dataset>` |
| LUKS | `luks:<mapper UUID>` |
| NFS | `nfs:<server>:<export>` |
| SMB | `cifs:<server>/<share>` |

A mounted filesystem without a stable identity (rare: some FAT/exFAT setups) is **refused** for
managed data: a reboot could reorder device names and the instance would start on the wrong disk
or on the root filesystem. Network mounts use their server/export as identity.

**Kind** is the *top* of the stack — how the filesystem is provided: `filesystem`, `lvm`, `mdadm`,
`zfs`, `luks`, `nfs`, `cifs`. `stack_json` carries the layers below it.

## 2. Layout and placement

Instance data goes to `<mountPath>/skiff/<id>` (`<id>` is `st_…` / `db_…`). Only that subtree is
created and `chown`ed to the container's uid/gid; Skiff never changes ownership or permissions of
the volume root.

Resolution order when a workload starts:

1. the instance's `volume_id`;
2. the node's `default_volume_id`;
3. the helper's state directory (today's behaviour).

Volumes are per node. A managed database can move to another node (D97): a final dump on the
source is restored onto the target's chosen (or default) volume, and the old copy is purged once
the restore succeeds. A storage instance can move too, but only empty (its objects are not copied
yet). An instance can be moved to
another volume on the same node as a follow-up (stop → copy → re-point → start, the D48 pattern).
A volume that still holds instances cannot be removed.

## 3. Adding a drive: inventory → plan → confirm → apply → verify

The dashboard never asks an operator to type a shell command, and the agent never sends one.

1. **Inventory.** The agent asks the helper `volumes.inventory` (cached ~60 s) and reports it in
   the heartbeat: block devices (model, serial, size, partition table, filesystem, mountpoint,
   holders), active pools/arrays, and current mounts (including network mounts). Only inventories
   are read-only and unprivileged in effect.
2. **Plan.** The control plane (`VolumesService.plan`) combines the request with the inventory and
   produces ordered steps with a `destructive` flag and the exact device identities:
   partition → `pvcreate`/`vgcreate`/`lvcreate` → `mdadm --create` → `zpool create` →
   `cryptsetup luksFormat`/`open` → `mkfs` → mount unit → adopt. The plan is shown verbatim and
   hashed.
3. **Confirm.** A platform admin types the volume name. The hash expires after 10 minutes and is
   bound to the node and the inventory generation. There is one apply per node at a time.
4. **Apply.** A root applier (`skiff-volumes.service`, the D48 pattern) re-reads the plan from the
   control plane and re-checks it against its **own** inventory. Device serial/UUID must still
   match, the device must still be unused, and the hash must match. It then runs the fixed steps,
   writes a systemd mount unit by UUID (or a network mount unit), creates the mount path, and
   writes `/etc/skiff/volumes.json`:
   `{ "<volumeId>": { "mountPath": "...", "sourceKey": "fs:...", "fsType": "ext4" } }`.
5. **Verify.** The applier reports success/failure to the control plane; the dashboard shows the
   volume as `ready` only after `findmnt` confirms the mount and the UUID matches. Workload
   starts re-check this every time (§6).

### 3.1 Partition list and *Add as volume* (built 2026-11-08)

Settings → Storage → **Disks and volumes** lists, per node, every partition the heartbeat
inventory reports (`lsblk` types `disk`, `part`, `lvm`, `crypt`, `raid*`; loop/rom/zram are
dropped; a disk that only holds partitions is not a row of its own). Each row carries a state
derived in `partitionViews` (`packages/core/src/disk-mounts.ts`):

| State | Meaning | Action |
|---|---|---|
| `volume` | Already a registered volume | *Unmount* when Skiff mounted it |
| `adoptable` | Mounted at a usable path | **Add as volume** → the P0 adopt dialog |
| `mountable` | Unmounted ext4/ext3/ext2/xfs/btrfs/f2fs with a UUID, node has `disk-mounts` | **Add as volume** → mount, then adopt |
| `mounting` / `failed` / `unmounting` | A partition mount in flight, failed (error shown) or being removed | *Cancel* |
| `system` | Mounted at `/`, `/boot`, `/var`, … or any path volumes cannot use | — |
| `in-use` | Swap, LVM PV, RAID member, LUKS container, ZFS member, or holds other devices | — |
| `unformatted` | No filesystem | — (formatting stays P1) |
| `unsupported` | vfat/ntfs/exfat (no POSIX ownership), no UUID, or an agent without `disk-mounts` | — |

**Mounting** an unmounted partition is non-destructive and follows the share-mount pattern (§5):

| Step | Where |
|---|---|
| Request | `DiskMountService.mount` (`disk_mounts` row, 0078): `{ fsUuid, name, pool?, defaultVolume }`; refused unless the inventory shows exactly one device with that UUID, unmounted, holding nothing, with a mountable filesystem |
| Node | Desired state `diskMounts` `{ id, name, fsUuid, fsType }` / `diskUnmounts`; agent capability `disk-mounts`; heartbeat `diskMounts` / `unmountedDisks` |
| Helper | `/v1/disks/{status,mount,unmount}`: re-reads `lsblk` and repeats the free-device check, then `mount -t <fs> -o rw,noatime,nosuid,nodev /dev/disk/by-uuid/<uuid> /mnt/skiff-disks/<name>`; unmount never forces and removes the mount point with `rmdir` |
| Adopt | Once the inventory shows the UUID at `/mnt/skiff-disks/<name>`, it is adopted as a node volume named `<name>` and put in the requested pool |
| Unmount | `DiskMountService.unmount`: unregisters the volume (refused while anything is on it), then the node unmounts and confirms |

The wire never carries a device path. Like share mounts there is no fstab entry or mount unit
yet: the agent remounts after a reboot (re-checked every 15 s), and workloads on the volume fail
closed until it has (D76). Not yet: REST/CLI verbs (dashboard only), LUKS unlock, and mounting a
btrfs subvolume other than the default.

## 4. Supported stacks

| Kind | Provision natively | Adopt existing | Notes / limits |
|---|---|---|---|
| **Local filesystem** (`ext4`, `xfs`, `btrfs`) | GPT + one partition + `mkfs` | yes | The default. btrfs only as a plain filesystem in v1 (no subvolume management). |
| **LVM** | PV → VG → LV → `mkfs` | yes | One LV per volume in v1; a VG can back several volumes by creating more LVs later. |
| **mdadm** | `mdadm --create` level 0/1/5/6/10 with v1.2 metadata → `mkfs` | yes | Arrays are assembled by `mdadm`/systemd; the mount unit depends on the array. |
| **ZFS** | `zpool create` (single, mirror, raidz1/2) + dataset | yes | Dataset uses the pool's mountpoint or an explicit one. No zvols in v1. `ashift=12`, compression on, `atime=off`. |
| **LUKS** | LUKS2 container → open → `mkfs` | yes (already-open mappers) | Unlock at boot with a keyfile (0400, root) or TPM2 enrollment (`systemd-cryptenroll`). Passphrase-at-boot is not offered for headless nodes. |
| **NFS** | mount unit (`vers=4.2`, `_netdev`, `nofail`, automount) | yes | First-class, with a warning: RustFS expects a local POSIX filesystem; locking, atomic rename and latency are the operator's risk. |
| **SMB/CIFS** | mount unit with a sealed credentials file (0400 root) | yes | First-class, same warning plus POSIX semantics (`mfsymlinks`, `uid`/`gid`). |

"Full stack" means Skiff can *create* these through fixed verbs, not that it re-implements the
storage engine: every step is an allowlisted command against validated device identities, never a
shell string.

## 5. Network mounts (first-class)

**Built (D143, 2026-11-07):** Settings → Network shares (`/settings/shares`) → *Mount on node* → the node's helper
mounts the share at `/mnt/skiff-shares/<share>` → once the heartbeat inventory reports it there
with the expected source key (`nfs:<server>:<export>` / `cifs:<server>/<share>`), a read-write
mount is adopted as a `remote` node volume (named after the share unless renamed; *Link to Skiff*
does it later for a mount created without linking). From then on it is an ordinary node volume:
pick it when creating a database, storage instance or app volume, or make it the node default.

| Step | Where |
|---|---|
| Define | `POST /api/v1/shares` (`credentials: { username, password, domain? }` for SMB, sealed with the platform key) |
| Mount | `POST /api/v1/shares/:name/mounts` `{ node, volumeName?, defaultVolume? }`; `volumeName: null` mounts without linking |
| Link / unlink | `PUT` / `DELETE /api/v1/shares/:name/mounts/:node/volume` |
| Unmount | `DELETE /api/v1/shares/:name/mounts/:node` — unregisters the volume first (refused while anything is placed on it), then the node unmounts and confirms |
| Node | Desired state `shareMounts` / `shareUnmounts`, heartbeat `shareMounts` / `unmountedShares`, agent capability `share-mounts`; SMB credentials from `GET /api/agent/share-mounts/:id/credentials` per mount call |

The helper uses fixed options — NFS `hard,proto=tcp,noatime,nosuid,nodev`; SMB
`vers=3.0,noatime,nosuid,nodev,mfsymlinks,file_mode=0770,dir_mode=0770` with a `0600` credentials file
in `/run/skiff-shares` that exists only for the mount call — plus `ro`/`rw` from the share. The
agent re-checks every 15 s and retries failures at 5 s, 15 s, 45 s, then every 5 minutes; rotating
credentials retries at once. Unmount never forces and cleanup is a plain `rmdir` of an unmounted,
empty directory, so a busy mount can never reach the share's files. A share's server, export or
mode cannot change, and it cannot be deleted, while it is mounted anywhere. Nodes need
`nfs-common`/`nfs-utils` or `cifs-utils`; a missing helper program is named in the mount error.

Not yet: the systemd mount units and automount below (the agent remounts after a reboot instead,
and workloads on the volume fail closed until then), CIFS `uid`/`gid` per container user (chown of
`<mount>/skiff/<id>` needs a server that honours it), the transport probes and `degraded` state of
CLUSTERING §5.2, and export paths with spaces or `$` (they cannot form a source key).

The original design, of which the above is the first slice:

- Credentials (SMB password, NFS with a custom sec) are sealed with the org key, written to a
  `0400` root file only at apply time, and never appear in desired state, logs or the dashboard.
- Mount units use `_netdev,nofail,x-systemd.automount` and a bounded `x-systemd.device-timeout`, so
  a missing server does not block boot. A managed instance on an unavailable network volume stops
  (fail closed) instead of writing to the local mountpoint.
- The dashboard labels network volumes **remote** and shows the performance/durability caveat
  when an S3 instance is placed on one. Alerts fire when the mount disappears or free space is low.
- NFS `sec=krb5`/kerberised shares are adopt-only in v1 (the node's keytab is outside Skiff).

## 6. Safety model

The destructive verbs are the most dangerous code in Skiff. Non-negotiable rules:

1. **The wire carries identities, not commands.** Plans name devices by serial/UUID and stack
   parameters; the root applier re-derives everything and refuses unknown or changed values.
2. **Only provably free devices.** A device is refused if it (or a child) is mounted, is a member
   of an active md/LVM/ZFS/LUKS stack, backs `/`, `/boot`, `/boot/efi`, `/var`, swap, or has any
   unrecognised signature. `wipefs` needs an explicit `wipe: true` plus typed confirmation.
3. **Mounts are verified, not assumed.** Before a managed container starts, the helper confirms
   `findmnt --mountpoint <path>` and that the filesystem UUID matches `/etc/skiff/volumes.json`.
   If not, the start fails with "volume not mounted"; it never creates data on the root disk
   through an empty mountpoint. This is the single most important rule: a directory that exists but
   is not mounted looks perfectly valid to naive code.
4. **UUIDs everywhere.** Mount units use `/dev/disk/by-uuid/…`; no device names in units, plans or
   the database.
5. **Allowlisted mount options.** `noatime,nosuid,nodev` for data volumes; `nofail` for removable
   and network; no user-supplied option string. CIFS adds `uid`/`gid` from the container's user.
6. **Least ownership.** Only `<mount>/skiff/<id>` is chowned. Removing a volume removes Skiff's
   mount unit and stack; it never recursively deletes the mount root without a `wipe` confirmation.
7. **One apply per node at a time**, serialised with the D48 storage apply so a move and a
   provision cannot race.
8. **Audit everything**: plan, confirm, apply, fail, remove, and every credential use.

## 7. Default volume and per-instance placement

- `PATCH /api/v1/nodes/:id` gains `defaultVolumeId` (or `null`).
- `POST /api/v1/storage` and `POST /api/v1/databases` gain `volume?: string` (name) — must be on
  the resolved node (`auto` is resolved first if necessary; a volume pins the node when placement
  is `auto`). Creating on a volume with less free space than `storageMb` is a 409 with the numbers.
- The workload desired state carries `volumeId` for managed services. The helper resolves it from
  `/etc/skiff/volumes.json`; unknown/not-mounted is a start failure, not a fallback.
- The instance view exposes `volume: { name, mountPath, remote }` and the volume view lists the
  instances on it.

## 8. Observability

- Heartbeat volume report: `status` (`mounted`/`missing`/`degraded`), `sizeBytes`, `freeBytes`,
  the observed `sourceKey`/`fsUuid` and mount path. The control plane reconciles it against the
  registered volume and marks it missing when a mounted volume disappears.
- Alerts: volume missing, free space below 15% (or below the instance budget), md array degraded,
  zpool `DEGRADED`, LUKS mapper absent.
- `/metrics`: `skiff_volume_size_bytes`, `skiff_volume_free_bytes`, `skiff_volume_up`.
- Dashboard: Nodes → node → **Volumes** (list, add wizard, usage, instances) and a volume gauge on
  the storage/database detail pages.

## 9. Surfaces

| Surface | What |
|---|---|
| Permissions | Volumes are infrastructure: `node:update`/platform admin for inventory, plan, apply, remove and the node default. `storage:read`/`database:read` see the volume name and capacity a resource uses, not credentials or device inventory. |
| REST | `GET /api/v1/nodes/:id/volumes` (inventory + registered), `POST …/volumes/plan`, `POST …/volumes` (apply), `DELETE …/volumes/:name`, `PATCH /api/v1/nodes/:id` `defaultVolumeId`; `volume` on storage/database create. |
| MCP | `list_volumes` only (admin scope), for fleet-aware agents. **No provisioning or removal over MCP**: destructive infra needs a dashboard session and typed confirmation (D29/D53). |
| CLI | `skif volume list|add|remove` (platform admin), `skif storage create --volume`, `skif db create --volume`. |
| Dashboard | Node volumes tab with inventory/adopt wizard and the full-stack plan; volume picker on managed-service create; capacity and health charts. |

## 10. Root applier and helper verbs

The helper keeps its fixed-verb surface; volumes add:

| Verb | What |
|---|---|
| `volumes.inventory` | Read-only `lsblk`/`findmnt`/pool inventory. |
| `volumes.verify` | Is `mountPath` a real mount with the expected UUID/source? |
| `disks.status` / `disks.mount` / `disks.unmount` | **Built:** mount an unmounted filesystem by UUID at `/mnt/skiff-disks/<name>` (§3.1). |
| `volumes.apply` | Execute a validated plan (one per node, hash-checked). |
| `volumes.remove` | Unmount, remove the mount unit and stack; `wipe` only with confirmation. |
| `volumes.mount` / `volumes.unmount` | Repair actions for an existing registered volume. |

All run through `skiff-helper` as root on the unix socket; the agent only relays stable ids. The
root applier is a systemd oneshot driven by a request file, mirroring D48, so the agent itself
still cannot mount or format anything.

## 11. Migration between volumes

Follow-up, after the foundation: `POST /storage/:name/volume` stops the container, copies
`<old>/skiff/<id>` → `<new>/skiff/<id>` with `cp -a`, re-points the desired state, starts it and
deletes the old copy once the instance is healthy — the D48 settle-and-rollback pattern. Bucket
replication is not used for a local move. Databases use their own safe stop/copy path.

## 12. Phased delivery

| Phase | Scope |
|---|---|
| **P0 (foundation)** | **Done:** `node_volumes` + per-instance `volume_id` + node default; inventory in the heartbeat; adopt an existing mount (no formatting); helper `volumes.inventory`/`volumes.verify`; `<mount>/skiff/<id>` data dirs with a fail-closed start; REST + storage/database create `volume`; tests. **Open:** the dashboard volumes page and `--volume` on the CLI. |
| **P1** | **Done:** the partition list with *Add as volume*, mounting an existing filesystem by UUID (§3.1). **Open:** guided local format (GPT + ext4/xfs) through plan/apply; mount units by UUID. |
| **P2** | LVM and mdadm provisioning; array/pool health in heartbeats. |
| **P3** | ZFS pools/datasets; LUKS2 with keyfile/TPM2. |
| **P4** | **Done:** NFS/CIFS mounts from the share registry with sealed credentials, linked as node volumes (§5, D143). **Open:** systemd mount units/automount, migration between volumes; multi-drive RustFS (erasure coding) as a separate decision. |

P0 is intentionally usable: an operator mounts a disk with their normal tools (fstab/systemd),
Skiff adopts it, and an S3 instance can be created on it. Every later phase adds provisioning, not
a new model.

## 13. Follow-ups

- Volume snapshots and backups (share the database backup scheduler).
- Volume-level quotas per org and per instance.
- Multi-drive RustFS (one instance across several volumes) and erasure coding.
- Disk health (SMART) and temperature.
- Move an instance between volumes from the dashboard.

## 14. App volumes (plan 07, MVP)

Node volumes (§1–§13) place managed databases and storage instances. **App volumes** are a
separate, project-owned resource: a directory with a size quota that a process or container
workload mounts at an absolute path. They are enabled by `SKIFF_FEATURE_APP_VOLUMES` (off by
default) and never replace the legacy `/data` mount.

### Model and backing

| Table | Purpose |
|---|---|
| `app_volumes` | Project, name, node, backing (`node_volume`/`state_dir`), node volume id, quota, usage (`used_bytes`, `used_at`), last mount path, status, single-writer flag, soft-delete timestamps (`deleted_at`, `purge_at`, `purge_requested_at`), `restore_snapshot_id` while it is being filled from a snapshot. |
| `app_volume_attachments` | Volume, workload, environment, sandbox mount path, read-only flag. |
| `app_volume_snapshots` | Snapshot metadata: recorded target (`target_id`, `target_name`, `location_json`), object key, size, sha256, status, error, label, method, quiesce, pinned, creator, created/finished, restore-verified time. |

A volume pins its project to one node. With `backing: node_volume`, the volume names a registered
node volume and the helper resolves `<node volume mount>/skiff/apps/<projectId>/<volumeId>`.
With `backing: state_dir` it uses `<helper state dir>/apps/<projectId>/<volumeId>`. Only that
subtree is created; the host path is derived on the node and is never stored or returned by the
API. A project-facing view contains the volume name, size, usage, status, attachments and — for a
node-volume backing — only `{ id, name, remote }`.

### Mount rendering and fail-closed starts

`WorkloadDesired.volumes` carries `{ id, mountPath, readOnly, backing, nodeVolumeId? }`; it never
carries a host path or device. Before writing a unit the helper:

1. resolves each mount through its own node-volume registry or its state directory;
2. verifies a node-volume backing with `findmnt` and the registered stable source key;
3. refuses the start if the registry entry or mount is missing — it never creates the directory
   under an empty mountpoint or falls back to the root disk;
4. creates only the per-volume subtree.

Process units render `BindPaths=<host>:<mountPath>` (or `BindReadOnlyPaths`) plus
`ReadWritePaths`; container units render `Volume=<host>:<mountPath>[:ro]:Z`. Mount points are
validated by the same rules as the contract: absolute, normalized, no traversal, not a system
tree, not `/data`, not `/var/lib/skiff`.

### Size quota, disk admission and single writer

`sizeMb` is the quota and the disk-admission input. The org quotas `appVolumes` and
`appVolumeBytes` (docs/QUOTAS.md) are checked first, against live (not trashed) volumes and their
configured `sizeMb`; growth checks only the delta. Create and grow are then refused when
`reserved + requested > 90% of free`, naming the free, reserved and requested megabytes; a node
that has not reported `diskFreeBytes` yet is refused instead of guessed at. State-dir volumes
reserve against the node's data-disk free space; node-volume volumes reserve against that
volume's reported `freeBytes`. Usage is measured on the node (see *Usage* below); the dashboard
shows used vs quota and the top-level capacity view exposes `diskFreeBytes`, `diskTotalBytes` and
`reservedDiskBytes`. The quota is a reservation, not a filesystem limit: nothing stops a writer
past it.

A single-writer volume accepts one read-write attachment. Additional attachments must be
read-only. Mount paths are unique per workload and environment, and a volume can be attached once
per environment.

### Surfaces

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

### Usage

The agent asks the helper to measure every volume on the node every five minutes
(`du --summarize --block-size=1 --one-file-system`, allocated bytes) and sends the latest sample
per volume once. A node-volume backing that is not mounted yields no sample. Views carry
`usedBytes`, `usedAt` and `nearQuota` (at or above `APP_VOLUME_USAGE_WARN_PERCENT`, 90 %). The
maintenance sweep raises the `storage_usage:<volume id>` system alert at the platform's
`storageAlertPercent` (critical at 95 %), routed with object-storage usage; the
`skiff_project_volume_used_bytes` / `_size_bytes` gauges export the same numbers.

### Snapshots

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

### Restore into a new volume

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

### Purge and timeouts

`tick()` in the maintenance sweep:

- sets `purge_requested_at` on trashed volumes past `purge_at`; their node deletes the directory
  (and any staging clone) and reports it, then the row and its attachments are deleted;
- deletes the snapshots of purged volumes: the archive from its recorded target, then the row (a
  deleted target or a write-only one leaves the object behind);
- fails snapshots and restores no node finished within 6 hours.

Deleting a single snapshot deletes the archive first and is refused while it runs, while a volume
is restored from it, or on a write-only target. There is no automatic snapshot retention yet;
`pinned` is recorded for when there is.
