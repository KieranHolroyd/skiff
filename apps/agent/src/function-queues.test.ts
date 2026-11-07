import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesiredState, WorkloadDesired } from '@skiff/contracts';
import {
	NatsConnection,
	QUEUE_HEADERS,
	ensureQueueStream,
	publishToQueue,
	queueBacklog,
} from '../../../packages/function-bindings/src/nats.js';
import { FunctionQueueConsumers, deliveredMessage, readOutcomes, retryDelaySeconds } from './function-queues.ts';
import { connectTcp } from './tcp-stream.ts';

/** Agent-side queue consumers (docs/FUNCTIONS.md §4.10, D112). */

const encode = (text: string) => new TextEncoder().encode(text);
const headers = (values: Record<string, string>) => ({
	status: 0,
	description: '',
	get: (name: string) => values[name],
	entries: () => Object.entries(values),
});

describe('message shaping and verdicts', () => {
	test('bodies decode by content type; a delayed message does not count its hold-back as an attempt', () => {
		const json = deliveredMessage({
			data: encode('{"n":1}'),
			headers: headers({ [QUEUE_HEADERS.id]: 'm1', [QUEUE_HEADERS.contentType]: 'json', [QUEUE_HEADERS.timestamp]: '1000' }),
			info: { delivered: 2, streamSequence: 7, timestampMs: 5 },
		});
		expect(json).toEqual({ id: 'm1', timestamp: 1000, attempts: 2, contentType: 'json', body: { n: 1 } });
		const delayed = deliveredMessage({
			data: encode('hi'),
			headers: headers({ [QUEUE_HEADERS.contentType]: 'text', [QUEUE_HEADERS.notBefore]: '1' }),
			info: { delivered: 2, streamSequence: 9, timestampMs: 5 },
		});
		expect(delayed).toMatchObject({ id: '9', timestamp: 5, attempts: 1, body: 'hi' });
		expect(deliveredMessage({ data: encode('raw'), headers: null, info: null }).body).toBe(btoa('raw'));
	});

	test('retry delay: the handler’s choice, then the consumer’s, then capped backoff', () => {
		expect(retryDelaySeconds(3, {}, 12)).toBe(12);
		expect(retryDelaySeconds(3, { retryDelay: 30 })).toBe(30);
		expect(retryDelaySeconds(1, {})).toBe(1);
		expect(retryDelaySeconds(3, {})).toBe(4);
		expect(retryDelaySeconds(20, {})).toBe(60);
	});

	test('shim replies: per-message results, bare 2xx acks all, errors retry all', async () => {
		const ok = await readOutcomes(
			new Response(JSON.stringify({ results: [{ id: 'b', outcome: 'retry', delaySeconds: 9 }, { id: 'zz', outcome: 'retry' }] })),
			['a', 'b'],
		);
		expect([...ok.outcomes.values()]).toEqual([{ id: 'a', outcome: 'ack' }, { id: 'b', outcome: 'retry', delaySeconds: 9 }]);
		expect([...(await readOutcomes(new Response(null, { status: 204 }), ['a'])).outcomes.values()]).toEqual([{ id: 'a', outcome: 'ack' }]);
		const failed = await readOutcomes(new Response('{"error":"this function has no queue handler"}', { status: 501 }), ['a']);
		expect([...failed.outcomes.values()]).toEqual([{ id: 'a', outcome: 'retry' }]);
		expect(failed.error).toBe('501 this function has no queue handler');
	});
});

function functionWorkload(queues: unknown[], overrides: Partial<WorkloadDesired> = {}): WorkloadDesired {
	return {
		id: 'wl_q1',
		projectId: 'prj_q1',
		projectSlug: 'jobs-fn',
		deploymentId: 'dep_1',
		runtime: 'function',
		status: 'running',
		release: 'a'.repeat(64),
		upstream: 'unix//run/skiff-workloads/wl_q1.sock',
		memoryMb: 128,
		cpus: 1,
		port: 3000,
		healthPath: '/__skiff/health',
		socketActivation: true,
		activationVersion: 'b'.repeat(64),
		env: {},
		secrets: [],
		dataSizeMb: null,
		function: {
			main: 'index.js',
			modules: [{ name: 'index.js', type: 'esm', sha256: 'c'.repeat(64) }],
			compatibilityDate: '2026-10-01',
			compatibilityFlags: [],
			bindings: [],
			triggers: { crons: [], queues: queues as never },
			assets: null,
			idleStopSeconds: 300,
			workerdVersion: '1.2.3',
		},
		...overrides,
	} as WorkloadDesired;
}

const stateOf = (workloads: WorkloadDesired[]) => ({ workloads }) as unknown as DesiredState;

