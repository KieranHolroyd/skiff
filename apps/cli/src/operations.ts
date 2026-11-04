/**
 * Operations (mass actions and prune, docs/OPERATIONS.md): the wire types the CLI reads, and the
 * pure formatting for plans, progress and outcomes. Types mirror `packages/contracts/src/
 * operations.ts`; the CLI bundle stays free of runtime dependencies (D40), so keep them in sync.
 */
import { formatBytes, formatNumber, plural, renderTable, truncate } from './output.ts';

export type OperationStatus =
	| 'queued'
	| 'planning'
	| 'planned'
	| 'applying'
	| 'succeeded'
	| 'partial'
	| 'failed'
	| 'cancelled'
	| 'expired';
export type ItemVerdict = 'ok' | 'skip' | 'blocked';
export type ItemStatus = 'pending' | 'succeeded' | 'skipped' | 'failed' | 'cancelled';
export type BulkAction = 'project.delete' | 'project.restore' | 'project.purge';

export interface CategoryTotals {
	planned: number;
	bytes: number;
	succeeded: number;
	failed: number;
	skipped: number;
}

export interface OperationSummary {
	verdicts: Partial<Record<ItemVerdict, number>>;
	statuses: Partial<Record<ItemStatus, number>>;
	flags: Partial<Record<string, number>>;
	categories?: Partial<Record<string, CategoryTotals>>;
	freedBytes: number;
}

export interface OperationView {
	id: string;
	kind: 'bulk' | 'prune';
	action: string;
	status: OperationStatus;
	scope: 'org' | 'platform' | null;
	phase: string | null;
	total: number;
	done: number;
	failed: number;
	summary: OperationSummary;
	actor?: { type: string; id: string | null; clientId: string | null };
	params?: { targets?: string[]; scope?: string; categories?: string[] };
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	planExpiresAt: string | null;
}

export interface OperationItemView {
	seq: number;
	category: string | null;
	targetKind: string;
	targetId: string;
	label: string | null;
	verdict: ItemVerdict;
	reason: string | null;
	flags: string[];
	status: ItemStatus;
	error: string | null;
	bytes: number | null;
}

/** Mirrors `pruneCategoryInfo` (order and labels). */
export const pruneCategoryInfo: ReadonlyArray<{ id: string; label: string; scope: 'org' | 'platform' }> = [
	{ id: 'project_rows', label: 'Project leftovers', scope: 'org' },
	{ id: 'domains', label: 'Orphaned domains', scope: 'org' },
	{ id: 'workload_reservations', label: 'Stale workload reservations', scope: 'org' },
	{ id: 'share_redemptions', label: 'Share link redemptions', scope: 'org' },
	{ id: 'deployments', label: 'Deleted deployments', scope: 'org' },
	{ id: 'upload_sessions', label: 'Abandoned uploads', scope: 'org' },
	{ id: 'config_snapshots', label: 'Config snapshots', scope: 'org' },
	{ id: 'releases', label: 'Unused releases', scope: 'org' },
	{ id: 'objects', label: 'Unreferenced objects', scope: 'platform' },
];
export const pruneCategoryIds = pruneCategoryInfo.map((info) => info.id);

const terminal: readonly string[] = ['succeeded', 'partial', 'failed', 'cancelled', 'expired'];
export const isTerminal = (status: string): boolean => terminal.includes(status);
/** Still being planned: the plan isn't ready to review yet. */
export const isPlanning = (status: string): boolean => status === 'queued' || status === 'planning';

/** 0 succeeded, 3 partial, 1 failed / cancelled / expired (docs/OPERATIONS.md §6.2). */
export function exitCodeFor(status: OperationStatus): number {
	if (status === 'succeeded') return 0;
	if (status === 'partial') return 3;
	return 1;
}

export const bulkVerbs: Record<BulkAction, { verb: string; past: string; noun: string }> = {
	'project.delete': { verb: 'Delete', past: 'Deleted', noun: 'delete' },
	'project.restore': { verb: 'Restore', past: 'Restored', noun: 'restore' },
	'project.purge': { verb: 'Permanently delete', past: 'Permanently deleted', noun: 'purge' },
};

