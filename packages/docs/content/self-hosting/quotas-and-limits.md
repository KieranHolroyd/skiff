---
title: Quotas, usage and limits
description: Set per-organisation quotas, read usage and showback reports, tune platform policies, and check the fixed limits built into Skiff.
---

Quotas cap what one organisation, or one project inside it, can create. Usage shows what is in use against those caps and gives you a CSV for showback, which means reporting what each project consumes. Skiff does not bill: there are no prices or invoices. Platform policies control retention, defaults for new resources and assistant cost caps. The last section lists the limits that are fixed in code.

## Organisation quotas

Every quota is a maximum in its natural unit. A value of `-1` means unlimited. A fresh organisation starts with every quota unlimited, so an upgrade does not change behaviour until you set a limit.

| Quota | Unit | What it limits | Checked when |
|---|---|---|---|
| `projects` | count | Projects in the organisation | Creating a project |
| `retainedDeployments` | count | Unpinned deployments kept per project | Deployments are pruned to this number |
| `maxUploadBytes` | bytes | Largest single upload or release | Starting an upload, or creating a release |
| `storageBytes` | bytes | Release artifacts, and the object storage budget | Uploads, and creating or resizing object storage |
| `databases` | count | Managed databases | Creating a database |
| `databaseStorageBytes` | bytes | Storage budgets reserved across databases | Creating or growing a database |
| `storageInstances` | count | Object storage services | Creating a storage service |
| `storageObjects` | count | Objects stored | Object uploads through the control plane |
| `buildsPerDay` | count | Builds started in the last 24 hours | Starting a build, including from a webhook |
| `workloadMemoryMb` | MB | Memory reserved by workloads, databases, storage and brokers | Starting or growing a workload |
| `appVolumes` | count | App volumes, not counting ones in the trash | Creating a volume |
| `appVolumeBytes` | bytes | Configured sizes of app volumes | Creating or growing a volume |
| `previews` | count | Previews: deployments that serve no environment and were never production | A deploy that adds a preview |
| `egressBytes` | bytes | Data served in the last 30 days | Deploying, when the total is already over the limit |
| `jobs`, `jobRunsPerDay` | count | Jobs, and job runs in the last 24 hours | Creating a job, and starting a run |

Two details matter when you size a limit:

- **Reserved, not measured.** Database and storage limits count the budget you configured (for example a database's `storageMb`), not its current size. A lagging metric cannot let a create slip past a limit. Usage pages show the measured size separately.
- **Overrides scope a count.** A project can override individual fields. When it overrides a count or budget, that limit counts only that project's resources. Otherwise it counts the whole organisation. The project count, upload size and release storage checks always use the organisation value.

### Previews

Every deployment gets its own preview URL. For the `previews` quota, a preview is a deployment that no environment is serving and that was never live in production. That is a deploy with `--no-promote`, or an older deployment of a non-production environment such as staging. Past production releases don't count, because they are your rollback history and `retainedDeployments` already limits them.

So only a deploy that adds a preview is checked. A normal deploy that goes straight to production is never refused by this quota, and neither are promote and rollback. To free a slot, promote or delete a preview deployment.

### Egress

Egress is an estimate of the bytes your sites and apps served over the last 30 days, read from the traffic metrics. If traffic metrics are off or unavailable, egress reads as zero and nothing is refused.

Going over the egress quota never cuts traffic. Instead:

- At 80% and 95% you get the usual quota warning (see [Warnings](#warnings)).
- Over 100%, new deploys are refused with `quota_exceeded`. This covers uploads, git builds and templates. Running sites keep serving, and you can still promote or roll back.

The window is rolling, so deploys work again once older traffic leaves the 30 days, or when an admin raises the quota.

### Jobs

`jobs` limits how many [jobs](/compute/scheduled-jobs#app-jobs) an organisation has, and `jobRunsPerDay` limits job runs in the last 24 hours: scheduled, manual, one-off commands and retries. A scheduled run (or retry) over the limit is not started; it appears in the job's history as **skipped** with the quota message, and skipped runs don't count. A manual run or `skif run` over the limit is refused with `quota_exceeded`. Function cron triggers are not jobs, and running one by hand from the function's test panel doesn't count either.

### Change a quota

Only a platform admin can change quotas. Open **Usage & limits** in settings and choose **Edit limits**. A blank field means unlimited. Byte fields are entered in GB or MB and stored in bytes. New requests are checked against the new values straight away.

The same change is available over REST. Send an org update with `PUT` or `PATCH` to `/api/v1/quotas`, using an API key from a platform admin:

```sh
curl -X PUT https://control.example.com/api/v1/quotas \
  -H "Authorization: Bearer $SKIFF_KEY" \
  -H "Content-Type: application/json" \
  -d '{"projects": 10, "maxUploadBytes": 104857600, "databases": -1}'
```

Each field is optional, but the body must name at least one. Use `-1` for unlimited.

To set a project's overrides, add `?project=my-site`. The body takes the same fields, and `null` means inherit the organisation value. A project update replaces all of that project's overrides, so send every override you want to keep. Remove them all with `DELETE /api/v1/quotas?project=my-site`.

> [!NOTE]
> Project overrides can only be written over REST. The dashboard edits the organisation values, and the CLI and MCP tools are read-only.

## When a quota is hit

A request that would go over a limit is refused before anything is created. The response is HTTP `409` with the error code `quota_exceeded`:

```json
{
  "error": "quota_exceeded",
  "message": "Databases quota (databases) exceeded: 3 used of 2. Delete unused resources or raise the quota."
}
```

The message names the metric, the value the request would reach and the limit. For count limits, that value includes the item being created. For egress, it is the current 30-day total. Project-count and upload messages are worded differently, for example `Storage quota exceeded (…)`, but they follow the same `409` shape. Existing resources keep running. The limit only blocks new ones.

## Usage

Usage reports current counts, measured sizes and a 30-day egress estimate. Some counters are rolling: builds and job runs cover the last 24 hours, and egress covers the last 30 days. Usage is cached for 60 seconds, and the cache clears when a quota changes. Anyone who can read projects can see usage. Usage never crosses organisations.

You can see it in four places:

- **Settings → Usage & limits** shows a card and table for each metric, a 30-day trend and an **Export CSV** button. The export covers the whole organisation.
- **`skif usage [project] [--json]`** prints the same numbers as a table. Give a project slug to scope it to one project. The `--json` flag prints the raw response.
- **REST** exposes `GET /api/v1/usage`. Add `?project=<slug>` to scope it, `?format=csv` for a CSV, or `?history=1` for up to 30 daily points.
- **MCP** exposes the read-only `get_usage` and `get_quotas` tools.

The CSV has one row per metric with the columns `metric,unit,used,limit,percent`. An unlimited metric shows `unlimited` in the limit column and an empty percent.

### Warnings

The maintenance sweep checks every organisation's quotas. When a metric reaches 80% or 95% of its limit, it raises a warning alert. Each threshold fires once per UTC day for each metric. Quotas only warn; they never page anyone. The usage view also lists metrics at or above 80%. See [alerts](/observe/alerts) for where warnings appear.

## Platform policies

Platform policies are settings that apply to the whole installation. Open **Policies** in settings. Only the owner can open or change this page. Changes apply from the next maintenance run or request, so no restart is needed. Each policy has a default, and each field is limited to the range shown.

| Policy | Controls | Default | Range |
|---|---|---|---|
| Trash period | How long deleted apps, databases, storage and volumes can be restored. Applies to items deleted from now on. | 7 days | 1 to 90 |
| Deployments kept per app | Unpinned deployments kept when neither the organisation nor the project quota sets one | 10 | 1 to 500 |
| Log retention | Build and runtime log lines older than this are pruned | 7 days | 1 to 90 |
| Deleted-history retention | Soft-deleted deployment records, revoked share links and expired redemptions | 30 days | 1 to 365 |
| Operation history | Finished bulk operations and prunes shown under **Maintenance** | 90 days | 1 to 365 |
| Backup schedule | Cron expression (UTC) for new managed databases | `0 3 * * *` | Five-field cron |
| Backup retention | How long backups of new managed databases are kept. The newest backup is always kept. | 7 days | 1 to 365 |
| Ingress driver | How the platform hostname follows a healthy ingress node. The default is `direct`, a single edge. | `direct` | See [clustering](/self-hosting/clustering) |
| Ingress hold-down | Failed probes before an ingress is withdrawn | 45 seconds | 10 to 600 |
| Ingress re-add hold-down | Healthy time before a recovered ingress is added back | 120 seconds | 30 to 3600 |
| Model calls per turn | Assistant model calls in one turn before it stops | 12 | 1 to 50 |
| Tool calls per turn | Assistant tool calls in one turn. Further calls are refused. | 24 | 1 to 200 |
| Turns per user per minute | Rate limit on starting assistant turns, per user | 12 | 1 to 120 |

Alert thresholds, such as disk, certificate expiry and database storage, are also platform settings. You edit them on **Alerts → System alerts**, not on this page.

## Hard limits

These limits are fixed in code. The only one you can change is the single-upload size for object storage, which is noted in its row.

### Static sites and deploys

| Limit | Value | Notes |
|---|---|---|
| Uncompressed size of one deploy | 500 MiB | Checked when the deploy is finalised |
| Size of one file | 25 MiB | Checked when the deploy is finalised |
| Files in one deploy | 20,000 | Checked when the deploy is finalised |
| Inline deploy, total size | 5 MiB | Files sent in the request body. Use an upload session for larger sites. |
| Upload session lifetime | 1 hour | Upload sessions expire after this time |
| File path length | 1,024 characters | Paths may not be absolute, contain `..`, or appear twice in one deploy |
| Pre-compression | Text files up to 5 MiB each, 100 MiB total | Larger files are still deployed, just not pre-compressed |

See [static sites](/deploying/static-sites) for how deploys are uploaded.

### Redirects, headers and `skiff.json`

| Limit | Value |
|---|---|
| Rules in `_redirects` | 1,000 |
| Path rules in `_headers` | 500 |
| `notFound` path in `skiff.json` | Up to 1,024 characters, must start with `/`, may not contain `..` |
| Statuses allowed in `_redirects` | 200, 301, 302, 303, 307, 308, 404, 410, 451 (default 301) |

See [site configuration](/deploying/site-config) for the file formats.

### Projects

| Limit | Value |
|---|---|
| Project slug | 3 to 40 characters. Lowercase letters, digits and single hyphens. It must start and end with a letter or digit and may not contain `--`. Reserved names such as `api`, `admin` and `status` are refused. |
| Project name | 1 to 120 characters |
| Placement | 1 to 64 characters |

### Functions and workloads

| Limit | Value |
|---|---|
| Modules in one function | 512 |
| Bindings in one function | 64 |
| Compatibility flags | 32, each up to 64 characters |
| Cron triggers | 8 |
| Queue consumers | 8 |
| Replicas per workload | 1 to 20 |
| Process idle stop | Up to 86,400 seconds (one day) |

See [functions](/compute/functions) and [apps and containers](/compute/apps-and-containers).

### Storage, email and databases

| Limit | Value | Notes |
|---|---|---|
| Single object upload through the control plane | 100 MiB by default | Set with `SKIFF_STORAGE_OBJECT_MAX_BYTES` |
| Share link expiry | 60 seconds to 7 days, default 1 hour | |
| Recipients per email (to, cc and bcc combined) | 50 | |
| Email message size | 10 MiB | |
| Inbound email size | 25 MiB | |
| Email tags per message | 10 | |
| Messages per email batch | 100 | |
| Client connections through the database pooler | 200 | |
| Database console session | 5 to 480 minutes, default 60 | Idle timeout 5 to 240 minutes, default 15 |

See [object storage](/data/object-storage), [email](/data/email) and [databases](/data/databases).

### Logs

| Limit | Value |
|---|---|
| Lines returned per log query | 2,000 maximum, 200 by default |

See [dashboards and logs](/observe/dashboards-and-logs).
