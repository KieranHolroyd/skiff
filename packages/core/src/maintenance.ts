import { lt } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupRuns, deployments, shareLinks, shareRedemptions } from '@skiff/db';
import { operationLimits } from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ALERT_AFTER_MS } from './nodes.ts';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Certificates closer than this to expiry alert (DESIGN §8); closer than the second, critically. */
export const CERT_WARN_MS = 14 * DAY_MS;
export const CERT_CRITICAL_MS = 3 * DAY_MS;
/** How long after a promote the 5xx comparison keeps running (DESIGN §8 "5xx spike after promote"). */
export const PROMOTE_WATCH_MS = 30 * MINUTE_MS;
/** Thresholds: enough traffic to judge, a real error rate, and clearly worse than before. */
export const SPIKE_MIN_REQUESTS = 20;
export const SPIKE_MIN_RATIO = 0.05;
export const SPIKE_FACTOR = 2;
const PARQUET_STATE_KEY = 'telemetry:parquet_exported_day';

export interface MaintenanceReport {
	projectsPurged: number;
	uploadsExpired: number;
	nodesOffline: number;
	logsPruned: number;
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
		// Expire scheduler leases from crashed workers; this is the only periodic loop (F4).
		this.ctx.scheduler.tick();
		const projectsPurged = await this.ctx.projects.purgeExpired();
		// Trashed databases past their window are handed to their node, which deletes the data (D59).
		this.ctx.databases.requestExpiredPurges();
		this.ctx.databases.tickBackups();
		await this.ctx.databases.pruneBackups();
		this.ctx.storage.requestExpiredPurges();
		// Cheap, certain cleanup runs every sweep; prune is the on-demand deep backstop.
		this.cleanupRows();
		this.ctx.releases.gcSnapshots(operationLimits.pruneGraceMs);
		this.ctx.operations.expireAndPrune();
		// Rename redirects older than 30 days release their slug (DESIGN §5.1).
		this.ctx.projects.pruneExpiredRedirects();
		const uploadsExpired = this.ctx.uploads.expireStale();
		const logsPruned = this.ctx.logs.prune(this.ctx.now());
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

