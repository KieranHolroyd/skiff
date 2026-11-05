# 13 — Postgres extensions, vector search, and slow queries

**Priority:** P1 · **Effort:** S–M · **Lane:** E · **Wave:** 2
**Depends on:** F1 contracts
**Blocks:** 11 blueprints, 14 stacks (AI/vector stacks)
**Primary files:** `packages/contracts/src/database.ts`, `packages/core/src/databases.ts`,
`apps/agent/src/database-stats.ts`, `apps/helper/src/databases.ts`, `docs/DATABASES.md`

> **Status update (5 Nov 2026):** the extension allowlist, `pg_stat_statements` slow-query sample,
> and dashboard panel are shipped. Remaining: verify on Debian 13, confirm PostGIS availability in
> the pinned image. Do not rebuild the shipped half.

## Goal

Make Skiff's Postgres feel like a real application database: enable common extensions (pgvector,
PostGIS, pg_trgm, pg_cron, pg_stat_statements), show slow queries, and document the vector use case
without shipping a separate vector database.

## Non-goals

- Arbitrary/superuser extensions. Allowlist only.
- Automatic index creation or query rewriting.
- A SQL IDE with arbitrary write access. A read-only console is a separate follow-up.
- Extension version upgrades beyond what the image ships.

## Current state

- `DatabaseCreate` has no `extensions` field; the bootstrap creates the database/role only.
- The agent samples `pg_stat_database`, connections, size, and a table snapshot; no
  `pg_stat_statements`.
- `shared_preload_libraries` is not set; `pg_cron`/`pg_stat_statements` need it.
- The dashboard shows tables and charts, no slow-query view.
- Supabase pre-installs 50+ extensions; Fly includes pgvector/PostGIS; Skiff is vanilla.

## Design

### Allowlist

`EXTENSION_ALLOWLIST` in contracts:

| Extension | Notes |
|---|---|
| `pgvector` | AI embeddings; index with `ivfflat`/`hnsw` |
| `postgis` | Geospatial; heavier image? verify availability |
| `pg_trgm` | Fuzzy search / LIKE indexes |
| `pgcrypto` | Hashing/UUIDs |
| `citext` | Case-insensitive text |
| `hstore` | Key-value |
| `unaccent` | Search normalization |
| `pg_cron` | Scheduled SQL; needs preload |
| `pg_stat_statements` | Query stats; needs preload |

- Validate the extension against the engine version's available list; a missing extension is a 422
  with the reason, not a silent skip.
- Do not allow `postgres_fdw`, `dblink`, `plpython`, `plv8`, or anything that escapes the container
  or makes network connections.

### Data model

- Add `databases.extensions_json` (array of names + installed version) and
  `databases.preload_json` (resolved `shared_preload_libraries`).
- `DatabaseCreate.extensions: string[]` default `[]`; `DatabaseUpdate.extensions` diff.
- Applying an extension:
  - On create: helper/agent connects with the owner credential, runs
    `CREATE EXTENSION IF NOT EXISTS <name>` (identifiers from the allowlist, never interpolated raw).
  - On update: same; removal is **not** automatic (dropping an extension can destroy data). Mark
    "removal requires SQL" and show a warning.
- `pg_cron`/`pg_stat_statements`: set `shared_preload_libraries` at create; changing it requires a
  restart. Warn before restart; do not restart a database with active connections without a
  maintenance window.

### Slow queries

- Agent samples `pg_stat_statements` every five minutes (top 50 by total time):
  queryid, fingerprint (normalized), calls, total/mean time, rows, shared blocks, temp blocks.
- Redact literals before storing: use `query` from `pg_stat_statements` and replace string/number
  literals with `?`; store the fingerprint, not raw SQL with values. Keep the raw query only in
  memory for the current sample if needed; never persist secrets.
- Store in SQLite (`databases.slow_queries_json`) or DuckDB (`db_slow_queries_1h`) for history. Start
  with latest-only JSON; history is a follow-up.
- Dashboard: slow-query table with mean/total time, calls, rows; a "reset stats" action (audited).
- Alerts: a query mean > threshold? Avoid noisy alerts; surface in the UI and let the operator set a
  threshold later.

### Surfaces

- REST: `GET/PATCH /databases/:name/extensions`, `GET /databases/:name/queries`.
- MCP: `list_database_extensions`, `enable_database_extension` (confirmed), `get_slow_queries`.
- CLI: `skif db extensions list|enable`, `skif db queries`.
- Dashboard: Extensions panel with toggles, vector/POSTGIS snippets, slow queries.
- Docs: `docs/DATABASES.md` sections for pgvector, PostGIS, pg_cron, pg_stat_statements.

## Implementation order

1. Contract allowlist + fields + migration (contract PR).
2. Bootstrap extension application + preload handling; tests against the Postgres image.
3. `DatabaseService` update diff + validation + "removal requires SQL" warning.
4. Agent `pg_stat_statements` sampler + redaction.
5. REST/MCP/CLI/dashboard.
6. Docs + stack examples (pgvector RAG, PostGIS).

## Acceptance criteria

- [ ] A database created with `extensions: [pgvector, pg_trgm]` has both installed; a query using
      `vector` works.
- [ ] An unknown/unsupported extension returns a clear 422; no partial install.
- [ ] `pg_stat_statements` is preloaded when requested; the slow-query panel shows redacted queries.
- [ ] Enabling `pg_cron` warns about the restart and works after it.
- [ ] Removing an extension is refused with a link to the manual SQL, never silent.
- [ ] No query literals/PII are persisted; a test with a literal secret asserts redaction.
- [ ] The extension list is data-driven; adding one is a contract + image check.

## Tests

- Unit: allowlist validation, preload resolution, redaction.
- Integration: Postgres container, each extension, vector query, PostGIS point, pg_cron job.
- Failure: extension missing from image, preload restart, permission denied.
- Security: identifier injection, literal redaction, no network extensions.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Extension not in image | Verify at create; clear error; document supported set |
| Preload restart disrupts apps | Warn; maintenance window; opt-in |
| Query text leaks secrets | Redact literals; store fingerprint; no raw SQL persistence |
| PostGIS image size | Optional; measure image pull/time; do not preload |
| Removal destroys data | Never auto-drop; explicit SQL warning |

## Rollout

Ship the read-only slow-query panel first; extension enablement behind `SKIFF_FEATURE_DB_EXTENSIONS`
off by default. Enable for new databases, then existing on restart.

## Open questions

- Which extensions are present in `postgres:17-alpine`? `pgvector` likely needs the `pgvector` image
  or an install; verify. If not, use a custom pinned image or a `postgres` image with contrib.
- Do we need a separate `vector` engine? No; pgvector is enough for the target user.
- Should `pg_stat_statements` be on by default? It has a small overhead and is very useful; default
  on for new databases, opt-out.

## File ownership

Own: `packages/contracts/src/database.ts` (allowlist/fields), `packages/core/src/databases.ts`,
`apps/helper/src/databases.ts` (new extension verb), `apps/agent/src/database-stats.ts`
(statements sampler), `docs/DATABASES.md`.

Integration-owned: schema/migration, helper server/systemd, agent main, dashboard database page,
MCP/CLI registration, e2e harness.
