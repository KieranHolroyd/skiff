# Durable scheduler

Status: **implemented, 2026-11-05** as foundation F4. This is the generic primitive feature plans
01 (database backups), 12 (preview teardown) and 06 (upgrade tasks) consume; it has no
feature-specific logic.

The scheduler lives entirely in SQLite (`scheduled_tasks`) and is driven by the existing 60-second
`MaintenanceService.run()` sweep. There is no separate daemon or in-memory timer, so restarts and a
brief second control plane are safe.

## Model

| Column | Meaning |
|---|---|
| `id` | `task_<uuid hex>`. |
| `kind`, `key` | Who owns the task and its idempotency key. `(kind, key)` is unique. |
| `run_at` | Epoch ms; the task is claimable once this is due. |
| `lease_until` | Epoch ms. A lease makes the task invisible to other workers until it expires. |
| `attempts`, `max_attempts` | Claims so far and the hard retry cap (default 5). |
| `payload_json` | Opaque input for the consumer. |
| `status` | `queued`, `leased`, `ok`, `failed`, `cancelled`. |
| `result_json`, `last_error` | Outcome of the last attempt. |
| `created_at`, `updated_at` | Epoch ms. |

Indexes: unique `(kind, key)` for idempotency, `(status, run_at)` for due claims and
`(status, lease_until)` for lease expiry.

## API (`packages/core/src/scheduler.ts`)

- `enqueue({ kind, key, runAt, payload, maxAttempts }) -> id`
  Active tasks (`queued`/`leased`) are never duplicated. Enqueueing a terminal key (`ok`, `failed`,
  `cancelled`) re-arms that same row as a fresh occurrence with `attempts = 0`; this lets a
  recurring producer keep a stable key.
- `claim(workerId, limit, now?, leaseMs?) -> ClaimedTask[]`
  One atomic `UPDATE ... RETURNING` leases due tasks, ordered by `run_at`. It increments `attempts`
  before the work starts. The default lease is five minutes.
- `complete(id, resultJson?)`, `fail(id, error, retryAt?)`, `cancel(id)`
  Terminal transitions are guarded by status. A failed attempt is retried with exponential backoff
  (30 s, 60 s, 120 s, … capped at one hour); at `maxAttempts` it becomes `failed`.
- `tick(now?)`
  Expires leases past `lease_until`: requeues below the attempt cap, fails at the cap. Idempotent.
  `MaintenanceService.run()` calls it on every sweep.
- `nextRun(expression, from?)` / the standalone `nextRun` helper
  Wrap the shared five-field UTC cron parser (`cron.ts`) so producers can compute `runAt`. A
  schedule that can never fire (for example 31 February) returns `null`; the producer should reject
  or disable it.

## Consuming it

A feature registers a `kind`, builds a stable key, and polls its own tasks. For example, backups
would use `kind: "database.backup"` and `key: <database id>`; preview teardown would use
`kind: "preview.teardown"` and `key: <deployment id>`. The worker maps `payloadJson` to its input,
does the work, then calls `complete` or `fail`. If it crashes, `tick` makes the task claimable
again without any feature-specific recovery code.

Backups keep their existing `next_backup_at` sweep in this change. Migrating them onto
`scheduled_tasks` is left to plan 01 so this foundation stays behaviour-preserving.

## Jobs

Status: **implemented, 2026-11-07** (plan 09), behind `YOAL_FEATURE_JOBS` (on by default; set `0`
to stop the scheduler). App cron jobs and one-off commands
for process and container projects. They do **not** use `scheduled_tasks`: a job run must execute
on one specific node and report an exit code, so it has its own run table and a node lease, like
node tasks (D124).

### Model (migration 0061)

