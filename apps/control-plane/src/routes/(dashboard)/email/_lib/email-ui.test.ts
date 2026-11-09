import { describe, expect, test } from 'bun:test';
import { EMAIL_REPUTATION, emailEventKinds } from '@yoal/contracts';
import {
	activitySearch,
	formatRate,
	messageIdQuery,
	messageStatusTone,
	quotaUse,
	rateGauge,
	readActivityFilters,
	recordState,
	reputationGauges
} from './email-ui.js';

const bounce = { warn: EMAIL_REPUTATION.bounceWarn, pause: EMAIL_REPUTATION.bouncePause };

describe('message status tones', () => {
	test('every event kind has a tone and failures are danger', () => {
		for (const kind of emailEventKinds) expect(messageStatusTone(kind)).toBeTruthy();
		expect(messageStatusTone('delivered')).toBe('success');
		expect(messageStatusTone('bounced')).toBe('danger');
		expect(messageStatusTone('deferred')).toBe('warning');
		expect(messageStatusTone('nonsense')).toBe('neutral');
	});
});

describe('rates', () => {
	test('format as percentages, with a dash before anything is sent', () => {
		expect(formatRate(null)).toBe('—');
		expect(formatRate(0.0123)).toBe('1.23%');
		expect(formatRate(0.05, 1)).toBe('5.0%');
	});

	test('a small sample is shown but not judged', () => {
		const gauge = rateGauge(0.5, bounce, EMAIL_REPUTATION.minMessages - 1);
		expect(gauge.level).toBe('unknown');
		expect(gauge.tone).toBe('neutral');
		expect(gauge.percent).toBe(100);
	});

	test('levels follow the warn and pause thresholds', () => {
		const n = EMAIL_REPUTATION.minMessages;
		expect(rateGauge(0.01, bounce, n).level).toBe('ok');
		expect(rateGauge(EMAIL_REPUTATION.bounceWarn, bounce, n).level).toBe('warn');
		expect(rateGauge(EMAIL_REPUTATION.bouncePause, bounce, n).level).toBe('pause');
		expect(rateGauge(null, bounce, n).level).toBe('unknown');
	});

	test('markers sit on a scale that ends past the pause threshold', () => {
		const gauge = rateGauge(0, bounce, 1000);
		expect(gauge.pauseAt).toBe(80);
		expect(gauge.warnAt).toBe(40);
		expect(gauge.percent).toBe(0);
	});

	test('both gauges come from one org view', () => {
		const gauges = reputationGauges({
			bounceRate: 0.09,
			complaintRate: 0.0005,
			windowMessages: 500
		});
		expect(gauges.enough).toBe(true);
		expect(gauges.bounce.level).toBe('pause');
		expect(gauges.complaint.level).toBe('ok');
		expect(gauges.complaint.value).toBe('0.05%');
	});
});

describe('quota and records', () => {
	test('daily use turns at 80% and 100%', () => {
		expect(quotaUse(10, 200)).toEqual({ percent: 5, tone: 'success' });
		expect(quotaUse(160, 200).tone).toBe('warning');
		expect(quotaUse(250, 200)).toEqual({ percent: 100, tone: 'danger' });
		expect(quotaUse(5, 0).percent).toBe(0);
	});

	test('a missing record blocks only when it is required', () => {
		expect(recordState({ ok: true, required: true })).toBe('ok');
		expect(recordState({ ok: false, required: true })).toBe('missing');
		expect(recordState({ ok: false, required: false })).toBe('advised');
	});
});

describe('activity filters', () => {
	test('round-trip through the query string, dropping empty and invalid values', () => {
		const filters = readActivityFilters(
			new URLSearchParams('q=%20a%40b.com%20&status=bounced&before=2026-11-07T10:00:00.000Z')
		);
		expect(filters).toEqual({
			q: 'a@b.com',
			status: 'bounced',
			before: '2026-11-07T10:00:00.000Z'
		});
		expect(activitySearch(filters)).toBe(
			'?q=a%40b.com&status=bounced&before=2026-11-07T10%3A00%3A00.000Z'
		);
		expect(readActivityFilters(new URLSearchParams('status=nope&before=yesterday'))).toEqual({
			q: '',
			status: '',
			before: ''
		});
		expect(activitySearch({})).toBe('');
	});

	test('a message id in the search box is recognised', () => {
		expect(messageIdQuery(' EM_abc12345 ')).toBe('em_abc12345');
		expect(messageIdQuery('someone@example.com')).toBeNull();
		expect(messageIdQuery('em_short')).toBeNull();
	});
});
