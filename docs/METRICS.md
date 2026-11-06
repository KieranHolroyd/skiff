# Prometheus metrics (`/metrics`)

Skiff exports Prometheus text so you can chart your own usage in Grafana (D16, D104). There is
no scraper to run on the Skiff side: point Prometheus, Grafana Alloy or Grafana Agent at the
control plane.

## Who sees what

| Request | Result |
|---|---|
| `GET /metrics`, no credentials | Fleet summary: node, node-volume and platform-wide traffic counts. Off when Settings → Metrics → *Public fleet summary* is off (then 401). |
| `GET /metrics` with `Authorization: Bearer skif_…` (or a dashboard session) | Every enabled section for **the key's organisation only**. Needs `metrics:read`; sections the key cannot read (`project:read`, `database:read`, `storage:read`) are left out. |
| `GET /metrics/<section>[/<name>]` | One section, or one app / database / storage instance. Always needs a key. |
| An `Authorization` header that does not resolve | 401, never the public view. |

The same paths work under `/api/v1/metrics/...`.

| Path | Contents | Permission |
|---|---|---|
| `/metrics/usage` | Quota usage and limits | `project:read` |
| `/metrics/apps`, `/metrics/apps/<slug>` | Per-app state, plus that app's traffic and volumes. `/metrics/projects/...` is an alias | `project:read` |
| `/metrics/traffic[/<slug>]` | Last-hour traffic per app only | `project:read` |
| `/metrics/databases[/<name>]` | Managed databases | `database:read` |
| `/metrics/storage[/<name>]` | Object storage instances | `storage:read` |
| `/metrics/volumes[/<slug>]` | App volumes | `project:read` |
| `/metrics/platform` | Nodes and node volumes | platform admin |

With hundreds of apps, give each Grafana dashboard its own scrape job on the narrowest path it
needs. For example, scrape `/metrics/usage` every 5 minutes and `/metrics/apps/shop` every 30
seconds.

## Prometheus config

```yaml
scrape_configs:
  - job_name: skiff-apps
    scheme: https
    metrics_path: /metrics/apps
    scrape_interval: 60s
    authorization:
      credentials: skif_...   # Settings → API keys, scope metrics:read (+ project:read)
    static_configs:
      - targets: ['control.example.com']
```

Then add Prometheus as a data source in Grafana.

## Metric reference

Every series is a gauge. Traffic and database activity are **rolling last-hour windows**
(`*_1h`), not monotonic counters, so chart them directly rather than through `rate()`. The
telemetry store's TTL would make a running total go backwards.

**Org** (`/metrics`, `/metrics/usage`)

- `skiff_quota_used{metric,unit}`, `skiff_quota_limit{metric,unit}` (absent when unlimited),
  `skiff_quota_used_ratio{metric}`. `metric` is a quota key from docs/QUOTAS.md. `egressBytes` is
  a 30-day sum.

**Apps** (label `project` = slug)

- `skiff_project_info{project,name,runtime,placement}`, `skiff_project_created_timestamp_seconds`
- `skiff_project_deployments{status}`, `skiff_project_last_deploy_timestamp_seconds`,
  `skiff_project_release_bytes`
- `skiff_project_builds_24h{status}`, `skiff_project_build_duration_seconds_avg_24h{status}`
- `skiff_project_workload_up{runtime}`, `skiff_project_workload_memory_limit_bytes`,
  `skiff_project_workload_cpu_limit`
- `skiff_project_domains{status}`
- Traffic (needs the telemetry store): `skiff_project_http_requests_1h{status_class}`,
  `skiff_project_http_response_bytes_1h`, `skiff_project_http_duration_p50_ms_1h`,
  `skiff_project_http_duration_p95_ms_1h`
- Volumes: `skiff_project_volume_ready{volume}`, `skiff_project_volume_size_bytes`,
  `skiff_project_volume_used_bytes`

**Databases** (labels `database`, `database_id`)

- `skiff_database_info{engine,version}`, `skiff_database_running`,
  `skiff_database_{memory_limit_bytes,cpu_limit,storage_limit_bytes}`, `skiff_database_size_bytes`
- Latest sample: `skiff_database_up`, `_connections`, `_max_connections`, `_memory_bytes`,
  `_pooler_up`, `_pool_active`, `_pool_idle`, `_pool_waiting`, `_pool_saturation`,
  `_pool_avg_wait_ms`
- Last hour: `skiff_database_transactions_1h{result}`, `skiff_database_tuples_1h{op}`,
  `skiff_database_blocks_1h{source}`, `skiff_database_deadlocks_1h`, `skiff_database_temp_bytes_1h`

**Object storage** (labels `storage`, `storage_id`)

- `skiff_storage_info{engine,version,public}`, `skiff_storage_running`,
  `skiff_storage_{memory_limit_bytes,storage_limit_bytes}`, `skiff_storage_used_bytes`,
  `skiff_storage_objects`, `skiff_storage_up`, `skiff_storage_buckets`, `skiff_storage_memory_bytes`

**Fleet** (public `/metrics`, `/metrics/platform`)

- `skiff_nodes_total`, `skiff_nodes_online`, `skiff_projects_total`, `skiff_deployments_active`,
  `skiff_storage_bytes`, `skiff_agent_desired_version_info{version}`
- `skiff_node_up{node,mode}`, `skiff_node_info{status,agent_version}`,
  `skiff_node_last_heartbeat_timestamp_seconds`, `skiff_node_cpu_percent`, `skiff_node_load1`,
  `skiff_node_memory_{used,total}_bytes`, `skiff_node_disk_{used,total,free}_bytes`,
  `skiff_node_uptime_seconds`, `skiff_node_cert_expiry_timestamp_seconds{host}`
- `skiff_volume_up{node,volume,kind}`, `skiff_volume_size_bytes`, `skiff_volume_free_bytes` (D80)
- Public `/metrics` only: `skiff_http_requests_total{host}`, `skiff_http_errors_total`,
  `skiff_bytes_total` (last hour), and `skiff_database_*` / `skiff_storage_*` keyed by id.

**Scrape meta**: `skiff_scrape_duration_seconds`, `skiff_telemetry_up` (0 when ClickHouse is not
installed or not reachable; traffic and live samples are then absent),
`skiff_scrape_truncated{section="apps"}`.

## Settings → Metrics (owner)

Stored in the `settings` table (`metrics_export`). A change applies to the next scrape, with no
restart.

| Setting | Default | Effect |
|---|---|---|
| Public fleet summary | on | Unauthenticated `GET /metrics`. Turn it off, or restrict the path in Caddy, if the platform origin is public. |
| Sections | all on | A disabled section is skipped in `/metrics` and 404s on its own path. Traffic is the costliest because it reads ClickHouse. |
| Cache | 15 s | Rendered scrapes are reused per org, path and permission set. Concurrent scrapes share one render. 0 turns caching off. |
| Max apps per scrape | 500 | Caps `/metrics` and `/metrics/apps` (alphabetical by slug). `skiff_scrape_truncated` reports a cut. Per-app paths are never capped. |

## Cost

A scrape runs a fixed set of grouped SQLite queries for each section: one per kind of resource,
batched over every app in scope. It also runs at most four ClickHouse queries, filtered to the
ids in scope. Cost therefore grows with the number of series written, not with the number of
queries. Code: `packages/core/src/metrics-export.ts`, `TelemetryStore.scrapeSamples`.
