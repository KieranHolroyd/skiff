# Skiff — Design

> A lightweight, self-hosted private cloud for spinning up simple projects on your own domain,
> with an operations dashboard and first-class AI agent (MCP) integration.
> "Ask your agent to deploy a website — and it does."

Status: **Design agreed (grilling session, 2026-11-03).** See [DECISIONS.md](./DECISIONS.md) for the
decision log with rationale, and [ROADMAP.md](./ROADMAP.md) for v1/v2 scope.

---

## 1. Goals & non-goals

**Goals**
- Deploy a site in one agent tool call (`deploy_site`), from chat-only or shell-capable agents.
- Use as few resources as humanly possible. Target baseline ≤ 250 MB RSS on the edge VPS (platform
  services only; edge-placed apps run in a capped workload slice on top, §3.4.1).
- Instant subdomains (no DNS propagation, no per-site certs).
- Instant, zero-cost promote and rollback.
- Multi-user ready (orgs, RBAC) even though it's single-user today.
- Personal infrastructure now, **engineered to become an open-source product** (semver, signed
  releases, safe migrations, clean-VM installer).
- Survive the loss of any node, the edge included, with each resource's redundancy chosen as an
  HA level, and put each service on hardware that suits it (D107, [CLUSTERING.md](./CLUSTERING.md)).

**Non-goals**
- Kubernetes, a continuously rebalancing scheduler, or a distributed filesystem. Redundancy lives
  in the data services (CLUSTERING.md §1).
- A multi-writer control plane. There is one active control plane, with warm standbys (D5).

---

## 2. Glossary (ubiquitous language)

| Term | Meaning |
|---|---|
| **Control plane** | The SvelteKit/Bun app: dashboard, REST API, MCP server, auth, SQLite, and the ClickHouse telemetry store beside it. One active per install, with optional warm standbys (D107). |
| **Node** | A machine running a **node agent**. It belongs to exactly one control plane. |
| **Edge node** | The node that terminates TLS and public ingress (the VPS). Today one node holds the role (D98); several ingress nodes are planned (CLUSTERING.md §7). |
| **Node agent** | A Bun-compiled binary on each node. It reconciles desired state: releases on disk, Caddy routes, runtime units. |
| **Runtime driver** | The agent's backend for running workloads: `systemd` (v1) and `docker` (v2, optional). |
| **Org** | Tenant boundary. Every project belongs to one. |
| **Project** | A named site/app with a globally unique **slug** → `<slug>.<contentDomain>`. |
| **Upload session** | A pending upload, filled inline (`deploy_files`) or via a presigned URL (`create_upload`). |
| **Release** | An immutable, content-addressed (sha256) build artifact. |
| **Config snapshot** | An immutable set of env vars, secret *version references* and parsed site config (`_redirects`, `_headers`, `skiff.json`). |
| **Deployment** | Release + config snapshot. It has a permanent preview URL `<slug>--<shortid>.<contentDomain>`. |
| **Production pointer** | The project's reference to the deployment served at `<slug>.<contentDomain>`. Promote and rollback move it. |
| **Placement** | Where a project runs: `edge`, a named node (e.g. `homelab`), or `auto`. Applies to every runtime tier: the edge can run apps too (D41). |
| **Workload slice** | The systemd slice (`skiff-workloads.slice`) every app on a node runs in. Its memory/CPU budget keeps the platform services on that node responsive. |
| **Access mode** | `public`, `password`, or `platform`, set separately for production and previews. |
| **Share link** | A magic link granting time- and usage-limited access to a protected deployment. |
| **Platform domain** | The domain for dashboard, API, MCP and auth. |
| **Content domain** | The domain for deployed sites. Can equal the platform domain (shared mode, with a warning). |
| **Recovery kit** | A passphrase-encrypted (`age`) export of the master key, shown once at install. |

---

## 3. Architecture

### 3.1 Topology (multi-node mode)

