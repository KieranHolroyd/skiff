# Quotas, usage and showback

Plan 16. Quotas bound what one org or project can create; usage shows what is actually in use and
produces a CSV for showback. There is **no billing**: no prices, invoices or payments.

## Model

`org_quotas` holds the org base. Every new field is nullable and `-1`/`NULL` mean unlimited, so an
existing org keeps its behaviour after the upgrade. `project_quotas` holds optional overrides; a
null column inherits the org value.

| Field | Unit | Enforced today |
|---|---|---|
| `projects` | count | yes |
| `storageBytes` | bytes (release artifacts) | yes (upload) |
| `retainedDeployments` | count | yes |
| `maxUploadBytes` | bytes | yes |
| `databases` | count | yes |
| `databaseStorageBytes` | bytes (configured budget) | yes |
| `storageInstances` | count | yes |
| `storageBytes` (object storage) | bytes (configured budget) | yes |
| `storageObjects` | count | control-plane uploads; presigned S3 writes are reflected after the next stats sample |
| `appVolumes` / `appVolumeBytes` | count / bytes (reserved `sizeMb`) | yes (create; grow checks the delta) |
| `jobs` / `jobRunsPerDay` | count | `assertCanCreateJob` / `assertCanRunJob`, counted through a hook the jobs service registers (see below) |
| `buildsPerDay` | count | yes (enqueue and webhook) |
| `previews` | concurrent count | yes (a deploy that adds a preview) |
| `workloadMemoryMb` | MB (reserved) | yes (workloads, databases, storage) |
| `egressBytes` | bytes (30-day rolling) | yes, at deploy time: over the quota new deploys are refused; traffic is never cut |

Enforcement is in `QuotaService` (`packages/core/src/quota.ts`), so REST, CLI, MCP, the dashboard and
webhooks all hit the same check. Hard limits use **reserved** values (a database's configured
`storageMb`) rather than lagging metrics. A failed check is a 409 `quota_exceeded` naming the metric,
the current value and the limit.

### Previews

A **preview** is an active deployment of a live project that no environment points at and that was
never production (`promoted_at IS NULL`). Every deployment has a preview URL (D13), but a past
production release is rollback history, already bounded by `retainedDeployments`; counting it would
make an ordinary promote-on-deploy fail once history filled up. `DeploymentService` checks
`assertCanCreatePreview` only when a deploy adds one: `promote: false`, or a promote that moves a
non-production environment off a deployment that was never production. Promote and rollback are
never refused, because they are the way back from a bad deploy. The check runs before the release is stored.

### Jobs

Jobs and job runs live in the jobs service's tables (plan 09), so `QuotaService` does not query
them itself. That service calls `quota.registerCounter('jobs' | 'jobRunsPerDay', fn)` with a counter
that receives `{ orgId, projectId, since }` (`projectId` null for an org-wide count, `since` the
start of the 24-hour window). It calls `assertCanCreateJob` before inserting a job and
`assertCanRunJob` before starting any run, scheduled, manual, one-off or retry; a refused scheduled
run or retry is recorded as `skipped` with the quota message rather than retried, and skipped runs
do not count towards `jobRunsPerDay` (docs/SCHEDULER.md §Jobs). Until a counter is registered,
usage reads 0 and only a limit of 0 refuses. Function cron triggers (D110) are not jobs: they fire
on the node from the function's manifest, and a manual "run scheduled now" is a function test, so
neither counts.

### Egress

Egress is the sum of response bytes in the traffic store's hourly buckets over the last 30 days,
for the org (or the project, when it overrides `egressBytes`). It is approximate (it lags traffic
ingest) and reads as zero when telemetry is off or unavailable, so a store outage never
blocks anything. Cutting live traffic on an approximate meter would turn a quota into an outage,
so the behaviour over the quota is:

- 80% and 95%: the usual quota warning alerts (below);
- over 100%: `DeploymentService.deployEntries` refuses **new deploys** (uploads, git builds,
  templates) with `409 quota_exceeded`. Running sites keep serving, and promote/rollback stay
  available as the recovery path. A refused git build is recorded as failed with the message.

The window is rolling, so deploys resume by themselves as old traffic leaves it. The total is
cached for 60 seconds per scope (`UsageService.egressUsed`), shared by the check and the usage view.

## Usage

`UsageService` (`packages/core/src/usage.ts`) computes:

- counts from SQLite (`projects`, `databases`, `storage_instances`, `builds`);
- bytes from the latest agent samples (`databases.size_bytes`, `storage_instances.used_bytes`);
- objects from `storage_instances.objects`;
- admitted memory from workloads, databases and storage reservations;
- app volumes as live volumes and their configured `sizeMb` (the reserved value);
- jobs and job runs from the counters the jobs service registers (skipped runs excluded);
- previews as defined above;
- egress as an approximate 30-day sum from the traffic store (zero when telemetry is off).

The view is cached for 60 seconds. A daily `usage_snapshots` row (org level) is written by the
maintenance sweep for the trend.

## Surfaces

- REST: `GET /api/v1/usage[?project=<slug>][&format=csv|&history=1]`,
  `GET /api/v1/quotas[?project=<slug>]`, `PUT|PATCH /api/v1/quotas[?project=<slug>]`,
  `DELETE /api/v1/quotas?project=<slug>`.
- MCP: `get_usage` and `get_quotas`, both read-only. A token cannot write a quota.
- CLI: `yoal usage [project]`.
- Dashboard: **Settings → Usage** cards, table and CSV. Project scoping is available through REST,
  MCP and the CLI.

Only a platform admin can change quotas. Reads always resolve the project inside the caller's org,
so another org's usage is a 404, never a leak.

## Alerts

The maintenance sweep evaluates org quotas at 80% and 95%. Each threshold fires once per UTC day
(the alert key includes the day), as a `warning` — quotas never page. Disk admission stays a node
warning/critical alert.

## Feature flag

`YOAL_FEATURE_QUOTAS` defaults on. Setting it off makes `get()` return unlimited, preserving the
pre-plan behaviour; usage/showback reads still work.
