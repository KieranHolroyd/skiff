import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LOG_DRAIN_MAX_ATTEMPTS, isPrivateAddress, maskUrl, otlpLogsPayload, type DrainLine } from './log-drains.ts';
import { LocalObjectStore } from './object-store.ts';
import { verifyWebhookSignature } from './webhook-signature.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-log-drains-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-07T10:00:00Z');

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '1.2.3',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
	},
});
const sql = opened.sqlite;

const platformOwner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const admin = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'admin' });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_1', role: 'deployer' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_4', orgId: 'org_1', role: 'viewer' });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });
const adminApiKey = buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true, keyId: 'key_1' });

interface Call {
	url: string;
	headers: Record<string, string>;
	body: string;
}
let calls: Call[] = [];
let answer: () => Response = () => new Response('', { status: 202 });

core.logDrains.fetch = async (input, init) => {
	calls.push({ url: String(input), headers: { ...(init.headers as Record<string, string>) }, body: String(init.body) });
	return answer();
};
let resolved: Record<string, string[]> = {};
core.logDrains.resolveHost = async (host) => resolved[host] ?? ['203.0.113.10'];

function appLog(orgId: string, projectId: string, message: string, options: { level?: string; source?: string } = {}) {
	sql.run(
		`INSERT INTO log_events (org_id, project_id, deployment_id, node_id, source, stream, level, message, ts)
		 VALUES (?, ?, 'dep_1', 'node_1', ?, 'stdout', ?, ?, ?)`,
		[orgId, projectId, options.source ?? 'runtime', options.level ?? 'info', message, clock],
	);
}

function serviceLog(orgId: string, message: string) {
	sql.run(
		`INSERT INTO service_log_events (org_id, kind, service_id, node_id, source, stream, level, message, ts)
		 VALUES (?, 'database', 'db_1', 'node_1', 'runtime', 'stdout', 'info', ?, ?)`,
		[orgId, message, clock],
	);
}

function brokerLog(orgId: string, message: string) {
	sql.run(
		`INSERT INTO broker_log_events (org_id, broker_id, node_id, source, stream, level, message, ts)
		 VALUES (?, 'brk_1', 'node_1', 'runtime', 'stdout', 'warn', ?, ?)`,
		[orgId, message, clock],
	);
}

const ndjson = (body: string) =>
	body
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Record<string, unknown>);

const drainRow = (id: string) =>
	sql.query<{ attempts: number; next_attempt_at: number; log_cursor: number }, [string]>('SELECT * FROM log_drains WHERE id = ?').get(id)!;

function cleanDrains() {
	for (const drain of core.logDrains.list(platformOwner)) core.logDrains.delete(platformOwner, drain.id);
}

beforeEach(() => {
	calls = [];
	answer = () => new Response('', { status: 202 });
	resolved = {};
	clock += 60_000;
});

