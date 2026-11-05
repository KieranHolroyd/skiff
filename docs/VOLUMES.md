# Skiff — Node volumes and drive setup

Status: **designed 2026-11-05; P0 backend implemented.** Managed databases and object storage
([DATABASES.md](./DATABASES.md), [OBJECT-STORAGE.md](./OBJECT-STORAGE.md)) currently live under
the helper's fixed state directory (`/var/lib/skiff-workloads/<id>`), so there is no supported way
to put an S3 instance on another disk. This document defines **volumes**: node-scoped storage that
an instance can be placed on, plus the guided setup for the common ways of adding a drive.

Decisions are recorded as **D72–D80** in [DECISIONS.md](./DECISIONS.md). The implementation is
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

Volumes are per node and managed instances never move between nodes (D41). An instance can be
moved to another volume on the same node as a follow-up (stop → copy → re-point → start, the D48
pattern). A volume that still holds instances cannot be removed.

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
| **P1** | Guided local format (GPT + ext4/xfs) through plan/apply; mount units by UUID; dashboard wizard. |
| **P2** | LVM and mdadm provisioning; array/pool health in heartbeats. |
| **P3** | ZFS pools/datasets; LUKS2 with keyfile/TPM2. |
| **P4** | Native NFS/CIFS creation with sealed credentials; migration between volumes; multi-drive RustFS (erasure coding) as a separate decision. |

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
| `app_volumes` | Project, name, node, backing (`node_volume`/`state_dir`), node volume id, quota, usage, last mount path, status, single-writer flag, soft-delete timestamps. |
| `app_volume_attachments` | Volume, workload, environment, sandbox mount path, read-only flag. |
| `app_volume_snapshots` | Versioned snapshot metadata (target, object key, size, checksum, status). |

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

`sizeMb` is the quota and the disk-admission input. Create and grow are refused when
`reserved + requested > 90% of free`, naming the free, reserved and requested megabytes; a node
that has not reported `diskFreeBytes` yet is refused instead of guessed at. State-dir volumes
reserve against the node's data-disk free space; node-volume volumes reserve against that
volume's reported `freeBytes`. Usage is reported by the node when available (currently `null`
until a helper usage sampler lands); the dashboard shows used vs quota and the top-level capacity
view exposes `diskFreeBytes`, `diskTotalBytes` and `reservedDiskBytes`.

A single-writer volume accepts one read-write attachment. Additional attachments must be
read-only. Mount paths are unique per workload and environment, and a volume can be attached once
per environment.

### Surfaces

| Surface | What |
|---|---|
| REST | `GET/POST /api/v1/projects/:slug/volumes`, `GET/PATCH/DELETE /…/volumes/:name`, `POST/DELETE /…/volumes/:name/attach`. |
| MCP | `list_volumes`, `create_volume`, `attach_volume`, `detach_volume`. |
| CLI | `skif volume create|list|attach|detach|delete`. |
| Dashboard | Project **Volumes** tab: create, attach/detach, usage and delete. |

Deleting a volume is refused while it is attached. The soft delete keeps the data and sets a
seven-day purge time; an automatic purge/restore worker is **not** implemented yet.

### Snapshots (follow-up)

The `app_volume_snapshots` table is in place, but snapshot and restore are **not implemented**.
The follow-up must stream a versioned archive to a plan-05 backup target, record size/checksum,
quiesce the writer by default, and restore into a **new** volume. No surface claims a verified
snapshot today.
