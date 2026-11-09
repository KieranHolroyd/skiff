import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir = '';
let server: ReturnType<typeof Bun.serve> | undefined;

interface Seen {
	method: string;
	path: string;
	body: unknown;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'yoal-cli-email-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

const dkimValue = `v=DKIM1; k=rsa; p=${'M'.repeat(200)}`;

function domain(overrides: Record<string, unknown> = {}) {
	return {
		id: 'ed_1',
		name: 'example.com',
		status: 'pending',
		sending: true,
		receiving: false,
		dkimSelector: 'skf202611',
		records: [
			{ purpose: 'dkim', type: 'TXT', name: 'skf202611._domainkey.example.com', value: dkimValue, required: true, ok: false, found: [], managed: false, note: null },
			{ purpose: 'spf', type: 'TXT', name: 'example.com', value: 'v=spf1 include:_spf.yoal.example ~all', required: true, ok: true, found: ['v=spf1 include:_spf.yoal.example ~all'], managed: false, note: null },
			{ purpose: 'dmarc', type: 'TXT', name: '_dmarc.example.com', value: 'v=DMARC1; p=none', required: false, ok: false, found: [], managed: true, note: null },
		],
		lastCheckedAt: null,
		verifiedAt: null,
		failingSince: null,
		createdAt: '2026-11-07T10:00:00.000Z',
		...overrides,
	};
}

function message(overrides: Record<string, unknown> = {}) {
	return {
		id: 'em_abc12345',
		from: 'hi@example.com',
		subject: 'Hello',
		projectId: null,
		source: 'api',
		tags: { campaign: 'nov' },
		status: 'delivered',
		recipients: [
			{ address: 'you@example.org', status: 'delivered', lastResponse: '250 2.0.0 OK', updatedAt: '2026-11-07T10:00:05.000Z' },
			{ address: 'gone@example.org', status: 'bounced', lastResponse: '550 5.1.1 no such user', updatedAt: '2026-11-07T10:00:06.000Z' },
		],
		createdAt: '2026-11-07T10:00:00.000Z',
		...overrides,
	};
}

/** A fake control plane: `routes` maps `METHOD /path` to a JSON body (or a Response). */
function serve(routes: Record<string, unknown>): Seen[] {
	const seen: Seen[] = [];
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = await request.text();
			seen.push({ method: request.method, path: `${url.pathname}${url.search}`, body: text ? JSON.parse(text) : undefined });
			const route = routes[`${request.method} ${url.pathname}${url.search}`] ?? routes[`${request.method} ${url.pathname}`];
			if (route === undefined) return Response.json({ error: 'not_found', message: 'no route' }, { status: 404 });
			return route instanceof Response ? route : Response.json(route);
		},
	});
	return seen;
}

