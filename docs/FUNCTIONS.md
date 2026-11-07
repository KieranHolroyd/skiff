# Skiff Functions: Workers-compatible functions on workerd

Status: **accepted as [D110](./DECISIONS.md); phases 1–3 and the stateless half of phase 4 are
implemented, 2026-11-06.** The `FN` codes below are the design of that decision and this file keeps
their detail, as [CLUSTERING.md](./CLUSTERING.md) does for its `H` codes.

Implemented on the node and in the control plane:

- **Phase 1 (fetch functions):** runtime `"function"` through contracts, admission and desired
  state; bundle validation, binding resolution and the function view
  (`packages/core/src/functions.ts`); the helper's socket-activated workerd unit and pinned-binary
  preflight; the agent's Cap'n Proto config, shim and assets-first Caddy route; `GET
  /projects/:slug/function` and the `get_function` MCP tool. `skif deploy` detects
  `wrangler.jsonc`/`wrangler.json`, bundles `main` with Skiff's own bundler (esbuild pinned in the
  CLI, [D113](./DECISIONS.md); Wrangler is never run), generates the internal
  `skiff-function.json` itself and creates the project as `runtime: "function"`; users only keep
  their Wrangler file. `skif wrangler …` passes commands through to Wrangler for local development.
- **Phase 2 (bindings):** Durable Objects on the host's `do-storage` disk service (SQL enabled),
  Hyperdrive through the attached database's loopback port, KV and D1 backed by Durable Object
  storage, Cache with a per-host size cap, R2 signing path-style S3 requests to the attached
  RustFS instance, Analytics Engine writing through an extension module to the node's telemetry
  batch, queues (a producer binding that publishes to a managed NATS broker, with the agent
  delivering batches to the shim, D112), and
  `env.ASSETS` served from the release's assets directory.
- **Phase 3 (economics and triggers):** cron on the node with a persisted cursor; idle hosts stop
  and cold-start through socket activation; the watchdog restarts after three missed probes; tail
  workers forward invocation events to the same telemetry channel (ClickHouse).
- **Phase 4 (stateless replicas):** a function with only stateless bindings may run `replicas > 1`
  on one node; each replica has its own socket and Caddy load-balances across them. Stateful
  functions stay at one host until workerd cluster mode passes S8.

Still not built: Durable Object/KV/cache/D1 SQLite snapshot backups and restore, cross-node service
bindings, workerd cluster mode and multi-node stateful failover, multi-node stateless placement,
Workflows, Worker Loader, and R2 multipart uploads (single-part is implemented). Python Workers,
Wasm languages and scale-to-zero process apps for every other language are in §4.13 (D121).
`skiff-update-self` does not install a newly pinned workerd yet; the installer does, so a host that
updates across a workerd pin bump needs the installer (or a manual install under
`/usr/lib/skiff/workerd/<version>/`). `SKIFF_FEATURE_FUNCTIONS` is on by default; set it to `0` to disable the tier (existing function
workloads keep serving).

Naming: Skiff already uses "worker" twice, for a no-ingress app (D89) and for a non-edge node. This
feature is therefore **Functions**, with `runtime: "function"`. "Workers" appears only when it
means Cloudflare's programming model.

---

## 0. Summary

Add a fourth runtime tier, `function`, that runs code written for Cloudflare Workers on
Cloudflare's open-source runtime, **workerd**. A function deployment is a **socket-activated
workerd process per project environment**, started by the helper with the same systemd sandbox as
a process app. It scales to zero when idle and starts on the first request, which gives it
Lambda-style economics. Users write ordinary Workers code (`export default { fetch }`, a
`wrangler.jsonc`) and test it locally with `wrangler dev`. That runs the same runtime, so local and
production behave the same.

Bindings map onto services Skiff already runs:

| Workers binding | Skiff backing |
|---|---|
| R2 | Managed RustFS (D62) |
| Hyperdrive | Managed Postgres through PgBouncer (D85) |
| Analytics Engine | The ClickHouse telemetry store (D101) |
| Durable Objects | workerd's own SQLite storage on a volume (D72) |
| Secrets | The existing activation path (D18) |

Cron runs from the node, in keeping with pull, not push. The control plane stays out of the
request path and never runs user code.

Durable Objects are single-node at first. **workerd gained an experimental cluster mode on
2026-10-29**, the start of Cloudflare's merge of Deno's celld into workerd. Its leases and object
ownership live in an S3-compatible bucket, and its peers talk over a private network. That fits
Skiff's WireGuard overlay and managed RustFS closely, so multi-node Durable Objects are a later
phase that adopts workerd's upstream design rather than a Skiff invention.

The trust argument is short. A process app already runs arbitrary native code under the helper's
sandbox, and a function can do strictly less. workerd's "not a hardened sandbox" warning therefore
adds no new trust tier to Skiff, as long as the process boundary between projects is kept (§4.8).

---

## 1. What Cloudflare has open-sourced (as of 2026-11-06)

| Project | Licence | What it gives Skiff | Maturity | Use? |
|---|---|---|---|---|
| **workerd** (`cloudflare/workerd`) | Apache-2.0 | The Workers runtime: V8 isolates, Web-standard APIs, Node compat, capability bindings, Durable Objects on local SQLite, tail workers, Worker Loader, Workflows engine hook | Production at Cloudflare. Releases are daily and the version is a date (`v1.20261106.1`). Prebuilt binaries ship on npm. | **Yes, the core.** |
| **workerd cluster mode** (`Config.cluster`, `--experimental`) | Apache-2.0 | Durable Objects spread across instances. A bucket holds instance leases and ownership records claimed by conditional write, and the epoch bumps on takeover. Committed writes are captured as LTX. Peers authenticate with an HMAC key and send traffic **unencrypted** (private network required). `workerd deploy` publishes named deployments into the bucket. | First commit 2026-10-29. `workerd deploy` landed 2026-11-05. Experimental. | **Later (phase 4)**, behind a spike. |
| **Miniflare** (`workers-sdk/packages/miniflare`) | Apache-2.0 | Simulators for KV, R2, D1, Queues, Workflows, Cache, assets, dispatch namespaces, Analytics Engine and more. Each is a **Worker running inside workerd**, built on Miniflare's own Durable Object base with SQLite and a blob store (`src/workers/kv/namespace.worker.ts`, `queues/broker.worker.ts`, `d1/database.worker.ts`) | A dev tool, and "not a hardened sandbox" | **As reference and source** for binding services, not as the server. |
| **Wrangler** | Apache-2.0 | The `wrangler.jsonc` config schema. `wrangler dev` gives users a local runtime that is the same as Skiff's. | Stable | **Yes, for the config schema and the local dev loop.** Not for deploy bundling: Skiff's own pinned bundler does that (D113). |
| **celld** (`denoland/celld`, Deno) | Apache-2.0 | A self-hosted, distributed Workers and Durable Objects daemon: one SQLite database per object, LTX replication to a bucket, signed peer HTTP, cron, KV, D1, R2, Queues, Workflows | v0.6 beta. Announced 2026-08-05. "Not safe for hostile multi-tenant workloads yet". Pull requests disabled. **Being merged into workerd** (Cloudflare blog, 2026-10-09). | **Reference only.** Its future as a separate repo is unannounced. |
| workers-rs, Python Workers (Pyodide), `@cloudflare/containers`, `@cloudflare/sandbox`, `agents` | MIT or Apache-2.0 | Client SDKs. They work wherever their underlying bindings work. | Varies | User-side libraries. Rust/Wasm and `agents` work once Durable Objects do. |
| Pingora, Cap'n Web, Cap'n Proto | Apache-2.0 / MIT | A proxy framework, an RPC protocol, and the serialisation format behind workerd's config | Stable | No. Caddy remains the proxy (D7). |

