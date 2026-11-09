import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	DEFAULT_FEATURES,
	nodeCapabilities,
	type AgentNodeTaskLease,
	type InlineFile
} from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, sha256Hex, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/**
 * The queue and function MCP tools (D124) against a real core: the node is simulated by leasing
 * and completing tasks while the tool waits. Stream purge/delete stay off MCP (D111).
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-mcp-node-tasks-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(
	join(dir, 'objects'),
	'https://control.test',
	'object-secret-123'
);
const realCore: Core = createCore({
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
		features: { ...DEFAULT_FEATURES }
	}
});

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { yoalToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	platformAdmin: true
});
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });

const SOURCE =
	'export default { async fetch() { return new Response("ok"); }, async scheduled() {} };';
const file = (path: string, content: string): InlineFile => ({ path, content, encoding: 'utf8' });

const NEW_TOOLS = [
	'create_queue',
	'send_queue_message',
	'peek_queue_messages',
	'redrive_queue',
	'get_node_task',
	'invoke_function',
	'run_function_cron'
];

let nodeId = '';
let nodeToken = '';

function heartbeat(capabilities: string[]) {
	realCore.nodes.heartbeat(nodeToken, {
		nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 0,
		status: 'online',
		caddyOk: true,
		capabilities,
		releases: []
	} as never);
}

/** Play the node: lease what is queued and answer it with `answer(task)`. */
function nodeAnswers(answer: (task: AgentNodeTaskLease['tasks'][number]) => unknown): () => void {
	const timer = setInterval(() => {
		const lease = realCore.nodeTasks.lease(nodeId);
		if (lease.tasks.length === 0) return;
		realCore.nodeTasks.complete(nodeId, {
			results: lease.tasks.map((task) => ({ id: task.id, ok: true, result: answer(task) }))
		});
	}, 20);
	return () => clearInterval(timer);
}

function definition(principal: typeof owner, name: string) {
	const found = yoalToolDefinitions(principal).find((entry) => entry.name === name);
	if (!found) throw new Error(`no tool ${name}`);
	return found;
}

async function call(principal: typeof owner, name: string, args: Record<string, unknown>) {
	const tool = assistantTools(principal).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	return {
		ok: result.ok,
		text: result.text,
		body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null
	};
}

