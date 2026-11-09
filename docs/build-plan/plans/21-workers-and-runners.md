# 21 — Workers, replicas, app templates and GitHub Actions runners

**Priority:** P1 · **Effort:** M · **Lane:** C (runtime) + D (workflow) · **Wave:** 2
**Depends on:** F1 contracts (soft: 19 process groups shares the vocabulary)
**Primary files:** `packages/contracts/src/{workload,github-runner,templates}.ts`,
`packages/core/src/{workloads,github-runners,templates,nodes,logs}.ts`,
`apps/agent/src/runtime.ts`, `apps/helper/src/{validate,units,systemd}.ts`,
`apps/control-plane/src/routes/(dashboard)/{new/**,projects/[slug]/_components/WorkerCard}.svelte`,
`docs/RUNNERS.md`, D89–D93

## Goal

Deploy long-running applications that have no inbound traffic, starting with a GitHub Actions
self-hosted runner pool, with the same one-step ease as the other app types.

## Shipped

- `ingress: "none"` workers for process and container projects (D89): no route, port or HTTP probe.
- `replicas` 1–20 for workers, expanded in desired state as `<id>-r<n>` (D90).
- A first-party template catalog (D92): `GET/POST /api/v1/templates[/:id]`, a **From template**
  page per template (`/new/<id>`) generated from the template's fields and groups, and a `yoal-template.json` release so no upload is
  needed.
- The **GitHub Actions runner** template (D91, D93): repo or org scope, labels, runner group,
  replicas, PAT or GitHub App (pasted or an existing secret), ephemeral one-job containers,
  registration cleanup, pool status from GitHub (`GET /projects/:slug/runners`, Worker card).

## Later (seams kept)

- **Docker in jobs.** An opt-in per-pool rootless Podman socket mounted into the runner
  (`runner.containerJobs`). Needs a spike: nested rootless Podman, `/dev/fuse`, user namespaces on
  Debian 13, and what it means for isolation. Until then the runner has no capabilities.
- **Autoscale** from `workflow_job` webhooks (scale 0..N); needs a public webhook receiver.
- **GitHub Enterprise Server** (`runner.apiUrl`, https only, SSRF allowlist).
- **MCP / CLI / blueprint** support: `list_templates` / `create_from_template` (secret references
  only, never a pasted credential through MCP), `yoal templates`, and `ingress`/`replicas`/`runner`
  on blueprint services.
- More templates (other CI runners, common workers) as catalog entries, no dashboard change.
- Plan 19 process groups can reuse `ingress: "none"` and replica expansion for per-process workers.

## Acceptance

- Unit tests: contracts, core (mocked GitHub: JIT mint, cleanup, App JWT + token cache, rollback,
  deregistration, replica logs), agent (recycle, settle window, failed backoff), helper (units,
  validation).
- Real node (Debian 13): a repo pool of 2 registers, runs `runs-on: [self-hosted, linux]` jobs,
  each job on a fresh container; a revoked PAT surfaces on the Worker card; deleting the project
  removes the runners from GitHub.