		// Disk pressure and certificate expiry come from the stats each agent reports in heartbeats.
		const nodesWithStats = this.ctx.sqlite
			.query<{ id: string; name: string; stats_json: string | null }, []>('SELECT id, name, stats_json FROM nodes')
			.all();
		for (const node of nodesWithStats) {
			if (!node.stats_json) continue;
			try {
				const stats = JSON.parse(node.stats_json) as {
					diskUsedBytes?: number;
					diskTotalBytes?: number;
					certs?: Array<{ host?: unknown; notAfter?: unknown }>;
				};
				alertsFired.push(...(await this.certAlerts(node, stats.certs)));
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

		alertsFired.push(...(await this.databaseAlerts()));
		alertsFired.push(...(await this.storageAlerts()));

		alertsFired.push(...(await this.promoteSpikeAlerts()));

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

		return {
			projectsPurged,
			uploadsExpired,
			nodesOffline: stale.length,
			logsPruned,
			alertsFired,
			telemetry,
		};
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

	/**
	 * One alert per certificate (host + expiry) when it is under 14 days from expiry, and a second,
	 * critical one under 3 days. Keying on `notAfter` means a renewed certificate alerts afresh
	 * next cycle, while a stuck one doesn't page every 30 minutes.
	 */
	private async certAlerts(node: { id: string; name: string }, certs: unknown): Promise<string[]> {
		if (!Array.isArray(certs)) return [];
		const fired: string[] = [];
		const now = this.ctx.now();
		for (const cert of certs as Array<{ host?: unknown; notAfter?: unknown }>) {
			if (typeof cert?.host !== 'string' || typeof cert.notAfter !== 'string') continue;
			const notAfter = Date.parse(cert.notAfter);
			if (!Number.isFinite(notAfter)) continue;
			const remaining = notAfter - now;
			if (remaining >= CERT_WARN_MS) continue;
			const critical = remaining < CERT_CRITICAL_MS;
			const key = `cert:${critical ? 'critical' : 'warning'}:${cert.host}:${cert.notAfter}`;
			if (this.alertSeen(key)) continue;
			const days = remaining / DAY_MS;
			fired.push(key);
			await this.notify({
				key,
				title: remaining <= 0 ? 'TLS certificate expired' : 'TLS certificate expiring',
				detail:
					remaining <= 0
						? `The certificate for ${cert.host} on node ${node.name} expired at ${cert.notAfter}. Check the Cloudflare DNS-01 token and Caddy logs.`
						: `The certificate for ${cert.host} on node ${node.name} expires in ${days.toFixed(1)} days (${cert.notAfter}). Caddy normally renews ~30 days ahead; check the Cloudflare DNS-01 token and Caddy logs.`,
				severity: critical ? 'critical' : 'warning',
			});
		}
		return fired;
	}

	/**
	 * For deployments promoted in the last 30 minutes, compare the production host's 5xx ratio since
	 * the promote with an equally long window before it. Fires once per deployment. Fail-open: no
	 * telemetry, no alert.
	 */
	private async promoteSpikeAlerts(): Promise<string[]> {
		const telemetry = this.ctx.telemetry;
		if (!telemetry?.available) return [];
		const now = this.ctx.now();
		const fired: string[] = [];
		for (const deployment of this.ctx.deployments.recentlyPromoted(now - PROMOTE_WATCH_MS)) {
			const key = `promote_5xx:${deployment.id}`;
			if (this.alertSeen(key)) continue;
			const host = `${deployment.slug}.${this.ctx.config.contentDomain}`;
			const promoteMinute = Math.floor(deployment.promoted_at / MINUTE_MS) * MINUTE_MS;
			const windowMs = Math.max(MINUTE_MS, Math.floor(now / MINUTE_MS) * MINUTE_MS - promoteMinute + MINUTE_MS);
			try {
				const after = await this.windowTotals(host, promoteMinute, now);
				const before = await this.windowTotals(host, promoteMinute - windowMs, promoteMinute - 1);
				const spike = isPromoteSpike(before, after);
				if (!spike) continue;
				fired.push(key);
				const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
				await this.notify({
					key,
					title: '5xx spike after promote',
					detail:
						`${deployment.slug}: ${pct(spike.afterRatio)} of ${after.requests} requests returned 5xx since deployment ` +
						`${deployment.short_id} was promoted (before: ${before.requests ? pct(spike.beforeRatio) : 'no traffic'}). ` +
						`Consider \`skif rollback ${deployment.slug}\` or the rollback tool.`,
					severity: 'critical',
				});
			} catch (error) {
				console.error('[maintenance] 5xx check failed:', error);
			}
		}
		return fired;
	}

	private async windowTotals(host: string, from: number, to: number): Promise<{ requests: number; status5xx: number }> {
		const points = await this.ctx.telemetry!.query({ host, from, to, interval: '1m' });
		return points.reduce(
			(sum, point) => ({ requests: sum.requests + point.requests, status5xx: sum.status5xx + point.status5xx }),
			{ requests: 0, status5xx: 0 },
		);
	}

	private alertSeen(key: string): boolean {
		return Boolean(
			this.ctx.sqlite.query<{ key: string }, [string]>('SELECT key FROM alert_state WHERE key = ?').get(key),
		);
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

	/** Managed databases near their storage budget or connection limit (D57). */
	private async databaseAlerts(): Promise<string[]> {
		const fired: string[] = [];
		for (const { row, ratio } of this.ctx.databases.alertCandidates()) {
			const key = `database_storage:${row.id}`;
			fired.push(key);
			await this.notify({
				key,
				title: 'Database storage above 85%',
				detail: `Database ${row.name} uses ${(ratio * 100).toFixed(1)}% of its ${row.storageMb} MB storage budget.`,
				severity: ratio >= 0.95 ? 'critical' : 'warning',
			});
		}
		if (!this.ctx.telemetry?.available) return fired;
		const samples = await this.ctx.telemetry.latestDatabaseMetrics(this.ctx.now() - 5 * 60_000);
		for (const sample of samples) {
			if (!sample.up || sample.maxConnections <= 0) continue;
			const ratio = sample.connectionsTotal / sample.maxConnections;
			if (ratio < 0.9) continue;
			const key = `database_connections:${sample.databaseId}`;
			fired.push(key);
			await this.notify({
				key,
				title: 'Database connections above 90%',
				detail: `Database ${sample.databaseId} has ${sample.connectionsTotal} of ${sample.maxConnections} connections in use.`,
				severity: 'warning',
			});
		}
		return fired;
	}

	/** Managed object storage near its storage budget (S7). */
	private async storageAlerts(): Promise<string[]> {
		const fired: string[] = [];
		for (const { row, ratio } of this.ctx.storage.alertCandidates()) {
			const key = `storage_usage:${row.id}`;
			fired.push(key);
			await this.notify({
				key,
				title: 'Object storage above 85%',
				detail: `Storage ${row.name} uses ${(ratio * 100).toFixed(1)}% of its ${row.storageMb} MB budget.`,
				severity: ratio >= 0.95 ? 'critical' : 'warning',
			});
		}
		return fired;
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

/**
 * The 5xx-after-promote rule: at least 20 requests since the promote, a 5xx ratio of 5% or more,
 * and at least double the ratio before (or 5xx where there were none). Returns the ratios on a hit.
 */
export function isPromoteSpike(
	before: { requests: number; status5xx: number },
	after: { requests: number; status5xx: number },
): { beforeRatio: number; afterRatio: number } | null {
	if (after.requests < SPIKE_MIN_REQUESTS) return null;
	const afterRatio = after.status5xx / after.requests;
	if (afterRatio < SPIKE_MIN_RATIO) return null;
	const beforeRatio = before.requests > 0 ? before.status5xx / before.requests : 0;
	if (beforeRatio > 0 && afterRatio < beforeRatio * SPIKE_FACTOR) return null;
	return { beforeRatio, afterRatio };
}
