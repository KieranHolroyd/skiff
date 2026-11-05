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
| GET | `/projects` | `project:read` | `?trash=1` lists the trash (with `deletedAt`, `purgeAt`) |
| POST | `/projects` | `project:create` | `{ name?, slug?, runtime?, placement?, productionAccess?, previewAccess? }` |
| GET | `/projects/:slug` | `project:read` | |
| PATCH | `/projects/:slug` | `project:update` | rename via `slug` (old slug 301s 30 days) |
| DELETE | `/projects/:slug` | `project:delete` | soft delete, restorable 7 days |
| POST | `/projects/:slug/restore` | `project:update` | re-checks the project quota |
| GET | `/operations/actions` | — | mass actions the caller can run (docs/OPERATIONS.md) |
| POST | `/operations` | per action | `{ action, targets?, scope?, categories?, stage: plan\|apply }`; `Idempotency-Key` header; `?wait=<s≤25>` → `202 { operation }`. Prune must be planned first |
| GET | `/operations` | `project:read` | `?kind&status&limit`; `?scope=platform` for platform admins |
| GET | `/operations/:id` | creator or `project:read` | `?items=1&after&limit&status&verdict&category`, `?wait` |
| GET | `/operations/:id/stream` | same | SSE: `progress`, `items` (`id: <seq>`, resume with `Last-Event-ID`), `done`; `?until=done` follows an applied plan to the end |
| POST | `/operations/:id/apply` | per action, planner only | from `planned`; `{ categories? }` narrows a prune |
| POST | `/operations/:id/cancel` | creator or `project:delete` | stops after the current item |
| POST | `/projects/:slug/access` | `project:update` | `{ scope: production\|previews, mode: public\|password\|platform, password? }` |
| POST | `/projects/:slug/deploy` | `deployment:create` | inline files (`deploy_files`); the URL slug is the target (`project` in the body is optional and must match); `environment` selects a named environment. Process/container projects run one workload, so only the latest deployment is active |
| GET | `/projects/:slug/deployments` | `deployment:read` | |
| GET | `/projects/:slug/deployments/:id` | `deployment:read` | id or short id |
| DELETE | `/projects/:slug/deployments/:id` | `deployment:delete` | |
| POST | `/projects/:slug/deployments/:id/pin` | `deployment:promote` | `{ pinned }` |
| POST | `/projects/:slug/promote` | `deployment:promote` | `{ project, deploymentId }` |
| POST | `/projects/:slug/rollback` | `deployment:rollback` | previous deployment |
| GET | `/projects/:slug/shares` | `shareLink:read` | clear URL only on creation |
| POST | `/projects/:slug/shares` | `shareLink:create` | expiry, caps, emails, note |
| DELETE | `/projects/:slug/shares/:id` | `shareLink:revoke` | pushes revocation to agents |
| GET | `/projects/:slug/logs` | `logs:read` | `?after&limit&source&buildId&deploymentId&level&q`; ordered events plus a `cursor` for tailing |
| POST | `/uploads` | `deployment:create` | `{ project, fileCount?, totalBytes? }` → presigned PUT |
| POST | `/uploads/:id/finalize` | `deployment:create` | `{ project, uploadId?, promote?, message? }`; `uploadId` must match `:id`, and the upload must belong to `project` |
| GET | `/nodes` | platform admin | any surface (session, API key, MCP) of a platform-admin user |
| GET | `/nodes/capacity` | platform admin | workload-slice budget per node (`sliceMemoryMb`, reserved, free) |
| PATCH | `/nodes/:id` | platform admin **session** | any of `{ name, publicAddress (host[:port] or null), sliceMemoryMb (32–65536, ≥ reserved), sliceCpuWeight (1–10000), canBuild, dataDir, buildDir, defaultVolumeId }`; agents apply it on their next pull. `dataDir`/`buildDir` (absolute paths, `null` = default) move node storage (D48); progress is in `storage.status` on the node. `defaultVolumeId` (or `null`) picks the volume new managed instances use (D74) |
| POST | `/nodes/:id/builder` | platform admin **session** | `{ builder: boolean }`; lets the node claim git builds |
| POST | `/nodes/join-token` | platform admin **session** | single-use, 1 h; 403 for API keys / OAuth tokens |
| POST | `/nodes/:id/drain` \| `/resume` | platform admin **session** | |
| POST | `/nodes/:id/rotate-token` | platform admin **session** | |
| GET | `/nodes/:id/volumes` | platform admin | `{ volumes: VolumeView[], inventory: { generatedAt, mounts, devices } \| null }`. `mounts` is what the node reports (stable `sourceKey`, mount path, fs type, size/free, `remote`); `devices` is the free/used block-device list for the provisioning wizard (D72) |
| POST | `/nodes/:id/volumes` | platform admin **session** | `{ name, sourceKey, default? }` adopts a mount from the latest inventory; no formatting or mounting happens (P0). 409 when the mount is not reported right now, the name/source is taken, or the node has not sent an inventory yet |
| PATCH | `/nodes/:id/volumes/:name` | platform admin **session** | `{ name?, default? }`; `default: true` makes it the node default, `false` clears it |
| DELETE | `/nodes/:id/volumes/:name` | platform admin **session** | removes the registration only; the mount stays. 409 while storage/database instances still live on it (D74) |
| GET | `/audit` | `project:read` | `?limit&action&resource` |
| GET | `/secrets` | `secret:read-metadata` | values never returned |
| POST | `/secrets` | `secret:create` | `{ name, value, projectId?, type? }` |
| DELETE | `/secrets/:id` | `secret:delete` | |
| POST | `/cli/token` | `apiKey:create` | exchange a one-time CLI login code + PKCE verifier for an API key |
| GET/POST | `/projects/:slug/environments` | `project:read` / `project:update` | list or create a named environment |
| PATCH/DELETE | `/projects/:slug/environments/:env` | `project:update` | rename/access or remove (production is built in) |
| POST | `/projects/:slug/environments/:env/promote` | `deployment:promote` | `{ deploymentId }`; moves only that environment's pointer (production also re-points a process/container workload) |
| GET/PUT/DELETE | `/projects/:slug/workload` | `deployment:read` / `project:update` | tier 2/3 runtime spec for the project |
| GET/PUT/DELETE | `/projects/:slug/git` | `build:read` / `build:create` | git source, branch, build/output dirs, webhook secret |
| GET/POST | `/projects/:slug/builds` | `build:read` / `build:create` | build history or enqueue `{ ref?, promote? }` |
| GET | `/projects/:slug/builds/:id` | `build:read` | build status + full log |
| POST | `/projects/:slug/builds/:id/cancel` | `build:cancel` | |
| GET | `/domains` | `domain:read` | `?project=<slug>` to scope |
| POST | `/domains` | `domain:create` | `{ project, hostname, redirectWww? }`; returns the TXT record to create |
| GET/DELETE | `/domains/:id` | `domain:read` / `domain:delete` | deleting also removes managed Cloudflare records |
| POST | `/domains/:id/check` | `domain:read` | re-check TXT/address records and report drift |

