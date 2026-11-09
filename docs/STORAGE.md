# Yoal — Disks and default storage

Status: **rebuilt 2026-11-08** (D169). Replaces node volumes, storage pools and the partition
table (D72–D75, D144). App volumes, the project-owned directories mounted into apps, are a
separate resource: [VOLUMES.md](./VOLUMES.md).

An operator should be able to answer "where does my data go?" in one screen. Yoal stores data on
**disks**, each disk is **fast** or **bulk**, and Settings says which of the two (or the system
disk) each kind of service uses by default. Nothing more to set up.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **Disk** | One mounted filesystem on one node that Yoal may store data on: a local disk or partition, an LVM/mdadm/ZFS/LUKS device the OS already assembled, or a mounted network share. |
| **System disk** | Each node's built-in storage (the helper state dir and the D48 install directories). Always there, never a row. |
| **Tier** | `fast` or `bulk`, per disk. Derived from the hardware (SSD/NVMe → fast; spinning disk, network share, unknown → bulk) until an operator sets it. |
| **Storage target** | Where a new service goes: `system`, `fast`, `bulk`, or one disk by name. |
| **Default storage** | Per kind of service, the target its create form preselects. |

There are no pools, allocation methods, minimum-free knobs, class overrides or node default
volumes. Yoal never formats, partitions or assembles anything: it uses filesystems the OS
already provides (D169).

## 2. Model

```text
disks            SQL table node_volumes (0010), TS `disks`:
                 id, node_id, name, kind, source_key, mount_path, fs_type, remote,
                 tier fast|bulk, tier_set (operator chose it), mount_uuid (Yoal mounts it),
                 status pending|ready|missing|failed|removing, message, size/free, stats_at
storage_defaults kind PK → target system|fast|bulk
settings['storage.onboarding'] = done|skipped
```

The SQL names predate the rebuild and stay, because migrations are additive (OPS §4.2.2); the
TypeScript schema calls the table `disks` and every `volume_id` placement column `diskId`.
`storage_pools`, `storage_rules`, `disk_mounts` and `nodes.default_volume_id` are no longer read.

A resource keeps the disk it was placed on (`disk_id`, null for the system disk) until an
explicit move. Disk data lives at `<mount>/yoal/<id>`; Yoal owns only that subtree (D78).

**Identity** is a stable source key, never `/dev/sdX` (D72): `fs:<UUID>[#subvol]`,
`lvm:<vg-lv>`, `md:<array UUID>`, `zfs:<pool/dataset>`, `luks:<mapper>`,
`nfs:<server>:<export>`, `cifs:<server>/<share>`. A filesystem without one is not offered.

### 2.1 Kinds and defaults

| Kind | What | Data path | Suggested default |
|---|---|---|---|
| `databases` | Managed databases, read replicas, move targets | `<disk>/yoal/<db_id>` | fast |
| `object-storage` | RustFS instances | `<disk>/yoal/<st_id>` | bulk |
| `brokers` | Queue brokers | `<disk>/yoal/<br_id>` | fast |
| `app-volumes` | App volumes ([VOLUMES.md](./VOLUMES.md)) | `<disk>/yoal/apps/<project>/<vol_id>` | fast |
| `builds` | Builder scratch (D48 `buildDir`) | `<disk>/yoal/node/<node>/builds` | bulk |
| `site-data` | Agent state and the static release cache (D48 `dataDir`) | `<disk>/yoal/node/<node>/agent` | system |

A kind with no saved default uses the system disk, so an install that never adds a disk behaves
exactly as before. The "suggested" column is what Settings fills in when an operator presses
**Suggest**; nothing is applied on its own.

### 2.2 Resolution

For a new resource of kind `k` with target `t` (the creator's choice, else `default[k]`, else
`system`):

```
t = system  → every node is eligible; the data goes on the system disk
t = <disk>  → the disk's node only (pins placement); the disk must be ready and have room
t = fast|bulk:
  eligible(node) ← ready disks on node with tier t and room for the request
  node           ← placement over eligible nodes only (CLUSTERING §3.4 filter)
  disk           ← the eligible disk on that node with the most free bytes
```

