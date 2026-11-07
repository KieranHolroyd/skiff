# 11 — Stack blueprints: `skiff.yaml` with plan/apply

**Priority:** P1 · **Effort:** M · **Lane:** D · **Wave:** 2–3
**Status:** v1 implemented 2026-11-07 behind `SKIFF_FEATURE_BLUEPRINTS` (design: docs/OPERATIONS.md §12).
Built: file `skiff.blueprint.yaml|yml|json` naming a *stack* (`name:`) with `projects`
(environments, domains, workload settings), `databases`, `storage` (+ buckets), `brokers` and
`attachments`; strict validation with paths; plan as a `blueprint.apply` operation with a stable
`planHash`; idempotent apply that stops at the first failure (no compensation; re-plan lists what
is left); opt-in prune with typed confirmation; `blueprints` stack table (0071); REST
`/api/v1/blueprints/{validate,plan,apply}`; CLI `skif blueprint validate|plan|apply`; MCP
`plan_stack`/`apply_stack`/`get_task`; dashboard `/new/blueprint`. Differs from the design below:
one stack spans several projects (not `project:` + `services:`), REST is under `/blueprints`, not
`/projects/:slug/blueprint`. Not built: jobs, volumes, previews, static `path` uploads, env per
environment, drift badge, `export`, JSON Schema, `--lenient`, compensation.
**Depends on:** F1 contracts, 08 Valkey, 09 jobs, 13 extensions (soft: 07 volumes)
**Blocks:** 12 preview data, 14 stacks, 18 OpenAPI/Terraform
**Primary files:** `packages/contracts/src/blueprint.ts`, `packages/core/src/blueprints.ts`,
`apps/cli/src/commands/blueprint.ts`, `apps/control-plane/src/routes/api/v1/blueprints/**`,
`docs/BLUEPRINTS.md`

## Goal

Make a whole stack declarative: one `skiff.yaml` describes the site, database, bucket, jobs,
volumes, env, domains, access, and preview policy. `skiff plan` shows the diff; `skiff apply`
creates or updates it through the existing service layer; a re-apply is a no-op.

## Non-goals

- A general Terraform replacement (18).
- A visual template marketplace (14).
- Importing arbitrary Compose (14 has a subset; this plan only defines the native format).
- Managing resources outside the org/project scope.

## Current state

- Resources exist as separate service calls: `projects`, `environments`, `deployments`,
  `workloads`, `databases`, `storage`, `volumes`, `domains`, `jobs`.
- The `Operation` primitive (`packages/core/src/operations/`) already supports plan → apply,
  resumability, and progress for bulk delete/restore/prune.
- `skiff.json` is a *site* config (`spa`, `cleanUrls`, `trailingSlash`, `notFound`), not a stack.
- No declarative project spec, diff, drift detection, or import/export.

## Design

### Schema (v1)

```yaml
apiVersion: skiff/v1
project: my-app
environments:
  production:
    access: public
  staging:
    access: platform
services:
  web:
    type: static            # static | process | container
    path: ./dist
    spa: true
  api:
    type: process
    command: [bun, run, start]
    port: 3000
    healthPath: /health
    memoryMb: 256
    cpus: 1
    volumes:
      - data:/var/lib/app
databases:
  main:
    engine: postgres
    version: "17"
    sizeMb: 10240
    extensions: [pgvector, pg_trgm]
  cache:
    engine: valkey
    memoryMb: 128
storage:
  assets:
    public: true
    buckets:
      uploads:
        access: private
        versioning: true
        quotaMb: 5120
jobs:
  cleanup:
    schedule: "0 3 * * *"
    command: [bun, run, cleanup]
    timeoutSeconds: 300
volumes:
  data:
    sizeMb: 1024
domains:
  - host: app.example.com
    service: web
env:
  production:
    LOG_LEVEL: info
secrets:
  production:
    - DATABASE_URL        # reference only; value lives in the secret store
attachments:
  - project: my-app
    database: main
    prefix: DATABASE
  - project: my-app
    storage: assets
    prefix: S3
    grants:
      - bucket: uploads
        mode: read-write
previews:
  enabled: true
  data: schema-seed       # none | schema-seed | fork
  ttlHours: 72
  maxConcurrent: 5
```

- Secrets are **references**, never values. `skiff apply` resolves them from the project's secret
  store; a missing secret is a plan error.
- `apiVersion` is required; unknown fields are errors (strict schema), with a `--lenient` escape
  hatch.
- `path` is relative to the file; a static upload can be inline (≤5 MB) or presigned.