## Managed databases

Org-owned PostgreSQL run as tier-3 containers ([DATABASES.md](./DATABASES.md), D55–D61). Names
follow slug rules and are unique per org. Responses carry a `DatabaseView` (status, node, limits,
`sizeBytes`, `attachments`, the latest top-50 `tables` snapshot, `deletedAt`/`purgeAt`) and never
contain credentials, except `/credentials`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/databases` | `database:read` | `?includeDeleted=1` adds the trash → `{ databases }` |
| POST | `/databases` | `database:create` (+ `project:update` with `project`) | `{ name, engine?, version? (16\|17), placement? (auto\|edge\|node id), memoryMb?, cpus?, storageMb?, volume?, project?, envPrefix?, extensions?, pooler? }` → `201 { database }`. Placement is resolved once; with `project` it follows the project's node and the attachment is created in the same call |
| GET | `/databases/:name` | `database:read` | `?includeDeleted=1` to read a trashed one → `{ database }` |
| PATCH | `/databases/:name` | `database:update` | any of `{ memoryMb, cpus, storageMb, extensions, pooler }`; more memory re-checks admission → `{ database }` |
| DELETE | `/databases/:name` | `database:delete` | soft delete, restorable 7 days; 409 while projects are attached → `{ database }` |
| DELETE | `/databases/:name?purge=1` | `database:delete` | trashed databases only: the node removes the data, then the row goes → `{ ok: true }` |
| POST | `/databases/:name/restore` | `database:delete` | re-checks admission; 409 once a purge was requested → `{ database }` |
| GET | `/databases/:name/credentials` | `database:credentials` | `{ credentials: { url, host, port, username, password, databaseName, note } }`; loopback URL on the database's node; `cache-control: no-store`; every read is audited. Not available over MCP (D58) |
| GET | `/databases/:name/metrics` | `database:read` | `?from&to` (ISO or epoch ms; default the last hour) `&interval=1m\|1h` (default `1m`, `1h` when the range exceeds 48 h; `1m` over 48 h is rejected; ranges ≤ 92 days) → `{ points, interval }`. Counters are per bucket |
| GET | `/databases/:name/backups` | `database:read` | `{ backups }` (size, SHA-256, status, verified restore) |
| POST | `/databases/:name/backups` | `database:update` | `{ pinned? }` → `202 { backup }`; the node streams a `pg_dump -Fc` to the object store |
| GET/DELETE | `/databases/:name/backups/:id` | `database:read` / `database:delete` | one artifact; delete removes the object first |
| POST | `/databases/:name/backups/:id/restore` | `database:create` (+ `project:update` with `project`) | `{ name, placement?, memoryMb?, cpus?, storageMb?, volume?, project?, envPrefix? }` → `202 { database }`; restore always creates a new database and verifies it |
| GET/PATCH | `/databases/:name/backup-policy` | `database:read` / `database:update` | `{ enabled, schedule (five-field UTC cron), retentionDays }` |
| GET/POST | `/databases/:name/rotate` | `database:read` / `database:credentials` + `database:update` | `{ role: owner\|monitor }` → `202 { rotation }`; the node applies ALTER ROLE before the secret swaps |
| POST | `/databases/:name/restart` | `database:update` | `{ target: "database"\|"pooler" }` → `202 { database, target }`; database restarts the container and pooler, pooler restarts only PgBouncer |
| GET | `/projects/:slug/databases` | `database:read` | `{ attachments }` with the env names each one injects |
| POST | `/projects/:slug/databases` | `database:update` + `project:update` | `{ database, envPrefix? (UPPER_SNAKE, default DATABASE) }` → `201 { attachment, warning }`. The project gets `<PREFIX>_URL`, `_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `_NAME` at activation and restarts; `warning` says when it must be redeployed onto the database's node (same node only, D56) |
| DELETE | `/projects/:slug/databases/:name` | `database:update` + `project:update` | detach; the app re-activates without the variables → `{ ok: true }` |

