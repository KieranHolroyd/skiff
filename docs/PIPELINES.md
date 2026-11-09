# Yoal — Pipelines (a GitHub-Actions-shaped builder)

Status: **WP1–WP5 built 2026-11-08** (§14, §15); WP6 is built except microVMs on real KVM and
runner-pool autoscaling. Shipped proposals are **D148–D153 and D160–D162** (D151 amended).
Phases **WP0–WP6** (§11); spikes **WS1–WS7** (§10, results there). The registry, registry
credentials, digest pinning and job registry logins are [REGISTRY.md](./REGISTRY.md)'s (R1–R14,
D145–D147, D154–D159), not this document's: W7, W8 and W9's registry half defer to it.

Yoal can build a repository today, but only one way: clone, run one shell command for up to ten
minutes in a `systemd-run` sandbox, zip a directory, and deploy it as a static or process release
(D45, D47). It cannot build a container image, run anything in parallel or across architectures,
keep a cache, hold a signing key for a release job, or run a job that is not a deploy. Yoal's own
releases (agent, helper, CLI, Caddy, the Postgres images) are therefore built on GitHub Actions
(`.github/workflows/publish.yml`, `postgres-images.yml`).

This document plans **Pipelines**: workflows written in a GitHub-Actions-shaped YAML, run as jobs
on build nodes, producing images, binaries, artifacts and deployments. The test that it is done is
**dogfooding**: Yoal builds, signs and publishes its own node binaries and images on itself (§9).

---

## 1. Goals and non-goals

**Goals**

- Workflows in the repository (`.yoal/workflows/*.yml`) with jobs, steps, `needs` (a DAG),
  `strategy.matrix`, `if`, `env`, `secrets`, job outputs, `timeout-minutes` and `concurrency`.
  Someone who has written GitHub Actions can write one without reading docs.
- **OCI image builds without a Docker daemon and without root on the host** (README invariant 8),
  pushed to a registry Yoal runs, signed, with provenance, and deployable as a container project.
- **Native multi-architecture builds**: one job per architecture on a node of that architecture,
  combined into one image index. No QEMU in the default path.
- Artifacts, caches, logs and secrets are part of Yoal and use its existing seams: ObjectStore,
  org/project secrets, disks and default storage (STORAGE.md), EventService, notifiers, quotas.
- The existing git build becomes a one-job workflow, not a second build system (D2 still holds:
  one artifact → release → deployment path).
- Every surface Yoal has: dashboard, REST, CLI, MCP, so coding agents can trigger a run, read
  the failing step's log and push a fix.

**Non-goals**

- **Full GitHub Actions compatibility.** Marketplace actions that need the artifact v4 or cache v2
  Twirp protocols, the Docker daemon, or `api.github.com` stay on the GitHub runner pool Yoal
  already runs (RUNNERS.md, D91). Gitea and Forgejo still ship forked actions for these after
  years of work (§2.1).
- A general durable-workflow engine for applications. Workflows here are CI: finite, a DAG,
  triggered by code and people. The FEATURE-RESEARCH "Do not build" row still applies to app
  workflows; W16 narrows it.
- Kubernetes-style schedulers, autoscaling cloud runners, or a public action marketplace.

---

## 2. Research summary

### 2.1 What existing systems do

| System | Model | Lesson for Yoal |
|---|---|---|
| **Forgejo Actions / Gitea act_runner** (from nektos/act) | Runs GHA YAML. `uses:` resolves against a mirror (`DEFAULT_ACTIONS_URL`). Executors: docker, LXC, host (no isolation). Forgejo's runner moved to **GPL-3.0** (Sep 2025). | The usable "compatible subset" is `on`, `jobs`, `needs`, matrix, `if`, `env`, `secrets`, `run:`, composite and Node actions, `services`. Artifacts and cache needed custom backends **and** forked actions, because `upload-artifact@v4` refuses anything that looks like GHES. Gitea now ships `builtin:checkout`. |
| **nektos/act** | Needs a Docker API socket. Older versions had a cache server on all interfaces and an env-injection bug. | A Docker socket in the job is the thing Yoal will not provide. |
| **Woodpecker** (3.x) | Every step is a container; workflow DAG; `from_secret`; Docker, Kubernetes, local backends. | Container-per-step is clean but loses shared shell state that GHA users expect. Yoal keeps **container-per-job, process-per-step**. |
| **Buildkite** | Thin agents poll for work by tags; pipelines can be uploaded at runtime. | Label-based claiming over an outbound connection is exactly Yoal's agent model. |
| **Dagger** | Pipelines as code on BuildKit; needs Docker or Podman. | BuildKit is the right engine for images; the pipeline layer can stay ours. |
| **Depot** | One ephemeral BuildKit machine per build, persistent NVMe cache per project, native amd64 + arm64, no cache for fork PRs. | Copy this: per-scope cache, native arches, untrusted builds never write shared cache. |
| **GitHub-hosted, Blacksmith, actuated** | Fresh VM (or Firecracker microVM) per job. | Strongest isolation, but needs `/dev/kvm`: bare metal or nested virt. Hetzner Cloud has none; the prod host (Scaleway Dedibox, bare metal) probably does: WS5 checks. |

### 2.2 Building images rootless

