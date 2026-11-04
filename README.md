# Skiff

A lightweight, self-hosted private cloud for shipping static sites on your own domain, with an
operations dashboard and first-class AI agent (MCP) integration.

> "Ask your agent to deploy a website — and it does."

Skiff is a Bun monorepo:

| Package | What it is |
|---|---|
| `apps/control-plane` | SvelteKit 3 app: dashboard, REST API, MCP server, auth, SQLite + DuckDB |
| `apps/agent` | Node agent: desired-state reconciliation, Caddy admin API, release cache, `forward_auth` |
| `apps/cli` | `skif` / `skiff` command: login, deploy, status, promote, rollback |
| `packages/contracts` | Zod schemas, RBAC permissions, slugs, API + agent protocol |
| `packages/core` | The one service layer every surface calls (RBAC, deploys, access, audit) |
| `packages/db` | Drizzle schema, forward-only SQL migrations, embedded at build time |
| `packages/site-config` | `_redirects` / `_headers` / `skiff.json` parsing and Caddy route compilation |

Read the design first: [`docs/DESIGN.md`](docs/DESIGN.md), decisions in
[`docs/DECISIONS.md`](docs/DECISIONS.md), scope in [`docs/ROADMAP.md`](docs/ROADMAP.md), and
operations in [`docs/OPS.md`](docs/OPS.md). Competitive research and the proposed feature build
order are in [`docs/FEATURE-RESEARCH.md`](docs/FEATURE-RESEARCH.md).

## How it fits together

```
Internet ──► Caddy (TLS, wildcard cert via DNS-01)
                │  *.contentDomain
                │        ├─ edge-placed sites: file_server from /releases/<sha>
                │        └─ worker-placed sites: reverse_proxy over WireGuard (503 + Retry-After if down)
                │  control.platformDomain
                ▼
          control plane (Bun, unix socket behind Caddy)
            dashboard · REST · MCP (OAuth 2.1) · Better Auth
            SQLite (state) · DuckDB (telemetry) · R2 (artifacts)
                ▲
                │ desired-state long-poll + heartbeats (node token)
          node agent ──► Caddy admin API (unix socket only)
```

Deploys are **artifacts only** in v1: a `deploy_site` MCP call, `skif deploy`, or a presigned R2
upload produces an immutable, content-addressed release. Every deployment gets a preview URL;
promote and rollback only move a pointer and swap a symlink.

## Install on a server

One-line bootstrap for Debian/Ubuntu with Caddy already installed:

```sh
curl -fsSL https://raw.githubusercontent.com/KieranHolroyd/skiff/main/install.sh | sudo sh
```

`install.sh` only downloads Bun and the repository. All deployment logic lives in
`scripts/install/main.ts` (Bun): preflight, users/dirs, secrets, build, atomic release switch,
systemd units, Caddy hand-off, edge-node enrollment, health check and rollback. Pass
`--dry-run` to see the plan, `--upgrade` to update, and `--help` for every option.

## Development

Requirements: Bun ≥ 1.4, a Caddy binary for the agent (dev), and optionally Docker/R2.

TypeScript 7 (the native compiler) type-checks the Bun packages and scripts. The SvelteKit app
keeps TypeScript 6 for now because `svelte-check` and `typescript-eslint` still use the classic
compiler API that the native port does not expose; both versions are installed side by side.

```sh
bun install

# control plane (dev sign-in enabled)
cd apps/control-plane
SKIFF_DEV_PASSWORD_LOGIN=1 SKIFF_DATA_DIR=.data bun run dev

# CLI, pointed at the dev server
SKIFF_URL=http://localhost:5173 SKIFF_TOKEN=skif_... bun apps/cli/src/main.ts status

# agent (needs a Caddy admin socket)
SKIFF_CONTROL_URL=http://localhost:5173 \
SKIFF_NODE_ID=nod_... SKIFF_NODE_TOKEN=... \
SKIFF_DATA_DIR=/tmp/skiff-agent bun apps/agent/src/main.ts
```

Create an API key in the dashboard (Settings → API keys) or via `POST /api/auth/api-key/create`
with a session cookie.

Deployed sites are reachable in development without Caddy: the dev server answers
`<slug>.localhost:<port>` (and `<slug>--<env>.localhost:<port>`) straight from the local object
store, so the preview links in the dashboard open the real deployed files. Preview and production
links are generated as `http://…:5173` while the content domain is a loopback host; production
links stay HTTPS.

### Tests

```sh
bun test                 # unit + integration (core, site-config, contracts, agent, CLI, telemetry)
bun run check            # every package type-checks
```

End-to-end, against a running dev server with a fresh data dir:

```sh
cd apps/control-plane
SKIFF_BASE=http://localhost:5173 bun tests/rest.e2e.ts
SKIFF_BASE=http://localhost:5173 bun tests/mcp-oauth.e2e.ts
```

`rest.e2e.ts` covers session auth, project CRUD, inline deploy, presigned upload, promote/rollback,
node join + desired state + heartbeat, share links, password-protected site login and audit.
`mcp-oauth.e2e.ts` covers CIMD/DCR discovery, PKCE, consent, scope step-up, elicitation and the
legacy dashboard hand-off.

### v2 stress example

[`examples/v2-stress`](examples/v2-stress) is a deployable tier-2/3 app plus scripts that provision
a project through REST and then stress the live workload: secrets, `/data`, env, health, resource
limits, SSE, load, environments, git builds, domains and the agent's desired-state/activation
protocol. See its [README](examples/v2-stress/README.md).

## Security model (short version)

- Every surface (dashboard, REST, MCP, CLI) goes through `packages/core`; no surface can do more
  than another.
- Tokens are always **scopes ∩ the user's current role**, so a role change immediately narrows
  existing tokens.
- Platform and deployed content should live on **separate registrable domains**; platform session
  cookies never reach content hosts. Protected sites use a stateless HMAC host-only cookie
  verified by the local agent.
- Deployed content is untrusted: strict Origin/CSRF checks, `__Host-` cookies, reserved slugs.
- Caddy's admin API is a unix socket only; the control plane and agent run unprivileged.

## Configuration

The full environment reference is in [`docs/OPS.md`](docs/OPS.md). Minimum for the control plane:

```sh
SKIFF_PLATFORM_ORIGIN=https://control.example.com
SKIFF_CONTENT_DOMAIN=example.com
BETTER_AUTH_SECRET=<32+ random bytes>
SKIFF_DATA_DIR=/var/lib/skiff/data
SKIFF_MASTER_KEY=<base64 32 bytes, or SKIFF_MASTER_KEY_FILE>
SKIFF_OBJECT_STORE=local|r2          # R2_* credentials when r2
```
