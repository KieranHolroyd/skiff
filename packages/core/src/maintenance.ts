import { lt } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupRuns, deployments, shareLinks, shareRedemptions } from '@skiff/db';
import type { CoreContext } from './context.ts';
import { ALERT_AFTER_MS } from './nodes.ts';

const DAY_MS = 86_400_000;
const PARQUET_STATE_KEY = 'telemetry:parquet_exported_day';

export interface MaintenanceReport {
	projectsPurged: number;
	uploadsExpired: number;
	nodesOffline: number;
	alertsFired: string[];
	telemetry?: { rolledUp: number; pruned: { raw: number; hourly: number }; archivedDay?: string };
}

/**
 * The single periodic job (every 60 s): trash purge, expired uploads, offline detection, alerting
 * and telemetry rollups. Keeping it idempotent makes restarts and multiple control planes safe.
 */
export class MaintenanceService {
	/** When each node was first seen heartbeating with Caddy down (it reports itself offline). */
	private readonly caddyDownSince = new Map<string, number>();

	constructor(private readonly ctx: CoreContext) {}

	async run(): Promise<MaintenanceReport> {
		const projectsPurged = this.ctx.projects.purgeExpired();
		// Rename redirects older than 30 days release their slug (DESIGN §5.1).
		this.ctx.projects.pruneExpiredRedirects();
		const uploadsExpired = this.ctx.uploads.expireStale();
		const stale = this.ctx.nodes.markStale();
		const alertsFired: string[] = [];

		// Evaluate every unhealthy node on every sweep, not only at the moment it flips offline
		// (that happens at ~30 s, before the 2-minute threshold). The notifier's cooldown keeps a
		// long outage from paging every minute.
		const now = this.ctx.now();
		const unhealthy = this.ctx.nodes.unhealthy();
		const caddyDown = new Set<string>();
		for (const node of unhealthy) {
			let offlineForMs = node.offlineForMs;
			if (node.reason === 'caddy_down') {
				caddyDown.add(node.nodeId);
				const since = this.caddyDownSince.get(node.nodeId) ?? now;
				this.caddyDownSince.set(node.nodeId, since);
				offlineForMs = now - since;
			}
			if (offlineForMs === null || offlineForMs < ALERT_AFTER_MS) continue;
			const key = `node_offline:${node.nodeId}`;
			alertsFired.push(key);
			await this.notify({
				key,
				title: 'Node offline',
				detail:
					node.reason === 'no_heartbeat'
						? `Node ${node.name} (${node.nodeId}) has not sent a heartbeat for ${Math.round(offlineForMs / 1000)}s.`
						: `Node ${node.name} (${node.nodeId}) reports its proxy (Caddy) unreachable for ${Math.round(offlineForMs / 1000)}s.`,
				severity: 'critical',
			});
		}
		for (const nodeId of this.caddyDownSince.keys())
			if (!caddyDown.has(nodeId)) this.caddyDownSince.delete(nodeId);

		// Disk pressure and certificate alerts are evaluated by the agent/dashboard when stats exist.
		const nodesWithStats = this.ctx.sqlite
			.query<{ id: string; stats_json: string | null }, []>('SELECT id, stats_json FROM nodes')
			.all();
		for (const node of nodesWithStats) {
			if (!node.stats_json) continue;
			try {
				const stats = JSON.parse(node.stats_json) as { diskUsedBytes?: number; diskTotalBytes?: number };
				if (stats.diskUsedBytes && stats.diskTotalBytes) {
					const used = stats.diskUsedBytes / stats.diskTotalBytes;
					if (used > 0.85) {
						const key = `disk:${node.id}`;
						alertsFired.push(key);
						await this.notify({
							key,
							title: 'Disk usage above 85%',
							detail: `Node ${node.id} is at ${(used * 100).toFixed(1)}% disk usage.`,
							severity: 'warning',
						});
					}
				}
			} catch {
				/* ignore malformed stats */
			}
		}

		let telemetry: MaintenanceReport['telemetry'];
		if (this.ctx.telemetry?.available) {
			try {
				const rolledUp = await this.ctx.telemetry.rollupHourly();
				const archivedDay = await this.archiveTelemetry();
				const pruned = await this.ctx.telemetry.prune();
				telemetry = { rolledUp, pruned, ...(archivedDay ? { archivedDay } : {}) };
			} catch (error) {
				console.error('[maintenance] telemetry failed:', error);
			}
		}

		return { projectsPurged, uploadsExpired, nodesOffline: stale.length, alertsFired, telemetry };
	}

