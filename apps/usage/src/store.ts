import type { Database } from 'bun:sqlite';
import {
	usageCapabilityKeys,
	usageFeatureNames,
	usageMetricKeys,
	type UsageCapability,
	type UsageMetricKey,
	type UsagePing
} from '@yoal/contracts';

/**
 * The collector's storage (docs/USAGE-ANALYTICS.md).
 *
 * Two tables. `installs` is one row per anonymous install with its latest hardware facts and a
 * ping counter; `pings` keeps the validated payloads for a long retention window so a metric added
 * later can be answered retroactively. A ping id is unique, so a sender retrying after a timeout
 * does not double-count.
 */

export interface UsageStats {
	days: number;
	generatedAt: string;
	installs: { total: number; active7d: number; active30d: number };
	pings: { total: number; inWindow: number; last24h: number };
	versions: Array<{ name: string; installs: number }>;
	os: Array<{ name: string; installs: number }>;
	arch: Array<{ name: string; installs: number }>;
	metrics: Record<UsageMetricKey, { installs: number; total: number; average: number }>;
	features: Array<{ name: string; installs: number }>;
	capabilities: Array<{ name: UsageCapability; installs: number }>;
}

const DAY_MS = 86_400_000;

export class UsageStore {
	constructor(
		private readonly db: Database,
		private readonly retentionDays = 400
	) {
		this.migrate();
	}

