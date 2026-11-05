-- Explicit restart controls (docs/DATABASES.md §11). Additive only.
-- A database restart bumps restart_generation, which is folded into the activation version so the
-- agent re-applies the unit. A pooler restart is a small request flag acknowledged by the node.

ALTER TABLE databases ADD COLUMN restart_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN pooler_restart_requested_at INTEGER;
