-- IAM engine at org scope (IAM.md I1, §4). Additive only.
--
-- Bindings are the unit of access: a user, group or service account gets a role at a scope
-- (`platform` › `org` › `project` › `environment` › one resource). Built-in roles are seeded as
-- `org_id IS NULL, built_in = 1` rows from the code catalog on first use; custom roles live per org.
-- `member.role` stays as Better Auth's denormalised base role and is not read for authorization
-- once the I2 migration reaches a call site.
--
-- `iam_state.version` is the org's `iamVersion` (IAM.md §5.2). It is bumped in the same transaction
-- as every IAM write and is part of the compiled-grant cache key, so a write is visible to the next
-- check without a sweep. A dedicated row is used instead of `organization.metadata` so the counter
-- exists before Better Auth's tables and survives its writes.

CREATE TABLE IF NOT EXISTS iam_roles (
  id TEXT PRIMARY KEY,
  -- NULL = a built-in or platform role.
  org_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  built_in INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS iam_roles_builtin_name_idx ON iam_roles (name) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS iam_roles_org_name_idx ON iam_roles (org_id, name) WHERE org_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS iam_groups (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- local | scim | sso
  source TEXT NOT NULL DEFAULT 'local',
  external_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS iam_groups_org_name_idx ON iam_groups (org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS iam_groups_external_idx ON iam_groups (org_id, source, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS iam_group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS iam_group_members_user_idx ON iam_group_members (user_id);

CREATE TABLE IF NOT EXISTS iam_bindings (
  id TEXT PRIMARY KEY,
  -- NULL = a platform-scope binding.
  org_id TEXT,
  -- user | group | serviceAccount
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  -- A built-in role name or an `iam_roles.id`.
  role_id TEXT NOT NULL,
  -- platform | org | project | environment | deployment | database | … (IAM.md §2)
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  -- The project an environment or resource scope belongs to, for list filtering and explanations.
  scope_parent_id TEXT,
  condition_json TEXT,
  expires_at INTEGER,
  reason TEXT,
  access_request_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS iam_bindings_principal_idx ON iam_bindings (org_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS iam_bindings_scope_idx ON iam_bindings (org_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS iam_bindings_expiry_idx ON iam_bindings (expires_at);

CREATE TABLE IF NOT EXISTS iam_guardrails (
  id TEXT PRIMARY KEY,
  -- NULL = applies across every org.
  org_id TEXT,
  name TEXT NOT NULL,
  -- {} = every principal; otherwise { principalTypes, principalIds, groupIds }.
  principal_selector_json TEXT NOT NULL DEFAULT '{}',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  scope_type TEXT,
  scope_id TEXT,
  condition_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS iam_guardrails_org_idx ON iam_guardrails (org_id, enabled); 

CREATE TABLE IF NOT EXISTS iam_state (
  org_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
