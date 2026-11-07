import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dkimVerify } from 'mailauth';
import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';
import getTLSOptions from 'smtp-server/lib/tls-options';
import { mailHostnames, type EmailEvent, type MailState } from '@skiff/contracts';
import type { MailResolver } from './dns.ts';
import { MailServer } from './server.ts';

// --- fixtures ---------------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const defaults = getTLSOptions();
const TLS = { key: Buffer.from(String(defaults.key)), cert: Buffer.from(String(defaults.cert)) };

function hash(password: string): string {
	const salt = randomBytes(16);
	return `scrypt$${salt.toString('base64url')}$${scryptSync(password, salt, 32).toString('base64url')}`;
}

const HOSTS = mailHostnames('skiff.test');

function state(patch: Partial<MailState> = {}, org: Partial<MailState['orgs'][number]> = {}): MailState {
	return {
		generation: 1,
		hostnames: HOSTS,
		paused: false,
		domains: [
			{ id: 'ed_1', orgId: 'org_a', name: 'example.com', sending: true, receiving: false, dkim: [{ selector: 'skf202611', algorithm: 'rsa-sha256', privateKey: PRIVATE_PEM }] },
		],
		credentials: [{ id: 'ec_1', orgId: 'org_a', projectId: 'prj_1', username: 'skf_test', hash: hash('s3cret-password'), allowedFromDomains: [] }],
		orgs: [{ orgId: 'org_a', state: 'active', perSecond: 100, perDay: 1000, sentToday: 0, verifiedAddresses: [], suppressed: [], ...org }],
		platformSuppressed: [],
		...patch,
	};
}

/** A fake recipient MX: replies per recipient, records what it accepted. */
class FakeMx {
	readonly received: Array<{ from: string; to: string[]; raw: Buffer }> = [];
	readonly replies = new Map<string, { code: number; message: string }>();
	private server!: SMTPServer;
	port = 0;

	async start(): Promise<void> {
		this.server = new SMTPServer({
			authOptional: true,
			disabledCommands: ['AUTH'],
			logger: false,
			onRcptTo: (address, _session, callback) => {
				const reply = this.replies.get(address.address);
				if (!reply) return callback();
				const error = new Error(reply.message) as Error & { responseCode: number };
				error.responseCode = reply.code;
				callback(error);
			},
			onData: (stream, session, callback) => {
				const chunks: Buffer[] = [];
				stream.on('data', (chunk: Buffer) => chunks.push(chunk));
				stream.on('end', () => {
					this.received.push({
						from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
						to: session.envelope.rcptTo.map((entry) => entry.address),
						raw: Buffer.concat(chunks),
					});
					callback();
				});
			},
		});
		await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		const address = this.server.server.address();
		this.port = typeof address === 'object' && address ? address.port : 0;
	}

	stop(): Promise<void> {
		return new Promise((resolve) => this.server.close(() => resolve()));
	}
}

const resolver: MailResolver = {
	async resolveMx(domain) {
		if (domain === 'nowhere.invalid') throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
		if (domain === 'nullmx.org') return [{ exchange: '', priority: 0 }];
		return [{ exchange: `mx.${domain}`, priority: 10 }];
	},
	async resolve4() {
		return ['127.0.0.1'];
	},
	async resolve6() {
		return [];
	},
};

async function dkimResult(raw: Buffer): Promise<string[]> {
	const result = await dkimVerify(raw, {
		resolver: async (name: string, type: string) => {
			if (type === 'TXT' && name === 'skf202611._domainkey.example.com') return [[`v=DKIM1; k=rsa; p=${PUBLIC_B64}`]];
			throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
		},
	});
	return result.results.map((entry) => entry.status.result);
}

// --- harness ----------------------------------------------------------------------------------

let mx: FakeMx;
let dir: string;
let server: MailServer;
let clock = Date.parse('2026-11-07T12:00:00Z');

beforeAll(async () => {
	mx = new FakeMx();
	await mx.start();
});
afterAll(() => mx.stop());

beforeEach(async () => {
	mx.received.length = 0;
	mx.replies.clear();
	clock = Date.parse('2026-11-07T12:00:00Z');
	dir = mkdtempSync(join(tmpdir(), 'skiff-mail-'));
	server = new MailServer({
		dataDir: dir,
		controlSocket: null,
		listen: { host: '127.0.0.1', inbound: 0, submission: 0, submissions: 0 },
		tls: TLS,
		deliveryPort: mx.port,
		resolver,
		now: () => clock,
		log: () => {},
		tickMs: 0,
	});
	await server.start();
	server.loadState(state());
});