	/**
	 * Archive yesterday's 1-minute telemetry as day-partitioned Parquet in the object store
	 * (DESIGN §8), once per UTC day. The day is still entirely within the 48 h raw window.
	 */
	private async archiveTelemetry(): Promise<string | undefined> {
		const telemetry = this.ctx.telemetry;
		if (!telemetry?.available || !telemetry.archiveEnabled) return undefined;
		const todayStart = Math.floor(this.ctx.now() / DAY_MS) * DAY_MS;
		const day = new Date(todayStart - DAY_MS).toISOString().slice(0, 10);
		const done = this.ctx.sqlite
			.query<{ last_value: string | null }, [string]>('SELECT last_value FROM alert_state WHERE key = ?')
			.get(PARQUET_STATE_KEY);
		if (done?.last_value === day) return undefined;

		const dir = await mkdtemp(join(tmpdir(), 'skiff-parquet-'));
		const errorBefore = telemetry.error;
		try {
			await telemetry.exportParquet({ from: todayStart - DAY_MS, to: todayStart, dir: join(dir, 'out') });
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
		// exportParquet is fail-open; a new error means the archive did not land, so retry later.
		if (telemetry.error !== errorBefore) return undefined;
		this.ctx.sqlite.run(
			'INSERT INTO alert_state (key, last_fired_at, last_value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_fired_at = excluded.last_fired_at, last_value = excluded.last_value',
			[PARQUET_STATE_KEY, this.ctx.now(), day],
		);
		return day;
	}

	/** Record the monthly restore drill outcome; a failure must alert (DESIGN §10). */
	recordBackupRun(kind: 'backup' | 'restore-drill', status: 'running' | 'ok' | 'failed', detail?: string): string {
		const id = `bkr_${crypto.randomUUID().replace(/-/g, '')}`;
		this.ctx.db.insert(backupRuns).values({ id, kind, status, detail: detail ?? null }).run();
		if (status === 'failed')
			void this.notify({
				key: `backup:${kind}`,
				title: `${kind} failed`,
				detail: detail ?? 'No detail provided.',
				severity: 'critical',
			});
		return id;
	}

	/** Delete old soft-deleted deployments and orphaned rows. */
	cleanupRows(): void {
		const cutoff = this.ctx.now() - 30 * 86_400_000;
		this.ctx.db.delete(deployments).where(lt(deployments.deletedAt, cutoff)).run();
		this.ctx.db.delete(shareRedemptions).where(lt(shareRedemptions.expiresAt, cutoff)).run();
		this.ctx.db.delete(shareLinks).where(lt(shareLinks.revokedAt, cutoff)).run();
	}

	private async notify(alert: { key: string; title: string; detail: string; severity: 'info' | 'warning' | 'critical' }): Promise<void> {
		const last = this.ctx.sqlite
			.query<{ last_fired_at: number | null }, [string]>('SELECT last_fired_at FROM alert_state WHERE key = ?')
			.get(alert.key);
		const cooldown = 30 * 60_000;
		if (last?.last_fired_at && this.ctx.now() - last.last_fired_at < cooldown) return;
		this.ctx.sqlite.run(
			'INSERT INTO alert_state (key, last_fired_at, last_value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_fired_at = excluded.last_fired_at, last_value = excluded.last_value',
			[alert.key, this.ctx.now(), alert.detail],
		);
		for (const notifier of this.ctx.notifiers) {
			try {
				await notifier.notify(alert);
			} catch (error) {
				console.error(`[alerts] ${notifier.name} failed:`, error);
			}
		}
	}
}