**MCP tools.** `list_databases` (`includeDeleted?`), `get_database` (the view plus a `lastHour`
summary: latest size vs the storage budget, connections vs `max_connections`, commits/min,
cache hit ratio), `create_database` (same input as `POST /databases`; step-up adds
`project:update` only when `project` is given), `attach_database` (`{ project, database,
envPrefix? }`), `detach_database` (`{ project, database }`) and `delete_database` (soft delete,
confirmed by multi-round-trip input bound to the database, refused before prompting while
attached; 2025-era clients get a dashboard link). There is **no credentials tool and no purge**
over MCP (D58, D53). Guide: `skiff://guides/databases`.

**CLI.** `skif db list [--all]`, `create <name> [-p <project>] [--prefix P] [--version 16|17]
[--placement …] [--memory 256M] [--cpus 1] [--storage 10G]`, `info <name>` (status, node, size
vs budget, attachments, top tables), `attach|detach <name> -p <project> [--prefix P]`,
`delete <name>` (asks; `--yes`), `restore <name>`, `purge <name>` (type the name, or `--yes`),
`credentials <name>` (prints the URL; `--json` prints everything). All accept `--json`.

## Managed object storage

Org-owned S3-compatible storage (RustFS) run as tier-3 containers ([OBJECT-STORAGE.md](./OBJECT-STORAGE.md),
S1–S10). Instance names follow slug rules (3–40 chars, no `--`) and are unique per org; bucket
names are 3–63 lowercase letters, digits and single hyphens (no dots). Responses carry a
`StorageView` (status, node, limits, `usedBytes`/`objects`, `public`/`publicUrl`,
`internalEndpoint`, `region`, `buckets`, `attachments`, `deletedAt`/`purgeAt`) and never contain
secret keys, except `/credentials`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/storage` | `storage:read` | `?includeDeleted=1` adds the trash → `{ storage: StorageView[] }` |
| POST | `/storage` | `storage:create` (+ `project:update` with `project`) | `{ name, engine? (rustfs), version?, placement? (auto\|edge\|node id), memoryMb?, cpus?, storageMb?, volume?, public?, buckets? (names, created private), project?, envPrefix? }` → `201 { storage }`. `project` needs at least one bucket and is granted read-write on all of them; a private instance with `project` follows the project's node |
| GET | `/storage/:name` | `storage:read` | `?includeDeleted=1` to read a trashed one → `{ storage }` |
| PATCH | `/storage/:name` | `storage:update` | any of `{ memoryMb, cpus, storageMb, public, version }`; more memory re-checks admission; going private is refused (409) while apps on other nodes use it → `{ storage }` |
| DELETE | `/storage/:name` | `storage:delete` | soft delete, restorable 7 days; the container and public route stop; 409 while projects are attached → `{ storage }` |
| DELETE | `/storage/:name?purge=1` | `storage:delete` | trashed instances only: the node removes the data, then the rows go → `{ ok: true }` |
| POST | `/storage/:name/restore` | `storage:delete` | re-checks admission; 409 once a purge was requested → `{ storage }` |
| POST | `/storage/:name/restart` | `storage:update` | restarts the RustFS container (buckets, objects and keys stay); the node applies it on its next reconcile → `202 { storage }` |
| GET | `/storage/:name/credentials` | `storage:credentials` | `{ credentials: { accessKeyId, secretAccessKey, region, endpoint, internalEndpoint, publicEndpoint, note } }`, the root key; `endpoint` is the public URL when public, else loopback on the node; `cache-control: no-store`; every read is audited. Not available over MCP (S6) |
| GET | `/storage/:name/metrics` | `storage:read` | same `?from&to&interval` rules as database metrics → `{ points: [{ bucket, up, usedBytes, objects, bucketCount, memoryBytes }], interval }` |
| GET | `/storage/:name/buckets` | `storage:read` | `{ buckets: [{ name, access, state (ready\|deleting\|delete-blocked), sizeBytes, objects, createdAt, statsAt }] }` |
| POST | `/storage/:name/buckets` | `storage:update` | `{ name, access? (private\|public-read) }` → `201 { bucket }`; re-creating a bucket whose delete was blocked cancels that delete. At most 200 per instance |
| PATCH | `/storage/:name/buckets/:bucket` | `storage:update` | `{ access }` → `{ bucket }`. `public-read` allows unsigned GETs of objects, not listing |
| DELETE | `/storage/:name/buckets/:bucket` | `storage:update`; with `?force=1` `storage:delete` | the node deletes it if empty (else it turns `delete-blocked`); 409 while granted to a project, or when it is known to hold objects without `force`. `force` empties it first → `{ bucket }` |
| GET | `/projects/:slug/storage` | `storage:read` | `{ attachments }` with grants, the env names each one injects and its access key id |
| POST | `/projects/:slug/storage` | `storage:update` + `project:update` | `{ storage, envPrefix? (UPPER_SNAKE, default S3), grants: [{ bucket, mode? (read\|read-write, default read-write) }] }` → `201 { attachment, warning }`. The project gets its own key as `<PREFIX>_ENDPOINT_URL`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_REGION`, `_FORCE_PATH_STYLE` (+ `_BUCKET` with one grant, `_PUBLIC_ENDPOINT_URL` when public) at activation and restarts. A private instance must share the project's node; `warning` says when it must be redeployed there |
| PATCH | `/projects/:slug/storage/:name` | `storage:update` + `project:update` | `{ grants }` replaces the grants; the key's policy changes in place → `{ attachment }` |
| DELETE | `/projects/:slug/storage/:name` | `storage:update` + `project:update` | detach and revoke the key; the app re-activates without the variables → `{ ok: true }` |
| GET | `/storage/:name/objects` | `storage:read` | `?bucket&prefix&delimiter=/&token&limit` → `{ bucket, prefix, delimiter, objects: [{ key, sizeBytes, etag, lastModified, storageClass }], prefixes, isTruncated, nextToken }`. `delimiter=/` gives the folder view; `token` continues a truncated listing (D82) |
| GET/HEAD | `/storage/:name/objects/item` | `storage:read` | `?bucket&key[&inline=1]`: GET streams the object (`content-disposition: attachment`, `etag`, `content-type`); HEAD returns the same headers without a body. Object keys travel in the query, never the path, so slashes are unambiguous |
| PUT | `/storage/:name/objects/item` | `storage:update` | `?bucket&key`, raw body. Limited to `SKIFF_STORAGE_OBJECT_MAX_BYTES` (default 100 MiB); `content-type` is stored. Larger files need a presigned PUT (public instances) or the CLI |
| DELETE | `/storage/:name/objects/item` | `storage:update` | `?bucket&key` → `{ deleted, errors }`; idempotent |
| POST | `/storage/:name/objects/delete` | `storage:update` | `{ keys }` (1–1000) in one S3 DeleteObjects call → `{ deleted, errors }` |
| POST | `/storage/:name/objects/folder` | `storage:update` | `{ prefix }` creates a zero-byte folder marker ending in `/` |
| POST | `/storage/:name/objects/presign` | `storage:read` | `{ bucket, key, method? (GET\|PUT), expiresIn? (60–604800) }` → `{ url, method, expiresIn }`. **Public instances only**: private instances have no browser-reachable endpoint |

