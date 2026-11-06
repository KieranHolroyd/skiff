-- Agent capabilities (plan 22 track G follow-up). Additive only.
-- The agent lists what its build can do in every heartbeat, so the control plane can refuse work
-- an older agent would silently drop (a read-only studio principal) instead of waiting forever.
-- NULL until the node's first heartbeat after this migration; `[]` for agents that predate it.

ALTER TABLE nodes ADD COLUMN capabilities_json TEXT;
