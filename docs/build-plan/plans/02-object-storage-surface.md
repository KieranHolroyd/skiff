# 02 — Object-storage product surface

**Priority:** P0 · **Effort:** S–M · **Lane:** B · **Wave:** 1
**Depends on:** F1 contracts, F3 e2e (soft: 04 for private gateway)
**Blocks:** 15 image transforms, 17 portability, 20 agent tools
**Primary files:** `packages/contracts/src/object-storage.ts`, `packages/core/src/storage-instances.ts`,
`apps/agent/src/storage-admin.ts`, `apps/control-plane/src/routes/api/v1/storage/**`,
`docs/OBJECT-STORAGE.md`

> **Status update (5 Nov 2026):** the object browser (list/upload/download/delete/presign, private
> gateway) is shipped. Remaining: bucket versioning, lifecycle, CORS, quotas, object lock, signed
> share links, write-only backup keys. Verify before implementing.

## Goal

Turn a bucket from "credentials plus a public URL" into a usable product: browse and manage objects,
configure versioning/lifecycle/CORS/quota/object lock, create share links, and expose it all through
REST, MCP, CLI, and the dashboard.

## Non-goals

- A full S3 gateway or a replacement for `aws s3`/`rclone`.
- A CDN. Public reads still traverse the edge; document the bandwidth warning.
- Building a custom object-storage engine; RustFS stays the engine.
- Image transforms (15) and custom bucket domains (P2).

## Current state

- `packages/contracts/src/object-storage.ts` models instances, buckets (`private`/`public-read`),
  grants, attachments, metrics, and credentials. `bucketUpdateSchema` only changes `access`.
- `packages/core/src/storage-instances.ts` handles create/attach/restore/delete and bucket rows.
- `apps/agent/src/storage-admin.ts` already has `StorageApi` with `listObjects`, `deleteObjects`,
  `listUploads`, `abortUpload`, bucket policy, IAM users, and `dataUsage`. It is used for stats and
  force delete, not for a browser.
- `apps/control-plane/src/routes/(dashboard)/storage/[name]/+page.svelte` shows metadata only.
- The control plane cannot reach node loopback (D57). Object listing/deletion must execute on the
  node; presigned URLs can be signed by the control plane but a private instance has no browser
  reachable endpoint.
- RustFS 1.0 supports bucket policy, versioning, lifecycle, quota, CORS, and object lock. Some
  features require versioning; object lock cannot be undone the same way. Pin the RustFS digest and
  keep Garage as a fallback.

## Design

### Phase A — Bucket configuration (MVP)

Extend the desired-state bucket shape instead of adding imperative calls:

```ts
// packages/contracts/src/object-storage.ts
bucketConfig: {
  access: 'private' | 'public-read';
  versioning: boolean;
  lifecycle: Array<{ id; prefix?; expireDays?; noncurrentExpireDays?; abortIncompleteDays?; enabled }>;
  cors: Array<{ origin: string[]; method: string[]; header: string[]; expose?: string[]; maxAge?: number }>;
  quotaBytes: number | null;
  objectLock: null | { mode: 'governance' | 'compliance'; retainDays: number };
};
```

- Add to `storageBuckets` table: `versioning`, `lifecycleJson`, `corsJson`, `quotaBytes`,
  `objectLockJson`, `configVersion`, `lastConvergedAt`.
- `BucketUpdate` accepts these fields. The control plane validates and stores them; the agent
  converges via `StorageApi`:
  - `putBucketVersioning`, `putBucketLifecycleConfiguration`, `putBucketCors`,
    `putBucketQuota`, `putObjectLockConfiguration`.
  - Object lock is only allowed at bucket creation (RustFS requires versioning); enforce it in
    create, not update.
  - Quota is a hard byte cap; if RustFS reports "degraded to allow", surface a warning.
- Add `GET /storage/:name/buckets/:bucket/config` and `PATCH` (or reuse the bucket PATCH).
- Audit every policy/lifecycle/quota/lock change.

### Phase B — Object browser

Need a path from the browser to a private RustFS instance. Use a **task/result relay** plus a
**short-lived platform gateway**:

1. **List/head/delete** are agent tasks. Add `storageOps` to desired state:
   `{ id, storageId, op: 'list'|'head'|'delete'|'sign', bucket, prefix, keys?, ttl? }`.
   The agent executes on the next reconcile (≤10 s) and reports `storageOpResults` in the heartbeat
   with a page of objects or a presigned URL. The dashboard shows a loading state and polls the
   task row. Cache the last page in `storage_object_pages` (or return it in the run row).
2. **Download/upload** need a browser-reachable URL:
   - Public instance: presign against `<name>--s3.<contentDomain>`.
   - Private instance: add a platform gateway route on the **platform origin**,
     `/_skiff/storage/<instance>/<bucket>/<key>`, served by the edge Caddy. The URL carries a
     short-lived HMAC token (`exp`, `method`, `key`, `user`) minted by the control plane. Caddy
     `forward_auth`s the token to the control plane, then proxies to the instance's loopback (edge)
     or over WireGuard (worker). This route is not a public S3 endpoint; it is an authenticated
     file gateway. Limit body size for the browser path and stream; large files use presigned
     direct URLs where possible.
   - If the gateway is too much for the first slice, ship browser **listing + delete + preview of
     small objects** through the agent relay, and defer downloads to `rclone`/presigned public URLs.
     Mark private download as a known gap; do not fake it.