**Not open source** (Skiff must supply it or leave it out): production limit enforcement,
multi-tenant hardening, Cloudflare's Durable Object routing ("simply not the implementation any
self-hoster would want", in Cloudflare's words), and the production backends for KV, R2, D1,
Queues, Hyperdrive and Workers AI. Vectorize, Browser Rendering and Email Workers are also closed.

### 1.1 Facts that shape the design

These were checked against primary sources (§9). Each one constrains a decision below.

1. **No CPU or memory limits per isolate.** The open-source server wires in "the unlimited
   `LimitEnforcer` … the null `IsolateLimitEnforcer`", which the source calls single-tenant policy
   objects (`src/workerd/server/AGENTS.md`, `factory/worker-factory.c++`). Production limits are
   proprietary. → Limits come from cgroups and process boundaries (FN5).
2. **One thread, one event loop per process.** A busy-looping request stalls everything else in
   that process. → One process per project environment, never one per org or node (FN3).
3. **Not a hardened sandbox.** For possibly malicious code the README says to run it "inside an
   appropriate secure sandbox, such as a virtual machine." → Org members are trusted no more and
   no less than they are for process apps. Open sign-ups are out of scope (FN6).
4. **Capability bindings.** A Worker can reach only what its config names. Global `fetch()` and
   `connect()` go through a `network` service with `allow`/`deny` lists. → This is the first-line
   SSRF defence (FN7).
5. **The container engine is Docker only, and only for development** (`containerEngine.localDocker`).
   → Containers bindings conflict with invariant 8 (no Docker daemon) and are not offered. A
   function reaches a Skiff container app through a binding instead.
6. **The cluster reads its catalog only at startup**, needs identical config on every instance, and
   gives every deployment the instance's full authority. → Skiff never uses the shared `workerd
   deploy` catalog for tenants. Each project is its own cluster on its own bucket prefix, with
   configs rendered by Skiff (§4.9).
7. **Prebuilt binaries need glibc ≥ 2.35.** Debian 13 and current Ubuntu LTS releases meet this (D27).
8. **The Deno runtime ends development around October 2027, and Deno Deploy shuts down around
   April 2027** (Deno blog, 2026-10-09). → Deno is not a base for this work.

---

## 2. Why this fits Skiff

| Skiff invariant ([build-plan §2](./build-plan/README.md)) | How Functions keeps it |
|---|---|
| 1. Agents pull desired state | A function is a `WorkloadDesired` like any other. Cron fires on the node from desired state (FN9). |
| 2. No shell, fixed helper verbs | The helper starts a fixed binary (`/usr/lib/skiff/workerd/<ver>/workerd`) with a generated config path. Nothing on the command line comes from the user. |
| 3. Immutable releases | The bundle is a content-addressed release. The config snapshot includes bindings and the compatibility date (D17). |
| 4. One service layer | `packages/core/src/functions.ts`. REST, MCP, CLI and the dashboard stay thin. |
| 5. Secrets never in desired state | Secrets become `fromEnvironment` bindings fed by the existing 0400 env file at activation. |
| 6. Control plane never reaches node loopback | Binding services run on the node, inside the function's own workerd process. |
| 7. ≤ 250 MB edge baseline | Off by default. Socket activation means **zero resident cost while idle** (FN4). |
| 8. No Kubernetes, no Docker | systemd only. workerd's Docker container engine is never configured. |
| D2. The control plane never builds | The user's machine or a Builder bundles with Skiff's own bundler (pinned esbuild, D113). The control plane validates a manifest. |
| D6. Bun everywhere, Caddy the only exception | **Amended**: workerd becomes the second non-Bun component (FN1). |

What users get that they can't get from Skiff today:

- **Static site plus functions in one project**, in the style of Pages Functions: a form handler,
  an auth check or an API route without a process app's always-on memory.
- **Durable Objects on their own box**: WebSocket rooms, rate limiters, per-user SQLite, and the
  `agents` SDK.
- **Code that ports both ways.** The same `wrangler.jsonc` project runs on Cloudflare or on Skiff.

---

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Function** | A project (or project environment) whose workload has `runtime: "function"`. |
| **Function host** | The workerd process serving one function workload on one node: `skiff-workload-<id>.service` plus its `.socket`. |
| **Bundle** | The release artifact: ES modules (or Wasm or Python), plus `skiff-function.json`. |
| **Binding service** | A Skiff-supplied Worker loaded into the same function host to back a binding (the KV, D1, R2-gateway, queue, cache and assets services). |
| **Shim** | The Skiff-generated entry module that wraps the user's default export and adds internal-only routes for `scheduled`, `queue` and health. |

---

## 4. Design

### 4.1 Shape: a process runtime that runs workerd (FN2, FN3)

A function is implemented as a specialised process workload:

```
WorkloadSpec { runtime: "function", function: { compatibilityDate, compatibilityFlags,
               mainModule, bindings[], triggers, assetsMode }, memoryMb: 128, cpus, ingress: "http" }
