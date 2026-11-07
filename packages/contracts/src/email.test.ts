import { describe, expect, test } from 'bun:test';
import {
	authorizeSend,
	dkimRecordValue,
	dkimSelector,
	emailDomainNameSchema,
	emailSendSchema,
	mergeSpf,
	parseAddress,
	parseVerp,
	spfIncludes,
	verpAddress,
	type EmailPolicyOrg,
} from './email.ts';

const org = (patch: Partial<EmailPolicyOrg> = {}): EmailPolicyOrg => ({
	orgId: 'org_1',
	state: 'active',
	perSecond: 10,
	perDay: 1000,
	sendingDomains: ['example.com'],
	verifiedAddresses: [],
	...patch,
});
const usage = { sentToday: 0, sentLastSecond: 0 };
const none = () => false;

describe('parseAddress', () => {
	test('accepts ordinary addresses and lowercases the domain', () => {
		expect(parseAddress('Ann.Lee+tag@Example.COM')).toEqual({
			local: 'Ann.Lee+tag',
			domain: 'example.com',
			address: 'Ann.Lee+tag@example.com',
		});
	});
	test.each(['', 'no-at', '@example.com', 'a@', 'a b@example.com', 'a@localhost', '.a@example.com', 'a..b@example.com', 'a@exa_mple.com', 'a@1.2.3.4'])(
		'refuses %p',
		(value) => expect(parseAddress(value)).toBeNull(),
	);
});

describe('emailDomainNameSchema', () => {
	test('normalises case and refuses single labels and wildcards', () => {
		expect(emailDomainNameSchema.parse('Mail.Example.com')).toBe('mail.example.com');
		expect(emailDomainNameSchema.safeParse('localhost').success).toBe(false);
		expect(emailDomainNameSchema.safeParse('*.example.com').success).toBe(false);
		expect(emailDomainNameSchema.safeParse('-bad.example.com').success).toBe(false);
	});
});

describe('emailSendSchema', () => {
	const base = { from: 'hi@example.com', to: ['a@b.org'], subject: 'Hello', text: 'x' };
	test('accepts the documented shape', () => {
		const parsed = emailSendSchema.parse({ ...base, from: { name: 'Hi', address: 'hi@example.com' }, tags: { kind: 'welcome' } });
		expect(parsed.cc).toEqual([]);
		expect(parsed.tags).toEqual({ kind: 'welcome' });
	});
	test('needs a recipient and a body', () => {
		expect(emailSendSchema.safeParse({ ...base, to: [] }).success).toBe(false);
		expect(emailSendSchema.safeParse({ from: base.from, to: base.to, subject: 'x' }).success).toBe(false);
	});
	test('refuses header injection and reserved headers', () => {
		expect(emailSendSchema.safeParse({ ...base, subject: 'a\r\nBcc: x@y.z' }).success).toBe(false);
		expect(emailSendSchema.safeParse({ ...base, headers: { 'X-Ok': 'a\nb' } }).success).toBe(false);
		expect(emailSendSchema.safeParse({ ...base, headers: { From: 'x@y.z' } }).success).toBe(false);
		expect(emailSendSchema.safeParse({ ...base, headers: { 'X-Skiff-Org': 'x' } }).success).toBe(false);
		expect(emailSendSchema.safeParse({ ...base, headers: { 'X-Campaign': 'spring' } }).success).toBe(true);
	});
	test('caps the total recipient count', () => {
		const many = Array.from({ length: 30 }, (_, i) => `r${i}@b.org`);
		expect(emailSendSchema.safeParse({ ...base, to: many, cc: many }).success).toBe(false);
	});
	test('raw excludes text/html', () => {
		expect(emailSendSchema.safeParse({ ...base, raw: 'Subject: x\r\n\r\nx' }).success).toBe(false);
		expect(emailSendSchema.safeParse({ from: base.from, to: base.to, raw: 'Subject: x\r\n\r\nx' }).success).toBe(true);
	});
});

