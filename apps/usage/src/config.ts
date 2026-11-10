import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Configuration for the usage collector (docs/USAGE-ANALYTICS.md).
 *
 * The collector is a plain Bun process with one SQLite file. It is small on purpose: it receives
 * one validated ping per install per day, so a single process and one disk are enough for a very
 * large number of installs, and there is no second database to operate.
 */

export interface UsageConfig {
	host: string;
	port: number;
	dataDir: string;
	dbPath: string;
	/** Bearer token for `GET /api/v1/stats`. Without it the stats route answers 404. */
	adminToken: string | null;
	/** Keep raw pings this long; installs and their latest state are kept indefinitely. */
	retentionDays: number;
	/** Behind Caddy, `X-Forwarded-For` carries the client address used for rate limiting. */
	trustProxy: boolean;
	/** The collector's own version, shown by `/healthz`. */
	version: string;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function loadUsageConfig(env: NodeJS.ProcessEnv = process.env): UsageConfig {
	const dataDir = env.YOAL_USAGE_DATA_DIR?.trim() || '/var/lib/yoal/usage';
	const dbPath = env.YOAL_USAGE_DB?.trim() || join(dataDir, 'usage.db');
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	return {
		host: env.YOAL_USAGE_HOST?.trim() || '127.0.0.1',
		port: integer(env.YOAL_USAGE_PORT, 8790, 1, 65_535),
		dataDir,
		dbPath,
		adminToken: env.YOAL_USAGE_ADMIN_TOKEN?.trim() || null,
		retentionDays: integer(env.YOAL_USAGE_RETENTION_DAYS, 400, 30, 3_650),
		trustProxy: env.YOAL_USAGE_TRUST_PROXY !== '0',
		version: env.YOAL_USAGE_VERSION?.trim() || '0.1.0'
	};
}