```
                    Internet
                       │  :80 :443
                       ▼
┌──────────────────────────── VPS (edge node) ─ Debian 13, 2 vCPU / 4 GB / 40 GB ────────┐
│ Caddy (custom build + caddy-dns/cloudflare)  ← admin API on unix socket only           │
│   *.contentDomain  ─► local sites/apps     or ─► homelab over WireGuard                │
│   cloud./api./mcp.platformDomain ─► control plane                                      │
│ Control plane (SvelteKit on Bun): UI · REST · MCP · Better Auth · SQLite · ClickHouse  │
│ Node agent (bun --compile) · [v2: edge-placed tier-2/3 apps in skiff-workloads.slice]  │
│ WireGuard (wg0) ◄─────────────────────────────┐                                        │
└───────────────────────────────────────────────┼────────────────────────────────────────┘
                                                │ homelab dials out (no inbound ports)
┌──────────────── Homelab node ─ Debian 13 VM on Unraid (~6 vCPU / 12 GB / 200 GB) ──────┐
│ Node agent · Caddy (local serving) · [v2: Builder, tier-2/3 workloads]                 │
└────────────────────────────────────────────────────────────────────────────────────────┘
             Cloudflare: DNS (grey cloud), R2 (artifacts, backups, Parquet archive)
             AWS SES (SMTP): outbound email
```

**Single-node mode:** control plane, agent and Caddy on one machine. The agent talks to the control
plane over a unix socket with the same protocol, and there's no WireGuard. You can have separate
installs on separate machines, each fully independent with no federation.

**Clusters:** zones, node roles, hardware-aware placement, the private overlay, shared drives and
high availability are planned in [CLUSTERING.md](./CLUSTERING.md).

### 3.2 Components & tech

| Component | Tech | Runs as | Approx. RSS |
|---|---|---|---|
| Control plane | SvelteKit 3 (`@sveltejs/adapter-bun`, listening on a unix socket behind Caddy with `PROTOCOL_HEADER`/`HOST_HEADER`), shadcn-svelte (nova preset), Better Auth, Drizzle + SQLite, ClickHouse (HTTP) | `skiff-cp` (unprivileged) | 80–150 MB target (spike: 92 idle / ~160 MB under load on macOS) |
| Node agent | Bun, `bun build --compile` single binary | `skiff-agent` (unprivileged) | 30–50 MB |
| Proxy | Caddy (prebuilt with `caddy-dns/cloudflare`), driven only via admin API on a unix socket | `caddy` | 30–50 MB |
| Privileged helper (v2) | Bun binary; fixed verbs over a root-only unix socket; renders unit files from validated specs. Installed on every node that runs apps, edge included | root | small |

**Monorepo (Bun workspaces):**
```
apps/control-plane     SvelteKit app (UI + REST + MCP + OTLP receiver)
apps/agent             node agent
apps/cli               CLI, npm package `skif` (bundled, runs on Node 20+ or Bun); installs both `skif` and `skiff` commands
packages/contracts     shared Zod/Valibot schemas: API, agent protocol, MCP tool I/O
packages/core          service layer (all business logic + RBAC checks)
packages/site-config   _redirects / _headers / skiff.json parser → Caddy route compiler
packages/db            Drizzle schema + migrations
```

**One service layer.** The dashboard, REST API, MCP server and CLI all call `packages/core`, with
identical permission checks. No surface can do something another can't.

### 3.3 Control model: desired-state reconciliation

- The control plane stores the **desired state per node**: releases present, routes, units, and the
  agent version.
- Agents **pull** it (long-poll/SSE over WireGuard, authenticated with mTLS/node tokens), converge
  idempotently, and report actual state plus heartbeats about every 10 s.
- Agents **cache the last desired state on disk**. If the control plane is down or mid-upgrade,
  nodes keep serving unchanged.
- Agent upgrades are just a desired-state field. The control plane supports agents one minor version behind.
  A worker installs the control plane's own signed release when an admin clicks **Update node**:
  the agent asks the root helper, which verifies the release signature itself (D99).

### 3.4 Runtime tiers

| Tier | v1? | systemd driver | docker driver (v2) |
|---|---|---|---|
| 1 Static | ✅ | Caddy `file_server` on `/srv/skiff/releases/<sha>` | Caddy container + volume |
| 2 Process (Bun/Node SSR) | v2 | Sandboxed unit: `DynamicUser`, `ProtectSystem=strict`, `MemoryMax`, `CPUQuota`, optional socket activation | Sibling container, read-only artifact mount, cap-drop all |
| 3 Container | v2 | Podman Quadlet (rootless, no daemon) | Native |