**Object transport.** The control plane reaches every instance through an internal gateway: the
edge Caddy listens on `127.0.0.1:8081` (never the public listener), and a worker exposes
host-matched routes on its WireGuard-only app port. Requests are SigV4-signed for
`s3-<id>.storage.internal`, the gateway preserves `Host`, and RustFS verifies the signature. The
root key stays sealed in the control plane; every upload, delete and folder creation is audited.
The dashboard browser (`/storage/:name/objects`) uses the same endpoints (D82).

**MCP tools.** `list_storage` (`includeDeleted?`), `get_storage` (the view plus a `lastHour`
summary: bytes used vs the storage budget, objects, buckets, memory), `create_storage` (same
input as `POST /storage`; step-up adds `project:update` only when `project` is given),
`create_bucket` (`{ storage, name, access? }`), `attach_storage` (`{ project, storage,
envPrefix?, grants? }`; without `grants`, read-write on the only bucket), `detach_storage`
(`{ project, storage }`) and `delete_storage` (soft delete, confirmed by multi-round-trip input
bound to the instance, refused before prompting while attached; 2025-era clients get a dashboard
link). Object tools: `list_objects` (folder view, pagination), `presign_object` (public instances
only) and `create_object_folder`. There is **no key reveal, bucket delete, object delete or purge**
over MCP (S6, D82). Guide:
`skiff://guides/storage`.

