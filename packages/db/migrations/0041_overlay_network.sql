-- Managed private overlay (docs/CLUSTERING.md §4.1, phase C1). Additive only.
-- Existing nodes keep network_mode 'external' and their public_address, so host-provisioned
-- WireGuard and bring-your-own networks keep working. A managed join allocates one /32 from the
-- install's overlay CIDR and stores only the node's public key; the private key never leaves the
-- node (helper keygen).

ALTER TABLE nodes ADD COLUMN private_address TEXT;
ALTER TABLE nodes ADD COLUMN private_cidr TEXT;
ALTER TABLE nodes ADD COLUMN wg_public_key TEXT;
ALTER TABLE nodes ADD COLUMN network_mode TEXT NOT NULL DEFAULT 'external'
  CHECK (network_mode IN ('skiff', 'external', 'edge'));
ALTER TABLE nodes ADD COLUMN wg_endpoint TEXT;
ALTER TABLE nodes ADD COLUMN wg_listen_port INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS nodes_private_address_idx
  ON nodes (private_address) WHERE private_address IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS nodes_wg_public_key_idx
  ON nodes (wg_public_key) WHERE wg_public_key IS NOT NULL;
