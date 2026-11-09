---
title: Prometheus metrics
description: Scrape Yoal's /metrics endpoints with Prometheus or Grafana, choose what is exported, and read node stats in the dashboard.
---

Yoal exposes its state as Prometheus text, so you can chart apps, databases, queue brokers and nodes in Grafana or alert on them in your own Prometheus. Yoal does not push metrics anywhere. Point Prometheus, Grafana Alloy or Grafana Agent at the control plane and it pulls what you ask for. The control plane answers scrapes for the organisation that owns the API key, and each node agent serves its own counters on a local socket.

## Endpoints on the control plane

`GET /metrics` on the control plane returns a different body depending on who asks:

| Request | Result |
|---|---|
| `GET /metrics` with no credentials | The fleet summary: node, disk and platform-wide counts. Returns `401` when **Settings → Metrics → Public fleet summary** is off. |
| `GET /metrics` with `Authorization: Bearer yoal_…` | Every enabled section for the key's organisation, limited to the resources the key can read. Needs `metrics:read`. |
| `GET /metrics/<section>` or `GET /metrics/<section>/<name>` | One section, or one app, database, storage instance or broker. Always needs a key or a dashboard session. |
| A bearer header that does not resolve | `401`. Yoal never falls back to the public view. |

The same paths also work under `/api/v1/metrics/…`. Each section needs the permission in the last column on top of `metrics:read`. Without it, the section is left out of `/metrics` and its own path is refused.

| Path | Contents | Also needs |
|---|---|---|
| `/metrics/usage` | Quota usage and limits for the organisation | `project:read` |
| `/metrics/apps`, `/metrics/apps/<slug>` | App state, deployments, builds, domains, workloads, and each app's traffic and volumes. `/metrics/projects/…` is an alias. | `project:read` |
| `/metrics/traffic`, `/metrics/traffic/<slug>` | Last-hour traffic per app only | `project:read` |
| `/metrics/volumes`, `/metrics/volumes/<slug>` | App volumes | `project:read` |
| `/metrics/databases`, `/metrics/databases/<name>` | Managed databases | `database:read` |
| `/metrics/storage`, `/metrics/storage/<name>` | Object storage instances | `storage:read` |
| `/metrics/brokers`, `/metrics/brokers/<name>` | Queue brokers, with one series per stream | `broker:read` |
| `/metrics/platform` | Nodes and disks | A platform admin's dashboard session. API keys do not carry platform scope. |

`/metrics` with a key does not include `/metrics/platform`. Scrape that path separately with a platform admin session, or use the public fleet summary if it suits you.

## Scrape config

Create an API key with `metrics:read` (and `project:read`, `database:read` and so on for the sections you want). See [API keys and tokens](/accounts/api-keys-and-tokens). Then add a job to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: yoal-usage
    scheme: https
    metrics_path: /metrics/usage
    scrape_interval: 5m
    authorization:
      credentials: yoal_…
    static_configs:
      - targets: ['control.example.com']

  - job_name: yoal-shop
    scheme: https
    metrics_path: /metrics/apps/shop
    scrape_interval: 30s
    authorization:
      credentials: yoal_…
    static_configs:
      - targets: ['control.example.com']
