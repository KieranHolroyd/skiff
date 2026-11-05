# 09 — Jobs, cron, and one-off tasks

**Priority:** P1 · **Effort:** M · **Lane:** C · **Wave:** 2 (scheduler primitive in Wave 1)
**Depends on:** F1 contracts, F4 scheduler primitive
**Blocks:** 01 backups (soft), 06 upgrade tasks, 11 blueprints, 12 preview teardown, 14 stacks, 19 process groups
**Primary files:** `packages/contracts/src/job.ts`, `packages/core/src/jobs.ts`,
`apps/helper/src/jobs.ts`, `apps/agent/src/jobs.ts`,
`apps/control-plane/src/routes/api/v1/jobs/**`, `docs/JOBS.md`

> **Status update (5 Nov 2026):** the five-field cron parser and the backup scheduling sweep are
> shipped; generic scheduler work is F4. Remaining: user jobs, one-off runs, retries/logs, preview
> teardown. Verify before implementing.

## Goal

Give projects a first-class scheduler: cron jobs, one-off tasks, retries, timeouts, concurrency
policy, logs, and history, running the same immutable release in the same sandbox as the app.

## Non-goals

- A general workflow/DAG engine, queues, or event-driven choreography.
- Multi-step pipelines with branching (that is a later workflow product, if ever).
- Running arbitrary host commands; jobs run the release's command in the workload sandbox.
- Replacing the Builder's build queue.

## Current state

- `WorkloadSpec` is one command/image; one workload per project (D44).
- The Builder has a job queue (`packages/core/src/builds.ts`) but it is build-specific.
- `MaintenanceService.run()` is the only periodic loop; no user-facing scheduler.
- The helper has fixed verbs; no transient job unit.
- No job table, API, UI, or MCP tool.

## Design

### Scheduler primitive (F4, Wave 1)

`SchedulerService`:

- `enqueue({ kind, key, runAt, payload })` with an idempotency key.
- `claim(workerId, limit)` leases due tasks (`leaseUntil`); a crashed worker's lease expires.
- `complete(id, result)` / `fail(id, error, retryAt)`; exponential backoff with a cap.
- `tick()` called from `MaintenanceService` (60 s) or a dedicated loop; no new daemon.
- Durable in SQLite; no in-memory timer reliance.
- Used first by backups (01), then by user jobs.

### Job model

| Table | Columns |
|---|---|
| `jobs` | id, orgId, projectId, environment, name, commandJson, schedule (cron, nullable = manual), timezone, timeoutSeconds, concurrency (`forbid`/`allow`), maxRetries, memoryMb, cpus, enabled, nextRunAt, lastRunAt, createdBy, timestamps |
| `job_runs` | id, jobId, trigger (`schedule`/`manual`/`api`/`mcp`), status (`queued`/`running`/`ok`/`failed`/`timeout`/`skipped`), startedAt, finishedAt, exitCode, stdoutTail, stderrTail, error, workerId |

- `command` is an argv array, not a shell string; the helper validates it.
- A job runs the project's **current production release** by default; `deploymentId` can pin a
  specific release for a one-off.
- `environment` scopes env/secrets; preview jobs are not supported in v1.
- `concurrency=forbid` skips a run if the previous is still running, recording `skipped`.
- `timeoutSeconds` is enforced by systemd (`TimeoutStartSec`) and the agent.

### Execution

1. Scheduler tick computes due jobs, creates `job_runs` (`queued`), enqueues a task.
2. Agent receives `jobTasks` in desired state (or claims from `SchedulerService` via a new agent
   endpoint); fetches activation for env/secrets.
3. Helper `jobs.run` renders a transient systemd unit:
   - Same `DynamicUser`/sandbox, `MemoryMax`, `CPUQuota`, `skiff-workloads.slice`.
   - Release dir read-only, `/data` or volumes as configured, env file + secret files.
   - `ExecStart` is the validated argv; no shell.
   - `TimeoutStartSec`, `Restart=no`.
4. Agent collects the exit code and a bounded stdout/stderr tail (e.g. 64 KB) and reports.
5. UI/CLI shows history, logs, next run, run now, retry, pause.

### Cron

- Parse 5-field cron with a small library or a tested internal parser; support time zones.
- Compute `nextRunAt` after each run; if the scheduler was down, do not replay every missed run by
  default; run once and record `missed` count. Add `catchUp: false` default.
- Validate minimum interval (e.g. 1 minute); prevent a runaway every-second job.
- DST handling: use the IANA zone; test spring-forward/fall-back.

### Surfaces

- REST: `/api/v1/projects/:slug/jobs`, `/:name`, `/:name/run`, `/:name/runs`, `/:name/pause`.
- MCP: `list_jobs`, `create_job`, `run_job`, `get_job_runs`, `pause_job` (confirmed for delete).
- CLI: `skif jobs list|create|run|logs|pause|delete`.
- Dashboard: Jobs tab, cron builder, next run, history, log tail, run now.
- Permissions: `project:update` for manage; `project:read` for list/logs. MCP scoped.

## Implementation order

1. F4 scheduler primitive + tests (Wave 1).
2. Contracts/tables/migration (contract PR).
3. `JobService` CRUD + cron next-run + validation.
4. Helper `jobs.run` transient unit + agent task loop + result.
5. Scheduler integration: due jobs, retries, concurrency.
6. REST/CLI/MCP/UI.
7. Logs/history retention + alerts.
8. Backup integration uses F4 directly (not user jobs).

## Acceptance criteria

- [ ] A cron job runs on schedule, records status/exit code, and shows a log tail.
- [ ] A one-off job can be triggered from UI/CLI/MCP and pinned to a deployment.
- [ ] `concurrency=forbid` skips an overlapping run and records `skipped`.
- [ ] A timeout kills the unit and records `timeout`.
- [ ] A crashed agent's lease expires and the job is retried or failed, not stuck.
- [ ] DST and a missed run behave as documented; no replay storm.
- [ ] No shell string; a command with spaces/quotes is preserved as argv.
- [ ] Job env/secrets use activation, not desired state.

## Tests

- Unit: cron parser, next-run/DST, retry backoff, concurrency, idempotency.
- Integration: fake helper, run success/failure/timeout, skipped, lease expiry.
- Real node: transient systemd unit, sandbox, `MemoryMax`, log tail, release mount.
- Security: no secret in logs; command validation; no host path.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Runaway schedules | Min interval, max runs/day, pause, alert |
| Overlap | `concurrency=forbid` default for cron |
| Log volume | 64 KB tail, retention, no full log warehouse |
| Scheduler downtime | `nextRunAt` recompute; no storm; `missed` count |
| Jobs mutate data | Run with the same env as the app; document; no automatic rollback |

## Rollout

`SKIFF_FEATURE_JOBS` off by default. Backups use F4 internally regardless. Enable user jobs after
the transient-unit test passes on Debian 13.

## Open questions

- Should a job run the production release by default, or require an explicit deployment? Production
  is convenient; allow `--deployment`.
- Do we need per-job volumes? Reuse app volumes (07) in v1.
- Do we expose a webhook trigger? Not in v1; cron + manual + API.

## File ownership

Own: `packages/contracts/src/job.ts`, `packages/core/src/jobs.ts` + test,
`apps/helper/src/jobs.ts` + test, `apps/agent/src/jobs.ts` + test,
`apps/control-plane/src/routes/api/v1/jobs/**`, `docs/JOBS.md`.

Integration-owned: F4 scheduler, schema/migration, core context/index, helper server/systemd, agent
main, dashboard project layout, MCP/CLI registration, e2e harness.
