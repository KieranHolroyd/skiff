---
title: REST API
description: Call the Yoal control plane over HTTP at /api/v1 with an API key, and find the endpoint for each resource.
---

The REST API is the HTTP interface behind the dashboard, the [`yoal` CLI](/clients/cli) and the [MCP server](/clients/mcp). Every endpoint calls the same service layer, so a permission refused in one place is refused everywhere. Use the REST API when you want to script Yoal from CI, a cron job or your own code. This page covers how to authenticate, what requests and errors look like, and a reference of every endpoint grouped by resource. Each feature has its own page for what the resource does.

## Base URL and authentication

The base URL is your platform origin with `/api/v1` appended:

```text
https://control.example.com/api/v1
```

Send an API key as a bearer token:

```http
Authorization: Bearer yoal_…
```

A bearer value that does not start with `yoal_` is rejected with `401`. MCP tokens are not accepted here. Create keys in the dashboard or through `yoal login`; see [API keys and tokens](/accounts/api-keys-and-tokens).

A key can only do what its scopes allow. If a key lacks the permission an endpoint needs, the response is `403` and names the permission. Some permissions are never granted by default, such as the `*:credentials` permissions that reveal secrets; add them to a key on purpose.

Requests from a signed-in browser can use the dashboard session cookie instead. Either way, mutations must pass the origin check described next.

> [!NOTE]
> Every request that changes state (`POST`, `PUT`, `PATCH`, `DELETE`) must carry an `Origin` header that matches your platform origin, or a `Sec-Fetch-Site: same-origin` header. Command-line tools such as `curl` send neither by default, so add `-H "Origin: https://control.example.com"` to every write. A request without them is refused with `403` and a plain-text body, before authentication is checked.

Each API key may make 100,000 requests in any 24-hour period.

In the tables below, a **platform admin** is a user whose account role is `admin`. Being an organisation owner does not make you a platform admin. Routes marked **session** need a dashboard sign-in and refuse API keys.

## Requests and responses

Send request bodies as JSON with `Content-Type: application/json`. A body that is not valid JSON returns `400` with `error: "invalid_json"`. Most responses are JSON too. The exceptions are:

- `GET /metrics` returns Prometheus text.
- `GET /usage?format=csv` returns CSV.
- Object downloads and uploads on `/storage/{name}/objects/item` move raw bytes.
- `GET /operations/{id}/stream` and `POST /assistant/chat` return server-sent events.

Status codes follow a simple pattern. Reads and most actions return `200`. Creates return `201`. Work that is queued and finishes later returns `202`, and deletes that return no body return `204`.

## Errors

Every JSON error has an `error` code and usually a `message`:

```json
{ "error": "conflict", "message": "\"blog\" is already taken.", "suggestions": ["blog-app"] }
```

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_json` | The request body is not valid JSON. |
| 401 | `unauthorized` | The key or session is missing, invalid or revoked. |
| 403 | `forbidden` | The key or user lacks the permission. The body has a `permission` field. |
| 404 | `not_found` | The resource does not exist, or you cannot see it. |
| 405 | `method_not_allowed` | The path exists but not for this method. |
| 409 | `conflict` or `quota_exceeded` | The request clashes with current state, or would exceed a quota. |
| 422 | `validation` | The input is invalid. The body has an `issues` array of `path` and `message` pairs. |
| 429 | `rate_limited` | A send or chat is over its limit. Email sends can also return `daily_quota`. |
| 500 | `internal` | An unexpected failure. The control plane logs the cause; the response body does not include it. |
| 502 | `node_task_failed` | A task ran on a node and the node reported a failure. The body includes the `task`. |

## Long-running work and idempotency

Work that takes a while, such as a restore or a node task, returns `202` with a `location` header or an `id` you poll. Two query parameters control waiting:

- `?wait=<seconds>` on `POST /operations`, `GET /operations/{id}` and `POST /blueprints/apply`, and on `GET /node-tasks/{id}`, holds the request open for up to 25 seconds. Use it to avoid polling.
- `GET /operations/{id}/stream` sends progress as server-sent events. Resume a dropped stream with `Last-Event-ID`.

`POST /operations` accepts an `Idempotency-Key` header of up to 128 characters. A repeat of the same key from the same user returns the operation the first request created, rather than starting another one. Email sends accept an `idempotencyKey` in the body.

Node tasks return `200` when they succeed, `202` while they are still running (poll the `location`), and `502` when they fail.

## Pagination and limits

There is no single pagination scheme. Each list endpoint takes its own parameters:

- Deployments take `limit` (default 50).
- Logs take `after` and `limit`, and return a `cursor` for tailing.
- Email messages take `limit` (up to 200) and `before`, an ISO timestamp.
- Email suppressions take `limit` (up to 1,000).
- Object listings take `prefix`, `delimiter=/` for folders, and a `token` from the previous page's `nextToken`.
- Operation items take `after` and `limit`.
- Event deliveries take `limit` (up to 200).

Some size limits apply to uploads and writes:

- An upload archive may be up to 500 MiB.
- An upload session expires after one hour. Finalise it once; a second finalise returns `422`.
- An inline deploy (`POST /projects/{slug}/deploy`) may carry up to 20,000 files.
- A direct object `PUT` through the API is limited to 100 MiB by default (`YOAL_STORAGE_OBJECT_MAX_BYTES`). Use a presigned upload or the CLI for larger files.

## Examples

Set your key and platform origin once for the examples below:

```sh
export YOAL_KEY=yoal_…
export YOAL_ORIGIN=https://control.example.com
```

### List projects

```sh
curl -sS "$YOAL_ORIGIN/api/v1/projects" \
  -H "Authorization: Bearer $YOAL_KEY"
