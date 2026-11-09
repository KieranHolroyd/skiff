# Skiff REST API (v1)

Base URL: `https://<platformOrigin>/api/v1`. "Platform admin" means a `platform-admin` binding at
platform scope (seeded from the Better Auth admin-plugin `user.role = admin`, D187), never an org
owner/admin. Authentication is either the Better Auth session cookie (dashboard) or
`Authorization: Bearer skif_…` (API key, CLI). Every mutation also sends `Origin: <platformOrigin>`
(CSRF policy). Errors are JSON:

```json
{ "error": "conflict", "message": "\"blog\" is already taken.", "suggestions": ["blog-app"] }
```

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/whoami` | — | user, org, role, effective permissions |
| GET | `/install/node.sh` | — | public POSIX installer: takes `--token` and `--name`, requires the signed agent/helper bundle, joins a managed-overlay node |
| GET | `/status` | `project:read` | fleet + deployment summary |
| GET | `/metrics[/<section>[/<name>]]` | `metrics:read` (+ section read) | Prometheus text for the caller's org; sections `usage`, `apps`, `traffic`, `databases`, `storage`, `volumes`, `platform` (platform admin). Same as `/metrics/...` on the platform origin, which also serves an unauthenticated fleet summary at `/metrics`. docs/METRICS.md |
| GET | `/projects` | `project:read` | `?trash=1` lists the trash (with `deletedAt`, `purgeAt`) |
| POST | `/projects` | `project:create` | `{ name?, slug?, runtime?, placement?, placementSpec?, productionAccess?, previewAccess? }`; `placementSpec` is the constraint spec (node, zone, roles, labels, volumeClass, volumeId, spread, near) |
| GET | `/projects/:slug` | `project:read` | |
| PATCH | `/projects/:slug` | `project:update` | rename via `slug` (old slug 301s 30 days); `placementSpec` (null clears) |
| DELETE | `/projects/:slug` | `project:delete` | soft delete, restorable 7 days |
| POST | `/projects/:slug/restore` | `project:update` | re-checks the project quota |
| GET | `/operations/actions` | — | mass actions the caller can run (docs/OPERATIONS.md) |
| POST | `/operations` | per action | `{ action, targets?, scope?, categories?, stage: plan\|apply }`; `Idempotency-Key` header; `?wait=<s≤25>` → `202 { operation }`. Prune must be planned first |
| GET | `/operations` | `project:read` | `?kind&status&limit`; `?scope=platform` for platform admins |
| GET | `/operations/:id` | creator or `project:read` | `?items=1&after&limit&status&verdict&category`, `?wait` |
| GET | `/operations/:id/stream` | same | SSE: `progress`, `items` (`id: <seq>`, resume with `Last-Event-ID`), `done`; `?until=done` follows an applied plan to the end |
| POST | `/operations/:id/apply` | per action, planner only | from `planned`; `{ categories? }` narrows a prune |
| POST | `/operations/:id/cancel` | creator or `project:delete` | stops after the current item |
| GET | `/operations/flows` | the run's read permission | flows (docs/FLOWS.md): `?kind&status&subjectKind&subjectId&limit` → `{ flows }` |
| GET | `/operations/flw_…` | the run's read permission (else 404) | `{ flow }`; `?wait=<s≤25>` until terminal; `?steps=1` adds the step log. `/stream` emits `progress` then `done` |
| POST | `/operations/flw_…/cancel` | the run's cancel permission | `{ flow }`; `409` with the reason when the current step cannot be cancelled (a database move after its cut-over) |
| POST | `/blueprints/validate` | `project:read` | `{ document }` (YAML/JSON text or object) → `{ validation }`; no live state read. All blueprint routes need `SKIFF_FEATURE_BLUEPRINTS` (docs/OPERATIONS.md §12) |
| POST | `/blueprints/plan` | `project:read` + every step's permission | `{ document, prune? }` → `{ plan }` (steps, `planHash`, `operationId`); stored as a planned `blueprint.apply` operation (1 h); problems → `422` with every issue's path |
| POST | `/blueprints/apply` | planner only, each step's permission | `{ planHash, confirm? }` (`confirm` = stack name when the plan deletes) → `202 { run }`; `?wait=<s≤25>`; live state moved → `409`; same hash again returns the same run |
| GET | `/blueprints/apply/:operationId` | creator or `project:read` | `{ run }` with every step's status |
| GET | `/blueprints` | `project:read` | `{ stacks }`: managed keys, last status, applied hash |
| GET | `/blueprints/:name` | `project:read` | `{ stack, lastRun }` |
| GET | `/export` | each section's own read permission | `{ export }`: the org's configuration (docs/OPERATIONS.md §13), secrets by name only; `?project=<slug>` (repeatable or comma-separated) limits projects; unreadable sections are listed in `skipped`; audited as `config.export` |
| POST | `/projects/:slug/access` | `project:update` | `{ scope: production\|previews, mode: public\|password\|platform\|access, password?, policyId? }`; each scope has its own password. `password` is required to switch a scope to `password` and may be omitted to keep the current one; leaving password mode clears only that scope's. `policyId` is required for `access` (Skiff Access) |
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
| GET | `/projects/:slug/sessions` | `shareLink:read` | live share-link sessions, newest first, max 500: `{ sessions: [{ id, kind: share, shareLinkId, note, host, email, startedAt, expiresAt }] }`. Password and platform sessions are stateless and not listed |
| DELETE | `/projects/:slug/sessions` | `project:update` | sign out everyone: bumps the project's session epoch (rotates its site key), ending password, platform and share sessions on every scope → `{ ok, epoch, signedOutAt, shareSessions }`. Share links keep working |
| DELETE | `/projects/:slug/sessions/:id` | `shareLink:revoke` | end one share-link session (`red_…`) → `{ ok, sessionId }` |
| GET | `/projects/:slug/logs` | `logs:read` | `?after&limit&source&buildId&deploymentId&level&q`; ordered events plus a `cursor` for tailing |
| POST | `/uploads` | `deployment:create` | `{ project, fileCount?, totalBytes? }` → presigned PUT |
| POST | `/uploads/:id/finalize` | `deployment:create` | `{ project, uploadId?, promote?, message? }`; `uploadId` must match `:id`, and the upload must belong to `project` |
| POST | `/projects/:slug/move` | `project:update` | `{ node }`; moves a deployed process/container app to another node and pins its placement there (D97). 409 for static sites, apps pinned by an attached database or private storage (move the database instead), app volumes or a persistent data dir; 422 when the target lacks budget or is not online |
| POST | `/databases/:name/move` | `database:update` | `{ node, storage?, from? }` → 202 `{ move }`; `storage` is `system`, `fast`, `bulk` or a disk on the target (default: the database's current tier, docs/STORAGE.md §2.2); stop attached apps → final backup → restore on the target → purge the old copy (D97). `from` is `dump` (default), or for a database that cannot be dumped `latest-backup` (newest good backup) or `empty` (start fresh, data discarded; the only choice for engines without backups). 409 for PITR on, a busy backup/rotation/credential task, a dump of a database or node that is down, a non-dump move of a running database with backups, or attached apps with app volumes or a data dir. Services attached apps also use that stay behind come back in `move.warnings`. `move.operationId` is the flow driving it (docs/FLOWS.md §6): follow it with `GET /operations/<id>?wait=…`, cancel it before the cut-over with `POST /operations/<id>/cancel` |
| POST | `/storage/:name/move` | `storage:update` | `{ node, storage?, from: "empty" }` → 202 `{ storage, from, to, projects, warnings }`; `storage` is a storage target on the target node as for databases; objects are not copied, so `from` must be `empty`. The target starts a fresh instance with the same buckets, keys and attachments; private-storage apps follow unless another service they use stays behind (listed in `warnings`); the old copy is purged (D97) |
| GET | `/databases/:name/move` | `database:read` | `{ move: DatabaseMoveView \| null }`: phase (`quiescing`, `dumping`, `restoring`, `purging`, `done`, `failed`), outcome (`moved`, `rolled_back`), source/target, attached projects, error, `operationId` (its flow run) |
| GET | `/nodes` | platform admin | any surface (session, API key, MCP) of a platform-admin user |
| GET | `/nodes/capacity` | platform admin | workload-slice budget per node (`sliceMemoryMb`, reserved, free) |
| PATCH | `/nodes/:id` | platform admin **session** | any of `{ name, publicAddress (host[:port] or null), sliceMemoryMb (32–65536, ≥ reserved), sliceCpuWeight (1–10000), canBuild, dataDir, buildDir, zone, roles, labels, lanEndpoint, cpuBudgetMillis }`; agents apply it on their next pull. `zone` is the failure domain; `roles` is the set the node may run (removing a role in use is 409); `labels` are operator `key=value` pairs (`skiff.io/*` reserved); `cpuBudgetMillis` is the CPU admission ceiling (null = uncapped). `dataDir`/`buildDir` (absolute paths, `null` = default) move node storage (D48); progress is in `storage.status` on the node. Where new services go is set per kind in Settings → Storage, not per node (docs/STORAGE.md) |
| DELETE | `/nodes/:id` | platform admin **session** | removes a worker node: its token is revoked, its disk registrations and studio sessions are dropped, and builds it claimed are requeued (`{ ok, requeuedBuilds }`). History keeps the node id. 409 for the edge node, or while projects are placed on it or workloads, databases, storage instances or app volumes still live there. Nothing on the machine changes; uninstall the agent there |
| POST | `/nodes/:id/builder` | platform admin **session** | `{ builder: boolean }`; lets the node claim git builds |
| POST | `/nodes/join-token` | platform admin **session** | single-use, 1 h; 403 for API keys / OAuth tokens |
| POST | `/nodes/:id/drain` \| `/resume` | platform admin **session** | |
| POST | `/nodes/:id/rotate-token` | platform admin **session** | |
| POST | `/nodes/:id/edge` | platform admin **session** | makes this online node the edge; the old edge becomes a worker (D98). 409 while `SKIFF_EDGE_NODE_ID` is set, for a node that is not online, or when the old edge hosts apps or data but has no public address |
| GET | `/storage/:name/replicas` | `storage:read` | bucket replication targets and status (C9) |
| POST | `/storage/:name/replicas` | `storage:update` | `{ target }`; another node, private target |
| DELETE | `/storage/:name/replicas/:id` | `storage:update` | remove the replication intent |
| GET | `/databases/:name/replicas` | `database:read` | `{ primaryGeneration, replicas, failovers }`: streaming replicas with node, status, LSN and lag, and the promotion history (C7) |
| POST | `/databases/:name/replicas` | `database:update` | `{ node, mode?: async, storage? }` (201); `storage` is `system`, `fast`, `bulk` or a disk on that node (default: the primary's tier); Postgres only, `sync` refused; same node allowed (reads only), another node needs both on the overlay |
| DELETE | `/databases/:name/replicas/:id` | `database:update` | 202; stops it, its node purges the copy and the primary drops the slot, then the row goes |
| POST | `/databases/:name/replicas/:id/promote` | `database:update` | `{ confirm: true, acceptDataLoss? }` + `If-Match: <primaryGeneration>` (412 when stale); 202 with the failover (fencing → promoting → repointing → completed). Never MCP |
| GET | `/platform/storage` | platform admin | storage overview: `{ onboarding, defaults, tiers, nodes }`; each node lists its system disk, its disks and the candidates it reports, usable ones under **Add a disk** and the rest with a reason (docs/STORAGE.md) |
| POST | `/platform/storage/disks` | platform admin **session** | `{ node, candidate, name?, tier? }`; `candidate` is a key from the listing (`mount:<sourceKey>` or `uuid:<fs UUID>`). A mounted filesystem is registered `ready` at once; an unmounted one is mounted by UUID at `/mnt/skiff-disks/<name>` (agent capability `disk-mounts`) and turns `ready` when the node reports it. Skiff never formats |
| PATCH | `/platform/storage/disks/:id` | platform admin **session** | `{ name?, tier? }` (`fast`\|`bulk`); a tier change affects new services only |
| DELETE | `/platform/storage/disks/:id` | platform admin **session** | unregister a disk; 409 while anything is stored on it, or for a share's disk (unmount the share instead). A disk Skiff mounted is unmounted by its node; its files stay |
| POST | `/platform/storage/disks/:id/profile` | platform admin **session** | benchmark the disk (seq MB/s, 4 KiB IOPS, sync-write latency) → 202; the result lands on the disk (`profile`) |
| PUT | `/platform/storage/defaults` | platform admin **session** | `{ defaults: [{ kind: databases\|object-storage\|brokers\|app-volumes\|builds\|site-data, target: system\|fast\|bulk }] }`. The target each create form preselects (and the API uses when `storage` is omitted); a kind with no default uses the system disk. Never moves existing services |
| POST | `/platform/storage/onboarding` | platform admin **session** | `{ state: done\|skipped }` |
| GET/PATCH | `/platform/errors` | platform admin | Server errors (docs/SERVER-ERRORS.md): GET lists issues (`?status=unresolved\|resolved\|ignored\|all&source=&q=&before=&limit=`) with a summary and 24 hourly counts; PATCH `{ ids, status }` changes several at once (platform maintenance) |
| GET/PATCH/DELETE | `/platform/errors/:id` | platform admin | one issue with its newest 50 events and hourly/daily counts; PATCH `{ status }`; DELETE removes it with its events (platform maintenance) |
| GET | `/shares` | platform admin | cluster share registry (C3) |
| POST | `/shares` | platform admin **session** | `{ name, protocol: nfs\|smb, server, exportPath, zone?, readOnly?, credentials?: { username, password, domain? } }`; SMB credentials are sealed and never returned |
| GET/PATCH/DELETE | `/shares/:name` | platform admin **session** | read (with `mounts`), update or remove a share; server/export/mode changes and delete are refused while mounted; `credentials` rotates |
| PUT | `/shares/:name/grants` | platform admin **session** | `{ grants: [{ orgId, mode: ro\|rw, pathPrefix? }] }`; replaces the set |
| POST | `/shares/:name/mounts` | platform admin **session** | `{ node, diskName? }`: mount at `/mnt/skiff-shares/<name>` on that node. A read-write share becomes a `bulk`, network disk named `diskName` (default: the share name) once mounted; a read-only share stays a plain mount (docs/STORAGE.md §3) |
| DELETE | `/shares/:name/mounts/:node` | platform admin **session** | remove the share's disk (refused while anything is stored on it), then unmount |
| PUT/DELETE | `/shares/:name/mounts/:node/disk` | platform admin **session** | `{ diskName }` uses a mounted share as a disk (**Use as disk**); DELETE stops using it as a disk (**Stop using as disk**; refused while anything is stored on it; the share stays mounted) |
| GET | `/cluster/config` | platform admin | cluster tunables: overlay, endpoints, replicas, database/storage limits, lease, failover, shares |
| PATCH | `/cluster/config` | platform admin **session** | section patches; unknown keys rejected; endpoint port range must have min < max |
| GET | `/ingress/status` | platform admin | ingress driver, hold-down policy and ingress-node readiness (C5) |
| GET | `/ha/status` | platform admin | the failover controller (`FailoverStatusView`): switch, lease epoch/holder, policy, per-node silence and copies, ingress record set, database promotion candidates, last 50 `failover_events` (C8) |
| GET | `/topology` | platform admin | zones, nodes, roles, labels, hardware, disks (`{ id, name, tier, mountPath, sizeBytes, freeBytes, remote }`) and placement counts (C0) |
| GET | `/topology/blast-radius?node=<id>` or `?zone=<name>` | platform admin | what an outage of that node or zone would take down: items and summary counts (C0) |
| GET | `/audit` | `project:read` | `?limit&action&resource&from&to&cursor` → `{ entries, nextCursor }`; `from`/`to` are a date, ISO time or epoch ms (a date as `to` covers the whole UTC day); `cursor` is the previous `nextCursor`; ≤ 200 a page |
| GET/POST | `/log-drains` | `logs:read` / org owner or admin | list `{ drains, canEdit }`, or create (`logDrainCreateSchema`) → `{ drain, signingSecret }` (webhook secret returned once); `allowPrivateNetwork` needs a platform admin **session** (DESIGN §8) |
| GET/PATCH/DELETE | `/log-drains/:id` | `logs:read` / org owner or admin | read, update (`logDrainUpdateSchema`; `headers` replaces all, `null` clears; `rotateSigningSecret` → new secret once) or delete |
| POST | `/log-drains/:id/test` | org owner or admin | send one test line → `{ result: { ok, status, message } }`; counters and cursors untouched |
| GET | `/secrets` | `secret:read-metadata` | values never returned |
| POST | `/secrets` | `secret:create` (new name) / `secret:update` (new version of a live name) | `{ name, value, projectId?, type? }`; versions count per scope, a project secret shadows the org's (D88); `projectId` must be in the org. Audited as `secret.create` / `secret.update`, never with the value |
| DELETE | `/secrets/:id` | `secret:delete` | |
| POST | `/cli/token` | `apiKey:create` | exchange a one-time CLI login code + PKCE verifier for an API key |
| GET/POST | `/projects/:slug/environments` | `project:read` / `project:update` | list or create a named environment |
| PATCH/DELETE | `/projects/:slug/environments/:env` | `project:update` | rename/access (`{ name?, access?, password? }`; the environment's own password, kept when omitted) or remove (production is built in) |
| POST | `/projects/:slug/environments/:env/promote` | `deployment:promote` | `{ deploymentId }`; moves only that environment's pointer (production also re-points a process/container workload) |
| GET/PUT/DELETE | `/projects/:slug/workload` | `deployment:read` / `project:update` | tier 2/3 runtime spec for the project. `idleStopSeconds` (process only; needs `socketActivation`, HTTP ingress and one replica; 0 or absent = always on) scales the app to zero after that many seconds without a request (D121) | The view carries `image` and `imageDigest` (the digest the running deployment is pinned to, D145; null when it runs a tag)
| POST | `/projects/:slug/deploy-image` | `deployment:create` + `project:update` | `{ image, promote?, message?, environment? }` → `201 { deployment, workload }`. Container projects only: keeps the rest of the spec, sets `image`, deploys a one-file `skiff-image.json` release and pins the tag to its digest (D145) |
| GET/POST | `/registry/credentials` | `image:pull` / `image:credentials` | registry logins for external registries (D146). POST `{ name, registry, username, password }` → `201 { credential }`; one per registry host per org (Docker Hub aliases fold into `docker.io`); the password is write-only |
| PATCH/DELETE | `/registry/credentials/:name` | `image:credentials` | `{ registry?, username?, password? }`; delete leaves running containers alone |
| GET/PATCH | `/registry` | `image:pull` / platform admin **session** | the platform registry: `{ enabled, host, node, status, engine, version, keepTags, realm }`; PATCH `{ enabled?, node?, host?, keepTags?, memoryMb?, mirrors?, signatures?: off\|warn\|enforce, cosignKeys?: [pem], cveScanning?, s3?: { endpoint, bucket, region?, accessKeyId, secretAccessKey, cacheUrl }\|null }` (D154, D159) |
| GET | `/registry/repositories` | `image:pull` | the org's repositories (created on first push) with the last tag, digest and push time |
| GET/DELETE | `/registry/tags?repository=<org>/<name>[&tag=]` | `image:pull` / `image:delete` | tags of a repository (deployment pins hidden); DELETE removes one tag |
| PATCH | `/registry/repositories` | `image:push` + `deployment:create` | deploy on push: `{ repository, project: slug\|null, tag? (latest) }` (D157) |
| GET | `/registry/scan?repository=<org>/<name>&reference=<tag\|sha256:…>` | `image:pull` | Trivy summary and the 50 most severe CVEs; 400 while CVE scanning is off (D159) |
| GET/POST | `/registry/trusts` | `image:pull` / `image:credentials` | GitHub Actions OIDC trusts: `{ githubRepository: owner/repo, ref?: glob, repository: <org>/<name>\|<org>/*, push? }` (D158) |
| DELETE | `/registry/trusts/:id` | `image:credentials` | remove a trust |
| GET | `/api/registry/token` (not under `/api/v1`) | Basic: any user + `skif_` API key, a per-workload login, a job token, a GitHub/GitLab OIDC token, or a Skiff workload/STS token (also accepted as `Bearer`) | the Docker token realm (D155): `?service=<host>&scope=repository:<org>/<name>:pull,push` → `{ token, access_token, expires_in, issued_at }`; the grant is intersected with the caller's `image:*` permissions in its own org and the token's restriction |
| GET | `/projects/:slug/container/targets` | `container:inspect` | container projects (D127): one entry per replica, `{ replica, nodeId, nodeName, desiredId }`. Every console call takes `?replica=<n>` for a multi-copy workload |
| GET | `/projects/:slug/container/inspect` | `container:inspect` | `{ targets, container }`: state, unit restarts, image and digest, entrypoint/command, env **names**, ports, networks, mounts, sandbox flags, raw counters (`stats`: CPU µs, memory/peak/limit, OOM kills, PIDs, net and block bytes, `sampledAt`; rates are the difference of two calls) and processes |
| GET | `/projects/:slug/container/files?path=` | `container:files` | `{ listing }` of one directory, symlinks resolved inside the container, ≤ 2,000 entries (`truncated`). 403 for the secrets dir and tmpfs, 409 while the container is not running |
| GET | `/projects/:slug/container/files/preview?path=` | `container:files` | `{ preview }`: text up to 1 MiB, else `content: null` with `reason` `binary` or `too-large`. Audited (`container.files.read`) |
| GET | `/projects/:slug/container/files/download?path=` | `container:files` | the file's bytes as an attachment, no size cap. Audited (`container.files.download`) |
| POST | `/projects/:slug/container/exec` | `container:exec` (people and API keys, never MCP) | `{ shell?: auto\|/bin/bash\|/bin/sh\|/bin/ash, user?: default\|root, cols?, rows? }` → `{ exec: { execId } }`. Audited (`container.exec.open`) |
| GET | `/projects/:slug/container/exec/:execId/stream` | `container:exec` | SSE: `data` events carry base64 output with the byte offset as `id`; one `exit` event (`{ code }`) ends it. `Last-Event-ID` or `?after=` replays what the node still holds (256 KiB) |
| POST | `/projects/:slug/container/exec/:execId/input` · `/resize` | `container:exec` | raw input bytes (≤ 64 KiB) · `{ cols, rows }`. A shell is bound to the person who opened it |
| DELETE | `/projects/:slug/container/exec/:execId` | `container:exec` | hang up the shell and everything it started |
| POST | `/projects/:slug/container/restart` | `project:update` | restart every replica through desired state (`{ ok, generation }`); open shells close |
| POST | `/projects/:slug/function/invoke` | `deployment:create` | Test request (D124), run on the function's node straight to its host: `{ method? (default GET), path? (default /, not under /__skiff/), headers?, body? }` → the node-task answer above with result `{ status, statusText, headers: [name, value][], encoding, body (≤ 256 KiB), size, truncated, durationMs, coldStart }` |
| POST | `/projects/:slug/function/scheduled` | `deployment:create` | `{ cron }` (one of the active deployment's crons) runs `scheduled()` now → result `{ status, error, durationMs, coldStart }` |
| GET | `/projects/:slug/function` | `deployment:read` | Functions view (D110): main module, compatibility date/flags, resolved bindings (no secret values), assets and `run_worker_first`, idle stop and the pinned workerd version. 404 when the project is not a function. A deploy of a bundle containing `skiff-function.json` validates it against the org; unsupported binding types and cron triggers fail with the phase that will serve them |
| GET | `/projects/:slug/runners` | `deployment:read` | GitHub Actions runner pool as GitHub reports it (`null` for other projects); `error` is set when GitHub cannot be reached (docs/RUNNERS.md) |
| GET | `/templates` | `project:read` | first-party app templates and their form fields (plan 21) |
| GET | `/templates/:id` | `project:read` | one template |
| POST | `/templates/:id` | `project:create` + `project:update` + `deployment:create` (+ `secret:create` when a credential is pasted) | `{ values }`; creates the project, its secrets, the workload spec and the first deployment in one step. Returns `{ project, deployment, secrets }` where `secrets` lists names only. A failure purges the half-made project |
| GET/POST | `/projects/:slug/volumes` | `project:read` / `project:update` | app volumes (plan 07); create takes `{ name, sizeMb?, storage?, singleWriter? }` (`storage`: `system`, `fast`, `bulk` or a disk name; default: Settings → Storage) and returns `AppVolumeView` with `disk` and no host path |
| GET/PATCH/DELETE | `/projects/:slug/volumes/:name` | `project:read` / `project:update` | get, grow/rename, or soft-delete (refused while attached; data kept 7 days) |
| POST/DELETE | `/projects/:slug/volumes/:name/attach` | `project:update` | `{ workload, environment?, mountPath, readOnly? }` / `{ workload, environment? }`; a second read-write mount on a single-writer volume is a 409 |
| GET/PUT/DELETE | `/projects/:slug/git` | `build:read` / `build:create` | git source, branch, build/output dirs, webhook secret |
| GET/POST | `/projects/:slug/builds` | `build:read` / `build:create` | build history or enqueue `{ ref?, promote? }` |
| GET | `/projects/:slug/builds/:id` | `build:read` | build status + full log |
| POST | `/projects/:slug/builds/:id/cancel` | `build:cancel` | |
| GET | `/domains` | `domain:read` | `?project=<slug>` to scope |
| POST | `/domains` | `domain:create` | `{ project, hostname, redirectWww? }`; returns the TXT record to create |
| GET/DELETE | `/domains/:id` | `domain:read` / `domain:delete` | deleting also removes managed Cloudflare records |
| POST | `/domains/:id/check` | `domain:read` | re-check TXT/address records and report drift. Status: `pending` → `verified` (TXT found) → `active` (an edge heartbeat reports a valid certificate); never-verified domains become `failed` 72 h after creation. The maintenance sweep re-checks pending domains every 10 min and failed ones every 6 h |

## Managed databases

Org-owned PostgreSQL run as tier-3 containers ([DATABASES.md](./DATABASES.md), D55–D61). Names
follow slug rules and are unique per org. Responses carry a `DatabaseView` (status, node, limits,
`sizeBytes`, `attachments`, the latest top-50 `tables` snapshot, `deletedAt`/`purgeAt`) and never
contain credentials, except `/credentials` and `/public-url`.

The studio workspace's own calls (`POST /databases/:name/studio/api/:op` for `tree`, `describe`,
`browse`, `run`, `explain`, `apply` and `value`) are dashboard-only: they need the platform session
cookie and an open studio session, refuse API keys, and are not part of the public API. Their
wire protocol is versioned in `packages/studio/src/protocol.ts` and may change between releases.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/databases` | `database:read` | `?includeDeleted=1` adds the trash → `{ databases }` |
| POST | `/databases` | `database:create` (+ `project:update` with `project`) | `{ name, engine?, version? (16\|17), placement? (auto\|edge\|node id), memoryMb?, cpus?, storageMb?, storage? (`system`, `fast`, `bulk` or a disk name; default: the kind's default from Settings → Storage, docs/STORAGE.md §2.2), project?, envPrefix?, extensions?, pooler? }` → `201 { database }`. Placement is resolved once; with `project` it follows the project's node and the attachment is created in the same call |
| GET | `/databases/:name` | `database:read` | `?includeDeleted=1` to read a trashed one → `{ database }` |
| PATCH | `/databases/:name` | `database:update` | any of `{ memoryMb, cpus, storageMb, version, extensions, pooler }`; more memory re-checks admission; `version` moves forward in place for engines that allow it (409 on a downgrade, a PostgreSQL major or MongoDB) → `{ database }` |
| DELETE | `/databases/:name` | `database:delete` | soft delete, restorable 7 days; 409 while projects are attached → `{ database }` |
| DELETE | `/databases/:name?purge=1` | `database:delete` | trashed databases only: the node removes the data, then the row goes → `{ ok: true }` |
| POST | `/databases/:name/restore` | `database:delete` | re-checks admission; 409 once a purge was requested → `{ database }` |
| GET | `/databases/:name/credentials` | `database:credentials` | `{ credentials: { url, host, port, username, password, databaseName, note } }`; loopback URL on the database's node; `cache-control: no-store`; every read is audited. Not available over MCP (D58) |
| GET | `/databases/:name/public-url` | `database:read` + `database:credentials` | decrypts the operator-managed public URL → `{ publicUrl: { url, updatedAt, updatedBy } }`; `cache-control: no-store`; audited as `database.public-url.reveal`. Metadata (`configured`, `updatedAt`) is in the normal view; the URL never is |
| PUT | `/databases/:name/public-url` | `database:update` | `{ url }` (`postgres://` or `postgresql://`) → `{ publicUrl }` metadata; the URL is sealed with the org key and replaces any previous value |
| DELETE | `/databases/:name/public-url` | `database:update` | clears the sealed URL → `{ publicUrl }` metadata |
| GET | `/databases/:name/metrics` | `database:read` | `?from&to` (ISO or epoch ms; default the last hour) `&interval=1m\|1h` (default `1m`, `1h` when the range exceeds 48 h; `1m` over 48 h is rejected; ranges ≤ 92 days) → `{ points, interval }`. Counters are per bucket |
| GET | `/databases/:name/logs` | `database:read` + `logs:read` | `?after&limit&level&q` → `{ events, cursor, hasMore }`; the agent drains the unit journal into `service_log_events` |
| GET | `/databases/:name/backups` | `database:read` | `{ backups }` (size, SHA-256, status, verified restore) |
| POST | `/databases/:name/backups` | `database:update` | `{ pinned? }` → `202 { backup }`; the node streams a `pg_dump -Fc` to the object store |
| GET/DELETE | `/databases/:name/backups/:id` | `database:read` / `database:delete` | one artifact; delete removes the object first |
| POST | `/databases/:name/backups/:id/restore` | `database:create` (+ `project:update` with `project`) | `{ name, placement?, memoryMb?, cpus?, storageMb?, storage?, project?, envPrefix? }` → `202 { database }`; restore always creates a new database and verifies it |
| GET/PATCH | `/databases/:name/backup-policy` | `database:read` / `database:update` | `{ enabled, schedule (five-field UTC cron), retentionDays }` |
| GET/PATCH | `/databases/:name/pitr` | `database:read` / `database:update` | `SKIFF_FEATURE_PITR` ([PITR.md](./PITR.md)). `{ pitr }` with archive health, last base backup and `recoverableFrom`/`recoverableTo`/`windowCheckedAt`; PATCH `{ enabled }` (PostgreSQL 18 standard only; enabling queues the first full base backup) |
| POST | `/databases/:name/pitr/backups` | `database:update` | `{ type: full\|diff\|incr }` → `202 { task }`; 409 while one is queued |
| POST | `/databases/:name/pitr/restore` | `database:create` | `{ name, targetTime (ISO with offset), memoryMb?, cpus?, storageMb?, storage? }` → `202 { database }` on the source's node; 400 outside the recoverable window |
| GET/POST | `/databases/:name/rotate` | `database:read` / `database:credentials` + `database:update` | `{ role: owner\|monitor }` → `202 { rotation }`; the node applies ALTER ROLE before the secret swaps |
| POST | `/databases/:name/restart` | `database:update` | `{ target: "database"\|"pooler" }` → `202 { database, target }`; database restarts the container and pooler, pooler restarts only PgBouncer |
| GET | `/databases/:name/studio` | `database:console` | the caller's native studio session (D96) → `{ studio: { sessionId, active, readOnly, expiresAt, idleMinutes, lastUsedAt, path, principal, principalError } }`; interactive users only, never the token |
| POST | `/databases/:name/studio` | `database:console` (+ `database:update` when `readOnly: false`) | `{ readOnly? (default true), ttlMinutes? (5–480, default 60), idleMinutes? (5–240, default 15) }` → `201 { studio }`; opens or extends the caller's session; never restarts the database. A read-only session connects as the database's read-only principal (`principal` says when it is `ready`) |
| DELETE | `/databases/:name/studio` | `database:console` | closes the caller's session now → `{ studio }` |
| POST | `/services/restart` | `database:update` and/or `storage:update` by scope | `{ scope: "all"\|"databases"\|"storage", databases?, storage? }` → `202 { restarted, skipped }` |
| POST | `/services/backup-databases` | `database:update` | queues a backup for every live database → `202 { queued, skipped }` |
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
| POST | `/storage` | `storage:create` (+ `project:update` with `project`) | `{ name, engine? (rustfs), version?, placement? (auto\|edge\|node id), memoryMb?, cpus?, storageMb?, storage? (`system`, `fast`, `bulk` or a disk name; default: the kind's default from Settings → Storage, docs/STORAGE.md §2.2), public?, buckets? (names, created private), project?, envPrefix? }` → `201 { storage }`. `project` needs at least one bucket and is granted read-write on all of them; a private instance with `project` follows the project's node |
| GET | `/storage/:name` | `storage:read` | `?includeDeleted=1` to read a trashed one → `{ storage }` |
| PATCH | `/storage/:name` | `storage:update` | any of `{ memoryMb, cpus, storageMb, public, version }`; more memory re-checks admission; going private is refused (409) while apps on other nodes use it → `{ storage }` |
| DELETE | `/storage/:name` | `storage:delete` | soft delete, restorable 7 days; the container and public route stop; 409 while projects are attached → `{ storage }` |
| DELETE | `/storage/:name?purge=1` | `storage:delete` | trashed instances only: the node removes the data, then the rows go → `{ ok: true }` |
| POST | `/storage/:name/restore` | `storage:delete` | re-checks admission; 409 once a purge was requested → `{ storage }` |
| POST | `/storage/:name/restart` | `storage:update` | restarts the RustFS container (buckets, objects and keys stay); the node applies it on its next reconcile → `202 { storage }` |
| GET | `/storage/:name/logs` | `logs:read` (+ `storage:read` to resolve the name) | `?after&limit&level&q` → `{ events: [{ seq, ts, kind, serviceId, source, stream, level, message }], cursor, hasMore }`. Newest page without `after`; the cursor tails new lines. RustFS writes to the unit journal and the agent drains it every couple of seconds |
| POST | `/storage/:name/restart` | `storage:update` | restarts the RustFS container (buckets, objects and keys stay); the node applies it on its next reconcile → `202 { storage }` |
| GET | `/storage/:name/credentials` | `storage:credentials` | `{ credentials: { accessKeyId, secretAccessKey, region, endpoint, internalEndpoint, publicEndpoint, note } }`, the root key; `endpoint` is the public URL when public, else loopback on the node; `cache-control: no-store`; every read is audited. Not available over MCP (S6) |
| GET | `/storage/:name/keys` | `storage:read` | `{ keys }`: named S3 keys with their bucket grants, purpose, expiry and access key id; no secrets |
| POST | `/storage/:name/keys` | `storage:update` | `{ name, grants, purpose?, expiresAt? }` → 201 `{ key }`; the secret is not returned here |
| DELETE | `/storage/:name/keys/:id` | `storage:update` | revoke the key; the node removes its RustFS user on the next round → `{ key }` |
| POST | `/storage/:name/keys/:id/reveal` | `storage:credentials` | `{ key }` with the secret; `cache-control: no-store`; audited; never MCP |
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
only) and `create_object_folder`; `restart_storage` restarts the RustFS container with data and
keys intact, and `get_storage_logs` pages the container log stream. There is **no key reveal, bucket delete, object delete or purge** over MCP (S6, D82). Guide:
`skiff://guides/storage`.

**CLI.** `skif storage list [--all]`, `create <name> [-b <bucket>]… [-p <project>] [--prefix P]
[--public] [--placement …] [--memory 512M] [--cpus 1] [--storage 10G]`, `info <name>`,
`update <name> [--memory] [--cpus] [--storage] [--version] [--public|--no-public]`,
`restart <name>`, `logs <name> [--follow] [--limit] [--level] [--q]`, `buckets [list] <name>`, `buckets create|update <name> <bucket> [--access private|public-read]`,
`buckets delete <name> <bucket> [--force]`, `attach <name> -p <project> [-b <bucket>[:read|:read-write]]…
[--prefix P]` (no `--bucket`: the only bucket, read-write), `grants <name> -p <project> -b …`,
`detach <name> -p <project>`, `delete <name>` (asks; `--yes`), `restore <name>`, `purge <name>`
(type the name, or `--yes`), `credentials <name> [--prefix AWS]` (prints the root key as env
lines; `--json` prints everything), `metrics <name> [--since 1h | --from … --to …] [--interval
1m|1h]`. All accept `--json`; `skif s3` is an alias.

## Managed queue brokers

Docs: [BROKERS.md](./BROKERS.md) (D111). A broker is an org resource, like a database: one NATS
server (JetStream on) per broker, placed once and reachable only on its node.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/brokers` | `broker:read` | `?includeDeleted=1` adds the trash → `{ brokers: BrokerView[] }` |
| POST | `/brokers` | `broker:create` (+ `project:update` with `project`) | `{ name, engine? (nats), version? (2.12\|2.11), placement? (auto\|edge\|node id), memoryMb? (≥64, default 256), cpus? (default 0.5), storageMb? (message-store cap, default 2048), storage? (`system`, `fast`, `bulk` or a disk name; default: the kind's default from Settings → Storage, docs/STORAGE.md §2.2), project?, envPrefix? (default NATS) }` → `201 { broker }`. Only nodes whose agent advertises the `brokers` capability are candidates; `project` places it on that project's node. 422 when `SKIFF_FEATURE_BROKERS=0` |
| GET | `/brokers/:name` | `broker:read` | `?includeDeleted=1` to read a trashed one → `{ broker }` |
| PATCH | `/brokers/:name` | `broker:update` | any of `{ memoryMb, cpus, storageMb, version }`; more memory re-checks admission and the memory quota; `version` only moves forward (409 on a downgrade) → `{ broker }` |
| DELETE | `/brokers/:name` | `broker:delete` | soft delete, restorable for the trash period; 409 while projects are attached → `{ broker }` |
| DELETE | `/brokers/:name?purge=1` | `broker:delete` | trashed brokers only: the node removes the data, then the rows go → `{ ok: true }` |
| POST | `/brokers/:name/restore` | `broker:delete` | re-checks admission; 409 once a purge was requested → `{ broker }` |
| POST | `/brokers/:name/restart` | `broker:update` | restarts the container (streams are kept) → `202 { broker }` |
| GET | `/brokers/:name/credentials` | `broker:credentials` | `{ credentials: { username, password, url, host, port, connectionSnippets, note } }`; loopback URL on the broker's node; `cache-control: no-store`; every read is audited. Not available over MCP (as D58) |
| GET | `/brokers/:name/logs` | `logs:read` (+ `broker:read`) | `?after&limit&level&q` → the same page shape as `/storage/:name/logs`, `kind: "broker"` |
| GET | `/brokers/:name/metrics` | `broker:read` | `?from&to&interval` (as `/databases/:name/metrics`; default the last hour at `1m`, ranges over 48 h use `1h`) → `{ points: BrokerMetricPoint[], interval }`: connections, store used/budget, messages, pending, awaiting ack, redelivered, oldest message age, and per-bucket published / messages and bytes in and out / slow consumers. Empty without ClickHouse (D123) |
| GET | `/brokers/:name/queues` | `broker:read` | the newest stream listing the node reported (once a minute, SQLite, so it works without ClickHouse) → `{ brokerId, name, at, truncated, streams: [{ stream, queue, subjects, storage, retention, messages, bytes, maxBytes, firstAt, lastAt, consumerCount, pending, ackPending, redelivered, consumers: [{ name, pending, ackPending, redelivered, waiting, lastDeliveredAt }] }] }`. `queue` is the function queue name for `SKIFF_Q_<queue>` streams, else null |
| GET | `/projects/:slug/brokers` | `broker:read` | `{ attachments: [{ brokerName, envPrefix, envNames, … }] }` |
| POST | `/projects/:slug/brokers` | `broker:update` + `project:update` | `{ broker, envPrefix? }` → `201 { attachment, warning }`; the app gets `<PREFIX>_URL/_HOST/_PORT/_USER/_PASSWORD` at activation and is placed on the broker's node at its next deploy. 409 for a duplicate prefix; 422 for static projects or services on another node (function projects attach brokers for their queues, D112) |
| DELETE | `/projects/:slug/brokers/:name` | `broker:update` + `project:update` | detach; the app restarts without the variables |

**Queue tools** (D124, [BROKERS.md §5.1](./BROKERS.md)) run on the broker's node. Each answers
`200 { task }` once the node has run it, `502 { error: "node_task_failed", message, task }` when
the node reports a failure, or `202 { task }` with a `location` to poll while it is still
running. `?wait=<seconds>` (0–25, default 20) sets how long the call holds. 409 when the broker
is not running, its node is offline, or its agent predates `node-tasks`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/brokers/:name/queues` | `broker:update` | `{ queue }` creates `SKIFF_Q_<queue>` → result `{ stream, created, state }` |
| POST | `/brokers/:name/queues/:queue/messages` | `broker:update` | `{ body, contentType? (json\|text, default json), delaySeconds? (≤ 43,200), count? (1–100) }` → `{ stream, sent, seqs, durationMs, state }` |
| POST | `/brokers/:name/queues/:queue/redrive` | `broker:update` | `{ to, limit? (≤ 1,000) }` moves messages from `:queue` into `to` → `{ moved, remaining, state, source }` |
| GET | `/brokers/:name/streams/:stream/messages` | `broker:update` | `?limit (≤ 50, default 20)&from=<seq>` reads without consuming → `{ stream, messages: [{ seq, subject, time, size, headers, encoding (utf8\|base64), body, truncated }], total, firstSeq, lastSeq, nextSeq }` |
| POST | `/brokers/:name/streams/:stream/purge` | `broker:delete` | → `{ stream, purged, state }` |
| DELETE | `/brokers/:name/streams/:stream` | `broker:delete` | → `{ stream, deleted }` |
| DELETE | `/brokers/:name/streams/:stream/messages/:seq` | `broker:delete` | → `{ stream, seq, deleted, state }` |
| GET | `/node-tasks/:id` | `broker:read` or `deployment:read` (by target) | `?wait=<seconds>` → `{ task: { id, kind, status (pending\|running\|succeeded\|failed), target, input, result, error, createdAt, startedAt, finishedAt } }`; kept for an hour |

Nodes use `POST /api/agent/tasks/lease?wait=<s>` and `POST /api/agent/tasks/result`.

## Event notifications

Docs: [EVENTS.md](./EVENTS.md) (D122). A rule publishes one source's events into a queue on a
managed broker; a function consumes the queue.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/events` | `broker:read` | `{ rules: EventRuleView[] }` with 24-hour delivery counts, last delivery and last error |
| POST | `/events` | `broker:update` + the source's read permission | `{ source (storage\|alerts\|deployments\|database-backups), events? (default all), broker, queue, description?, enabled? }` plus the source's filter: `storage` + `bucket` (required), `prefix?`, `suffix?` for storage; `project?`; `database?`; `alertRule?` → `201 { rule }`. A storage rule restarts the instance once to switch notifications on |
| GET | `/events/:id` | `broker:read` | `{ rule }` |
| PATCH | `/events/:id` | `broker:update` | any of `{ events, prefix, suffix, queue, description, enabled }` (`null` clears a filter); the source, its resource and the broker are fixed → `{ rule }` |
| DELETE | `/events/:id` | `broker:update` | drops the rule and its undelivered events → `{ ok: true }` |
| POST | `/events/:id/test` | `broker:update` | queues one synthetic event → `202 { delivery }` |
| GET | `/events/deliveries` | `broker:read` | `?rule&status=pending\|delivered\|failed&limit` (≤200), newest first → `{ deliveries }` with each message body |

RustFS posts bucket events to `POST /api/webhooks/storage/:id` with the instance's bearer token
(not for clients). Nodes use `POST /api/agent/events/lease` and `POST /api/agent/events/ack`.

## Email

Docs: [EMAIL.md](./EMAIL.md) (D114–D120). Sending domains, credentials, suppressions and the
message log are org resources; the mail node and an org's sandbox state are platform settings.
With `SKIFF_FEATURE_EMAIL=0`, configuring, creating domains or credentials, attaching and sending
return 403 `feature_disabled`, and the MCP tools are not offered.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/email` | `email:read` | `{ org: EmailOrgView (state sandbox\|active\|paused, perSecond, perDay, sentToday, bounceRate, complaintRate, windowMessages, pausedReason), settings }`; `settings` is `{ nodeId, paused, generation, mailDomain, hostnames, platformRecords }` for platform admins, else `null` |
| PATCH | `/email/settings` | platform admin **session** | `{ nodeId?: string\|null, paused?: boolean }` picks (or clears) the mail node, which must advertise the `mail` capability and have a public address, and pauses all sending → `{ settings }` |
| PATCH | `/email/orgs/:orgId` | platform admin **session** | `{ state? (sandbox\|active\|paused), perSecond? (1–1000), perDay? (1–10,000,000) }`; leaving the sandbox applies the active defaults → `{ org }` |
| GET | `/email/domains` | `email:read` | `{ domains: EmailDomainView[] }`, each with its records and last check results |
| POST | `/email/domains` | `email:update` | `{ name, sending? (default true), autoDns? (default true) }`; generates the DKIM key, creates the records through Cloudflare when the zone is the platform's, then checks DNS → `201 { domain }`. 409 when the name is taken; `receiving` is refused until inbound ships |
| GET | `/email/domains/:name` | `email:read` | `{ domain }` |
| PATCH | `/email/domains/:name` | `email:update` | `{ sending? }` → `{ domain }` |
| DELETE | `/email/domains/:name` | `email:delete` | removes the domain and the records Skiff created → `204` |
| POST | `/email/domains/:name/check` | `email:read` | looks the records up in public DNS now; verified once DKIM is found → `{ domain }` |
| POST | `/email/send` | `email:send` | `EmailSendInput` (`from`, `to/cc/bcc` ≤ 50 in total, `replyTo`, `subject`, `text`/`html`/`raw`, `attachments`, `headers`, `tags`, `unsubscribe`, `idempotencyKey`) → `202 { id, accepted, suppressed }`. Suppressed recipients are dropped; 403 `email_paused`, 429 `rate_limited`/`daily_quota`, 422 for the other policy codes (`from_not_verified`, `sandbox_recipient`, `all_suppressed`, …) |
| POST | `/email/send-batch` | `email:send` | `{ messages: EmailSendInput[] }` (≤ 100) → `{ results }`, where `results[i]` is `{ id, accepted, suppressed }` or `{ error: { code, message } }` for `messages[i]` |
| GET | `/email/messages` | `email:read` | `?limit (≤200, default 50)&before=<ISO>&recipient=<address>&status=<event kind>`, newest first → `{ messages: EmailMessageView[] }` |
| GET | `/email/messages/:id` | `email:read` | `{ message }` with each recipient's status and last SMTP response |
| GET | `/email/suppressions` | `email:read` | `?limit (≤1000, default 100)&address` → `{ suppressions }` |
| POST | `/email/suppressions` | `email:update` | `{ address, reason? (manual\|bounce\|complaint\|unsubscribe, default manual) }` → `201 { suppression }` |
| DELETE | `/email/suppressions/:address` | `email:update` | takes the address off the list → `204` (404 when it is not on it) |
| GET | `/email/addresses` | `email:read` | sandbox recipients (EMAIL.md §4.3) → `{ addresses: EmailSandboxAddressView[] }` (`status` pending\|verified, `verifiedAt`, `sentAt`, `expiresAt`) |
| POST | `/email/addresses` | `email:update` | `{ address }` mails a 24 h single-use link through the mail node from `no-reply@<mail domain>` (platform SMTP when no mail node is set, D170) → `201 { address }`; again for a pending address sends a fresh link (429 under a minute or after 5 per link); a verified one → `200` unchanged. 409 `platform_mail_unavailable` with neither a mail node nor `SKIFF_SMTP_*`, 409 `email_paused` while sending is paused, 422 `recipient_suppressed`, 409 `quota_exceeded` over 50 addresses / 10 pending, 502 `platform_mail_failed` |
| DELETE | `/email/addresses/:address` | `email:update` | → `204` (404 when unknown) |
| GET | `/email/access-request` | `email:read` | the org's latest production access request → `{ request: EmailAccessRequestView \| null }` |
| POST | `/email/access-request` | `email:update`, org owner/admin | `{ useCase (20–2000), expectedDailyVolume (1–10,000,000), website? (http/https URL) }` → `201 { request }`; 409 when active, paused or a request is pending; notifies platform admins |
| GET | `/email/access-requests` | platform admin | `?status (pending\|approved\|denied)&limit (≤500, default 100)`, pending first → `{ requests }` |
| POST | `/email/access-requests/:id` | platform admin **session** | `{ decision: 'approve', perDay?, perSecond?, note? }` moves the org to active (defaults 10,000/day, 10/s); `{ decision: 'deny', note }` keeps it in sandbox → `{ request }`; the requester is emailed. 409 when already decided |
| GET | `/email/credentials` | `email:read` | `{ credentials: EmailCredentialView[] }` (never the password) |
| POST | `/email/credentials` | `email:credentials`, not MCP | `{ name, project?, allowedFromDomains? }` → `201 { credential }` with `password` and `smtp` **once**; `cache-control: no-store`; audited |
| DELETE | `/email/credentials/:id` | `email:credentials` | revoke → `204` |
| GET | `/projects/:slug/email` | `email:read` (+ `project:read`) | `{ attachments: [{ envPrefix, envNames, username }] }` |
| POST | `/projects/:slug/email` | `email:update` + `project:update` | `{ envPrefix? (default SMTP) }` creates a project-scoped credential; the app gets `<PREFIX>_HOST/_PORT/_SECURE/_USER/_PASSWORD/_URL` at activation → `201 { envPrefix, envNames }`. 409 for a duplicate prefix |
| DELETE | `/projects/:slug/email?envPrefix=` | `email:update` + `project:update` | revokes that attachment's credential (default prefix SMTP); the app restarts without it → `204` |

MCP has `get_email_status`, `list_email_domains`, `get_email_domain`, `create_email_domain`,
`check_email_domain`, `send_email` (confirmed per message), `list_email_messages`,
`get_email_message`, `list_email_suppressions`, `remove_email_suppression` (confirmed),
`list_email_addresses`, `add_email_address` and `remove_email_address` (both confirmed). It has no
credential, settings, org-state or access-request tools.

## CLI browser login (`/cli/login`, `/api/v1/cli/token`)

`skif login` (browser sign-in is the default) opens
`GET /cli/login?redirect_uri=http://127.0.0.1:<port>/callback&state=…&code_challenge=…&code_challenge_method=S256`.
The page requires a signed-in dashboard session and, on approval, redirects a one-time code to the
loopback URI. `POST /cli/token` with `{ code, codeVerifier }` verifies the PKCE challenge, redeems
the code once, and returns `{ token, platform, contentDomain }`; `token` is a normal `skif_…` API
key for the REST API. Codes expire after five minutes and are stored hashed.

## Agent protocol (`/api/agent`)

Machine-authenticated with a node bearer token; no cookies. `POST /api/agent/join` consumes a
single-use join token and returns the node's long-lived token. A managed overlay join adds
`{ networkMode: "skiff", wireguardPublicKey }` and receives a `wireguard` block (address, CIDR, MTU,
listen port and peer list); an external/BYO join omits both and keeps `publicAddress`.

- `GET /api/agent/desired-state` — desired-state JSON; ETag `"v<version>"`; `?wait=<seconds>` long-polls
  (server cap 25). The agent sends `wait=8` to stay under Bun's default 10 s idle timeout
  (`CONNECTION_IDLE_TIMEOUT`), and re-pulls without `If-None-Match` after a failed converge so
  expired presigned release URLs are reissued. The token is checked before the wait.
- `POST /api/agent/heartbeat` — stats + actual state version every ~10 s, plus `storage` (what `skiff-storage.service` last applied) and, on a managed overlay node, `wireguard` peer health (public keys, endpoints, handshake times and byte counters).
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

## Usage and quotas

Quotas bound org and project resources; usage is read-only showback (no billing). See
[QUOTAS.md](./QUOTAS.md).

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/usage?project=<slug>&format=csv&history=1` | `project:read` | Current org/project usage, CSV export or daily points |
| GET | `/quotas?project=<slug>` | `project:read` | Org quota, or a project's base/overrides/effective limits |
| PUT/PATCH | `/quotas?project=<slug>` | platform admin (checked in core, `UsageService.setQuotas`) | Patch org quota fields or replace project overrides (`-1` unlimited; project `null` inherits) |
| DELETE | `/quotas?project=<slug>` | platform admin | Remove project overrides |

## Observability dashboards (D101)

Saved dashboards and the query endpoint behind them. Types and zod schemas are in
`packages/contracts/src/observability.ts`. Every route needs `metrics:read`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/observability/schema` | `metrics:read` | Datasets, measures and dimensions; ClickHouse tables (SQL users only); id → name maps; `available`/`error` |
| POST | `/observability/query` | `metrics:read` | `{ query, range: {from, to}, maxDataPoints?, variables? }` → `QueryResult`. Builder queries are scoped to the caller's projects, databases and storage; `mode: "sql"` is platform-admin only (403 otherwise), runs as the read-only reader, and returns ClickHouse's message as a 400 on a bad query. 503 while ClickHouse is down |
| GET | `/observability/dashboards` | `metrics:read` | Org dashboards (summaries) |
| POST | `/observability/dashboards` | `metrics:read` | `{ title, description?, tags?, spec? }` → 201. Non-admins cannot add SQL queries |
| GET | `/observability/dashboards/:id` | `metrics:read` | Full dashboard with its spec |
| PUT | `/observability/dashboards/:id` | author, org owner/admin | Partial update; must send the `version` it was based on (stale → 409) |
| DELETE | `/observability/dashboards/:id` | author, org owner/admin | |

Agents get the same capabilities as MCP tools (DESIGN §6.3): `create_dashboard` takes a template and/or
panel drafts and lays them out, so an agent never deals with grid positions.

## Alerts

Metric alert rules ([ALERTS.md](./ALERTS.md), D109). Types and zod schemas are in
`packages/contracts/src/alerts.ts`. Reads need `metrics:read`; rule writes need an org owner or
admin (or a platform admin); acknowledging and silencing also allow deployers.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/alerts` | `metrics:read` | `AlertsOverview`: active series (firing/pending/nodata), counts, channels, telemetry availability, the caller's abilities |
| GET | `/alerts/rules` | `metrics:read` | Rules with state, per-state counts and health |
| POST | `/alerts/rules` | owner/admin | `AlertRuleInput` → 201 `{ rule }`. Builder queries need exactly one metric; SQL is platform-admin only |
| GET | `/alerts/rules/:id` | `metrics:read` | Rule plus its series (`instances`) |
| PUT | `/alerts/rules/:id` | owner/admin | Partial update with the `version` it was based on (stale → 409). Changing the query or pausing resets its series |
| DELETE | `/alerts/rules/:id` | owner/admin | Deletes its series and silences; history stays |
| POST | `/alerts/rules/:id/evaluate` | owner/admin | Evaluate now (state changes and notifications apply) |
| POST | `/alerts/rules/:id/test` | owner/admin | Send a test notification → `{ delivery: { channel: 'ok' \| error } }` |
| POST | `/alerts/rules/:id/ack` | owner/admin/deployer | `{ fingerprint, acknowledged? }`: stop repeats until the series resolves |
| POST | `/alerts/preview` | `metrics:read` | `{ rule?, ruleId? }` → `AlertPreview`: series, values and which breach now; saves nothing |
| GET | `/alerts/silences?expired=1` | `metrics:read` | Active and upcoming silences (plus the last 30 days' expired) |
| POST | `/alerts/silences` | owner/admin/deployer | `{ ruleId?, matchers?, startsAt?, endsAt? \| durationMinutes, comment? }` → 201 |
| DELETE | `/alerts/silences/:id` | owner/admin/deployer | End a silence now |
| GET | `/alerts/system` | platform admin | Built-in alert kinds with on/off, channels, thresholds, last fired; channel status |
| PUT | `/alerts/system` | platform owner | `{ routing?: { <kind>: { enabled, channels } }, policies?: { diskAlertPercent?, … } }` |
| POST | `/alerts/channels/test` | platform owner | `{ channel? }`: test one channel or all → `{ delivery }` |
| GET | `/alerts/history?rule=&kind=&before=&limit=` | `metrics:read` | Events newest first: `state`, `notification` (with per-channel `delivery`), `error`, `ack`, `silence`, and `system` (platform admins) |

## IAM

Bindings, custom roles and groups ([IAM.md](./IAM.md) I1). Reads need `iam:read`; writes check
`iam:manage-roles`, `iam:manage-bindings` or `iam:manage-groups`, which owners and admins hold.
Resource arguments are query parameters: `resourceType` (default `org`), `resourceId`, `projectId`,
`environmentId`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/iam` | `iam:read` | `{ version, roles, bindings, groups, can }` for the caller's org |
| POST | `/iam/roles` | `iam:manage-roles` | `{ name, description?, permissions: string[] }` → 201. Names cannot shadow a built-in; permissions must be catalog entries |
| DELETE | `/iam/roles/:id` | `iam:manage-roles` | 409 while any binding still uses the role |
| POST | `/iam/bindings` | `iam:manage-bindings` | `{ principalType: user\|group\|serviceAccount, principalId, roleId, scope: { type, id?, projectId? }, condition?, expiresAt?, reason? }` → 201 |
| DELETE | `/iam/bindings/:id` | `iam:manage-bindings` | Platform bindings are removed by a platform admin |
| POST | `/iam/groups` | `iam:manage-groups` | `{ name, description? }` → 201 |
| POST | `/iam/groups/:id/members` | `iam:manage-groups` | `{ userId }`; SCIM/SSO groups are read-only |
| DELETE | `/iam/groups/:id/members` | `iam:manage-groups` | `{ userId }` |
| GET | `/iam/explain?permission&resourceType&…` | `iam:read` | The caller's decision plus every grant considered (IAM.md I12) |
| GET | `/iam/who-can?permission&resourceType&…` | `iam:read` | `{ permission, principals: [{ principalType, principalId, via }] }`; expands groups |
| POST | `/iam/simulate` | `iam:read` | `{ sample: { principalType: user\|serviceAccount, principalId }, change: { kind: "binding", roleId, scope, expiresAt?, condition? } \| { kind: "role", roleId, permissions } }` → `{ sample, draft, changes: [{ permission, resource, before, after, change, beforeVia, afterVia }], added, removed, applied: false }`; dry-run only, platform scopes refused, nothing saved |

**MCP tools.** Read: `whoami`, `explain_access`, `who_can`, `simulate_access`, `list_roles`,
`list_service_accounts`, `list_federation_trusts`. Write: `create_service_account`
(`serviceAccount:create`), `bind_role` (`iam:manage-bindings`), `request_access` (creates a pending
request only) and `unbind_role` (confirmed; platform bindings are refused). Approving, denying and
extending a request, and all platform bindings, remain dashboard/CLI-only.

### Federation trusts

An issuer → service-account mapping for RFC 8693 token exchange ([IAM.md](./IAM.md) I17, §7.3;
D190). A trust is org-scoped and holds no secret. `GET` needs `federation:read`; writes need
`federation:create`, `federation:update` or `federation:delete`. Deleting a trust stops new
exchanges; tokens already minted keep their TTL. The CLI is `skif federation list|create|delete`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/federation-trusts` | `federation:read` | `{ federationTrusts }`, ordered by issuer |
| POST | `/federation-trusts` | `federation:create` | `{ serviceAccountId, issuer, audiences (1–32), subjectPattern?, claimConditions?, maxTtlSeconds? (≤3600), restriction? }` → 201; `issuer` must be absolute http(s) and the service account must be in the caller's org |
| GET | `/federation-trusts/:id` | `federation:read` | `{ federationTrust }` |
| PATCH | `/federation-trusts/:id` | `federation:update` | any create field → `{ federationTrust }` |
| DELETE | `/federation-trusts/:id` | `federation:delete` | `{ ok: true }` |

`restriction` is `{ permissions?: string[], resources?: string[] }` and only ever narrows the
service account's bindings. `subjectPattern` uses the exchange's glob: `*` within one segment, `**`
across segments. The STS endpoint is in [STS token exchange](#sts-token-exchange-and-platform-discovery).

### Service accounts

Org-owned machine principals (`sa_…`), bound to roles like any other principal ([IAM.md](./IAM.md) I13, §7.2).
Disabling is the normal off-switch; delete is refused while a binding still uses the account.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/service-accounts` | `serviceAccount:read` | `{ serviceAccounts }`, sorted by name |
| POST | `/service-accounts` | `serviceAccount:create` | `{ name, description?, ownerGroupId? }` → 201 with the new view. `name` is a slug, unique per org |
| GET | `/service-accounts/:id` | `serviceAccount:read` | `{ serviceAccount }` |
| PATCH | `/service-accounts/:id` | `serviceAccount:update` | `{ name?, description?, ownerGroupId?, disabled? }` → `{ serviceAccount }`; disabling bumps the org's IAM version |
| DELETE | `/service-accounts/:id` | `serviceAccount:delete` | `{ ok: true }`; 409 while a binding still references it |
| GET | `/service-accounts/:id/keys` | `serviceAccount:read` + `serviceAccount:manage-keys` (or `accessKey:read-all`) | `{ accessKeys }` for that account, newest first; no raw key |
| POST | `/service-accounts/:id/keys` | `serviceAccount:manage-keys` | `{ name, permissions?, resources?, expiresInSeconds?, allowedCidrs? }` → 201 `{ accessKey, key }`; the `skif_…` key is shown once |
| DELETE | `/service-accounts/:id/keys?keyId=…` | `serviceAccount:manage-keys` | revoke one key owned by the account → `{ ok: true, accessKey }`; 400 without `keyId`, 404 for another account's key |
| POST | `/service-accounts/:id/token` | `serviceAccount:impersonate` | `{ ttl? (≤3600, default 3600), audience? (default the platform origin) }` → 201 `{ access_token, token_type, expires_in, audience, service_account }`; an STS token carrying `act` and `impersonated_by`, audited as `service_account.impersonate`. `skif sa token` |

### Access keys

A key belongs to one org and one principal; the raw `skif_…` key is returned exactly once, from
`POST`, and only its hash and visible `start` are stored ([IAM.md](./IAM.md) I14, §7.2).

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/access-keys` | `accessKey:read` (own) / `accessKey:read-all` (org) | `?principalId` filters; without `read-all` only the caller's own keys are visible → `{ accessKeys }` |
| POST | `/access-keys` | `accessKey:create` (user) / `serviceAccount:manage-keys` (service account) | `{ name, principalType? (user\|serviceAccount), principalId?, permissions?, resources?, expiresInSeconds?, allowedCidrs? }` → 201 `{ accessKey, key }`; `key` is shown once and never again |
| DELETE | `/access-keys/:id` | `accessKey:revoke` (own) / `accessKey:revoke-any` (another's) | revoke at once → `{ ok: true }`; revoking twice is idempotent |

### Guardrails, access requests, reviews and usage

Governance surfaces ([IAM.md](./IAM.md) §9.2–§9.5). A guardrail is a deny rule that beats every
allow; a request is just-in-time access for at most eight hours; a review is a campaign that
snapshots bindings.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/iam/guardrails` | `iam:read` | `{ guardrails, templates, can: { manage } }`; includes read-only platform rows and the built-in templates |
| POST | `/iam/guardrails` | `iam:manage-guardrails` | `{ template? }` or `{ name, permissions }`, plus `selector?`, `scope?`, `condition?`, `enabled?` → 201. `office-only` is listed but unavailable (needs a negated IP condition) |
| PATCH | `/iam/guardrails/:id` | `iam:manage-guardrails` | any of `{ name, permissions, selector, scope, condition, enabled }` → the view |
| DELETE | `/iam/guardrails/:id` | `iam:manage-guardrails` | `{ deleted: true }` |
| GET | `/iam/access-requests` | member | the caller's requests plus the ones they may decide, `?status=pending\|approved\|denied\|cancelled\|expired` → `{ requests, limits: { maxDurationSeconds, requestTtlSeconds } }` |
| POST | `/iam/access-requests` | member | `{ roleId, scope, durationSeconds (60–28,800), reason (3–500), changeRef? }` → 201; one pending request per role and scope |
| POST | `/iam/access-requests/:id/approve` \| `/deny` | `iam:manage-bindings` at the scope, never the requester | decides it → the request view; approval creates a binding that expires on its own |
| POST | `/iam/access-requests/:id/cancel` | the requester | ends a pending request or an approved grant early → the request view |
| GET | `/iam/access-reviews` | `iam:read` or `iam:review` | `?status=open\|completed` → `{ reviews, can: { review } }`; each review carries its items |
| POST | `/iam/access-reviews` | `iam:review` at the scope | `{ scope, name?, defaultDecision? (keep\|revoke), dueAt? (epoch ms) }` → 201; org resources only |
| PATCH | `/iam/access-reviews/:id/items/:itemId` | `iam:review` | `{ decision: keep\|revoke\|shorten }` → the review with its items; the campaign id checks ownership |
| POST | `/iam/access-reviews/:id/complete` | `iam:review` | applies every decision (undecided items follow `defaultDecision`) → the review |
| GET | `/iam/usage` | own usage; `iam:read` for `?principalId` | `{ usage: [{ principalType, principalId, permission, scopeType, scopeId, lastUsedAt, count30d }], windowDays: 30 }`, newest first |

### Signing keys

The platform key ring ([IAM.md](./IAM.md) §7.3; I15). `GET` needs a platform read and `POST` needs
platform maintenance; D129's session-only condition applies to both. No private key is ever
returned.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/iam/keys` | platform read | `{ purposes, policy, lastRotatedAt, nextCheckAt, can: { rotate } }`; each purpose lists its active/next `kid`, retired count, every key's state and the rotation decision the monthly sweep would take |
| POST | `/iam/keys/rotate` | platform maintenance | `{ purpose }` or `{ all: true }` → `{ rotations, rotatedAt }`. `all` covers the automatically rotated purposes and never `pool:<id>` keys, which rotate with their pool |

### Platform IAM

Platform roles bound at `platform` scope ([IAM.md](./IAM.md) §10; I24). Reads need a platform read;
writes need a platform administrator **session** (D129), and platform guardrail writes also need
`iam:manage-guardrails` in the admin's own org.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/platform/iam/roles` | signed in | `{ roles }`: `platform-admin`, `platform-operator`, `platform-viewer` and their permissions |
| GET | `/platform/iam/bindings` | platform read | `{ bindings, roles, can: { administer } }`; every binding at `{ type: "platform" }` with its condition and expiry |
| POST | `/platform/iam/bindings` | platform admin **session** | `{ userId \| groupId, roleId, condition?, expiresAt?, reason? }` → 201; exactly one of `userId` or `groupId`. Omitting `condition` keeps the role's default (`platform-admin` is `credentialIn: [session]`); `condition: null` removes it for the quota exception |
| DELETE | `/platform/iam/bindings/:id` | platform admin **session** | `{ ok: true }`; the synced `user.role = admin` binding is re-created on the next sync |
| GET | `/platform/iam/guardrails` | platform read | `{ guardrails, can: { manage } }`; rows with `org_id IS NULL` that apply to every org |
| POST | `/platform/iam/guardrails` | platform admin **session** + `iam:manage-guardrails` | `{ name?, permissions?, selector?, scope?, condition?, enabled? }` → 201 |
| PATCH/DELETE | `/platform/iam/guardrails/:id` | same | update the rule or delete it |

### Step-up verification

"Please verify it's you" before a sensitive action ([STEP-UP.md](./STEP-UP.md); D186). These are
Better Auth endpoints under `/api/auth`, not `/api/v1`, and need the dashboard session cookie. A
guarded action answers `403 { error: "step_up_required", permission, level }`; the client opens the
dialog and retries the original request once. Enforcement is off unless `SKIFF_STEP_UP=1`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/step-up/status` | `{ fresh, class, strongest, windowMs, freshUntil, preferred, alternatives, email }`; `email` is masked |
| POST | `/api/auth/step-up/passkey/options` | WebAuthn assertion options for this user's passkeys; the challenge is bound to the session for 2 minutes |
| POST | `/api/auth/step-up/passkey/verify` | `{ response }` → `{ ok, class: "strong", method: "passkey" }` |
| POST | `/api/auth/step-up/totp` | `{ code }` → `{ ok, class: "strong", method: "totp" }`; a replayed step is refused |
| POST | `/api/auth/step-up/backup-code` | `{ code }` → `{ ok, class: "strong", method: "backup-code" }`; the code is consumed |
| POST | `/api/auth/step-up/password` | `{ password }` → `{ ok, class: "basic", method: "password" }`; 403 when a stronger factor exists |
| POST | `/api/auth/step-up/email/send` | `{ action? }` → `{ sent: true, expiresIn }`; throttled to one a minute |
| POST | `/api/auth/step-up/email/verify` | `{ code, action? }` → `{ ok, class: "basic", method: "email" }` |
| POST | `/api/auth/step-up/lock` | clears the window now → `{ ok: true }` |

### SSO providers, domains and org auth policy

OIDC sign-in per organisation ([IAM.md](./IAM.md) I19–I21, §8.3–§8.5). Client secrets are
write-only; a blank `clientSecret` on update keeps the stored one.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/sso/providers` | `sso:read` | `{ providers }` with `protocol` (`oidc`\|`saml`), issuer, endpoints, scopes, claim map, `hasClientSecret`, `callbackUrl`, and for SAML the `acsUrl`, `spMetadataUrl`, `certificateCount`, `certificates`, `sloUrl`, `sloBinding` and `spSigning` (`{ certificate, previousCertificate, createdAt, previousPublishedUntil }`; the private key never leaves the server) |
| POST | `/sso/providers` | `sso:manage` | `{ name, protocol? (oidc\|saml), issuer? \| preset: { id, values? }, clientId?, clientSecret?, discoveryUrl?, scopes?, claims?, enabled?, saml? }` → 201; 409 for a second provider on the same issuer. OIDC needs `issuer` (or a preset), `clientId` and `clientSecret`; SAML takes `saml: { metadataUrl?, entityId?, entryPoint?, cert?, certs?, secondaryCerts?, sloUrl?, sloBinding? (redirect\|post), spEntityId?, audience?, wantAssertionsSigned?, identifierFormat? }`, where `metadataUrl` is fetched at save time and otherwise `entityId`, `entryPoint` and at least one certificate are required. `certs`/`secondaryCerts` add IdP signing certificates for a rollover; an explicit blank `sloUrl` disables SLO. `protocol` cannot change after creation |
| GET | `/sso/providers/:id` | `sso:read` | one provider (no secret) |
| PATCH | `/sso/providers/:id` | `sso:manage` | partial update; `clientSecret` omitted keeps the current one |
| DELETE | `/sso/providers/:id` | `sso:manage` | `{ ok: true }`; sign-in through it stops at once |
| GET | `/sso/domains` | `sso:read` | `{ domains }`; re-checks any domain whose last check is a day old before answering |
| POST | `/sso/domains` | `sso:manage` | `{ domain }` → 201 with the TXT record to publish (`txtRecordName`, `txtRecordValue`); 409 when another org claimed it |
| POST | `/sso/domains/:domain/verify` | `sso:manage` | re-reads the TXT record now → the domain view |
| DELETE | `/sso/domains/:domain` (also `?domain=` on the collection) | `sso:manage` | `{ ok: true }`; email routing stops immediately |
| GET | `/sso/policy` | `sso:read` | `{ policy }`: `requireSso`, `require2fa`, `allowedMethods`, `sessionMaxAge`, `idleTimeout`, `ipAllowlist`, `breakGlassUserIds`, `autoDisableUnusedServiceAccounts` |
| PUT | `/sso/policy` | `sso:manage` | a partial of those fields; session limits are seconds, `null` turns a limit off; `autoDisableUnusedServiceAccounts` lets the daily pass disable service accounts unused for 90 days (off by default) |
| GET | `/sso/presets` | signed in | `{ presets }`: the ready-made IdP set-ups and the values each needs (D180) |
| GET | `/sso/resolve?email=` | public | email → `{ provider: { id, name, orgId, domain } \| null }`; only a verified domain routes |
| GET | `/sso/group-mappings` | `sso:read` | `{ mappings }`: IdP group claim value → Skiff group |
| POST | `/sso/group-mappings` | `sso:manage` | `{ providerId, claimValue, groupId }` → 201; the mapping applies on the next sign-in |
| DELETE | `/sso/group-mappings/:id` | `sso:manage` | `{ ok: true }` |
| GET | `/sso/scim` | `sso:read` | `{ endpoint, tokens }`; the protocol endpoint is `/api/auth/scim/v2` and no token value is returned |
| POST | `/sso/scim` | `sso:manage` | mints a bearer token → 201 with the token shown once and the endpoint; minting revokes the org's other active tokens |
| DELETE | `/sso/scim/:id` | `sso:manage` | revokes one token; the directory's next request gets a 401 |
| POST | `/org/switch` | signed in | `{ organizationId }` → `{ org: { id, name, slug, role } }`; stored on the session and remembered for the next sign-in. A key cannot switch, because a key is bound to its own org |
| GET/POST | `/sso/logout` (not under `/api/v1`) | signed in (a signed-out request still redirects) | `?providerId=&returnTo=` (or the same as form fields) clears the Better Auth session, audits `sso.logout`, and redirects to the SAML provider's configured IdP SLO URL when one exists, else a same-origin `returnTo` or `/login`. The local session is always cleared; the plugin's SLO callback handles IdP-initiated logout |

The Better Auth SSO callback is `/api/auth/sso/callback/:providerId` for OIDC and
`/api/auth/sso/saml2/sp/acs/:providerId` for SAML; both are public and live outside `/api/v1`.
The plugin's SLO callback is `/api/auth/sso/saml2/sp/slo/:providerId`; it accepts an IdP-initiated
`LogoutRequest` and deletes the matching session. SAML SP requests are signed with a per-provider
RSA key; its certificate (and the previous one during the 30-day rollover) is in `spSigning` and the
SP metadata document. Rotate it in Settings → SSO; there is no REST rotate route.

### Access policies (Skiff Access)

Ordered allow/deny rules for the `access` protection mode ([IAM.md](./IAM.md) I25, §11.1; D188,
D192). A matching deny beats every allow; no match denies. Rules match an org group, any member, an
email or domain, an SSO provider, a user pool and its groups, a CIDR, or a service-token header.

A **service token** is a `serviceToken` rule: a header name and the SHA-256 of a `skiff_svc_…`
secret. There is no REST route that returns the secret: Settings → Access policies mints it through
a form action and shows it once; revoking it removes the rule. Desired state carries only the header
name, hash and action, and the agent decides a matching machine before any login redirect. Editing
or removing a rule, disabling a policy, or reassigning a host bumps that policy's `version`, which
is folded into the site key of every host using it, so issued cookies and callback tokens for those
hosts stop verifying while hosts on another policy keep theirs. Adding an allow rule does not sign
existing visitors out.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/access-policies` | `accessPolicy:read` at each policy's scope | `?projectId` narrows to policies that apply to that project; returns the array directly |
| POST | `/access-policies` | `accessPolicy:create` at the scope | `{ name, description?, scope: { type: org\|project\|environment, id?, projectId? }, enabled?, rules: [{ idx, action: allow\|deny, matcher }] }` → 201. A `serviceToken` matcher carries `{ header, tokenHash }`, never the secret |
| GET | `/access-policies/:id` | `accessPolicy:read` at its scope | one policy |
| PATCH | `/access-policies/:id` | `accessPolicy:update` at its scope | `{ name?, description?, enabled?, rules? }` (rules replace the ordered list) |
| DELETE | `/access-policies/:id` | `accessPolicy:delete` at its scope | `{ ok: true }`; refused while a project or environment still assigns it |
| POST | `/projects/:slug/access` | `project:update` | assign one with `{ scope: production\|previews, mode: "access", policyId }`; this is the same route as the other protection modes. Named-environment assignment exists only in the dashboard |
| GET | `/access/authorize?host=&return=` | public (platform session optional) | the Skiff Access login page. The agent redirects an unauthenticated visitor here; the platform evaluates the host's ordered policy and, on `allow`, redirects to the agent's `/_skiff/access/callback` with a single-use host-bound token, else renders an HTML 403. A `userPool` rule accepts the pool's session cookie or bearer access token and matches `groups`/`poolGroups` metadata; a person with no pool session is sent to that pool's hosted login. SSO sessions are attributed to their linked provider. Service-token rules are deliberately not evaluated here, so a leaked token cannot mint a browser session. Only content hosts this platform serves may be a `return` target |

### User pools and OIDC clients

A pool is an org resource: a hosted OIDC provider for one app's own users ([IAM.md](./IAM.md)
I26–I29, §11.2). The native `skiff-identity` engine runs in the control plane today: pool users,
sessions, authorization codes, access/ID tokens, magic links, password reset, email verification and
invites live in the `user_pool_*` tables, signed by the pool's `pool:<id>` key. Pool users are not
platform users and a platform session cannot sign anybody into a pool. The hosted pages are
`/pool/<id>/{login,signup,reset,magic,logout,verify}`. Passkeys, TOTP MFA and pool-local groups are
built; social login, import and export are not. Groups and the pool-level `mfaRequired` switch are
managed in Settings → Identity (there are no REST group routes); pool users enrol TOTP and manage
passkeys/groups from the hosted `/pool/<id>` account page. Attaching a pool to a project is a
dashboard action (there is no REST attachment route): it injects `<P>_ISSUER`, `<P>_CLIENT_ID` and
`<P>_CLIENT_SECRET`, and a function gets `env.AUTH.verify(request)`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/user-pools` | `userPool:read` (org or per pool) | `{ pools }`; an org grant sees every pool |
| POST | `/user-pools` | `userPool:create` | `{ name, description?, engine? (skiff-identity), signupMode? (invite\|open), requireEmailVerification?, mfaRequired?, theme? }` → 201 with the pool; 409 for a duplicate name |
| GET | `/user-pools/:id` | `userPool:read` on the pool | `{ pool }` with issuer, active signing `kid` and `mfaRequired` |
| PATCH | `/user-pools/:id` | `userPool:update` on the pool | `{ name?, description?, signupMode?, requireEmailVerification?, mfaRequired?, theme?, disabled? }` → `{ pool }`; disabling keeps clients and keys |
| DELETE | `/user-pools/:id` | `userPool:delete` on the pool | `{ ok: true }`; removes the clients, signing key, users, passkeys, TOTP rows and groups; refused while a project is attached |
| GET | `/user-pools/:id/clients` | `userPool:read` on the pool | `{ clients }`: public `clientId`, redirect allowlist, no secret |
| POST | `/user-pools/:id/clients` | `userPool:credentials` on the pool | `{ name, redirectUris, public? }` → 201 `{ client, clientSecret }`; `clientSecret` is `null` for a public (PKCE) client and is shown once |
| DELETE | `/user-pools/:id/clients/:clientId` | `userPool:credentials` on the pool | `{ ok: true }`; `:clientId` may be the row id or the public OIDC `client_id`; refused while attached |
| GET | `/user-pools/:id/users` | `userPool:manage-users` on the pool | `{ users }`: id, email, name, verification and disabled state, metadata |
| PATCH | `/user-pools/:id/users/:userId` | `userPool:manage-users` on the pool | `{ disabled }` → `{ user }`; disabling revokes their pool sessions at once |
| DELETE | `/user-pools/:id/users/:userId` | `userPool:manage-users` on the pool | GDPR delete: the user, sessions, codes, verification tokens, passkeys, TOTP row and group memberships → `{ ok: true }` |
| GET | `/user-pools/:id/users/invites` | `userPool:manage-users` on the pool | `{ invites }`: pending invitations, no raw token |
| POST | `/user-pools/:id/users/invites` | `userPool:manage-users` on the pool | `{ email }` → 201 with the invitation and its token **once** |
| GET | `/user-pools/:id/oauth/authorize` | public | OIDC authorization code flow: `?client_id&redirect_uri&response_type=code&scope=&state=&nonce=&code_challenge=&code_challenge_method=`. A signed-in pool session gets a single-use code; anyone else is redirected to the pool's hosted login. Always a 303 |
| POST | `/user-pools/:id/oauth/token` | public | `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret?` (or HTTP Basic), `code_verifier?` → `{ access_token, token_type: "Bearer", expires_in, id_token, scope }`; `cache-control: no-store` |
| GET/POST | `/user-pools/:id/oauth/userinfo` | pool bearer access token | `{ sub, email?, email_verified?, name?, groups }`; an ID token or a revoked/disabled user is refused |
| GET/POST | `/user-pools/:id/oauth/logout` | public | revokes the pool session and redirects to `post_logout_redirect_uri` when it is same-origin, else `/pool/<id>/login` |
| GET | `/user-pools/:id/.well-known/openid-configuration` | public | OpenID Connect Discovery for the pool; 404 while the pool is disabled |
| GET | `/user-pools/:id/.well-known/jwks.json` | public | the pool's `pool:<id>` signing keys; 404 while disabled |

**Hosted pool passkeys and MFA (D194).** These are browser routes on the platform origin, not
`/api/v1`, and take the pool's session/CSRF cookies. The challenge is stored server-side and is
single use; only the public key and signature counter are stored, and a counter that does not
advance is refused as a possible clone. The account page lists and removes a user's passkeys.
TOTP enrolment (start, confirm, disable, regenerate recovery codes) and the second sign-in step are
SvelteKit form actions on `/pool/:id` and `/pool/:id/login`; there is no REST admin for pool TOTP or
groups. A user who has enrolled must pass the code step before a password sign-in sets a session;
`mfaRequired` is the pool's prompt for every user to enrol.

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/pool/:id/passkeys/register/options` | pool session | → `{ challengeId, expiresAt, options }`; `options` is WebAuthn creation options, excluding existing credentials |
| POST | `/pool/:id/passkeys/register/verify` | pool session | `{ challengeId, response, name?, csrf }` → `{ passkey }`; 409 when the credential is already registered |
| POST | `/pool/:id/passkeys/login/options` | public | `{ email?, csrf }` → discoverable authentication options; the answer is the same for a known and an unknown address |
| POST | `/pool/:id/passkeys/login/verify` | public | `{ challengeId, response, email?, return_to?, csrf }` → starts a pool session and `{ redirect }`; failures share one generic refusal |

### STS token exchange and platform discovery

RFC 8693 token exchange ([IAM.md](./IAM.md) I15–I17, §7.3). The subject token is the credential, so
the endpoint takes no session or API key. Tokens are ES256, 15 minutes by default (at most 1 hour),
narrowed by the matching federation trust's restriction and the optional `scope`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/api/iam/token` (not under `/api/v1`) | none; the subject token is the credential | form-urlencoded (JSON accepted): `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token`, `subject_token_type?` (`access_token\|jwt\|id_token`), `audience?`, `scope?`, `trust_id?` → `{ access_token, issued_token_type, token_type: "Bearer", expires_in }`; 400 with RFC 8693 `error`/`error_description`. `cache-control: no-store` |
| GET | `/.well-known/jwks.json` (platform origin) | public | every signing-key purpose except `pool:*`; 5-minute cache |
| GET | `/.well-known/openid-configuration` (platform origin) | public | issuer, `jwks_uri`, `token_endpoint`, token-exchange grant, subject token types and the claims Skiff mints |

From a workload, `skif identity token --audience <aud>` reads `$SKIFF_TOKEN_FILE` (or
`/var/run/skiff/token`) and uses the node metadata endpoint for a non-`skiff` audience;
`skif sts exchange --subject-token-file <path> --audience <aud> [--scope <p>]` runs this exchange.
Neither prints the subject token. The full setup, including AWS, GCP and Azure trust policies, is
in [CLOUD-IDENTITY.md](./CLOUD-IDENTITY.md).

A workload or STS token is accepted as `Bearer` by the REST API, MCP and the registry realm; the
registry also accepts one as the Basic password. It resolves to the service account's principal,
narrowed by the token's `scope` and `resources`. A workload token must carry `aud: skiff`; an STS
token may carry `skiff`, the platform origin or the MCP resource, depending on the surface. A
missing or disabled service account, or a token whose `org_id` no longer matches it, is refused even
with a valid signature. Storage STS (RustFS `AssumeRoleWithWebIdentity`) is still deferred.

Federation trusts are managed at `/api/v1/federation-trusts` (above). The token service reads the
same rows on every exchange; a deleted trust stops new exchanges but does not revoke a token already
minted.

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
| GET | `/assistant/status` | signed in | `{ enabled, configured, provider, model }`; never the API key |
| GET | `/assistant/models?provider=openrouter` | owner | OpenRouter's catalogue, filtered to models that support tools; `?refresh=1` bypasses the 10-minute cache. Owner-only, like Settings → Assistant |
| POST | `/assistant/chat` | `project:read` | `{ message, history?, context: { path, title?, project?, targets? } }` → SSE of `run.started`, `text.delta`, `tool.started`, `tool.finished`, `ui.guide`, `confirmation.required`, `run.finished`, `error` |
| POST | `/assistant/confirm` | `project:read` | `{ token }` from a `confirmation.required` event; runs exactly the approved destructive tool, bound to the user, org, tool and arguments (10 min) |
