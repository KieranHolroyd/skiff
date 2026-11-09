import type {
	BuildView,
	DatabaseView,
	DomainView,
	QuotaWarning,
	StorageView
} from '@yoal/contracts';
import type { DeploymentView, NodeView } from '@yoal/core';
import { QUOTA_FIELDS } from '../settings/usage/quota-fields.js';

/** Something on the fleet that wants a person's attention, most severe first. */
export interface AttentionItem {
	id: string;
	tone: 'danger' | 'warning' | 'info';
	kind: 'node' | 'database' | 'storage' | 'deployment' | 'build' | 'domain' | 'quota';
	title: string;
	detail: string | null;
	href: string;
}

export interface AttentionInput {
	now: number;
	nodes: NodeView[];
	databases: DatabaseView[] | null;
	storage: StorageView[] | null;
	/** Newest first. */
	deployments: DeploymentView[];
	/** Newest first. */
	builds: BuildView[];
	domains: DomainView[] | null;
	quotaWarnings: QuotaWarning[];
}

const DAY_MS = 86_400_000;
const MB = 1024 * 1024;

function nodeNumber(stats: unknown, key: string): number | null {
	if (!stats || typeof stats !== 'object') return null;
	const value = (stats as Record<string, unknown>)[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * What on the fleet needs a person, most severe first. Only current problems count: a failed
 * deploy already fixed by a later one is dropped, and a service down because its node is offline
 * is folded into that node's item.
 */
export function buildAttention(input: AttentionInput): AttentionItem[] {
	const { now, nodes, databases, storage, deployments, builds, domains } = input;
	const recent = (iso: string | null) => iso !== null && now - Date.parse(iso) < DAY_MS;

	const attention: AttentionItem[] = [];
	// A service on an offline node is down because of the node; report it once, on the node.
	const offline = new Set(nodes.filter((node) => node.status === 'offline').map((node) => node.id));
	const strandedOn = (nodeId: string) => [
		...(databases ?? []).filter((db) => db.nodeId === nodeId).map((db) => db.name),
		...(storage ?? []).filter((st) => st.nodeId === nodeId).map((st) => st.name)
	];
	for (const node of nodes) {
		if (node.status === 'offline') {
			const stranded = strandedOn(node.id);
			attention.push({
				id: `node:${node.id}`,
				tone: 'danger',
				kind: 'node',
				title: `Node ${node.name} is offline`,
				detail: [
					node.lastHeartbeatAt
						? 'Sites placed on it are not being served.'
						: 'It has never sent a heartbeat.',
					stranded.length > 0
						? `${stranded.join(', ')} ${stranded.length === 1 ? 'runs' : 'run'} on it and ${stranded.length === 1 ? 'is' : 'are'} unavailable too.`
						: null
				]
					.filter(Boolean)
					.join(' '),
				href: '/nodes'
			});
		}
		const used = nodeNumber(node.stats, 'diskUsedBytes');
		const total = nodeNumber(node.stats, 'diskTotalBytes');
		if (used !== null && total && used / total >= 0.9)
			attention.push({
				id: `disk:${node.id}`,
				tone: 'warning',
				kind: 'node',
				title: `${node.name} is ${Math.round((used / total) * 100)}% full`,
				detail:
					'Builds and new releases fail when the disk fills. Prune old data under Maintenance.',
				href: '/settings/maintenance'
			});
	}
	for (const db of databases ?? []) {
		const href = `/databases/${encodeURIComponent(db.name)}`;
		if (db.status === 'failed' && !offline.has(db.nodeId))
			attention.push({
				id: `db:${db.id}`,
				tone: 'danger',
				kind: 'database',
				title: `Database ${db.name} has failed`,
				detail: db.message ?? 'Its logs usually say why.',
				href: `${href}/logs`
			});
		else if (db.backup.lastBackupStatus === 'failed')
			attention.push({
				id: `backup:${db.id}`,
				tone: 'warning',
				kind: 'database',
				title: `The last backup of ${db.name} failed`,
				detail: db.backup.lastBackupError,
				href: `${href}?tab=backups`
			});
		if (db.sizeBytes !== null && db.storageMb > 0 && db.sizeBytes / (db.storageMb * MB) >= 0.85)
			attention.push({
				id: `dbsize:${db.id}`,
				tone: 'warning',
				kind: 'database',
				title: `${db.name} is ${Math.round((db.sizeBytes / (db.storageMb * MB)) * 100)}% of its storage`,
				detail: 'Resize it under Settings before writes start failing.',
				href: `${href}?tab=settings`
			});
	}
	for (const st of storage ?? []) {
		const href = `/storage/${encodeURIComponent(st.name)}`;
		if (st.status === 'failed' && !offline.has(st.nodeId))
			attention.push({
				id: `st:${st.id}`,
				tone: 'danger',
				kind: 'storage',
				title: `Storage ${st.name} has failed`,
				detail: st.message ?? 'Its logs usually say why.',
				href: `${href}/logs`
			});
		if (st.usedBytes !== null && st.storageMb > 0 && st.usedBytes / (st.storageMb * MB) >= 0.85)
			attention.push({
				id: `stsize:${st.id}`,
				tone: 'warning',
				kind: 'storage',
				title: `${st.name} is ${Math.round((st.usedBytes / (st.storageMb * MB)) * 100)}% full`,
				detail: 'Uploads are refused once it reaches its budget.',
				href: `${href}?tab=settings`
			});
	}
	// Only the newest outcome per project counts: a failure already fixed by a later success is noise.
	const latestDeploy = new Map<string, DeploymentView>();
	for (const deployment of deployments)
		if (!latestDeploy.has(deployment.projectSlug))
			latestDeploy.set(deployment.projectSlug, deployment);
	for (const deployment of latestDeploy.values())
		if (deployment.status === 'failed' && recent(deployment.createdAt))
			attention.push({
				id: `deploy:${deployment.id}`,
				tone: 'warning',
				kind: 'deployment',
				title: `The latest deployment of ${deployment.projectSlug} failed`,
				detail: deployment.message,
				href: `/projects/${encodeURIComponent(deployment.projectSlug)}?tab=deployments`
			});
	const latestBuild = new Map<string, BuildView>();
	for (const build of builds)
		if (!latestBuild.has(build.projectSlug)) latestBuild.set(build.projectSlug, build);
	for (const build of latestBuild.values())
		if (build.status === 'failed' && recent(build.finishedAt ?? build.createdAt))
			attention.push({
				id: `build:${build.id}`,
				tone: 'warning',
				kind: 'build',
				title: `The latest build of ${build.projectSlug} failed`,
				detail: build.error,
				href: `/projects/${encodeURIComponent(build.projectSlug)}?tab=builds`
			});
	for (const domain of domains ?? [])
		if (domain.status === 'failed')
			attention.push({
				id: `domain:${domain.id}`,
				tone: 'warning',
				kind: 'domain',
				title: `${domain.hostname} could not be verified`,
				detail: domain.lastError,
				href: `/projects/${encodeURIComponent(domain.projectSlug)}?tab=domains`
			});
	const pendingDomains = (domains ?? []).filter((domain) => domain.status === 'pending');
	if (pendingDomains.length > 0)
		attention.push({
			id: 'domains:pending',
			tone: 'info',
			kind: 'domain',
			title:
				pendingDomains.length === 1
					? `${pendingDomains[0]!.hostname} is waiting for its DNS record`
					: `${pendingDomains.length} domains are waiting for their DNS records`,
			detail: 'They go live once the verification record resolves.',
			href:
				pendingDomains.length === 1
					? `/projects/${encodeURIComponent(pendingDomains[0]!.projectSlug)}?tab=domains`
					: '/projects'
		});
	for (const warning of input.quotaWarnings)
		attention.push({
			id: `quota:${warning.metric}`,
			tone: warning.percent >= 100 ? 'danger' : 'warning',
			kind: 'quota',
			title: `${QUOTA_FIELDS[warning.metric].label} is at ${Math.round(warning.percent)}% of its limit`,
			detail: 'Requests that would go over the limit are refused.',
			href: '/settings/usage'
		});
	const severity = { danger: 0, warning: 1, info: 2 } as const;
	attention.sort((a, b) => severity[a.tone] - severity[b.tone]);
	return attention;
}
