# 19 — Process groups: web, worker, and scheduler

**Priority:** P1 · **Effort:** M · **Lane:** C · **Wave:** 2
**Depends on:** F1 contracts, 08 Valkey, 09 jobs (soft: 07 volumes)
**Blocks:** 14 stacks (multi-process apps)
**Primary files:** `packages/contracts/src/workload.ts`, `packages/core/src/workloads.ts`,
`apps/helper/src/units.ts`, `apps/agent/src/runtime.ts`, `docs/V2-BACKEND.md`

## Goal

Let one project run more than one process from the same immutable release: a web server, one or
more workers, and a scheduler, each with its own command, port/health, resources, logs, and
restart policy.

## Non-goals

- Autoscaling. Multi-node placement of process groups follows [CLUSTERING.md](../../CLUSTERING.md) §8.
- Per-process releases; all processes share the release.
- A general supervisor API (systemd is the supervisor).
- Horizontal autoscaling; manual replicas on one node only.

## Current state

- `WorkloadSpec` is one command/image; `workloads` has a unique index on `project_id` (D44).
- `WorkloadDesired` has one `command`/`image`, one `port`, one `healthPath`.
- The helper renders one unit per workload; the agent converges one.
- Heroku has a Procfile, Fly has `processes`, Render has six service types; Skiff has one.

## Design

### Spec

```json
{
  "runtime": "process",
  "processes": {
    "web": { "command": ["bun","run","start"], "port": 3000, "healthPath": "/health", "memoryMb": 256, "cpus": 1 },
    "worker": { "command": ["bun","run","worker"], "replicas": 2, "memoryMb": 192 },
    "scheduler": { "command": ["bun","run","scheduler"], "memoryMb": 128 }
  },
  "env": {},
  "secrets": []
}
```

- Exactly one process may declare a `port`/`healthPath` (the web process) unless a future plan adds
  multiple routes.
- `replicas` is allowed only for non-web processes in v1, and only on one node; the scheduler/jobs
  run once (no replicas).
- All processes share env, secrets, release, and data/volumes; each gets its own resource caps.
- `WorkloadSpec.processes` is mutually exclusive with `command`/`image` at the top level. For a
  single process, the existing shape remains valid for backward compatibility.

### Model

- Change `workloads` uniqueness from `project_id` to `(project_id, environment, process_name)`;
  add `process_name`, `replicas`, `parent_workload_id` or `process_group_id`.
- A `process_group` row per deployment/environment, with child workloads per process.
- `Deployment` snapshots the whole process group spec; rollback restores all children.
- Admission sums memory across processes; each child gets its own `MemoryMax` and a share of CPU.
- Port allocation: web gets the Caddy upstream; workers get no published port. A worker that needs
  a port (metrics) is a later feature.

### Runtime

- Helper renders one unit per process: `skiff-workload-<groupId>-<process>.service` for processes, or
  one Quadlet container per process for containers (if the spec allows it; start with process only).
- Each unit mounts the same release, env files, secrets, and volumes; `ReadWritePaths` per process.
- `Restart=on-failure`; `TimeoutStopSec` for drain; health check only for web.
- Logs are tagged with process name; the agent reports status per child; the group is `running` when
  web is healthy and workers are running (or degraded with a message).
- Caddy upstream points at the web process; workers do not get routes.

### Surfaces

- REST: `GET/PUT /projects/:slug/workload` accepts `processes`; `GET /projects/:slug/processes`
  returns status per process.
- MCP: `set_processes`, `get_processes`, `restart_process` (confirmed).
- CLI: `skif processes list|restart|logs`.
- Dashboard: Processes tab, per-process status/logs/restart, memory/CPU, replica count.
- Docs: `docs/V2-BACKEND.md` process groups; `skiff.json` migration.

## Implementation order

1. Contract `processes` + validation + migration (contract PR).
2. Workload uniqueness per environment/process; migrate existing rows as a singleton group.
3. Helper multi-unit rendering + shared release/env/volumes + health per process.
4. Agent convergence/status aggregation.
5. Admission sum + per-process caps.
6. REST/MCP/CLI/dashboard.
7. Logs and restart.
8. Docs + a fixture (web + worker + scheduler).

## Acceptance criteria

- [ ] A process app with web + 2 workers + scheduler runs all four; web is routed; workers are not.
- [ ] A worker crash restarts without taking down web; the group status shows degraded.
- [ ] Memory admission sums all processes; a group over the node budget is rejected.
- [ ] Rollback restores the whole process group, not one child.
- [ ] Logs are tagged by process and visible in the UI/CLI.
- [ ] A single-process app keeps working with the old spec.
- [ ] Scaling a worker to 2 replicas works on one node; the UI warns about single-node limits.

## Tests

- Unit: spec validation, process names, port uniqueness, admission sum, status aggregation.
- Integration: helper render 4 units, crash/restart, rollback, logs.
- Real node: systemd units, shared release/env, `MemoryMax`, Caddy upstream.
- Security: no secret in logs; per-process `ReadWritePaths`.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Migration of unique index | Additive column; migrate to singleton; keep old path until green |
| Memory overcommit | Sum admission; per-process caps; group reject |
| Log routing confusion | Process tag; UI filter; `journalctl` unit name |
| Replica confusion | Single-node only; explicit warning; no autoscaling claim |
| Container process groups | Start with process runtime; container groups later |

## Rollout

`SKIFF_FEATURE_PROCESS_GROUPS` off by default. Existing single-process apps continue. Enable for new
process apps, then migrate a fixture. Do not change the default for existing projects.

## Open questions

- Do we allow multiple web processes with different ports/routes? Not in v1; one web route.
- Should replicas be a separate feature? Keep a simple `replicas` count; no scheduler.
- How do we expose a worker metrics port? Later; no route.

## File ownership

Own: `packages/contracts/src/workload.ts` (processes), `packages/core/src/workloads.ts`,
`apps/helper/src/units.ts`, `apps/agent/src/runtime.ts`, `docs/V2-BACKEND.md`.

Integration-owned: schema/migration, core context/index, helper server/systemd, agent main,
dashboard project layout, MCP/CLI registration, e2e harness.
