-- More database engines (docs/DATABASES.md §17, D95). Additive only.
-- 0008 created `databases.engine` with CHECK (engine IN ('postgres')), and SQLite cannot change a
-- CHECK constraint without rebuilding the table, which the additive-migration rule forbids. The
-- engine therefore moves to a new, unconstrained column; the engine registry in @skiff/contracts
-- validates it (D61), so a future engine is a data change and never another migration.
--
-- Existing rows are all Postgres, which is the default. The old `engine` column is no longer read
-- or written by the service layer and keeps its 'postgres' default. A release rolled back with
-- `--keep-db` still reads it, so it sees every database as Postgres and never crashes on an
-- engine it does not know.

ALTER TABLE databases ADD COLUMN engine_name TEXT NOT NULL DEFAULT 'postgres';
