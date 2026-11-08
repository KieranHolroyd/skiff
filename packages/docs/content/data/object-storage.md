---
title: Object storage
description: Create S3-compatible storage instances, buckets and per-project keys, then use them from your code, the dashboard or the skif CLI.
---

Object storage gives you an S3-compatible server for files: user uploads, build artefacts, exports or anything else you would otherwise put in a bucket. A **storage instance** is a RustFS server that Skiff runs on one of your nodes. It holds **buckets**, and each project that needs them gets its own access key, limited to the buckets you grant. Storage instances are organisation resources, like [managed databases](/data/databases): they have no releases or deployments of their own.

## Concepts

- **Instance**: one RustFS server, with its own memory, CPU and storage budget. Names are 3 to 40 characters of lowercase letters, digits and single hyphens.
- **Bucket**: a namespace inside an instance. Bucket names are 3 to 63 characters of lowercase letters, digits and hyphens. Dots are not allowed, and neither are double hyphens.
- **Attachment**: a link between an instance and a project. It carries an env prefix, a list of bucket grants and a key pair that belongs to that attachment alone.

Your apps never see the instance's root key. They receive the attachment's key, which you can detach at any time.

## Create an instance

In the dashboard, go to **Storage → Create storage**. From the CLI, `create` makes the instance, adds any buckets you name and, with `--project`, attaches it in one step:

```sh
skif storage create media --bucket uploads --project api
skif storage create assets --bucket img,css --public --storage 50G
```

