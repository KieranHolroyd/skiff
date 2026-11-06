<p align="center">
  <img src="apps/control-plane/src/lib/assets/favicon.svg" width="112" height="112" alt="Skiff logo: an orange sail above a white hull on a navy tile">
</p>

<h1 align="center">Skiff</h1>

<p align="center">
  <b>Your own little cloud. Ship sites to your domain from a CLI, a dashboard, or your AI agent.</b>
</p>

<p align="center">
  Skiff is a lightweight, self-hosted deploy platform for one VPS and a few nodes. Deploy static sites,
  get a preview URL for every deployment, then promote or roll back instantly. It comes with an
  operations dashboard, and AI agents can drive it as a first-class client over MCP.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-f0743a?style=flat-square"></a>
  <a href="https://github.com/KieranHolroyd/skiff/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/KieranHolroyd/skiff/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="https://www.npmjs.com/package/@skiffy/skiff"><img alt="npm: @skiffy/skiff" src="https://img.shields.io/npm/v/@skiffy/skiff?style=flat-square&label=skif%20CLI&color=1b2235"></a>
  <img alt="Built with Bun" src="https://img.shields.io/badge/built%20with-Bun-1b2235?style=flat-square&logo=bun&logoColor=white">
  <img alt="Agent-drivable over MCP" src="https://img.shields.io/badge/agents-MCP%20%2B%20OAuth%202.1-f0743a?style=flat-square">
  <img alt="Status: early development" src="https://img.shields.io/badge/status-early%20development-1b2235?style=flat-square">
</p>

<p align="center">
  <a href="#why-skiff">Why Skiff</a> ·
  <a href="#what-works-today">What works</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#for-agents-mcp">For agents</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#security-model">Security</a> ·
  <a href="#development">Development</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="#license">License</a>
</p>

<br>

> **"Deploy `./dist` as `launch-page`, and give me a share link that expires on Friday."**
>
> Your agent calls `deploy_site`, then `create_share_link`. You get a preview URL, a link that
> expires on Friday, and an audit-log entry recording who did it and how.

> [!NOTE]
> **Skiff is newly open source and still early.** The v1 static platform is feature-complete apart from
> a few release items. v2 (process apps, containers, git builds, custom domains, named
> environments) has its backend in place, and installer and release wiring are still in progress.
> Expect rough edges and breaking changes before 1.0. Issues and PRs are welcome.

## Why Skiff

- **Yours.** One Debian/Ubuntu VPS, your domain, your object store. No per-seat pricing, no
  vendor lock-in, and if the control plane goes down, your sites keep serving.
- **Small.** Bun, SQLite and Caddy (plus an optional small ClickHouse for telemetry). There's no Kubernetes, no Docker requirement and no
  external database, so the whole platform fits on a small VPS.
- **Immutable by default.** Every deploy is a content-addressed release with its own preview URL.
  Promote and rollback only move a pointer and swap a symlink, so they finish almost instantly
  and can't half-apply.
- **Agent-native.** A full MCP server with OAuth 2.1 (CIMD and DCR, PKCE, consent with permission
  subsets, scope step-up) and human confirmation before destructive actions. Your agent can do
  exactly what its token allows and nothing more.
- **One brain, five surfaces.** The dashboard, optional in-dashboard assistant, REST API, MCP
  server and `skif` CLI all call the same service layer, so no surface can do more than another
  and every action is audited the same way.
- **Operable.** Prometheus metrics, traffic and error telemetry, alerts (email and webhook),
  Litestream backups to R2, a monthly restore drill, a recovery kit, and self-update with rollback
  from the dashboard.

## What works today

