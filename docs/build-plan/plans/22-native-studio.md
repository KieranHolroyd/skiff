# 22 — Native database studio

**Priority:** P1 · **Effort:** L · **Lane:** E · **Wave:** 3
**Depends on:** 03 TLS (agent dials with the helper CA), 04 named credentials, D95 engine
registry, the shipped DBGate studio (06-database-studio.md) for its session model
**Blocks:** 20 `query_database` (shares the Postgres plugin and the read-only path)
**Supersedes:** D60's choice of DBGate (proposed D96 below)
**Primary files:** `packages/studio/**` (new), `apps/agent/src/studio/**` (new),
`scripts/systemd/skiff-studio.service` (new), `apps/helper/src/{server,validate}.ts` (studio verbs),
`apps/control-plane/src/routes/(dashboard)/databases/[name]/studio/**`,
`apps/control-plane/src/lib/studio/**` (new), `packages/core/src/databases.ts` (console section)

> **Status (6 Nov 2026):** Phases 1 and 2 (plugins and UI) are built behind
> `SKIFF_FEATURE_DB_STUDIO` (default off). Every plugin passes the conformance suite against real
> containers. The UI is checked against mocked studio calls, not yet end to end on a node. Next:
> track G (read-only principals), a live run on a node, then Phase 3 cutover.

## Goal

Replace the DBGate sidecar with Skiff's own database studio, built into the dashboard. It must
be:

- **Lightweight.** No container, image pull or extra daemon per database. Nothing runs or uses
  memory until someone opens a studio.
- **Plugin-based per engine.** Each engine is one driver plugin behind a small interface, with
  capabilities that the UI reads to decide what it shows. Adding an engine means adding a plugin
  and passing the shared conformance suite. The UI does not need new code.
- **Native.** A Svelte workspace using the dashboard's own components, session and permissions.
  No iframe, no framing exception and no second login.

It covers all six D95 engines: Postgres, MySQL, MariaDB, MongoDB, Valkey and Redis.

## Non-goals (v1)

- ERD diagrams, a visual schema designer, and ALTER TABLE forms. DDL runs through the SQL editor.
- Bulk import, and dump/restore. Plan 17 covers portability.
- Transactions held open across several editor runs. Each run is one implicit transaction.
- Redis/Valkey Cluster or Sentinel. Skiff runs single nodes, and Bun's client has no cluster
  support.
- Running JavaScript from the Mongo shell on the server. Mongo commands are EJSON documents only.
- Saved queries shared across the org. v1 keeps query history in the browser only.

## Research findings (summary)

| Tool | Driver shape | What we take from it |
|---|---|---|
| DBGate | One ~150-member `EngineDriver` per plugin, with boolean capability flags; results spooled to JSONL files | Capability flags; `scanKeys`/`readCollection` for non-SQL engines. **Avoid** the giant interface. |
| Adminer | About 30 functions per driver, with one `support($feature)` regex | Proves a small surface is enough. Per-engine `slowQuery` timeouts. |
| Prisma Studio | `Adapter {introspect, query, raw, insert, update, delete}`, `capabilities`, separate `Executor` | Closest to our stack (it uses CodeMirror and TanStack Table). Splits the adapter from transport. |
| Outerbase | `BaseDriver` subclassed per dialect, with `getFlags()` | Refuses edits on tables with no primary key, or a NULL primary key. |
| Drizzle Studio | A closed UI behind a 4-message JSON proxy (`init`/`proxy`/`tproxy`/`defaults`) | A thin wire protocol is enough. Introspection is catalog SQL sent through it. |
| pgweb | Re-runs `SET default_transaction_read_only=on` before **every** query | A session-level read-only flag is not a security boundary. |
| RedisInsight | `SCAN … COUNT ≤2000 TYPE t`, then a pipeline of `TYPE`/`PTTL`/`MEMORY USAGE` | The key-browser algorithm. |
| Compass | `$sample` of 1,000 documents to infer a schema | The document-schema algorithm. |

Runtime facts that drive the per-engine choices (Bun 1.4.x, checked 6 Nov 2026):

