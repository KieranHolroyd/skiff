---
title: Volumes
description: Persistent directories for apps that survive redeploys, with a size quota, a mount path, one read-write owner and snapshots.
---

A volume is a directory that belongs to a project and keeps its files when the app is redeployed or restarted. Use one when an app needs to write data that has to outlive a deploy, such as an SQLite file, uploaded files or a cache worth keeping. Volumes can be mounted into **process** and **container** projects only. A static site has nothing to mount into.

> [!NOTE]
> Volumes are behind the `APP_VOLUMES` feature flag, which is on by default. An operator can turn it off with `YOAL_FEATURE_APP_VOLUMES=0`. If the Volumes card is missing or disabled on your project, ask your platform operator whether it was turned off.

For managed databases and object storage, use [databases](/data/databases) and [object storage](/data/object-storage) instead. They are separate services with their own backups.

## How volumes work

Each volume has:

- **A name**, unique within its project. Names are 3 to 40 characters: lowercase letters, digits and single hyphens, starting and ending with a letter or digit.
- **A size quota** in megabytes. The quota is reserved on the node's disk when you create or grow the volume. See [size and capacity](#size-and-capacity).
- **A disk**, which is where the directory lives on the node: the node's system disk, or a [disk](/self-hosting/nodes-and-fleet#disks) an operator has added. You pick it when you create the volume.
- **Mounts**: one or more attachments, each giving a path inside the app.
- **A single-writer flag**, on by default. A single-writer volume can have one read-write attachment at a time. Read-only attachments are unlimited.

The app only sees the mount path. Host paths and device names are never shown in the dashboard, the CLI or the API.

## Create a volume

```sh
yoal volume create app-data --project api --size 2G
```

`--disk` picks where it is stored: `system` for the node's system disk, `fast` or `bulk` for a disk of that tier, or a disk by name. Without it, the volume uses the **App volumes** default from **Settings → Storage**, which is the system disk unless an operator set another. The dashboard's **Storage** field offers the same choice.

