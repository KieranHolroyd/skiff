import {
	FUNCTION_INTERNAL_HEADER,
	FUNCTION_INTERNAL_VALUE,
	type DesiredState,
	type FunctionRuntimeQueueConsumer,
	type FunctionRuntimeSpec,
	type WorkloadActivation,
	type WorkloadDesired,
} from '@skiff/contracts';
import {
	NatsConnection,
	QUEUE_HEADERS,
	ackMessage,
	ensureQueueConsumer,
	ensureQueueStream,
	nakMessage,
	publishToQueue,
	pullQueue,
	termMessage,
} from '../../../packages/function-bindings/src/nats.js';
import { connectTcp } from './tcp-stream.ts';

/**
 * Queue consumers for functions (docs/FUNCTIONS.md §4.10, D112).
 *
 * A function that declares `triggers.queues` consumes those queues from its managed broker. The
 * agent, not the function host, does the pulling: like cron, a batch is POSTed to the shim's
 * internal `/__skiff/queue` route over the host socket, which socket-activates an idle-stopped
 * host. One loop per (workload, queue) holds its own broker connection and:
 *
 * 1. pulls up to `maxBatchSize` messages, waiting at most `maxBatchTimeout` for the batch to fill;
 * 2. holds back delayed messages (`Skiff-Not-Before`) with a timed NAK;
 * 3. delivers the rest and applies the shim's per-message verdict: ack, or retry with a delay;
 * 4. after `maxRetries` retries, moves a message to `deadLetterQueue` (or drops it, with a warning).
 *
 * Delivery is at least once. The broker credentials come from the workload's activation (the
 * broker attachment's `<PREFIX>_*` values) and are kept in memory only, like database monitors.
 */

type FunctionWorkload = WorkloadDesired & { function: FunctionRuntimeSpec };

/** What a NATS connection needs; injectable so tests can use a fake broker. */
export type BrokerConnector = (target: { host: string; port: number; user: string; pass: string; name: string }) => Promise<NatsConnection>;

export interface FunctionQueueOptions {
	socketDir: string;
	fetchActivation: (id: string, signal: AbortSignal) => Promise<WorkloadActivation>;
	connect?: BrokerConnector;
	fetch?: typeof fetch;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** Tells the idle-stop sweep a project is busy (FunctionScheduler.noteActivity). */
	noteActivity?: (projectId: string) => void;
	reconcileIntervalMs?: number;
}

/** How long the shim may hold a batch; ack_wait sits above it so a slow batch is never redelivered mid-flight. */
const DELIVERY_TIMEOUT_MS = 5 * 60_000;
const ACK_WAIT_MS = DELIVERY_TIMEOUT_MS + 60_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RETRY_BACKOFF_MAX_SECONDS = 60;

interface QueueMessage {
	data: Uint8Array;
	headers: { get(name: string): string | undefined } | null;
	reply?: string;
	info: { delivered: number; streamSequence: number; timestampMs: number } | null;
}

/** One message as the shim hands it to `queue()`: the same shape the Durable Object broker used. */
export interface DeliveredMessage {
	id: string;
	timestamp: number;
	attempts: number;
	contentType: string;
	body: unknown;
}

/** The shim's verdict for one message. */
interface MessageOutcome {
	id: string;
	outcome: 'ack' | 'retry';
	delaySeconds?: number;
}

const decoder = new TextDecoder();

export function deliveredMessage(message: QueueMessage): DeliveredMessage {
	const headers = message.headers;
	const contentType = headers?.get(QUEUE_HEADERS.contentType) ?? 'bytes';
	const text = decoder.decode(message.data);
	let body: unknown;
	if (contentType === 'json') {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	} else if (contentType === 'text') {
		body = text;
	} else {
		// The internal route is JSON, so `bytes`/`v8` bodies travel base64-encoded.
		body = Buffer.from(message.data).toString('base64');
	}
	const delayed = headers?.get(QUEUE_HEADERS.notBefore) !== undefined;
	const delivered = message.info?.delivered ?? 1;
	const stamped = Number(headers?.get(QUEUE_HEADERS.timestamp));
	return {
		id: headers?.get(QUEUE_HEADERS.id) ?? String(message.info?.streamSequence ?? 0),
		timestamp: Number.isFinite(stamped) && stamped > 0 ? stamped : (message.info?.timestampMs ?? 0),
		// A delayed message spends one delivery being held back; it does not count as an attempt.
		attempts: Math.max(1, delivered - (delayed ? 1 : 0)),
		contentType,
		body,
	};
}

