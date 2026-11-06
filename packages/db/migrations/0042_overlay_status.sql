-- Overlay peer health (docs/CLUSTERING.md §4.1, phase C1). Additive only.
-- The agent reports the helper's `wg show` output with its heartbeat. Public keys, endpoints and
-- counters only: no private key or config ever reaches the control plane.

ALTER TABLE nodes ADD COLUMN wg_status_json TEXT;
ALTER TABLE nodes ADD COLUMN wg_status_at INTEGER;
