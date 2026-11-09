/**
 * The failover controller's status (docs/CLUSTERING.md §8.3, §12.3): wire types and the text
 * `yoal ha status` prints. Types mirror `FailoverStatusView` in packages/contracts/src/failover.ts;
 * the CLI bundle stays free of runtime dependencies (D40), so keep them in sync.
 */
import { formatTime, renderTable, truncate } from './output.ts';

export interface HaEventView {
	id: string;
	kind: 'replica' | 'ingress' | 'database' | 'lease';
	status: string;
	stage: string;
	subjectId: string;
	subjectName: string | null;
	fromNodeId: string | null;
	fromNodeName: string | null;
	toNodeId: string | null;
	toNodeName: string | null;
	reason: string;
	epoch: number;
	detectedAt: string;
	appliedAt: string | null;
	finishedAt: string | null;
}

export interface HaStatusView {
	enabled: boolean;
	policy: {
		graceSeconds: number;
		replicaGraceSeconds: number;
		maxPerMinute: number;
		perTargetPerMinute: number;
		queueExpirySeconds: number;
		leaseTtlSeconds: number;
		tickSeconds: number;
	};
	lease: { state: string; epoch: number; holderId: string | null; self: boolean; expiresAt: string | null };
	lastTickAt: string | null;
	nodes: Array<{
		id: string;
		name: string;
		zone: string;
		status: string;
		silentSeconds: number | null;
		lost: boolean;
		replicaFailoverAt: string | null;
		copies: number;
	}>;
	ingress: {
		driver: string;
		steers: boolean;
		rotates: boolean;
		nodes: Array<{ id: string; name: string; healthy: boolean; inRotation: boolean; pinned: boolean }>;
	};
	databases: Array<{
		name: string;
		nodeName: string | null;
		primaryLost: boolean;
		replicas: number;
		candidate: { nodeName: string | null; nodeId: string } | null;
		refusals: string[];
		automatic: boolean;
	}>;
	counts: { lastMinute: number; inProgress: number; queued: number };
	recent: HaEventView[];
}

export function formatHaStatus(view: HaStatusView, options: { events?: number } = {}): string {
	const lines: string[] = [];
	const lease = view.lease;
	lines.push(
		`Automatic failover: ${view.enabled ? 'on' : 'off (drains still move replica copies)'}`,
		`Lease: ${lease.state}${lease.epoch ? ` at epoch ${lease.epoch}` : ''}${lease.holderId ? `, held by ${lease.holderId}${lease.self ? ' (this control plane)' : ''}` : ''}${lease.expiresAt ? `, expires ${formatTime(lease.expiresAt)}` : ''}`,
		`Last tick: ${formatTime(view.lastTickAt ?? undefined)} · every ${view.policy.tickSeconds}s`,
		`Policy: node lost after ${view.policy.graceSeconds}s, copies move after ${view.policy.replicaGraceSeconds}s, ` +
			`${view.policy.maxPerMinute}/min fleet-wide, ${view.policy.perTargetPerMinute}/min per target, queue expires after ${Math.round(view.policy.queueExpirySeconds / 60)} min`,
		`Actions: ${view.counts.lastMinute} in the last minute, ${view.counts.inProgress} in progress, ${view.counts.queued} waiting`,
		'',
		renderTable(
			['NODE', 'ZONE', 'STATUS', 'SILENT', 'LOST', 'COPIES', 'COPIES MOVE AT'],
			view.nodes.map((node) => [
				node.name,
				node.zone,
				node.status,
				node.silentSeconds === null ? '-' : `${node.silentSeconds}s`,
				node.lost ? 'yes' : 'no',
				String(node.copies),
				formatTime(node.replicaFailoverAt ?? undefined),
			]),
		),
	);
	lines.push('', `Ingress (${view.ingress.driver}): ${view.ingress.rotates ? 'record set tracked; withdrawals and re-adds are manual DNS steps' : 'no record set to rotate'}`);
	if (view.ingress.nodes.length)
		lines.push(
			renderTable(
				['INGRESS', 'HEALTHY', 'IN ROTATION', 'PINNED'],
				view.ingress.nodes.map((node) => [node.name, yes(node.healthy), yes(node.inRotation), yes(node.pinned)]),
			),
		);
	if (view.databases.length) {
		lines.push(
			'',
			renderTable(
				['DATABASE', 'PRIMARY', 'LOST', 'REPLICAS', 'CANDIDATE', 'AUTOMATIC'],
				view.databases.map((database) => [
					database.name,
					database.nodeName ?? '-',
					yes(database.primaryLost),
					String(database.replicas),
					database.candidate ? (database.candidate.nodeName ?? database.candidate.nodeId) : `none (${truncate(database.refusals.join('; ') || 'no replica', 50)})`,
					yes(database.automatic),
				]),
			),
		);
	}
	if (options.events === 0) return lines.join('\n');
	const events = view.recent.slice(0, options.events ?? 10);
	lines.push('', events.length ? 'Recent events:' : 'No failover events yet.');
	if (events.length)
		lines.push(
			renderTable(
				['WHEN', 'KIND', 'STATUS', 'SUBJECT', 'FROM', 'TO', 'REASON'],
				events.map((event) => [
					formatTime(event.detectedAt),
					event.kind,
					event.status,
					truncate(event.subjectName ?? event.subjectId, 28),
					event.fromNodeName ?? event.fromNodeId ?? '-',
					event.toNodeName ?? event.toNodeId ?? '-',
					truncate(event.reason, 70),
				]),
			),
		);
	return lines.join('\n');
}

function yes(value: boolean): string {
	return value ? 'yes' : 'no';
}
