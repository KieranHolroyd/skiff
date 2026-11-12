import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import {
	APP_ERROR_LIMITS,
	appErrorFingerprint,
	authHeaderKey,
	normalizeSentryEvent,
	parseSentryEnvelope,
} from './app-errors.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-app-errors-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-11T10:00:00Z');

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '1.2.3',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_a', orgId: 'org_a', role: 'owner' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_v', orgId: 'org_a', role: 'viewer' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const project = await core.projects.create(owner, {
	name: 'Shop',
	slug: 'shop',
	runtime: 'static',
	placement: 'edge',
	productionAccess: 'public',
	previewAccess: 'platform',
});

function envelope(items: Array<{ type: string; payload: unknown }>, header: Record<string, unknown> = {}): Uint8Array {
	const chunks: Buffer[] = [Buffer.from(`${JSON.stringify(header)}\n`)];
	for (const item of items) {
		const payload = Buffer.from(JSON.stringify(item.payload));
		chunks.push(Buffer.from(`${JSON.stringify({ type: item.type, length: payload.length })}\n`), payload, Buffer.from('\n'));
	}
	return Buffer.concat(chunks);
}

function sentryEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		event_id: 'a'.repeat(32),
		platform: 'node',
		level: 'error',
		environment: 'production',
		release: 'web@1.0.0',
		exception: {
			values: [
				{
					type: 'TypeError',
					value: "Cannot read properties of undefined (reading 'id')",
					stacktrace: {
						frames: [
							{ function: 'inner', filename: 'apps/shop/src/inner.ts', lineno: 10, in_app: true },
							{ function: 'handler', filename: 'apps/shop/src/handler.ts', lineno: 20, in_app: true },
							{ function: 'node', filename: 'node_modules/lib/index.js', lineno: 1, in_app: false },
						],
					},
				},
			],
		},
		tags: { route: '/checkout' },
		user: { id: 'user_123', email: 'person@example.com', ip_address: '203.0.113.5' },
		request: { method: 'GET', url: 'https://shop.test/checkout?token=secret', headers: { cookie: 'a=b' } },
		...overrides,
	};
}

async function enabled() {
	let settings = core.appErrors.settings(owner, project);
	if (!settings.enabled) settings = core.appErrors.enable(owner, project);
	const row = opened.sqlite
		.query<{ dsn_project_id: number }, [string]>('SELECT dsn_project_id FROM app_error_projects WHERE project_id = ?')
		.get(project.id)!;
	return { dsnId: String(row.dsn_project_id), key: settings.publicKey!, dsn: settings.dsn! };
}

describe('Sentry parsing', () => {
	test('parses an envelope on bytes, including a UTF-8 event', () => {
		const parsed = parseSentryEnvelope(
			envelope([{ type: 'event', payload: sentryEvent({ message: 'café ☕️' }) }], { event_id: 'b'.repeat(32) }),
		);
		expect(parsed.header?.event_id).toBe('b'.repeat(32));
		expect(parsed.event?.message).toBe('café ☕️');
		expect(parsed.ignored).toEqual([]);
	});

	test('accepts exception as an object or a Go-style array', () => {
		const object = normalizeSentryEvent(sentryEvent(), null, clock);
		const array = normalizeSentryEvent(
			sentryEvent({
				exception: [
					{ type: 'errorString', value: 'go failure', stacktrace: { frames: [{ function: 'main', filename: 'main.go', lineno: 8, in_app: true }] } },
				],
			}),
			null,
			clock,
		);
		expect(object.exceptions).toHaveLength(1);
		expect(array.exceptions[0]?.type).toBe('errorString');
		expect(array.exceptions[0]?.frames[0]?.fn).toBe('main');
	});

	test('drops user email/IP and request query strings', () => {
		const event = normalizeSentryEvent(sentryEvent(), null, clock);
		expect(event.userId).toBe('user_123');
		expect(event.path).toBe('/checkout');
		expect(JSON.stringify(event)).not.toContain('person@example.com');
		expect(JSON.stringify(event)).not.toContain('203.0.113.5');
	});

	test('scrubs credentials from the message, tags and extra', () => {
		const event = normalizeSentryEvent(
			sentryEvent({
				message: 'authorization: Bearer abcdefghijklmnop',
				tags: { token: 'sk_test_fake_secret_123456' },
				extra: { password: 'hunter2', safe: 'ok' },
			}),
			null,
			clock,
		);
		expect(event.message).not.toContain('abcdefghijklmnop');
		expect(event.tags.token).not.toContain('sk_test_fake_secret_123456');
		expect(JSON.stringify(event.extra)).not.toContain('hunter2');
	});

	test('groups by environment, type, normalised value and app frames', () => {
		const one = appErrorFingerprint({
			platform: 'node',
			environment: 'production',
			name: 'TypeError',
			message: 'order 123 failed',
			culprit: 'GET /orders/123',
			frames: [{ fn: 'handler', file: 'src/checkout.ts', line: 10, column: 2, inApp: true }],
		});
		const two = appErrorFingerprint({
			platform: 'node',
			environment: 'production',
			name: 'TypeError',
			message: 'order 456 failed',
			culprit: 'GET /orders/456',
			frames: [{ fn: 'handler', file: 'src/checkout.ts', line: 99, column: 8, inApp: true }],
		});
		const staging = appErrorFingerprint({
			platform: 'node',
			environment: 'staging',
			name: 'TypeError',
			message: 'order 123 failed',
			culprit: 'GET /orders/123',
			frames: [{ fn: 'handler', file: 'src/checkout.ts', line: 10, column: 2, inApp: true }],
		});
		expect(one).toBe(two);
		expect(one).not.toBe(staging);
	});
});

