-- Postgres extensions and slow queries (docs/DATABASES.md §10). Additive only.

ALTER TABLE databases ADD COLUMN extensions_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE databases ADD COLUMN slow_queries_json TEXT;
ALTER TABLE databases ADD COLUMN slow_queries_at INTEGER;
