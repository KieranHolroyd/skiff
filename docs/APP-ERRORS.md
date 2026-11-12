# App errors — top-level Errors service

Status: **built — 2026-11-12.** The ingest, core service, top-level Errors page, auto-linking,
standalone targets, filters/search, pagination, REST, MCP, environment injection, browser snippet
and tests are in place. Source maps and auto-instrumentation (Phase 3) and the CLI/metrics polish
(Phase 4) are not.

A Sentry-sized slice of Sentry for everything an organization deploys: exceptions grouped into
issues, with a stack trace, a count and a resolve button. It is an organization-level **Errors**
page, not a per-project page. A target is either a Yoal project (linked automatically or by hand)
or an off-platform app attached with its own DSN. It reuses Yoal's auth, permissions, audit log,
alerts and SQLite; there is no second service and no org → team → project → key setup.

The compatibility bet: **errors are drop-in Sentry-compatible**. An app already using a Sentry SDK
switches by changing one DSN. Static sites get a one-line script. JS, PHP and Go harnesses already
exist in `tests/harnesses/error-tracker/` and are the acceptance test for the ingest path.

---

## 1. Scope

**The whole product**

1. Open the organization-level **Errors** page.
2. Turn on **automatic linking** to give every Yoal project a numeric DSN, or attach an
   off-platform app as a standalone target with its own DSN.
3. Copy the DSN or the one-line browser snippet.
4. A Sentry SDK or the snippet sends errors.
5. Issues are grouped by bug, with stack, counts, first/last seen, environment, release and target.
6. **Resolve** marks it fixed; if it happens again, it reopens.
7. A new issue can send one alert through Yoal's existing notifiers.
8. Linked process apps and functions get the DSN injected, so most apps need no code change.

**Not building** (the fluff):

| Sentry feature | Why not |
|---|---|
| Organizations, teams, members, roles, SSO | Yoal already has orgs, projects, roles and IAM. Do not duplicate them. |
| Performance, tracing, spans, profiles | Different product; Yoal has traffic metrics and logs. |
| Session replay, screenshots, attachments | Storage and privacy cost; error management does not need them. |
| Crons, uptime, status pages, check-ins | Not errors. |
| Issue comments, assignment, mentions, ownership rules | The resolve button is the workflow. |
| Custom dashboards, Discover, a query language | The issue list is the dashboard. |
| Alert rules, escalation policies, on-call | One fixed "new issue" notification. |
| Release health, adoption, crash-free sessions | Needs sessions, which we ignore. |
| Breadcrumbs, user feedback, feature flags | Payload we would have to store, scrub and display. |
| A second database or ClickHouse table | SQLite with sampling and retention, like D171. |
| A separate error-tracker daemon | It is part of the control plane. |

The one "extra" kept is **source maps**, because a minified stack is not error management. Phase 3.

---

## 2. Why built into Yoal

- **The project already is a target.** No duplicate tenancy model, no duplicate member list. An
  off-platform app is a target without a project link.
- **Deploy metadata comes for free.** `environment` is production or preview, `release` is the
  deployment short ID or git commit, and the issue page can link back to the deployment.
- **One permission model.** Viewing needs organization `project:read`; changing anything needs
  organization `project:update`, or the linked project's `project:update` for that target.
- **One alert path.** The existing notifiers already send email, webhook, Slack, Discord, Telegram,
  ntfy, SMS and push. No new channel code.
- **One backup and one migration story.** The rows live in Yoal's SQLite; the existing backup,
  restore and prune machinery applies.
- **No new always-on process.** D171's rule: no extra stack for a small feature.

---

## 3. Drop-in Sentry compatibility

### DSN

```
https://<32-hex-public-key>@<platform-origin>/ingest/<numeric-project-id>
```

Examples:

```
https://1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d@yoal.example.com/ingest/7
https://1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d@localhost:5173/ingest/1
```

**The project id must be numeric.** The harness caught this immediately: `@sentry/node` refuses a
DSN with `prj_…` and logs `Invalid Sentry Dsn: Invalid projectId prj_js`. So `app_error_projects`
owns an autoincrement integer `dsn_project_id`; the public DSN uses it, and the service maps it back
to the Yoal `prj_…` project. The user never sees the numeric id in Yoal; it is only in the DSN.