**CLI.** `skif storage list [--all]`, `create <name> [-b <bucket>]… [-p <project>] [--prefix P]
[--public] [--placement …] [--memory 512M] [--cpus 1] [--storage 10G]`, `info <name>`,
`update <name> [--memory] [--cpus] [--storage] [--version] [--public|--no-public]`,
`buckets [list] <name>`, `buckets create|update <name> <bucket> [--access private|public-read]`,
`buckets delete <name> <bucket> [--force]`, `attach <name> -p <project> [-b <bucket>[:read|:read-write]]…
[--prefix P]` (no `--bucket`: the only bucket, read-write), `grants <name> -p <project> -b …`,
`detach <name> -p <project>`, `delete <name>` (asks; `--yes`), `restore <name>`, `purge <name>`
(type the name, or `--yes`), `credentials <name> [--prefix AWS]` (prints the root key as env
lines; `--json` prints everything), `metrics <name> [--since 1h | --from … --to …] [--interval
1m|1h]`. All accept `--json`; `skif s3` is an alias.

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
- `POST /api/agent/heartbeat` — stats + actual state version every ~10 s, plus `storage` (what `skiff-storage.service` last applied).
- `GET /api/agent/storage` — `{ dataDir, buildDir }` for the node's root `skiff-storage.service`, which re-reads the paths here instead of trusting the agent (D48).
- `POST /api/agent/telemetry` — pre-aggregated 1-minute access buckets (never raw requests), plus
  `databases` / `databaseSnapshots` and `objectStorage` / `objectStorageBuckets` samples. Database
  and storage sizes land in SQLite even when DuckDB telemetry is disabled; samples for instances
  the calling node doesn't host are dropped. → `{ ok, stored, databasesStored, storageStored }`.
