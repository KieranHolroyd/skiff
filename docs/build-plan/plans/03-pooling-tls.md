# 03 — Connection pooling, TLS, and connection UX

**Priority:** P0 · **Effort:** S–M · **Lane:** C · **Wave:** 1
**Depends on:** F1 contracts, F3 e2e
**Blocks:** 10 private networking, 12 preview data, 20 agent tools
**Primary files:** `packages/contracts/src/database.ts`, `packages/core/src/databases.ts`,
`apps/helper/src/units.ts`, `apps/agent/src/runtime.ts`, `docs/DATABASES.md`

> **Status update (5 Nov 2026):** the per-database PgBouncer sidecar, port allocation, and unit
> rendering are shipped. Remaining: TLS, pooled/direct connection UX, pool metrics, rotation
> integration. Verify before implementing.

## Goal

Make Postgres safe under real application connection patterns: a pooler by default, TLS in transit,
clear direct-vs-pooled URLs, and copy-paste snippets that work.

## Non-goals

- A database proxy with query routing, read/write splitting, or caching.
- HA/failover.
- Pooling for RustFS (S3 is stateless HTTP).
- Replacing Postgres's own `max_connections` tuning.

## Current state

- `databaseEngineRegistry` has `postgres` only; `DatabaseCreate` has `memoryMb`, `cpus`,
  `storageMb`, `volume`, `project`.
- `DatabaseService.connectionUrl()` emits a direct URL with no `sslmode`; the sampler uses
  `tls: false` (`apps/agent/src/database-stats.ts`).
- The helper renders one container unit per database, publishes `127.0.0.1:<port>:5432`, and joins
  `skiff-workloads`.
- Attachments inject `<PREFIX>_URL`, host/port/user/password/name at activation.
- Users must set `max_connections` or add PgBouncer themselves; there is no pooler, no TLS cert,
  and no connection snippet.

## Design

### Pooler placement

Start with a **per-database PgBouncer sidecar** in the same `skiff-workloads` network. It is simple,
isolated, and measurable. PgBouncer's RSS is small (typically 5–20 MB), but measure against the
250 MB baseline; if density becomes a problem, add a node-level pooler in P2. Do not silently route
everything through it.

- New managed profile field: `pooler: { enabled, mode: 'transaction'|'session', maxClientConn,
  defaultPoolSize, reservePoolSize }`.
- `database.pooler.enabled` defaults true for new databases; false for existing until restarted.
- The helper renders a second `.container` unit (or a Quadlet `Pod` in a follow-up) on the same
  network with `PublishPort=127.0.0.1:<poolerPort>:6432`, `auth_type=scram-sha-256`,
  `auth_query` against the monitor user, `server_reset_query=DISCARD ALL`.
- The pooler connects to the database's network alias, not loopback, so it works for container and
  process consumers.
- Port allocation: a parallel `DATABASE_POOLER_PORT_MIN/MAX` range (e.g. 16432–17431), lowest free,
  including soft-deleted databases.
- The pooler starts after Postgres is healthy; if it fails, the database still serves direct. The
  status view shows `pooler: running|failed|disabled`.
- Metrics: `SHOW POOLS`/`SHOW STATS` sampled by the agent; add active/idle/waiting clients, pool
  saturation, avg wait. Alert at 90% of `max_client_conn`.

### TLS

- Generate a per-node CA (or per-database self-signed cert) in the helper; write the cert/key as
  `0400` files under `/run/skiff-workloads/<id>/tls/`; mount into the Postgres container.
- Postgres settings: `ssl=on`, `ssl_cert_file`, `ssl_key_file`, `ssl_min_protocol_version=TLSv1.2`.
- Attachments inject:
  - `<PREFIX>_URL` with `?sslmode=require` (default; encrypts, no CA verification).
  - `<PREFIX>_CA_CERT` (PEM) and a note for `sslmode=verify-full` if the app supports it.
- Credentials response includes `sslmode` and the CA PEM (not a secret) so GUI clients can connect.
- The sampler moves to `tls: { rejectUnauthorized: false }` or the CA; never `tls:false` for
  production.
- If TLS setup fails, the database starts without it and the view shows a warning; do not block
  startup on a cert bug.

