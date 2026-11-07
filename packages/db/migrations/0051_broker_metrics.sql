-- Broker metrics (docs/BROKERS.md §7, D123). Additive only.
-- The node agent samples each broker once a minute over its own client connection. The time
-- series goes to ClickHouse when it is installed; the newest totals and the stream listing land
-- here so the dashboard, API and /metrics show them without ClickHouse.

ALTER TABLE brokers ADD COLUMN store_bytes INTEGER;
ALTER TABLE brokers ADD COLUMN messages INTEGER;
-- The newest `BrokerQueueSnapshot.streams` as JSON (at most 200 streams).
ALTER TABLE brokers ADD COLUMN queue_stats TEXT;
ALTER TABLE brokers ADD COLUMN queue_stats_truncated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE brokers ADD COLUMN stats_at INTEGER;