| Option | Fit | Notes |
|---|---|---|
| **Rootless BuildKit** (`moby/buildkit:rootless`) | **Recommended** | Needs subuid ≥ 65 536, native overlay (kernel ≥ 5.11) or fuse-overlayfs. In a container it needs seccomp and AppArmor unconfined plus `systempaths=unconfined`; acceptable because buildkitd itself is non-root. `--oci-worker-no-process-sandbox` is **discouraged** (steps can kill or ptrace the daemon) and is not used. Ubuntu ≥ 24.04 needs `kernel.apparmor_restrict_unprivileged_userns=0`. Cache exporters: inline, registry, local. SLSA provenance and SBOM attestations built in; `--secret` mounts never reach provenance. |
| **Buildah / `podman build`** in a container | Fallback | Works with `--isolation chroot` + `vfs`. Slow (vfs copies layers) and chroot is weaker isolation. Podman 6 (June 2026, now under CNCF) needs Buildah 1.44, cgroups v2 and nftables. |
| **Kaniko** | No | Archived by Google June 2025; maintenance-only forks; runs as root in its container. |
| **QEMU binfmt multi-arch** | Escape hatch only | Slow and fragile for compilers. Native builders + an OCI index instead; binaries cross-compile (`bun build --compile --target`, Go, Zig, Rust). |

### 2.3 Registry

| Option | Fit | Notes |
|---|---|---|
| **zot** (CNCF, Apache-2.0) | **Recommended** | One static binary, no database. Local or S3 storage (so RustFS works), GC and retention policies, dedupe, sync/mirroring, cosign and notation verification, OCI referrers (signatures, SBOMs, provenance). Auth includes a bearer token server and **OIDC workload identity**: a job's ID token as the Bearer credential, with per-repository glob ACLs. |
| CNCF Distribution v3 | Possible | Plain registry, external token auth, offline-only GC. Fewer of the pieces we need. |
| Harbor | No | ≥ 2 CPU / 4 GB, Postgres, many services. |

### 2.4 What is in Yoal today (and what has to change)

- **No image build path.** A container project names a pre-built image (`workload.ts:151`); the
  helper only regex-checks it (`validate.ts:823`). There are **no registry pull credentials** at
  all, and only runner containers get `Pull=newer` (`units.ts:712`).
- **The build sandbox cannot run Podman**: `NoNewPrivileges`, `RestrictSUIDSGID`, an empty
  capability set and `PrivateDevices` block `newuidmap` and `/dev/fuse`, and `yoal-build` has no
  subuid range. Image builds need a different executor, not a looser sandbox.
- **No job heartbeat.** A claim expires 15 minutes after `claimedAt` and is requeued even if
  still running (`builds.ts:29,146`). Harmless with a 600 s timeout, fatal for an hour-long job.
- **One build per node, oldest first**, no labels or architecture matching (`builds.ts:200-226`).
- **One repository per project** (`git_sources` unique on project) and only `push` webhooks for
  the configured branch, always promoting. No CLI or MCP trigger.
- Reusable: the HMAC-checked webhook, envelope-encrypted secrets, `log_events`, the durable
  scheduler (`scheduler.ts`), `EventService`, notifiers, the `buildsPerDay` quota, the storage
  `builds` kind (and the planned `images` kind, STORAGE.md §8), and the ephemeral-container pattern of the GitHub runner (D91).

---

## 3. Proposed decisions

