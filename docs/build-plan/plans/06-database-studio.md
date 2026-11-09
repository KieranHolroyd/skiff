# Database Studio (D60 implementation)

> **Superseded by [plan 22](./22-native-studio.md) / D96 (6 Nov 2026).** The DBGate studio described
> here was deleted at the native studio cutover: the image pin, helper `console/start|stop` verbs,
> `databaseConsoles` tasks, iframe proxy and framing exception, and the `console_*` columns
> (migration 0033). The helper removes leftover console sidecars once at start. Kept as history.

Status: implemented, 2026-11-05. Supersedes the "pgweb or Adminer" note in D60 with **DBGate 7.3.4**, because the
request is a full DBMS surface (SQL editor, table browser, row editing, import/export, ERD), and
DBGate is the only open-source option that supports a subpath (`WEB_ROOT`), basic auth and
`SINGLE_CONNECTION`/`SINGLE_DATABASE` cleanly.

## Shape

- On demand, one **DBGate sidecar** per database on the database's node.
- Loopback-only (`PublishPort=127.0.0.1:<port>:3000`), on the same workload network, reaching
  Postgres at `db-<id>:5432`.
- The control plane never dials a node loopback directly. It uses the same internal Caddy gateway
  pattern as the object browser (D82): the node gets `databaseGateway` host routes for
  `db-<label>.console.internal`, and the edge dials `127.0.0.1:<YOAL_DATABASE_GATEWAY_PORT>`.
- The platform proxies `/databases/<name>/studio/proxy/*` to that gateway. The platform session is
  the authentication; DBGate additionally requires HTTP Basic, whose password is generated per
  session, sealed with the org key, and injected by the proxy only. The password never reaches the
  browser, desired state, logs or MCP.
- Opening/closing does **not** re-apply the Postgres workload, so it never restarts the database.
  It travels as a separate `databaseConsoles` task list, executed by the helper's fixed verbs.
- Read-only is the default (`READONLY_yoal=1`). Write mode also requires `database:update` and is
  confirmed in the UI. The console session expires after 60 minutes and idle-stops after 15.

## Core API (implemented in `packages/core/src/databases.ts`)

```ts
console(principal, name): DatabaseConsoleView
openConsole(principal, name, raw?): DatabaseConsoleView
closeConsole(principal, name): DatabaseConsoleView
touchConsole(principal, name): DatabaseConsoleView
consoleEndpoint(principal, name): {
  host: string;            // internal gateway host
  authHeader: string;      // `Basic ...`
  webRoot: string;         // /databases/<name>/studio/proxy
  readOnly: boolean;
  expiresAt: string | null;
}
consoleTasksForNode(nodeId): DatabaseConsoleTask[]      // requested/current generation only
consoleActivation(nodeId, id): DatabaseConsoleActivation // node-authenticated
applyConsoleResults(nodeId, results): void
tickConsoles(now?): number                               // maintenance: expiry + idle
gatewayForNode(nodeId, isEdge, publicAddressOf): { listen: string | null; routes: {host, upstream}[] }
```

`DatabaseView.console` is `{ status, active, readOnly, port, expiresAt, idleMinutes, lastUsedAt, error, path }`.
The sealed password and the auth header never appear in a view.

## Agent protocol

- Desired state gains `databaseConsoles: [{ id, action: 'start' | 'stop', generation }]` and
  `databaseGateway: { listen, routes }`.
- A `start` task makes the agent fetch `GET /api/agent/database-consoles/:id` (node bearer) for
  `{ databaseId, port, webRoot, readOnly, authUser, authPassword, tls? }`, then call
  `POST /v1/workloads/:id/console/start` on the helper.
- A `stop` task calls `POST /v1/workloads/:id/console/stop`.
- Results ride the next heartbeat as `databaseConsoleResults` and are applied only when the
  generation still matches (`consoleAppliedGeneration`).

## Files

-Foundation (done):* `packages/contracts/src/database.ts`, `agent.ts`, `permissions.ts`,
`features.ts`; `packages/db/src/schema.ts`; `packages/db/migrations/0026_database_console.sql`;
`packages/core/src/config.ts`.

- *Core track:* `packages/core/src/databases.ts`, `nodes.ts`, `maintenance.ts`,
  `apps/control-plane/src/routes/api/agent/[...path]/+server.ts`, core tests.
- *Runtime track:* `apps/helper/src/{units,systemd,server,validate}.ts`, `apps/agent/src/{helper-client,database-consoles,main,caddy-config}.ts`,
  runtime tests.
- *Surface track:* `apps/control-plane/src/hooks.server.ts`, `lib/server/api.ts`,
  `routes/(dashboard)/databases/[name]/studio/proxy/[...path]/+server.ts`,
  `routes/api/v1/databases/[name]/console/+server.ts`, the database detail page/header/tabs,
  `_lib/forms.server.ts`.
- *Docs track:* `docs/DATABASES.md`, `docs/DECISIONS.md` (D60), `docs/ROADMAP.md`, `README.md`.

## Security invariants

1. The console port is loopback-only and never in a public route.
2. The basic-auth password is sealed, per session, never in desired state or logs; the browser
   receives the platform session cookie only.
3. `database:console` is required on every console call and is never a default agent scope.
4. Write mode requires `database:update`; read-only is the default.
5. Only lifecycle is audited (`database.console.open|close|expired`); proxied SQL is not logged.
6. The proxy strips hop-by-hop headers, rewrites absolute redirects, and does not cache.
7. Session expiry and idle timeout are enforced in the control plane; the node still stops the
   container when the task arrives.

## Verification

- `bun run check` plus the `contracts`, `core`, `agent` and `helper` unit suites.
- Open a studio as a user with `database:console`: the sidecar starts, DBGate loads under
  `/databases/<name>/studio/proxy/`, and the session is read-only.
- Try write mode without `database:update` (refused), then with it (allowed after UI confirmation).
- Confirm the loopback port and `db-<label>.console.internal` are not reachable outside the
  platform proxy, and that the proxy injects the sealed basic-auth header.
- Close, expire and idle-stop a session; the sidecar stops and Postgres uptime is unchanged.
- Check `database.console.open|close|expired` audit rows and verify the password never appears in
  views, desired state, logs or MCP.
- Set `YOAL_FEATURE_DB_CONSOLE=0` and confirm the Studio tab, console API and proxy path are
  unavailable.
