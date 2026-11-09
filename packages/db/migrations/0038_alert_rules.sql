-- Metric alert rules over the ClickHouse telemetry store (docs/ALERTS.md, D109). Additive only.
--
-- A rule is an org resource: a JSON spec (query, condition, timing, routing) validated by
-- `alertRuleInputSchema` in @yoal/contracts. Each series a rule's query returns has one row in
-- `alert_instances` holding its state machine (normal → pending → firing, or nodata).
-- `alert_events` is the history: state changes, notifications and their per-channel outcome,
-- rule errors, and the platform's built-in system alerts. Silences mute notifications only.

CREATE TABLE IF NOT EXISTS alert_rules (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL,
	name TEXT NOT NULL,
	spec_json TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	version INTEGER NOT NULL DEFAULT 1,
	health TEXT NOT NULL DEFAULT 'unknown',
	last_error TEXT,
	error_since INTEGER,
	error_notified INTEGER NOT NULL DEFAULT 0,
	last_evaluated_at INTEGER,
	next_eval_at INTEGER NOT NULL DEFAULT 0,
	created_by TEXT,
	updated_by TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS alert_rules_org ON alert_rules (org_id, name);
CREATE INDEX IF NOT EXISTS alert_rules_due ON alert_rules (enabled, next_eval_at);

CREATE TABLE IF NOT EXISTS alert_instances (
	rule_id TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	labels_json TEXT NOT NULL DEFAULT '{}',
	state TEXT NOT NULL DEFAULT 'normal',
	value REAL,
	state_since INTEGER NOT NULL,
	active_since INTEGER,
	cleared_since INTEGER,
	last_seen_at INTEGER,
	last_evaluated_at INTEGER NOT NULL,
	notified_at INTEGER,
	notified_state TEXT,
	acknowledged_by TEXT,
	acknowledged_at INTEGER,
	PRIMARY KEY (rule_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS alert_instances_state ON alert_instances (state);

CREATE TABLE IF NOT EXISTS alert_events (
	id TEXT PRIMARY KEY,
	org_id TEXT,
	rule_id TEXT,
	kind TEXT NOT NULL,
	fingerprint TEXT,
	labels_json TEXT NOT NULL DEFAULT '{}',
	from_state TEXT,
	to_state TEXT,
	value REAL,
	severity TEXT NOT NULL DEFAULT 'info',
	title TEXT NOT NULL,
	detail TEXT NOT NULL DEFAULT '',
	delivery_json TEXT,
	at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS alert_events_org_at ON alert_events (org_id, at);
CREATE INDEX IF NOT EXISTS alert_events_rule_at ON alert_events (rule_id, at);
CREATE INDEX IF NOT EXISTS alert_events_at ON alert_events (at);

CREATE TABLE IF NOT EXISTS alert_silences (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL,
	rule_id TEXT,
	matchers_json TEXT NOT NULL DEFAULT '[]',
	starts_at INTEGER NOT NULL,
	ends_at INTEGER NOT NULL,
	comment TEXT NOT NULL DEFAULT '',
	created_by TEXT,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS alert_silences_org ON alert_silences (org_id, ends_at);