```ts
interface RuntimeDriver {
  serveStatic(release, route): Promise<void>
  runProcess(release, spec): Promise<void>     // v2
  runContainer(image, spec): Promise<void>     // v2
  stats(): Promise<Stats>; logs(q): AsyncIterable<LogLine>; remove(id): Promise<void>
}
```

Data for future tier-2 apps defaults to **a SQLite file per project**, not a shared database server.

#### 3.4.1 Placement and the edge

Every runtime tier can be placed on **any node, the edge included** (D41). The edge is not limited to
static sites.

- **Placement values:** `edge`, a node name/id, or `auto`. The control plane resolves `auto` once, at
  deploy time, and records the node on the deployment, so a running app never moves on its own
  unless an explicit move (D97) or its HA policy (D107) moves it.
  - Static: `auto` → edge (local `file_server`, no WireGuard hop).
  - Process/container: `auto` → the online, non-draining node with the most free workload-slice
    budget, preferring workers. Falls back to the edge when no worker can admit it.
- **Serving:** an edge-placed app listens on a unix socket (or a loopback port) and the edge Caddy
  reverse-proxies to it locally. Worker-placed apps are proxied over WireGuard as before.
- **Protecting the edge:** on every node, apps run under `skiff-workloads.slice`, never beside the
  platform services.
  - The slice has a node-level `MemoryMax` (edge default **1 GiB** on the 4 GB VPS, set per node) and a
    lower `CPUWeight` than `skiff-cp`, `skiff-agent` and `caddy`. A runaway app hits its own limit or the
    slice limit, and the control plane, Caddy and ingress for every other site stay up.
  - **Admission:** each app declares `MemoryMax` (default 256 MB). The control plane refuses a deploy
    whose reservation would exceed the target node's slice budget, with an error naming the free
    budget and suggesting another node.
- **Builds stay on the homelab** (D3), even for edge-placed apps: the Builder produces an artifact and
  the edge only runs it. Single-node mode builds locally inside the workload slice.
- **Why place an app on the edge:** it keeps serving when the homelab is offline, skips the WireGuard
  hop, and lets a single-node install run apps at all.

---

## 4. Deploy pipeline

```
deploy_files (inline, ≤5 MB) ─┐
create_upload → presigned PUT ─┼─► Upload session ─► finalize ─► Release (sha256, R2) ─┐
[v2] git build on homelab ─────┘                                                        │
                       config snapshot (env, secret versions, parsed site config) ─────┤
                                                                                        ▼
                                              Deployment ─► preview URL (always)
                                                         └► promote? → production pointer
```

- **The server never builds in v1.** Artifacts only.
- **Presigned uploads go directly to R2.** Large uploads never touch the VPS disk or bandwidth.
- **Finalize:**
  1. Validate limits (500 MB/artifact, 20k files, 25 MB/file).
  2. Parse and validate `_redirects`, `_headers` and `skiff.json` (fail with a precise error).
  3. Compute the sha256 for content addressing.
  4. Precompress (brotli + gzip) as a low-priority background job.
- **Activate:** nodes pull the release into a local cache, the symlink is swapped atomically, and the
  Caddy route is updated through the admin API. Serving never depends on R2 being reachable.
  - Each admin call reloads Caddy's full config, so the agent **applies all routes in a single PUT per reconcile**.
  - Promote and rollback of an existing route only swap the symlink. No Caddy call is needed.
- **Promote/rollback:** move the production pointer. Instant. Rollback restores code *and* config.
  Each deployment records when it was promoted; rollback goes to the most recently promoted deployment that went
  live before the current one (never to a preview that was never in production).
- **Retention:** last 10 deployments per project plus pinned ones. GC removes the rest from R2 and node caches.
- `promote` defaults to `true`.

### 4.1 Static serving

- Netlify/Cloudflare-Pages-compatible `_redirects` and `_headers` (supported subset: status codes,
  splats, placeholders, per-path headers).
