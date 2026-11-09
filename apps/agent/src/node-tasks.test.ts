import { describe, expect, test } from 'bun:test';
import type { AgentNodeTask, WorkloadDesired } from '@yoal/contracts';
import { encodeHeaders } from '../../../packages/function-bindings/src/nats.js';
import { NodeTaskRunner, taskTargets } from './node-tasks.ts';

/** Queue and function tools on the node (D124). */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function broker(id = 'mq_1'): WorkloadDesired {
	return {
		id,
		projectId: id,
		projectSlug: 'jobs',
		deploymentId: id,
		runtime: 'container',
		status: 'running',
		release: null,
		image: 'nats:2.12-alpine',
		upstream: '127.0.0.1:14222',
		memoryMb: 256,
		cpus: 0.5,
		port: 14222,
		healthPath: '/',
		socketActivation: false,
		activationVersion: 'v1',
		env: {},
		secrets: [],
		dataSizeMb: null,
		broker: { engine: 'nats', version: '2.12', storageMb: 2048 },
	} as WorkloadDesired;
}

function fn(id = 'wl_fn'): WorkloadDesired {
	return {
		...broker(id),
		projectId: 'prj_fn',
		projectSlug: 'fn',
		runtime: 'process',
		broker: undefined,
		function: { triggers: { crons: ['*/5 * * * *'], queues: [] } },
	} as unknown as WorkloadDesired;
}

interface StoredMessage {
	seq: number;
	subject: string;
	data: Uint8Array;
	headers: Record<string, string>;
}

/** Just enough JetStream for the task verbs: streams, publish, MSG.GET/DELETE, PURGE, DELETE. */
function fakeJetStream() {
	const streams = new Map<string, { subject: string; lastSeq: number; messages: StoredMessage[] }>();
	const reply = (body: unknown) => ({ data: encoder.encode(JSON.stringify(body)) });
	const jsError = (code: number, description: string) => reply({ error: { code: 404, err_code: code, description } });
	const info = (name: string) => {
		const stream = streams.get(name)!;
		const first = stream.messages[0];
		return {
			config: { name },
			state: {
				messages: stream.messages.length,
				bytes: stream.messages.reduce((sum, item) => sum + item.data.length, 0),
				first_seq: first?.seq ?? stream.lastSeq + 1,
				last_seq: stream.lastSeq,
				first_ts: first ? '2026-11-07T10:00:00Z' : '0001-01-01T00:00:00Z',
				last_ts: first ? '2026-11-07T10:00:01Z' : '0001-01-01T00:00:00Z',
			},
		};
	};
	const connection = {
		request: async (subject: string, data: string | Uint8Array, options: { headers?: Record<string, string> } = {}) => {
			const text = typeof data === 'string' ? data : decoder.decode(data);
			const body = text && subject.startsWith('$JS.API.') ? JSON.parse(text) : {};
			const api = /^\$JS\.API\.([A-Z.]+?)\.([^.]+)$/.exec(subject);
			if (api) {
				const [, verb, name] = api as unknown as [string, string, string];
				if (verb === 'STREAM.CREATE') {
					streams.set(name, { subject: body.subjects[0], lastSeq: 0, messages: [] });
					return reply(info(name));
				}
				const stream = streams.get(name);
				if (!stream) return jsError(10059, 'stream not found');
				switch (verb) {
					case 'STREAM.INFO':
						return reply(info(name));
					case 'STREAM.PURGE': {
						const purged = stream.messages.length;
						stream.messages = [];
						return reply({ success: true, purged });
					}
					case 'STREAM.DELETE':
						streams.delete(name);
						return reply({ success: true });
					case 'STREAM.MSG.GET': {
						const found = stream.messages.find((item) => item.seq >= body.seq);
						if (!found) return jsError(10037, 'no message found');
						return reply({
							message: {
								subject: found.subject,
								seq: found.seq,
								time: '2026-11-07T10:00:00Z',
								hdrs: Buffer.from(encodeHeaders(found.headers)).toString('base64'),
								data: Buffer.from(found.data).toString('base64'),
							},
						});
					}
					case 'STREAM.MSG.DELETE': {
						const before = stream.messages.length;
						stream.messages = stream.messages.filter((item) => item.seq !== body.seq);
						return before === stream.messages.length ? jsError(10037, 'no message found') : reply({ success: true });
					}
				}
				throw new Error(`fake JetStream has no ${verb}`);
			}
			const target = [...streams.entries()].find(([, stream]) => stream.subject === subject);
			if (!target) throw Object.assign(new Error('no responders'), { code: 'no_responders' });
			const [name, stream] = target;
			stream.lastSeq += 1;
			stream.messages.push({ seq: stream.lastSeq, subject, data: typeof data === 'string' ? encoder.encode(data) : data, headers: options.headers ?? {} });
			return reply({ stream: name, seq: stream.lastSeq });
		},
		close: async () => undefined,
	};
	return { streams, connect: async () => connection as never };
}

