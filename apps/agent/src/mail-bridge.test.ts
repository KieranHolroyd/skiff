import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMTPServer } from 'smtp-server';
import { mailHostnames, type EmailEvent, type MailInject, type MailState } from '@skiff/contracts';
import { MailServer } from '@skiff/mail';
import { MailBridge, type HelperMailApi } from './mail-bridge.ts';

/** The bridge end to end: control plane (fake) ⇄ agent bridge ⇄ skiff-mail (real) → recipient MX (fake). */

const dir = mkdtempSync(join(tmpdir(), 'skiff-mail-bridge-'));
const socketPath = join(dir, 'mail.sock');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const hostnames = mailHostnames('skiff.test');

const state: MailState = {
	generation: 3,
	hostnames,
	paused: false,
	domains: [
		{ id: 'ed_1', orgId: 'org_a', name: 'example.com', sending: true, receiving: false, dkim: [{ selector: 'skf202611', algorithm: 'rsa-sha256', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }] },
	],
	credentials: [],
	orgs: [{ orgId: 'org_a', state: 'active', perSecond: 10, perDay: 100, sentToday: 0, verifiedAddresses: [], suppressed: [] }],
	platformSuppressed: [],
};

const raw = Buffer.from('From: hi@example.com\r\nTo: friend@example.org\r\nSubject: Bridge\r\n\r\nHello\r\n').toString('base64');
const outbox: MailInject[] = [{ messageId: 'em_00000000000000000000000000000001', orgId: 'org_a', projectId: null, from: 'hi@example.com', recipients: ['friend@example.org'], raw, tags: {} }];

const seen = { acked: [] as string[], events: [] as EmailEvent[], stateFetches: 0 };
let control: ReturnType<typeof Bun.serve>;
let mx: SMTPServer;
let mxPort = 0;
const delivered: string[] = [];
let mail: MailServer;

beforeAll(async () => {
	control = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.headers.get('authorization') !== 'Bearer node-token') return new Response('no', { status: 401 });
			if (url.pathname === '/api/agent/email/state') {
				seen.stateFetches += 1;
				return Response.json(state);
			}
			if (url.pathname === '/api/agent/email/outbox') return Response.json({ messages: outbox.splice(0) });
			if (url.pathname === '/api/agent/email/outbox/ack') {
				seen.acked.push(...((await request.json()) as { messageIds: string[] }).messageIds);
				return Response.json({ acked: 1 });
			}
			if (url.pathname === '/api/agent/email/events') {
				seen.events.push(...((await request.json()) as { events: EmailEvent[] }).events);
				return Response.json({ applied: 1 });
			}
			return new Response('not found', { status: 404 });
		},
	});
	mx = new SMTPServer({
		authOptional: true,
		disabledCommands: ['AUTH'],
		logger: false,
		onData(stream, session, callback) {
			stream.resume();
			stream.on('end', () => {
				delivered.push(...session.envelope.rcptTo.map((entry) => entry.address));
				callback();
			});
		},
	});
	await new Promise<void>((resolve) => mx.listen(0, '127.0.0.1', resolve));
	const address = mx.server.address();
	mxPort = typeof address === 'object' && address ? address.port : 0;
	mail = new MailServer({
		dataDir: join(dir, 'spool'),
		controlSocket: socketPath,
		listen: { host: '127.0.0.1', inbound: null, submission: null, submissions: null },
		deliveryPort: mxPort,
		resolver: {
			resolveMx: async (domain) => [{ exchange: `mx.${domain}`, priority: 10 }],
			resolve4: async () => ['127.0.0.1'],
			resolve6: async () => [],
		},
		log: () => {},
		tickMs: 0,
	});
	await mail.start();
});

afterAll(async () => {
	await mail.stop();
	control.stop(true);
	await new Promise<void>((resolve) => mx.close(() => resolve()));
	rmSync(dir, { recursive: true, force: true });
});

describe('mail bridge', () => {
	const calls: string[] = [];
	const helper: HelperMailApi = {
		mailStart: async () => void calls.push('start'),
		mailStop: async () => void calls.push('stop'),
		mailTls: async (host) => {
			calls.push(`tls:${host}`);
			return { found: false, changed: false };
		},
	};
	const logs: string[] = [];
	const bridge = new MailBridge({
		controlUrl: `http://127.0.0.1:${0}`,
		nodeToken: 'node-token',
		socketPath,
		helper,
		log: (_level, message) => logs.push(message),
		intervalMs: 60_000,
		outboxWaitSeconds: 0,
		loops: false,
	});

	test('starts skiff-mail, pushes state once, and asks for the submission certificate', async () => {
		(bridge as unknown as { options: { controlUrl: string } }).options.controlUrl = `http://127.0.0.1:${control.port}`;
		bridge.apply({ generation: 3, hostnames });
		await bridge.tick();
		expect(calls.slice(0, 2)).toEqual(['start', `tls:${hostnames.submission}`]);
		expect(seen.stateFetches).toBe(1);
		expect(mail.policy.generation).toBe(3);
		await bridge.tick();
		expect(seen.stateFetches).toBe(1);
	});

	test('outbox → skiff-mail → MX, with the ack sent only once spooled', async () => {
		expect(await bridge.drainOutbox(0)).toBe(1);
		expect(seen.acked).toEqual(['em_00000000000000000000000000000001']);
		await mail.queue.tick();
		while (mail.queue.busy) await Bun.sleep(5);
		expect(delivered).toEqual(['friend@example.org']);
	});

	test('events reach the control plane and are acked out of the spool', async () => {
		await bridge.tick();
		expect(seen.events.map((event) => event.kind)).toEqual(['accepted', 'delivered']);
		expect(mail.spool.pendingEvents()).toBe(0);
	});

	test('a newer generation is pushed; leaving the mail role stops skiff-mail', async () => {
		state.generation = 4;
		bridge.apply({ generation: 4, hostnames });
		await bridge.tick();
		expect(mail.policy.generation).toBe(4);
		bridge.apply(null);
		await Bun.sleep(10);
		expect(calls.at(-1)).toBe('stop');
		expect(bridge.isActive).toBe(false);
		await bridge.close();
	});
});
