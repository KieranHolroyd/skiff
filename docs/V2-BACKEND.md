# Skiff v2 — Backend build plan

Status: all four workstreams landed and green (471+ tests). Installer/release wiring is the remaining integration step.
Frontend/dashboard work is deliberately **out of scope** here (it is handled separately).

v2 is not a rewrite. It keeps the v1 deploy pipeline (artifact → release → deployment → preview →
promote) and widens three axes:

1. **What runs**: tier 2 process apps and tier 3 containers, not just static files.
2. **Where it runs**: any node, edge included, under a per-node workload-slice budget (D41).
3. **Where it comes from and where it answers**: git builds (D2/D3) and custom domains (D31).

Everything still goes through `packages/core`; REST, MCP, CLI and the dashboard remain thin surfaces.

---

## Foundation (landed)

| Area | Where | What |
|---|---|---|
| Workload contract | `packages/contracts/src/workload.ts` | `WorkloadSpec`, secret refs/delivery, `WorkloadDesired`, activation payload, node capacity |
| Build contract | `packages/contracts/src/build.ts` | git source, build queue/report/job shapes |
| Domain contract | `packages/contracts/src/domain.ts` | TXT verification, `apex`/`custom`, `www`, Caddy `ask` |
| Environment contract | `packages/contracts/src/environment.ts` | named environments; `production` is built in |
| Agent protocol | `packages/contracts/src/agent.ts` | `desiredState.workloads`, `desiredState.domains`, `platformOrigin`; heartbeat reports workloads |
| Schema | `packages/db/migrations/0003_v2_backend.sql` | node slice budget + builder flag, project workload spec, deployment environment/workload snapshot, `environments`, `workloads`, `git_sources`, `builds`, domain verification columns |
| Placement | `packages/core/src/placement.ts` | pure `auto`/explicit/edge resolution with admission |
| Workloads | `packages/core/src/workloads.ts` | spec validation, admission, placement, desired state, **just-in-time activation** of secrets |
| Environments | `packages/core/src/environments.ts` | production bootstrap, host rules, CRUD pointers |
| Domains | `packages/core/src/domains.ts` | create/list/remove, TXT check, Caddy `ask` approval, desired hosts (Cloudflare/apex work expands it) |
| Builds | `packages/core/src/builds.ts` | queue, claim, report, finalize into the normal deploy pipeline, GitHub signature check |
| Deploy integration | `packages/core/src/deployments.ts`, `nodes.ts` | app deploys execute admission and snapshot the spec; rollback restores spec + placement; routes proxy to workload upstreams; environments and domains ride desired state |
| Runtime execution | `apps/helper`, `apps/agent/src/runtime.ts` | sandboxed systemd/Quadlet units, socket activation, slice budget, JIT secret activation, failure isolation |
| Builds | `apps/builder` | node-token Builder, transient `systemd-run` unit, zip upload, report |
| Surfaces | `apps/control-plane/src/routes/api/**`, `mcp.ts` | REST + MCP for environments, workloads, builds, domains, capacity |

Key invariants:

- A running app never changes node on its own. `auto` is resolved once at deploy time and recorded
  on the deployment/workload.
- Admission is `reserved + memoryMb ≤ sliceMemoryMb`; reserved counts `pending/starting/running`.
- **Secret values never enter desired state or its on-disk cache.** The agent fetches
  `GET /api/agent/workloads/:id/activation` with its node token at activation time.
- The control plane never executes user code. Builds run on a node marked `can_build`; deploys run
  through the privileged helper's fixed verbs.

---

## Workstreams

Each stream owns its files. Do not edit another stream's files, the foundation files above, or the
dashboard. Add new files rather than rewriting shared ones; keep `bun run --filter '<pkg>' check` and
targeted `bun test` green.

### A — Runtime execution (`apps/helper`, `apps/agent`)

- `apps/helper`: root Bun daemon on a root-only unix socket. Fixed verbs only. Renders systemd unit +
  socket unit from validated fields (never a shell string), enforces `DynamicUser`, `ProtectSystem=strict`,
  `NoNewPrivileges`, `MemoryMax`, CPU quota, `Restart=on-failure`, `skiff-workloads.slice`.
  Owns the slice budget (`MemoryMax`, `CPUWeight=200`).
- Agent runtime driver: converge `desiredState.workloads`, fetch activation, hand the unit to the
  helper, wait for health, report actual status in heartbeats. Static serving is unchanged.
- Files: `apps/helper/**` (new), `apps/agent/src/runtime*.ts` (new), `apps/agent/src/config.ts`,
  `apps/agent/src/main.ts`, `apps/agent/package.json` only if needed.
- Do **not** edit `apps/agent/src/caddy-config.ts` (stream B), `packages/core/**`, `packages/contracts/**`,
  `packages/db/**`.