export function watchHint(id: string): string {
	return `Still running: skif operations watch ${id}`;
}

// --- plans --------------------------------------------------------------------------------

/** Bulk plan: one row per target with what the server decided. */
export function planTable(items: OperationItemView[]): string {
	const rows = items.map((item) => [
		item.label ?? item.targetId,
		item.verdict,
		item.flags.length > 0 ? item.flags.join(',') : '-',
		item.reason ? item.reason.replace(/_/g, ' ') : '-',
	]);
	return renderTable(['SLUG', 'VERDICT', 'FLAGS', 'REASON'], rows);
}

export function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
	return counts;
}

/** `3 to delete (1 live, 1 workload), 1 skipped, 1 blocked` */
export function planSummaryLine(action: BulkAction, items: OperationItemView[]): string {
	const verdicts = countBy(items, (item) => item.verdict);
	const ok = items.filter((item) => item.verdict === 'ok');
	const flags = countBy(
		ok.flatMap((item) => item.flags),
		(flag) => flag,
	);
	const flagText = Object.entries(flags).map(([flag, count]) => `${count} ${flag.replace(/_/g, ' ')}`);
	const parts = [
		`${verdicts.ok ?? 0} to ${bulkVerbs[action].noun}${flagText.length ? ` (${flagText.join(', ')})` : ''}`,
	];
	if (verdicts.skip) parts.push(`${verdicts.skip} skipped`);
	if (verdicts.blocked) parts.push(`${verdicts.blocked} blocked`);
	return parts.join(', ');
}

/** `Delete 12 projects (3 live)? [y/N] ` */
export function confirmQuestion(action: BulkAction, ok: OperationItemView[]): string {
	const live = ok.filter((item) => item.flags.includes('live')).length;
	const base = `${bulkVerbs[action].verb} ${plural(ok.length, 'project')}${live ? ` (${live} live)` : ''}`;
	if (action === 'project.purge') return `${base}? This cannot be undone. [y/N] `;
	if (action === 'project.delete') return `${base}? They stay restorable for 7 days. [y/N] `;
	return `${base}? [y/N] `;
}

export function typedConfirmQuestion(count: number): string {
	return `This permanently deletes ${plural(count, 'project')} and cannot be undone. Type ${count} to confirm: `;
}

export const isYes = (answer: string): boolean => /^(y|yes)$/i.test(answer.trim());

// --- prune --------------------------------------------------------------------------------

export function categoryLabel(id: string): string {
	return pruneCategoryInfo.find((info) => info.id === id)?.label ?? id;
}

/** Categories with something planned, in registry order (unknown ones last). */
export function plannedCategories(summary: OperationSummary): Array<[string, CategoryTotals]> {
	const entries = Object.entries(summary.categories ?? {}).filter(
		(entry): entry is [string, CategoryTotals] => entry[1] !== undefined && entry[1].planned > 0,
	);
	const order = (id: string) => {
		const index = pruneCategoryIds.indexOf(id);
		return index === -1 ? Number.MAX_SAFE_INTEGER : index;
	};
	return entries.sort((a, b) => order(a[0]) - order(b[0]));
}

export function pruneTotals(summary: OperationSummary): { items: number; bytes: number } {
	let items = 0;
	let bytes = 0;
	for (const [, totals] of plannedCategories(summary)) {
		items += totals.planned;
		bytes += totals.bytes;
	}
	return { items, bytes };
}

/** Per-category plan: CATEGORY, ITEMS, SIZE, and a total row. */
export function pruneTable(summary: OperationSummary): string {
	const entries = plannedCategories(summary);
	const rows = entries.map(([id, totals]) => [
		`${categoryLabel(id)} (${id})`,
		formatNumber(totals.planned),
		totals.bytes > 0 ? formatBytes(totals.bytes) : '-',
	]);
	const totals = pruneTotals(summary);
	rows.push(['Total', formatNumber(totals.items), totals.bytes > 0 ? formatBytes(totals.bytes) : '-']);
	return renderTable(['CATEGORY', 'ITEMS', 'SIZE'], rows);
}