Sentry builds the endpoint as `{base}/api/{project_id}/{endpoint}/`, so the base path `/ingest` gives:

| Endpoint | Used by |
|---|---|
| `POST /ingest/api/<dsn_project_id>/envelope/` | modern SDKs (JS, PHP, Go, Python, Ruby, Java, .NET), Relay-style clients |
| `POST /ingest/api/<dsn_project_id>/store/` | older SDKs and simple JSON clients |
| `OPTIONS` on both | browser CORS preflight |

New routes: `apps/control-plane/src/routes/ingest/api/[project]/envelope/+server.ts` and
`store/+server.ts`. `/ingest` is deliberately outside `/api` so it cannot collide with the existing
REST, agent and webhook routes.

### Authentication

Accept every form a Sentry client uses:

- `X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<key>, sentry_client=<name/version>`
- query `?sentry_version=7&sentry_key=<key>&sentry_client=...`
- the envelope header `"dsn": "https://<key>@<host>/ingest/<id>"` (the key is its userinfo)

If more than one form is present they must agree; otherwise `401`. `sentry_secret` is accepted and
ignored, as Sentry itself now does. `sentry_version` is not enforced. A key belongs to one
`dsn_project_id`; a key used on another project is rejected. An endpoint URL that carries the DSN
only as userinfo, with no auth header, query key or envelope `dsn`, is not authenticated.

### HTTP behaviour

- **CORS:** `Access-Control-Allow-Origin: *`, methods `POST, OPTIONS`, allow headers
  `content-type, x-sentry-auth, sentry-trace, baggage, traceparent, x-requested-with`, expose
  `x-sentry-rate-limits, retry-after`. No credentials, no cookies. Headers are on every response,
  including `4xx` and `429`.
- **Content types:** `application/x-sentry-envelope`, `application/json`, `text/plain` (browsers
  use `text/plain` to avoid a preflight). `multipart/form-data` is `415`.
- **Compression:** `Content-Encoding: gzip` and `deflate` accepted; anything else `415`.
- **Response:** `200 { "id": "<event_id>" }` for an accepted error. `200 {}` when an envelope has
  no error item. `400` malformed, `401` bad key, `413` too large, `415` unsupported, `429` limited.
- **Rate limits:** `X-Sentry-Rate-Limits: <retry_after>:<category>:<scope>:<reason>`, e.g.
  `60:error:project:rate_limited`. Sentry SDKs honour it and back off.

### Envelope parsing

Follow the Sentry spec, on bytes rather than a JS string:

1. First line: envelope header JSON. It may carry `event_id`, `sent_at`, `sdk` and a full `dsn`.
2. Each item: item header JSON (`type`, optional `length`) then its payload. With `length`, read
   exactly that many **bytes**; without it, read to the next newline or EOF.
3. Unknown item types are skipped and the rest of the envelope is still parsed.
4. At most one `event` item. `event_id` comes from the envelope header if present, else the event.
5. A malformed envelope is `400`; a malformed ignored item does not fail the envelope.

### Event normalisation

Sentry is not one shape, as the harness proved:

| SDK | `exception` shape | Notes |
|---|---|---|
| `@sentry/node` 11 | `{ values: [...] }` | Also sends `span` + `session` items around errors. |
| `sentry/sentry` 4 (PHP) | `{ values: [...] }` | Sends a `transaction` item when tracing is on. |
| `sentry-go` 0.50 | **an array** of exceptions | Sends `client_report` in the same envelope; `client_report` must be ignored. |

So the parser accepts `exception` as either `{ values: [...] }` or a bare array. Each value has
`type`, `value` and a `stacktrace`. The **last** value is the thrown exception; it is the one used
for the fingerprint and the headline. All values are stored and displayed as the exception chain
(oldest first). Chained errors work in all three SDKs (PHP `previous`, JS `cause`, Go `%w`).

Other fields:

