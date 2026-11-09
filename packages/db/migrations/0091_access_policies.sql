-- Yoal Access: identity-aware proxy policies (IAM.md I25, §11.1). Additive only.
--
-- A policy is an ordered list of allow/deny rules. `scope_type` names where it may be attached:
-- an organisation (`id`/`parent` NULL), a project, or one named environment. A project or
-- environment points at its policy (`production_access_policy_id`, `preview_access_policy_id`,
-- `environments.access_policy_id`) and the effective protection mode becomes `access`.
--
-- The legacy access-mode columns keep their CHECK (`public|password|platform`), so an `access`
-- scope stores `platform` there: an older control plane still fails closed rather than making a
-- site public, and disabling the policy leaves the site on platform login instead of exposing it.
--
-- Each rule's `matcher_json` is the typed matcher from `@yoal/contracts` (an org group, any
-- member, email/domain, SSO provider, user pool and groups, CIDR, or a service-token header hash).
-- Rules are ordered by `idx`; a matching deny beats every allow.

ALTER TABLE projects ADD COLUMN production_access_policy_id TEXT;
ALTER TABLE projects ADD COLUMN preview_access_policy_id TEXT;
ALTER TABLE environments ADD COLUMN access_policy_id TEXT;

CREATE TABLE IF NOT EXISTS access_policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- org | project | environment
  scope_type TEXT NOT NULL,
  -- NULL for an org policy, else projects.id or environments.id
  scope_id TEXT,
  -- The project an environment policy belongs to.
  scope_parent_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS access_policies_org_idx ON access_policies (org_id, name);
CREATE INDEX IF NOT EXISTS access_policies_scope_idx ON access_policies (org_id, scope_type, scope_id);

CREATE TABLE IF NOT EXISTS access_policy_rules (
  policy_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('allow','deny')),
  matcher_json TEXT NOT NULL,
  PRIMARY KEY (policy_id, idx)
);
