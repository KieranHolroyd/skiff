# 12 — Preview environments with cloned or seeded data

**Priority:** P1 · **Effort:** L · **Lane:** D · **Wave:** 3
**Depends on:** 01 backups, 04 isolation, 07 app volumes, 09 jobs, 11 blueprints, 03 TLS, 10 private networking
**Blocks:** 20 agent data tools (preview tools)
**Primary files:** `packages/contracts/src/preview.ts`, `packages/core/src/previews.ts`,
`packages/core/src/environments.ts`, `packages/core/src/workloads.ts`,
`packages/control-plane/src/routes/api/v1/projects/[slug]/previews/**`, `docs/PREVIEWS.md`

## Goal

Give every pull request a full, isolated preview: the app, a database clone or schema+seed, a
bucket (or prefix), env, and a URL, with a PR comment, a TTL, quotas, and guaranteed teardown.

## Non-goals

- Production-data cloning by default. Schema+seed is the default; a production fork is explicit.
- Multi-region previews.
- A general environment-provisioning product for arbitrary branches (start with PRs).
- Replacing the existing static per-deployment preview; this adds data and per-environment
  workloads.

## Current state

- `environments` exist (`production` built in); `environments.ts` handles hosts and pointers.
- v2 runs **one workload per project** (D44); only the latest deployment is active.
- Preview URLs exist (`<slug>--<shortid>`); static previews are immutable releases.
- Git builds and PR webhooks exist; no sticky PR comment/check/deployment status.
- Databases/storage attachments are project-level; no clone/seed per environment.
- No preview table, TTL, quota, or teardown reconciler.

## Design

### Environment model

- Extend `environments` with `kind` (`production`/`named`/`preview`), `prNumber`, `branch`,
  `expiresAt`, `createdBy`, `source` (`github`/`api`/`cli`).
- Change workload uniqueness from `project_id` to `(project_id, environment)` or add
  `environment_id`. Migrate existing rows to `production`.
- `Deployment` already carries an environment; ensure each environment has its own production
  pointer and route.
- `previews` table: id, projectId, environmentId, provider (`github`), repo, prNumber, headSha,
  baseBranch, status (`creating`/`ready`/`failed`/`deleting`), url, dataMode
  (`none`/`schema-seed`/`fork`), databaseCloneId, bucketPrefix, expiresAt, createdAt, teardownAt.

### Database data

Three modes, in order of safety:

1. **`none`** — no database; for static sites.
2. **`schema-seed`** (default) — dump schema from the base database, create a new database inside
   the same instance, restore schema, run the project's seed command. No production rows.
3. **`fork`** — restore the latest backup (01) into the clone; sanitize/limit rows; explicit
   permission (`project:preview-fork`) and a warning. Never for fork PRs.

Implementation:

- `database_clones` table: id, sourceDatabaseId, previewId, databaseName, role, mode,
  sourceArtifactId, status, expiresAt.
- Agent creates the clone inside the source instance (`CREATE DATABASE <clone> OWNER <role>`,
  `pg_dump --schema-only | psql`, or `pg_restore`), grants a scoped role, and reports.
- Inject `<PREFIX>_URL` pointing at the clone; the preview's env overrides the production attachment.
- Teardown: `DROP DATABASE` after terminating connections; audit. Guard against dropping the source.
- Quotas: one clone per preview; max previews per project/org; storage/CPU budget.
- Fork PRs: no production secrets; placeholder env; no `fork` mode; no access to production
  attachments.

### Bucket data

- Create a per-preview bucket **or** a prefix in the source bucket. Prefer a prefix for cheap
  isolation: `<project>/previews/<pr>/...`, with a scoped key limited to the prefix. A separate
  bucket is cleaner but costs a bucket per PR; make it a flag.
- Copy seed objects only if the blueprint asks; never copy production objects by default.
- Teardown deletes the prefix (force) or bucket; versioned buckets must expire noncurrent versions.

### Workloads and routes

- Create one workload per service per preview environment, with the preview's env/secrets and
  resource caps.