| | |
|---|---|
| **Deploy** | Inline uploads (≤ 5 MB) or presigned R2 uploads; `_redirects`, `_headers` and `skiff.json` compiled to Caddy routes; precompressed `br`/`gzip`; SPA mode; preview URLs; promote, rollback and retention GC |
| **Access** | Public, password-protected or platform-login sites via `forward_auth`; share links with limits and instant revocation |
| **Accounts** | Email + password, passkeys, GitHub, magic links, TOTP 2FA (owners must prove a passkey or TOTP each session), first-run setup wizard, orgs, member invites, roles, API keys |
| **Fleet** | Node agents with desired-state reconciliation, an on-disk release cache and heartbeats; wildcard TLS via DNS-01; a branded 503 with `Retry-After` when a node is down |
| **Observe** | Dashboard for fleet, projects, deployments, traffic, errors, logs and the audit log; `/metrics` on the control plane and agents; alerts for offline nodes, disk, certs, backups and 5xx spikes after a promote |
| **Recover** | Litestream → R2, scripted restore, monthly drill, age-encrypted recovery kit, atomic release switch with automatic rollback |
| **Managed services** | Postgres 16/17 databases and RustFS S3-compatible object storage as tier-3 containers: attachments with scoped credentials, Railway-style env suggestions from `.env`/code, one-click linking, usage charts, soft delete and restore, human-only credential reveal, scheduled/verified backups and restore-to-new, PgBouncer pooling, an extension allowlist with slow queries, a native database studio with a data grid and query editor for every engine (read-only by default, write mode with `database:update`), and staged credential rotation ([DATABASES.md](./docs/DATABASES.md), [OBJECT-STORAGE.md](./docs/OBJECT-STORAGE.md)) |
| **Assistant** | Optional in-dashboard chat over the same MCP tools, one agent with every tool, click-to-confirm destructive actions, and a guided tour that navigates and spotlights elements ([ASSISTANT.md](./docs/ASSISTANT.md)) |
| **v2 preview** | Sandboxed systemd process apps, Podman Quadlet containers, git builds on a builder node, custom domains with TXT verification, named environments, per-node workload budgets |

## Quick start

### 1. Install the platform on a server

On Debian or Ubuntu with Caddy installed:

```sh
curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/skiff/main/install.sh | sudo sh
```

`install.sh` only fetches Bun and the repository. Everything else is in
[`scripts/install/main.ts`](scripts/install/main.ts): preflight checks, users and directories,
secrets, build, the atomic release switch, systemd units, Caddy hand-off, edge-node enrollment,
a health check, and rollback if anything fails. Pass `--dry-run` to see the plan, `--upgrade` to
update, or `--help` for every option.

The full runbook (host layout, environment, backups, restore, key rotation) is in
[`docs/OPS.md`](docs/OPS.md).

### 2. Deploy from your terminal

```sh
npm install -g @skiffy/skiff                    # or: bun add -g / npx @skiffy/skiff

skif login --url https://control.example.com    # approve the CLI in your browser
skif deploy ./dist                              # zip, upload, promote
# Functions: a project with wrangler.jsonc is bundled by Wrangler automatically
skif deploy .                                   # runs `wrangler deploy --dry-run` on the client
skif wrangler dev                               # local Workers runtime, same as production
skif status my-site
skif rollback my-site                           # production back one deployment
```

For CI, skip the browser and use an API key: `SKIFF_URL=… SKIFF_TOKEN=skif_… skif deploy ./dist --json`.
See the [CLI README](apps/cli/README.md) for every command, profiles and JSON output.

### 3. Connect your agent

Point any MCP client that supports remote servers at `https://control.example.com/mcp`. For example,
in Claude Code:

```sh
claude mcp add --transport http skiff https://control.example.com/mcp
```

The client finds the authorization server on its own, so you approve it on a consent screen and
choose which permissions it gets.

## For agents (MCP)

Each MCP tool is a thin wrapper over the same `packages/core` call the dashboard uses. Tools carry
read-only, destructive and idempotent annotations. Deletes need a human to confirm through MCP
elicitation, and clients that don't support elicitation get a dashboard hand-off instead.

| Area | Tools |
|---|---|
| Identity | `whoami` |
| Projects | `list_projects` · `get_project` · `create_project` · `update_project` · `delete_project` |
| Deploy | `deploy_site` · `deploy_files` · `create_upload` · `finalize_upload` |
| Releases | `list_deployments` · `get_deployment` · `promote_deployment` · `rollback` |
| Environments | `list_environments` · `create_environment` · `deploy_to_environment` |
| Workloads | `get_workload` · `set_workload` · `get_node_capacity` |
| Access | `set_access` · `create_share_link` · `list_share_links` · `revoke_share_link` |
| Operate | `get_status` · `get_metrics` · `get_logs` · `get_audit_log` · `list_nodes` |

A token's effective permissions are always **its scopes ∩ the user's current role**. Demote someone
and every token they've issued narrows straight away. Every tool call is recorded in the audit log
as `mcp.<tool>`, including calls denied for missing scope.

### In-dashboard assistant (optional)

