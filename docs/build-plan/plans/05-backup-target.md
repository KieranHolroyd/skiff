# 05 — Self-hosted backup target

**Priority:** P0 · **Effort:** S–M · **Lane:** A · **Wave:** 1
**Depends on:** F1 contracts, F2 streaming `ObjectStore`
**Blocks:** 01 backups, 06 upgrade safety, 17 portability
**Primary files:** `packages/core/src/object-store.ts`, `packages/contracts/src/backup.ts`,
`packages/core/src/backup-targets.ts`, `scripts/install/main.ts`, `docs/BACKUPS.md`

## Goal

Remove the hard dependency on Cloudflare R2 for platform and managed-data backups. Support any
S3-compatible endpoint (RustFS, MinIO, Garage, Backblaze, Wasabi) and a local filesystem target, so
a fully offline install is possible.

## Non-goals

- A general storage marketplace or per-tenant arbitrary endpoints.
- Cross-region replication or tiering.
- Replacing the platform's canonical artifact store; backups are a separate target.
- Storing canonical platform artifacts on a workload whose own deploys need those artifacts
  (replication target only).

## Current state

- `ObjectStore` (`packages/core/src/object-store.ts`) has `local` and `r2` implementations; `put`
  takes `Uint8Array`, `get` returns `Uint8Array`, and `list` is optional.
- `R2ObjectStore` already accepts a custom `endpoint`, but the name, config, and `kind` are R2-specific.
- The installer and docs assume R2 credentials (`docs/OPS.md`, `docs/ROADMAP.md`).
- `backup_runs` is platform-level; managed-data backups need their own target (01).

## Design

### `ObjectStore` v2

Add streaming without breaking existing callers:

```ts
interface ObjectStore {
  readonly kind: 'local' | 's3';
  put(key, data, contentType?): Promise<void>;
  putStream(key, body: ReadableStream<Uint8Array>, contentType?, size?): Promise<void>;
  get(key): Promise<Uint8Array>;
  getStream(key): Promise<{ body: ReadableStream<Uint8Array>; size: number | null }>;
  delete(key): Promise<void>;
  exists(key): Promise<boolean>;
  size(key): Promise<number | null>;
  presignPut(key, ttl, contentType?): Promise<string>;
  presignGet(key, ttl): Promise<string>;
  list(prefix): AsyncIterable<StoredObject>;
}
```

- `S3ObjectStore` (rename `R2ObjectStore`, keep an alias) supports `endpoint`, `bucket`, `region`,
  `forcePathStyle`, `accessKeyId`, `secretAccessKey`, and optional `sessionToken`.
- `LocalObjectStore.putStream/getStream` uses `Bun.file`/`createWriteStream`; no full buffer.
- `ObjectStore.put` can call `putStream` internally for large data; keep the old signature for
  releases/artifacts.
- Add `testConnection()`: head bucket, put/list/delete a probe object, report versioning/lock.

### Target model

`backup_targets` (shared with 01):

- `id`, `orgId` nullable (null = platform default), `name`, `kind` (`local`/`s3`), `endpoint`,
  `bucket`, `region`, `pathPrefix`, `forcePathStyle`, `accessKeySealed`, `secretSealed`,
  `writeOnly`, `objectLock`, `status`, `lastCheckedAt`, `lastError`, timestamps.
- Per-org target or platform default. Resolution: resource schedule target → org target → platform
  target → local default.
- `writeOnly` means the key has `PutObject`/`ListBucket` but no `DeleteObject`; retention GC uses a
  separate privileged target key or admin credentials. Never store the privileged key on the node
  if it is only needed by the control plane.
- `objectLock` is a bucket-level flag; if enabled, backups are immutable for the retention period.
  Warn that GC cannot delete before the lock expires.

### Config and installer

- `YOAL_BACKUP_TARGET=local|s3` and `YOAL_BACKUP_S3_*` env vars; secrets via the existing
  platform config pattern, not the repo.
- Installer prompts for local vs S3; local defaults to `/var/lib/yoal/backups` (same disk warning).
- `yoal backup target add|test|list|remove`; dashboard Settings → Backups.
- Platform target is used for SQLite Litestream and managed-data backups; an org can override for
  its own data.

### Security

- Seal access keys with the org key; never return the secret after create (one-time reveal only).
- Presigned URLs are short-lived and scoped to a key prefix.
- Local target files are `0600`, owner `yoal`; no world read.
- Path traversal guard: keys must not escape the prefix.
- Audit target create/update/delete/test and every restore/download.

## Implementation order

1. F2 interface + `S3ObjectStore` + local streaming + tests (this is the foundation slice).
2. `backup_targets` table + service + validation (contract PR).
3. `testConnection` + status; REST/CLI/dashboard.
4. Wire platform backup/Litestream and managed-data schedules to the target resolver.
5. Installer prompt and docs.
6. Write-only/object-lock variants + retention GC.

## Acceptance criteria

- [ ] A local target backs up and restores the platform DB and a managed Postgres DB without R2.
- [ ] An S3 target works against RustFS and MinIO with path-style URLs.
- [ ] `testConnection` reports bucket/versioning/lock status and a clear error on bad credentials.
- [ ] A write-only key can upload a backup but cannot delete it; retention uses the privileged path.
- [ ] Object lock prevents deletion for the retention period; the UI explains why GC is blocked.
- [ ] No secret is returned by list/get or logged; one-time reveal is audited.
- [ ] A 1 GB stream does not increase control-plane RSS by the file size.

## Tests

- Unit: key prefix, path traversal, target resolution, seal/unseal, write-only policy.
- Integration: RustFS/MinIO container, put/list/get/delete/presign, multipart, versioning/lock.
- Failure: wrong endpoint, wrong bucket, expired key, read-only bucket, full disk.
- Security: secret not in logs; presigned URL cannot escape prefix; local file mode.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Endpoint quirks | Conformance test against RustFS, MinIO, R2, local |
| Same-disk backup is not DR | Installer warns; dashboard shows "same disk" badge |
| Write-only GC cannot delete | Separate privileged key; retention runbook |
| Object lock traps data | Show expiry; require typed confirmation to enable |
| Streaming regressions | Keep old `put` tests; add 1 GB memory test |

## Rollout

Local target can be default for new installs. S3 target is opt-in until the conformance matrix
passes. Keep R2 working as one S3 endpoint; do not break existing configs.

## Open questions

- Should the platform default target be per-org or global? Start global with per-org override.
- Do we support Google Drive/Dropbox like Easypanel? No; S3-compatible + local covers the demand.
- Who holds the privileged delete key: control plane only, or a node-local escrow? Control plane
  only; agents get write-only credentials.

## File ownership

Own: `packages/core/src/object-store.ts`, `packages/core/src/backup-targets.ts` + test,
`packages/contracts/src/backup.ts` (target types), `scripts/install/main.ts` (prompt only),
`docs/BACKUPS.md`.

Integration-owned: schema/migration, core context/index, MCP/CLI registration, dashboard Settings,
installer wiring beyond the prompt, e2e harness.
