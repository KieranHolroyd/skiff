-- Cross-node service endpoints (docs/CLUSTERING.md §4.3, phase C2). Additive only.
-- A consumer node owns one loopback port per attached remote service; the port is stable across
-- provider failover. The provider-side port and the attachment grants are resolved lazily, so no
-- existing same-node attachment changes. Node certificates are public material only; private
-- keys stay on the node.

CREATE TABLE IF NOT EXISTS node_certificates (
  node_id TEXT PRIMARY KEY,
  serial TEXT NOT NULL,
  cert_pem TEXT NOT NULL,
  ca_serial TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS node_certificates_serial_idx ON node_certificates (serial);

CREATE TABLE IF NOT EXISTS service_endpoints (
  id TEXT PRIMARY KEY,
  consumer_node_id TEXT NOT NULL,
  service_kind TEXT NOT NULL CHECK (service_kind IN ('database', 'storage')),
  service_id TEXT NOT NULL,
  local_port INTEGER NOT NULL,
  upstream_node_id TEXT NOT NULL,
  upstream_port INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS service_endpoints_consumer_port_idx
  ON service_endpoints (consumer_node_id, local_port);
CREATE UNIQUE INDEX IF NOT EXISTS service_endpoints_pair_idx
  ON service_endpoints (consumer_node_id, service_kind, service_id);
CREATE INDEX IF NOT EXISTS service_endpoints_upstream_idx
  ON service_endpoints (upstream_node_id);