function runner(options: { js?: ReturnType<typeof fakeJetStream>; fetch?: typeof fetch; status?: string } = {}) {
	const activity: string[] = [];
	const instance = new NodeTaskRunner({
		controlUrl: 'https://control.test',
		nodeToken: 'tok',
		socketDir: '/run/yoal/workloads',
		fetchActivation: async () => ({ env: { YOAL_BROKER_USER: 'u', YOAL_BROKER_PASSWORD: 'p' } }) as never,
		connect: (options.js ?? fakeJetStream()).connect,
		workloadStatus: async () => (options.status ?? 'running') as never,
		noteActivity: (projectId) => activity.push(projectId),
		...(options.fetch ? { fetch: options.fetch } : {}),
	});
	return { instance, activity };
}

const targets = (...items: WorkloadDesired[]) => new Map(items.map((item) => [item.id, item]));
const task = (spec: Omit<AgentNodeTask, 'id' | 'targetId'>, targetId = 'mq_1', id = 'ntk_1') => ({ id, targetId, ...spec }) as AgentNodeTask;

describe('NodeTaskRunner: broker tasks', () => {
	test('create, send, peek, delete a message, purge and delete a stream', async () => {
		const js = fakeJetStream();
		const { instance } = runner({ js });
		const signal = new AbortController().signal;
		const on = targets(broker());

		const created = await instance.runOne(task({ kind: 'broker.queue.create', input: { queue: 'jobs' } }), on, signal);
		expect(created).toMatchObject({ ok: true, result: { stream: 'YOAL_Q_jobs', created: true, state: { messages: 0, firstAt: null } } });
		const again = await instance.runOne(task({ kind: 'broker.queue.create', input: { queue: 'jobs' } }), on, signal);
		expect(again.result).toMatchObject({ created: false });

		const sent = await instance.runOne(
			task({ kind: 'broker.queue.send', input: { queue: 'jobs', body: '{"n":1}', contentType: 'json', count: 3, delaySeconds: 5 } }, 'mq_1', 'ntk_send'),
			on,
			signal,
		);
		expect(sent).toMatchObject({ ok: true, result: { sent: 3, seqs: [1, 2, 3], state: { messages: 3 } } });
		const stored = js.streams.get('YOAL_Q_jobs')!.messages;
		expect(stored.map((item) => item.headers['Nats-Msg-Id'])).toEqual(['ntk_send-0', 'ntk_send-1', 'ntk_send-2']);
		expect(stored[0]!.headers['Yoal-Content-Type']).toBe('json');
		expect(Number(stored[0]!.headers['Yoal-Not-Before'])).toBeGreaterThan(Date.now());

		const peek = await instance.runOne(task({ kind: 'broker.stream.peek', input: { stream: 'YOAL_Q_jobs', limit: 2 } }), on, signal);
		expect(peek.result).toMatchObject({ total: 3, firstSeq: 1, lastSeq: 3, nextSeq: 3 });
		const messages = (peek.result as { messages: Array<{ seq: number; body: string; encoding: string; headers: Record<string, string> }> }).messages;
		expect(messages.map((item) => [item.seq, item.body, item.encoding])).toEqual([
			[1, '{"n":1}', 'utf8'],
			[2, '{"n":1}', 'utf8'],
		]);
		expect(messages[0]!.headers['yoal-content-type']).toBe('json');
		// Peeking consumes nothing.
		expect(js.streams.get('YOAL_Q_jobs')!.messages).toHaveLength(3);

		const removed = await instance.runOne(task({ kind: 'broker.stream.deleteMessage', input: { stream: 'YOAL_Q_jobs', seq: 2 } }), on, signal);
		expect(removed.result).toMatchObject({ deleted: true, state: { messages: 2 } });
		const gone = await instance.runOne(task({ kind: 'broker.stream.deleteMessage', input: { stream: 'YOAL_Q_jobs', seq: 2 } }), on, signal);
		expect(gone.result).toMatchObject({ deleted: false });

		const purged = await instance.runOne(task({ kind: 'broker.stream.purge', input: { stream: 'YOAL_Q_jobs' } }), on, signal);
		expect(purged.result).toMatchObject({ purged: 2, state: { messages: 0 } });
		const deleted = await instance.runOne(task({ kind: 'broker.stream.delete', input: { stream: 'YOAL_Q_jobs' } }), on, signal);
		expect(deleted.result).toEqual({ stream: 'YOAL_Q_jobs', deleted: true });
		expect(js.streams.has('YOAL_Q_jobs')).toBe(false);

		const missing = await instance.runOne(task({ kind: 'broker.stream.peek', input: { stream: 'YOAL_Q_jobs', limit: 5 } }), on, signal);
		expect(missing).toMatchObject({ ok: false, error: 'Stream YOAL_Q_jobs does not exist on this broker.' });
	});

	test('redrive moves dead-lettered messages back, keeping body and id but not the attempt count', async () => {
		const js = fakeJetStream();
		const { instance } = runner({ js });
		const signal = new AbortController().signal;
		const on = targets(broker());
		await instance.runOne(task({ kind: 'broker.queue.create', input: { queue: 'jobs-dlq' } }), on, signal);
		const dlq = js.streams.get('YOAL_Q_jobs-dlq')!;
		for (const [index, body] of ['a', 'b', 'c'].entries())
			dlq.messages.push({ seq: index + 1, subject: 'yoal.q.jobs-dlq', data: encoder.encode(JSON.stringify(body)), headers: { 'Nats-Msg-Id': `m${index}`, 'Yoal-Content-Type': 'json', 'Yoal-Attempts': '4' } });
		dlq.lastSeq = 3;

		const result = await instance.runOne(task({ kind: 'broker.queue.redrive', input: { from: 'jobs-dlq', to: 'jobs', limit: 2 } }), on, signal);
		expect(result).toMatchObject({ ok: true, result: { moved: 2, remaining: 1, state: { stream: 'YOAL_Q_jobs', messages: 2 }, source: { messages: 1 } } });
		const moved = js.streams.get('YOAL_Q_jobs')!.messages;
		expect(moved.map((item) => [decoder.decode(item.data), item.headers['Nats-Msg-Id'], item.headers['Yoal-Attempts']])).toEqual([
			['"a"', 'm0', undefined],
			['"b"', 'm1', undefined],
		]);
	});

	test('a target that left this node fails the task without touching anything', async () => {
		const { instance } = runner();
		const result = await instance.runOne(task({ kind: 'broker.stream.purge', input: { stream: 'S' } }), targets(), new AbortController().signal);
		expect(result).toEqual({ id: 'ntk_1', ok: false, error: 'The service is not running on this node any more.' });
	});
});

