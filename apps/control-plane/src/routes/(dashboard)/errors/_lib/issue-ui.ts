import type {
	AppErrorFrameView,
	AppErrorIssueView,
	AppErrorLevel,
	AppErrorStatus,
	AppErrorTargetView
} from '@yoal/contracts';

/** Presentation rules for the Errors page, kept pure so they are tested without a browser. */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type Tone = 'danger' | 'warning' | 'success' | 'info' | 'neutral';

export function levelTone(level: AppErrorLevel | string): Tone {
	if (level === 'fatal' || level === 'error') return 'danger';
	if (level === 'warning') return 'warning';
	if (level === 'info') return 'info';
	return 'neutral';
}

/** The solid colour for a level's marker (dot or row edge). Static strings so Tailwind sees them. */
export function levelColor(level: AppErrorLevel | string): string {
	switch (level) {
		case 'fatal':
			return 'bg-destructive';
		case 'error':
			return 'bg-destructive/70';
		case 'warning':
			return 'bg-warning';
		case 'info':
			return 'bg-info';
		default:
			return 'bg-muted-foreground/50';
	}
}

/** The solid colour for a tone's dot. */
export function toneDot(tone: Tone): string {
	return {
		danger: 'bg-destructive',
		warning: 'bg-warning',
		success: 'bg-success',
		info: 'bg-info',
		neutral: 'bg-muted-foreground/50'
	}[tone];
}

export function statusTone(status: AppErrorStatus | string): Tone {
	if (status === 'unresolved') return 'danger';
	if (status === 'resolved') return 'success';
	return 'neutral';
}

export interface TargetHealth {
	label: string;
	tone: Tone;
	/** Reporting right now: the dot pulses. */
	live: boolean;
	description: string;
}

export function targetHealth(target: AppErrorTargetView, now = Date.now()): TargetHealth {
	if (!target.enabled)
		return {
			label: 'Disabled',
			tone: 'neutral',
			live: false,
			description: 'Its DSN rejects new events. Stored issues are kept.'
		};
	if (target.lastSeenAt && target.lastSeenAt >= now - DAY)
		return {
			label: 'Reporting',
			tone: 'success',
			live: true,
			description: 'Received an event in the last 24 hours.'
		};
	if (target.lastSeenAt)
		return {
			label: 'Quiet',
			tone: 'warning',
			live: false,
			description: 'No events for a day or more. Quiet is good, unless the app stopped reporting.'
		};
	return {
		label: 'Waiting for first event',
		tone: 'info',
		live: false,
		description: 'The DSN has not received anything yet.'
	};
}

/** First seen in the last 24 hours. */
export function isNew(issue: Pick<AppErrorIssueView, 'firstSeenAt'>, now = Date.now()): boolean {
	return issue.firstSeenAt >= now - DAY;
}

/** Regressed (resolved, then seen again) and still unresolved. */
export function isRegressed(issue: Pick<AppErrorIssueView, 'regressedAt' | 'status'>): boolean {
	return issue.regressedAt !== null && issue.status === 'unresolved';
}

const dayLabel = new Intl.DateTimeFormat('en-GB', {
	day: 'numeric',
	month: 'short',
	timeZone: 'UTC'
});
const hourLabel = new Intl.DateTimeFormat('en-GB', {
	hour: '2-digit',
	minute: '2-digit',
	timeZone: 'UTC'
});

/** Labels for `count` daily buckets ending today (UTC), oldest first, matching the server. */
export function dayLabels(count: number, now = Date.now()): string[] {
	const today = Math.floor(now / DAY) * DAY;
	return Array.from({ length: count }, (_, index) => {
		const offset = count - 1 - index;
		return offset === 0 ? 'Today' : dayLabel.format(today - offset * DAY);
	});
}

/** Labels for `count` hourly buckets ending with the current hour (UTC), oldest first. */
export function hourLabels(count: number, now = Date.now()): string[] {
	const current = Math.floor(now / HOUR) * HOUR;
	return Array.from({ length: count }, (_, index) => {
		const offset = count - 1 - index;
		return offset === 0 ? 'This hour' : `${hourLabel.format(current - offset * HOUR)} UTC`;
	});
}

/** "src/app.ts:12:4", or the bare file when the line is unknown. */
export function frameLocation(frame: Pick<AppErrorFrameView, 'file' | 'line' | 'column'>): string {
	return `${frame.file}${frame.line ? `:${frame.line}` : ''}${frame.line && frame.column ? `:${frame.column}` : ''}`;
}

