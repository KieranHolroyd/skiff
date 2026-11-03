# Skiff REST API (v1)

Base URL: `https://<platformOrigin>/api/v1`. Authentication is either the Better Auth session
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
| POST | `/projects/:slug/deploy` | `deployment:create` | inline files (`deploy_files`) |
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
| POST | `/uploads/:id/finalize` | `deployment:create` | `{ uploadId, project, promote?, message? }` |
| GET | `/nodes` | platform admin | |
| POST | `/nodes/join-token` | platform admin | single-use, 1 h |
| POST | `/nodes/:id/drain` \| `/resume` | platform admin | |
| POST | `/nodes/:id/rotate-token` | platform admin | |
| GET | `/audit` | `project:read` | `?limit&action&resource` |
| GET | `/secrets` | `secret:read-metadata` | values never returned |
| POST | `/secrets` | `secret:create` | `{ name, value, projectId?, type? }` |
| DELETE | `/secrets/:id` | `secret:delete` | |
| POST | `/cli/token` | — | exchange a one-time CLI login code + PKCE verifier for an API key |

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

## Objects (local store only)

With `SKIFF_OBJECT_STORE=local`, presigned URLs point at `/api/objects/<key>?exp=&sig=` and are
verified with HMAC. With R2, URLs point directly at R2.

## Site access bridge

`GET|POST /_skiff/site-login?project=<id>&return=<content url>` authenticates a visitor (platform
session or password), redeems share links, and redirects to
`https://<host>/_skiff/callback?token=<host-bound token>` where the agent sets the host-only cookie.
The token is valid for 60 s and is redeemed once (the agent remembers its `jti`); the cookie
carries the session expiry (`sexp`).
