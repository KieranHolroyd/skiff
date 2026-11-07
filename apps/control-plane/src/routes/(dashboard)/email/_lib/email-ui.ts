import {
	EMAIL_REPUTATION,
	emailEventKinds,
	type EmailEventKind,
	type EmailOrgState,
	type EmailOrgView,
	type EmailRecordCheck
} from '@skiff/contracts';
import type { Tone } from '#lib/status.js';

/**
 * Pure helpers for the Email pages (docs/EMAIL.md §9): status tones, the reputation gauges and
 * the activity log's query string. No I/O, so they are tested directly.
 */

const MESSAGE_TONES: Record<EmailEventKind, Tone> = {
	accepted: 'info',
	delivered: 'success',
	deferred: 'warning',
	bounced: 'danger',
	complained: 'danger',
	rejected: 'danger',
	suppressed: 'neutral',
	received: 'info',
	dropped: 'neutral'
};

/** Tone for a message or recipient status (an `EmailEventKind`). Unknown values are neutral. */
export function messageStatusTone(status: string): Tone {
	return MESSAGE_TONES[status as EmailEventKind] ?? 'neutral';
}

/** Whether a string is a known message status, for the activity filter. */
export function isMessageStatus(value: string | null | undefined): value is EmailEventKind {
	return !!value && (emailEventKinds as readonly string[]).includes(value);
}

export const ORG_STATE_COPY: Record<EmailOrgState, { label: string; tone: Tone; summary: string }> =
	{
		sandbox: {
			label: 'Sandbox',
			tone: 'warning',
			summary:
				'Mail can only go to your own verified domains and verified addresses. A platform admin moves the organisation out of the sandbox.'
		},
		active: {
			label: 'Active',
			tone: 'success',
			summary: 'Sending to any recipient, within the limits below.'
		},
		paused: {
			label: 'Paused',
			tone: 'danger',
			summary: 'Every send is refused with email_paused; mail already queued still drains.'
		}
	};

/** `0.0123` → `1.23%`; `null` (nothing sent yet) → `—`. */
export function formatRate(rate: number | null | undefined, digits = 2): string {
	if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
	return `${(rate * 100).toFixed(digits)}%`;
}

export type GaugeLevel = 'unknown' | 'ok' | 'warn' | 'pause';

export interface RateGauge {
	level: GaugeLevel;
	tone: Tone;
	/** Bar fill, 0–100, on a scale that ends a quarter past the pause threshold. */
	percent: number;
	/** Where the warning and pause markers sit on the same scale, 0–100. */
	warnAt: number;
	pauseAt: number;
	value: string;
}

/**
 * One reputation gauge (EMAIL.md §7.2). Below `minMessages` the rate is shown but not judged:
 * the platform does not warn or pause on a small sample either.
 */
export function rateGauge(
	rate: number | null,
	thresholds: { warn: number; pause: number },
	windowMessages: number,
	minMessages: number = EMAIL_REPUTATION.minMessages
): RateGauge {
	const max = thresholds.pause * 1.25;
	const scale = (value: number) => Math.min(100, Math.max(0, (value / max) * 100));
	const base = {
		warnAt: scale(thresholds.warn),
		pauseAt: scale(thresholds.pause),
		value: formatRate(rate, thresholds.warn < 0.01 ? 2 : 1)
	};
	if (rate === null || windowMessages < minMessages)
		return { ...base, level: 'unknown', tone: 'neutral', percent: rate === null ? 0 : scale(rate) };
	const level: GaugeLevel =
		rate >= thresholds.pause ? 'pause' : rate >= thresholds.warn ? 'warn' : 'ok';
	const tone: Tone = level === 'pause' ? 'danger' : level === 'warn' ? 'warning' : 'success';
	return { ...base, level, tone, percent: scale(rate) };
}

/** Both reputation gauges for an org view. */
export function reputationGauges(
	view: Pick<EmailOrgView, 'bounceRate' | 'complaintRate' | 'windowMessages'>
) {
	return {
		enough: view.windowMessages >= EMAIL_REPUTATION.minMessages,
		bounce: rateGauge(
			view.bounceRate,
			{ warn: EMAIL_REPUTATION.bounceWarn, pause: EMAIL_REPUTATION.bouncePause },
			view.windowMessages
		),
		complaint: rateGauge(
			view.complaintRate,
			{ warn: EMAIL_REPUTATION.complaintWarn, pause: EMAIL_REPUTATION.complaintPause },
			view.windowMessages
		)
	};
}

/** Today's use of the daily limit: 0–100 and a tone that turns at 80% and 100%. */
export function quotaUse(sentToday: number, perDay: number): { percent: number; tone: Tone } {
	const percent = perDay > 0 ? Math.min(100, (sentToday / perDay) * 100) : 0;
	return { percent, tone: percent >= 100 ? 'danger' : percent >= 80 ? 'warning' : 'success' };
}

/** A record's row state: passing, a required one missing (blocks), or a recommended one missing. */
export function recordState(
	record: Pick<EmailRecordCheck, 'ok' | 'required'>
): 'ok' | 'missing' | 'advised' {
	if (record.ok) return 'ok';
	return record.required ? 'missing' : 'advised';
}

/** The activity log's filters, read from and written to the query string. */
export interface ActivityFilters {
	/** Recipient address (exact), or a message id (`em_…`), which opens that message. */
	q: string;
	status: EmailEventKind | '';
	/** ISO timestamp: show messages older than this. */
	before: string;
}

export function readActivityFilters(params: { get(name: string): string | null }): ActivityFilters {
	const status = params.get('status');
	const before = params.get('before') ?? '';
	return {
		q: (params.get('q') ?? '').trim(),
		status: isMessageStatus(status) ? status : '',
		before: Number.isFinite(Date.parse(before)) ? before : ''
	};
}

/** `?q=…&status=…&before=…`, leaving out empty filters; `''` when there are none. */
export function activitySearch(filters: Partial<ActivityFilters>): string {
	const params = new URLSearchParams();
	if (filters.q) params.set('q', filters.q);
	if (filters.status) params.set('status', filters.status);
	if (filters.before) params.set('before', filters.before);
	const search = params.toString();
	return search ? `?${search}` : '';
}

/** A search box value that is a message id rather than an address. */
export function messageIdQuery(q: string): string | null {
	const value = q.trim().toLowerCase();
	return /^em_[a-z0-9]{8,64}$/.test(value) ? value : null;
}
