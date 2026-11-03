# @skiff/control-plane

The Skiff control plane: dashboard, REST API v1, MCP server (OAuth 2.1), Better Auth, and the
SQLite/DuckDB state stores. It runs on Bun behind Caddy over a unix socket.

See the root [`README.md`](../../README.md) for the architecture and the full dev quickstart, and
[`docs/API.md`](../../docs/API.md) for the HTTP surface.

## Scripts

```sh
bun run dev      # vite dev (set SKIFF_DEV_PASSWORD_LOGIN=1 for headless tests)
bun run build    # adapter-bun production bundle
bun run check    # svelte-check + TypeScript
bun run test     # unit tests only (e2e files are run explicitly)
bun run create-user you@example.com "Your Name" [--password …] [--org <slug> --role <role>]
```

`create-user` writes straight to `$SKIFF_DATA_DIR/skiff.db` (default `.data`), bypassing the
invite-only gate. Use it to bootstrap an owner or for local development. Start the server once
first so the auth tables exist. The password is prompted for (hidden) unless `--password` is
given; piped stdin also works. Password sign-in needs `SKIFF_DEV_PASSWORD_LOGIN=1`; otherwise
sign in with a magic link and add a passkey.

## End-to-end tests

Run against a dev server with a **fresh** data dir (tests create fixed slugs):

```sh
rm -rf .data-test
SKIFF_DEV_PASSWORD_LOGIN=1 SKIFF_DATA_DIR=.data-test \
SKIFF_PLATFORM_ORIGIN=http://localhost:5173 SKIFF_CONTENT_DOMAIN=localhost \
BETTER_AUTH_SECRET=dev-secret-0123456789abcdef0123456789 bun run dev -- --port 5173

SKIFF_BASE=http://localhost:5173 bun tests/rest.e2e.ts
SKIFF_BASE=http://localhost:5173 bun tests/mcp-oauth.e2e.ts
```

The REST test covers the full deploy pipeline, presigned uploads, nodes/desired state, share
links, password-protected sites and audit. The MCP test covers discovery (CIMD + DCR), PKCE,
consent, scope step-up, elicitation and the 2025-era dashboard hand-off.

## Key modules

- `src/lib/server/core.ts` — constructs the shared service layer (`@skiff/core`).
- `src/lib/server/principal.ts` — session/API-key/MCP token → `Principal` (role ∩ scopes).
- `src/lib/server/mcp.ts` — every v1 tool; all call the service layer.
- `src/routes/api/v1/[...path]/+server.ts` — REST router.
- `src/routes/api/agent/[...path]/+server.ts` — desired-state long-poll, heartbeat, telemetry.
- `src/routes/_skiff/site-login/+server.ts` — protected-site login and share-link redemption.