describe('reconcile', () => {
	test('starts one loop per consumer on replica 0, restarts on a new activation and stops removed ones', () => {
		const consumers = new FunctionQueueConsumers({
			socketDir: '/nowhere',
			fetchActivation: () => new Promise(() => undefined),
		});
		const signal = new AbortController().signal;
		const consumer = { queue: 'jobs', broker: 'events', envPrefix: 'NATS', maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3 };
		consumers.reconcile(stateOf([functionWorkload([consumer]), functionWorkload([consumer], { id: 'wl_q1-r1', replica: { index: 1 } })]), signal);
		expect(consumers.running()).toEqual(['wl_q1\nevents\njobs']);
		consumers.reconcile(stateOf([functionWorkload([consumer], { activationVersion: 'd'.repeat(64) })]), signal);
		expect(consumers.running()).toEqual(['wl_q1\nevents\njobs']);
		consumers.reconcile(stateOf([functionWorkload([])]), signal);
		expect(consumers.running()).toEqual([]);
		void consumers.stopAll();
	});
});

/** Needs a NATS server with JetStream; see packages/function-bindings/src/queue.test.ts. */
const target = process.env.SKIFF_TEST_NATS ?? '';
const [host, port] = target.split(':');
const USER = 'tester';
const PASS = 'tester-password-123';

describe.skipIf(!target)('consuming from a real broker', () => {
	const cleanup: Array<() => Promise<void>> = [];
	afterAll(async () => {
		for (const step of cleanup.reverse()) await step();
	});

	async function waitFor(check: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			if (await check()) return;
			await Bun.sleep(50);
		}
		throw new Error('condition not met in time');
	}

	test('delivers batches to the shim, retries, dead-letters and holds back delayed messages', async () => {
		const suffix = Math.random().toString(36).slice(2, 8);
		const queue = `agent-${suffix}`;
		const dlq = `agent-dlq-${suffix}`;
		const dir = await mkdtemp(join(tmpdir(), 'skiff-queue-shim-'));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));

		const batches: Array<{ queue: string | null; messages: Array<{ id: string; attempts: number; body: unknown }> }> = [];
		const server = Bun.serve({
			unix: join(dir, 'wl_q1.sock'),
			async fetch(request) {
				const messages = (await request.json()) as Array<{ id: string; attempts: number; body: unknown }>;
				batches.push({ queue: request.headers.get('x-skiff-queue'), messages });
				return Response.json({
					results: messages.map((message) =>
						message.body === 'poison' ? { id: message.id, outcome: 'retry' } : { id: message.id, outcome: 'ack' },
					),
				});
			},
		});
		cleanup.push(async () => void server.stop(true));

		const producer = await NatsConnection.connect(await connectTcp(host!, Number(port)), { user: USER, pass: PASS });
		cleanup.push(() => producer.close());
		await ensureQueueStream(producer, queue);
		const send = (body: string, extra: Record<string, string> = {}) =>
			publishToQueue(producer, queue, encode(body), {
				[QUEUE_HEADERS.id]: `${body}-${suffix}`,
				[QUEUE_HEADERS.contentType]: 'text',
				...extra,
			});
		await send('one');
		await send('two');
		await send('poison');
		await send('later', { [QUEUE_HEADERS.notBefore]: String(Date.now() + 1_500) });

		const activity: string[] = [];
		const consumers = new FunctionQueueConsumers({
			socketDir: dir,
			fetchActivation: async (id) => ({
				workloadId: id,
				activationVersion: 'b'.repeat(64),
				env: { NATS_PORT: port!, NATS_USER: USER, NATS_PASSWORD: PASS },
				files: {},
			}),
			noteActivity: (projectId) => activity.push(projectId),
		});
		const controller = new AbortController();
		cleanup.push(() => consumers.stopAll());
		consumers.reconcile(
			stateOf([
				functionWorkload([
					{ queue, broker: 'events', envPrefix: 'NATS', maxBatchSize: 10, maxBatchTimeout: 1, maxRetries: 1, retryDelay: 0, deadLetterQueue: dlq },
				]),
			]),
			controller.signal,
		);

		const delivered = () => batches.flatMap((batch) => batch.messages);
		await waitFor(() => delivered().some((message) => message.body === 'later'));
		await waitFor(async () => (await queueBacklog(producer, dlq)).backlogCount === 1);

		expect(batches.every((batch) => batch.queue === queue)).toBe(true);
		const bodies = delivered().map((message) => message.body);
		expect(bodies.filter((body) => body === 'one')).toHaveLength(1);
		expect(bodies.filter((body) => body === 'two')).toHaveLength(1);
		// Poison: the first try plus `maxRetries` retries, then the dead-letter queue.
		expect(delivered().filter((message) => message.body === 'poison').map((message) => message.attempts)).toEqual([1, 2]);
		// The delayed message was held back, not delivered early, and its hold-back is not an attempt.
		expect(delivered().find((message) => message.body === 'later')?.attempts).toBe(1);
		expect(activity).toContain('prj_q1');
		await waitFor(async () => (await queueBacklog(producer, queue)).backlogCount === 0);
		controller.abort();
	});
});
