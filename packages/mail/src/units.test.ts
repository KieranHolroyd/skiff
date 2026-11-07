import { describe, expect, test } from 'bun:test';
import { classifyNetworkError, classifyReply } from './classify.ts';
import { DeliveryDnsError, resolveTargets, type MailResolver } from './dns.ts';
import { retryDelaySeconds } from './queue.ts';
import { providerFor, Shaper } from './shaping.ts';

describe('classifyReply', () => {
	test.each([
		[250, '2.0.0 OK 1699999999 abc - gsmtp', 'delivered', null],
		[550, "5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient's email address", 'permanent', 'invalid-recipient'],
		[550, 'Requested action not taken: mailbox unavailable', 'permanent', 'invalid-recipient'],
		[550, '5.4.1 Recipient address rejected: Access denied. AS(201806281)', 'permanent', 'invalid-recipient'],
		[550, '5.7.1 Message rejected due to local policy', 'permanent', 'policy'],
		[552, '5.2.2 The email account that you tried to reach is over quota', 'permanent', 'mailbox-full'],
		[452, '4.2.2 The email account that you tried to reach is over quota', 'transient', 'mailbox-full'],
		[550, '5.7.1 [203.0.113.9] Our system has detected that this message is likely unsolicited mail', 'permanent', 'spam-block'],
		[554, '5.7.1 Service unavailable; Client host [203.0.113.9] blocked using Spamhaus', 'permanent', 'spam-block'],
		[550, '5.7.26 This mail has been blocked because the sender is unauthenticated', 'permanent', 'auth'],
		[421, '4.7.28 Our system has detected an unusual rate of unsolicited mail', 'transient', 'spam-block'],
		[421, '4.7.0 Try again later, closing connection.', 'transient', 'throttled'],
		[451, '4.7.0 Temporary server error. Please try again later', 'transient', 'other'],
		[450, '4.7.1 Too many messages, slow down', 'transient', 'throttled'],
		[552, '5.3.4 Message size exceeds fixed limit', 'permanent', 'message-too-large'],
		[550, '5.1.2 Bad destination system address', 'permanent', 'bad-domain'],
	])('%i %s → %s/%s', (code, text, kind, bounceClass) => {
		const outcome = classifyReply(code, text);
		expect(outcome.kind).toBe(kind as never);
		if (outcome.kind !== 'delivered') expect(outcome.bounceClass).toBe(bounceClass as never);
	});

	test('network errors', () => {
		expect(classifyNetworkError('ECONNREFUSED')).toEqual({ kind: 'transient', bounceClass: 'connection' });
		expect(classifyNetworkError('EBADDOMAIN')).toEqual({ kind: 'permanent', bounceClass: 'bad-domain' });
	});
});

describe('resolveTargets', () => {
	const records: Record<string, Array<{ exchange: string; priority: number }>> = {
		'example.org': [
			{ exchange: 'backup.example.org', priority: 20 },
			{ exchange: 'mx1.example.org', priority: 10 },
		],
		'nomx.org': [],
	};
	const resolver: MailResolver = {
		async resolveMx(domain) {
			if (domain in records) {
				if (records[domain]!.length === 0) throw Object.assign(new Error('nodata'), { code: 'ENODATA' });
				return records[domain]!;
			}
			if (domain === 'flaky.org') throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
			throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
		},
		async resolve4(host) {
			return { 'mx1.example.org': ['192.0.2.1'], 'backup.example.org': ['192.0.2.2'], 'nomx.org': ['192.0.2.3'] }[host] ?? [];
		},
		async resolve6() {
			return ['2001:db8::1'];
		},
	};

	test('orders by priority', async () => {
		const targets = await resolveTargets(resolver, 'example.org');
		expect(targets.map((target) => target.host)).toEqual(['mx1.example.org', 'backup.example.org']);
	});

	test('falls back to the domain itself without MX', async () => {
		expect((await resolveTargets(resolver, 'nomx.org'))[0]).toMatchObject({ host: 'nomx.org', address: '192.0.2.3' });
	});

	test('a missing domain is permanent, a DNS timeout is not', async () => {
		await expect(resolveTargets(resolver, 'nope.org')).rejects.toMatchObject({ code: 'EBADDOMAIN' });
		const error = await resolveTargets(resolver, 'flaky.org').catch((caught: DeliveryDnsError) => caught);
		expect(error).toBeInstanceOf(DeliveryDnsError);
		expect((error as DeliveryDnsError).code).toBe('ETEMPDNS');
	});

	test('IPv6 only when enabled', async () => {
		expect((await resolveTargets(resolver, 'example.org')).some((target) => target.address.includes(':'))).toBe(false);
		expect((await resolveTargets(resolver, 'example.org', { ipv6: true })).some((target) => target.address.includes(':'))).toBe(true);
	});
});

describe('shaping', () => {
	test('providers by domain and MX', () => {
		expect(providerFor('gmail.com').key).toBe('google');
		expect(providerFor('company.com', 'aspmx.l.google.com').key).toBe('google');
		expect(providerFor('hotmail.co.uk').key).toBe('microsoft');
		expect(providerFor('example.org').key).toBe('domain:example.org');
	});

	test('connection cap, per-minute budget and back-off', () => {
		let now = 0;
		const shaper = new Shaper(() => now);
		const limits = { connections: 1, perMinute: 2 };
		expect(shaper.budget('k', limits)).toBe(2);
		shaper.open('k');
		expect(shaper.budget('k', limits)).toBe(0);
		shaper.close('k');
		shaper.sent('k');
		shaper.sent('k');
		expect(shaper.budget('k', limits)).toBe(0);
		now = 61_000;
		expect(shaper.budget('k', limits)).toBe(2);
		expect(shaper.throttled('k')).toBe(300_000);
		expect(shaper.budget('k', limits)).toBe(0);
		expect(shaper.throttled('k')).toBe(600_000);
		now += 600_001;
		expect(shaper.budget('k', limits)).toBe(2);
	});

	test('retry schedule caps at hourly', () => {
		expect([0, 1, 2, 3, 4, 10].map(retryDelaySeconds)).toEqual([60, 300, 900, 1800, 3600, 3600]);
	});
});