### Connection UX

- `DatabaseView` gains `pooler: { enabled, host, port, mode, urlTemplate }` and
  `tls: { enabled, mode, caPem }`.
- Add `connectionSnippets` to the credentials response: `psql`, `DATABASE_URL`, Prisma, Drizzle,
  Kysely, Django, Rails, Go `pgx`, Node `pg`, and `pgAdmin`/TablePlus fields.
- Document: migrations, `pg_dump`, logical replication, `LISTEN/NOTIFY`, advisory locks, prepared
  statements, cursors, and temp tables must use the **direct** URL in transaction mode.
- Add a `poolMode` per attachment? Keep it simple: the consumer gets both URLs; the app chooses.

### Rotation

- `DatabaseService.rotate(principal, name, role)`:
  1. Generate a new password.
  2. Agent fetches activation, runs `ALTER ROLE <role> PASSWORD '<new>'` through a fixed helper verb
     (or a direct connection with the owner credential).
  3. Seal the new secret; bump the attachment activation version; consumers restart.
  4. Revoke/expire the old credential after a configurable grace period.
- Roles: `owner`, `app`, `monitor`, `readonly`, `backup`. Start with owner + monitor; add app and
  readonly in 04.

## Implementation order

1. Contract fields (`pooler`, `tls`) + migration columns (contract PR).
2. Helper cert generation + Postgres TLS unit rendering; test a TLS handshake.
3. Helper pooler unit + port allocation + status reporting.
4. `DatabaseService` URL/snippet generation; credentials response.
5. Agent metrics for pooler; alerts.
6. Rotation (can land with 04).
7. Docs and UI: pooler/TLS badges, snippets, "use direct for migrations" warning.

## Acceptance criteria

- [ ] A new database starts with TLS on; `psql "sslmode=require"` succeeds and plaintext is refused.
- [ ] The pooler runs, injects `DATABASE_POOL_URL`, and survives a database restart.
- [ ] 200 concurrent short-lived clients succeed through the pooler; direct connections show the
      expected limit.
- [ ] A migration using the direct URL works; the same migration through transaction pooling is
      documented as unsupported.
- [ ] Pool saturation and wait metrics appear in the dashboard and `/metrics`.
- [ ] Rotating the owner password updates the secret, restarts consumers, and leaves the old
      password invalid after the grace period.
- [ ] The feature is off by default until the e2e TLS/pooler test passes on Debian 13.

## Tests

- Unit: port allocation, URL builder, snippet generation, cert file permissions, config rendering.
- Integration: Postgres container + PgBouncer; 200 concurrent connections; TLS handshake; wrong CA;
  pooler restart; database restart.
- Security: no private key in logs/desired state; cert files `0400`; `sslmode=require` enforced.
- Regression: direct URL still works for existing databases.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Pooler breaks session features | Direct URL for migrations; document limits; per-attachment choice |
| Memory cost per database | Measure; per-DB first; node-level pooler if density demands |
| TLS cert lifecycle | Node CA, rotate on node rekey; fallback to no TLS with a warning |
| Port range collision | Separate range, allocation test, include soft-deleted rows |
| Old clients break after rotation | Grace period; dual credentials; audit |

## Rollout

`SKIFF_FEATURE_POOLER` and `SKIFF_FEATURE_DB_TLS` off by default. Enable TLS first (low risk), then
the pooler for new databases, then convert existing databases on restart. Never force a restart of
a running database without a maintenance window.

## Open questions

- Per-database sidecar vs node-level pooler: start per-DB, measure, revisit.
- Should `sslmode=require` be the default, or `verify-full` with the CA? `require` is compatible;
  offer `verify-full` in snippets.
- Do we need a `pgbouncer`-specific backup path? `pg_dump` should use the direct URL.

## File ownership

Own: `packages/contracts/src/database.ts` (append-only), `packages/core/src/databases.ts`,
`apps/helper/src/units.ts` (pooler/TLS rendering), `apps/agent/src/database-stats.ts` (TLS/pool
metrics), `docs/DATABASES.md`.

Integration-owned: schema/migration, core context/index, helper server/systemd wiring, agent main,
dashboard database page, MCP/CLI registration, e2e harness.
