# Skiff — Clustering, redundancy and high availability

Status: **plan, 2026-11-06.** The direction is **D107**, which retires D24 and the limits that
blocked multi-node work. The mechanisms are **proposed decisions (H1–H16)**, each becoming a
D-number when its spike (§15) passes and it is built; phases are **C0–C10** (§14). Sections describe
the target design in the present tense; the phase named in each section says when it lands. "Today"
means verified here, "the plan" means unbuilt.

**Implemented so far (2026-11-06):** C0's backend — migration 0040, the `hardware` heartbeat block, node zone/roles/labels/CPU budget, derived volume classes, constraint-aware placement and the `GET /topology` + `GET /topology/blast-radius` API with its read-only dashboard page. C1's control-plane model and helper/agent apply path are in too (migration 0041, address allocation, peer graph, managed join fields, the desired-state `wireguard` block, root `wireguard/keygen|apply|status` verbs and peer health on the heartbeat); the served installer still requires the signed agent bundle, and real-host verification has not run. C2's data model, forwarding path, pinned self-signed mTLS and cross-node attachments for process apps are in as well (migration 0043, `node_certificates`, `service_endpoints`, the endpoint planner, desired-state endpoints/providers, the agent's Bun TCP/TLS forwarder with fingerprint pinning, and the `SERVICE_ENDPOINTS` flag covering database and private-storage attachments); the per-install CA, Caddy L4 proxy and cross-node container attachments are not. C3's share registry and dashboard page (migration 0044, CRUD, org grants) and the helper's fixed NFS/SMB mount/unmount verbs are in; desired-state mounting, `backing: share` and blast-radius inheritance are not. C4's replica table, spread planner, deploy-time row population, per-node desired state and route fan-out are in behind `MULTI_NODE_REPLICAS` (migration 0045, `workload_replicas`, `planReplicas`, `RouteSpec.upstreams`); Caddy active health checks, least-conn balancing and automatic replica re-placement off an offline/draining node are in; rolling deploys, surge and drain are not. The rest of this document remains the plan.

Related: [DESIGN.md](./DESIGN.md) §3 and §9, [VOLUMES.md](./VOLUMES.md),
[DATABASES.md](./DATABASES.md), [OBJECT-STORAGE.md](./OBJECT-STORAGE.md), [OPS.md](./OPS.md),
[ALERTS.md](./ALERTS.md), [API.md](./API.md),
[build-plan 10](./build-plan/plans/10-private-networking.md) and
[build-plan 23](./build-plan/plans/23-one-click-nodes.md) (a proposal, extended by §4.1).

**Implementation status (2026-11-06).** The code below is what is actually in the tree; the
"not built" column is the remaining work.

| Phase | In the tree | Not built |
|---|---|---|
| C0 | Hardware heartbeat, zones/roles/labels, placement spec, CPU admission, volume classes, topology/blast radius, Topology UI | Hardware tab, class-override UI, MCP tools |
| C1 | Managed overlay, hubs/LAN mesh, join, installer, helper keygen/apply/status, ufw/firewalld/nftables, peer health | Real two-host verification; installer still needs the signed agent bundle |
| C2 | Cross-node DB/private storage for process apps, TCP/TLS forwarder, pinned self-signed mTLS, endpoint status plumbing | Per-install CA, Caddy L4, container apps, endpoint failover UI |
| C3 | Share registry/API/dashboard, helper NFS/SMB mount verbs | Desired-state mounts, `backing: share`, quotas/uid-gid, blast radius |
| C4 | Replica table/planner, deploy population, per-node state, route fan-out, health checks, re-placement | Rolling/surge, operator drain workflow, move-back |
| C5 | Driver/policy contracts, `IngressHealth`, status API, Settings page | Probing, Cloudflare writes, full route tables, certificate distribution |
| C6 | Lease decision logic and CAS interface | Standby, Litestream follow, epoch propagation, promotion |
| C7 | Replica registry/API/UI, failover table, promotion-choice logic | `pg_basebackup`, slots/WAL, streaming/lag, promotion execution |
| C8 | Failover stage machine | Three-signal detection, fencing/promotion execution, drills |
| C9 | Replication registry/API/UI, migration | RustFS rule execution, IAM/config recreation, promotion |
| C10 | Engine replication capability values | Per-engine replica topology and member networking |

**Contents:** [0 Summary](#0-summary) · [1 Goals](#1-goals-and-non-goals) · [2 Vocabulary](#2-vocabulary) · [3 Hardware](#3-hardware-model-and-service-mapping) · [4 Network](#4-network) · [5 Storage](#5-storage-and-shared-drives) · [6 Control plane](#6-control-plane-ha) · [7 Ingress](#7-ingress-ha) · [8 Workloads](#8-workload-ha) · [9 Databases](#9-database-ha) · [10 Object storage](#10-object-storage-ha) · [11 Failure matrix](#11-failure-matrix) · [12 Surfaces](#12-surfaces) · [13 Data model](#13-data-model-changes) · [14 Phases](#14-implementation-phases) · [15 Spikes](#15-spikes) · [16 Decisions](#16-proposed-decisions) · [17 Security](#17-security-and-threat-model) · [18 Runbooks](#18-operations-runbooks) · [19 Testing](#19-testing-and-verification) · [20 Compatibility](#20-compatibility-rollout-and-upgrades) · [21 Risks](#21-risks-and-open-questions) · [22 Alternatives](#22-alternatives-considered)

---

## 0. Summary

Skiff becomes a small cluster without becoming Kubernetes. Five ideas carry the plan:

1. **Nodes describe their hardware; operators describe failure domains.** Hourly CPU, RAM, GPU and
   disk facts plus an operator-set zone, roles and labels let placement make one deploy-time
   choice, preventing a database on a parity array or two replicas in one house.
2. **Every node reaches every attached service on loopback.** A consumer's Caddy forwards a local
   port over the overlay to the provider, so an app keeps `127.0.0.1:<port>` wherever its database
   runs, a move needs no redeploy, and data ports stay private (D56).
3. **Redundancy lives in the data services, not the disks.** Postgres streams to replicas, RustFS
   replicates buckets and SQLite uses Litestream, so a distributed filesystem's footprint and
   failure modes do not land on a fleet whose largest node has 12 GB of RAM.
4. **One active control plane, with warm standbys and fencing.** SQLite stays the single writer; a
   standby follows the Litestream replica; a lease picks the primary and an epoch fences the
   deposed one, preventing split brain after a partition.
5. **High availability is a per-resource level, opted into and visible.** `L0` is one copy and the
   default; `L3` is active replicas across zones, so silent single copies are visible.

| Capability | Today | The plan adds |
|---|---|---|
| Nodes and control | Join tokens, per-node desired state, 10 s heartbeats, pull reconciliation (D23), memory admission (D42) | Zones, roles, labels, hardware facts, constraint placement, epoch and generation, CPU and disk budgets |
| Attachments and replicas | Same-node only, pinned to the service's node (D56); workers only, on one node (D90) | Loopback endpoints over the overlay; HTTP replicas across nodes and zones |
| SQLite and updates | Litestream to R2; a same-host update slot (`SKIFF_STANDBY=1`, not an HA standby) | A cross-zone standby that follows the replica and can be promoted |
| Ingress and overlay | One edge with a manual hand-off (D98); host-provisioned WireGuard | Every ingress a full edge with DNS steering; managed hubs and LAN mesh (§4) |
| Databases | One primary per database, loopback only | Streaming replicas, promotion and read URLs |

---

## 1. Goals and non-goals

**Goals.** Survive losing any one node within the bounds below; put each service on suitable
hardware; mount one share on any node (§5); keep pull reconciliation (D23), one service layer,
fixed helper verbs (D43), private data ports (D56), human-gated destruction (D29/D35) and a small
footprint; leave the single-node install untouched. `L2`/`L3` **data** keeps an `L1` path.

| Failure | Bound | Conditions |
|---|---|---|
| Any one ingress node | Every static route and `L3` app served within **120 s** proxied, **240 s** DNS-only (**165 s** with one witness) | Two ingress nodes in distinct zones; control plane reachable or promoted; `dns-failover`. Derivation: ≈45 s promotion + 45 s hold-down + withdrawal (§7.2, §11.1) |
| Control-plane primary | Mutations back within **60 s** `auto` (45 s measured), **15 min** manual | Warm standby in another zone, replay within RPO, object store reachable. §11.1: promotion completes at ≈45 s; the 60 s figure is the published bound |
| Any one compute node | `L3` traffic moves within **10 s**; copies re-placed within grace + 2 min | Two replicas in distinct zones and failover headroom |
| Any one data node | `L2` promoted within **120 s** `auto`, **15 min** manual; no loss beyond RPO | A caught-up replica, three-signal detection, mandatory fencing |
| Any one node | No acknowledged write lost beyond the stated RPO | `sync` gives RPO 0; `async` the lag; Litestream ≤ 1 s |
| The object store | No promotion; the control plane read-only after one TTL; sites serve | A safe failure, not a data outage |
| A single-node install | No behaviour change and no new dependency | No lease, no epoch, no new unit (§13.8) |

| # | Invariant | Enforced by |
|---|---|---|
| I1 | At most one control plane accepts writes per epoch; a fenced node writes nothing | Lease CAS; API 503; agents treat 503 as unreachable (§6.3) |
| I2 | The epoch is strictly monotonic, +1 per promotion | Only the lease CAS writes it; agents keep the highest seen |
| I3 | At most one primary per database generation | `POST /databases/:name/promote` with `If-Match: <primary_generation>` (§9.3) |
| I4 | A singleton runs at most once | Run lease, then self-fencing after one TTL (§8.4) |
| I5 | A single-writer volume is mounted read-write on at most one node | Helper mount registry and the D97 move protocol (§5) |
| I6 | No acknowledged write is lost beyond the stated RPO | `durability` per database; Litestream interval; no silent downgrade |
| I7 | Only the lease holder replicates SQLite | The Litestream unit is gated by lease ownership (§6.2) |

**Non-goals, with the trade-off each accepts.** No continuous scheduler or autoscaling: capacity is
planned, so a hot node can sit beside a cold one until **Rebalance**. No multi-writer control plane:
failover costs a TTL plus promotion and the standby idles, but SQLite stays the writer without
consensus per write. No distributed block or file storage: a single-writer volume is pinned and
capped at `L1` (or `L2` with an explicit replicated-copy protocol). No geo-routing, Kubernetes API
or federation (D5): distant users keep zone latency, and one install has one control plane.

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Zone** | A failure domain: everything in it shares power, uplink and provider fate. A node belongs to exactly one. |
| **Role** | What a node may run: `ingress`, `control`, `compute`, `data`, `build`. Placement filters on the set. |
| **Label** | A `key=value` attribute placement matches. `skiff.io/*` is derived and read-only; operator labels are free-form. |
| **Volume class** | `fast`, `bulk`, `remote` or `unknown`, derived from the mount's stack and overridable with a reason (§3.3). |
| **HA level** | Per-resource redundancy: `L0` single, `L1` recoverable, `L2` failover, `L3` active (§8.1). Default `L0`. |
| **Service endpoint** | A consumer-side loopback port forwarded over the overlay to a provider node (§4.3). |
| **Lease** | A time-bound object-store claim to be the control-plane primary: `{epoch, holderNodeId, expiresAt}`. |
| **Epoch** | A monotonic counter incremented at each control-plane promotion. Agents reject lower epochs. |
| **Generation** | A per-resource counter (`primary_generation`) fencing one database's writers; not the global epoch. |
| **Run lease** | A per-singleton, TTL-bound permission to run, so one singleton does not run twice. |
| **Promotion** | Making a standby or replica primary. Control-plane promotion bumps the epoch; database promotion the generation. |
| **Switchover** | A planned promotion after the old primary stopped, with no acknowledged loss. |
| **Fencing** | Making a former primary refuse writes, so two primaries cannot both mutate. |
| **Self-fencing** | A node that loses contact stops units that must never run twice, without waiting for the control plane. |
| **Drain** | Moving or stopping what a node runs for maintenance; `cordon` and `evacuate` are its narrower and broader forms (§3.9). |
| **Surge** | Starting a replacement copy before stopping the old one, when budget allows. |
| **Hold-down** | The wait after a signal recovers before reversing a route or promotion, so a flapping node does not thrash the fleet. |
| **Witness and quorum** | The object store is the witness: a third vote in a two-control-node install, holding only the lease. Quorum is the minimum agreeing participants, used only for that lease. |
| **Split brain** | Two components both believing they are primary and both accepting writes. |
| **Blast radius** | What becomes unavailable if a node, zone or dependency fails, from placement and reported health (§11). |
| **Capability** | An agent-declared feature string (`ha-epoch`, `l4-endpoints`) gating desired-state work; missing means ineligible. |

---

## 3. Hardware model and service mapping

This section defines the facts placement uses, the fields the operator owns, and how services map
to hardware. Networking is §4; HA behaviour is §6–§9.

### 3.1 What the node reports (H1)

The agent adds a `hardware` block to the heartbeat. It refreshes at start-up, every hour, and when
the helper's volume inventory generation changes. UPS state refreshes every 60 s.

| Field | Unit | Source | Refresh | If unavailable |
|---|---|---|---|---|
| `arch`, `cpuModel`, `cores`, `threads` | —, count | `os.arch()`, `os.cpus()`, `/proc/cpuinfo` | Start-up, hourly | Omit the model; omit the block if cores are unknown |
| `memoryBytes`, `swapBytes` | bytes | `/proc/meminfo` | Start-up, hourly | Omit; the node cannot be admitted for new work |
| `os`, `kernel`, `virtualization` | — | `/etc/os-release`, `uname -r`, `systemd-detect-virt` | Start-up, hourly | Omit kernel; `unknown` for virtualisation on a container or non-zero exit |
| `gpus[]` | name, MiB, PCI id | `nvidia-smi --query-gpu=… --format=csv,noheader`, `/dev/dri/renderD*`, PCI vendor/device files | Start-up, hourly | Sysfs fallback; no binary means `gpus: []`, never an install |
| `disks[]` | bytes, `rotational`, `transport` | The helper's `volumes.inventory`, plus `/sys/block/<dev>/queue/rotational` and transport | Start-up, hourly, inventory change | Keep the last inventory, marked stale; never guess |
| `nics[]` | Mbit/s, MTU | `/sys/class/net/<if>/speed` and `/mtu` | Start-up, hourly | Omit speed when it reads `-1` (a virtual NIC) |
| `power` | state, per cent | `upsc` over the NUT socket, when present | 60 s | `null`; no NUT is not an error |

Discovery is read-only and local: no package install, no container, no driver load. `nvidia-smi` is
optional (absent or blind inside LXC), with `/dev/dri` and sysfs as fallbacks; missing values are
omitted, never zero.

**Validation and storage.** `hardware.v1` is a Zod schema in `@skiff/contracts`: fixed units,
non-negative integers, caps (16 GPUs, 64 disks, 32 NICs), sanitised strings and a 64 KiB bound. It
is stored in `nodes.hardware_json` with `hardware_at`; a parse failure keeps the previous block,
sets `hardware_error` and alerts. Derived labels are computed server-side, never operator-written:
`skiff.io/arch`, `skiff.io/virt`, `skiff.io/gpu`, `skiff.io/gpu-count`, `skiff.io/memory-gb` and a
sanitised `skiff.io/cpu-model`, recomputed only when the block changes.

### 3.2 What the operator sets (H2)

| Field | Default | Validation |
|---|---|---|
| `zone` | `default` | Lowercase `[a-z0-9-]{1,32}`; one zone per power/uplink domain |
| `roles` | Edge: `ingress, control, compute, data`; worker: `compute, data` | At least one; `ingress` needs an address or tunnel, `control` 2 GB RAM and 10 GB free, `data` a mounted volume, `build` `can_build` (D47) |
| `labels` | none | ≤ 32, lowercase keys, `skiff.io/` reserved |
| `lanEndpoint` | none | Private LAN address inside one zone |
| `defaultVolumeId` | none | A registered, mounted volume on that node (D74) |
| `sliceMemoryMb` | 1024 | Cannot drop below current reservations (D42/D47) |
| `sliceCpuWeight` | 200 | 1–10,000; lower than the platform services |
| `canBuild` | false | Boolean; `build` is its alias |

**Role removal while work runs** is refused with a `409` listing every running resource under that
role. The operator moves what can move (D97) and retries. The D97 exceptions are real: an app with
an app volume or a persistent data dir cannot move, a PITR database cannot move, and a storage
instance moves only empty. There the choices are to keep the role, delete and recreate elsewhere, or
wait for move support that does not exist yet.

**Derived versus operator.** Operator-owned: the eight fields above. Derived: `hardware_json`, the
`skiff.io/*` labels, volume classes, the effective role set (`build` when `can_build` is true), free
budget and the HA ceiling. `nodes.mode` and `can_build` stay stored: several nodes may hold
`ingress` but exactly one is the edge (D98 relies on the singular field and lookup in
`packages/core/src/nodes.ts`), and `can_build` is D47's toggle with `build` as its alias. This
narrows H2's "both become derived"; §16 still lists the proposal.

**Zone naming.** Name the failure domain: `cloud-a`, `cloud-b`, `home`. Different regions or
providers are two zones; one LAN or one UPS is one. A rename is refused while an `L2`/`L3` resource
spreads across it, and the dashboard warns when two zones share a public /24 or LAN prefix. `L3`
across zones requires zones that pass that check, or an explicit override.

### 3.3 Volume classes (H3)

Every volume gets a `class`, derived from how the filesystem is provided and from the disk facts.
The derivation is conservative: an unrecognised stack is `unknown`, and `unknown` is refused for
managed databases rather than guessed as `fast`.

| Detected stack | Class | Why |
|---|---|---|
| NVMe, or a SATA/SAS SSD (`rotational=0`) | `fast` | Lowest commit latency; the database default |
| HDD, USB, md RAID5/6, or any array with a rotational member | `bulk` | Seek and parity penalties make fsync unpredictable |
| md RAID0/1 over SSDs | `fast` | No parity penalty |
| ZFS all-flash vdevs / ZFS raidz over HDDs | `fast` / `bulk` | Data vdevs decide; raidz pays parity |
| Unraid array over virtiofs / cache-pool vdisk | `bulk` / `fast` | The vdisk lies about rotation; the pool is SSD, so override |
| NFS or SMB mount | `remote` | Locking, latency and a server that can vanish |
| Unknown stack, or no stable identity | `unknown` | Refused for managed data (D72) |

**Overrides.** An operator may set `classOverride` plus a reason, audited as `node.update`. `remote`
cannot become `fast` or `bulk`; the override is stored against the volume's `sourceKey`, goes inert
if the volume is replaced, and is re-checked when the inventory changes. It is the only way a virtio
cache-pool vdisk becomes `fast`.

### 3.4 Placement (H4)

`placement` grows from `edge | <node> | auto` into a constraint spec, with the old values as
shorthands.

```ts
interface PlacementSpec {
  node?: string; zone?: string | string[];                    // hard pin; zone restriction
  roles?: Role[]; labels?: Record<string, string>;            // derived from type; all must match
  volumeClass?: 'fast' | 'bulk' | 'remote'; volumeId?: string; // volume pins its node (D74)
  spread?: 'node' | 'zone'; near?: string;                    // replica constraint; locality hint
}
```

**Filter** is a hard screen. `spread` is a filter, not a score: a penalty cannot guarantee "never
two copies in one zone" when a node with more free budget holds one.

```
filter(spec, resource, fleet):
 1  candidates ← online nodes that are not draining
 2  node / zone / roles / labels / volumeClass → drop non-matches
 3  locality: before C2, an attached resource keeps only its provider's node
 4  spread: replica n>0 drops nodes (and zones, when zone) already holding a copy
 5  admission: memory, CPU and disk reservations must fit
 6  failover reserve: drop a placement that leaves the fleet unable to absorb any one node
 7  empty → PlacementRefusal, one first-failing reason per node
```

**Score** then orders the survivors, in order: (1) free memory and CPU ratio, averaged, descending;
(2) +40 locality for the attachment provider or `near`; (3) +20 for compute-only nodes; (4) +0–20
free disk ratio; (5) a stable hash of the node id, so the same fleet makes the same choice.

**Budget maths.** Memory is `memoryMb × replicas` (D90), and a managed database counts the same way
(D55); admission is `reservedMb + reserveMb ≤ sliceMemoryMb`, unchanged from D42. CPU is
`cpuMillis = cpuQuotaPercent × 10` against `hardware.cores × 1000` (or `nodes.cpu_budget_millis`),
with `reservedMillis + cpuMillis ≤ budget × 0.9`. Disk reserves `volumeSizeMb × 1.1` and needs
`reserved + requested ≤ freeBytes × 0.9`; a node without `diskFreeBytes` is refused. The fleet
failover reserve must still fit the largest node's reservations, or the placement is refused.

**Refusal format.** One first-failing reason per node, in filter order, requirement before cause:

```
placement refused for database "orders" (data, zone cloud-b, 2048 MiB, 500 millicores, a
fast volume): edge memory 512/1024 MiB free; edge-b no mounted fast volume; homelab draining
```

REST returns `{ error: "placement_refused", resource, requirements, nodes: [{id, name, reason}] }`
and the dashboard renders the same list; a refusal never collapses to "no capacity".

**Worked examples.** (1) An `L2` Postgres of 2 GiB on `fast` with `spread: zone` puts its primary
on edge and replica on edge-b, filtering homelab as `bulk`. (2) An `L3` app with two replicas and
`spread: zone` is refused in a one-zone fleet and gets one copy per zone in a two-zone fleet. (3) A
GPU job matches only `skiff.io/gpu=nvidia`; score never runs. (4) An attached app before C2 is
hard-pinned to its database's node, and no failover moves a pin; it caps at `L0`/`L1`.

**D41, D97 and pins.** `auto` keeps its order: static to `ingress`, apps to a worker with budget,
otherwise the edge; `PlacementSpec` is a constraint on that, not a scheduler. A running workload
moves only through D97 or an opted-in failover, and changing a pin is a move. Placement is
re-evaluated only on deploy, scale, **Rebalance** and failover.

### 3.5 Default mapping

| Service | Roles | Constraint | Why |
|---|---|---|---|
| Ingress and static sites | `ingress` | Public address or tunnel, stable uplink | Every ingress node serves every route and static release (§7) |
| Control plane, ClickHouse | `control` | 2 GB RAM, a zone distinct from the primary's; ClickHouse only where 300–800 MB is spare | Primary and standby in different zones (§6); telemetry is optional (D101) |
| Process and container apps | `compute` | `near` their database; `spread` for replicas | Short data hop, spread failure |
| Postgres, MySQL, MariaDB, MongoDB, Valkey, Redis | `data` | A `fast` volume with RAM headroom | Parity fsyncs make commit latency unpredictable; replica traffic crosses nodes |
| RustFS | `data` | `bulk` for capacity, `fast` for small hot buckets | Objects tolerate seek latency; databases do not |
| Builds | `build` | `can_build`, most cores, not an ingress node when another builder exists | Bursty; must not starve ingress (D47) |
| GPU jobs | `compute` | `skiff.io/gpu=nvidia` | The label is the only proof the device is visible |
| Backup target | — | Prefer another zone and provider; warn when it is not | A backup in the same failure domain is not one, but D83 does not forbid it |
| App volumes | `compute` | Pinned to the volume's node; `L1` today, `L2` snapshot shipping from C9, never `L3` (§5.4) | [VOLUMES.md](./VOLUMES.md) §14 pins a project to one node today |

### 3.6 Reference topology for this fleet

The fleet today is the prod VPS (edge and control plane), the Unraid homelab VM and `linux-box` on
the same LAN. This is the recommended target; costs are estimates, not quotes.

| Node | Zone | Spec | Roles | Runs | Estimate |
|---|---|---|---|---|---|
| `edge` (existing VPS) | `cloud-a` | 2 vCPU / 4 GB / 40 GB | ingress, control, compute, data | Ingress, primary control plane, small critical apps and primaries | €5–8/month (paid) |
| `edge-b` (new VPS) | `cloud-b` | 2 vCPU / 4 GB / 40 GB | ingress, control, compute, data | Second ingress, standby control plane, database replicas, app replicas | €5–8/month |
| `homelab` (Unraid VM) | `home` | ~6 vCPU / 12 GB / 200 GB | compute, data, build | Heavy apps, larger `L1` databases, bulk RustFS, builds, off-site backup copy | Owned; €10–25/month power if counted |
| `linux-box` | `home` | Existing desktop | compute, build | Builds, batch work, extra replicas; LAN peering | Owned |

**Why a second VPS, not the homelab as the HA twin.** A home connection is the weakest failure
domain: residential power and uplink, often CGNAT, and 10–30 ms to the VPS that every synchronous
commit pays. The homelab is excellent for capacity, bulk storage and the disaster-recovery copy,
and poor as the synchronous partner. A small second VPS gives two independent cloud zones for
ingress, the control plane and critical data; the homelab stays a third zone for stateless replicas
and backups.

**Capacity maths.** With 4096 MB, the edge spends ~860 MB on the OS (~400), the control plane's
350 MiB reservation (§6.1), Caddy (50), agent (50) and helper (10), leaving ~2212 MB after its
1024 MB slice; with ClickHouse it spends ~1628 MB and leaves ~1444 MB. `edge-b` with a standby
control plane spends ~860 MB and leaves ~2212 MB. The homelab (12,288 MB) leaves ~3486 MB after an
8192 MB slice. The edge's 1 GiB default slice is the binding constraint: a 2 GiB database cannot
land there unless the operator raises `sliceMemoryMb`, which reduces the failover reserve. Losing
the edge means `edge-b` must absorb its 1 GiB of workloads; it fits in 2.2 GB, but only while the
fleet keeps that reserve.

### 3.7 Unraid specifics

- **Databases:** a vdisk on the SSD **cache pool**, or a passed-through NVMe, adopted as a `fast`
  volume. The vdisk reports `rotational=1`, so it needs the §3.3 override, never the parity array.
- **Bulk data:** an array share passed with **virtiofs** (Unraid 7) is local-path `bulk`; the same
  share exported over NFS is `remote` (D77). Both serve the same data; their classes differ.
- **GPU:** VFIO passthrough, so the VM reports `skiff.io/gpu=nvidia`; without the device the label
  disappears and GPU placement refuses rather than landing silently.
- **Boot order:** VM autostart after the array starts. Mount units fail closed (D76), so a VM that
  boots before its share appears refuses to start instances instead of writing to the root disk.
- **Power:** NUT (or `upsc` in the VM) feeds `power.state` into the heartbeat; a low-battery event
  drains the node so its `L3` replicas move and its databases switch over before shutdown.

### 3.8 Capacity and cost model

Steady RSS figures are estimates from [DESIGN.md](./DESIGN.md) §3.2 and the D101 limits, not
measured guarantees; clustering adds no component to a node that is not using it.

| Component | Where | Steady RSS | Notes |
|---|---|---|---|
| Agent and Caddy | Every node | 60–100 MB | Endpoint work adds listeners, not processes |
| Control plane | Control nodes | 150 MB steady; 350 MiB reserved | A standby runs the release; only one accepts writes (§6.1) |
| ClickHouse | Control nodes, optional | 300–800 MB | Off by default (D101); the largest single overhead |
| Litestream | Where SQLite replicates | 20–40 MB | One process per replicated SQLite file |
| PgBouncer | Where enabled | 10–20 MB | Per database, beside Postgres (D85) |
| RustFS | Data nodes | 100–200 MB + page cache | Page cache is not reserved; watch free memory |
| Helper, studio, lease | Every node / on demand | < 10 MB, 256 MB cap, 0 MB | The studio runs only while a session is open (D96) |

Per level, `L0` adds nothing; `L1` adds Litestream (20–40 MB where used) and backup storage; `L2`
adds a second copy's RAM (plus the control plane's 350 MiB reservation), a second data copy and one
WAL or snapshot stream; `L3` multiplies compute and ingress but adds no storage.

**WAN replication.** A quiet database writes 50–200 MB of WAL a day, a busy one 1–5 GB. `sync`
adds one replica round trip per commit: 10–30 ms in-country, 50–150 ms for a five-commit
transaction. The operating rule is `sync` at or below **30 ms** RTT (§3.8 headroom rules, Q5); 50 ms
is the point past which it is refused outright. The home zone is excluded from `sync` by policy
whatever its measured RTT, because §3.6 rates it the weakest failure domain; the topology pairs
cloud zones rather than stretching `sync` to the house, and R2 has no egress fee.

**Backup storage.** Litestream keeps a daily full snapshot plus WAL: budget 2–3× the SQLite size
per month before retention. A logical dump compresses to 20–40% of the database, so 30-day
retention of a 2 GB database is about 18 GB; bucket replication doubles that. At €0.015 per
GB-month, 20 GB retained is €0.30–0.60; two copies of a media library are the cost.

**Example monthly cost.** Two VPSes at €5–8 each, 20 GB of R2 at €0.30–0.60, plus 10–30 GB of
egress at €0–3 and free DNS, total **€10–20**. Cloudflare Load Balancing adds €5–25,
for €15–45.

**Headroom rules.** Keep 25% of `sliceMemoryMb` unplaced on any node that also runs `ingress` or
`control`; hold a failover reserve equal to the largest node's reservations; alert at 15% free and
refuse at 90% reserved; run `sync` only at or below 30 ms RTT; and recompute blast radius after any
deploy that raises reservations.

**When clustering is not worth it.** One machine with no second power or uplink domain; a second
site in the same house; a WAN slower than about 50 ms when synchronous durability is the point; a
dataset too large to replicate; no willingness to run restore and failover drills; or an all-`L0`
mix whose downtime is acceptable. Then one node with backups beats a fleet that cannot pass its own
acceptance criteria.

### 3.9 Node lifecycle

Lifecycle: join → verify → label → admit → drain → decommission. Schema has `pending`,
`online`, `offline` and `draining`; `draining` is a cordon flag beside the status, so a draining node
stays `online` for heartbeat, reporting and everything else, and only stops receiving placements
(§8.5). Drain moves nothing today.

| State | Meaning | Enters when |
|---|---|---|
| `pending` | Token issued, no heartbeat yet | Token created; it expires after 1 h |
| `online` | Heartbeat within 30 s, placement-eligible | First heartbeat plus a passing checklist |
| `offline` | No heartbeat for 30 s (`OFFLINE_AFTER_MS`); alert at 2 min (`ALERT_AFTER_MS`) | Missed heartbeats |
| `draining` | Cordoned: no new placements; existing work moves or stays | Operator action, UPS event or decommission |

**Join.** A single-use token (1 h) and one-line command (§4.1, plan 23) carry the node's WireGuard
public key; the control plane allocates the id, overlay `/32` and token in one transaction, and the
node stays `pending` until its first heartbeat. A re-run repairs a half-installed node.

**Verify.** First heartbeat within 60 s; overlay handshake within 20 s; Caddy answers on its overlay
health host; helper reports its version; clock skew under 120 s; the volume inventory parses; the
agent declares `ha-epoch` and `l4-endpoints`. Failure leaves the node `online` but
**placement-ineligible** and names the check; a wrong clock cannot hold a lease.

**Label and admit.** `PATCH /nodes/:id` sets `zone`, `roles`, `labels`, `lanEndpoint`, default
volume and class overrides (§3.2/§3.3); every edit is audited as `node.update`. A node is eligible
when it is `online`, verified, has no `hardware_error` and passes admission for the resource; the
dashboard shows **eligible** or the first blocking reason.

**Drain.** `POST /nodes/:id/drain` with mode `cordon`, `drain` or `evacuate`: **cordon** stops new
placements; **drain** moves what can move; **evacuate** stops everything and accepts downtime for
`L0`. Order: `L3` replicas, `L2` databases by switchover, then stateless `L0` best-effort. Builds
get their 10-minute cap and no new claims, a studio session
closes, and a share unmounts when no local workload uses it. An app volume cannot move today, so it
blocks a clean drain and is listed. The 30-minute deadline leaves the node `draining` with blockers
shown; nothing is force-stopped, and `POST /nodes/:id/resume` cancels it idempotently.

**Decommission.** A node may hold the lease, an ingress certificate lease, a
`synchronous_standby_names` slot, a replica, a share server and a valid CA-issued certificate, so
the order is: cordon → drain → verify nothing remains → leave any sync quorum → transfer the
lease, ACME and ingress roles → revoke token and certificate → drop the overlay peer and free
the address → wipe with evidence → `DELETE /nodes/:id`. Removal is refused for the last ingress,
the last control node while HA is enabled, the last hub and a required sync replica. A dead node
cannot cooperate: revoke immediately, accept the data loss, and promote its replicas.

| Step | Failure | Result |
|---|---|---|
| Join | Token expired or used; no handshake within 20 s | `401`, or `pending` until expiry and address reclaim |
| Verify / Label | A check fails; invalid zone, role or label | Ineligible, or `422` with the node unchanged |
| Admit | Budget or volume check fails | Placement refuses; still eligible elsewhere |
| Drain | Deadline expires | Stays `draining`; blockers listed; no force stop |
| Decommission | Last ingress, control node, hub or required sync replica | Refused, naming the role or slot |
| Decommission | Node already dead | Token and certificate revoked; data lost; replicas promoted |

Every step is idempotent and resumable; a rebuilt machine is a new node with a new id and
certificate that must not inherit the old one's roles, replicas or sync slot. The decommission
checklist is a runbook (§18).

---

## 4. Network

Three jobs: a private address per node that survives losing any hub, a path for every agent to the
primary control plane, and a loopback port for every cross-node service. §4.1–§4.4 are the paths;
§4.5 states what crosses each boundary.

### 4.1 Overlay: hubs plus LAN mesh (H5)

