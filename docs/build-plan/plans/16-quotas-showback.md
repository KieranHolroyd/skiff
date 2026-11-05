# 16 — Quotas, usage, and showback

**Priority:** P1 · **Effort:** M · **Lane:** E · **Wave:** 2
**Depends on:** F1 contracts
**Blocks:** 12 preview data (caps), 20 agent tools (quotas)
**Primary files:** `packages/contracts/src/quota.ts`, `packages/core/src/quota.ts`,
`packages/db/src/schema.ts`, `packages/core/src/metrics.ts`,
`apps/control-plane/src/routes/api/v1/quotas/**`, `docs/QUOTAS.md`

## Goal

Stop one project or agent from exhausting a node, and give operators a clear usage picture: per-org
and per-project limits for databases, storage, volumes, jobs, builds, previews, memory, and egress,
with alerts and CSV showback. No billing.

## Non-goals

- Metered billing, invoices, or payments.
- A chargeback system with prices; usage is shown in resource units, optionally with a configurable
  rate table for showback.
- Per-request quotas for the public data plane (rate limits are separate).
- Replacing node admission; quotas are org-level, admission is node-level.

## Current state

- `QuotaService` (`packages/core/src/quota.ts`) has `projects`, `storageBytes`,
  `retainedDeployments`, `maxUploadBytes`; it counts projects and release bytes only.
- `orgQuotas` table has those four columns.
- Database/storage `storageMb` is alert-only; `admit()` checks memory only.
- Telemetry has `db_metrics_1m`/`1h` and `storage_metrics_1m`/`1h` with size/usage.
- No usage page, CSV export, or resource-count quota.

## Design

### Quota model

Extend `orgQuotas` (nullable = unlimited):

| Field | Unit |
|---|---|
| `databases` | count |
| `databaseStorageBytes` | sum of `storageMb` (or actual size) |
| `storageInstances` | count |
| `storageBytes` | sum of instance `storageMb` / used |
| `storageObjects` | count |
| `appVolumes` | count |
| `appVolumeBytes` | sum of `sizeMb` |
| `jobs` | count |
| `jobRunsPerDay` | count |
| `buildsPerDay` | count |
| `previews` | concurrent count |
| `workloadMemoryMb` | sum of admitted memory |
| `egressBytes` | 30-day rolling |

- Per-project overrides in a `project_quotas` table (same shape, nullable = inherit).
- `QuotaService` gets `assertCanCreateDatabase`, `assertCanResizeDatabase`,
  `assertCanCreateStorage`, `assertCanCreateVolume`, `assertCanCreateJob`, `assertCanRunJob`,
  `assertCanCreatePreview`, `assertCanAdmitMemory`, `assertCanEgress`.
- Enforcement at create/update and at preview/job creation. A quota error names the quota, current
  usage, and the limit.

### Usage

- `UsageService` computes a snapshot on demand and caches it for 60 s:
  - Counts from SQLite tables.
  - Bytes from the latest `db_metrics_1m`/`storage_metrics_1m` and `node_volumes`/`app_volumes`.
  - Egress from the traffic pipeline (bytes per host/org) over 30 days.
  - Jobs/builds from `job_runs`/`builds` (last 24 h).
- `usage_snapshots` table (orgId, day, json) for trend; a daily compaction in maintenance.
- Showback rate table optional: `settings` JSON with `cpuPerHour`, `gbStoragePerMonth`, etc.;
  compute a currency estimate in the UI only, never bill.

### Dashboard

- Org Settings → Usage: cards for each quota, 30-day sparkline, top projects, CSV export.
- Project Settings → Usage: the same scoped.
- Alerts at 80% and 95%; a quota breach is a warning, not a page (unless disk).
- Node capacity panel: reserved vs actual, disk free, top consumers.

### Agent/MCP

- MCP: `get_usage` (org/project), `get_quotas`; no write by default. Platform admin can set quotas via
  REST/CLI.
- CLI: `skif usage`, `skif quota set`.
- Never expose another org's usage.

## Implementation order

1. Contract fields + migration (contract PR).
2. `QuotaService` methods + enforcement in services; tests for each resource.
3. `UsageService` counts + latest metrics; REST.
4. Dashboard cards + CSV.
5. Daily snapshots/trend + alerts.
6. Per-project overrides.
7. Agent/MCP read tools.

## Acceptance criteria

- [ ] Creating a database over the count or storage quota fails with a clear 409 naming the limit.
- [ ] Resizing a database/volume over quota fails; a preview over the concurrent cap fails.
- [ ] Usage cards show counts/bytes and a 30-day trend; CSV exports the same numbers.
- [ ] 80%/95% alerts fire once per period, not every sweep.
- [ ] The operator can set a per-project override; inheritance is visible.
- [ ] An agent creating resources hits the same quotas; no bypass via MCP.
- [ ] Disk admission and org quotas do not double-count; a test asserts the numbers.

## Tests

- Unit: quota math, inheritance, usage aggregation, alert dedupe.
- Integration: create/resize over quota; preview cap; job runs/day; CSV.
- Real node: disk admission vs quota; metrics lag; no false positive.
- Security: org isolation; no cross-org usage.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Metrics lag causes false quotas | Use reserved values for hard limits, actual for display |
| Double counting | One source per resource; test fixture |
| Quota bypass via resize/MCP | Enforce in the service layer, not the surface |
| Alert noise | Dedupe per period; 80/95 only |
| Showback misleads | Label estimates; no billing |

## Rollout

Counts and hard limits first (databases, storage, volumes, previews), then memory/egress showback.
Default quotas unlimited for existing orgs; new installs get sensible defaults. Feature flag
`SKIFF_FEATURE_QUOTAS` for enforcement.

## Open questions

- Should `databaseStorageBytes` use the budget (`storageMb`) or actual size? Budget for admission,
  actual for usage.
- Do we need per-project quotas in v1? Org-level first; project overrides are a small addition.
- Egress metering from the traffic pipeline is approximate; label it.

## File ownership

Own: `packages/contracts/src/quota.ts`, `packages/core/src/quota.ts` + test,
`packages/core/src/usage.ts` + test, `apps/control-plane/src/routes/api/v1/quotas/**`,
`docs/QUOTAS.md`.

Integration-owned: schema/migration, core context/index, metrics queries, dashboard settings,
MCP/CLI registration, e2e harness.