"Room" means the disk keeps 10 % of its size free after the request (unknown capacity fits).
**There is no fallback**: a `fast` request on a node with no usable fast disk is refused, naming
each node's reason ("homelab: no fast disk; edge: fast disk nvme is below 10 % free after
20 GiB"). Yoal never puts a service on another tier than the one chosen.

Node-level kinds (`builds`, `site-data`) resolve per node when its desired state is built: the
node's explicit D48 directory, else its most-free **local** ready disk of the default tier, else
the install default. A change reaches the node's `yoal-storage.service` applier, which moves the
directory (D48). Network shares are skipped here: Caddy serves releases from `site-data`.

Moves (D97) keep the resource's tier: a database on a fast disk moves to a fast disk on the
target, one on the system disk to the target's system disk, unless the move names a target.

## 3. Adding a disk

Settings → Storage lists each node with its system disk, its disks, and a **Add a disk** list of
what the node reports that Yoal could use. Each candidate is one row with one button:

| Candidate | What **Use this disk** does |
|---|---|
| A filesystem already mounted at a usable path (e.g. `/mnt/data`, a ZFS dataset, an assembled array) | Registers it as a disk at once (`ready`). |
| An unmounted ext4/ext3/ext2/xfs/btrfs/f2fs filesystem with a UUID, on a node with the `disk-mounts` capability | Registers it as `pending` with `mount_uuid`; the node's helper mounts it by UUID at `/mnt/yoal-disks/<name>`; the disk turns `ready` when the inventory shows that UUID there. |

The dialog asks only for a name (prefilled from the label or device) and the tier (prefilled from
the hardware). Everything the node reports that cannot be used — the OS's own filesystems, swap,
LVM/RAID/LUKS/ZFS members, disks without a filesystem, vfat/ntfs/exfat, filesystems without a
UUID — is folded into **Not usable (n)** with the reason, so the list never shows a partition the
operator cannot act on.

**Remove** unregisters a disk; it is refused while anything is stored on it. A disk Yoal mounted
goes `removing`, the node unmounts it (never forced; the mount point is removed with `rmdir`) and
the row is deleted when the node confirms. Its files stay on the disk. **Rename** and **tier**
are edited in place; changing a tier affects new services only.

Network shares are defined under **Settings → Network shares** (D143). Mounting a share on a node
makes it a disk on that node (tier `bulk`, marked *network*), named after the share unless
renamed; unmounting removes the disk first.

### 3.1 Node protocol

The wire names predate the rebuild and are unchanged, so agents and helpers of either age agree:

| Desired state | Heartbeat | Helper |
|---|---|---|
| `volumes`: every disk except `removing` `{ id, mountPath, sourceKey, fsType }` (the registry D76 verifies against) | `volumes`: inventory `{ mounts, devices }`; devices now include `rotational` | `volumes.inventory`, `volumes.verify` |
| `diskMounts`: disks with `mount_uuid`, not `removing` `{ id, name, fsUuid, fsType }`; `diskUnmounts`: `removing` ones | `diskMounts` `{ id, mounted, error }`, `unmountedDisks` | `/v1/disks/{status,mount,unmount}` |
| `volumeProfileTasks` `{ id, volumeId, … }` (a disk id) | `volumeProfileResults` | `/v1/volumes/profile` |

The helper re-reads `lsblk` before every mount and refuses unless exactly one unmounted, unheld
device has that UUID; it mounts with `rw,noatime,nosuid,nodev`. The agent remounts after a reboot
(checked every 15 s); workloads on a disk fail closed until it has (D76).

## 4. Onboarding

Setup's **Storage** step shows the same per-node list: use the disks you want, check their tiers,
press **Suggest** (or pick) the defaults, then **Finish** (`storage.onboarding = done`). **Use the
system disk for now** stores `skipped`. Until one is stored, platform admins see a banner linking
to Settings → Storage.

## 5. Settings → Storage

One page, platform admin:

1. **Defaults** — one row per kind: `System disk` / `Fast disks` / `Bulk disks`, with a warning
   when a node-level kind's tier has only network disks or a tier has no disks at all.
2. **Nodes** — per node: system disk usage; its disks (name, tier, network badge, mount path,
   used/size bar, status, what is stored on it, latest benchmark) with *Profile*, *Edit*,
   *Remove*; then **Add a disk** candidates and the folded **Not usable** list.

### 5.1 Profiling

**Profile** on a disk benchmarks it so the operator can see which tier it belongs in:

| Measure | How (fio) | Fallback (no fio) |
|---|---|---|
| Sequential read / write | 1 MiB blocks, queue depth 8, MB/s | GNU `dd` 1 MiB, O_DIRECT |
| Random read / write | 4 KiB, queue depth 32, IOPS | not measured (—, with a hint to install fio) |
| Sync write | 4 KiB, `fdatasync` after each, depth 1: IOPS and mean round trip | `dd bs=4k oflag=dsync` |

The control plane queues a `volume_profiles` row and lists it in desired state as a
`volumeProfileTasks` entry naming the disk id, never a path. The agent (capability
`volume-profiles`) runs them one at a time through the helper, which resolves the mount from its
own registry, verifies it (D76), refuses when free space is under twice the 512 MiB scratch size,
writes under `<mount>/yoal/.profile/` and deletes it afterwards. A run not finished within 15
minutes fails, and a late report never overwrites a final one. `fio`, `nfs-common` and
`cifs-utils` are installed by the installer and, on in-place updates, once per helper version by
the helper (`YOAL_HELPER_STORAGE_TOOLS=0` turns that off; Debian/Ubuntu only).

## 6. Surfaces

| Surface | What |
|---|---|
| REST | `GET /api/v1/platform/storage` (defaults, nodes with disks and candidates, onboarding); `POST /platform/storage/disks` `{ node, candidate, name?, tier? }`; `PATCH`/`DELETE /platform/storage/disks/:id`; `POST /platform/storage/disks/:id/profile`; `PUT /platform/storage/defaults` `{ defaults: [{ kind, target }] }`; `POST /platform/storage/onboarding` `{ state }`. Create bodies for databases, object storage, brokers and app volumes, replica add and moves take `storage?: "system" \| "fast" \| "bulk" \| <disk name>`. |
| Views | A placed resource shows `disk: { id, name, tier, remote } \| null` (null = system disk). Create forms get `storageChoices(kind)`: the default target and the tiers that have at least one ready disk (no nodes, paths or capacity). |
| Permissions | Platform admin dashboard session for every write (D129); platform viewers read. |
| Audit | `storage.disk.add`, `storage.disk.update`, `storage.disk.remove`, `storage.disk.mount.fail`, `storage.defaults.update`, `storage.profile`, `storage.onboarding` |
| CLI | `--disk <system\|fast\|bulk\|name>` on `yoal db create`, `yoal db replica add`, `yoal storage create`, `yoal storage move`, `yoal broker create`, `yoal volume create` (`--storage` already means the size budget). `--volume` is a deprecated alias on replica add, storage move and broker create. |
| MCP | `storage` on the same create tools; no disk writes over MCP (D29/D53). |

## 7. Safety

- The wire carries ids, UUIDs and source keys, never device paths or commands; the helper
  re-derives everything from its own `lsblk`/`findmnt`.
- Every managed start verifies the mount and its source key (D76); a missing disk fails closed
  instead of writing to the system disk through an empty mountpoint.
- Only `<mount>/yoal/<id>` is created and chowned; removing a disk never deletes files (D78).
- Defaults and tier changes never move existing data; a disk holding anything cannot be removed.
- Node-level kinds skip network disks, so Caddy and the builder never depend on a share.
- Health and capacity ride the heartbeat (D80): a disk that disappears is `missing`.

## 8. Later

- `images` (podman `graphroot`) and `backups` (local backup target) as kinds; capacity alerts per
  tier.
- Moving a resource between disks on one node (stop → copy → re-point → start, D79).
- Systemd mount units for disks Yoal mounts (today the agent remounts after boot).
