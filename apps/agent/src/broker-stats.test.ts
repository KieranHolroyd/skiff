import { describe, expect, test } from 'bun:test';
import type { WorkloadActivation } from '@skiff/contracts';
import { BrokerStatsSampler, readStatz, type BrokerStatsTarget } from './broker-stats.ts';

/**
 * Broker metrics (docs/BROKERS.md §7, D123). The fake answers with the reply shapes a real
 * NATS 2.12 server returns for `$JS.API.INFO`, `STREAM.LIST`, `CONSUMER.LIST.<stream>` and
 * `$SYS.REQ.ACCOUNT.PING.STATZ` (captured from `nats:2.12-alpine`).
 */

const encoder = new TextEncoder();
const MINUTE = 60_000;
const T0 = Date.parse('2026-11-07T12:00:30.000Z');

interface FakeStream {
	name: string;
	retention?: 'workqueue' | 'limits' | 'interest';
	messages: number;
	bytes?: number;
	lastSeq: number;
	firstTs?: string;
	created?: string;
	consumers?: Array<{ name: string; pending: number; ackPending?: number; redelivered?: number; waiting?: number }>;
}

interface FakeAccount {
	conns: number;
	inMsgs: number;
	outMsgs: number;
	inBytes?: number;
	outBytes?: number;
	slow?: number;
}

function fakeBroker() {
	const state = {
		streams: [] as FakeStream[],
		account: { conns: 1, inMsgs: 0, outMsgs: 0 } as FakeAccount | null,
		store: 0,
		fail: false,
	};
	const subjects: string[] = [];
	const connects: Array<{ host: string; port: number; user: string; name: string }> = [];
	let closed = 0;
	const reply = (body: unknown) => ({ data: encoder.encode(JSON.stringify(body)), headers: null });
	const connect = async (target: { host: string; port: number; user: string; pass: string; name: string }) => {
		connects.push({ host: target.host, port: target.port, user: target.user, name: target.name });
		return {
			closed: false,
			request: async (subject: string) => {
				subjects.push(subject);
				if (state.fail) throw Object.assign(new Error('The broker connection is closed.'), { code: 'closed' });
				if (subject === '$JS.API.INFO')
					return reply({
						type: 'io.nats.jetstream.api.v1.account_info_response',
						memory: 0,
						storage: state.store,
						streams: state.streams.length,
						consumers: state.streams.reduce((n, s) => n + (s.consumers?.length ?? 0), 0),
					});
				if (subject === '$JS.API.STREAM.LIST')
					return reply({
						total: state.streams.length,
						offset: 0,
						limit: 256,
						streams: state.streams.map((s) => ({
							config: { name: s.name, subjects: [`skiff.q.${s.name}`], retention: s.retention ?? 'workqueue', max_bytes: -1, storage: 'file' },
							created: s.created ?? '2026-11-01T00:00:00Z',
							state: {
								messages: s.messages,
								bytes: s.bytes ?? s.messages * 50,
								first_seq: s.lastSeq - s.messages + 1,
								first_ts: s.firstTs ?? '0001-01-01T00:00:00Z',
								last_seq: s.lastSeq,
								last_ts: '2026-11-07T12:00:00Z',
								consumer_count: s.consumers?.length ?? 0,
							},
						})),
					});
				const consumerList = /^\$JS\.API\.CONSUMER\.LIST\.(.+)$/.exec(subject);
				if (consumerList) {
					const stream = state.streams.find((s) => s.name === consumerList[1]);
					return reply({
						total: stream?.consumers?.length ?? 0,
						consumers: (stream?.consumers ?? []).map((c) => ({
							stream_name: stream!.name,
							name: c.name,
							delivered: { consumer_seq: 3, stream_seq: 3, last_active: '2026-11-07T11:59:00Z' },
							num_ack_pending: c.ackPending ?? 0,
							num_redelivered: c.redelivered ?? 0,
							num_waiting: c.waiting ?? 1,
							num_pending: c.pending,
						})),
					});
				}
				if (subject === '$SYS.REQ.ACCOUNT.PING.STATZ') {
					const a = state.account;
					if (!a) throw Object.assign(new Error('No responders'), { code: 'no_responders' });
					return reply({
						server: { name: 'mq-test' },
						data: {
							account_statz: [
								{
									acc: '$G',
									conns: a.conns,
									sent: { msgs: a.outMsgs, bytes: a.outBytes ?? 0 },
									received: { msgs: a.inMsgs, bytes: a.inBytes ?? 0 },
									slow_consumers: a.slow ?? 0,
								},
							],
						},
					});
				}
				throw new Error(`unexpected subject ${subject}`);
			},
			close: async () => {
				closed += 1;
			},
		} as never;
	};
	return { state, subjects, connects, connect, closedCount: () => closed };
}

