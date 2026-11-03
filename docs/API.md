# Skiff REST API (v1)

Base URL: `https://<platformOrigin>/api/v1`. "Platform admin" means the Better Auth admin-plugin
user role (`user.role = admin`), never an org owner/admin. Authentication is either the Better Auth session
cookie (dashboard) or `Authorization: Bearer skif_…` (API key, CLI). Every mutation also sends
`Origin: <platformOrigin>` (CSRF policy). Errors are JSON:

```json
{ "error": "conflict", "message": "\"blog\" is already taken.", "suggestions": ["blog-app"] }
```

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/whoami` | — | user, org, role, effective permissions |
| GET | `/status` | `project:read` | fleet + deployment summary |
| GET | `/metrics` | — | Prometheus text (also at `/metrics`) |
| GET | `/projects` | `project:read` | |
| POST | `/projects` | `project:create` | `{ name?, slug?, runtime?, placement?, productionAccess?, previewAccess? }` |
| GET | `/projects/:slug` | `project:read` | |
| PATCH | `/projects/:slug` | `project:update` | rename via `slug` (old slug 301s 30 days) |
| DELETE | `/projects/:slug` | `project:delete` | soft delete, restorable 7 days |
| POST | `/projects/:slug/restore` | `project:update` | |
| POST | `/projects/:slug/access` | `project:update` | `{ scope: production\|previews, mode: public\|password\|platform, password? }` |
| POST | `/projects/:slug/deploy` | `deployment:create` | inline files (`deploy_files`); the URL slug is the target (`project` in the body is optional and must match); `environment` selects a named environment |
| GET | `/projects/:slug/deployments` | `deployment:read` | |
| GET | `/projects/:slug/deployments/:id` | `deployment:read` | id or short id |
| DELETE | `/projects/:slug/deployments/:id` | `deployment:delete` | |
| POST | `/projects/:slug/deployments/:id/pin` | `deployment:promote` | `{ pinned }` |
| POST | `/projects/:slug/promote` | `deployment:promote` | `{ project, deploymentId }` |
| POST | `/projects/:slug/rollback` | `deployment:rollback` | previous deployment |
| GET | `/projects/:slug/shares` | `shareLink:read` | clear URL only on creation |
| POST | `/projects/:slug/shares` | `shareLink:create` | expiry, caps, emails, note |
| DELETE | `/projects/:slug/shares/:id` | `shareLink:revoke` | pushes revocation to agents |
| GET | `/projects/:slug/logs` | `logs:read` | static sites: empty + note |
| POST | `/uploads` | `deployment:create` | `{ project, fileCount?, totalBytes? }` → presigned PUT |
| POST | `/uploads/:id/finalize` | `deployment:create` | `{ project, uploadId?, promote?, message? }`; `uploadId` must match `:id`, and the upload must belong to `project` |
| GET | `/nodes` | platform admin | any surface (session, API key, MCP) of a platform-admin user |
| GET | `/nodes/capacity` | platform admin | workload-slice budget per node (`sliceMemoryMb`, reserved, free) |
| POST | `/nodes/:id/builder` | platform admin **session** | `{ builder: boolean }`; lets the node claim git builds |
| POST | `/nodes/join-token` | platform admin **session** | single-use, 1 h; 403 for API keys / OAuth tokens |
| POST | `/nodes/:id/drain` \| `/resume` | platform admin **session** | |
| POST | `/nodes/:id/rotate-token` | platform admin **session** | |
| GET | `/audit` | `project:read` | `?limit&action&resource` |
| GET | `/secrets` | `secret:read-metadata` | values never returned |
| POST | `/secrets` | `secret:create` | `{ name, value, projectId?, type? }` |
| DELETE | `/secrets/:id` | `secret:delete` | |
| POST | `/cli/token` | `apiKey:create` | exchange a one-time CLI login code + PKCE verifier for an API key |
| GET/POST | `/projects/:slug/environments` | `project:read` / `project:update` | list or create a named environment |
| PATCH/DELETE | `/projects/:slug/environments/:env` | `project:update` | rename/access or remove (production is built in) |
| POST | `/projects/:slug/environments/:env/promote` | `deployment:promote` | `{ deploymentId }`; moves only that environment's pointer |
| GET/PUT/DELETE | `/projects/:slug/workload` | `deployment:read` / `project:update` | tier 2/3 runtime spec for the project |
| GET/PUT/DELETE | `/projects/:slug/git` | `build:read` / `build:create` | git source, branch, build/output dirs, webhook secret |
| GET/POST | `/projects/:slug/builds` | `build:read` / `build:create` | build history or enqueue `{ ref?, promote? }` |
| GET | `/projects/:slug/builds/:id` | `build:read` | build status + full log |
| POST | `/projects/:slug/builds/:id/cancel` | `build:cancel` | |
| GET | `/domains` | `domain:read` | `?project=<slug>` to scope |
| POST | `/domains` | `domain:create` | `{ project, hostname, redirectWww? }`; returns the TXT record to create |
| GET/DELETE | `/domains/:id` | `domain:read` / `domain:delete` | deleting also removes managed Cloudflare records |
| POST | `/domains/:id/check` | `domain:read` | re-check TXT/address records and report drift |

## CLI browser login (`/cli/login`, `/api/v1/cli/token`)

`skif login` (browser sign-in is the default) opens
`GET /cli/login?redirect_uri=http://127.0.0.1:<port>/callback&state=…&code_challenge=…&code_challenge_method=S256`.
The page requires a signed-in dashboard session and, on approval, redirects a one-time code to the
loopback URI. `POST /cli/token` with `{ code, codeVerifier }` verifies the PKCE challenge, redeems
the code once, and returns `{ token, platform, contentDomain }`; `token` is a normal `skif_…` API
key for the REST API. Codes expire after five minutes and are stored hashed.

