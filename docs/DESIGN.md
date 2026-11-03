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
- Use as few resources as humanly possible. Target baseline ≤ 250 MB RSS on the edge VPS.
- Instant subdomains (no DNS propagation, no per-site certs).
- Instant, zero-cost promote and rollback.
- Multi-user ready (orgs, RBAC) even though it's single-user today.
- Personal infrastructure now, **engineered to become an open-source product** (semver, signed
  releases, safe migrations, clean-VM installer).

**Non-goals (v1)**
- Server-side builds from git (v2).
- Process apps and containers (tiers 2 and 3, v2, but designed for now).
- Custom domains (v2).
- Surviving a full VPS outage (accepted single point of failure; mitigated by fast restore).
- Importing metrics from external Prometheus (export only).

---

## 2. Glossary (ubiquitous language)

| Term | Meaning |
|---|---|
| **Control plane** | The SvelteKit/Bun app: dashboard, REST API, MCP server, auth, SQLite + DuckDB. Exactly one per install. |
| **Node** | A machine running a **node agent**. It belongs to exactly one control plane. |
| **Edge node** | The node with the public IP that terminates all TLS and ingress (the VPS). |
| **Node agent** | A Bun-compiled binary on each node. It reconciles desired state: releases on disk, Caddy routes, runtime units. |
| **Runtime driver** | The agent's backend for running workloads: `systemd` (v1) and `docker` (v2, optional). |
| **Org** | Tenant boundary. Every project belongs to one. |
| **Project** | A named site/app with a globally unique **slug** → `<slug>.<contentDomain>`. |
| **Upload session** | A pending upload, filled inline (`deploy_files`) or via a presigned URL (`create_upload`). |
| **Release** | An immutable, content-addressed (sha256) build artifact. |
| **Config snapshot** | An immutable set of env vars, secret *version references* and parsed site config (`_redirects`, `_headers`, `skiff.json`). |
| **Deployment** | Release + config snapshot. It has a permanent preview URL `<slug>--<shortid>.<contentDomain>`. |
| **Production pointer** | The project's reference to the deployment served at `<slug>.<contentDomain>`. Promote and rollback move it. |
| **Placement** | Where a project runs: `edge`, `homelab` (any named node), or `auto`. |
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
│   *.contentDomain  ─► local static sites   or ─► homelab over WireGuard               │
│   cloud./api./mcp.platformDomain ─► control plane                                     │
│ Control plane (SvelteKit on Bun): UI · REST · MCP · Better Auth · SQLite · DuckDB      │
│ Node agent (bun --compile)                                                             │
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

### 3.2 Components & tech

| Component | Tech | Runs as | Approx. RSS |
|---|---|---|---|
| Control plane | SvelteKit 3 (`@sveltejs/adapter-bun`, listening on a unix socket behind Caddy with `PROTOCOL_HEADER`/`HOST_HEADER`), shadcn-svelte (nova preset), Better Auth, Drizzle + SQLite, DuckDB | `skiff-cp` (unprivileged) | 80–150 MB target (spike: 92 idle / ~160 MB under load on macOS) |
| Node agent | Bun, `bun build --compile` single binary | `skiff-agent` (unprivileged) | 30–50 MB |
| Proxy | Caddy (prebuilt with `caddy-dns/cloudflare`), driven only via admin API on a unix socket | `caddy` | 30–50 MB |
| Privileged helper (v2) | Bun binary; fixed verbs over a root-only unix socket; renders unit files from validated specs | root | small |

**Monorepo (Bun workspaces):**
```
apps/control-plane     SvelteKit app (UI + REST + MCP + OTLP receiver)
apps/agent             node agent
apps/cli               CLI, npm package `skif`; installs both `skif` and `skiff` commands (wraps presigned upload, login, etc.)
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
- Sign-in: passkeys + GitHub OAuth. No passwords. Invite only. 2FA required for owners.

### 6.2 RBAC
- **Platform level** (`admin` plugin): `platform:admin` manages nodes, global settings, domains, Caddy.
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
- Every tool call is written to the **audit log** (user, client, tool, args, result).
- MCP resources: `skiff://guides/deploying`, `skiff://guides/limits`, `skiff://guides/site-config`.

**v1 tools**

| Group | Tools |
|---|---|
| One-shot | `deploy_site({ name, files?, uploadId?, promote? })`: creates the project if missing, then deploys |
| Projects | `list_projects`, `get_project`, `create_project`, `update_project`, `delete_project` |
| Deploying | `create_upload`, `deploy_files`, `finalize_upload`, `list_deployments`, `get_deployment`, `promote_deployment`, `rollback` |
| Access | `set_access`, `create_share_link`, `list_share_links`, `revoke_share_link` |
| Observability | `get_status`, `get_metrics`, `get_logs`, `get_audit_log` |
| Platform | `list_nodes` (read-only) |

All tools carry `readOnlyHint` / `destructiveHint` / `idempotentHint`. Responses include URLs and next steps.

