# Skiff v2 — Dashboard guide

For operators who know the v1 dashboard: where v2 appears ([V2-BACKEND.md](./V2-BACKEND.md)), the
multi-screen flows, and deliberate limits. Rationale: [DESIGN.md](./DESIGN.md), [DECISIONS.md](./DECISIONS.md).

| Surface  | Route              | Purpose                                                                    |
| -------- | ------------------ | -------------------------------------------------------------------------- |
| Projects | `/projects`        | Create by runtime + placement; production state                            |
| Project  | `/projects/<slug>` | Deployments, Environments, Builds, Domains, Runtime, Share links, Settings |
| Nodes    | `/nodes`           | Platform-admin fleet: slice capacity, draining, Builder role               |

## Projects list

`New project` takes name, optional slug, **runtime** (`static` / `process` / `container`),
**placement** (`edge` / `auto` / node) and production + preview access (defaults `public` /
`platform`). Runtime is only an intent: nothing deploys and no workload starts until the first
deploy. Node choices come from capacity, so they are complete only for platform admins; others
choose `edge` or `auto`. `auto` resolves once at deploy time and is recorded on the deployment, so a
running app never moves by itself. The table shows runtime icon, placement and `Live` / `Not
deployed`.

## Project navigation

Header shows runtime and placement badges. Sections live in a sticky rail beside the content on wide
screens and in a scrollable pill row on narrow screens: **Monitor** (Traffic, Logs), **Ship**
(Deployments, Environments, Builds, Source) and **Configure** (Domains, Runtime, Share links,
Settings). Every section is deep-linkable with `?tab=`, the active pill survives reloads, and quiet
counters show section size. The primary **Deploy** action accepts a `.zip` of an already-built artifact (contents of the output directory,
not the folder) and deploys it to a chosen environment, with an optional message and
promote-on-success. It is subject to the same 500 MB / 20,000 files / 25 MB per-file limits as the
CLI. For repositories, use **Builds** instead.

### Environments

`production` is built in at `<slug>.<contentDomain>`; every other environment answers on
`<slug>--<env>.<contentDomain>` (D44).

- `New environment`: name, optional slug, access (`public` / `password` / `platform`).
- Each card shows host, access and its current deployment pointer.
- `Promote` moves that environment's pointer to an existing **active** deployment. Code and config
  move together; non-production pointers never touch the production pointer.
- `Roll back` returns to the previously promoted deployment. Edit (name/access) and delete exist for
  non-production environments only; delete requires the environment to be empty first.
- **v2 runs one workload per project.** For process/container projects only the latest deployment is
  active: deploying to any environment switches the running app, and every environment host and
  preview URL proxies to it. Environment pointers do not run separate copies; promoting to
  production moves the workload back to that release.

### Builds

- **Git source**: repository, branch, root dir, build command, output dir, `enabled` toggle and an
  optional webhook secret (≥16 chars; unsigned GitHub deliveries are rejected). Private repos need a
  Builder-side deploy key; there is no per-project credential in the UI.
- Webhook URL: `https://<platform>/api/webhooks/github/<slug>` (copy button). Use the same secret in
  GitHub.
- `Build now` builds the configured branch or an explicit branch/tag/commit; “promote to production
  on success” is ticked by default.
- Rows show status, ref, commit, start, duration; open a log dialog or cancel while `queued` /
  `building`. One job per Builder, 15-minute abandoned-claim requeue, 10-minute build cap.

### Source

`Source` is a read-only IDE for a deployment's immutable release artifact. It uses the manifest in
SQLite as the file index and lazily extracts individual entries from the stored zip, so browsing
does not unpack the whole artifact or write anything to disk.

- Pick any deployment from the release picker; production is selected by default. The header shows
  the release SHA, file count and artifact size.
- The explorer has collapsible folders and a path filter. `⌘P` / `Ctrl P` quick-opens a file and
  `⌘B` / `Ctrl B` toggles the explorer.
- Monaco opens each file in a tab and keeps per-file cursor and scroll state. Syntax highlighting
  covers the common web languages; word wrap, minimap and sticky scroll are in the toolbar.
- Raster images get a zoomable preview. SVG is shown as XML and everything else as text; files over
  2 MB and non-previewable binaries offer a download instead.
- **Download .zip** returns the original artifact and **Open site** opens the deployment URL.

Reading source requires `deployment:read`; there is no write path. File responses are
`text/plain` (or an image type only for raster previews) with `nosniff` and a sandbox CSP, so
deployed content can never execute on the platform origin.

### Domains

- `Add domain`: hostname (apex or subdomain, no scheme/port/path) and an optional “create `www` and
  redirect to the apex”.
- Unverified domains show two records with copy buttons: the **TXT** proof, and the traffic target —
  **A** when the content domain is an IP, otherwise **CNAME** to `<slug>.<contentDomain>`.
- `Check DNS` verifies **on demand** (the UI never polls); verified domains route to production and
  Caddy issues a certificate on the first request. `lastError` is shown as a warning.
- **Custom domains serve the production route.** Environment hosts are separate; per-environment
  domains are not part of v2.
- Removing stops serving and cleans up Skiff-created records; certificates are left to expire. The
  `www` choice is fixed at attach time — remove and re-add to change it.

### Runtime

