# 14 — Curated stacks and Compose import

**Priority:** P1 · **Effort:** M (mechanism) + S per stack · **Lane:** D · **Wave:** 3
**Depends on:** 07 volumes, 08 Valkey, 09 jobs, 11 blueprints, 13 extensions (soft: 15 transforms)
**Blocks:** nothing, but it is the adoption flywheel
**Primary files:** `packages/contracts/src/stack.ts`, `packages/core/src/stacks.ts`,
`stacks/*.yaml`, `apps/cli/src/commands/stack.ts`, `docs/STACKS.md`

## Goal

Ship 10–20 first-party, pinned, tested stacks that install a real application with its database,
cache, bucket, volume, jobs, domain, and backups in one action. Add a Compose-import subset for the
long tail, instead of a 750-template catalogue.

## Non-goals

- Matching Coolify's 360+ or Easypanel's 750+ template count.
- A public template marketplace or user-submitted registry.
- Arbitrary Docker Compose compatibility.
- Privileged containers, host networking, or host bind mounts.

## Current state

- `yoal.yaml` blueprints (11) are the packaging mechanism; this plan consumes them.
- Resources exist; no stack registry, install record, upgrade path, or compose importer.
- Coolify/Easypanel template staleness is a known failure: `:latest`, wrong images, stale releases,
  upgrades that break data.

## Design

### Stack manifest

A stack is a blueprint with parameters and metadata:

```yaml
apiVersion: yoal/stack/v1
name: n8n
version: 1.4.0
description: Workflow automation with Postgres
icon: n8n
parameters:
  domain:
    type: string
    required: true
  adminEmail:
    type: string
    default: admin@example.com
resources:
  database:
    engine: postgres
    version: "17"
    extensions: [pg_trgm]
  web:
    image: docker.io/n8nio/n8n:1.94.1@sha256:...
    port: 5678
    healthPath: /healthz
    memoryMb: 512
    env:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: ${database.host}
      N8N_ENCRYPTION_KEY: ${secret:N8N_ENCRYPTION_KEY}
  job:
    schedule: "0 3 * * *"
    command: [n8n, export:workflow, --all]
backups:
  database: true
  volume: true
```

- Every image is pinned by digest; no `:latest`.
- Secrets are generated once and stored in the project secret store; the manifest references them.
- Stacks are signed/versioned in-repo; the control plane verifies the manifest hash.
- `parameters` are validated; no arbitrary shell.
- `upgrade` is explicit: a new stack version with a diff and a pre-upgrade backup; never auto-upgrade.

### Registry and install

- `stacks` table: name, version, manifestJson, hash, publishedAt, deprecated.
- `stack_installs` table: projectId, stackName, version, blueprintHash, status, installedBy,
  installedAt, lastUpgradedAt.
- `StackService.list/install/upgrade/uninstall`:
  - `install` resolves parameters, generates secrets, builds a blueprint, and calls
    `BlueprintService.apply`.
  - `uninstall` uses blueprint `--prune` semantics with a typed confirmation; data is soft-deleted
    for 7 days.
  - `upgrade` shows the manifest diff, takes a backup, applies, and rolls back on failure.
- Version pinning: an install records the stack version; an upgrade is opt-in.

### Compose import

- `yoal stack import compose.yml` translates a subset:
  - `services.<name>.image` (digest or tag), `command`, `ports`, `environment`, `volumes` (named
    only), `depends_on`, `healthcheck`.
  - Reject `privileged`, `network_mode: host`, `cap_add`, `devices`, bind mounts, `build` (or map
    build to a git build later), and unknown top-level keys.
  - Map named volumes to app volumes (07); map a Postgres/Redis service to a managed database only
    if the image is recognized and the user opts in; otherwise run it as a container with a volume.
  - Emit a `yoal.yaml` plan for review; never apply directly.
- This is a convenience, not a compatibility promise; print a warning for each unsupported key.

### Stack catalogue (first 15)

n8n + Postgres, Plausible + ClickHouse, Uptime Kuma, Gitea + Postgres, Ghost + MySQL (when MySQL
lands), WordPress + MySQL, Directus + Postgres, Cal.com + Postgres, Metabase + Postgres, Umami +
Postgres, Vaultwarden, Supabase-lite (Postgres + PostgREST + storage), Meilisearch, RabbitMQ,
MinIO/RustFS console.

- Each stack has a smoke test: install, health check, a basic API call, uninstall.
- Each stack enables backups by default where data exists.
- Each stack has an upgrade note and a pinned digest.

## Implementation order

1. Contract/schema + a single stack manifest + validator (contract PR).
2. `StackService.install` for n8n (app + Postgres + domain) via BlueprintService.
3. CLI `stack list|install|upgrade|uninstall`; dashboard catalogue.
4. Stack tests + pinned digest checks + a CI job that installs in a dev node.
5. Add 5 stacks; add 10 more.
6. Compose import translator + tests + warnings.
7. Upgrade flow with backup/rollback.

## Acceptance criteria

- [ ] `yoal stack install n8n --param domain=n8n.example.com` creates the app, Postgres, env,
      domain, and backup schedule; the app is healthy.
- [ ] A stack manifest with a floating tag is rejected in CI and at install.
- [ ] Uninstall soft-deletes data for 7 days and requires typed confirmation.
- [ ] Upgrade shows a diff, takes a backup, and rolls back on a failed health check.
- [ ] Compose import rejects privileged/host-network/bind-mount inputs with a precise error.
- [ ] A stack smoke test runs in CI; a broken stack fails the build.
- [ ] No stack ships with `:latest` or an unpinned digest.

## Tests

- Unit: manifest validation, parameter interpolation, digest check, compose translation.
- Integration: install n8n + Postgres + domain; health; uninstall; upgrade.
- CI: stack smoke matrix; stale digest check; SBOM (optional).
- Security: no privileged/host mount; secret generation; no `:latest`.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Stale templates | Pin digests; CI smoke; upgrade PRs; deprecation |
| Supply chain | First-party only; signed manifests; SBOM; no user registry |
| Compose false compatibility | Reject unsupported keys loudly; document the subset |
| Stack upgrades break data | Backup first; diff; rollback; opt-in |
| Catalogue treadmill | Cap at 15–20; compose import for the long tail |

## Rollout

Start with 3 stacks in a private beta; add 12 after the install/upgrade tests are stable. Compose
import is a preview feature, not the default path.

## Open questions

- Do we host the catalogue in-repo or in a signed remote index? In-repo first; a remote index only
  with signing.
- Do we support `build:` in compose? No; map to a git build in a later plan.
- How do we handle MySQL stacks before 08's MySQL? Use the Postgres variant or defer.

## File ownership

Own: `packages/contracts/src/stack.ts`, `packages/core/src/stacks.ts` + test, `stacks/*.yaml`,
`apps/cli/src/commands/stack.ts`, `docs/STACKS.md`.

Integration-owned: schema/migration, core context/index, BlueprintService hooks, dashboard
catalogue, MCP/CLI registration, CI stack matrix, e2e harness.
