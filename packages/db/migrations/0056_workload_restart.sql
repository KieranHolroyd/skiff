-- Container console restarts (D127). Additive only.
-- A restart bumps the generation, which is folded into the workload's activation version so the
-- agent re-applies the unit and systemd restarts it (the D87 pattern for databases). Zero keeps
-- every existing activation hash unchanged, so the upgrade restarts nothing.

ALTER TABLE workloads ADD COLUMN restart_generation INTEGER NOT NULL DEFAULT 0;