	private migrate(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS installs (
				install_id TEXT PRIMARY KEY,
				first_seen_at INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL,
				first_version TEXT NOT NULL,
				last_version TEXT NOT NULL,
				os TEXT NOT NULL,
				arch TEXT NOT NULL,
				pings INTEGER NOT NULL DEFAULT 0
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS pings (
				id TEXT PRIMARY KEY,
				install_id TEXT NOT NULL,
				received_at INTEGER NOT NULL,
				sent_at INTEGER NOT NULL,
				version TEXT NOT NULL,
				payload_json TEXT NOT NULL
			)
		`);
		this.db.run('CREATE INDEX IF NOT EXISTS pings_install_idx ON pings (install_id, received_at)');
		this.db.run('CREATE INDEX IF NOT EXISTS pings_received_idx ON pings (received_at)');
	}

	/**
	 * Store one validated ping. `receivedAt` is the collector's clock, never the sender's: a
	 * misconfigured clock on an install must not hide it from the active-install counts.
	 */
	record(ping: UsagePing, receivedAt: number): { stored: boolean } {
		const payload = JSON.stringify(ping);
		return this.db.transaction(() => {
			const inserted = this.db
				.query(
					'INSERT OR IGNORE INTO pings (id, install_id, received_at, sent_at, version, payload_json) VALUES (?, ?, ?, ?, ?, ?)'
				)
				.run(ping.id, ping.installId, receivedAt, Date.parse(ping.sentAt), ping.version, payload);
			// A retry is the same ping: it must not bump the install's counter or move last_seen_at.
			if (inserted.changes === 0) return { stored: false };
			this.db
				.query(
					`INSERT INTO installs (install_id, first_seen_at, last_seen_at, first_version, last_version, os, arch, pings)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 1)
					 ON CONFLICT(install_id) DO UPDATE SET
						last_seen_at = excluded.last_seen_at,
						last_version = excluded.last_version,
						os = excluded.os,
						arch = excluded.arch,
						pings = installs.pings + 1`
				)
				.run(ping.installId, receivedAt, receivedAt, ping.version, ping.version, ping.os, ping.arch);
			this.prune(receivedAt);
			return { stored: true };
		})();
	}

	/** Drop raw pings past the retention window; per-install latest state survives in `installs`. */
	prune(now = Date.now()): number {
		const cutoff = now - this.retentionDays * DAY_MS;
		return this.db.query('DELETE FROM pings WHERE received_at < ?').run(cutoff).changes;
	}

	/** Everyone's latest ping inside the window, for the stats view. One row per install. */
	private latestPayloads(now: number, days: number): UsagePing[] {
		const since = now - days * DAY_MS;
		const rows = this.db
			.query<{ payload_json: string }, [number]>(
				`SELECT payload_json FROM pings p
				 WHERE p.received_at >= ?
				   AND p.received_at = (SELECT MAX(q.received_at) FROM pings q WHERE q.install_id = p.install_id)
				 GROUP BY p.install_id`
			)
			.all(since);
		const pings: UsagePing[] = [];
		for (const row of rows) {
			try {
				pings.push(JSON.parse(row.payload_json) as UsagePing);
			} catch {
				// A row written by an older version that no longer parses is skipped, never fatal.
			}
		}
		return pings;
	}

	private count(sql: string, ...params: Array<string | number>): number {
		return this.db.query<{ count: number }, Array<string | number>>(sql).get(...params)?.count ?? 0;
	}

	stats(now = Date.now(), days = 30): UsageStats {
		const since = now - days * DAY_MS;
		const payloads = this.latestPayloads(now, days);

		const metrics = Object.fromEntries(
			usageMetricKeys.map((key) => [key, { installs: 0, total: 0, average: 0 }])
		) as UsageStats['metrics'];
		for (const ping of payloads) {
			for (const key of usageMetricKeys) {
				const value = ping.metrics[key] ?? 0;
				const bucket = metrics[key];
				bucket.installs += 1;
				bucket.total += value;
			}
		}
		for (const key of usageMetricKeys) {
			const bucket = metrics[key];
			bucket.average = payloads.length > 0 ? Math.round((bucket.total / payloads.length) * 10) / 10 : 0;
		}

		const featureCounts = new Map<string, number>(usageFeatureNames.map((name) => [name, 0]));
		const capabilityCounts = new Map<UsageCapability, number>(
			usageCapabilityKeys.map((name) => [name, 0])
		);
		for (const ping of payloads) {
			for (const name of ping.features) {
				if (featureCounts.has(name)) featureCounts.set(name, featureCounts.get(name)! + 1);
			}
			for (const name of ping.capabilities as UsageCapability[]) {
				if (capabilityCounts.has(name))
					capabilityCounts.set(name, capabilityCounts.get(name)! + 1);
			}
		}

		const installs = this.count('SELECT COUNT(*) AS count FROM installs');
		const active7d = this.count('SELECT COUNT(*) AS count FROM installs WHERE last_seen_at >= ?', now - 7 * DAY_MS);
		const active30d = this.count('SELECT COUNT(*) AS count FROM installs WHERE last_seen_at >= ?', now - 30 * DAY_MS);

		const grouped = (column: 'last_version' | 'os' | 'arch') =>
			this.db
				.query<{ name: string; installs: number }, [number]>(
					`SELECT ${column} AS name, COUNT(*) AS installs FROM installs WHERE last_seen_at >= ? GROUP BY ${column} ORDER BY installs DESC, name`
				)
				.all(since);

		return {
			days,
			generatedAt: new Date(now).toISOString(),
			installs: { total: installs, active7d, active30d },
			pings: {
				total: this.count('SELECT COUNT(*) AS count FROM pings'),
				inWindow: this.count('SELECT COUNT(*) AS count FROM pings WHERE received_at >= ?', since),
				last24h: this.count('SELECT COUNT(*) AS count FROM pings WHERE received_at >= ?', now - DAY_MS)
			},
			versions: grouped('last_version').slice(0, 20),
			os: grouped('os'),
			arch: grouped('arch'),
			metrics,
			features: [...featureCounts]
				.map(([name, installs]) => ({ name, installs }))
				.sort((a, b) => b.installs - a.installs || a.name.localeCompare(b.name)),
			capabilities: ([...capabilityCounts] as Array<[UsageCapability, number]>)
				.map(([name, installs]) => ({ name, installs }))
				.sort((a, b) => b.installs - a.installs || a.name.localeCompare(b.name))
		};
	}
}
