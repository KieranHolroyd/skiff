# Server errors

A very small, built-in error tracker for the control plane itself (D171). It answers "what broke,
where, how often, and is it still happening?" without running Sentry, a log stack or anything
outside the platform database. Platform admins find it under **Settings → Server errors**.

It covers Yoal's own code. Errors inside deployed apps are the apps' business: their logs,
drains and the `promote_5xx` alert cover those.

## 1. What is recorded

| Source | Caught by | Example |
|---|---|---|
| `request` (Dashboard) | SvelteKit `handleError`, for `kind: 'unknown'` errors only, and the dashboard's "unexpected action error" fallback in `routes/(dashboard)/_lib/errors.ts` | A page load throws `TypeError` |
| `api` (REST API) | `errorResponse` in `lib/server/api.ts`, the branch that answers `{ error: 'internal' }` 500 | A handler throws something that is not a `CoreError` |
| `response` (5xx response) | `handle` in `hooks.server.ts`: any 5xx answered without an exception it already recorded | A proxy answers 502, a handler returns 503 itself |
| `background` | `reportBackgroundError(task, error)` in the boot loops: maintenance, failover, alerts, jobs, log drains, flows, operations resume | The maintenance sweep throws |

`error(4xx)`, framework errors (404s) and validation errors are expected and never recorded.
Every request runs inside an `AsyncLocalStorage` context, so code without the `event` (the REST
`errorResponse`) still records the method, path, route id, user and organisation; a request that
recorded an exception is marked so its 500 is not recorded again as a bare response.

The error page shows `Reference err_…` for an unexpected error, and a REST 500 carries
`errorId`, so a user can quote the issue to an admin.

## 2. Grouping

Events with the same fingerprint fold into one issue. The fingerprint is a hash of:

- the source and the error's class name;
- the message with ids, UUIDs, hex, numbers and quoted values masked
  (`Project prj_abc not found after 3 tries` → `Project <id> not found after <n> tries`);
- the culprit for background errors (the loop's name);
- the top three application stack frames, without line or column numbers, build chunk hashes,
  the install prefix, `node_modules` or runtime frames, so a bug keeps one issue across releases.

A bare 5xx groups by status, method and route id.

An issue is `unresolved`, `resolved` or `ignored`. A new event on a resolved issue reopens it
(`regressedAt`); an ignored issue keeps counting but stays out of the default list and raises no
alert. Deleting an issue removes its events and counts; if it happens again it starts fresh.

## 3. Storage and limits

Migration 0093: `server_error_issues`, `server_error_events` and `server_error_hourly`.

- **Counts are exact**: `event_count` per issue and one row per issue per hour.
- **Stored events are sampled**: at most one per issue per second, and 60 a minute across every
  issue, so an error storm costs counter updates, not rows. Each issue keeps its newest 50.
- **Retention**: events and hourly counts go after 30 days, and issues not seen for 90 days go
  with them (the maintenance sweep, `core.serverErrors.prune`).
- **Scrubbing**: messages and stacks lose URL credentials, bearer/basic tokens, JWTs, Yoal and
  common provider keys, AWS key ids, PEM blocks and `password=`/`token:`-style pairs before they
  are stored. Paths never keep their query string, and long token-like path segments become
  `:token`. No request body, header or cookie is ever stored.
- `capture` never throws; an error while recording an error is dropped rather than recursing.

## 4. Alerts

A new issue, or a resolved one that comes back, raises the `server_error` system alert ("New
server error", warning) with a link to the issue. Turn it off or pick its channels under
**Alerts → System alerts**. At most ten are sent an hour, whatever the number of issues.

## 5. Access and API

Reads need `platform:read` (platform admins); resolving, ignoring, reopening and deleting need
platform maintenance. The dashboard and the REST API call the same `core.serverErrors` service.

| Method | Path | Body / query |
|---|---|---|
| GET | `/api/v1/platform/errors` | `?status=unresolved\|resolved\|ignored\|all&source=&q=&before=&limit=` → `{ issues, summary, hourly, nextBefore }` |
| PATCH | `/api/v1/platform/errors` | `{ ids: [...], status }` → `{ updated }` |
| GET | `/api/v1/platform/errors/:id` | → `{ issue, events, hourly, daily }` |
| PATCH | `/api/v1/platform/errors/:id` | `{ status }` → the issue |
| DELETE | `/api/v1/platform/errors/:id` | → `{ deleted }` |

## 6. Sentry (optional)

Errors can be forwarded to Sentry as well as kept here. **Settings → Server errors → Sentry** holds
the whole configuration, so enabling it needs no environment variable, restart or root access,
and an install with no DSN never contacts Sentry.

| Field | Required | Notes |
|---|---|---|
| Send errors to Sentry | – | Off until switched on. A saved DSN with it off keeps the settings. |
| DSN | to enable | Project → Settings → Client Keys (DSN). Its public key is enough to send events. |
| Environment | – | Defaults to `production`; use it to separate staging. |
| Release | – | Defaults to `yoal@<running version>`; issues group by release. |
| Performance sample rate | – | `0` off (default), `1` every request. |
| Organisation / project slug | – | Optional; with an auth token, Yoal creates the release on boot. |
| Auth token | – | Optional, sealed with the platform data key. Needs `project:releases` (`project:write`) to create releases. Events themselves only use the DSN. |
| Include request metadata | – | Adds the client IP and request headers Sentry normally drops. Request bodies, cookies and `authorization` are always dropped. |

Forwarding uses the same `ServerErrorCapture` as the local tracker, so every source in §1 is
covered: dashboard loads and actions, REST 500s, bare 5xx responses and background loops. Each
event carries `yoal.source`, `yoal.status`, `yoal.route`, `yoal.culprit` and `yoal.org` tags and a
`yoal` context with method, path and route. The user id is set as Sentry's user; no email, IP
(unless opted in), body or header is added.

**Send test event** sends one real event with the saved configuration. The panel also shows the
live status: whether the SDK is initialised, how many events this process handed to Sentry, when
the last one went, and the last transport or release error. If Sentry is slow or down, the request
path is unaffected: forwarding is fire-and-forget and every error is still stored locally.

## 7. Not built

- Browser (client-side) errors: they would need an unauthenticated, rate-limited intake. That is the
  app-facing tracker in [APP-ERRORS.md](./APP-ERRORS.md), not part of this one.
- Agent and helper errors: agents log to their own journal (`journalctl -u yoal-agent`).
- Source maps for the production bundle: frames point at built chunks, which is enough to group
  but not to show original line numbers.
