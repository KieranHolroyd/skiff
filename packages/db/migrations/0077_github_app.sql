-- Yoal's GitHub App (docs/GITHUB.md, D163–D166). Additive only.
-- The App's own credentials live sealed in `settings` (`github.app`); this table records every
-- installation GitHub reports, and which Yoal organisation (if any) it is linked to. An
-- installation is unclaimed (org_id NULL) until someone who can see it on GitHub links it.

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id INTEGER PRIMARY KEY,
  org_id TEXT,
  account_login TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  account_type TEXT NOT NULL,
  avatar_url TEXT,
  repository_selection TEXT NOT NULL DEFAULT 'selected',
  permissions_json TEXT NOT NULL DEFAULT '{}',
  suspended_at INTEGER,
  linked_by TEXT,
  linked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS github_installations_org_idx ON github_installations (org_id);
CREATE INDEX IF NOT EXISTS github_installations_account_idx ON github_installations (account_login);
