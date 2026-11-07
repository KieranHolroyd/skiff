import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, nodeCapabilities, nodeTaskLimits, type InlineFile } from '@skiff/contracts';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { sha256Hex } from './util.ts';

/** Queue and function tools run by the target node (D124). */
const dir = mkdtempSync(join(tmpdir(), 'skiff-node-tasks-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-07T10:00:00Z');
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
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_2', role: 'owner' });

const SOURCE = 'export default { async fetch() { return new Response("ok"); }, async scheduled() {} };';
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

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function heartbeat(token: string, nodeId: string, capabilities: string[], workloads: Array<{ id: string; status: 'running' }> = []) {
	core.nodes.heartbeat(token, {
		nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 0,
		status: 'online',
		caddyOk: true,
		capabilities,
		releases: [],
		...(workloads.length ? { workloads: workloads.map((item) => ({ ...item, restarts: 0 })) } : {}),
	} as never);
}

describe('node tasks', () => {
	let nodeId = '';
	let nodeToken = '';
	let brokerId = '';

	test('setup: a node, a running broker', () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		nodeId = joined.nodeId;
		nodeToken = joined.token;
		core.nodes.update(owner, nodeId, { sliceMemoryMb: 8192 });
		heartbeat(nodeToken, nodeId, ['functions', 'brokers']);
		brokerId = core.brokers.create(owner, { name: 'jobs' }).id;
	});

	test('a broker that is not running refuses tasks', () => {
		expect(() => core.nodeTasks.brokerTask(owner, 'jobs', 'broker.stream.peek', { stream: 'SKIFF_Q_jobs' })).toThrow(/pending/);
	});

	test('an agent without the capability is refused up front, not left waiting', () => {
		core.brokers.applyHeartbeat(nodeId, [{ id: brokerId, status: 'running', restarts: 0 }]);
		expect(() => core.nodeTasks.brokerTask(owner, 'jobs', 'broker.stream.peek', { stream: 'SKIFF_Q_jobs' })).toThrow(/predates queue and function tools/);
		heartbeat(nodeToken, nodeId, [...nodeCapabilities]);
	});

	test('permissions, names and bodies are checked before anything is queued', () => {
		expect(() => core.nodeTasks.brokerTask(viewer, 'jobs', 'broker.stream.peek', { stream: 'SKIFF_Q_jobs' })).toThrow(/broker:update/);
		expect(() => core.nodeTasks.brokerTask(owner, 'jobs', 'broker.stream.peek', { stream: 'bad.name' })).toThrow();
		expect(() => core.nodeTasks.brokerTask(owner, 'jobs', 'broker.queue.send', { queue: 'jobs', body: '{nope' })).toThrow(/not valid JSON/);
		expect(() => core.nodeTasks.brokerTask(owner, 'jobs', 'broker.queue.send', { queue: 'jobs', body: 'x'.repeat(nodeTaskLimits.messageBytes + 1), contentType: 'text' })).toThrow();
		expect(() => core.nodeTasks.brokerTask(owner, 'jobs', 'broker.queue.redrive', { from: 'jobs', to: 'jobs' })).toThrow(/different queue/);
		expect(() => core.nodeTasks.brokerTask(otherOrg, 'jobs', 'broker.stream.peek', { stream: 'SKIFF_Q_jobs' })).toThrow(/not found/i);
		expect(core.nodeTasks.lease(nodeId).tasks).toEqual([]);
	});

	test('queue → lease → result, and the listing picks up the change', async () => {
		const task = core.nodeTasks.brokerTask(owner, 'jobs', 'broker.queue.send', { queue: 'jobs', body: '{"hello":1}', count: 3 });
		expect(task).toMatchObject({ status: 'pending', kind: 'broker.queue.send', target: { type: 'broker', name: 'jobs', nodeId } });
		expect(task.input).toEqual({ queue: 'jobs', body: '{"hello":1}', contentType: 'json', count: 3 });
		expect(core.nodeTasks.hasPending(nodeId)).toBe(true);

		const lease = core.nodeTasks.lease(nodeId);
		expect(lease.tasks).toEqual([{ id: task.id, targetId: brokerId, kind: 'broker.queue.send', input: task.input }]);
		// A second lease in the same window gets nothing.
		expect(core.nodeTasks.lease(nodeId).tasks).toEqual([]);
		expect(core.nodeTasks.get(owner, task.id).status).toBe('running');

		// Another node cannot answer for it.
		core.nodeTasks.complete('node_other', { results: [{ id: task.id, ok: true, result: {} }] });
		expect(core.nodeTasks.get(owner, task.id).status).toBe('running');

		const state = { stream: 'SKIFF_Q_jobs', messages: 3, bytes: 99, firstAt: '2026-11-07T10:00:00Z', lastAt: '2026-11-07T10:00:00Z' };
		core.nodeTasks.complete(nodeId, { results: [{ id: task.id, ok: true, result: { stream: 'SKIFF_Q_jobs', sent: 3, seqs: [1, 2, 3], durationMs: 4, state } }] });
		const done = await core.nodeTasks.wait(owner, task, 10);
		expect(done.status).toBe('succeeded');
		expect(done.result).toMatchObject({ sent: 3, seqs: [1, 2, 3] });
		expect(core.brokers.queues(owner, 'jobs').streams).toEqual([
			expect.objectContaining({ stream: 'SKIFF_Q_jobs', queue: 'jobs', messages: 3, bytes: 99, retention: 'workqueue' }),
		]);
	});

	test('a failure keeps the node’s message; a result of the wrong shape fails', async () => {
		const peek = core.nodeTasks.brokerTask(owner, 'jobs', 'broker.stream.peek', { stream: 'SKIFF_Q_jobs' });
		const purge = core.nodeTasks.brokerTask(owner, 'jobs', 'broker.stream.purge', { stream: 'SKIFF_Q_jobs' });
		expect(core.nodeTasks.lease(nodeId).tasks.map((item) => item.id)).toEqual([peek.id, purge.id]);
		core.nodeTasks.complete(nodeId, {
			results: [
				{ id: peek.id, ok: false, error: 'Stream SKIFF_Q_jobs does not exist on this broker.' },
				{ id: purge.id, ok: true, result: { nonsense: true } },
			],
		});
		expect(core.nodeTasks.get(owner, peek.id)).toMatchObject({ status: 'failed', error: 'Stream SKIFF_Q_jobs does not exist on this broker.' });
		expect(core.nodeTasks.get(owner, purge.id).error).toMatch(/does not understand/);
		await expect(core.nodeTasks.run(owner, core.nodeTasks.get(owner, peek.id))).rejects.toThrow(/does not exist/);
	});

	test('deleting a stream drops it from the listing', () => {
		const task = core.nodeTasks.brokerTask(owner, 'jobs', 'broker.stream.delete', { stream: 'SKIFF_Q_jobs' });
		core.nodeTasks.lease(nodeId);
		core.nodeTasks.complete(nodeId, { results: [{ id: task.id, ok: true, result: { stream: 'SKIFF_Q_jobs', deleted: true } }] });
		expect(core.brokers.queues(owner, 'jobs').streams).toEqual([]);
	});

	test('the sweep fails unleased and lost tasks, then forgets them', () => {
		const unleased = core.nodeTasks.brokerTask(owner, 'jobs', 'broker.queue.create', { queue: 'later' });
		clock += nodeTaskLimits.pickupMs + 1;
		const lost = core.nodeTasks.brokerTask(owner, 'jobs', 'broker.queue.create', { queue: 'lost' });
		expect(core.nodeTasks.get(owner, unleased.id).error).toMatch(/did not pick this task up/);
		core.nodeTasks.lease(nodeId);
		clock += nodeTaskLimits.leaseSeconds * 1000 + 1;
		core.nodeTasks.sweep();
		expect(core.nodeTasks.get(owner, lost.id).error).toMatch(/did not report a result/);
		clock += nodeTaskLimits.retentionMs;
		expect(core.nodeTasks.sweep().removed).toBeGreaterThan(0);
		expect(() => core.nodeTasks.get(owner, lost.id)).toThrow(/not found/i);
	});

	test('an org cannot pile up unbounded tasks', () => {
		for (let index = 0; index < nodeTaskLimits.pendingPerOrg; index += 1)
			core.nodeTasks.brokerTask(owner, 'jobs', 'broker.queue.create', { queue: `q${index}` });
		expect(() => core.nodeTasks.brokerTask(owner, 'jobs', 'broker.queue.create', { queue: 'one-more' })).toThrow(/already waiting/);
		clock += nodeTaskLimits.pickupMs + 1;
		core.nodeTasks.sweep();
	});

	test('function tasks target replica 0 of the active deployment and only its crons', async () => {
		await core.projects.create(owner, { name: 'fn-tools', slug: 'fn-tools', runtime: 'function', placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
		const project = core.projects.requireRow(owner, 'fn-tools');
		expect(() => core.nodeTasks.functionTask(owner, project, 'function.invoke', {})).toThrow(/no active function deployment/);
		await core.uploads.deployInline(owner, project, bundle({ triggers: { crons: ['*/5 * * * *'], queues: [] } }), { promote: true });

		expect(() => core.nodeTasks.functionTask(owner, project, 'function.invoke', { path: '/__skiff/scheduled' })).toThrow(/internal/);
		expect(() => core.nodeTasks.functionTask(owner, project, 'function.invoke', { method: 'GET', body: 'x' })).toThrow(/no body/);
		expect(() => core.nodeTasks.functionTask(owner, project, 'function.scheduled', { cron: '0 * * * *' })).toThrow(/Its crons: \*\/5/);
		expect(() => core.nodeTasks.functionTask(viewer, project, 'function.invoke', {})).toThrow(/deployment:create/);

		const invoke = core.nodeTasks.functionTask(owner, project, 'function.invoke', {
			method: 'POST',
			path: '/hook?x=1',
			headers: { 'content-type': 'application/json', 'X-Skiff-Internal': '1' },
			body: '{}',
		});
		expect(invoke.input).toEqual({ method: 'POST', path: '/hook?x=1', headers: { 'content-type': 'application/json' }, body: '{}' });
		const cron = core.nodeTasks.functionTask(owner, project, 'function.scheduled', { cron: '*/5 * * * *' });
		const workload = (await core.nodes.desiredState(nodeToken)).workloads.find((item) => item.projectId === project.id)!;
		const lease = core.nodeTasks.lease(nodeId);
		expect(lease.tasks.map((item) => [item.id, item.targetId])).toEqual([
			[invoke.id, workload.id],
			[cron.id, workload.id],
		]);
	});
});
