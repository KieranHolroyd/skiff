-- Observability dashboards (D101). Additive only.
-- A dashboard is an org resource: a title plus a JSON spec (panels, queries, variables, layout)
-- validated by `dashboardSpecSchema` in @skiff/contracts. `version` increments on every save so
-- concurrent editors get a conflict instead of silently overwriting each other.

CREATE TABLE IF NOT EXISTS observability_dashboards (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	tags_json TEXT NOT NULL DEFAULT '[]',
	spec_json TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 1,
	created_by TEXT,
	updated_by TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS observability_dashboards_org ON observability_dashboards (org_id, updated_at);
