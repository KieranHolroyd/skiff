# Skiff — Storage pools and default storage

Status: **designed 2026-11-07; phase S1 implemented** (see §9). Decision **D144**.

Skiff used to decide where data lands one resource at a time: a managed instance took an explicit
volume, else its node's default volume, else the helper's state directory on the system disk.
Nothing said "databases belong on SSD, object storage on the HDD array". This document makes
storage something the operator sets up **first** — in onboarding, or later under **Settings →
Storage**. **Where a service is stored is chosen when it is created**; Settings holds the default
pool each kind of service starts with. Skiff never picks a different pool on its own.

It builds on [VOLUMES.md](./VOLUMES.md) (node volumes, network shares, fail-closed mounts) and
borrows from Unraid and TrueNAS, which both solved "fast pool for apps, big pool for bulk" for
home servers.

---

## 1. What we borrow, and what we don't

| From | Concept | In Skiff |
|---|---|---|
| Unraid | Named **pools** (6.9+, 7.x makes the array optional); `appdata`/`system` on the SSD pool, media on the array | **Pools** are named tiers (`ssd`, `hdd`, `nas`); the defaults put databases on the fast one |
| Unraid | Per-share **primary storage** + **secondary storage** used when primary falls below **minimum free space** (default 10 %) | Each pool has `minFreePercent` (default 10). **No secondary/overflow pool:** a pool that cannot hold a service is a refusal, never a silent move elsewhere |
| Unraid | **Allocation method** (`high-water`, `most-free`, `fill-up`) | Per pool: `most-free` (default) or `fill-up` |
| Unraid | Changing a share's primary does **not** move existing files; the mover is explicit | Changing a default affects new services only; moving is an explicit action (D97 moves) |
| Unraid | Remote SMB/NFS mounts under `/mnt/remotes` (Unassigned Devices) | Network shares mounted at `/mnt/skiff-shares/<share>` and linked as volumes (D143) |
| TrueNAS | **Pools** of devices, then a **dataset per workload** with its own quota/snapshots | A pool member is a volume; each resource gets its own `<mount>/skiff/<id>` directory |
| TrueNAS | Dataset **presets** (Generic, SMB, Apps) and property **inheritance** | The default per kind acts as a preset; the create form preselects it and the creator can pick another pool |
| TrueNAS | Apps choose an **apps pool**; host-path datasets recommended over ixVolumes for durable data | The default for each kind is that choice, made once in Settings; each service can still choose |

**Not copied:** Unraid's FUSE union filesystem (a resource always gets a real path on one volume),
secondary storage and the schedule-driven mover (the pool chosen at creation is where the service
lives; a full pool refuses rather than spills elsewhere), split levels, and public-by-default exports. ZFS vdev layout stays in
VOLUMES P3: Skiff consumes what the disks provide and labels it with a class.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Volume** | One mounted filesystem on one node: a local disk, an LVM/mdadm/ZFS/LUKS stack, or a mounted network share ([VOLUMES.md](./VOLUMES.md)). Has a derived class (`fast`/`bulk`/`remote`/`unknown`). |
| **System disk** | Each node's built-in storage: the helper state dir and the D48 default directories. Always present, never a row. |
| **Pool** | A platform-wide, named group of volumes, possibly on many nodes. A volume belongs to at most one pool. `system` is a built-in pool whose single member on every node is its system disk. |
| **Data kind** | A category of data Skiff writes: databases, object storage, queues, app volumes, builds, site data (and later images, backups, telemetry). |
| **Default storage** | For one data kind: the pool its create form preselects. |

## 3. Model

```text
storage_pools(id, name, description, allocation: most-free|fill-up, min_free_percent)
node_volumes.pool_id → storage_pools.id        -- a volume is in ≤ 1 pool
storage_rules(kind PK, pool_id NULL=system)    -- the defaults (overflow_pool_id is unused)
settings['storage.onboarding'] = done|skipped  -- onboarding finished or skipped
```

The resource keeps what it was placed on (`volume_id`, or null for the system disk). Defaults only
decide **new** services, and moves keep the resource's pool on the target node.

### 3.1 Data kinds