```

- The helper renders the same unit shape process apps get: `DynamicUser=yes`,
  `ProtectSystem=strict`, `NoNewPrivileges`, `MemoryMax`, `CPUQuota`, `TasksMax`, the
  `skiff-workloads.slice` and a `.socket` unit at `/run/skiff-workloads/<id>.sock`.
  `ExecStart` is the pinned workerd binary: `workerd serve <config> --socket-fd http=3`. Only the
  config path varies, and it is a fixed location under the workload directory.
- The **agent** (unprivileged) renders the Cap'n Proto config into the workload directory from
  desired state and the activation payload. It is data, not a command: the helper validates the
  path, and workerd runs it as the dynamic user.
- **One host per project environment** (production, plus at most one active preview, matching
  V2-BACKEND's "only the latest deployment is active" rule). Never one process per org or per
  node: §1.1 facts 1 and 2 make the process the only real fault and fairness boundary.
- `memoryMb` defaults to **128**, Cloudflare's per-isolate figure, and admission reserves it like
  any workload (D42).

### 4.2 Request path

```
client ─▶ Cloudflare ─▶ ingress Caddy ──(static asset hit? serve it)──▶ 200
                              │ miss, or a run_worker_first path
                              ▼
                       workload-node Caddy ─▶ /run/skiff-workloads/<id>.sock
                                                  │  (systemd starts workerd on first connect)
                                                  ▼
                                         workerd: shim ─▶ user Worker ─▶ bindings
                                                             │
                     ┌───────────────┬──────────────────────┼──────────────────────┐
                     ▼               ▼                      ▼                      ▼
              DO / KV / D1     R2-gateway worker      Hyperdrive binding     Analytics Engine
              SQLite on the    ─▶ RustFS (D62)        ─▶ PgBouncer (D85)     ─▶ agent ─▶ ClickHouse
              project volume