Create a volume after the project has been deployed at least once if you want it on the same node as the app. See [node placement](#node-placement).

### Size and capacity

`--size` takes a whole number of megabytes, or a number with an `M` or `G` unit: `512M`, `2G`. The default is 1 GB (1024 MB). The largest volume is 1 TB (1,048,576 MB).

When you create or grow a volume, Yoal checks that the total reserved quota on that disk stays within 90% of the free space the node last reported. If it would not, the request is refused and the error names the free space and the limit. A node that has not reported its free disk yet also refuses the request. It reports about every 10 seconds, so retry shortly.

> [!NOTE]
> The quota is a reservation for capacity planning. Yoal does not currently stop an app writing past its quota.

### Usage

The volume's node measures how much space each volume uses every 5 minutes. The dashboard, `yoal volume list` and `yoal volume show` show used space against the quota, and a volume at 90% or more of its quota is flagged as nearly full. A new volume shows no usage until the first measurement.

Usage also raises a platform alert when a volume passes the storage usage threshold (85% by default, critical at 95%), and it is exported as the `yoal_project_volume_used_bytes` metric. See [alerts](/observe/alerts) and [metrics](/observe/metrics).

## Attach to an app

Attach a volume at a mount path inside the app:

```sh
yoal volume attach app-data --project api --mount /var/lib/app
```

The app restarts to pick up the mount. The mount path must be absolute and normalised, with no trailing slash, `//`, `.` or `..`. It also cannot be one of the reserved paths `/`, `/data`, `/home`, `/media`, `/mnt`, `/srv`, `/var`, or `/var/lib`, and it cannot sit inside a system or platform tree such as `/bin`, `/etc`, `/usr`, `/tmp`, `/opt/yoal` or `/var/lib/yoal`. Mount inside a reserved path instead, for example `/var/lib/app`.

Add `--read-only` to mount the volume read-only. A read-write attachment to a single-writer volume that already has one is refused. Detach the existing attachment first, or attach the new one read-only.

By default an attachment goes to the project's workload. `--workload` also accepts the workload id, and the project slug is accepted as an alias for it. Attaching fails until the project has a workload, so deploy first.

## Node placement

A volume lives on one node, and its project is tied to that node while the volume is attached.

- A volume is created on the node the project's workload runs on. If the project has no workload yet, it is created on the edge node. If no edge node is registered, creation fails.
- With `fast` or `bulk`, that node needs a ready disk of that tier with room for the quota. If it has none, creation is refused; Yoal never uses the other tier instead.
- A volume on a named disk lives on that disk's node. Naming a disk on another node than the one the project's workload runs on is refused.
- Attaching a volume to a workload on a different node is refused.
- Apps with volumes cannot be moved to another node yet.
- A volume on a disk is checked each time the app starts. If the disk is not mounted, the app does not start, and Yoal never falls back to the system disk.

## Resize a volume

Volumes can only grow. Use the REST API to change the size, because the CLI and the dashboard do not offer resize:

```sh
curl -X PATCH https://control.example.com/api/v1/projects/api/volumes/app-data \
  -H "Authorization: Bearer yoal_…" \
  -H "Content-Type: application/json" \
  -d '{"sizeMb": 4096}'
```

A smaller size is refused. To shrink, create a new volume, copy the data across, and delete the old one. A growth request goes through the same capacity check as creation.

## Detach a volume

```sh
yoal volume detach app-data --project api
```

The app restarts without the mount. The volume and its data are untouched. If a project has more than one attachment, pass `--env` (default `production`) to choose which one to remove. Use `--workload` to name the workload explicitly.

## Delete a volume

A volume must be detached before you can delete it:

```sh
yoal volume delete app-data --project api --yes
```

Deletion is a soft delete. The volume can no longer be mounted, and its data is kept for the platform's trash period, which is 7 days by default. The CLI prints the purge date. While a volume is in the trash, its name cannot be reused, and its snapshots can still be listed and restored. Without `--yes`, the CLI asks for confirmation in a terminal. Without a terminal, it refuses and changes nothing.

When the trash period ends, the volume's node deletes the directory and the volume is gone for good. Its snapshots are deleted from their backup target at the same time.

A volume that is still being restored cannot be deleted. Wait for the restore to finish or fail.

## Snapshots

A snapshot is a compressed archive (`.tar.gz`) of a volume, written to a backup target. Take one before a risky migration or upgrade:

```sh
yoal volume snapshot app-data --project api --label "before v2 migration"
```

The volume's node picks the snapshot up within a few seconds. By default it pauses the app that has the volume mounted read-write while it copies, so the copy is consistent:

- On filesystems with copy-on-write clones (btrfs, XFS with reflink, OpenZFS 2.2 or later), the pause lasts only as long as the clone, usually under a second. The archive is then made from the clone while the app runs.
- On other filesystems, such as ext4, the app stays paused while the archive is written and uploaded. A pause that would last longer than 15 minutes is aborted and the snapshot fails.
- If no app has the volume mounted read-write, nothing is paused.

The app is paused, not restarted: its processes freeze and continue where they left off, and open connections stay open. Add `--no-quiesce` to copy without pausing. The copy may then be inconsistent if the app writes while it runs, so use it only for data that tolerates that.

Each snapshot records how it was made, shown as its method: `reflink`, `paused`, `idle` (nothing was writing) or `live` (`--no-quiesce` with a running writer). It also records its size and a SHA-256 checksum.

One snapshot runs per volume at a time. A snapshot that no node finishes within 6 hours fails.

### Where snapshots are written

A snapshot goes to the same place as database backups: the organisation's backup target, then the platform's, then the platform object store. Use `--target <name>` to pick a named target instead. The snapshot remembers its target, so changing the default later does not move existing snapshots. See [backup targets](/data/backups-and-pitr#backup-targets).

Snapshots are kept until you delete them or the volume is purged. There is no automatic retention for volume snapshots yet. `--pin` marks a snapshot as pinned for your own bookkeeping.

### List and delete snapshots

```sh
yoal volume snapshots app-data --project api
yoal volume snapshot-delete app-data avs_… --project api --yes
```

The list shows each snapshot's id, status, size, method, target, label, when it was created and when a restore last verified it. Deleting a snapshot removes its archive from the backup target first. A snapshot that is still running, or that a volume is being restored from, cannot be deleted. A write-only backup target cannot delete objects, so deleting a snapshot stored there is refused.

## Restore a snapshot

A restore always creates a **new** volume in the same project. It never overwrites the volume the snapshot was taken from:

```sh
yoal volume restore app-data avs_… --project api --to app-data-restored
```

The new volume is on the same disk and has the same single-writer setting as the source, and at least the same quota. Use `--size` to make it larger. Creating it goes through the same quota and capacity checks as `yoal volume create`, and the snapshot's backup target must still exist.

The node downloads the archive and extracts it into the new, empty volume, checking the SHA-256 checksum as it goes. Until that finishes, the volume shows as `restoring` and cannot be attached or deleted. Follow it with `yoal volume show app-data-restored --project api`. When it is ready, mount it in place of the old volume:

```sh
yoal volume detach app-data --project api
yoal volume attach app-data-restored --project api --mount /var/lib/app
```

If the restore fails, for example because the checksum does not match, the new volume is left empty and marked `failed` with the reason. It cannot be attached: delete it and restore again. A restore that no node finishes within 6 hours fails the same way.

> [!NOTE]
> Snapshots and restores need an agent version with app-volume support on the volume's node. On an older node, the request is refused and asks you to update the node first.

## List volumes

```sh
yoal volume list --project api
yoal volume list --project api --json
yoal volume show app-data --project api
```

The table shows each volume's status, backing (`system` or `disk:<name>`), quota, usage, the mount paths it is attached at, and when it was created. A nearly full volume gets a warning under the table. `show` adds the writer, when usage was last measured, a restore in progress and the latest snapshots. `--json` prints the raw API response.

## CLI reference

```sh
yoal volume <command> [options]
```

| Command | Purpose |
| --- | --- |
| `list` (alias `ls`) | List a project's volumes. This is the default when no command is given. |
| `show <name>` (alias `get`) | Show one volume's usage, attachments and latest snapshots. |
| `create <name>` | Create a volume with a size quota. |
| `attach <name>` | Mount a volume into the project's workload. |
| `detach <name>` | Unmount a volume. The data is kept. |
| `delete <name>` (alias `rm`) | Soft-delete a volume. |
| `snapshot <name>` | Snapshot a volume to a backup target. |
| `snapshots <name>` | List a volume's snapshots. |
| `restore <name> <snapshot-id>` | Restore a snapshot into a new volume named by `--to`. |
| `snapshot-delete <name> <snapshot-id>` | Delete a snapshot and its archive. |

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `-p`, `--project <slug>` | all | Project that owns the volume. Required. |
| `--size <size>` | create | Quota, such as `512M` or `2G`. Default 1 GB. |
| `--disk <where>` | create | `system`, `fast`, `bulk` or a disk name. Defaults to the **App volumes** default in **Settings → Storage**. |
| `--[no-]single-writer` | create | Refuse a second read-write attachment. On by default. |
| `-m`, `--mount <path>` | attach | Absolute path inside the app, such as `/var/lib/app`. Required. |
| `--workload <id\|slug>` | attach, detach | Workload id or project slug. Defaults to the project's workload. |
| `--env <name>` | attach, detach | Environment label for the attachment. Default `production`. |
| `--read-only` | attach | Mount read-only. |
| `--label <text>` | snapshot | A note to recognise the snapshot by. Up to 120 characters. |
| `--target <name>` | snapshot | Backup target to write to. Defaults to the organisation's, then the platform's. |
| `--pin` | snapshot | Mark the snapshot pinned. |
| `--no-quiesce` | snapshot | Copy without pausing the app. The copy may be inconsistent. |
| `--to <name>` | restore | Name of the new volume. Required. |
| `--size <size>` | restore | Quota of the new volume. Defaults to, and cannot be below, the source's quota. |
| `-y`, `--yes` | delete, snapshot-delete | Skip the confirmation prompt. Required without a terminal. |
| `--json` | all | Print the raw API response. |
| `-h`, `--help` | all | Show help. |

## REST API

Every route is under `/api/v1/projects/{slug}` and takes `Authorization: Bearer yoal_…`. Responses are JSON.

| Method and path | Purpose | Body | Response |
| --- | --- | --- | --- |
| `GET /volumes` | List volumes | | `{ "volumes": [...] }` |
| `POST /volumes` | Create a volume | `name`, `sizeMb`, `storage`, `singleWriter` | The new volume, `201` |
| `GET /volumes/{name}` | Get one volume | | `{ "volume": {...} }` |
| `PATCH /volumes/{name}` | Rename, grow or change single-writer | `name`, `sizeMb`, `singleWriter` | `{ "volume": {...} }` |
| `DELETE /volumes/{name}` | Soft-delete | | `{ "ok": true, "purgeAt": "…" }` |
| `POST /volumes/{name}/attach` | Attach | `workload`, `environment`, `mountPath`, `readOnly` | The volume, `201` |
| `DELETE /volumes/{name}/attach` | Detach | `workload`, `environment` | `{ "volume": {...} }` |
| `GET /volumes/{name}/snapshots` | List snapshots, newest first | | `{ "snapshots": [...] }` |
| `POST /volumes/{name}/snapshots` | Queue a snapshot | `label`, `pinned`, `quiesce` (default `true`), `target` | `{ "snapshot": {...} }`, `202`, plus `warning` when `quiesce` is `false` |
| `GET /volumes/{name}/snapshots/{id}` | Get one snapshot | | `{ "snapshot": {...} }` |
| `DELETE /volumes/{name}/snapshots/{id}` | Delete a snapshot and its archive | | `{ "ok": true }` |
| `POST /volumes/{name}/snapshots/{id}/restore` | Restore into a new volume | `name`, `sizeMb` | `{ "volume": {...} }`, `202` |

The create body uses `sizeMb` in megabytes, not the CLI's `--size` string, and `storage` for the CLI's `--disk`. Here is an example that creates and mounts a volume:

```sh
curl -X POST https://control.example.com/api/v1/projects/api/volumes \
  -H "Authorization: Bearer yoal_…" \
  -H "Content-Type: application/json" \
  -d '{"name": "app-data", "sizeMb": 2048}'

curl -X POST https://control.example.com/api/v1/projects/api/volumes/app-data/attach \
  -H "Authorization: Bearer yoal_…" \
  -H "Content-Type: application/json" \
  -d '{"mountPath": "/var/lib/app"}'
```

The `workload` and `environment` fields in the attach body default to the project's workload and `production`. A volume view includes `disk` (`{ id, name, tier, remote }`, or `null` for the system disk), `usedBytes`, `usedAt`, `nearQuota`, `restoringFrom` (the snapshot id while a restore runs) and its latest snapshots. See [the REST API](/clients/rest-api) for authentication and error formats.

Over MCP, `list_volume_snapshots`, `snapshot_volume` and `restore_volume` do the same. Deleting a snapshot is not available over MCP. See [MCP](/clients/mcp).

## Dashboard

Open **Projects → my-site → Data**, then find the **Volumes** card.

- **New volume** creates a volume with a name, size, single-writer setting and storage.
- **Mount in my-site…** attaches an unattached volume at a path you choose. It defaults to `/var/lib/app`.
- **Unmount from production** detaches a mount. The data is kept.
- **Snapshot now…** takes a snapshot, with an optional label. Tick **Copy without pausing the app** to skip the pause.
- Each volume lists its latest five snapshots with their status, size, method and target. **Restore…** restores one into a new volume, and the bin icon deletes it.
- **Delete volume** deletes an unattached volume.

A volume being restored shows as **Restoring** and cannot be mounted until it is ready. A nearly full volume is flagged under its usage bar.

You need permission to update the project to see these actions. The dashboard does not offer resize.

## Related

- [Apps and containers](/compute/apps-and-containers) explains the runtimes a volume can attach to.
- [The CLI](/clients/cli) covers authentication and global flags.
- [Disks](/self-hosting/nodes-and-fleet#disks) explains how operators add disks and set the default for app volumes.
