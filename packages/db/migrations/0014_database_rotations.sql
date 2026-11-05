-- Database credential rotation (docs/DATABASES.md §4). Additive only.
-- The new secret waits here until the node confirms ALTER ROLE; a failed rotation leaves the
-- live secret untouched.

CREATE TABLE IF NOT EXISTS database_rotations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','monitor')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','ok','failed')),
  secret_sealed TEXT NOT NULL,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS database_rotations_database_idx ON database_rotations (database_id, created_at);