```

- **Assets first.** Projects with assets keep the static tier's routes (`_headers`,
  `_redirects`, precompression, D30). Caddy falls through to the function on a miss, or first for
  `run_worker_first` globs compiled from `wrangler.jsonc` `assets`. `env.ASSETS.fetch()` is backed
  by an assets binding service that reads the same release directory.
- Preview URLs, promote, rollback, access modes and custom domains all work unchanged. They operate
  on routes and pointers, not on the runtime.
- Streaming, SSE and WebSockets use the existing per-route flags (CLUSTERING §4.4).

### 4.3 The bundle and its manifest (FN8)

`skif deploy` detects `wrangler.jsonc` or `wrangler.json`, bundles `main` with Skiff's own bundler
(`apps/cli/src/worker-bundler.ts`), copies the bundled modules and assets, and generates
`skiff-function.json` itself — the user never writes or commits that file.

The bundler runs esbuild as a library, pinned to an exact version in the CLI's `package.json`, so
the bundle only changes when Skiff ships a release (D113). Wrangler is never run on the deploy path;
only its config file is read. It follows the parts of Wrangler's bundling that decide whether a
Worker runs: ESM output named after `main`, `workerd`/`worker`/`browser` export conditions,
`keep_names` on by default, `process.env.NODE_ENV` set to `"production"`, `cloudflare:*` imports left
to the runtime, and Wrangler's module rules (`.txt`/`.html`/`.sql` as Text, `.bin` as Data, `.wasm`
as CompiledWasm, plus the config's `rules`), each split into a `<sha1>-<basename>` module. It honours
`define`, `alias`, `minify`, `keep_names`, `tsconfig`, `jsx_factory`, `jsx_fragment` and runs
`build.command` first. With `nodejs_compat` (or a compatibility date from 2026-08-04, when workerd
turns it on by default), Node built-ins stay external as `node:` imports for the pinned workerd to
provide; there is no unenv polyfill layer, so a built-in workerd lacks fails at runtime rather than
being stubbed. It refuses service-worker syntax, `no_bundle`, `find_additional_modules`, the legacy
`node_compat` option with a message. A `.py` `main` skips esbuild entirely: it is a Python Worker
(§4.13). A bundle without the
manifest is still accepted when it is an already-built Worker (`skif deploy ./dist`, or a raw API
upload): the previous deployment's spec supplies compatibility/bindings/assets, and a first deploy
gets conservative defaults plus the project's own secrets. The control plane receives modules plus
the generated manifest when the CLI produced one:

```jsonc
{
  "main": "index.js",
  "modules": [{ "name": "index.js", "type": "esm", "sha256": "…" }],
  "compatibilityDate": "2026-10-01",
  "compatibilityFlags": ["nodejs_compat"],
  "bindings": [
    { "name": "BUCKET",  "type": "r2",          "storage": "media", "bucket": "uploads" },
    { "name": "DB",      "type": "hyperdrive",  "database": "app-db" },
    { "name": "ROOMS",   "type": "durable_object", "className": "Room" },
    { "name": "CACHE",   "type": "kv" },
    { "name": "API_KEY", "type": "secret" }
  ],
  "triggers": { "crons": ["*/5 * * * *"] },
  "assets": { "directory": "public", "runWorkerFirst": ["/api/*"] }
}
```

- The control plane **validates and never bundles** (D2). It checks the binding types it
  supports, checks that every referenced Skiff resource exists in the org and that the caller may
  attach it, caps the compatibility date at what the pinned workerd supports (the workerd version
  *is* that maximum date), and rejects unknown binding types with a clear "not supported on Skiff"
  message rather than ignoring them.
- Wrangler binding IDs (`kv_namespaces[].id`, `d1_databases[].database_id`) are Cloudflare
  account IDs. Skiff maps bindings by **name** and keeps a `skiff` section in `wrangler.jsonc`
  for overrides, which Wrangler ignores. One file serves both platforms.
- Git builds (D45/D47) produce the same bundle on a Builder node.

### 4.4 Activation and secrets

The activation payload already carries a workload's secrets. For a function, the agent writes them
to the 0400 env file it uses today, and the config declares them as `fromEnvironment` bindings. The
rendered config itself never contains a secret, so it can live in the release cache. Rotating a
secret bumps the activation version (V2-BACKEND) and restarts the host. A restart costs one cold
start; see §4.7.

### 4.5 Bindings: the support matrix (FN10)

| Binding | Phase | Implementation | Notes |
|---|---|---|---|
| `vars` (text/JSON) | 1 | workerd `text` / `json` bindings | |
| Secrets | 1 | `fromEnvironment` + activation | D18, D88 scoping |
| Static assets | 1 | Caddy first, plus an assets binding service | Reuses the static tier |
| Service bindings (same project) | 1 | Named entrypoints in the same host | JS RPC works within one process |
| Service bindings (other project) | 3 | An `external` service over the other host's socket, or the overlay for another node | **fetch only.** JS RPC across processes needs cluster channel tokens (phase 4). |
| Bindings to Skiff apps | 1 | An `external` service to the app's socket or loopback port | The way to reach containers (§1.1 fact 5) |
| Durable Objects (SQLite) | 2 | Native `durableObjectStorage.localDisk` on the project's volume (D72/D74) | Single node until phase 4. Alarms and hibernating WebSockets work in-process. |
| R2 | 2 | An `r2Bucket` binding to an R2-gateway service that speaks S3 to a managed RustFS instance, using an attachment-scoped key (D66) | Port R2 semantics from Miniflare's `r2/bucket.worker.ts` |
| Hyperdrive | 2 | workerd's `hyperdrive` binding pointing at an `external` server for the database's PgBouncer (`127.0.0.1:<port>`) | The connection string comes from the attachment |
| KV | 2 | A KV binding service backed by Durable Object SQLite (from Miniflare's `kv/namespace.worker.ts`) | Strongly consistent on one node, which exceeds Cloudflare's guarantee, so it is safe |
| D1 | 2 | A D1 binding service over a Durable Object's SQLite (Miniflare's `d1/database.worker.ts`) | Backups use the D83 path, as SQLite snapshots |
| Analytics Engine | 2 | workerd forwards events to a Skiff service, which hands them to the agent's telemetry batch, which writes to ClickHouse (D101) | Queryable in the user dashboards |
| Cache API | 2 | A node-local cache binding service with a size cap | Without it, behaviour falls back to always-miss, as celld's does |
| Tail Workers and logs | 1 / 3 | Phase 1: structured JSON logs to journald, into the existing log view. Phase 3: `tails` to a Skiff tail service that sends OTLP to the receiver (D16). | |
| Cron triggers | 3 | See FN9 | |
| Queues | 3 | A JetStream stream per queue on the project's **managed broker** (docs/BROKERS.md, D112). The producer service publishes over an `external` TCP service at the broker's loopback port; the agent pulls batches and POSTs them to the shim's `/__skiff/queue`, which returns per-message ack/retry verdicts. | At-least-once; `max_batch_size`, `max_batch_timeout`, `max_retries`, `retry_delay`, delays and a dead-letter queue; one consumer per queue; producers and consumers may be different functions on the same broker |
| Workflows | 4 | workerd's `workflowsEngine` designator plus Miniflare's engine | After Durable Objects are durable across nodes |
| Worker Loader (Dynamic Workers) | 5 | workerd's `workerLoader` binding, opt-in, `globalOutbound: null` by default | See §4.11 |
| Containers, Workers AI, Vectorize, Browser Rendering, Email, Images | — | Not offered. Images can map to plan 15's image transforms later. | Rejected with a clear error at deploy time |

Each binding service is a Worker loaded into the **same** function host, so it shares the
project's process, cgroup and volume. That needs no new daemon, keeps tenant data in the tenant's
sandbox, and keeps the control plane out of the data path. Ported Miniflare code keeps its
Apache-2.0 notices under `packages/function-bindings/`.

Implemented today: Durable Objects, Hyperdrive, KV, Cache, R2, D1, Analytics Engine, queues and
assets bindings, plus tail workers. Cross-node service bindings and stateful multi-node replication
are still refused; see the status note at the top of this file.

### 4.6 Egress and SSRF (FN7)

Two layers, both default-deny for private space:

1. **workerd capabilities.** `globalOutbound` points at a `network` service with
   `allow = ["public"]`, so global `fetch()` and `connect()` can never reach loopback, the
   WireGuard overlay, RFC 1918 space or link-local addresses. Every intentional private target (a
   database, an app, RustFS) is an explicit `external` service in the config, which means a
   capability the user declared and the control plane validated.
2. **systemd.** `IPAddressDeny=` covers the overlay and private ranges. `IPAddressAllow=` covers
   only the loopback addresses that declared bindings need. The agent, the helper socket, Caddy's
   admin socket and the control plane are unreachable from the host, matching the existing
   process sandbox.

### 4.7 Limits, scale to zero, and the busy-loop problem (FN4, FN5)

Open-source workerd enforces no limits, so Skiff sets them outside it:

| Limit | Mechanism |
|---|---|
| Memory | cgroup `MemoryMax` = `memoryMb`. V8 heap via `v8Flags = ["--max-old-space-size=<memoryMb·0.75>"]`. An OOM kills the host, and systemd restarts it on the next connection. |
| CPU share | `CPUQuota` (from `cpus`) and `CPUWeight` in the workloads slice |
| Wall clock | Caddy `response_header_timeout` per route (5 min, sized for long AI calls), plus a shim-side `AbortSignal` timeout for `scheduled` and `queue` |
| Request body | The existing site `request_body` limit |
| Runaway CPU | The agent probes the shim's internal `/__skiff/health` on the host socket every 5 s. Three missed probes restart the host and log a `function_watchdog` line. (The proposal's "while the cgroup is at its CPU quota" gate is not implemented yet.) **Honest limit: one busy request stalls its project's host until the watchdog fires.** |
| Concurrency | One event loop per host. Throughput scales with `replicas`; same-node prefork over the shared listening socket is spike S6. |

**Scale to zero.** The `.socket` unit stays listening while the service is stopped, and systemd
starts workerd on the first connection. The agent stops a host after `idleStopSeconds` (default
300, `0` means always on) with no requests, measured from the Caddy access log it already tails for
telemetry (scale-to-zero is skipped when no access log is configured). A cold start costs
process start plus module compile. S2 measures it, and the target is under 150 ms p50 for a small
bundle on the edge VPS. Admission still reserves `memoryMb` for idle hosts at first.
Overcommitting idle hosts is an explicit later decision.

**Deploys and restarts.** A new release or secret writes a new config and restarts the host.
Because the socket is held by systemd, new connections queue during the restart rather than being
refused. Draining in-flight requests on `SIGTERM` is spike S3 (workerd has a drain path; confirm
its behaviour). Durable Object state survives restarts because it is on disk.

### 4.8 Trust model (FN6)

| Boundary | Mechanism | Who it protects |
|---|---|---|
| Between requests in one project | V8 isolates in one process | Nobody: same code, same tenant |
| Between projects, the same org included | A separate process, `DynamicUser`, cgroup, per-unit IP filter, a separate volume subtree | Projects from each other's bugs and noisy neighbours |
| Function → platform | Capability bindings + systemd sandbox + no reachable control sockets | The node and the platform |
| Hostile tenants (open sign-ups) | **Not supported.** Same position as process apps today. | — |

This matches the process tier exactly. A function is less powerful than a process app, which
already runs arbitrary native code under this sandbox. A stronger tier for hostile code (workerd
under gVisor through Podman `--runtime=runsc`, or a microVM) is a later bet and would apply to
process apps as well. It is not a Functions-only feature.

### 4.9 State, placement and HA (FN11)

- **Phases 1–3: node-local state.** Durable Object, KV and D1 data lives at
  `<volume>/skiff/fn-<workload-id>/`. The rules a running app follows apply: it never changes node
  on its own, and moving it is stop → copy → start (D97). Backups take SQLite snapshots through
  the D83 backup path to the platform `ObjectStore`, with restore to a new project.
- **Stateless functions** (no Durable Object, KV or D1 bindings) can run `replicas > 1`
  across nodes as soon as CLUSTERING §8.2 multi-node replicas land, because they have no state to
  place.
- **Phase 4: workerd cluster mode.** Each stateful project's replicas form **their own cluster**:
  - bucket prefix `functions/<project-id>/` on the platform `ObjectStore`, or a managed RustFS
    instance once one is replicated (D71 allows only a replication target today, so this needs a
    decision);
  - the cluster `key` delivered through activation;
  - `address` and `advertise` set to the node's `wg0` address, which meets workerd's "private
    network" requirement and its refusal of public addresses;
  - configs rendered by Skiff and identical across replicas by construction. Skiff never uses the
    shared `workerd deploy` catalog, because its authority model (§1.1 fact 6) is wrong for tenants.

  Ownership by conditional write, epoch bumps on takeover, and LTX restore from the bucket give
  failover close to celld's measured ~20 s, which suits HA level `failover` (CLUSTERING §8.1). This
  phase waits for cluster mode to drop `--experimental` or to pass Skiff's own failure tests (S8).

### 4.10 Triggers (FN9)

- **HTTP**: §4.2.
- **Cron.** `triggers.crons` rides desired state. The agent's function scheduler (UTC, shared
  five-field parser in `@skiff/contracts`' `cron.ts`) keeps a persisted cursor and `POST`s due
  occurrences to the shim's internal `/__skiff/scheduled` on the host socket; the shim calls the
  user's `scheduled(controller, env, ctx)`. The contract proposed a systemd `.timer` per schedule;
  the shipped scheduler is in-agent because it needs no per-project unit and keeps the cursor with
  the workload's other node state. The route is reachable only from the socket, never from Caddy.
  Delivery is one run per occurrence per project, from the node that owns the workload, with no
  control-plane round trip. Phase 4 moves this to a cluster run lease (CLUSTERING §8.4)
  for multi-node functions.
- **Queues** (D112): `triggers.queues` (Wrangler `queues.consumers`) rides desired state. For each
  consumer the agent holds a connection to the project's managed broker, pulls up to
  `maxBatchSize` messages (waiting at most `maxBatchTimeout` for the batch to fill) from the
  queue's durable JetStream consumer, and `POST`s them to the shim's internal `/__skiff/queue` on
  the host socket, which socket-activates an idle-stopped host and counts as activity. The shim
  gives `queue()` Cloudflare's `ack()`/`retry()`/`ackAll()`/`retryAll()` and returns a verdict per
  message: a handler that returns acks what it did not retry, one that throws retries what it did
  not ack. Retries wait `retryDelay` (or 1 s doubling to 60 s); after `maxRetries` a message goes to
  `deadLetterQueue` or is dropped with a warning. Delayed sends carry `Skiff-Not-Before` and are
  held back with a timed NAK, which does not count as an attempt. Only replica 0 consumes.
  Producer bindings publish from inside workerd (`packages/function-bindings/src/queue.js` over
  the shared `nats.js` client), and `send()` resolves once JetStream has stored the message. Queue
  data lives in the broker, so queue bindings no longer pin a function to one host or need its
  durable-storage directory. Messages sent with the default `v8` content type still reach the
  consumer base64-encoded; use `contentType: "json"` or `"text"` (or the `queues_json_messages`
  flag).
- **Events** (D122): platform events (bucket uploads and deletes, alerts, deployments, database
  backups) are published into a queue by an event rule, and the function consumes that queue as
  above. Storage events use R2's notification body. See [EVENTS.md](./EVENTS.md).
- **Alarms**: native to Durable Objects.

### 4.11 Surfaces

- **CLI**: `skif deploy` detects `wrangler.jsonc`/`wrangler.json`, bundles with Skiff's own pinned
  bundler (§4.3, D113), generates the internal manifest, and creates the project as
  `runtime: "function"`. Deploying needs no Wrangler install. `skif wrangler …` passes any Wrangler
  command through (`dev`, `tail`, `types`, …), installing Wrangler as a project dev dependency when
  it is missing (or using an ephemeral runner when there is no package.json). Local development is
  plain Wrangler. Logs use `skif logs`. `skif function invoke <slug> [path]` (`-X`, `-H`, `-d`,
  `-i`) sends a test request and `skif function cron <slug> '<cron>'` runs a cron now (D124).
- **MCP**: `deploy_site` accepts function bundles, alongside `get_function`,
  `list_function_invocations`, `invoke_function` and `run_function_cron` (the dashboard
  assistant asks before both). As with every other surface, MCP tools return no secrets.
- **Dashboard**: a Runtime card for functions showing compatibility date, bindings, cron,
  cold-start and invocation charts (from ClickHouse), and idle-stop. The **Test** tab sends a
  request (method, path, headers, body) and shows the status, headers, body, duration and whether
  it cold-started; runs any cron now; and drops a message into a queue the function consumes.
- **Test tools (D124)** run on the function's node as node tasks (see BROKERS.md §5.1): the agent
  sends the request straight to replica 0's host socket, so domains, Caddy and access rules are
  skipped, paths under `/__skiff/` are refused and the internal header is stripped. A test request
  socket-activates an idle-stopped host and counts as activity, but is not in Invocations (those
  come from the access log). Both need `deployment:create`. Responses are cut at 256 KiB.
- **Assistant (later, phase 5)**: the Worker Loader binding is a natural sandbox for the assistant's
  own code mode (D106). It could run generated JavaScript against Skiff's typed API with
  `globalOutbound: null`, the pattern Cloudflare's own MCP server uses. That is a separate,
  explicitly gated decision.

### 4.12 Distribution and updates (FN1)

- Ship the `workerd` binary for linux-x64 and linux-arm64 from npm (`workerd` and its platform
  packages) inside Skiff's **signed release** (self-update v2). Record its version and sha256 in
  the release manifest, install it to `/usr/lib/skiff/workerd/<version>/`, and never fetch it at
  runtime.
- workerd publishes a release almost daily. Skiff **pins one per Skiff minor** and bumps it
  deliberately. The pinned version sets the maximum `compatibilityDate`, and old dates keep
  working, so a bump never breaks a deployed function.
- Old versions stay on disk while any workload references them, which keeps rollback exact.

### 4.13 Other languages (D121)

Three routes, chosen by what the code is:

| Language | Route | How it runs |
|---|---|---|
| JavaScript, TypeScript | Function | The bundler (D113) and the JS shim, as above |
| Rust (workers-rs), Go (TinyGo), C/C++, Zig | Function | A JS entry imports a `.wasm` file; the bundler emits it as a `CompiledWasm` module (`wasm` in the manifest) |
| Python | Function | Python Workers on the pinned workerd's Pyodide (below) |
| PHP | Process app | FrankenPHP on an inherited socket, scaling to zero (below) |
| Node.js servers (Express, Fastify, Next.js, …) | Process app, `engine: "node"` | The pinned Node.js LTS; the helper's preload moves `listen()` onto the inherited socket, so it scales to zero (below, D125) |
| Ruby, Python (WSGI/ASGI), Go, anything else | Process app | Any server that listens on fd 3 (Puma, Gunicorn `--bind fd://3`, Uvicorn `--fd 3`, `server.listen({ fd: 3 })`), scaling to zero |

