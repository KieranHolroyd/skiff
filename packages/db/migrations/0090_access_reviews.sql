-- Access reviews and permission usage (IAM.md I23, §4, §9.5). Additive only.
--
-- A review campaign snapshots the bindings at a scope into items, so completing the campaign
-- applies decisions to the bindings as they were when it started (a binding deleted meanwhile is
-- simply skipped). Items are assigned to the scope's managers as a hint; deciding one still needs
-- `iam:review` at the campaign's scope.
--
-- `access_reviews.status` is `open` or `completed`. `default_decision` is applied to every
-- undecided item when the campaign completes (`keep` by default, or `revoke` for a stricter
-- campaign). No CHECK constraints: a future status or decision is a data change, never a table
-- rebuild (the lesson of 0028).
--
-- `iam_permission_usage` is a daily, 30-day recompute from `audit_log`. The rollup deletes and
-- reinserts an org's rows, so running it twice in a day is idempotent and rows that age out of the
-- window disappear. `scope_id` is `''` for a scope with no id (an org-wide use); the unique index
-- uses COALESCE so a NULL cannot create a duplicate.

CREATE TABLE IF NOT EXISTS access_reviews (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- org | project | environment | database | storage | … (IAM.md §2); never platform here.
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  scope_parent_id TEXT,
  -- open | completed
  status TEXT NOT NULL DEFAULT 'open',
  -- keep | revoke: applied to undecided items at completion.
  default_decision TEXT NOT NULL DEFAULT 'keep',
  -- Optional deadline shown in the dashboard. Deciding after it is still allowed by the service;
  -- the default decision is applied only on completion.
  due_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_by TEXT,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS access_reviews_org_idx
  ON access_reviews (org_id, status, created_at);
CREATE INDEX IF NOT EXISTS access_reviews_scope_idx
  ON access_reviews (org_id, scope_type, scope_id);

CREATE TABLE IF NOT EXISTS access_review_items (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  -- The binding this item snapshots. It may be gone by the time the campaign completes.
  binding_id TEXT NOT NULL,
  -- user | group | serviceAccount, as on iam_bindings.
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  -- Snapshot of the role's display name, so the item still reads well after a custom role is renamed.
  role_name TEXT NOT NULL DEFAULT '',
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  scope_parent_id TEXT,
  condition_json TEXT,
  -- The binding's expiry when the campaign started.
  expires_at INTEGER,
  -- A scope manager, as a hint for who should decide this item.
  reviewer_id TEXT,
  -- keep | revoke | shorten; NULL until decided.
  decision TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS access_review_items_review_idx
  ON access_review_items (review_id, decision);
CREATE INDEX IF NOT EXISTS access_review_items_reviewer_idx
  ON access_review_items (reviewer_id, decision);
CREATE INDEX IF NOT EXISTS access_review_items_binding_idx
  ON access_review_items (binding_id);

CREATE TABLE IF NOT EXISTS iam_permission_usage (
  org_id TEXT NOT NULL,
  -- user | serviceAccount
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  -- org today: audit rows do not carry a scope (see GovernanceService.rollupUsage).
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  last_used_at INTEGER NOT NULL,
  count_30d INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS iam_permission_usage_key_idx
  ON iam_permission_usage (
    org_id, principal_type, principal_id, permission, scope_type, COALESCE(scope_id, '')
  );
CREATE INDEX IF NOT EXISTS iam_permission_usage_principal_idx
  ON iam_permission_usage (org_id, principal_type, principal_id, last_used_at);
CREATE INDEX IF NOT EXISTS iam_permission_usage_permission_idx
  ON iam_permission_usage (org_id, permission, last_used_at);