## Agent protocol (`/api/agent`)

Machine-authenticated with a node bearer token; no cookies. `POST /api/agent/join` consumes a
single-use join token and returns the node's long-lived token.

- `GET /api/agent/desired-state` — desired-state JSON; ETag `"v<version>"`; `?wait=<seconds>` long-polls
  (server cap 25). The agent sends `wait=8` to stay under Bun's default 10 s idle timeout
  (`CONNECTION_IDLE_TIMEOUT`), and re-pulls without `If-None-Match` after a failed converge so
  expired presigned release URLs are reissued. The token is checked before the wait.
- `POST /api/agent/heartbeat` — stats + actual state version every ~10 s.
- `POST /api/agent/telemetry` — pre-aggregated 1-minute access buckets (never raw requests).
- `GET /api/agent/workloads/:id/activation` — decrypted env/secret-file values for a workload
  owned by the calling node. Never cached on disk by the agent.
- `GET /api/agent/builds/next` — claim the oldest queued build (builder nodes only); returns the
  clone/ref/command plus a presigned upload URL.
- `POST /api/agent/builds/:id/log` and `POST /api/agent/builds/:id/report` — stream logs and report
  `building` / `succeeded` / `failed` / `cancelled`.

## v2 machine endpoints

- `GET|POST /api/domains/ask?domain=<host>` — Caddy on-demand TLS authorization; 200 only for a
  verified domain on a live project. Cookieless and CSRF-exempt by design.
- `POST /api/webhooks/github/:project` — `X-GitHub-Event` + `X-Hub-Signature-256`; requires the
  project's webhook secret and queues a build for pushes to the configured branch.

## Objects (local store only)

With `SKIFF_OBJECT_STORE=local`, presigned URLs point at `/api/objects/<key>?exp=&sig=` and are
verified with HMAC. With R2, URLs point directly at R2.

## Site access bridge

`GET|POST /_skiff/site-login?project=<id>&return=<content url>` authenticates a visitor (platform
session or password), redeems share links, and redirects to
`https://<host>/_skiff/callback?token=<host-bound token>` where the agent sets the host-only cookie.
The token is valid for 60 s and is redeemed once (the agent remembers its `jti`); the cookie
carries the session expiry (`sexp`).