If you want help *inside* the dashboard, an owner can point Skiff at an OpenAI-compatible endpoint
(OpenAI, OpenRouter, vLLM, LM Studio or a local Ollama; OpenRouter gets a searchable, tool-capable model picker) in **Settings → Assistant**. The chat panel
uses the same MCP tool catalog, so it can answer questions about the current page and the whole
platform in one pass. Its `guide_user` tool
can move you to the right page and spotlight the element it is talking about.

Nothing is enabled until it is configured. Destructive calls are held for an explicit Confirm in
the chat and executed only with a signed, target-bound approval; chat tool calls are audited as
`assistant.<tool>`. Setup, limits and the event protocol are in [ASSISTANT.md](./docs/ASSISTANT.md).

## Architecture

```
Internet ──► Caddy (TLS, wildcard cert via DNS-01)
                │  *.contentDomain
                │        ├─ edge-placed sites: file_server from /releases/<sha>
                │        └─ worker-placed sites: reverse_proxy over WireGuard (503 + Retry-After if down)
                │  control.platformDomain
                ▼
          control plane (Bun, unix socket behind Caddy)
            dashboard · REST · MCP (OAuth 2.1) · Better Auth
            SQLite (state) · ClickHouse (telemetry) · R2 (artifacts)
                ▲
                │ desired-state long-poll + heartbeats (node token)
          node agent ──► Caddy admin API (unix socket only)
```

Skiff is a Bun monorepo:

| Package | What it is |
|---|---|
| [`apps/control-plane`](apps/control-plane) | SvelteKit app: dashboard, REST API, MCP server, auth, SQLite + ClickHouse |
| [`apps/agent`](apps/agent) | Node agent: desired-state reconciliation, Caddy admin API, release cache, `forward_auth` |
| [`apps/cli`](apps/cli) | `skif` / `skiff`: login, deploy, status, promote, rollback, logs ([npm](https://www.npmjs.com/package/@skiffy/skiff)) |
| [`apps/helper`](apps/helper) | Privileged runtime helper: renders systemd units and drives workloads over a root-only socket |
| [`apps/builder`](apps/builder) | Git build worker: runs builds in a transient `systemd-run` unit and uploads the artifact |
| [`packages/contracts`](packages/contracts) | Zod schemas, RBAC permissions, slugs, the REST and agent protocols |
| [`packages/core`](packages/core) | The single service layer every surface calls: RBAC, deploys, access, audit |
| [`packages/db`](packages/db) | Drizzle schema and forward-only SQL migrations, embedded at build time |
| [`packages/site-config`](packages/site-config) | `_redirects` / `_headers` / `skiff.json` parsing and Caddy route compilation |

The design docs are the source of truth. Start with [`docs/DESIGN.md`](docs/DESIGN.md), then the
numbered decision log in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Security model

- **One service layer.** Every surface goes through `packages/core`, so no surface can do more
  than another.
- **Tokens narrow with roles.** Effective permissions are always scopes ∩ the user's current role.
- **Two domains.** The platform and deployed content should live on separate registrable domains,
  so platform session cookies never reach content hosts. Protected sites use a stateless HMAC
  host-only cookie that the local agent verifies.
- **Deployed content is untrusted.** Strict Origin/CSRF checks, `__Host-` cookies and reserved
  slugs.
- **Least privilege.** Caddy's admin API listens only on a unix socket, and the control plane and
  agent run unprivileged. Secrets use envelope encryption with the master key in `systemd-creds`
  (TPM2 where available) and can't be read back through the API.

Found a vulnerability? Please report it privately through
[GitHub security advisories](https://github.com/KieranHolroyd/skiff/security/advisories/new)
rather than in a public issue.

## Configuration

The full environment reference is in [`docs/OPS.md`](docs/OPS.md). The control plane needs at least:

```sh
SKIFF_PLATFORM_ORIGIN=https://control.example.com
SKIFF_CONTENT_DOMAIN=example.com
BETTER_AUTH_SECRET=<32+ random bytes>
SKIFF_DATA_DIR=/var/lib/skiff/data
SKIFF_MASTER_KEY=<base64 32 bytes, or SKIFF_MASTER_KEY_FILE>
SKIFF_OBJECT_STORE=local|r2          # R2_* credentials when r2

# Optional: the in-dashboard assistant (Settings → Assistant does the same thing)
SKIFF_ASSISTANT_BASE_URL=https://api.openai.com/v1
SKIFF_ASSISTANT_MODEL=gpt-4.1-mini
SKIFF_ASSISTANT_API_KEY=sk-...
```

## Development

You need Bun ≥ 1.4, a Caddy binary for the agent, optionally ClickHouse for telemetry and
dashboards (`brew install --cask clickhouse`), and optionally Docker or R2.

```sh
bun install

# telemetry store on 127.0.0.1:18123 (the dev control plane finds it without env vars;
# telemetry tests use it too). Stop with --stop.
bun run dev:clickhouse --background

# control plane, with dev password sign-in (without the flag, a fresh .data opens the
# setup wizard: the server logs the /setup?token=… link on start)
cd apps/control-plane
SKIFF_DEV_PASSWORD_LOGIN=1 SKIFF_DATA_DIR=.data bun run dev

# CLI, pointed at the dev server
SKIFF_URL=http://localhost:5173 SKIFF_TOKEN=skif_... bun apps/cli/src/main.ts status

# agent (needs a Caddy admin socket)
SKIFF_CONTROL_URL=http://localhost:5173 \
SKIFF_NODE_ID=nod_... SKIFF_NODE_TOKEN=... \
SKIFF_DATA_DIR=/tmp/skiff-agent bun apps/agent/src/main.ts
```

Create an API key in the dashboard (Settings → API keys). In development you don't need Caddy to
view deployed sites: the dev server answers `<slug>.localhost:5173` and
`<slug>--<env>.localhost:5173` straight from the local object store, so dashboard preview links
open the real files.

> [!TIP]
> TypeScript 7 (the native compiler) type-checks the Bun packages and scripts. The SvelteKit app
> stays on TypeScript 6 for now because `svelte-check` and `typescript-eslint` still need the
> classic compiler API. Both versions are installed side by side.

### Tests

```sh
bun test           # unit + integration: core, site-config, contracts, agent, CLI, telemetry
bun run check      # type-check every package
```

End-to-end, against a running dev server with a fresh data dir:

```sh
cd apps/control-plane
SKIFF_BASE=http://localhost:5173 bun tests/rest.e2e.ts       # auth, deploys, promote/rollback, nodes, share links, audit
SKIFF_BASE=http://localhost:5173 bun tests/mcp-oauth.e2e.ts  # CIMD/DCR, PKCE, consent, scope step-up, elicitation
```

[`examples/v2-stress`](examples/v2-stress) is a deployable v2 app plus scripts that stress-test a live
workload: secrets, `/data`, env, health checks, resource limits, SSE, load, environments, git builds,
domains and the agent's activation protocol.

### Versioning

`VERSION` holds the platform version. A pre-commit hook bumps the patch number, and minor or major
releases use `bun run version:minor` / `bun run version:major`.

### Secret scanning

A pre-push hook scans outgoing commits with GitGuardian. Install it with `brew install ggshield`,
then run `ggshield auth login` once. See [`docs/OPS.md`](docs/OPS.md) for the skip switches.

## Roadmap

The full checklist is in [`docs/ROADMAP.md`](docs/ROADMAP.md). The headlines:

- **Next for v1:** installer verifies the signed release bundle, a browser setup wizard, and an
  in-process self-updater.
- **v2:** process apps and containers in installer and release builds, env and secrets UI, git
  builds with GitHub webhooks, custom domains with Cloudflare auto-records, pluggable object
  stores (Garage, MinIO, replication).
- **Clustering & HA:** hardware-aware placement, zones and roles, a private overlay, shared
  drives, multi-ingress, a control-plane standby and database replicas
  ([`docs/CLUSTERING.md`](docs/CLUSTERING.md)).
- **Later:** custom roles UI, templates and scaffolding for agents.

Competitive research and the proposed build order are in
[`docs/FEATURE-RESEARCH.md`](docs/FEATURE-RESEARCH.md).

## Contributing

Bug reports, ideas and pull requests are welcome in
[issues](https://github.com/KieranHolroyd/skiff/issues). Before you start on a larger change, read
[`docs/DESIGN.md`](docs/DESIGN.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md) and open an issue
first. Many trade-offs are already settled there, along with the options that were considered and
rejected. Please make sure `bun test` and `bun run check` pass before you open a PR.

## License

Skiff is released under the [MIT License](LICENSE).
Copyright © 2026 Kieran Holroyd.
