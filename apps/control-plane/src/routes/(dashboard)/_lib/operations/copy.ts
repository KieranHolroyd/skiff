import {
	isTerminalOperation,
	operationActions,
	pruneCategoryInfo,
	type ItemFlag,
	type ItemStatus,
	type OperationActionId,
	type OperationStatus,
	type OperationView,
	type PruneCategory
} from '@skiff/contracts';
import type { Tone } from '#lib/status.js';
import { formatDuration } from '../format.js';

/** Plain-language text for the reason codes plans and runs attach to items. */
const reasons: Record<string, string> = {
	already_in_trash: 'Already in the trash',
	not_in_trash: 'Not in the trash',
	not_found: 'Not found',
	forbidden: 'You do not have permission',
	already_purged: 'Already permanently deleted',
	restored: 'Restored before it ran',
	changed: 'Changed since the plan',
	no_longer_orphaned: 'No longer orphaned',
	deselected: 'Category not selected',
	plan_expired: 'The plan expired',
	store_cannot_list: 'The object store cannot list its contents'
};

export function reasonLabel(reason: string | null | undefined): string {
	if (!reason) return '';
	return reasons[reason] ?? reason.replace(/_/g, ' ');
}

export const flagLabels: Record<ItemFlag, string> = {
	live: 'Live',
	workload: 'Runs a workload',
	custom_domain: 'Custom domain'
};

const statusLabels: Record<OperationStatus, string> = {
	queued: 'Queued',
	planning: 'Planning',
	planned: 'Planned',
	applying: 'Running',
	succeeded: 'Succeeded',
	partial: 'Partial',
	failed: 'Failed',
	cancelled: 'Cancelled',
	expired: 'Expired'
};

const statusTones: Record<OperationStatus, Tone> = {
	queued: 'info',
	planning: 'info',
	planned: 'brand',
	applying: 'warning',
	succeeded: 'success',
	partial: 'warning',
	failed: 'danger',
	cancelled: 'neutral',
	expired: 'neutral'
};

export const operationStatusLabel = (status: OperationStatus) => statusLabels[status] ?? status;
export const operationStatusTone = (status: OperationStatus): Tone =>
	statusTones[status] ?? 'neutral';

const itemTones: Record<ItemStatus, Tone> = {
	pending: 'info',
	succeeded: 'success',
	skipped: 'neutral',
	failed: 'danger',
	cancelled: 'neutral'
};
export const itemStatusTone = (status: ItemStatus): Tone => itemTones[status] ?? 'neutral';

export function actionLabel(action: OperationActionId | string): string {
	return operationActions[action as OperationActionId]?.label ?? action;
}

const categoryById = new Map(pruneCategoryInfo.map((info) => [info.id, info]));
export function categoryLabel(category: PruneCategory | string | null | undefined): string {
	if (!category) return '—';
	return categoryById.get(category as PruneCategory)?.label ?? category.replace(/_/g, ' ');
}

export const isActive = (operation: Pick<OperationView, 'status'>) =>
	!isTerminalOperation(operation.status);

/** How long an operation ran (or has been running). */
export function operationDuration(operation: OperationView, now = Date.now()): string {
	// A plan waiting for review is not running.
	if (operation.status === 'planned' || operation.status === 'expired') return '—';
	const start = operation.startedAt ?? operation.createdAt;
	const end = operation.finishedAt ? Date.parse(operation.finishedAt) : now;
	const seconds = Math.max(0, (end - Date.parse(start)) / 1000);
	return formatDuration(seconds);
}

/** "purges in 3 days" for a trashed project. */
export function purgeCountdown(purgeAt: string | null, now = Date.now()): string {
	if (!purgeAt) return 'Not scheduled';
	const ms = Date.parse(purgeAt) - now;
	if (!Number.isFinite(ms)) return 'Not scheduled';
	if (ms <= 0) return 'Purges soon';
	const hours = ms / 3_600_000;
	if (hours < 1) return 'Purges in under an hour';
	if (hours < 24) {
		const n = Math.ceil(hours);
		return `Purges in ${n} ${n === 1 ? 'hour' : 'hours'}`;
	}
	const days = Math.ceil(hours / 24);
	return `Purges in ${days} ${days === 1 ? 'day' : 'days'}`;
}

export function countLabel(count: number, noun = 'project'): string {
	return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