**Hubs.** A node is hub-eligible when it has a public address and holds `ingress`, so the hub set
stays small and the role keeps its meaning. Elect at most four: one per zone first for diversity,
then the lowest node id. A `draining` node is not elected, a drain leaving no hub is refused, and no
eligible node means no overlay. Losing a hub only affects pairs relayed through it, which move to
another hub within one reconcile of the hub being marked offline (30 s, `OFFLINE_AFTER_MS`). None of
this is built: plan 23 proposes one edge hub, the helper has no `wireguard` verb, there is no
overlay column, and WireGuard is host-provisioned, so C1 generalises it.

**Peer graph.** Recomputed on join, removal, a zone or `lan_endpoint` change and a hub election;
every remote `/32` sits under exactly one entry.

1. Direct: a hub, or a same-zone node with `lan_endpoint` (`endpoint` is `host:51820` or the LAN
   address, which wins).
2. Relayed: every other `/32` sits in the `allowedIps` of the hub in that zone, or of the lowest-id
   hub. A hub forwards overlay to overlay only; a NATed node in another zone is never a direct peer.
3. Cryptokey routing drops any source outside a peer's `allowedIps`, which is what makes the §4.3
   allowlist enforceable.

**Addresses.** `10.88.0.0/22` per install by default, in `nodes.private_cidr`; `10.88.0.0/24` is
reserved for gateways, leaving 768 node `/32`s taken from `10.88.1.0` in join order. A join is
refused if the CIDR overlaps `ip route` or `100.64.0.0/10` (CGNAT, Tailscale). C1 adds
`nodes.private_address`, `private_cidr`, `wg_public_key` and `network_mode`, superseding plan 10's
`10.88.0.0/16` and plan 23's random `/24` and `nodes.wg_address`: one field name, one CIDR.

**Keys, MTU and keepalive.** `wireguard/keygen` runs on the node: the public key goes to the control
plane, the private key to `/etc/skiff/wireguard/wg0.key` (0600 root), never to desired state, logs
or audit. The MTU is the minimum of the probed paths: probe 1360–1500 in 8-byte steps with `ping -M
do`, subtract 80 bytes of WireGuard overhead, giving a `wg0` MTU of 1280–1420, at join and after a
restart; a probe filtered by ICMP keeps 1420. `PersistentKeepalive=25` is set only on the dialling
side; handshake age, RTT and bytes ride the heartbeat.

**LAN mesh and bring-your-own networks.** Same-zone pairs with `lan_endpoint` peer directly at
`LAN:51820`; if that path dies the pair is re-rendered onto the zone hub at the next reconcile.
`network_mode: external` creates no tunnel: the operator supplies the address the other nodes
already reach (Tailscale, a VPC, a LAN), the join is refused unless a hub shares it, and that
address becomes `private_address` with no peer list.

**Firewall.** One helper-owned `inet skiff` table, applied with `nft -f` after `nft -c -f`: on
`wg0`, established state, UDP 51820 on a hub, `:8080` from ingress `/32`s, one `tcp dport <port> ip
saddr <consumer /32>` rule per attachment, then drop.

**Desired state and join.** Per node, gated by `wg-mesh`: `{ mode, address, mtu, peers[],
allowedPeers[] }`. C1 adds `wireguard/{keygen,apply,peers,status}` and `network/{allow,probe-mtu}`,
validating keys, `/32`s inside the CIDR, ports and an MTU of 1280–1420.

1. **Add node** issues a token carrying the control plane's SPKI hash (`skn1_<sha256>_<secret>`);
   the agent pins it, `node.sh` checks root, systemd, arch and the kernel module, and
   `wireguard/keygen` runs.
2. `POST /api/agent/join` allocates the `/32` in the token transaction and returns the address, MTU
   and each hub's key and endpoint.
3. `wireguard/apply` brings `wg0` up, and a handshake is due within 20 s.
4. Every node diffs the peer in; removal drops it everywhere and then frees the `/32`.

### 4.2 Agents and the control plane

Today an agent has one control origin: `SKIFF_CONTROL_URL` in `/etc/skiff/agent.env`, written at
join and stored in `node.json` — no endpoint list, no pin beyond the system roots, no persisted
epoch. The endpoint list, in order: the control-plane unix socket on a node that runs it; the
`private_address` of every `control` node, primary first; then the public platform URL. The list
rides the heartbeat response (`controlEndpoints`). The agent tries them in order, with a 2 s connect
timeout and a 5 s first-byte timeout, and takes the first whose epoch is at least the highest it has
seen, writing that epoch atomically to `$SKIFF_DATA_DIR/epoch.json` before applying the state (§6.3).

**Backoff, pins and revocation.** Retries run 1 s, 2 s, 4 s … capped at 30 s with ±20 % jitter,
reset on success. A `503` with code `control-fenced` is a refusal, not an answer, so the agent moves
on (§8.4). Every control certificate is checked against the SPKI pin from the join token; rotation
publishes the next pin in the heartbeat response, signed by the current key, and both are accepted
for 30 days. A revoked token gets `401 node-revoked`: the agent stops pulling, keeps serving cached
state and stops its singleton units, but never deletes data. With no answering endpoint it keeps
serving (D23); the node shows offline after 30 s and alerts after 2 min (§12).

### 4.3 Service endpoints: loopback everywhere (H6)

This replaces plan 10's "inject the remote private IP". Today `resolveForConsumer` filters on
`db.nodeId === nodeId` (D56); C2 makes it cross-node, and same-node attachments keep their direct
path. Ports are allocated per consumer node by the control plane, never from the provider's port,
and recorded in `service_endpoints` (`consumer_node_id`, `service_id`, `local_port`,
`upstream_node_id`). Two providers on host port 15432 give one consumer two local ports, so nothing
collides on `127.0.0.1`; allocation is the lowest free port. Attaching starts one L4 listener on
each side, the row is `ready` once both report `applied` and a TCP probe passes (2 s, three
attempts), and detaching drains for 30 s and removes both. An agent restart re-applies them before
reporting online, and ports never change. A node holds at most 1,000 endpoints.

| Range | Use | Owner |
|---|---|---|
| `8081`, `8082`, `8083` | S3, database and studio gateways (D82, D96) | existing config |
| `15432–17431` | database host ports, then pooler ports | today |
| `18123` | ClickHouse HTTP | `scripts/systemd/clickhouse.ts` |
| `19000–19999` | storage instance ports | used today |
| `21000–21999` | consumer endpoint ports | C2 |
| `22000–22999` | read-URL ports on the consumer node | C7 |

The ranges are disjoint and each has one allocator; a new range is added here before anything uses
it. `18123` lies between the database and storage ranges and belongs to ClickHouse alone, so no
allocator hands it out.

**Caddy L4 sketch** (JSON through the admin socket; `caddy-l4` is not in today's build — the
`docker/node/Dockerfile` ships only `caddy-dns/cloudflare`, so C2 compiles and pins it):

```jsonc
// consumer: loopback + workload gateway -> the provider's overlay port
{"apps":{"layer4":{"servers":{"ep-db_01":{"listen":["127.0.0.1:21432","10.89.0.1:21432"],"routes":[{"handle":[{"handler":"proxy","upstreams":[{"dial":["10.88.1.5:15432"]}]}]}]}}}}}}
// provider: overlay listener, client cert from the install CA -> the service loopback
{"apps":{"layer4":{"servers":{"svc-15432":{"listen":["10.88.1.5:15432"],"tls":{"connection_policies":[{"client_authentication":{"mode":"require_and_verify","trusted_ca_certs":["<install CA PEM>"]}}]},"routes":[{"handle":[{"handler":"proxy","upstreams":[{"dial":["127.0.0.1:15432"]}]}]}]}}}}}}
```

**mTLS and authorisation.** One per-install CA issues each node a leaf at join (CN = node id, URI
SAN `skiff://node/<id>`, 90 days); the provider requires and verifies it, so the hop is
authenticated even on a bring-your-own network. That is authentication, not authorisation:
`caddy-l4` has one client-CA setting per listener, so any node with a valid certificate would pass.
The allowlist is nftables, one `tcp dport <port> ip saddr <consumer /32>` rule per attachment,
default drop on `wg0`, and cryptokey routing binds that address to the consumer's key.

**Readiness, failover and the container alias.** Activation waits up to 30 s for its endpoints, then
deploys degraded with the reason attached. A failover rewrites `upstream_node_id`: environment,
activation version and process are untouched. Container apps reach the port through `db-<id>`, which
today resolves only because the database container carries `NetworkAlias=db-<id>` on the shared
network (`apps/helper/src/units.ts`); a remote service needs `AddHost=db-<id>:<gateway>` on the
workload Quadlet. `DB_PORT` becomes the local port; no new DNS, because Postgres carries no SNI. If
`caddy-l4` fails spike S1 the agent's Bun TCP forwarder takes the same ports and nftables hand-off;
metrics are `skiff_endpoint_up{consumer,service}`, `skiff_endpoint_rtt_ms` and
`skiff_wireguard_handshake_age_seconds{peer}`, and C1 caps the fleet at 32 nodes.

### 4.4 Ingress → workload path

Unchanged in shape: the ingress Caddy reverse-proxies to `<workload private_address>:8080` — the
port plan 23 sets with `SKIFF_CADDY_LISTEN` — preserving `Host` and `X-Forwarded-*`. The workload
node's Caddy matches the host and forwards to the local workload, a socket for process apps or the
published port for containers. Today's `:443,:80` default binds every interface; C1 narrows any node
without an ingress role to its overlay address. Each ingress carries the full route table and dials
the workload node directly: no extra hop, no shared pool, no sticky routing (§8.6).

**Timeouts and streaming.** `dial_timeout 5s`, `response_header_timeout 60s`, `keepalive 30s`.
WebSockets upgrade through both proxies; SSE needs `flush_interval -1` on both hops, set by the
route renderer for a route the site config marks as streaming. Bodies stream end to end and are
never spooled to disk; the cap is the site's `request_body` limit (100 MB through Cloudflare). Each
hop terminates TCP, so the proxy-to-proxy connection takes the `wg0` MSS automatically and no
clamping rule is needed.

**502 and 503.** A dial failure is a 502 after `dial_timeout`. A node that stops answering is marked
passively unhealthy (health checks every 5 s) and dropped for `fail_duration` (30 s), so later
requests go to another replica. With no healthy upstream the branded 503 is served, and
`handle_errors` maps 502 and 504 on app routes to it; a single-replica app on a lost node shows it
within the passive window, not instantly (§11).

### 4.5 Trust boundaries on the overlay

The overlay makes every node addressable by every other node, so the network stops being a boundary
and authorisation is per port and per source; assets and adversaries are §17.

| Boundary | What crosses | Authentication | Authorisation | Encryption | Audit |
|---|---|---|---|---|---|
| Internet → ingress | HTTP(S) to sites and the platform | session, passkey, or none | `forward_auth`, route table | TLS at the ingress | access log, `site.access` |
| Internet → hub | WireGuard handshake, keepalive | peer public key | `allowedIps` per peer | WireGuard | handshake age metric |
| Ingress → workload | HTTP with the original `Host` | node certificate | only `ingress` `/32`s on `:8080` | WireGuard and TLS | access log on both hops |
| Consumer → provider | database or S3 protocol | node certificate | nftables `/32` per attachment | WireGuard and TLS | `attachment.create`/`delete` |
| Container → listener | database protocol on the gateway | none, host-local | the container already runs there | none on the bridge | none |
| Agent → control plane | desired state, heartbeat, activation | node token and TLS pin | token scoped to one node | TLS | `node.*` audit |
| Control plane → gateway | S3 and studio requests (D82) | TLS, SigV4 or session token | per-request signing | TLS over the overlay | `storage.object.*` |
| Control node → object store | lease CAS, Litestream, backups | S3 credentials | bucket policy | TLS | S3 access logs |
| Operator → dashboard | session, passkey, MCP token | Better Auth | RBAC; fleet actions session-only | TLS | `audit_log` |

**Node CA.** Created at install (ECDSA P-256, ten years), its private key sealed with the master key
in SQLite; only the control plane unseals it, so a control plane that is down issues no certificates
and existing ones keep working. A node generates its own key pair and sends a CSR at join; the
control plane signs a 90-day leaf, renewed by a node-token-authenticated CSR at 60 days. Rotation
publishes a second CA as `nextCaPem` and trusts the old one until its last leaf expires. A
compromised CA can mint a certificate but still cannot reach a service, because the source `/32` and
the peer public key are separate facts.

**Containment.** A compromised worker reads its own secrets and reaches only the services it holds
an attachment to, plus the control plane with its own token; it cannot reach `:8080`, where only
ingress `/32`s are allowed. A compromised provider sees the plaintext of its own services and can
impersonate them to their consumers, not another provider's traffic. A compromised ingress sees
every site it proxies in plaintext, holds the site-cookie key and is in the app-port allowlist: the
largest data-plane exposure. A compromised control node holds the master key, the CA key and the
lease and is equivalent to compromising the install; network rules do not contain it, detection and
rotation do (§17). A compromised object store can forge the lease and choose the primary.

**No inbound public port.** Every node dials out: UDP 51820 to a hub, kept alive with
`PersistentKeepalive=25`; HTTPS to the control plane; TCP to provider overlay ports. Inbound
listeners exist only on loopback, on `wg0` and — on an ingress node — on 80/443, which is the job; a
hub also accepts UDP 51820. The control plane never dials a public node interface: a port scan of a
worker's address finds nothing.

---

## 5. Storage and shared drives

### 5.1 Layers of redundancy

Four layers, four failures, four recovery costs. A resource's HA level (§8.1) is its weakest layer.

| Layer | Protects against | Mechanism | RPO | RTO | Status |
|---|---|---|---|---|---|
| Disk | A failed drive | mdadm or a ZFS mirror/RAIDZ under a node volume (VOLUMES §4) | 0, writes are mirrored synchronously | 0, it serves degraded until the drive is replaced | Adopt exists; mdadm/ZFS provisioning planned (VOLUMES P2/P3) |
| Service | A failed node | Postgres replicas (C7), bucket replication (C9), Litestream (C9 for app SQLite) | Replicas: the lag, ≈ 0 with `sync`; app SQLite: ≈ 1 s; buckets: the sync interval | Manual promote: minutes; control plane `auto`: TTL + replay ≈ 45 s (§6.3) | `skiff-litestream.service` exists for the control plane's SQLite; the app paths are planned |
| Zone | A failed site | The same replicas in another zone (`spread: zone`, §3.4) | As the service row, plus WAN exposure | As the service row; `L3` ingress moves in 5–10 s (§8.1) | Plan (C7–C9) |
| Backup | Deletion, corruption, ransomware | Verified logical dumps (D83), PITR where enabled, app-volume snapshots (C9) | 24 h at the default daily policy; ≤ 1 min with PITR | Hours, dominated by download and replay | Dumps exist; PITR is flag-gated and unproven ([PITR.md](./PITR.md)); snapshots are metadata only |

**Replication is not a backup**: a replica copies a `DROP TABLE` as faithfully as an insert, so
every `L2`/`L3` data resource still needs `L1` backups. **A mechanism with no tested restore is `L1`
at best**: "Litestream is running" is not an RPO claim until `skiff-restore` has run against that
replica, and ROADMAP still has the Litestream → R2 round trip unticked. **Data outside Skiff's
backup path has no backup level**: a share, or a volume never restored, is `L0` however many copies
run. No RTO here is measured; C9 records one per drill.

### 5.2 Cluster shares (H7)

A **share** is a platform-level network filesystem defined once and mounted on whichever nodes need
it. None of it exists: no `shares` table, no mount verb, no `backing: share`; a network mount is
only an adopted `remote` node volume today (VOLUMES §4). This is C3.

```ts
interface Share {
  id: string; name: string;                      // name: 3–40 chars, unique per install
  protocol: 'nfs' | 'smb'; server: string; export: string;   // nfs: host + /export
  options: AllowlistedOptions;                   // D77 rules, never a free-form string
  credentialsRef: string | null;                 // opaque id, never the value
  zone: string;                                  // derived from the server node
  grants: { orgId: string; mode: 'ro' | 'rw' }[];
}
```

**Validation** names the failing rule: an absolute NFS export path with no `..`, an SMB share name
with no `/` or `$`; an overlay or private `server`, with a public one needing an acknowledgement;
and an allowlisted `options` set decoded into fields (NFS `vers=4.2`, `ro`, `soft` on read-only
grants only; SMB `vers=3.1.1`, `ro`) with `nosuid,nodev,noexec,noatime,_netdev,nofail` fixed. A
grant must name an existing org and stay inside the share's root.

**Credentials** are write-only: sealed with the org key and written as a `0400` root file at
`/run/skiff/shares/<id>.cred` at mount time. The workload never sees them, and the value never
enters desired state, the disk cache, logs, MCP or audit arguments (D18, D43, D77).

**Mount lifecycle.** The helper owns the mount; the agent reports `mountStatus` and the last error.

| State | Entered when | Leaves to |
|---|---|---|
| `unmounted` | No attachment on this node, or a clean unmount | `mounting` |
| `mounting` | Helper starts `shares.mount` with a validated spec and the credential file written | `mounted` or `failed` |
| `mounted` | `findmnt` shows the mount, the source key matches, the identity probe passes | `degraded`, `unmounting` |
| `degraded` | The probe fails (`timeout`, `ESTALE`, `EACCES`, `ENOSPC`) but the mount entry exists | `mounted` on recovery, `unmounting`, `failed` |
| `unmounting` | No attachment remains, or an operator forces it | `unmounted` or `failed` |
| `failed` | The mount command failed, or the unmount timed out | `mounting` on retry, `unmounted` after a forced unmount |

Mount only while an attached workload runs there; unmount ten minutes after the last attachment, and
refuse the unmount while a read-write attachment runs. Attempts back off at 5 s, 15 s and 45 s. A
workload whose share is not `mounted` fails to start rather than writing into an empty mountpoint
(D76). **Probe by transport, not by filesystem call**: a `stat` on a hard-mounted NFS share blocks
uninterruptibly when the server is gone, so the helper opens TCP 2049/445 with a 3 s timeout every
30 s, then `stat`s as the workload's uid, and for read-write attachments creates and deletes
`.skiff-write-canary` every 15 minutes. A passing stat with a failing canary is a permission fault.

**Mount options** are fixed, never user input. NFS: `vers=4.2,hard,proto=tcp,rsize=1048576,
wsize=1048576,actimeo=30,noatime,nosuid,nodev,noexec,_netdev,nofail,x-systemd.automount,
x-systemd.device-timeout=30s`. SMB: `vers=3.1.1,credentials=/run/skiff/shares/<id>.cred,uid=<uid>,
gid=<gid>,forceuid,forcegid,file_mode=0660,dir_mode=0770,mfsymlinks`; `soft` only on read-only
media.

**Identity and mapping** is per attachment. Containers use the image's uid/gid; process workloads
get a stable `shareUid`/`shareGid` instead of `DynamicUser=yes`, which changes uid on every restart
and would break CIFS `uid=` (new work in C3), so SMB mounts are per (node, share, uid) with
`forceuid,forcegid`. NFS maps numeric uid only: a Skiff-served export squashes to one `shareUid` and
chowns the subdirectory on the server, while an external export must already accept the workload's
uid. The mount root is never chowned (D78).

**Subpath and read-only default.** A subpath defaults to `skiff/apps/<project>/<volume>` (VOLUMES
§14) or an explicit media path; it is absolute, normalised, free of `..` and inside the org's
prefix. Attachments start `readOnly: true`; turning it off confirms multi-writer semantics, the zone
joining the blast radius, no Skiff backup and no `L2` in one dialog.

**Multi-writer semantics.** A share is ReadWriteMany; Skiff arbitrates nothing and holds no lease,
so two copies writing one file is the operator's problem and the attach form says so. Locks (NFSv4
byte range, SMB leases) are advisory, server-held and lost when it restarts or the lease expires
(typically 90 s), so exclusivity comes from `O_CREAT|O_EXCL` or a managed database. `rename()`
within one export is atomic; across exports it fails with `EXDEV` and the caller copies then
deletes. Skiff-served exports use `sync`, because `async` would acknowledge before the array holds
the data, and attribute caching hides another node's changes for up to `actimeo` (30 s here, 600 s
for read-only media).

**Quotas, backup and blast radius.** `sizeMb` is a recorded budget, not an enforced limit, unless
the server is a managed ZFS or btrfs volume where C9 applies a dataset quota. Skiff does not back up
share contents, so share-backed data is `L0` while compute is `L3`. A workload on a share also
inherits the share's zone ("down if `home` is down", even with cloud replicas), and placement keeps
read-write copies there. That caps a share-backed app at `L2`: a share's zone is always its server
node's, so the app can never meet §8.1's `L3` requirement of "no share confined to one zone".

**Surfaces and audit.** A **Shares** page (create wizard with probe-before-save, mount status,
grants, rotation) and a `backing: share` option on the project Volumes attach form. Audited:
`share.create`, `share.update`, `share.delete`, `share.grant`, `share.attach`, `share.detach`,
`share.mount`, `share.unmount`, `share.mount.fail`, `share.credential.rotate`. Share CRUD is
platform-admin only; attaching needs `project:update`; MCP gets `list_shares` only.

### 5.3 Skiff-served shares (H8, later)

A `data` node with a `bulk` volume can export a directory over **NFSv4.2 on the overlay only**, so
the homelab array becomes the shared drive for every node, the VPSes included, with the WAN latency
caveat shown. It is C9 and unbuilt: nothing exports NFS, and nothing installs `nfs-kernel-server`.

- **Export and firewall.** A new helper verb `shares.export` writes
  `/etc/exports.d/skiff-<shareId>.exports` and runs `exportfs -ra` for `<bulk
  volume>/skiff/shares/<shareId>`, owned by the share's `shareUid`/`shareGid`, with
  `rw,sync,no_subtree_check,root_squash,all_squash,anonuid=<uid>, anongid=<gid>,fsid=<id>` and a
  client list of the overlay `/32`s holding an attachment (or `ro` for a read-only grant). NFSv4
  needs only TCP 2049, so there is no rpcbind or portmapper; the nftables verb accepts 2049 on the
  overlay interface from the same `/32` set and drops it elsewhere, and both lists render from one
  desired-state object, so drift is an alert.
- **Client mount shape.** The §5.2 unit with `10.88.0.5:/skiff/shares/<shareId>` as the source;
  `hard` by default, and a read-write mount over a home uplink warns.
- **Performance.** Every write is a synchronous round trip, so commit latency is the WAN RTT plus
  the array's write latency: 10–30 ms over the home uplink, worse on a parity array, with metadata
  the worst case. Throughput is bounded by the uplink, not the disk. Fine for media and backups; not
  for SQLite, a database directory, a build cache or a git checkout.
- **Failure behaviour.** A hard mount whose server disappears blocks the caller in `D` state, which
  ignores `SIGTERM` and `SIGKILL` until the call returns, so `systemctl stop` hits `TimeoutStopSec`
  and leaves the unit failed; the cures are restoring connectivity or `umount -f -l` then a restart.
  `nofail` and `x-systemd.automount` keep boot unaffected, and the dashboard shows the mount
  `degraded`, the share `down` and its dependants degraded with the reason.

### 5.4 State in apps

State belongs in a managed database or a bucket, and apps should stay stateless and `L3`; for the
apps that cannot, two mechanisms are planned, both recover-and-promote rather than warm standby.

**Litestream.** The plan gives an app volume `replicate: sqlite` with a database path: Skiff runs
one Litestream process beside the workload streaming the file to the object store with
`sync-interval: 1s`, `snapshot-interval: 24h`, 168 h retention and the prefix
`skiff/sqlite/apps/<volumeId>`. The control plane does the same for its own SQLite
(`skiff-litestream.service`, `scripts/litestream.yml`, a 24 h snapshot, 720 h retention under
`skiff/sqlite/`, restored by `skiff-restore`); the app path reuses it.

- **Credentials** are sealed, delivered through the activation endpoint and written to a `0400` file
  beside the config; they never enter desired state or the workload's environment.
- **Restore** follows `skiff-restore`: restore into a scratch file next to the target, run `PRAGMA
  integrity_check`, checkpoint the WAL into the file, then move it into place on the same filesystem
  so the last step is atomic. The helper does the same with the workload stopped and only then
  records `restoreVerifiedAt`; a failed restore leaves the old copy untouched.
- **Multiple databases and limits.** One config may carry several `dbs:` entries (`app.db`,
  `cache.db`), each with its own prefix and status; one failing entry alerts for that file only. The
  RPO is about one second of committed transactions while the process lives, and a crashed unit
  restarts in 5 s. WAL mode only, the app must be the only writer, and it cannot run against a share
  because SQLite needs POSIX locking and atomic rename. **This is `L1`, not `L2`:** a restore is a
  recovery, not a failover.

**Snapshot shipping.** For an app volume holding files rather than one database, Skiff ships
incremental snapshots to a standby node's volume, kept at rest under
`<mount>/skiff-shadow/<volumeId>` and never mounted by a workload.

| Mechanism | When | Increment | RPO |
|---|---|---|---|
| `zfs send -i` | The volume is a ZFS dataset | Incremental between snapshots | The interval |
| `btrfs send -p` | btrfs, after a read-only snapshot | Incremental against the parent | The interval |
| `rsync -a --delete` | ext4/xfs, or no snapshot support | Full scan | The interval, crash-consistent at best |

1. **Schedule.** The durable scheduler queues an `app_volume_snapshots` row (the table exists) every
   15 minutes for `zfs send`/`btrfs send` and every 60 minutes for `rsync`, streams it through the
   overlay, and records size and checksum only after the receive verifies. There is no quiesce by
   default; an app that needs one opts into a pre-snapshot command.
2. **Retention.** 48 increments and 7 daily copies per volume, pruned only after the next transfer
   verifies; the newest good and any pinned copy are never deleted, the rule D83 already uses.
3. **Failover** is manual in C9: the source node is fenced or declared offline; the control plane
   writes `writerNodeId = <target>`; the helper mounts the shadow copy read-write and starts the
   workload. Desired state carries that id, so the helper enforces the single writer: it refuses a
   read-write mount on any other node, the second check behind the control plane's attachment rule.
   There is no automatic failback: the old copy is discarded and re-seeded, because merging two
   diverged directories is not solvable.
4. **Level.** The RPO is the interval, so this is `L2` for node loss with a manual promotion only; a
   zone loss takes both copies when the standby is in the same zone. The shadow copy is inert until
   promotion, so it is not a continuous replica. VOLUMES §14 pins an app volume to one node today;
   this protocol relaxes the pin, and it ships with the mechanism rather than before it.

**Recommendation.** A single SQLite file gets Litestream (`L1`); a file-heavy single-writer volume
gets snapshot shipping (`L2` for node loss, RPO = interval); media and drop folders get a share
(`L0` for data). Nothing here runs a database.

### 5.5 Share semantics and failure modes

This table is the contract the operator reads before attaching a share and the runbooks implement.

| Failure | What the workload sees | What Skiff does | What the operator does |
|---|---|---|---|
| Share server down | Reads and writes hang in `D` state on a hard mount, `EIO` on a `soft` read-only one. Health checks fail, ingress returns 502, the app logs stop. | The 2049/445 probe fails twice and marks the mount `degraded` and the share `down`; the alert names the server and the affected workloads. Skiff does not unmount, restart or re-place anything, because none of those clears a stuck call. | Check the server's power, uplink and array. If it is coming back, wait; if not, stop the workloads, force-unmount, then re-point the share at a new server or restore from the server's own backup. |
| Stale NFS handle (`ESTALE`) | `ESTALE` on open, read or write of a file whose inode the server no longer has. New files in the directory may work, which makes it look random. | The TCP probe passes and the stat probe returns `ESTALE`, so the mount is `degraded` with `stale_handle`, distinct from `unreachable`. Skiff does not auto-remount: a remount does not fix a handle an open process holds. | Restart the workload first, which drops cached dentries. If it recurs the export was re-created or `fsid` changed: run the share's `remount` action and re-point the export. |
| Partition while mounted | Writes block; a read-only workload serves from cache until the attribute timeout. A partition that also cuts the node from the control plane stops the heartbeat, and the two look identical on the dashboard. | The mount goes `degraded` only if the node can still reach the server; a node isolated from everything reports nothing and is offline after 30 s. Skiff never promotes or moves a workload because of a share, and the share's zone stays in the blast radius. | Decide which side moved. If the node is isolated but healthy, restore its path; if the server is, treat it as "share server down". A hard mount may need `umount -f -l` before the workload can stop, and its `D`-state processes clear only after the mount is gone. |
| Permission change | `EACCES` on open, or on write for a read-write attachment. Reads may be fine while writes fail, or the reverse. | The canary probe, run as the workload's uid, fails while the stat probe passes, so the mount is `degraded` with `permission_denied` rather than `unreachable`, and the share page shows the last successful canary. | Fix ownership or mode on the server, or re-issue the grant. If the export now squashes to a different identity, change `shareUid`/`shareGid` and remount; never chmod the share root from the client. |
| Full server (`ENOSPC`) | Writes fail with `ENOSPC`, partial files are left behind, and some apps corrupt their own state on a short write. | For a Skiff-served export the server node's volume metrics (D80) drive a `ha.share_full` alert at 15 % and again at 5 % free, before the workload fails. For an external share Skiff cannot see free space, so the workload's error rate is the first signal. | Free space on the server, grow the array or move the data, after finding the runaway writer: a full share is usually an app writing logs or a backup into it. |
| Client reboot | Boot does not block (`nofail`, automount). On first access the mount either returns or its unit fails, and a workload that needs it fails to start with "share not mounted". | Mount units are re-created from the registry at boot, the helper verifies each one before a dependent workload starts, and the heartbeat reports failures. A reboot during a write loses what was not committed to the server; Skiff claims nothing about unflushed data. | Nothing, if the server was reachable. If the mount failed, check the credential file and the server's export list; the next pull retries, and the workload stays down rather than writing to an empty mountpoint. |

**Skiff never starts a workload against a share it believes is unmounted**, and **never restarts,
moves or promotes a workload because of a storage failure**: both would turn a storage incident into
a data-loss incident. §11 carries these rows under its node and zone cases; C3's exit criterion is
the first row.

---

## 6. Control plane HA

Today one host runs the control plane: `skiff-control-plane.service`, SQLite at
`/var/lib/skiff/data/skiff.db`, Litestream to the object store (OPS §6). The self-updater also starts a
second copy of the same release on the same host with `SKIFF_STANDBY=1`, sharing the database file and
living for a minute; that is not an HA standby and does not survive a reboot. This section adds a remote
warm standby with its own data directory, an object-store lease that decides which node is primary, and
an epoch that fences everything else.

### 6.1 Shape (H9)

A multi-node install has one `primary` and at least one warm `standby`, each on a `control` node in a
different zone (§3.5). A single-node install has neither, stays at `L1` and runs none of this (§13.8).

| State | What it is | Serves | Maintenance |
|---|---|---|---|
| `primary` | Holds the lease at epoch E | Everything | Runs |
| `standby` | Follows the replica; replay current | Read-only status page, `/readyz`, `/metrics`, `/api/v1/ha/status` | Never |
| `standby-behind` | Replay older than 5 s, or replica missing | As `standby`; `canPromote: false` | Never |
| `promoting` | Won the CAS at E+1, finishing replay, loading config | `/readyz` only | Starts on completion |
| `fenced` | Held the lease and lost it, or cannot confirm it for 20 s | Dashboard reads only; 503 for every write | Stops |
| `joining` | `control` role set, no replica restored yet | `/readyz` returns 503 | Never |

A standby serves humans, not agents: every `/api/agent/*` request to a standby or a fenced node returns
503 with `x-skiff-role` and `x-skiff-epoch`, so agents keep cached state (D23). A node that cannot write
must not renew a run lease or hand out desired state, or a singleton survives on the authority of a node
that has already lost the right to decide. `SKIFF_CONTROL_ROLE=standby` (new, C6) marks an HA standby;
`SKIFF_STANDBY=1` keeps its meaning for the updater's slot and the canary; a promoted standby clears
both and starts the maintenance loop.

**Health and cost.** `GET /readyz` (OPS §4.2.3) gains `role`, `epoch`, `lease.holder`,
`lease.expiresAt`, `replication.position`, `replication.lagSeconds` and `canPromote`. It is load-bearing
three times: the updater keeps a release only on a 200, the canary boots it, and the ingress platform
route health-checks it (§6.4). A standby answering 200 with `canPromote: false` is honest.
`GET /api/v1/ha/status` is new: per-node role, epoch, lease token, lag. Updates go standby first, one
node at a time, with a promotion between steps when a release ships migrations (§6.5). Memory is one
more copy of the same release: `MemoryMax=1G` per unit (OPS §10), 150 MB steady and budgeted at
350 MiB reserved (§3.8), which is why §3.6 sizes `edge-b` at 4 GB.

### 6.2 What is replicated

| State | Mechanism | RPO | Failure mode | Verification |
|---|---|---|---|---|
| SQLite | Litestream from the lease holder to the object store (exists, ~1 s WAL sync); the standby restores the replica, then follows it (S2) | ≤ 1 s | Two writers to one replica path interleave generations; a standby past the 720 h retention cannot catch up | `PRAGMA integrity_check`; fingerprint compare (`scripts/skiff-db-fingerprint.ts`); replay position in `/api/v1/ha/status` |
| Master key | Recovery kit at enrolment; the standby keeps its own copy at `/etc/skiff/master.key` (0400 root) behind `LoadCredential` | Until the next rotation | A rotation not re-delivered leaves the standby unable to decrypt | `skiff-recovery-kit verify` (fingerprints equal); read one secret |
| Platform config | Allowlisted `skiff.env` keys through the activation endpoint, values sealed (the OPS §4.3 shape; distribution is new) | Last saved value | Divergent R2, SMTP or alert settings on a promoted standby | Config digest in `/api/v1/ha/status`; `sha256` of the allowlisted keys |
| Releases | Standby updates first (§6.5) | n/a | Older release, newer schema: pending migrations block promotion | `/readyz` `version` and `schema`; `skiff-update-self status` |
| ClickHouse | Not replicated; optional and off by default (D101); one store per control node that installed it. The agent buffer is in memory, 5,000 minute-buckets, oldest dropped, lost on restart | Not applicable | A promoted standby with a fresh store has no hot history | `curl -s 127.0.0.1:18123/ping`; "not installed" is valid |