- `message` (`logentry.formatted` fallback) for message events.
- `threads[].stacktrace` if there is no exception stack.
- Frames: `function`, `filename`/`abs_path` (query stripped, install prefixes removed), `lineno`,
  `colno`, `in_app`; max 100. Store top-first for display but fingerprint the top three in-app
  frames.
- `culprit`: `transaction` if present, else the top in-app frame.
- `request`: method and URL **path only** (no query, headers, cookies or body).
- `user`: `id` only; drop email, username and IP.
- `tags`: object or `[key, value]` pairs, max 20.
- `contexts`: only `browser`, `os` and `runtime` (name/version).
- `extra`: scrubbed JSON, max 4 KB.
- `environment`, `release`, `dist`, `platform`, `sdk`.
- `fingerprint`: see §8.
- `event_id`: 32 hex, dashes removed, generated if absent.
- `timestamp`: float seconds or ISO; clamped to now ± 1 hour.
- `level`: `fatal|error|warning|info|debug`; default `error`.

Everything is scrubbed with the D171 credential scrubbers before storage: URL credentials, bearer
and basic tokens, JWTs, `sk_/pk_/ghp_/xox…` keys, AWS key ids, PEM blocks and
`password=/token:/secret=` pairs. Paths lose query strings and token-like segments.

### Accepted and ignored

| Item / payload | v1 |
|---|---|
| `event` with exceptions, message, stack | **Stored** |
| `store` JSON event | **Stored** |
| `session`, `sessions` | `200`, dropped |
| `transaction`, `span` | `200`, dropped |
| `replay_event`, `replay_recording`, `profile`, `profile_chunk` | `200`, dropped |
| `check_in` | `200`, dropped |
| `attachment`, minidumps | `200`, dropped |
| `client_report` | `200`, dropped |
| `feedback` / `user_report` | `200`, dropped |

A `200` is deliberate: a `4xx` makes Sentry SDKs retry or disable features, and their session and
transaction noise must not fill the logs. Ignored item types are counted per target per hour and
shown as "ignored telemetry" in settings.

### Compatibility reality check

| Sentry behaviour | v1 |
|---|---|
| JS browser/Node/Bun, PHP, Go, Python, Ruby, Java, .NET error events | Yes, via envelope or store |
| `beforeSend`, client sampling, filtering | Yes, it runs in the SDK |
| Source map upload with `sentry-cli sourcemaps upload` | **No** — artifact bundles/debug IDs are a separate API. Our own uploader arrives in Phase 3. |
| Release/deploy APIs, `sentry-cli releases new` | No |
| Grouping identical to Sentry | No — similar, but our fingerprint is simpler |
| Sessions/transactions/replays/crons | Accepted and discarded |
| User feedback widget | Discarded |
| Native/mobile minidump endpoints | Not implemented |

Stacks still point at file:line without maps; they are just minified. That is the honest limit.

---

## 4. Harnesses (already built)

`tests/harnesses/error-tracker/` contains real Sentry SDK harnesses for **JS, PHP and Go**, plus a
capture sink and a runner. They are how the parser was prototyped and how the ingest route will be
accepted.

```sh
cd tests/harnesses/error-tracker
./setup.sh
./run.sh                 # sink + all three languages
./run.sh --repeat 2      # grouping check
./run.sh --dsn 'https://<key>@<host>/ingest/<numeric-project-id>'
```

Each language sends six stable scenarios: `simple`, `chained`, `message`, `tags` (tags, user, extra
and a fake secret to prove scrubbing), `normalize` (ids/numbers/UUIDs in the message) and
`telemetry` (a transaction). The sink writes the raw envelope and a best-effort parse to
`captures/`, which are the fixtures for parser tests. See the harness README for details.

Findings from the first run, now baked into the design:

- **Numeric DSN project ids are mandatory** (JS rejects `prj_…` outright).
- **Go sends `exception` as an array**; JS and PHP send `{ values: [...] }`.
- **Telemetry item types differ**: JS v11 sends `span` + `session`, PHP and Go send `transaction`,
  Go adds `client_report`. All must be ignored with a `200`.
