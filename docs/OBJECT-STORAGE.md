# Skiff — Managed object storage (RustFS)

Status: **built 2026-11-05.** Storage reuses the managed-database runtime profile, sealed
credentials, attachments, stats path and soft delete ([DATABASES.md](./DATABASES.md), D55–D61).
The decisions below are recorded as **D62–D71** in [DECISIONS.md](./DECISIONS.md) (S1→D62,
S2→D63, … S10→D71); the `S` labels are kept here because the code refers to them. The ROADMAP
section tracks what is still open (notably the Debian 13 end-to-end run and backups).

A **storage instance** is an org-owned [RustFS](https://github.com/rustfs/rustfs) server that Skiff
provisions, runs, observes and connects to apps. It serves an S3-compatible API and holds
**buckets**. Like a database it is not a project: it has no releases or deployments. It runs as a
tier-3 container on one node, inside `skiff-workloads.slice`, admitted against the node's memory
budget (D41, D42).

Why RustFS: Apache-2.0 (MinIO is AGPLv3 and has stripped its community edition), single static
binary and image, S3 API on one port, and 1.0 GA in September 2026. Garage stays the fallback
engine if RustFS fails a spike (§9); the engine registry keeps that a data change.

Everything goes through `packages/core` (`StorageService`); REST, MCP, CLI and the dashboard stay
thin surfaces.

---

## 1. Model

| Table | Purpose |
|---|---|
| `storage_instances` | Org, name, engine/version, resolved node, host port, memory/CPU, storage budget, `public` flag + `public_host`, status, sealed root credentials, latest usage snapshot, soft-delete columns. |
| `storage_buckets` | Instance, bucket name, anonymous access (`private` \| `public-read`), latest size/object count, soft-delete columns. |
| `storage_attachments` | Instance ↔ project, env prefix, bucket grants (`[{bucket, mode: read \| read-write}]`), sealed access key pair for that project. |

- **Names** follow the database rules (3–40, `[a-z0-9-]`, no `--`), unique per org. Bucket names
  follow S3 rules (3–63, lowercase, digits, `-`, no `.` so path-style and TLS stay simple), unique
  per instance.
- **Ids** are `st_<32 hex>`; the id doubles as the workload id on the node (helper, journal, logs,
  heartbeat), as with databases.
- **Status** uses the workload vocabulary and is driven by heartbeats.

**S1.** Storage instances are org resources run as tier-3 containers, a sibling of databases, not
a project runtime. One RustFS server per instance, never a shared server with a bucket per tenant
(same reasoning as D55: per-instance limits, one noisy tenant can't starve others).

## 2. Runtime (helper `storage` profile)

The control plane sends the instance as a container `WorkloadDesired` entry. At build time the
`database` field generalises into a managed-service profile, `service: { kind, engine, version }`
(`kind` is `database` or `storage`). The D61 engine registry becomes one registry with RustFS as
its first `storage` engine. The helper derives everything from that triple and never takes an
image, user or mount from the wire:

- Image: a pinned `docker.io/rustfs/rustfs:<version>` (by digest in the helper's copy of the
  registry; tags are not trusted).
- Single-drive mode: `RUSTFS_VOLUMES=/data`, `RUSTFS_ADDRESS=:9000`, `RUSTFS_CONSOLE_ENABLE=false`.
  The root key pair arrives as 0400 files under `/run/skiff-workloads/<id>/` (D43), not as env in
  the unit.
- Runs as the image's unprivileged user (uid confirmed in spike 1); the helper creates and `chown`s
  the data dir. `DropCapability=all`, `NoNewPrivileges`, `ReadOnly=true`, `Tmpfs=/tmp`.
- `PublishPort=127.0.0.1:<hostPort>:9000` only. `Network=skiff-workloads.network` with
  `NetworkAlias=s3-<id hex>`.
- `MemoryMax`, `CPUQuota`, `Slice=skiff-workloads.slice`; counts toward admission (default 512 MB,
  minimum set by spike 1).
- Health probe: HTTP `GET /health` on the loopback port (falls back to TCP connect if the endpoint
  differs by version).

Host ports per node come from `19000–19999`, lowest free first, including soft-deleted instances.
This range doesn't overlap the database range (`15432–16431`).

**S2.** The built-in RustFS web console is **off**. Bucket and key management happens through
Skiff (§4), so Skiff stays the source of truth and nothing else needs exposing. An on-demand
console can follow the D60 pattern later if people ask for it.

## 3. Access: private by default, public per instance (S3)

Each instance has a **`public` toggle**, off by default.

**Private (default).** Same rules as databases (D56): listens only on `127.0.0.1` and the
`skiff-workloads` network. Attached projects are placed on the instance's node.

**Public.** The control plane adds a route `<name>--s3.<contentDomain>` (covered by the existing
wildcard certificate, D44). Edge Caddy serves it; for worker-placed instances it forwards over
WireGuard exactly like worker apps. The route is a dedicated **storage route kind**, not a site:

- **No `forward_auth`.** S3 clients don't carry cookies, so the SigV4 signature *is* the access
  control. `password`/`platform` access modes don't apply.
- **Byte-for-byte proxying.** No `encode`, no `_headers`/site-config, `Host` preserved across both
  hops (SigV4 signs it), `flush_interval -1`, no request-body size limit at Caddy (RustFS enforces
  S3 limits), long read/write timeouts for multipart uploads.
- Requests show up in the traffic pipeline under the instance (access logs are already collected).
- Path-style only (`https://<name>--s3.<contentDomain>/<bucket>/<key>`); virtual-hosted style would
  need a second wildcard level (D44).
- **Hostname safety.** `public_host` has a global unique index. Environment names `s3` and
  `console` are reserved, so `<slug>--s3` can never be an environment URL too.

Turning public on or off is an `update`. It changes routes only; the container doesn't restart.

**Bandwidth warning.** All public traffic goes through the edge VPS, and through the WireGuard link
for worker-placed instances. The dashboard says so when the toggle is turned on.

**S3.** Exposure is a per-instance toggle: private (loopback + Podman network) by default, public
via a dedicated storage route on `<name>--s3.<contentDomain>` that authenticates with S3
signatures only.

## 4. Buckets, keys and attachments

**Buckets are desired state.** Creating a bucket in Skiff writes a row; the instance's desired
entry lists its buckets (name + anonymous policy). The agent converges them over the loopback port
with the root key: `CreateBucket`, `PutBucketPolicy` for `public-read`, and removal (only when the
bucket is empty, unless it's a purge). The root key is fetched at activation and **kept in agent
memory only**, the same pattern as the D57 monitor credentials.

**Attachments get scoped keys (S4).** `attach` links an instance to a project with an env prefix
and a list of bucket grants. The control plane generates a dedicated access key pair for that
attachment and seals it with the org key. The agent creates a matching RustFS IAM user and a
policy limited to the granted buckets and modes (spike 2). Detach deletes the user. Apps never see
the root key.

At activation the consumer receives (prefix `P`, default `S3`):

| Var | Value |
|---|---|
| `<P>_ENDPOINT_URL` | Same node: process → `http://127.0.0.1:<hostPort>`, container → `http://s3-<id hex>:9000`. Other node (public instances only): the public URL. |
| `<P>_PUBLIC_ENDPOINT_URL` | Public URL when `public` is on, so apps can presign browser URLs against the host clients will actually hit. Absent when private. |
| `<P>_ACCESS_KEY_ID`, `<P>_SECRET_ACCESS_KEY` | The attachment's scoped key. |
| `<P>_REGION` | `us-east-1` (RustFS accepts any region; SDKs insist on one). |
| `<P>_BUCKET` | Only when exactly one bucket is granted. |
| `<P>_FORCE_PATH_STYLE` | `true`. |

Using prefix `AWS` produces the AWS SDKs' own variable names (`AWS_ENDPOINT_URL`,
`AWS_ACCESS_KEY_ID`, …), so most SDKs work with zero config. The docs call this out; it isn't the
default because it would shadow real AWS credentials.

**Placement (S5).** Attachments to a **private** instance are same-node only, enforced at deploy
time as for databases. Attachments to a **public** instance work from any node through the public
URL. That is the first cross-node managed resource, and it's safe because the traffic is
TLS-authenticated S3, not a raw database port.

Values are injected at activation only (D18, D43); the consumer's activation version includes an
attachments hash, so attach, detach or grant changes restart the app without a redeploy.

## 5. Credentials (S6)

- The **root key** is sealed with the org key. `GET /api/v1/storage/:name/credentials` reveals the
  endpoint and root key to humans with `storage:credentials` (never pre-ticked for agents; every
  read audited), for tools like `rclone`, `aws s3` or a desktop S3 client.
- **MCP never returns keys**, as in D58. Agents attach instances to apps instead.
- Attachment keys aren't revealable; they belong to the app. Extra named keys for humans (with
  their own bucket grants) are a follow-up that reuses the attachment-key machinery.
- Rotation: generate a new pair, let the agent create it, re-activate consumers, then delete the
  old pair. This is easier than with Postgres because keys are independent IAM users.

## 6. Observability (S7)

The telemetry batch gets an additive `storage` field, sent once a minute per running instance:

| Kind | Fields |
|---|---|
| Gauges | `disk_bytes` (data dir, from a fixed helper `usage` verb), `buckets`, `objects`, `memory_bytes` (container), `up` |
| Counters | requests and bytes in/out from RustFS's metrics endpoint if spike 3 finds one usable; otherwise public-endpoint traffic only, from access logs |

These land in DuckDB as `storage_metrics_1m`, rolled up into `storage_metrics_1h` with traffic's
retention. Per-bucket size and object count (from RustFS's data-usage info, spike 3) are sampled
every five minutes into `storage_buckets` as a latest-only snapshot, like the database table
snapshot.

Surfaces: `GET /api/v1/storage/:name/metrics`, dashboard charts and a bucket list,
`skiff_storage_*` on `/metrics`. One alert: disk above 85% of the storage budget.

## 7. Lifecycle (S8)

Mirrors databases (D59):

- **Create** resolves placement once (`auto` → most free budget), allocates the port, and creates
  any buckets given on create.
- **Update**: memory, CPUs, storage budget (admission re-checked), `public`. Engine version bumps
  within the pinned list restart the container.
- **Delete** is soft for 7 days and is refused while projects are attached. The container stops,
  the route is removed and the data dir stays, so **restore** is lossless (the public host is held
  for the 7 days).
- **Purge** goes through desired state (`storagePurges`) to the helper's fixed `purge` verb, which
  removes only `<stateDir>/<id>`. The row is deleted on the agent's report.
- **Bucket delete**: refused if the bucket isn't empty, unless `--force` (a human with
  `storage:delete`, typed confirmation in the dashboard; never over MCP).

## 8. Surfaces

| Surface | What |
|---|---|
| Permissions | New `storage` resource: `create`, `read`, `update`, `delete`, `credentials`. Deployer gets everything except `delete`; viewer gets `read`; agents get the deployer set minus `credentials`. |
| REST | `GET/POST /api/v1/storage`, `GET/PATCH/DELETE /api/v1/storage/:name`, `POST …/:name/restore`, `GET …/:name/credentials`, `GET …/:name/metrics`, `GET/POST …/:name/buckets`, `PATCH/DELETE …/:name/buckets/:bucket`, `GET/POST /api/v1/projects/:slug/storage`, `PATCH/DELETE …/storage/:name` |
| MCP | `list_storage`, `get_storage`, `create_storage`, `create_bucket`, `attach_storage`, `detach_storage`, `delete_storage` (confirmed, soft). No bucket force-delete, no key reveal. |
| CLI | `skif storage list\|create\|info\|update\|delete\|restore\|credentials`, `skif storage buckets list\|create\|delete`, `skif storage attach\|detach` |
| Dashboard | Storage list + create, detail (status, endpoint, public toggle, buckets, attached projects, charts), attach from a project with bucket grants |

## 9. Spikes before building

1. **Container profile**: the image's uid, whether it runs with `ReadOnly=true` plus a
   `/data`/`/tmp` mount, idle memory, the health endpoint, and the env/file names for the root
   key on the pinned version.
2. **IAM**: create a user, attach a bucket-scoped policy and delete it through RustFS's admin API
   (MinIO-compatible `admin/v3` or RustFS's own). This decides S4. Fallback if it's missing or
   immature: one non-root service key per instance shared by all attachments, documented as a
   known gap.
3. **Usage and metrics**: data-usage per bucket and a metrics endpoint the agent can poll on
   loopback (Prometheus text or OTLP).
4. **Proxy fidelity**: SigV4 through edge Caddy → WireGuard → worker Caddy → container, a 5 GB
   multipart upload, presigned GET/PUT against the public host, and range requests.
5. **Anonymous read**: a `public-read` bucket policy serves unsigned GETs through the public route.

## 10. Follow-ups

- **Backups (S9)**: bucket replication or a scheduled sync to the platform `ObjectStore` (R2),
  with retention, sharing the scheduler planned for database `pg_dump` backups.
- **Skiff's own `ObjectStore` on RustFS (S10)**: an `S3ObjectStore` (generalising the R2 client to
  any endpoint) can point at a managed instance. It's allowed as a **replication target only**:
  canonical platform artifacts can't live on a workload whose own deploys need those artifacts.
  This covers part of the roadmap's "Garage/MinIO" item.
- Human access keys with bucket grants; key rotation in the dashboard; per-bucket quotas; lifecycle
  rules (expire after N days); CORS config per bucket; custom domains for public instances; Garage
  as a second engine; bulk actions and prune for storage.
