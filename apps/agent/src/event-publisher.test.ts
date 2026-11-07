import { describe, expect, test } from 'bun:test';
import type { AgentEventAck, DesiredState, WorkloadDesired } from '@skiff/contracts';
import { EventPublisher, localBrokers } from './event-publisher.ts';

/** Event notifications (docs/EVENTS.md, D122): the broker node publishes the outbox. */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function broker(id: string, overrides: Partial<WorkloadDesired> = {}): WorkloadDesired {
	return {
		id,
		projectId: id,
		projectSlug: 'events',
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
		...overrides,
	} as WorkloadDesired;
}

interface Published {
	subject: string;
	body: unknown;
	headers: Record<string, string>;
}

/** A broker that stores every publish, or refuses with `fail`. */
function fakeBroker(options: { fail?: boolean } = {}) {
	const published: Published[] = [];
	const connects: Array<{ host: string; port: number; user: string }> = [];
	let closed = 0;
	const connect = async (target: { host: string; port: number; user: string; pass: string; name: string }) => {
		connects.push({ host: target.host, port: target.port, user: target.user });
		return {
			request: async (subject: string, body: Uint8Array, opts: { headers: Record<string, string> }) => {
				if (options.fail) throw Object.assign(new Error('nats: connection refused'), { code: 'closed' });
				published.push({ subject, body: JSON.parse(decoder.decode(body)), headers: opts.headers });
				return { data: encoder.encode(JSON.stringify({ stream: 'SKIFF_Q_images', seq: published.length })) };
			},
			close: async () => {
				closed += 1;
			},
		} as never;
	};
	return { published, connects, connect, closedCount: () => closed };
}

/** A control plane that leases `items` once and records acks. */
function fakeControl(items: Array<{ id: string; brokerId: string; queue: string; body: unknown }>) {
	const acks: AgentEventAck[] = [];
	const auth: string[] = [];
	let leased = false;
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		auth.push(String((init?.headers as Record<string, string>).authorization));
		if (String(url).endsWith('/api/agent/events/lease')) {
			const batch = leased ? [] : items;
			leased = true;
			return Response.json({ items: batch, leaseSeconds: 60 });
		}
		acks.push(JSON.parse(String(init?.body)));
		return Response.json({ ok: true });
	}) as typeof fetch;
	return { acks, auth, fetchImpl };
}

const activation = async (id: string) => ({
	workloadId: id,
	activationVersion: 'v1',
	env: { SKIFF_BROKER_USER: 'events', SKIFF_BROKER_PASSWORD: 'secret' },
	files: {},
});

describe('event publisher', () => {
	test('only running brokers on this node are publish targets', () => {
		const state = {
			workloads: [broker('mq_a'), broker('mq_b', { status: 'stopped' }), { ...broker('wld_x'), broker: undefined }],
		} as unknown as DesiredState;
		expect([...localBrokers(state).keys()]).toEqual(['mq_a']);
		expect(localBrokers(null).size).toBe(0);
	});

	test('publishes each leased event to its queue with dedupe headers, then acks', async () => {
		const nats = fakeBroker();
		const control = fakeControl([
			{ id: 'evd_1', brokerId: 'mq_a', queue: 'images', body: { action: 'PutObject', object: { key: 'a.jpg' } } },
			{ id: 'evd_2', brokerId: 'mq_a', queue: 'pages', body: { type: 'alerts.firing' } },
		]);
		const publisher = new EventPublisher({
			controlUrl: 'https://control.test/',
			nodeToken: 'node-token',
			fetchActivation: activation,
			connect: nats.connect,
			fetch: control.fetchImpl,
			now: () => 1234,
		});
		const handled = await publisher.tick(new Map([['mq_a', broker('mq_a')]]), new AbortController().signal);
		expect(handled).toBe(2);
		expect(nats.connects).toEqual([{ host: '127.0.0.1', port: 14222, user: 'events' }]);
		expect(nats.published.map((item) => item.subject)).toEqual(['skiff.q.images', 'skiff.q.pages']);
		expect(nats.published[0]!.body).toEqual({ action: 'PutObject', object: { key: 'a.jpg' } });
		expect(nats.published[0]!.headers).toEqual({ 'Nats-Msg-Id': 'evd_1', 'Skiff-Content-Type': 'json', 'Skiff-Timestamp': '1234' });
		expect(control.acks).toEqual([{ results: [{ id: 'evd_1', ok: true }, { id: 'evd_2', ok: true }] }]);
		expect(control.auth.every((value) => value === 'Bearer node-token')).toBe(true);
		// The connection is reused for the next round.
		await publisher.tick(new Map([['mq_a', broker('mq_a')]]), new AbortController().signal);
		expect(nats.connects).toHaveLength(1);
	});

	test('a broker failure or a broker that moved away acks as a retry, never a loss', async () => {
		const nats = fakeBroker({ fail: true });
		const control = fakeControl([
			{ id: 'evd_1', brokerId: 'mq_a', queue: 'images', body: {} },
			{ id: 'evd_2', brokerId: 'mq_gone', queue: 'images', body: {} },
		]);
		const publisher = new EventPublisher({
			controlUrl: 'https://control.test',
			nodeToken: 'node-token',
			fetchActivation: activation,
			connect: nats.connect,
			fetch: control.fetchImpl,
		});
		await publisher.tick(new Map([['mq_a', broker('mq_a')]]), new AbortController().signal);
		expect(control.acks[0]!.results).toEqual([
			{ id: 'evd_1', ok: false, error: 'nats: connection refused' },
			{ id: 'evd_2', ok: false, error: 'The broker is not on this node any more.' },
		]);
		// The failed connection is dropped, so the next round reconnects.
		expect(nats.closedCount()).toBe(1);
	});

	test('nothing leased means nothing acked', async () => {
		const control = fakeControl([]);
		const publisher = new EventPublisher({
			controlUrl: 'https://control.test',
			nodeToken: 'node-token',
			fetchActivation: activation,
			connect: fakeBroker().connect,
			fetch: control.fetchImpl,
		});
		expect(await publisher.tick(new Map([['mq_a', broker('mq_a')]]), new AbortController().signal)).toBe(0);
		expect(control.acks).toHaveLength(0);
	});
});