3. **Browser UI:** prefix breadcrumb, search, sort, pagination, upload (drag/drop, multipart for
   large), download, rename/copy, delete, image/PDF/text preview, object metadata, storage class,
   size, last modified. Bulk select and delete with typed confirmation.
4. **Share links:** per-object presigned GET/PUT with expiry (max 7 days for SigV4), optional
   password (gateway-signed), download count, revocation. For private objects, use the gateway;
   for public, use the S3 endpoint. Record the link in `storage_share_links` with a hash, never the
   secret.
5. **Human keys:** `storage_keys` (name, accessKeyId, secret sealed, grants, lastUsedAt, expiresAt,
   createdBy). Reuse the attachment IAM reconciliation; never return the secret after creation
   except an explicit, audited reveal.
6. **Backup credentials:** allow a key with `PutObject` only (no delete) for backup targets; default
   for backup use. This is a small policy variant, not a new engine.

### Phase C — Safety and observability

- Public bucket warning: `noindex`, all traffic through the edge, optional rate limit.
- Quota alerts at 85%, object count alerts, lifecycle misconfiguration warning.
- Audit: bucket config, key create/reveal/revoke, share link, force delete, restore.
- S3 access logs already flow into the traffic pipeline; add per-bucket request/bytes panels if
  RustFS exposes metrics; otherwise use public-route traffic only and label it.

## Implementation order

1. Contract + table columns + validation (contract PR).
2. Agent `StorageApi` methods and desired-state convergence for versioning/lifecycle/CORS/quota/lock.
3. REST/MCP/CLI for config; dashboard bucket settings.
4. Agent task relay for list/head/delete; dashboard browser MVP.
5. Public presigned share links.
6. Private gateway route + download/upload.
7. Human keys and write-only backup keys.
8. Alerts, audit, docs.

## Acceptance criteria

- [ ] A user can create a bucket with versioning + lifecycle + CORS + quota and see the config
      converge on the node; re-applying is idempotent.
- [ ] The browser lists objects by prefix, uploads a 100 MB file (multipart), downloads it, and
      deletes it; a private instance works through the gateway.
- [ ] A share link expires, can be revoked, and records views; it never exposes the root key.
- [ ] A write-only backup key cannot delete an object.
- [ ] Object lock prevents deletion for the retention period on a versioned bucket.
- [ ] Quota enforcement is visible; a full bucket fails writes with a clear error.
- [ ] No object bytes are buffered in the control plane for large files.
- [ ] RustFS digest is pinned; an S3 conformance test covers versioning/lifecycle/CORS/quota/lock.

## Tests

- Unit: bucket config schema, lifecycle validation, quota math, share-link signing/verification.
- Agent: fake `StorageApi`; config convergence; list/delete pagination; force delete.
- Integration: MinIO or RustFS container; SigV4 through Caddy; multipart; range; CORS preflight;
  presigned GET/PUT; private gateway auth.
- Security: root key never logged; share token cannot be replayed for another key/method; path
  traversal rejected.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| RustFS feature gaps/CVEs | Pin digest, S3 conformance suite, Garage fallback, security review |
| Browser path is slow/async | Optimistic UI, 10 s polling, cache pages; direct presign where possible |
| Private gateway bypass | HMAC token bound to user/method/key/expiry; `forward_auth`; rate limit |
| Quota enforcement lags | Treat as a guardrail, alert at 85%, reject at create when over budget |
| Object lock is irreversible | Only at bucket create; typed confirmation; document the retention period |
| Large listings | Prefix pagination, max page size, no recursive scan |

## Rollout

`SKIFF_FEATURE_OBJECT_BROWSER` off by default. Bucket config can ship first. Enable browser for
dev, then staging, then default after the conformance suite passes. Keep the RustFS console off.

## Open questions

- Do we need a private gateway in v1, or is "browse via relay + download via public URL" enough?
- Should versioning be on by default for new buckets? Cost vs safety; recommend on for backup
  buckets, off for media buckets.
- Which lifecycle rules does RustFS 1.0 actually enforce? Verify in the spike before exposing.

## File ownership

Own: `packages/contracts/src/object-storage.ts` (append-only), `packages/core/src/storage-instances.ts`
(bucket methods), `apps/agent/src/storage-admin.ts`, `apps/control-plane/src/routes/api/v1/storage/**`,
`apps/control-plane/src/routes/(dashboard)/storage/**`, `docs/OBJECT-STORAGE.md`.

Integration-owned: schema, migration, core context/index, agent main hook, Caddy route renderer,
MCP registry, CLI main, dashboard layout, e2e harness.