describe('node task MCP tools', () => {
	test('setup: a node with the node-tasks capability, a running broker', () => {
		const joined = realCore.nodes.join({
			token: realCore.nodes.createJoinToken(owner, 'edge').token,
			name: 'edge'
		});
		nodeId = joined.nodeId;
		nodeToken = joined.token;
		realCore.nodes.update(owner, nodeId, { sliceMemoryMb: 8192 });
		heartbeat(['functions', 'brokers']);
		const broker = realCore.brokers.create(owner, { name: 'jobs' });
		realCore.brokers.applyHeartbeat(nodeId, [{ id: broker.id, status: 'running', restarts: 0 }]);
		heartbeat([...nodeCapabilities]);
	});

	test('are registered, while stream purge and delete stay off MCP', () => {
		const names = new Set(yoalToolDefinitions(owner).map((entry) => entry.name));
		for (const name of NEW_TOOLS) expect(names.has(name)).toBe(true);
		expect(
			[...names].filter((name) => /purge|delete_stream|delete_message|delete_queue/.test(name))
		).toEqual([]);
		expect(definition(owner, 'peek_queue_messages').config.annotations?.readOnlyHint).toBe(true);
		expect(definition(owner, 'get_node_task').config.annotations?.readOnlyHint).toBe(true);
		expect(definition(owner, 'create_queue').config.annotations?.idempotentHint).toBe(true);
	});

	test('the assistant asks before anything that runs production code, and hides the tools from viewers', () => {
		const tools = new Map(assistantTools(owner).map((entry) => [entry.name, entry]));
		for (const name of [
			'send_queue_message',
			'redrive_queue',
			'invoke_function',
			'run_function_cron'
		])
			expect(tools.get(name)?.destructive).toBe(true);
		expect(tools.get('create_queue')?.destructive).toBe(false);
		expect(tools.get('peek_queue_messages')?.destructive).toBe(false);
		const forViewer = new Set(assistantTools(viewer).map((entry) => entry.name));
		for (const name of [
			'create_queue',
			'send_queue_message',
			'peek_queue_messages',
			'redrive_queue',
			'invoke_function',
			'run_function_cron'
		])
			expect(forViewer.has(name)).toBe(false);
		expect(forViewer.has('get_node_task')).toBe(true);
	});

	test('send_queue_message waits for the node and reports the stored copies', async () => {
		const seen: unknown[] = [];
		const stop = nodeAnswers((task) => {
			seen.push(task);
			return { stream: 'YOAL_Q_jobs', sent: 2, seqs: [7, 8], durationMs: 3, state: null };
		});
		try {
			const result = await call(owner, 'send_queue_message', {
				broker: 'jobs',
				queue: 'jobs',
				body: '{"hello":1}',
				count: 2
			});
			expect(result.ok).toBe(true);
			expect(result.body).toMatchObject({
				status: 'succeeded',
				kind: 'broker.queue.send',
				result: { sent: 2, seqs: [7, 8] }
			});
			expect(result.body!.taskId).toStartWith('ntk_');
			expect(result.body!.nextSteps.join(' ')).toContain('peek_queue_messages');
		} finally {
			stop();
		}
		expect(seen).toEqual([
			expect.objectContaining({
				kind: 'broker.queue.send',
				input: { queue: 'jobs', body: '{"hello":1}', contentType: 'json', count: 2 }
			})
		]);
		// The audit log keeps the size, not the message body.
		const audit = realCore.ctx.sqlite
			.query<{ args_json: string }, []>(
				"SELECT args_json FROM audit_log WHERE action = 'assistant.send_queue_message'"
			)
			.get();
		expect(audit?.args_json).not.toContain('hello');
	});

	test('peek_queue_messages maps a queue to its stream and points at the next page', async () => {
		const stop = nodeAnswers((task) => {
			expect(task).toMatchObject({
				kind: 'broker.stream.peek',
				input: { stream: 'YOAL_Q_jobs', limit: 1 }
			});
			return {
				stream: 'YOAL_Q_jobs',
				messages: [
					{
						seq: 7,
						subject: 'yoal.q.jobs',
						time: null,
						size: 11,
						headers: {},
						encoding: 'utf8',
						body: '{"hello":1}',
						truncated: false
					}
				],
				total: 2,
				firstSeq: 7,
				lastSeq: 8,
				nextSeq: 8
			};
		});
		try {
			const result = await call(owner, 'peek_queue_messages', {
				broker: 'jobs',
				queue: 'jobs',
				limit: 1
			});
			expect(result.ok).toBe(true);
			expect(result.body!.result.messages[0].body).toBe('{"hello":1}');
			expect(result.body!.nextSteps.join(' ')).toContain('fromSeq 8');
		} finally {
			stop();
		}
		const both = await call(owner, 'peek_queue_messages', {
			broker: 'jobs',
			queue: 'jobs',
			stream: 'YOAL_Q_jobs'
		});
		expect(both.ok).toBe(false);
		expect(both.text).toContain('exactly one of queue or stream');
		expect(
			(await call(owner, 'peek_queue_messages', { broker: 'jobs', queue: 'jobs', limit: 51 })).ok
		).toBe(false);
	});

	test('a node failure comes back as the tool error', async () => {
		const stop = setInterval(() => {
			const lease = realCore.nodeTasks.lease(nodeId);
			if (lease.tasks.length)
				realCore.nodeTasks.complete(nodeId, {
					results: lease.tasks.map((task) => ({
						id: task.id,
						ok: false,
						error: 'Stream YOAL_Q_dead does not exist on this broker.'
					}))
				});
		}, 20);
		try {
			const result = await call(owner, 'redrive_queue', {
				broker: 'jobs',
				from: 'dead',
				to: 'jobs'
			});
			expect(result.ok).toBe(false);
			expect(result.text).toContain('does not exist');
		} finally {
			clearInterval(stop);
		}
	});

	test('permissions: viewers are refused, and get_node_task asks for the scope its task needs', async () => {
		const send = await definition(viewer, 'send_queue_message').handler({
			broker: 'jobs',
			queue: 'jobs',
			body: '{}',
			contentType: 'json',
			count: 1
		});
		expect((send as { isError?: boolean }).isError).toBe(true);
		expect(JSON.stringify(send)).toContain('broker:update');

		await realCore.projects.create(owner, {
			name: 'fn-tools',
			slug: 'fn-tools',
			runtime: 'function',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform'
		});
		const project = realCore.projects.requireRow(owner, 'fn-tools');
		await realCore.uploads.deployInline(
			owner,
			project,
			[
				file(
					'yoal-function.json',
					JSON.stringify({
						version: 1,
						main: 'index.js',
						modules: [
							{ name: 'index.js', type: 'esm', sha256: sha256Hex(new TextEncoder().encode(SOURCE)) }
						],
						compatibilityDate: '2026-10-01',
						bindings: [],
						triggers: { crons: ['*/5 * * * *'], queues: [] }
					})
				),
				file('index.js', SOURCE)
			],
			{ promote: true }
		);
		const task = realCore.nodeTasks.functionTask(owner, project, 'function.scheduled', {
			cron: '*/5 * * * *'
		});

		// An MCP token granted broker:read only: following a function task needs deployment:read.
		const scoped = buildPrincipal({
			kind: 'mcp',
			userId: 'user_1',
			orgId: 'org_1',
			role: 'owner',
			granted: ['broker:read']
		});
		const challenge = definition(scoped, 'get_node_task').config.scopeChallenge as (
			context: unknown
		) => Promise<unknown>;
		const asked = await challenge({
			authInfo: { scopes: ['broker:read'] },
			request: { params: { arguments: { id: task.id } } }
		});
		expect(asked).toMatchObject({ scopes: ['broker:read', 'deployment:read'] });
		const fine = definition(owner, 'get_node_task').config.scopeChallenge as (
			context: unknown
		) => Promise<unknown>;
		expect(
			await fine({
				authInfo: { scopes: [...owner.permissions] },
				request: { params: { arguments: { id: task.id } } }
			})
		).toBeUndefined();

		// Still queued: get_node_task reports it pending and says how to follow it.
		const pending = await call(owner, 'get_node_task', { id: task.id });
		expect(pending.body).toMatchObject({ status: 'pending', kind: 'function.scheduled' });
		expect(pending.body!.nextSteps[0]).toContain(`get_node_task with id "${task.id}"`);
	});

	test('invoke_function returns the response from the function host', async () => {
		const stop = nodeAnswers((task) =>
			task.kind === 'function.invoke'
				? {
						status: 200,
						statusText: 'OK',
						headers: [['content-type', 'text/plain']],
						encoding: 'utf8',
						body: 'ok',
						size: 2,
						truncated: false,
						durationMs: 12,
						coldStart: true
					}
				: { status: 200, error: null, durationMs: 1, coldStart: false }
		);
		try {
			const result = await call(owner, 'invoke_function', {
				project: 'fn-tools',
				method: 'GET',
				path: '/'
			});
			expect(result.ok).toBe(true);
			expect(result.body).toMatchObject({
				status: 'succeeded',
				result: { status: 200, body: 'ok', coldStart: true }
			});
			expect(result.body!.nextSteps[0]).toContain('cold start');
		} finally {
			stop();
		}
	});
});