**Python Workers.** A wrangler config whose `main` ends in `.py` is a Python Worker. `skif deploy`
runs `build.command` (normally `uv run pywrangler sync`, which vendors `pyproject.toml` dependencies,
the `workers` SDK included, into `python_modules/`), then ships every `.py` file under the entry's
directory, named relative to it, plus every file under `python_modules/` (`.py` as `python` modules,
everything else as data). Bytecode caches and `*.dist-info` are left out; the 512-module cap applies.
The control plane adds the `python_workers` flag and reserves 384 MB unless `skiff.memoryMb` says
otherwise (at least 256). A bundle cannot mix Python and JavaScript modules.

A JavaScript module cannot import a Python one, so a Python host is two Workers in one workerd:

```
socket ─▶ skiff-shim (JS, the function-shim credential)
            │  /__skiff/health            answered here, never wakes Python
            │  public request             env.USER.fetch(request)
            │  /__skiff/scheduled         env.USER.scheduled({ cron, scheduledTime })  → 204 / 500
            │  /__skiff/queue             env.USER.queue(name, messages) → per-message verdicts
            ▼ USER service binding
          main (Python: entry module first, the manifest's bindings, DOs, tail)
```

`scheduled()` and `queue()` on a service binding deliver real events with Cloudflare's semantics
(explicit `ack()`/`retry()`, `ackAll()`, `retryAll()`, a thrown handler retries), but workerd only
exposes them under `service_binding_extra_handlers`, an experimental flag. The agent sets it on the
shim Worker only and the helper adds `--experimental` to Python hosts only. Calling those methods
without the flag dispatches them as RPC with the wrong argument shapes, which is why it is not
optional. Everything the agent sees (health, internal routes, the queue result body) is the same as
for a JavaScript host.

