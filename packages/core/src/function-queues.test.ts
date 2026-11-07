import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, type InlineFile } from '@skiff/contracts';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { sha256Hex } from './util.ts';

/** Function queues on managed brokers (docs/FUNCTIONS.md §4.10, D112). */
const dir = mkdtempSync(join(tmpdir(), 'skiff-fn-queues-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const clock = Date.parse('2026-11-07T10:00:00Z');
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
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
		features: { ...DEFAULT_FEATURES },
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

const SOURCE = 'export default { async fetch() { return new Response("ok"); }, async queue() {} };';
const file = (path: string, content: string): InlineFile => ({ path, content, encoding: 'utf8' });
const bundle = (overrides: Record<string, unknown>): InlineFile[] => [
	file(
		'skiff-function.json',
		JSON.stringify({
			version: 1,
			main: 'index.js',
			modules: [{ name: 'index.js', type: 'esm', sha256: sha256Hex(new TextEncoder().encode(SOURCE)) }],
			compatibilityDate: '2026-10-01',
			bindings: [],
			...overrides,
		}),
	),
	file('index.js', SOURCE),
];

async function functionProject(slug: string) {
	await core.projects.create(owner, { name: slug, slug, runtime: 'function', placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
	return core.projects.requireRow(owner, slug);
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('function queues on a managed broker', () => {
	let nodeToken = '';

	test('setup: a node that runs functions and brokers, and a broker', () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		nodeToken = joined.token;
		core.nodes.update(owner, joined.nodeId, { sliceMemoryMb: 8192 });
		core.nodes.heartbeat(nodeToken, {
			nodeId: joined.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 0,
			status: 'online',
			caddyOk: true,
			capabilities: ['functions', 'brokers'],
			releases: [],
		});
		expect(core.brokers.create(owner, { name: 'events' }).status).toBe('pending');
	});

	test('a queue binding without an attached broker is refused at deploy time', async () => {
		const project = await functionProject('fn-orphan');
		await expect(
			core.uploads.deployInline(owner, project, bundle({ bindings: [{ name: 'JOBS', type: 'queue', queue: 'jobs' }] })),
		).rejects.toThrow(/queues run on a managed broker/);
		await expect(
			core.uploads.deployInline(owner, project, bundle({ bindings: [{ name: 'JOBS', type: 'queue', queue: 'jobs', broker: 'events' }] })),
		).rejects.toThrow(/attach broker "events"/);
		await expect(
			core.uploads.deployInline(owner, project, bundle({ bindings: [{ name: 'JOBS', type: 'queue', queue: 'jobs', broker: 'nope' }] })),
		).rejects.toThrow(/does not exist/);
		await expect(
			core.uploads.deployInline(owner, project, bundle({ bindings: [{ name: 'JOBS', type: 'queue', queue: 'Bad.Name' }] })),
		).rejects.toThrow();
	});

	test('a function attaches a broker, produces and consumes; the spec carries the attachment prefix', async () => {
		const producer = await functionProject('fn-producer');
		const { attachment } = core.brokers.attach(owner, producer, { broker: 'events' });
		expect(attachment.envPrefix).toBe('NATS');
		await core.uploads.deployInline(
			owner,
			producer,
			bundle({
				bindings: [{ name: 'JOBS', type: 'queue', queue: 'jobs' }],
				triggers: { crons: [], queues: [{ queue: 'jobs', maxBatchSize: 20, deadLetterQueue: 'jobs-dlq' }] },
			}),
			{ promote: true },
		);
		const view = core.functions.view(owner, producer)!;
		expect(view.bindings).toEqual([{ name: 'JOBS', type: 'queue', summary: 'queue jobs on broker events' }]);
		expect(view.triggers.queues).toEqual([{ queue: 'jobs', broker: 'events' }]);

		const state = await core.nodes.desiredState(nodeToken);
		const workload = state.workloads.find((item) => item.projectSlug === 'fn-producer')!;
		expect(workload.function?.bindings).toEqual([
			{ name: 'JOBS', type: 'queue', queue: 'jobs', producer: true, broker: 'events', envPrefix: 'NATS' },
		]);
		expect(workload.function?.triggers.queues).toEqual([
			{ queue: 'jobs', broker: 'events', envPrefix: 'NATS', maxBatchSize: 20, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: 'jobs-dlq' },
		]);
		// The function's activation carries the broker credentials the producer and consumer read.
		const activation = core.workloads.activation(state.nodeId, workload.id);
		expect(activation.env.NATS_PORT).toBe(core.brokers.get(owner, 'events').internalHost.process.split(':')[1]);
		expect(activation.env.NATS_USER).toBe('events');
		expect(activation.env.NATS_PASSWORD).toBeTruthy();
		// The broker pins the function to its node (D56).
		expect(core.workloads.attachmentNode(producer.id)).toBe(state.nodeId);
	});

	test('a queue has one consumer per broker', async () => {
		const other = await functionProject('fn-other');
		core.brokers.attach(owner, other, { broker: 'events' });
		await expect(
			core.uploads.deployInline(owner, other, bundle({ triggers: { crons: [], queues: [{ queue: 'jobs' }] } })),
		).rejects.toThrow(/already has a consumer: "fn-producer"/);
		// Producing to it from another function is fine: that is the point of a shared broker.
		await core.uploads.deployInline(owner, other, bundle({ bindings: [{ name: 'JOBS', type: 'queue', queue: 'jobs' }] }));
		await expect(
			core.uploads.deployInline(
				owner,
				other,
				bundle({ triggers: { crons: [], queues: [{ queue: 'mail', deadLetterQueue: 'mail' }] } }),
			),
		).rejects.toThrow(/dead-letter queue must be a different queue/);
	});
});
