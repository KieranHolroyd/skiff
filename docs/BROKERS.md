# Skiff — Managed queue brokers

Status: **implemented, 2026-11-07** (not yet exercised on a real Debian/Podman node; the unit,
config, validation, probe and control-plane flow are covered by unit tests; the metrics sampler
was checked against a real `nats:2.12-alpine`). The decisions are D111, D123 (metrics) and the
queue-tools D124 (node tasks, §5.1) in
[DECISIONS.md](./DECISIONS.md).

A managed broker is an org-owned message broker that Skiff provisions, runs and connects to apps:
background jobs, events and fan-out without hand-rolling a container. **NATS with JetStream** is
the first engine; RabbitMQ is the next registry entry. A broker is not a project and not a
database: it has its own table, permissions (`broker:*`) and surfaces, and reuses the managed-
database node pipeline (DATABASES §2) so the trust model is the same.

Everything goes through `packages/core` (`BrokerService`); REST, MCP, CLI and the dashboard
(**Queues** in the sidebar) are thin surfaces.

---

## 1. Model

| Table | Purpose |
|---|---|
| `brokers` | One row per broker: org, name, engine/version, resolved node, host port, memory/CPU, message-store cap, optional node volume, status, sealed owner password, restart generation, soft-delete columns. |
| `broker_attachments` | Broker ↔ project, with the env prefix the project receives (`NATS` → `NATS_URL`). |
| `broker_log_events` | Runtime and lifecycle log lines. `service_log_events.kind` has a storage/database CHECK (0017), so brokers get a table of the same shape. |

- **Names** follow slug rules (3–40, `[a-z0-9-]`, no `--`), unique per org. The client user is the
  name with `-` → `_`.
- **Ids** are `mq_<32 hex>`; the id doubles as the workload id on the node.
- **Engines** are a registry (`packages/contracts/src/broker.ts`); `brokers.engine` has no CHECK,
  so a new engine never needs a migration (the lesson of 0028).
- **Status** uses the workload vocabulary and is driven by heartbeats; five restarts mark it failed.

| Engine | Versions (default) | Image | Port | Default prefix | URL |
|---|---|---|---|---|---|
| NATS | 2.12, 2.11 (2.12) | `nats:<v>-alpine` | 4222 | `NATS` | `nats://user:pass@host:4222` |

Defaults: 256 MB memory (minimum 64), 0.5 vCPU, 2 GB message store. Versions only move forward in
place (`PATCH { version }`); a downgrade is refused.

## 2. Runtime (helper `broker` profile)

The control plane sends a broker to its node as a container `WorkloadDesired` with
`broker: { engine, version, storageMb }`. The helper keeps its **own** registry (as D61) and never
takes an image, user, mount or config from the wire:

- Image from engine + version; `Exec=nats-server --config /etc/skiff/broker.conf`.
- `User=4222:4222` (NATS is a static binary, so the uid is the helper's choice); the data dir and
  config are chowned to it. `DropCapability=all`, `NoNewPrivileges`, `ReadOnly=true`, `/tmp` tmpfs.
- `PublishPort=127.0.0.1:<hostPort>:4222` only (host ports 14222–14721), org network alias
  `mq-<hex>`. Nothing listens on a public or WireGuard address.
- `MemoryMax`, `CPUQuota`, `Slice=skiff-workloads.slice`; brokers count toward node admission (D42)
  and the org memory quota.
- **Config.** The activation carries `SKIFF_BROKER_USER`/`SKIFF_BROKER_PASSWORD`; the helper takes
  them out of the container env and writes a 0600 `broker.conf` beside the env file: one ACL user
  (no anonymous access), JetStream with `store_dir: /data`, `max_memory_store` at 25% of
  `MemoryMax` and `max_file_store` at the broker's store cap, so a full broker refuses publishes
  instead of filling the disk or being OOM-killed. Values are validated before they reach the file.
- **Env.** Only `GOMEMLIMIT` (80% of `MemoryMax`), so Go collects before the cgroup kills it.
- Data under `<stateDir>/<id>`, or `<volume>/skiff/<id>` with a node volume (D74, D76). `purge`
  accepts `mq_` ids and removes only that directory.

**Health.** A NATS server greets every connection with `INFO {…}`; Podman's forwarder accepts the
connect but never speaks. The agent's TCP probe waits for that greeting; no credentials are sent.

**Capability gate.** An agent that predates brokers would hand the helper a plain container
without the profile. Agents advertise `brokers` in their heartbeat; placement only considers those
nodes, and naming an older node explicitly is refused with "update its agent first".

## 3. Connecting apps

`attach` links a broker to a process, container or function project (`static` is refused; functions
use it for queues, §6).
At activation the app receives `<P>_URL`, `<P>_HOST`, `<P>_PORT`, `<P>_USER`, `<P>_PASSWORD`
(default `P` = `NATS`; most NATS clients read `NATS_URL`).

- Process app on the broker's node → `127.0.0.1:<hostPort>`.
- Container app on the broker's node → `mq-<hex>:4222` on the org network.
- **Same node only.** An attached broker pins the project's placement (D56), even when C2 service
  endpoints let a process app float away from its databases. A project's brokers, databases and
  private storage must share a node.
- Values are injected at activation only (D18, D43); attach, detach, a restart or a version change
  re-activates the app.

## 4. Lifecycle

| Action | What happens |
|---|---|
| Create | Placement and admission once; port allocated; password sealed; optional attach. |
| Update | Memory (admission + quota), CPU, store cap, forward-only version. The unit re-renders and restarts; JetStream data is kept. |
| Restart | Bumps the restart generation; a breadcrumb lands in the broker log. |
| Delete | Refused while attached. The container stops; the data stays for the trash period (D59). |
| Restore | Re-checks admission and the volume; refused once a purge was requested. |
| Purge | Immediately or when the trash expires (maintenance sweep): `brokerPurges` → the helper deletes the data → `purgedBrokers` in the heartbeat → rows and logs go. |

## 5. Surfaces

- **REST:** see [API.md](./API.md#managed-queue-brokers).
- **MCP:** `list_brokers`, `get_broker`, `get_broker_logs`, `get_broker_metrics`,
  `get_broker_queues`, `create_broker`, `update_broker`, `restart_broker`, `attach_broker`,
  `detach_broker`, and the queue tools `create_queue`, `send_queue_message`,
  `peek_queue_messages`, `redrive_queue` and `get_node_task` (§5.1). Credentials, delete and
  purge, and the stream purge/delete tools, are not on MCP; agents never receive the password
  (D58). The dashboard assistant asks before `send_queue_message` and `redrive_queue`.
- **CLI:** `skif broker list|create|info|update|attach|detach|restart|delete|restore|purge|logs|credentials|metrics|queues`
  and the queue tools `queue-create|send|peek|redrive|queue-purge|queue-rm|message-rm`
  (aliases `skif brokers`, `skif queue`).
- **Dashboard:** Queues list (live + trash, create dialog), detail (connection with audited
  reveal and client snippets, resources, attachments, version upgrade, danger zone), Queues
  (streams and consumers, §7, with New queue, Send message and a per-stream menu: peek, send,
  move messages, purge, delete), Metrics (charts, §7) and logs.

### 5.1 Queue tools (D124)

The control plane cannot reach a broker, so these run as **node tasks**: the control plane queues
a typed task, the broker's node agent leases it, runs it over the broker's own client connection
(as the D123 sampler does) and posts the result back. A call waits up to 20 s; a slower node
answers `202` with a task to poll (`GET /api/v1/node-tasks/:id`).

| Tool | What it does | Permission |
|---|---|---|
| Create queue | Creates `SKIFF_Q_<queue>` with the function-queue settings (§6) now instead of on first use. | `broker:update` |
| Send message | Publishes a body (`json` or `text`) to `skiff.q.<queue>` as a queue binding would, with an optional delay and up to 100 copies. The task id is the `Nats-Msg-Id`, so a retried lease does not double it. | `broker:update` |
| Peek | Reads up to 50 messages from any stream by sequence (`STREAM.MSG.GET`), without consuming them; bodies over 16 KiB are cut and binary bodies come back as base64. | `broker:update` |
| Redrive | Moves up to 1,000 messages from a queue (usually a dead-letter queue) into another: body, id and content type are kept, the attempt count starts again, then the message is deleted from the source. | `broker:update` |
| Purge | Removes every message; the stream and its consumers stay. | `broker:delete` |
| Delete stream | Removes the stream and its consumers. A function queue's stream comes back on next use. | `broker:delete` |
| Delete message | Removes one message by sequence. | `broker:delete` |

Peek counts as an operator action, not a read, because message bodies are application data.
After a change the stream's new totals are written into the stored listing, so the Queues tab
does not wait for the next minute's sample. Only agents that advertise `node-tasks` get tasks;
on an older agent the dashboard says to update the node.
- **Flag:** `SKIFF_FEATURE_BROKERS` (default on). Off hides the nav entry and refuses new brokers
  and restores; existing brokers keep running.

## 6. Function queues (D112)

Functions use brokers for Cloudflare-style queues ([FUNCTIONS.md §4.10](./FUNCTIONS.md)). Attach the
broker to the function project (`skif broker attach jobs --project my-fn`), declare producers and
consumers in `wrangler.jsonc` as on Cloudflare, and name the broker per queue when the project has
more than one:

```jsonc
{
  "queues": {
    "producers": [{ "binding": "JOBS", "queue": "jobs" }],
    "consumers": [{ "queue": "jobs", "max_batch_size": 20, "max_retries": 5, "dead_letter_queue": "jobs-dlq" }]
  },
  "skiff": { "brokers": { "jobs": "events", "jobs-dlq": "events" } }
}
```

- Each queue is a JetStream stream `SKIFF_Q_<queue>` on the broker (subject `skiff.q.<queue>`,
  work-queue retention, file store, 128 KiB messages) with one durable pull consumer
  `skiff-consumer`. Any app attached to the broker can publish to `skiff.q.<queue>` with a NATS
  client too; set `Skiff-Content-Type: json|text` so the consumer decodes the body.
- A queue has one consumer per broker; a second deploy that consumes it is refused (409).
- Streams are created on first use and stay until removed with `nats stream rm` (Skiff does not
  delete them when a function goes away).
- Event rules (D122, [EVENTS.md](./EVENTS.md)) publish platform events into a broker's queues; the
  broker's node agent does the publishing, with the broker's own credentials.

## 7. Metrics (D123)

Once a minute the agent on a broker's node samples it **over the broker's own client
connection**, with the user and password from the broker's activation. It reads:

| Call | Gives |
|---|---|
| `$JS.API.INFO` | JetStream file and memory store in use, stream and consumer counts |
| `$JS.API.STREAM.LIST` (pages of 256, up to 1,024 streams) | per stream: messages, bytes, first/last sequence and time, consumer count |
| `$JS.API.CONSUMER.LIST.<stream>` (first 200 streams) | per consumer: pending, awaiting ack, redelivered, waiting pulls, last delivery |
| `$SYS.REQ.ACCOUNT.PING.STATZ` | the account's connections, messages and bytes in and out, slow consumers |

NATS exports STATZ to every account, so no system user is needed. Nothing new listens on the
node. The HTTP monitor port (`/varz`, `/jsz`, `/connz`) is unauthenticated: on node loopback,
any tenant's process app could read it. Checked against `nats:2.12-alpine` with the helper's
config.

**The sample** (`brokerMetricBucketSchema`) rides the telemetry batch:

- Gauges: `up`, connections (the sampler's own is not counted), streams, consumers, store used,
  store budget (`storageMb`), memory store used, messages held, pending, awaiting ack,
  redelivered, container memory, and **oldest message age**.
- Per-minute deltas: messages JetStream stored (`published`, from stream sequences), messages and
  bytes in and out of the server (STATZ, minus the sampler's own request/reply pairs), and slow
  consumers. The first sample after an agent start reads 0. A restarted server resets its
  counters, and the delta starts again from there.
- Oldest message age counts only work-queue and interest streams that have a consumer. A held
  message there is unprocessed by definition. A limits stream keeps messages on purpose, and a
  dead-letter queue nobody consumes is parked, not lagging.
- A broker that is not running, or does not answer, reports `up: false` with zeros. Its last good
  totals stay in place.

**Where it lands.** The control plane drops samples for brokers not placed on the sending node.

- ClickHouse (when installed): `broker_metrics_1m` / `_1h` with the hourly rollup, prune and a
  `broker_metrics_hourly` view, like databases and storage. Hourly points take the max of
  sizes and backlog, average `up` and connections, and sum the deltas.
- SQLite (always): `brokers.store_bytes`, `messages`, `stats_at` and the newest **stream
  listing** (`queue_stats`, at most 200 streams with 20 consumers each; `queue_stats_truncated`
  flags a cut), migration 0051.

**Surfaces.**

- `GET /api/v1/brokers/:name/metrics?from&to&interval`: the series, as for databases.
  `GET /api/v1/brokers/:name/queues`: the newest listing. Both need `broker:read`.
- Dashboard: **Queues** tab (streams, function-queue names, consumers and backlog, plus the §5.1
  actions: new queue, send, peek, move messages, purge, delete stream and delete message) and
  **Metrics** tab (store vs budget, backlog, throughput, connections, memory, oldest message).
  The list and overview show store used against the budget.
- `/metrics/brokers[/<name>]` ([METRICS.md](./METRICS.md)): configuration and SQLite totals
  always, live gauges and last-hour rates from ClickHouse, and one series family per stream.
- The `brokers` query-builder dataset, for dashboards and alert rules. It adds a derived
  `store_utilization`. Alert templates: **Queue broker down**, **store nearly full** (> 85%)
  and **backlog not draining** (oldest message > 15 min for 10 min).
- Built-in system alert `broker_store` (Alerts → System alerts). It reads the SQLite totals, so
  it needs no ClickHouse. Its threshold is the `brokerStoreAlertPercent` policy (default 85%,
  critical at 95%). A full store refuses publishes (`discard: new`).

## 8. Not yet

- RabbitMQ engine (registry entry, helper profile, AMQP greeting probe, management UI off).
- Per-stream time series (today only the newest listing is kept per stream).
- Per-attachment users with subject permissions (today every attached app shares the broker's
  one user), TLS, cross-node endpoints (C2), stream snapshots as backups, moves (D97), bulk actions
  and prune, and an attach panel on the project page.
