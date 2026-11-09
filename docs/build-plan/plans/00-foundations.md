# 00 — Foundations: contracts, streaming storage, e2e, scheduler, flags

**Priority:** P0 · **Effort:** M total · **Lane:** integration · **Wave:** 0
**Depends on:** nothing
**Blocks:** every feature plan
**Primary files:** `packages/contracts/src/*`, `packages/db/src/schema.ts`,
`packages/db/migrations/*`, `packages/core/src/scheduler.ts`, `apps/control-plane/src/lib/server/mcp/*`,
`apps/cli/src/commands/*`, `tests/e2e/*`

This is not a user-facing feature. It is the interface freeze that lets 20 agents work without
rewriting each other's code. Land it before Wave 1. Each sub-task below is a separate PR and can be
reviewed independently.

---

## F1 — Contracts, schema, and module split

**Goal:** define the shapes every Wave 1–3 plan imports.

1. **New contracts files** (one domain each, no implementations):
   - `packages/contracts/src/backup.ts` — targets, schedules, artifacts, runs, tasks/results.
   - `packages/contracts/src/app-volume.ts` — volumes, attachments, snapshots.
   - `packages/contracts/src/job.ts` — jobs, runs, cron, concurrency.
   - `packages/contracts/src/blueprint.ts` — `yoal.yaml` schema, plan/apply views.
   - `packages/contracts/src/preview.ts` — preview, database clone, bucket prefix, TTL.
   - `packages/contracts/src/bucket-config.ts` (or append to `object-storage.ts`) — versioning,
     lifecycle, CORS, quota, object lock, share links.
   - `packages/contracts/src/pooler.ts` (or append to `database.ts`) — pooler/TLS fields.
   - `packages/contracts/src/extension.ts` — allowlist, installed extensions, slow queries.
   - `packages/contracts/src/quota.ts` — extended quota/usage views.
   - `packages/contracts/src/mcp-data.ts` — agent data tool inputs/outputs.
2. **`WorkloadDesired` additive fields** (freeze these; plans 07/09/19/20 depend on them):
   ```ts
   volumes?: Array<{ id: string; mountPath: string; readOnly: boolean }>;
   processes?: Array<{ name: string; command: string[]; port?: number; healthPath?: string }>;
   job?: { id: string; timeoutSeconds: number };
   ```
   Keep them optional so older agents ignore unknown fields.
3. **Schema marker blocks.** Add empty table definitions with a `// --- NN: <plan> ---` marker for
   every new table. Do not implement services here. Include the migration numbering convention.
4. **Module split for parallel work** (important):
   - Extract MCP tools into `apps/control-plane/src/lib/server/mcp/tools/<domain>.ts` with a
     registry; DB/storage first, then the rest. Keep `mcp.ts` as the composition root.
   - Extract CLI commands into `apps/cli/src/commands/<domain>.ts` with a registry.
   - Extract helper verbs into `apps/helper/src/<domain>.ts` with a `HelperRuntime` method per verb.
   - This is a refactor only; behavior must not change. Cover with the existing tests.
5. **Contract tests:** parse/round-trip for every new schema; no integration.

**Exit:** `bun run check` and `bun test` green; the contracts index exports every new domain; a
feature agent can import a type without touching a shared file.

**Contract note (F1 slice):** Added `backup-target.ts` (targets only, since 01 already owns backup
schedules/artifacts/runs), `app-volume.ts`, `job.ts`, `blueprint.ts`, `preview.ts`, `quota.ts` and
`mcp-data.ts`, plus the optional `volumes`/`processes`/`job` fields on `WorkloadDesired`. Consumers:
01/05 (targets), 07/12 (app volumes, previews), 09 (jobs), 11/14 (blueprint + Compose result),
16 (quota/usage) and 20 (MCP data tools). Bucket config, pooler and extension contracts are omitted
because their Wave 1 features already shipped their own contracts. No tables, migrations or service
implementations are part of this slice; `packages/contracts/src/index.ts` exports the new modules.

---

## F2 — Streaming `ObjectStore`

**Goal:** backups and imports must not buffer multi-GB objects.

1. Extend `ObjectStore` with `putStream`, `getStream`, and a required `list`.
2. Rename/generalize `R2ObjectStore` to `S3ObjectStore` with `endpoint`, `bucket`, `region`,
   `forcePathStyle`, optional `sessionToken`; keep the R2 config as an alias.