Telemetry has no RPO: a promotion starts a visible gap. The plan adds an endpoint list (§4.2), an on-disk
spool and a gap band on the dashboard rather than pretending the history survives.

### 6.3 Lease, epoch and fencing (H10)

The lease is one object, `skiff/ha/control-lease.json`:

```json
{ "epoch": 7, "holderNodeId": "nod_01JB8Q3K9X", "holderVersion": "1.4.0",
  "expiresAt": "2026-11-06T20:41:12Z" }
```

Every write is a conditional PUT:

```
PUT /skiff/ha/control-lease.json
Content-Type: application/json
If-Match: "b7f1c0a2e4d9..."       # renew or take over: the ETag just read
If-None-Match: *                   # create only; 412 when the object already exists
200 OK + ETag | 409 ConditionalRequestConflict | 412 Precondition Failed | 501 Not Implemented
```

A 409 or a 412 means the CAS was lost: re-read, never retry blindly. S3 and R2 return
`409 ConditionalRequestConflict` when two conditional writes race on one key, which is the exact case
this design exists to survive. A 501 or a vanished ETag means the store has no conditional PUT, so HA
is unavailable and the surfaces fail closed.

**CAS protocol.** Read the object and its ETag. On 404, create with `If-None-Match: *` at epoch 1. As
holder, renew with `If-Match`, same epoch, `expiresAt = serverDate + 30 s`. As a standby, take over only
when the object has been unchanged for 40 s and replay is current, with `If-Match` and `epoch + 1`.
Otherwise never write: follow and remember the ETag.

**Clocks.** The only trusted clock is the object store's `Date` header. `expiresAt` is
`serverDate + 30 s`; elapsed time is the local monotonic clock between two store responses. The tolerated
offset between node and store is 5 s; beyond it the node raises `ha.control_clock_skew`. Promotion needs the
ETag unchanged for **40 s** — TTL plus twice the skew — because an observer cannot see renewals after its
read, and a slow holder must not lose to a fast standby. TTL 30 s renewed every 5 s gives six attempts.

| Case | Detected by | Behaviour | Recovery |
|---|---|---|---|
| Object store unreachable | PUT 5xx or network error | Renewals continue; after 20 s without a success the primary fences: no writes, no agent routes, maintenance stops | Fix credentials or endpoint; it resumes only after a successful renewal naming self, else demotes |
| Lease contested | 409 or 412 on `If-Match` | If the body names self at a higher epoch, demote at once; otherwise re-read and follow | Compare `/api/v1/ha/status` on both nodes |
| Partition, store reachable from one or both sides | One node sees 5xx, the other 200; or both renew | The CAS decides; the loser fences within 20 s and never writes again in that term | Restore the path; re-enrol the isolated side |
| Stale primary returns | Lease shows another holder or a higher epoch | Fences immediately; does not serve; does not resume automatically | §6.6 |
| Standby behind | Replay lag > 5 s, or replica missing | `canPromote: false`; `auto` does not promote; alert | Fix replication; if past retention, restore from backup |

**Fencing, and who it reaches.** Desired state carries `epoch` at the top level; the heartbeat response
carries `{ epoch, role, leaseExpiresAt }`; the agent persists the highest epoch seen in
`$SKIFF_DATA_DIR/epoch.json` by atomic rename before applying state, and refuses a lower one. That
protects agents, not the dashboard. So a fenced primary refuses every non-GET with 503,
`x-skiff-fenced: 1` and `Retry-After`, and refuses the agent-facing writes the same way — heartbeat,
desired-state pull, activation fetch, telemetry ingest, run-lease renewal. Reads stay available so
an operator can see what happened. The run lease carries the control epoch; database fencing uses
`primary_generation` (§9.3).

A primary stops acknowledging writes at 20 s and a standby cannot take the lease before 40 s, so no
instant exists when both accept writes. The price is up to ~40 s of control-plane write unavailability;
auto promotion adds replay and startup, which is where ≈ 45 s comes from. Fencing on a lost store is new
behaviour: today an R2 outage breaks new deploys while the dashboard stays writable (DESIGN §9; OPS §9).

### 6.4 Reaching the active control plane

The platform hostname resolves to the ingress nodes, and each ingress Caddy proxies it to the primary.
Today that route is per-node agent configuration, not desired state: `SKIFF_PLATFORM_HOST` and
`SKIFF_PLATFORM_UPSTREAM` are written into `agent.env` by the node bootstrap
(`scripts/install/bootstrap-node.ts`), and the installer points the edge at
`unix//run/skiff/control.sock`. A failover therefore cannot move the upstream by changing desired state.
The plan moves it into desired state as `ingress.platformUpstreams`, a list of
`{ node, address, priority }` rendered on every ingress node. The route health-checks `/readyz` every 5 s
with `lb_policy first`, so the primary is preferred while it answers 200, a fenced or dead primary is
skipped within one interval, and the standby's **Promote** page stays reachable through the hostname.

| Concern | Behaviour |
|---|---|
| TLS and sessions | Every ingress holds the same wildcard certificate and key (§7.3); the origin does not change, so no re-trust prompt. The dashboard cookie is host-scoped, so sessions survive only if `BETTER_AUTH_SECRET` is identical on both nodes |
| Passkeys | WebAuthn binds a credential to the origin. HA needs a dashboard domain over HTTPS; an install at `http://<server-ip>` (D105) is non-HA, because a failover changes the origin and invalidates every passkey |
| SSE, uploads | Log and operation streams use `text/event-stream` with `flush_interval -1`; a failover cuts them and clients resume from `Last-Event-ID`. `BODY_SIZE_LIMIT=520M` in the unit, but Cloudflare caps a proxied body at 100 MB (§7.2); an in-flight upload is retried to the same presigned URL |
| IPv6, one node | AAAA records point at the same ingress set; with a single ingress that is also the only control node the route keeps its unix socket, no lease exists, desired state carries epoch 0 and the HA paths stay off (§13.8) |

### 6.5 Bootstrap, upgrades and recovery

1. **Gate.** The node is online and has run for 24 h; the overlay works both ways (§4.1); the clock is
   synced (`timedatectl`, offset < 1 s); at least 4 GB RAM; a restore drill passed within 30 days
   (OPS §8); the second ingress record is live and holds the certificate; every agent declares `ha-epoch`
   and none is below the minimum version, or the role is refused with the failing check named.
2. **Enrol and verify.** `skif node roles edge-b --add control`, then
   `skif ha standby enrol --node edge-b` (it refuses on lag, backup age or clock skew). The node receives
   the master key and platform config through the activation endpoint (0400 root), `SKIFF_CONTROL_ROLE`
   goes into `agent.env`, and the unit restores the replica into its own `/var/lib/skiff/data`
   (`litestream restore`, then follow), applies no migrations and reports `standby`. Check
   `curl -fsS https://control.example.com/readyz | jq '.role, .epoch, .replication'`: `standby`, the
   primary's epoch, `lagSeconds < 1`, `canPromote: true`. Run `scripts/skiff-db-fingerprint.ts` on both
   hosts and compare the JSON byte-for-byte, the check the restore drill already uses.
3. **Promote and demote.**

   ```sh
   skif ha status                            # epoch, holder, per-node epoch, lag
   skif ha promote --expect-epoch 7          # 409 if the lease is not at 7, or canPromote is false
   skif ha status --wait                     # every node reports epoch 8 within one heartbeat
   ```

   Promotion forwards the read ETag as `If-Match`, so a stale ETag returns `412` and a mismatched
   `expectEpoch` returns `409`, instead of bumping twice. A fenced node may not demote itself. On the
   old primary: stop `skiff-control-plane` and `skiff-litestream`, keep the data directory as
   evidence, restore the replica at the new epoch, verify and re-enrol as a standby. Its SQLite is
   replaced, never merged.
4. **Upgrade order.** Standby first, always: update it (`sudo skiff-update-self check`, then update); if
   the release ships migrations, `canPromote` stays false until the schema moves. A code-only release
   then promotes the standby and updates the old primary, which rejoins as standby. A release with
   migrations takes the sealed snapshot, stops the primary, promotes the standby so it applies them as
   the only writer, then updates the old primary; a standby never migrates while following. Rollback:
   agents refuse a lower epoch, so a downgrade across an epoch boundary is not a supported rollback;
   switch to the other node on the previous release before any promotion.
5. **Rebuild a lost standby.** Join a replacement (C1), add the control role, run
   `skif ha standby enrol --repair`. It restores the replica's newest generation — not incrementally,
   because the old local state is gone — verifies the fingerprint and follows. Past Litestream's 720 h
   retention, restore the newest logical backup and accept that RPO; the node stays `standby-behind`.
6. **Both control nodes lost.** The lease object and the replica are in the object store, which is why
   they live there. Provision one host at the same version, import the recovery kit and run
   `skiff-restore --yes --recovery-kit` (OPS §5.3), then `skif ha claim --from-store --expect-epoch 7`:
   it reads the object, CASes to 8 and stops on 412. If the object is missing it creates one with
   `If-None-Match: *` at `lastEpoch + 1`, the highest value in the restored `control_nodes` table. If a
   heartbeat then reports a higher epoch, it takes one more CAS at `reportedEpoch + 1` before answering
   desired state, so a restore from an older backup cannot talk to agents that saw a newer term.
7. **Object-store or DNS loss.** Store gone: no promotion, the primary fences at 20 s, every site keeps
   serving, and the only recovery is to fix the credentials or endpoint, or restore to a second target
   and claim a new epoch, accepting the lost interval. DNS loss (Cloudflare API unavailable): deploys and
   certificate renewal fail, but the platform hostname still resolves and the control plane is
   unaffected. Do not change the hostname during an incident; reach the ingress over SSH.

### 6.6 Split-brain, partitions and fencing recovery

| Scenario | Lease outcome | Who serves | Divergence | Operator action |
|---|---|---|---|---|
| Symmetric partition, store reachable | CAS picks one holder | Winner only; loser fences at 20 s | None | None; verify epochs |
| Standby cut off from the primary | Standby may take the lease at 40 s | New primary; old one fences | None | Demote and re-enrol the old primary |
| Store unreachable from both | Nobody can renew | Nobody writes; reads and sites continue | None | Fix the store or accept downtime |
| Store reachable from one side | Connected side keeps the lease | Connected side | None | Restore the path; re-enrol the other |
| Stale primary returns | It sees a higher epoch | New primary; returning node stays fenced | None if it wrote nothing; its SQLite is discarded | Brain-heal below |

**Detection.** Two nodes reporting `role: primary` with different `holderNodeId`; a non-zero
`skiff_control_lease_conflicts_total`; mixed `skiff_agent_epoch` values; two `ha.promote` audit rows at
one epoch.

**Runbook.** This is the §18 detail. Do not restart either control plane: writes on the fenced side are
already failing, which is the design working.

1. Read both nodes (`curl --unix-socket /run/skiff/control.sock http://localhost/api/v1/ha/status`) and the
   lease object; record epoch, ETag, holder and timestamps.
2. Pick the winner: the node whose epoch and `holderNodeId` match the object; failing that, the highest
   epoch with the newest `last_lease_seen`, never uptime.
3. Freeze the loser: `sudo systemctl stop skiff-control-plane skiff-litestream`, then mask both units.
4. Confirm no double-writes: search the loser's `audit_log` for rows after the winner's epoch start and
   compare fingerprints. Empty is the expected answer, because the loser refused writes.
5. Replace, never merge: move the loser's data directory aside, restore the replica at the winner's
   epoch, `PRAGMA integrity_check`, compare fingerprints, re-enrol it as a standby.
6. Verify agents: every node reports the winner's epoch within one heartbeat, and every singleton runs
   only where the winner placed it. Record epochs, ETags, audit rows and the first and last 503.

**Why the data cannot diverge.** Five things hold, each with an owner. One SQLite writer per epoch,
enforced by the lease CAS. A strictly monotonic epoch, enforced by CAS increments and the agents'
refusal of a lower value. Only the lease holder replicates SQLite, enforced by the unit supervisor. A
fenced node performs no writes at all, enforced at the route layer. A loser's database is discarded, not
merged, enforced by the runbook and audited. Safety rests on one strongly consistent object: a store
that acknowledges two conflicting `If-Match` writes, or two endpoints with divergent views, removes the
foundation, which is why S3 gates C6 and why the behaviour fails closed.

**Manual interventions.** Three, all root, all audited, none over MCP: `skif ha promote --force` from a
host when the API is unavailable, with typed confirmation naming the epoch and the candidate;
`skif ha fence <node>`, which stops serving and revokes the token; and no manual epoch edit, because
the only supported raise is a CAS.

**Metrics and alerts.** `skiff_control_lease_epoch`, `skiff_control_lease_age_seconds`,
`skiff_control_role`, `skiff_control_standby_lag_seconds`, `_bytes`,
`skiff_control_lease_conflicts_total`, `skiff_control_promotions_total` and `skiff_agent_epoch`,
labelled by node; the catalogue is §12. Alerts follow the OPS §7.2 shape: two primaries or an epoch
mismatch (critical, page, this runbook); renewal failing for 10 s (warning); standby behind 60 s or
`canPromote: false` (warning); an agent two heartbeats behind (warning); any promotion (info).

**Tests.** Each targets one invariant and runs in the multi-container variant of the systemd harness
(§19), twenty repetitions, against a fake S3 endpoint that can return 412, 5xx and delay. Today that
harness is two containers on one host, so C8 must finish it before any `auto` mode ships.

| # | Fault | Assertion |
|---|---|---|
| T1 | `SIGKILL` the primary mid-commit | Standby promotes at ≥ 40 s; nothing committed beyond the replica position is lost |
| T2 | Symmetric partition with `tc netem` | Both fence; no promotion without the store; sites serve throughout |
| T3 | Store 5xx for 90 s | Primary fences at 20 s and does not resume; one primary and one epoch bump after recovery |
| T4 | Clock skew +30 s on the standby | No early promotion; the server clock decides |
| T5 | Stale primary returns | 503 on every write, no agent routes, no automatic resume |
| T6 | Concentrated 409s and 412s from two writers | Exactly one winner, conflicts counted, no epoch regression |
| T7 | Both nodes lose the store for 5 min | No primary during the outage; exactly one afterwards |
| T8 | Restore from a backup with a lower epoch | The primary raises the epoch from reported agent epochs before serving |

---

## 7. Ingress HA

### 7.1 Every ingress node is a full edge (H11)

Today the edge is the only node whose desired state contains every project; a worker gets only what
is placed on it. `setEdge` hands the role over without touching DNS or TLS (D98). The plan makes it
that payload, unreduced, on every node with the `ingress` role:

| Payload | Desired-state field | Today |
|---|---|---|
| Routes: production, previews, environments, custom domains, S3 | `routes[]`, `domains[]`, `storageRoutes[]` | Full set: edge only |
| Static releases and download URLs | `releases[]` | Every release: edge only |
| Share-link and session revocations | `revocations[]` | Every agent |
| Per-project site-cookie key | `routes[].access.siteKey` | Every project's: edge only |
| Platform route `control.<domain>` | `SKIFF_PLATFORM_HOST` / `_UPSTREAM` env | Edge only |
| TLS certificate and key | not in desired state | Edge only |

- **Route table.** Each ingress renders the same config and does one atomic `POST /load`
  (`apps/agent/src/caddy.ts`); `upstream` points at the workload's node (§4.4).
- **Release cache.** Each ingress downloads every release its routes name; GC keeps desired plus
  two older ones. Cost is disk times ingress count, so warm a node before it takes traffic.
- **Site-cookie key.** `routes[].access.siteKey` is an HMAC of the platform secret and project id
  (`packages/core/src/config.ts`) and already travels in every route, so every ingress gets it.
  Every control-plane host must install the same `SKIFF_SITE_COOKIE_SECRET` (§6.2); rotating it
  signs every visitor out.
- **Callback tokens.** Tokens are 60 s and single-use, but the redeemed-id cache is in memory today
  (`apps/agent/src/verify.ts`). The plan adds an `ingress` claim and persists the cache under the
  agent data dir; a login that lands on another ingress fails closed.
- **Revocations and limits.** `revocations[]` already reaches every agent and the agent checks `sid`
  on the cookie and the callback. There is no ingress rate limit today; if one is added it is per
  node, so the fleet limit is the per-node value times the ingress count.
- **Convergence and drift.** `actualStateVersion` and `caddyOk` already ride the heartbeat. An
  ingress behind for 2 minutes, or with `caddyOk` false for 60 s, is `drifted`: removed from DNS
  (§7.2) and re-added after 60 s clean, because stale routes can serve a deleted site.

### 7.2 Traffic steering drivers (H12)

The plan adds `ha.ingressDriver` (§13.2). `direct` describes today; the rest are unbuilt.

| Driver | Requirements | Detection | Failover bound | Cost and limits | Choose when |
|---|---|---|---|---|---|
| `direct` (today) | One ingress | Node offline alert (2 min) | None: a human repoints the record | No daemon; an edge loss is an outage until DNS is edited | One node, or an IP-only install (D105) |
| `dns-failover` | Two or more ingress nodes in distinct zones, a Cloudflare zone and token, origins the fleet can probe | Skiff probes from the primary plus corroborating nodes | 120 s proxied (165 s single-witness), 240 s DNS-only, `auto`; manual adds human time | No daemon; no Cloudflare health checks, so detection and last-record protection are ours | The reference fleet |
| `cloudflare-lb` | Paid Load Balancing; origins reachable from Cloudflare | Cloudflare health monitors | Monitor interval and retries, set to meet the target | Paid add-on; Cloudflare owns the decision and adds config surface | Many ingress nodes, or weak probe vantage points |
| `cloudflare-tunnel` | `cloudflared` per ingress as connectors of one tunnel; no public origin | Cloudflare connector health | Seconds | 30–40 MB per node; Cloudflare terminates TLS; 100 MB body cap; no origin to probe | Behind CGNAT or without a public IP |

**Recommendation for this fleet:** `dns-failover` with proxied records across `edge` + `edge-b`.
Both zones are already orange-cloud, so it adds no daemon; proxied failover works in seconds. The
algorithm:

1. **Observe.** The primary probes every ingress every 10 s:
   `GET https://<address>/.well-known/skiff/health` with the probed node's SNI and Host, 3 s
   timeout, 200 is success. New in C5, it is unauthenticated and targets the origin address, not
   Cloudflare. Nodes with a public path also probe and report in the heartbeat; silence is not
   evidence of failure.
2. **Quorum.** Removal needs the primary's probe failing for the hold-down plus one corroborating
   report from another zone, or the node's replicated status `offline` for over 2 minutes. Without
   corroboration the driver is `single-witness` and doubles the hold-down, because a false removal
   costs capacity. One ingress refuses `dns-failover`.
3. **Hold-down.** 45 s of consecutive failures (90 s single-witness), with a success no more than
   10 s before the first failure. A node already down when a primary starts is judged after one
   hold-down.
4. **Remove or re-add.** Never remove the last healthy record; the intended set is persisted before
   the API call. Re-add after 120 s of successes, at most once per 10 minutes; two cycles in
   30 minutes pin the node down and alert. Promotion comes first, because the probe loop and token
   live with the control plane: `auto` is promotion + replay + hold-down, manual has no bound.

**Caches and the Cloudflare-only path.** A DNS-only removal stays in resolver caches for the
remaining TTL, and stubs and browsers can exceed it; plan TTL plus 2 minutes. Proxied records are
different: the client talks to Cloudflare, so removal affects new origin connections while existing
ones fail and retry. Never empty the set, because negative answers outlive the TTL. If the API is
unreachable, no record changes: sites serve from surviving origins, Cloudflare returns 52x for the
dead one, retries back off 5/15/45 s then every 60 s, and `ha.dns_update_failing` alerts. If origins
are firewalled to Cloudflare ranges or all ingress is tunnelled, the origin probe cannot run: probe
through Cloudflare, or pick a driver that fails over inside it.

**Cloudflare plan limits that matter.** The Free plan has no health checks and no load balancing, so
detection and decision are Skiff's. Proxied request bodies are capped at 100 MB, which already
applies to public S3 routes; the API allows 1,200 requests per 5 minutes, far above a 30 s
reconcile. The token needs `Zone:DNS:Edit` and is held by the control plane and the ACME holder
(§7.3). A proxied name with several A records is not a documented failover API; whether Cloudflare
treats it as an origin pool is an open question for the C5 soak.

### 7.3 Certificates (H13)

Today Caddy on the edge holds every certificate: the content apex, its one-level wildcard, the
platform host and each verified custom domain. Issuance is ACME DNS-01 through the Cloudflare token;
custom domains are issued up front, because Cloudflare will not forward to an origin with no
certificate (D31). The agent probes each certificate every 6 h and alerts at 14 and 3 days
(`packages/core/src/maintenance.ts`). The plan is to issue once and distribute to every wildcard name
and every verified custom domain; custom domains grow with tenants, so per-ingress issuance would
multiply the duplicate risk and the key copies.

- **ACME lease.** `skiff/ha/acme-lease.json` in the platform object store, separate from the control
  lease: `{holderNodeId, expiresAt, generation}`, 600 s TTL renewed every 120 s. Only the holder
  runs the ACME issuer; if it dies another ingress takes the lease. Renewal starts 30 days before
  expiry and retries every 6 h, so a slow issuance does not lose the lease.
- **Custody.** After issuance the holder's agent copies the PEM pair out of Caddy's storage and
  uploads it over the node-authenticated agent API, as database credentials do. The control plane
  seals it with the master key (D18) and bumps `ingressCertificates.generation`; certificates never
  enter desired state, logs or audit arguments.
- **Distribution.** Other ingresses fetch the pair from the node-authenticated activation endpoint on
  start, when the generation changes and every 6 h; the agent writes it 0640 root:caddy and loads it
  from file (`certificates.load_files`; `load_pem` in Caddyfile terms) with no ACME issuer. On
  success every ingress reloads and reports the new fingerprint.
- **Failure handling.** A dead holder costs one lease TTL, not the certificate. A follower that
  cannot fetch keeps its last file and shows a fingerprint mismatch. A control plane down for longer
  than the certificate lifetime cannot be repaired here, and that outage is out of scope.
- **Cloudflare Origin CA.** Free and long-lived (up to 15 years), covering the same names, but
  trusted only by Cloudflare's edge: every name must be proxied with Full (strict), and in exchange
  ACME, the lease, distribution and renewal disappear. For DNS-only records it is unusable; under
  `cloudflare-tunnel` no public certificate is needed at all.
- **One-level wildcard.** `<slug>` and `<slug>--<env>` are single labels, so one wildcard covers
  them (D14, D44); a nested name needs its own certificate and `*.*` cannot be issued, so every new
  hostname shape stays single-label or gets an explicit certificate and record.
- **Key security.** The wildcard key impersonates every site on the content domain and every ingress
  holds it, so an ingress node is as trusted as that certificate. Files are 0640 root:caddy, sealed
  at rest, delivered only over the node-token-authenticated endpoint and never in desired state,
  logs, MCP or audit. Removing the role deletes the files; removing a node reissues the certificate,
  because taking the DNS record away does not take the key back.

### 7.4 DNS and certificate operations

**Preflight, before `dns-failover` is enabled** (C5; until then OPS §3.7 and §9 are the story).

- Two or more `ingress` nodes in distinct zones, converged: current `actualStateVersion`,
  `caddyOk` true, every release present, the same certificate fingerprint everywhere.
- Every probing node reaches every ingress at `/.well-known/skiff/health` over the public path; if
  not, the driver runs `single-witness`.
- Cloudflare zone connected, token with `Zone:DNS:Edit` and `Zone:Zone:Read`, records
  exported, managed names identified, TTL 60 s.
- A real HTTPS platform name (D105); an IP-only install stays `direct`. SSH and a DNS-free route to
  the standby dashboard are written down and tested.

**Migrating from `direct` to `dns-failover`.**

1. Add the second ingress and let it warm; do not add it to DNS yet.
2. Run the driver observe-only for 24 h; it logs the set it would apply. Adopt the existing apex,
   wildcard and platform records, and refuse a managed name whose proxy state differs from the plan.
3. Set TTL 60 s and keep one address (the current edge). In a maintenance window add the second;
   both nodes must already serve every route, or half of production gets a 404.
4. Watch 5xx and probe state for 30 minutes, then enable removals. Rollback: set the driver to
   `direct`; the set collapses to the chosen node within 30 s.