- Optional `skiff.json`: `{ "spa": bool, "cleanUrls": bool, "trailingSlash": "always"|"never"|"ignore", "notFound": "404.html" }`.
- SPA is **suggested, never auto-enabled** (the deploy response hints at it when it's detected).
- Caching: hashed assets → `public, max-age=31536000, immutable`; HTML → `no-cache` + ETag.
- Default headers: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`. No default CSP.

---

## 5. Domains, DNS & TLS

- **Cloudflare DNS, grey cloud (DNS only).**
- Wildcard A/AAAA `*.<contentDomain>` → VPS, created once. New sites need **no DNS calls**.
- Wildcard certs via **ACME DNS-01** (Caddy + `caddy-dns/cloudflare`, scoped API token).
- Preview URLs use a single label, `<slug>--<shortid>`, because wildcard certs only cover one level.
- **Two-domain mode (recommended):** platform and content on separate registrable domains, so
  deployed (untrusted, AI-generated) content is cross-site to the dashboard.
- **Shared-domain mode (allowed, warned):** mandatory, non-configurable hardening:
  - `__Host-` cookies only, plus strict Origin/Referer checks and CSRF tokens on every mutation.
  - Reserved slugs are enforced.
  - Persistent security notice in the dashboard.
  - Migrating to two domains later is supported (301s for a grace period).
- Custom domains (v2): TXT verification, Caddy on-demand TLS with an `ask` endpoint that only approves
  verified hostnames, automatic records when the domain is in the connected Cloudflare account,
  apex↔www redirect, drift detection.

### 5.1 Project slugs
- `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$`, **no `--`**, globally unique, first come first served.
- Reserved: `cloud api mcp auth www admin status mail login static assets _*` (and more).
- On collision: error + 3 suggested free slugs (never a silent `-2`).
- Rename: the old slug 301s for 30 days, then is released.

---

## 6. Identity, RBAC & agent access

### 6.1 Auth (Better Auth)
- Plugins: `organization` (with access control), `admin`, `passkey`, `twoFactor`, `apiKey`,
  MCP/OAuth provider, `magicLink` (invites/recovery).
- Sign-in: email + password (D103), passkeys, GitHub OAuth and magic links. Invite only (no public password
  sign-up). 2FA required for owners: an owner's session
  must prove a second factor (passkey sign-in, or a TOTP/backup code verified in that session) before it can use
  the dashboard or API. Password, GitHub and magic-link sign-ins count as single-factor. An unverified session can't enrol a
  new factor when one already exists, so a hijacked GitHub account or mailbox can't add its own.

### 6.2 RBAC
- **Platform level** (`admin` plugin): `platform:admin` manages nodes, global settings, domains, Caddy.
  It is the admin-plugin **user role** (`user.role = admin`), independent of org roles: an org owner is
  not a platform admin. The first user is made platform admin at bootstrap. Read-only fleet views work
  from any surface of a platform admin; fleet mutations (join tokens, drain, token rotation, self-update)
  require the admin's own dashboard session, never an API key or OAuth token.
- Personal orgs are created only for the bootstrap user (or under open signup); invitees join the
  inviting org. Self-service org creation is off.
- **Org level**, permissions as `resource:action`:

| Resource | Actions |
|---|---|
| project | create, read, update, delete |
| deployment | create, read, promote, rollback, delete |
| domain | create, read, delete |
| secret | create, read-metadata, update, delete (values never readable) |
| build | create, read, cancel |
| shareLink | create, read, revoke |
| logs / metrics | read |
| apiKey | create, read, revoke |
| member | invite, update-role, remove |

- Roles: `owner`, `admin`, `deployer`, `viewer` (custom roles later via the same tables).
- **Tokens and API keys always carry a subset of the issuing user's permissions.**
- Per-org quotas in the schema from day one (projects, storage, retained deployments): unlimited for the
  owner org, enforced for others.

### 6.3 MCP
- Remote MCP over **Streamable HTTP** at `mcp.<platformDomain>`, served by the control plane.
- **OAuth 2.1** for interactive clients (Claude Code, Claude.ai). The consent screen lets you pick permissions.
  - Client identity: **CIMD** (Client ID Metadata Documents, the MCP 2026-07-28 mechanism), with legacy
    **DCR** also enabled for older clients (`SKIFF_MCP_ALLOW_DCR`).
  - Scope step-up: tools declare the permission they need, and a token without it gets `403 insufficient_scope`,
    which makes the client re-authorize so the user can grant it explicitly.
  - Root `/.well-known/oauth-protected-resource[/mcp]` and `/.well-known/oauth-authorization-server[/api/auth]`
    are forwarded to Better Auth.
  The default is **deployer-level**, with `project:delete` and `deployment:delete` unticked.
- **API keys** as the headless fallback (CI, scripts, CLI).
- Destructive tools ask the human to confirm through **multi-round-trip input** (`inputRequired` elicitation,
  MCP 2026-07-28). The confirmation is bound to the target (e.g. the slug), and if the user declines, the tool cancels.
  2025-era clients (stateless legacy path) can't receive input requests, so they get an error telling the
  agent to ask the user to act in the dashboard. Projects are soft-deleted (7-day trash).
- Every tool call is written to the **audit log** as `mcp.<tool>` (user, client, tool, args, result), including
  scope denials and declined confirmations. File contents are recorded as count, size and paths only.
- Delete confirmations carry a signed, 10-minute state token bound to the user, client, tool and target, so a
  client can't pre-fill the answer to skip the prompt.
- MCP resources: `skiff://guides/deploying`, `skiff://guides/limits`, `skiff://guides/site-config`.

**v1 tools**

| Group | Tools |
|---|---|
| One-shot | `deploy_site({ name, files?, uploadId?, promote? })`: creates the project if missing, then deploys |
| Projects | `list_projects`, `get_project`, `create_project`, `update_project`, `delete_project` |
| Mass actions | `delete_projects` (≤25, one confirmation for the whole list), `restore_projects`, `get_operation` (D53; no purge or prune over MCP) |
| Deploying | `create_upload`, `deploy_files`, `finalize_upload`, `list_deployments`, `get_deployment`, `promote_deployment`, `rollback` |
| Access | `set_access`, `create_share_link`, `list_share_links`, `revoke_share_link` |
| Observability | `get_status`, `get_metrics`, `get_logs`, `get_audit_log` |
| Dashboards (D101) | `describe_telemetry`, `query_telemetry`, `list_dashboards`, `get_dashboard`, `create_dashboard` (templates + panel drafts, auto-layout, data preview), `add_dashboard_panels`, `update_dashboard_panel`, `remove_dashboard_panels`, `update_dashboard`, `delete_dashboard` (elicitation) |
| Alerts (D109) | `list_alerts`, `get_alert_rule`, `create_alert_rule` (outage templates, preview), `update_alert_rule`, `silence_alerts`, `acknowledge_alert`, `get_alert_history`, `delete_alert_rule` (elicitation) |
| Platform | `list_nodes` (read-only) |

All tools carry `readOnlyHint` / `destructiveHint` / `idempotentHint`. Responses include URLs and next steps.

### 6.3.1 CSRF / Origin policy
SvelteKit's built-in CSRF check is disabled because it would block the OAuth token endpoint. It's replaced by
`src/lib/server/csrf.ts`:
- Every non-GET/HEAD request must have `Origin` equal to the platform origin, or `Sec-Fetch-Site: same-origin`.
- Exceptions are an exact allowlist of cookieless endpoints: `oauth2/token`, `register`, `revoke`, `introspect`, `/mcp`,
  `/api/v1/cli/token` (PKCE-bound code) and `/_skiff/site-login`, plus the bearer/signature-only prefixes
  `/api/agent/` and `/api/objects/` (prefixes end in `/` so they never match a sibling REST path).
- The control plane sends `X-Frame-Options: DENY` and `frame-ancestors 'none'` so consent and CLI-approval pages
  can't be framed.

### 6.3.2 CLI configuration
`skif` keeps persistent settings in `~/.config/skiff/config.json` (`$SKIFF_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/skiff`, else `~/.config/skiff`), mode 0600. Settings are grouped into named
**profiles**, one per deployment, so a single machine can talk to production, staging and a
local dev server without environment-variable juggling:
- `profiles.<name>.url` — control-plane origin, e.g. `https://control.example.com`.
- `profiles.<name>.contentDomain` — domain deployed sites use, e.g. `examplecloud.com`; used to
  build preview URLs when the API does not return one.
- `profiles.<name>.token` — API key.
- `activeProfile` — the profile used when none is selected explicitly.

A profile is selected by, in order: `--profile <name>`, `$SKIFF_PROFILE`, the active profile, or
the only profile when exactly one exists. When several profiles exist and none is active, commands
refuse to guess and list the choices. A profile named `default` is what a legacy single-profile
file becomes on read; the file is rewritten in the version 2 shape on the next write.
`skif profile list|add|use|remove|show|current` manages the profiles, and
`skif config list|get|set|unset|path` manages the selected profile's settings and shows whether
each effective value comes from the file or the environment.

`skif login` is browser-first: it opens the dashboard approval page, which redirects a one-time
PKCE-bound code to the CLI's loopback listener; the CLI exchanges that code for a new API key
(`--no-browser` prints the URL, `--token` stores a key created in the dashboard). The code is
stored hashed in `cli_login_codes`, expires after five minutes, and can be redeemed once. Login
records the canonical platform and content domain the server reports in the selected profile.
`skif logout` removes only the selected profile's token, so the next login remembers the URL and
domains; `skif logout --all` removes the file and every profile. `SKIFF_URL`, `SKIFF_TOKEN` and
`SKIFF_CONTENT_DOMAIN` override the profile for CI and agent use.

### 6.4 Protected sites
- Access modes per project, set separately for production and previews: `public | password | platform`.
  **Defaults: production `public`, previews `platform`.**
- Flow: Caddy `forward_auth` goes to the **local node agent**, which verifies an **HMAC-signed, host-only
  cookie** statelessly (sub-ms, no DB). With no cookie, the visitor is redirected to the platform domain
  to log in or enter the password, then back to `/_skiff/callback?token=<one-time, 60s>`, where the agent sets a site-scoped cookie.
  The token carries a one-time id (the agent remembers used ids until they expire) and a separate session expiry that
  the cookie inherits.
  Platform session cookies never touch the content domain.
- Protected responses get `X-Robots-Tag: noindex` and `Cache-Control: private`. Public sites skip `forward_auth` entirely.
- **Share links:**
  - Options: `expiresAt`, `maxVisitors`, `maxRedemptions`, `sessionTtl`, `allowedEmails`, `note`.
  - A "visit" is a **redemption**, not a page load. Redemption is atomic on the control plane.
  - Revocation: the control plane pushes a revocation set (link and session IDs) to agents, which takes effect in seconds.
  - Per-link analytics come from the access logs.

---

## 7. Secrets & config

- **Deployment = release + config snapshot** (Vercel/Fly model). Changing config creates a new deployment
  on the same artifact. Rollback restores both.
- **Envelope encryption:** per-org data keys, encrypted by a master key held as a **`systemd-creds`**
  credential (TPM2-bound where available, host key otherwise).
- Secrets are **write-only** through the API and MCP. Plain env vars are a separate, readable type.
- Secrets are **scoped**: a project secret shadows an organisation secret of the same name; another project's
  secrets never resolve (D88). Changing a referenced secret restarts the apps that use it.
- Snapshots reference **secret versions**. A version is kept while any retained deployment references it.
- Delivery (tier 2): decrypted at activation, sent to the agent over WireGuard/mTLS, and injected as env vars
  by default or as files via `LoadCredential` (opt-in per secret).
- Platform secrets (Cloudflare token, R2 keys, SES SMTP creds, Better Auth secret, WireGuard keys) are stored the same way.

---

## 8. Observability

- **Stores:** SQLite holds platform state. A small local **ClickHouse** server (`skiff-clickhouse.service`,
  HTTP on 127.0.0.1:18123, ~768 MiB cap, D101) holds telemetry. It is **optional and off by default** to
  keep the base install light; an owner adds it from Settings → Telemetry or at the installer's prompt. The control plane reaches it with `fetch`,
  so no native addon can fail to load, and the zero-downtime standby shares it with the primary.
- **OTel-conformant.** Agents emit OTLP with semantic conventions (`service.name` = project slug,
  `deployment.id`, `host.name`, `http.*`). The control plane runs an **OTLP/HTTP receiver** that writes into ClickHouse.
  The OTel Collector binary is not run.
- **The agent sends pre-aggregated 1-minute buckets only.** Raw requests never reach the telemetry store; it stays
  small and its memory bounded.
- **Tables** (database `skiff`): `traffic_1m/1h`, `db_metrics_1m/1h`, `storage_metrics_1m/1h` (ReplacingMergeTree,
  keyed by series + bucket, newest ingest wins, read with `final = 1`), plus `*_hourly` views that join rolled-up hours
  with not-yet-rolled minutes.
- **Dashboards (D101).** Users build Grafana-style dashboards (`/dashboards`): a 24-column panel grid, time range and
  refresh pickers, variables, and time series, stat, gauge, bar gauge, table, pie and text panels. A panel query is a
  **builder** spec (dataset + measures + group-by + filters), compiled by the control plane with the caller's project,
  database and storage scope ANDed in, or **SQL** with Grafana-style macros (`$__timeFilter(bucket)`, `$__timeInterval(bucket)`,
  `$var`). SQL runs as the read-only `skiff_reader` with time, memory and row limits, and only for platform admins,
  because it reads every org's rows. REST: `/api/v1/observability/*` (API.md).
- **Collection (agent, about every 10 s):**
  - Node: CPU/mem/disk/net from `/proc`.
  - Per app: cgroup v2 stats.
  - Per site: Caddy JSON access logs aggregated into 1-minute buckets (requests, status classes, bytes, p50/p95, top paths and referrers). IPs are hashed.
- **Retention:** 1-minute buckets for 48 h, 1-hour for 90 days in ClickHouse (explicit prune, with table TTLs as a
  backstop), then **daily Parquet partitions to R2** (queryable with ClickHouse's `s3()` table function).
- **Logs:**
  - App logs go to journald and are queried on demand through the agent, with live tail over SSE.
  - Raw Caddy logs are kept 7 days, compressed.
- **Export:** Prometheus `/metrics` on the control plane and agents, plus an optional outbound OTLP exporter.
  (Import from external Prometheus is a designed interface, not built.)
- Tier-2 apps (v2) get `OTEL_EXPORTER_OTLP_ENDPOINT` injected, pointing at their local agent.
- **Dashboard views:** fleet overview, per-project traffic, errors and resources with deploy markers, audit log, live logs.
- **Alerts:** `Notifier` interface, email (SES SMTP) + generic webhook (Home Assistant; Discord/Slack URLs are detected) + chat channels with native payloads (Discord, Slack, Telegram, ntfy). User-defined metric alert rules over the ClickHouse telemetry (D109, [ALERTS.md](./ALERTS.md)) use the same notifiers.
  Defaults:
  - node offline > 2 min
  - disk > 85%
  - cert expiring < 14 d
  - 5xx spike after promote
  - failed backup or restore drill

---

## 9. Failure behaviour

| Failure | Effect | Behaviour |
|---|---|---|
| Homelab offline | Homelab-placed projects unreachable | Edge Caddy health-checks and serves a branded 503 + `Retry-After`. Alert after 2 min. Optional static mirror to edge (per project, opt-in). Edge-placed sites and apps keep serving. |
| Edge app exhausts memory | That app is OOM-killed and restarted | Contained by its own `MemoryMax` and `skiff-workloads.slice`. The control plane, Caddy and other sites are unaffected. Alert on restart loops. |
| Control plane crash | Dashboard/API/MCP down | All sites keep serving (agents use cached desired state). systemd restarts it. |
| VPS lost | Everything on it down | Today: restore to a fresh VPS in under 15 min (OPS.md §5.3). With a second ingress node and a control-plane standby (CLUSTERING.md), ingress and the control plane fail over and only L0 resources on the VPS are down. |
| R2 unreachable | New deploys fail | Existing sites unaffected (node-local cache). |

---

## 10. Backups & disaster recovery

| Data | Mechanism |
|---|---|
| SQLite | **Litestream** → R2 (continuous) |
| Release artifacts | Canonical in **R2**, cached on nodes |
| Telemetry | Hot ClickHouse not backed up. Cold Parquet in R2. |
| Master key | **Recovery kit**: `age`-encrypted with a passphrase, shown once at install |
| Certs | Re-issued on restore |

- On the host, after the installer: `skiff-restore --recovery-kit <file> [--from <replica>]` installs the master key
  (and env) from the kit, then rebuilds SQLite from R2; WireGuard is re-keyed (the homelab reconnects) and nodes
  reconcile. The recovery kit is produced by `skiff-recovery-kit export` (offered at install).
- **Monthly automated restore drill** into a scratch directory, with an alert on failure.
- `ObjectStore` interface: R2 only in v1. Local fs, Garage/MinIO and multi-target replication in v2.

---

## 11. Hosts & hardening

- **Debian 13 minimal** on both nodes. The homelab node is a **VM on Unraid** (not Docker), which keeps a
  hypervisor boundary between workloads and the NAS array.
- Platform services run under systemd sandboxing (`ProtectSystem=strict`, `NoNewPrivileges`, …).
- **Caddy admin API on a unix socket only**, readable only by `skiff-agent` (never `localhost:2019`).
- VPS nftables: allow 80, 443 and the WireGuard UDP port only. SSH over WireGuard (or key-only break-glass).
- Homelab: no inbound ports. It dials out over WireGuard.
- Unattended security upgrades.
- v1 needs **no root** at runtime. The privileged helper arrives with tier 2, on every node that runs
  apps (edge included).

---

## 12. Install, update, release

- **CI (GitHub Actions)** builds a versioned release: control-plane bundle, agent binary, prebuilt
  Caddy (with `caddy-dns/cloudflare`). Everything is **signed** (minisign or cosign).
- **Bootstrap:** `curl -fsSL <url>/install.sh | sh` → a one-time setup URL → browser wizard (D102).
  The installer collects domains, R2 and SMTP, checks the domains resolve (re-checkable while
  records propagate) and offers the recovery kit; it never asks for a DNS token. Domains are
  optional: without them the dashboard is at `http://<ip>` and sites at `<ip>.sslip.io`, and
  Settings → Domains adds or changes them (and HTTPS) later (D105).
  The wizard (`/setup`, token-gated) then:
  1. Checks the instance: HTTPS, passkey support on this origin, email mode, storage, nodes,
     shared-domain mode.
  2. Creates the owner (platform admin + organisation owner) atomically and signs them in.
  3. Sets the owner's password (D103), then enrols a passkey, or an authenticator app when passkeys
     can't work here (plain HTTP, an IP address).
  4. Offers an authenticator backup and links to email, backups, members and API keys.
  No sign-up path works before an owner exists.
- **Join a node:** `skiff-agent join https://cloud.<platformDomain> --token <single-use, 1h> --name <name>`.
- **Self-update:**
  1. Verify the signature.
  2. Snapshot SQLite.
  3. Run forward-only Drizzle migrations.
  4. Atomic symlink swap and restart.
  5. Health check, with automatic rollback on failure.
- Update policy: patch releases auto-apply in a maintenance window; minor and major updates notify you.

---

## 13. Early risks / spikes (do these first)

1. **DuckDB under Bun.** Does `@duckdb/node-api` (N-API) run under Bun? Fallback: an isolated worker using the DuckDB CLI or WASM.
2. **Better Auth MCP/OAuth provider** working with Claude Code and Claude.ai (dynamic client registration, consent with permission subsets).
3. **MCP elicitation** support in target clients, for the destructive-action confirmation path.
4. **Caddy admin API over a unix socket**: atomic route updates, `forward_auth` to the agent, precompressed serving.
5. **SvelteKit 3 + Bun adapter + shadcn-svelte**: confirm compatible versions.
6. **Litestream → R2**, plus the restore drill end to end.
