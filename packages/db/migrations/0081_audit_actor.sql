-- IAM audit actor columns (docs/IAM.md §7.1, I0). Additive only.
--
-- `credential_id` is the key/token/credential that proved the principal; `acting_for_type` and
-- `acting_for_id` name the principal a machine acts for (a job for the person who started its run,
-- an impersonation token for the user). Existing rows stay NULL, which means "unknown credential"
-- and "not acting for anyone", so every current query keeps working.
--
-- `actor_type` keeps its CHECK (user/apiKey/mcp/system/agent): new principal kinds
-- (serviceAccount/workload/job/node) are written as `system` until a later migration can relax the
-- constraint without rebuilding the table.

ALTER TABLE audit_log ADD COLUMN credential_id TEXT;
ALTER TABLE audit_log ADD COLUMN acting_for_type TEXT;
ALTER TABLE audit_log ADD COLUMN acting_for_id TEXT;

-- "What did machines do on behalf of this principal?" — org-scoped, newest first, like list().
CREATE INDEX IF NOT EXISTS audit_acting_for_idx
  ON audit_log (org_id, acting_for_type, acting_for_id, created_at);