| Operation | Procedure |
|---|---|
| Add | (1) Join it (plan 23, or today's manual flow), assign `ingress`, keep it out of DNS. (2) Wait for the route table and releases; the heartbeat's `releases[]` proves the cache. (3) Compare certificate fingerprints. (4) Probes clean for 5 minutes, then add the address and watch 5xx for 10 minutes. |
| Drain | (1) Remove the address from the records; it keeps serving. (2) Wait `max(60 s TTL, 5 minutes)` for resolver caches and keep-alive connections; the DNS window, not Caddy's shutdown, drains clients. (3) Stop Caddy last. |
| Remove | (1) Drain. (2) Remove the `ingress` role. (3) Reissue the affected certificates: the removed node still holds the key, and this is the step people skip. (4) Revoke the node token and certificate (§17), then delete the node. If it held the ACME lease, confirm the lease moved first. |

**Emergency failover, manual mode, edge unreachable.**

1. Confirm from outside the fleet that the site is down, not just your path to it.
2. Reach the standby directly: SSH to it and use a hosts entry or SSH tunnel to `control.<domain>`,
   because DNS still points at the dead edge. Promote the control plane (§6.3). Do not edit DNS
   first: without the promotion there is no writer, and a manual edit is reconciled away.
3. Confirm the new primary's probes remove the dead node; `dig @1.1.1.1` and `@8.8.8.8` should show
   the survivor. Verify a static site, a share link, the dashboard and one `L3` app. Do not re-add
   the failed node until it is repaired, converged, certified and its epoch checked.

**Monitoring.** The full alert catalogue is §12; these are the ingress-specific signals.

| Signal | Shows | Alert |
|---|---|---|
| `skiff_ingress_probe_success{node,observer}` | Per-observer reachability | Warn when observers disagree for 60 s |
| `skiff_ingress_dns_state{node}` | `present`, `suspect`, `removed`, `damping` | Page on removal; warn when one ingress remains or the driver is `single-witness` |
| `skiff_node_cert_expiry_timestamp_seconds{node,host}` | Certificate expiry (exists) | 14 d warn, 3 d page |

**Common failure modes.**

| Symptom | Cause | Fix |
|---|---|---|
| 525/526 on some requests after adding a node | Certificate missing or different there | Remove from DNS, distribute, compare fingerprints, re-add |
| Half of requests 404 or 503 after adding a node | Record added before routes or releases converged | Remove, wait for `actualStateVersion` and `releases[]`, re-add |
| Sites and dashboard down after the edge fails | Control plane died with the ingress; manual mode needs a promote | Reach the standby directly, promote, then DNS |
| Everyone signed out after a promotion | `SKIFF_SITE_COOKIE_SECRET` differs on the new primary | Restore the same `skiff.env` from the recovery kit |
| Callbacks fail with 403 after a failover | The token was node-bound and redeemed elsewhere | Expected; sign in again |

---

## 8. Workload HA

Every workload — static site, process app, container app or worker — carries an HA level. It is
stored on the resource's row and shown wherever the resource appears, never inferred at runtime.
Today every workload is effectively `L0`; §8.2–§8.6 are the plan, from C4, C5 and C8.

### 8.1 HA levels (H14)

| Level | Meaning | Requires | Costs | Limits | Failover and RPO |
|---|---|---|---|---|---|
| `L0` single | One copy on one node. | Nothing; today's behaviour. | One memory reservation. | Down until the node returns or an operator moves it (D97). | Until repaired. |
| `L1` recoverable | `L0` plus a verified backup and a scripted restore. | A backup target and a passing restore drill: a D83 dump for a database, Litestream for a SQLite app volume. | Backup storage and a scheduled dump; 1–2% CPU while it runs. | Restore is a human action into a new instance. Litestream restores a file; it is not a warm standby. | Minutes to hours; RPO is the backup interval. |
| `L2` failover, replica | A warm standby or replica in another node or zone, manual or opt-in automatic promotion. | A second `data`/`compute` node in another zone, the engine's replication (§9.2), a drilled promotion. | A second memory reservation and a copy of the data; `sync` Postgres pays the zone RTT per commit. | 1–2 replicas, caught up before promotion. No automatic move back (§8.3). No protection from a bad release. | Workload replica 5–10 s after promotion; Postgres 90 s target / 2 min budget after detection; RPO is replication lag, 0 with `sync`. |
| `L2` failover, snapshot | Snapshot shipping to a standby, mounted read-write only on promotion. | The above, plus `zfs send`/`btrfs send` or `rsync`. | A second copy of the volume. | **Not available today**: an app volume pins its project to one node (VOLUMES §14, OPS §4.2); C9 adds mount-on-promotion. | After the mount; RPO is the snapshot interval. |
| `L3` active | Several active copies across zones behind the ingress load balancer. | ≥2 replicas, `ingress: http`, two verified-distinct zones, no `singleton`, no app volume, no share confined to one zone. | n × the memory reservation across the fleet, plus route fan-out on every ingress node (§7.1). | Traffic failover only: a bad release or a `DROP TABLE` reaches every copy. Capacity restoration needs headroom. Two real zones, not two nodes in one house. | Traffic 5–10 s; capacity ≥ grace + placement + start, 2–3 min; stateless. |

`L3` for a **worker** means active capacity, not traffic failover: copies have no route (D89), each
consumes the queue independently, and delivery is at least once. Stateful engines are not in this
table: a MongoDB replica set is `native-cluster` (§9.4), and a Postgres primary with replicas is `L2`.

The level is set with `ha_level`. `L2`/`L3` on a stateful resource is refused without a verified `L1`
backup, naming the missing one; stateless `L3` is exempt, because there is nothing to back up.

**The RTO is a budget, not a promise.** Each row is detect → decide → fence → promote → re-point. For
`L2` in `auto` mode the node is `offline` at 30 s (`OFFLINE_AFTER_MS`), grace is 120 s from the last
heartbeat (§8.3), promotion waits for the lease when the control plane shared the failed node, and
re-pointing is one desired-state render. That is why §9.3 adds the two failovers and why the
automatic figure is not under a minute; in `manual` mode the clock starts at **Promote**. A single
control node is `L1`, with a standby `L2` (§6.1), listed once at the level it delivers.

**The gap to the next level.** Every resource page shows the level in force and the next one with its
blocker, generated from the same check that would refuse the change, so the sentence and the
behaviour cannot drift:

- `L0 → L1: no verified backup. D83 dumps exist for billing; none has been restored.`
- `L1 → L2: add a replica in another zone. Blocked: only cloud-a has a data node.`
- `L2 → L3: add a copy in another zone. Blocked: app volume appdata pins this project to edge (C9).`
- `L3 held down by: share media in zone home; a home outage still takes this app down (§5.2).`

### 8.2 Multi-node replicas (amends D90)

`replicas` exists today (D90): one `WorkloadDesired` per copy, `<id>` and `<id>-r<n>`, all on the
workload's node, workers only. HTTP replicas, spread, per-node placement and route fan-out are C4.

**Identity.** `workload_replicas` gets a row per copy — workload, index, node, status,
`placement_reason`, rendered epoch — and a node's desired state carries only its own copies. A copy
keeps its index when it moves, so `[r2]` means the same copy; scale-down drops the highest first.
Activation is per replica id, and `replicas` stays out of the activation version (D90), so scaling
never restarts a running copy.

1. **Filter.** `compute` role, online, not cordoned, `memoryMb` free (D42), and the hard spread rules.
2. **Hard spread.** Two HTTP copies may not share a node: a container publishes
   `127.0.0.1:<port>:<port>` and a process app binds the same `port`, so a second copy collides.
   `spread: node` is therefore an anti-affinity filter for `ingress: http` and `spread: zone` a filter
   for `L3`. `spread` is a hard filter at every replica count, never a score (§3.4, §13.3): a
   penalty cannot uphold "never two copies in one zone".
3. **Score** the eligible nodes: free budget, locality (`near`, or an attachment's node), then the
   least-loaded role mix.
4. **Admit on every target before anything is written.** One refusal fails the operation with the node
   and the shortfall; a deploy never lands three of four copies and reports success.
5. **Record** `placement_reason`: `deploy`, `scale`, `manual`, `failover` or `drain`.

**Ingress upstreams.** The route stays per workload. On every ingress node its `reverse_proxy` carries
one upstream per ready copy — the copy's overlay address and port — so a request reaches any zone in
one hop (§4.4). Today `upstreamFor()` returns a single `127.0.0.1:<port>` and a remote route dials the
node's `publicAddress`; C2 replaces both with the list, and a copy that is healthy but not ready is
never in it.

**Logs and metrics.** Replica logs drain under `<id>-r<n>` and fold onto the workload with an `[r<n>]`
prefix, and the heartbeat folds replicas with the worst status winning (`aggregateReplicaReports`).
Both exist and fold by workload id, so they survive copies moving across nodes; new per-replica series
are in §12. Health, policy and retries are §8.6.

### 8.3 Opt-in automatic re-placement

1. **Trigger.** Heartbeats stop and the node is `offline` after 30 s (`OFFLINE_AFTER_MS`).
   Re-placement waits `grace`, default 120 s from the last heartbeat — the same origin and duration as
   the offline alert, so the two cannot disagree about how long a node has been gone.
2. **Decide.** The level is `L2` or `L3`, `failover: auto` is set, and nothing pins the resource: not a
   `singleton` (§8.4), not a database primary (§9.3), not a volume (D74), not a share in the failed
   zone (§5.2), and until C2 not an attachment on the failed node (D56).
3. **Order.** Stateless HTTP copies first, workers next, singletons last after lease expiry plus
   margin. Within a workload the lowest index moves first, so the log stream keeps its shape.
4. **Admit.** Every target must pass §8.2 admission. If none can take the copy the move fails with
   `placement_blocked` and the free-budget table; it never half-succeeds quietly. A manual **Drain**
   (§8.5) starts the same machinery at once.
5. **Rate limit.** Six actions a minute fleet-wide, two a minute per target, one in flight per
   workload. Queued actions expire after 10 min and alert, rather than firing into a changed fleet.
6. **Apply.** Write the placement with `placement_reason: 'failover'`, bump the workload generation,
   render both nodes' state and update the ingress upstreams. A copy leaves the upstreams before its
   node is asked to stop it.
7. **Record.** One audit row per moved copy (actor `system`, from, to, epoch), a timeline entry and an
   alert that the failover happened.

**No automatic move back.** The returned node holds nothing of this workload, because desired state no
longer assigns it. The resource shows `degraded spread` and a **Rebalance** action; an operator
decides whether the original shape is worth another move. Nothing moves back on its own: a flapping
node would otherwise move every workload twice.

**Drain and UPS.** A NUT low-battery event (§3.1 `power`) cordons the node and drains with the
remaining runtime as the deadline. If the estimate is under 90 s the node skips the moves and stops its
units cleanly: a move that starts and cannot finish is worse than a clean stop. A dry run (**Would
this survive?**) applies this decision and admission to a chosen node or zone and writes nothing; it
shares one computation with the blast-radius view (§11).

### 8.4 Singletons and run leases (H15)

Some workloads must never run twice: schedulers, bots that would double-post, single-writer volume
holders. They set `singleton: true`. None of this exists today; it is C4.

The lease is the authority, not reachability. An agent that can reach a deposed control plane has
renewed nothing, and fencing on "cannot reach an endpoint" leaves the singleton running through the
partition it exists to survive.

- The control plane keeps one `run_leases` row per singleton: workload, node, `epoch`, `expires_at`,
  state. The lease is rendered into that node's desired state (`runLeases` with `leaseId`,
  `workloadId`, `epoch`, `expiresAt`, `renewAfterSeconds: 10`) with a 60 s TTL, refreshed on each pull.
- The agent starts a singleton only when its lease is present, and only for the epoch it trusts. It
  stops the unit when the TTL elapses on its monotonic clock, when a newer state drops the lease, or
  when it sees a higher epoch.
- A fenced primary answers desired-state and activation fetches with `503 control plane is fenced`.
  Agents treat that as unreachable, so the countdown runs on the isolated side too. Acceptance,
  activation and lease renewal are writes, and a fenced primary refuses all three.
- The lease is re-granted only after `expires_at` plus 10 s, so a gap of up to 70 s with no copy
  running is the price. The resource page says so rather than promising zero downtime.
- **Clocks.** The holder measures the TTL monotonically from arrival, so a wrong wall clock cannot
  extend a lease, and takes the earlier of that deadline and `expiresAt`; if the wall clock is 5 s or
  more behind the monotonic count (a resumed suspended VM, a stepped clock) it stops the unit and
  reports `clock_skew`. The control plane compares `expires_at` with its own clock only, so there is
  one grant clock and no agreement protocol.
- **D23 exception, stated.** A singleton stops when it cannot renew, the opposite of D23's "the control
  plane can be down without affecting live sites". It is a deliberate exception limited to
  `singleton: true`, offered only where running twice is worse than not running.
- **Tests.** Kill the control-plane primary: the singleton stops at TTL on the old side and starts once
  on the new. Partition the control plane from the node: same result. Freeze the holder past the TTL
  and resume it: it stops before the new copy starts. Step the node clock back 10 min: `clock_skew`,
  unit stopped. Repeat with two singletons to prove the leases are independent.

### 8.5 Rolling deploy and drain state machine

Both operations move work between nodes, and drain is the tool an operator uses most, so they are one
machine with two drivers. Today there is neither: a deploy replaces the unit in place.

**Rollout.** One step per replica, repeated until every copy runs the new release.

| State | Entered when | Leaves when | Timeout | On timeout |
|---|---|---|---|---|
| `queued` | Another rollout already holds a fleet or node slot | A slot frees | 15 min | Dropped, `409 rollout_capacity` |
| `surge` | A new copy starts beside the old ones | Its unit is active | 120 s container, 30 s process | Step fails |
| `probe` | The unit is active | Two consecutive readiness passes | 30 s | Step fails |
| `switch` | The copy is ready | It is in the upstream list on every ingress node | 10 s | Step fails |
| `drain` | Traffic has moved off the old copy | Unit stopped, connections closed | 60 s, then SIGKILL | Step continues, connections cut |
| `settled` | Every copy is on the new release | — | — | — |
| `paused` | A step failed | An operator retries or rolls back | 30 min | Stays paused; old copies serve |
| `rolled_back` | Rollback finished, old release restored on every copy | — | — | — |

**Invariants.** (1) Ready copies in the upstream set never fall below `replicas - maxUnavailable`; with
`maxUnavailable: 0`, the default whenever the budget allows a surge, never below `replicas`. (2) One
copy mid-step at a time. (3) A copy leaves the upstreams before SIGTERM, never after. (4) A copy joins
only after two consecutive readiness passes. (5) One rollout per workload; a second request gets `409`,
it is not queued. (6) At most two rollouts run fleet-wide and one per node; the rest wait in `queued`.
(7) On failure the previous release keeps or regains every copy — no steady state is half old and half
new.

**Failure and rollback.** A failed step pauses the rollout. A retry re-runs that step; a rollback walks
the copies that already took v2 back to the previous release, one at a time, under the same invariants.
It never leaves some copies forward and some back: a retry or a rollback ends with every copy on one
release.

**Worked example A — surge, 3 replicas, budget for 4.** `maxSurge: 1`, `maxUnavailable: 0`.

| t (s) | Action | Ready v2 | Ready v1 |
|---|---|---|---|
| 0 | Start a v2 copy of `r0` beside the v1 `r0` | 0 | 3 |
| 30 | `r0` v2 ready; joins upstreams; remove and stop the v1 `r0` | 1 | 2 |
| 50 | Start a v2 copy of `r1` | 1 | 2 |
| 80 | `r1` v2 ready; joins; remove and stop the v1 `r1` | 2 | 1 |
| 105 | Start a v2 copy of `r2` | 2 | 1 |
| 135 | `r2` v2 ready; joins; remove and stop the v1 `r2` — `settled` | 3 | 0 |

Serving never drops below 3. A failed `probe` returns to `paused`: copies already on v2 stay there, the
failed copy is removed, and the operator retries or rolls back.

**Worked example B — no surge, 2 replicas, node at budget.** `maxSurge: 0`, `maxUnavailable: 1`.

| t (s) | Action | Ready v2 | Ready v1 |
|---|---|---|---|
| 0 | Stop `r1`; there is no room for a third unit | 0 | 1 |
| 15 | Start `r1` on v2 | 0 | 1 |
| 45 | `r1` v2 ready; joins; stop `r0` | 1 | 0 |
| 60 | Start `r0` on v2 | 1 | 0 |
| 90 | `r0` v2 ready; joins — `settled` | 2 | 0 |

From t=0 to t=90 the app runs at one of two copies, and a node loss in that window is an outage. The
dashboard shows `deploying, 1 of 2 ready` for those ninety seconds, and the deploy response says the
surge was refused for budget. That is the honest version of a rolling deploy on a full fleet.

**Drain.** Cordon, move, verify. A drain never stops what it could move, and never moves what it cannot
restore.

| State | Meaning | Exits to |
|---|---|---|
| `running` | Normal; placements allowed. | `cordoned` |
| `cordoned` | No new placements; existing copies stay. | `draining` or `running` |
| `draining` | Moves in flight, ordered as §8.3 step 3, at its rate limit. | `drained`, `expired` |
| `drained` | Nothing movable remains; the `L0` remainder is listed. | `resumed` |
| `expired` | The deadline passed with work left; moves stop, the cordon stays. | `draining`, `evacuated` |
| `evacuated` | The operator stops the remainder and accepts downtime. Typed confirmation, audited. | — |
| `resumed` | Cordon lifted; placements resume. | `running` |

1. **Cordon:** placement excludes the node, auto re-placement stops targeting it, the page marks it.
2. **Classify:** movable (`L2`/`L3`), singleton (stop, then hand the lease over on the target), or
   pinned (volume, share, `L0`) — listed with the reason and left alone.
3. **Move** one workload at a time. A failed move pauses the drain and names the workload; it is never
   skipped silently.
4. **Deadline** 30 min by default, or the UPS runtime when the trigger was power. On expiry the drain
   stops in `expired` and reports what remains; it does not escalate to `evacuated` by itself, because
   stopping a customer workload needs a person.
5. **Verify** the new copy's readiness and the old unit's absence, then resume with
   `POST /nodes/:id/resume`. Drain and resume exist in API.md today as platform-admin **session**
   routes, never API-key ones; §12 adds them to the surface list. An interrupted drain re-classifies
   from scratch.

A drain and an automatic failover cannot fight over one workload: the drain holds its placement lock
and auto re-placement for it is dropped until the drain releases. A draining node is still `online` for
every other purpose, and its replicas serve until moved.

### 8.6 Health, readiness and load balancing

Today the agent makes one probe per workload: an HTTP `GET` on `healthPath` over loopback or the
socket, 2 s per attempt every 500 ms for up to 30 s (`SKIFF_WORKLOAD_HEALTH_TIMEOUT_MS`). The result
sets `running` or `starting` and does not gate traffic. Databases get a TCP engine handshake
(`probeDatabasePort`); a worker is healthy when its unit is active (D89). Caddy has one upstream per
route and no health configuration.

| Probe | Question | Today | Plan |
|---|---|---|---|
| Startup | Has it finished starting? | The 30 s window above | The same probe, 120 s for containers (image pull), and a `starting` state that never touches a route |
| Readiness | May it take traffic? | Not asked | Caddy active health on `readyPath` (default `healthPath`): interval 5 s, timeout 2 s, three failures eject, two passes rejoin |
| Liveness | Should it restart? | `Restart=on-failure` only | Unchanged: process exit is the signal. No HTTP liveness probe, which would restart a wedged-but-answering process in a loop and kill its in-flight requests |

**Passive health.** With `max_fails 3` inside `fail_duration 30s`, an upstream is marked down after
three responses in `unhealthy_status [502, 503, 504]` or three dial errors. Application answers — a 500
from a bug, a 404 — do not eject a copy, because that turns a bug into an outage. `unhealthy_latency`
is left unset for the same reason: a slow endpoint is a metric, not an ejection.

**Connection draining.** Fixed order: remove the copy from the upstream list, wait `stream_close_delay
10s` so assigned requests finish, send SIGTERM, wait `TimeoutStopSec=30` (the existing unit setting),
then SIGKILL. The reverse order cuts requests in flight. WebSocket and SSE routes set
`flush_interval -1`, no response header timeout, and expect an app heartbeat every 15 s; a drain waits
up to 60 s, then closes with 1001 and the client reconnects to a live copy.

**502, 503 and 504.** A 502 (upstream died mid-request, or the dial failed) serves the branded 503 page
with `Retry-After: 30` and is retried once if the method is idempotent and no body byte was forwarded.
A 503 with no ready upstream serves the branded page immediately, without a retry; a 503 the app
answered is passed through. A 504 is passed through and never retried: the origin may still be working
and a retry duplicates it. The branded page and the error-route fallback exist today
(`packages/site-config/src/compile.ts`); the plan keeps both for a route whose whole set is down.

**Retries.** `lb_try_duration 10s`, `lb_try_interval 250ms`, restricted to `GET`, `HEAD`, `OPTIONS`,
`PUT` and `DELETE`. Caddy does not filter retries by method, so the plan adds an explicit matcher and a
C2 test that a `POST` is never replayed. Nothing is retried after a response has begun streaming, and
nothing is retried across a WebSocket upgrade.

**Sticky sessions.** `sticky: 'cookie'` uses Caddy's `lb_policy cookie` with `skiff_affinity`
(`Secure`, `HttpOnly`, `SameSite=Lax`) for apps that hold a session in memory. It costs even load: one
client sticks to one copy, and a retirement re-pins every client on its next response. It is never
used for databases.

**Observability.** The agent reports each replica's last probe result, the time since it changed and
its ejection count in the heartbeat; each ingress node reports per-upstream request, error and latency
counters as `skiff_upstream_*` (§12). The resource page shows a probe timeline beside the deploy
history. Alerts fire on a ready-but-ejected copy for over 2 min, on a workload with no ready copy for
30 s, and on an ingress whose upstream set is smaller than its level requires.

---

## 9. Database HA

Status: **plan.** Every engine today runs one container on one node with a loopback-only port
(DATABASES §2, D56), and a project with an attachment is placed on the database's node. Nothing
replicates a database: there is no `pg_basebackup`, `pg_rewind` or `pg_ctl promote` in the tree, the
engine registry has no `replication` capability, and `db_metrics_1m` has no lag columns. C7 adds
replicas, C8 automatic failover; the unit of HA is the individual database (§8.1, §13 for its shape).

### 9.1 Engine capability

The engine registry (D95) gains `replication: 'none' | 'streaming' | 'native-cluster'`. `streaming`
means Skiff runs the replicas and orchestrates promotion; `native-cluster` means the engine owns
membership and election and Skiff renders configuration and watches it. Surfaces hide what an engine
lacks, and `L2` is refused when the value is `none`.

| Engine | Mode | Read URLs | Failover | RPO / RTO | Phase |
|---|---|---|---|---|---|
| Postgres 16/17 | `streaming`, 1–2 replicas, async or `ANY 1` sync | `<P>_READ_URL`, `_READ_POOL_URL`, `_READ_URLS` | Skiff; manual C7, `auto` C8 | async = lag ≤ 1 s; sync = 0 / 90 s target, 2 min budget | C7, C8 |
| MySQL 8.4/9.7, MariaDB 11.4/11.8 | `streaming`, GTID async | none | Skiff, manual only | lag ≈ 1 s / ≈ 10 min, operator-led | C10 |
| MongoDB 8.0/9.0 | `native-cluster`, 3 voting members | `<P>_URI` already lists all members | the engine's election | 0 for `w:majority,j:true` / 10–30 s | C10 |
| Valkey 9.1/8.1, Redis 8.10/8.8 | `streaming`, primary + async replicas, no Sentinel | none | Skiff, manual | AOF ≤ 1 s plus lag / ≈ 5 min | C10 |

Postgres is the only engine with a zero-RPO option, and `sync` needs two replicas in different zones to be
worth anything (§9.2); spike S6 keeps it off the homelab WAN pair. MongoDB needs three nodes, since a
two-member set elects nobody on a single loss. Valkey and Redis replicas serve stale reads and lose writes on
primary loss, so the engine page says what may attach; no Sentinel, because a second quorum daemon would give
one dataset two authorities.

### 9.2 Postgres replicas (H16)

**Roles and layout.** `database_replicas` holds one row per replica (node, volume, slot, role
`primary`/`replica`/`fenced`, replayed LSN, lag, state). `databases.primary_generation` counts promotions;
`databases.durability` is `async` or `sync`. No two members share a node, and a replica node needs the
`data` role and a `fast` volume.

**Bootstrap.** The helper verb `POST /v1/workloads/:id/replica/init` fills an empty data directory with
`pg_basebackup -D /data/pgdata -X stream -c fast -R --checkpoint=fast --max-rate=50M` against the primary,
through the same L4 endpoint a consumer uses, as `skiff_repl` with `sslmode=verify-full`. `-R` writes
`primary_conninfo` and `standby.signal`, so nothing is hand-edited; with PITR on, the source is
`pgbackrest --stanza=<id> restore`, still blocked by the missing PITR image (PITR.md).

**Slots and WAL retention.** One physical slot per replica, `skiff_<dbid8>_<node8>`, with
`max_wal_senders = max_replication_slots = 10`, `wal_keep_size = 512MB` and
`max_slot_wal_keep_size = 2GB` by default (operator range 512MB–16GB). The cap protects the primary's disk:
a replica down longer than the cap generates is a rebuild, never a resume, and a slot whose `wal_status`
reaches `lost` is marked `lost`, alerts, and requires a fresh bootstrap.

**Durability.** `async` is the default and the RPO is the lag, usually under a second. `sync` sets
`synchronous_standby_names = 'ANY 1 (<slot a>, <slot b>)'` with `synchronous_commit = on`: one listed
replica acknowledging is enough, so one can be lost without blocking writes. A single sync replica has no
slack, so `sync` requires two replicas in different zones unless the operator sets `on_sync_loss: 'block'`.

The downgrade decision lives on the primary's node, not in the control plane, which may itself be missing:
the agent counts failed acknowledgements from `pg_stat_replication` and after `sync_timeout` (30 s) clears
`synchronous_standby_names`, records `durability_effective = 'async'` and raises the alert on its next
heartbeat.

**Lag.** Two sampler queries as `skiff_monitor`, whose `pg_monitor` grant already covers both:
`pg_stat_replication` on the primary (state, LSN positions, the three lag intervals, `sync_state`), and the
replica's `pg_is_in_recovery()`, replay LSN and replay timestamp. New `db_replica_metrics_1m`, keyed by
`(database_id, replica_id, bucket)` with the same TTL and rollup, carries `state`, `lag_bytes` (`sent_lsn -
replay_lsn`), `lag_seconds` and `replayed_lsn`. Alerts: lag above 30 s or 256 MB for 2 minutes (warn); not
`streaming` for 60 s (page); `lost` immediately (page); no sync replica for 30 s (page).

**Read URLs and the pooler.** An attachment gains `<P>_READ_URL`, `<P>_READ_POOL_URL` and `<P>_READ_URLS`
(comma-separated), all optional: an app that ignores them keeps working against the primary. The read URL
is a **loopback port that does not change when the read target moves** — one extra port per attachment on
the consumer node from `22000–22999` (§4.3), mapped in `service_endpoints` to whichever replica
serves reads. `_READ_URL` targets the replica with the lowest node id and `_READ_URLS` lists all;
reads can trail by `lag_seconds`, and read-your-writes uses the direct URL.

The pooler stays on the database's node (D85), so `_READ_POOL_URL` points at the read replica's pooler and
`_POOL_URL` at the primary's.

**Settings, disk and limits.** The helper renders `wal_level=replica` once a database has a replica (today
only under PITR), `hot_standby=on`, `wal_receiver_timeout=wal_sender_timeout=60s`, `primary_conninfo …
connect_timeout=10`, and `initdb --data-checksums` for new databases from C7 so `pg_rewind` works; older
databases get `wal_log_hints=on` until a major upgrade or move re-creates them (OPS §4.2.5). Disk is
`1.3 × size` on the replica node, whose IOPS class must match, and each WAL sender costs a few MB of RSS.
`skiff_repl` is `LOGIN REPLICATION`, its password is sealed on the row and fetched at activation, and
`pg_hba` allows it only from the endpoint address for `replication`; streaming crosses the overlay inside the
mTLS endpoint path (§4.3), no port is public (D56), and an app credential cannot promote. Limits: two
replicas; none cascading in C7; none across a major version; none for a PITR database until its image gap
closes.

### 9.3 Failover orchestration

The control-plane primary orchestrates, one state machine per database, persisted in `database_failovers`
(database, from/to generation, state, chosen replica, evidence, timestamps, actor) so a promoted control
plane resumes at the same state. Skiff adds neither Patroni plus etcd/Consul nor pg_auto_failover.

The machine is `steady → suspect → confirmed → fenced → promoted → repointed → healing → steady`, with
`failed` reachable from any step. `suspect` starts the detection budget and records which signals agree;
`confirmed` writes the decision and picks the replica; `fenced` bumps `primary_generation`, holds the lease
and marks the old primary; `promoted` records the new primary; `repointed` verifies writes, traffic and
replication; `healing` rewinds or rebuilds the old primary; `failed` stays fenced and pages.

Detection uses three independent signals: the primary's agent reporting `up=0` for two consecutive samples
(60 s), which catches a crashed container on a healthy node that a heartbeat rule misses; no heartbeat from
its node for `db_failover_grace` (default 30 s, range 15–120 s), deliberately shorter than §8.3's 2-minute
placement `grace`; and a probe through a third node's endpoint failing, or, with no third node, the replica
reporting `pg_stat_wal_receiver` stopped with `last_msg_receipt_time` older than 60 s.

With three or more data nodes all three must agree, and with `failover: auto` that promotes. With two nodes
the only agreement is "node offline plus the replica's stream down", which cannot distinguish a dead primary
from a partition: hold, page, and promote only after the confirmed-dead check in §9.6. A single node has
nothing to promote to, so page and restore or move the database.

**Choose.** The eligible replica with the highest `replay_lsn`, excluding one on the old primary's node and
one whose slot is `lost`; more than 64 MB or 60 s behind needs `accept_data_loss: true`, else 409.

**Fence, then promote. Order is not negotiable.** Each database with `failover: auto` holds
`skiff/ha/db/<id>.json`, `{ generation, holderNodeId, expiresAt }`, renewed every 5 s with a 15 s TTL — the
same conditional-PUT mechanism as §6.3, gated by spike S3. Promotion acquires it at `generation + 1`; the
old primary stops when it cannot renew for one TTL, and immediately when it reads a higher generation. With
the object store unreachable nobody can be promoted. The generation also rides desired state, so a
reconnecting node sees `fenced` and stops. Self-fencing is **mandatory** with `failover: auto`, `fence: stop`
by default and `fence: readonly` where reads must keep working.

**Promote, re-point and heal.** `POST /databases/:name/promote` runs `pg_ctl promote`, waits for
`pg_is_in_recovery() = false` (30 s timeout) and reports the generation and LSN, refusing a lower one.
Consumers change only through `service_endpoints`, reloaded into Caddy's L4 route; connections drop and the
app reconnects (§9.5). Healing runs `pg_rewind --target-pgdata=/data/pgdata --source-server=…`, starts with
`-R` and waits for `streaming`; when rewind fails or the timeline diverged, purge and bootstrap instead.

**Split brain and its limits.** Only the lease holder is promoted and a holder that loses the lease stops, so
two writers cannot appear while the object store is reachable. They *can* when it is not and an operator
promotes by hand without checking the old primary, so that path demands the confirmed-dead check. §8.1
rates the database `L2` for node loss only.

**Timeouts.** Detection 30 s, decision 5 s, fence 15 s, promote 30 s, re-point 15 s, reconnect 10 s: ≈ 105 s
typical against the 2-minute budget, which is what §8.1's `L2` row carries.

**Control plane, manual promote and D97.** If the control-plane primary and the database primary share the
failed node, the control-plane failover runs first (§6.3) and the two RTOs add. Promote is
`POST /databases/:name/promote` (`If-Match: <primary_generation>`, `{ acceptDataLoss? }`, `confirm:
true`), `skif db replica promote`, or the dashboard behind a typed confirmation;
never MCP. Switchover drains the primary first: checkpoint, stop, wait for `replay_lsn =
pg_current_wal_lsn()`, promote — zero lost commits, refused when the gap is non-zero. Both audit
`database.failover.*` and page on `ha.replica_down`, `ha.slot_lost`, `ha.sync_downgraded` and `ha.fenced`
(§12.5).
D97 remains stop → dump → restore → purge; H16 **amends** it with a replica path: add a replica on the
target, catch up, switch over, purge.

### 9.4 Other engines

| Engine | What C10 ships | What it deliberately does not |
|---|---|---|
| MongoDB | 3 members, one per zone (`rs.initiate`), keyfile internal auth generated on each node and never in desired state, `rs.status()` sampled | Arbitration by the control plane (the engine elects), 2 + arbiter sets, sharding |
| Valkey / Redis | Primary plus 1–2 async replicas, AOF kept on, manual promotion, `INFO replication` sampled | Sentinel, automatic promotion, read URLs, replicas for queue workloads |
| MySQL / MariaDB | GTID async replicas (`gtid_mode=ON`, `enforce_gtid_consistency=ON`, `SOURCE_AUTO_POSITION=1`; MariaDB's `gtid_domain_id`, `gtid_strict_mode`), manual promotion, `SHOW REPLICA STATUS` sampled | Semi-sync, read URLs, automatic promotion |
| ClickHouse | Nothing: it is not a managed engine but the optional telemetry store (D101) | Any HA; when installed each control node keeps its own store and promotion loses the hot history (§6.2) |

The blocker is the provider-side listener, not the engine. A database container reaches a peer only through
the `skiff-workloads` network alias, and §4.3's provider listener is overlay-bound behind a per-peer
nftables allowlist: the member container has no host-network access and no route to the overlay, so it
cannot open the member port. C10 extends it: each member publishes a per-peer port on its own loopback
**and** an alias on the org network, and the provider accepts that port only from the member nodes' overlay
addresses, so replication stays inside the overlay and inside mTLS. Without that extension these
engines stay same-node only, which is worthless, so the correct outcome is to ship nothing for them.
Deferred beyond C10: MySQL group replication, MongoDB sharding and Valkey cluster mode, plus logical
replication for zero-downtime major upgrades.

### 9.5 Connection handling, pooling and app compatibility

**PgBouncer placement.** One pooler per database on the database's node, as today (D85): a separate Quadlet
unit, `MemoryMax=64M`, a loopback publish, a 0600 config and userlist, transaction mode. A remote consumer
reaches it through its own loopback endpoint, so the path is app → local endpoint → overlay mTLS → provider
→ pooler loopback; a consumer-side pooler would multiply server connections through the overlay for nothing.

**Modes.** `databases.pool_mode` is added as `transaction` (default) or `session`; today the helper
hard-codes `pool_mode = transaction` and there is no such field. Session mode is required for
`LISTEN`/`NOTIFY`, advisory locks held across statements, cursors and session `SET`. Changing it restarts
the pooler only (D87), so Postgres keeps its connections.

**The loopback endpoint.** Allocation is per consumer, not per provider: `22000–22999` on the consumer node,
recorded in `service_endpoints.local_port`, lowest free, released with the attachment. Provider ranges are
per node, so two provider nodes can both own `15432`; the consumer range must be independent or an app
attached to two databases collides.

**What an app sees during a failover.** The local endpoint accepts the TCP connection and closes it when
the upstream cannot be reached, so `connect_timeout` alone does not help. Fence gives `57P01` or a reset,
promote gives `08006`/`08001`, the re-point refuses on the port for up to 15 s, and after it the port and
URL are unchanged. Retry the whole unit of work at 100 ms → 2 s exponential backoff with jitter, at most
five attempts, and never retry a transaction that was already open.

**Retry, timeouts and transactions.** Retry only idempotent units of work, and retry the whole transaction
rather than a statement inside an aborted one; cap the total at 30 s, then surface the error. Set
`connect_timeout=5` (`connectionTimeoutMillis` in node-postgres), a 30 s `statement_timeout` and
`idle_in_transaction_session_timeout=30s`, so a fenced primary neither holds a request open nor accumulates
locks. Session state does not survive transaction mode, so migrations, schema tools, `pg_dump`/`pg_restore`,
logical replication and `LISTEN`/`NOTIFY` use the direct URL.

**Prepared statements.** Transaction mode breaks server-side prepared statements unless PgBouncer tracks
them. The plan adds `max_prepared_statements = 200` to the pooler config, and documents the client switch in
the existing credentials snippets (DATABASES §4): Prisma `?pgbouncer=true` on the pool URL,
Drizzle/node-postgres `prepare: false`, Go `pgx` `default_query_exec_mode=simple_protocol`, Rails
`prepared_statements: false` and Django `DISABLE_SERVER_SIDE_CURSORS = True`. Without one, the second
execution of a statement fails.

**Read replicas and published timeouts.** `_READ_URL` is opt-in and its contract is "may be stale by up to
`lag_seconds`". Use the direct URL for read-your-writes, for a read that must see a just-committed row and
for anything taking a lock; a useful middle ground is `_READ_URLS` plus the app's own rule "use the primary
for 1 s after a write in this session". Publish `max_connections` (Postgres default 100), the pooler's
`max_client_conn = 200` and `default_pool_size = 20`, `statement_timeout` 30 s and `connect_timeout` 5 s.

### 9.6 Failover runbook

Preconditions: the database is `L2` with a healthy replica, a verified `L1` backup exists, the mode is
known, and there is a way to reach the host or dashboard that does not depend on the failed node (§18).

1. **Detect and confirm.** Read the alert and `GET /api/v1/databases/:name/replicas` (or `skif db replica
   list`): state, `replay_lsn`, `lag_seconds`, `primary_generation`, node online? Apply §9.3's rule.
2. **Check the control plane.** If it is down too, run its runbook first (§18).
3. **Decide.** With `auto` and 3+ data nodes, watch it complete. With `manual`, or two nodes, decide between
   promoting and waiting, and record why.
4. **Confirm the old primary is dead** (manual path): node offline past `db_failover_grace`, host
   unreachable out of band, no recent writes in its logs. Two of the three only with `accept_data_loss`.
5. **Fence.** If it is reachable, set its database `fenced` with a generation bump and confirm the container
   stopped; if not, lease expiry is the fence.
6. **Promote** with `If-Match` on the generation, and `accept_data_loss` when the gap exceeds 64 MB or 60 s.
7. **Verify writes and replication.** `pg_is_in_recovery()` returns `false`; write and read back a
   `skiff_canary` row; `pg_stat_replication` and `database_replicas` agree that the survivors stream.
8. **Re-point.** Confirm every consumer map updated (`GET /topology`), then watch 5xx for 5 minutes; restart
   the pooler only if it never reconnects.
9. **Heal.** Rewind, start with `-R`, wait for `streaming`; on failure purge and bootstrap, never a merge.
10. **Roll back the decision only, never the data.** Once the new primary has accepted writes you cannot
    promote the old one back; another promote or an `L1` restore is the path, with a second person for the
    data loss.
11. **Communicate and review.** Status page with the measured RTO and any loss window; audit
    `database.failover.promote`. The postmortem records detect, decide, promote and re-point times, measured
    RPO, whether the fence worked and what the alerts said, and adds any missing step to §18.

**Drill variant.** Monthly, on a scratch database restored from a recent `L1` backup of a real one, using the
real path: the real lease, a real generation bump, a real promote and re-point, against a project deployed
for the drill, with the steps above under scratch names. Record the timings and compare them with the §9.3
budget; a green drill proves nothing unless the numbers are written down. Never use a separate drill key: it
exercises a different permission path with no contention, so it proves nothing about the mechanism (§19).

---

## 10. Object storage HA

A storage instance today is **one RustFS container on one node with one data directory** (D62,
[OBJECT-STORAGE.md](./OBJECT-STORAGE.md) §2): `RUSTFS_VOLUMES=/data`, a loopback S3 port from
`19000–19999`, buckets and keys converged as desired state (D65). Lose the node or disk and the
objects are gone; the row lives in the control plane, the bytes do not. **Plan (C9)**, after S5.

### 10.1 Topology options

| Option | Protects against | Does not protect against | Status |
|---|---|---|---|
| Multiple drives, one node | One failed drive, with degraded reads during rebuild | Node, PSU or zone loss | Plan (VOLUMES P4) |
| Distributed RustFS, one zone | One failed node: serves and rebuilds | Zone loss; any node over a WAN | Plan; no multi-node schema |
| Bucket replication, two zones | Zone loss, with RPO = replication lag | Deletion, corruption, metadata, IAM | Plan: C9 |

Four requirements. **Four drives in total**, the floor for erasure coding and a distributed set; S5
confirms the exact rule for the pinned version. **LAN latency**: distributed mode puts internode
traffic on the write path, so its nodes need an L2 segment or one switch hop (p99 under 1 ms);
bucket replication is the only mechanism allowed across a WAN. **Versioning on both sides** before
the link exists, because an unversioned bucket cannot be replicated and object lock is create-only
([OBJECT-STORAGE.md](./OBJECT-STORAGE.md) §8). **The same pinned engine version** on both sides.
Multi-drive alone is the disk layer of §5.1, not an HA level.

### 10.2 Bucket replication

Bucket replication is a RustFS feature that Skiff configures and observes; Skiff does not move the
objects. It is **active–passive**: the control plane owns the rule and the promotion.

1. **Create the replica**: a second container on the target node, same version, same root key pair
   (from the sealed `storage_instances` columns, never desired state), same object-lock config.
2. **Version, then link.** Version every bucket; write a `storage_replication` row (source, target,
   mode `bucket`, status) and have the agent apply it over loopback with endpoint and credentials.
3. **Initial sync.** Objects are enumerated and copied; the RPO is unbounded until it finishes, and
   a bucket is never shown as protected halfway.
4. **Steady state and breaks.** Asynchronous, per version, queued at the source; the replica serves
   nothing. S5 establishes whether a restart loses the queue; a lost queue means a full rescan.

| Item | Replicated | Where the passive side gets it |
|---|---|---|
| Buckets, objects, versions, delete markers | Yes, asynchronous | The link |
| Bucket config (policy, lifecycle, CORS, quota, lock) | No | Desired state; lock only at creation |
| IAM users and access keys | No | Desired state plus sealed attachment rows; same key pairs |
| `storage_instances` row, name, public host, ports | No | Control-plane SQLite, by Litestream (§6.2) |

**The row is not in the bucket.** Replication copies objects, not the instance row, bucket
configuration, IAM users, credentials or any other metadata: those live in the control-plane SQLite
and in sealed rows. Without a control plane the replica has bytes but no identity, routing or
credentials.

**Replication is not a backup.** For S3 the general rule in §5.1 takes this form: a delete replicates
as a delete marker within the RPO, a lifecycle expiry runs on both sides, and a granted `DELETE` or
corrupt write is copied. Only object lock or D70's scheduled backup survives that, and D70 is not
built.

**RPO is the lag, not a constant.** Target p95 lag ≤ 60 s, measured as the age of the newest source
version on the destination and shown per bucket ("L2, RPO p95 42 s"). The alert fires well before the
target is missed: p95 lag above 2 min for 5 min (§10.4).

Failover, in order:

1. **Decide.** Operator-gated, never automatic in C9: a promote action, the storage equivalent of
   the database promote in §12, records the reason and the accepted RPO.
2. **Freeze and measure.** Stop the source if reachable — the S3 API has no read-only mode, so this
   is the only fence — and record `last_replicated_at` as the RPO accepted.
3. **Move the row.** Check the replica is healthy, `streaming` and converged, then move
   `storage_instances.node_id` and `host_port` to the replica's; id, name, root key and `public_host`
   do not; `storage_replication` flips.
4. **Re-render, re-point, reverse.** Re-apply buckets and users (D65). A public instance moves every
   ingress node's `storageRoutes` upstream (D64), with no DNS or certificate change; a private one
   moves the consumer's loopback upstream (§4.3). Then reverse replication, confirm lag, and audit.

Attachments: **keys do not change** (same sealed pairs, so SigV4 verifies); **public URLs stay
valid** (host, keys and region unchanged, so old presigned URLs work); **private attachments survive
only with a stable consumer port** — before C2 they are same-node (D66), so a failover drags the
apps (D97), while from C2 the app keeps `127.0.0.1:<port>`; and **multipart uploads in flight fail**.

### 10.3 The platform object store

Skiff's own artifacts live in **R2**, external to every node and already highly available: releases,
uploads, telemetry Parquet, Litestream replicas and database dumps (D83). It is not a
`storage_instances` resource and never becomes one. If R2 is unreachable, new deploys (DESIGN §9) and
backups fail and Litestream stalls, while serving continues (D23); under §6.3 the control plane also
becomes read-only after one TTL.

**Multi-target replication** is the plan for this store, not built (ROADMAP). `ObjectStore` already
abstracts `local` and `s3`, so it means a list of write targets with one primary for reads: a write
is acknowledged when the primary succeeds, secondaries are fed by a retry queue, and restore reads
the primary with the secondary as fallback. Backups come first (D83 dumps, storage sync copies),
because those are needed when R2 itself is the casualty.

**Why it is not managed by Skiff.** A managed instance may be an `ObjectStore` target only, never
canonical ([OBJECT-STORAGE.md](./OBJECT-STORAGE.md) §10): a deploy needs artifacts from the store
(DESIGN §9), so the store cannot depend on a workload that deploy repairs; storage instances are
org-owned, soft-deleted and purged (D69), while platform artifacts must outlive any org; and the
control plane must reach the store when no node is healthy, which a loopback-only instance cannot.

### 10.4 Operations

The D68 sampler gains four fields per link in `storage_metrics_1m`: `replication_state`,
`replication_lag_seconds`, `replication_lag_bytes` and `replication_queue`; the heartbeat gains the
last replicated timestamp. Alerts: replication `error` or unexpected `off` for 5 min (critical), p95
lag above 2 min for 5 min, no initial-sync progress for 30 min, destination unreachable on three
probes (critical), versioning disabled on a replicated bucket (critical), and the 85% disk alert.

Restore: **promote the replica** (§10.2); **restore a D70 backup into a new instance** (not built);
**restore the sync-fallback copy**, which is a backup restore, not a failover.

Failures map to §11: node or zone loss is a promote (§10.2), link loss is an alert, and
control-plane loss blocks promotion but not serving.

Cost is a second container at the instance's memory (default 512 MB, D62), a full second copy of the
data, replication egress and ingress, and drilled operator time. Limits: the link is **per bucket**,
so a bucket created later is unprotected until the agent extends the rule; versioning is permanent
for a replicated bucket; object lock is create-only; there is **no metadata, IAM or row
replication**, so the control plane must exist for a failover; and there is **no automatic failover
in C9**.

**The honest caveat.** RustFS reached 1.0 in September 2026 and its replication has no track record
at this scale; that is why S5 gates the whole section rather than one phase.

**S5 (§15) decides whether any of §10.2 ships.** It must answer, with numbers: initial sync for
1 TB, p95 lag at 50 writes/s, a 10-minute break, a restart of either side, queue survival, delete
markers and object lock, memory overhead, and a bucket joining without a full rescan. **If S5
fails**, the fallback is a scheduled sync every 15 min: `L1` with the interval as RPO, not `L2`.
the `L2` replica row in §8.1 then does not apply to RustFS (§6.1 keeps the control-plane standby);
the instance shows "L1, sync copy, RPO 15 min", and a fifteen-minute-old copy is a restore, not a
failover.

---

## 11. Failure matrix

Each row states how the failure is detected and how long that takes, what breaks, what the platform
does without a human, what the human must do, the recovery objective, and the test that proves the
row. The reference topology is `edge` and `edge-b` in `cloud-a` and `cloud-b`, with `homelab` and
`linux-box` in `home` (§3.6); figures are sums of §11.1, and a row is a promise only while its test
is green (§19). Today's behaviour is [OPS.md](./OPS.md) §9; every manual action has a runbook in
§18.

### 11.1 Timing budget

| Stage | Owner | Value |
|---|---|---|
| Heartbeat, node `offline`, `Node offline` page | agent, core | 10 s, 30 s, 2 min |
| Control lease: TTL, renew, primary fences, standby may take it, promotion completes | §6.3 | 30 s, 5 s, 20 s, 40 s, ≈45 s |
| Ingress probe, hold-down, withdrawal | §7.2 | 10 s, 45 s, 120 s proxied / 240 s DNS-only |
| Database lease, renew, `db_failover_grace`, promote | §9.3 | 15 s, 5 s, 30 s, ≤30 s |
| Singleton run lease, Litestream sync, `sync` downgrade | §8.4, §6.2, §9.2 | 60 s, 1 s, 30 s |
| Operator response | human | 5–15 min from the page |

An RTO is detect → decide → fence → promote → re-point, and the slowest stage dominates. A figure
smaller than the sum of its stages is a bug in the figure; where §8.1 publishes an aggregate, this
budget is what makes it achievable.

### 11.2 The matrix

| Failure | Detection (signal, time) | Impact | Automatic response | Manual action | RTO / RPO | Test |
|---|---|---|---|---|---|---|
| `edge` lost | lease expires at `edge-b` in 30 s, takeover at 40 s; `Node offline` page at 2 min | public ingress, dashboard, `L0` on `edge`, SQLite writes | standby promotes (≈45 s), then `dns-failover` withdraws `edge` after a 45 s hold-down; `L2`/`L3` copies serve | promote, then point the record at `edge-b` (§18) | ≈120 s proxied (165 s single-witness), 240 s DNS-only `auto`; 10–20 min manual. RPO 0 stateless, ≤1 s SQLite | `chaos/kill-edge` |
| `edge-b` lost | heartbeat stops; page 2 min | second ingress, the standby, its replicas | paths re-route to `edge`; nothing to promote | repair, rejoin, re-seed the standby | seconds for ingress; hours for its `L0` | `chaos/kill-edge-b` |
| `homelab` offline | page 2 min; `skiff_volume_up` 0 | `home`-only apps, shares it serves, bulk RustFS, builds | `L3` elsewhere continues; routes return the branded 503; builds queue | repair; mounts fail closed (D76); re-run builds | seconds replicated, hours `L0`; builds wait | `chaos/zone-home` |
| `linux-box` offline | page 2 min | build capacity, replicas it held | re-placement only under `failover: auto`; builds queue | none unless it held a singleton | seconds for `L3`; builds wait | `chaos/kill-linux-box` |
| A whole zone (`cloud-a`, `home`) | the rows above, at once | control primary and ingress if `cloud-a`; shares, builds and bulk if `home` | promotion, then steering, then database failover | operate from the survivor (§18) | 3–5 min auto for `cloud-a`; hours for `home` | `drill/zone-loss` |
| A WireGuard hub | `skiff_wireguard_handshake_age_seconds{peer}` > 180 s | cross-zone overlay traffic through that hub | peers use the other hub; LAN pairs unaffected | repair; the helper re-applies peers | seconds with two hubs; total with one | `chaos/kill-hub` |
| Control-plane primary process | `/readyz` fails; no renewal for 20 s; no `Node offline` page | dashboard, REST, MCP, maintenance loop, deploys | the standby takes the lease at 40 s and promotes (≈45 s total) | restart the unit, then demote the loser (§18) | ≤1 min auto; RPO ≤1 s | `chaos/kill-control-process` |
| Control-plane standby | its heartbeat stops; `ha.standby_behind` | the failover target and the warm SQLite copy | primary keeps serving; `canPromote` stays false | re-enrol; wait for a full replay before calling it ready | none now; failover unavailable until repaired | `chaos/kill-standby` |
| Partition between the control planes | a lease CAS returns 409 or 412, or two `primary` roles are seen (`skiff_control_lease_conflicts_total`) | split brain; agents on a stale epoch | the loser fences at 20 s and the winner cannot take the lease before 40 s, so no instant has two writers; agents follow the highest epoch; singletons fence on the run lease | compare `/api/v1/ha/status` on both, stop the loser's Litestream, replace its SQLite, never merge (§18) | up to ~40 s of write unavailability; heal 10–30 min | `chaos/partition-a-b` |
| Object store unreachable | two failed lease reads or writes; `ha.object_store_unavailable` | deploys, uploads, backups, drills, promotion | no promotion; the primary fences after 20 s without a successful renewal; sites and reads keep serving | restore R2 access; if prolonged, accept read-only or break-glass | none: fail closed. RPO unaffected | `chaos/r2-unavailable` |
| DNS or Cloudflare | Cloudflare API 4xx/5xx on reconcile; `ha.dns_update_failing`; probe of `control.<domain>` fails | new steering only; existing records keep serving | retry with backoff; hold the record set; never remove the last healthy record | edit the record, change driver, or pin one ingress with `direct` | 0 for serving; steering frozen | `chaos/cf-api-403` |
| Certificate renewal | `TLS certificate expiring` at 14 d and 3 d (today); `skiff_node_cert_expiry_timestamp_seconds` | HTTPS on ingress; mTLS once a node certificate expires | the `acme` lease holder (§7.3) retries DNS-01; followers fetch from it; warn every sweep | re-issue with a fresh token, or install a Cloudflare Origin CA certificate | hours while days remain; outage once expired | `chaos/cert-expiry` |
| Failed control-plane upgrade | canary or bake verdict (D99); agent more than one release behind | the release only; the old one serves | the updater reverts inside the bake window; a migrated release restores its sealed bundle | `skiff-update-self rollback` or `recover`; a downgrade across an epoch is refused while any agent holds one (§20) | 2–10 min. RPO 0 code, last Litestream position for migrations | `chaos/upgrade-crash` |
| Stalled deploy or rollout | `pending`/`building` past its bound (10 min for a build, D45); no version change | the new version does not go live; the old one serves | the rollout stops at the last healthy step; the operation is marked `interrupted` (§8.5) | cancel, retry, roll the pointer back, or move off the failed node | 0: the old version serves. RPO 0 | `chaos/deploy-stall` |
| Database primary | its agent reports `up=0` twice (60 s); node offline past `db_failover_grace` (30 s); the third-node probe fails, or with no third node the replica's receiver stops for 60 s (§9.3) | writes to that database and every attached app | manual by default; with `failover: auto`, fence at `generation + 1`, then promote the replica with the highest `replay_lsn` | promote, re-point, `pg_rewind` or a base backup (§18) | 90 s target, 2 min budget auto; 5–15 min manual. RPO = async lag, usually <1 s; 0 with `sync` | `chaos/db-primary-kill` |
| Database replica | not `streaming` for 60 s; lag >30 s or 256 MB for 2 min; slot `lost` at once | redundancy reduced; a `sync` quorum if it was the only replica | the slot's WAL cap protects the primary; `sync` drops to `async` after 30 s, with `ha.sync_downgraded` | re-add the replica; check its disk and volume | none; protection reduced | `chaos/db-replica-kill` |
| Storage node | `skiff_storage_up` 0; page 2 min | the S3 API for that instance and its consumers | none: C9 promotion is operator-gated (§10.2); `L0` returns 503 | promote the secondary, re-point the endpoint at the replica, re-enable replication and verify the newest objects | seconds to minutes. RPO = replication lag or sync interval | `chaos/storage-node-kill` |
| Share server | the share's mount is gone; every attached workload fails closed (D76) | every workload mounting it, on every node | none; a share has one export (H7) | repair the export; mounts re-attach on the next converge | hours. RPO = the last accepted write | `chaos/share-server-down` |
| One disk in a mirror | `skiff_volume_up == 0`; the degraded-array alert (D80) | nothing until a second disk fails in the window | alert only; rebuilding is not automated | replace and rebuild; watch for a second fault | 0 / 0 while the mirror holds | `chaos/disk-fault` |
| Operator error (`DROP TABLE`, wrong prune, wrong promote) | `5xx spike after promote` (today); error rate; the audit diff | data loss, a workload on the wrong node, or a demotion of the healthy side | destructive actions are typed-confirmed and soft-deleted (D29, D54); promote carries `If-Match` | restore to a new database from `L1` or PITR; treat a wrong promote as a partition (§18) | minutes to hours. RPO = PITR point or backup interval | `drill/drop-table` |

### 11.3 Ordering rules

**Promotion before steering**: only a lease holder may withdraw a record, so the `edge` row is
promotion *then* removal. **A fenced primary is unreachable to agents but readable to humans**: 503
with `x-skiff-fenced: 1` for every non-GET and for heartbeat, desired state, activation and run-lease
renewal, while dashboard reads continue. **No instant has two writers**: writes stop at 20 s, the
standby cannot take the lease before 40 s. Only the lease holder replicates SQLite, a fenced primary
never resumes automatically, and `failover: auto` is refused unless self-fencing is on.

### 11.4 Dependencies and assumptions

The blast-radius view is this matrix made live: pick a node, a zone or a non-node domain (the object
store, Cloudflare, the ACME lease, a share server, the builder role) and see what would go down,
degrade or move. Every row holds only under these assumptions, each listed in §21:

| Dependency | What it assumes | If it fails |
|---|---|---|
| Zones | separate power, uplink and provider account | two "zones" are one; every spread cell is wrong |
| Clocks | NTP, skew under 1 s | lease expiry is unsafe and a standby can promote early |
| Overlay | one hub reachable from `home` | `home` is isolated; LAN pairs still talk |
| Object store | strong consistency for the lease object | no promotion and read-only; spike S3 (§15) must pass first |
| DNS | answers honoured, TTL ≤ 60 s | steering takes minutes; `direct` is the fallback |
| Headroom, hardware | the §3.4 reserve absorbs a failed node; a replacement machine exists | re-placement silently does nothing, and every RTO grows by the procurement time |

Survival of any one node is also a capacity property: without the headroom the automatic column
silently does nothing, which is worse than a longer RTO because it is invisible.

### 11.5 What the matrix does not cover

Two failures at once; silent corruption, which every replica copies and only `L1` and PITR answer;
degraded-but-up states such as half-open TCP, a slow disk, a full `/var` or a clock jump, which are
alerts rather than rows; security incidents (§17); and tenancy, because one node can host two
organisations' `L0` workloads while only the owner is warned. With one data node the database
decision is hold-and-page (§9.3); with one zone every "other zone" cell is empty.

## 12. Surfaces

One service layer (`packages/core`), several surfaces (D29, D81). Permissions are `resource:action`
strings scoped to an organisation (D9); the platform admin role is separate (DESIGN §6.2). Read-only
fleet views work from any surface of a platform admin (`canViewPlatform`); fleet mutations need that
admin's own dashboard session, never an API key, an OAuth token or MCP (`canAdministerPlatform`).

### 12.1 Dashboard

| Page | Who | Content | Status |
|---|---|---|---|
| **Topology** (`/topology`) | platform admin, read | zones → nodes (hardware, roles, labels) → volumes and shares → services; overlay links with RTT and handshake age; level and effective level per resource; the blast-radius simulator | Plan (C0) |
| **Node detail** (`/nodes`) | platform admin | today: status, stats, update, drain/resume, token rotation, storage, edge hand-off. Plan: Hardware tab, zone/roles/labels editing, endpoint and peer list | Today, extended in C0/C1 |
| **Resource HA card** (project, database, storage) | org reader | level, replicas with node and zone, lag, effective level, **Promote**/**Switchover**, and why a higher level is unavailable | Plan (C6–C7) |
| **Settings → High availability** | platform admin, session | ingress driver, standby enrolment and state, failover modes, headroom reserve, drill schedule and last result | Plan (C6) |
| **Audit**, **Backups**, **Metrics**, **Updates** | org `project:read`; fleet rows platform admin | today's log filtered by `ha.*`, `node.*`, `database.*`; restore-drill result; metric sections; node update state | Today, HA actions added in C4 |

### 12.2 REST

Base `https://<platformOrigin>/api/v1`, session cookie or `skif_…` bearer, `Origin` on every
mutation (API.md); the HA routes mount at `/api/v1/ha/`, the path every runbook uses. New routes keep
the existing error shape and add `412 precondition_failed` for a stale `If-Match` and `503` with
`x-skiff-fenced: 1` when a caller reaches a primary that lost the lease.

| Method | Path | Permission | Notes | Status |
|---|---|---|---|---|
| GET | `/topology`, `/topology/blast-radius?node=<id>` | platform admin | nodes, zones, links, effective level; impact from reported state | Plan |
| GET | `/ha/status` | platform admin | epoch, lease, role and lag per control node, `canPromote`, effective driver (§7.2) | Plan |
| POST | `/ha/promote` | platform admin **session** | `If-Match: "<etag>"`, `{ expectEpoch, dryRun?, reason? }` | Plan |
| PATCH, POST | `/nodes/:id`, `/nodes/:id/drain`, `/resume` | platform admin **session** | today `{ name, publicAddress, sliceMemoryMb, canBuild, … }` and a drain status bit; plan adds `{ zone, roles, labels, lanEndpoint }` and `{ mode: "cordon" \| "drain" \| "evacuate", deadlineSeconds? }` | Today / plan |
| GET, POST | `/databases/:name/replicas` | `database:read` / `database:update` | list `{ node, zone, state, lagBytes, lagSeconds, slot }`; add `{ node, volume?, mode: "async" \| "sync" }` | Plan |
| POST | `/databases/:name/promote`, `/switchover` | `database:update` | `If-Match: <primary_generation>`, `{ acceptDataLoss? }`; switchover waits for LSN parity | Plan |
| GET, POST, DELETE | `/shares`, `/ha/certificates` (+ `/rotate`) | platform admin **session** | the share resource (H7); per-ingress certificate state and the `acme` lease holder | Plan |

```jsonc
POST /api/v1/ha/promote       If-Match: "b7f1c0a2…"      { "expectEpoch": 7, "reason": "edge unreachable 12:04Z" }
200 { "epoch": 8, "holderNodeId": "n_edgeb", "demotedNodeId": "n_edge", "leaseExpiresAt": "…T12:05:30Z" }
409 { "error": "conflict", "message": "standby is 94 s behind; canPromote is false" }
412 { "error": "precondition_failed", "message": "lease moved since the read; re-read /api/v1/ha/status" }
503 { "error": "unavailable", "message": "object store unavailable; no promotion is possible" }
```

`GET /ha/status` returns `{ mode, epoch, driver, fenced, objectStore, lease: { holderNodeId,
expiresAt }, controlNodes: [{ nodeId, role, epoch, replayLagSeconds, canPromote }] }`. Promote is
idempotent under `Idempotency-Key`; a stale ETag returns `412` and a mismatched `expectEpoch`
returns `409` instead of bumping twice, and `dryRun` returns the checks it would run.

### 12.3 CLI

`skif` and `skiff` are the same binary (D33/D40). Exit codes are the existing ones: 0 all succeeded,
1 failed, refused or cancelled, 3 partial for batch verbs. Every command takes `--json`.

| Command | What it does | Status |
|---|---|---|
| `skif status`, `skif topology [--node <id>] [--blast-radius]` | fleet health; the Topology page in text | Today / plan (C0) |
| `skif ha status [--wait]`, `skif ha promote --expect-epoch 7 [--dry-run]` | epoch, holder, per-node lag; promotion with a precondition | Plan (C6) |
| `skif ha standby enrol --node edge-b`, `skif ha claim --from-store --expect-epoch 7`, `skif ha fence <node>` | enrolment, disaster claim, and the root break-glass actions (§6.5) | Plan (C6) |
| `skif ha drill <kind>` | run a drill and print the measured RTO/RPO | Plan (C8) |
| `skif node list\|show`, `skif node edit <node> --zone cloud-b --role ingress,control`, `skif node drain\|resume` | hardware, roles, zone, labels; drain modes and cancellation (C0, C4) | Plan |
| `skif db replica list\|add\|remove`, `skif db promote\|switchover`, `skif share add\|list\|remove\|attach\|detach`, `skif cert status\|rotate` | replicas, failover, shares and certificates | Plan (C7, C3, C5) |

`skiff-ha promote|demote` on the host does not exist today; the tools on the host are
`skiff-update-self` and `skiff-restore`, and `skif ha` is the CLI. Break-glass is
`skif ha promote --force` from a root shell: it takes the epoch it expects to replace, prints the lease and the candidate's lag,
requires the node name typed, and writes `/var/lib/skiff/ha/break-glass.log` for the promoted
control plane to import into `audit_log`.

### 12.4 MCP

The rule is explicit and closed: **MCP never changes placement, node state, control-plane role,
database role, certificate or lease.** D53 separates reversible agent actions from irreversible
human ones, D29 and D35 add the confirmation model, and DESIGN §6.2 makes fleet mutation
session-only; the no-promote rule follows from all three — not from D53, which is about project
delete, restore and prune.

| Tool | Returns | Status |
|---|---|---|
| `get_topology`, `get_blast_radius` | zones, nodes, roles, links, effective levels, impact of losing a domain; platform-admin only | Plan |
| `get_ha_status` | epoch, lease, standby lag, driver, effective level per resource | Plan |
| `list_nodes`, `get_node_capacity` | fleet nodes and slice budgets | Today |

The fleet reads reveal other organisations' placements, so they run only for a platform-admin
principal; `list_nodes` today challenges for `project:read` then refuses a non-admin in
`core.nodes.list`, which works but shows the wrong consent scope, so C6 adds `platform:read`. No tool
takes a node id as a write target, and every call — scope denial included — is audited.

### 12.5 Alerts

Alerts keep the existing shape — name, condition, severity, first response — and the existing
severities `info`, `warning` and `critical`, where critical pages. Every alert links to its runbook
by name in §18 (promote, demote, fencing, object store, zone loss, database failover), so renumbering
a subsection cannot break a link in an incident.

| Alert | Condition | Severity | First response |
|---|---|---|---|
| `ha.lease_lost` / `ha.lease_contested` / `ha.control_clock_skew` | no renewal for 20 s / a CAS 409 or 412 twice or two `primary` roles / offset from the store's `Date` header over 5 s | critical | stop mutating; compare `/api/v1/ha/status`; fix time sync before promoting again |
| `ha.object_store_unavailable` | two consecutive lease reads or writes fail | critical | check R2 credentials and status; expect fencing |
| `ha.standby_behind` | `skiff_control_standby_lag_seconds` > 5 s for 1 min, or the replica is missing | warning | `canPromote` is false; fix replication or re-seed |
| `ha.replica_down` / `ha.replica_lag` | not `streaming` 60 s / lag > 30 s or 256 MB for 2 min | critical / warning | re-add the replica; check disk, network and the slot cap |
| `ha.slot_lost` | a replica's slot reaches `wal_status = lost` | critical | bootstrap the replica again; a `lost` slot cannot be resumed (§9.2) |
| `ha.fenced` | a database or control node is fenced at a new generation | critical | read `/api/v1/ha/status`, confirm the old primary stopped, then heal (§18.8) |
| `ha.sync_downgraded` | `sync` configured but `durability_effective` is `async` | critical | the RPO just changed; restore the quorum or accept async |
| `ha.effective_below_target` / `ha.spread_degraded` | effective level below configured for 5 min / replicas share a forbidden domain | warning | repair, Rebalance, or re-declare the level |
| `ha.backup_missing` / `ha.backup_same_zone` | stateful `L2`/`L3` without a verified `L1` / target in the data's zone | warning | take and verify a backup; accept the risk knowingly |
| `ha.endpoint_down` / `ha.wg_handshake_stale` | `skiff_endpoint_up` 0 for 2 min / `skiff_wireguard_handshake_age_seconds{peer}` > 180 s | critical / warning | check the provider, the overlay path and the hub |
| `ha.share_full` | a Skiff-served share is below 15 %, then 5 %, free | warning / critical | free space on the server; find the runaway writer (§5.5) |
| `ha.dns_update_failing` / `ha.drill_failed` | the Cloudflare reconcile is failing / a drill was missed | warning / critical | check the token; fix the recovery path today |
| `ha.failover_performed` | an automatic promotion or re-placement ran | info | read the record and close the incident |

The notifier is not exempt: `skiff-alert@.service` runs where it was triggered, so a down node cannot
send its own page. The plan adds a dead-man's switch on a host that is not the primary,
probing `/api/v1/status` every minute with a `project:read` key and alerting after five failures.

### 12.6 Audit

Every HA action writes one `audit_log` row, following the existing `resource.action` convention
(`node.update`, `database.create`): `ha.promote`, `ha.demote`, `ha.fence`, `ha.claim`,
`ha.lease.take`, `ha.lease.refused`, `ha.drill.run`, `ha.topology.read`, `node.cordon`,
`node.drain`, `database.replica.add`, `database.replica.remove`, `database.promote`,
`database.switchover`, `certificate.rotate`, `share.create`, `share.delete`. A zone, role or label
edit is one `node.update` row with the changed fields in `args`; it never emits a second action.
Each row carries the actor and surface, the before and after epoch and `primary_generation`, the node
set, and a `reason` — who promoted, from where, and why, without a shell history.

### 12.7 Drills

The monthly restore drill (OPS §8) stays as it is: it proves the backup, not the failover. The plan
adds five drills that exercise the real path with the real key, not a drill key.

| Drill | What runs | Pass condition | Cadence |
|---|---|---|---|
| Control promotion | promote the standby for real; agents follow; write through the API; demote back | no agent on the old epoch after 60 s; measured RTO ≤ 45 s | Monthly |
| Ingress loss | withdraw one ingress with the configured driver, then restore it | traffic served by the survivor within the driver's bound | Monthly |
| Zone loss | cordon and evacuate `home` or `cloud-a` | blast radius matches the view; `L3` keeps serving | Quarterly |
| Object store down | revoke R2 access for five minutes | fencing at 20 s, no promotion, sites serving, recovery on restore | Quarterly |
| Split brain | asymmetric partition between the control planes | no instant with two writers; the loser never resumes alone | Quarterly |

Each drill writes `ha_drills` (§13; kind, started, measured RTO/RPO, assertions, result); the dashboard
shows measured against target, because a drill without contention, an epoch bump and agent reaction
proves nothing.

### 12.8 Who can do what

Roles are `owner`, `admin`, `deployer` and `viewer` (DESIGN §6.2); "member" means an org member with
`deployer` (write) or `viewer` (read). Platform admin is a separate user role, never implied by being
an org owner.

| Action | Owner | Admin | Member | Agent (MCP) | Platform admin |
|---|---|---|---|---|---|
| See fleet topology, blast radius, break-glass log | — | — | — | read, only with a platform-admin token | any surface |
| See a resource's HA level, replicas and lag | yes | yes | read | read | yes |
| Edit zone, roles or labels; drain or cordon a node; rotate a certificate; run a drill | — | — | — | no | session only |
| Promote or demote the control plane, or claim from the object store | — | — | — | no | session only |
| Promote or switch over a database; add or remove a replica | yes | yes | deployer | no | session only |
| Read the HA audit trail | own org | own org | own org, read | `get_audit_log` | any surface, fleet |

---

## 13. Data model changes

Everything lands in the control plane's one SQLite database (D9). `packages/db/src/index.ts` applies
each file in `packages/db/migrations` once, records it in `skiff_migrations`, and has no down path;
`packages/db/src/schema.ts` mirrors the tables in Drizzle. Every change below is additive: new
tables, and new nullable or defaulted columns. The migration numbers are the next free sequence
(0040 onward as this is written); a branch that lands first renames its file before merge. Each entry
below gives the type, nullability, default and index; §13.1 supplies the migration strategy,
retention and rollback that apply to all of them.

### 13.1 Rules, counters and rollback

Four rules hold for every table. **Default to today:** `zone='default'`, `ha_level='L0'`,
`failover='manual'`, and `epoch` absent unless C6 is on. **One writer per column:** intent columns
come from a `packages/core` service inside the auditing transaction, reported columns from the
heartbeat or a reconcile. **Backfill in the migration** while the table is small (tens of nodes);
above ~100,000 rows use a chunked `scheduled_tasks` sweep. **Rollback is code:** revert the release,
leave the columns and tables, turn the flag off; a column is dropped only in a later release.

Retention follows the class. Intent rows die with their resource (D59/D69). Allocation rows
(`service_endpoints`, `workload_replicas`, `run_leases`, `control_nodes`, `database_replicas`,
`storage_replication`) are freed by their reconcile, with an orphan sweep after 24 h. History
(`database_failovers`, `ha_drills`) is kept 24 months and pruned by the scheduler.

Only `epoch` fences the install; the other counters are per-resource compare-and-swap values, and a
generation compares only within one resource id. A single-node install omits `epoch` entirely.

| Term | Scope and carrier | Raised by | Enforced by |
|---|---|---|---|
| `desiredState.version` | One node; top level | Every render | Nothing; the agent applies any version |
| `epoch` | Install; top level, heartbeat (C6) | Promotion, `+1` by lease CAS | Agent persists the highest seen, refuses a lower |
| `primary_generation` | One database (C7) | Promotion, `+1` by database CAS | The database's agent stops on a lower value |
| `workloads.generation` | One workload (C4) | Every placement change | `If-Match`; a retry cannot double-apply |

### 13.2 Nodes, volumes and settings

C0 adds these to `nodes`. `mode` and `can_build` stay stored (§3.2); `build` is `can_build`'s role
alias.

| Column | Type, nullability, default | Index | Backfill |
|---|---|---|---|
| `zone` | TEXT NOT NULL DEFAULT `'default'` | `nodes_zone_idx` | Every row `default`; the operator renames |
| `roles_json` | TEXT NOT NULL DEFAULT `'[]'` | — | From `mode`/`can_build`: edge `["ingress","control","compute","data"]`, worker `["compute","data"]`, `build` appended when `can_build = 1` |
| `labels_json` | TEXT NOT NULL DEFAULT `'{}'` | — | `{}` |
| `hardware_json`, `hardware_at`, `hardware_error` | TEXT NULL, INTEGER NULL, TEXT NULL | — | NULL until the first C0 heartbeat |
| `lan_endpoint` | TEXT NULL | — | NULL; set by the operator |
| `private_address` | TEXT NULL | unique partial `nodes_private_address_idx` | NULL; join fills it in C1 |
| `private_cidr`, `wg_public_key`, `network_mode` | TEXT NULL | — | NULL; `network_mode` is `skiff` or `external`, NULL = legacy host-provisioned |
| `cpu_budget_millis` | INTEGER NULL | — | NULL; derived from `hardware.cores × 1000` |

`node_volumes` gains `class TEXT NOT NULL DEFAULT 'unknown' CHECK (class IN ('fast','bulk','remote','unknown'))`,
`class_override TEXT`, `class_reason TEXT`, `class_source TEXT NOT NULL DEFAULT 'derived'` (C0). The
migration sets `remote` for `remote = 1`; a sweep derives the rest, and a managed database create
refuses `unknown`. C2 and C5 add `node_certificates` and `ingress_certificates`, sealed material only
(§4.3, §7.3).

`settings` is the existing `key`/`value`/`updated_at` table, unused by HA today: platform config lives
in `/etc/skiff/skiff.env` via `skiff-platform-config` (verified). This is the canonical catalogue of
`ha.*` keys; §7.2, §20.1 and §20.4 read these names. Keys: `ha.mode` (`single` | `active-passive`;
`single` is the default and the disabled state, `off` is a legacy alias for `single`, and
`active-active` is refused), `ha.ingressDriver` (`direct`), `ha.autoFailover` (`false`),
`ha.placementGraceSeconds` (`120`), `ha.dbFailoverGraceSeconds` (`30`), `ha.syncTimeoutSeconds`
(`30`), `ha.promoteHoldSeconds` (`40`), `ha.drillSchedule` (`0 4 1 * *`), `ha.minAgentVersion` (the
C6 release), `ha.epochFloorVersion` (the first release that served this install an epoch above zero)
and `overlay.cidr` (`10.88.0.0/22`); JSON scalars validated in `@skiff/contracts`, missing = default,
audited as `ha.setting`. `ha.mode` is per install; `control_nodes.role` is per node.

### 13.3 Workloads, placement and replicas

`PlacementSpec` is §3.4's shape, persisted rather than derived; it is control-plane state, not a
desired-state field, so it needs no agent capability. `spread` is a hard filter, never a score.

```ts
interface PlacementSpec {
  node?: string; zone?: string | string[];                     // hard pin; zone restriction
  roles?: Role[]; labels?: Record<string, string>;             // implied by type; all must match
  volumeClass?: 'fast' | 'bulk' | 'remote'; volumeId?: string; // a volume pins its node (D74)
  spread?: 'node' | 'zone'; near?: string;                     // replica filter; locality hint
}
interface HaPolicy {
  level: 'L0' | 'L1' | 'L2' | 'L3'; failover: 'manual' | 'auto'; fence: 'stop' | 'readonly';
  graceSeconds: number; maxLagBytes: number; maxLagSeconds: number;
  onSyncLoss: 'downgrade' | 'block';                           // databases only (§9.2)
}
```

| Column | Type, nullability, default | Index | Backfill |
|---|---|---|---|
| `projects.placement_json` | TEXT NULL | — | NULL; read as `placement_json ?? placement` |
| `workloads.placement_json` | TEXT NULL | — | NULL; the resolved spec is recorded at the next deploy |
| `workloads.ha_level` | TEXT NOT NULL DEFAULT `'L0'` | `workloads_ha_level_idx` | `L0` |
| `workloads.failover`, `fence` | TEXT NOT NULL DEFAULT `'manual'`, `'stop'` | — | As the default |
| `workloads.spread` | TEXT NULL CHECK (`node`, `zone`) | — | NULL = derived from the level |
| `workloads.singleton` | INTEGER NOT NULL DEFAULT 0 | partial `workloads_singleton_idx` | 0 |
| `workloads.generation` | INTEGER NOT NULL DEFAULT 0 | — | 0; every placement change bumps it |

`projects.placement` keeps today's `edge | auto | <node>` shorthand beside `placement_json` for one
deprecation window; `placement_json` wins, an old surface reading only `placement` still works, and
the pair is removed after the minimum version stops reading it. Every placement-changing operation
bumps `generation` and takes an `If-Match` on it, so a retry cannot apply twice.

### 13.4 New tables and columns

Columns are NOT NULL unless marked NULL; `timestamps` means `created_at` and `updated_at` INTEGER NOT
NULL. Every `*_id` is TEXT without a declared foreign key, following the existing schema convention.

| Table (phase) | Columns: type, nullability, default | Indexes | Backfill |
|---|---|---|---|
| `workload_replicas` (C4) | `id` TEXT PK; `workload_id` TEXT; `replica_index` INT; `node_id` TEXT; `status` TEXT DEFAULT `'pending'`; `placement_reason` TEXT; `generation` INT; `epoch` INT; timestamps | unique `(workload_id, replica_index)`; `node_id`; `workload_id` | One row per existing workload at index 0, reason `legacy` |
| `run_leases` (C4) | `lease_id` TEXT PK; `workload_id` TEXT; `node_id` TEXT; `epoch` INT; `generation` INT; `state` TEXT DEFAULT `'granted'`; `expires_at` INT; `granted_at` INT; `renewed_at` INT NULL; `updated_at` INT | unique `(workload_id)`; `(node_id, state)` | Empty: no workload is a singleton until set |
| `service_endpoints` (C2) | `id` TEXT PK; `consumer_node_id` TEXT; `service_kind` TEXT; `service_id` TEXT; `local_port` INT; `upstream_node_id` TEXT; `upstream_port` INT; `protocol` TEXT DEFAULT `'tcp'`; `state` TEXT DEFAULT `'pending'`; `version` INT DEFAULT 0; timestamps | unique `(consumer_node_id, service_kind, service_id)`, `(consumer_node_id, local_port)`; `upstream_node_id` | None; created on attach |
| `shares` (C3) | `id` TEXT PK; `name` TEXT UNIQUE; `protocol` TEXT; `server` TEXT; `export` TEXT; `options_json` TEXT; `credentials_ref` TEXT NULL; `zone` TEXT; `server_node_id` TEXT NULL; `size_mb` INT NULL; `created_by` TEXT; timestamps; `deleted_at` INT NULL | unique `(name)` | None; new resource |
| `share_grants` (C3) | `id` TEXT PK; `share_id` TEXT; `org_id` TEXT; `mode` TEXT DEFAULT `'ro'`; `path_prefix` TEXT; `created_at` INT | unique `(share_id, org_id)`; `org_id` | None |
| `control_nodes` (C6) | `node_id` TEXT PK; `role` TEXT DEFAULT `'joining'`; `epoch` INT DEFAULT 0; `replay_position` TEXT NULL; `replay_lag_bytes` INT NULL; `replay_lag_seconds` REAL NULL; `last_replay_at`, `last_lease_seen_at` INT NULL; `can_promote` INT DEFAULT 0; `enrolled_at`, `updated_at` INT | PK only | None; rows appear at enrolment |
| `ha_drills` (C6) | `id` TEXT PK; `kind` TEXT; `started_at`, `finished_at` INT (latter NULL); `result` TEXT; `measured_rto_ms`, `measured_rpo_ms` INT NULL; `assertions_json` TEXT; `actor` TEXT | `kind`; `started_at` | None; append-only |
| `database_replicas` (C7) | `id` TEXT PK; `database_id` TEXT; `node_id` TEXT; `volume_id` TEXT NULL; `slot_name` TEXT NULL; `role` TEXT DEFAULT `'replica'`; `state` TEXT DEFAULT `'pending'`; `replay_lsn` TEXT NULL; `lag_bytes` INT NULL; `lag_seconds` REAL NULL; `sync_state` TEXT NULL; `generation` INT DEFAULT 0; timestamps | unique `(database_id, node_id)`, `(slot_name)`; `database_id` | One owner row per database, role `primary` |
| `database_failovers` (C7) | `id` TEXT PK; `database_id` TEXT; `from_generation`, `to_generation` INT; `state` TEXT; `candidate_node_id` TEXT NULL; `evidence_json` TEXT NULL; `started_at`, `updated_at` INT; `finished_at` INT NULL; `actor` TEXT | `database_id`; `started_at` | None; append-only |
| `storage_replication` (C9) | `id` TEXT PK; `source_id`, `target_id` TEXT; `mode` TEXT DEFAULT `'bucket'`; `status` TEXT DEFAULT `'pending'`; `last_replicated_at` INT NULL; `lag_bytes` INT NULL; `lag_seconds` REAL NULL; `error` TEXT NULL; timestamps | unique `(source_id, target_id)`; `target_id` | One `standalone` row per storage instance |
| `databases` columns (C7) | `primary_generation` INT DEFAULT 0; `durability`, `durability_effective` TEXT DEFAULT `'async'`; `on_sync_loss` TEXT DEFAULT `'downgrade'`; `ha_level`, `failover`, `fence` TEXT DEFAULT `'L0'`, `'manual'`, `'stop'` | — | All rows at the default |
| `storage_instances` columns (C9) | `ha_level`, `failover` TEXT DEFAULT `'L0'`, `'manual'`; `replica_role` TEXT DEFAULT `'standalone'` (`standalone`, `source` or `target`) | — | One `standalone` row per instance |

`workload_replicas.id` is `<workloadId>` at index 0 and `<id>-r<n>` otherwise; `placement_reason` is
`deploy`, `scale`, `manual`, `failover` or `drain`. C7 backfills a `database_replicas` owner row per
database (`state='streaming'`, `slot_name` NULL, `generation=0`); a database without it is `L0` and
never a promotion target. `database_failovers` is written before the fence, so a promoted control
plane resumes a state rather than restarting it (§9.3). `control_nodes` is reported cache: the lease
holds the truth and its columns rebuild from heartbeats. Expired `run_leases` are kept seven days.
`durability` is intent, `durability_effective` is what the agent applied, and a stateful `L2`/`L3`
row is refused without a verified `L1` backup.

### 13.5 Shares and service endpoints

`shares` is new in C3. `zone` derives from the server node and is never typed; `credentials_ref` is
an opaque id resolved at activation, never a sealed value, because the agent cannot decrypt an
org-key secret and D18/D43 keep it out of desired state. `app_volumes` gains `share_id`,
`share_subpath` and `share_read_only INTEGER NOT NULL DEFAULT 1`; `share_id` alone makes the volume
share-backed. The stored `backing` keeps a legal value (`state_dir` or `node_volume`, its existing
CHECK) and the service maps `share` on read, so the API contract still says `backing: 'share'`
without a CHECK widening and a table rebuild. C9 adds `replicate TEXT NOT NULL DEFAULT 'none' CHECK
(replicate IN ('none','sqlite'))`, `replicate_path TEXT NULL`, `writer_node_id TEXT NULL`,
`snapshot_interval_seconds INTEGER NOT NULL DEFAULT 900` and `snapshot_retention INTEGER NOT NULL
DEFAULT 48`; the backfill is `none` and NULL, which is today's pinned-volume behaviour. Deleting a
share is refused while a volume references it.

`service_endpoints` is stored intent for the allocation; desired state is a render of it, never a
second opinion.

```ts
interface ServiceEndpoint {
  id: string; consumerNodeId: string; serviceKind: 'database' | 'database-read' | 'storage' | 'studio';
  serviceId: string; localPort: number;                // 21000–21999 attachments; 22000–22999 reads
  upstreamNodeId: string; upstreamPort: number; protocol: 'tcp';
  state: 'pending' | 'ready' | 'degraded'; version: number;   // version bumps on every re-point
}
```

A failover changes `upstream_node_id`, `upstream_port` and `version`; it never changes `local_port`,
which is why an app's `DATABASE_URL` survives. A detach deletes the row only after the consumer
reports its listener gone, and the port is not reused before that report. One node holds at most
1,000 endpoints across both ranges. If the row and the render disagree, the row wins and the next
reconcile corrects the render; the agent never allocates a port.

### 13.6 Desired-state additions

`desiredStateSchema` gains only optional fields. Zod strips unknown keys, so a field is invisible to
an agent that predates it, and an older control plane that omits it leaves the newer agent on its
default. The per-workload entry also gains `generation`, `placement?: PlacementSpec` and, for a
managed database, `database.role`, `database.primaryGeneration`, `database.durability` and
`database.primary?: { nodeId, address, port }`.

```ts
interface WireguardPeer {
  nodeId: string; publicKey: string; allowedIps: string[]; endpoint: string | null;  // relayed = null
  persistentKeepalive: number | null;                  // 25 on the dialling side only
}
interface DesiredStateAdditions {
  epoch?: number;                                      // C6, gated by `ha-epoch`
  wireguard?: { mode: 'skiff' | 'external'; address: string; mtu: number; peers: WireguardPeer[] };
  serviceEndpoints?: (ServiceEndpoint & { upstream: { nodeId: string; address: string; port: number } })[];
  runLeases?: { leaseId: string; workloadId: string; epoch: number; expiresAt: string; renewAfterSeconds: number }[];
  ingress?: { platformUpstreams: { nodeId: string; address: string; priority: number }[]; certificateGeneration: number };
  storageReplication?: { replicationId: string; source: { nodeId: string; port: number }; mode: 'bucket'; action: 'link' | 'unlink' }[];
}
```

Bounds are enforced in the schema so an over-limit render fails loudly rather than truncating: 1,000
`serviceEndpoints`, 200 `runLeases`, 256 `wireguard.peers`, 2 MiB for the whole document. The §13.4
indexes keep the render linear in one node's own rows rather than the fleet's.

### 13.7 Capabilities and mixed versions

Capabilities are declared in the heartbeat today (`nodeCapabilities`, currently `studio-principal`
and `node-update`). The plan adds one per field group and renders a field only to a node that
declares it.

| Capability | Gates | Without it |
|---|---|---|
| `ha-epoch` | `epoch` and the heartbeat epoch | No `control` role, no `L2`/`L3` placement; HA enablement refused |
| `wg-mesh` | `wireguard` | No Skiff overlay; bring-your-own network only |
| `l4-endpoints` | `serviceEndpoints` | No cross-node attachment; same-node only |
| `ha-run-lease` | `runLeases` | No singleton |
| `ha-workload-replicas` | Cross-node replicas | Single-node replicas only, as D90 today |
| `ha-ingress` | `ingress` | No `ingress` role |
| `ha-db`, `ha-storage` | Database and storage member fields | No HA member on that node |
| `probe-peer` | The third-node failure signal (§9.3) | Two signals only; `auto` refused |

This table is canonical: §20.1's negotiation uses these strings verbatim, and a capability is added
here before anywhere else.

1. **Declare.** `capabilities` in the heartbeat is the only claim; `nodes.capabilities_json` is the
   stored copy, and an empty list means unknown, not "supports everything".
2. **Require.** Enabling HA, adding `control` or placing `L2`/`L3` lists every eligible node and refuses
   with the node name and the missing capability; the minimum version is one constant in
   `@skiff/contracts`, set at the C6 release.
3. **Degrade.** A node without a capability is excluded from the placement, not handed partial state.
4. **Refuse, do not hope.** Mixed-version fleets are **not** fenced: a pre-epoch agent that can reach a
   deposed primary keeps converging cached state, so it must never hold a control role or an HA
   placement. "Old agents keep working" is true only for installs without HA.
5. **Fence everything.** A fenced primary returns 503 to every agent endpoint, heartbeat, desired-state
   pull, activation and run-lease renewal included, so even a non-epoch agent has nothing to pull.

A field an old agent ignores must never be the only carrier of a safety property: the epoch is
checked in the agent, the lease in the object store, the database generation in the database's own
agent, so none of the three refusals depends on a new field being parsed.

### 13.8 The single-node path and the 1→2→N migration

A single-node install creates no lease, writes no `epoch`, has no `control_nodes` or
`service_endpoints` rows, no shares, and one `workload_replicas` row per workload at index 0.
`ha.mode` is absent, `private_address` is NULL and settings resolve to defaults; every query above
tolerates an empty HA table, and the HA pages say "not available on a single node". This is §6.1's
contract and a gate on every phase.

The upgrade is ordered and reversible in reverse: **C0** names zones and roles; **C1** joins the
second node and proves the LAN path; **C2/C3** attach a remote database and a read-only share;
**C5** adds the second ingress and runs `dns-failover` observe-only for 24 h; **C6** enrols the
standby, waits for lag under 1 s, then sets `ha.mode=active-passive` (epoch 1 at the first CAS);
**C7/C9** add data replicas one resource at a time, each refused without a verified `L1` backup;
**C8** enables `auto` per resource, never fleet-wide first.

Back to one node: demote the standby, remove the `control` role, delete the `control_nodes` rows
after twice the lease TTL, and leave the epoch at its last value. The epoch is never decremented, and
a control-plane release older than the epoch is refused (§6.5, §20).

---

## 14. Implementation phases

The phases are **C0–C10**, not H0–H10. `H1–H16` are the proposals in §16 (D107); using H for phases
made "phase H7" mean both the shares proposal and the database-replica phase. `docs/ROADMAP.md`
already lists C0–C10; older text that says "phase H7" means C7. A phase is one or more pull requests
that can merge, ship and be reverted on its own; the previous phase's flag may stay off. Estimates
are focused days for one maintainer, excluding review and soak. C5 owns the shared object-store lease
client, so C5's certificates no longer depend on C6's lease.

Migration filenames below use `NNN1`, `NNN2`, … as placeholders in order: reserve the next free
contiguous block when the phase starts, as Wave 1 did. The tree was at `0039` when this was written,
and other work keeps landing, so a hard-coded number here would be wrong by the time the phase begins.

| Phase | Goal and scope | Deliverables and primary files | Migration, flag, depends |
|---|---|---|---|
| **C0** | Hardware facts and derived labels, zone/roles/labels editing, volume classes, `PlacementSpec` filter and score with explained refusals, CPU budget, read-only Topology and blast radius | `hardware.v1`, `PATCH /nodes/:id` fields, class sweep, `GET /topology`, `/topology/blast-radius`; `packages/contracts/src/{agent,node,features}.ts`, `packages/core/src/{nodes,placement,volumes}.ts`, `apps/agent/src/{stats,main}.ts`, `apps/control-plane/src/routes/(dashboard)/{nodes,topology}` | `NNN1_nodes_topology.sql`, `NNN2_placement.sql`, `NNN3_volume_class.sql`; `SKIFF_FEATURE_PLACEMENT_SPEC`; none |
| **C1** | Plan 23's single hub generalised to hubs plus a LAN mesh; one-command join; `private_address`; peer health; external networks unchanged | Helper `wireguard/{keygen,apply,peers,status}` and `network/{allow,probe-mtu}`, join exchange, install script; new `apps/helper/src/{wireguard,network}.ts`, `apps/agent/src/join.ts`, `packages/core/src/nodes.ts`, `scripts/install/{main.ts,node.sh}` | `NNN4_private_network.sql`; `SKIFF_FEATURE_MANAGED_OVERLAY`; C0 |
| **C2** | Per-install CA, mTLS, loopback consumer port and overlay provider listener, cross-node database and private-storage attachments; S1 picks `caddy-l4` or the Bun forwarder | `node_certificates`, `service_endpoints`, port allocation, one nftables rule per attachment; `packages/contracts/src/{agent,database}.ts`, `packages/core/src/{databases,storage-instances}.ts`, `apps/agent/src/{caddy-config,caddy}.ts`, `docker/node/Dockerfile` | `NNN5_node_certificates.sql`, `NNN6_service_endpoints.sql`; `SKIFF_FEATURE_SERVICE_ENDPOINTS`; C1, S1 |
| **C3** | `shares` resource, on-demand NFS/SMB mounts, `backing: share`, credential refs, blast-radius inheritance | Share CRUD and grants, mount lifecycle and probes, credential handoff, Shares page; new `packages/core/src/shares.ts`, `packages/contracts/src/{app-volume,agent}.ts`, `apps/helper/src/shares.ts` | `NNN7_shares.sql`; `SKIFF_FEATURE_CLUSTER_SHARES`; C0, C1 |
| **C4** | HTTP and worker replicas across nodes, hard spread, health-checked balancing, rolling deploys, cordon/drain, singletons; `failover: auto` stored and refused until C8 | `workload_replicas`, `run_leases`, route fan-out, rollout and drain state machine, singleton fence; `packages/contracts/src/workload.ts`, `packages/core/src/{workloads,placement,scheduler}.ts`, `apps/agent/src/{caddy-config,runtime}.ts` | `NNN8_replicas_and_leases.sql`; `SKIFF_FEATURE_MULTI_NODE_REPLICAS`; C0, C2 |
| **C5** | Every ingress a full edge, shared cookie key, node-bound callback tokens, `dns-failover`, certificates issued once and distributed; owns the shared lease client | Full route table per ingress, `ingress_certificates`, probe quorum, last-record protection, hold-down; `packages/core/src/{domains,maintenance}.ts`, new `packages/core/src/ha-lease.ts`, `apps/agent/src/caddy-config.ts` | `NNN9_ingress_certificates.sql`; `SKIFF_FEATURE_INGRESS_HA`; C1, S3, S4 |
| **C6** | Standby enrolment, Litestream follow, master-key and config distribution, lease and epoch, fencing, proxied control hostname, manual promote | `control_nodes`, `ha_drills`, `controlEndpoints`, persisted agent epoch, 503 fence on every agent route, Promote; `packages/core/src/{nodes,maintenance}.ts`, new `packages/core/src/control-ha.ts`, `apps/agent/src/{state,main}.ts` | `NNN10_control_nodes.sql`; `SKIFF_FEATURE_CONTROL_STANDBY`; C5, S2, S3 |
| **C7** | Postgres streaming replicas, slots and WAL caps, lag metrics, read URLs, manual promote and switchover, replica-based moves; two-node fleets hold and page | `database_replicas`, `database_failovers`, failover state machine, helper replica verbs, `db_replica_metrics_1m`, read endpoint; `packages/core/src/{databases,database-metrics-sql}.ts`, `packages/contracts/src/{database,agent}.ts`, `apps/agent/src/database-stats.ts` | `NNN11_database_replicas.sql`; `SKIFF_FEATURE_DB_REPLICAS`; C2, C6, S6 |
| **C8** | Automatic failover for the control plane and Postgres, three-signal detection, mandatory self-fencing, and the chaos harness that must exist first | Decision matrix, self-fencing, rate limits, `ha_drills` with measured RTO/RPO, multi-container fault harness; `packages/core/src/{control-ha,databases}.ts`, `apps/control-plane/src/routes/api/v1/ha`, `tests/e2e/chaos/**` | No schema change; `SKIFF_FEATURE_AUTO_FAILOVER`; C4, C6, C7 |
| **C9** | RustFS bucket replication and manual promote, Litestream for SQLite app volumes, snapshot shipping, Skiff-served NFS; S5 gates replication | `storage_replication`, replication metrics, promote with object verification, Litestream unit, snapshot protocol, export verb; `packages/core/src/storage-{instances,metrics-sql}.ts`, `apps/agent/src/storage-apply.ts`, `apps/helper/src/volumes.ts` | `NNN12_storage_replication.sql`; `SKIFF_FEATURE_STORAGE_REPLICATION`; C2, C6, S5 |
| **C10** | MongoDB replica sets, Valkey/Redis replicas, MySQL/MariaDB GTID replicas, each behind its own engine flag; gated on a provider-side member port in §4.3 | Engine replication capability, member placement by zone, member ports, per-engine drills; `packages/contracts/src/database.ts`, `packages/core/src/databases.ts`, `apps/helper/src/units.ts` | No schema change; `SKIFF_FEATURE_ENGINE_MONGODB`, `SKIFF_FEATURE_ENGINE_VALKEY`, `SKIFF_FEATURE_ENGINE_MYSQL`; C7, C8, member-port decision |

| Phase | Exit criteria and demo | Rollback | Risks | Estimate and gating tests |
|---|---|---|---|---|
| **C0** | Every refusal names the first failing constraint per node; blast radius matches a hand-checked four-node fleet; no `unknown` class on a managed volume; single-node unchanged with the flag off. Demo: remove the only `fast` volume and read the exact refusal | Flag off returns to `edge`/`auto`; columns and overrides stay inert | A wrong role check refuses valid deploys; cross-distro hardware parsing | 8–10 d; placement unit table, migration from 0038, four-node e2e |
| **C1** | One pasted command joins a worker; LAN RTT under 1 ms; losing one hub keeps the rest reachable; an existing `wg0` is untouched; a single node has no interface. Demo: kill `edge`, reach `edge-b` from `homelab` | Flag off restores host-provisioned peers; the helper never deletes an interface it did not create | Blocked UDP 51820, MTU black holes, an nftables rule that locks out SSH | 10–12 d; helper units, three-container harness, `tc netem`, re-run idempotency |
| **C2** | An app reaches a remote database on `127.0.0.1`; a public scan is empty; a re-point needs no restart; a consumer without an attachment is refused; the cap is enforced. Demo: move a database, URL unchanged | Flag off returns to same-node; listeners drain and rows are freed | `caddy-l4` reloads drop long-lived Postgres connections; certificate expiry; port exhaustion | 12–15 d; 24 h S1 soak, two-node e2e, nftables denial, port allocation |
| **C3** | A read-only share mounts on two nodes and fails closed when the server is gone; a read-write attach shows the multi-writer warning; the share's zone joins the blast radius; no credential in desired state, logs or audit. Demo: yank the uplink, no write reaches the root disk | Flag off hides the resource and unmounts at zero attachments | A hard NFS mount in `D` state ignores `SIGKILL`; uid mapping; credential leakage | 10–12 d; mount lifecycle, credential grep, fail-closed e2e, unmount under load |
| **C4** | Killing a node keeps an `L3` app serving; a drain moves every movable copy and stops at the deadline; a singleton never runs twice in a partition; a deploy racing a drain cannot land on the draining node. Demo: rolling deploy plus a drain | Flag off returns to D90 single-node replicas; leases stop rendering and singletons are refused | Port collision (hard spread guards it); two placement operations racing | 12–15 d; invariant suite, partition with a fake control plane, rollout failure, drain deadline |
| **C5** | Powering off `edge` keeps static sites and `L3` apps reachable within 120 s proxied / 240 s DNS-only; identical fingerprints; the last healthy record is never removed; a Cloudflare failure freezes steering. Demo: kill `edge`, watch the record set change | Driver back to `direct`; the set collapses within 30 s | Several A records in Cloudflare is unproven; duplicate-certificate limit; divergent cookie key | 10–12 d; driver simulation, probe quorum, certificate distribution, clock skew |
| **C6** | Manual promote moves every agent to the new epoch within one heartbeat; the old primary fences and is replaced; lag stays under 1 s; enabling HA is refused while a node lacks `ha-epoch`; a downgrade across an epoch is refused. Demo: promote `edge-b`, session continues | Promote back, set `ha.mode=off`, delete the lease after two TTLs; the epoch never decreases | Two primaries, a second master-key copy, R2 CAS semantics, operator error | 15–20 d; T1–T8 at 20 repetitions against fake S3 (412, 5xx, delay) |
| **C7** | Switchover loses no commit; a promote re-points every consumer without re-activation; a lagging or `lost` replica is refused; a major-version mismatch is refused; a two-node fleet offers Promote and never promotes itself. Demo: kill the primary, Promote, app reconnects | Remove replicas, set `async`, flag off; rows stay as evidence | WAL retention fills the primary; `sync` stalls writes; failed `pg_rewind`; accepted data loss | 15–20 d; replica lifecycle, slot loss, sync downgrade, state machine, two-node refusal |
| **C8** | `auto` refused unless self-fencing is on; the fault catalogue passes 20 times with invariants intact; every drill records measured RTO and RPO; split-brain overlap is at most one TTL. Demo: pull the plug, no human | `auto` off per resource, then the flag; manual Promote remains | False-positive promotion, asymmetric partition, object store failing at the same time | 15–20 d; §19 fault matrix, 1 s clock skew, 24 h soak |
| **C9** | Lag reported and alerted; a promote moves the row and route without changing keys or URLs; a Litestream app restores within its stated RPO; an app-volume snapshot mounts on promotion; a failed S5 leaves the instance at `L1`. Demo: promote a replica, an old presigned URL still works | Flag off stops replication and leaves the source serving; the target is inert | RustFS replication maturity, key recreation, the unbuilt D70 backup, a half-replicated bucket shown as protected | 10–15 d; S5 numbers, replication break, promote, restore, versioning |
| **C10** | Each engine passes its own kill-and-promote drill and a member-to-member connection works through a provider-side listener; no public port. Demo: elect a Mongo primary after killing a member | Engine flag off hides the HA option; the instance runs `L0` | The endpoint model may not cover member traffic, so C10 may stop at MySQL/MariaDB async | 10–15 d; per-engine drills, no-public-port scan |

### Sequencing

| Phase | C0 | C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | C9 | C10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Estimate | 8–10 d | 10–12 d | 12–15 d | 10–12 d | 12–15 d | 10–12 d | 15–20 d | 15–20 d | 15–20 d | 10–15 d | 10–15 d |
| Depends on | — | C0 | C1, S1 | C0, C1 | C0, C2 | C1, S3, S4 | C5, S2, S3 | C2, C6, S6 | C4, C6, C7 | C2, C6, S5 | C7, C8, member port |
| Default after | On | On | On | Off | On for new `L3` | Off | Off | Off | Off | Off | Off |

The total is roughly 125–165 focused days, six to eight months for one maintainer before review and
soak. The order is acyclic once C5 owns the lease client: C0 → C1 → C2 → C3/C4 → C5 → C6 → C7 → C8
→ C9/C10. No phase needs a later phase's schema.

### First slice

C0, C1 and C2, in that order. C0 is useful on any fleet and has no HA risk; C1 makes a second node
reachable; C2 turns a set of nodes into one platform, because every cross-node attachment, C5's
second ingress and C7's replicas depend on it. This revises the old "C0, C1 and C3 are the right
first slice": C3 is safe but lower value and can follow C2 without blocking it. C3 first is correct
only for an operator whose actual need is a shared media library on a homelab. C4 and C5 deliver
most of the visible availability; C6–C8 carry the correctness risk and need the chaos harness before
any `auto` mode reaches a user.

### Rules that hold across phases

1. One flag per phase, `SKIFF_FEATURE_<NAME>` registered in `packages/contracts/src/features.ts`;
   off stops the control plane rendering the fields, it does not make the agent forget them.
2. Every phase carries a single-node regression gate: flag off, one node, the same routes and
   behaviour.
3. A migration ships before the code that reads it; if a release needs both, the migration is first.
4. No `auto` mode before C8, no stateful `L2`/`L3` resource without a passing restore drill, and a
   field or table is never removed in the phase that added it.
5. Done includes the operator surface: an `docs/OPS.md` runbook, a `docs/ROADMAP.md` tick, and the Hn
   promoted to a D-number in `docs/DECISIONS.md`.

---

## 15. Spikes

Six questions decide whether the mechanisms in §4–§10 are buildable. None has been run: the only
related result is row 6 of [SPIKES.md](./SPIKES.md) (Litestream to R2, then restore), recorded there
as *not run* for want of R2 credentials. A spike is a timeboxed experiment against the real
dependency, not a prototype: it produces a number, a line in §15.4 and a decision about the branch
to build. The fallback is agreed first, so a failure changes the plan rather than the date.

### 15.1 How a spike is run

1. The question and its pass criterion are written down before any code, in the spike's issue.
2. The rig exercises the dependency: the pinned Caddy build, the Litestream binary the unit runs, R2
   itself, the real homelab link. A local fake proves nothing about a lease.
3. The rig lives in `spikes/<name>/` beside `duckdb`, `caddy` and `cimd-bun`; the numbers go into
   [SPIKES.md](./SPIKES.md) as a dated section keyed `S1`–`S6`, so the v0 table keeps its numbers.
4. The outcome is appended to §15.4, and everything that is not the rig is deleted. A spike is not
   the first commit of a phase.

One maintainer owns all six; each row names the access it needs, because access, not skill, sets the
start date. C1 has no spike: plan 23's acceptance and the `network/probe-mtu` verb cover MTU and
handshake risk, and S6 exercises the overlay in passing.

### 15.2 The six spikes

| # | Question and why it matters | Pass criteria |
|---|---|---|
| S1 | Does a full config reload through the admin API keep established L4 connections alive, and is `caddy-l4` stable for sessions that live for hours? C2 puts every cross-node attachment behind it, and the admin API reloads the whole config on each call ([SPIKES.md](./SPIKES.md) §4), so a reset listener would cut live queries on every reconcile. | 0 unexpected resets in 100,000 short connections; all 50 idle connections survive a route edit for another service; p99 added latency ≤ 2 ms; RSS ≤ 40 MB at 200 routes; fd count flat over 72 h. |
| S2 | Can the standby follow the Litestream replica continuously rather than re-restoring on each poll, and at what lag? C6's ≤ 1 s control-plane RPO and its promotion path rest on this, and SQLite has no other continuous copy. | p95 replay lag ≤ 1 s and p99 ≤ 5 s over 24 h; a promotion from the follower gives an identical fingerprint and `PRAGMA integrity_check` ok; recovery after a 60 s cut in ≤ 30 s; a restart keeps the replay position. |
| S3 | Do R2 and each configured S3 target honour `If-Match` and `If-None-Match` on PUT strongly enough to be the only arbiter of one primary? Two acknowledged conflicting writes, or two views of one object, remove the foundation of §6.3. | Exactly one 200 per epoch, never two holders; 409 or 412, never 200, for a stale `If-Match`; the ETag changes on every write; p99 PUT ≤ 300 ms; store time within 5 s of true time; 501 for an unsupported condition, never silent success. |
| S4 | Is one certificate distributed through the activation endpoint workable, and does renewal happen once per window without dropped connections or a duplicate-certificate refusal? Every ingress must serve the name at the instant of failover, and each copy of the wildcard key can impersonate every site (§7.3). | Both ingresses report one fingerprint; one issuance per name set per 7 days at steady state; a renewal reloads with ≤ 0.1% dropped connections; a 6 h control-plane outage does not stop renewal of the file on disk. |
| S5 | Is RustFS bucket replication mature enough to be an `L2` data path, and what does it cost in memory and versioning? §10.2 is the only cross-zone path for bucket data, and the project reached 1.0 in September 2026 with no track record at this scale. | 1 TB initial sync ≤ 12 h; p95 lag ≤ 5 s at 50 writes/s (headroom against the 60 s target in §10.2); a 10-minute break resumes without a full rescan; the queue survives a restart; delete markers and lock behave; ≤ 512 MiB RSS per instance. |
| S6 | Can streaming replication, `pg_basebackup` and `pg_rewind` work over a WireGuard hop to a home uplink at acceptable throughput, and what MTU and RTT does `sync` need? `sync` pays the round trip on every commit, and the homelab WAN is the weakest link in §3.6. | Base backup ≥ 20 MB/s and ≤ 20 min for 20 GB; async lag p95 ≤ 2 s at 200 writes/s; `pg_rewind` ≤ 60 s; no reset across a 10-minute link flap; sync commit ≤ 30 ms p95 at ≤ 5 ms RTT. |

| # | Method | Fallback | Effort, blocks, owner |
|---|---|---|---|
| S1 | Two containers on the overlay, Postgres 17 on the provider, `caddy-l4` on the consumer, one connection held open for 14 days, 50 idle connections, one full-config PUT every 60 s for 24 h. | The agent's Bun TCP forwarder on the same ports with the same nftables hand-off: about 10–15 MB more RSS per node, and the peer-certificate check in our code rather than in Caddy (§4.3). | 2 days plus a 14-day soak. Blocks C2. Owner: network path; root on two VMs. |
| S2 | Start by running row 6 of [SPIKES.md](./SPIKES.md). Then a control-plane-sized database (a live `skiff.db` copy with 200k audit rows) replicated by the unit's own `litestream replicate`, a follower in its own data directory, 50 transactions/s, a 60 s network cut, `kill -9` during a write, and `scripts/skiff-db-fingerprint.ts` compared before and after. | `litestream restore` into a staging file every 60 s and an atomic swap: the control-plane RPO becomes the interval, and promotion waits for the last swap to finish. | 3 days. Blocks C6. Owner: storage; R2 credentials and a second host. |
| S3 | A harness against R2 and every S3 target in use, plus a proxy that delays one response by 5 s: 10,000 CAS attempts at 200 writers for 60 s, an unconditional PUT against a held `If-Match`, and a comparison of the store's `Date` header with a synced clock. | **Fail closed, and retire the old fallback.** Two control nodes can both hold a local lease, and a tiebreaker needs the same conditional write that just failed, so that is not a lease. Without a CAS there is no automatic promotion: control-plane promotion is manual after stopping the old primary's units (§6.6), C8 ships without automatic control-plane failover, and the database (§9.3) and ACME (§7.3) leases lose their arbiter too. | 2 days. Blocks C6 and the `auto` modes of C8. Owner: platform; store credentials. |
| S4 | Two ingress hosts on a staging domain: issue once and distribute, force five renewals in a week, run the certmagic S3-storage variant beside it, cut the control plane for 6 h during a renewal window, and reload with 1,000 keep-alive connections open. | Cloudflare Origin CA when every name is proxied (15 years, no ACME, trusted only by Cloudflare's edge), or per-ingress ACME. The second multiplies key copies and duplicate-certificate risk and caps DNS-only installs at one ingress, because C5 cannot serve a name from a second node without a certificate. | 4 days. Blocks C5. Owner: PKI and DNS; a Cloudflare zone and a second ingress host. |
| S5 | Two four-drive instances in two zones, 1 TB of mixed object sizes, 50 writes/s for 24 h, a 10-minute break, a restart of each side, a bucket added while the first replicates, delete markers and object lock exercised, RSS measured on both. | Scheduled sync every 15 min: `L1` with a 15-minute RPO, not `L2`. A fifteen-minute-old copy is a restore, not a failover, so the `L2` replica row in §8.1 does not apply to it. | 5 days. Blocks C9. Owner: storage; two hosts with four drives each. |
| S6 | 20 GB base backup and 200 writes/s through the consumer endpoint (§4.3) to a `home` replica, with `tc netem` adding 15 ms and 30 ms RTT and 0.1% loss, MTU probed at 1420 and 1280, a forced divergence healed by `pg_rewind`, and sync commit latency at p50 and p95. | `sync` restricted to cloud-zone pairs: every `home` replica async, a `home` primary unable to use `sync`, and that zone's RPO the lag rather than zero. | 3 days. Blocks C7. Owner: data path; the real homelab link and `network/probe-mtu`. |

### 15.3 Order and concurrency

Run risk-weighted, not in phase order: the cheapest test that can invalidate the most design goes
first, and anything with a soak starts early so the soak runs behind other work.

| Order | Spike | Start | Duration | Why here |
|---|---|---|---|---|
| 1 | S3 | now | 2 d | Cheapest, no infrastructure to book, and a failure rewrites C6 and C8 |
| 2 | S1 | now | 2 d + 14 d soak | The soak is the long pole; C2 cannot start until it passes |
| 3 | S2 | after S3 | 3 d | Shares the bucket and the rig with S3; together they decide C6 |
| 4 | S4 | week 1 | 4 d | Needs the second ingress host; C5 is the next gated phase |
| 5 | S6 | during C1 | 3 d | Needs the real overlay; no other spike depends on it |
| 6 | S5 | before C9 | 5 d | Needs a RustFS host with four drives; nothing else waits on it |

About 19 engineer-days, five weeks calendar with S1's soak and S2/S4 overlapping. A result recorded
out of order is fine; the order sets start dates only.

### 15.4 What a failed spike changes

A failed spike is a branch, not a delay, and the branch is agreed before the experiment starts.

| Spike | If it fails | What changes |
|---|---|---|
| S1 | Bun forwarder | C2 grows about 5 days, +10–15 MB RSS per node, the peer check becomes ours; order unchanged |
| S2 | Staging restore and swap | Control-plane RPO becomes the interval (30–60 s), promotion waits for the last swap, C6 grows 5 days, §6.1's standby table changes |
| S3 | No object-store lease | Fail closed: no automatic promotion. Control-plane promotion is manual with a confirmed-dead isolation step, the database and ACME leases go with it, C8 loses automatic control-plane failover, and §11's ≤ 45 s becomes 10–20 min |
| S4 | Origin CA, or per-ingress ACME | Proxied installs get a 15-year Origin CA certificate and lose ACME; DNS-only installs are capped at one ingress, so C5 ships for proxied installs only |
| S5 | Scheduled sync every 15 min | RustFS is `L1` at a 15-minute RPO, the `L2` replica row in §8.1 does not apply to it, C9 still ships |
| S6 | `sync` only between cloud zones | `home` replicas are async, a `home` primary cannot use `sync`, and that zone's RPO is lag rather than zero |

---

## 16. Proposed decisions

H1–H16 are proposals, not decisions. D107 records the direction and names them; none is a decision
until its phase ships, and code cites `Hn` until then. None is built end to end: where a prerequisite
already ships (Litestream for the control plane, single-node replicas), §3 and §13 say so. Every
acceptance signal below is a test that does not exist yet.

### 16.1 Proposals, phases and traceability

This table is the traceability matrix: proposal, phase, gating spike, and the number it becomes. The
last column reads "next free" in every row on purpose (§16.2).

| # | Proposal | Acceptance signal | Phase | Spike | D when built |
|---|---|---|---|---|---|
| H1 | Nodes report hardware facts; `skiff.io/*` labels are derived and read-only. | Every node reports `hardware.v1`; a write to a `skiff.io/*` label is refused 422 naming the fact. | C0 | — | next free |
| H2 | Zones, roles and labels are operator-set; `mode` and `can_build` stay stored and are surfaced as roles/labels. | Adding `data` changes the next placement with no restart; removing a role in use is 409 listing the pinned resources. | C0 | — | next free |
| H3 | Volumes have a class (`fast`/`bulk`/`remote`), derived and overridable. | Class is derived per volume, an override survives a rescan and a restart, and `volumeClass: fast` refuses a `bulk` volume by name. | C0 | — | next free |
| H4 | Placement is a constraint spec filtered and scored once, at deploy time, with explained refusals; no continuous scheduler. | A refusal returns `placement_refused` with one reason per node and never "no capacity"; the same input on an unchanged fleet picks the same node. | C0 | — | next free |
| H5 | The overlay is hubs plus LAN mesh, computed by the control plane and applied by the helper. | Killing one hub leaves every pair reachable within 30 s, and LAN traffic increments no hub counter. | C1 | — | next free |
| H6 | Cross-node services are reached through loopback endpoints on the consumer node (L4 plus mTLS over the overlay); failover is an upstream change. | An app reaches a database on another node at `127.0.0.1:<port>`, `ss -ltn` shows no public listener, and a re-point needs no app restart. | C2 | S1 | next free |
| H7 | Shares are platform resources mounted on demand, multi-writer by opt-in, and add their zone to a workload's blast radius. | A share mounts read-only into two workloads on two nodes, fails closed when the server goes, and appears in both blast radii. | C3 | — | next free |
| H8 | Skiff can export a `bulk` volume over NFS on the overlay only. | `exportfs` lists the overlay CIDR only, an off-overlay mount is refused, and no public address answers. | C9 | — | next free |
| H9 | The control plane is active–passive: one primary, warm standbys following Litestream. | Standby replay lag ≤ 5 s; promote in ≤ 45 s with every agent on the new epoch; the old primary answers writes 503 with `x-skiff-fenced`. | C6 | S2 | next free |
| H10 | An object-store lease plus an epoch on all desired state; agents refuse lower epochs; a primary that cannot renew becomes read-only. | 200 concurrent CAS attempts produce one holder; 20 s without renewal means no writes; a lower epoch in desired state is refused. | C6 | S3 | next free |
| H11 | Every ingress node is a full edge, with a shared site-cookie key and node-bound callback tokens. | Power off `edge`; every static site and `L3` app answers through `edge-b` within the driver's bound, and a cookie set by one is accepted by the other. | C5 | S4 | next free |
| H12 | Ingress steering is a driver: `direct`, `dns-failover`, `cloudflare-lb`, `cloudflare-tunnel`. | Observe-only for 24 h logs the exact record diff and writes nothing; the last healthy record is never withdrawn; one ingress refuses to enable. | C5 (`dns-failover`); the other two after C10 | S4 | next free |
| H13 | Certificates are issued once per install and distributed to ingress nodes. | Every ingress reports one fingerprint; removing the role deletes the key files; a renewal reaches every ingress within 6 h. | C5 | S4 | next free |
| H14 | HA levels L0–L3 per resource; L0 is the default and stateful L2/L3 require L1 backups. | Every resource shows its level and the next level's blocker; a stateful `L2`/`L3` without a verified `L1` backup is refused by name. | C0 (model); C4, C7, C9 (enforced) | — | next free |
| H15 | Automatic re-placement is opt-in per workload, there is no automatic move back, and singletons self-fence on a run lease. | Killing a node keeps an `L3` app serving; a singleton never runs twice in a partition test; a returning node is not moved back automatically. | C4 | — | next free |
| H16 | Postgres HA is streaming replication orchestrated by the control plane, with three-signal detection and a generation fence; no Patroni or etcd. | Switchover loses zero commits; a manual promote after killing the primary serves writes; `pg_rewind` heals in ≤ 60 s. | C7 | S6 | next free |

Two proposals were narrowed while §3–§9 were written; the narrowing is part of the record, not a
silent edit. **H2** was narrowed: `mode` and `can_build` stay stored (§3.2). **H14**'s backup gate
applies to stateful resources, since an `L3` static site has nothing to back up (§8.1). **H16**
amends D97, which keeps its stop, dump, restore and purge move where no replica exists.

### 16.2 Promotion rule

A proposal becomes a decision through three gates, in order, none skippable.

1. **The spike passes**, or its fallback is accepted and each section it changes is edited to match.
   A proposal whose gating spike has not run cannot be promoted; it can only be deferred or dropped.
2. **The phase ships.** On by default for one install, tests in CI, §12 alerts in a drill, and the
   §18 runbook written. A merge behind a flag nobody sets has not shipped.
3. **The number is assigned** in the change that removes the flag: the proposal text is copied into
   [DECISIONS.md](./DECISIONS.md) at the next free number, marked `Refines D107`, with the evidence
   that satisfied gate 2. Numbers follow shipping order, not §16.1's order.

D107 is the umbrella. It states the direction, names H1–H16 and says they are promoted as they
ship; that sentence is the process other documents need. No spike, phase or surface gets a D-number.

### 16.3 Reverse index

C0: H1–H4, H14's level model. C1: H5. C2: H6. C3: H7. C4: H15, H14 for workloads. C5: H11–H13.
C6: H9, H10. C7: H16. C8: none new, being the `auto` modes of H10, H15 and H16. C9: H8 and H14's
storage rows. C10: none new, being H16 applied per engine (§9.1).

Two phases add no proposal, deliberately. C8 turns on automatic failover that H10, H15 and H16
already define, and C10 applies H16's mechanism per engine that gains a `replication` capability. If
either needs something new it goes to §21 under the nearest H, never as a new number.

---

## 17. Security and threat model

Clustering turns one trusted host into a fleet of partly trusted ones. Today a compromised VPS is a
compromised install and nothing else exists to attack; from C2 a node certificate is the only identity on
the endpoint path, from C6 a standby holds the master key, and an object in R2 decides who may write. §4.5
says what crosses each boundary; this section says what each is worth, and what an operator does when one
fails.

### 17.1 Assets

| Asset | Lives in | Why it matters |
|---|---|---|
| Master key (KEK) | `/etc/skiff/master.key` 0400 root as a systemd credential; one copy per control node | It unwraps every org DEK, the node CA key and the sealed config. One host with it is the install. |
| Org DEKs and secrets | SQLite, wrapped by the KEK | Every stored and deployment secret, and every database credential. |
| Platform state and credentials | `skiff.db`; R2, Cloudflare, SES and GitHub credentials in `skiff.env` and `agent.env`, 0640 root:skiff | Every org and audit row, plus releases, backups, DNS and build sources. Losing DNS loses every hostname at once. |
| The lease object | `skiff/ha/control-lease.json` in R2 | Who may write the control plane. Forging it chooses the writer. |
| Node and ingress key material | Node disks; `nodes.token_hash`; the peer list; a sealed copy in SQLite | A node's token, leaf and WireGuard key, and the wildcard certificate key with `SKIFF_SITE_COOKIE_SECRET`. |
| Managed data | Data nodes, RustFS buckets, D83 dumps, the Litestream replica | Tenant data at rest, and the only copy of some of it. |
| Signing keys and the audit log | GitHub Actions secret and the bundle in R2; `audit_log` in SQLite | The root code path onto every node, and the only account of who did what. |

### 17.2 Actors

| Actor | Holds | Can reach | Cannot |
|---|---|---|---|
| Internet attacker | a path to 80/443 | the ingress, a public S3 route, the dashboard | a node port, the overlay, the object store |
| Org member | a session, API key or MCP token, org-scoped | own projects, secret metadata, own attachments and audit trail | another org, fleet topology, node state |
| Platform admin | a dashboard session | every fleet action, topology, the break-glass log | nothing beyond the session-only rule; the role is trusted |
| Tenant workload | its activation, its org's loopback endpoints | its own secrets and its attached services | other orgs, `:8080`, the overlay, the helper socket |
| Node agent and helper | a node token; root only inside fixed verbs (D43) | the control plane, its own units and attachments | another node's units or desired state |
| Control plane | master key, CA key, lease, every DEK | everything, by design | nothing: it is the trust root and is not contained |
| Cloud dependencies | R2, Cloudflare, the VPS provider | platform state and backups in the clear, sealed secret values, steering, the hypervisor | the master key; a sealed column without it |
| Insider with host root | root on a control node | the install | nothing technical; only detection and rotation |

### 17.3 Trust boundaries

- **Node.** Its units, keys and the plaintext of what it hosts; enforced by cgroups and fixed helper verbs.
- **Zone.** Administrative, not technical — every spread cell in §8.1 and §11 is wrong if the claim is.
- **Overlay.** Encrypted, not authorising: per port and per source (§4.3, §4.5), mTLS as the second layer.
- **Control plane and object store.** The control plane holds the master key and the CA, so nothing separates
  it from the install; the store holds platform state and backups in the clear (the SQLite replica,
  releases, D83 dumps) plus sealed secret values, and is a witness, not a principal. A leaked store
  credential is a confidentiality event comparable to a control-node disk, not a ciphertext-only one.
- **Cloudflare.** Terminates TLS for proxied records and holds the DNS authority DNS-01 depends on.
- **Human.** Platform admin is not org owner (DESIGN §6.2); fleet mutations need the admin's own session.

Epochs are an **integrity** mechanism, not an authentication one: a deposed primary still holds a valid token
and certificate, and loses only the right to be believed. Never use the epoch as an access decision.

### 17.4 Threats

| Threat | Preconditions | Impact | Mitigation | Residual | Detection |
|---|---|---|---|---|---|
| Node compromise | root or code execution on a non-control node | its own secrets and its attachments' plaintext; it can answer its consumers wrongly | D26/D43 (unprivileged agent, fixed verbs), D87 (restarts are desired-state generations), per-attachment `/32`, activation-time secrets, no node token in workloads (D93) | it reads what it serves, and a poisoned answer looks like an app bug | `skiff_agent_epoch` moving with no promote, `ha.endpoint_down`, unexpected helper verbs; token rotation (D86) evicts it |
| Control-plane compromise | code execution there, or a platform-admin session | master key, CA key, lease and every DEK: the install | D26 sandboxing, session-only fleet mutations (DESIGN §6.2), no mutation over MCP (D53), owner second factor (D10), audit | nothing contains it; network rules are irrelevant once it is the writer | `ha.promote` with no matching operation, an epoch no human bumped, fingerprint drift |
| Object-store compromise | a leaked R2 key, or the Cloudflare account | the lease (choosing the writer), the SQLite replica, releases, backups | bucket-scoped token (OPS §2.3), CAS plus epoch (H10), agents refuse a lower epoch, fingerprints before any restore | a forged lease plus any `control` node is a takeover, and backups can be deleted | a holder change with no `ha.promote` row, ETag churn, R2 access logs, a fingerprint mismatch |
| DNS or Cloudflare compromise | the DNS token (in `agent.env` on every ingress) or account takeover | redirect or impersonate any site, remove records, issue certificates for the zone via DNS-01 | token scoped to `Zone:DNS:Edit` on one zone, never in desired state; proxied origins hide the origin IP (D8); Origin CA option (H13) | impersonation is invisible from inside Skiff; watching certificate transparency is manual and unbuilt | `ha.dns_update_failing`, an unexpected record set, a certificate mismatch at the probe (§7.4) |
| Supply-chain compromise | a malicious release, dependency, image or Caddy plugin | root code on every node | signed releases verified on the node (D99), the helper derives the image (D61), pinned Bun, Caddy and plugin versions (OPS §13) | a stolen signing key, or the pinned registries; OS packages are the operator's | a signature verification failure, an unexpected version, an update nobody requested |
| Tenant isolation failure | a deploy, a container escape, a scoping bug | another org's secrets or data | per-workload units and cgroups, no capabilities, read-only root, `InaccessiblePaths`, secret scoping (D88), never the node token in a workload (D93) | a shared kernel: container-grade isolation, not VM-grade | audit review, an unexpected endpoint, a helper refusal, an error spike after a deploy |
| Secret leakage | a bug, a mis-scoped surface, an app printing its env, a log capture | use of that credential within its scope | envelope encryption (D18), write-only secrets, injection at activation (D43/D66), audited reveals (D58/D67), key-name redaction in audit arguments | redaction matches `secret\|password\|token\|key\|authorization`, so an oddly named field leaks; log drain forwards app stdout by design | `database.credentials.reveal`, `storage.key.reveal`, `cli.login`; use from an unexpected node is not detected |
| Overlay sniffing or MITM | a peer's private key, or a compromised hub | plaintext of node-to-node traffic | per-peer WireGuard keys, mTLS on the endpoint hop (§4.3), TLS pinning for agent-to-control, a hub relays overlay only (nftables) | a stolen node key makes the overlay readable, which is why mTLS is not optional | `skiff_wg_handshake_age_seconds`, an unknown peer key, a certificate mismatch |
| Replay | capture of a token or request | a duplicated mutation, a second singleton start, a redeemed callback | one-time join tokens (1 h), one-time CLI codes (5 min, hashed, single use), epoch plus `If-Match`, `Idempotency-Key`, 60 s site tokens | the agent's used-token cache is in memory, so a restart forgets redemptions inside the 60 s window | duplicate audit rows for one operation; no dedupe alert exists today |
| Denial of service | any internet client | ingress saturation, quota exhaustion, a stalled maintenance loop | Cloudflare proxying fronts the origin and caps a proxied body at 100 MB; API keys 100,000 requests a day; the assistant 12 a minute; `MemoryMax` and `TasksMax` per unit | no per-IP ingress rate limit exists today, so a layer-7 flood on one site degrades its node; volumetric DDoS is out of scope | the `traffic_1m` 5xx and request rate, node load, a probe that stops answering |
| Insider access | a legitimate owner or platform admin | any mutation they hold, promote and reveal included | platform admin distinct from org owner (D9), session-only fleet actions, typed confirmation and soft delete (D29/D54), audit with reason | a platform admin is trusted by design, and host root can edit `audit_log` | `ha.*` and `*.reveal` rows, `ha.failover_performed`, a second admin reading the trail |
| Physical access | the machine, its disk, or the provider's console | the master key and CA key on a control node's disk; every secret if both are taken | `master.key` 0400 root, `systemd-creds` (TPM2 where available), the recovery kit offline, wipe with evidence at decommission, KEK rotation when a control node leaves | Skiff provides no disk encryption, so a powered-off control node is an offline target and the VPS console is outside our control | node offline then a lease expiry; a returning node is refused (§6.6); the theft itself is invisible |

### 17.5 Security invariants

| # | Invariant | Enforced by | Test |
|---|---|---|---|
| I1 | No secret value in desired state, a log line, MCP output or an audit argument | injection at activation (D18/D43); `redact` in the audit service; references only in the §5.2 share form | a leak grep over every desired-state render, audit row and MCP response (§19) |
| I2 | No managed data port is public | D56, per-`/32` nftables rules, the consumer-side loopback endpoint | an external scan finds 80/443 and, on a hub, UDP 51820 |
| I3 | One control-plane writer per epoch; a fenced node writes nothing | lease CAS and epoch (§6.3); 503 for every non-GET on a fenced node | `chaos/partition-a-b`: no instant with two writers, no epoch regression |
| I4 | No fleet or data-plane mutation over MCP | D53; `canAdministerPlatform` is session-only (§12.4) | no write tool exists for a node, a control role, a database role, a certificate or the lease |
| I5 | Root work only through the helper's fixed verbs | D26/D43; socket `root:skiff` 0660 | no shell verb exists; `systemd-analyze security` on every unit |
| I6 | Every reveal, role change, promote and certificate issue is attributable | `audit_log` with actor, surface, epoch and reason (§12.6) | an action with no row fails the §19 suite |
| I7 | A removed node holds no route | token revoked, peer and `/32` removed, certificate expiry as the outer bound (§4.5) | a removed node's key cannot handshake and its leaf opens nothing |
| I8 | A tenant reaches only its own org's attachments and secrets | secret scoping (D88), per-attachment `/32`, per-workload units | a two-org fixture reaches its own services and nothing else |

### 17.6 Audit and logging

Today every mutating surface writes one `audit_log` row as `resource.action`; MCP records `mcp.<tool>` with
the client id, credential reveals are rows of their own (`database.credentials.reveal`,
`storage.key.reveal`), node changes are `node.update` and `node.set_edge`, and CLI approval is `cli.login`.
Arguments are redacted by key name and truncated at 2,000 characters, and the table is in SQLite, so
Litestream replicates it and a promoted standby has the trail within the 1 s RPO.

The gaps are worth naming. There is no hash chain and no export, so host root can rewrite history; retention
is whatever the table holds; failed sign-in is a journal line, not a row; and redaction is a key-name match,
so the structural rule matters more than the filter — a secret must never be an argument. The plan adds the
chain, a daily NDJSON export (FEATURE-RESEARCH P1), the `ha.*` and `node.*` rows of §12.6, and `security.*`
rows for certificate issuance, token rotation and a refused overlay connection. Audit is not a paging path:
`skiff-alert@.service` runs on the host that failed, so §12.5 adds a dead-man's switch.

### 17.7 Keys and certificates

| Asset | Generated | Stored | Lifetime | Rotation | Revocation |
|---|---|---|---|---|---|
| Master key (KEK) | installer, 32 random bytes | `master.key` 0400 root as a credential; one copy per control node | until rotated | `skif admin keys rotate` (planned; OPS §11) | none; the recovery kit is the way back |
| Org DEKs | control plane, at org creation | SQLite, wrapped by the KEK | until re-wrapped | re-wrapped in the KEK rotation's transaction | org delete |
| Node CA, ECDSA P-256 | control plane at install (C2) | sealed with the master key in SQLite | 10 years | a second CA as `nextCaPem`, the old trusted until its last leaf expires | replace the CA |
| Node leaf certificate | the node's key pair and CSR at join | node disk; serial in SQLite | 90 days, renewed at 60 | re-issue to a re-keyed node | removing the node removes its `/32` and peer; expiry is the bound |
| WireGuard peer key | helper `keygen` (C1); by hand today | private key 0600 root on the node; public key in desired state | node lifetime | re-key on rebuild | peer removal |
| Ingress TLS key | ACME DNS-01 by the `acme` lease holder (H13) | sealed in SQLite, distributed through activation | 90 days, renewed with 30 left | renewal; every ingress holds the same key | reissue retires the old key |
| Session and cookie secrets | installer: `BETTER_AUTH_SECRET` 48 bytes, `SKIFF_SITE_COOKIE_SECRET` 32 bytes | `skiff.env` on control and ingress nodes | until rotated | replace and restart; sessions or cookies are invalidated | replace |
| Node and join tokens | control plane; only hashes stored | `nodes.token_hash`, `node_join_tokens` | until rotated; a join token is 1 h, single use | `POST /nodes/:id/rotate-token` | rotate or delete the node |
| Provider and replication credentials | operator (R2, Cloudflare, SES); control plane (replication, sealed with the org key) | `skiff.env` / `agent.env`; SQLite, fetched at activation | until rotated | rotate in the provider; staged rotation (D86) | revoke in the provider; drop the role |

Generate on the node what must never travel — the WireGuard key and the leaf's key — and seal everything else
with the KEK, delivering it only through activation. Removing a control node rotates the master key, because
every DEK was decryptable on it; a failed rotation keeps the old key until the new one is proven (OPS §11.3).

### 17.8 Incident response

| Class | Example | First action |
|---|---|---|
| Key exposure | the master key, CA key, ingress key or an R2 credential is seen by the wrong party | rotate before repair: node tokens, leaves, CA, then the KEK (OPS §11); rebuild rather than clean in place |
| Integrity | two primaries, a lease holder nobody promoted, an epoch that moved without a person | treat it as a partition and follow §6.6; never restart either control plane |
| Node compromise | a workload escape, a stolen node token, an unexpected helper call | `skif ha fence <node>` (C6), rotate its token, remove its peer and `/32`, rebuild with a new identity |
| Data exposure | one tenant reaches another's rows | stop the workload, preserve evidence, rotate every secret of the affected org, review the audit window |
| Supply chain | a release or image nobody asked for | stop the updater, keep the previous release, verify signatures, rebuild from a known-good bundle |

The order is preserve, contain, rotate, rebuild, notify, review — restarting first destroys the evidence of
whether data diverged. Collect `ha/status` from both control nodes with the lease ETag, the lease object, the
`audit_log` slice, the journals, a fingerprint and `/var/lib/skiff/ha/break-glass.log`. Notification is thin by
design: one operator and one org are the normal case, and a data-loss decision needs a second person (§9.3).

### 17.9 Out of scope

Not defended: volumetric denial of service, which one node cannot absorb and Cloudflare already handles; a
hostile hypervisor or VPS provider; the OS, firmware and pinned registries below the signed-release boundary;
kernel exploits and side channels, because isolation is container-grade; a platform admin with host root,
malware on an operator workstation, mail spoofing, legal holds and forensic preservation; and the physical
security of the homelab or the provider's datacentre.

---

## 18. Operations runbooks

Fourteen procedures, each naming its surface: **dashboard** (session only), **`skif`** (remote), or **root on
the host** (§18.14). REST paths omit `/api/v1`, and every runbook ends in the audit trail (§12.6).

### 18.1 Add a node

**When** new hardware, or a replacement with a new identity (§3.9). **Before** power and a name.
**Time** 10–20 min. **Risk** low.
1. `POST /nodes/join-token`, install the agent (OPS §3.2), then `skiff-agent join` with the token.
2. Wait for `online` and the §3.9 checks, including the `ha-epoch` and `l4-endpoints` capabilities.
3. `PATCH /nodes/:id` with `{ zone, roles, labels }` (C0); confirm `eligible` and one deploy.

**Verify** heartbeat under 30 s, handshake under 180, no `hardware_error`. **Roll back** `DELETE /nodes/:id`.

### 18.2 Change a node's zone, roles or labels

**When** a machine moved, a role is added, or a failure domain was declared wrongly. **Before** reading §3.4.
**Time** 1 min. **Risk** medium for `zone`, low for labels.
1. Record the current values and what is placed there (`GET /topology?node=<id>`).
2. `PATCH /nodes/:id`; a zone change that breaks spread is refused, and a role removal waits on D97.
3. After `zone`, rebalance any `ha.spread_degraded`; after `ingress`, §7.4; after `control`, §6.5.

**Verify** `GET /topology` shows the change and no `ha.spread_degraded`. **Roll back** `PATCH` the old value.

### 18.3 Drain and undrain

**When** maintenance, a UPS event, a zone move, or before decommissioning. **Before** target headroom.
**Time** 5–45 min. **Risk** medium.
1. `POST /nodes/:id/drain` with `{ mode, deadlineSeconds }`: cordon, drain or evacuate (§8.5).
2. Pinned resources are listed, not moved; the deadline leaves blockers and only `evacuate` stops them.
3. `POST /nodes/:id/resume` when done; it is idempotent and cancels an expired drain.

**Verify** no workload names the node and every moved copy is ready. **Roll back** `resume`.

### 18.4 Decommission a node

**When** retiring hardware or a zone. **Before** the drain, an `L1` backup of anything `L0`, a replacement.
**Time** 1–3 h plus the key window. **Risk** high. The order is §3.9's.
1. Drain (§18.3); promote off it (§18.5), move the ACME lease (§7.4), hand the edge over (D98).
2. Leave every `synchronous_standby_names` quorum before removing it (refusals: §3.9).
3. `POST /nodes/:id/rotate-token`, then `DELETE /nodes/:id`.
4. A control node takes the KEK with it: rotate it (OPS §11), then `sudo skiff-uninstall --purge --yes`.

**Verify** the token fails, the peer cannot handshake, no replica names it. **Roll back** none; re-add anew.

### 18.5 Promote the control plane

**When** the primary is dead in `manual` mode, or a planned hand-off. **Before** `canPromote: true` and a
route that does not use the failed node. **Time** 1–5 min. **Risk** critical. Mechanism §6.3, table §6.6.
1. `skif ha status` (C6) or `GET /ha/status`: note the epoch, the holder and each replay lag.
2. `skif ha promote --expect-epoch <n>`; it sends the read ETag as `If-Match`, so a stale ETag is a
   412 and a wrong `--expect-epoch` is a 409.
3. `skif ha status --wait` until every node reports the new epoch, and confirm singletons moved.

**Verify** one `primary`, every agent on the new epoch, a write. **Roll back** none; see §18.8.

### 18.6 Fail over a database

**When** the primary's node or process is gone and the database is `L2`. **Before** a healthy replica, an
`L1` backup and control-plane access. **Time** 2–5 min auto, 5–15 manual. **Risk** high; runbook §9.6.
1. Confirm which signal fired and that the control plane is healthy; if it is not, run §18.5.
2. With `auto` and three or more data nodes, watch it finish; otherwise decide, and write down why.
3. Promote with `If-Match: <primary_generation>` and `{ acceptDataLoss: true }` past 64 MB or 60 s of lag.

**Verify** `pg_is_in_recovery()` is false and a canary row round-trips. **Roll back** the decision, not the data.

### 18.7 Switch over

**When** planned maintenance, a node drain, or a major-version move. **Before** a caught-up replica, a
quiet write period and `database:update`. **Time** 1–2 min. **Risk** medium.
1. `POST /databases/:name/switchover` with `{ node, expectedGeneration }`, or `skif db switchover`.
2. It waits for `replay_lsn = pg_current_wal_lsn()`, refuses a non-zero gap; the old node becomes a replica.

**Verify** zero lost commits, replication from the new primary, consumers re-pointed.
**Roll back** with another switchover once the old node has caught up.

### 18.8 Recover from a suspected split brain

**When** two `primary` roles, `ha.lease_contested`, two `ha.promote` rows at one epoch, or mixed epochs.
**Before** root on both hosts and the lease ETag. **Time** 30–60 min. **Risk** critical. Table: §6.6.
1. Read both: `curl --unix-socket /run/skiff/control.sock http://localhost/api/v1/ha/status`.
2. Pick the winner by matching epoch and `holderNodeId`, else the highest epoch with the newest lease.
3. Freeze the loser: `sudo systemctl stop skiff-control-plane skiff-litestream`, then mask both units.
4. Compare its `audit_log` and fingerprint, then replace — never merge — by restoring the replica at the
   winner's epoch and re-enrolling it as a standby.

**Verify** one primary and every agent on the winner's epoch.
**Roll back** none: a fenced or demoted primary never resumes on its own, which is what makes healing safe.

### 18.9 Replace a failed node

**When** dead hardware and a new machine will take its place. **Before** the failure is confirmed dead, not
partitioned, and surviving replicas exist. **Time** 20 min stateless, hours with data. **Risk** high.
1. Treat anything `L0` as lost unless an `L1` backup exists; re-place first, because `DELETE` refuses.
2. Leave every sync quorum, confirm replicas elsewhere stream, then rotate its token and delete it.
3. Join the replacement (§18.1); a former control node, replica or sync member leaves those roles first.

**Verify** no state names the old id and the replacement passes its checks.
**Roll back** none: the old identity is never reused, and a returned machine rejoins as a new node.

### 18.10 Restore from backup

**When** data loss, corruption, a failed upgrade, or a lost control-plane host. **Before** the newest backup.
**Time** 15–60 min. **Risk** high. Restore to new, never in place.
1. `sudo skiff-restore --yes [--from <replica>] [--recovery-kit <file>]`; reverts on a failed check.
2. Raise the epoch before serving: `skif ha claim --from-store --expect-epoch <n>`, or §6.5's CAS.
3. A managed database: restore the D83 dump into a **new** database and re-attach, then fingerprint both.

**Verify** `PRAGMA integrity_check` is `ok`, fingerprints match, the epoch exceeds every agent's.
**Roll back** to the pre-restore snapshot it already took.

### 18.11 Rotate certificates and keys

**When** suspected exposure (§17.8), a node leaving, or a scheduled rotation. **Before** a passing drill.
**Time** 5 min for TLS, 30–60 for the KEK. **Risk** high for the KEK.
1. Least privileged first: `POST /nodes/:id/rotate-token`, then re-key a leaving node (§4.5).
2. Ingress TLS: `POST /ha/certificates/rotate` (C5), or let the `acme` holder renew and distribute it.
3. Application secrets: replace `BETTER_AUTH_SECRET` or `SKIFF_SITE_COOKIE_SECRET` and restart (§7.1).
4. Master key last: `sudo skif admin keys rotate` (planned; OPS §11.2), then re-export the recovery kit.

**Verify** a secret-backed deployment activates, one fingerprint everywhere, a matching recovery kit.
**Roll back** keep the previous key for one window (OPS §11.3).

### 18.12 Disable HA

**When** retiring the standby, debugging a contested lease, or preparing a downgrade (§20). **Before** a
verified backup. **Time** 10–20 min. **Risk** medium: you lose the failover target.
1. Set every `L2`/`L3` resource to `failover: manual` and confirm nothing is mid-failover.
2. Stop the standby's units, drop its `control` role, and write the lease as a **tombstone** at the same epoch
   with `holderNodeId: null`; never delete it, because a fresh lease at epoch 1 is refused fleet-wide.
3. Confirm every agent lists one control endpoint and desired state still carries the epoch.

**Verify** `GET /ha/status` reports `mode: single` and a tombstone. **Roll back** re-enrol (§6.5).

### 18.13 Run a drill

**When** monthly for control promotion, ingress loss and restore; quarterly for zone loss, object store down
and split brain (§12.7). **Before** a window, a scratch target and the real key. **Time** 30–60 min.
**Risk** medium: it exercises production paths.
1. `skif ha drill <kind>` (C8) scripts it; until then follow the matching runbook with scratch names.
2. Use the real lease, epoch bump and promotion — a drill key proves nothing — measure each stage against
   §11.1, write the `ha_drills` row with RTO and RPO, and tear down.

**Verify** the §12.7 pass condition and a measured RTO at or under the §8.1 target.
**Roll back** as the runbook says, and record a failed drill as failed.

### 18.14 Break-glass access

**When** the dashboard and API are unreachable, or a promote is needed with no session. **Before** root on a
host, key-only SSH (OPS §12) and a second person for anything lossy. **Time** 5–15 min. **Risk** critical.
1. Reach a host without the failed node: WireGuard SSH, else the console or the path recorded in §7.4.
2. Read the state: `curl --unix-socket /run/skiff/control.sock http://localhost/api/v1/ha/status`.
3. `sudo skif ha promote --force --expect-epoch <n>` (C6); it prints the lease and candidate lag, requires
   the node name typed, and appends to `/var/lib/skiff/ha/break-glass.log`.
4. If no control plane can run, `sudo skiff-restore --yes --recovery-kit <file>` and `skif ha claim` (§6.5).

**Verify** one primary, the action in `audit_log` with actor and reason, every agent on the new epoch.
**Roll back** none: record what was done and review it.

---

## 19. Testing and verification

§4–§10 are safety claims before they are features: one writer, one epoch, one primary, one copy of a
singleton. This section fixes what a pass means, how faults are injected, the lab they run on, the gate
each phase clears and the evidence that outlives the run.

The tree has `bun test`, `tests/e2e/managed-data.e2e.ts`, `tests/rest.e2e.ts`, `tests/mcp-oauth.e2e.ts`,
the monthly restore drill and `scripts/skiff-db-fingerprint.ts`, but no chaos harness, no multi-node lab
and no systemd lane in CI. The layers, in gate order: unit and contract in `bun test` on every push,
with `packages/contracts` as the contract; integration with two control planes and a real agent against
real Postgres and RustFS; the systemd layer, which hosted runners cannot provide honestly; then chaos,
72-hour performance and security (negative mTLS, `ss`/`nmap`, a desired-state grep). C1 builds the lab,
C2 the fault helpers, C8 the suite that gates `auto`.

### 19.1 The invariants a test asserts

§6.6 names the five properties that make control-plane divergence impossible and §11.3 the ordering
rules that hold them. A phase is done when its invariant has a test that fails when the invariant
breaks.

| # | Invariant | Enforced at | Asserted by |
|---|---|---|---|
| I1 | At most one control-plane writer per epoch | lease CAS, §6.3 | `chaos/partition-a-b`, T6 |
| I2 | The epoch is strictly monotonic | CAS increment, §6.3 | `chaos/partition-a-b`, `contract/epoch` |
| I3 | At most one primary per database generation | database lease, §9.3 | `chaos/db-primary-kill` |
| I4 | A singleton runs at most once | run lease, §8.4 | `chaos/singleton-partition` |
| I5 | A single-writer volume is read-write on at most one node | mount protocol, §5.4 | `chaos/volume-failover` |
| I6 | No acknowledged write is lost beyond the stated RPO | `sync`/lag, §9.2; replication, §10.2 | `chaos/db-primary-kill` plus a checksum |
| I7 | A fenced node performs no writes | route layer, §6.3 | T5, `chaos/kill-control-process` |
| I8 | Only the lease holder replicates SQLite | unit supervisor, §6.2 | T5, `sec/second-writer` |
| I9 | No managed data port is reachable off-node | D56, §4.3 | `sec/port-scan` |
| I10 | State from a lower epoch is never applied | agent, §4.2 | `integ/epoch-regression` |

Plant the bug each test exists to catch — the deleted epoch comparison, the unconditional lease
write — and confirm it fails; a test that passes against broken code tests the harness.

### 19.2 Scenario matrix

Rows are scenario families, columns the phase where each becomes a gate. A dash means "not exercised in
that phase", never "untested".

| Scenario family | C0–C1 | C2–C3 | C4–C5 | C6–C7 | C8 | C9–C10 |
|---|---|---|---|---|---|---|
| Placement, admission, blast radius | unit, fixtures | — | admission under failover | — | `drill/zone-loss` | — |
| Desired state, epoch fencing | contract | contract, integ | run-lease integ | `integ/epoch-regression`, T5 | `chaos/partition-a-b` | contract |
| Promotion, demotion | — | — | — | T1–T8 | `drill/control-promotion` | — |
| Endpoints, re-point | — | Postgres over L4, `sec/port-scan` | re-point integ | — | `chaos/db-primary-kill` | `chaos/storage-node-kill` |
| Ingress steering, certificates | — | — | observe-only 24 h, cross-ingress cookie | — | `chaos/kill-edge`, `chaos/cert-expiry` | — |
| Replicas, rollout, drain, singletons | unit state machine | — | eject, drain, `chaos/singleton-partition` | — | `chaos/kill-edge-b` | — |
| Database replicas, failover | — | — | — | S6 rig, `chaos/db-primary-kill` | `drill/drop-table` | per-engine drills |
| Single-node regression (every phase) | — | — | — | — | — | — |

The last row is the one most likely to be skipped: every phase adds a single-node case with HA off,
asserting no lease object, `epoch: 0` and no new unit.

### 19.3 The lab and the faults

Three VMs and a host that is never a fleet member: `lab-a` (`cloud-a`, ingress, control primary, data),
`lab-b` (`cloud-b`, ingress, standby, replica), `lab-c` (`home`, compute, data, build, NATed uplink, so
S6's residential numbers are honest) and `lab-ctl` for injection, the S3 proxy, the DNS stub and the
artefacts. VMs for node loss; containers for everything else, and those are what CI runs.

| Fault | Injected by | Proves |
|---|---|---|
| Process crash | `kill -9`, `systemctl kill -s KILL` | Restart behaviour, in-flight writes, orphaned slots |
| Node loss | `virsh destroy`, provider API stop | Heartbeat loss, lease expiry, promotion |
| Partition | `nft` DROP one direction, then both | Asymmetric failure — the case that produces split brain |
| Slow link, loss | `tc qdisc netem delay, loss, corrupt, duplicate` | Lag, timeouts, retry storms, `sync` blocking |
| Clock skew | `libfaketime` on the control-plane process, or a VM RTC offset | Store-clock authority, `ha.control_clock_skew` |
| Disk full | Loopback ext4 at the data dir, filled with `fallocate` | Fail-closed writes, slot caps, Litestream behaviour |
| Object-store loss | `s3lab` returns 412, 500, 501, delay or divergent ETags | CAS semantics, fencing at 20 s, no promotion |
| Crash mid-promotion | `SKIFF_FAULT_AT=promote:after-cas`, inert unless `SKIFF_FAULT_INJECTION=1` | Recovery from the worst intermediate state |

Certificate expiry, DNS and stepped clocks reuse the same rig (a 10-minute lab CA, a stub resolver, a
step during a lease write). The record says what each cannot fake: page cache survives `kill -9`, a
hypervisor stop is not a provider partition, and the crash hook is a test seam.

### 19.4 Acceptance gates per phase

§14 holds the exit criteria; this is the suite that proves each one, and the evidence retained.

| Phase | Merge gate | Release gate | Evidence |
|---|---|---|---|
| C0 | Placement, admission and blast-radius units; decision fixtures | A hand-checked fleet reproduces the blast radius | Fixtures, decision rows |
| C1 | Two-node overlay integ; hub loss; MTU probe | A reboot either side restores the tunnel unattended | Handshake matrix, MTU numbers |
| C2 | Endpoint contract; Postgres over L4; `sec/port-scan` | S1's numbers; a re-point with no app restart | S1 report, scan output |
| C3 | Share mount, fail-closed, zone inheritance | Two workloads, two nodes, one read-only share | Mount and refusal logs |
| C4 | Rollout and drain state machine; health and ejection | Killing a node keeps `L3` serving; no doubled singleton | 20-run invariant record |
| C5 | Observe-only diff; certificate fingerprint | 24 h observe-only writes nothing; `edge` off meets the bound | The diff, the timings |
| C6 | T1–T8 against `s3lab`, 20 runs each | Manual promote with agents following; the old primary fences | S2/S3 reports, fingerprints |
| C7 | Replica init, lag sampling, switchover | Switchover with zero lost commits; promote after a kill | LSN evidence, `pg_rewind` timing |
| C8 | The whole suite, 20 runs, no invariant failure | Measured RTO/RPO inside §11.1; 72 h soak | `ha_drills` rows, artefacts |
| C9 | Bucket replication, Litestream app, snapshot shipping | Each restores on another node inside its RPO | Restore timings, checksums |
| C10 | Per-engine dormancy and one drill each | Manual promotion per engine | Per-engine drill records |

### 19.5 CI, flake policy and drills

- `test` (exists) gains the HA unit and contract suites, so they cannot rot in a side job.
- `ha-integration` (new): two control planes, `s3lab`, Postgres and RustFS on `ubuntu-latest`, about 10
  minutes, on `apps/**`, `packages/core/**`, `tests/ha/**` and every `main` push.
- `ha-chaos` (new): a self-hosted runner labelled `skiff-lab` running the VM lane; nightly, on dispatch
  and on a `v*` tag, uploading the record, journals and fingerprints for 14 days; `ha-soak` is weekly.
- `publish.yml` requires `test` and `ha-integration`; enabling an installer default or an `auto` mode
  needs a green chaos run in the release notes, the gate §16.2 demands. Secrets are a dedicated
  `skiff-ha-lab` bucket and zone; a run that finds a production token fails.

1. **Flake policy: no retries on invariant tests.** A second-attempt pass is a flake and fails the gate; retrying is
   how a split-brain test becomes green. Timing asserts 125% of §11.1 and publishes the measurement.
2. **Determinism is recorded**: seeds, fixture, kernel, Podman, Caddy and Litestream versions. A flaky
   test is tagged `ha-flake` and owned for 14 days; invariants cannot be quarantined. The nightly lane
   tolerates 2% flake across 100 runs, and `scripts/e2e/ha/replay.ts` re-runs one case.

The monthly restore drill proves the backup, not a failover. The five HA drills in §12.7 run the real
path with the real key and write one `ha_drills` row each — kind, timings per stage, measured RPO,
assertions, result, artefact. A drill with a separate key, a scratch lease or no agents proves nothing,
which is why §9.6 bans the drill key. A phase exits when a drill of its own mechanism is recorded and
compared with §11.1: C6 a promoted standby with agents on the new epoch, C7 a switchover with an LSN
comparison, C8 the suite repeated twenty times, C9 a restore timed against its RPO.

---

## 20. Compatibility, rollout and upgrades

HA changes the contract between a control plane and every agent in the one direction that cannot be
undone cheaply: the epoch. This section defines how versions negotiate, what a mixed fleet may do, how
an install is upgraded, and how each step is reversed.

### 20.1 The baseline, and what capability negotiation adds

- The updater installs only a newer release and refuses a downgrade by precedence (OPS §4.1), and D99's
  helper refuses a downgrade or a control-plane host, so neither a node nor a fleet can regress by
  accident. Migrations are additive and forward-only with a sealed snapshot before the switch.
- `heartbeatSchema.capabilities` already exists as an optional array in `packages/contracts/src/agent.ts`,
  and `nodes.update` already refuses with `409` when an agent lacks `node-update`. HA reuses both.

Declare (the heartbeat lists what the agent applies), require (the control plane refuses work the fleet
cannot complete everywhere it might place it), degrade (the node is ineligible for that class).

| Capability | Added by | Gates | Refusal when absent |
|---|---|---|---|
| `ha-epoch` | C6 | Control standby, `auto`, L2 and above | Placement excluded; enrolment refused |
| `wg-mesh` | C1 | Skiff-managed overlay membership | The node runs as `external` |
| `l4-endpoints` | C2 | Cross-node attachments, both directions | Refused, or the consumer stays pinned |
| `ha-run-lease` | C4 | `singleton: true` | The singleton is pinned to a capable node |
| `ha-workload-replicas` | C4 | Replicas beyond one node | Single-node replicas only |
| `ha-ingress` | C5 | The `ingress` role | The role is refused |
| `ha-db`, `ha-storage` | C7, C9 | Database and storage member fields | No HA member on that node |
| `probe-peer` | C7 | The third-node signal, §9.3 | Two signals only; `auto` refused |

**HA is a property of the fleet, not of a release.** L0 keeps today's promise; L2, L3, singletons, the
control standby and `auto` are refused while any node that could host the resource is below the floor.
The floor is `settings.ha.minAgentVersion`, defaulting to the C6 release, shown on Settings → High
availability with every node below it. A node below it stays usable for L0, ingress and builds —
ineligible, not degraded — and a control node below it blocks standby enrolment for the whole install.
§13.7 is the canonical capability table; §3.9 and §4.2 name `ha-epoch` and `l4-endpoints` in their checks.

### 20.2 Mixed-version fleets and the single-node path

| Fleet | Allowed | Behaviour |
|---|---|---|
| Control plane ≥ C6, agent ≥ C6 | Everything | Full HA; the epoch is persisted and enforced |
| Control plane ≥ C6, agent < C6 | L0, ingress, builds | HA-ineligible; a fenced primary still refuses its routes |
| Control plane < C6, no node has an epoch | L0 only | HA is off; no `epoch` in state, and agents accept it |
| Control plane < C6, any node has an epoch | Refused | Preflight refuses the downgrade (§20.4) |
| Control nodes on different schemas | Refused | Update order is §20.5 |

An agent newer than the control plane within one minor is always allowed: new fields are optional with
defaults and Zod strips what it does not know. The safety net survives the skew — a fenced primary
refuses heartbeat, desired state, activation and run-lease renewal whatever the agent declares (§6.3),
so an old agent cannot converge intent from a deposed node; it keeps its cache, which is D23 working.

A single-node install takes none of these paths: no lease object, `epoch: 0`, no new unit, no standby or
driver settings, and the HA code paths are skipped entirely. §13.8 owns the enumeration and §19.2 makes
it a gate.

### 20.3 Feature flags

Flags follow OPS §2.5: `SKIFF_FEATURE_<NAME>` in `/etc/skiff/skiff.env`, read once at startup, default
off. Two exceptions define §14's "Default after" row. C0, C1 and C2 ship **enabled** on a multi-node
install, because nothing later works without them; `SKIFF_FEATURE_MULTI_NODE_REPLICAS` is enabled only
for `L3` workloads created after C4, while existing `L0`/`L1` resources keep it off. Every other flag
starts off and is turned on per resource in the §20.6 order. On a multi-node install the set joins the
config digest in `/api/v1/ha/status` (§6.2), because a standby that promotes with a different set
misbehaves at the worst moment. A flag is a kill switch, not a deconfiguration; the safe order to
remove something is §20.5.

| Flag | Phase | Gates | Turning it off |
|---|---|---|---|
| `SKIFF_FEATURE_PLACEMENT_SPEC` | C0 | Placement classes, topology and blast-radius views | Placement falls back to `edge`/`auto`; the rows stay inert |
| `SKIFF_FEATURE_MANAGED_OVERLAY` | C1 | Managed WireGuard; `external` nodes ignore it | Peers stay until the next reconcile |
| `SKIFF_FEATURE_SERVICE_ENDPOINTS` | C2 | Consumer endpoints, cross-node attachments | Attachments stop rendering; apps fail |
| `SKIFF_FEATURE_CLUSTER_SHARES` | C3 | The share resource and on-demand mounts | Mounts stay until unused |
| `SKIFF_FEATURE_MULTI_NODE_REPLICAS` | C4 | Replicas beyond one node, drain, `singleton` | Copies stay; no new placement |
| `SKIFF_FEATURE_INGRESS_HA` | C5 | Steering driver, certificate distribution | The record set is left; `direct` is the fallback |
| `SKIFF_FEATURE_CONTROL_STANDBY` | C6 | Enrolment, lease, epoch | Refused while an epoch is held |
| `SKIFF_FEATURE_DB_REPLICAS` | C7 | Replica creation and failover | Replicas stream; promotion is unavailable |
| `SKIFF_FEATURE_AUTO_FAILOVER` | C8 | The `auto` modes of §6.3, §8.3, §9.3 | Falls back to `manual` |
| `SKIFF_FEATURE_STORAGE_REPLICATION` | C9 | Replication, Litestream, snapshot shipping | Replication stops; bytes remain |
| `SKIFF_FEATURE_ENGINE_MONGODB`, `_VALKEY`, `_MYSQL` | C10 | Per-engine member replication and member ports | The engine runs `L0`; no member port |

### 20.4 Migration order and rollback

1. **Schema only**: additive tables and columns (§13), no behaviour change, snapshot restores.
2. **Dual-emit**: `placement` text plus `placement_json`, `epoch: 0`, `mode` and `can_build` unchanged.
3. **Agent floor**: every agent through D99, control nodes first; capabilities on every heartbeat.
4. **Standby**: `SKIFF_FEATURE_CONTROL_STANDBY` on, enrol, replay current, fingerprint equal (§6.5).
5. **Manual promote** in a window, every agent on the new epoch, then demote.
6. **`auto` on one resource** with a recorded drill, then widen by zone, then resource.

Only step 1 is irreversible; it ships with the snapshot and preflight OPS §4.2.2 already specifies.

| Rollback | Mechanism | Allowed when | Cost |
|---|---|---|---|
| Code | `skiff-update-self rollback` | The previous release knows every applied migration | Seconds; data untouched |
| Schema | `rollback --restore-db` or the sealed bundle | Always, with a stated loss window | Writes since the switch |
| HA configuration | The §20.5 off-sequence | Always | Capacity drops; replicas keep data |
| A promotion | Promote again, at a new epoch | Always | Never restore the old primary's SQLite |

The epoch is a one-way door for code: once an agent has persisted epoch E it refuses any state without
one, so a pre-C6 release cannot serve that fleet — the dashboard works and every agent refuses.
`settings.ha.epochFloorVersion` records the first release that served this install an epoch above zero;
preflight refuses a downgrade below it, and `rollback` exits 1 with the reason. `--force` does not
bypass the floor. The way back is a re-enrolment: restore the control plane, stop every agent, delete
`$SKIFF_DATA_DIR/epoch.json`, re-enrol, and accept the restored SQLite as the source of truth; §18
carries it as a procedure. Code-only releases inside the epoch-aware range roll back normally.

Data rollback is separate: dropping a replica, detaching an endpoint or disabling the standby leaves
data intact, while restoring an `L1` backup discards accepted writes. A promotion is undone by another
promotion, never by a file restore.

### 20.5 Turning a feature off, and upgrading nodes

1. `failover: auto` → `manual` fleet-wide; let in-flight re-placement finish or expire (10 min, §8.3).
2. Drain the standby, then disable it: `mode: single`, the lease released, the epoch frozen.
3. Drop database replicas one at a time after a final backup; the primary is not restarted.
4. Detach cross-node attachments and disable `SKIFF_FEATURE_SERVICE_ENDPOINTS`, then drop the extra
   ingress record and disable `SKIFF_FEATURE_INGRESS_HA`; consumers are re-activated on the provider's
   node.
5. Remove `control` and `ingress` from the second node and decommission it (§3.9).

The residual is stated on the page: one control plane after step 2, one copy of each database after step
3. Turning HA off never turns a backup off, and never deletes a replica's data without an explicit purge.

- **Control nodes** update with `skiff-update-self`, standby first, primary after it reports healthy and
  with no promotion in flight. **Ingress** and **data** nodes update from the dashboard (D99), one at a
  time, an ingress withdrawn from steering first and a data node never the only `sync` replica.
  **Compute and build** nodes update in batches, never mid-build and never mid-rollout.
- A release with migrations cannot follow that order, because a standby never migrates while following
  (§6.5): snapshot, stop the primary, promote the standby so it migrates as the only writer, update the
  old primary, rejoin it as standby, repeat for a third control node.
- Two standbys are not the same: `SKIFF_STANDBY=1` is the updater's same-host slot (OPS §4.1),
  `SKIFF_CONTROL_ROLE=standby` is the HA follower (§6.1). A promoted HA standby clears both; an updater
  slot never takes the lease.

### 20.6 Rolling this onto a live fleet

1. **Baseline**: a drill within 30 days, every agent on a capable release, `VERSION` at or above the floor.
2. **Join the second node** (C1), verify overlay both ways and MTU; reverse by removing peer and node.
3. **Second ingress, observe-only** for 24 h (C5); the diff is empty; reverse by deleting the record.
4. **Enable `dns-failover`** and perform a planned withdrawal and re-add; reverse to `direct`.
5. **Enrol the standby** (C6), verify replay and `canPromote`; reverse by draining and disabling it.
6. **Promote and demote manually**, agents on the new epoch inside §11.1; the demoted node is re-seeded.
7. **Add one replica** (C7) on a non-critical database and switch over with zero lost commits.
8. **Enable `auto` for one resource** (C8) and run a drill; reverse to `manual`.
9. **Add the third zone**, rebalance, verify spread and blast radius; reverse by cordon, drain and
   decommission.
10. **Widen by zone then resource**, recording each drill; reverse with §20.5.

Steps 2, 5 and 7 change the failure modes; steps 3, 4 and 8 change what happens without a human.

### 20.7 Version policy, deprecations and adoption

- **Agents:** one minor behind the control plane, as today (DESIGN §3.3), except that HA resources need
  the `ha-epoch` floor; a node below it keeps working and is named on the page. **Control nodes:** within
  one minor of each other and never on a schema the primary does not ship.

| Field | Deprecated in | Removed when | Replaced by |
|---|---|---|---|
| `placement` text | C0 | Every agent reads `PlacementSpec` (C2) | `placement_json` |
| `SKIFF_FEATURE_DB_CONSOLE` | Already, D96 | Ignored with a startup warning today | `SKIFF_FEATURE_DB_STUDIO` |

Adoption is measured, not claimed: `skiff_ha_mode`, `skiff_ha_level{kind,level}`,
`skiff_ha_effective_below_target`, `skiff_agent_capability{capability,version}` and
`skiff_ha_drill_age_seconds{kind}`, beside §6.6's lease series and §9.2's replicas. Settings → High
availability shows five numbers: agents at the floor, resources at L2 or above, control nodes with
`canPromote`, drills green in 30 days, and resources whose effective level equals the configured one.

---

## 21. Risks and open questions

### 21.1 Risk register

Judged for the reference topology (§3.6) at the phase that introduces the risk. The last column is where
it is retired, not where it is mentioned; "permanent" means no phase removes it.

| # | Risk | Likelihood | Impact | Mitigation | Detection | Owner | Retired by |
|---|---|---|---|---|---|---|---|
| R1 | Split brain during a partition | Low | Critical | CAS lease, 20 s fence, 40 s takeover, no auto-resume (§6.3) | `ha.lease_contested`; two `primary` rows | platform | C6 |
| R2 | Divergence found after a brain heal | Medium | High | The loser's SQLite is discarded, never merged (§6.6) | Fingerprint mismatch in the runbook | platform | C6 |
| R3 | The object store has no usable CAS | Medium | Critical | S3 gates C6; otherwise manual promotion with a confirmed-dead step | 501, or two 200s for one epoch | platform | C6 |
| R4 | An object-store outage makes the control plane read-only | Medium | High | 20 s fence; reads and sites keep serving | `ha.object_store_unavailable` | platform | C6 |
| R5 | Litestream follow cannot hold a 1 s RPO | Medium | High | S2 gates C6; the fallback is an interval RPO, published as such | Standby lag above 5 s | storage | C6 |
| R6 | A two-node fleet cannot tell a dead primary from a partition | High | Medium | Hold and page; `auto` needs three data nodes (§9.3) | The decision matrix | data | Permanent |
| R7 | The homelab WAN cannot carry `sync` | High | Medium | `sync` is cloud-zone only; S6 measures it | S6 numbers, commit latency | data | C7 |
| R8 | An operator promotes the wrong node or epoch | Medium | Critical | `If-Match`, typed confirmation naming the epoch, audit, second person for data loss | Audit diff | operator | C6, partly permanent |
| R9 | No headroom, so failover silently does nothing | High | High | 25% reserve, admission refusal, blast radius from state (§3.8) | `placement_blocked` | platform | C0 / C4 |
| R10 | Endpoint authorisation is weaker than the text claims | Medium | High | Per-consumer `/32` rules; a per-service CA is an S1 question (§4.3) | `sec/port-scan`; an unexpected peer connects | network | C2 |
| R11 | Clock skew makes lease expiry unsafe | Low | Critical | Store `Date` header, 5 s tolerance, 40 s takeover (§6.3) | `ha.control_clock_skew` | platform | C6 |
| R12 | Eleven phases, mostly unbuilt, one maintainer | High | High | Risk-ordered phases, each shipping alone, deferrals in §21.4 | Velocity against §14 | maintainer | Permanent |
| R13 | The backup gate blocks L2 on resources that cannot be backed up yet | High | Medium | Scoped to stateful resources; L1 per engine ships before L2 | `ha.backup_missing` | data | C7 / C9 |

### 21.2 Open questions

| # | Question | Decision needed | Default if unresolved | Settled by |
|---|---|---|---|---|
| Q1 | Where does the lease live: R2, a control-node quorum, or a witness node? | Which object is the single arbiter | R2 if S3 passes; otherwise manual only | C6 |
| Q2 | Is automatic control-plane promotion ever the default? | Whether `auto` is offered for the control plane | No; opt-in per install | C8 |
| Q3 | One lease per database or one per cluster? | The granularity of database fencing | Per database, as §9.3 | C7 |
| Q4 | What is supported above two control nodes? | Whether a third standby is tested or only designed for | Designed for N, tested at two | C6 / C8 |
| Q5 | What RTT makes `sync` worth it? | The cutoff, per attachment or per database | 30 ms, cloud zones only, from S6 | C7 |
| Q6 | Does a proxied name with several A records behave as a pool? | Whether `dns-failover` may rely on it | Assume no; remove records only | C5 soak |
| Q7 | `caddy-l4` or the Bun forwarder? | Which transport is built | The forwarder if S1 fails, at +10–15 MB per node | C2 |
| Q8 | Do app volumes reach L2 at all? | Whether mount-on-promotion ships | L1 only until C9 proves it | C9 |
| Q9 | Are zones a registry or free text? | Whether a zone is validated | Free text with a co-location warning | C0 |
| Q10 | How large is the failover reserve? | The percentage admission holds back | 25% of the slice plus the largest node's reservations | C0 |

### 21.3 Assumptions to validate

§11.4 lists which assumption breaks which row; this is who proves it and what a false assumption costs.

| Assumption | Validated by | If false |
|---|---|---|
| NTP keeps skew under 1 s on every node | C1's verify step and T4 | Lease expiry is unsafe; no automatic promotion |
| The object store is strongly consistent for one object | S3 against R2 and every configured target | No CAS, so no automatic anything |
| Zones fail independently (power, uplink, provider) | Operator attestation and the co-location detector (§3.2) | Every spread cell lies; L3 is single-zone |
| DNS answers are honoured and TTLs are at most 60 s | C5's observe-only window | Steering takes minutes; `direct` is the fallback |
| Within a zone p99 is under 1 ms; across zones under 30 ms | C1's probe and S6 | Distributed RustFS and `sync` are both out |
| A replacement machine exists within the RTO | Operator stock, recorded beside the topology | Every RTO includes procurement, which dwarfs it |

### 21.4 Deferred deliberately

Not forgotten, and in no phase: a third control node, a witness daemon, active–active anything,
automatic move-back, cross-version Postgres replication, MongoDB sharding, tenant-defined zones,
ClickHouse HA, a self-hosted platform object store (D71 keeps it a replication target), automatic drift
repair and network-level fencing (STONITH). Each has a trigger: a third control node when hold-and-page
costs more than a witness; active–active never, because SQLite is the single writer (§1); move-back when
a flapping node is measured moving work twice; ClickHouse HA when telemetry becomes a product surface
rather than best-effort (D101); drift repair when `ha.effective_below_target` is ignored twice.

---

## 22. Alternatives considered

Each option was judged on the same criteria, and each verdict carries the evidence that would reverse
it. The purpose is not to relitigate but to record where the design is a choice rather than a
constraint, so a future reviewer knows what to measure.

### 22.1 Criteria, and the summary

Judged on operational cost (daemons, RAM, attention), failure modes added, footprint against DESIGN's
≤250 MB baseline, lock-in, recovery (RTO, RPO, human steps) and fit with the invariants — single-writer
SQLite, loopback-only data ports, fixed helper verbs, human-gated destruction.

| Option | Verdict | Decisive criterion | Evidence that would change it |
|---|---|---|---|
| Kubernetes (k3s), Nomad, Swarm | Rejected | Cost and footprint: a control plane larger than the workloads it schedules | 10+ nodes, several operators, a need for continuous scheduling |
| Ceph, Longhorn, GlusterFS, DRBD | Rejected | Failure modes and footprint: quorum and heal behaviour at home scale | Cross-zone POSIX multi-writer with strong consistency |
| Patroni + etcd/Consul | Rejected | A second consensus system and a per-database daemon | Postgres dominating the fleet, or zero-RPO beyond `ANY 1` |
| pg_auto_failover | Rejected | A monitor Postgres to run, patch and lose | One large Postgres estate where one monitor beats our state machine |
| etcd or Consul as the lease store | Rejected | Three nodes and consensus for one object | S3 failing while the fleet still wants automatic promotion |
| rqlite, dqlite, Kine, LiteFS | Rejected | Replaces SQLite's single writer; a different product | Writes must survive a partition without the 40 s gap |
| keepalived/HAProxy VIP | Rejected | A floating VIP needs L2 adjacency cross-provider zones lack | One provider with several nodes on one segment |
| Cloudflare LB or Tunnel only | Deferred | Paid; Cloudflare arbitrates availability and terminates TLS | Many ingress nodes, or the homelab becoming a permanent ingress |
| Tailscale, Headscale, NetBird | Rejected as default | A daemon and an account per node; NetBird is AGPL and heavy | A NAT type WireGuard over a hub cannot traverse |
| Custom WireGuard mesh | **Chosen** | ~400 lines against a hub; the helper owns privileged networking | Two hub failures a year, or a topology plan 23 cannot traverse |
| Active–active control plane | Rejected | Multi-writer SQLite is the non-goal in §1 | Never for this product; a different architecture |
| Shared Postgres, a database per tenant | Rejected | Blast radius and D55: one noisy tenant, one failure domain | A single-tenant install wanting many small databases |

### 22.2 Orchestrators and distributed storage

Kubernetes earns its cost at a scale and a team this design does not have: an API server, etcd, a
scheduler and a kubelet per node, for placement that happens once at deploy time. Nomad adds a second
scheduler and unit system; Swarm makes a Docker daemon a hard dependency, which the footprint rule
rejects, and D27 keeps Docker optional rather than required. H4's
filter-and-score plus §8.3's opt-in re-placement is less capable on paper, and the only capability the
reference topology needs is "put it somewhere sensible and say why". Ceph needs monitors and OSDs and
brings petabyte-shaped failure modes, Longhorn needs Kubernetes, GlusterFS has no credible one-person
maintenance story, and DRBD is block replication with a split-brain decision harder than the lease
already solves. No cross-zone ReadWriteMany volume is the price, which is why a share is a network
filesystem with stated semantics (§5.2) rather than a pretend local disk.

### 22.3 Database and control-plane alternatives

Patroni is excellent and brings etcd or Consul: three more processes, a second consensus system, and a
per-database agent whose failure mode is a second authority over promotion. pg_auto_failover replaces it
with a monitor Postgres, still deciding promotion outside the control plane that owns desired state; an
etcd or Consul lease store is the same cost for one object. The chosen design puts the decision in the
control plane and the authority in a per-database lease (§9.3), reusing what the control plane needs
anyway, and accepts that Skiff owns the state machine and must test it (§19). LiteFS is the closest
control-plane alternative, rejected because it still needs a lease to decide the writer plus a FUSE
mount on every node. Consensus on every write (rqlite, dqlite, Kine) is the cost §1 rejects; the 40 s
write gap during a partition is the cheaper trade at this scale.

### 22.4 Network and ingress alternatives

Plan 23 holds the evidence for the mesh: Tailscale has the best traversal and adds a daemon, an account
and a tailnet conflict on a homelab already on one; Headscale is the self-hosted equivalent with the same
daemon; NetBird is AGPL and heavy; Nebula needs certificate lifecycle work. A custom WireGuard mesh is
chosen, with bring-your-own-network first-class, and the trigger to revisit is a NAT type the hub cannot
traverse. For ingress, an external load balancer — a second VPS running HAProxy, keepalived for a VIP, or
a provider LB — moves the decision to a component with its own failure mode and bill, and a floating VIP
needs L2 adjacency the two cloud zones do not share. `dns-failover` keeps the decision in the control
plane that already knows which ingresses are healthy. Cloudflare-only ingress is strongest operationally
and weakest on lock-in: TLS terminates there, the 100 MB body cap applies to everything, and the install
stops if the account does.

### 22.5 Active–active, shared clusters, and what would reopen this

An active–active control plane is a different data model, rejected because SQLite is the single writer.
A shared Postgres with a database per tenant would centralise HA and drop per-database limits, replica
control and the loopback endpoint model; D55 rejected it for blast radius, since one noisy tenant affects
everyone and one failed cluster takes the fleet's data. Three measurements would reopen the rest: a lease
CAS that fails S3 while the fleet still wants automatic promotion (reopens etcd and pg_auto_failover
together); a two-node fleet whose hold-and-page cost exceeds a witness; and a fleet large enough that
placement must be continuous (reopens Nomad, not Kubernetes).
