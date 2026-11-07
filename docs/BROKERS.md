# Skiff — Managed queue brokers

Status: **implemented, 2026-11-07** (not yet exercised on a real Debian/Podman node; the unit,
config, validation, probe and control-plane flow are covered by unit tests). The decision is D111
in [DECISIONS.md](./DECISIONS.md).

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
- **MCP:** `list_brokers`, `get_broker`, `get_broker_logs`, `create_broker`, `update_broker`,
  `restart_broker`, `attach_broker`, `detach_broker`. Credentials, delete and purge are not on MCP;
  agents never receive the password (D58).
- **CLI:** `skif broker list|create|info|update|attach|detach|restart|delete|restore|purge|logs|credentials`
  (aliases `skif brokers`, `skif queue`).
- **Dashboard:** Queues list (live + trash, create dialog), detail (connection with audited
  reveal and client snippets, resources, attachments, version upgrade, danger zone) and logs.
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

## 7. Not yet

- RabbitMQ engine (registry entry, helper profile, AMQP greeting probe, management UI off).
- Metrics: a loopback monitor port sampled by the agent (`/varz`, `/jsz`) into ClickHouse, a
  store-full alert, and stream/consumer listing in the dashboard.
- Per-attachment users with subject permissions (today every attached app shares the broker's
  one user), TLS, cross-node endpoints (C2), stream snapshots as backups, moves (D97), bulk actions
  and prune, and an attach panel on the project page.