afterEach(async () => {
	await server.stop();
	rmSync(dir, { recursive: true, force: true });
});

async function drain(): Promise<void> {
	for (let i = 0; i < 50; i++) {
		await server.queue.tick();
		await Bun.sleep(5);
		while (server.queue.busy) await Bun.sleep(5);
		if (server.spool.due(clock).length === 0) return;
	}
}

function submit(message: Record<string, unknown>, options: { port?: 'submission' | 'submissions'; password?: string } = {}) {
	const port = options.port ?? 'submission';
	const transport = nodemailer.createTransport({
		host: '127.0.0.1',
		port: server.port(port)!,
		secure: port === 'submissions',
		requireTLS: port === 'submission',
		tls: { rejectUnauthorized: false },
		auth: { user: 'skf_test', pass: options.password ?? 's3cret-password' },
	});
	return transport.sendMail({ from: 'App <hi@example.com>', subject: 'Hello', text: 'Hello there', ...message });
}

function events(): EmailEvent[] {
	return server.spool.events(0, 1000);
}

async function control(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await server.handle(
		new Request(`http://mail${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
	);
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// --- tests ------------------------------------------------------------------------------------

describe('submission', () => {
	test('STARTTLS + AUTH, DKIM-signed, delivered with a VERP return path', async () => {
		const info = await submit({ to: 'friend@example.org' });
		expect(info.response).toContain('Queued as em_');
		await drain();
		expect(mx.received).toHaveLength(1);
		const delivered = mx.received[0]!;
		expect(delivered.to).toEqual(['friend@example.org']);
		expect(delivered.from).toMatch(/^b-em_[a-z0-9]+-0@bounces\.skiff\.test$/);
		expect(await dkimResult(delivered.raw)).toEqual(['pass']);
		const headers = delivered.raw.toString('latin1');
		expect(headers).toMatch(/^X-Skiff-Id: em_/m);
		expect(headers).toMatch(/^Message-ID: </m);
		expect(events().map((event) => event.kind)).toEqual(['accepted', 'delivered']);
		expect(events()[1]).toMatchObject({ orgId: 'org_a', projectId: 'prj_1', source: 'smtp', recipient: 'friend@example.org', tls: true });
		// Delivered messages leave the spool.
		expect(server.spool.counts()).toMatchObject({ queued: 0, deferred: 0 });
	});

	test('implicit TLS on 465 works too', async () => {
		await submit({ to: 'friend@example.org' }, { port: 'submissions' });
		await drain();
		expect(mx.received).toHaveLength(1);
	});

	test('wrong password is refused', async () => {
		await expect(submit({ to: 'friend@example.org' }, { password: 'nope' })).rejects.toThrow(/535/);
	});

	test('AUTH without TLS is refused', async () => {
		const transport = nodemailer.createTransport({
			host: '127.0.0.1',
			port: server.port('submission')!,
			ignoreTLS: true,
			auth: { user: 'skf_test', pass: 's3cret-password' },
		});
		await expect(transport.sendMail({ from: 'hi@example.com', to: 'a@example.org', text: 'x' })).rejects.toThrow();
	});

	test('policy refusals carry the reason', async () => {
		await expect(submit({ from: 'hi@unverified.com', to: 'friend@example.org' })).rejects.toThrow(/not a verified sending domain/);
		server.loadState(state({ generation: 2 }, { state: 'sandbox' }));
		await expect(submit({ to: 'stranger@example.org' })).rejects.toThrow(/sandbox/);
		await submit({ to: 'team@example.com' });
	});

	test('a paused org is refused; a daily quota is a temporary failure', async () => {
		server.loadState(state({ generation: 2 }, { state: 'paused' }));
		await expect(submit({ to: 'friend@example.org' })).rejects.toThrow(/550/);
		server.loadState(state({ generation: 3 }, { perDay: 1, sentToday: 1 }));
		await expect(submit({ to: 'friend@example.org' })).rejects.toThrow(/451/);
	});

	test('suppressed recipients are dropped with an event', async () => {
		server.loadState(state({ generation: 2 }, { suppressed: ['gone@example.org'] }));
		await submit({ to: ['gone@example.org', 'friend@example.org'] });
		await drain();
		expect(mx.received.map((message) => message.to[0])).toEqual(['friend@example.org']);
		expect(events().map((event) => event.kind).sort()).toEqual(['accepted', 'delivered', 'suppressed']);
		await expect(submit({ to: 'gone@example.org' })).rejects.toThrow(/suppression list/);
	});
});

describe('delivery outcomes', () => {
	test('a 550 5.1.1 is a hard bounce and suppresses the address', async () => {
		mx.replies.set('nobody@example.org', { code: 550, message: '5.1.1 The email account that you tried to reach does not exist' });
		await submit({ to: 'nobody@example.org' });
		await drain();
		const bounced = events().find((event) => event.kind === 'bounced');
		expect(bounced).toMatchObject({ severity: 'hard', bounceClass: 'invalid-recipient', recipient: 'nobody@example.org' });
		expect(server.policy.isSuppressed('org_a', 'Nobody@example.org')).toBe(true);
	});

	test('a 451 defers and retries on schedule', async () => {
		mx.replies.set('later@example.org', { code: 451, message: '4.7.0 Try again later' });
		await submit({ to: 'later@example.org' });
		await drain();
		expect(events().map((event) => event.kind)).toEqual(['accepted', 'deferred']);
		expect(server.spool.counts().deferred).toBe(1);
		mx.replies.delete('later@example.org');
		clock += 59_000;
		await drain();
		expect(mx.received).toHaveLength(0);
		clock += 2_000;
		await drain();
		expect(mx.received).toHaveLength(1);
		expect(events().map((event) => event.kind)).toEqual(['accepted', 'deferred', 'delivered']);
		expect(events().at(-1)!.attempt).toBe(2);
	});

	test('deferrals past the expiry bounce as expired', async () => {
		mx.replies.set('later@example.org', { code: 450, message: '4.2.1 Mailbox temporarily unavailable' });
		await submit({ to: 'later@example.org' });
		await drain();
		clock += 3 * 86_400_000;
		await drain();
		expect(events().at(-1)).toMatchObject({ kind: 'bounced', severity: 'soft', bounceClass: 'expired' });
		expect(server.spool.counts()).toMatchObject({ queued: 0, deferred: 0 });
	});

	test('a domain that does not exist or has a null MX bounces at once', async () => {
		await submit({ to: ['a@nowhere.invalid', 'b@nullmx.org'] });
		await drain();
		const bounced = events().filter((event) => event.kind === 'bounced');
		expect(bounced.map((event) => event.bounceClass)).toEqual(['bad-domain', 'bad-domain']);
	});

	test('a globally paused state spools but does not deliver', async () => {
		server.loadState(state({ generation: 2, paused: true }));
		await submit({ to: 'friend@example.org' });
		await drain();
		expect(mx.received).toHaveLength(0);
		server.loadState(state({ generation: 3, paused: false }));
		await drain();
		expect(mx.received).toHaveLength(1);
	});
});

describe('control API', () => {
	const raw = Buffer.from('From: App <hi@example.com>\r\nTo: friend@example.org\r\nSubject: Via API\r\n\r\nHello\r\n').toString('base64');
	const inject = { messageId: 'em_0123456789abcdef0123456789abcdef', orgId: 'org_a', projectId: null, from: 'hi@example.com', recipients: ['friend@example.org'], raw, tags: { kind: 'welcome' } };

	test('health reports listeners, state and queue', async () => {
		const { body } = await control('GET', '/health');
		expect(body).toMatchObject({ ok: true, generation: 1, queued: 0, tls: true });
	});

	test('inject signs, spools and delivers; it is idempotent', async () => {
		expect((await control('POST', '/inject', inject)).status).toBe(200);
		expect((await control('POST', '/inject', inject)).body).toMatchObject({ duplicate: true });
		await drain();
		expect(mx.received).toHaveLength(1);
		expect(await dkimResult(mx.received[0]!.raw)).toEqual(['pass']);
		expect(events()[0]).toMatchObject({ kind: 'accepted', source: 'api', tags: { kind: 'welcome' } });
	});

	test('inject refuses a domain without a key or of another org', async () => {
		expect((await control('POST', '/inject', { ...inject, from: 'x@other.com' })).status).toBe(409);
		expect((await control('POST', '/inject', { ...inject, orgId: 'org_b' })).status).toBe(409);
	});

	test('events page by cursor and acks delete them', async () => {
		await control('POST', '/inject', inject);
		await drain();
		const first = (await control('GET', '/events?after=0&limit=1')).body.events as EmailEvent[];
		expect(first).toHaveLength(1);
		const rest = (await control('GET', `/events?after=${first[0]!.seq}`)).body.events as EmailEvent[];
		expect(rest.map((event) => event.kind)).toEqual(['delivered']);
		await control('POST', '/events/ack', { upTo: rest[0]!.seq });
		expect(server.spool.pendingEvents()).toBe(0);
	});

	test('a bad state push is refused and the old state stays', async () => {
		expect((await control('PUT', '/state', { generation: 'x' })).status).toBe(422);
		expect(server.policy.generation).toBe(1);
	});
});

describe('port 25', () => {
	function inbound(from: string, to: string, raw: string) {
		const transport = nodemailer.createTransport({ host: '127.0.0.1', port: server.port('inbound')!, secure: false, ignoreTLS: true });
		return transport.sendMail({ envelope: { from, to: [to] }, raw });
	}

	test('refuses to relay', async () => {
		await expect(inbound('spammer@evil.test', 'victim@example.org', 'Subject: x\r\n\r\nx\r\n')).rejects.toThrow(/550/);
		await expect(inbound('spammer@evil.test', 'b-nope@bounces.skiff.test', 'Subject: x\r\n\r\nx\r\n')).rejects.toThrow(/550/);
	});

	test('an asynchronous DSN to the VERP address becomes a hard bounce', async () => {
		await submit({ to: 'friend@example.org' });
		await drain();
		const returnPath = mx.received[0]!.from;
		const dsn = [
			'From: MAILER-DAEMON@mx.example.org',
			`To: ${returnPath}`,
			'Subject: Undelivered Mail Returned to Sender',
			'MIME-Version: 1.0',
			'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
			'',
			'--b1',
			'Content-Type: text/plain',
			'',
			'Your message could not be delivered.',
			'--b1',
			'Content-Type: message/delivery-status',
			'',
			'Reporting-MTA: dns; mx.example.org',
			'',
			'Final-Recipient: rfc822; friend@example.org',
			'Action: failed',
			'Status: 5.1.1',
			'Diagnostic-Code: smtp; 550 5.1.1 <friend@example.org>: Recipient address rejected: User unknown',
			'--b1--',
			'',
		].join('\r\n');
		await inbound('', returnPath, dsn);
		const bounced = events().find((event) => event.kind === 'bounced');
		expect(bounced).toMatchObject({ source: 'inbound', bounceClass: 'invalid-recipient', recipient: 'friend@example.org', orgId: 'org_a' });
		expect(server.policy.isSuppressed('org_a', 'friend@example.org')).toBe(true);
	});

	test('an ARF complaint is matched by the X-Skiff-Id header', async () => {
		await submit({ to: 'friend@example.org' });
		await drain();
		const original = mx.received[0]!.raw.toString('latin1').split('\r\n\r\n')[0];
		const arf = [
			'From: feedback@isp.example',
			'To: fbl@bounces.skiff.test',
			'Subject: complaint',
			'MIME-Version: 1.0',
			'Content-Type: multipart/report; report-type=feedback-report; boundary="b2"',
			'',
			'--b2',
			'Content-Type: text/plain',
			'',
			'This is an abuse report.',
			'--b2',
			'Content-Type: message/feedback-report',
			'',
			'Feedback-Type: abuse',
			'User-Agent: ISP-FBL/1.0',
			'Version: 1',
			'Source-IP: 203.0.113.9',
			'--b2',
			'Content-Type: text/rfc822-headers',
			'',
			original,
			'--b2--',
			'',
		].join('\r\n');
		await inbound('feedback@isp.example', 'fbl@bounces.skiff.test', arf);
		const complaint = events().find((event) => event.kind === 'complained');
		expect(complaint).toMatchObject({ feedbackType: 'abuse', recipient: 'friend@example.org', orgId: 'org_a' });
		expect(server.policy.isSuppressed('org_a', 'friend@example.org')).toBe(true);
	});
});