```

The response is `{ "projects": [ … ] }`.

### Deploy with an upload session

A deploy is three calls: open an upload session, put the zipped build to the signed URL, then finalise. The signed URL needs no Yoal credentials.

```sh
# Zip the built site, so its files sit at the root of the archive.
(cd dist && zip -qr ../site.zip .)

# 1. Open an upload session. The response has uploadId, url, method, headers and expiresAt.
UPLOAD=$(curl -sS -X POST "$YOAL_ORIGIN/api/v1/uploads" \
  -H "Authorization: Bearer $YOAL_KEY" \
  -H "Origin: $YOAL_ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{"project":"my-site"}')
UPLOAD_ID=$(printf '%s' "$UPLOAD" | jq -r '.uploadId')
UPLOAD_URL=$(printf '%s' "$UPLOAD" | jq -r '.url')

# 2. PUT the archive to the signed URL, with the content type the session returned.
curl -sS -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/zip" \
  --data-binary @site.zip

# 3. Finalise. This builds the release and, with promote true, makes it production.
curl -sS -X POST "$YOAL_ORIGIN/api/v1/uploads/$UPLOAD_ID/finalize" \
  -H "Authorization: Bearer $YOAL_KEY" \
  -H "Origin: $YOAL_ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{"project":"my-site","promote":true,"message":"Release 2026-11-07"}'
```

Finalising returns the new deployment, including its `id`, `shortId`, `previewUrl` and `productionUrl`. If you finalise before the PUT lands, you get a `422` and can try again. See [static sites](/deploying/static-sites) for what goes in the archive.

### Promote a deployment

Promotion points production at an existing deployment. Find its id first:

```sh
curl -sS "$YOAL_ORIGIN/api/v1/projects/my-site/deployments?limit=10" \
  -H "Authorization: Bearer $YOAL_KEY"
```

Then promote it. The body must repeat the project slug as well as the URL:

```sh
curl -sS -X POST "$YOAL_ORIGIN/api/v1/projects/my-site/promote" \
  -H "Authorization: Bearer $YOAL_KEY" \
  -H "Origin: $YOAL_ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{"project":"my-site","deploymentId":"dep_…"}'
```

`deploymentId` takes a full id or a short id. This moves production only. To move a named environment, use `POST /projects/{slug}/environments/{env}/promote`.

### Roll back

Rollback points production back at the deployment that was promoted before the current one:

```sh
curl -sS -X POST "$YOAL_ORIGIN/api/v1/projects/my-site/rollback" \
  -H "Authorization: Bearer $YOAL_KEY" \
  -H "Origin: $YOAL_ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

If there is no earlier production deployment, the response is `409` and the message tells you to promote a specific deployment instead. Rollback only moves the production pointer; it does not rebuild anything. See [static sites](/deploying/static-sites) for how deployments are kept.

## Endpoints by resource

Each table has one row per path. Where a path takes several methods, they share the row. Path parameters appear as `{name}`. Routes marked **platform admin** need a platform admin; **session** routes also refuse API keys.

### Account and status

| Method | Path | Purpose |
|---|---|---|
| GET | `/whoami` | The signed-in user, org, role, effective permissions and platform origin. |
| GET | `/status` | Fleet and deployment summary. |
| GET | `/metrics[/{section}[/{name}]]` | Prometheus metrics for your org, optionally one section. |
| GET | `/audit` | Audit log entries, newest first, filtered by `action`, `resource`, `from` and `to` (a date, ISO time or epoch ms; a date as `to` covers the whole day). Returns `entries` and `nextCursor`; pass it as `cursor` for the next, older page. At most 200 a page (`limit`). |
| GET, POST | `/secrets` | List secret metadata (values are never returned), or set a secret. A new name needs `secret:create`; a new version of an existing name needs `secret:update`. |
| DELETE | `/secrets/{id}` | Delete a secret. |
| POST | `/cli/token` | Exchange a CLI login code and PKCE verifier for an API key. |
| GET | `/connected-apps` | MCP clients you have approved. `?scope=org` lists every member's, and needs `member:remove`. See [connected apps](/accounts/api-keys-and-tokens#connected-apps). |
| DELETE | `/connected-apps/{id}` | Disconnect an approved MCP client: its next `/mcp` call gets `401`. Another member's needs `member:remove`; an owner's needs an owner. |

### Projects

| Method | Path | Purpose |
|---|---|---|
| GET, POST | `/projects` | List projects (`?trash=1` lists the trash), or create one. |
| GET, PATCH, DELETE | `/projects/{slug}` | Read, update (rename, placement, access) or soft-delete a project. Deletes are restorable for 7 days. |
| POST | `/projects/{slug}/restore` | Restore a project from the trash. |
| POST | `/projects/{slug}/access` | Set who can reach production or previews: public, password or platform. Each scope has its own password; omit `password` to keep the current one. |
| POST | `/projects/{slug}/move` | Move a process or container app to another node. |
| GET | `/projects/{slug}/logs` | Runtime and build log events, filtered by `source`, `level`, `q` and `after`. |
| GET, PUT, DELETE | `/projects/{slug}/workload` | Read, set or remove the runtime spec for a process or container project. |
| GET | `/projects/{slug}/container/targets` · `/container/inspect` | Container console: the replicas and their nodes; live state, resources, mounts and processes (`container:inspect`). Every console call takes `?replica=`. |
| GET | `/projects/{slug}/container/files?path=` · `/files/preview` · `/files/download` | List a directory, preview a text file (≤ 1 MiB) or download any file from the running container (`container:files`). |
| POST | `/projects/{slug}/container/exec` | Open a shell (`container:exec`, people and API keys only): `{ shell, user, cols, rows }` → `{ exec: { execId } }`. |
| GET | `/projects/{slug}/container/exec/{id}/stream` | Shell output as server-sent events: base64 `data` events with byte offsets as ids, then one `exit`. Resume with `Last-Event-ID`. |
| POST, DELETE | `/projects/{slug}/container/exec/{id}/input` · `/resize` · `/exec/{id}` | Send raw input bytes, resize to `{ cols, rows }`, or hang up. |
| POST | `/projects/{slug}/container/restart` | Restart every replica from the same image and configuration (`project:update`). |
| GET | `/projects/{slug}/function` | The Functions view: entry module, bindings (without secret values) and idle stop. |
| POST | `/projects/{slug}/function/invoke` | Send one test request to a function on its node, bypassing domains. |
| POST | `/projects/{slug}/function/scheduled` | Run a function's scheduled handler now for one cron. |
| GET | `/projects/{slug}/runners` | The GitHub Actions runner pool for the project. |
| GET, POST | `/projects/{slug}/environments` | List named environments, or create one. |
| PATCH, DELETE | `/projects/{slug}/environments/{env}` | Update or remove an environment. Production cannot be removed. |
| POST | `/projects/{slug}/environments/{env}/promote` | Point an environment at a deployment. |
| GET, PUT, POST, DELETE | `/projects/{slug}/git` | Read, set or update, or remove the project's git source. |
| GET, POST | `/projects/{slug}/builds` | List git builds, or queue one. |
| GET | `/projects/{slug}/builds/{id}` | One build, with its full log. |
| POST | `/projects/{slug}/builds/{id}/cancel` | Cancel a build. |
| GET, POST | `/projects/{slug}/volumes` | List app volumes, or create one. Takes the same `storage` target as databases. |
| GET, PATCH, DELETE | `/projects/{slug}/volumes/{name}` | Read, grow or rename, or soft-delete a volume. Attached volumes cannot be deleted. |
| POST, DELETE | `/projects/{slug}/volumes/{name}/attach` | Mount a volume into a workload, or detach it. |
| GET, POST | `/projects/{slug}/volumes/{name}/snapshots` | List a volume's snapshots, or queue one (`202`). |
| GET, DELETE | `/projects/{slug}/volumes/{name}/snapshots/{id}` | Read a snapshot, or delete it and its archive. |
| POST | `/projects/{slug}/volumes/{name}/snapshots/{id}/restore` | Restore a snapshot into a new volume (`202`). |

### Deployments and uploads

| Method | Path | Purpose |
|---|---|---|
| POST | `/projects/{slug}/deploy` | Deploy inline files, as text or base64, in one request. |
| GET | `/projects/{slug}/deployments` | List deployments, newest first. |
| GET, DELETE | `/projects/{slug}/deployments/{id}` | Read or delete a deployment. Accepts a full id or a short id. |
| POST | `/projects/{slug}/deployments/{id}/pin` | Pin or unpin a deployment with `pinned`. |
| POST | `/projects/{slug}/promote` | Point production at a deployment. |
| POST | `/projects/{slug}/rollback` | Point production back at the previously promoted deployment. |
| GET, POST | `/projects/{slug}/shares` | List or create share links, with expiry, visitor caps and allowed emails. |
| DELETE | `/projects/{slug}/shares/{id}` | Revoke a share link. |
| GET, DELETE | `/projects/{slug}/sessions` | List live share-link visitor sessions, or sign out every visitor of the project (`project:update`). |
| DELETE | `/projects/{slug}/sessions/{id}` | End one share-link visitor session. The link keeps working. |
| POST | `/uploads` | Open an upload session and get a signed PUT URL. |
| POST | `/uploads/{id}/finalize` | Build and deploy the uploaded archive. |

### Domains

| Method | Path | Purpose |
|---|---|---|
| GET, POST | `/domains` | List domains (`?project=`), or add one and get the TXT record to create. |
| GET, DELETE | `/domains/{id}` | Read a domain, or remove it and its managed DNS records. |
| POST | `/domains/{id}/check` | Re-check DNS and report drift. |

### Databases

| Method | Path | Purpose |
|---|---|---|
| GET, POST | `/databases` | List databases (`?includeDeleted=1` adds the trash), or create one. `storage` picks where its data goes: `system`, `fast`, `bulk` or a disk name (see [disks](/self-hosting/nodes-and-fleet#disks)). |
| GET, PATCH, DELETE | `/databases/{name}` | Read, resize, change extensions and pooler, or move the version forward in place; or soft-delete. `?purge=1` removes a trashed database for good. |
| POST | `/databases/{name}/restore` | Bring a soft-deleted database back. |
| GET | `/databases/{name}/credentials` | Reveal connection details. Audited and never cached. |
| GET, PUT, DELETE | `/databases/{name}/public-url` | Read, set or clear the public connection URL. It is stored sealed. |
| GET | `/databases/{name}/metrics` | Size, connection and throughput metrics for a time range. |
| GET | `/databases/{name}/logs` | Service log events. |
| GET, POST | `/databases/{name}/backups` | List backups, or start one. |
| GET, DELETE | `/databases/{name}/backups/{backupId}` | Read or delete a backup. |
| POST | `/databases/{name}/backups/{backupId}/restore` | Restore a backup into a new database. |
| GET, PATCH | `/databases/{name}/backup-policy` | Read or set the backup schedule and retention. |
| GET, PATCH | `/databases/{name}/pitr` | Point-in-time recovery status, including `recoverableFrom` and `recoverableTo`, and `{"enabled": true}` to turn it on. PostgreSQL 18, behind the `YOAL_FEATURE_PITR` flag. |
| POST | `/databases/{name}/pitr/backups` | Queue a PITR base backup: `{"type": "full"}`, `"diff"` or `"incr"`. |
| POST | `/databases/{name}/pitr/restore` | Restore to `targetTime` (inside the recoverable window) into a new database named `name`. |
| GET, POST | `/databases/{name}/replicas` | List read replicas with `primaryGeneration` and the promotion history, or add one with `{"node": "<id or name>"}` and an optional `storage` target. PostgreSQL only. |
| DELETE | `/databases/{name}/replicas/{id}` | Start removing a replica (202): its node deletes the copy and the primary drops its slot. |
| POST | `/databases/{name}/replicas/{id}/promote` | Promote a replica to primary (202): `{"confirm": true, "acceptDataLoss": false}` with `If-Match: <primaryGeneration>`; a stale generation returns 412. |
| GET, POST | `/databases/{name}/move` | Read the latest move, or start moving the database to another node, with an optional `storage` target there. |
| GET, POST | `/databases/{name}/rotate` | Rotate the owner or monitor password, with `role`. |
| POST | `/databases/{name}/restart` | Restart the database, or only its pooler, with `target`. |
| GET, POST, DELETE | `/databases/{name}/studio` | Open, read or close your studio session. See [database studio](/data/database-studio). |
| GET, POST | `/databases/{name}/upgrade` | Plan a major version upgrade, or run it with `apply: true`. Upgrades are always manual. |
| GET, POST | `/projects/{slug}/databases` | List attachments, or attach a database and get its environment variables. |
| DELETE | `/projects/{slug}/databases/{name}` | Detach a database from a project. |

### Storage

| Method | Path | Purpose |
|---|---|---|
| GET, POST | `/storage` | List storage instances (`?includeDeleted=1` adds the trash), or create one. Takes the same `storage` target as databases. |
| GET, PATCH, DELETE | `/storage/{name}` | Read, resize or change visibility, or soft-delete an instance. |
| POST | `/storage/{name}/restore` | Bring a soft-deleted instance back. |
| POST | `/storage/{name}/restart` | Restart the instance. Buckets, objects and keys are kept. |
| POST | `/storage/{name}/move` | Move an empty instance to another node, with an optional `storage` target there. Objects are not copied. |
| GET | `/storage/{name}/credentials` | Reveal the root key. Audited and never cached. |
| POST, DELETE | `/storage/{name}/rotate-root` | Start a root key rotation (RustFS restarts with a new key, promoted once the node confirms it), or cancel one that is waiting. Needs `storage:credentials`. |
| GET, POST | `/storage/{name}/keys` | List named access keys, or create one with `name`, `grants`, and optional `purpose` and `expiresAt`. No secrets. |
| DELETE | `/storage/{name}/keys/{id}` | Revoke a named key. |
| POST | `/storage/{name}/keys/{id}/reveal` | Reveal a named key's secret. Needs `storage:credentials`; audited and never cached. |
| GET | `/storage/{name}/metrics` | Usage metrics for a time range. |
| GET | `/storage/{name}/logs` | Service log events. |
| GET, POST | `/storage/{name}/buckets` | List buckets, or create one. |
| PATCH, DELETE | `/storage/{name}/buckets/{bucket}` | Change a bucket's access, or delete it. `?force=1` empties it first. |
| GET, PATCH | `/storage/{name}/buckets/{bucket}/config` | Read or change one bucket's desired configuration. |
| POST | `/storage/{name}/buckets/{bucket}/sign` | Mint a share link for one object. The response contains no key. |
| GET, POST | `/storage/{name}/replicas` | List bucket replication rules with their progress, or add a target (`{"target": "<name>"}`). |
| DELETE | `/storage/{name}/replicas/{id}` | Remove a replication target. |
| GET | `/storage/{name}/objects` | List objects in a bucket, with `prefix`, `delimiter` and `token`. |
| GET, HEAD, PUT, DELETE | `/storage/{name}/objects/item` | Download, check, upload or delete one object, identified by `bucket` and `key` in the query. |
| POST | `/storage/{name}/objects/delete` | Delete up to 1,000 keys in one call. |
| POST | `/storage/{name}/objects/folder` | Create a folder marker. |
| POST | `/storage/{name}/objects/presign` | Presign a GET or PUT URL. Public instances only. |
| GET, POST | `/projects/{slug}/storage` | List attachments, or grant a project access to buckets. |
| PATCH, DELETE | `/projects/{slug}/storage/{name}` | Change a project's grants, or detach the instance. |

### Brokers and events

| Method | Path | Purpose |
|---|---|---|
| GET, POST | `/brokers` | List queue brokers (`?includeDeleted=1` adds the trash), or create one. Takes the same `storage` target as databases. |
| GET, PATCH, DELETE | `/brokers/{name}` | Read, resize or move the version forward, or soft-delete a broker. |
| POST | `/brokers/{name}/restore` | Bring a soft-deleted broker back. |
| POST | `/brokers/{name}/restart` | Restart the broker. Streams are kept. |
| GET | `/brokers/{name}/credentials` | Reveal credentials. Needs `broker:credentials`, and every read is audited. |
| GET | `/brokers/{name}/logs` | Service log events. |
| GET | `/brokers/{name}/metrics` | Connections, store use, message and consumer metrics. |
| GET, POST | `/brokers/{name}/queues` | List JetStream streams, or create a function queue's stream now. |
| POST | `/brokers/{name}/queues/{queue}/messages` | Publish a test message, or up to 100 copies. |
| POST | `/brokers/{name}/queues/{queue}/redrive` | Move messages from a dead-letter queue back to another queue. |
| GET | `/brokers/{name}/streams/{stream}/messages` | Read messages without consuming them, starting at sequence `from`, with `limit` up to 50. |
| DELETE | `/brokers/{name}/streams/{stream}` | Delete a stream and its messages. |
| POST | `/brokers/{name}/streams/{stream}/purge` | Remove every message, keeping the stream and its consumers. |
| DELETE | `/brokers/{name}/streams/{stream}/messages/{seq}` | Delete one message by stream sequence. |
| GET, POST | `/projects/{slug}/brokers` | List attachments, or attach a broker and get its environment variables. |
| DELETE | `/projects/{slug}/brokers/{name}` | Detach a broker from a project. |
| GET, POST | `/events` | List event rules, or create one that publishes a source's events to a queue. |
| GET, PATCH, DELETE | `/events/{id}` | Read, update or delete an event rule. |
| POST | `/events/{id}/test` | Queue one synthetic event for a rule. |
| GET | `/events/deliveries` | Recent deliveries, filtered by `rule`, `status` and `limit`. |

### Email

| Method | Path | Purpose |
|---|---|---|
| GET | `/email` | Your org's sending state and quotas. Platform admins also see mail node settings. |
| PATCH | `/email/settings` | Pick the mail node and pause or resume sending. Platform admin, session only. |
| PATCH | `/email/orgs/{orgId}` | Set an org's sending state and limits. Platform admin, session only. |
| GET, POST | `/email/domains` | List sending domains, or add one. Yoal creates DNS records where it can. |
| GET, PATCH, DELETE | `/email/domains/{name}` | Read, turn sending on or off, or remove a domain. |
| POST | `/email/domains/{name}/check` | Look up the domain's DNS records now. |
| POST | `/email/send` | Send one message. Returns `202` with the message id. |
| POST | `/email/send-batch` | Send up to 100 messages in one call. |
| GET | `/email/messages` | The message log, filtered by `limit`, `before`, `recipient` and `status`. |
| GET | `/email/messages/{id}` | One message, with each recipient's status. |
| GET, POST | `/email/suppressions` | List suppressed addresses, or add one. |
| DELETE | `/email/suppressions/{address}` | Remove an address from the suppression list. |
| GET, POST | `/email/addresses` | List sandbox recipients, or add one: Yoal emails it a confirmation link. `201` for a new link, `200` if it is already verified. |
| DELETE | `/email/addresses/{address}` | Remove a sandbox recipient. |
| GET, POST | `/email/access-request` | Your org's latest production access request (`null` if none), or send one with `useCase`, `expectedDailyVolume` and optional `website`. Owners and admins. |
| GET | `/email/access-requests` | Every org's requests, pending first, filtered by `status` and `limit`. Platform admin. |
| POST | `/email/access-requests/{id}` | Approve (`decision`, optional `perDay`, `perSecond`, `note`) or deny (`note` required) a request. Platform admin, session only. |
| GET, POST | `/email/credentials` | List SMTP credentials, or create one. The password is shown once. |
| DELETE | `/email/credentials/{id}` | Revoke an SMTP credential. |
| GET, POST, DELETE | `/projects/{slug}/email` | List a project's SMTP attachments, attach one with its own credential, or detach it. |

### Nodes and fleet

| Method | Path | Purpose |
|---|---|---|
| GET | `/nodes` | List nodes. |
| POST | `/nodes/join-token` | Create a single-use join token, valid for one hour. Session only. |
| GET | `/nodes/capacity` | The workload slice budget and reservation on each node. |
| PATCH, DELETE | `/nodes/{id}` | Update a node's settings, or remove a worker node. Session only. |
| POST | `/nodes/{id}/builder` | Allow or stop a node claiming git builds. |
| POST | `/nodes/{id}/drain` | Drain a node. |
| POST | `/nodes/{id}/resume` | Resume a drained node. |
| POST | `/nodes/{id}/rotate-token` | Rotate a node's token. Session only. |
| POST | `/nodes/{id}/edge` | Make an online node the public edge. Session only. |

### Topology, cluster and platform

| Method | Path | Purpose |
|---|---|---|
| GET | `/topology` | Zones, nodes, roles, labels, disks and placement counts. |
| GET | `/topology/blast-radius` | What an outage of `?node=` or `?zone=` would take down. |
| GET, PATCH | `/cluster/config` | Read or change cluster tunables such as overlay, replicas and limits. Platform admin, session only for changes. |
| GET, POST | `/shares` | List cluster shares (NFS or SMB), or register one. Session only for creates. |
| GET, PATCH, PUT, DELETE | `/shares/{name}` | Read, update or remove a cluster share. |
| PUT | `/shares/{name}/grants` | Replace the set of orgs that may use a share. |
| POST | `/shares/{name}/mounts` | Mount a share on a node: `{"node": "<id or name>", "diskName": "<name>"}`. A read-write share becomes a bulk, network disk once mounted. Session only. |
| DELETE | `/shares/{name}/mounts/{node}` | Remove the share's disk (refused while anything is stored on it), then unmount. Session only. |
| PUT, DELETE | `/shares/{name}/mounts/{node}/disk` | Use a mounted share as a disk (`{"diskName": "<name>"}`), or stop using it as one. The share stays mounted. Session only. |
| GET | `/platform/storage` | Storage defaults, and per node its system disk, disks and the filesystems it could add. Platform admin. |
| POST | `/platform/storage/disks` | Add a disk: `{"node", "candidate", "name", "tier"}`, where `candidate` is a key from the listing. Session only. |
| PATCH, DELETE | `/platform/storage/disks/{id}` | Rename a disk or change its tier, or stop using it. Removal is refused while anything is stored on it. Session only. |
| POST | `/platform/storage/disks/{id}/profile` | Benchmark a disk. Session only. |
| PUT | `/platform/storage/defaults` | Set the default per kind: `{"defaults": [{"kind": "databases", "target": "fast"}]}`. Session only. |
| POST | `/platform/storage/onboarding` | Mark the setup Storage step `done` or `skipped`. Session only. |
| GET | `/ingress/status` | Ingress driver and readiness. |
| GET | `/ha/status` | The failover controller: whether automatic failover is on, the lease (epoch, holder), policy, per-node silence and replica copies, the ingress record set, databases whose primary is lost with the promotion candidate, and the last 50 failover events. Platform admin. |
| GET | `/platform/upgrade/plan` | A read-only plan for upgrading the platform. It never changes the host. |
| GET, POST | `/backup-targets` | List backup targets, or create one. `?platform=1` makes a platform target. |
| GET, PATCH, PUT, DELETE | `/backup-targets/{id}` | Read, update or remove a backup target. `DELETE` is refused while backups are stored on the target unless you add `?force=1`. |
| POST | `/backup-targets/{id}/test` | Test a backup target's connection. |
| POST | `/services/restart` | Restart databases and/or storage instances, by `scope`. |
| POST | `/services/backup-databases` | Queue a backup for every live database. |

### Jobs

Cron jobs and one-off commands on a process or container project (see [app jobs](/compute/scheduled-jobs#app-jobs)). All paths are under `/projects/{slug}/jobs`. Writes and runs answer `404 feature_disabled` while the platform has jobs turned off.

| Method | Path | Purpose |
|---|---|---|
| GET | `/projects/{slug}/jobs` | List jobs. |
| POST | `/projects/{slug}/jobs` | Create a job: `{ "name", "command": ["bun", "tidy.ts"], "schedule"?, "timeoutSeconds"?, "concurrency"?, "maxRetries"?, "enabled"? }`. `201`. |
| GET, PATCH, DELETE | `/projects/{slug}/jobs/{name}` | Read, change (`"schedule": null` removes the schedule) or delete a job and its history. |
| POST | `/projects/{slug}/jobs/{name}/run` | Run the job now. `202` with the queued run and a `location` to poll. |
| POST | `/projects/{slug}/jobs/{name}/pause`, `/resume` | Pause or resume the schedule. |
| GET | `/projects/{slug}/jobs/{name}/runs` | The job's runs, newest first. `?limit=` up to 200. |
| GET | `/projects/{slug}/jobs/runs` | Every run of the project. `?oneOff=1` keeps one-off commands only. |
| POST | `/projects/{slug}/jobs/runs` | Run a one-off command: `{ "command": [...], "timeoutSeconds"? }`. `202` with the run and a `location`. |
| GET | `/projects/{slug}/jobs/runs/{id}` | Read a run. `?wait=` holds the request for up to 25 seconds while it is queued or running. |
| POST | `/projects/{slug}/jobs/runs/{id}/cancel` | Cancel a queued run, or ask the node to stop a running one. |
| GET | `/projects/{slug}/jobs/runs/{id}/logs` | A run's output: the newest page, or everything after `?after=<cursor>`; `limit`, `level`, `q`. |

### Node tasks

| Method | Path | Purpose |
|---|---|---|
| GET | `/node-tasks/{id}` | Read a node task. `?wait=` holds the request for up to 25 seconds. |

### Alerts

| Method | Path | Purpose |
|---|---|---|
| GET | `/alerts` | Overview of active alerts, counts, channels and what you may do. |
| GET, POST | `/alerts/rules` | List alert rules, or create one. |
| GET, PUT, DELETE | `/alerts/rules/{id}` | Read, update or delete a rule. |
| POST | `/alerts/rules/{id}/evaluate` | Evaluate a rule now. |
| POST | `/alerts/rules/{id}/test` | Send a test notification for a rule. |
| POST | `/alerts/rules/{id}/ack` | Acknowledge a series, to stop repeats until it resolves. |
| POST | `/alerts/preview` | Preview which series a rule would breach. Saves nothing. |
| GET, POST | `/alerts/silences` | List silences, or create one. |
| DELETE | `/alerts/silences/{id}` | End a silence now. |
| GET, PUT | `/alerts/system` | Built-in alert kinds and their routing. Platform admins read; the platform owner changes. |
| POST | `/alerts/channels/test` | Test one notification channel, or all of them. |
| GET | `/alerts/history` | Alert events, newest first, filtered by `rule`, `kind`, `before` and `limit`. |

### Observability

| Method | Path | Purpose |
|---|---|---|
| GET | `/observability/schema` | The datasets and measures that dashboard queries can use. |
| POST | `/observability/query` | Run one panel query. Nothing is saved. |
| GET, POST | `/observability/dashboards` | List saved dashboards, or create one. |
| GET, PUT, DELETE | `/observability/dashboards/{id}` | Read, update (send the `version` you based it on) or delete a dashboard. |
| GET, POST | `/log-drains` | List log drains (`logs:read`), or create one (owners and admins). A webhook drain's `signingSecret` is in the create response once. See [log drains](/observe/dashboards-and-logs#log-drains). |
| GET, PATCH, DELETE | `/log-drains/{id}` | Read, update or delete a drain. `headers` replaces every header (`null` removes them); `rotateSigningSecret: true` returns a new secret once; `enabled: true` resumes from new lines. |
| POST | `/log-drains/{id}/test` | Send one test line now. Returns `{ result: { ok, status, message } }`. |

### Operations

| Method | Path | Purpose |
|---|---|---|
| GET | `/operations/actions` | The mass actions you may run. |
| GET, POST | `/operations` | List operations, or start one. Returns `202`. Accepts `Idempotency-Key`. |
| GET | `/operations/{id}` | One operation. `?items=1` adds its per-item results. |
| GET | `/operations/{id}/stream` | Server-sent events for progress and items. |
| POST | `/operations/{id}/apply` | Apply a planned operation. |
| POST | `/operations/{id}/cancel` | Cancel an operation after its current item. |

### Blueprints

These need the `BLUEPRINTS` feature flag. See [blueprints](/compute/apps-and-containers#blueprints).

| Method | Path | Purpose |
|---|---|---|
| POST | `/blueprints/validate` | Check `{ document }` (YAML or JSON text, or a parsed object) without reading live state. Returns `{ validation }`. |
| POST | `/blueprints/plan` | Diff `{ document, prune? }` against live state. Changes nothing. Returns `{ plan }` with every resource step, a `planHash` and the planned operation's id. Any problem is a `422` listing every issue with its resource path. |
| POST | `/blueprints/apply` | Apply `{ planHash, confirm? }`: your own plan, within one hour. `confirm` is the stack name, required when the plan deletes resources. Returns `202` with `{ run }`; `?wait=<seconds>` (up to 25) holds the response until the run settles. A plan whose live state moved is a `409`. |
| GET | `/blueprints/apply/{operationId}` | One run: its status and the result of every step. |
| GET | `/blueprints` | The stacks your organisation has applied, with the resources each manages. |
| GET | `/blueprints/{name}` | One stack, its last cleanly applied document and its last run. |

### Usage, quotas and templates

| Method | Path | Purpose |
|---|---|---|
| GET | `/usage` | Usage for your org, or one project with `?project=`. Use `format=csv` or `history=1`. |
| GET | `/quotas` | The org quota, or one project's limits with `?project=`. |
| PATCH, DELETE | `/quotas` | Set org quotas or project overrides, or clear a project's overrides. Platform admin. |
| GET | `/templates` | The first-party app templates. |
| GET | `/templates/{id}` | One template and its form fields. |
| POST | `/templates/{id}` | Create a project from a template with `values`. Returns the project, deployment and secret names. |

### Assistant

| Method | Path | Purpose |
|---|---|---|
| GET | `/assistant/status` | Whether the assistant is enabled and configured. Never returns the provider key. |
| GET | `/assistant/models` | Models available from the configured provider. Owner only. |
| POST | `/assistant/chat` | Send one message. The reply is server-sent events. |
| POST | `/assistant/confirm` | Run a destructive action the user approved in the chat. |

## Internal endpoints

The `/api/agent` routes are the protocol nodes use to talk to the control plane. They are internal, authenticated with node tokens, and not part of the public API.