describe('NodeTaskRunner: function tasks', () => {
	test('invoke sends the request to the host socket and returns the response', async () => {
		const calls: Array<{ url: string; init: RequestInit & { unix?: string } }> = [];
		const fetchFake = (async (url: string, init: RequestInit & { unix?: string }) => {
			calls.push({ url, init });
			return new Response('hello', { status: 201, statusText: 'Created', headers: { 'x-out': '1' } });
		}) as unknown as typeof fetch;
		const { instance, activity } = runner({ fetch: fetchFake, status: 'stopped' });
		const result = await instance.runOne(
			task({ kind: 'function.invoke', input: { method: 'POST', path: '/hook?x=1', headers: { 'content-type': 'text/plain', 'x-yoal-internal': '1' }, body: 'hi' } }, 'wl_fn'),
			targets(fn()),
			new AbortController().signal,
		);
		expect(result).toMatchObject({ ok: true, result: { status: 201, statusText: 'Created', body: 'hello', encoding: 'utf8', size: 5, truncated: false, coldStart: true } });
		expect((result.result as { headers: string[][] }).headers).toContainEqual(['x-out', '1']);
		expect(calls[0]!.url).toBe('http://localhost/hook?x=1');
		expect(calls[0]!.init.unix).toBe('/run/yoal/workloads/wl_fn.sock');
		const sent = calls[0]!.init.headers as Headers;
		expect(sent.get('x-yoal-internal')).toBeNull();
		expect(sent.get('user-agent')).toBe('yoal-test-request');
		expect(activity).toEqual(['prj_fn']);
	});

	test('scheduled posts to the internal cron route and reports the handler error', async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const fetchFake = (async (url: string, init: RequestInit) => {
			calls.push({ url, headers: init.headers as Record<string, string> });
			return new Response(JSON.stringify({ error: 'this function has no scheduled handler' }), { status: 501 });
		}) as unknown as typeof fetch;
		const { instance } = runner({ fetch: fetchFake });
		const on = targets(fn());
		const result = await instance.runOne(task({ kind: 'function.scheduled', input: { cron: '*/5 * * * *' } }, 'wl_fn'), on, new AbortController().signal);
		expect(result).toMatchObject({ ok: true, result: { status: 501, error: 'this function has no scheduled handler', coldStart: false } });
		expect(calls[0]!.url).toBe('http://localhost/__yoal/scheduled');
		expect(calls[0]!.headers).toMatchObject({ 'x-yoal-internal': '1', 'x-yoal-cron': '*/5 * * * *' });

		const unknown = await instance.runOne(task({ kind: 'function.scheduled', input: { cron: '0 0 * * *' } }, 'wl_fn'), on, new AbortController().signal);
		expect(unknown).toMatchObject({ ok: false });
		expect(unknown.error).toMatch(/no cron "0 0 \* \* \*"/);
	});
});

test('taskTargets lists running brokers and function hosts only', () => {
	const stopped = { ...broker('mq_2'), status: 'stopped' } as WorkloadDesired;
	const plain = { ...fn('wl_app'), function: undefined } as WorkloadDesired;
	const state = { workloads: [broker(), fn(), stopped, plain] } as never;
	expect([...taskTargets(state).keys()]).toEqual(['mq_1', 'wl_fn']);
});