function target(overrides: Partial<BrokerStatsTarget> = {}): BrokerStatsTarget {
	return { id: 'mq_a', activationVersion: 'v1', port: 14222, status: 'running', memoryBytes: 40_000_000, storageMb: 1024, ...overrides };
}

function sampler(broker: ReturnType<typeof fakeBroker>, targets: () => BrokerStatsTarget[], clock = { now: T0 }) {
	const activations: string[] = [];
	const instance = new BrokerStatsSampler({
		source: { brokerTargets: targets },
		fetchActivation: async (id) => {
			activations.push(id);
			return { env: { SKIFF_BROKER_USER: 'jobs', SKIFF_BROKER_PASSWORD: 'secret-password-123' } } as unknown as WorkloadActivation;
		},
		connect: broker.connect,
		now: () => clock.now,
	});
	return { instance, activations, clock };
}

describe('BrokerStatsSampler', () => {
	test('samples JetStream totals and per-queue backlog over the broker credentials', async () => {
		const broker = fakeBroker();
		broker.state.store = 4_096;
		broker.state.streams = [
			{ name: 'SKIFF_Q_jobs', messages: 7, lastSeq: 40, firstTs: '2026-11-07T11:55:30Z', consumers: [{ name: 'skiff-consumer', pending: 5, ackPending: 2, redelivered: 1 }] },
			// A parked dead-letter queue with no consumer: held, but not lagging.
			{ name: 'SKIFF_Q_jobs-dlq', messages: 3, lastSeq: 3, firstTs: '2026-11-06T00:00:00Z' },
			// An app's own log stream keeps messages on purpose.
			{ name: 'audit', retention: 'limits', messages: 100, lastSeq: 100, firstTs: '2026-10-01T00:00:00Z', consumers: [{ name: 'reader', pending: 0 }] },
		];
		const { instance, activations } = sampler(broker, () => [target()]);

		expect(await instance.sample()).toBe(1);
		expect(broker.connects).toEqual([{ host: '127.0.0.1', port: 14222, user: 'jobs', name: 'skiff-stats' }]);
		expect(activations).toEqual(['mq_a']);

		const { brokers, brokerQueues } = instance.pending();
		expect(brokers).toHaveLength(1);
		expect(brokers[0]).toMatchObject({
			brokerId: 'mq_a',
			bucket: '2026-11-07T12:00:00.000Z',
			up: true,
			connections: 0, // the sampler's own connection is not counted
			streams: 3,
			consumers: 2,
			storeBytes: 4_096,
			storeLimitBytes: 1024 * 1024 * 1024,
			messages: 110,
			pending: 5,
			ackPending: 2,
			redelivered: 1,
			oldestAgeSeconds: 300, // only SKIFF_Q_jobs counts
			published: 0, // no previous reading yet
			messagesIn: 0,
			memoryBytes: 40_000_000,
		});

		expect(brokerQueues).toHaveLength(1);
		const streams = brokerQueues[0]!.streams;
		expect(streams.map((s) => [s.stream, s.queue])).toEqual([
			['audit', null],
			['SKIFF_Q_jobs', 'jobs'],
			['SKIFF_Q_jobs-dlq', 'jobs-dlq'],
		]);
		expect(streams[1]).toMatchObject({
			messages: 7,
			consumerCount: 1,
			pending: 5,
			ackPending: 2,
			redelivered: 1,
			firstAt: '2026-11-07T11:55:30.000Z',
			consumers: [{ name: 'skiff-consumer', pending: 5, ackPending: 2, redelivered: 1, waiting: 1, lastDeliveredAt: '2026-11-07T11:59:00.000Z' }],
		});
		// Streams without consumers are not asked for them.
		expect(broker.subjects.filter((s) => s.startsWith('$JS.API.CONSUMER.LIST'))).toEqual([
			'$JS.API.CONSUMER.LIST.audit',
			'$JS.API.CONSUMER.LIST.SKIFF_Q_jobs',
		]);
	});

	test('rates are deltas against the previous reading, without the sampler’s own traffic', async () => {
		const broker = fakeBroker();
		broker.state.streams = [{ name: 'SKIFF_Q_jobs', messages: 0, lastSeq: 10, consumers: [{ name: 'skiff-consumer', pending: 0 }] }];
		broker.state.account = { conns: 3, inMsgs: 1_000, outMsgs: 2_000, inBytes: 10_000, outBytes: 20_000, slow: 1 };
		const { instance, clock } = sampler(broker, () => [target()]);
		await instance.sample();

		// One minute later: 25 more messages stored, one stream created since, and the account
		// counters moved by the apps' traffic plus this round's 4 requests (INFO, LIST, CONSUMER.LIST, STATZ).
		clock.now = T0 + MINUTE;
		broker.state.streams = [
			{ name: 'SKIFF_Q_jobs', messages: 25, lastSeq: 35, firstTs: '2026-11-07T12:01:00Z', consumers: [{ name: 'skiff-consumer', pending: 25 }] },
			{ name: 'SKIFF_Q_new', messages: 4, lastSeq: 4, created: '2026-11-07T12:00:45Z' },
		];
		broker.state.account = { conns: 3, inMsgs: 1_000 + 30 + 4, outMsgs: 2_000 + 50 + 4, inBytes: 12_500, outBytes: 25_000, slow: 3 };
		await instance.sample();

		const second = instance.pending().brokers[1]!;
		expect(second).toMatchObject({
			bucket: '2026-11-07T12:01:00.000Z',
			connections: 2,
			published: 25 + 4,
			messagesIn: 30,
			messagesOut: 50,
			bytesIn: 2_500,
			bytesOut: 5_000,
			slowConsumers: 2,
		});
		expect(broker.connects).toHaveLength(1); // the connection is reused
	});

	test('a server restart resets its counters instead of producing negative rates', async () => {
		const broker = fakeBroker();
		broker.state.streams = [{ name: 'SKIFF_Q_jobs', messages: 0, lastSeq: 500 }];
		broker.state.account = { conns: 2, inMsgs: 9_000, outMsgs: 9_000 };
		const { instance, clock } = sampler(broker, () => [target()]);
		await instance.sample();

		clock.now = T0 + MINUTE;
		broker.state.streams = [{ name: 'SKIFF_Q_jobs', messages: 0, lastSeq: 12 }];
		broker.state.account = { conns: 2, inMsgs: 40, outMsgs: 10 };
		await instance.sample();

		expect(instance.pending().brokers[1]).toMatchObject({ published: 12, messagesIn: 37, messagesOut: 7 });
	});

	test('a broker that is not running reports down without connecting', async () => {
		const broker = fakeBroker();
		const { instance } = sampler(broker, () => [target({ status: 'starting' })]);
		await instance.sample();
		expect(broker.connects).toHaveLength(0);
		expect(instance.pending().brokers[0]).toMatchObject({ up: false, messages: 0, memoryBytes: 40_000_000 });
		expect(instance.pending().brokerQueues).toHaveLength(0);
	});

	test('a failed reading reports down, drops the connection and reconnects next time', async () => {
		const broker = fakeBroker();
		const { instance, clock } = sampler(broker, () => [target()]);
		await instance.sample();
		broker.state.fail = true;
		clock.now = T0 + MINUTE;
		await instance.sample();
		expect(instance.pending().brokers.map((b) => b.up)).toEqual([true, false]);
		expect(broker.closedCount()).toBe(1);

		broker.state.fail = false;
		clock.now = T0 + 2 * MINUTE;
		await instance.sample();
		expect(broker.connects).toHaveLength(2);
		expect(instance.pending().brokers[2]?.up).toBe(true);
	});

	test('a new activation (password rotation, restart) opens a new connection', async () => {
		const broker = fakeBroker();
		let current = target();
		const { instance, activations } = sampler(broker, () => [current]);
		await instance.sample();
		current = target({ activationVersion: 'v2' });
		await instance.sample();
		expect(activations).toEqual(['mq_a', 'mq_a']);
		expect(broker.connects).toHaveLength(2);
		expect(broker.closedCount()).toBe(1);
	});

	test('without STATZ the JetStream numbers still count', async () => {
		const broker = fakeBroker();
		broker.state.account = null;
		broker.state.streams = [{ name: 'SKIFF_Q_jobs', messages: 2, lastSeq: 2 }];
		const { instance } = sampler(broker, () => [target()]);
		await instance.sample();
		expect(instance.pending().brokers[0]).toMatchObject({ up: true, connections: 0, messages: 2, messagesIn: 0 });
	});

	test('the listing keeps the newest snapshot per broker and flags a cut', async () => {
		const broker = fakeBroker();
		broker.state.streams = Array.from({ length: 205 }, (_, i) => ({ name: `s${String(i).padStart(3, '0')}`, messages: 1, lastSeq: 1 }));
		const { instance, clock } = sampler(broker, () => [target()]);
		await instance.sample();
		clock.now = T0 + MINUTE;
		await instance.sample();
		const { brokerQueues } = instance.pending();
		expect(brokerQueues).toHaveLength(1);
		expect(brokerQueues[0]).toMatchObject({ truncated: true, at: new Date(T0 + MINUTE).toISOString() });
		expect(brokerQueues[0]!.streams).toHaveLength(200);
		// Totals still cover every stream.
		expect(instance.pending().brokers[1]?.messages).toBe(205);
	});

	test('brokers that leave the node are forgotten and their connections closed', async () => {
		const broker = fakeBroker();
		let targets = [target()];
		const { instance } = sampler(broker, () => targets);
		await instance.sample();
		targets = [];
		await instance.sample();
		expect(broker.closedCount()).toBe(1);
	});

	test('flush clears the buffer only after the post succeeds', async () => {
		const broker = fakeBroker();
		const { instance } = sampler(broker, () => [target()]);
		await instance.sample();
		await expect(instance.flush(async () => Promise.reject(new Error('503')))).rejects.toThrow('503');
		expect(instance.pending().brokers).toHaveLength(1);
		const posted: unknown[] = [];
		expect(await instance.flush(async (payload) => void posted.push(payload))).toBe(true);
		expect(posted).toHaveLength(1);
		expect(instance.pending()).toEqual({ brokers: [], brokerQueues: [] });
		expect(await instance.flush(async () => undefined)).toBe(false);
	});
});

describe('readStatz', () => {
	test('reads the global account from a real STATZ reply', () => {
		expect(
			readStatz({
				server: { name: 'mq-test', ver: '2.12.15' },
				data: {
					account_statz: [
						{
							acc: '$G',
							conns: 1,
							total_conns: 1,
							sent: { msgs: 15, bytes: 7003 },
							received: { msgs: 16, bytes: 1021 },
							slow_consumers: 0,
						},
					],
				},
			}),
		).toEqual({ connections: 1, messagesIn: 16, messagesOut: 15, bytesIn: 1021, bytesOut: 7003, slowConsumers: 0 });
	});

	test('anything else is null', () => {
		expect(readStatz({})).toBeNull();
		expect(readStatz({ data: { account_statz: [] } })).toBeNull();
		expect(readStatz('nope')).toBeNull();
	});
});