async function cli(...args: string[]) {
	const child = Bun.spawn([process.execPath, 'src/main.ts', ...args], {
		cwd: join(import.meta.dir, '../..'),
		env: {
			...process.env,
			YOAL_CONFIG_DIR: dir,
			YOAL_URL: `http://127.0.0.1:${server!.port}`,
			YOAL_TOKEN: 'yoal_test',
			YOAL_CONTENT_DOMAIN: '',
			YOAL_PROFILE: '',
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const code = await child.exited;
	return { code, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

describe('yoal email', () => {
	test('status is the default and prints state, limits and usage', async () => {
		serve({
			'GET /api/v1/email': {
				org: { state: 'active', perSecond: 10, perDay: 10_000, sentToday: 42, bounceRate: 0.01, complaintRate: 0, windowMessages: 900, pausedReason: null },
				settings: null,
			},
		});
		const result = await cli('mail');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('active — sending to anyone');
		expect(result.stdout).toContain('42 of 10,000');
		expect(result.stdout).toContain('1.0%');
	});

	test('domains add sends the flags and prints the records to create, not the managed ones', async () => {
		const seen = serve({ 'POST /api/v1/email/domains': new Response(JSON.stringify(domain()), { status: 201, headers: { 'content-type': 'application/json' } }) });
		const result = await cli('email', 'domains', 'add', 'example.com', '--no-auto-dns', '--no-sending');
		expect(result.code).toBe(0);
		expect(seen[0]).toEqual({ method: 'POST', path: '/api/v1/email/domains', body: { name: 'example.com', sending: false, autoDns: false } });
		expect(result.stdout).toContain('Added example.com (pending).');
		expect(result.stdout).toContain(dkimValue);
		expect(result.stdout).toContain('Yoal created 1 record through Cloudflare: DMARC.');
		expect(result.stdout).not.toContain('_dmarc.example.com');
		expect(result.stdout).toContain('yoal email domains check example.com');
	});

	test('domains add without flags leaves the server defaults alone', async () => {
		const seen = serve({ 'POST /api/v1/email/domains': { domain: domain() } });
		const result = await cli('email', 'domains', 'add', 'example.com');
		expect(result.code).toBe(0);
		expect(seen[0]?.body).toEqual({ name: 'example.com' });
	});

	test('domains list accepts the wrapped list shape', async () => {
		serve({ 'GET /api/v1/email/domains': { domains: [domain({ status: 'verified' })] } });
		const result = await cli('email', 'domains');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('example.com');
		expect(result.stdout).toContain('verified');
		expect(result.stdout).toContain('1/2');
	});

	test('domains check posts and shows what public DNS returned', async () => {
		const seen = serve({ 'POST /api/v1/email/domains/example.com/check': domain() });
		const result = await cli('email', 'domains', 'check', 'example.com');
		expect(result.code).toBe(0);
		expect(seen[0]?.method).toBe('POST');
		expect(result.stdout).toContain('example.com is pending: 1 of 2 required records check out.');
		expect(result.stdout).toContain('DKIM skf202611._domainkey.example.com: not found');
	});

	test('domains rm refuses without a terminal or --yes, and deletes with --yes', async () => {
		let seen = serve({});
		const refused = await cli('email', 'domains', 'rm', 'example.com');
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain('Not confirmed');
		expect(seen).toHaveLength(0);
		server?.stop(true);
		seen = serve({ 'DELETE /api/v1/email/domains/example.com': new Response(null, { status: 204 }) });
		const result = await cli('email', 'domains', 'rm', 'example.com', '--yes');
		expect(result.code).toBe(0);
		expect(seen[0]?.method).toBe('DELETE');
		expect(result.stdout).toContain('Removed example.com.');
	});

	test('send builds the message from flags and files and prints accepted and suppressed', async () => {
		const html = join(dir, 'body.html');
		await writeFile(html, '<p>Hi</p>');
		const seen = serve({
			'POST /api/v1/email/send': new Response(
				JSON.stringify({ id: 'em_abc12345', accepted: ['a@x.com', 'b@y.com'], suppressed: ['c@z.com'] }),
				{ status: 202, headers: { 'content-type': 'application/json' } },
			),
		});
		const result = await cli(
			'email', 'send',
			'--from', 'hi@example.com',
			'--to', 'a@x.com,b@y.com', '--bcc', 'c@z.com',
			'--subject', 'Hello',
			'--text', 'Plain',
			'--html-file', html,
			'--tag', 'campaign=nov', '--tag', 'tier=1',
		);
		expect(result.code).toBe(0);
		expect(seen[0]?.body).toEqual({
			from: 'hi@example.com',
			to: ['a@x.com', 'b@y.com'],
			bcc: ['c@z.com'],
			subject: 'Hello',
			text: 'Plain',
			html: '<p>Hi</p>',
			tags: { campaign: 'nov', tier: '1' },
		});
		expect(result.stdout).toContain('Queued em_abc12345 for 2 recipients: a@x.com, b@y.com.');
		expect(result.stdout).toContain('Not sent to c@z.com: on the suppression list');
	});

	test('send checks its required flags before calling the server', async () => {
		const seen = serve({});
		const noBody = await cli('email', 'send', '--from', 'hi@example.com', '--to', 'a@x.com', '--subject', 'Hi');
		expect(noBody.code).toBe(1);
		expect(noBody.stderr).toContain('Give a body');
		const noTo = await cli('email', 'send', '--from', 'hi@example.com', '--subject', 'Hi', '--text', 'x');
		expect(noTo.stderr).toContain('Add at least one recipient');
		const both = await cli('email', 'send', '--from', 'hi@example.com', '--to', 'a@x.com', '--subject', 'Hi', '--text', 'x', '--text-file', 'y');
		expect(both.stderr).toContain('--text or --text-file, not both');
		expect(seen).toHaveLength(0);
	});

	test('log lists with filters; log <id> shows each recipient', async () => {
		const seen = serve({
			'GET /api/v1/email/messages': { messages: [message()] },
			'GET /api/v1/email/messages/em_abc12345': {
				message: message(),
				events: [
					{ kind: 'accepted', at: '2026-11-07T10:00:00.000Z', recipient: null },
					{ kind: 'bounced', at: '2026-11-07T10:00:06.000Z', recipient: 'gone@example.org', bounceClass: 'invalid-recipient', response: '550 5.1.1' },
				],
			},
		});
		const list = await cli('email', 'log', '--limit', '5', '--recipient', 'you@example.org', '--status', 'delivered');
		expect(list.code).toBe(0);
		expect(seen[0]?.path).toBe('/api/v1/email/messages?limit=5&recipient=you%40example.org&status=delivered');
		expect(list.stdout).toContain('you@example.org +1');
		const one = await cli('email', 'log', 'em_abc12345');
		expect(one.code).toBe(0);
		expect(one.stdout).toContain('550 5.1.1 no such user');
		expect(one.stdout).toContain('campaign=nov');
		expect(one.stdout).toContain('Timeline:');
		expect(one.stdout).toContain('invalid-recipient');
	});

	test('suppressions add validates the reason and rm URL-encodes the address', async () => {
		const seen = serve({
			'POST /api/v1/email/suppressions': { address: 'a+b@x.com', reason: 'unsubscribe', messageId: null, createdAt: '2026-11-07T10:00:00.000Z' },
			'DELETE /api/v1/email/suppressions/a%2Bb%40x.com': { ok: true },
		});
		const bad = await cli('email', 'suppressions', 'add', 'a+b@x.com', '--reason', 'bounce');
		expect(bad.code).toBe(1);
		expect(bad.stderr).toContain('--reason must be manual or unsubscribe');
		const added = await cli('email', 'suppressions', 'add', 'a+b@x.com', '--reason', 'unsubscribe');
		expect(added.code).toBe(0);
		expect(seen[0]?.body).toEqual({ address: 'a+b@x.com', reason: 'unsubscribe' });
		expect(added.stdout).toContain('Suppressed a+b@x.com (unsubscribe).');
		const removed = await cli('email', 'suppressions', 'rm', 'a+b@x.com');
		expect(removed.code).toBe(0);
		expect(seen[1]).toEqual({ method: 'DELETE', path: '/api/v1/email/suppressions/a%2Bb%40x.com', body: undefined });
	});

	test('credentials create prints the password once with the SMTP host', async () => {
		const seen = serve({
			'POST /api/v1/email/credentials': {
				id: 'ec_1',
				name: 'mailer',
				username: 'skf_0123abcd',
				projectId: 'prj_1',
				projectSlug: 'api',
				allowedFromDomains: ['example.com'],
				lastUsedAt: null,
				createdAt: '2026-11-07T10:00:00.000Z',
				password: 'pw-only-once',
				smtp: { host: 'smtp.yoal.example', port: 587, secure: 'starttls' },
			},
		});
		const result = await cli('email', 'credentials', 'create', 'mailer', '-p', 'api', '--from', 'example.com');
		expect(result.code).toBe(0);
		expect(seen[0]?.body).toEqual({ name: 'mailer', project: 'api', allowedFromDomains: ['example.com'] });
		expect(result.stdout).toContain('pw-only-once');
		expect(result.stdout).toContain('smtp.yoal.example');
		expect(result.stdout).toContain('587 (STARTTLS)');
		expect(result.stdout).toContain('shown only once');
	});

	test('attach posts the prefix; detach passes it as a query', async () => {
		const seen = serve({
			'POST /api/v1/projects/api/email': { envPrefix: 'MAIL', envNames: ['MAIL_HOST', 'MAIL_PORT'] },
			'DELETE /api/v1/projects/api/email': { ok: true },
		});
		const missing = await cli('email', 'attach');
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain('yoal email attach --project <slug>');
		const attached = await cli('email', 'attach', '--project', 'api', '--prefix', 'MAIL');
		expect(attached.code).toBe(0);
		expect(seen[0]?.body).toEqual({ envPrefix: 'MAIL' });
		expect(attached.stdout).toContain('Attached email to api as MAIL: it receives MAIL_HOST, MAIL_PORT');
		const detached = await cli('email', 'detach', '-p', 'api', '--prefix', 'MAIL');
		expect(detached.code).toBe(0);
		expect(seen[1]?.path).toBe('/api/v1/projects/api/email?envPrefix=MAIL');
	});

	test('addresses add posts the address; list and rm use the sandbox recipient routes', async () => {
		const pending = {
			id: 'ea_1',
			address: 'me+test@gmail.com',
			status: 'pending',
			verifiedAt: null,
			sentAt: '2026-11-07T10:00:00.000Z',
			expiresAt: '2026-11-08T10:00:00.000Z',
			createdAt: '2026-11-07T10:00:00.000Z',
		};
		const seen = serve({
			'POST /api/v1/email/addresses': new Response(JSON.stringify({ address: pending }), { status: 201, headers: { 'content-type': 'application/json' } }),
			'GET /api/v1/email/addresses': { addresses: [pending, { ...pending, id: 'ea_2', address: 'ok@gmail.com', status: 'verified', verifiedAt: '2026-11-07T11:00:00.000Z', sentAt: null, expiresAt: null }] },
			'DELETE /api/v1/email/addresses/me%2Btest%40gmail.com': new Response(null, { status: 204 }),
		});
		const added = await cli('email', 'addresses', 'add', 'me+test@gmail.com');
		expect(added.code).toBe(0);
		expect(seen[0]).toEqual({ method: 'POST', path: '/api/v1/email/addresses', body: { address: 'me+test@gmail.com' } });
		expect(added.stdout).toContain('Sent a confirmation link to me+test@gmail.com (expires 2026-11-08T10:00:00.000Z)');
		const listed = await cli('email', 'addresses');
		expect(listed.code).toBe(0);
		expect(listed.stdout).toContain('ok@gmail.com');
		expect(listed.stdout).toContain('verified');
		expect(listed.stdout).toContain('LINK EXPIRES');
		const removed = await cli('email', 'addresses', 'rm', 'me+test@gmail.com');
		expect(removed.code).toBe(0);
		expect(seen[2]).toEqual({ method: 'DELETE', path: '/api/v1/email/addresses/me%2Btest%40gmail.com', body: undefined });
		expect(removed.stdout).toContain('Removed me+test@gmail.com.');
	});

	test('request-access validates its flags, posts the request, and shows the last one without flags', async () => {
		const request = {
			id: 'ear_1',
			orgId: 'org_1',
			orgName: 'Acme',
			status: 'denied',
			useCase: 'Password resets and receipts for our customers.',
			expectedDailyVolume: 10_000,
			website: 'https://acme.example',
			requestedBy: { id: 'usr_1', email: 'ada@acme.example' },
			decidedBy: 'usr_admin',
			decidedAt: '2026-11-07T12:00:00.000Z',
			note: 'DMARC still fails.',
			perDay: null,
			perSecond: null,
			createdAt: '2026-11-07T10:00:00.000Z',
		};
		const seen = serve({
			'GET /api/v1/email/access-request': { request },
			'POST /api/v1/email/access-request': new Response(JSON.stringify({ request: { ...request, id: 'ear_2', status: 'pending', note: null, decidedAt: null } }), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			}),
		});
		const noVolume = await cli('email', 'request-access', '--use-case', 'Password resets for customers');
		expect(noVolume.code).toBe(1);
		expect(noVolume.stderr).toContain('--volume is required');
		const badVolume = await cli('email', 'request-access', '--use-case', 'x', '--volume', 'lots');
		expect(badVolume.code).toBe(1);
		expect(badVolume.stderr).toContain('--volume must be a whole number');
		expect(seen).toHaveLength(0);

		const shown = await cli('email', 'request-access');
		expect(shown.code).toBe(0);
		expect(shown.stdout).toContain('denied');
		expect(shown.stdout).toContain('Reason');
		expect(shown.stdout).toContain('DMARC still fails.');

		const asked = await cli('email', 'request-access', '--use-case', 'Password resets and receipts for our customers.', '--volume', '10k', '--website', 'https://acme.example');
		expect(asked.code).toBe(0);
		expect(seen[1]).toEqual({
			method: 'POST',
			path: '/api/v1/email/access-request',
			body: { useCase: 'Password resets and receipts for our customers.', expectedDailyVolume: 10_000, website: 'https://acme.example' },
		});
		expect(asked.stdout).toContain('Requested production access (ear_2).');
	});

	test('request-access without a request yet says how to ask', async () => {
		serve({ 'GET /api/v1/email/access-request': { request: null } });
		const result = await cli('email', 'request-access');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('No production access request yet.');
	});
});