- Route `<slug>--pr-<n>.<contentDomain>` (existing environment host shape) and an immutable
  per-deployment preview URL.
- Access defaults to `platform` or password-protected; previews are protected by default.
- PR comment: one sticky comment with URL, status, data mode, expiry, and cleanup note. Commit
  check/deployment status via the GitHub App (existing webhooks).
- Teardown: on merge/close, TTL expiry, or manual; a reconciliation sweep (09) deletes orphans even
  if the webhook was missed. Never rely only on webhooks.

### Security

- Fork PRs: untrusted code; no production secrets, no production DB, no host mounts.
- Preview URLs: `noindex`, platform/password access by default; optional public with a warning.
- Data: schema+seed default; sanitize production forks (limit tables/rows, redact PII columns).
- Audit create/teardown/fork; attribute to actor.
- Quotas: max concurrent previews, CPU/memory/storage per preview, TTL.

## Implementation order

1. Contracts/tables/migration: `environments.kind`, `previews`, `database_clones` (contract PR).
2. Workload uniqueness per environment; migrate production rows; keep static previews working.
3. `PreviewService.create/teardown` for `dataMode: none` (app + bucket prefix + route).
4. Database `schema-seed` clone + attach.
5. PR webhook/comment/check integration.
6. TTL + reconciliation sweep + quotas.
7. `fork` mode behind a permission and a flag.
8. Dashboard preview list, logs, teardown, data mode.
9. Docs and security review.

## Acceptance criteria

- [ ] Opening a PR creates an app + database clone + bucket prefix + URL; a sticky comment says so.
- [ ] Closing/merging tears down the workload, database, bucket/prefix, and route; a missed webhook
      is cleaned by the sweep.
- [ ] `schema-seed` has the schema and seed rows but no production rows.
- [ ] `fork` is opt-in, permissioned, and refuses fork PRs.
- [ ] A preview cannot read production secrets or the production database.
- [ ] TTL and max-concurrent quotas prevent runaway resources; an agent loop is capped.
- [ ] A preview app can run a migration against its clone without affecting production.
- [ ] The PR comment updates in place and shows the data mode/expiry.

## Tests

- Unit: environment host, data-mode validation, clone naming, TTL, quota, teardown state machine.
- Integration: create/teardown for each mode; missed webhook sweep; fork PR isolation; bucket prefix.
- Real node: workload per environment, DB clone, route, PR comment (fake GitHub).
- Security: no prod secret; no prod DB; no fork-PR fork; audit.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Production data leaks | Schema+seed default; `fork` opt-in; sanitize; no fork PRs |
| Orphaned resources | TTL + reconciliation sweep + quotas + alerts |
| Workload uniqueness migration | Additive column; migrate production first; keep old path until green |
| Clone cost | Same-instance database clone; cap count; storage quota |
| Teardown races | Idempotent state machine; mark deleting; retry |
| PR webhook misses | Poll/reconcile; do not rely on the event |

## Rollout

`YOAL_FEATURE_PREVIEW_DATA` off by default. Start with `dataMode: none` for existing static
previews, then `schema-seed` for one repo, then `fork` for trusted branches. Keep previews
protected by default.

## Open questions

- Same-instance clone vs a new instance per preview: same-instance is cheap and fast; a new instance
  is better isolation. Start same-instance with a scoped role.
- Do we need a per-preview bucket or is a prefix enough? Prefix for v1; bucket flag later.
- How do we seed? Use the project's `seed` command from `yoal.yaml`; no built-in fixture.

## File ownership

Own: `packages/contracts/src/preview.ts`, `packages/core/src/previews.ts` + test,
`packages/core/src/environments.ts` (kind/preview fields), `packages/core/src/workloads.ts`
(environment uniqueness), `apps/control-plane/src/routes/api/v1/projects/[slug]/previews/**`,
`docs/PREVIEWS.md`.

Integration-owned: schema/migration, core context/index, agent/helper clone verbs, GitHub webhook
handler, dashboard project layout, MCP/CLI registration, e2e harness.
