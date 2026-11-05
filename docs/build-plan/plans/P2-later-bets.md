# P2 — Later bets

These are deliberately not in the 0.5–0.8 critical path. Each is a short brief; promote it to a
numbered plan when demand is proven and the P0/P1 layer is boring.

---

## P2.1 Read replicas and HA

**Why:** Render, Fly, Supabase, and Northflank offer read replicas/HA. **Why not yet:** it multiplies
the operational promise before backups and pooling are stable. **Shape:** a streaming replica on a
second node, a read-only URL, lag metrics, and a manual promote; automatic failover is a separate,
much larger project. **Depends on:** 01, 03, 04, 10. **Effort:** L.

## P2.2 Database branching/clone as a resource

**Why:** Neon's signature; preview data needs it. **Shape:** `skiff db branch <source> --from
<backup|timestamp>` creates a new instance or an in-instance clone; schema-only by default, data
opt-in; TTL; delete. **Reality check:** true copy-on-write needs ZFS/btrfs; on ext4 use dump/restore
or `pg_basebackup`. **Depends on:** 01, 12. **Effort:** M–L.

## P2.3 More engines (MySQL/MariaDB, MongoDB, ClickHouse)

**Why:** WordPress and legacy apps want MySQL; analytics wants ClickHouse. **Shape:** add to the
engine registry only when the backup/metrics/attach path is generic; otherwise ship as a stack with a
volume. **Rule:** every native engine needs backup, restore, metrics, upgrades, and a patch cadence.
Start with MySQL only if WordPress demand is real. **Depends on:** 08's registry refactor.
**Effort:** M per engine.

## P2.4 S3 event notifications and object-triggered jobs

**Why:** R2 supports object-create/delete → Queues; RustFS emits to webhook/Kafka/MQTT/Postgres/
NATS/Redis. **Shape:** a `storage_events` consumer with at-least-once delivery, idempotency, retries,
and a dead-letter view; trigger a job/webhook. Do not build a queue product. **Depends on:** 02, 09.
**Effort:** M.

## P2.5 Log drains and archives

**Why:** Railway lacks log drains; Coolify/Dokploy are weak. **Shape:** per-org OTLP/Loki/webhook sink,
S3 archive, retention, redaction; export beats building a log warehouse. **Depends on:** existing
telemetry. **Effort:** S–M.

## P2.6 Data governance

**Why:** enterprise trust; the audit log is already there. **Shape:** hash-chained audit, NDJSON/CSV
export, approval gates for destructive data ops, retention/legal hold, SIEM webhook, data-access
reports. **Depends on:** 01, 04, 20. **Effort:** M.

## P2.7 Custom bucket domains and static site from a bucket

**Why:** Vercel/Netlify/Cloudflare make a bucket a site; Skiff already serves static releases.
**Shape:** map a verified custom domain to a bucket, index/error documents, cache headers, optional
SPA fallback; only for public-read buckets; preserve `Host` for SigV4 or use a separate read-only
route. **Depends on:** 02, 15. **Effort:** M.

## P2.8 Auth/realtime/search/queue as stacks

**Why:** Supabase/Appwrite bundle these. **Shape:** curated stacks (Supabase-lite, Centrifugo,
Meilisearch, RabbitMQ), not native products. **Rule:** do not build a second permission model.
**Depends on:** 14. **Effort:** S per stack.

## P2.9 Reserved: node-level pooler

If per-database PgBouncer sidecars consume too much memory at density, replace them with a single
node-level pooler with per-database pools. Measure first; keep the per-DB path for isolation.
**Depends on:** 03. **Effort:** M.

## P2.10 Reserved: multi-node workload scheduling

Not a goal. Keep manual placement, vertical resize, and single-node replicas. Revisit only if a
design partner needs active-active, which conflicts with one control plane + SQLite.