- `GET /api/agent/workloads/:id/activation` — decrypted env/secret-file values for a workload
  owned by the calling node. Never cached on disk by the agent.
- `GET /api/agent/builds/next` — claim the oldest queued build (builder nodes only); returns the
  clone/ref/command plus a presigned upload URL.
- `POST /api/agent/builds/:id/log` and `POST /api/agent/builds/:id/report` — stream logs and report
  `building` / `succeeded` / `failed` / `cancelled`.
- `POST /api/agent/logs` — runtime log drain: `{ workloadId, cursor?, lines[] }`. The node token
  must own the workload; the server resolves its project and deployment.
- Dashboard live logs use `GET /projects/:slug/logs/stream?source=runtime|build&…` (SSE, session
  authenticated). The stream sends `id: <cursor>` so `EventSource` reconnects resume without a gap.

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

## Dashboard assistant (optional)

Enabled only when an owner has configured a model provider (Settings → Assistant,
[ASSISTANT.md](./ASSISTANT.md)). The session cookie is the intended credential; an API key works
too, with the user's normal permissions. One message is at most 8,000 characters, and a user gets
12 turns a minute.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/assistant/status` | signed in | `{ enabled, configured, provider, model, agents, maxAgents }`; never the API key |
| GET | `/assistant/models?provider=openrouter` | owner | OpenRouter's catalogue, filtered to models that support tools; `?refresh=1` bypasses the 10-minute cache. Owner-only, like Settings → Assistant |
| POST | `/assistant/chat` | `project:read` | `{ message, history?, context: { path, title?, project?, targets? } }` → SSE of `run.started`, `agent.started`, `text.delta`, `tool.started`, `tool.finished`, `ui.guide`, `confirmation.required`, `agent.finished`, `run.finished`, `error` |
| POST | `/assistant/confirm` | `project:read` | `{ token }` from a `confirmation.required` event; runs exactly the approved destructive tool, bound to the user, org, tool and arguments (10 min) |