afterAll(() => {
	sql.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('log drains: access', () => {
	afterAll(cleanDrains);

	test('org owners and admins manage drains; deployers and viewers only read', () => {
		const { drain } = core.logDrains.create(admin, { name: 'admin-drain', kind: 'webhook', url: 'https://logs.example.com/in' });
		expect(core.logDrains.list(viewer).map((entry) => entry.id)).toEqual([drain.id]);
		expect(core.logDrains.canEdit(viewer)).toBe(false);
		expect(core.logDrains.canEdit(deployer)).toBe(false);
		expect(() => core.logDrains.create(deployer, { name: 'x', kind: 'webhook', url: 'https://logs.example.com/in' })).toThrow(
			/owners and admins/,
		);
		expect(() => core.logDrains.update(viewer, drain.id, { enabled: false })).toThrow(/owners and admins/);
		expect(() => core.logDrains.delete(viewer, drain.id)).toThrow(/owners and admins/);
		expect(core.logDrains.test(viewer, drain.id)).rejects.toThrow(/owners and admins/);
	});

	test('another org sees none of them', () => {
		expect(core.logDrains.list(otherOrg)).toEqual([]);
		const [drain] = core.logDrains.list(platformOwner);
		expect(() => core.logDrains.get(otherOrg, drain!.id)).toThrow(/not found/i);
		expect(() => core.logDrains.delete(otherOrg, drain!.id)).toThrow(/not found/i);
	});

	test('only a platform admin in the dashboard can allow private networks', () => {
		const input = { name: 'lan', kind: 'webhook' as const, url: 'http://10.0.0.5:8080/in', allowPrivateNetwork: true };
		expect(() => core.logDrains.create(admin, input)).toThrow(/platform admin/);
		expect(() => core.logDrains.create(adminApiKey, input)).toThrow(/platform admin/);
		const { drain } = core.logDrains.create(platformOwner, input);
		expect(drain.allowPrivateNetwork).toBe(true);
		// Repointing a private-network drain is as sensitive as allowing it.
		expect(() => core.logDrains.update(admin, drain.id, { url: 'http://10.0.0.6/in' })).toThrow(/platform admin/);
		expect(core.logDrains.update(admin, drain.id, { minLevel: 'warn' }).drain.minLevel).toBe('warn');
	});

	test('validates URLs, names, headers and the per-org cap', () => {
		expect(() => core.logDrains.create(admin, { name: 'plain', kind: 'webhook', url: 'http://logs.example.com/in' })).toThrow(/https/);
		expect(() =>
			core.logDrains.create(admin, { name: 'creds', kind: 'webhook', url: 'https://user:pw@logs.example.com/in' }),
		).toThrow(/header/);
		expect(() =>
			core.logDrains.create(admin, { name: 'hdr', kind: 'webhook', url: 'https://logs.example.com/in', headers: { 'X-Yoal-Drain': 'x' } }),
		).toThrow(/set by Yoal/);
		expect(() => core.logDrains.create(admin, { name: 'admin-drain', kind: 'webhook', url: 'https://logs.example.com/in' })).toThrow(
			/already exists/,
		);
		expect(() => core.logDrains.create(admin, { name: 'otlp-fmt', kind: 'otlp', url: 'https://otel.example.com', format: 'json' })).toThrow(
			/OTLP/,
		);
		for (let index = core.logDrains.list(admin).length; index < 10; index += 1)
			core.logDrains.create(admin, { name: `fill-${index}`, kind: 'webhook', url: 'https://logs.example.com/in', enabled: false });
		expect(() => core.logDrains.create(admin, { name: 'one-too-many', kind: 'webhook', url: 'https://logs.example.com/in' })).toThrow(
			/at most 10/,
		);
	});
});

describe('log drains: secrets and views', () => {
	afterAll(cleanDrains);

	test('header values and the signing secret never come back; the URL is masked', () => {
		const result = core.logDrains.create(admin, {
			name: 'secretive',
			kind: 'webhook',
			url: 'https://logs.example.com/in?api_key=topsecret&dataset=prod',
			headers: { Authorization: 'Bearer hunter2' },
		});
		expect(result.signingSecret).toMatch(/^whsec_/);
		const view = core.logDrains.get(viewer, result.drain.id);
		expect(view.url).toBe('https://logs.example.com/in?api_key=***&dataset=***');
		expect(view.headerNames).toEqual(['Authorization']);
		expect(view.signed).toBe(true);
		expect(view.status).toBe('pending');
		const text = JSON.stringify(view);
		expect(text).not.toContain('hunter2');
		expect(text).not.toContain('topsecret');
		expect(text).not.toContain(result.signingSecret!);
		const stored = JSON.stringify(sql.query('SELECT * FROM log_drains WHERE id = ?').get(result.drain.id));
		expect(stored).not.toContain('hunter2');
		expect(stored).not.toContain(result.signingSecret!);
		const audit = JSON.stringify(core.audit.list({ principal: admin, resource: 'log_drain' }));
		expect(audit).not.toContain('hunter2');
		expect(audit).not.toContain('topsecret');
	});

	test('rotation returns a new secret once; OTLP drains are unsigned and get /v1/logs', () => {
		const { drain, signingSecret } = core.logDrains.create(admin, { name: 'rotating', kind: 'webhook', url: 'https://logs.example.com/in' });
		const rotated = core.logDrains.update(admin, drain.id, { rotateSigningSecret: true });
		expect(rotated.signingSecret).toMatch(/^whsec_/);
		expect(rotated.signingSecret).not.toBe(signingSecret);
		expect(core.logDrains.update(admin, drain.id, { name: 'rotating-2' }).signingSecret).toBeNull();

		const otlp = core.logDrains.create(admin, { name: 'otel', kind: 'otlp', url: 'https://otel.example.com' });
		expect(otlp.signingSecret).toBeNull();
		expect(otlp.drain.signed).toBe(false);
		expect(otlp.drain.format).toBeNull();
		expect(otlp.drain.url).toBe('https://otel.example.com/v1/logs');
		expect(() => core.logDrains.update(admin, otlp.drain.id, { rotateSigningSecret: true })).toThrow(/webhook/);
	});
});

describe('log drains: delivery', () => {
	afterAll(cleanDrains);

	test('a new drain starts at the head, ships signed NDJSON for its own org, and moves its cursors', async () => {
		appLog('org_1', 'prj_a', 'before the drain existed');
		const { drain, signingSecret } = core.logDrains.create(admin, {
			name: 'all',
			kind: 'webhook',
			url: 'https://logs.example.com/in',
			headers: { Authorization: 'Bearer hunter2' },
		});
		appLog('org_1', 'prj_a', 'hello');
		appLog('org_2', 'prj_z', 'another org');
		serviceLog('org_1', 'database line');
		brokerLog('org_1', 'broker line');

		const result = await core.logDrains.deliverDue();
		expect(result).toEqual({ drains: 1, lines: 3 });
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe('https://logs.example.com/in');
		expect(call.headers['content-type']).toBe('application/x-ndjson');
		expect(call.headers.Authorization).toBe('Bearer hunter2');
		expect(call.headers['user-agent']).toBe('Yoal-Log-Drain/1.2.3');
		expect(call.headers['x-yoal-drain']).toBe(drain.id);
		expect(verifyWebhookSignature(signingSecret!, call.body, call.headers['x-yoal-signature'], { nowMs: clock })).toBe(true);
		expect(verifyWebhookSignature('whsec_wrong', call.body, call.headers['x-yoal-signature'], { nowMs: clock })).toBe(false);

		const lines = ndjson(call.body);
		expect(lines.map((line) => line.message).sort()).toEqual(['broker line', 'database line', 'hello']);
		const hello = lines.find((line) => line.message === 'hello')!;
		expect(hello).toMatchObject({ org: 'org_1', projectId: 'prj_a', deploymentId: 'dep_1', node: 'node_1', level: 'info', source: 'runtime' });
		expect(hello.id).toMatch(/^log:\d+$/);
		expect(lines.find((line) => line.message === 'broker line')!.service).toEqual({ kind: 'broker', id: 'brk_1', name: null });

		const view = core.logDrains.get(admin, drain.id);
		expect(view.status).toBe('healthy');
		expect(view.delivery).toMatchObject({ deliveredLines: 3, deliveredBatches: 1, droppedLines: 0, attempts: 0 });

		// Nothing new: no request.
		calls = [];
		expect(await core.logDrains.deliverDue()).toEqual({ drains: 1, lines: 0 });
		expect(calls).toHaveLength(0);
	});

	test('filters by project, source and level; a JSON-array drain sends an array', async () => {
		cleanDrains();
		await core.projects.create(platformOwner, {
			name: 'Blog',
			slug: 'blog',
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const blog = core.projects.requireRow(platformOwner, 'blog');
		const { drain } = core.logDrains.create(admin, {
			name: 'blog-errors',
			kind: 'webhook',
			format: 'json',
			url: 'https://logs.example.com/in',
			project: 'blog',
			sources: ['runtime'],
			minLevel: 'warn',
		});
		expect(drain.project).toBe('blog');
		appLog('org_1', blog.id, 'blog warning', { level: 'warn' });
		appLog('org_1', blog.id, 'blog info');
		appLog('org_1', blog.id, 'blog build error', { level: 'error', source: 'build' });
		appLog('org_1', 'prj_other', 'other project error', { level: 'error' });
		serviceLog('org_1', 'database line');

		await core.logDrains.deliverDue();
		expect(calls).toHaveLength(1);
		expect(calls[0]!.headers['content-type']).toBe('application/json');
		const lines = JSON.parse(calls[0]!.body) as Array<Record<string, unknown>>;
		expect(lines.map((line) => line.message)).toEqual(['blog warning']);
		expect(lines[0]!.project).toBe('blog');
		expect(() => core.logDrains.update(admin, drain.id, { sources: ['services'] })).toThrow(/project drain/);
	});

	test('a failure backs off and retries the same lines; after the last attempt the batch is dropped', async () => {
		cleanDrains();
		const { drain } = core.logDrains.create(admin, { name: 'flaky', kind: 'webhook', url: 'https://logs.example.com/in' });
		appLog('org_1', 'prj_a', 'retry me');
		answer = () => new Response('busy', { status: 503 });

		await core.logDrains.deliverDue();
		let row = drainRow(drain.id);
		expect(row.attempts).toBe(1);
		expect(row.next_attempt_at).toBe(clock + 5_000);
		let view = core.logDrains.get(admin, drain.id);
		expect(view.status).toBe('failing');
		expect(view.delivery.lastError).toContain('HTTP 503: busy');

		// Not due yet: no request.
		calls = [];
		await core.logDrains.deliverDue();
		expect(calls).toHaveLength(0);

		// Second attempt sends the same line again, with a doubled backoff.
		clock += 5_000;
		await core.logDrains.deliverDue();
		expect(calls).toHaveLength(1);
		expect(ndjson(calls[0]!.body).map((line) => line.message)).toEqual(['retry me']);
		row = drainRow(drain.id);
		expect(row.attempts).toBe(2);
		expect(row.next_attempt_at).toBe(clock + 10_000);

		for (let attempt = 3; attempt <= LOG_DRAIN_MAX_ATTEMPTS; attempt += 1) {
			clock = drainRow(drain.id).next_attempt_at;
			await core.logDrains.deliverDue();
		}
		view = core.logDrains.get(admin, drain.id);
		expect(view.delivery).toMatchObject({ droppedLines: 1, droppedBatches: 1, deliveredLines: 0, attempts: 0 });

		// The next line goes out once the receiver recovers; the dropped one is not resent.
		answer = () => new Response('', { status: 200 });
		appLog('org_1', 'prj_a', 'after recovery');
		clock = drainRow(drain.id).next_attempt_at;
		calls = [];
		await core.logDrains.deliverDue();
		expect(ndjson(calls[0]!.body).map((line) => line.message)).toEqual(['after recovery']);
		view = core.logDrains.get(admin, drain.id);
		expect(view.status).toBe('healthy');
		expect(view.delivery.failingSince).toBeNull();
	});

	test('an answer a retry cannot fix (400, 413, 415, 422) or a redirect drops the batch at once', async () => {
		cleanDrains();
		const { drain } = core.logDrains.create(admin, { name: 'strict', kind: 'webhook', url: 'https://logs.example.com/in' });
		appLog('org_1', 'prj_a', 'too big');
		answer = () => new Response('payload too large', { status: 413 });
		await core.logDrains.deliverDue();
		expect(core.logDrains.get(admin, drain.id).delivery).toMatchObject({ droppedLines: 1, droppedBatches: 1, attempts: 0 });

		appLog('org_1', 'prj_a', 'redirected');
		answer = () => new Response('', { status: 301, headers: { location: 'https://elsewhere.example.com' } });
		clock = drainRow(drain.id).next_attempt_at;
		await core.logDrains.deliverDue();
		const view = core.logDrains.get(admin, drain.id);
		expect(view.delivery.droppedBatches).toBe(2);
		expect(view.delivery.lastError).toMatch(/redirect/);
	});

	test('egress: private addresses are refused unless a platform admin allowed them', async () => {
		cleanDrains();
		resolved['logs.internal-lan.example'] = ['192.168.1.20'];
		const { drain } = core.logDrains.create(admin, { name: 'sneaky', kind: 'webhook', url: 'https://logs.internal-lan.example/in' });
		appLog('org_1', 'prj_a', 'should not leave');
		await core.logDrains.deliverDue();
		expect(calls).toHaveLength(0);
		const view = core.logDrains.get(admin, drain.id);
		expect(view.delivery.lastError).toMatch(/private address \(192\.168\.1\.20\)/);
		expect(view.delivery.droppedLines).toBe(1);

		const test = await core.logDrains.test(admin, drain.id);
		expect(test.ok).toBe(false);
		expect(calls).toHaveLength(0);

		const lan = core.logDrains.create(platformOwner, {
			name: 'lan',
			kind: 'webhook',
			url: 'http://192.168.1.20:9000/in',
			allowPrivateNetwork: true,
		});
		const allowed = await core.logDrains.test(platformOwner, lan.drain.id);
		expect(allowed.ok).toBe(true);
		expect(calls.map((call) => call.url)).toEqual(['http://192.168.1.20:9000/in']);
	});

	test('test() sends one line and leaves cursors and counters alone', async () => {
		cleanDrains();
		const { drain, signingSecret } = core.logDrains.create(admin, { name: 'tested', kind: 'webhook', url: 'https://logs.example.com/in' });
		const before = drainRow(drain.id);
		const result = await core.logDrains.test(admin, drain.id);
		expect(result).toMatchObject({ ok: true, status: 202 });
		const [line] = ndjson(calls[0]!.body);
		expect(line!.id).toMatch(/^test:/);
		expect(line!.message).toContain('"tested"');
		expect(verifyWebhookSignature(signingSecret!, calls[0]!.body, calls[0]!.headers['x-yoal-signature'], { nowMs: clock })).toBe(true);
		expect(drainRow(drain.id)).toEqual(before);
		expect(core.audit.list({ principal: admin, action: 'log_drain.test' }).find((entry) => entry.resourceId === drain.id)!.result).toBe('ok');

		answer = () => new Response('nope', { status: 401 });
		const failed = await core.logDrains.test(admin, drain.id);
		expect(failed).toMatchObject({ ok: false, status: 401 });
		expect(failed.message).toContain('HTTP 401');
	});

	test('disabling stops delivery; re-enabling resumes from now, not from where it stopped', async () => {
		cleanDrains();
		const { drain } = core.logDrains.create(admin, { name: 'pausable', kind: 'webhook', url: 'https://logs.example.com/in' });
		core.logDrains.update(admin, drain.id, { enabled: false });
		expect(core.logDrains.get(admin, drain.id).status).toBe('disabled');
		appLog('org_1', 'prj_a', 'while off');
		await core.logDrains.deliverDue();
		expect(calls).toHaveLength(0);

		core.logDrains.update(admin, drain.id, { enabled: true });
		appLog('org_1', 'prj_a', 'back on');
		await core.logDrains.deliverDue();
		expect(ndjson(calls[0]!.body).map((line) => line.message)).toEqual(['back on']);
	});

	test('a large backlog goes out in several batches in one tick', async () => {
		cleanDrains();
		const { drain } = core.logDrains.create(admin, { name: 'backlog', kind: 'webhook', url: 'https://logs.example.com/in' });
		for (let index = 0; index < 1_200; index += 1) appLog('org_1', 'prj_a', `line ${index}`);
		const result = await core.logDrains.deliverDue();
		expect(result.lines).toBe(1_200);
		expect(calls.map((call) => ndjson(call.body).length)).toEqual([500, 500, 200]);
		expect(core.logDrains.get(admin, drain.id).delivery.deliveredBatches).toBe(3);
	});

	test('a leased drain is not delivered twice at once', async () => {
		cleanDrains();
		const { drain } = core.logDrains.create(admin, { name: 'leased', kind: 'webhook', url: 'https://logs.example.com/in' });
		appLog('org_1', 'prj_a', 'once');
		sql.run('UPDATE log_drains SET leased_until = ? WHERE id = ?', [clock + 60_000, drain.id]);
		expect(await core.logDrains.deliverDue()).toEqual({ drains: 0, lines: 0 });
		sql.run('UPDATE log_drains SET leased_until = 0 WHERE id = ?', [drain.id]);
		expect((await core.logDrains.deliverDue()).lines).toBe(1);
	});

	test('OTLP drains post an ExportLogsServiceRequest and count partial rejections as dropped', async () => {
		cleanDrains();
		const { drain } = core.logDrains.create(admin, { name: 'otel', kind: 'otlp', url: 'https://otel.example.com' });
		appLog('org_1', 'prj_a', 'otel one', { level: 'error' });
		appLog('org_1', 'prj_a', 'otel two');
		answer = () => Response.json({ partialSuccess: { rejectedLogRecords: '1', errorMessage: 'too old' } });
		await core.logDrains.deliverDue();
		const call = calls[0]!;
		expect(call.url).toBe('https://otel.example.com/v1/logs');
		expect(call.headers['content-type']).toBe('application/json');
		expect(call.headers['x-yoal-signature']).toBeUndefined();
		const body = JSON.parse(call.body) as ReturnType<typeof otlpLogsPayload>;
		expect(body.resourceLogs).toHaveLength(1);
		const records = body.resourceLogs[0]!.scopeLogs[0]!.logRecords as Array<{ severityText: string; body: { stringValue: string } }>;
		expect(records.map((record) => [record.severityText, record.body.stringValue])).toEqual([
			['ERROR', 'otel one'],
			['INFO', 'otel two'],
		]);
		const view = core.logDrains.get(admin, drain.id);
		expect(view.delivery).toMatchObject({ deliveredLines: 1, droppedLines: 1, deliveredBatches: 1 });
		expect(view.delivery.lastError).toContain('too old');
	});
});

describe('log drain helpers', () => {
	test('otlpLogsPayload groups by resource with semantic-convention attributes', () => {
		const base: DrainLine = {
			id: 'log:1',
			ts: Date.parse('2026-11-07T10:00:00Z'),
			level: 'warn',
			message: 'm',
			source: 'runtime',
			stream: 'stderr',
			projectId: 'prj_a',
			project: 'blog',
			deploymentId: 'dep_1',
			buildId: null,
			nodeId: 'node_1',
			service: null,
		};
		const payload = otlpLogsPayload(
			[base, { ...base, id: 'svc:2', projectId: null, project: null, deploymentId: null, service: { kind: 'database', id: 'db_1', name: 'main' } }],
			{ orgId: 'org_1', version: '1.2.3', now: base.ts + 1 },
		);
		expect(payload.resourceLogs).toHaveLength(2);
		const [app, service] = payload.resourceLogs;
		const attrs = (entry: { key: string; value: { stringValue: string } }[]) =>
			Object.fromEntries(entry.map((item) => [item.key, item.value.stringValue]));
		expect(attrs(app!.resource.attributes)).toEqual({
			'service.name': 'blog',
			'service.namespace': 'yoal',
			'yoal.org.id': 'org_1',
			'yoal.project.id': 'prj_a',
			'deployment.id': 'dep_1',
		});
		expect(attrs(service!.resource.attributes)['service.name']).toBe('main');
		const record = app!.scopeLogs[0]!.logRecords[0] as Record<string, unknown>;
		expect(record).toMatchObject({ timeUnixNano: '1794045600000000000', severityNumber: 13, severityText: 'WARN' });
		expect(attrs(record.attributes as never)).toMatchObject({ 'log.record.uid': 'log:1', 'log.iostream': 'stderr', 'host.id': 'node_1' });
		expect(app!.scopeLogs[0]!.scope).toEqual({ name: 'yoal.log-drain', version: '1.2.3' });
	});

	test('isPrivateAddress covers v4, v6 and mapped ranges', () => {
		for (const address of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.9', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1'])
			expect(isPrivateAddress(address)).toBe(true);
		for (const address of ['203.0.113.10', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])
			expect(isPrivateAddress(address)).toBe(false);
		expect(isPrivateAddress('not-an-ip')).toBe(true);
	});

	test('maskUrl keeps query names only', () => {
		expect(maskUrl('https://x.example.com/a?token=1&b=2&b=3')).toBe('https://x.example.com/a?token=***&b=***');
		expect(maskUrl('https://x.example.com/a')).toBe('https://x.example.com/a');
	});
});
