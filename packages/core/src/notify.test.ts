import { describe, expect, test } from 'bun:test';
import { SMS_MAX_LENGTH, SmsNotifier, TwilioSmsTransport, WebhookNotifier, smsBody } from './notify.ts';
import { webhookNotifierFor } from './notify-chat.ts';
import { signWebhookBody, verifyWebhookSignature } from './webhook-signature.ts';

const SID = `AC${'a'.repeat(32)}`;
const TOKEN = 'b'.repeat(32);

function stubFetch(respond: (url: string, init: RequestInit) => Response) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		calls.push({ url, init });
		return respond(url, init);
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('TwilioSmsTransport', () => {
	test('posts a form-encoded message with basic auth', async () => {
		const { fetch, calls } = stubFetch(() => json({ sid: 'SM123' }, 201));
		const transport = new TwilioSmsTransport({ accountSid: SID, authToken: TOKEN, from: '+447700900000', fetch });
		expect(await transport.send('+447700900123', 'hello')).toEqual({ sid: 'SM123' });

		const [call] = calls;
		expect(call!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
		expect(call!.init.method).toBe('POST');
		const headers = call!.init.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
		const form = call!.init.body as URLSearchParams;
		expect(form.get('To')).toBe('+447700900123');
		expect(form.get('From')).toBe('+447700900000');
		expect(form.get('Body')).toBe('hello');
		expect(form.has('MessagingServiceSid')).toBe(false);
	});

	test('sends through a Messaging Service when FROM is an MG sid', async () => {
		const { fetch, calls } = stubFetch(() => json({ sid: 'SM1' }, 201));
		const service = `MG${'c'.repeat(32)}`;
		await new TwilioSmsTransport({ accountSid: SID, authToken: TOKEN, from: service, fetch }).send('+15005550006', 'x');
		const form = calls[0]!.init.body as URLSearchParams;
		expect(form.get('MessagingServiceSid')).toBe(service);
		expect(form.has('From')).toBe(false);
	});

	test('surfaces the Twilio error message and code', async () => {
		const { fetch } = stubFetch(() => json({ code: 21211, message: "The 'To' number is not a valid phone number." }, 400));
		const transport = new TwilioSmsTransport({ accountSid: SID, authToken: TOKEN, from: '+447700900000', fetch });
		await expect(transport.send('+10000000', 'x')).rejects.toThrow(
			"Twilio returned 400: The 'To' number is not a valid phone number. (Twilio error 21211)",
		);
	});

	test('verify reads the account without sending anything', async () => {
		const { fetch, calls } = stubFetch(() => json({ friendly_name: 'Ops', status: 'active' }));
		const transport = new TwilioSmsTransport({ accountSid: SID, authToken: TOKEN, from: 'Skiff', fetch });
		expect(await transport.verify()).toEqual({ friendlyName: 'Ops', status: 'active' });
		expect(calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}.json`);
		expect(calls[0]!.init.method).toBeUndefined();
	});

	test('verify rejects a suspended account', async () => {
		const { fetch } = stubFetch(() => json({ status: 'suspended' }));
		const transport = new TwilioSmsTransport({ accountSid: SID, authToken: TOKEN, from: 'Skiff', fetch });
		await expect(transport.verify()).rejects.toThrow('the Twilio account is suspended');
	});
});

describe('smsBody', () => {
	test('keeps messages GSM-7 by folding typographic punctuation', () => {
		const body = smsBody({ severity: 'warning', title: 'Disk 85% full', detail: 'Node “edge-1” — it’s at 86%…' });
		expect(body).toBe('Skiff warning: Disk 85% full\nNode "edge-1" - it\'s at 86%...');
	});

	test('caps the length at two segments', () => {
		const body = smsBody({ severity: 'critical', title: 'x', detail: 'y'.repeat(1000) });
		expect(body.length).toBe(SMS_MAX_LENGTH);
		expect(body.endsWith('...')).toBe(true);
	});
});

describe('SmsNotifier', () => {
	test('sends to every number and reports the ones that failed', async () => {
		const sent: string[] = [];
		const notifier = new SmsNotifier(
			{
				async send(to: string) {
					if (to === '+15005550001') throw new Error('invalid number');
					sent.push(to);
					return { sid: 'SM' };
				},
			},
			['+447700900123', '+15005550001', '+447700900456'],
		);
		await expect(notifier.notify({ title: 't', detail: 'd', severity: 'critical' })).rejects.toThrow(
			'+15005550001: invalid number',
		);
		expect(sent).toEqual(['+447700900123', '+447700900456']);
	});
});

describe('WebhookNotifier', () => {
	const alert = {
		key: 'alert_rule:r1',
		title: 'Site down',
		detail: 'shop.example.com: 62.5% 5xx',
		severity: 'critical' as const,
		status: 'firing' as const,
		url: 'https://control.test/alerts/rules/r1',
		labels: { host: 'shop.example.com' },
	};

	test('keeps the original four fields and adds status, url and labels', async () => {
		const { fetch, calls } = stubFetch(() => new Response('ok'));
		await new WebhookNotifier('https://hooks.test/in', { fetch }).notify(alert);
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body).toEqual({
			title: 'Skiff: Site down',
			message: 'shop.example.com: 62.5% 5xx',
			severity: 'critical',
			key: 'alert_rule:r1',
			status: 'firing',
			url: 'https://control.test/alerts/rules/r1',
			labels: { host: 'shop.example.com' },
		});
		// Unsigned without a secret.
		expect((calls[0]!.init.headers as Record<string, string>)['x-skiff-signature']).toBeUndefined();
	});

	test('defaults: firing, no url, no labels', async () => {
		const { fetch, calls } = stubFetch(() => new Response('ok'));
		await new WebhookNotifier('https://hooks.test/in', { fetch }).notify({ key: 'disk:n1', title: 'Disk', detail: 'd', severity: 'warning' });
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body.status).toBe('firing');
		expect(body.url).toBeNull();
		expect(body.labels).toEqual({});
	});

	test('signs the exact body with HMAC-SHA256 when a secret is set', async () => {
		const { fetch, calls } = stubFetch(() => new Response('ok'));
		const now = 1_790_000_000_000;
		await new WebhookNotifier('https://hooks.test/in', { fetch, secret: 'whsec_test_0123456789', now: () => now }).notify({ ...alert, status: 'resolved', severity: 'info' });
		const body = String(calls[0]!.init.body);
		const header = (calls[0]!.init.headers as Record<string, string>)['x-skiff-signature'];
		expect(header).toBe(signWebhookBody('whsec_test_0123456789', body, now / 1000));
		expect(verifyWebhookSignature('whsec_test_0123456789', body, header, { nowMs: now })).toBe(true);
		expect(verifyWebhookSignature('wrong-secret-0123456789', body, header, { nowMs: now })).toBe(false);
		expect(verifyWebhookSignature('whsec_test_0123456789', `${body} `, header, { nowMs: now })).toBe(false);
		// Replays outside the tolerance fail.
		expect(verifyWebhookSignature('whsec_test_0123456789', body, header, { nowMs: now + 10 * 60_000 })).toBe(false);
	});

	test('webhookNotifierFor passes the secret to the generic notifier only', async () => {
		const { fetch, calls } = stubFetch(() => new Response('ok'));
		await webhookNotifierFor('https://hooks.test/in', { secret: 'whsec_test_0123456789', fetch }).notify(alert);
		expect((calls[0]!.init.headers as Record<string, string>)['x-skiff-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
	});

	test('a non-2xx answer is an error', async () => {
		const { fetch } = stubFetch(() => new Response('nope', { status: 500 }));
		await expect(new WebhookNotifier('https://hooks.test/in', { fetch }).notify(alert)).rejects.toThrow('Webhook returned 500');
	});
});
