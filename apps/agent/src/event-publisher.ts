import {
	agentEventLeaseSchema,
	type AgentEventAck,
	type AgentEventLease,
	type DesiredState,
	type WorkloadActivation,
	type WorkloadDesired,
} from '@skiff/contracts';
import { NatsConnection, QUEUE_HEADERS, publishToQueue } from '../../../packages/function-bindings/src/nats.js';
import { connectTcp } from './tcp-stream.ts';
import type { BrokerConnector } from './function-queues.ts';

/**
 * Event notifications (docs/EVENTS.md, D122): publish the control plane's outbox into queues.
 *
 * Every rule targets a managed broker, and only the broker's own node can reach it (it listens on
 * loopback). So the agent on a node that runs brokers leases pending deliveries for them, publishes
 * each one to `skiff.q.<queue>` and acks the result. The function that consumes the queue then gets
 * the event through its ordinary queue trigger, with the queue's retries and dead-letter queue.
 *
 * - JetStream dedupes on `Nats-Msg-Id` (the delivery id), so a lease that expires mid-publish and
 *   is retried never doubles a message inside the stream's duplicate window.
 * - Connections are kept per broker and dropped on any error or a credential change.
 * - Nodes without brokers never poll.
 */

export interface EventPublisherOptions {
	controlUrl: string;
	nodeToken: string;
	fetchActivation: (id: string, signal: AbortSignal) => Promise<WorkloadActivation>;
	connect?: BrokerConnector;
	fetch?: typeof fetch;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	now?: () => number;
}

/** Poll again at once while there is a backlog; otherwise this often. */
const IDLE_POLL_MS = 2_000;
const ERROR_BACKOFF_MAX_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 10_000;

interface BrokerHandle {
	activationVersion: string;
	connection: NatsConnection;
}

const encoder = new TextEncoder();

export class EventPublisher {
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly fetchActivation: EventPublisherOptions['fetchActivation'];
	private readonly connect: BrokerConnector;
	private readonly doFetch: typeof fetch;
	private readonly doSleep: (ms: number, signal: AbortSignal) => Promise<void>;
	private readonly log: NonNullable<EventPublisherOptions['log']>;
	private readonly now: () => number;
	private readonly brokers = new Map<string, BrokerHandle>();

	constructor(options: EventPublisherOptions) {
		this.controlUrl = options.controlUrl.replace(/\/$/, '');
		this.nodeToken = options.nodeToken;
		this.fetchActivation = options.fetchActivation;
		this.connect =
			options.connect ??
			(async (target) =>
				NatsConnection.connect(await connectTcp(target.host, target.port), { user: target.user, pass: target.pass, name: target.name }));
		this.doFetch = options.fetch ?? fetch;
		this.doSleep = options.sleep ?? sleep;
		this.log = options.log ?? (() => undefined);
		this.now = options.now ?? Date.now;
	}

	/** Lease, publish and ack until shutdown. Never throws. */
	async run(getState: () => DesiredState | null, signal: AbortSignal): Promise<void> {
		let failures = 0;
		while (!signal.aborted) {
			let backlog = false;
			try {
				const brokers = localBrokers(getState());
				this.dropGone(brokers);
				if (brokers.size > 0) backlog = (await this.tick(brokers, signal)) > 0;
				failures = 0;
			} catch (error) {
				if (signal.aborted) break;
				failures += 1;
				this.log('warn', `Event publishing failed: ${errorText(error)}`);
			}
			const wait = failures > 0 ? Math.min(1000 * 2 ** failures, ERROR_BACKOFF_MAX_MS) : backlog ? 0 : IDLE_POLL_MS;
			if (wait > 0) await this.doSleep(wait, signal).catch(() => undefined);
		}
		for (const id of [...this.brokers.keys()]) this.drop(id);
	}

