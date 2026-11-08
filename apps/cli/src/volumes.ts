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

export type AppVolumeSnapshotStatus = 'pending' | 'running' | 'ok' | 'failed';
export type AppVolumeSnapshotMethod = 'reflink' | 'paused' | 'idle' | 'live';

export interface AppVolumeSnapshotView {
	id: string;
	volumeId: string;
	target: { id: string; name: string } | null;
	objectKey: string;
	sizeBytes: number | null;
	checksum: string | null;
	pinned: boolean;
	status: AppVolumeSnapshotStatus;
	error: string | null;
	label: string | null;
	method: AppVolumeSnapshotMethod | null;
	quiesce: boolean;
	createdAt: string;
	finishedAt: string | null;
	expiresAt: string | null;
	restoreVerifiedAt: string | null;
}

/** Mirrors `APP_VOLUME_USAGE_WARN_PERCENT`. */
export const VOLUME_USAGE_WARN_PERCENT = 90;

export interface AppVolumeView {
	id: string;
	orgId: string;
	projectId: string;
	projectSlug: string;
	name: string;
	nodeId: string;
	backing: 'node_volume' | 'state_dir';
	/** The disk it lives on; null is the system disk. */
	disk: { id: string; name: string; tier?: string; remote: boolean } | null;
	sizeMb: number;
	usedBytes: number | null;
	/** Absent from control planes older than snapshots. */
	usedAt?: string | null;
	nearQuota?: boolean;
	restoringFrom?: string | null;
	mountPath: string;
	status: AppVolumeStatus;
	message: string | null;
	singleWriter: boolean;
	writer: { workloadId: string; environment: string } | null;
	attachments: AppVolumeAttachmentView[];
	snapshots: AppVolumeSnapshotView[];
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

export function volumeStatusLabel(view: Pick<AppVolumeView, 'status' | 'deletedAt' | 'restoringFrom'>): string {
	if (view.deletedAt) return 'deleted';
	return view.restoringFrom ? 'restoring' : view.status;
}

/** A one-line warning when the volume is at or above the warn threshold, else null. */
export function nearQuotaWarning(view: Pick<AppVolumeView, 'name' | 'usedBytes' | 'sizeMb'>): string | null {
	if (view.usedBytes === null || view.usedBytes === undefined) return null;
	const budget = view.sizeMb * 1024 * 1024;
	const percent = budget > 0 ? Math.round((view.usedBytes / budget) * 100) : 0;
	if (percent < VOLUME_USAGE_WARN_PERCENT) return null;
	return `Volume "${view.name}" is ${percent}% full (${formatBytes(view.usedBytes)} of ${formatBytes(budget)}). Delete data, or grow it with a larger sizeMb (\`PATCH /api/v1/projects/<slug>/volumes/${view.name}\`).`;
}

function snapshotMethod(snapshot: AppVolumeSnapshotView): string {
	if (snapshot.method) return snapshot.method;
	return snapshot.quiesce ? '-' : 'live?';
}

export function snapshotTable(snapshots: AppVolumeSnapshotView[]): string {
	const rows = snapshots.map((snapshot) => [
		snapshot.id,
		snapshot.status,
		snapshot.sizeBytes === null ? '-' : formatBytes(snapshot.sizeBytes),
		snapshotMethod(snapshot),
		snapshot.target?.name ?? 'platform',
		truncate(snapshot.label ?? '', 28) || '-',
		formatTime(snapshot.createdAt),
		snapshot.restoreVerifiedAt ? formatTime(snapshot.restoreVerifiedAt) : '-',
	]);
	return renderTable(['ID', 'STATUS', 'SIZE', 'METHOD', 'TARGET', 'LABEL', 'CREATED', 'VERIFIED'], rows);
}

export function snapshotDetails(snapshot: AppVolumeSnapshotView): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(10)}  ${value}`);
	field('Snapshot', snapshot.id);
	field('Status', `${snapshot.status}${snapshot.error ? ` (${snapshot.error})` : ''}`);
	if (snapshot.label) field('Label', snapshot.label);
	field('Target', snapshot.target?.name ?? 'platform object store');
	field('Size', snapshot.sizeBytes === null ? '-' : formatBytes(snapshot.sizeBytes));
	field('Method', snapshot.method ?? (snapshot.quiesce ? 'not run yet' : 'not run yet (live copy)'));
	if (snapshot.checksum) field('SHA-256', snapshot.checksum);
	field('Created', formatTime(snapshot.createdAt));
	if (snapshot.finishedAt) field('Finished', formatTime(snapshot.finishedAt));
	if (snapshot.restoreVerifiedAt) field('Verified', formatTime(snapshot.restoreVerifiedAt));
	return lines.join('\n');
}

export function volumeBacking(view: Pick<AppVolumeView, 'backing' | 'disk'>): string {
	return view.backing === 'node_volume' ? `disk:${view.disk?.name ?? 'removed'}` : 'system';
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
	field('Used', `${volumeQuota(view)}${view.usedAt ? `, measured ${formatTime(view.usedAt)}` : ''}`);
	if (view.restoringFrom) field('Restoring', `from snapshot ${view.restoringFrom}; attachable once it finishes`);
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
	if (view.snapshots.length === 0) {
		lines.push(`No snapshots. Take one with \`skif volume snapshot ${view.name} --project ${view.projectSlug}\`.`);
	} else {
		lines.push('Snapshots:');
		lines.push(snapshotTable(view.snapshots.slice(0, 10)));
		if (view.snapshots.length > 10)
			lines.push(`… ${view.snapshots.length - 10} more: \`skif volume snapshots ${view.name} --project ${view.projectSlug}\``);
	}
	const warning = nearQuotaWarning(view);
	if (warning) {
		lines.push('');
		lines.push(`Warning: ${warning}`);
	}
	return lines.join('\n');
}