export type FrameRun =
	| { kind: 'app'; index: number; frame: AppErrorFrameView }
	| { kind: 'library'; start: number; frames: AppErrorFrameView[] };

/**
 * Frames grouped for display: in-app frames stand alone, and each run of library frames folds
 * into one group the reader can open. A stack with no in-app frame at all is shown whole, since
 * folding everything would hide the only clue.
 */
export function frameRuns(frames: AppErrorFrameView[]): FrameRun[] {
	if (!frames.some((frame) => frame.inApp))
		return frames.map((frame, index) => ({ kind: 'app', index, frame }));
	const runs: FrameRun[] = [];
	frames.forEach((frame, index) => {
		if (frame.inApp) {
			runs.push({ kind: 'app', index, frame });
			return;
		}
		const last = runs.at(-1);
		if (last?.kind === 'library') last.frames.push(frame);
		else runs.push({ kind: 'library', start: index, frames: [frame] });
	});
	return runs;
}

/** The stack as plain text, crash frame first, for the clipboard. */
export function stackText(
	exceptions: Array<{ type: string; value: string; frames: AppErrorFrameView[] }>
): string {
	return exceptions
		.map((exception) => {
			const frames = exception.frames
				.map((frame) => `  at ${frame.fn} (${frameLocation(frame)})`)
				.join('\n');
			return `${exception.type}: ${exception.value}${frames ? `\n${frames}` : ''}`;
		})
		.join('\n\n');
}

export function compactNumber(value: number): string {
	if (value < 1000) return value.toLocaleString('en-GB');
	return new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(
		value
	);
}

/** True when keyboard shortcuts should leave this key alone (typing, or a dialog is open). */
export function shortcutBlocked(event: KeyboardEvent): boolean {
	if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return true;
	const target = event.target as HTMLElement | null;
	if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
		return true;
	return (
		typeof document !== 'undefined' &&
		document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null
	);
}

/** The Issues tab's URL state, as the server load parsed it. */
export interface IssueFilters {
	status: string;
	level: string;
	environment: string;
	release: string;
	target: string;
	q: string;
	range: string;
	sort: string;
	offset: number;
}

type FilterKey = Exclude<keyof IssueFilters, 'offset'>;

/** Narrowing filters (not status or sort), as removable chips. */
export function activeFilters(
	filters: IssueFilters,
	targetName: (id: string) => string | undefined
): Array<{ key: FilterKey; label: string; value: string }> {
	const chips: Array<{ key: FilterKey; label: string; value: string }> = [];
	if (filters.q) chips.push({ key: 'q', label: 'Search', value: filters.q });
	if (filters.target)
		chips.push({
			key: 'target',
			label: 'Target',
			value: targetName(filters.target) ?? filters.target
		});
	if (filters.level) chips.push({ key: 'level', label: 'Level', value: filters.level });
	if (filters.environment)
		chips.push({ key: 'environment', label: 'Environment', value: filters.environment });
	if (filters.release) chips.push({ key: 'release', label: 'Release', value: filters.release });
	if (filters.range && filters.range !== 'all')
		chips.push({ key: 'range', label: 'Seen in', value: filters.range });
	return chips;
}

/**
 * A link to the Issues tab that keeps the current filters, with `over` applied (null drops one).
 * Paging and the open issue are dropped unless given, so a filter change starts on page one.
 */
export function issuesHref(
	filters: IssueFilters,
	over: Partial<Record<FilterKey | 'issue', string | null>> & { offset?: number | null } = {}
): string {
	const params = new URLSearchParams({ tab: 'issues' });
	const pick = (key: FilterKey, fallback: string) => (key in over ? (over[key] ?? '') : fallback);
	const status = pick('status', filters.status);
	if (status && status !== 'unresolved') params.set('status', status);
	for (const key of ['target', 'level', 'environment', 'release', 'q'] as const) {
		const value = pick(key, filters[key]);
		if (value) params.set(key, value);
	}
	const range = pick('range', filters.range);
	if (range && range !== 'all') params.set('range', range);
	const sort = pick('sort', filters.sort);
	if (sort && sort !== 'last_seen') params.set('sort', sort);
	if (over.offset) params.set('offset', String(over.offset));
	if (over.issue) params.set('issue', over.issue);
	return `?${params.toString()}`;
}
