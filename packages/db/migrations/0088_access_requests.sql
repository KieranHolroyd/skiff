-- Just-in-time access requests (IAM.md I22, §4, §9.4). Additive only.
--
-- A request names a role, a scope, a duration, a reason and an optional change reference.
-- `status` moves pending → approved | denied | cancelled, and a pending request older than 24
-- hours becomes `expired` on the next read. Approval writes an `iam_bindings` row with
-- `expires_at` and `access_request_id`, and stores its id here so cancelling the request can
-- end the binding early.
--
-- No CHECK on `status`: a future state is a data change, never a table rebuild (the lesson of
-- 0028). `scope_parent_id` is the project an environment or resource scope belongs to.

CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  -- org | project | environment | deployment | database | … (IAM.md §2)
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  scope_parent_id TEXT,
  -- Seconds the approved binding lasts. Capped at 8 hours by GovernanceService.
  duration_seconds INTEGER NOT NULL,
  reason TEXT NOT NULL,
  change_ref TEXT,
  -- pending | approved | denied | cancelled | expired
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at INTEGER,
  binding_id TEXT,
  created_at INTEGER NOT NULL
);

-- The approver's queue for one org: pending first, newest first.
CREATE INDEX IF NOT EXISTS access_requests_pending_idx
  ON access_requests (org_id, status, created_at);

-- "My requests" and the requester's history.
CREATE INDEX IF NOT EXISTS access_requests_requester_idx
  ON access_requests (org_id, requester_id, created_at);
