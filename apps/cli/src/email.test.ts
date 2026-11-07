import { describe, expect, test } from 'bun:test';
import {
	emailAddressTable,
	emailDomainTable,
	emailRecordsTable,
	emailStatusReport,
	listFrom,
	parseAddressList,
	parseDailyVolume,
	parseTags,
	takeNewMessages,
	viewFrom,
	type EmailDomainView,
	type EmailMessageView,
	type EmailOrgView,
	type EmailRecordCheck,
} from './email.ts';

function record(overrides: Partial<EmailRecordCheck> = {}): EmailRecordCheck {
	return {
		purpose: 'dkim',
		type: 'TXT',
		name: 'skf202611._domainkey.example.com',
		value: `v=DKIM1; k=rsa; p=${'A'.repeat(300)}`,
		required: true,
		ok: false,
		found: [],
		managed: false,
		note: null,
		...overrides,
	};
}

function domain(overrides: Partial<EmailDomainView> = {}): EmailDomainView {
	return {
		id: 'ed_1',
		name: 'example.com',
		status: 'pending',
		sending: true,
		receiving: false,
		dkimSelector: 'skf202611',
		records: [record(), record({ purpose: 'spf', name: 'example.com', value: 'v=spf1 include:_spf.skiff.example ~all', ok: true })],
		lastCheckedAt: null,
		verifiedAt: null,
		failingSince: null,
		createdAt: '2026-11-07T10:00:00.000Z',
		...overrides,
	};
}

function message(id: string, status: EmailMessageView['status'] = 'accepted'): EmailMessageView {
	return {
		id,
		from: 'hi@example.com',
		subject: 'Hello',
		projectId: null,
		source: 'api',
		tags: {},
		status,
		recipients: [{ address: 'you@example.org', status, lastResponse: null, updatedAt: '2026-11-07T10:00:00.000Z' }],
		createdAt: '2026-11-07T10:00:00.000Z',
	};
}

function org(overrides: Partial<EmailOrgView> = {}): EmailOrgView {
	return {
		state: 'sandbox',
		perSecond: 1,
		perDay: 200,
		sentToday: 12,
		bounceRate: null,
		complaintRate: null,
		windowMessages: 12,
		pausedReason: null,
		...overrides,
	};
}

describe('skif email formatting', () => {
	test('the records table keeps the full DKIM value and marks each check', () => {
		const table = emailRecordsTable(domain().records);
		expect(table).toContain('A'.repeat(300));
		expect(table).toContain('✗');
		expect(table).toContain('✓');
		expect(table.split('\n')[0]).toMatch(/^PURPOSE\s+TYPE\s+NAME\s+REQUIRED\s+OK\s+NOTE\s+VALUE$/);
	});

	test('MX records carry their priority and managed records say so', () => {
		const table = emailRecordsTable([
			record({ purpose: 'mx', type: 'MX', priority: 10, value: 'mx.skiff.example', managed: true, ok: true, required: false }),
		]);
		expect(table).toContain('MX 10');
		expect(table).toContain('managed by Skiff');
		expect(table).toContain('recommended');
	});

	test('the domain list counts required records that check out', () => {
		expect(emailDomainTable([domain()])).toContain('1/2');
	});

	test('status explains the sandbox and holds back rates until there is enough mail', () => {
		const report = emailStatusReport(org(), { nodeId: null, hostnames: { submission: 'smtp.skiff.example' } });
		expect(report).toContain('sandbox — only to your own verified domains');
		expect(report).toContain('12 of 200');
		expect(report).toContain('after 200 messages; 12 so far');
		expect(report).toContain('not set up');
		expect(report).toContain('smtp.skiff.example:587');
	});

	test('status flags rates over a threshold', () => {
		const report = emailStatusReport(
			org({ state: 'active', perDay: 10_000, perSecond: 10, windowMessages: 5000, bounceRate: 0.05, complaintRate: 0.0005 }),
			null,
		);
		expect(report).toContain('5.0% (over the warning threshold)');
		expect(report).toContain('0.05%  (warn 0.10%, pause 0.30%)');
		expect(report).not.toContain('Mail node');
	});
});

describe('skif email parsing', () => {
	test('recipients may repeat and be comma separated', () => {
		expect(parseAddressList(['a@x.com, b@y.com', 'c@z.com', ''])).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
	});

	test('tags are key=value and values may contain =', () => {
		expect(parseTags(['campaign=nov', 'q=a=b'])).toEqual({ campaign: 'nov', q: 'a=b' });
		expect(() => parseTags(['nokey'])).toThrow('key=value');
		expect(() => parseTags(['bad key=1'])).toThrow('Tag key');
		expect(() => parseTags(Array.from({ length: 11 }, (_, i) => `k${i}=v`))).toThrow('At most 10 tags');
	});

	test('responses may be bare or wrapped', () => {
		expect(listFrom([1, 2], 'domains')).toEqual([1, 2]);
		expect(listFrom({ domains: [3] }, 'domains')).toEqual([3]);
		expect(listFrom({ other: [3] }, 'domains')).toEqual([]);
		expect(viewFrom({ domain: { name: 'a', records: [] } }, 'domain', 'records')).toEqual({ name: 'a', records: [] });
		expect(viewFrom({ name: 'a', records: [] }, 'domain', 'records')).toEqual({ name: 'a', records: [] });
		expect(viewFrom({ ok: true }, 'domain', 'records')).toBeNull();
	});

	test('follow prints new messages and status changes oldest first, once', () => {
		const seen = new Map<string, string>();
		expect(takeNewMessages([message('em_2'), message('em_1')], seen).map((item) => item.id)).toEqual(['em_1', 'em_2']);
		expect(takeNewMessages([message('em_2'), message('em_1')], seen)).toEqual([]);
		const next = takeNewMessages([message('em_3'), message('em_2', 'delivered'), message('em_1')], seen);
		expect(next.map((item) => `${item.id}:${item.status}`)).toEqual(['em_2:delivered', 'em_3:accepted']);
	});
});

describe('skif email sandbox', () => {
	test('--volume takes whole numbers and k/m shorthands', () => {
		expect(parseDailyVolume('500')).toBe(500);
		expect(parseDailyVolume('10,000')).toBe(10_000);
		expect(parseDailyVolume('10k')).toBe(10_000);
		expect(parseDailyVolume('1.5M')).toBe(1_500_000);
		expect(() => parseDailyVolume(undefined)).toThrow('--volume is required');
		expect(() => parseDailyVolume('0')).toThrow('between 1 and 10,000,000');
		expect(() => parseDailyVolume('20m')).toThrow('between 1 and 10,000,000');
		expect(() => parseDailyVolume('some')).toThrow('whole number');
	});

	test('a pending address whose link ran out shows as expired', () => {
		const table = emailAddressTable(
			[
				{
					id: 'ea_1',
					address: 'me@gmail.com',
					status: 'pending',
					verifiedAt: null,
					sentAt: '2026-11-06T10:00:00.000Z',
					expiresAt: '2026-11-07T10:00:00.000Z',
					createdAt: '2026-11-06T10:00:00.000Z',
				},
			],
			Date.parse('2026-11-07T11:00:00.000Z'),
		);
		expect(table).toContain('link expired');
	});
});