describe('authorizeSend', () => {
	const send = (recipients: string[], from = 'hi@example.com', sizeBytes = 100) => ({ from, recipients, sizeBytes });

	test('passes a normal message and dedupes recipients', () => {
		const result = authorizeSend(org(), send(['a@b.org', 'A@B.org', 'c@d.org']), usage, none);
		expect(result).toEqual({ ok: true, deliver: ['A@b.org', 'c@d.org'], suppressed: [] });
	});

	test('checks run in the documented order', () => {
		// Paused beats everything, even an unverified sender.
		expect(authorizeSend(org({ state: 'paused' }), send(['a@b.org'], 'x@nope.com'), usage, none)).toMatchObject({ ok: false, code: 'email_paused' });
		expect(authorizeSend(org(), send(['a@b.org'], 'x@nope.com'), usage, none)).toMatchObject({ ok: false, code: 'from_not_verified' });
		expect(authorizeSend(org(), send(['not-an-address']), usage, none)).toMatchObject({ ok: false, code: 'invalid_address' });
		expect(authorizeSend(org(), send([]), usage, none)).toMatchObject({ ok: false, code: 'no_recipients' });
	});

	test('a subdomain is a different identity', () => {
		expect(authorizeSend(org(), send(['a@b.org'], 'x@mail.example.com'), usage, none)).toMatchObject({ code: 'from_not_verified' });
	});

	test('credential allowlist narrows the sending domains', () => {
		const o = org({ sendingDomains: ['example.com', 'other.com'] });
		expect(authorizeSend(o, { ...send(['a@b.org'], 'x@other.com'), allowedFromDomains: ['example.com'] }, usage, none)).toMatchObject({ code: 'from_not_allowed' });
		expect(authorizeSend(o, { ...send(['a@b.org']), allowedFromDomains: ['example.com'] }, usage, none).ok).toBe(true);
	});

	test('sandbox allows own domains and verified addresses only', () => {
		const sandbox = org({ state: 'sandbox', verifiedAddresses: ['Me@Gmail.com'] });
		expect(authorizeSend(sandbox, send(['team@example.com', 'me@gmail.com']), usage, none).ok).toBe(true);
		expect(authorizeSend(sandbox, send(['team@example.com', 'stranger@gmail.com']), usage, none)).toMatchObject({
			code: 'sandbox_recipient',
		});
	});

	test('size, quota and rate', () => {
		expect(authorizeSend(org(), send(['a@b.org'], 'hi@example.com', 11 * 1024 * 1024), usage, none)).toMatchObject({ code: 'message_too_large' });
		expect(authorizeSend(org(), send(['a@b.org']), { sentToday: 1000, sentLastSecond: 0 }, none)).toMatchObject({ code: 'daily_quota', temporary: true });
		expect(authorizeSend(org(), send(['a@b.org']), { sentToday: 0, sentLastSecond: 10 }, none)).toMatchObject({ code: 'rate_limited', temporary: true });
	});

	test('suppressed recipients are dropped unless all are', () => {
		const suppressed = (address: string) => address === 'gone@b.org';
		expect(authorizeSend(org(), send(['gone@b.org', 'ok@b.org']), usage, suppressed)).toEqual({ ok: true, deliver: ['ok@b.org'], suppressed: ['gone@b.org'] });
		expect(authorizeSend(org(), send(['Gone@B.org']), usage, suppressed)).toMatchObject({ ok: false, code: 'all_suppressed' });
	});
});

describe('VERP', () => {
	test('round-trips message id and recipient index', () => {
		const address = verpAddress('em_0123456789abcdef', 7, 'bounces.example.dev');
		expect(address).toBe('b-em_0123456789abcdef-7@bounces.example.dev');
		expect(parseVerp(address, 'bounces.example.dev')).toEqual({ messageId: 'em_0123456789abcdef', recipientIndex: 7 });
	});
	test('ignores other domains and shapes', () => {
		expect(parseVerp('b-em_0123456789abcdef-7@evil.dev', 'bounces.example.dev')).toBeNull();
		expect(parseVerp('postmaster@bounces.example.dev', 'bounces.example.dev')).toBeNull();
	});
});

describe('DNS helpers', () => {
	test('DKIM record and selector', () => {
		expect(dkimRecordValue('AAAA')).toBe('v=DKIM1; k=rsa; p=AAAA');
		expect(dkimSelector(new Date('2026-11-07T00:00:00Z'))).toBe('skf202611');
	});
	test('SPF merge keeps the existing qualifier and never duplicates', () => {
		const inc = 'include:_spf.skiff.dev';
		expect(mergeSpf(null, inc)).toBe('v=spf1 include:_spf.skiff.dev ~all');
		expect(mergeSpf('v=spf1 include:_spf.google.com -all', inc)).toBe('v=spf1 include:_spf.google.com include:_spf.skiff.dev -all');
		expect(mergeSpf('v=spf1 mx', inc)).toBe('v=spf1 mx include:_spf.skiff.dev ~all');
		expect(mergeSpf('v=spf1 include:_spf.skiff.dev ~all', inc)).toBe('v=spf1 include:_spf.skiff.dev ~all');
		expect(spfIncludes('v=spf1 +include:_spf.skiff.dev ~all', inc)).toBe(true);
		expect(spfIncludes('v=spf1 mx ~all', inc)).toBe(false);
	});
});
