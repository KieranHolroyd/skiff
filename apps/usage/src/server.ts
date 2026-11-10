import { Database } from 'bun:sqlite';
import { handleUsageRequest, RateLimiter } from './http.ts';
import type { UsageConfig } from './config.ts';
import { UsageStore } from './store.ts';

/**
 * Run the collector (docs/USAGE-ANALYTICS.md).
 *
 * One Bun process, one SQLite file in WAL mode. It listens on loopback behind Caddy like every
 * other Yoal service, so TLS, request-size limits and the public hostname are Caddy's job.
 */

export interface UsageServer {
	server: ReturnType<typeof Bun.serve>;
	store: UsageStore;
	db: Database;
	stop(): void;
}

export function startUsageServer(config: UsageConfig): UsageServer {
	const db = new Database(config.dbPath, { create: true });
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA synchronous = NORMAL');
	db.run('PRAGMA busy_timeout = 5000');
	const store = new UsageStore(db, config.retentionDays);
	// A restart should not delete anything; the window is the retention policy.
	store.prune();

	const log = (message: string) => console.log(`[usage] ${message}`);
	const limiter = new RateLimiter(60, 60_000);

	const server = Bun.serve({
		hostname: config.host,
		port: config.port,
		// The collector never needs a large request; refuse before buffering it.
		maxRequestBodySize: 64 * 1024,
		fetch: (request) =>
			handleUsageRequest(request, {
				store,
				version: config.version,
				adminToken: config.adminToken,
				trustProxy: config.trustProxy,
				limiter,
				log
			}).catch((error: unknown) => {
				// A failure to handle one ping must never take the collector down.
				log(`request failed: ${(error as Error).message}`);
				return new Response(JSON.stringify({ error: 'internal_error' }), {
					status: 500,
					headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
				});
			})
	});

	return {
		server,
		store,
		db,
		stop() {
			server.stop();
			db.close();
		}
	};
}