| ID | Proposal |
|---|---|
| **W1** | **Workflows are a strict, documented subset of GitHub Actions syntax**, read from `.yoal/workflows/*.yml` at the triggering commit (never from the default branch for a PR). Unknown keys are errors, not silently ignored. A separate directory keeps GitHub from also running them; `yoal workflow lint` and an import helper convert a `.github/workflows` file and list what will not carry over. |
| **W2** | **The parser and expression evaluator live in `@yoal/contracts`**, pure and shared by the control plane (planning, `if:` on jobs) and the in-job step runner (`if:` on steps, `${{ }}` in `run:`/`with:`/`env:`). The grammar and functions are specified in §5.3 and fuzz-tested; there is no `eval`. |
| **W3** | **A repository is an org resource** (`repositories`); projects link to one with a branch and an optional workflow. Pipelines hang off repositories, so a repo that deploys nothing (Yoal itself, a library) can still run workflows, and one repo can deploy many projects. Each existing `git_sources` row migrates to a repository + link. |
| **W4** | **Runs, jobs and steps are first-class rows with leases.** A job is claimed by a node whose labels satisfy `runs-on`, holds a 60 s lease renewed by a 15 s heartbeat, and is retried or failed when the lease lapses. This replaces the claim-age TTL. `timeout-minutes` defaults to 60 and is capped per org. |
| **W5** | **Each job runs in a fresh, unprivileged Podman container** started by the helper through a fixed verb (D43): `UserNS=auto`, all capabilities dropped, `NoNewPrivileges`, no Podman or Docker socket, cgroup memory/CPU/PIDs limits in a dedicated `yoal-builds.slice`, workspace on a per-job directory in the `builds` storage kind. Steps are processes run by `yoal-step` inside it, so the shell state, `$PATH` and files carry between steps as in GHA. |
| **W6** | **Images are built by a per-job rootless BuildKit sidecar**, never a shared daemon. The helper starts `buildkitd` (rootless image, pinned by digest, own user namespace, the WS1 security profile) next to the job, with a cache directory scoped to `(repository, trust)`; the job reaches it only through a unix socket in a shared volume. The `yoal/build-image` step drives it. Fallback when WS1 fails on a host: `buildah --isolation chroot` with `vfs`. |
| **W7** | *Owned by [REGISTRY.md](./REGISTRY.md) R4–R6, R12.* **Yoal runs one OCI registry: zot**, as a platform service with a helper-derived image (the D61 pattern), on the `images` storage kind, local disk or an org's RustFS bucket. Repositories are `<org>/<name>`. Pushes authenticate with the job's token (W9); nodes pull with a node-scoped token. Retention policies and scheduled GC are on from day one. Amends FEATURE-RESEARCH's "hosted registry" row, which was about a public marketplace, not a private store. |
| **W8** | *Built as D145/D146 ([REGISTRY.md](./REGISTRY.md) R1, R2).* **Container projects can pull from private registries**, Yoal's own or external (GHCR, Docker Hub, ECR). Org-level registry credentials are sealed with the org key; the helper writes a `0400` per-workload `auth.json` just in time (like D43 secrets) and passes `--authfile`. Deploys pin the **digest**, never a tag, so a rollback is exact and `Pull=` policy stops mattering. |
| **W9** | **Every job gets a short-lived, audience-scoped job token**: an Ed25519 JWT from the control plane (claims: org, repository, ref, sha, workflow, job, run, attempt, environment, trust), published via JWKS at `/.well-known/jwks.json`. Audience `yoal` reaches the job API (logs, outputs, artifacts, cache); audience `registry` is zot's bearer credential with ACLs for the repository's own image namespace; `id-token: write` mints an external OIDC token for cloud federation. The node token never enters a job. |
| **W10** | **Trust tiers decide secrets, cache and isolation.** `trusted`: push or dispatch on the repository itself. `untrusted`: pull requests from forks and anything the repository marks so. Untrusted jobs get no secrets, read-only access to the default-branch cache, write only their own scope, cannot push outside a `pr-<n>` image namespace, and run under gVisor once WS4 passes (W14). |
| **W11** | **Secrets reach a job only through its activation**, fetched with the job token after the claim, never in desired state (the D93 pattern). `yoal-step` and the host log pump both mask every secret value and its base64 and URL-encoded forms. Image builds get secrets only as BuildKit `--secret` mounts; `build-args` containing a secret name are refused. |
| **W12** | **Environments gate the dangerous secrets.** An environment (per repository: `production`, `release`, …) has its own secrets, allowed branches/tags, and optional required approvers. A job naming `environment: release` waits in `waiting` until the rules pass. The Yoal release-signing key lives only in such an environment (§9). |
| **W13** | **Artifacts, caches and logs live in the ObjectStore** (the control plane's, or an org's RustFS) with a simple REST API under the job token. **No Twirp.** `actions/upload-artifact`, `actions/download-artifact` and `actions/cache` at any version are aliased to the built-in `yoal/artifact` and `yoal/cache` steps (Gitea's `builtin:` idea), so most real workflows run unchanged. Defaults: artifacts 30 days, caches 7 days unused and 10 GB per repository, logs 90 days. |
| **W14** | **Isolation is a node capability, chosen per job.** `container` (W5) everywhere; `gvisor` (`--runtime runsc`) on nodes where WS4 passes; `microvm` (Firecracker/Kata) only on nodes that report `/dev/kvm`. A repository sets a minimum per trust tier; a job is never placed on a node below it. |
| **W15** | **The git build becomes an implicit workflow.** A project with a build command and no workflow file gets a generated one-job workflow (`checkout → run → yoal/deploy`) and keeps its current behaviour, dashboard and API. `builds` rows become runs; `/api/agent/builds` stays until every node runs the new runner. |
| **W16** | **Scope boundary.** Pipelines are CI: finite DAGs triggered by code, schedules, people and Yoal events. Durable app workflows, queues and sagas stay out (FEATURE-RESEARCH row kept, narrowed). GitHub-runner pools (D91) remain for workflows that need github.com's full feature set. |

---

## 4. Architecture

```
            push / pull_request / dispatch / schedule / yoal event
                                │
 GitHub ─ webhook (HMAC) ─▶ control plane ──────────────────────────────────────────────┐
 (or any git host)         │  parse .yoal/workflows at sha  → plan run (DAG, matrix)  │
                           │  pipeline_runs / jobs / steps, leases, environments       │
                           │  job tokens (JWKS), secrets activation, ObjectStore       │
                           │  check runs back to GitHub, events, notifiers, quotas     │
                           └──────────────▲──────────────────────────────┬─────────────┘
                     claim by labels,     │ heartbeat, logs, outputs,    │ zot (registry)
                     lease + activation   │ artifacts, cache (job token) │ push/pull (job/node token)
                           ┌──────────────┴──────────────────────────────▼─────────────┐
 build node (can_build)    │ yoal-runner (today's yoal-builder daemon, evolved)      │
                           │   └─ helper verb job/start ─▶ Podman, yoal-builds.slice │
                           │        ├─ job container (UserNS=auto, no caps)           │
                           │        │    └─ yoal-step: run steps, mask, outputs       │
                           │        ├─ buildkitd rootless sidecar (only if needed)    │
                           │        └─ service containers (postgres, redis…) on a    │
                           │           per-job network                                │
                           └───────────────────────────────────────────────────────────┘
```

### 4.1 Control plane

- **Planner**: on a trigger, fetch the workflow files at the commit (via the repository's
  credential; GitHub contents API or a shallow `git fetch` on a build node for other hosts), parse
  (W1, W2), filter by `on:` (branches, tags, paths), expand matrices, and write one run with its
  jobs in `pending`/`queued`. `concurrency` groups cancel or queue older runs.
- **Scheduler**: a job becomes `queued` when every `needs` succeeded (or per `if:`), and its
  `outputs` and the `needs` context are frozen into its plan. Runs on the existing maintenance tick
  plus an immediate pass on every job transition.
- **Claim API** (node token): `POST /api/agent/jobs/claim {labels, capacity, isolation[]}` returns
  the job plan or nothing; long-poll up to 30 s to keep latency low without a socket.
- **Job API** (job token): `heartbeat`, `steps/:i` (status), `logs` (batched), `outputs`,
  `artifacts` (presigned PUT/GET), `cache` (lookup by key and restore-keys, presigned), `secrets`
  (once, after claim), `oidc` (mint external token), `complete`.
- **Integrations**: GitHub check runs and commit statuses through a GitHub App (FEATURE-RESEARCH
  P0 row: "GitHub App with sticky PR comment, commit check, deployment status"), EventService
  source `pipelines` (`run.started|completed|failed`, `job.waiting`), notifiers for failures on
  the default branch.

### 4.2 Build node

- `yoal-builder.service` becomes **`yoal-runner`** (same binary, same root-only-to-launch
  rule as D47). It advertises labels: `os` (`linux`), `arch` (`x64`/`arm64`), node labels from
  CLUSTERING (`zone`, custom), and capabilities (`oci-build`, `gvisor`, `kvm`, `gpu`).
- **Capacity replaces "one at a time"**: `maxJobs` and a memory budget for `yoal-builds.slice`
  (default: half the workload budget on a `build`-only node, one job of 2 GB on an ingress node,
  per CLUSTERING's "must not starve ingress").
- Each job: the helper creates the per-job directory, network and containers from **validated
  fields only** (image ref, limits, mounts the helper chooses itself), the same shape as the D91
  runner profile. The runner daemon never runs `podman` as root itself.
- **Job image**: `yoal/runner-base` (Debian, git, curl, Node LTS, Bun, `buildctl`, `yoal-step`,
  `cosign`), built and published by Yoal's own pipeline. A job may set `container: <image>`;
  `yoal-step` is bind-mounted read-only in, so any glibc image works.
- **Teardown** always runs: stop sidecars and services, remove the network, delete the workspace,
  return capacity. A runner restart reaps orphaned `yoal-job-*` units before claiming.

### 4.3 Images

`yoal/build-image` wraps `buildctl`:

```yaml
- uses: yoal/build-image@v1
  with:
    context: .
    file: apps/api/Dockerfile
    tags: registry/acme/api:${{ yoal.sha }}   # "registry/" expands to Yoal's zot
    platforms: native                          # this job's arch only; see multi-arch below
    secrets: |
      npmrc=${{ secrets.NPM_TOKEN }}
    cache: true                                # zot-backed registry cache, scoped (W10)
    provenance: mode=min                       # mode=max is opt-in: it records build args
    sbom: true
    sign: true                                 # cosign with the org's signing key (W-later)
```

Outputs: `digest`, `image` (`registry/…@sha256:…`). **Multi-arch** is a matrix over `runs-on`
labels plus `yoal/image-index`, which writes one OCI index from the per-arch digests.
**Cache** uses BuildKit's registry exporter into `<org>/<repo>/cache:<scope>`; scopes are
`(repository, trust, branch-or-default)` so a PR reads main's cache and never writes it.

### 4.4 Deploying from a pipeline

`yoal/deploy` targets a project the repository is linked to:

- **container project**: `image: ${{ steps.build.outputs.image }}` (a digest) → new release,
  normal deployment, preview or promote by input.
- **static / process project**: `path: dist` → zips and uploads exactly like today's builder.
- **function project**: `path:` a bundle directory, or runs `yoal deploy` semantics (D113).

The deploy call uses the job token with a `deploy` scope that exists only when the repository link
grants it and, if configured, only inside an environment (W12). That is how "deploy only from
`main` after tests pass" is expressed, instead of webhook-always-promotes.

---

## 5. Workflow format

### 5.1 Example

```yaml
# .yoal/workflows/ci.yml
name: ci
on:
  push: { branches: [main] }
  pull_request: {}
  workflow_dispatch:
    inputs: { promote: { type: boolean, default: false } }

concurrency: { group: 'ci-${{ yoal.ref }}', cancel-in-progress: true }

jobs:
  test:
    runs-on: [linux]
    steps:
      - uses: actions/checkout@v4          # built-in alias, no github.com API needed
      - uses: actions/cache@v4             # aliased to yoal/cache
        with: { path: ~/.bun/install/cache, key: "bun-${{ hashFiles('bun.lock') }}" }
      - run: bun install --frozen-lockfile && bun test
    services:
      postgres: { image: postgres:17, env: { POSTGRES_PASSWORD: test } }

  image:
    needs: test
    strategy: { matrix: { arch: [x64, arm64] } }
    runs-on: [linux, "${{ matrix.arch }}", oci-build]
    outputs: { digest: "${{ steps.b.outputs.digest }}" }
    steps:
      - uses: actions/checkout@v4
      - id: b
        uses: yoal/build-image@v1
        with: { tags: "registry/acme/api:${{ yoal.sha }}-${{ matrix.arch }}" }

  deploy:
    needs: image
    if: yoal.ref == 'refs/heads/main'
    environment: production
    runs-on: [linux]
    steps:
      # yoal/image-index (one OCI index from the per-arch digests) is WP5; until then deploy one arch.
      - uses: yoal/deploy@v1
        with: { project: api, image: "registry/acme/api:${{ yoal.sha }}-x64", promote: true }
```

### 5.2 Supported subset (v1)

| Area | Supported | Not (yet) |
|---|---|---|
| Triggers | `push`, `pull_request` (+ `types`), `workflow_dispatch` with typed `inputs`, `schedule` (cron, via the durable scheduler), `yoal_event` (EventService: deployment failed, backup done…) | `workflow_run`, `repository_dispatch`, `workflow_call` (WP4) |
| Filters | `branches`, `tags`, `paths`, `-ignore` variants | |
| Jobs | `needs`, `if`, `runs-on` (labels), `strategy.matrix` incl. `include`/`exclude`, `fail-fast`, `max-parallel`, `outputs`, `env`, `defaults.run`, `timeout-minutes`, `continue-on-error`, `concurrency`, `environment`, `container`, `services` | `permissions` (accepted, mapped to job-token scopes), `uses:` reusable workflows (WP4) |
| Steps | `run` (bash/sh, `shell:`), `uses` (built-ins; composite and Node actions in WP4), `with`, `env`, `id`, `if`, `working-directory`, `continue-on-error`, `timeout-minutes` | Docker-container actions |
| Files | `$YOAL_OUTPUT`, `$YOAL_ENV`, `$YOAL_PATH`, `$YOAL_STEP_SUMMARY`, with `GITHUB_*` aliases so existing scripts work | |

### 5.3 Expressions

Contexts: `yoal` (alias `github`: `sha`, `ref`, `ref_name`, `event_name`, `event`, `repository`,
`run_id`, `run_attempt`, `actor`, `workspace`), `env`, `vars`, `secrets`, `inputs`, `matrix`,
`strategy`, `needs`, `steps`, `job`, `runner`. Operators `! < <= > >= == != && ||`, property and
index access, literals. Functions: `contains`, `startsWith`, `endsWith`, `format`, `join`,
`toJSON`, `fromJSON`, `hashFiles`, `success`, `failure`, `always`, `cancelled`. GitHub's
loose-equality and implicit `success() &&` rules are followed exactly and pinned by a test table
taken from GitHub's documentation.

---

## 6. Data model

```text
repositories(id, org_id, name, provider: github|gitea|generic, clone_url, default_branch,
             credential_ref, webhook_secret_enc, settings json)            -- W3
project_repository_links(project_id, repository_id, branch, workflow, deploy_grant)
pipeline_runs(id, repository_id, workflow_path, workflow_name, event, ref, sha, actor,
              trust, inputs json, status, conclusion, attempt, concurrency_group,
              created_at, started_at, finished_at)
pipeline_jobs(id, run_id, key, name, matrix json, needs json, runs_on json, isolation,
              environment, status, conclusion, node_id, lease_expires_at, attempt,
              outputs json, plan json, started_at, finished_at)
pipeline_steps(job_id, idx, name, status, conclusion, started_at, finished_at, log_key)
pipeline_artifacts(id, run_id, job_id, name, object_key, size, digest, expires_at)
pipeline_caches(repository_id, scope, key, version, object_key, size, last_used_at)
environments(id, repository_id, name, allowed_refs json, approvers json, wait_minutes)
environment_secrets(environment_id, name, value_enc)                       -- sealed, org key
registry_credentials(id, org_id, registry_host, username, secret_enc)      -- W8
images(id, org_id, repository, digest, tags json, platforms json, run_id, signed, created_at)
nodes.runner_labels json, nodes.runner_capacity json
```

Statuses: run `queued → in_progress → completed` with conclusion `success|failure|cancelled|
skipped|timed_out`; job adds `waiting` (environment) and `pending` (needs). Logs: live lines go
to `log_events` (`source: 'pipeline'`) for SSE tailing; each finished step is compressed into one
object (`logs/<run>/<job>/<idx>.log.zst`) and its `log_events` rows pruned, so large CI logs never
bloat SQLite (today's 2 MB build-log cap goes away).

---

## 7. Security model

| Threat | Mitigation |
|---|---|
| Job escapes to the host | W5 container (userns, no caps, no socket); W14 gVisor/microVM tiers; helper builds every unit from validated fields; the BuildKit sidecar runs in its own user namespace with no host mounts except its scoped cache. |
| Fork PR steals secrets or poisons images | W10: untrusted jobs get no secrets, no deploy scope, no write to shared cache, push only to `pr-<n>`; workflow files are read from the PR head but **environment rules come from the default branch**. Optional "approve to run" for first-time contributors. |
| Secrets in logs or images | W11 masking (raw, base64, URL-encoded); BuildKit `--secret` only; `provenance: mode=min` by default because `max` records build args. |
| Token theft from a job | Job tokens expire at job end + 5 min, are audience-scoped and revoked on completion; the node token never enters the job; OIDC tokens carry `sub = repo:<org>/<repo>:ref:<ref>` (or `:environment:<env>`) so external trust policies can pin them. |
| Release key misuse | Signing key only in an environment limited to `v*` tags with an approver; `cosign` signs by digest; the updater keeps verifying against compiled-in keys (D128), so a compromised pipeline alone cannot ship an update that nodes accept unless it also has the environment's key. |
| Resource exhaustion | `yoal-builds.slice` budget, per-org concurrent-job and minutes quotas (extends `buildsPerDay`), job timeouts, workspace and cache size caps, registry retention and GC. |
| Webhook forgery | Existing per-repository HMAC secret (D45), now on the repository row. |

---

## 8. Surfaces

- **Dashboard**: Repositories list; per repository **Runs** (filters by workflow, branch, event,
  status), run page with a DAG view of jobs, live step logs (SSE), re-run all / failed jobs,
  cancel, approve an environment wait, artifacts download; **Images** page per org (tags,
  digests, platforms, signature, linked run, "deploy to project"); Settings → **Runners** (node
  labels, capacity, isolation tiers) and **Registries** (external credentials).
- **REST**: `/api/v1/repositories[/:id]/{runs,workflows,environments,caches}`,
  `/runs/:id/{jobs,logs,artifacts,rerun,cancel}`, `/images`. OpenAPI as for everything else.
- **CLI**: `yoal run list|view|watch|logs|rerun|cancel`, `yoal workflow dispatch <wf> -f k=v`,
  `yoal workflow lint [--import .github/workflows/x.yml]`, `yoal image ls|inspect`. Later
  `yoal workflow run --local` executes a job on the developer's Podman with the same step runner.
- **MCP** (task-shaped, for coding agents): `list_runs`, `get_run` (jobs + failing step + last
  200 log lines), `dispatch_workflow` (inputs; no secrets), `rerun_failed`. Agents never receive
  secret values or job tokens.

---

## 9. Dogfooding: Yoal builds Yoal

The acceptance test for WP5 is porting `publish.yml` and the image workflows:

1. `matrix: arch [x64, arm64]` on `runs-on: [linux, ${{ matrix.arch }}]`: the edge (x64) and
   `linux-box` or an ARM node. `bun build --compile` for agent, helper, CLI, updater; xcaddy
   Caddy (Go cross-compiles, so one node could do both arches).
2. Tests and `scripts/release/ci-canary.sh` in the job container, which already matches the
   production sandbox better than a GitHub VM does.
3. `environment: release` (tags `v*` only, approver required) holds
   `YOAL_RELEASE_SIGNING_KEY` and a GitHub token; `scripts/release/manifest.ts` signs; `gh
   release create --prerelease` publishes. `promote.yml` becomes a `workflow_dispatch`.
4. `yoal/build-image` builds `docker/postgres*` and `yoal/runner-base` natively per arch,
   `yoal/image-index` joins them, push to zot and mirror to GHCR (`skopeo copy` with a GHCR
   token in the environment).
5. GitHub Actions stays as the **fallback builder** for one release cycle: both pipelines run on
   the same tag and the manifests must match byte-for-byte except signatures. The bootstrap rule
   holds: Yoal can always be rebuilt from GitHub Actions if every Yoal node is gone.

---

## 10. Spikes (WP0)

| ID | Question | Pass when |
|---|---|---|
| **WS1** | Rootless BuildKit sidecar under rootful Podman with `UserNS=auto` on Debian 13 and Ubuntu 24.04 (AppArmor userns sysctl), native overlay, no `no-process-sandbox`. | A multi-stage Dockerfile builds, pushes to zot with registry cache, and a second build is a full cache hit; documented exact Quadlet keys. |
| **WS2** | Buildah `--isolation chroot` + `vfs` fallback in the W5 job container. | Same Dockerfile builds; time recorded vs WS1. |
| **WS3** | zot on local disk and on RustFS, bearer auth from a Yoal-signed JWT (JWKS), per-repo ACLs, retention + GC, referrers for cosign signatures and SBOMs; memory footprint. | Push/pull/sign/verify works; idle RSS < 100 MB. |
| **WS4** | gVisor `runsc` as a Podman runtime for job containers with `UserNS=auto`; BuildKit under it or not. | `bun test` and a Node build pass; known breakages written down. |
| **WS5** | `/dev/kvm` on prod (Dedibox), `linux-box`, and an Unraid VM with host-passthrough; Firecracker boot of the job image. | Yes/no per host, boot time. |
| **WS6** | `yoal-step` in a container: streaming logs to the runner over stdout framing, masking throughput, `$YOAL_OUTPUT`/`$GITHUB_OUTPUT`, `services:` on a per-job Podman network with DNS names. | A workflow with a Postgres service passes; masked secret never appears in stored logs. |
| **WS7** | Node actions: run `actions/setup-node` and `actions/checkout` with `INPUT_*` and `GITHUB_*` env and files, no api.github.com dependency. | Both work against a private repo using the repository credential. |

### Results (2026-11-08)

Run on a rootful Podman machine (Fedora CoreOS 44, aarch64, Podman 6.1.4, SELinux enforcing) with
the helper driver's real argv. Not yet repeated on Debian 13 / Ubuntu 24.04 (AppArmor).

| Spike | Result |
|---|---|
| WS1 | **Pass** with `label=disable` (SELinux otherwise blocks BuildKit's `/proc` mount per `RUN`). Multi-stage build 5.9 s; the same scope's second job a full cache hit in 1.4 s; BuildKit ready in 0.4 s. No `no-process-sandbox`. Registry cache to zot not exercised. |
| WS2 | **Pass.** `buildah --isolation chroot` + vfs in the `oci-build` profile: 7.2 s cold. |
| WS3 | Owned by REGISTRY.md (S1–S3 there). |
| WS4 | **Pass** with `label=disable` for runsc. `npm install` + `tsc` 4.8 s vs 3.7 s under runc. Upstream now ships `runsc` inside `gvisor.tar.bz2`. BuildKit builds under runsc, but its container removal fails on gVisor's filestore cleanup, so the sidecar stays on runc. |
| WS5 | No `/dev/kvm` in an Apple-hypervisor VM; Kata not tried. Kata 3 ships only a containerd shim that Podman cannot use, so the `microvm` tier is detected but effectively unavailable until a Podman-usable Kata runtime is installed. Prod (Dedibox) and `linux-box` not probed. |
| WS6 | **Pass.** Postgres 17 service healthy, aliases resolve, 6.1 s; the job token is not in `/proc/1/cmdline`. |
| WS7 | **Pass** in development: the step runner fetched and ran the real `actions/setup-node@v4` from codeload (the test was then made offline). |

---

## 11. Phases

| Phase | Ships | Decisions |
|---|---|---|
| **WP0** | Spikes WS1–WS7; written results here. | — |
| **WP1 — Engine core** | Repositories + links (migration from `git_sources`); parser + evaluator in contracts; runs/jobs/steps with leases and heartbeats; label-based claim with capacity; helper `job/start|stop` verbs and the job container; `yoal-step` with `run:` steps, masking, outputs; logs to `log_events` + object archive; secrets activation; push + dispatch triggers; implicit workflow for existing projects (W15); dashboard run list and run page; REST + CLI `run`/`dispatch`. | W1–W5, W11, W15 |
| **WP2 — Images and registry** | zot platform service on the `images` storage kind; job tokens + JWKS; BuildKit sidecar + `yoal/build-image`; registry cache; `yoal/deploy` of a digest; private pulls with `auth.json` and digest pinning, external registry credentials; Images page. | W6–W9 |
| **WP3 — Real CI** | Matrix, `needs` outputs, `services`, artifacts and cache (+ `actions/*` aliases), `concurrency`, `pull_request` with trust tiers, environments with approvals, GitHub App check runs and PR comment, `schedule` and `yoal_event` triggers, EventService source, quotas in minutes. | W10, W12, W13 |
| **WP4 — Compatibility** | Composite and Node actions fetched by pinned SHA (mirror cache in zot as OCI artifacts), reusable workflows (`workflow_call`), `yoal workflow lint --import`, `yoal workflow run --local`. | — |
| **WP5 — Dogfood** | §9: Yoal's release, images and runner-base built on Yoal; cosign signing, SBOM + provenance; `yoal/image-index`; GitHub Actions kept as fallback for one cycle. | — |
| **WP6 — Isolation and scale** | gVisor tier, microVM tier on KVM nodes (W14); per-repository minimum tiers; MCP tools; optional autoscaling of GitHub runner pools from the same claim queue. | W14, W16 |

WP1 alone already replaces today's builder with something strictly more capable (parallel jobs,
long jobs, labels, multi-step), so it is worth shipping before images exist.

---

## 12. Risks

1. **Compatibility creep.** Every unsupported GHA feature looks small. Hold the W1 line: an
   unknown key is an error with a pointer to the GitHub runner pool.
2. **BuildKit security profile.** Unconfined seccomp/AppArmor for the sidecar is the price of
   rootless BuildKit in a container. Keep it per-job, non-root, scoped cache only, and gate
   untrusted builds behind gVisor or buildah once WS4 says which works.
3. **Disk growth.** Registry layers, BuildKit caches, artifacts and logs all grow. Retention and
   GC defaults ship in the same phase as the thing that stores data, with disk placement through a
   storage kind and a usage card per repository.
4. **Cache poisoning across trust tiers.** Scopes are part of the cache key and the registry ACL,
   not a convention.
5. **Builder starving ingress** on single-node installs. Default capacity on an ingress node is
   one 2 GB job, and `yoal-builds.slice` has lower CPU weight than workloads.
6. **Subuid overlap.** Job containers, BuildKit's nested namespace and app containers all draw
   from subuid ranges; the helper must allocate non-overlapping ranges (WS1 documents this).

## 13. Open questions

1. Do pipelines need non-GitHub hosts at launch (Gitea/Forgejo webhooks, plain git with polling),
   or is GitHub-first with a generic `provider` column enough?
2. Should zot be one per install (control node) or placeable on any node like object storage,
   with a pull-through mirror per node later?
3. Org signing keys: Yoal-managed cosign key per org, or bring-your-own (KMS) only?
4. Is a hosted ARM node available for native arm64, or does WP5 rely on Go/Bun cross-compiles
   plus QEMU for the arm64 images only?
5. Billing of build minutes in showback (plan 16): count wall time or CPU time?

---

## 14. What is built (WP1, 2026-11-08)

| Piece | Where |
|---|---|
| Wire contract, built-in action names and `actions/*` aliases | `packages/contracts/src/pipeline.ts` |
| Workflow parser, trigger/glob matching, matrix, dispatch inputs (W1) | `packages/contracts/src/pipeline-workflow.ts` |
| `${{ }}` evaluator (W2) | `packages/contracts/src/pipeline-expr.ts` |
| Tables (migration 0071) | `pipeline_repositories`, `_triggers`, `_runs`, `_jobs`, `_steps`, `_log_lines`, `_artifacts`, `_caches`, `_secrets`, `_variables`, `_environments`, `_project_links`, `_deploys` |
| Engine: resolve → runs, DAG, matrix, max-parallel, fail-fast, concurrency, leases, environments, approvals, cancel, re-run, artifacts, caches, deploys, retention | `packages/core/src/pipeline-engine.ts` |
| Repositories, secrets, variables, environments, deploy targets, dispatch, GitHub webhook (push, pull_request, ping), schedules, views | `packages/core/src/pipelines.ts` |
| Node protocol `POST /api/agent/pipelines/claim`; job-token API `/api/pipeline/*`; REST `/api/v1/repositories/**`; webhook `/api/webhooks/pipelines/:id` | `apps/control-plane/src/routes/…` |
| Runner on build nodes (resolve, executor, Podman or sandbox isolation, heartbeats) and the in-job step runner (`yoal-agent pipeline-step`) | `apps/builder/src/pipeline/` |
| Dashboard (Pipelines), CLI (`yoal repo/run/workflow/secret/var`), MCP tools | control plane, `apps/cli` |

**How the pieces differ from §3–§4 as first written**

- **Resolving is a node job.** The control plane never clones. A trigger is claimed by a build node
  (`kind: "resolve"`), which reads `.yoal/workflows/*` at the commit with its own git credentials
  and posts the files back; the control plane parses them and creates the runs. This works for any
  git host. The default branch's `schedule:` crons are remembered on the repository row so the
  minute tick never clones.
- **Job tokens are opaque** (`pjt_…`, stored as a sha256), valid while the job runs plus five
  minutes for the final log flush. W9's JWT/JWKS form (external OIDC, registry bearer) comes with
  the registry's token realm (REGISTRY.md R6).
- **Placeholders, then expansion.** Each job key starts as one `pending` row; when its `needs` are
  done, its `if:` and matrix are evaluated against `needs.*` and it is replaced by one row per
  combination. That is what lets `matrix: ${{ fromJSON(needs.plan.outputs.targets) }}` work.
- **Lost runners fail, they are not retried.** A job whose lease lapses fails with "the runner
  stopped responding", because it may already have deployed or pushed. Resolves are retried.
- **Permissions reuse `build:*`.** `build:read` views; `build:create` dispatches and manages
  repositories; `build:cancel` cancels; secrets also need `secret:create`; linking a deploy target
  needs `deployment:promote`; environment rules and approvals need an org owner or admin, and never
  an MCP principal.
- **Logs live in SQLite** (`pipeline_log_lines`, 50 000 lines per job, 90 days), not the object
  store archive §6 describes. Moving finished logs to the object store is a follow-up.

**Not built yet:** W6's per-job BuildKit sidecar (the step runs `buildctl` against `BUILDKIT_HOST`
or falls back to Buildah, pending WS1/WS2), composite and JavaScript actions (WP4), reusable
workflows, GitHub check runs and PR comments, `yoal_event` triggers, gVisor and microVM isolation
(W14), quotas in build minutes (runs share the `buildsPerDay` guard), and porting Yoal's own
release workflow (WP5).

---

## 15. What was built for WP2–WP6 (2026-11-08)

| Piece | Where | Decision |
|---|---|---|
| Job containers through helper verbs (`/v1/pipeline/capabilities`, `jobs/start\|stop\|cleanup`, status, list); `auto` isolation picks containers when the helper answers | `apps/helper/src/pipeline-jobs.ts`, `apps/builder/src/pipeline/{helper-client,executor,loop}.ts` | D151 |
| Per-job rootless BuildKit sidecar with trust-scoped cache; `buildctl` mounted read-only | helper, `apps/builder/src/pipeline/image-build.ts` | D160 |
| `yoal/build-image` BuildKit-first (registry cache, `--secret`, provenance, SBOM; buildah/podman/docker fallbacks), `yoal/image-index` (OCI client, per-arch index), `yoal/oidc-token` | `apps/builder/src/pipeline/{actions,image-build,image-registry}.ts` | D160, D162 |
| Isolation tiers: node runtimes in the claim, repository minimums, runtime per job | contracts, `packages/core/src/pipeline-engine.ts` (`offeredTiers`, `requiredTier`, `chooseTier`) | D160 |
| Reusable workflows (inlining, inputs, secret maps, outputs over `jobs`) | `packages/core/src/pipeline-calls.ts`, parser | D161 |
| Remote, local, composite and Node actions with pre/post | `apps/builder/src/pipeline/remote-actions.ts` | D161 |
| GitHub commit statuses, OIDC issuer + JWKS, `yoal_event` triggers, step summaries, quota | `packages/core/src/{pipeline-status,pipeline-oidc}.ts`, `events.ts`, migration 0074 | D162 |
| `yoal workflow run --local` and `yoal workflow lint --import` | `apps/cli/src/pipelines-local.ts`, `pipelines.ts` | — |
| Yoal's own release on Yoal: `.yoal/workflows/publish.yml`, `runner-image.yml`, `docker/runner/Dockerfile` | repository root | — |

**Verified on real Linux** (`E2E_VM=yoal-spike bun tests/e2e/pipelines-linux.e2e.ts`). The
installer's own `yoal-helper` and `yoal-builder` units ran compiled linux-arm64 binaries against a
mirror of the control-plane routes. Rootful Podman VM, Fedora CoreOS 44, SELinux enforcing:

| Scenario | Result |
|---|---|
| outputs → `needs`, secret masking, artifacts across jobs, cache save + restore (node:24 job image, runc) | pass, 5.5 s / 5.0 s |
| `services:` postgres 17 with a health command, reached by name | pass, 6.5 s |
| `yoal/build-image` through the per-job BuildKit sidecar; second run fully `CACHED` | pass, 6.5 s / 5.5 s |
| repository minimum `gvisor`: the job runs under runsc (`4.19.0-gvisor`) | pass, 2.5 s |
| cancel a running job: `always()` step runs, conclusion `cancelled`, nothing left behind | pass, ~10 s (one heartbeat) |

SELinux hosts are not supported (D27), and there the helper unit's `NoNewPrivileges=yes` stops
podman/conmon/crun from entering their container domain, so crun's device filter is refused. The
test VM gets a drop-in turning it off; the production unit keeps it. Debian and Ubuntu (AppArmor)
are still to be run, along with image pushes and the registry cache, untrusted cache scopes, x86_64,
timeouts and OOM kills, lost leases, concurrent jobs, and musl job images (the step runner is a glibc
binary, so Alpine job images will not work).

**Not built, deliberately or for lack of hardware**

- **MicroVM tier on real KVM.** Detection and routing exist; no Podman-usable Kata runtime was
  available to test (WS5).
- **Autoscaling GitHub runner pools** from `workflow_job` webhooks (WP6 option). Pipelines cover the
  self-hosted CI case; RUNNERS.md pools stay fixed-size.
- **W15, git builds as implicit workflows.** The existing git builder keeps its own path; moving it
  would change a production deploy path for no new capability. Repositories can do the same with a
  one-job workflow and `yoal/deploy`.
- **Job logs in the object store.** They stay in SQLite (D153); moving them would make every log
  read asynchronous.
- **GitHub App check runs and PR comments**, remote reusable workflows, a matrix on a reusable-
  workflow call, an action mirror in the registry.
- **The release canary** (`scripts/release/ci-canary.sh`) needs root and `systemd-run`, which a job
  container does not have, so the ported `publish.yml` stops there by design until the canary has a
  container-safe mode. GitHub Actions stays the release builder until then (§9 point 5).
