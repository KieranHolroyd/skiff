# 08 — Managed Valkey (Redis-compatible)

**Priority:** P1 · **Effort:** S–M · **Lane:** C · **Wave:** 2
**Depends on:** F1 contracts
**Blocks:** 11 blueprints, 14 stacks, 19 process groups
**Primary files:** `packages/contracts/src/database.ts`, `packages/core/src/databases.ts`,
`apps/helper/src/units.ts`, `apps/agent/src/database-stats.ts`, `docs/DATABASES.md`

## Goal

Add a managed Valkey instance as the second engine, so apps have a cache, session store, rate
limiter, and queue backend without hand-rolling a container.

## Non-goals

- A Redis Cluster or Sentinel HA deployment.
- A workflow engine. Durable queues are managed brokers (D111, docs/BROKERS.md), not Valkey.
- Public exposure by default.
- Replacing Postgres for durable data.

## Current state

- `databaseEngines = ['postgres']`; `databaseEngineRegistry` has one entry.
- `DatabaseService` assumes SQL: `databaseName`, `username`, `connectionUrl`, table snapshots,
  `pg_stat_database` sampling.
- The helper has a fixed database profile (`database: { engine, version }`), derives the image,
  and renders PGDATA. It needs an engine branch for Valkey.
- Attachments inject `DATABASE_URL`/host/port/user/password/name.
- Metrics tables are Postgres-specific (`db_metrics_1m` with xact/tup/blks).

## Design

### Engine registry

Add `kind: 'sql' | 'cache'` and `defaultPort` to `DatabaseEngineInfo`:

```ts
valkey: {
  engine: 'valkey', label: 'Valkey', kind: 'cache',
  versions: ['8'], defaultVersion: '8',
  containerPort: 6379, scheme: 'redis',
  minMemoryMb: 64, defaultMemoryMb: 128,
}
```

- Keep the `databases` table; branch on `engineInfo.kind`.
- `DatabaseView` gains `kind`, `connection: { url, host, port, tls }`, and for cache: `role`,
  `maxmemoryPolicy`, `persistence`.
- `DatabaseCreate` gains cache fields: `maxmemoryMb` (defaults to `memoryMb`), `maxmemoryPolicy`
  (`noeviction`/`allkeys-lru`/`volatile-lru`/…), `persistence` (`appendonly`/`rdb`/`none`).
- `DatabaseUpdate` can change memory/policy; changing persistence requires a restart with a warning.

### Helper profile

- The helper's fixed map adds `valkey` → pinned image, uid/gid, data dir `/data`, command args.
- Render a container unit with:
  - `--requirepass <file>` or an ACL file `0400` under `/run/yoal-workloads/<id>/`; never env.
  - `--appendonly yes` or `--save` per config; `--maxmemory`, `--maxmemory-policy`.
  - `PublishPort=127.0.0.1:<port>:6379`; org network only; no public port by default.
  - Health: `valkey-cli -a <file> PING` via a fixed helper probe or TCP connect.
- Optional TLS: reuse 03's node CA; `--tls-port`, `--tls-cert-file`, `--tls-key-file`,
  `--tls-ca-cert-file`. Default off until tested; `rediss://` when on.
- Port allocation: a `VALKEY_PORT_MIN/MAX` range, disjoint from Postgres/storage.

### Attachments

- Inject `<PREFIX>_URL` (`redis://` or `rediss://`), `_HOST`, `_PORT`, `_PASSWORD`, `_TLS`.
- If `PREFIX=AWS` is not relevant; keep `REDIS` default? Use `REDIS` for cache, but allow
  `DATABASE` for consistency. Document both.
- Scoped ACL users: v1 uses the default user with a password; v2 can add per-attachment ACLs
  (`+@read`, `~prefix:*`). Do not claim isolation until ACLs exist.

### Metrics and backups

- Agent `INFO` sampler: memory used/max, keys, hits/misses, evictions, connected clients, ops/sec,
  persistence status.
- Store in `db_metrics_1m` with a `kind`/`engine` column or a separate `cache_metrics_1m`; prefer a
  generic `service_metrics_1m` to avoid a second pipeline.
- Alerts: memory > 85%, evictions > 0 with `noeviction`, persistence failure, connection saturation.
- Backups: RDB snapshot (`BGSAVE`) or AOF; stream to the target via 01. Restore into a new instance.
  Document that RDB is point-in-time-ish, not PITR.
- No SQL console; add a "command" panel? No, do not expose arbitrary commands. A read-only `INFO`
  panel is enough.

### Surfaces

- REST/MCP/CLI reuse `databases` endpoints but validate engine-specific fields.
- MCP: `create_database` accepts `engine: 'valkey'`; never returns the password.
- Dashboard: engine picker, memory/eviction policy, persistence, metrics, attach.
- Docs: `docs/VALKEY.md` or a section in `DATABASES.md`.

## Implementation order

1. Contract `kind`, engine entry, create/update fields (contract PR).
2. Helper image/user/profile + unit rendering + health.
3. `DatabaseService` branches for create/attach/connection/metrics/backup.
4. Agent metric sampler.
5. UI/CLI/MCP.
6. TLS (after 03) and ACL users (follow-up).
7. Backup/restore via 01.

## Acceptance criteria

- [ ] `yoal db create cache --engine valkey` creates a running Valkey instance with a generated
      password; `redis-cli` connects over loopback/org network.
- [ ] An attached app receives `REDIS_URL` and can `SET`/`GET`.
- [ ] No public port; a cross-org container cannot connect.
- [ ] Memory/eviction metrics and alerts work; `maxmemory-policy` is applied.
- [ ] A backup/restore into a new instance preserves keys.
- [ ] Restart/redeploy keeps data (AOF/RDB).
- [ ] The engine list is data-driven; adding MySQL later does not change the UI.

## Tests

- Unit: engine registry, create validation, connection URL, policy validation.
- Integration: Valkey container, auth, persistence across restart, maxmemory eviction, metrics.
- Real node: Podman unit, org network, no public port, backup/restore.
- Security: password file `0400`; no password in logs/desired state; TLS handshake if enabled.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Eviction surprises | Default `noeviction`, warn when full; explicit policy |
| Persistence misconfig | Default AOF everysec; test restart; document durability |
| Memory cost | min 64 MB; admission; alert |
| SQL assumptions leak | Branch on `kind`; add a non-SQL test path |
| Another engine to patch | Pin digest; one engine, not a catalogue |

## Rollout

`YOAL_FEATURE_VALKEY` off by default. New engine only; no migration of existing databases.
Enable after the restart/persistence test passes on Debian 13.

## Open questions

- Table name: keep `databases` or introduce `data_services`? Keep `databases` for v1; a rename is
  costly and not user-visible.
- Do we support per-attachment ACLs in v1? No; password + private network first.
- Should cache instances count toward the same quota as databases? Yes, one data-resource quota.

## File ownership

Own: `packages/contracts/src/database.ts` (engine/kind/fields), `packages/core/src/databases.ts`,
`apps/helper/src/units.ts` (valkey profile), `apps/agent/src/database-stats.ts` (INFO sampler),
`docs/DATABASES.md`.

Integration-owned: schema/migration, core context/index, helper server/systemd, agent main,
dashboard database page, MCP/CLI registration, e2e harness.