- **All three send `X-Sentry-Auth` and an envelope `dsn` header**, so both auth paths must agree.
- Chained exceptions arrive as two values in all three SDKs; the last one is the thrown error.

Limits: the JS harness is Node, not a browser; minidumps and source-map upload are not exercised.
The sink never validates auth, rate limits or retention; the real route tests do.

---

## 5. Setup experience

### On the Errors page

**Errors → Targets** shows two configuration paths:

- **Automatic linking.** One switch creates a linked target for every current project; every new
  project gets one as it is created. Turning it off disables the targets it created and keeps their
  data.
- **Attach an off-platform project.** Give it a name; Yoal creates a standalone target with its own
  DSN. This is for an app that is not deployed by Yoal.

Every target row shows:

- the DSN and a copy button;
- **"Already using Sentry? Replace your DSN with this. That's it."**
- a browser snippet for static sites;
- a **Send test error** button that pushes a real event through the ingest path;
- enable/disable, rotate key, stored-event sample rate, notification toggle and delete.

No wizard, no environment picker, no platform picker, no team.

### Browser (one line)

```html
<script src="https://<platform>/e.js"
        data-dsn="https://<key>@<platform>/ingest/7"
        data-release="web@1.4.2"
        data-environment="production"></script>
```

`/e.js` is a small script served by the control plane (content-hashed, one-year cache). It captures
`window.onerror` and `unhandledrejection`, dedupes identical errors for a second, and posts a Sentry
`store` event with query-string auth (`text/plain`, so no preflight). It uses `sendBeacon` on
`pagehide`, otherwise `fetch` with `keepalive`. `data-release`/`data-environment` are optional;
without them `localhost` is `development`, everything else `production`.

If the site has a CSP, allow the platform origin in `script-src` and `connect-src`.

### Existing Sentry SDKs

```ts
Sentry.init({ dsn: 'https://<key>@<platform>/ingest/7', release: 'web@1.4.2' });
```

Nothing else changes. The SDK still does its client-side filtering; the tracker ignores sessions,
transactions, replays and attachments.

### Injected into Yoal apps

For a linked target that is enabled, `WorkloadService.activation` adds defaults before the spec's
own env:

- `SENTRY_DSN` — the target DSN;
- `SENTRY_RELEASE` — the deployment short ID or git commit;
- `SENTRY_ENVIRONMENT` — `production` or `preview`.

Sentry SDKs read these on startup, so a process app needs no config. The workspace's own env is
spread **after** the defaults, so an app that already sets `SENTRY_DSN` wins. Functions get
`SENTRY_DSN` as a text binding; their release and environment come from the function's own
deployment metadata rather than a per-invocation binding. If auto-injection is unwanted, the
defaults are not secrets and can be overridden per project.

---

## 6. Architecture

```
 browser / Sentry SDK
        │  POST /ingest/api/<numeric-id>/{envelope,store}/
        ▼
 control plane: ingest route → parse → scrub → fingerprint
        │                                                    │ 100 ms / 500 events
        │                                                    ▼
        │                                     SQLite: targets, issues, events, hourly, usage
        ▼
 dashboard /errors · REST /api/v1/projects/:slug/errors · MCP
```

- **Ingest writes synchronously, with sampling.** One event is one SQLite transaction; the rate
  limit and sampling keep that bounded, and the current path is simple. A write queue flushed every
  100 ms is a later scale step if a single project ever needs it; it is not in this build.
- **One service layer.** `packages/core/src/app-errors.ts` (`AppErrorService`) owns ingest,
  queries, status changes, keys, settings and prune. The dashboard, REST and MCP call it, like every
  other Yoal feature.
- **SQLite only.** No ClickHouse table, no object storage, no new daemon. Sampling and retention keep the
  database bounded.
- **Single writer.** Yoal has one active control plane (D5); there is no multi-writer ingest.
- **Contracts:** `packages/contracts/src/app-errors.ts` for event schemas, list queries, views and
  limits.
- **Migration:** `packages/db/migrations/0110_app_errors.sql` and `0111_app_error_targets.sql`.

---

## 7. Data model

