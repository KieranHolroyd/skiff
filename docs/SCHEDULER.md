# Durable scheduler

Status: **implemented, 2026-11-05** as foundation F4. This is the generic primitive feature plans
01 (database backups), 09 (jobs), 12 (preview teardown) and 06 (upgrade tasks) consume; it has no
feature-specific logic.

The scheduler lives entirely in SQLite (`scheduled_tasks`) and is driven by the existing 60-second
`MaintenanceService.run()` sweep. There is no separate daemon or in-memory timer, so restarts and a
brief second control plane are safe.

## Model

| Column | Meaning |
|---|---|
| `id` | `task_<uuid hex>`. |
| `kind`, `key` | Who owns the task and its idempotency key. `(kind, key)` is unique. |
| `run_at` | Epoch ms; the task is claimable once this is due. |
| `lease_until` | Epoch ms. A lease makes the task invisible to other workers until it expires. |
| `attempts`, `max_attempts` | Claims so far and the hard retry cap (default 5). |
| `payload_json` | Opaque input for the consumer. |
| `status` | `queued`, `leased`, `ok`, `failed`, `cancelled`. |
| `result_json`, `last_error` | Outcome of the last attempt. |
| `created_at`, `updated_at` | Epoch ms. |

Indexes: unique `(kind, key)` for idempotency, `(status, run_at)` for due claims and
`(status, lease_until)` for lease expiry.

## API (`packages/core/src/scheduler.ts`)

- `enqueue({ kind, key, runAt, payload, maxAttempts }) -> id`
  Active tasks (`queued`/`leased`) are never duplicated. Enqueueing a terminal key (`ok`, `failed`,
  `cancelled`) re-arms that same row as a fresh occurrence with `attempts = 0`; this lets a
  recurring producer keep a stable key.
- `claim(workerId, limit, now?, leaseMs?) -> ClaimedTask[]`
  One atomic `UPDATE ... RETURNING` leases due tasks, ordered by `run_at`. It increments `attempts`
  before the work starts. The default lease is five minutes.
- `complete(id, resultJson?)`, `fail(id, error, retryAt?)`, `cancel(id)`
  Terminal transitions are guarded by status. A failed attempt is retried with exponential backoff
  (30 s, 60 s, 120 s, … capped at one hour); at `maxAttempts` it becomes `failed`.
- `tick(now?)`
  Expires leases past `lease_until`: requeues below the attempt cap, fails at the cap. Idempotent.
  `MaintenanceService.run()` calls it on every sweep.
- `nextRun(expression, from?)` / the standalone `nextRun` helper
  Wrap the shared five-field UTC cron parser (`cron.ts`) so producers can compute `runAt`. A
  schedule that can never fire (for example 31 February) returns `null`; the producer should reject
  or disable it.

## Consuming it

A feature registers a `kind`, builds a stable key, and polls its own tasks. For example, backups
would use `kind: "database.backup"` and `key: <database id>`; preview teardown would use
`kind: "preview.teardown"` and `key: <deployment id>`. The worker maps `payloadJson` to its input,
does the work, then calls `complete` or `fail`. If it crashes, `tick` makes the task claimable
again without any feature-specific recovery code.

Backups keep their existing `next_backup_at` sweep in this change. Migrating them onto
`scheduled_tasks` is left to plan 01 so this foundation stays behaviour-preserving.
