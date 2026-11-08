# Skiff — Flows: durable multi-step changes

Status: **built 2026-11-08** (D167). The engine, its migration (`0079_flows.sql`), the REST/SSE/MCP
surfaces and the first consumer (database moves, D97) are in the tree and covered by unit tests.
Other hand-written state machines are not migrated yet (§8). Why this exists, and what comes after
it, is in [ARCHITECTURE-RESEARCH.md](./ARCHITECTURE-RESEARCH.md).

A **flow** is a named step machine for one long-running change: a database move, a replica
promotion, a restore. A **run** is one execution of a flow. Every transition a run makes is written
to SQLite before the next starts, so a restarted control plane resumes it where it stopped, and
every path ends in `succeeded`, `failed` or `cancelled`.

Code: `packages/core/src/flows/` (engine), `packages/contracts/src/flows.ts` (views and limits).

---

## 1. Why

Before flows, each multi-step change wrote its own phase column, lease, timeout and retry logic,
driven from heartbeats and from the 60-second `MaintenanceService.run()` sweep (about 30 `tick()`
calls). Each copy had to get the same things right: never stall in a non-terminal phase, survive a
restart, time out a node that never answers, and compensate on failure. Self-hosted peers show what
happens when they don't: Coolify's deploys stay `running` forever when a timeout skips the `finally`
block that writes their status ([coolify#11383](https://github.com/coollabsio/coolify/issues/11383)).

Flows centralise that once, following Fly.io's flyd (a step log in a local store that a restart
resumes from, [Fly](https://fly.io/blog/the-exit-interview-jp/)) and Cloud Foundry's split between
one-shot work and its observers. They live in the control plane's own SQLite, so they add no
service and no dependency.

**Flows vs. the scheduler vs. operations:**

| Primitive | Use it for | Unit |
|---|---|---|
| `scheduled_tasks` (docs/SCHEDULER.md) | "Run this once at time T", retried as a whole | one task, no steps |
| Operations (docs/OPERATIONS.md) | Mass actions over many items: plan, review, apply | items |
| **Flows** | One change with ordered steps that wait on nodes or people | steps and signals |

---

## 2. Model

| Table | Holds |
|---|---|
| `flow_runs` | One row per run: `kind`, idempotency `key`, owning org, subject, read/cancel permissions, `status`, current `step`, `state_json`, `attempt`, `waiting_for` + `wait_deadline`, `wake_at` (retry backoff), `deadline_at`, lease (`lease_owner`, `lease_until`), `cancel_requested`, `detail`, `result_json`, `error`. |
| `flow_steps` | Append-only log: `(run_id, seq)`, step, attempt, event, detail, time. |
| `flow_signals` | External events for a run: name, JSON payload, `consumed_at`. |

- Ids are `flw_…`. At most one **active** run per `(kind, key)` (a partial unique index); starting
  an active key returns the existing run, so callers are idempotent.
- Statuses: `queued` (ready to enter its step), `running` (a process holds the lease),
  `waiting` (parked on a signal), then `succeeded`, `failed` or `cancelled`.
- Step-log events: `started`, `next`, `wait`, `signal`, `timeout`, `retry`, `resumed`,
  `cancel-requested`, `cancel-refused`, `succeeded`, `failed`, `cancelled`.
- Finished runs, their logs and signals are deleted after 30 days.

---

## 3. Engine semantics

A definition (`FlowDefinition`) has steps. Each step has `run` (enter the step), and optionally
`onSignal` and `onTimeout`. Handlers return an outcome, and **the engine, never the handler, writes
the transition**:

| Outcome | Transition |
|---|---|
| `flow.next(step)` | Enter `step` now, in the same drive. |
| `flow.wait(signal, { timeoutMs })` | Park until `signal` arrives (then `onSignal`) or the timeout passes (then `onTimeout`; without one, the run fails). |
| `flow.succeed(result)` / `flow.fail(error)` | Terminal. A step that fails has already compensated. |
| `flow.cancel()` | Terminal; only from the definition's `cancel` hook. |
| `null` from `onSignal` | Ignore the signal; keep waiting with the same deadline. |

**Leases and fencing.** A run is claimed (`queued`/`waiting` → `running`, five-minute lease) before
any handler runs. Every transition is an `UPDATE … WHERE lease_owner = me AND status = 'running'`,
so a process whose lease was taken over cannot advance the run.

**Synchronous by default.** Handlers may be synchronous. Then `start`, `signal` and `cancel`
finish every transition before they return. This keeps request paths as immediate as the code
flows replaced: a heartbeat that delivers a backup result has already cut the database over when
it returns. Asynchronous handlers work too. `start(...).settled` and `drive().settled` resolve
when they finish.

**Signals.** `signal(kind, key, name, payload)` stores the event, then drives the run. A run that
is not waiting for that name yet keeps the signal until it is. A signal is consumed in the same
transaction as the transition it causes.

**Failures.**
- A handler that throws is retried with exponential backoff (5 s doubling, capped at 10 min) up to
  `maxAttempts` (default 5). Its signal stays unconsumed, so it is delivered again.
- When attempts run out, a lease expires too often, the run passes `deadline_at`, or a step is
  missing, the engine calls the definition's `onFailure` (compensation) and fails the run. Errors
  in compensation are logged in the step log and never rethrown.

**Recovery.** `tick()` finds `running` runs whose lease expired (the process died mid-step) and
returns them to their step (`resumed`). Steps must therefore be idempotent; the database move's
steps check the move row before acting.

**Cancel.** `cancel()` sets `cancel_requested` and drives the run. The definition's `cancel` hook
returns the outcome (usually `flow.cancel()` after compensating), or `null` to refuse at the current
step. A refusal is logged and reported as `409`. A run held by another process is cancelled when
that process releases it.

**Driving.** Starts and signals drive their own run at once. The control plane also calls
`drive()` every 5 s (retries after backoff, wait timeouts, cancels requested while another process
held the run), and the maintenance sweep calls `tick()`, `drive()` and `prune()`. A standby control
plane (`SKIFF_STANDBY=1`) drives nothing.

**Adoption.** `start({ waiting })` creates a run already parked on a signal without calling the
step. The database move uses it for moves that began before flows existed (§6).

---

## 4. Permissions

A run records its org, a read permission and a cancel permission (for a move: `database:read` and
`database:update`).
- A principal of another org, or one without the read permission, gets `404`, so ids of other orgs'
  work never leak.
- A run with no org is visible to platform admins only.
- Cancel needs the cancel permission.

---

## 5. Surfaces: one async-operation contract

Flows share the routes, stream and MCP tools of mass operations (docs/OPERATIONS.md); the id prefix
picks the kind.

| Surface | Flow behaviour |
|---|---|
| `GET /api/v1/operations/flows` | `?kind&status&subjectKind&subjectId&limit` → `{ flows }` |
| `GET /api/v1/operations/flw_…` | `{ flow }`; `?wait=<s≤25>` holds until terminal; `?steps=1` adds the step log |
| `POST /api/v1/operations/flw_…/cancel` | `{ flow }`, or `409` with the reason |
| `GET /api/v1/operations/flw_…/stream` | SSE: `progress` on every transition, then `done` |
| MCP `get_task` / `get_operation` | status (`queued`/`running`/`succeeded`/`failed`/`cancelled`), current step, waiting signal, step log, `nextSteps` while running |
| MCP `cancel_task` | cancels a flow or a mass operation |

Resources that start a flow return its id: a database move's view carries `operationId`.

---

## 6. First consumer: database moves (D97)

`database.move` keys runs by the move id. The `database_moves` row remains the domain state other
services read (quiesced apps, reserved ports, node blockers, purges). The flow decides when it
changes.

| Step | Enters by | Waits for | On signal | On timeout |
|---|---|---|---|---|
| `quiesce` | start, when attached apps run on the source | `source-converged` (heartbeat: the source applied the stop and no longer reports the apps), 10 min | `dump` | abort → `failed` |
| `dump` | start (nothing to stop) or `quiesce` | `backup-result` from the source, 2 h | ok → `cutover`; failed → abort → `failed` | abort → `failed` |
| `cutover` | start (`from: latest-backup`/`empty`) or `dump` | `restore-result` from the target, 2 h | ok → finish; failed → roll back; then `purge` | roll back → `purge` |
| `purge` | `cutover` | `purged` from the node holding the old copy | `succeeded` (moved) or `failed` (rolled back) | — |

- **Cancel** is allowed in `quiesce` and `dump` (an abort: nothing has moved). From the cut-over on,
  the restore result decides between finishing and rolling back, so a cancel is refused.
- **`onFailure`** aborts before the cut-over and rolls back during the restore.
- **Hooks become signals.** `onHeartbeat`, `onBackupResult` and `onRestoreResult` keep their
  domain checks and send signals instead of transitioning. `onPurged` still marks the move `done`
  directly, then signals the run.
- **Adoption.** A move with no run (begun before this release) is adopted where its phase is, the
  first time a node event or the maintenance tick touches it. The wait deadline is counted from
  the move row's `updated_at`, as the old timeouts were.

---

## 7. Writing a flow

```ts
ctx.flows.register<{ id: string }>({
  kind: 'replica.promote',
  title: 'Replica promotion',
  steps: {
    fence: {
      run: ({ state }) => { requestFence(state.id); return flow.wait('fenced', { timeoutMs: FENCE_MS }); },
      onSignal: () => flow.next('promote'),
      onTimeout: ({ state }) => { restartOldPrimary(state.id); return flow.fail('The old primary was not fenced.'); },
    },
    promote: { run: ({ state }) => { promote(state.id); return flow.succeed(); } },
  },
  cancel: ({ run }) => (run.step === 'fence' ? flow.cancel() : null),
  onFailure: ({ state }, error) => markFailed(state.id, error),
});
```

Rules:
- **Idempotent steps.** `run` may be called again after a crash; check domain state before acting.
- **Short handlers.** Long work belongs on nodes. Request it, then `wait` for the result signal.
- **Domain tables stay the source of truth** for other readers. The run records progress and
  decides transitions.
- **Register** in `createCore` after every service exists.
- **Signal from node-protocol hooks** with `ctx.flows.signal(kind, key, name, payload)`.

---

## 8. Migration plan for other state machines

Each of these keeps a phase column and a `tick()` today. Move them one at a time, behind their own
tests, the way §6 did.

| State machine | Today | Notes |
|---|---|---|
| Replica promotion with fencing (C7) | `database_failovers` + `DatabaseReplicaService.tick` | Natural next: fence → promote → rebuild others |
| App-volume snapshot/restore tasks | `AppVolumeLifecycle.tick` | Task + timeout per node |
| Database PITR restores, credential rotations | `DatabaseService.tickPitr`, rotations | Request → node result → apply |
| Storage moves | inline in `moveStorage` | Short today; becomes a flow once objects are copied |
| Node update (D99) | update generation on `nodes` | Request → report → verify version |
| Failover re-placement (C8) | controller loop with its own lease | Keep the controller; express each re-placement as a run |

---

## 9. Not built

- Dashboard pages for runs (a run timeline on the database page, an activity list). The REST, SSE
  and MCP surfaces are complete.
- CLI commands (`skif ops get <id> --wait` works through `GET /api/v1/operations/<id>`, but the
  CLI does not render flows specially yet).
- Fencing tokens across control planes. Leases fence processes sharing one SQLite. The HA epoch
  (docs/CLUSTERING.md §6) will add the controller epoch to the claim when standbys can promote.
