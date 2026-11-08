-- Registry quota and usage (docs/REGISTRY.md §6.3, QUOTAS.md). Additive only.
-- `registry_repositories.bytes` is the sampled size of a repository's images (each image's
-- layers + config, shared layers counted once per image). `registry_bytes` limits an org's (or a
-- project's linked repositories') total; NULL/-1 is unlimited. Over the limit, pushes are refused
-- at the token realm; pulls never are.

ALTER TABLE registry_repositories ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE registry_repositories ADD COLUMN bytes_sampled_at INTEGER;
ALTER TABLE org_quotas ADD COLUMN registry_bytes INTEGER DEFAULT -1;
ALTER TABLE project_quotas ADD COLUMN registry_bytes INTEGER;