/** Seconds before the next try: the shim's choice, else the consumer's fixed delay, else backoff. */
export function retryDelaySeconds(attempts: number, consumer: Pick<FunctionRuntimeQueueConsumer, 'retryDelay'>, requested?: number): number {
	if (requested !== undefined && Number.isFinite(requested) && requested >= 0) return Math.min(43_200, Math.floor(requested));
	if (consumer.retryDelay !== undefined) return consumer.retryDelay;
	return Math.min(RETRY_BACKOFF_MAX_SECONDS, 2 ** Math.max(0, attempts - 1));
}

/** Read the shim's reply. 2xx without a body acks everything; anything else retries everything. */
export async function readOutcomes(response: Response, ids: string[]): Promise<{ outcomes: Map<string, MessageOutcome>; error: string | null }> {
	const outcomes = new Map<string, MessageOutcome>();
	const all = (outcome: 'ack' | 'retry') => {
		for (const id of ids) outcomes.set(id, { id, outcome });
	};
	type ShimReply = { results?: unknown; error?: unknown };
	let payload: ShimReply | null = null;
	const text = await response.text().catch(() => '');
	if (text) {
		try {
			payload = JSON.parse(text) as ShimReply;
		} catch {
			payload = null;
		}
	}
	if (!response.ok) {
		all('retry');
		const reason = typeof payload?.error === 'string' ? payload.error : text.slice(0, 200);
		return { outcomes, error: `${response.status}${reason ? ` ${reason}` : ''}` };
	}
	all('ack');
	if (Array.isArray(payload?.results)) {
		for (const value of payload.results as unknown[]) {
			if (typeof value !== 'object' || value === null) continue;
			const record = value as Record<string, unknown>;
			if (typeof record.id !== 'string' || !outcomes.has(record.id)) continue;
			if (record.outcome === 'retry')
				outcomes.set(record.id, {
					id: record.id,
					outcome: 'retry',
					...(typeof record.delaySeconds === 'number' ? { delaySeconds: record.delaySeconds } : {}),
				});
		}
	}
	return { outcomes, error: typeof payload?.error === 'string' ? payload.error : null };
}

interface LoopHandle {
	key: string;
	activationVersion: string;
	controller: AbortController;
	done: Promise<void>;
}

export class FunctionQueueConsumers {
	private readonly socketDir: string;
	private readonly fetchActivation: FunctionQueueOptions['fetchActivation'];
	private readonly connect: BrokerConnector;
	private readonly doFetch: typeof fetch;
	private readonly now: () => number;
	private readonly doSleep: (ms: number, signal: AbortSignal) => Promise<void>;
	private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
	private readonly noteActivity: (projectId: string) => void;
	private readonly reconcileIntervalMs: number;
	private readonly loops = new Map<string, LoopHandle>();

	constructor(options: FunctionQueueOptions) {
		this.socketDir = options.socketDir;
		this.fetchActivation = options.fetchActivation;
		this.connect =
			options.connect ??
			(async (target) =>
				NatsConnection.connect(await connectTcp(target.host, target.port), { user: target.user, pass: target.pass, name: target.name }));
		this.doFetch = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.doSleep = options.sleep ?? sleep;
		this.log = options.log ?? (() => undefined);
		this.noteActivity = options.noteActivity ?? (() => undefined);
		this.reconcileIntervalMs = options.reconcileIntervalMs ?? 5_000;
	}