- **Bun.SQL, Postgres.** `unsafe()`, column OIDs in `result.columns`, and a real `query.cancel()`
  (CancelRequest; this was a no-op before #45304, merged 17 Oct 2026). It has **no row
  streaming**. A `DECLARE … CURSOR` / `FETCH n` loop inside `sql.reserve()` works.
- **Bun.SQL, MySQL/MariaDB.** It buffers whole results: 1M rows took 159 MB of heap (#46529).
  It cannot cancel a query already in flight, and has no per-query timeout. **This makes it
  unsafe for arbitrary SQL in a long-lived process.** `mysql2` 3.24 has `.stream()` and timeouts.
- **Bun RedisClient.** RESP3, needs ≥7.2 (we ship Valkey 8.1/9.1 and Redis 8.8/8.10).
  `send(cmd, args)` runs any command. Cluster support is missing.
- **`mongodb` 7.8.** About 5.7 MB unpacked with `bson`. It is not officially supported on Bun,
  and two Bun bugs in it were fixed in October 2026. It needs a spike.
- **Editor size** (measured with `bun build --minify`): CodeMirror 6 with `lang-sql` and
  `lang-json` is **147 KB gzipped**, against 703 KB plus workers for Monaco's core.
  `lang-sql` has PostgreSQL, MySQL and MariaSQL dialects, and schema-aware completion fed from
  a namespace object. No Redis mode exists, so we write a small `StreamLanguage`.
- **Wire format.** NDJSON over `fetch` POST. An `AbortController` in the browser becomes
  `request.signal` at the agent, which the driver turns into a cancel. SSE can't send a request
  body, and WebSocket is only worth it for long-held transactions, which are a non-goal.

## Spike results (6 Nov 2026)

Run on macOS arm64 against throwaway containers. Postgres 17, MySQL 8.4, MariaDB 11.8,
MongoDB 8.0 and Valkey 9.1 each got 1–2M-row fixtures. Compiled binaries were built with
`bun build --compile` and ad-hoc signed. The scripts are throwaway and were not committed.

| Spike | Result |
|---|---|
| S4 Postgres, Bun.SQL | **Bun 1.4.0 (our pin) is not enough.** `result.columns` is `undefined`, and `query.cancel()` does nothing (a 60 s `pg_sleep` runs to the end). **On Bun 1.4.4 both work:** column OIDs are returned, and cancel takes 309 ms with error 57014. `DECLARE`/`FETCH 500` inside `reserve()` returns the first batch in 4–6 ms, and RSS rises about 5–8 MB over 10k rows. `SET LOCAL statement_timeout` gives 57014. Read-only transactions refuse DDL with 25006. `.simple()` returns one result per statement. Types come back as: int4 → number, int8/numeric → string, bytea → Buffer, timestamptz → Date. |
| S2 mysql2 3.x | Rows stream on MySQL 8.4 and MariaDB 11.8, first row in 2 ms, and RSS rises about 6 MB. **After `destroy()` the stream keeps emitting rows already buffered on the socket (2,848 rows for a cap of 1,000)**, so the plugin must ignore rows past the cap and call `pause()` before `destroy()`. `KILL CONNECTION` from a side connection cancels in about 300 ms. MySQL's `MAX_EXECUTION_TIME` interrupts `SLEEP()` with a *result* (`1`), not an error, while real scans fail with 3024. MariaDB's `SET STATEMENT max_statement_time=… FOR` raises an error. `START TRANSACTION READ ONLY` refuses writes. Multiple result sets work. **MariaDB reports `JSON` as LONGTEXT (type 252)**, so the plugin must detect JSON columns from `information_schema` `json_valid` CHECK constraints. Adds about 1.3 MB to the compiled binary. |
| S1 mongodb 7.8 | Works compiled under Bun 1.4.0. Connect takes 20 ms; the first 1,000 documents arrive in 11 ms; RSS rises 17 MB. Canonical EJSON, `$sample` schema inference and `db.command(EJSON.parse(text))` all work. **`killOp` cancel works:** `$currentOp` matched by `comment` interrupts the operation in 430 ms. `maxTimeMS` gives `MaxTimeMSExpired`. **Import EJSON as `BSON.EJSON` from `mongodb`:** the named `EJSON` export is `undefined` in a compiled binary. Adds about 1.4 MB. |
| Bun RedisClient vs Valkey 9.1 | `send()` works for SCAN with `TYPE`, `TYPE`, `MEMORY USAGE`, HGETALL (a RESP3 map becomes an object) and ZADD/XADD. `SCAN COUNT 500` returned 501 keys, so the plugin caps and de-duplicates. `COMMAND INFO` flags (`readonly`, `write`) are usable for the read-only second layer. **An ACL user with `+@read -@write -@admin -@dangerous` is refused `SET` and `FLUSHALL` (NOPERM).** No extra dependency. |
| S3 Caddy gateway | Two hops (edge Caddy 2.11, then worker Caddy, then Bun upstream), using the existing `compileProxyRoute` config (`flush_interval: -1`). NDJSON lines arrive unbuffered: the first in 12 ms, then one every 250 ms as sent. **A client abort reaches the upstream `request.signal`** (the upstream saw the abort after 4 chunks). `Host` and the token header pass through. The SvelteKit hop in between is still unmeasured; Phase 1 covers it. |

**What changes because of the spikes:**

- **Bump Bun from 1.4.0 to ≥ 1.4.4 before Phase 2** (Phase 1, step 0). Update the CI
  workflows, `publish.yml`, `release.yml`, `cli-release.yml`, `docker/node/Dockerfile` and
  `docs/OPS.md`. Re-check the Bun 1.4.0 workaround in `apps/agent/src/releases.ts`, and
  re-measure `docs/SPIKES.md`. The Postgres plugin's conformance suite requires the bump for
  cancel and column types.
- Binary cost: about +3 MB for all drivers together, not the +6 MB estimated. Lazy loading still
  keeps idle RSS unchanged.
- Every finding above is a named conformance case: row cap after `destroy`, MariaDB JSON,
  `MAX_EXECUTION_TIME` returning a value, `BSON.EJSON`, and SCAN overshoot.

## Current state

- D60 runs a DBGate container per database, opened on demand through `databaseConsoles` desired
  state tasks. Opening is slowed by the 10 s heartbeat. It allocates a loopback port per
  database (17432–18431) and reaches the container through the internal Caddy gateway (D82).
  The browser sees DBGate in an iframe, with a sealed per-session Basic password injected by the
  SvelteKit proxy.
- **Reusable:** the session model and its `console_*` columns (open, touch, TTL 60 min, idle
  15 min, `tickConsoles`), the `database:console` and `database:update` permissions, the
  `database.console.*` audit names, `SKIFF_FEATURE_DB_CONSOLE`, the `console` capability, the
  Studio tab, and the gateway pattern.
- **DBGate-specific (to delete at cutover):** the image pin and unit/env renderers, the helper
  `console/start|stop` verbs, the agent readiness probe, per-database port allocation, the
  iframe and its `hooks.server.ts` framing exception, and the per-database gateway routes.
- **Existing drivers:** only the agent's Postgres stats sampler, which uses Bun.SQL over
  `127.0.0.1:<hostPort>` with helper-CA TLS (`apps/agent/src/database-stats.ts`). It proves the
  agent can already reach every database it hosts.
- **Read-only credentials:** opt-in for Postgres only, as a `readonly` named credential with
  `GRANT SELECT` on `public`. Nothing exists for the other five engines.
- **Invariants that constrain the design** (`docs/build-plan/README.md` §2): there is no
  control-plane-to-agent command channel, and the control plane never dials node loopback
  except through the internal HTTP gateway. Databases are published on loopback only (D56). A
  new always-on daemon would need a memory budget.

## Design

### Where queries run: a separate on-demand studio process, fronted by the agent

```
browser ──fetch NDJSON──▶ SvelteKit /databases/<name>/studio/api/*   (session, permission, audit)
         ◀──stream──────        │ fetch, Host: studio.<node>.internal, X-Skiff-Studio: <token>
                                ▼
                         edge Caddy internal gateway (D82)  ──WireGuard──▶ worker Caddy
                                                                              │
                              skiff-agent (front)  127.0.0.1:<SKIFF_STUDIO_PORT>
                              token check · activation fetch · start studio · byte pump
                                                                              │ unix /run/skiff/studio.sock
                              skiff-studio.service  (`skiff-agent studio`, own cgroup, MemoryMax)
                                                                              │ lazy import(plugin)
                                                                              ▼
                                                              127.0.0.1:<db hostPort>  (TLS: helper CA)
```

- **The drivers run in their own process.** `skiff-studio.service` is a static systemd unit
  shipped next to `skiff-agent.service`. It runs the **same binary** with a different entrypoint
  (`skiff-agent studio`), so release artifacts don't change. It has:
  - `User=skiff`, and the same sandbox as the agent (`ProtectSystem=strict`, no capabilities,
    `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`);
  - **its own cgroup with `MemoryMax=256M`** and `TasksMax=64`. The agent's `MemoryMax=192M`
    cgroup would otherwise also hold a child process, and an out-of-memory kill could pick the
    agent;
  - `Restart=on-failure`, and it is never enabled at boot.
  - It listens only on `/run/skiff/studio.sock` (mode 0660). It has no TCP listener and no
    node token, and it never talks to the control plane.
- **Started on demand, stopped when idle.** On the first studio request, with no studio running,
  the agent calls a new fixed helper verb, `POST /v1/studio/start`. That verb runs
  `systemctl start skiff-studio.service` and takes no arguments. The agent then waits for the
  socket to answer `/healthz`. The studio process exits cleanly after 5 minutes with no
  sessions; that is a clean exit, so systemd leaves it stopped. A node that never opens a
  studio never runs it, so there is still no always-on daemon (README invariant 7).
- **The agent is a thin front.** It binds `127.0.0.1:<SKIFF_STUDIO_PORT>`: one fixed port per
  node, with **one gateway route per node** (`studio.<nodeId>.internal`). It does four things:
  1. checks the session token;
  2. fetches and caches the activation;
  3. starts the studio process if it isn't running;
  4. forwards the request over the unix socket (`fetch(url, { unix })`), streaming both bodies
     and passing the abort through.

  It never imports a driver or plugin, and never parses result rows, so its memory doesn't
  change while results stream.
- **Opening is pull-based, with no desired-state task.** Opening a studio in the control plane
  mints a session token, stored sealed. The first request the agent sees for an unknown token
  makes it call `GET /api/agent/database-studio/:sessionId` (node bearer, with the token). The
  control plane answers with `{databaseId, engine, hostPort, tls, credential, readOnly, limits,
  expiresAt}` only if the token matches a live session for a database **on that node**. The
  agent hands the activation to the studio process with `PUT /sessions/:id` over the socket.
  Credentials live only in the agent's and the studio's memory.
- **Crash isolation.** If a driver crashes or runs out of memory, only the studio process dies.
  Heartbeats, Caddy config and log shipping carry on. systemd restarts the process. If the
  studio answers `unknown session`, the agent sends the activation again and retries once for
  idempotent calls (`tree`, `describe`, `browse`, `value`). For `run`/`apply` it returns
  `studio_restarted`, and the UI offers "Run again".
- **Closing and expiry.** The control plane revokes the token. The agent drops the session, and
  sends `DELETE /sessions/:id` to the studio process, when the session expires, when the
  activation fetch is refused, or when the heartbeat's `studioSessions: string[]` (the ids
  still live) no longer lists it. Connections close after 5 minutes idle.
- **Authentication between the hops.** The token is checked twice: the agent checks it against
  its cached activation, and the control plane checks it again on activation fetch. The gateway
  listener is loopback on the edge and WireGuard-only on workers, as it is today. The unix
  socket is reachable only by the `skiff` user and group.
- **Why not inside the agent.** It would be lighter (no unit and no hop), but a driver bug or
  out-of-memory kill would take the agent down. **Why not a container sidecar like DBGate.**
  That needs an image, a pull and a port per database, and opening waits on the heartbeat.

### Plugin model (`packages/studio`)

A new workspace package. The studio process imports it to run plugins; the agent front and the
control plane import only its protocol schemas and types. Four plugins cover the six engines:

| Plugin | Engines | Client | Notes |
|---|---|---|---|
| `postgres` | postgres | Bun.SQL | Cursor `DECLARE`/`FETCH 500` in `reserve()`; native cancel |
| `mysql` | mysql, mariadb | `mysql2` | `.stream()`; the dialect flag picks `MAX_EXECUTION_TIME` or `max_statement_time`; cancel is `KILL CONNECTION` on a side connection |
| `mongodb` | mongodb | `mongodb` | EJSON commands; cancel is `$currentOp` by `comment`, then `killOp` |
| `keyvalue` | valkey, redis | Bun RedisClient | `send()`; no cancel, so a server-side command allowlist and a client timeout |

```ts
// packages/studio/src/driver.ts — the whole contract a plugin implements
export interface StudioPlugin {
  engines: readonly DatabaseEngine[];
  family: 'relational' | 'document' | 'keyvalue';           // picks the UI workspace
  capabilities(engine: DatabaseEngine, version: string): StudioCapabilities;
  connect(target: StudioTarget, opts: SessionOptions): Promise<StudioSession>;
}

export interface StudioCapabilities {
  language: 'sql' | 'mongo' | 'redis';
  dialect?: 'postgres' | 'mysql' | 'mariadb';                // drives the editor
  edit: 'primary-key' | 'document-id' | 'key' | false;
  cancel: 'native' | 'kill-connection' | 'kill-op' | 'none';
  explain: boolean;
  schemas: boolean;                                          // pg schemas, mongo dbs, redis db index
  types: Record<string, CellKind>;                           // native type → grid cell editor
}

export interface StudioSession {
  tree(path: TreePath): Promise<TreeNode[]>;                   // lazy: one level per call
  describe(object: ObjectRef): Promise<ObjectDescription>;      // columns/fields, keys, indexes, DDL
  browse(object: ObjectRef, q: BrowseQuery, signal: AbortSignal): AsyncIterable<StudioEvent>;
  run(input: string, opts: RunOptions, signal: AbortSignal): AsyncIterable<StudioEvent>;
  explain?(input: string, signal: AbortSignal): Promise<ExplainResult>;
  apply(object: ObjectRef, changes: RowChange[]): Promise<ApplyResult>;   // one transaction
  close(): Promise<void>;
}

export type StudioEvent =
  | { t: 'columns'; columns: Column[] }          // name, nativeType, kind, nullable, key
  | { t: 'rows'; rows: Cell[][] }                // batches of ≤500
  | { t: 'notice'; level: 'info' | 'warn'; message: string }
  | { t: 'result'; affected?: number; command?: string }   // ends one statement's result set
  | { t: 'done'; ms: number; truncated: boolean }
  | { t: 'error'; code: string; message: string; position?: number };
```

- **`browse` is the same idea for every engine.** It returns paged, sortable, filterable rows,
  documents or keys, so the grid, pager and filter bar are shared:
  - **Relational:** keyset pagination on the primary key when there is one, otherwise offset.
  - **Mongo:** filter is an EJSON query, sort and projection apply, and `_id` is used as the
    keyset.
  - **Key-value:** a cursor loop of `SCAN … MATCH … TYPE`, plus pipelined
    `TYPE`/`PTTL`/`MEMORY USAGE`, as RedisInsight does.
- **`apply` takes `RowChange = insert | update | delete` keyed by the full primary key,
  `_id` or key name, with the original values for optimistic concurrency.**
  - **Relational:** `WHERE pk = … AND <edited columns> IS NOT DISTINCT FROM <originals>`. If
    `affected ≠ 1`, it rolls back and returns a conflict. A table with no primary key, or with
    a NULL key, is refused.
  - **Mongo:** `findOneAndUpdate({_id, ...originals})`.
  - **Key-value:** a `WATCH`/`MULTI` per key for `SET`, `HSET`, `ZADD` and so on, and
    `EXPIRE`/`PERSIST` for TTL.
- **Cell encoding is JSON-safe and lossless.** A cell is a plain JSON value when that is
  lossless. Otherwise it is tagged: `{$t:'bigint'|'numeric'|'bytes'|'date'|'json'|'oid'|…, v}`.
  Mongo cells use canonical EJSON. Bytes are base64, truncated at 64 KB with a `truncated`
  marker and a separate "load full value" call.
- **Conformance kit** (`packages/studio/src/conformance.ts`). One suite that every plugin runs
  against a seeded fixture in the Podman e2e harness (`tests/e2e`). It checks:
  - the tree shape;
  - `describe` keys and indexes;
  - stable keyset paging under concurrent inserts;
  - filter and sort;
  - truncation at `maxRows` and `maxBytes`;
  - cancel finishes within 2 s for engines that support it;
  - the read-only credential refuses writes, including `BEGIN READ WRITE`, `SET … off` and
    `COMMIT`-escape tricks;
  - optimistic-concurrency conflicts;
  - lossless round trips of awkward types (bigint, numeric, bytea, timestamptz, json, arrays,
    ObjectId, Decimal128, binary keys).

  The plugins can be built in parallel because this suite is the definition of done.

### Safety and limits (enforced in the studio process, not the browser)

- **Read-only is the credential, not a flag.** Read-only sessions connect as a per-database
  `skiff_studio_ro` principal created by a new helper verb, `credentials/studio-readonly`:

  | Engine | Read-only principal |
  |---|---|
  | Postgres | role in `pg_read_all_data` |
  | MySQL, MariaDB | `SELECT, SHOW VIEW` on the database |
  | Mongo | `read` role |
  | Valkey, Redis | ACL `+@read -@write -@admin -@dangerous ~*` |

  The session flags are a second layer: Postgres `BEGIN READ ONLY` per run, MySQL
  `START TRANSACTION READ ONLY`, and a Redis command check against `COMMAND INFO` flags. Write
  sessions use the owner credential and require `database:update` (unchanged).
- **Limits (defaults, overridable per org by operators):**

  | Limit | Default |
  |---|---|
  | `maxRows` per result | 1,000 (UI can raise to 10,000) |
  | `maxBytes` per response | 16 MB, then `truncated: true` |
  | Statement timeout | 30 s (`statement_timeout`, `MAX_EXECUTION_TIME` / `max_statement_time`, `maxTimeMS`, client-side for Redis) |
  | Runs per session | 1 at a time; a second run cancels or queues |
  | Connections per session | ≤ 2 (browse and run) |
  | Sessions per node | 8 |
  | Postgres `idle_in_transaction_session_timeout` | 10 s |

- **Memory budget.** No new always-on daemon (README invariant 7): the studio process runs only
  while sessions exist. The cgroup hard cap is `MemoryMax=256M`; the target is ≤ 60 MB RSS at 8
  open sessions (the spikes measured 6–17 MB per streaming engine). The agent front's RSS
  doesn't change. Results stream through and are never buffered past one 500-row batch.
- **Audit.** Lifecycle events stay `database.console.*`. Add `database.studio.write {object,
  inserted, updated, deleted}` for every `apply`, and `database.studio.run {fingerprint,
  readOnly, ms, rows}` for editor runs: a normalised SQL/command hash, as plan 20 does, never
  raw text or values.
- **Cancel path.** Closing the tab or pressing Stop aborts the browser `fetch`. That aborts the
  SvelteKit upstream `fetch` and Caddy closes the upstream. The agent front sees
  `request.signal` fire and aborts its socket `fetch`. The studio process then sees its own
  `request.signal` and calls the plugin's cancel.

### Wire protocol (browser ⇄ control plane ⇄ agent front ⇄ studio process)

The same JSON calls run on both hops. The SvelteKit route checks permissions, audits, and adds
the session token, then streams the body through untouched.

| Call | Body | Response |
|---|---|---|
| `POST tree` | `{path}` | JSON `TreeNode[]` |
| `POST describe` | `{object}` | JSON |
| `POST browse` | `{object, query}` | NDJSON `StudioEvent` |
| `POST run` | `{input, maxRows}` | NDJSON `StudioEvent` |
| `POST explain` | `{input}` | JSON |
| `POST apply` | `{object, changes}` | JSON `{applied, conflicts[]}` |
| `POST value` | `{object, key, column}` | full value of one truncated cell |

All bodies and events are zod schemas in `packages/studio/src/protocol.ts`, versioned with
`v: 1`, so the control plane and nodes can be updated at different times. The agent front
forwards bodies byte for byte; only the studio process decodes them. The studio socket adds
`PUT/DELETE /sessions/:id` and `GET /healthz`, which only the agent can reach.

### UI (`apps/control-plane/src/lib/studio/**`)

A full-height route, `/databases/<name>/studio`, replaces the iframe tab. It reuses
shadcn-svelte, `@tanstack/svelte-table` and `@tanstack/svelte-virtual`. The editor is
**Monaco** (decided 6 Nov 2026), which is already a dashboard dependency (`CodeEditor.svelte`),
so the studio adds no new package. It is dynamically imported on this route only. Monaco's core
is about 700 KB gzipped, against 147 KB for CodeMirror, but users already download it for the
project code view, and it gives the studio one editor and one look across the dashboard.
Languages: Monaco's built-in `sql`/`mysql`/`pgsql` and `json`, plus a small Monarch grammar
for Redis commands. Completion providers are fed from `tree`/`describe`.

- **Shared shell:**
  - lazy object tree (left);
  - tabs (right) for objects and editors;
  - a read-only/write badge, with an explicit "Enable writes" confirmation (as today);
  - session expiry countdown and keyboard shortcuts.
- **`StudioGrid`.** A virtualised, column-resizable grid. It renders cells by `CellKind`, has
  inline editors per kind, a pending-changes tray ("3 edits · Review · Apply · Discard") and a
  JSON/EJSON cell inspector.
- **Workspaces, chosen by `family`:**
  - **Relational:** a data tab with a filter builder (column/op/value) and sort; a structure tab
    (columns, indexes, FKs, DDL); and a SQL editor with dialect, schema autocomplete, run
    selection or all, several result tabs, EXPLAIN, and CSV/JSON export of results.
  - **Document:** collections with an EJSON filter, sort and projection; table or JSON view;
    document edit, insert and delete; indexes; schema sample; an aggregate pipeline runner.
  - **Key-value:**
    - key tree split on `:`, with pattern and type filters;
    - per-type viewers and editors (string with JSON pretty-print, hash, list, set, zset,
      stream);
    - TTL edit and delete;
    - command console with completion from `COMMAND DOCS`;
    - `INFO` panel.
- **Per-engine UI plugins** are tiny descriptors (`lib/studio/engines/<engine>.ts`): editor
  language and dialect, snippet templates, and native-type to `CellKind` mapping overrides. The
  workspace reads `capabilities` and never branches on the engine name.
- **Query history** is per database, in IndexedDB, holding the last 200 runs.

## Proposed decision (to add as D96 on acceptance)

> **D96: The database studio is native: per-engine plugins in an on-demand
> `skiff-studio` process, fronted by the agent.** Supersedes D60's DBGate choice. Each engine is
> a `@skiff/studio` plugin implementing a small session interface (`tree`, `describe`, `browse`,
> `run`, `explain?`, `apply`), with declared capabilities. Plugins run in
> `skiff-studio.service`: the agent binary's `studio` entrypoint, with its own cgroup
> (`MemoryMax=256M`), a unix socket only, and no node token. The helper starts it on demand,
> and it exits when idle. It reaches only loopback databases (D56/D57). The agent fronts it on
> one loopback port per node. The control plane reaches that port only through the D82 internal
> HTTP gateway, with a sealed per-session token and a pull-based activation, so there is still
> no control-plane-to-agent command channel. Read-only is enforced by a per-database read-only
> database principal; session flags are a second layer. *Rejected:* keeping DBGate (GPL
> sidecar, ~300 MB image, iframe, heartbeat-delayed open, no say over the UX); plugins inside
> the agent process (lighter, but a driver crash or out-of-memory kill would take heartbeats
> down); a child process of the agent (shares the agent's 192 MB cgroup); querying from the
> control plane (it cannot reach node loopback, by invariant).

## Phase 1 as built (6 Nov 2026)

| Piece | Where |
|---|---|
| Protocol, plugin interface, cells, limiter, lazy registry, fake plugin, conformance kit | `packages/studio/src/*` (the fake plugin passes the conformance suite) |
| Contracts: activation, open schema, desired `studio`, headers, `DB_STUDIO` flag | `packages/contracts/src/database-studio.ts`, `agent.ts`, `features.ts` |
| Sessions, activation, desired state, gateway routes, tick, audit, `studioFingerprint` | `packages/core/src/database-studio.ts` (`core.databaseStudio`), migration 0029 |
| Activation route `GET /api/agent/database-studio/:id` | `apps/control-plane/src/routes/api/agent/[...path]/+server.ts` |
| Studio process (`skiff-agent studio`) and agent front | `apps/agent/src/studio/{process,front}.ts`, `main.ts` |
| Unit and helper verbs `POST /v1/studio/start|stop` | `scripts/systemd/skiff-studio.service` (no `[Install]`), `apps/helper/src/*` |
| Install and update of the unit | `scripts/install/main.ts`, `scripts/update-self/*`, `scripts/uninstall.sh` |
| Streaming proxy, session API, skeleton workspace | `apps/control-plane/src/lib/studio/*`, `databases/[name]/studio/**`, `api/v1/databases/[name]/studio` |
| Bun 1.4.0 → 1.4.4 | workflows, `docker/node/Dockerfile`, `docs/OPS.md` |

Deviations from the plan text, all deliberate:

- **Sessions are per user** in their own table, not `console_*` columns. Several people can
  have a studio open on the same database.
- **`endpoint` re-checks `database:update` for write sessions,** so losing the role locks a user
  out mid-session. `recordActivity` only accepts a 16-hex fingerprint, so raw SQL can never be
  audited by mistake.
- **The studio process sends headers after the first event,** so an early refusal (for example
  `read_only`) comes back as a proper JSON error with the right status.
- **Bun's 10 s idle timeout is disabled on the unix socket** (`idleTimeout: 0`), so a quiet
  long query isn't cut.
- **A newly fetched session gets 30 s of grace before eviction,** because the heartbeat that
  lists it may lag behind the user's first click.
- **Rollback stops `skiff-studio.service`** rather than restarting it, because an older binary
  has no `studio` subcommand.
- **The unit uses `SupplementaryGroups=caddy`,** because `/run/skiff` is `root:caddy 2770`.
  The static `skiff-agent.service` says `skiff-caddy`; the installer uses `caddy`.

Still open before the flag can be turned on anywhere real:

- **Interim credential:** activations carry the **owner** credential until the read-only
  principals (track G) land. Until then, read-only rests on the session flags alone.
- **S5 not yet run:** cold start on Debian 13, plus a live end-to-end check through the gateway
  on a node.
- **Worker unit snippet:** the node unit printed by `nodes/vpn/+page.svelte` doesn't include the
  studio unit. Workers installed that way get it on their next self-update.

## Phase 2 plugins as built (6 Nov 2026)

| Plugin | Engines tested | Client | E2E (`SKIFF_E2E_STUDIO=1`) |
|---|---|---|---|
| `postgres` | PG 17, 16 | Bun.SQL (needs Bun ≥ 1.4.4) | 68 pass |
| `mysql` | MySQL 8.4, 9.7; MariaDB 11.8, 11.4 | mysql2 | 140 pass |
| `mongodb` | Mongo 8.0, 9.0 | mongodb 7.8 | 47 pass |
| `keyvalue` | Valkey 9.1, Redis 8.10 | Bun RedisClient | 54 pass |

Each engine runs the conformance suite twice: with the owner credential and read-only sessions
(the interim setup), and with the Phase 3 read-only principal. The suites live in
`tests/e2e/studio/*.e2e.test.ts` and skip unless `SKIFF_E2E_STUDIO=1`. A compiled `skiff-agent`
(Bun 1.4.4, 88 MB) served all four engines from one studio process at about 81 MB RSS with 4
sessions open, which is above the 60 MB target and inside the 256 MB cap.

**How each plugin enforces read-only:**

- **Postgres:**
  - Each statement runs in its own `BEGIN READ ONLY … ROLLBACK`.
  - The timeout is set through `set_config`. `SET LOCAL` let `SET transaction_read_only = off`
    through.
  - Every statement goes over the extended protocol, so the server refuses multi-statement
    smuggling.
- **MySQL/MariaDB:**
  - `SET SESSION transaction_read_only = ON` and `START TRANSACTION READ ONLY` before every
    statement.
  - Statements are refused before sending when they could escape. Verified escapes are `CALL`
    (both engines), and on MariaDB `SET STATEMENT … FOR`, `BEGIN NOT ATOMIC` and
    `ANALYZE TABLE`. The plugin also refuses `PREPARE`/`EXECUTE`, transaction control,
    `/*! */` comments and `INTO OUTFILE`.
- **MongoDB:** a command allowlist. Recursive checks catch `$out`/`$merge` in `$facet`,
  `$lookup` and `$unionWith`, and `explain` of a write is refused.
- **Valkey/Redis:**
  - `COMMAND INFO` `readonly` flag plus a denylist. Harmless unflagged commands such as `PING`
    and `INFO` are allowed.
  - The `+@read` principal can't run `COMMAND INFO`, so it falls back to a static allowlist.
  - **Decision for track G:** grant `+command|info +client|setname` to the read-only ACL user.

**Bug found by the compiled smoke test, now fixed:** `limitEvents` returned after `done`
without closing the plugin generator. Its `finally` (rollback, releasing the run connection)
never ran, so the session's next run hung. The conformance suite now runs consecutive runs on
one session.

**Known limits and follow-ups:**

- **Bun 1.4.0 is unsupported for Postgres.** It decodes nothing and its cancel does nothing.
  The pin is 1.4.4.
- **MongoDB has no transactions on a standalone server.** `apply` checks every change against
  its originals first, then writes guarded changes. A race between the two steps returns
  "partially applied", the one exception to "conflict means `applied: 0`".
- **Valkey/Redis replies are UTF-8 decoded by Bun.** Binary values inside collections are lossy,
  and integer replies above 2^53 lose precision. `run` replies are buffered whole.
- **MySQL and Postgres `run`** fetch in 500-row batches with no per-cell size cap (browse has
  one). JSON numbers above 2^53 inside MySQL JSON documents lose precision.
- **Bun timers stall during fast mysql2 streams.** The plugin checks deadlines inside the row
  loop (S2 addendum).
- **Conformance suite gaps:** it doesn't cover filters/sort, `maxBytes`, `explain`, `value`,
  type round trips or the `timeout` code (each plugin's extras cover them). Its escape check
  only counts rows, so DDL escapes are caught only by the plugins' extras.
  `postgresHealthProbe` in `tests/e2e/lib/containers.ts` can hang without a timeout.
- **Unix socket paths over about 104 bytes fail on macOS.** Production uses
  `/run/skiff/studio.sock`.

## Phase 2 UI as built (6 Nov 2026)

Monaco is the editor (user's choice). It is dynamically imported on the studio route only.
Everything lives under `apps/control-plane/src/lib/studio/`; the contracts between the pieces
are in `ui-types.ts`.

| Track | What | Where |
|---|---|---|
| E | The route page is thin. Shell: session header (badge, expiry, enable writes, close), lazy filterable object tree with keyboard navigation, tab strip saved per database. `StudioGrid`: virtualised on both axes, resizable columns, cell editors by kind that keep `$t` tags, cell inspector, pending-changes tray building `RowChange`s with originals, conflict marking. Relational workspace: filter builder, multi-column sort, cursor paging, editing, structure (columns, indexes, FK links, DDL) | `shell/`, `grid/`, `workspaces/RelationalWorkspace.svelte` |
| F | `StudioEditor` (Monaco: `pgsql`/`mysql`, `json` with a Mongo command schema, a Monarch `skiff-redis`), lazy completion from `tree`/`describe` with alias resolution, run-selection, error markers. `QueryTab`: one result tab per statement, Stop, Explain plan tree, CSV/JSON export, max-rows; IndexedDB history (last 200, no results stored) | `editor/`, `query/`, `completion.ts`, `history.ts` |
| G | Document workspace: EJSON filter, sort, table/JSON views, top-level `$set` edits with originals, insert, delete, indexes, sampled schema with type shares, "Partially applied" notice. Key-value workspace: MATCH/TYPE key list with "Load more", inline string/TTL edits, add key, per-type key detail (string/hash/list/set/zset/stream) with in-key edits, full-value load, console | `workspaces/DocumentWorkspace.svelte`, `workspaces/KeyValueWorkspace.svelte`, `document/`, `keyvalue/` |

Integration changes:

- `StudioGridProps` gained `sort`/`onsort`, and `onrowactivate`, which clicking a row number
  calls. It opens a key's detail.
- The new-query shortcut is ⌘/Ctrl+Alt+N, because browsers keep ⌘/Ctrl+Shift+N for a private
  window.

Not yet verified: a live session through agent and studio process with real data, Stop and
abort against a real query, IndexedDB in a browser, and the light/dark editor theme switch.

## Implementation order

Phases 0–1 are serial and small. Phase 2 is the parallel build, in six tracks with disjoint
files. Phase 3 is serial.

**Phase 0: spikes (½ day, parallel).** Each spike's result goes into this plan before Phase 1.

| Spike | Question |
|---|---|
| S1 | Does `mongodb` 7.8 work under `bun build --compile` (connect, cursor, `killOp`)? What does it add to binary size? |
| S2 | Does `mysql2` `.stream()` work under compiled Bun against MySQL 8.4 and MariaDB 11.8? |
| S3 | Does Caddy's gateway stream NDJSON through without buffering (`flush_interval -1`, unknown length) on edge-local and edge-to-worker paths? |
| S4 | Postgres `DECLARE`/`FETCH` through Bun.SQL `reserve()` on Bun 1.4.4, and `cancel()` latency. |
| S5 (Phase 1, on Debian 13) | Cold start of `skiff-studio.service`: from the helper verb to `/healthz` on the socket (target < 500 ms). Also streaming plus abort through `fetch({unix})`. |

**Phase 1: foundation (serial, one agent).**

0. Bump Bun to ≥ 1.4.4 across CI, the release workflows, the node Dockerfile and docs (see
   Spike results). Ship it as its own release first.
1. `packages/studio`: protocol, driver interface, cell encoding, conformance kit, and an
   in-memory fake plugin for UI work.
2. Contracts and core:
   - `studioSessions` added to desired state;
   - the session token replaces `console_secret`, and the port is no longer used;
   - `GET /api/agent/database-studio/:id`;
   - `gatewayForNode` emits one `studio.<nodeId>.internal` route to `SKIFF_STUDIO_PORT`;
   - feature flag `SKIFF_FEATURE_DB_STUDIO`, **off by default**, alongside the DBGate flag.
   - Migration 0029 adds a `database_studio_sessions` table: one session per user and
     database, with a sealed token. The DBGate `console_*` columns are untouched until cutover.
3. Studio process: the `skiff-agent studio` entrypoint (`apps/agent/src/studio/process.ts`).
   It runs `Bun.serve` on the unix socket, holds the session table, applies limits, writes
   NDJSON, loads plugins, and exits when idle. It runs on the fake plugin only at this stage.
4. Agent front: `apps/agent/src/studio/front.ts`. It handles the loopback listener, token
   cache, activation fetch, "ensure started" through the helper, socket forwarding with abort,
   and re-activation after a restart.
5. Runtime: `scripts/systemd/skiff-studio.service`, installed by `scripts/install` and the
   updater like the agent unit (installed but never enabled). Add the helper verb
   `POST /v1/studio/start` and a matching stop verb (no arguments, fixed unit name), with
   tests. Then run S5.
6. Control plane: the `studio/api/[op]` proxy with streaming passthrough and abort, a
   permission check per call, audit, and a skeleton route.

**Phase 2: parallel build (six tracks; files never overlap).**

| Track | Owns | Done when |
|---|---|---|
| A: Postgres plugin | `packages/studio/src/plugins/postgres/**` | Conformance passes on PG 16/17, including cursor streaming and cancel |
| B: MySQL/MariaDB plugin | `plugins/mysql/**` | Conformance passes on MySQL 8.4/9.7 and MariaDB 11.4/11.8 |
| C: Mongo plugin | `plugins/mongodb/**` | Conformance passes on Mongo 8.0/9.0, including `killOp` |
| D: Key-value plugin | `plugins/keyvalue/**` | Conformance passes on Valkey 8.1/9.1 and Redis 8.8/8.10, including the command allowlist |
| E: UI shell + relational | `lib/studio/{shell,grid,editor,relational}/**`, route | Works end to end against track A, falling back to the fake plugin |
| F: UI document + key-value | `lib/studio/{document,keyvalue}/**`, `engines/*.ts` | Works end to end against tracks C and D |

A seventh, smaller track (G) owns the helper `credentials/studio-readonly` verb for all six
engines (`apps/helper/src/{systemd,validate,server}.ts`) and its tests. It is needed before
Phase 3.

**Phase 3: cutover (serial).**

1. Wire read-only sessions to the G principal, and run a security pass over the conformance
   read-only cases.
2. Turn `SKIFF_FEATURE_DB_STUDIO` on by default and turn the DBGate flag off. Run on prod for
   one release.
3. Delete DBGate: the image pin, renderers, helper console verbs, agent readiness probe, port
   allocator, iframe, framing exception, and per-database gateway routes. Migration 0030 drops
   `console_port`, its unique index and `console_secret`.
4. Docs: D96 in DECISIONS; DATABASES.md §14; API.md; OPS.md (studio port, limits, flag);
   ROADMAP (close "Native table editor"); mark 06-database-studio.md as superseded.
5. Plan 20's `query_database`: implement it on the Postgres plugin's read-only `run`, with a
   fingerprint audit and the `database:query` scope, and no new query engine.

## Acceptance criteria

- Opening a studio shows the object tree in under 1 s on an edge-local database, from a cold
  (stopped) studio process, with no heartbeat wait and no container started.
- For all six engines: browse, filter, sort, page, edit, insert and delete through the UI, with
  conflicts detected and reported.
- `SELECT * FROM <10M-row table>` streams the first batch in under 500 ms, stops at `maxRows`,
  the studio process RSS rises by less than 20 MB during the run, and agent RSS doesn't change.
- Stop cancels a running `pg_sleep(60)` / `SLEEP(60)` / `$where`-sleep within 2 s. For Redis,
  the client timeout fires.
- A read-only session cannot write through any trick in the conformance list, on any engine.
- With no studio open, `skiff-studio.service` is inactive and the agent loads no plugin code.
  It stops by itself 5 minutes after the last session closes.
- `kill -9` of the studio process mid-query: the agent keeps heartbeating, the UI shows
  `studio_restarted`, and the next request restarts the process and re-activates the session.
  A query that tries to use more than `MemoryMax` gets the studio process killed by the kernel,
  never the agent.
- The audit shows lifecycle, `studio.write` counts and `studio.run` fingerprints, and never raw
  SQL, values or credentials. Credentials never appear in desired state, logs, MCP or the
  browser.
- With `SKIFF_FEATURE_DB_STUDIO=0`, the studio route, API, agent front listener and helper
  start verb are all unavailable.

## Tests

- Unit tests:
  - `packages/studio`: protocol schemas, cell encoding round trips, and SQL generation for
    keyset paging and `apply` with quoting per dialect.
  - Core: token, activation scoping (wrong node is refused), expiry and revocation.
  - Agent front: token cache, ensure-started, abort passthrough, retry after restart.
  - Studio process: session table, limits, idle exit, NDJSON writer.
  - Helper: the start/stop verbs refuse any arguments; unit-file rendering and lint.
- Conformance suite for each plugin in `tests/e2e` (Podman), run in CI on the engine matrix.
- UI: component tests for grid editing and the pending-changes tray, plus one Playwright smoke
  test per family against the e2e stack.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Driver bug or out-of-memory kill | Contained in `skiff-studio.service` (own cgroup, `MemoryMax=256M`); the agent is untouched. Hard `maxRows`/`maxBytes` caps, streaming only, one run per session, session cap per node |
| Cold-start latency of the unit | S5 measures it. If it is over 500 ms, the agent starts the studio when the heartbeat first lists a `studioSessions` id, which usually arrives before the user's first click |
| Credential exposure across the extra hop | Credentials go over a 0660 unix socket owned by `skiff`, never touch disk or argv, and are dropped on session close. The studio process holds no node token |
| `mongodb` on Bun regresses | Pin the Bun version (already done for releases); conformance on every Bun bump; spike S1 gates the plugin |
| Caddy buffers NDJSON | Spike S3; set `flush_interval: -1` on the studio route |
| Bun.SQL Postgres behaviour changes (cancel and columns are recent) | Conformance cases for cancel and type metadata; pin Bun |
| SQL injection through browse filters | Filters are structured `{column, op, value}`, identifiers come from `describe` and are quoted per dialect, values are always parameters. Only `run` takes free text |
| A wide read-only role (`pg_read_all_data`) exposes other schemas | Same database only, which is the owner's anyway. Document it, and let the org restrict the role to `public` like the 04 credential if wanted |
| Losing DBGate features (ERD, import) | Listed as non-goals with roadmap items. DBGate stays available behind its flag for one release |

## Rollout

The feature flag is off, then on in dev and on `mac-dev`, then on in prod alongside DBGate. Then
it becomes the default with DBGate off, and DBGate is deleted in the following release. Each step
is a normal versioned release, with no special canary.

## Resolved questions (6 Nov 2026)

1. **Separate process** (changed from agent-hosted, 6 Nov 2026). Plugins run in the on-demand
   `skiff-studio.service`, using the same binary's `studio` entrypoint and its own cgroup, so a
   driver crash or out-of-memory kill can never take the agent down. The agent is only a thin
   front for authentication and forwarding.
2. **Read-only covers the whole database, and writes are a per-session RW option.** The
   Postgres read-only principal gets `pg_read_all_data` on its own database, so every schema
   is visible. Writing is an explicit read/write toggle on the session, which reconnects as the
   owner credential, rather than a narrower read role.
3. **Writes need `database:update`.** No new permission.
4. **Plan 20 shares the path.** `query_database` calls the studio's `run` with
   `readOnly: true` and `maxRows: 1000` through the same plugin. It is added to Phase 3 as
   step 5.

## File ownership

- Phase 1 (one agent): `packages/studio/src/{driver,protocol,cells,conformance,fake}.ts`,
  `packages/contracts/src/{database,agent}.ts` (studio section),
  `packages/core/src/databases.ts` (console section), `packages/db` (0029),
  `apps/agent/src/studio/{front,process}.ts`, `apps/agent/src/main.ts` (entrypoint switch),
  `scripts/systemd/skiff-studio.service`, `scripts/install/**` (unit install),
  `apps/helper/src/{server,validate}.ts` (studio verbs),
  `apps/control-plane/src/routes/(dashboard)/databases/[name]/studio/**`.
- Phase 2: as in the track table. Plugins never import from each other. The UI imports only
  `@skiff/studio` types and the fake plugin.
- Phase 3: deletions across the DBGate files listed in Current state, plus migration 0030 and
  docs.