Defaults are 512 MB of memory, 1 CPU and a 10 GB storage budget. The budget drives the usage gauge and the alert at 85%; it does not cap what the instance can hold. The memory limit must be at least 256 MB. Use `--placement auto` (the default), `edge`, or a node id to choose where the instance runs. `--disk` chooses where its data is stored: `system`, `fast`, `bulk`, or a [disk](/self-hosting/nodes-and-fleet#disks) by name. It defaults to the **Object storage** default in **Settings → Storage**. `--project` needs at least one `--bucket`, because the project is granted read-write on the buckets you create.

Check on it with `skif storage info media`, which shows its status, node, endpoints, buckets and attached projects.

## Buckets

Each bucket is either `private` (the default) or `public-read`. A `public-read` bucket lets anyone send unsigned `GET` requests for its objects, but not list them.

```sh
skif storage buckets create media avatars --access public-read
skif storage buckets list media                  # size and object count per bucket
skif storage buckets config media avatars        # versioning, lifecycle, CORS, quota, convergence
skif storage buckets update media avatars --access private
```

Bucket configuration is optional. You can set versioning, a lifecycle policy, CORS rules and a hard quota. Object lock is set at creation only, and cannot be turned off:

```sh
skif storage buckets create ledger records --object-lock compliance:365
skif storage buckets update media uploads --versioning on --quota 5G
skif storage buckets update media uploads --cors @cors.json
```

Lifecycle and CORS take a JSON array, either inline or from a file with `@`. Bucket configuration needs the object browser feature, which is on by default. The node applies changes within about a minute and reports `configStatus` as `pending`, `converged`, `error` or `unsupported`. `unsupported` means the RustFS build cannot apply that setting.

> [!NOTE]
> A bucket can only be deleted when it is empty. `skif storage buckets delete media avatars --force` empties it first. That needs the `storage:delete` permission, and it cannot be undone.

## Attach a project

Attaching gives a project a scoped key and injects its connection details at the project's next activation. You do not need to redeploy. A running app restarts on its own.

```sh
skif storage attach media --project worker                  # read-write on the only bucket
skif storage attach media --project cdn --bucket uploads:read --bucket avatars --prefix AWS
skif storage grants media --project cdn --bucket uploads:read-write   # replaces the grants
skif storage detach media --project cdn                    # revokes the key; the app restarts without it
```

Without `--bucket`, `attach` grants read-write on the instance's only bucket. If the instance has several buckets, it asks you to name them. Each grant is `<bucket>:read` or `<bucket>:read-write`, and read-write is the default. A project can hold more than one attachment, but each one needs its own env prefix.

The project receives these variables. `<P>` is the env prefix, which defaults to `S3`:

| Variable | Value |
| --- | --- |
| `<P>_ENDPOINT_URL` | The address the app should use. See [public and private instances](#public-and-private-instances). |
| `<P>_ACCESS_KEY_ID` | The attachment's access key ID. |
| `<P>_SECRET_ACCESS_KEY` | The attachment's secret key. |
| `<P>_REGION` | `us-east-1`. RustFS accepts any region, but SDKs require one. |
| `<P>_FORCE_PATH_STYLE` | `true`. |
| `<P>_BUCKET` | Only when exactly one bucket is granted. |
| `<P>_PUBLIC_ENDPOINT_URL` | Only when the instance is public: the URL browsers and external clients use. |

Use `--prefix AWS` to get the names the AWS SDKs and the AWS CLI read by default (`AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID` and so on). The default prefix `S3` avoids shadowing any real AWS credentials your app might also use.

## Use it from code

Any S3 SDK works. Use path-style addressing, because the endpoint is a host and port, not a bucket subdomain. With the AWS SDK for JavaScript v3, for example:

```ts
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const s3 = new S3Client({
	endpoint: process.env.S3_ENDPOINT_URL,
	region: process.env.S3_REGION,
	forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
	credentials: {
		accessKeyId: process.env.S3_ACCESS_KEY_ID!,
		secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!
	}
});

const listing = await s3.send(new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET! }));
```

If you attached with `--prefix AWS`, the SDK can read `AWS_ENDPOINT_URL` and the other variables itself, but set `forcePathStyle: true` explicitly.

To give a browser a presigned upload or download URL for a public instance, sign against `<P>_PUBLIC_ENDPOINT_URL` rather than `<P>_ENDPOINT_URL`. The internal endpoint is not reachable from browsers.

## Public and private instances

A **private** instance (the default) listens only on its own node. Apps attached to it are placed on that node, so they reach it locally. The endpoint is `127.0.0.1` on that node, and you cannot reach it from your laptop without a tunnel.

A **public** instance also serves S3 at `https://<name>--s3.<content domain>`. Use path-style URLs with it, for example `https://media--s3.example.com/uploads/photos/a.jpg`. Attached apps on any node can use it, which is the only way to reach an instance from a different node. Public traffic goes through the edge server, so large transfers use your bandwidth there.

```sh
skif storage update media --public        # or --no-public
```

Turning `--public` on or off changes only the routing. The instance does not restart, and its data stays where it is.

> [!WARNING]
> The root key can manage every bucket. Prefer attachments for apps. Use the root key only from trusted machines.

## Browse objects in the dashboard

Open an instance and choose a bucket to get the object browser. You can move through folders, create folders, upload, download, preview and delete objects. You can also create signed share links for a single object: they take an expiry of up to 7 days and can be limited to a number of downloads.

Uploads through Skiff are capped at 100 MB per file by default. Operators can change this with `SKIFF_STORAGE_OBJECT_MAX_BYTES` (see [configuration](/self-hosting/configuration)). Larger files need a presigned URL, which requires a public instance.

Object keys can be up to 1,024 bytes, and cannot start with `/` or contain `.`, `..` or `//` segments.

## Objects from the CLI

```sh
skif storage objects ls media -b uploads --prefix photos/
skif storage objects put media -b uploads -k photos/a.jpg -f ./a.jpg
skif storage objects get media -b uploads -k photos/a.jpg -o a.jpg
skif storage objects rm media -b uploads --prefix photos/ --yes
skif storage objects presign media -b uploads -k photos/a.jpg --expires 6h   # public instances only
skif storage objects share media -b uploads -k photos/a.jpg --expires 7d --downloads 3
```

`rm --prefix` deletes every object under the prefix, up to 10,000 in one run. Without `--yes`, it asks first. `share` works on private instances too. Its link goes through the control plane, and the storage key is never shown.

## Usage and logs

Each running instance is sampled about once a minute: stored bytes, object count, container memory and disk use. Look at the trend with:

```sh
skif storage metrics media --since 24h
skif storage metrics media --from 2026-11-01T00:00:00Z --to 2026-11-02T00:00:00Z --interval 1h
```

`--interval` is `1m` or `1h`. The dashboard shows the same series as charts, plus a per-bucket table.

Container output is available from the dashboard's logs page and from the CLI: `skif storage logs media --follow`, or filter with `--level`, `--q` and `--limit`.

## Credentials

Your root key lets you set up any client. Reveal it from the instance page in the dashboard, or print it from the CLI:

```sh
set -a; eval "$(skif storage credentials media)"; set +a; aws s3 ls
skif storage credentials media --prefix S3 > .env
skif storage credentials media --json
```

Credentials print as `<prefix>_` lines, with `AWS` by default. Each read needs the `storage:credentials` permission, and is recorded in the audit log.

To rotate an attachment's key, detach the project and attach it again. The old key is revoked on detach, and the new one is generated when you reattach.

### Rotate the root key

Use **Rotate** on the instance's **Endpoints** panel, or:

```sh
skif storage rotate-root media            # asks first; use --yes off a terminal
skif storage rotate-root media --cancel   # abandon a rotation that is still waiting
```

RustFS can only change its root key on a restart, so the instance restarts with a new key and S3 requests fail briefly. The node then checks that the new key works. Once it confirms, usually within a minute, the new key replaces the old one and the old key stops working. Update any tool that uses the root key, then read the new one with `skif storage credentials media`. Until the node confirms, `credentials` still returns the current key.

If RustFS refuses the new key, or the node does not confirm it within 10 minutes, the rotation rolls back: the instance restarts with the previous key, and `skif storage info` shows why. Attached apps and named keys are not affected, because they never use the root key. Rotating needs the `storage:credentials` permission and the instance must be running.

## Access keys

Named access keys are for people and services outside Skiff, such as a backup tool, a CDN or a teammate's S3 client. Like an attachment's key, each one can reach only the buckets you grant. Manage them in the instance's **Access keys** panel, or from the CLI:

```sh
skif storage keys create media backup-tool --bucket uploads:read --purpose "Offsite copy" --expires 90d
skif storage keys list media
skif storage keys reveal media stk_123 > .env      # prints AWS_* env lines
skif storage keys revoke media stk_123
```

`create` does not print the secret. Reveal it when you need it: like the root key, a reveal needs the `storage:credentials` permission and is recorded in the audit log. `--expires` takes a duration from now (`30d`, `12h`, `2w`) or an ISO time. The node adds a new key, and removes a revoked or expired one, within about a minute. Creating and revoking keys needs `storage:update`.

The list also shows the keys of attached projects, named `attachment-<project>-…`. Those belong to the project: detaching it revokes the key, and they cannot be revealed. Key names starting with `attachment-` are reserved.

AI agents can list, create and revoke keys over MCP, but never read a secret.

## Replication

A replication target keeps a second copy of an instance's buckets on another node. Add one in the instance's **Replication** panel, or with the REST API:

```sh
curl -X POST https://control.example.com/api/v1/storage/media/replicas \
  -H "Authorization: Bearer skif_…" \
  -H "Content-Type: application/json" \
  -d '{"target": "media-copy"}'
```

The target must be a private instance on a different node, and it cannot replicate anywhere itself. Skiff creates the target's copy of every source bucket, then copies every object to it. After that, every 15 minutes by default (`storage.syncIntervalMinutes` in **Settings → Clustering**), it copies new and changed objects and deletes objects that were deleted on the source. A bucket you add to the source later is included from the next pass. An instance can replicate to at most `storage.maxTargets` targets (2 by default) and covers at most 20 buckets.

The **Replication** panel shows each rule's status:

| Status | Meaning |
| --- | --- |
| `pending`, `syncing` | The first full copy has not finished. The target is not a usable copy yet. |
| `protected` | The last full pass finished within two intervals. |
| `lagging` | The last full pass is older than that, or the latest one hit errors. |
| `failed` | Copying keeps failing and there is no recent full pass. |

It also shows the last full sync, objects and bytes copied, objects that could not be copied, the last error and each bucket's state. The same fields come back from `GET /api/v1/storage/{name}/replicas`, on both the source and the target.

> [!WARNING]
> Replication is not a backup. A delete or an overwrite on the source reaches the target on the next pass. Turn on versioning for the target's buckets if you want to recover from that.

The target is passive: nothing writes to it except replication, and Skiff does not fail over to it. If the source's node is lost, attach your apps to the target instead. Removing the rule stops copying and keeps the target and its objects.

## Move to another node

```sh
skif storage move media --node <node-id>
```

Skiff does not copy objects when it moves an instance. The instance starts empty on the target node with the same buckets, keys and attachments, and the old copy and its objects are deleted once it is up. Copy what you need first, for example with `aws s3 sync` and the root key. `move` asks you to type the instance's name, or takes `--yes` off a terminal. The instance keeps its tier on the target node; `--disk` picks another target there. Attached apps on the old node move with a private instance. In the dashboard, use **Move** on the **Settings** tab.

## Restart

```sh
skif storage restart media          # one instance
skif storage restart --all          # every storage instance
```

A restart briefly fails S3 requests. Buckets, objects and keys are kept.

## Delete, restore and purge

Deleting an instance moves it to the trash. Its container stops, its public route is removed and its data stays on the node. You can restore it within 7 days by default, and a platform admin can set the window between 1 and 90 days.

```sh
skif storage delete media          # asks first; use --yes off a terminal
skif storage restore media
skif storage purge media           # permanent; asks you to type the name
```

An instance that still has attached projects cannot be deleted. Detach them first. Restoring does not reattach anything, so run `skif storage attach` again for each project. Purging deletes the data on the node. Once it is requested, the instance cannot be restored.

## Command reference

| Command | Purpose | Key flags |
| --- | --- | --- |
| `skif storage [list]` | List instances. | `--all` includes the trash |
| `create <name>` | Create an instance. | `-b`, `-p`, `--prefix`, `--public`, `--placement`, `--memory`, `--cpus`, `--storage`, `--disk`, `--version` |
| `info <name>` | Status, endpoints, buckets and attachments. | |
| `update <name>` | Change limits, version or public access. | `--memory`, `--cpus`, `--storage`, `--version`, `--public` or `--no-public` |
| `restart <name>` or `--all` | Restart the RustFS container. | `--all` |
| `delete <name>` | Move the instance to the trash. | `--yes` |
| `restore <name>` | Bring it back from the trash. | |
| `purge <name>` | Delete a trashed instance and its data. | `--yes` |
| `credentials <name>` | Print the root key as env lines. | `--prefix` (default `AWS`), `--json` |
| `rotate-root <name>` | Replace the root key; RustFS restarts. | `--cancel`, `--yes` |
| `keys list\|create\|reveal\|revoke` | Manage named access keys. | `-b <bucket>[:read\|:read-write]`, `--purpose`, `--expires`, `--prefix`, `--yes` |
| `move <name>` | Move the instance to another node, empty. | `--node`, `--disk`, `--yes` |
| `metrics <name>` | Usage samples. | `--since`, `--from`, `--to`, `--interval 1m\|1h` |
| `logs <name>` | Container output. | `-f`, `--level`, `--q`, `--limit`, `--after` |
| `attach <name>` | Give a project a scoped key. | `-p`, `-b <bucket>[:read\|:read-write]` (repeatable), `--prefix` (default `S3`) |
| `grants <name>` | Replace an attachment's bucket grants. | `-p`, `-b` (repeatable) |
| `detach <name>` | Revoke an attachment's key. | `-p` |
| `buckets list\|create\|config\|update\|delete` | Manage buckets. | `--access`, `--versioning`, `--quota`, `--lifecycle`, `--cors`, `--object-lock`, `--force` |
| `objects ls\|get\|put\|rm\|mkdir\|presign\|share` | Browse and manage bucket contents. | `-b`, `-k`, `-f`, `-o`, `--prefix`, `--expires`, `--downloads` |

Most commands accept `--json` for scripting. Commands that delete data ask for confirmation, and off a terminal they need `--yes`. Run `skif storage <command> --help` for the full list of options.

The commands call the same endpoints as the [REST API](/clients/rest-api). Who may run each one depends on the `storage` permissions your role grants; see [organisations and roles](/accounts/organizations-and-roles).