3. Implement streaming in `LocalObjectStore` (no `readFile`/`writeFile` for large bodies).
4. Add `testConnection()` (head/put/list/delete a probe) and a `kind: 's3' | 'local'` union.
5. Tests: 1 GB stream with a bounded RSS assertion; path traversal; presign; list pagination.

**Exit:** 01, 05, and 17 can stream without touching `ObjectStore` again. Old `put/get` callers keep
working.

---

## F3 — Debian 13 / Podman e2e harness

**Goal:** the managed-data path must be tested on the target host, not just in unit tests.

1. One command (script or Bun test) that starts a disposable Debian 13 container/VM with Podman ≥5
   and netavark, installs the helper, and runs:
   - Postgres create/attach/health.
   - RustFS create/bucket/SigV4/multipart/presigned/range.
   - A backup/restore fixture (after 01) and an object browser fixture (after 02).
2. A fake S3 target (MinIO or a local S3 stub) and a Postgres fixture with deterministic data.
3. CI job that runs on PRs touching `apps/helper`, `apps/agent`, `packages/core/src/databases.ts`,
   or `storage-*`.
4. Document how to run it locally.

**Exit:** the same command passes locally and in CI; a failing Quadlet/uid/network case is caught
before merge.

---

## F4 — Scheduler primitive

**Goal:** one durable, idempotent scheduler for backups, jobs, upgrades, and preview teardown.

1. `packages/core/src/scheduler.ts` with `enqueue`, `claim`, `complete`, `fail`, `tick`.
2. Table `scheduled_tasks` (id, kind, key unique, runAt, leaseUntil, attempts, payloadJson, status,
   resultJson, createdAt, updatedAt).
3. Idempotency by `kind + key`; lease expiry; exponential backoff; max attempts.
4. `MaintenanceService.run()` calls `scheduler.tick()`; no new daemon.
5. Tests: duplicate enqueue, lease expiry, retry, concurrent claim, clock skew.

**Exit:** 01 and 09 can use the primitive; it is covered by tests and has no feature-specific logic.

---

## F5 — Feature flags, migrations, and rollback protocol

**Goal:** risky work ships dark and can be undone.

1. `YOAL_FEATURE_<AREA>` env flags read once, exposed in `/api/setup/status`; default off for
   destructive features. List the flags in `docs/OPS.md`.
2. Migration rules: additive only; one file per feature; no destructive `ALTER`; a pre-migration
   snapshot hook; a `schema_version` check in `/readyz`.
3. A CI check that fails if a migration is not additive or if a feature flag is missing from the
   registry.
4. Document the rollback path for a bad migration (restore the snapshot, never edit history).

**Exit:** the release checklist can gate each feature; a bad migration is caught before merge.

---

## Parallelisation

| Sub-task | Can start | Depends on | Owner |
|---|---|---|---|
| F1 | immediately | — | integration |
| F3 | immediately | — | test/infra |
| F2 | after F1's `ObjectStore` interface | F1 | storage |
| F4 | after F1's table convention | F1 | runtime |
| F5 | immediately | — | release |

F1 must merge before any Wave 1 feature starts. F2 and F4 can overlap F1's tail once their interface
is agreed. F3 runs independently.

## Acceptance criteria

- [ ] Every new domain has a contracts file and a round-trip test.
- [ ] `WorkloadDesired` has the additive fields, and an older agent ignores them.
- [ ] MCP/CLI/helper modules exist; behavior is unchanged; existing tests pass.
- [ ] `ObjectStore` streams 1 GB with bounded RSS.
- [ ] The Debian 13 e2e command runs Postgres and RustFS.
- [ ] The scheduler passes duplicate/lease/retry tests.
- [ ] Every destructive feature has a flag and a migration rule.
- [ ] `bun test` and `bun run check` are green.

## File ownership

Own: the new contracts files, `packages/db/src/schema.ts` marker blocks,
`packages/db/migrations/*` (one per sub-task), `packages/core/src/scheduler.ts`,
`apps/control-plane/src/lib/server/mcp/*` (extraction), `apps/cli/src/commands/*` (extraction),
`tests/e2e/*`, `docs/OPS.md` (flags/migrations).

Do not implement feature behavior here. If a feature needs a field, it goes in the contract PR; if
it needs a table, it goes in the marker block.