Pyodide is not part of the workerd binary: workerd downloads a bundle per compatibility-date era
(0.26 before 2026-06-10, the CPython 3.14 build after; ~36 MB together). The installer starts the
pinned workerd once per era with a probe Worker and a scratch cache, then moves the bundles to
`/usr/lib/skiff/workerd/<version>/pyodide` (`scripts/install/pyodide.ts`, `--no-python` skips it);
convergence does the same after a pin bump on nodes that had a cache. Python hosts get
`--pyodide-bundle-disk-cache-dir` pointing there, read-only. The agent adds `functions-python` to its
heartbeat only while a bundle is present, and placement refuses a Python function on any other node,
so a host never fetches its runtime at cold start.

**Process apps that scale to zero.** `WorkloadSpec.idleStopSeconds` (process runtime, socket
activation on, HTTP ingress, one replica; 0 or absent is always on) reaches the node as
`WorkloadDesired.idleStopSeconds`. The function scheduler's idle sweep covers these units too: the
same access-log activity signal, the same "first sight and restarts reset the timer" rules, and
`helper.stop` of the service while the `.socket` keeps listening. The watchdog and cron stay
workerd-only. The runtime treats such a stopped unit as steady state. The app must adopt the
inherited listener; Bun cannot yet, so Bun apps keep socket activation off and stay always on.

