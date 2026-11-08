-- Service accounts (IAM.md I13, §4, §7.2). Additive only.
--
-- A service account is an org-owned machine principal with a stable `sa_…` id. It is bound like any
-- other principal (`iam_bindings.principal_type = 'serviceAccount'`) and this table carries only its
-- identity: a slug that is unique in the org, a description, the group that owns it, and the
-- disabled flag that is the normal off-switch. Access keys, federation trusts and impersonation
-- tokens arrive in later phases (I3/I4) and will reference this id; deleting an account is refused
-- while bindings still point at it.

CREATE TABLE IF NOT EXISTS service_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  -- A slug, unique per org (IAM.md §4).
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- The `iam_groups.id` answerable for this account; NULL when the org owns it directly.
  owner_group_id TEXT,
  -- NULL = enabled. Disabling is preferred to deleting because keys and bindings keep their history.
  disabled_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS service_accounts_org_name_idx ON service_accounts (org_id, name);
CREATE INDEX IF NOT EXISTS service_accounts_owner_group_idx ON service_accounts (org_id, owner_group_id);
