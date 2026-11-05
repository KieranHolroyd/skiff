/**
 * App volumes (plan 07): CLI wire types and pure formatting. The CLI bundle stays free of runtime
 * dependencies (D40), so these mirror `packages/contracts/src/app-volume.ts` and must stay in sync.
 */
import { formatBytes, formatTime, renderTable, truncate } from './output.ts';

export type AppVolumeStatus = 'pending' | 'ready' | 'missing' | 'failed' | 'deleting';

export interface AppVolumeAttachmentView {
	id: string;
	volumeId: string;
	volumeName: string;
	workloadId: string;
	environment: string;
	mountPath: string;
	readOnly: boolean;
	createdAt: string;
}

export interface AppVolumeView {
	id: string;
	orgId: string;
	projectId: string;
	projectSlug: string;
	name: string;
	nodeId: string;
	backing: 'node_volume' | 'state_dir';
	nodeVolume: { id: string; name: string; remote: boolean } | null;
	sizeMb: number;
	usedBytes: number | null;
	mountPath: string;
	status: AppVolumeStatus;
	message: string | null;
	singleWriter: boolean;
	writer: { workloadId: string; environment: string } | null;
	attachments: AppVolumeAttachmentView[];
	snapshots: unknown[];
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
}

export function volumeQuota(view: Pick<AppVolumeView, 'usedBytes' | 'sizeMb'>): string {
	const budget = view.sizeMb * 1024 * 1024;
	if (view.usedBytes === null || view.usedBytes === undefined) return `- / ${formatBytes(budget)}`;
	const percent = budget > 0 ? Math.round((view.usedBytes / budget) * 100) : 0;
	return `${formatBytes(view.usedBytes)} / ${formatBytes(budget)} (${percent}%)`;
}

export function volumeStatusLabel(view: Pick<AppVolumeView, 'status' | 'deletedAt'>): string {
	return view.deletedAt ? 'deleted' : view.status;
}

export function volumeBacking(view: Pick<AppVolumeView, 'backing' | 'nodeVolume'>): string {
	return view.backing === 'node_volume' ? `node:${view.nodeVolume?.name ?? 'removed'}` : 'state-dir';
}

export function volumeTable(volumes: AppVolumeView[]): string {
	const rows = volumes.map((view) => [
		view.name,
		volumeStatusLabel(view),
		volumeBacking(view),
		`${view.sizeMb} MB`,
		volumeQuota(view),
		view.attachments.length
			? truncate(
					view.attachments
						.map((item) => `${item.mountPath}${item.readOnly ? ' (ro)' : ''}`)
						.join(', '),
					36,
				)
			: '-',
		formatTime(view.createdAt),
	]);
	return renderTable(['NAME', 'STATUS', 'BACKING', 'QUOTA', 'USED', 'MOUNTS', 'CREATED'], rows);
}

export function volumeDetails(view: AppVolumeView): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(10)}  ${value}`);
	field('Volume', view.name);
	field('Status', `${volumeStatusLabel(view)}${view.message ? ` (${view.message})` : ''}`);
	field('Project', view.projectSlug);
	field('Backing', volumeBacking(view));
	field('Quota', `${view.sizeMb} MB`);
	field('Used', volumeQuota(view));
	field('Writer', view.writer ? `${view.writer.environment} (single-writer)` : 'none');
	field('Created', formatTime(view.createdAt));
	if (view.deletedAt) field('Deleted', formatTime(view.deletedAt));
	if (view.attachments.length === 0) {
		lines.push('');
		lines.push(
			`Not attached. Attach it with \`skif volume attach ${view.name} --project ${view.projectSlug} --mount /var/lib/app\`.`,
		);
	} else {
		lines.push('');
		lines.push(
			renderTable(
				['ENVIRONMENT', 'MOUNT', 'MODE', 'WORKLOAD'],
				view.attachments.map((item) => [
					item.environment,
					item.mountPath,
					item.readOnly ? 'read-only' : 'read-write',
					item.workloadId,
				]),
			),
		);
	}
	lines.push('');
	lines.push('Snapshots: not implemented yet (follow-up after the backup-target surface).');
	return lines.join('\n');
}