| Table | Holds |
|---|---|
| `jobs` | `name` (unique per project), `command_json` (argv), `schedule` (five-field UTC cron, NULL = manual only), `timeout_seconds`, `concurrency` (`forbid`/`allow`/`replace`), `max_retries`, `enabled`, `next_run_at`. |
| `job_runs` | One execution: `job_id` (NULL for a one-off), `trigger` (`schedule`/`manual`/`retry`), `attempt`, `retry_of`, `status` (`queued`/`running`/`succeeded`/`failed`/`timeout`/`cancelled`/`skipped`), the argv and timeout copied at creation, `node_id` + `workload_id` (replica 0 of the project's workload), `deployment_id` (refreshed at lease), `exit_code`, `error`, `cancel_requested`, `leased_until`, `run_at` (later than `created_at` for a retry's backoff). |
| `log_events.job_run_id` | A run's output, drained like runtime logs. Project log queries leave these rows out. |

Limits (`jobLimits`): 50 jobs per project, newest 100 finished runs kept per job (and per project
for one-off runs), 8 concurrent runs per node, heartbeat 15 s, lease 90 s, pickup 5 min, timeout
10 s to 24 h, at most 10 retries, 10,000 output lines per run.

### Core (`packages/core/src/jobs.ts`)

- **CRUD.** `list`/`get` need `project:read`; `create`/`update`/`remove` need `project:update` and
  `deployment:create`; pause/resume (`setEnabled`) needs `project:update`; `run`, `runOneOff` and
  `cancelRun` need `deployment:create`. Only process and container projects (not static sites,
  functions or CI runner pools). A schedule that never fires is refused. `runs` is a reserved name
  (it is the REST path of the run history).
- **Scheduling.** `scheduleDue(now)` runs every 10 s from `hooks.server.ts` and on every
  maintenance sweep. Each due job is claimed with `UPDATE jobs SET next_run_at = <next> WHERE id = ?
  AND next_run_at = <due>`, so two control planes fire it once. `next` is computed from **now**:
  after an outage a missed job runs once, never once per missed occurrence. Concurrency applies to
  scheduled runs only: `forbid` inserts a `skipped` run, `replace` cancels queued runs and sets
  `cancel_requested` on running ones, `allow` runs both. Manual and one-off runs always queue.
- **Quota.** The service registers the `jobs` and `jobRunsPerDay` counters (skipped runs do not
  count). `create` calls `assertCanCreateJob`; every run calls `assertCanRunJob`. A refused
  scheduled run or retry is recorded `skipped` with the quota message; a manual run throws.
- **Retries.** A `failed` or `timeout` run of an enabled job with `attempt <= max_retries` queues
  attempt + 1 at `now + retryDelayMs(attempt)` (30 s, 1 min, 2 min, …, capped at 1 h). Cancelled
  runs are never retried; lost leases and unclaimed runs are.
- **Node protocol** (agent routes `jobs/lease`, `jobs/heartbeat`, `jobs/result`):
  `lease(nodeId)` hands out due queued runs up to the node's free slots with a conditional
  `queued → running` update (the route long-polls up to 25 s); `heartbeat` extends the leases the
  agent still holds and answers `stop` for runs that are cancelled, replaced, settled or not this
  node's; `complete` records the outcome (a run with `cancel_requested` that did not succeed is
  `cancelled`) and schedules a retry.
- **Sweep** (maintenance): queued runs not leased within `pickupMs` fail, running runs whose lease
  lapsed fail (or become `cancelled` if a cancel was pending), orphans of purged projects and
  deleted jobs are removed, and each job keeps its newest 100 finished runs with their output.
- **Logs.** `LogService.appendRuntime` routes a batch with `jobRunId` to the run (the node must own
  the run under the same workload id, else 403) and caps it at 10,000 lines plus one notice.
  `LogService.query` filters `job_run_id IS NULL` unless a run is asked for.

### Node (`apps/agent/src/jobs.ts`, `apps/helper/src/jobs.ts`)

The agent's `JobRunner` leases (long-poll while it holds nothing), fetches the app's activation,
and calls the helper's `POST /v1/jobs { run, workload, activation }`. While runs are held it polls
`GET /v1/jobs/:id` every 2 s, drains `GET /v1/jobs/:id/logs` to `/api/agent/logs` with `jobRunId`,
heartbeats every 15 s, stops a run (`POST /v1/jobs/:id/stop`, then `{ force: true }` after 30 s) on
a `stop` answer or when it outlives its timeout plus 30 s, reports the result, and removes the unit
(`DELETE /v1/jobs/:id`). Held runs, log cursors and unsent results live in
`<dataDir>/jobs-state.json`, so an agent restart neither loses a run nor starts it twice.