### 6.3.1 CSRF / Origin policy
SvelteKit's built-in CSRF check is disabled because it would block the OAuth token endpoint. It's replaced by
`src/lib/server/csrf.ts`:
- Every non-GET/HEAD request must have `Origin` equal to the platform origin, or `Sec-Fetch-Site: same-origin`.
- Exceptions are an exact allowlist of cookieless endpoints: `oauth2/token`, `register`, `revoke`, `introspect`, `/mcp`.

### 6.4 Protected sites
- Access modes per project, set separately for production and previews: `public | password | platform`.
  **Defaults: production `public`, previews `platform`.**
- Flow: Caddy `forward_auth` goes to the **local node agent**, which verifies an **HMAC-signed, host-only
  cookie** statelessly (sub-ms, no DB). With no cookie, the visitor is redirected to the platform domain
  to log in or enter the password, then back to `/_skiff/callback?token=<one-time, 60s>`, where the agent sets a site-scoped cookie.
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
- Snapshots reference **secret versions**. A version is kept while any retained deployment references it.
- Delivery (tier 2): decrypted at activation, sent to the agent over WireGuard/mTLS, and injected as env vars
  by default or as files via `LoadCredential` (opt-in per secret).
- Platform secrets (Cloudflare token, R2 keys, SES SMTP creds, Better Auth secret, WireGuard keys) are stored the same way.

---

## 8. Observability

- **Stores:** SQLite holds platform state. **DuckDB** holds telemetry (`memory_limit='256MB'`,
  `threads=2` on the VPS).
- **OTel-conformant.** Agents emit OTLP with semantic conventions (`service.name` = project slug,
  `deployment.id`, `host.name`, `http.*`). The control plane runs an **OTLP/HTTP receiver** that writes into DuckDB.
  The OTel Collector binary is not run.
- **The agent sends pre-aggregated 1-minute buckets only.** DuckDB's RSS grows with the amount of hot data, regardless of
  `memory_limit` (see SPIKES.md), so raw requests never enter DuckDB.
- **Collection (agent, about every 10 s):**
  - Node: CPU/mem/disk/net from `/proc`.
  - Per app: cgroup v2 stats.
  - Per site: Caddy JSON access logs aggregated into 1-minute buckets (requests, status classes, bytes, p50/p95, top paths and referrers). IPs are hashed.
- **Retention:** 1-minute buckets for 48 h, 1-hour for 90 days in DuckDB, then **daily Parquet partitions to R2**
  (still queryable from DuckDB).
- **Logs:**
  - App logs go to journald and are queried on demand through the agent, with live tail over SSE.
  - Raw Caddy logs are kept 7 days, compressed.
- **Export:** Prometheus `/metrics` on the control plane and agents, plus an optional outbound OTLP exporter.
  (Import from external Prometheus is a designed interface, not built.)
- Tier-2 apps (v2) get `OTEL_EXPORTER_OTLP_ENDPOINT` injected, pointing at their local agent.
- **Dashboard views:** fleet overview, per-project traffic, errors and resources with deploy markers, audit log, live logs.
- **Alerts:** `Notifier` interface, email (SES SMTP) + generic webhook (ntfy, Discord, Home Assistant).
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
| Homelab offline | Homelab-placed projects unreachable | Edge Caddy health-checks and serves a branded 503 + `Retry-After`. Alert after 2 min. Optional static mirror to edge (per project, opt-in). |
| Control plane crash | Dashboard/API/MCP down | All sites keep serving (agents use cached desired state). systemd restarts it. |
| VPS lost | Everything down | **Accepted single point of failure for v1.** Restore to a fresh VPS in under 15 min. |
| R2 unreachable | New deploys fail | Existing sites unaffected (node-local cache). |

---

## 10. Backups & disaster recovery

| Data | Mechanism |
|---|---|
| SQLite | **Litestream** → R2 (continuous) |
| Release artifacts | Canonical in **R2**, cached on nodes |
| Telemetry | Hot DuckDB not backed up. Cold Parquet in R2. |
| Master key | **Recovery kit**: `age`-encrypted with a passphrase, shown once at install |
| Certs | Re-issued on restore |

- `skif restore --from r2://<bucket> --recovery-kit <file>` rebuilds SQLite, reinstalls the agent and Caddy,
  re-keys WireGuard (the homelab reconnects), and nodes reconcile.
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
- v1 needs **no root** at runtime. The privileged helper arrives with tier 2.

---

## 12. Install, update, release

- **CI (GitHub Actions)** builds a versioned release: control-plane bundle, agent binary, prebuilt
  Caddy (with `caddy-dns/cloudflare`). Everything is **signed** (minisign or cosign).
- **Bootstrap:** `curl -fsSL <url>/install.sh | sh` → a one-time setup URL → browser wizard:
  1. Platform and content domains (warns on shared mode).
  2. Cloudflare token, used to create the wildcard records and the SES DKIM/SPF/DMARC records.
  3. R2 credentials.
  4. SES SMTP (flags the SES sandbox).
  5. First admin with a passkey.
  6. Recovery kit.
- **Join a node:** `skif agent join https://cloud.<platformDomain> --token <single-use, 1h>`.
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
