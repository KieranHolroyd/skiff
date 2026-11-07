-- Blueprints (plan 11, docs/OPERATIONS.md §12). Additive only.
-- One row per stack an org has applied: the name the file declares, what the stack created or
-- adopted (`managed_json`, resource keys such as `projects.shop-web` or `databases.shop-db`; only
-- these can be pruned), and how the last apply went. The plan itself is a `blueprint.apply`
-- operation (0007), so progress, resume and audit come from there.
--
-- `document_json` is the last document that applied cleanly, normalised and without secret
-- values (blueprints only ever hold secret *names*). `last_status` keeps no CHECK on purpose (the
-- lesson of 0028): it mirrors the operation status set.

CREATE TABLE IF NOT EXISTS blueprints (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  document_json TEXT,
  document_hash TEXT,
  managed_json TEXT NOT NULL DEFAULT '[]',
  last_operation_id TEXT,
  last_status TEXT,
  applied_plan_hash TEXT,
  applied_at INTEGER,
  applied_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS blueprints_org_name_idx ON blueprints (org_id, name);