export function pruneConfirmQuestion(summary: OperationSummary): string {
	const totals = pruneTotals(summary);
	return `Prune ${plural(totals.items, 'item')}${totals.bytes > 0 ? ` (${formatBytes(totals.bytes)})` : ''}? This cannot be undone. [y/N] `;
}

// --- progress -----------------------------------------------------------------------------

/** `▕████████░░▏` */
export function progressBar(done: number, total: number, width = 10): string {
	const ratio = total > 0 ? Math.min(Math.max(done / total, 0), 1) : 1;
	const filled = Math.round(ratio * width);
	return `▕${'█'.repeat(filled)}${'░'.repeat(width - filled)}▏`;
}

export interface ProgressRow {
	key: string;
	done: number;
	total: number;
	bytes: number;
	failed: number;
}

/** `releases ▕████████░░▏ 384/480 · 46 MiB · 2 failed` */
export function progressLine(row: ProgressRow, keyWidth = row.key.length): string {
	const parts = [`${row.key.padEnd(keyWidth)} ${progressBar(row.done, row.total)} ${row.done}/${row.total}`];
	if (row.bytes > 0) parts.push(formatBytes(row.bytes));
	if (row.failed > 0) parts.push(`${row.failed} failed`);
	return parts.join(' · ');
}

export function progressLines(rows: ProgressRow[]): string[] {
	const width = Math.max(0, ...rows.map((row) => row.key.length));
	return rows.map((row) => progressLine(row, width));
}

/**
 * Tracks what a running operation has done, from `items` events, so the TTY can draw one line
 * per prune category (or one line for a bulk action) with bytes freed so far.
 */
export class ProgressTracker {
	private readonly perKey = new Map<string, { done: number; bytes: number; failed: number }>();
	private readonly succeededLabels: string[] = [];

	constructor(private operation: OperationView) {}

	get view(): OperationView {
		return this.operation;
	}

	get succeeded(): string[] {
		return this.succeededLabels;
	}

	update(operation: OperationView): void {
		this.operation = operation;
	}

	/** Record finished items; returns the ones that failed so they can be printed inline. */
	items(items: OperationItemView[]): OperationItemView[] {
		const failures: OperationItemView[] = [];
		for (const item of items) {
			if (item.verdict !== 'ok' || item.status === 'pending') continue;
			const key = this.keyFor(item.category);
			const entry = this.perKey.get(key) ?? { done: 0, bytes: 0, failed: 0 };
			entry.done++;
			if (item.status === 'succeeded') {
				entry.bytes += item.bytes ?? 0;
				this.succeededLabels.push(item.label ?? item.targetId);
			}
			if (item.status === 'failed') {
				entry.failed++;
				failures.push(item);
			}
			this.perKey.set(key, entry);
		}
		return failures;
	}

	rows(): ProgressRow[] {
		const view = this.operation;
		if (view.kind === 'prune') {
			return plannedCategories(view.summary).map(([id, totals]) => {
				const seen = this.perKey.get(id);
				const done = Math.max(seen?.done ?? 0, totals.succeeded + totals.failed + totals.skipped);
				return {
					key: id,
					done: Math.min(done, totals.planned),
					total: totals.planned,
					bytes: seen?.bytes ?? 0,
					failed: Math.max(seen?.failed ?? 0, totals.failed),
				};
			});
		}
		return [{ key: this.keyFor(null), done: view.done, total: view.total, bytes: 0, failed: view.failed }];
	}

	private keyFor(category: string | null): string {
		if (category) return category;
		const action = this.operation.action as BulkAction;
		return bulkVerbs[action]?.noun ?? this.operation.action;
	}
}

/** One plain line per phase or status change, for logs and pipes. */
export function phaseLine(view: OperationView): string {
	const counts = view.total > 0 ? ` ${view.done}/${view.total}${view.failed ? `, ${view.failed} failed` : ''}` : '';
	if (view.status === 'planning' || view.status === 'queued')
		return `${view.status}${view.phase ? `: ${view.phase}` : ''}`;
	if (view.status === 'applying') return `applying${view.phase ? `: ${view.phase}` : ''}${counts}`;
	return `${view.status}${counts}`;
}

