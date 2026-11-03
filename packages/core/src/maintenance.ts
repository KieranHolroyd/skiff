import { eq, lt, sql } from 'drizzle-orm';
import { backupRuns, deployments, projects, shareLinks, shareRedemptions } from '@skiff/db';
import type { CoreContext } from './context.ts';
import { ALERT_AFTER_MS } from './nodes.ts';

export interface MaintenanceReport {
	projectsPurged: number;
	uploadsExpired: number;
	nodesOffline: number;
	alertsFired: string[];
	telemetry?: { rolledUp: number; pruned: { raw: number; hourly: number } };
}

/**
 * The single periodic job (every 60 s): trash purge, expired uploads, offline detection, alerting
 * and telemetry rollups. Keeping it idempotent makes restarts and multiple control planes safe.
 */
export class MaintenanceService {
	constructor(private readonly ctx: CoreContext) {}

	async run(): Promise<MaintenanceReport> {
		const projectsPurged = this.ctx.projects.purgeExpired();
		const uploadsExpired = this.ctx.uploads.expireStale();
		const stale = this.ctx.nodes.markStale();
		const alertsFired: string[] = [];

		for (const node of stale) {
			if (node.offlineForMs >= ALERT_AFTER_MS) {
				alertsFired.push(`node_offline:${node.nodeId}`);
				await this.notify({
					key: `node_offline:${node.nodeId}`,
					title: 'Node offline',
					detail: `Node ${node.nodeId} has not sent a heartbeat for ${Math.round(node.offlineForMs / 1000)}s.`,
					severity: 'critical',
				});
			}
		}

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
				const pruned = await this.ctx.telemetry.prune();
				telemetry = { rolledUp, pruned };
			} catch (error) {
				console.error('[maintenance] telemetry failed:', error);
			}
		}

		return { projectsPurged, uploadsExpired, nodesOffline: stale.length, alertsFired, telemetry };
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

export const _unused = [eq, projects, sql];