**PHP.** FrankenPHP is PHP embedded in Caddy, and Caddy listens on an inherited fd with
`bind fd/3`, so a PHP app is a process app whose command is `frankenphp run --config Caddyfile`
(`examples/php-frankenphp`). The static Linux build is ~175 MB, over the 25 MB release per-file
limit, so it is installed on the node like workerd: pinned version and SHA-256 digests in
`scripts/install/frankenphp.ts`, opt-in with `--with-php` (or that script on an installed node),
linked at `/usr/local/bin/frankenphp` (on every process unit's `PATH`), and refreshed by convergence
only on nodes that already have it. Checked with FrankenPHP 1.13.2 (Caddy 2.11.7): it serves on the
passed socket only, opens no TCP port, and exits 0 on `SIGTERM`.

**Node.js (D125).** A process app with `engine: "node"` runs on the Node.js LTS the installer
pins in `scripts/install/node.ts` (26.13.0, SHA-256 per architecture): the official tarball under
`/usr/lib/skiff/node/<version>/`, with `node`, `npm` and `npx` linked into `/usr/local/bin`. It is
installed by default (`--no-node` declines it), convergence adds it to agent hosts that lack it and
follows pin bumps, and an operator's own `/usr/local/bin/node` is never replaced. The agent
advertises `process-node` while the binary exists; placement refuses Node apps elsewhere.

- **Command.** Blank runs the package.json `start` script as `/bin/sh -c`, with the release's
  `node_modules/.bin` and the pinned Node first on `PATH`. Not `npm start` or `node --run start`:
  both start the script with every non-stdio fd closed (checked on Linux and macOS), so the app
  never sees its socket. The contract refuses those launchers (and `npx`, `pnpm`, `yarn`,
  `corepack`) as a socket-activated Node command; with socket activation off any command works.
- **Socket.** With socket activation on, the helper writes a CommonJS preload into the workload's
  runtime directory, passes it as the `skiff-node-listen.cjs` credential and sets
  `NODE_OPTIONS=--require=%d/skiff-node-listen.cjs <the app's own NODE_OPTIONS>` in the unit (the
  app's value comes out of the env file, which would otherwise override it). The preload rewrites
  the first TCP `listen()` of each process to `listen({ fd: 3 })` and clears `LISTEN_*`; a listen
  on a path, fd or handle passes through, so an app that adopts fd 3 itself still works.
  `LISTEN_PID` is ignored because the server is the shell's child. An unchanged Express or Next.js
  server therefore serves on the project socket and can use `idleStopSeconds`.
- `examples/node-http` is a dependency-free server with its workload spec.

---

## 5. Phased plan

| Phase | Goal | Contents | Effort | Exit criteria |
|---|---|---|---|---|
| **0. Spikes** | De-risk before any contract change | S1–S8 below | S | A results row per spike in [SPIKES.md](./SPIKES.md) |
| **1. Fetch functions** | Ship stateless `fetch` functions | Runtime `function` in contracts and admission; bundle and manifest validation; helper unit plus pinned binary; agent config renderer and shim; vars and secrets; assets-first routing; egress policy; journald logs; preview, promote and rollback; `skif deploy` with `wrangler.jsonc`; dashboard card; MCP | M–L | A `wrangler init` hello-world plus a Hono API deploy unchanged; previews and rollback work; the SSRF suite (loopback, overlay, metadata IPs) is blocked; feature flag on by default |
| **2. Bindings** | Durable data | Durable Objects on a volume; R2 → RustFS; Hyperdrive → PgBouncer; KV; D1; Analytics Engine → ClickHouse; Cache; SQLite backups and restore | L | A chat-room Durable Object with hibernating WebSockets survives a host restart; an R2 put/get round-trips to RustFS; a D1 backup restores to a new project |
| **3. Triggers and economics** | Lambda-style | Cron timers; queues; scale to zero with idle stop; the runaway watchdog; tail workers → OTLP; cross-project service bindings | M | A cron fires exactly once per occurrence across agent restarts; an idle function holds 0 MB; cold-start p50 is within the S2 target |
| **4. HA** | Survive node loss | Multi-node stateless replicas; workerd cluster mode per stateful project; Workflows | L | The CLUSTERING §11 failure matrix rows for functions pass, including killing the owner of a Durable Object |
| **5. Later bets** | — | Worker Loader for user code and the assistant's code mode; a gVisor tier; Python memory snapshots for faster cold starts. Python Workers and Wasm languages shipped as D121 (§4.13). | — | Each needs its own FN or D decision |

### 5.1 Spikes

| # | Question | Pass condition |
|---|---|---|
| S1 | Does the prebuilt workerd run under the helper's sandbox (`DynamicUser`, `ProtectSystem=strict`, `MemoryDenyWriteExecute` **off**, since V8 needs W^X toggling) on Debian 13 and Ubuntu 26.04, with `--socket-fd` from systemd socket activation? | It serves `fetch` through `/run/skiff-workloads/<id>.sock` |
| S2 | Resident memory of an idle host with one small Worker, and cold-start latency (socket connect → first byte) for 50 KB and 2 MB bundles | Numbers recorded. The design holds if idle RSS is ≤ 40 MB and cold start p50 is ≤ 150 ms on the edge VPS. |
| S3 | `SIGTERM` behaviour: do in-flight requests drain, and do WebSockets close cleanly? | A documented drain window. `TimeoutStopSec` set to match. |
| S4 | Shim pattern: can a generated entry module wrap the user's default export *and* re-export Durable Object classes and named entrypoints without changing behaviour? | Wrangler's `tests` examples pass through the shim |
| S5 | Egress: the `network` allow list plus `IPAddressDeny` blocks loopback, `wg0`, `169.254.169.254` and IPv6 ULA, while `external` binding targets still work | The SSRF suite passes |
| S6 | Busy loop: one `while(true)` request. Watchdog timing, and whether other connections to the same host stall. Can two workerd processes share one inherited socket as a prefork? | A watchdog restart in ≤ 20 s; prefork answered yes or no |
| S7 | Port Miniflare's KV and R2 services to run in production mode (no dev-only APIs, no `unsafeEval`), against RustFS | KV and R2 conformance subsets pass |
| S8 | Cluster mode: three nodes on `wg0`, RustFS as the bucket. Kill the owner of a Durable Object under write load and check durability (no acknowledged write lost) and failover time. | No lost acknowledged writes. Failover ≤ 30 s. |

---

## 6. Proposed decisions

| # | Proposal | Why | Rejected |
|---|---|---|---|
| FN1 | **workerd is the Functions runtime, shipped pinned in Skiff's signed release.** Amends D6: Caddy and workerd are the non-Bun components. | It is the only open runtime with Workers fidelity, and Cloudflare now backs self-hosting as "first-class" (2026-10-09). The pinned version sets the maximum compatibility date. | Bun (no isolates, no Workers API); Deno (end of life ~2027-10); celld (being merged, PRs closed); Miniflare as a server (dev tool); WASM-only runtimes (no Workers compatibility); a runtime fetch of the binary |
| FN2 | **`runtime: "function"` is a fourth tier (amends D1), implemented as a specialised process workload.** | Reuses the helper unit, socket activation, admission, logs, previews and rollback. Almost nothing in the pipeline is new. | A separate "edge functions" subsystem with its own scheduler |
| FN3 | **One workerd host per project environment.** Never shared across projects. | workerd has no isolate limits and one event loop, so the process is the only fault and fairness boundary. | A shared host per node or per org, which is denser but lets one project stall another |
| FN4 | **Hosts are socket-activated and stop when idle** (default 300 s, configurable, `0` = always on). | Lambda-style economics within the 250 MB edge budget | Always-on hosts; overcommitting admission (deferred) |
| FN5 | **Limits come from outside workerd**: cgroup memory and CPU, the V8 heap flag, Caddy timeouts and an agent watchdog. Per-request CPU limits are documented as unsupported. | The open-source server ships null limit enforcers | Patching workerd's limit enforcer (a fork to maintain) |
| FN6 | **The trust model equals the process tier.** Org members may run code. Hostile multi-tenant use is unsupported until a gVisor or microVM tier exists for all runtimes. | Functions are strictly less powerful than process apps | Marketing functions as a hostile-code sandbox |
| FN7 | **Default-deny private egress**: workerd `network` `allow=["public"]` plus systemd IP filtering. Private targets exist only as declared `external` bindings. | SSRF into the overlay and loopback is the main new risk | Relying on either layer alone |
| FN8 | **`wrangler.jsonc` is the source config.** Clients bundle with Skiff's own pinned bundler (D113); Skiff maps bindings by name and validates a `skiff-function.json` manifest. Unsupported bindings fail the deploy. | Code ports both ways, `wrangler dev` is the local loop, and D2 holds | A Skiff-only config format; building on the control plane; silently dropping bindings; running the user's Wrangler to bundle |
| FN9 | **Cron fires on the node** through a systemd timer and an internal shim route. Phase 4 adds run leases. | Pull, not push (invariant 1). No control plane in the trigger path. | The control-plane scheduler pushing invocations |
| FN10 | **Binding services run inside the function's own host**, ported from Miniflare where possible (Apache-2.0 notices kept). R2 maps to RustFS, Hyperdrive to PgBouncer, Analytics Engine to ClickHouse. | No new daemon. Tenant data stays in the tenant's sandbox. Reuses managed services. | A node-wide binding daemon; a control-plane KV |
| FN11 | **Stateful functions are single-node until workerd cluster mode passes S8.** Each project is then its own cluster on its own bucket prefix, over `wg0`, with Skiff-rendered configs. The shared `workerd deploy` catalog is not used. | Adopts upstream's design rather than inventing one. Upstream's authority model is wrong for tenants. | A Skiff-built Durable Object router; running celld alongside workerd |
| FN12 | **Feature flag `SKIFF_FEATURE_FUNCTIONS`, on by default; `0` disables the tier.** It shipped on once phases 1–3 passed; a disabling flag remains for operators. | Standard for risky work, now shipped | — |

---

## 7. Risks and open questions

- **Upstream churn.** Cluster mode is days old and experimental, and the celld merge has "more
  announcements … in the coming months". Phases 1–3 depend only on stable workerd features; phase 4
  is explicitly gated on upstream.
- **Cloudflare-specific semantics.** KV is strongly consistent here (stricter than Cloudflare's, so
  safe). `request.cf` geo fields are filled from `CF-Connecting-IP` and `CF-IPCountry` when the
  zone is proxied, and are otherwise empty. Document the differences in a compatibility page, as
  celld does.
- **Memory budget.** If S2 shows a host above about 40 MB idle-resident, scale to zero becomes
  essential rather than nice to have, and the default `memoryMb` may rise.
- **Python Workers (D121).** Measured on workerd 1.20261106.1: an idle Pyodide host is ~230 MB
  resident (a JS host ~30 MB) and a cold start from the warmed cache is ~1.2 s, so the default
  reservation is 384 MB and scale to zero matters more. `--experimental` is on for Python hosts
  only, for `service_binding_extra_handlers`; if upstream renames or graduates that flag the shim
  Worker's flag list is the one place to change. Memory snapshots (`--python-load-snapshot`) would
  cut the cold start and are not used yet.
- **Licensing.** workerd, Miniflare and celld are Apache-2.0, and Skiff is MIT. Shipping the
  binary and ported code needs `NOTICE` and licence files in the release; that is not a blocker.
- **Open decisions:** whether the cluster bucket may be a managed RustFS instance (D71 tension);
  overcommitting admission for idle hosts; whether previews of function projects get their own
  host or share production's with a header switch.

---

## 8. Not doing

- A hostile-multi-tenant "Workers for Platforms" product (dispatch namespaces for strangers).
- Cloudflare's network-bound products: Workers AI, Vectorize, Browser Rendering and Email.
- Containers bindings. workerd's engine is Docker-only, which breaks invariant 8. Use a Skiff
  container app plus a binding.
- A global edge network. Functions run where the project is placed. Cloudflare in front gives
  caching and TLS, not compute.

---

## 9. Sources

Checked 2026-11-06.

- workerd README, including the self-hosting and "not a hardened sandbox" sections:
  <https://github.com/cloudflare/workerd>
- workerd config schema, covering `ClusterConfig`, `workerLoader`, `durableObjectStorage`,
  `containerEngine`, `network` and `hyperdrive`:
  <https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp>
- workerd null limit enforcers: `src/workerd/server/AGENTS.md`,
  `src/workerd/server/factory/worker-factory.c++`
- workerd cluster commit history: `src/workerd/server/cluster/`. The first commit is "Cluster
  workerd processes over a shared bucket (#7994)", 2026-10-29. "Add `workerd deploy` for cluster
  deployments" followed on 2026-11-05.
- Cloudflare, "Deno joins Cloudflare" (2026-10-09): <https://blog.cloudflare.com/deno-joins-cloudflare>
- Deno, "Deno is joining Cloudflare" (2026-10-09): <https://deno.com/blog/cloudflare>
- celld README: <https://github.com/denoland/celld>. Overview by Flavio Copes (updated
  2026-10-16): <https://flaviocopes.com/celld/>
- Miniflare: <https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare> (simulators
  in `src/workers/`) and <https://developers.cloudflare.com/workers/testing/miniflare/>
- Wrangler commands, including `deploy --dry-run --outdir`:
  <https://developers.cloudflare.com/workers/wrangler/commands/workers/>
- Dynamic Workers: <https://developers.cloudflare.com/dynamic-workers/>
- Pingora: <https://github.com/cloudflare/pingora>. Cap'n Web: <https://github.com/cloudflare/capnweb>
