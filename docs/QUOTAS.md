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
| `appVolumes` / `appVolumeBytes` | count / bytes | schema + assert only (wave 2) |
| `jobs` / `jobRunsPerDay` | count | schema + assert only (jobs are a later wave) |
| `buildsPerDay` | count | yes (enqueue and webhook) |
| `previews` | count | schema + assert only (preview creation is a later wave) |
| `workloadMemoryMb` | MB (reserved) | yes (workloads, databases, storage) |
| `egressBytes` | bytes (30-day) | `assertCanEgress` takes the current total; no data-plane hook yet |

Enforcement is in `QuotaService` (`packages/core/src/quota.ts`), so REST, CLI, MCP, the dashboard and
webhooks all hit the same check. Hard limits use **reserved** values (a database's configured
`storageMb`) rather than lagging metrics. A failed check is a 409 `quota_exceeded` naming the metric,
the current value and the limit.

## Usage

`UsageService` (`packages/core/src/usage.ts`) computes:

- counts from SQLite (`projects`, `databases`, `storage_instances`, `builds`);
- bytes from the latest agent samples (`databases.size_bytes`, `storage_instances.used_bytes`);
- objects from `storage_instances.objects`;
- admitted memory from workloads, databases and storage reservations;
- previews as active deployments that are not a project's production pointer;
- egress as an approximate 30-day sum from the traffic store (zero when telemetry is off).

The view is cached for 60 seconds. A daily `usage_snapshots` row (org level) is written by the
maintenance sweep for the trend.

## Surfaces

- REST: `GET /api/v1/usage[?project=<slug>][&format=csv|&history=1]`,
  `GET /api/v1/quotas[?project=<slug>]`, `PUT|PATCH /api/v1/quotas[?project=<slug>]`,
  `DELETE /api/v1/quotas?project=<slug>`.
- MCP: `get_usage` and `get_quotas`, both read-only. A token cannot write a quota.
- CLI: `skif usage [project]`.
- Dashboard: **Settings → Usage** cards, table and CSV. Project scoping is available through REST,
  MCP and the CLI.

Only a platform admin can change quotas. Reads always resolve the project inside the caller's org,
so another org's usage is a 404, never a leak.

## Alerts

The maintenance sweep evaluates org quotas at 80% and 95%. Each threshold fires once per UTC day
(the alert key includes the day), as a `warning` — quotas never page. Disk admission stays a node
warning/critical alert.

## Feature flag

`SKIFF_FEATURE_QUOTAS` defaults on. Setting it off makes `get()` return unlimited, preserving the
pre-plan behaviour; usage/showback reads still work.
