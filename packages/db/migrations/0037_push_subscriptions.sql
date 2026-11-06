-- Web Push alert subscriptions (D108). Additive only.
-- One row per browser (usually the installed dashboard app) an owner turned push alerts on in.
-- `endpoint` is the push service URL the browser handed out; `p256dh`/`auth` are its RFC 8291
-- encryption keys (base64url). Rows are deleted when the push service answers 404/410 (the
-- browser unsubscribed or the app was removed), when the owner removes the device, and when the
-- user is gone. `user_id` is a Better Auth user id (separate migration stream, so unconstrained).

CREATE TABLE IF NOT EXISTS push_subscriptions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	endpoint TEXT NOT NULL,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	device TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	last_success_at INTEGER,
	last_error TEXT,
	last_error_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint ON push_subscriptions (endpoint);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);