### B — Custom domains (`packages/core/src/domains.ts`, `apps/agent/src/caddy-config.ts`)

- Finish the domain service: Cloudflare record creation/cleanup when a token is configured, apex↔www,
  drift detection on check, injected DNS/Cloudflare clients for tests.
- Agent: serve verified domains by cloning the project's production route with the custom host;
  `redirectTo` hosts 301; on-demand TLS with Caddy's `ask` pointing at `platformOrigin + /api/domains/ask`.
- New routes: `apps/control-plane/src/routes/api/v1/domains/**`,
  `apps/control-plane/src/routes/api/domains/ask/+server.ts`; CSRF exception in
  `apps/control-plane/src/lib/server/csrf.ts`.
- Do **not** edit `packages/core/src/{workloads,builds,environments,deployments,nodes}.ts`,
  `packages/contracts/**`, `packages/db/**`, or the agent's `main.ts`.
- Note: the catch-all `/api/v1/[...path]` intentionally returns 501 for `POST /domains`; the new
  static route wins for SvelteKit, so remove or leave that fallback without breaking it.

### C — Git builds + Builder (`packages/core/src/builds.ts`, `apps/builder`)

- Finish build finalization (store the release id, not the deployment id), claim/report races, logs.
- `apps/builder`: node-token daemon. Poll `GET /api/agent/builds/next`, clone into a temp dir, run the
  configured command in a **transient systemd unit** (`systemd-run`, memory/CPU caps, 10-minute
  timeout, one at a time), zip `outputDir`, PUT to the presigned URL, report. Direct execution
  fallback for development.
- New routes: `apps/control-plane/src/routes/api/agent/builds/**`,
  `apps/control-plane/src/routes/api/webhooks/github/[project]/+server.ts`,
  `apps/control-plane/src/routes/api/v1/projects/[slug]/{git,builds}/**`.
- Add `NodeService.setBuilder` + `POST /api/v1/nodes/:id/builder` (platform admin session).
- CSRF exceptions for the webhook prefix and agent prefix.
- Do **not** edit `packages/contracts/**`, `packages/db/**`, `packages/core/src/{workloads,domains,environments,deployments}.ts`,
  `apps/agent/**`.

### D — Environments + workload surfaces (`packages/core/src/environments.ts`, deploy/routes/MCP)

- Environment-aware deploys and promotion: `POST /projects/:slug/deploy { environment? }`,
  `POST /projects/:slug/environments/:env/promote`, environment hosts
  (`<slug>--<env>.<contentDomain>`), access mode per environment, routes in desired state.
- Workload REST + MCP: `GET/PUT/DELETE /api/v1/projects/:slug/workload`,
  `GET /api/v1/nodes/capacity`, MCP tools for environments and workloads.
- Files: `packages/core/src/environments.ts`, `packages/core/src/{deployments,nodes}.ts`,
  `packages/core/src/environments.test.ts`, `packages/contracts/src/api.ts` (environment field only),
  `apps/control-plane/src/routes/api/v1/projects/[slug]/**` (new env/workload routes),
  `apps/control-plane/src/routes/api/v1/[...path]/+server.ts` (deploy body only),
  `apps/control-plane/src/lib/server/mcp.ts`, `apps/control-plane/src/routes/api/v1/nodes/capacity/+server.ts`.
- Do **not** edit `packages/core/src/{workloads,domains,builds,placement}.ts`, `packages/db/**`,
  `packages/contracts/src/{workload,build,domain,environment}.ts`, `apps/agent/**`.

---

## Integration order

1. Foundation (done).
2. A/B/C/D (done): helper + agent runtime, custom domains, git builds + Builder, environments + surfaces.
3. Integration pass (done): API docs, protected custom-domain access, mandatory webhook secrets,
   `command`/`image` in desired state, per-node slice budget in desired state.
4. Remaining: installer/release wiring for `skiff-helper`, `skiff-builder`, the helper socket,
   `skiff-workloads.slice`, and node requirements (`systemd-run`, `podman` for tier 3); then the
   REST/MCP e2e against a dev server.
5. Example stress project: `examples/v2-stress` provisions a process or container workload through
   the public REST API and runs conformance/load checks against the live app (including desired
   state, JIT activation and `/data`). Use it as the integration gate while finishing item 4.

## Open decisions (record in `docs/DECISIONS.md` when settled)

- **Environment host shape**: `<slug>--<env>` (used here, fits the wildcard) vs `env.<slug>`
  (needs a second wildcard).
- **Per-preview app runtimes**: v2 runs one workload per project (the environment/production pointer).
  Running every preview would need per-deployment units; deferred.
- **Builder placement**: node flag today (`nodes.can_build`), with one job per Builder at a time.
- **Secret rotation**: activation version is a hash of refs + public spec; rotating a secret bumps
  the version at activation without a redeploy.