| Kind | What | Unit of placement | Default (fresh install) | Phase |
|---|---|---|---|---|
| `databases` | Managed database data dirs, read replicas, move targets | `<volume>/skiff/<db_id>` | `system` | S1 |
| `object-storage` | RustFS instance data | `<volume>/skiff/<st_id>` | `system` | S1 |
| `brokers` | Queue broker data | `<volume>/skiff/<br_id>` | `system` | S1 |
| `app-volumes` | Project volumes mounted into apps (VOLUMES §14) | `<volume>/skiff/apps/<project>/<vol_id>` | `system` | S1 |
| `builds` | Builder scratch (D48 `buildDir`) | `<volume>/skiff/node/<node>/builds` | `system` | S1 |
| `site-data` | Agent state and static release cache (D48 `dataDir`) | `<volume>/skiff/node/<node>/agent` | `system` | S1 |
| `images` | Container image store (podman `graphroot`) | per node | `system` | S2 |
| `backups` | Local backup target and dump staging | per node | `system` | S2 |
| `telemetry` | ClickHouse data | control node | `system` | S3 |

`system` everywhere is exactly the old behaviour, so an install that skips onboarding is unchanged.
A kind with **no saved default** also keeps the legacy fallback — the node's `default_volume_id` —
so existing installs that set a node default keep using it until they save defaults.

### 3.2 Resolution

For a new resource of kind `k`, with the pool `p` its creator chose (or a single volume, the
advanced escape hatch that bypasses pools):

```
pool      ← p given ? p : default[k]
             (no default saved → legacy: node default volume, else system)
eligible  ← nodes with a usable member of pool (system: every node)
node      ← placement as today, over eligible candidates only (CLUSTERING §3.4 filter)
volume    ← pick(pool, node) ?? refuse          -- never another pool
pick(pool, node):
  pool = system → the system disk
  members ← pool volumes on node, status ready, and
            (free − request) ≥ size × minFreePercent
  most-free → the member with the most free bytes; fill-up → the fullest member that still fits
```

A refusal names the pool and each node's reason ("ssd: edge has no member; homelab member nvme0 is
below 10 % free after 20 GiB"), in the CLUSTERING §3.4 refusal style.

Node-level kinds (`builds`, `site-data`) resolve per node when its desired state is built: the
effective D48 directory is the node's explicit setting, else the default pool's member volume on that node
(**local members only** — Caddy serves releases from `site-data`, and a build cache on a share is
pointless), else the install default. A change reaches the node's existing `skiff-storage.service`
applier, which moves the directory and reports back (D48).

### 3.3 Per-resource choice

Create forms and APIs for databases, object storage, brokers and app volumes take `pool?: string`.
The form's **Storage** field lists the pools with the kind's default preselected, so the choice is
made, and visible, when the service is created; the API uses the default when `pool` is omitted.
`volume` stays for pinning one volume.
The detail page shows the pool and volume a resource landed on.

### 3.4 Network and durability

A pool can mix local and network volumes, but the pool view shows the classes of its members and
warns when the `databases` default is a pool with `remote` or `bulk` members (CLUSTERING §3.3:
`unknown` is refused for databases). Durability is per volume: Skiff shows "no Skiff backup" for
shares (CLUSTERING §5.1) and leaves disk redundancy to the volume's stack.

## 4. Onboarding

Setup gains a **Storage** step after Secure:

1. **Detect.** Show what each node reports: system disk, mounted filesystems not yet adopted
   (with class, size, free), and free block devices (P1 formatting comes later).
2. **Pools.** Suggest pools from classes: `fast` mounts → `ssd`, `bulk` → `hdd`, network shares →
   `nas`. The operator adopts mounts, names pools and assigns volumes; **Add network share** opens
   the share flow (D143).
3. **Defaults.** Prefill: databases, queues and app volumes → the fast pool; object storage and
   builds → the bulk pool; site data → system. Each service can still choose another pool.
4. **Finish** stores `storage.onboarding = done`. **Use the system disk for now** stores `skipped`.

Until one of those is stored, platform admins see a banner linking to Settings → Storage.

## 5. Settings → Storage

One page (platform group, platform admin), four sections:

- **Default storage** — one default pool per kind, which the create forms preselect.
- **Pools** — capacity bar, members (volume @ node, class, free/size), allocation, min free; create,
  edit, delete (refused while it is a default; members fall back to unassigned).
- **Volumes** — per node: registered volumes with a pool picker, mounts waiting to be adopted, and
  a link to **Settings → Network shares** (D143), the section next to Storage.
- **Onboarding state** — the banner disappears once defaults are saved or setup is skipped.

### 5.1 Profiling

**Profile** on a pool (or on one volume, or on a linked network-share mount) benchmarks each ready
member so an operator can see which tier is which before choosing defaults:

| Measure | How (fio) | Fallback (no fio) |
|---|---|---|
| Sequential read / write | 1 MiB blocks, queue depth 8, MB/s | GNU `dd` 1 MiB, O_DIRECT |
| Random read / write | 4 KiB, queue depth 32, IOPS | not measured (shown as —, with a hint to install fio) |
| Sync write | 4 KiB, `fdatasync` after each, depth 1: IOPS and mean round trip | `dd bs=4k oflag=dsync` |

Mechanics: the control plane queues a `volume_profiles` row per member (0070) and lists queued
ones in the node's desired state as `volumeProfileTasks` `{ id, volumeId, sizeMb: 512,
runtimeSeconds: 10 }` — a registered volume id, never a path. The agent (capability
`volume-profiles`) runs them **one at a time** through the helper's `/v1/volumes/profile`, which
resolves the mount from its own registry, verifies it (D76), refuses when free space is under twice
the scratch size, writes under `<mount>/skiff/.profile/` and deletes it afterwards. All I/O is
O_DIRECT unless the filesystem refuses (some CIFS mounts), in which case the result says it measured
cached I/O. Results arrive as `volumeProfileResults` in the heartbeat; a run not finished within 15
minutes fails, and a late report never overwrites a final one. Nodes keep every run; views show the
latest per volume. A profile loads the disk heavily for about a minute per volume, so the dashboard
asks for confirmation first.

**Installing the tools.** `fio` (profiling), `nfs-common` and `cifs-utils` (network shares) are
installed with the other prerequisites by the installer on every agent node. Nodes installed
earlier, or updated in place through the signed node-update verb, get them from the helper: on its
first start of a new version it checks for `fio`, `mount.nfs` and `mount.cifs`, and if any is
missing runs `apt-get install` once in the background (waiting up to 120 s for the apt lock),
recording the attempt per helper version so an unavailable package never makes every restart an
apt run. Debian/Ubuntu only. `SKIFF_HELPER_STORAGE_TOOLS=0` in `/etc/skiff/helper.env` turns it
off, and `--skip-deps` installs write that for the operator.

## 6. Surfaces

| Surface | What |
|---|---|
| REST | Under `/api/v1/platform/storage` (`/storage` is object storage): `GET` (pools, defaults, nodes, onboarding); `POST /pools`, `PATCH/DELETE /pools/:name`, `POST /pools/:name/profile`; `PUT /defaults`; `POST /volumes/:id/profile`; `PUT /volumes/:id/pool` `{ pool: name\|null }`; `POST /onboarding` `{ state: done\|skipped }`. `pool` on database, storage, broker and app-volume create, replica add and moves |
| Permissions | Platform admin dashboard session for every write (D129); read for platform viewers |
| Audit | `storage.pool.create|update|delete`, `storage.defaults.update`, `storage.profile`, `storage.volume.pool`, `storage.onboarding` |
| MCP | read-only `storage` view later; no writes (D29/D53) |

## 7. Safety

- Defaults never move existing data, and Skiff never puts a service on a pool other than the one
  chosen for it. A resource's `volume_id` is fixed until an explicit move.
- Resolution only picks `ready` volumes; the helper still verifies every mount before a start
  (D76), so a missing share fails closed instead of writing to the system disk.
- Deleting a pool that is a default is refused; removing a volume from a pool never touches its data.
- Node-level kinds skip remote members, so Caddy and the builder never depend on a share.

## 8. Moves

`databases` moves (D97) and storage moves ask the resolver for the target node with the
resource's current pool (the pool of its volume, or the kind's default when it was on the system
disk), so a database on `ssd` stays on `ssd` when it moves.

## 9. Phases

| Phase | Scope |
|---|---|
| **S1** | **Done:** pools, per-kind defaults with the pool chosen at creation, resolution and placement filtering for databases, replicas, moves, object storage, brokers and app volumes; `builds`/`site-data` through the D48 applier; Settings → Storage; onboarding step and banner; pool/volume profiling with fio installed by the installer and the helper; REST; tests. |
| **S2** | `images` (podman `graphroot` per node: stop containers, switch `storage.conf`, re-pull) and `backups` (local backup target per pool); pool capacity alerts. |
| **S3** | `telemetry`; a mover that rebalances existing resources between pools on request (stop → copy → verify → start, the D48/D97 pattern); per-pool quotas per org. |
