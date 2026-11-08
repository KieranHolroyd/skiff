-- Registry trust for external CI identities (docs/REGISTRY.md G3). Additive only.
-- A GitHub Actions workflow logs in with its OIDC token (audience = the registry host); a trust
-- names the GitHub repository (and optionally a ref glob) and what it may do in one registry
-- repository (or `<org>/*`) of the trusting org. No secret is stored.

CREATE TABLE IF NOT EXISTS registry_oidc_trusts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github')),
  subject_repository TEXT NOT NULL,
  subject_ref TEXT,
  repository TEXT NOT NULL,
  push INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS registry_oidc_trusts_subject_idx ON registry_oidc_trusts (provider, subject_repository);
CREATE INDEX IF NOT EXISTS registry_oidc_trusts_org_idx ON registry_oidc_trusts (org_id);