```

With hundreds of apps, give each dashboard its own job on the narrowest path it needs, as above, rather than scraping `/metrics` for everything. Renders are cached on the control plane for 15 seconds by default, so several Prometheus replicas share one render.

## Metric reference

Every control-plane series is a gauge. Traffic and database activity are rolling one-hour totals (`*_1h`), not monotonic counters, so chart them directly rather than through `rate()`. The series below are the main ones. Labels are shown where they matter for queries.

### Organisation and quotas

| Metric | Type | Meaning |
|---|---|---|
| `yoal_quota_used{metric,unit}` | gauge | Current usage per quota metric. Egress is a 30-day sum. |
| `yoal_quota_limit{metric,unit}` | gauge | The limit for a quota metric. Absent when unlimited. |
| `yoal_quota_used_ratio{metric}` | gauge | Usage as a share of the limit, from 0 upwards. |

### Apps

Apps carry a `project` label holding the app's slug.

| Metric | Type | Meaning |
|---|---|---|
| `yoal_project_info{project,name,runtime,placement}` | gauge | One series per app, always 1. |
| `yoal_project_deployments{project,status}` | gauge | Deployments per status, deleted ones excluded. |
| `yoal_project_builds_24h{project,status}` | gauge | Git builds started in the last 24 hours. |
| `yoal_project_workload_up{project,runtime}` | gauge | 1 while the app's process or container is running. |
| `yoal_project_domains{project,status}` | gauge | Custom domains per status. |
| `yoal_project_http_requests_1h{project,status_class}` | gauge | Requests in the last hour, split into `2xx` to `5xx`. Needs the telemetry store. |
| `yoal_project_http_duration_p95_ms_1h{project}` | gauge | Request-weighted p95 latency over the last hour, in milliseconds. Needs the telemetry store. |
| `yoal_project_volume_used_bytes{project,volume}` | gauge | Bytes used on an app volume, from the last node sample. |

### Databases

| Metric | Type | Meaning |
|---|---|---|
| `yoal_database_up{database,database_id}` | gauge | 1 when the database answered its last sample. |
| `yoal_database_connections` | gauge | Open connections. |
| `yoal_database_pool_saturation` | gauge | Share of PgBouncer's `max_client_conn` in use, from 0 to 1. |
| `yoal_database_size_bytes` | gauge | Database size on disk. |
| `yoal_database_transactions_1h{result}` | gauge | Commits and rollbacks in the last hour. |
| `yoal_database_deadlocks_1h` | gauge | Deadlocks in the last hour. |

### Object storage

| Metric | Type | Meaning |
|---|---|---|
| `yoal_storage_used_bytes{storage,storage_id}` | gauge | Bytes stored across buckets. |
| `yoal_storage_objects` | gauge | Objects stored across buckets. |
| `yoal_storage_up` | gauge | 1 when the instance answered its last sample. |

### Queue brokers

| Metric | Type | Meaning |
|---|---|---|
| `yoal_broker_up{broker,broker_id}` | gauge | 1 when the broker answered its last sample. |
| `yoal_broker_messages` | gauge | Messages held across streams. |
| `yoal_broker_pending` | gauge | Messages not yet delivered, summed over consumers. |
| `yoal_broker_ack_pending` | gauge | Delivered messages waiting for an ack. |
| `yoal_broker_oldest_message_age_seconds` | gauge | Age of the oldest message held in any stream. |
| `yoal_broker_stream_messages{broker,stream,queue}` | gauge | Messages held in one stream, from the newest listing. There is a matching family for bytes, consumers, pending, ack-pending and redelivered. |

### Nodes and disks

These appear on `/metrics/platform`, and in the public fleet summary when it is on.

| Metric | Type | Meaning |
|---|---|---|
| `yoal_nodes_total`, `yoal_nodes_online` | gauge | Nodes known to the control plane, and nodes currently online. |
| `yoal_node_up{node,mode}` | gauge | 1 while the node is online. |
| `yoal_node_cpu_percent{node}` | gauge | Host CPU use, in percent. |
| `yoal_node_memory_used_bytes{node}` | gauge | Host memory in use. |
| `yoal_node_disk_free_bytes{node}` | gauge | Free bytes on the data filesystem. |
| `yoal_node_last_heartbeat_timestamp_seconds{node}` | gauge | When the node last sent a heartbeat. |
| `yoal_node_cert_expiry_timestamp_seconds{node,host}` | gauge | When a TLS certificate served by the node expires. |
| `yoal_volume_up{node,volume,kind,tier}` | gauge | 1 while a [disk](/self-hosting/nodes-and-fleet#disks) is mounted and ready. `volume` is the disk's name and `tier` is `fast` or `bulk`. |
| `yoal_volume_size_bytes{node,volume,kind,tier}` | gauge | A disk's size. |
| `yoal_volume_free_bytes{node,volume,kind,tier}` | gauge | Free space on a disk. |

### Scrape health

| Metric | Type | Meaning |
|---|---|---|
| `yoal_scrape_duration_seconds` | gauge | Time the control plane spent rendering the scrape. |
| `yoal_telemetry_up` | gauge | 0 when the telemetry store is not installed or not reachable. Traffic and live samples are then absent. |
| `yoal_scrape_truncated{section="apps"}` | gauge | 1 when an aggregate scrape left apps out because of **Max apps per scrape**. |

## Node agents

Each node's agent also serves a `/metrics` endpoint, but on its local Unix socket (`/run/yoal-agent/agent.sock` by default), not on the network. The control plane does not proxy it, so scrape it from the node itself, for example with a Grafana Alloy or Prometheus instance running on that machine:

```sh
curl --unix-socket /run/yoal-agent/agent.sock http://localhost/metrics
```

The agent exposes these series. The `_total` ones are counters; the rest are gauges.

| Metric | Type | Meaning |
|---|---|---|
| `yoal_agent_build_info{version}` | gauge | Agent build version, always 1. |
| `yoal_agent_caddy_up` | gauge | 1 when the Caddy admin API is reachable. |
| `yoal_agent_routes` | gauge | Routes in the current desired state. |
| `yoal_agent_releases` | gauge | Verified releases on disk. |
| `yoal_agent_workloads_total`, `yoal_agent_workloads_running` | gauge | Workloads reported by this node, and how many are running. |
| `yoal_agent_desired_state_version`, `yoal_agent_actual_state_version` | gauge | The desired state the agent last pulled, and the version it has converged to. |
| `yoal_agent_reconcile_failures_total` | counter | Desired-state pulls or converges that failed. |
| `yoal_agent_heartbeat_failures_total` | counter | Heartbeats that could not be delivered. |
| `yoal_agent_telemetry_batches_sent_total` | counter | Telemetry batches delivered to the control plane. |
| `yoal_agent_telemetry_flush_failures_total` | counter | Telemetry batches that could not be delivered. |

## Settings → Metrics

**Settings → Metrics** is owner-only. Changes are stored in the database and apply to the next scrape, with no restart.

| Setting | Default | Effect |
|---|---|---|
| Public fleet summary | On | Allows an unauthenticated `GET /metrics`. Turn it off, or restrict the path at your reverse proxy, if the platform origin is publicly reachable. |
| Sections | All on | A disabled section is left out of `/metrics`, and its own path returns `404`. App traffic is the most expensive, because it reads ClickHouse. |
| Cache (seconds) | 15 | Reuses a rendered scrape per organisation, path and permission set. Accepts 0 to 300. `0` turns caching off. |
| Max apps per scrape | 500 | Caps `/metrics` and `/metrics/apps`, taken alphabetically by slug. Accepts 1 to 10,000. Per-app paths are never capped. |

The app traffic section and the database, storage and broker series read from the telemetry store. If it is not installed, those series are absent and `yoal_telemetry_up` is 0. Install it under **Settings → Telemetry**.

## Node stats in the dashboard

Each node reports CPU, memory, disk, load and uptime in its heartbeat, about every 10 seconds. On Linux the agent reads these from `/proc` and the data filesystem. The **Nodes** page and the **Overview** page show them as CPU, Memory and Disk meters with a bar, plus uptime and load. These are the same figures the platform section exports as `yoal_node_*` series, so you do not need a scrape to see them. Check [nodes and the fleet](/self-hosting/nodes-and-fleet) for how node status is determined.
