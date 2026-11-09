# The private cloud's second act: make the data layer the moat

**Research question:** Yoal has just shipped managed Postgres and S3-compatible object storage. What do comparable platforms treat as their flagship features, and which of those should Yoal build next to become dramatically more powerful?

**Answer in one line:** stop adding deploy surface and make the data layer trustworthy, composable, and agent-operable. Provisioning a database or a bucket is now commodity; proving that data is safe, connecting it to everything else, and letting an agent use it without leaking it is the moat.

> **Execution plans:** the 20 recommendations below are turned into individually assignable briefs,
> with a dependency graph, file ownership, and a parallel build order, in
> [`docs/build-plan/README.md`](../docs/build-plan/README.md).

---

## Executive summary

Managed databases and S3-compatible storage change what Yoal is. Before them, Yoal competed with static hosts and simple PaaS. After them, it is a small private cloud: compute, releases, database, object storage, domains, TLS, backups, metrics, and an MCP control plane in one install. That is a much stronger product, and it raises the bar for what "finished" means.

Six findings from the research changed the recommendation order:

1. **Preview data is the new dividing line.** Netlify is the only major platform that forks production data into every deploy preview through Netlify DB; Render and Railway previews get empty datastores; Supabase branches are data-less by default; Northflank can fork from a backup. Yoal owns both Postgres and RustFS, so a preview with an isolated database and bucket is cheaper for Yoal than for almost anyone.
2. **PITR is now table stakes at the top of the market.** Railway archives WAL to a bucket with pgBackRest, keeps roughly four weeks of restore points, and restores into a brand-new service without touching the source. Fly includes HA, PITR, and PgBouncer on its entry Managed Postgres plan. Render sells 3–7 day PITR. The self-hosted peers are still mostly at nightly `pg_dump`.
3. **The self-hosted weak point is restore, not backup.** Coolify restores have deleted the `postgres` database and its restore list depends on the control-plane database. Dokploy's restore can overwrite the wrong database and has no restore history. Easypanel's volume "backup" is an `rclone sync` mirror, so deletions propagate. CapRover's config backup excludes database contents and volumes. Backup checkboxes are common; a restore that has been tested is rare.
4. **Object storage is underbuilt nearly everywhere.** Railway buckets are private-only with no lifecycle, versioning, SSE, or object lock. Vercel Blob has no documented lifecycle or versioning. Appwrite's S3 gateway is deliberately partial. Cloudflare R2 has the semantics. A bucket with no browser, policy, quota, or signed links is half a feature.
5. **Agents can deploy, but almost none can safely restore.** Railway, Coolify, Dokploy, Supabase, Vercel, and Render all expose MCP or agent tools; destructive confirmation is usually a client-side hint, not a server-enforced control. No vendor advertises durable restore/fork tools. Yoal's OAuth model, scope ∩ role, and human confirmation are already ahead; the missing piece is safe data operations.
6. **RustFS is a risk to manage, not a detail.** RustFS shipped real authorization-bypass advisories in its 1.0 line, including a multipart `UploadPartCopy` cross-bucket exfiltration issue. Pinning digests, running an S3 conformance suite, and keeping Garage as a tested fallback are part of shipping storage, not polish.

**If Yoal only does five things next, do these:** backups with **verified** restore, an object-storage product surface, connection pooling plus TLS, persistent volumes with disk admission, and stack blueprints. They are the difference between "we have a database and a bucket" and "we can run real applications on this."

**If it only does one thing:** make restore provable. A scheduled restore drill with a visible report is the single strongest switching trigger from Coolify, Dokploy, and Easypanel, because their users have been burned by restores that failed silently.

> **The risk to avoid.** A managed database without backups, restore, pooling, and isolation is worse than no managed database, because users will put production data in it. The first release after 0.4 should be a data-safety release, not a feature-breadth release.

---

## Scope, method, and evidence

This report synthesizes six parallel research streams: commercial PaaS, self-hosted PaaS and panels, data platforms, agent/IaC/storage UX, a codebase gap audit, and real user pain points. Products reviewed: Vercel, Netlify, Cloudflare Pages/Workers, Render, Railway, Fly.io, Heroku, Northflank, Coolify, Dokploy, Easypanel, CapRover, Dokku, Kamal, Portainer, Zeabur, Supabase, Neon, Appwrite, MinIO, RustFS, Upstash, and Tigris. Sources are vendor documentation, pricing pages, changelogs, repositories, GitHub issues/discussions, Reddit/HN threads, and public incident reports, accessed 5 November 2026.

Effort is for one experienced engineer: **S** up to a week, **M** two to six weeks, **L** over six weeks. Priority is **P0** (next release; the data layer is unsafe or unusable without it), **P1** (next quarter; unlocks real applications or teams), **P2** (later or demand-gated), and **Skip** (explicitly will not build).

Three caveats bound the conclusions. Vendor pages are claims, not measurements: "one-click", "instant restore", "fork", and "full-stack preview" mean different things at different vendors. There are no Yoal user interviews or usage telemetry, so demand is inferred from competitor packaging, issue volume, and the product's stated ICP. The two new features are built but not yet exercised end-to-end on a real Debian/Podman node, so part of P0 is hardening, not new work. Negative claims are limited to the pages and issues reviewed; the data-platform market moves monthly.

---

## What the market actually ships

| Product | Flagship features in late 2026 | What it teaches | Copy / skip for Yoal |
|---|---|---|---|
| **Vercel** | Per-commit previews, instant rollback, Rolling Releases, Image Optimization, Blob (public/private stores, signed URLs), Marketplace storage, remote MCP, Cron | The category leader ships no first-party database; integration and preview UX are the product. Blob is deliberately thin. | Copy preview ergonomics, signed URLs, image transforms; skip global CDN/WAF and marketplace-as-a-business |
| **Netlify** | Deploy Previews with a **database branch forked from production data**; Netlify DB (Neon); deploy-bound migrations; Blobs; Agent Runners | Preview-with-data is no longer hypothetical; the branch and the deploy share a lifecycle. Netlify's own docs warn preview URLs may expose PII. | Copy preview data with schema/seed by default and an opt-in production fork; skip credit accounting |
| **Cloudflare** | R2 (zero egress, lifecycle, versioning, event notifications, object lock), D1, KV, Queues, Hyperdrive, Images, Workers, Durable Objects | Storage primitives become powerful when they compose; R2 owns S3 semantics. | Copy R2-style lifecycle/events/locks and image pipeline; skip anycast/WAF/Durable Objects |
| **Railway** | One-click Postgres/MySQL/Mongo/Redis, volumes, private networking, templates, PR environments; **pgBackRest PITR (~4 weeks) to a bucket, restore to new**; buckets | PITR via WAL → object storage is portable and can be bundled without a separate fee. Railway buckets are private-only and lack lifecycle/versioning/SSE/object lock. | Copy pgBackRest PITR, restore-to-new, env-scoped credentials; adapt bucket defaults; skip usage billing |
| **Render** | `render.yaml` Blueprints, full-stack previews, Postgres PITR (3–7 days), HA, read replicas, persistent disks, cron, workers, Workflows, MCP | Preview environments copy infrastructure, **not data**; disks force a single instance; HA is billed as a second instance. | Copy Blueprints, PITR window, restore-to-new, cron; defer HA/read replicas; copy the preview knobs (`previewPlan`, `expireAfterDays`) |
| **Fly.io** | Machines, volumes + snapshots, Managed Postgres (**HA + PITR + PgBouncer on every plan**), pgvector/PostGIS, Tigris S3, Upstash | "Everything included" at the entry tier is a strong packaging message; extensions and pooling are part of the database product. | Copy pooling, extensions, volumes, private networking; skip multi-region active-active |
| **Heroku** | Pipelines (dev → review → staging → production), Review Apps, Postgres fork/follow/rollback, add-ons | `fork` is a better primitive than "restore a backup"; review apps are a mature delivery model. | Copy fork + pipeline semantics; skip buildpacks/dyno economics |
| **Northflank** | Full-stack previews, database fork from backup, six DB engines (Postgres, MySQL, Mongo, Redis, MinIO, RabbitMQ), volumes, release flows, BYOC | Preview blueprints can include services, addons, jobs, volumes, secrets; a release flow can back up, build, migrate, and promote. | Copy preview data forks, release flows, volume backups; skip Kubernetes/BYOC |
| **Supabase** | Postgres + Auth + Storage + Realtime + Edge Functions, branching, Cron, Queues, pgvector, image transforms, read replicas | Branching is schema/config, not a data clone by default; PITR is WAL-G with ~2-minute RPO; **DB backups do not include Storage objects**. | Copy branching workflow, pg extensions, storage transforms; skip native auth/realtime (offer as a stack) |
| **Appwrite** | Auth, Databases, Storage, Functions, Messaging, Realtime, Sites, image transformations, Terraform | A unified permission model across data services is the product; its S3 gateway is intentionally partial and shows the compatibility trap. | Copy image transforms and unified permissions; do not build a partial S3 gateway |
| **Neon** | Copy-on-write branching, instant PITR, scale-to-zero, 30-day history window | Branching is the database developer experience; restore is fast and time-travel is inspectable. | Copy branch/clone and PITR semantics; skip scale-to-zero |
| **Coolify** | 360+ templates, 8 DB engines, scheduled DB + volume backups to S3, previews on four Git hosts, built-in MCP, proxy analytics | Breadth plus backups is the self-hosted default; restore is still the weak spot, and previews leak. | Copy backup/restore UX, MCP, PR previews; skip Docker dependency and template treadmill |
| **Dokploy** | Compose/Stack, 6 DB engines, scheduled DB + named-volume backups to S3, schedules, multi-server, MCP | Compose import is the long-tail strategy; restore history and secret hygiene are missing. | Copy restore UX, volume snapshots, schedules, compose import (subset); skip Swarm |
| **Easypanel** | 750+ templates, Postgres/MySQL/Mongo/Redis, backups to S3/Drive/Dropbox, real-time monitoring, MCP | Polish and template packaging drive adoption; **volume backup is a mirror, not a timestamped snapshot**, and scheduled DB backups are paid. | Copy S3-compatible targets and polish; skip template count race and mirror-as-backup |
| **Zeabur** | One-click templates, databases, object storage, agent skills | Agents can operate infrastructure; the 2026 shutdown and breaches are a reminder that export/restore and secret hygiene matter. | Copy agent-skill packaging; skip marketplace |
| **MinIO / RustFS** | S3 API, bucket lifecycle, versioning, replication, quotas, CORS, object lock, console | A bucket is a managed resource with a lifecycle; users need policy and browser UX, not just credentials. MinIO's community repo is archived; RustFS has had auth-bypass advisories. | Copy lifecycle/versioning/quotas/CORS/object lock; build Yoal's own browser; pin and test RustFS |
| **Vercel Blob / Tigris / Upstash** | Private/public stores, signed URLs, presigned uploads, S3-compatible storage, Redis/Vector/Blob/QStash | Signed URLs and private-by-default are the expected security model; storage, cache, and queue are bundled. | Copy signed URLs and private defaults; add Valkey, not a queue product |