export function failureLine(item: OperationItemView): string {
	const where = item.category ? `${item.category} ` : '';
	return `  failed  ${where}${item.label ?? item.targetId}: ${truncate(item.error ?? 'unknown error', 200)}`;
}

/** `Partial: 10 succeeded, 1 failed, 1 skipped.` */
export function outcomeLine(view: OperationView): string {
	const statuses = view.summary.statuses;
	const parts: string[] = [];
	for (const status of ['succeeded', 'failed', 'skipped', 'cancelled'] as const) {
		const count = statuses[status] ?? 0;
		if (count > 0) parts.push(`${count} ${status}`);
	}
	const label = view.status.charAt(0).toUpperCase() + view.status.slice(1);
	const freed = view.kind === 'prune' && view.summary.freedBytes > 0 ? ` Freed ${formatBytes(view.summary.freedBytes)}.` : '';
	return `${label}: ${parts.length ? parts.join(', ') : 'nothing ran'}.${freed}`;
}

/** Operations list: ID, ACTION, STATUS, PROGRESS, CREATED. */
export function operationsTable(views: OperationView[], formatTime: (value: string) => string): string {
	const rows = views.map((view) => [
		view.id,
		view.action,
		view.status,
		view.total > 0 ? `${view.done}/${view.total}${view.failed ? ` (${view.failed} failed)` : ''}` : '-',
		formatTime(view.createdAt),
	]);
	return renderTable(['ID', 'ACTION', 'STATUS', 'PROGRESS', 'CREATED'], rows);
}

/** Item rows for `operations show`: TARGET, CATEGORY?, VERDICT, STATUS, DETAIL. */
export function itemsTable(items: OperationItemView[], options: { categories: boolean }): string {
	const headers = options.categories
		? ['TARGET', 'CATEGORY', 'VERDICT', 'STATUS', 'DETAIL']
		: ['TARGET', 'VERDICT', 'FLAGS', 'STATUS', 'DETAIL'];
	const rows = items.map((item) => {
		const detail = truncate(item.error ?? (item.reason ? item.reason.replace(/_/g, ' ') : '-'), 60);
		const target = truncate(item.label ?? item.targetId, 48);
		return options.categories
			? [target, item.category ?? '-', item.verdict, item.status, detail]
			: [target, item.verdict, item.flags.length ? item.flags.join(',') : '-', item.status, detail];
	});
	return renderTable(headers, rows);
}

/** `6d 23h`, `5h 12m`, `3m`, `due` */
export function formatDurationShort(ms: number): string {
	if (!Number.isFinite(ms)) return '-';
	if (ms <= 0) return 'due';
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return '<1m';
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	return `${mins}m`;
}

/** Live TTY region: redraws its lines in place; `log` prints a permanent line above them. */
export class LiveRegion {
	private drawn = 0;
	private last = '';

	constructor(private readonly write: (text: string) => void) {}

	/** Redraw the region; a frame identical to the one on screen is skipped. */
	render(lines: string[]): void {
		const frame = lines.map((line) => `${line}\n`).join('');
		if (frame === this.last) return;
		this.write(this.clearSequence() + frame);
		this.drawn = lines.length;
		this.last = frame;
	}

	log(line: string, lines: string[]): void {
		const frame = lines.map((l) => `${l}\n`).join('');
		this.write(`${this.clearSequence()}${line}\n${frame}`);
		this.drawn = lines.length;
		this.last = frame;
	}

	/** Leave the last frame on screen and stop tracking it. */
	done(): void {
		this.drawn = 0;
		this.last = '';
	}

	private clearSequence(): string {
		if (this.drawn === 0) return '';
		return `\x1b[${this.drawn}A${'\x1b[2K\n'.repeat(this.drawn)}\x1b[${this.drawn}A`;
	}
}