The helper validates the run id (`jr_<32 hex>`), the argv (1–64 arguments, 1–1024 characters, no
control characters; a relative `argv[0]` cannot start with `-` or contain `=`), the timeout and the
workload/activation with the same parser as `POST /v1/workloads`; only app workloads (not managed
services or runners) are accepted. It writes the env file and file secrets 0400 under
`<runtimeDir>/jobs/<run id>/` and starts `yoal-job-<run id>.service` with `systemd-run --no-block`
(no daemon-reload): `Type=exec`, `RemainAfterExit=yes` (so the exit status stays readable),
`Restart=no`, `RuntimeMaxSec=<timeout>`, `TimeoutStopSec=30`, the workload slice, `MemoryMax` and
`CPUQuota` of the app.

- **Process apps**: the same sandbox directives as the app unit (a test keeps them identical),
  `DynamicUser=yes` with `User=yoal-workload-<id>` and `StateDirectory=yoal-workloads/<id>` so the
  run shares the app's dynamic uid and state directory, the release as working directory, the
  run's env file, file secrets as `LoadCredential=` with `<NAME>_FILE=/run/credentials/<unit>/<NAME>`,
  and the app's volumes as `BindPaths`/`BindReadOnlyPaths`. A bare `argv[0]` runs through
  `/usr/bin/env` inside the sandbox, so `PATH` (node and bun directories first) and the release
  directory apply. No `PORT`/`HOST`.
- **Container apps**: `podman run --rm --cgroups=split --log-driver=passthrough --pull=missing`
  of the app's image with `--userns=container:yoal-workload-<id>` (the run joins the running app
  container's user namespace, so `/data` and volumes are mounted without `U` or a private SELinux
  relabel and are never re-chowned under the app), the app's network, env file, `/data`, volumes,
  the run's own secrets (`:ro,U`), `--cap-drop=all`, `no-new-privileges`, read-only root and a
  64 MB `/tmp`. The app container must be running. `Delegate=yes`, `KillMode=mixed`.
- **No shell, no expansion.** The argv goes to systemd as an array. systemd ≥ 254 gets
  `--expand-environment=no`; older versions get every `$` doubled. Specifiers are not expanded for
  a transient unit's command.
- **Status** comes from `systemctl show --timestamp=unix` (`ExecMainCode`, `ExecMainStatus`,
  `Result`, start/exit timestamps). An exit before the timeout is judged by its exit code even if
  the remaining "exited" state later ran into `RuntimeMaxSec`. systemd's own exec statuses (203
  EXEC, 200 CHDIR, …) become readable errors in the agent.

### Surfaces

REST `api/v1/projects/:slug/jobs` (`GET`/`POST`), `…/jobs/:name` (`GET`/`PATCH`/`DELETE`),
`…/:name/run`, `…/:name/runs`, `…/:name/pause`, `…/:name/resume`, `…/jobs/runs` (`GET`, `POST` a
one-off), `…/runs/:id` (`?wait=`), `…/runs/:id/cancel`, `…/runs/:id/logs`. MCP `list_jobs`,
`create_job`, `update_job`, `pause_job`, `run_job`, `run_command`, `get_job_runs`, `get_job_run`,
`cancel_job_run`, `delete_job` (confirmed); the assistant also confirms `run_job` and
`run_command`. CLI `yoal jobs …` and `yoal run <project> -- <argv…>` (exits with the command's
status, 124 on timeout, 130 when cancelled). Dashboard: the project's **Jobs** tab.

### Not built

Time zones (UTC only), pinning a run to an older deployment, a `catchUp` option, per-job memory or
CPU (runs get the app's), webhooks to trigger a job, and alerts on job failure.