**Table stakes now:** one-click database, connection-string injection, scheduled backups, restore, a bucket, credentials, metrics, logs, a CLI, an API, and a preview URL. Yoal has most of these; it is missing the backup/restore half and the object-management half.

**Still differentiating:** verified restore, PITR, database branching/cloning for previews, pooling, per-preview data, volumes, private networking, blueprints, and agent-safe data tools.

---

## What users actually complain about

The positive feature lists hide the failure modes. These recurring issues are the strongest evidence for what to build, because they show where trust breaks.

| Theme | Evidence | What to build |
|---|---|---|
| **Restore fails or restores the wrong thing** | Coolify's Postgres restore deleted the `postgres` database ([#7987](https://github.com/coollabsio/coolify/issues/7987)); Dokploy's `pg_restore` parallel workers race and can overwrite the wrong database ([#4127](https://github.com/Dokploy/dokploy/issues/4127), [#3436](https://github.com/Dokploy/dokploy/issues/3436)) | Restore to a **new** resource by default; typed target; dry-run; verification query; never trust a dump's `USE`/database name |
| **Restore metadata depends on the control plane** | Coolify's restore screen reads its own database, so after a control-plane loss, newer backups already in S3 are invisible ([#11115](https://github.com/coollabsio/coolify/discussions/11115)) | **S3-first restore browser**: list and verify backups from the object store, independent of SQLite; cache metadata but never require it |
| **Silent backup failures** | Coolify's own database backups stopped for 49 days without a UI/log trace ([#10623](https://github.com/coollabsio/coolify/issues/10623)); Easypanel users report scheduled Postgres backups never run while manual works (vendor feedback) | Missed-run and stale-age alerts; last successful backup and **last verified restore** on the resource; failure drill-down |
| **PITR is expected but absent** | Coolify's pgBackRest request was closed "not planned" ([#7423](https://github.com/coollabsio/coolify/issues/7423)); WAL-G PRs are drafts ([#11035](https://github.com/coollabsio/coolify/pull/11035)); users ask for a timestamp picker | WAL archiving to the platform object store; 7/30-day restore window; restore-to-timestamp into a new instance |
| **Pooling is DIY and connection limits bite** | Coolify's 5-second `SELECT 1` healthcheck stampedes to `max_connections` under I/O stall, locking out services ([#9939](https://github.com/coollabsio/coolify/issues/9939)); PgBouncer requires a hand-written compose stack | Pooler by default, sane `max_connections`, separate direct/pooled URLs, pool metrics, connection alerts |
| **Major upgrades brick data** | Changing the Postgres image without a major-version migration bricks the volume; PG18's path change broke templates ([#8935](https://github.com/coollabsio/coolify/issues/8935)); Coolify does not migrate majors ([docs](https://coolify.io/docs/get-started/internal-postgresql-upgrade)) | Refuse unsafe image tags; pre-upgrade snapshot; dump/restore wizard; tested `pg_upgrade` path; rollback |
| **Preview environments leak** | Coolify previews survive merged/closed PRs ([#2485](https://github.com/coollabsio/coolify/issues/2485)); an audit found 35 preview hosts, 6 still serving, oldest 222 days after close ([#11663](https://github.com/coollabsio/coolify/discussions/11663)); no cap ([#9064](https://github.com/coollabsio/coolify/issues/9064)) | TTL, hard caps, reconciliation-based teardown, orphan sweeps, PR comment, per-preview quota |
| **Preview secrets and fork PRs** | Dokploy auto-deployed fork PRs and exposed preview env vars; RCE in public repos ([CVE-2025-53825](https://github.com/Dokploy/dokploy/security/advisories/GHSA-h67g-mpq5-6ph5)); Coolify warns preview code is untrusted | Never expose production secrets to fork PRs; placeholder secrets; schema/seed data by default; explicit production-data fork |
| **Object retention and deletion** | Coolify S3 retention kept backups past the window ([#5455](https://github.com/coollabsio/coolify/issues/5455)); users ask for write-only credentials so a compromised panel cannot delete backups (Easypanel feedback); Easypanel volume backup is `rclone sync`, so deletions propagate ([docs](https://easypanel.io/docs/backups/volumes)) | Server-enforced retention; write-only backup credentials; versioning + object lock; deletion protection; restore from bucket |
| **Template staleness** | Coolify templates used `postgres:latest` and broke on PG18 ([#8935](https://github.com/coollabsio/coolify/issues/8935)); wrong images and stale releases occur ([#10446](https://github.com/coollabsio/coolify/issues/10446), [#12282](https://github.com/coollabsio/coolify/issues/12282)) | Pin digests in every stack; automated upgrade PRs with smoke tests; known-good badges; rollback |
| **Platform upgrades break the control plane** | Coolify updates corrupted `coolify-db`, broke Redis, and left no working rollback ([#7519](https://github.com/coollabsio/coolify/issues/7519), [#5288](https://github.com/coollabsio/coolify/issues/5288)); Dokploy users ask for an LTS channel ([#2476](https://github.com/Dokploy/dokploy/discussions/2476)) | Pre-update snapshot of the control DB and secrets; staged channel; one-command rollback; data-layer compatibility checks |
| **Agents can be dangerous** | Research finds most destructive MCP tools lack server-side confirmation; Coolify's `confirm=true` is client-enforced | Server-enforced approval, dry-run blast-radius preview, scoped short-lived tokens, immutable audit |

**The switching trigger is rarely a feature.** It is one bad restore or one bad update, after which "boring and recoverable" beats "more features". Yoal should market the boring part.

---

## Counterintuitive findings

1. **"Full-stack previews" are mostly empty.** Render and Railway provision blank datastores and volumes for a preview; only Netlify forks production data by default, and Northflank can fork from a backup. The market has copied the *shape* of preview environments without the *data*. That is Yoal's opening.
2. **The category leader has no database.** Vercel sunset Vercel Postgres and now sells Neon, Supabase, Prisma, and PlanetScale through its Marketplace. Integration and preview UX matter more than owning the engine. Yoal owning both is an advantage, but only if the integration is better than a marketplace link.
3. **HA is commoditizing at the bottom while PITR is still premium in the middle.** Fly bundles HA, PITR, and pooling at its entry Managed Postgres tier; Render charges double for HA and caps PITR at 7 days. On one VPS, Yoal should not fake HA; it should sell **restore confidence** and a clear "not HA" label.
4. **Newer is not always better.** Heroku's 2026 Advanced Postgres tier lists server-side pooling as not yet available, while the older Classic tier has it. A regression in a flagship data product is a reminder to test the boring path.
5. **Self-hosted catalogues are wide but shallow where it counts.** Coolify has 360+ templates and Dokploy/Easypanel 500–800, yet their restore paths are the most complained-about area. Breadth wins the demo; restore wins the renewal.
6. **Object storage at most PaaS is a bucket, not a product.** Railway buckets are private-only with no lifecycle/versioning/SSE/object lock; Vercel Blob has no documented lifecycle; Appwrite's S3 gateway omits versioning, lifecycle, policies, object lock, and CORS configuration. R2 is the exception. Yoal can beat the PaaS default with a complete bucket surface.
7. **Agents can deploy, but almost none can restore.** The MCP market has converged on deploy/logs/metrics tools. Durable restore, fork, and PITR tools are missing even where the underlying API supports them. Yoal can own this with its existing OAuth and audit model.

---

## Where Yoal stands after databases and S3

| Area | Today | Gap that matters |
|---|---|---|
| **Deploy loop** | Immutable releases, preview URLs, promote/rollback, git builds, PR webhooks, named environments | PR comment/check/status, rollback to any retained release, preview protection by default |
| **Runtime** | Tier 2 systemd process apps, tier 3 Podman containers, admission, JIT secrets, one workload per project | Multiple processes per project, per-environment workloads, persistent volumes, cron |
| **Databases** | Postgres 16/17 as tier-3 containers, attachments, sealed credentials, metrics, table snapshots, soft delete/restore | Backups, PITR, restore verification, pooling, TLS, rotation, console, extensions, cross-node access |
| **Object storage** | RustFS instances, buckets, scoped keys, public endpoint, metrics, soft delete | Browser, versioning, lifecycle, CORS, quotas, object lock, signed share links, image transforms, backups |
| **Data safety** | Platform SQLite has Litestream, monthly drill, recovery kit | Managed data has no backup or restore story at all |
| **Composition** | Same-node Podman network; WireGuard edge ↔ worker; attachments inject at activation | Cross-node private DB/S3, service discovery, volumes, jobs, workers |
| **Packaging** | Project, environment, deployment, workload, database, storage, domain as separate API calls | One `yoal.yaml` plan/apply that creates a whole stack |
| **Previews** | Per-deployment static preview; named environments; one active workload per project | Per-PR app + database + bucket, with cloned or seeded data |
| **Agents** | MCP with OAuth 2.1, scope ∩ role, confirmation, audit; DB/S3 tools that never return credentials | One-call stack provisioning, read-only SQL, presigned URLs, restore/fork, data activity view |
| **Operations** | Metrics, alerts, audit, logs, restore drills, 250 MB baseline | Data-specific alerts (backup age, pool saturation, object quota), showback, backup target portability |

### Exact gaps in the current code

The audit found the following seams and constraints. These matter because they determine how much of each feature is new versus finishing existing work.

| Capability | Current state | Missing / partial | Seam |
|---|---|---|---|
| DB backups | None; `MaintenanceService.run()` has no DB job | No backup, schedule, retention, or restore-to-new; soft delete is not a backup | 60 s maintenance loop; helper fixed verb; `ObjectStore.put` (must stream, not buffer) |
| PITR | None | No WAL archiving, base backups, or replay; no drill | `archive_command`/`archive_mode` in the fixed helper unit; restore verb |
| Restore drills | Platform SQLite only (`scripts/yoal-restore-drill.sh`, `recordBackupRun`) | No managed-DB or bucket drill; Litestream has no client-side encryption | Extend `backup_runs`; reuse drill alerting; age/org-key encryption |
| Pooling | None | No PgBouncer, `DATABASE_POOL_URL`, or pool sizing | New managed `pooler` profile; note ~50–100 MB per DB against the 250 MB baseline; consider a node-level pooler |
| TLS | Loopback/Podman only; `connectionUrl()` has no `sslmode`; sampler uses `tls:false` | No cert issuance/rotation or encrypted transport | Helper-generated cert or Caddy `ask`; append `sslmode=require` |
| Rotation / named keys | Storage attachments only; rotation is a follow-up in both docs | No `ALTER ROLE`, key rollover, or consumer re-activation | `rotateCredentials()`; agent applies; bump attachment fingerprint |
| Audit | Create/attach/credentials/delete audited | No SQL/object data-plane audit; no auth-failure events | `pg_stat_statements`/pgaudit; S3 access logs already reach traffic |
| Volumes | `WorkloadSpec.data.sizeMb` validated, never enforced; helper mounts `/data` | No snapshots, multi-volume, or disk admission; `admit()` checks memory only; `storageMb` is alert-only | Extend spec with `volumes[]`; helper mounts; add node disk budget |
| Cron / jobs | None; only the Builder queue | No scheduled/one-off jobs, replicas, or workers | New `Job` resource; helper transient unit; systemd timer |
| Cross-node private network | Same-node only (D56); `nodes.public_address` only | No `private_address`, cross-node DB reachability, or discovery | Add WireGuard address; bind DB to it; extend placement conflict |
| Per-org networks | One global `yoal-workloads` network | Every tenant shares L2/DNS | Render `yoal-org-<id>.network`; pass org id in desired state |
| Object browser | Dashboard shows bucket metadata only; `StorageApi.listObjects` is agent-side | No list/read/upload/delete, prefix search, or presigned browse | Agent endpoint (control plane cannot reach loopback); presigned GETs |
| Bucket policy/versioning/lifecycle/CORS/quota/lock | Only private/public-read | None of the rest | Extend `storageBucketDesiredSchema`; RustFS admin/S3 calls in `storage-admin.ts` |
| Signed links | None platform-issued; apps can presign with their scoped key | No TTL policy, audit, or private-instance browser access | `POST /storage/:name/buckets/:bucket/sign` using root key, audited |
| Image transforms | None | No resize/format/thumbnail pipeline | Build-time variants; optional imgproxy container |
| Custom bucket domains | Fixed `<name>--s3.<contentDomain>` | No user domain, TXT verification, or cert mapping | Reuse `domains` with a `storage` target; preserve `Host` for SigV4 |
| Blueprints | Only `yoal.json` site config; Operations `plan → apply` is bulk delete/prune | No declarative project/service spec, diff, drift, or import/export | `yoal.yaml` parsed into existing service calls; Operation primitive |
| Preview data | Named environments exist, but one workload per project (D44) | No per-preview runtime, DB/bucket clone, or seed | Snapshot/restore-to-new + bucket copy; environment attachments |
| Quotas | `QuotaService` counts projects and release bytes only | No DB/storage quotas, byte/CPU showback, or chargeback | Extend `org_quotas`; enforce at create; report from `db_metrics_1m`/`storage_metrics_1m` |
| MCP data tools | DB list/get/create/attach/detach/delete; storage list/get/create/create_bucket/attach/detach/delete_storage | No restore, bucket update/delete, metrics, or key reveal (by design) | Add tools calling existing service methods; confirmation for destructive |
| E2E | Strong unit tests; no managed-data REST/MCP e2e; no Debian 13/Podman run | Quadlet, chown, network alias, SigV4 hop, health probe unverified on target | Add REST+MCP e2e; CI VM with Podman ≥5/netavark |

**Invariants every recommendation must preserve:** pull-based desired state, no imperative shell; immutable releases; one service layer for all surfaces; secrets never in desired state or its disk cache; edge baseline ≤250 MB RSS; no Kubernetes or Docker daemon; helper fixed verbs only; control plane never reaches node loopback; one wildcard level unless explicitly revised.

---

## Recommendations

### P0 — Trust the data (the next release)

These are not optional if users are going to put production data in Yoal. They are also the features that show up first in every self-hosted comparison.

#### 1. Backups, PITR, restore, and a visible restore drill

**Problem.** A managed database with no backup is a demo. Today the roadmap lists `pg_dump` and object-storage backups as follow-ups. Coolify, Dokploy, Easypanel, Render, Fly, Supabase, Railway, and Neon all ship some form of backup; the self-hosted peers also ship one-click restore.

**Evidence.** Railway archives WAL with pgBackRest to a bucket, keeps roughly four weeks of restore points, and restores into a brand-new service without touching the source. Fly includes HA, PITR, and PgBouncer on its entry Managed Postgres plan. Render offers 3–7 day PITR. Supabase uses WAL-G with a ~2-minute RPO and sells longer retention. Coolify, Dokploy, and Easypanel schedule dumps to S3 and restore from a bucket — badly, often, but the expectation is set.

**Fit.** Yoal already has `ObjectStore`, an org data key, the Litestream drill pattern, agent telemetry, and a helper that executes fixed verbs. This is a new fixed-verb family and a `BackupService`, not a new control plane.

**Minimal implementation.**
- Add `backup_schedules` and `backup_runs`: resource kind (`database`/`storage`/`volume`), resource id, schedule, retention, target, status, size, checksum, started/finished, error, `restore_verified_at`.
- Control-plane scheduler claims due runs, asks the agent to execute a fixed helper verb (`dumpDatabase`, `snapshotStorage`, `snapshotVolume`), and records the result. Never build a shell command from user input.
- **Phase 1 — logical backups.** `pg_dump -Fc` with a consistent snapshot, streamed to a presigned `ObjectStore` URL; client-side envelope encryption with the org/backup key; daily retention plus weekly/monthly; pinned backups never GC. Stream the dump — `ObjectStore.put` currently buffers, which will not survive a multi-GB database.
- **Phase 2 — PITR.** Use `pgBackRest` (or WAL-G) with `archive_command`/`archive_timeout` to a dedicated object-store bucket, weekly full + daily differential, 7/30-day windows. The helper starts/stops the backup sidecar; the control plane only schedules and records. Restore provisions a new instance and runs `restore --type=time --target=...` on first boot, exactly as Railway describes. Do not claim PITR until a restore to an arbitrary timestamp has passed in CI.
- **Restore semantics.** Restore into a new resource by default; generate new credentials; run a verification query (`pg_amcheck`, row counts, a canary table); show the diff in connection details; let the operator attach/promote. In-place restore requires a typed confirmation and a pre-restore snapshot.
- **S3-first restore browser.** List and verify backups directly from the object store, not from SQLite. This directly addresses Coolify's failure where a control-plane restore hides newer S3 backups. Cache metadata, but never require it.
- **Failure detection.** Alert on missed schedule, backup age beyond SLO, upload failure, checksum mismatch, and failed drill. Show "last backup" and "last verified restore" on the resource and in `get_data_health`.
- **Drills.** Monthly restore into a throwaway resource, timed and checked; persist the result; badge it. This is the differentiator: no self-hosted peer publishes a verified restore record.
- **Surfaces.** `yoal db backup|restore|backups`, `yoal storage backup|restore`, REST, dashboard "Backups" tab, MCP `list_backups` and `restore_backup` (human-confirmed; no credentials).

**Effort.** M for dumps and bucket sync; L for true PITR and in-place restore. **Risk.** Restore correctness, storage growth, encryption/key loss, cross-node transfer, and false confidence. The mitigation is the same discipline Yoal already applies to its own SQLite: a persisted drill, not a green backup job.

#### 2. Object storage as a real product: browser, versioning, lifecycle, CORS, quotas, object lock, signed links

**Problem.** Yoal's storage instance has buckets, scoped keys, a public endpoint, and metrics. It does not have a file browser, bucket versioning, lifecycle rules, CORS, per-bucket quotas, object lock, or human share links. The RustFS console is deliberately off; MinIO's community console was stripped before the project was archived.

**Evidence.** Cloudflare R2 documents lifecycle rules, versioning, event notifications, and object lock. MinIO documents bucket lifecycle, replication, quotas, CORS, and object lock. Vercel Blob ships private/public stores and signed URLs for one operation and one pathname. Supabase and Appwrite treat image transformations as baseline. Railway's buckets are private-only and omit lifecycle/versioning/SSE/object lock — a PaaS default Yoal can beat.

**Fit.** The control plane already speaks S3 to RustFS for bucket and IAM convergence. A browser and policy editor are a thin, audited surface over the same client. Presigned URLs avoid proxying bytes through the control plane. The existing traffic pipeline can count public reads.

**Minimal implementation.**
- **Browser:** paginated list by prefix, search, upload (presigned PUT, multipart for large files), download (presigned GET), rename/copy, bulk delete, image/PDF/text preview, drag-and-drop folder upload. Never stream large objects through SvelteKit; the control plane cannot reach node loopback, so list/delete go through an agent endpoint or the public endpoint with a short-lived key.
- **Bucket settings:** public-read toggle, versioning, lifecycle rules (expire current/noncurrent versions, abort incomplete multipart), CORS for browser uploads, per-bucket quota, object lock/WORM for backups. Model these as desired state so the agent converges them, not as imperative API calls that can drift.
- **Share links:** per-object presigned GET/PUT with expiry, optional password, download limits, view counts, revocation. This is the storage analogue of Yoal's existing share links.
- **Human access keys:** named keys with bucket grants and `last_used`, rotation, and revocation. Today only attachment keys exist.
- **Backup credentials:** write-only (`PutObject` only) keys for backup targets so a compromised panel cannot delete backups; object-lock/versioning presets for immutable backups.
- **Safety:** public buckets get `noindex`, a warning that all traffic traverses the edge (and WireGuard for worker-placed instances), and a note that this is not a CDN.
- **Audit:** record bucket policy changes, key creation/reveal, share-link creation, force deletes, and restores. Do not log every GET; aggregate access from the traffic pipeline.

**Effort.** S–M. **Risk.** Presigned URL leakage, CORS misconfiguration, quota enforcement races, and confusing "public bucket" semantics. Keep private by default and make public a deliberate, warned toggle.

#### 3. Connection pooling, TLS, and connection UX

**Problem.** Postgres has a hard connection limit. Agents, serverless-style handlers, and many small apps open short-lived connections and exhaust it. Fly includes PgBouncer on every Managed Postgres plan; Render exposes pooled connections; Supabase runs Supavisor. Yoal injects a direct URL only, binds to loopback/Podman, and does not document TLS.

**Evidence.** Fly's Managed Postgres page lists PgBouncer on every plan. Render documents PgBouncer and private networking. Supabase's pooler is core to its connection story. Coolify's healthcheck stampede issue shows how quickly a naive health probe exhausts `max_connections`.

**Fit.** A PgBouncer sidecar in the same `yoal-workloads` network is small in CPU, but the audit estimates 50–100 MB per database, which conflicts with the 250 MB baseline. Better: a **node-level pooler** with a pool per database, or an optional per-database pooler for larger instances. The same managed-service profile can carry TLS.

**Minimal implementation.**
- Run PgBouncer as a node-level service (or per-database sidecar for large plans), `pool_mode=transaction`, `max_client_conn` derived from plan, `default_pool_size` bounded. Expose only on the private network/loopback.
- Inject `<PREFIX>_URL` (direct) and `<PREFIX>_POOL_URL` (pooled), plus host/port/user/password/name. Document when to use each: transaction pooling breaks session-level features (advisory locks, `SET`, prepared statements, `LISTEN/NOTIFY`, cursors, temp tables); migrations and logical replication should use the direct URL.
- Add TLS: generate a per-database certificate, set `ssl=on`, inject `sslmode=require` and the CA, and verify. For cross-node access, this is mandatory.
- Add connection saturation alerts from `pg_stat_activity` and a "connection" panel next to the existing charts.
- Add copy-paste snippets for `psql`, Prisma, Drizzle, Kysely, Django, Rails, Go `pgx`, Node `pg`, and a generic `DATABASE_URL`.
- Rotation: `ALTER ROLE` for owner and monitor roles, create the new credential, re-activate consumers, then revoke the old one. Audit every reveal.

**Effort.** S–M. **Risk.** Pooling changes semantics; a bad default breaks apps. Default to direct for migrations, pooled for runtime, and make it configurable per attachment.

#### 4. Data-plane isolation and credential lifecycle

**Problem.** Today every container on a node shares `yoal-workloads`, and private databases trust a password. That is acceptable for a single-tenant homelab and not acceptable for a multi-tenant install or a security questionnaire.

**Evidence.** Zeabur's 2026 incident report describes attacker access to shared cluster databases and a backup via a presigned URL; its shutdown is a reminder that secret hygiene and export matter. Coolify documents SSL connections; Railway and Vercel scope tokens; Render and Fly put databases on a private network by default.

**Fit.** Yoal already has node tokens, WireGuard, sealed secrets, scoped IAM users for storage, and a scope ∩ role model. This is mostly finishing the isolation model, not inventing one.

**Minimal implementation.**
- Per-org Podman network on each node, with database/storage instances attached only to their org's network. The helper owns network creation and membership.
- TLS for Postgres, private-by-default for RustFS, and no public database ports. Public S3 stays SigV4-only.
- Named credentials: owner, app, monitor, read-only, backup. Each has a purpose, last-used, expiry, and revocation. Never return credentials over MCP.
- Reveal requires `database:credentials`/`storage:credentials`, step-up authentication, and an audit event. The default agent scope excludes it.
- Encrypt data at rest: RustFS SSE-S3 or volume-level encryption; document the host-disk assumption for Postgres. Add a key-rotation runbook and a `yoal doctor --data` check.
- Add "data access" to the audit log: credential reveal, backup download, restore, force bucket delete, SQL console session.

**Effort.** M. **Risk.** Network policy complexity, lockout, and migration of existing single-network installs. Do it before multi-tenant adoption, not after.

#### 5. A self-hosted backup target, so R2 is optional

**Problem.** Yoal's platform backups currently depend on R2. That is an adoption blocker for offline, air-gapped, and "no cloud account" installs, and it weakens the "your own cloud" promise.

**Evidence.** Coolify, Dokploy, and Easypanel all support multiple S3-compatible destinations (AWS, MinIO, R2, Backblaze, Wasabi). Fly bundles Tigris; Cloudflare pushes R2. Yoal's own roadmap already lists local fs and Garage/MinIO for `ObjectStore`.

**Fit.** The `ObjectStore` interface exists; the missing work is an `S3ObjectStore` for arbitrary endpoints and a local-filesystem driver, plus configuration and tests. Yoal can also point its backup target at a managed RustFS instance as a **replication target only**; canonical platform artifacts must not live on a workload whose own deploys need those artifacts.

**Minimal implementation.**
- Generalize the R2 client to any S3 endpoint (path-style, region, forcePathStyle, TLS verification).
- Add a local-filesystem store for single-node installs, with a documented directory and disk alert.
- Add a per-org/platform backup target setting, test-connection, and a "restore from this target" flow.
- Make the installer accept a target during setup; default to local if no R2 credentials.
- Document the 3-2-1 story and the caveat that a backup on the same disk is not a disaster-recovery backup.

**Effort.** S–M. **Risk.** Endpoint quirks, credential handling, and accidental backup of backups. Keep the interface small and test against RustFS, MinIO, R2, and local fs.

#### 6. Upgrade safety: pre-update snapshots, rollback, and a major-version guard

**Problem.** With data, an upgrade is no longer just a control-plane restart. Coolify updates have corrupted `coolify-db`, broken Redis, and left no working rollback; changing a Postgres image tag without a major-version migration bricks the volume. Yoal's installer has an upgrade path and rollback, but the in-process updater is pending, and there is no data-layer compatibility check.

**Evidence.** Coolify issues #7519, #5288, and the PG18 template break (#8935); Dokploy users request an LTS channel. The common failure is a config/secret migration that cannot be rolled back.

**Fit.** Yoal already has pre-upgrade snapshots, an atomic release switch, and installer rollback for the control plane. Extending that to managed data is mostly orchestration and a guardrail.

**Minimal implementation.**
- Before any upgrade, snapshot the control DB, `.env`/APP_KEY, and managed-data metadata; verify the snapshot; record the release and migration version.
- Refuse an in-place Postgres major-version change. Offer a dump/restore or `pg_upgrade` wizard with a pre-upgrade snapshot, a verification query, and a rollback path.
- Add a data-layer compatibility check to `/readyz` (schema version, helper version, Podman/Quadlet, RustFS version).
- Add a staged update channel and one-command rollback including data; surface it in the dashboard and CLI.
- Do not auto-upgrade a database engine; make it an explicit, scheduled operation with a maintenance window.

**Effort.** S–M. **Risk.** Rollback that does not actually cover data, and false confidence in `pg_upgrade`. Test on a copy, not on production.

---

### P1 — Compose the stack (the next quarter)

Once the data is safe, the next power comes from connecting it to everything else. These are the features that make Yoal feel like a private cloud rather than a collection of resources.

#### 7. Persistent volumes with snapshots and disk admission

**Problem.** Tier 2/3 workloads have a single fixed `/data` directory (`dataSizeMb`), not general-purpose volumes. The audit found `sizeMb` is validated but never enforced, `admit()` checks memory only, and `storageMb` is alert-only. SQLite, uploaded files, and stateful services need multiple mounts, resize, detach/attach, snapshots, and disk admission.

**Evidence.** Railway volumes, Render disks (single instance, no zero-downtime), Fly volumes + snapshots, Northflank volumes, Coolify/Dokploy volume backups. Easypanel's volume backup is a mirror, which is the anti-pattern to avoid.

**Fit.** Volumes are a natural sibling of managed databases: a `volumes` table, a node-local directory, an attachment to a workload, admission against disk, and a snapshot to `ObjectStore`. The helper already owns data directories and fixed verbs.

**Minimal implementation.**
- `volumes` (org, name, node, size, path, status, soft-delete) and `volume_attachments` (volume ↔ workload, mount path, read-only).
- Single-writer scheduling: refuse two workloads/replicas on one read-write volume; warn that attaching a volume disables zero-downtime swap, as Render does.
- Snapshot via a helper verb: quiesce optionally, `tar`/`rsync` with xattrs to a staging path, upload to `ObjectStore`, record checksum/size. Versioned snapshots, not a mirror; never propagate deletions.
- Restore to a new volume, attach to a new workload, and verify before exposing "restore".
- Dashboard: usage, mount path, snapshot list, restore, delete. Alerts at 85% of the volume size; disk admission on create/attach.
- Do not expose arbitrary host paths; volumes are named resources under the helper's state directory.

**Effort.** M. **Risk.** Data corruption on snapshot, disk exhaustion, and single-writer confusion. The UX must state the trade-off plainly.

#### 8. Managed Valkey (Redis-compatible) as the second engine

**Problem.** Postgres plus S3 is not a complete stack. Caches, sessions, rate limits, queues, and background workers need a key-value store. Railway, Render, Fly (Upstash), Coolify, Dokploy, Easypanel, and Northflank all offer one.

**Fit.** The engine registry was explicitly designed for this (`database.ts` is a seam for MySQL/Valkey). Valkey is BSD-licensed, small, and operationally simple. Reuse the database profile: sealed credentials, attachments, metrics, soft delete, restore, same-node private networking.

**Minimal implementation.**
- Add `valkey` to the engine registry with a pinned image and health check (`PING`).
- Helper profile: data dir, `appendonly yes` or RDB snapshots, `maxmemory` and eviction policy, private port only.
- Attachments inject `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` (and `VALKEY_*` aliases).
- Metrics: memory, keys, hits/misses, evictions, connected clients, ops/sec; alerts on memory and evictions.
- Backups: RDB snapshot to `ObjectStore`, restore into a new instance.
- Do not make it public by default. If public is requested, require TLS and a strong password.

**Effort.** S–M. **Risk.** Eviction policy surprises, persistence configuration, and another engine to patch. Valkey first; MySQL second only if WordPress/legacy demand appears; MongoDB and ClickHouse via stack templates, not native engines.

#### 9. Scheduled jobs, cron, and one-off jobs

**Problem.** Backups need a scheduler, and users need cron for cleanup, reports, syncs, and agent tasks. Render has cron jobs and workflows; Railway has cron; Heroku has Scheduler; Coolify/Dokploy have scheduled tasks; Northflank has jobs. Yoal has no general scheduler.

**Fit.** The scheduler built for backups can be generalized. The agent already runs sandboxed units; a job is a transient unit with the same release, env, secrets, resource caps, and logs. This is a small extension of the runtime, not a workflow engine.

**Minimal implementation.**
- `jobs` table: project/environment, name, argv, schedule (cron), timezone, timeout, concurrency policy (`forbid`/`allow`), retries, memory/CPU, enabled.
- Agent claims due jobs, helper runs a transient systemd unit with the release mounted, JIT activation for env/secrets, and a hard timeout. One-off runs use the same path.
- History: status, duration, exit code, stdout/stderr tail, trigger (schedule/manual/API/MCP). Alert on failure and on missed schedules.
- UI: job list, next run, run now, logs, pause. CLI `yoal jobs run|logs|pause`.
- Use the same scheduler for database/volume backups, with a separate platform-owned job namespace so users cannot delete the backup job.
- Do not build a general workflow/DAG engine; cron + one-off + retries covers most of the demand.

**Effort.** M. **Risk.** Time zones, overlapping runs, log volume, and clock skew. Persist last-run and next-run; make idempotency the user's responsibility but document it.

#### 10. Cross-node private networking and service discovery

**Problem.** Private database and storage attachments are same-node only. That forces a project onto the database's node, and it prevents a multi-node app from sharing one database. The roadmap already lists "cross-node access via a node private address" as a follow-up.

**Fit.** Yoal already runs WireGuard between edge and workers. A node private address plus firewall rules is the missing piece; DNS is the ergonomics layer.

**Minimal implementation.**
- Add `private_address` to nodes (WireGuard IP), allocated by the control plane and reported in heartbeats.
- Allow attachments to inject the private address + port when the consumer and database are on different nodes. Require TLS for Postgres and keep RustFS private (or use the public SigV4 endpoint for storage).
- Firewall: only the WireGuard interface can reach database/storage ports; never bind them to the public interface.
- Service discovery: start with deterministic names injected as env (`db-<id>`, `s3-<id>`) and a per-node DNS resolver (dnsmasq or CoreDNS) if demand justifies the footprint. Do not add Kubernetes DNS.
- Placement: keep "same node" as the default for latency and safety; cross-node is explicit or automatic only when the database/storage is public.
- Surface the topology in the dashboard: which app talks to which data resource, over which path, and whether it is encrypted.

**Effort.** M–L. **Risk.** Firewall mistakes, MTU/WireGuard issues, and DNS becoming a new critical service. Ship private IP + TLS first, DNS second.

#### 11. Stack blueprints: `yoal.yaml` with plan/apply

**Problem.** Creating a real app today is a sequence of API calls: project, environment, database, bucket, attachment, env vars, domain, deployment. That is fine for a dashboard demo and painful for a team, CI, or an agent. Render has `render.yaml` Blueprints, Railway has `.railway/railway.ts` with `config plan|apply`, Northflank has visual templates, Heroku has `app.json` pipelines.

**Fit.** Yoal already has all the resources and a service layer. A blueprint is a validated document that calls those services in dependency order, with a plan diff. It is also the packaging format for curated stacks, preview environments, and agent provisioning.

**Minimal implementation.**
- Schema: `project`, `environments`, `services` (static/process/container, command/image, port, health, resources, env/secrets refs), `databases` (engine/version, size, extensions), `storage` (buckets, public, lifecycle), `jobs`, `domains`, `access`, `previews`.
- `yoal plan` computes create/update/delete/no-op against live state; `yoal apply` executes through the operation primitive (resumable, progress, audit). `--dry-run`, `--json`, `--yes`.
- Server-side `BlueprintService` validates and applies; REST/MCP/CLI/dashboard all call it. Do not add a second execution path.
- Store the last applied blueprint hash on the project; warn on drift; never silently delete resources that are not in the file unless `--prune` is explicit.
- Preview environments derive from the blueprint: same services, cloned/seeded data, ephemeral names.
- Compatibility: import a subset of `docker-compose.yml` (services, image, ports, env, volumes, depends_on) with explicit warnings for unsupported features. This is the long-tail strategy without a 750-template catalogue.

**Effort.** M. **Risk.** Plan/apply drift, secret handling in the file (only references, never values), and destructive prune. Make prune opt-in and typed-confirmed.

#### 12. Preview environments with cloned or seeded data

**Problem.** Yoal has preview URLs and named environments, but a process app has one active workload per project. A reviewer cannot test a migration, a seed change, or a data-dependent feature in a PR.

**Evidence.** Netlify forks production data into every deploy preview. Railway clones a project environment, including databases, but the datastores start empty. Northflank can fork from a backup and fails loudly if none exists. Supabase branches are schema/config by default; Neon branches are copy-on-write and can include data. `preview-with-data` is genuinely under-served, and Yoal owns both stores.

**Fit.** The `environments` model already exists; the missing pieces are a workload per environment/deployment, a database/bucket clone, and PR automation. The clone can start as dump/restore; copy-on-write is not required to deliver the workflow.

**Minimal implementation.**
- Change the runtime from one workload per project to one workload per environment (production, staging, `pr-<n>`), with the production pointer unchanged.
- On PR open: create an ephemeral environment, deploy the branch, clone the base database (schema-only + seed by default, or a fork from the latest backup for trusted branches), create a bucket/prefix or clone, inject env, route `<slug>--pr-<n>.<contentDomain>`, comment on the PR, and set a TTL.
- On merge/close: tear down the workload, database, bucket, and route; keep an audit record. Reconcile on a schedule, not only on webhooks, so missed events do not leak resources.
- Data safety: never clone production data by default for a fork PR; use schema-only plus seed, or a sanitized snapshot. Make "clone data" an explicit, permissioned choice. Placeholder secrets for previews.
- Quotas: cap preview count and total memory/storage per org; show cost/showback. A looping agent must not create 100 previews.
- PR surface: sticky comment, check, deployment status, and a cleanup note. This is table stakes from Netlify/Vercel.

**Effort.** L. **Risk.** Data leakage across previews, resource exhaustion, teardown races, and migration state. Start with an opt-in "preview data" for trusted branches, then broaden.

#### 13. Postgres extensions, vector search, and slow-query insight

**Problem.** Teams choose Supabase/Fly/Neon partly because extensions are easy: `pgvector`, PostGIS, `pg_trgm`, `pg_cron`, `pg_stat_statements`. Yoal ships vanilla Postgres and a table snapshot; it does not expose extensions or query-level insight.

**Fit.** The database is a normal Postgres container with owner credentials. An allowlist of extensions applied at create/update is a small, high-leverage feature. `pg_stat_statements` gives a slow-query panel from data the agent can already sample.

**Minimal implementation.**
- `extensions` list on database create/update, validated against an allowlist (`vector`, `postgis`, `pg_trgm`, `pgcrypto`, `pg_cron`, `pg_stat_statements`, `hstore`, `citext`).
- Apply `CREATE EXTENSION IF NOT EXISTS` with the owner credential at bootstrap; set `shared_preload_libraries` for `pg_stat_statements` and `pg_cron` at create (requires restart).
- Add a "Vector" note and a snippet for `pgvector`; this is the cheapest way to be credible for AI apps.
- Sample `pg_stat_statements` every five minutes: query fingerprint, calls, mean/total time, rows, shared blocks. Store the top N in SQLite/DuckDB, show a slow-query table and an alert threshold.
- Add index suggestions only as advisory text, never automatic DDL. Destructive or long-running SQL is human-only.

**Effort.** S–M. **Risk.** Extension availability per image, `shared_preload_libraries` restarts, and query text containing secrets. Redact literals before storing.

#### 14. Curated stacks and a compose-import path

**Problem.** Coolify's 360+ templates and Easypanel's 750+ are the self-hosted acquisition engine. Yoal cannot and should not match the count. But users still want "install n8n with Postgres" or "run a Supabase-like stack" in one click, and stale templates are a recurring failure.

**Fit.** A stack is a blueprint, not a new runtime. Ten to twenty first-party stacks that use managed Postgres, RustFS, Valkey, volumes, jobs, and backups would cover most demand and demonstrate the platform. A compose-import subset covers the long tail.

**Minimal implementation.**
- First-party stacks: n8n + Postgres, Plausible + ClickHouse, Uptime Kuma, Gitea + Postgres, Ghost + MySQL, WordPress + MySQL, Directus + Postgres, Cal.com + Postgres, Metabase + Postgres, Umami + Postgres, Vaultwarden, Supabase-lite (Postgres + PostgREST + storage), MinIO/RustFS console, Meilisearch, RabbitMQ.
- Each stack: pinned image digests, generated secrets, a volume, a database/bucket, a health check, backups on by default, a domain, and an uninstall path that respects soft delete.
- Sign and version the stack manifests; show the diff before install; never run privileged containers or host mounts.
- Compose import: services, image, command, ports, env, named volumes, depends_on. Reject `privileged`, `network_mode: host`, arbitrary bind mounts, and unknown capabilities with a clear error. This is a convenience, not a compatibility promise.
- Automated upgrade PRs with smoke tests and a known-good badge; never use `:latest`.

**Effort.** M for the mechanism, S per stack. **Risk.** Supply-chain trust, stale images, and support burden. Keep the catalogue small, first-party, and pinned; let the compose importer handle the rest.

#### 15. Image transformations and a media pipeline

**Problem.** Static sites and apps need responsive images. Vercel, Netlify, Cloudflare, Supabase, Appwrite, Bunny, and Fastly all sell image optimization. Yoal serves precompressed HTML/CSS/JS but not images.

**Fit.** A managed `media` service (imgproxy or Thumbor) attached to a storage bucket, behind a public route, with signed URLs and a cache, is a small addition that makes the storage feature much more useful. Do not build an image CDN from scratch.

**Minimal implementation.**
- Add a `media` engine profile or a stack that runs imgproxy with the bucket as source; expose `/<bucket>/<key>?w=&h=&fit=&format=`.
- Sign URLs with HMAC; allow only configured widths/formats; cap source size and output pixels; rate-limit; guard decompression bombs.
- Cache transformed images on disk or in the bucket; purge on object update.
- Add a `<Image>` snippet for static sites and a `yoal images` build step that generates AVIF/WebP variants at five widths with a manifest.
- Metrics: transforms, cache hit rate, source bytes, errors.

**Effort.** M. **Risk.** CPU abuse, cache poisoning, signed URL mistakes, and format licensing. Default to a small allowlist and a per-org transform budget.

#### 16. Quotas, usage, and showback

**Problem.** Managed data consumes disk, memory, connections, and bandwidth. Without quotas and usage, one project can starve a node, and an agent can create resources until the disk fills. `QuotaService` currently counts projects and release bytes only; `storageMb` is alert-only.

**Fit.** Yoal already has node budgets, telemetry, and DuckDB. Add per-org/project quotas and a usage page; no billing, just showback and hard limits.

**Minimal implementation.**
- Quotas: databases (count, total size), storage (bytes, objects, egress), volumes (bytes), jobs (runs/day), builds (minutes), previews (count), memory (sum of admitted workloads).
- Enforce at create/update with a clear error naming the quota and current usage.
- Usage page: per project/org, 30-day trend, top consumers, CSV export. Alert at 80/95%.
- Operator view: node capacity, reserved vs actual, disk per node, data growth, backup size.
- This is also the safety rail for agent-created preview environments.

**Effort.** M. **Risk.** Measurement drift, double counting, and quota false positives. Start with hard limits on the resources that can fill a disk, then add soft showback.

#### 17. Data import, export, and portability

**Problem.** Users will not put data into a platform they cannot leave. Zeabur's shutdown is the extreme case, but the everyday case is a migration from an existing Postgres or S3. Coolify/Dokploy support import/export; Supabase has a CLI and dump/restore; Netlify documents migration paths.

**Fit.** Yoal already has restore-to-new, object storage, and a CLI. Import/export is a small surface over the same primitives and a strong switching feature.

**Minimal implementation.**
- `yoal db import <file|s3-url>` with `pg_restore`/`psql`, a dry-run, and a target check; `yoal db export` streams a compressed dump to stdout or a signed URL.
- `yoal storage sync` / `rclone`-compatible import/export; per-bucket export; preserve keys/metadata.
- CSV import for a table via the SQL console or CLI, with a size limit.
- Export a whole project/stack as `yoal.yaml` plus data dumps and object manifests; import it elsewhere.
- Never export secrets; export secret references and a separate recovery kit.
- Document the exit path and test it in CI. Portability is a trust feature, not a nice-to-have.

**Effort.** S–M. **Risk.** Large dumps, encoding, permissions, and accidental overwrite. Always import into a new resource by default.

#### 18. IaC: OpenAPI 3.1, typed SDK, and a Terraform provider

**Problem.** Teams want to manage projects, databases, buckets, domains, and jobs as code. The API is documented as a markdown table; clients guess. Vercel, Railway, Render, Heroku, Appwrite, and Dokploy all have providers or generated clients.

**Fit.** Zod contracts are already the source of truth. Generate OpenAPI 3.1 and a typed SDK, then a Terraform provider. Blueprints cover the "one file for one stack" case; Terraform covers the "many stacks in one org" case.

**Minimal implementation.**
- `GET /api/openapi.json`, Scalar UI, CI route/spec diff, generated `@yoal/sdk`.
- `Idempotency-Key` on create/apply, stable error codes, `X-Request-Id`, cursor pagination.
- Terraform provider generated from the spec, with acceptance tests against a dev install; resources for project, environment, database, storage, bucket, attachment, domain, job, blueprint.
- Publish the provider only after the spec is stable; a hand-written provider is a permanent compatibility tax.

**Effort.** S–M for OpenAPI/SDK; M–L for Terraform. **Risk.** Spec drift and provider maintenance. Do it after blueprints, because blueprints define the resource semantics.

#### 19. Process groups: web, worker, and scheduler in one project

**Problem.** A real app is not one process. Heroku has a Procfile, Fly has `processes`, Render has six service types. Yoal runs one workload per project today, so a worker or a queue consumer has no home.

**Fit.** `yoal.json` already exists; add a `processes` map and render one unit per process from the same release. This pairs naturally with Valkey and jobs.

**Minimal implementation.**
- `processes: { web: { command, port, health }, worker: { command, replicas }, scheduler: { command } }`, each with memory/CPU and optional volume/data.
- One workload per process per environment; logs tagged by process; restart/scale (single-node replicas only) in the UI; shared env and secrets.
- Do not claim multi-node scheduling or autoscaling; vertical resize and manual placement are enough.

**Effort.** M. **Risk.** Admission accounting per process, log routing, and port allocation. Keep replicas single-node and explicit.

---

### P2 — Depth and scale (when demand is proven)

- **Read replicas and HA.** Render, Fly, Supabase, and Northflank offer them; Yoal should not until backups and pooling are boring. A streaming replica on another node with a read-only URL is the first step; automatic failover is a much larger promise.
- **Database branching/clone as a first-class resource.** Neon's copy-on-write is the benchmark; Tigris offers O(1) snapshots/forks. On ext4, true COW needs ZFS/btrfs; the 80/20 is "clone from backup" (dump/restore or `pg_basebackup`) into a new instance, plus "branch from timestamp" with PITR. This is the engine behind preview data; expose it directly for staging and debugging.
- **More engines, judiciously.** MySQL/MariaDB for WordPress and legacy apps; MongoDB and ClickHouse via stacks, not native, unless demand is clear. Every native engine adds patch cadence, backup logic, metrics, and support.
- **S3 event notifications and object-triggered jobs.** R2 supports object-create/object-delete notifications to queues; RustFS can emit to webhook/Kafka/MQTT/Postgres/NATS/Redis. Add idempotent consumers, retries, and a dead-letter view. This makes the bucket part of the application, not just a file store.
- **Log drains and archives.** OTLP/Loki/webhook drain, S3 archive, retention controls. Yoal already has telemetry; exporting it is cheaper than building a log warehouse.
- **Data governance.** Audit hash chain, export to NDJSON/CSV, approval gates for destructive data operations, retention/legal hold, and SIEM webhooks. This is the enterprise trust layer; it is also the natural extension of the existing audit log.
- **Search, queue, realtime, and auth as stacks.** Meilisearch, RabbitMQ, Centrifugo, and Supabase-lite can be curated stacks or compose imports. Do not build them natively; they are separate products with separate security models.

---

## The agent-native differentiator

Yoal's MCP authorization is already ahead of the self-hosted field. The data layer is the opportunity to make it visibly useful. The goal is not "an agent can call every REST endpoint"; it is "an agent can stand up a complete, safe stack and operate its data within the user's permissions."

### Tool surface

| Tool | What it does | Safety |
|---|---|---|
| `plan_stack` / `apply_stack` | Diff and apply a blueprint: site, database, bucket, jobs, env, domain | Scope ∩ role; plan returns a resource graph, cost, and diff; destructive changes require confirmation |
| `get_data_health` | Backup age, last verified restore, pool saturation, disk/quota, replication lag | Read-only; no secrets |
| `query_database` | Run a read-only SQL query with row/time limits | Separate `database:query` scope; never pre-ticked; audit; redact literals; no DDL/DML |
| `create_presigned_url` | Mint a short-lived GET/PUT URL for one object | Object-scoped, expiry-capped, audited; no root key |
| `restore_backup` | Restore into a new resource | Human confirmation; typed target; never in-place by default |
| `fork_database` | Clone a database for staging/preview | Quota-checked; data-sanitization policy; teardown TTL |
| `list_backups` | List backups from the object store | Read-only; works without control-plane metadata |

### Design rules

1. **Server-enforced confirmation, not client hints.** Every destructive verb (`restore`, `fork`, `delete`, `force bucket delete`) should require a server-side confirmation token or step-up, not trust the client to show a dialog. Research finds most destructive MCP tools lack this; Coolify's `confirm=true` is client-enforced. Yoal can own the safer model.
2. **Scope ∩ role ∩ environment.** A token should carry project, environment, read-only, feature groups (`database`, `storage`, `jobs`), and secret sensitivity. `read_only=true` should be a server-side filter, not a client convention. Supabase and Neon do parts of this well; Yoal's existing scope ∩ role is the foundation.
3. **The agent never receives credentials.** It receives resource IDs, connection status, and env-injected apps. Credential reveal stays human-only, as it is today.
4. **Durable tasks.** Long provisions, restores, and migrations should return a durable handle with `input_required` for approvals and resumable polling. MCP 2026-07-28 standardizes Tasks; few vendors implement them. This is a clear gap Yoal can own.
5. **The unit of work is the stack.** A single `apply_stack` call should create the app, database, bucket, attachment, env, and route, then return a preview URL, a health summary, and a cost estimate. Railway's `deploy_template` + `create_bucket` + `generate_domain` is the closest; Render's Blueprint + `fromDatabase` is the closest declarative model.
6. **Data-safe previews by default.** Fork PRs get schema/seed, not production data; placeholder secrets; TTL and quota; teardown reconciliation. This is both a security and a cost control.

### Main risks

Production secrets or data leaking into PR previews; a generic `execute`/raw-SQL tool becoming a confused-deputy path; prompt injection via logs, object metadata, or tickets; destructive actions guarded only by a client-side hint; orphaned preview resources; irreversible bucket/database deletion; audit logs that cannot distinguish agent actions from humans; and context blow-up from wrapping every endpoint as a separate tool.

---

## Sequencing

| Release | Theme | Contents | Exit criteria |
|---|---|---|---|
| **0.5** | Data safety | Debian 13 e2e; dumps + bucket sync; PITR via pgBackRest; S3-first restore browser; object browser/policies/versioning/lifecycle/CORS/quota/lock; pooling + TLS; rotation; self-hosted backup target; upgrade snapshot/rollback | An operator can delete a production database, restore it to a verified new instance at a chosen minute, undelete an object, survive 200 concurrent app connections, and roll back a bad platform update |
| **0.6** | Compose the stack | Volumes + disk admission; Valkey; scheduler + cron + one-off jobs; cross-node private networking; `yoal.yaml` plan/apply; process groups; import/export | One repo runs web + worker + cron + Postgres + bucket from one file, on more than one node, with backups and a tested restore |
| **0.7** | Previews and depth | Preview environments with cloned/seeded data; PITR retention tiers; extensions/vector/slow queries; curated stacks + compose import; image transforms; quotas/showback | A PR gets an app, a database, and a bucket, and tears down cleanly; an AI app gets vector search without a second vendor |
| **0.8** | Agent data ops | `plan_stack`/`apply_stack`, read-only SQL, presigned URLs, restore/fork; server-enforced approvals; durable tasks; audit export; OpenAPI/SDK/Terraform | An agent stands up a full stack, demonstrates a restore, and cannot read a secret or run DDL |

Dependencies are real. Pooling and TLS before cross-node data access. Backups before preview cloning. Blueprints before curated stacks. OpenAPI before Terraform. Approvals before agents can restore or fork. Disk admission before volumes and previews.

---

## What not to build

| Do not build | Why | Closest alternative |
|---|---|---|
| Kubernetes, Swarm, HPA, a general scheduler | Erases the 250 MB, no-container-daemon advantage | Node labels, manual placement, vertical resize, workload-slice admission |
| A 750-template marketplace | A treadmill with supply-chain and support costs; the long tail is better served by compose import | 10–20 first-party stacks + `yoal.yaml` |
| Native auth, realtime, search, or a queue product | Each is a separate security and product surface | Curated stacks (Supabase-lite, Centrifugo, Meilisearch, RabbitMQ) |
| A general workflow/DAG engine | Large product; cron + one-off + retries covers most demand | Jobs with retries and concurrency policy |
| Global anycast CDN, WAF, or bot management | Different company; a single edge cannot absorb volumetric DDoS | CDN presets, Caddy rate limits, Cloudflare/Bunny in front |
| Billing and metered SaaS pricing | Self-hosted has no bill; quotas and showback are the useful translation | Quotas, usage, CSV export |
| Agent sandbox shell or hosted coding agent | Second security model for egress, persistence, and secrets | External agents over MCP; document E2B/Daytona/Fly Sprites |
| Read replicas and HA in the first data release | Multiplies the operational promise before backups are boring | PITR + restore drills first; replica later |
| A native image CDN | Huge surface; imgproxy is a commodity | Managed imgproxy/Thumbor profile |
| A partial S3 gateway | Appwrite's compatibility list shows how quickly this becomes a trap | Expose RustFS directly; put policy/UX in the control plane |
| Multi-region active-active control plane | Conflicts with one control plane + SQLite | Warm standby, Litestream replica, DNS failover |

---

## How to know it worked

Track outcomes, not feature counts:

- **Restore confidence:** percentage of managed data resources with a backup in the last 24 hours; restore drills passed; median restore time; earliest/latest restorable; percentage of backups whose restore was verified.
- **Data safety:** connection saturation alerts per database; pooler adoption; TLS usage; credential age; unrotated keys; backup age alarms; object-lock coverage.
- **Composition:** percentage of process apps with a database/bucket attachment; median time from `git push` to a working preview with data; blueprint adoption; jobs per project.
- **Object storage:** share-link creation, object browser sessions, lifecycle rules configured, quota breaches, undelete success.
- **Agent operations:** `apply_stack` success rate; tool errors by scope; destructive actions confirmed server-side; secrets never revealed over MCP; durable-task completion.
- **Upgrades:** pre-update snapshot success; rollback time; failed upgrades caught by `/readyz`; data-layer compatibility failures.
- **Operations:** node disk headroom, backup storage growth, restore failures, support tickets tagged "data".

The leading indicator is not "databases created". It is "databases with backups, a verified restore, a pooled connection, and an attached app". That is the number that says Yoal is a private cloud rather than a provisioning UI.

---

## Open questions

- **Which second engine matters?** Valkey is the safest bet. MySQL unlocks WordPress and legacy apps; MongoDB and ClickHouse are better as stacks. There is no usage data to decide, so ship Valkey and instrument attach rates.
- **Is PITR worth the complexity?** Dumps cover most homelab/SMB loss. PITR is what makes a database feel production-grade and is a clear differentiator against Coolify/Dokploy. The middle path is daily base backups plus WAL archiving, with a tested restore, and a clear "not HA" label.
- **How much compose compatibility is enough?** The long tail is real, but every unsupported compose feature becomes a support ticket. Start with a documented subset and reject the rest loudly.
- **Who owns preview data?** Cloning production data into a fork PR is a leak. Default to schema + seed; require an explicit permission and a sanitization policy for real data.
- **Can RustFS carry the storage story?** It is young, has had auth-bypass advisories, and MinIO's archival shows engine risk. Keep the engine registry and Garage fallback honest; test S3 fidelity (SigV4, multipart, presigned, range, CORS, lifecycle) before marketing it.
- **Does the target user want a private cloud or a static host?** If most users only ship static sites, 0.6–0.8 should slow down. The research has no user interviews; this is the biggest unknown.
- **What is the upgrade cadence?** A data platform cannot ship breaking changes weekly. A staged channel, LTS, and a tested rollback may matter more than any feature in this report.

---

## Sources

### Commercial deploy platforms

- Vercel storage overview: https://vercel.com/docs/storage
- Vercel Blob signed URLs: https://vercel.com/docs/vercel-blob/vercel-signed-urls
- Vercel Blob private storage: https://vercel.com/changelog/private-storage-for-vercel-blob-now-available-in-public-beta
- Vercel Rolling Releases: https://vercel.com/docs/rolling-releases
- Vercel Cron usage/pricing: https://vercel.com/docs/cron-jobs/usage-and-pricing
- Netlify Database: https://docs.netlify.com/build/data-and-storage/netlify-database/
- Netlify Database announcement: https://www.netlify.com/blog/netlify-database/
- Netlify deploy notifications: https://docs.netlify.com/deploy/deploy-notifications/
- Netlify image CDN: https://docs.netlify.com/build/image-cdn/overview/
- Cloudflare R2 object lifecycles: https://developers.cloudflare.com/r2/buckets/object-lifecycles
- Cloudflare R2 event notifications: https://developers.cloudflare.com/r2/buckets/event-notifications
- Cloudflare R2 presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- Cloudflare R2 bucket locks: https://developers.cloudflare.com/r2/buckets/bucket-locks/
- Cloudflare storage options (D1, KV, Queues, Hyperdrive): https://developers.cloudflare.com/workers/platform/storage-options
- Cloudflare Images pricing: https://developers.cloudflare.com/images/pricing/
- Render pricing: https://render.com/pricing
- Render PostgreSQL backups: https://render.com/docs/postgresql-backups
- Render PostgreSQL high availability: https://render.com/blog/high-availability-postgresql
- Render Blueprints: https://render.com/docs/blueprint-spec
- Render preview environments: https://render.com/docs/preview-environments
- Railway next-gen databases: https://blog.railway.com/p/launch-01-next-gen-databases
- Railway point-in-time recovery: https://docs.railway.com/volumes/point-in-time-recovery
- Railway buckets: https://docs.railway.com/storage-buckets
- Railway preview environments: https://blog.railway.com/p/best-preview-environment-platforms-2026
- Railway volumes: https://docs.railway.com/reference/volumes
- Fly Managed Postgres: https://fly.io/mpg
- Fly resource pricing: https://docs.fly.io/about/pricing
- Fly volumes: https://docs.fly.io/volumes/overview
- Heroku pipelines: https://devcenter.heroku.com/articles/pipelines
- Heroku Review Apps: https://devcenter.heroku.com/articles/github-integration-review-apps
- Heroku Postgres plans: https://devcenter.heroku.com/articles/heroku-postgres-plans
- Northflank preview environments: https://northflank.com/blog/alternatives-to-render-preview-environments
- Northflank backup and clone volumes: https://northflank.com/docs/v1/application/databases-and-persistence/backup-and-clone-volumes
- Northflank preview blueprints: https://northflank.com/docs/v1/application/release/set-up-preview-blueprints
- Northflank fork an addon: https://northflank.com/docs/v1/application/databases-and-persistence/fork-an-addon

### Self-hosted PaaS and panels

- Coolify database backups: https://coolify.io/docs/databases/backups
- Coolify vs Dokploy (template and engine counts): https://coolify.io/compare/coolify-vs-dokploy
- Coolify databases: https://coolify.io/docs/databases
- Coolify internal Postgres upgrade: https://coolify.io/docs/get-started/internal-postgresql-upgrade
- Coolify restore issue: https://github.com/coollabsio/coolify/issues/7987
- Coolify S3 restore visibility: https://github.com/coollabsio/coolify/discussions/11115
- Coolify backup retention: https://github.com/coollabsio/coolify/issues/5455
- Coolify silent backup failure: https://github.com/coollabsio/coolify/issues/10623
- Coolify PITR request: https://github.com/coollabsio/coolify/issues/7423
- Coolify healthcheck connection storm: https://github.com/coollabsio/coolify/issues/9939
- Coolify PG18 template break: https://github.com/coollabsio/coolify/issues/8935
- Coolify preview leaks: https://github.com/coollabsio/coolify/issues/2485
- Coolify preview audit: https://github.com/coollabsio/coolify/discussions/11663
- Coolify preview cap request: https://github.com/coollabsio/coolify/issues/9064
- Coolify upgrade breakage: https://github.com/coollabsio/coolify/issues/7519
- Dokploy database management: https://dokploy.com/features/database-management-tool
- Dokploy volume backups: https://docs.dokploy.com/docs/core/volume-backups
- Dokploy restore race: https://github.com/Dokploy/dokploy/issues/4127
- Dokploy wrong-database restore: https://github.com/Dokploy/dokploy/issues/3436
- Dokploy restore history: https://github.com/Dokploy/dokploy/issues/5629
- Dokploy volume backup discussion: https://github.com/Dokploy/dokploy/discussions/3992
- Dokploy fork PR advisory: https://github.com/Dokploy/dokploy/security/advisories/GHSA-h67g-mpq5-6ph5
- Dokploy LTS request: https://github.com/Dokploy/dokploy/discussions/2476
- Easypanel changelog: https://easypanel.io/changelog
- Easypanel volume backups: https://easypanel.io/docs/backups/volumes
- Easypanel database backups: https://easypanel.io/docs/backups/database
- CapRover backup limitations: https://caprover.com/docs/server/backup
- CapRover database backup discussion: https://github.com/caprover/caprover/discussions/1701
- Dokku backup/recovery: https://dokku.com/docs/advanced-usage/backup-recovery/
- Kamal installation: https://kamal-deploy.org/docs/installation/
- Portainer requirements: https://docs.portainer.io/start/requirements-and-prerequisites
- Zeabur agent skills: https://zeabur.com/blogs/zeabur-agent-skills-guide
- Zeabur incident report: https://zeabur.com/blogs/october-2026-security-incident
- Zeabur shutdown: https://zeabur.com/blogs/zeabur-is-shutting-down

### Data platforms and storage

- Supabase storage image transformations: https://supabase.com/docs/guides/storage/serving/image-transformations
- Supabase branching: https://supabase.com/docs/guides/deployment/branching
- Supabase branching 2.0: https://supabase.com/blog/branching-2-0
- Supabase backups and PITR: https://supabase.com/docs/guides/platform/backups
- Supabase connection pooling: https://supabase.com/docs/guides/database/connecting-to-postgres
- Supabase extensions: https://supabase.com/docs/guides/database/extensions
- Supabase read replicas: https://supabase.com/docs/guides/platform/read-replicas
- Neon instant restore / PITR: https://neon.com/docs/postgres/backup-restore/branch-restore
- Neon branching: https://neon.com/docs/introduction/branching
- Neon connection pooling: https://neon.com/docs/connect/connection-pooling
- Appwrite image transformations: https://appwrite.io/docs/advanced/billing/image-transformations
- Appwrite S3 gateway limitations: https://appwrite.io/docs/products/storage/s3
- MinIO bucket configuration: https://docs.min.io/aistor/administration/bucket-configuration
- MinIO object lifecycle: https://docs.min.io/aistor/administration/object-lifecycle-management
- MinIO repository status: https://github.com/minio/minio
- RustFS: https://github.com/rustfs/rustfs
- RustFS bucket policy: https://docs.rustfs.com/en/administration/data/bucket/policy
- RustFS object lock: https://docs.rustfs.com/en/administration/data/object/object-lock
- RustFS quota: https://docs.rustfs.com/en/administration/data/bucket/quota
- RustFS event notifications: https://docs.rustfs.com/en/operations/event-notifications
- RustFS advisory (multipart auth bypass): https://github.com/rustfs/rustfs/security/advisories/GHSA-mx42-j6wv-px98
- RustFS CVE-2026-27607: https://www.sentinelone.com/vulnerability-database/cve-2026-27607/
- Tigris presigned URLs: https://www.tigrisdata.com/docs/objects/presigned
- Tigris snapshots and forks: https://www.tigrisdata.com/docs/snapshots-and-forks/
- Upstash Blob: https://upstash.com/docs/blob/overall/quickstart

### Agent, IaC, and operations

- MCP Tasks specification: https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks
- Railway MCP: https://docs.railway.com/ai/mcp-server
- Railway IaC: https://docs.railway.com/infrastructure-as-code
- Coolify MCP capabilities: https://coolify.io/docs/mcp/capabilities/databases
- Coolify MCP security: https://coolify.io/docs/mcp/security
- Dokploy MCP: https://github.com/Dokploy/mcp
- Supabase MCP: https://supabase.com/docs/guides/getting-started/mcp
- Neon MCP: https://neon.com/docs/ai/neon-mcp-server
- Render MCP: https://render.com/docs/mcp-server
- Vercel MCP tools: https://vercel.com/docs/agent-resources/vercel-mcp/tools
- Cloudflare MCP servers: https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/
- Zeabur MCP: https://zeabur.com/docs/en-US/mcp
- Terraform MCP: https://github.com/hashicorp/terraform-mcp-server/
- Pulumi MCP: https://www.pulumi.com/docs/ai/guides/set-up-mcp-server/

### Yoal context

- Yoal README: `README.md`
- Yoal design: `docs/DESIGN.md`
- Managed databases: `docs/DATABASES.md`
- Managed object storage: `docs/OBJECT-STORAGE.md`
- Roadmap: `docs/ROADMAP.md`
- v2 backend plan: `docs/V2-BACKEND.md`
- Prior feature research: `reports/Yoal platform feature research.md`
