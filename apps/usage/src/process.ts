import { loadUsageConfig } from './config.ts';
import { startUsageServer } from './server.ts';

/**
 * `yoal-usage` entrypoint (docs/USAGE-ANALYTICS.md).
 *
 * Configuration is entirely environment-driven; see `loadUsageConfig`. The process is meant to
 * run as its own systemd unit or Yoal project behind Caddy, not inside the control plane.
 */

const config = loadUsageConfig();
const started = startUsageServer(config);

console.log(
	`[usage] listening on http://${config.host}:${started.server.port} (db ${config.dbPath}, retention ${config.retentionDays}d)`
);
if (!config.adminToken)
	console.log('[usage] YOAL_USAGE_ADMIN_TOKEN is not set: GET /api/v1/stats is disabled.');

let stopping = false;
function shutdown(signal: string): void {
	if (stopping) return;
	stopping = true;
	console.log(`[usage] ${signal}: stopping`);
	started.stop();
	process.exit(0);
}

const signals = process as unknown as {
	on(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
};
signals.on('SIGTERM', () => shutdown('SIGTERM'));
signals.on('SIGINT', () => shutdown('SIGINT'));