| Table | Contents |
|---|---|
| `app_error_projects` | A target: `dsn_project_id INTEGER PRIMARY KEY AUTOINCREMENT`, `project_id TEXT UNIQUE` (the Yoal `prj_…` for a linked target, or `ext_…` for a standalone app), `org_id`, `name`, `kind` (`project` or `standalone`), `auto_linked`, enabled, sample rate, notification channels, created/updated. |
| `app_error_settings` | `org_id → auto_link`, one row per organization for the top-level switch. |
| `app_error_keys` | id, target, `public_key` (32 hex), label, created/revoked. One active key per target. |
| `app_error_issues` | `aei_…`, target, fingerprint, platform, environment, name, message, culprit, level, status, exact `event_count`, first/last seen, first/last release, regression/resolution. Unique `(project_id, fingerprint)`. |
| `app_error_events` | `aev_…`, target, issue, `event_id` (Sentry 32 hex), received_at, timestamp, level, message, `exceptions_json` (the chain with frames), path, method, release, environment, `tags_json`, `contexts_json`, `extra_json`, user id, platform, sdk. Unique `(project_id, event_id)`. |
| `app_error_hourly` | `(issue_id, hour) → count`, exact. |
| `app_error_usage` | `(project_id, month) → accepted, dropped, ignored`, for the cap and the settings panel. |

- The internal `project_id` is either a Yoal project id or the synthetic `ext_…` id of a standalone
  target. Every issue, event, key and usage row keys off it, so the ingest path does not care which
  kind of target it wrote to.
- `dsn_project_id` is the only place a numeric id exists. It is allocated once per target and never
  reused, so a DSN cannot be recycled onto another target.
- Deleting a Yoal project cascades its linked target's keys, issues, events, hourly rows and usage.
  Deleting a standalone target does the same; the off-platform app is untouched.
- Turning automatic linking off disables only targets marked `auto_linked`; it never deletes data.
- `events` keeps the newest 50 per issue. Counts come from `issues.event_count` and
  `app_error_hourly`; a sampled-out event never changes the count.
- All timestamps are integer milliseconds; Sentry's float seconds and ISO strings are normalised.

---

## 8. Grouping and lifecycle

Default fingerprint = SHA-256 of:

- `platform` + `environment`;
- the last exception's type;
- its value with UUIDs, ids, hex, numbers and quoted strings masked (reuse the D171 normaliser);
- the top three **in-app** frames as `function@filename`, without line/column, build hashes,
  `node_modules`, runtime or extension frames;
- the culprit (query stripped, numeric/UUID path segments masked) if present.

Environment is included so staging never reopens or inflates a production issue. Release is not
included, so a bug survives deploys. Level is not included.

If the client sends `fingerprint`, a plain list is used verbatim; `{{ default }}` is replaced by the
computed key; `{{ transaction }}`, `{{ error.type }}` and `{{ error.value }}` are supported; unknown
placeholders stay literal, like Sentry. That is the only grouping control. No merge/split UI.

Lifecycle: `unresolved` → `resolved` / `ignored`. A new event on a resolved issue sets `regressed_at`,
clears the resolution and reopens. An ignored issue keeps counting, stays out of the default list
and never alerts. Delete removes the issue, its events and counts; a fresh occurrence starts over.

---

## 9. Limits, security and abuse

- **Per target:** 600 accepted events/minute, burst 50; in-memory token bucket.
- **Global ingest:** 5 000 accepted events/minute, to protect SQLite.
- **Monthly cap:** platform policy `appErrorEventsPerMonth`, default 100 000 per target. Past it,
  respond `429` with `X-Sentry-Rate-Limits: 3600:error:project:quota_exceeded` and count the drop.
  The target panel shows usage. It never blocks a deploy or a request.
- **Stored events:** at most one per issue per second, 50 per issue, 500 per target per minute.
  Counts remain exact.
- **Payload:** envelope 1 MB decompressed, event 512 KB, 100 frames, 20 tags, 4 KB extra, 16 KB
  of exception chain and values after frame trimming; oversized events answer `413`.