	/** One lease → publish → ack round. Returns how many deliveries were handled. */
	async tick(brokers: Map<string, WorkloadDesired>, signal: AbortSignal): Promise<number> {
		const lease = await this.lease(signal);
		if (lease.items.length === 0) return 0;
		const results: AgentEventAck['results'] = [];
		for (const item of lease.items) {
			if (signal.aborted) break;
			const broker = brokers.get(item.brokerId);
			if (!broker) {
				// Desired state moved the broker away since the lease; the next owner will publish it.
				results.push({ id: item.id, ok: false, error: 'The broker is not on this node any more.' });
				continue;
			}
			try {
				const connection = await this.connectionFor(broker, signal);
				await publishToQueue(
					connection,
					item.queue,
					encoder.encode(JSON.stringify(item.body)),
					{
						[QUEUE_HEADERS.id]: item.id,
						[QUEUE_HEADERS.contentType]: 'json',
						[QUEUE_HEADERS.timestamp]: String(this.now()),
					},
					PUBLISH_TIMEOUT_MS,
				);
				results.push({ id: item.id, ok: true });
			} catch (error) {
				this.drop(item.brokerId);
				results.push({ id: item.id, ok: false, error: errorText(error).slice(0, 500) });
			}
		}
		await this.ack({ results }, signal);
		const failed = results.filter((result) => !result.ok).length;
		if (failed > 0) this.log('warn', `Published ${results.length - failed}/${results.length} events; ${failed} will be retried`);
		return results.length;
	}

	private async connectionFor(broker: WorkloadDesired, signal: AbortSignal): Promise<NatsConnection> {
		const cached = this.brokers.get(broker.id);
		if (cached && cached.activationVersion === broker.activationVersion) return cached.connection;
		this.drop(broker.id);
		const activation = await this.fetchActivation(broker.id, signal);
		const user = activation.env.SKIFF_BROKER_USER;
		const pass = activation.env.SKIFF_BROKER_PASSWORD;
		if (!user || !pass) throw new Error(`Broker ${broker.id} has no credentials in its activation`);
		const connection = await this.connect({ host: '127.0.0.1', port: broker.port, user, pass, name: 'skiff-events' });
		this.brokers.set(broker.id, { activationVersion: broker.activationVersion, connection });
		return connection;
	}

	private drop(brokerId: string): void {
		const handle = this.brokers.get(brokerId);
		if (!handle) return;
		this.brokers.delete(brokerId);
		void Promise.resolve()
			.then(() => handle.connection.close())
			.catch(() => undefined);
	}

	private dropGone(brokers: Map<string, WorkloadDesired>): void {
		for (const id of [...this.brokers.keys()]) if (!brokers.has(id)) this.drop(id);
	}

	private async lease(signal: AbortSignal): Promise<AgentEventLease> {
		const response = await this.doFetch(`${this.controlUrl}/api/agent/events/lease`, {
			method: 'POST',
			headers: { authorization: `Bearer ${this.nodeToken}`, 'content-type': 'application/json' },
			body: '{}',
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		});
		if (response.status === 404) return { items: [], leaseSeconds: 60 }; // control plane predates D122
		if (!response.ok) throw new Error(`events/lease answered ${response.status}`);
		return agentEventLeaseSchema.parse(await response.json());
	}

	private async ack(body: AgentEventAck, signal: AbortSignal): Promise<void> {
		const response = await this.doFetch(`${this.controlUrl}/api/agent/events/ack`, {
			method: 'POST',
			headers: { authorization: `Bearer ${this.nodeToken}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		});
		// An unacked publish is leased again after the lease expires; JetStream drops the duplicate.
		if (!response.ok) throw new Error(`events/ack answered ${response.status}`);
	}
}

/** Running brokers on this node, by id. */
export function localBrokers(state: DesiredState | null): Map<string, WorkloadDesired> {
	const out = new Map<string, WorkloadDesired>();
	for (const workload of state?.workloads ?? []) if (workload.broker && workload.status !== 'stopped') out.set(workload.id, workload);
	return out;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