describe('AppErrorService', () => {
	test('enables a project with a numeric DSN and a 32-hex key', async () => {
		const { dsnId, key, dsn } = await enabled();
		expect(Number(dsnId)).toBeGreaterThan(0);
		expect(key).toMatch(/^[0-9a-f]{32}$/);
		expect(dsn).toBe(`https://${key}@control.test/ingest/${dsnId}`);
		expect(authHeaderKey(`Sentry sentry_version=7, sentry_client=test, sentry_key=${key}`)).toBe(key);
	});

	test('ingests an envelope, groups repeated errors and samples stored events', async () => {
		const { dsnId, key } = await enabled();
		for (let i = 0; i < 5; i++) {
			clock += 10;
			const event = sentryEvent({ event_id: `${i}`.repeat(32), timestamp: clock / 1000 });
			const result = core.appErrors.ingest({
				dsnProjectId: dsnId,
				endpoint: 'envelope',
				body: envelope([{ type: 'event', payload: event }], { event_id: event.event_id }),
				headerKey: key,
			});
			expect(result.status).toBe(200);
		}
		const list = core.appErrors.list(owner, project, { status: 'unresolved' });
		expect(list.issues).toHaveLength(1);
		expect(list.issues[0]?.count).toBe(5);
		expect(list.issues[0]?.name).toBe('TypeError');
		expect(list.issues[0]?.environment).toBe('production');
		expect(list.summary.unresolved).toBe(1);
		const detail = core.appErrors.get(owner, project, list.issues[0]!.id);
		expect(detail.events.length).toBeLessThanOrEqual(APP_ERROR_LIMITS.eventsPerIssue);
		expect(detail.events.length).toBeLessThan(5);
	});

	test('never counts the same Sentry event id twice', async () => {
		const { dsnId, key } = await enabled();
		const event = sentryEvent({ event_id: 'c'.repeat(32), exception: { values: [{ type: 'Error', value: 'duplicate me', stacktrace: { frames: [{ function: 'dup', filename: 'src/dup.ts', lineno: 1, in_app: true }] } }] } });
		const body = envelope([{ type: 'event', payload: event }], { event_id: event.event_id });
		core.appErrors.ingest({ dsnProjectId: dsnId, endpoint: 'envelope', body, headerKey: key });
		core.appErrors.ingest({ dsnProjectId: dsnId, endpoint: 'envelope', body, headerKey: key });
		const issue = core.appErrors.list(owner, project, { q: 'duplicate me', status: 'all' }).issues[0];
		expect(issue?.count).toBe(1);
	});

	test('reopens a resolved issue and ignores an ignored one', async () => {
		const { dsnId, key } = await enabled();
		const event = sentryEvent({ event_id: 'd'.repeat(32), exception: { values: [{ type: 'Error', value: 'regression me', stacktrace: { frames: [{ function: 'regress', filename: 'src/regress.ts', lineno: 1, in_app: true }] } }] } });
		const body = envelope([{ type: 'event', payload: event }], { event_id: event.event_id });
		core.appErrors.ingest({ dsnProjectId: dsnId, endpoint: 'envelope', body, headerKey: key });
		let issue = core.appErrors.list(owner, project, { q: 'regression me', status: 'all' }).issues[0]!;
		core.appErrors.setStatus(owner, project, { ids: [issue.id], status: 'resolved' });
		const again = sentryEvent({ event_id: 'e'.repeat(32), exception: { values: [{ type: 'Error', value: 'regression me', stacktrace: { frames: [{ function: 'regress', filename: 'src/regress.ts', lineno: 1, in_app: true }] } }] } });
		core.appErrors.ingest({
			dsnProjectId: dsnId,
			endpoint: 'envelope',
			body: envelope([{ type: 'event', payload: again }], { event_id: again.event_id }),
			headerKey: key,
		});
		issue = core.appErrors.list(owner, project, { q: 'regression me', status: 'unresolved' }).issues[0]!;
		expect(issue.count).toBe(2);
		expect(issue.regressedAt).not.toBeNull();
		core.appErrors.setStatus(owner, project, { ids: [issue.id], status: 'ignored' });
		expect(core.appErrors.list(owner, project, { status: 'unresolved' }).issues.some((row) => row.id === issue.id)).toBe(false);
		expect(core.appErrors.list(owner, project, { status: 'ignored' }).issues.some((row) => row.id === issue.id)).toBe(true);
	});

	test('accepts a store payload and Go-style exception arrays', async () => {
		const { dsnId, key } = await enabled();
		const event = {
			event_id: 'f'.repeat(32),
			platform: 'go',
			level: 'error',
			environment: 'production',
			exception: [{ type: 'errorString', value: 'go harness failure', stacktrace: { frames: [{ function: 'main', filename: 'main.go', lineno: 4, in_app: true }] } }],
		};
		const result = core.appErrors.ingest({
			dsnProjectId: dsnId,
			endpoint: 'store',
			body: Buffer.from(JSON.stringify(event)),
			queryKey: key,
		});
		expect(result.status).toBe(200);
		const issue = core.appErrors.list(owner, project, { q: 'go harness failure', status: 'unresolved' }).issues[0]!;
		expect(issue.name).toBe('errorString');
	});

	test('accepts the minimal store event the setup page curls, with no event id', async () => {
		const { dsnId, key } = await enabled();
		// Keep in step with `storeCurl` in the Errors setup (apps/control-plane errors/_lib/sdks.ts).
		const body = '{"level":"error","platform":"other","exception":{"values":[{"type":"Error","value":"Hello from curl"}]}}';
		const result = core.appErrors.ingest({ dsnProjectId: dsnId, endpoint: 'store', body: Buffer.from(body), queryKey: key });
		expect(result.status).toBe(200);
		expect(result.eventId).toMatch(/^[0-9a-f]{32}$/);
		const issue = core.appErrors.list(owner, project, { q: 'Hello from curl' }).issues[0]!;
		expect(issue.name).toBe('Error');
	});

	test('rejects a wrong key and an envelope with mismatched auth', async () => {
		const { dsnId, key } = await enabled();
		const body = envelope([{ type: 'event', payload: sentryEvent({ event_id: '1'.repeat(32) }) }], {
			event_id: '1'.repeat(32),
			dsn: `https://${'0'.repeat(32)}@control.test/ingest/${dsnId}`,
		});
		expect(core.appErrors.ingest({ dsnProjectId: dsnId, endpoint: 'envelope', body, headerKey: key }).status).toBe(401);
		expect(core.appErrors.ingest({ dsnProjectId: dsnId, endpoint: 'envelope', body, headerKey: '0'.repeat(32) }).status).toBe(401);
	});

	test('accepts telemetry and counts it as ignored', async () => {
		const { dsnId, key } = await enabled();
		const result = core.appErrors.ingest({
			dsnProjectId: dsnId,
			endpoint: 'envelope',
			body: envelope([{ type: 'session', payload: { sid: 'x' } }], { event_id: '2'.repeat(32) }),
			headerKey: key,
		});
		expect(result.status).toBe(200);
		if (result.status !== 200) throw new Error('expected 200');
		expect(result.ignored).toBe(1);
		const usage = core.appErrors.settings(owner, project).usage;
		expect(usage.ignored).toBeGreaterThan(0);
	});

	test('enforces the per-project rate limit', async () => {
		const { dsnId, key } = await enabled();
		let limited = 0;
		for (let i = 0; i < 60; i++) {
			const event = sentryEvent({ event_id: `${i.toString(16).padStart(8, '0')}`.repeat(4), message: `storm ${i}` });
			const result = core.appErrors.ingest({
				dsnProjectId: dsnId,
				endpoint: 'store',
				body: Buffer.from(JSON.stringify(event)),
				headerKey: key,
			});
			if (result.status === 429) limited++;
		}
		expect(limited).toBeGreaterThan(0);
	});

	test('viewers can read but not change settings', async () => {
		expect(core.appErrors.settings(viewer, project).enabled).toBe(true);
		expect(() => core.appErrors.enable(viewer, project)).toThrow();
	});

	test('injects the DSN into the workload environment', async () => {
		const env = core.appErrors.consumerEnv(project.id);
		expect(env.SENTRY_DSN).toMatch(/^https:\/\/[0-9a-f]{32}@control\.test\/ingest\/\d+$/);
		expect(core.appErrors.consumerEnv('prj_missing')).toEqual({});
	});

	test('creates a test event through the same storage path', async () => {
		const result = core.appErrors.testEvent(owner, project);
		expect(result.eventId).toMatch(/^[0-9a-f]{32}$/);
		const detail = core.appErrors.get(owner, project, result.issueId);
		expect(detail.events[0]?.tags['yoal.test']).toBe('true');
	});

	test('rejects a single event over the per-event cap but keeps the envelope cap', async () => {
		const { dsnId, key } = await enabled();
		const big = sentryEvent({ event_id: '9'.repeat(32), extra: { blob: 'x'.repeat(APP_ERROR_LIMITS.eventBytes) } });
		const body = envelope([{ type: 'event', payload: big }], { event_id: big.event_id as string });
		expect(core.appErrors.ingest({ dsnProjectId: dsnId, endpoint: 'envelope', body, headerKey: key }).status).toBe(413);
		expect(
			core.appErrors.ingest({
				dsnProjectId: dsnId,
				endpoint: 'store',
				body: Buffer.from(JSON.stringify(big)),
				headerKey: key,
			}).status,
		).toBe(413);
	});

	test('caps a large exception chain at the stack budget', () => {
		const frames = Array.from({ length: 100 }, (_, index) => ({
			function: `frame${index}`,
			filename: `apps/shop/src/${'deep/'.repeat(50)}file${index}.ts`,
			lineno: index + 1,
			in_app: true,
		}));
		const event = normalizeSentryEvent(
			sentryEvent({
				exception: {
					values: [
						{ type: 'TypeError', value: 'outer failure', stacktrace: { frames } },
						{ type: 'Error', value: 'cause '.repeat(2_000), stacktrace: { frames } },
					],
				},
			}),
			null,
			clock,
		);
		expect(JSON.stringify(event.exceptions).length).toBeLessThanOrEqual(APP_ERROR_LIMITS.stackLength);
		expect(event.exceptions.at(-1)?.type).toBe('Error');
	});

	test('filters by range and lists environments and releases for the pickers', async () => {
		clock += 61_000;
		const { dsnId, key } = await enabled();
		const event = sentryEvent({ event_id: '7'.repeat(32), release: 'web@2.0.0', environment: 'staging' });
		core.appErrors.ingest({
			dsnProjectId: dsnId,
			endpoint: 'envelope',
			body: envelope([{ type: 'event', payload: event }], { event_id: event.event_id }),
			headerKey: key,
		});
		clock += 8 * 24 * 60 * 60 * 1000;
		const week = core.appErrors.list(owner, project, { status: 'all', range: '7d', q: 'Cannot read properties' });
		expect(week.issues).toHaveLength(0);
		const month = core.appErrors.list(owner, project, { status: 'all', range: '30d', q: 'Cannot read properties' });
		expect(month.issues.some((issue) => issue.environment === 'staging')).toBe(true);
		expect(month.environments).toContain('staging');
		expect(month.releases).toContain('web@2.0.0');
	});

	test('keeps a rotated key for the grace period, then rejects it', async () => {
		const { dsnId, key: oldKey } = await enabled();
		core.appErrors.rotateKey(owner, project);
		const event = (id: string) => sentryEvent({ event_id: id.repeat(32) });
		expect(
			core.appErrors.ingest({
				dsnProjectId: dsnId,
				endpoint: 'envelope',
				body: envelope([{ type: 'event', payload: event('3') }], { event_id: '3'.repeat(32) }),
				headerKey: oldKey,
			}).status,
		).toBe(200);
		clock += 25 * 60 * 60 * 1000;
		expect(
			core.appErrors.ingest({
				dsnProjectId: dsnId,
				endpoint: 'envelope',
				body: envelope([{ type: 'event', payload: event('4') }], { event_id: '4'.repeat(32) }),
				headerKey: oldKey,
			}).status,
		).toBe(401);
	});

	test('notifies a new issue with a link the dashboard can open', async () => {
		const alerts: Array<{ title: string; url?: string }> = [];
		core.ctx.notifiers.push({
			name: 'test',
			notify: async (message) => {
				alerts.push(message);
			},
		});
		core.appErrors.updateSettings(owner, project, { notify: true });
		try {
			const { dsnId, key } = await enabled();
			const event = sentryEvent({
				event_id: '5'.repeat(32),
				exception: {
					values: [
						{
							type: 'Error',
							value: 'alert me once',
							stacktrace: { frames: [{ function: 'alertMe', filename: 'src/alert.ts', lineno: 1, in_app: true }] },
						},
					],
				},
			});
			core.appErrors.ingest({
				dsnProjectId: dsnId,
				endpoint: 'envelope',
				body: envelope([{ type: 'event', payload: event }], { event_id: event.event_id }),
				headerKey: key,
			});
			const issue = core.appErrors.list(owner, project, { status: 'all', q: 'alert me once' }).issues[0]!;
			expect(alerts.at(-1)?.title).toContain('New error');
			expect(alerts.at(-1)?.url).toBe(`https://control.test/errors?issue=${issue.id}`);
		} finally {
			core.appErrors.updateSettings(owner, project, { notify: false });
			core.ctx.notifiers.pop();
		}
	});

	test('auto-links current and future projects, then leaves manual targets alone', async () => {
		expect(core.appErrors.serviceView(owner).autoLink).toBe(false);
		expect(() => core.appErrors.setAutoLink(viewer, true)).toThrow();
		expect(core.appErrors.serviceView(viewer).targets.length).toBeGreaterThan(0);

		await core.projects.create(owner, {
			name: 'Auto linked',
			slug: 'auto-linked',
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const enabledView = core.appErrors.setAutoLink(owner, true);
		expect(enabledView.autoLink).toBe(true);
		const shopTarget = enabledView.targets.find((target) => target.projectSlug === 'shop')!;
		expect(shopTarget.kind).toBe('project');
		expect(shopTarget.enabled).toBe(true);
		expect(shopTarget.autoLinked).toBe(true);
		expect(shopTarget.dsn).toMatch(/^https:\/\/[0-9a-f]{32}@control\.test\/ingest\/\d+$/);

		await core.projects.create(owner, {
			name: 'Created after auto link',
			slug: 'created-after-auto-link',
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const autoLinked = core.appErrors.serviceView(owner).targets.find((target) => target.projectSlug === 'created-after-auto-link');
		expect(autoLinked).toBeDefined();
		expect(autoLinked?.autoLinked).toBe(true);
		expect(autoLinked?.enabled).toBe(true);

		const afterOff = core.appErrors.setAutoLink(owner, false);
		expect(afterOff.autoLink).toBe(false);
		expect(afterOff.targets.find((target) => target.projectSlug === 'shop')?.enabled).toBe(false);
		expect(afterOff.targets.find((target) => target.projectSlug === 'created-after-auto-link')?.enabled).toBe(false);

		await core.projects.create(owner, {
			name: 'Manual link',
			slug: 'manual-link',
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		expect(core.appErrors.serviceView(owner).targets.some((target) => target.projectSlug === 'manual-link')).toBe(false);
		const manual = core.appErrors.createProjectTarget(owner, core.projects.requireRow(owner, 'manual-link'));
		expect(manual.kind).toBe('project');
		expect(manual.autoLinked).toBe(false);
		expect(manual.enabled).toBe(true);
	});

	test('attaches an off-platform target and manages its issues from the top-level service', async () => {
		const target = core.appErrors.createStandaloneTarget(owner, { name: 'Off-platform shop' });
		expect(target.kind).toBe('standalone');
		expect(target.projectId).toBeNull();
		expect(target.projectSlug).toBeNull();
		expect(target.enabled).toBe(true);
		expect(target.dsn).toMatch(/^https:\/\/[0-9a-f]{32}@control\.test\/ingest\/\d+$/);
		const dsnId = target.dsn!.match(/\/ingest\/(\d+)$/)![1]!;
		expect(() => core.appErrors.createStandaloneTarget(viewer, { name: 'Nope' })).toThrow();

		const event = sentryEvent({
			event_id: '8'.repeat(32),
			environment: 'production',
			message: 'off-platform boom',
			exception: {
				values: [{ type: 'Error', value: 'off-platform boom', stacktrace: { frames: [{ function: 'offPlatform', filename: 'src/off.ts', lineno: 1, in_app: true }] } }],
			},
		});
		const outcome = core.appErrors.ingest({
			dsnProjectId: dsnId,
			endpoint: 'envelope',
			body: envelope([{ type: 'event', payload: event }], { event_id: event.event_id }),
			headerKey: target.publicKey!,
		});
		expect(outcome.status).toBe(200);

		const all = core.appErrors.orgList(owner, { status: 'all', target: target.id, q: 'off-platform boom' });
		expect(all.issues).toHaveLength(1);
		expect(all.issues[0]?.targetName).toBe('Off-platform shop');
		expect(all.issues[0]?.targetKind).toBe('standalone');
		const issue = all.issues[0]!;
		expect(core.appErrors.orgGet(owner, issue.id).issue.targetName).toBe('Off-platform shop');
		expect(core.appErrors.orgSetStatus(owner, { ids: [issue.id], status: 'resolved' })).toBe(1);
		expect(core.appErrors.orgList(owner, { status: 'resolved', target: target.id }).issues[0]?.id).toBe(issue.id);

		const overview = core.appErrors.serviceView(owner);
		expect(overview.daily).toHaveLength(14);
		expect(overview.newDaily).toHaveLength(14);
		expect(overview.hourly).toHaveLength(24);
		const targetView = overview.targets.find((row) => row.id === target.id)!;
		expect(targetView.daily).toHaveLength(7);
		expect(targetView.firstSeenAt).not.toBeNull();
		expect(overview.summary.targets).toBeGreaterThan(0);

		const testIssue = core.appErrors.testTarget(owner, target.id);
		expect(core.appErrors.orgDeleteIssues(owner, [issue.id, testIssue.issueId])).toBe(2);
		expect(core.appErrors.orgList(owner, { status: 'all', target: target.id }).issues).toHaveLength(0);

		const paused = core.appErrors.updateTarget(owner, target.id, { enabled: false });
		expect(paused.enabled).toBe(false);
		const resumed = core.appErrors.updateTarget(owner, target.id, { enabled: true, sampleRate: 0.5, notify: true });
		expect(resumed.enabled).toBe(true);
		expect(resumed.sampleRate).toBe(0.5);
		expect(resumed.notify).toBe(true);
		const rotated = core.appErrors.rotateTargetKey(owner, target.id);
		expect(rotated.publicKey).not.toBe(resumed.publicKey);

		expect(core.appErrors.deleteTarget(owner, target.id)).toBe(true);
		expect(core.appErrors.serviceView(owner).targets.some((row) => row.id === target.id)).toBe(false);
	});
});