	/** Keep the consumer loops in step with desired state until shutdown. Never throws. */
	async run(getState: () => DesiredState | null, signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				this.reconcile(getState(), signal);
			} catch (error) {
				this.log('warn', `Function queue reconcile failed: ${errorText(error)}`);
			}
			await this.doSleep(this.reconcileIntervalMs, signal);
		}
		await this.stopAll();
	}

	/** Running consumer keys, for tests and status. */
	running(): string[] {
		return [...this.loops.keys()].sort();
	}

	/** Start loops for new consumers, stop removed ones, restart ones whose activation changed. */
	reconcile(state: DesiredState | null, signal: AbortSignal): void {
		if (!state) return;
		const wanted = new Map<string, { workload: FunctionWorkload; consumer: FunctionRuntimeQueueConsumer }>();
		for (const workload of state.workloads) {
			if (workload.runtime !== 'function' || !workload.function) continue;
			// Replicas share one queue; replica 0 consumes, as it alone fires cron.
			if (workload.replica && workload.replica.index > 0) continue;
			if (workload.status === 'stopped' && workload.function.idleStopSeconds <= 0) continue;
			for (const consumer of workload.function.triggers.queues ?? [])
				wanted.set(`${workload.id}\n${consumer.broker}\n${consumer.queue}`, { workload: workload as FunctionWorkload, consumer });
		}
		for (const [key, handle] of this.loops) {
			const next = wanted.get(key);
			if (next && next.workload.activationVersion === handle.activationVersion) continue;
			handle.controller.abort();
			this.loops.delete(key);
		}
		for (const [key, { workload, consumer }] of wanted) {
			if (this.loops.has(key)) continue;
			const controller = new AbortController();
			const combined = AbortSignal.any([signal, controller.signal]);
			const done = this.consume(workload, consumer, combined).catch((error) => {
				this.log('error', `Queue ${consumer.queue} consumer for ${workload.id} stopped: ${errorText(error)}`);
			});
			this.loops.set(key, { key, activationVersion: workload.activationVersion, controller, done });
			this.log('info', `Consuming queue ${consumer.queue} on broker ${consumer.broker} for ${workload.id}`);
		}
	}

	async stopAll(): Promise<void> {
		const handles = [...this.loops.values()];
		this.loops.clear();
		for (const handle of handles) handle.controller.abort();
		await Promise.all(handles.map((handle) => handle.done));
	}

	/** One consumer: connect, then pull and deliver until aborted; reconnect with backoff on failure. */
	private async consume(workload: FunctionWorkload, consumer: FunctionRuntimeQueueConsumer, signal: AbortSignal): Promise<void> {
		let backoff = RECONNECT_MIN_MS;
		while (!signal.aborted) {
			let connection: NatsConnection | null = null;
			const onAbort = () => void connection?.close();
			signal.addEventListener('abort', onAbort, { once: true });
			try {
				const target = await this.target(workload, consumer, signal);
				connection = await this.connect(target);
				await ensureQueueConsumer(connection, consumer.queue, ACK_WAIT_MS);
				if (consumer.deadLetterQueue) await ensureQueueStream(connection, consumer.deadLetterQueue);
				backoff = RECONNECT_MIN_MS;
				while (!signal.aborted) {
					const messages = (await pullQueue(connection, consumer.queue, {
						batch: consumer.maxBatchSize,
						expiresMs: Math.max(1_000, consumer.maxBatchTimeout * 1_000),
					})) as QueueMessage[];
					if (messages.length > 0) await this.process(connection, workload, consumer, messages, signal);
				}
			} catch (error) {
				if (signal.aborted) break;
				this.log('warn', `Queue ${consumer.queue} for ${workload.id}: ${errorText(error)}; reconnecting in ${Math.round(backoff / 1000)}s`);
				await this.doSleep(backoff, signal);
				backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
			} finally {
				signal.removeEventListener('abort', onAbort);
				await connection?.close();
			}
		}
	}

	/** Broker address and credentials from the workload's activation (the attachment's `<PREFIX>_*`). */
	private async target(workload: FunctionWorkload, consumer: FunctionRuntimeQueueConsumer, signal: AbortSignal) {
		const activation = await this.fetchActivation(workload.id, signal);
		const env = activation.env;
		const prefix = consumer.envPrefix;
		const port = Number(env[`${prefix}_PORT`]);
		const user = env[`${prefix}_USER`];
		const pass = env[`${prefix}_PASSWORD`];
		if (!Number.isInteger(port) || port < 1 || port > 65_535 || !user || !pass)
			throw new Error(`the activation has no ${prefix}_PORT/_USER/_PASSWORD; attach broker "${consumer.broker}" to this project`);
		return { host: '127.0.0.1', port, user, pass, name: `skiff-agent:${workload.projectSlug}:${consumer.queue}` };
	}

	/** Hold back delayed messages, deliver the due ones, then apply the verdicts. */
	async process(
		connection: NatsConnection,
		workload: FunctionWorkload,
		consumer: FunctionRuntimeQueueConsumer,
		messages: QueueMessage[],
		signal: AbortSignal,
	): Promise<void> {
		const now = this.now();
		const due: Array<{ message: QueueMessage; delivered: DeliveredMessage }> = [];
		for (const message of messages) {
			const notBefore = Number(message.headers?.get(QUEUE_HEADERS.notBefore));
			if (Number.isFinite(notBefore) && notBefore > now) {
				await nakMessage(connection, message, notBefore - now);
				continue;
			}
			due.push({ message, delivered: deliveredMessage(message) });
		}
		if (due.length === 0) return;

		this.noteActivity(workload.projectId);
		const ids = due.map((item) => item.delivered.id);
		let outcomes: Map<string, MessageOutcome>;
		try {
			const response = await this.doFetch('http://localhost/__skiff/queue', {
				method: 'POST',
				unix: `${this.socketDir}/${workload.id}.sock`,
				headers: {
					[FUNCTION_INTERNAL_HEADER]: FUNCTION_INTERNAL_VALUE,
					'x-skiff-queue': consumer.queue,
					'content-type': 'application/json',
				},
				body: JSON.stringify(due.map((item) => item.delivered)),
				signal: AbortSignal.any([signal, AbortSignal.timeout(DELIVERY_TIMEOUT_MS)]),
			});
			const read = await readOutcomes(response, ids);
			outcomes = read.outcomes;
			if (read.error) this.log('warn', `Queue ${consumer.queue} batch for ${workload.id}: ${read.error}`);
		} catch (error) {
			if (signal.aborted) return; // Unacked messages are redelivered after ack_wait.
			this.log('warn', `Queue ${consumer.queue} delivery to ${workload.id} failed: ${errorText(error)}`);
			outcomes = new Map(ids.map((id) => [id, { id, outcome: 'retry' as const }]));
		}
		this.noteActivity(workload.projectId);

		for (const { message, delivered } of due) {
			const outcome = outcomes.get(delivered.id) ?? { id: delivered.id, outcome: 'retry' as const };
			if (outcome.outcome === 'ack') {
				await ackMessage(connection, message);
				continue;
			}
			if (delivered.attempts > consumer.maxRetries) {
				await this.deadLetter(connection, workload, consumer, message, delivered);
				continue;
			}
			await nakMessage(connection, message, retryDelaySeconds(delivered.attempts, consumer, outcome.delaySeconds) * 1_000);
		}
	}

	private async deadLetter(
		connection: NatsConnection,
		workload: FunctionWorkload,
		consumer: FunctionRuntimeQueueConsumer,
		message: QueueMessage,
		delivered: DeliveredMessage,
	): Promise<void> {
		if (!consumer.deadLetterQueue) {
			await termMessage(connection, message);
			this.log('warn', `Queue ${consumer.queue} for ${workload.id}: dropped message ${delivered.id} after ${delivered.attempts} attempts (no dead-letter queue)`);
			return;
		}
		await publishToQueue(connection, consumer.deadLetterQueue, message.data, {
			[QUEUE_HEADERS.id]: delivered.id,
			[QUEUE_HEADERS.contentType]: delivered.contentType,
			[QUEUE_HEADERS.timestamp]: String(delivered.timestamp),
			[QUEUE_HEADERS.attempts]: String(delivered.attempts),
		});
		await ackMessage(connection, message);
		this.log('warn', `Queue ${consumer.queue} for ${workload.id}: moved message ${delivered.id} to ${consumer.deadLetterQueue} after ${delivered.attempts} attempts`);
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener('abort', finish, { once: true });
	});
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