### Plan/apply

- `BlueprintService.plan(principal, project, doc)`:
  - Resolve the project by slug or plan a create.
  - Diff resources by stable keys (`services.web`, `databases.main`, `storage.assets.buckets.uploads`).
  - Produce a graph with `create|update|delete|noop`, a summary, and a hash.
  - Validate dependencies: service → DB attach → env; preview → clone; job → deployment.
  - Detect drift: a resource exists but is not in the file (warn, do not delete unless `--prune`).
- `BlueprintService.apply(principal, planHash, options)`:
  - Reuse `Operation` for resumability and SSE progress.
  - Execute in dependency order; compensate on failure (delete created resources, keep existing).
  - Record `appliedHash` and `appliedAt` on the project; a re-apply with the same hash is a no-op.
  - `--prune` deletes resources absent from the file, with a typed confirmation and a plan diff.
- `skiff plan` prints a human table and `--json`; `skiff apply` requires `--yes` in CI or a
  confirmation in a TTY.

### Drift

- `skiff plan` re-reads live state and compares to the file; a changed field shows `update`.
- Drift detection is advisory; never auto-reconcile in v1.
- Store the last applied doc (or hash + normalized JSON) for comparison and export.

### Surfaces

- REST: `POST /api/v1/projects/:slug/blueprint/plan`, `POST …/apply`, `GET …/blueprint`,
  `GET /api/v1/blueprints/schema` (JSON Schema for editors).
- MCP: `plan_stack`, `apply_stack`, `get_stack`, `export_stack` (no secrets).
- CLI: `skif plan`, `skif apply`, `skif export`, `skif blueprint validate`.
- Dashboard: "Import YAML", plan diff, apply progress, last applied, drift badge.
- Editor support: publish `skiff.schema.json` and a VS Code snippet in `docs/`.

## Implementation order

1. Contract/schema + strict validator + fixture docs (contract PR).
2. `BlueprintService.plan` for project + static + database + storage (the smallest useful stack).
3. `apply` using `Operation`; idempotency; compensation.
4. CLI `plan/apply/validate`.
5. Add jobs, volumes, domains, env/secrets, attachments.
6. Preview block (consumed by 12).
7. Drift + export + JSON Schema.
8. Dashboard import/diff.

## Acceptance criteria

- [ ] A `skiff.yaml` with a static site, Postgres, bucket, attachment, and domain applies in one
      command; a second apply is a no-op.
- [ ] `plan` shows create/update/delete/noop with a stable hash; `--json` is machine-readable.
- [ ] A missing secret fails the plan, not the apply.
- [ ] `--prune` is opt-in and requires typed confirmation; without it, orphan resources are warned.
- [ ] A failed apply compensates or leaves a resumable operation; no half-created stack.
- [ ] `export` produces a file that re-applies to the same state (minus secrets).
- [ ] Unknown fields fail with a precise path.

## Tests

- Unit: schema validation, diff, hash stability, dependency ordering, secret refs.
- Integration: apply/apply no-op, update, prune, compensation, operation resume.
- Real node: static + Postgres + bucket + domain end-to-end.
- Security: no secret values in the file, plan output, logs, or MCP.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Drift/plan surprises | Plan diff is explicit; `--prune` opt-in; no auto-apply |
| Partial apply | Operation primitive; compensation; resumable |
| Schema churn | `apiVersion`; strict validation; migration notes |
| Secret leakage | References only; resolve server-side; redact plan output |
| Huge files | Static path + presigned upload; no inline >5 MB |

## Rollout

`SKIFF_FEATURE_BLUEPRINTS` off by default. Start with read-only `plan` for existing projects; enable
apply for new projects; enable `--prune` last.

## Open questions

- Do we store the doc in the repo only, or also in the DB? Store the normalized doc + hash in the
  DB for drift/export; the repo is the source of truth.
- Should `apply` deploy the app or only provision? Provision + attach; deploy is a separate
  `skif deploy` unless `services.web.path` is present (then deploy).
- How do we handle a rename? Stable keys; a rename is delete+create, warned in the plan.

## File ownership

Own: `packages/contracts/src/blueprint.ts`, `packages/core/src/blueprints.ts` + test,
`apps/cli/src/commands/blueprint.ts`, `apps/control-plane/src/routes/api/v1/blueprints/**`,
`docs/BLUEPRINTS.md`.

Integration-owned: schema/migration, core context/index, Operation hooks, MCP registry, CLI main,
dashboard layout, e2e harness.