- **Retention:** events and hourly counts 30 days; issues not seen for 90 days; usage 13 months;
  source maps 90 days after their release last received an event. The existing maintenance sweep
  runs the prune.
- **Key rotation:** a new key can coexist for a rollout; old keys get a 24-hour grace period, then
  401. Turning tracking off rejects immediately.
- **PII:** never store request headers, cookies, bodies, query strings, `user.email`,
  `user.username` or `user.ip`. Sentry SDKs may send them; normalisation drops them. Messages,
  stacks, tags, contexts and extra are scrubbed. `sendDefaultPii` cannot override this.
- **XSS:** every stored string is escaped by the UI; no `{@html}` on user data.
- **CSRF:** SvelteKit's global CSRF check must **not** run for the ingest routes — it rejects the
  cross-origin `text/plain` the browser snippet uses. Disable `csrf.checkOrigin` in
  `svelte.config.js` and enforce `Origin` on mutating dashboard requests in `hooks.server.ts`;
  ingest is authenticated by the DSN key, not cookies.
- **Abuse:** rate limits, the monthly cap, body caps, sampling and retention bound a leaked key.
  Rotating the key is the remedy; no captcha or reputation system in v1.
- **Audit:** enabling, settings changes, key rotation, bulk status changes and deletes are recorded
  as `app_errors.*`. Individual ingest events are not audited.

---

## 10. UI: top-level Errors page

**Observe → Errors** is an organization-level page, not a project sub-page. It has two tabs.

**Issues** (default; `?tab=issues`):

- filters: status tabs (Unresolved / Resolved / Ignored / All), target, environment, release, time
  range (24h / 7d / 30d / all), search over name/message/culprit/issue id;
- rows: level, `Name: message`, target name and project slug, culprit, count, last seen;
- keyset pagination via `before`, behind a **Load older issues** link.

**Issue detail** (the same page with `?issue=<issueId>`, opened from a row or an alert link; the
card has a back link):

- name + message, target, status buttons (Resolve / Ignore / Reopen / Delete), first/last seen,
  count, environment and release badges;
- 24-hour and 14-day bar charts from `app_error_hourly`;
- the exception chain and top-first frames with `file:line:col`, in-app highlighted;
- tags, browser/os/runtime, extra and request path;
- the newest stored events (at most 50 per issue).

**Targets** (`?tab=targets`):

- the **Automatic linking** switch with its consequences spelled out;
- **Attach an off-platform project**, one name field and a DSN;
- one row per target: name, kind (`Yoal project` / `Off-platform`), auto-linked/manual, enabled,
  DSN with copy, unresolved and 24-hour counts, last seen, Send test, Rotate key, Enable/Disable,
  Delete, and a settings form for name, stored-event sample rate, notification toggle and usage.

No comments, assignee, breadcrumbs, merge/split or "seen by". Project pages do not get an Errors tab;
the top-level page is the only error view.

Empty state: *"No errors here"* with the target hint, or *"No issues match these filters"* when a
filter is active.

Permissions: viewing the page needs the organization-level `project:read`; linked targets are
further filtered to projects the caller can read. Configuring auto-linking, attaching off-platform
targets, rotating keys and changing target settings needs organization-level `project:update`.
Platform admins pass through IAM as usual.

---

## 11. Alerts

One fixed notification per target, not a rule builder:

- **New issue** and **regressed issue** send once through the platform's configured notifier channels,
  at most 10 per hour per target.
- Detail: target name, environment, `Name: message`, culprit, first release, link to the issue on
  the top-level Errors page.
- Off by default; one checkbox turns it on. Recording errors never depends on delivery.
- No resolved notifications, repeats, digests, escalation or on-call.

Implementation: `AppErrorService` fans out to `ctx.notifiers` with the same `AlertMessage` shape the
existing alerts use, so there is no new channel code. Platform system alerts are not used; app
errors belong to the organization.

---

## 12. Surfaces

**REST** and **MCP** remain project-scoped thin wrappers over `core.appErrors`, for callers that
already know the project; the top-level page calls the organization-scoped service methods directly.

| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/projects/:slug/errors?status=&environment=&release=&q=&range=&before=&limit=` | `project:read` |
| GET | `/api/v1/projects/:slug/errors/:id` | `project:read` |
| PATCH | `/api/v1/projects/:slug/errors` `{ ids, status }` | `project:update` |
| DELETE | `/api/v1/projects/:slug/errors/:id` | `project:update` |
| GET/PATCH | `/api/v1/projects/:slug/errors/settings` | read / `project:update` |
| POST | `/api/v1/projects/:slug/errors/key/rotate` | `project:update` |
| POST | `/api/v1/projects/:slug/errors/test` | `project:update` |

**Public ingest:** `/ingest/api/<dsn_project_id>/{envelope,store}/` and `OPTIONS`, unversioned
because it is embedded in apps and must never move.

**MCP:** `list_app_errors` (project, status, environment, range), `get_app_error` (issue + recent
events + stacks), `update_app_errors` (`resolve`/`ignore`/`reopen`). Read needs `project:read`, write
`project:update`. No tool returns a key except the setup view behind `project:update`.

**CLI (Phase 4):** `yoal errors ls|show|resolve|ignore`.

---

## 13. Source maps (Phase 3)

- For git builds Yoal already owns the build output. Copy `*.js.map` and `*.css.map` to a private
  app-errors map store (not served) and index by release + path.
- At read time, match a frame's filename to a map (suffix, then basename), resolve file/line/column/
  name with `@jridgewell/trace-mapping`, and cache parsed maps in an LRU. Show the original frame
  plus a few `sourcesContent` lines when present.
- Uploaded (non-git) sites can use `POST /api/v1/projects/:slug/errors/sourcemaps` with a zip/tar,
  up to 20 MB. Reject absolute paths, `..`, symlinks and more than 100 MB extracted.
- The SDK must send `release`; injection already does that for Yoal apps, and the snippet has
  `data-release`.
- Frames with no map fall back to the minified location, clearly marked.
- **Sentry CLI:** `sentry-cli sourcemaps upload` uses artifact bundles and debug IDs; that API is out
  of scope. Legacy `sentry-cli releases files upload-sourcemaps` may follow if it is worth it. Do
  not claim it works until it does.

---

## 14. Build plan

### Phase 0 — service and ingest — **built**

- `packages/contracts/src/app-errors.ts`: Sentry event schema, list query, views, statuses, limits.
- `packages/db/migrations/0110_app_errors.sql` and `0111_app_error_targets.sql`: the target,
  settings, key, issue, event, hourly and usage tables.
- `packages/core/src/app-errors.ts`: `AppErrorService` with `ingest`, `serviceView`, `setAutoLink`,
  `createProjectTarget`, `createStandaloneTarget`, `updateTarget`, `orgList`, `orgGet`,
  `orgSetStatus`, `orgDeleteIssue`, `prune`, `consumerEnv`; exported pure helpers for the parser,
  fingerprint and scrub.
- `apps/control-plane/src/routes/ingest/api/[project]/envelope/+server.ts` and `store/+server.ts`:
  CORS, auth, caps, rate limit, `200`.
- Wire `ctx.appErrors` into `packages/core/src/index.ts` and the maintenance sweep.
- Parser tests from harness captures: JS, PHP and Go envelopes, `exception` object vs array,
  `client_report`, `span`/`session`/`transaction`, gzip, byte lengths, unknown items. Commit a small
  redacted fixture set under `packages/core/src/app-errors/fixtures/` so CI does not need PHP/Go.
- Unit tests: auth forms, CORS, caps, rate limit, grouping, scrubbing, retention, cascade delete.

### Phase 1 — the usable product — **built**

- Organization-level `Errors` page in the sidebar (Observe), with Issues and Targets tabs.
- Target list, auto-link switch, manual project link, off-platform attachment, setup panel, status
  actions, delete, test event.
- Filters, search, pagination and issue detail.
- REST routes and `docs/API.md`; MCP tools.
- User docs page `packages/docs/content/observe/app-errors.md`.
- Run the JS/PHP/Go harness against a dev install; `--repeat 2` must group.

### Phase 2 — zero-config apps — **built**

- Inject `SENTRY_DSN`/`SENTRY_RELEASE`/`SENTRY_ENVIRONMENT` in `WorkloadService.activation` and the
  function host spec.
- Ship `/e.js` and the snippet panel; cache headers and CSP note.
- Target alerts through the existing notifier fan-out.
- Usage/cap display and ignored-telemetry counts.

### Phase 3 — source maps — **not built**

- Map capture for git builds, upload endpoint, frame resolution, LRU, prune.
- Optional auto-instrumentation for git builds.
- Legacy Sentry release-file upload only if a real user needs it.

### Phase 4 — polish — **not built**

- CLI commands, org-level roll-up, error counts in `/metrics/apps`.
- Optional per-project retention/sample-rate settings.

---

## 15. Acceptance tests

**Compatibility**

- JS (`@sentry/node`), PHP (`sentry/sentry`) and Go (`sentry-go`) harnesses all send six scenarios
  and the tracker stores five issues plus ignored telemetry.
- `--repeat 2` leaves one issue per stable scenario with count 2.
- A `sentry-python` project works by changing the DSN.
- An old `/store/` payload works.
- A transaction/session/replay envelope returns `200` and stores nothing; the ignored count moves.
- The browser snippet works from a static site, including CORS and `sendBeacon` on pagehide.

**Product**

- Automatic linking creates a target for every existing project and for a project created later;
  turning it off disables auto-linked targets and keeps data.
- A manual project link creates one target while automatic linking is off.
- An off-platform target ingests, lists, resolves and deletes from the top-level page.
- The top-level Issues tab filters by target and shows the target name and project slug.
- Resolve then throw again reopens the same issue with `regressed_at`.
- Ignore then throw again counts but stays out of the default list and does not alert.
- Two environments are separate issues; two releases are one issue with first/last release.
- 10 000 events in a minute leaves a bounded database, returns `429`s and shows dropped counts.
- Wrong key, wrong target, revoked key `401`; oversized body `413`; bad gzip `400`.
- No headers, cookies, query strings, email or IP in any stored row.
- Deleting the Yoal project removes every row and key for its linked target.
- Permissions: organization `project:read` can view, not mutate; organization `project:update`
  (or the linked project's `project:update`) can manage targets.

**Operations**

- A backup/restore of Yoal's SQLite brings issues/events back.
- The migration applies over a populated database.
- The maintenance prune drops old events, hourly counts, quiet issues and maps.

---

## 16. Decisions to confirm

1. **DSN path.** Recommended `/ingest/<numeric-dsn-target-id>`, with the numeric id allocated per
   target. It is required by the Sentry SDKs and keeps `/api` clean. The alternative — a
   query-param or custom SDK — is not drop-in.
2. **Injection.** Recommended injecting `SENTRY_DSN`/`SENTRY_RELEASE`/`SENTRY_ENVIRONMENT` as
   overridable defaults. The alternative is `YOAL_ERRORS_*` only, which needs one line of app code.
3. **Alerts.** Recommended off by default, one toggle, existing channels; no rule builder.
4. **Monthly cap.** Recommended 100 000 accepted events/project/month as a platform policy, not a
   deploy-blocking quota.
5. **Source maps.** Recommended git builds + own uploader in Phase 3; explicitly do not claim
   `sentry-cli` source-map compatibility.
6. **Browser SDK.** Recommended a tiny `/e.js` for static sites and Sentry's own browser SDK for
   bundled apps. Do not write a second full SDK.

## 17. Success check

- An owner turns on automatic linking once and every project has a DSN; a new project gets one
  without another visit.
- An off-platform app gets a target and a DSN without a Yoal project.
- A Sentry user changes one DSN and their error page keeps working with their existing SDK.
- A static site owner pastes one line and sees a grouped exception in under a minute.
- A process app or function reports errors with no code change because the DSN and release were
  injected.
- The dashboard has no concept the user did not ask for.
- A 10 000-event storm cannot take down the control plane or grow the database without bound.
- The Errors page, the issue page and the target settings feel like the rest of Yoal.