Static projects show a “Static project” empty state — there is no workload. Process/container
projects show the runtime card (node, upstream, memory/CPU, deployment, memory reservation against
the node slice), the specification, node capacity (platform admins), and secrets.

`Configure` edits the spec; saved values apply on the **next deploy**, never hot-reloaded. `Reset`
stops the workload and clears the spec but keeps deployments and releases.

| Field              | Applies to | Notes                                                                  |
| ------------------ | ---------- | ---------------------------------------------------------------------- |
| `command`          | process    | argv split on whitespace — no shell; defaults to `bun run start`       |
| `image`            | container  | OCI reference, pulled rootlessly on the node                           |
| `port`             | both       | listen port; Caddy proxies to it locally                               |
| `healthPath`       | both       | probed before the agent reports ready                                  |
| `memoryMb`         | both       | admission unit and `MemoryMax` (32–8192)                               |
| `cpus`             | both       | CPU quota (0.1–8), not a hard pin                                      |
| `socketActivation` | process    | pass the socket via `LISTEN_FDS` (default on)                          |
| `env`              | both       | plain, readable `NAME=value` pairs                                     |
| `secrets`          | both       | write-only refs, delivered as env var or file; optional pinned version |
| `data.sizeMb`      | both       | optional persistent directory at `/data`                               |

### Settings

Name, slug (30-day redirect from the old address), placement, and separate production/preview
access. Placement changes are next-deploy changes too.

## Secrets lifecycle

Add a `UPPER_SNAKE_CASE` name, value and type: **secret** (write-only) or **plain env** (readable).
Reusing a name creates a new version; only the latest is listed. Reference secrets from the spec with
`env` or `file` delivery (a `0400` file exposed through `NAME_FILE`). Values never enter desired
state; the agent fetches them just-in-time at activation, so a new version is picked up at the next
activation (restart or redeploy), not hot-swapped into a running process. Deleting removes the latest
version; running workloads keep the activated value until restart. Org-level secrets work from any
project.

## Node capacity and the Builder role

`/nodes` is platform-admin only. Cards show status, mode, agent version, heartbeat, host stats and
the **workload slice** bar (`reserved / slice` MB, free MB, workload count). Actions: drain/resume
(no new placements, existing workloads keep serving), copy node ID, rotate token, toggle **Builder**.

A Builder badge means the node claims git builds, one at a time; removing it leaves queued builds
waiting for another Builder. Admission runs at **deploy time**: `reserved + memoryMb ≤
sliceMemoryMb`, counting `pending/starting/running`; a refusal names the free budget, and `auto`
prefers the worker with the most free budget, then the edge. Capacity (`GET /api/v1/nodes/capacity`)
is shown to platform admins only.

## Status vocabulary

One mapping (`apps/control-plane/src/lib/status.ts`) colours every badge; `online`, `running` and
`building` also get the animated live dot.

| Tone             | Statuses                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| success          | `active`, `online`, `ok`, `verified`, `succeeded`, `running`                                                             |
| info / warning   | `pending`, `queued`, `starting` / `building`, `draining`, `used up`, `unverified`                                        |
| danger / neutral | `failed`, `error`, `denied`, `offline`, `revoked` / `expired`, `inactive`, `disabled`, `deleted`, `cancelled`, `stopped` |

Workload status: `pending → starting → running`, plus `failed` / `stopped`. Domain status:
`pending → verified → active`, or `failed`. Brand tone marks `production`.

## End-to-end flows

**Process app.** `/projects` → `New project` with runtime `process` and a placement → project
**Runtime** → `Configure` (command, port, health path, memory, env, secret refs) → deploy from CLI,
MCP or REST (`skif deploy ./dist --project <slug>`) → confirm node, upstream and reservation on the
Runtime card. **Container app:** same, but set the `image` before the first deploy.

**Git → build → environment.** **Builds** → `Connect repository` (repo, branch, root, command,
output, webhook secret) and paste the webhook into GitHub → `Build now` or push to the branch → watch
the row / open the log → the artifact becomes a normal release and deployment. If “promote on
success” was ticked the production pointer moves; otherwise **Environments** → `Promote` points
staging (or production) at that active deployment.

**Custom domain.** **Domains** → `Add domain` → add the TXT and A/CNAME records (Cloudflare
auto-records handle this when a token and zone are configured) → `Check DNS` → verified domains
serve the production deployment and get a certificate on the first request.

**Zip deploy from the dashboard.** Project header → `Deploy` → choose the `.zip`, environment,
optional message and promote → the deployment appears on the **Deployments** tab and can be promoted
or rolled back like any other deploy.

## Deliberate limits

- **DNS verification is manual.** No background re-check or scheduled drift scan; press `Check DNS`
  after changing records.
- **Environment hosts are `<slug>--<env>.<contentDomain>`** (single label, covered by the wildcard
  certificate). No per-environment custom domains.
- **Secret values are write-only** — create, rotate and reference, never read back.
- **Dashboard deploys are `.zip` uploads** of a built artifact; there is no folder picker or
  presigned/multipart upload UI yet.
- **Static projects have no workload** and cannot configure a runtime.
- **One workload per project.** For process/container projects only the latest deployment is active
  (a production promote or rollback re-points the workload); per-preview runtimes are deferred.
- **Builds run only on a Builder node** (one at a time, 10-minute cap), and **spec/placement edits
  apply on the next deploy** — settings never restart or move a running workload.
