import {
	FUNCTION_INTERNAL_HEADER,
	FUNCTION_INTERNAL_VALUE,
	agentNodeTaskLeaseSchema,
	nodeTaskLimits,
	type AgentNodeTask,
	type AgentNodeTaskLease,
	type AgentNodeTaskResult,
	type BrokerQueueCreateResult,
	type BrokerQueueRedriveResult,
	type BrokerQueueSendResult,
	type BrokerStreamDeleteMessageResult,
	type BrokerStreamDeleteResult,
	type BrokerStreamPeekResult,
	type BrokerStreamPurgeResult,
	type DesiredState,
	type FunctionInvokeResult,
	type FunctionScheduledResult,
	type NodeTaskStreamState,
	type PeekedMessage,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadStatus,
} from '@yoal/contracts';
import {
	NatsConnection,
	QUEUE_HEADERS,
	decodeHeaders,
	jsApi,
	publishToQueue,
	queueStreamConfig,
	queueStreamName,
} from '../../../packages/function-bindings/src/nats.js';
import { connectTcp } from './tcp-stream.ts';
import type { BrokerConnector } from './function-queues.ts';

/**
 * Node tasks (D124): the agent's half of the queue and function tools.
 *
 * The control plane cannot reach a broker or a function host (both listen on this node only), so
 * it queues typed tasks and this runner leases the ones for this node, runs them and posts the
 * results back. Each kind is one fixed verb:
 *
 * - `broker.*`: JetStream API calls over the broker's own client connection (the D123 sampler's
 *   pattern), with the user and password from the broker's activation.
 * - `function.invoke`: one HTTP request to the host socket, exactly as Caddy would send it, minus
 *   Yoal's internal header. Socket activation starts an idle-stopped host.
 * - `function.scheduled`: the cron route the function scheduler uses, for one cron, now.
 *
 * The lease long-polls, so a dashboard click runs within about a second. Nodes that run neither
 * brokers nor functions never poll.
 */

export interface NodeTaskRunnerOptions {
	controlUrl: string;
	nodeToken: string;
	socketDir: string;
	fetchActivation: (id: string, signal: AbortSignal) => Promise<WorkloadActivation>;
	/** The helper's view of a unit, to tell a cold start from a warm one. */
	workloadStatus?: (id: string) => Promise<WorkloadStatus | null>;
	/** Tells the idle-stop sweep a project is busy (FunctionScheduler.noteActivity). */
	noteActivity?: (projectId: string) => void;
	connect?: BrokerConnector;
	fetch?: typeof fetch;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	now?: () => number;
	/** Seconds the control plane holds an empty lease open. */
	leaseWaitSeconds?: number;
}

const IDLE_POLL_MS = 5_000;
const ERROR_BACKOFF_MAX_MS = 30_000;
const JS_TIMEOUT_MS = 5_000;
const INVOKE_TIMEOUT_MS = 30_000;
/** The shim aborts a `scheduled` invocation after a minute (docs/FUNCTIONS.md §4.7). */
const SCHEDULED_TIMEOUT_MS = 65_000;
/** JetStream: stream not found / no message found / stream name in use. */
const JS_STREAM_NOT_FOUND = 10059;
const JS_NO_MESSAGE_FOUND = 10037;
const JS_STREAM_NAME_IN_USE = 10058;

interface BrokerHandle {
	activationVersion: string;
	connection: NatsConnection;
}

type Handlers = {
	[K in AgentNodeTask['kind']]: (task: Extract<AgentNodeTask, { kind: K }>, target: WorkloadDesired, signal: AbortSignal) => Promise<unknown>;
};

const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true });

export class NodeTaskRunner {
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly socketDir: string;
	private readonly fetchActivation: NodeTaskRunnerOptions['fetchActivation'];
	private readonly workloadStatus: NonNullable<NodeTaskRunnerOptions['workloadStatus']>;
	private readonly noteActivity: NonNullable<NodeTaskRunnerOptions['noteActivity']>;
	private readonly connect: BrokerConnector;
	private readonly doFetch: typeof fetch;
	private readonly doSleep: (ms: number, signal: AbortSignal) => Promise<void>;
	private readonly log: NonNullable<NodeTaskRunnerOptions['log']>;
	private readonly now: () => number;
	private readonly leaseWaitSeconds: number;
	private readonly brokers = new Map<string, BrokerHandle>();
	private readonly handlers: Handlers;

	constructor(options: NodeTaskRunnerOptions) {
		this.controlUrl = options.controlUrl.replace(/\/$/, '');
		this.nodeToken = options.nodeToken;
		this.socketDir = options.socketDir;
		this.fetchActivation = options.fetchActivation;
		this.workloadStatus = options.workloadStatus ?? (async () => null);
		this.noteActivity = options.noteActivity ?? (() => undefined);
		this.connect =
			options.connect ??
			(async (target) =>
				NatsConnection.connect(await connectTcp(target.host, target.port), { user: target.user, pass: target.pass, name: target.name }));
		this.doFetch = options.fetch ?? fetch;
		this.doSleep = options.sleep ?? sleep;
		this.log = options.log ?? (() => undefined);
		this.now = options.now ?? Date.now;
		this.leaseWaitSeconds = options.leaseWaitSeconds ?? 20;
		this.handlers = {
			'broker.queue.create': (task, target, signal) => this.queueCreate(task, target, signal),
			'broker.queue.send': (task, target, signal) => this.queueSend(task, target, signal),
			'broker.queue.redrive': (task, target, signal) => this.queueRedrive(task, target, signal),
			'broker.stream.peek': (task, target, signal) => this.streamPeek(task, target, signal),
			'broker.stream.purge': (task, target, signal) => this.streamPurge(task, target, signal),
			'broker.stream.delete': (task, target, signal) => this.streamDelete(task, target, signal),
			'broker.stream.deleteMessage': (task, target, signal) => this.streamDeleteMessage(task, target, signal),
			'function.invoke': (task, target, signal) => this.functionInvoke(task, target, signal),
			'function.scheduled': (task, target, signal) => this.functionScheduled(task, target, signal),
		};
	}

	/** Lease, run and report until shutdown. Never throws. */
	async run(getState: () => DesiredState | null, signal: AbortSignal): Promise<void> {
		let failures = 0;
		while (!signal.aborted) {
			let wait = IDLE_POLL_MS;
			try {
				const targets = taskTargets(getState());
				this.dropGone(targets);
				if (targets.size > 0) {
					await this.tick(targets, signal);
					wait = 0; // The lease itself long-polls.
				}
				failures = 0;
			} catch (error) {
				if (signal.aborted) break;
				failures += 1;
				wait = Math.min(1000 * 2 ** failures, ERROR_BACKOFF_MAX_MS);
				this.log('warn', `Node tasks failed: ${errorText(error)}`);
			}
			if (wait > 0) await this.doSleep(wait, signal).catch(() => undefined);
		}
		for (const id of [...this.brokers.keys()]) this.drop(id);
	}

	/** One lease → run → report round. Returns how many tasks ran. */
	async tick(targets: Map<string, WorkloadDesired>, signal: AbortSignal): Promise<number> {
		const lease = await this.lease(signal);
		if (lease.tasks.length === 0) return 0;
		// Tasks are independent (different queues, different hosts), so they run side by side.
		const results = await Promise.all(lease.tasks.map((task) => this.runOne(task, targets, signal)));
		await this.report({ results }, signal);
		return results.length;
	}

	async runOne(task: AgentNodeTask, targets: Map<string, WorkloadDesired>, signal: AbortSignal): Promise<AgentNodeTaskResult['results'][number]> {
		const target = targets.get(task.targetId);
		if (!target) return { id: task.id, ok: false, error: 'The service is not running on this node any more.' };
		try {
			const handler = this.handlers[task.kind] as (task: AgentNodeTask, target: WorkloadDesired, signal: AbortSignal) => Promise<unknown>;
			return { id: task.id, ok: true, result: await handler(task, target, signal) };
		} catch (error) {
			if (task.kind.startsWith('broker.')) this.drop(target.id);
			return { id: task.id, ok: false, error: friendlyError(error).slice(0, 2000) };
		}
	}

	// ---------------------------------------------------------------- broker tasks

	private async queueCreate(task: Extract<AgentNodeTask, { kind: 'broker.queue.create' }>, broker: WorkloadDesired, signal: AbortSignal): Promise<BrokerQueueCreateResult> {
		const connection = await this.connectionFor(broker, signal);
		const stream = queueStreamName(task.input.queue);
		let created = false;
		try {
			await jsApi(connection, `STREAM.INFO.${stream}`, undefined, JS_TIMEOUT_MS);
		} catch (error) {
			if (jsCode(error) !== JS_STREAM_NOT_FOUND) throw error;
			try {
				await jsApi(connection, `STREAM.CREATE.${stream}`, queueStreamConfig(task.input.queue), JS_TIMEOUT_MS);
				created = true;
			} catch (createError) {
				if (jsCode(createError) !== JS_STREAM_NAME_IN_USE) throw createError;
			}
		}
		return { stream, created, state: await this.streamState(connection, stream) };
	}

	private async queueSend(task: Extract<AgentNodeTask, { kind: 'broker.queue.send' }>, broker: WorkloadDesired, signal: AbortSignal): Promise<BrokerQueueSendResult> {
		const connection = await this.connectionFor(broker, signal);
		const { queue, body, contentType, delaySeconds, count } = task.input;
		const bytes = encoder.encode(body);
		const started = performance.now();
		const seqs: number[] = [];
		for (let index = 0; index < count; index += 1) {
			if (signal.aborted) break;
			const now = this.now();
			const ack = await publishToQueue(
				connection,
				queue,
				bytes,
				{
					// The task id makes a retried lease idempotent inside the stream's dedupe window.
					[QUEUE_HEADERS.id]: count === 1 ? task.id : `${task.id}-${index}`,
					[QUEUE_HEADERS.contentType]: contentType,
					[QUEUE_HEADERS.timestamp]: String(now),
					...(delaySeconds ? { [QUEUE_HEADERS.notBefore]: String(now + delaySeconds * 1000) } : {}),
				},
				JS_TIMEOUT_MS,
			);
			seqs.push(Number(ack?.seq ?? 0));
		}
		const stream = queueStreamName(queue);
		return { stream, sent: seqs.length, seqs, durationMs: round(performance.now() - started), state: await this.streamState(connection, stream) };
	}

	/**
	 * Move messages out of a dead-letter queue back into a queue. Each message is republished with
	 * its body, id and content type (its attempt count starts again), then deleted from the
	 * dead-letter stream. A failure part way leaves the rest where they were.
	 */
	private async queueRedrive(task: Extract<AgentNodeTask, { kind: 'broker.queue.redrive' }>, broker: WorkloadDesired, signal: AbortSignal): Promise<BrokerQueueRedriveResult> {
		const connection = await this.connectionFor(broker, signal);
		const source = queueStreamName(task.input.from);
		const info = await jsApi(connection, `STREAM.INFO.${source}`, undefined, JS_TIMEOUT_MS).catch((error: unknown) => {
			if (jsCode(error) === JS_STREAM_NOT_FOUND) throw new Error(`Queue ${task.input.from} does not exist on this broker.`);
			throw error;
		});
		let cursor = Number(info?.state?.first_seq ?? 1) || 1;
		let moved = 0;
		while (moved < task.input.limit && !signal.aborted) {
			const message = await this.messageAt(connection, source, cursor);
			if (!message) break;
			const headers = decodeHeaders(message.headerBytes);
			const id = headers.get(QUEUE_HEADERS.id) ?? `${task.id}-${moved}`;
			const republish = (msgId: string) =>
				publishToQueue(
					connection,
					task.input.to,
					message.data,
					{
						[QUEUE_HEADERS.id]: msgId,
						[QUEUE_HEADERS.contentType]: headers.get(QUEUE_HEADERS.contentType) ?? 'json',
						[QUEUE_HEADERS.timestamp]: headers.get(QUEUE_HEADERS.timestamp) ?? String(this.now()),
					},
					JS_TIMEOUT_MS,
				);
			const ack = await republish(id);
			// Inside the dedupe window the original id is swallowed as a duplicate; give it a fresh one.
			if (ack?.duplicate) await republish(`${id}-r${message.seq}`);
			await jsApi(connection, `STREAM.MSG.DELETE.${source}`, { seq: message.seq, no_erase: true }, JS_TIMEOUT_MS);
			moved += 1;
			cursor = message.seq + 1;
		}
		const sourceState = await this.streamState(connection, source);
		return {
			moved,
			remaining: sourceState?.messages ?? 0,
			state: await this.streamState(connection, queueStreamName(task.input.to)),
			source: sourceState,
		};
	}

	/** Read messages without consuming them (`STREAM.MSG.GET` by sequence). */
	private async streamPeek(task: Extract<AgentNodeTask, { kind: 'broker.stream.peek' }>, broker: WorkloadDesired, signal: AbortSignal): Promise<BrokerStreamPeekResult> {
		const connection = await this.connectionFor(broker, signal);
		const { stream, limit } = task.input;
		const info = await this.requireStream(connection, stream);
		const state = info?.state ?? {};
		const firstSeq = Number(state.first_seq ?? 0) || 0;
		const lastSeq = Number(state.last_seq ?? 0) || 0;
		const total = Number(state.messages ?? 0) || 0;
		const messages: PeekedMessage[] = [];
		let cursor = Math.max(task.input.fromSeq ?? firstSeq, firstSeq, 1);
		let nextSeq: number | null = null;
		while (total > 0 && cursor <= lastSeq && !signal.aborted) {
			const message = await this.messageAt(connection, stream, cursor);
			if (!message) break;
			if (messages.length >= limit) {
				nextSeq = message.seq;
				break;
			}
			messages.push(peeked(message));
			cursor = message.seq + 1;
		}
		return { stream, messages, total, firstSeq, lastSeq, nextSeq };
	}

	private async streamPurge(task: Extract<AgentNodeTask, { kind: 'broker.stream.purge' }>, broker: WorkloadDesired, signal: AbortSignal): Promise<BrokerStreamPurgeResult> {
		const connection = await this.connectionFor(broker, signal);
		await this.requireStream(connection, task.input.stream);
		const reply = await jsApi(connection, `STREAM.PURGE.${task.input.stream}`, {}, JS_TIMEOUT_MS);
		return { stream: task.input.stream, purged: Number(reply?.purged ?? 0) || 0, state: await this.streamState(connection, task.input.stream) };
	}

	private async streamDelete(task: Extract<AgentNodeTask, { kind: 'broker.stream.delete' }>, broker: WorkloadDesired, signal: AbortSignal): Promise<BrokerStreamDeleteResult> {
		const connection = await this.connectionFor(broker, signal);
		try {
			const reply = await jsApi(connection, `STREAM.DELETE.${task.input.stream}`, undefined, JS_TIMEOUT_MS);
			return { stream: task.input.stream, deleted: reply?.success !== false };
		} catch (error) {
			if (jsCode(error) === JS_STREAM_NOT_FOUND) return { stream: task.input.stream, deleted: true };
			throw error;
		}
	}

	private async streamDeleteMessage(task: Extract<AgentNodeTask, { kind: 'broker.stream.deleteMessage' }>, broker: WorkloadDesired, signal: AbortSignal): Promise<BrokerStreamDeleteMessageResult> {
		const connection = await this.connectionFor(broker, signal);
		const { stream, seq } = task.input;
		await this.requireStream(connection, stream);
		let deleted = true;
		try {
			await jsApi(connection, `STREAM.MSG.DELETE.${stream}`, { seq, no_erase: true }, JS_TIMEOUT_MS);
		} catch (error) {
			// Already acknowledged by its consumer, or deleted by someone else.
			if (jsCode(error) !== JS_NO_MESSAGE_FOUND) throw error;
			deleted = false;
		}
		return { stream, seq, deleted, state: await this.streamState(connection, stream) };
	}

	private async requireStream(connection: NatsConnection, stream: string): Promise<{ state?: Record<string, unknown> }> {
		try {
			return await jsApi(connection, `STREAM.INFO.${stream}`, undefined, JS_TIMEOUT_MS);
		} catch (error) {
			if (jsCode(error) === JS_STREAM_NOT_FOUND) throw new Error(`Stream ${stream} does not exist on this broker.`);
			throw error;
		}
	}

	/** The first message at or after `seq` (null past the end). */
	private async messageAt(connection: NatsConnection, stream: string, seq: number): Promise<RawMessage | null> {
		let reply: { message?: { subject?: string; seq?: number; hdrs?: string; data?: string; time?: string } };
		try {
			reply = await jsApi(connection, `STREAM.MSG.GET.${stream}`, { seq, next_by_subj: '>' }, JS_TIMEOUT_MS);
		} catch (error) {
			if (jsCode(error) === JS_NO_MESSAGE_FOUND) return null;
			throw error;
		}
		const message = reply?.message;
		if (!message || typeof message.seq !== 'number') return null;
		return {
			seq: message.seq,
			subject: String(message.subject ?? ''),
			time: typeof message.time === 'string' ? message.time : null,
			headerBytes: message.hdrs ? base64Bytes(message.hdrs) : new Uint8Array(0),
			data: message.data ? base64Bytes(message.data) : new Uint8Array(0),
		};
	}

	private async streamState(connection: NatsConnection, stream: string): Promise<NodeTaskStreamState | null> {
		try {
			const info = await jsApi(connection, `STREAM.INFO.${stream}`, undefined, JS_TIMEOUT_MS);
			const state = info?.state ?? {};
			const messages = Number(state.messages ?? 0) || 0;
			const stamp = (value: unknown) => (messages > 0 && typeof value === 'string' && !value.startsWith('0001-') ? value : null);
			return { stream, messages, bytes: Number(state.bytes ?? 0) || 0, firstAt: stamp(state.first_ts), lastAt: stamp(state.last_ts) };
		} catch {
			// The change itself succeeded; the listing catches up on the next minute's sample.
			return null;
		}
	}

	private async connectionFor(broker: WorkloadDesired, signal: AbortSignal): Promise<NatsConnection> {
		const cached = this.brokers.get(broker.id);
		if (cached && cached.activationVersion === broker.activationVersion) return cached.connection;
		this.drop(broker.id);
		const activation = await this.fetchActivation(broker.id, signal);
		const user = activation.env.YOAL_BROKER_USER;
		const pass = activation.env.YOAL_BROKER_PASSWORD;
		if (!user || !pass) throw new Error(`Broker ${broker.id} has no credentials in its activation`);
		const connection = await this.connect({ host: '127.0.0.1', port: broker.port, user, pass, name: 'yoal-tasks' });
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

	private dropGone(targets: Map<string, WorkloadDesired>): void {
		for (const id of [...this.brokers.keys()]) if (!targets.has(id)) this.drop(id);
	}

	// ---------------------------------------------------------------- function tasks

	private async functionInvoke(task: Extract<AgentNodeTask, { kind: 'function.invoke' }>, workload: WorkloadDesired, signal: AbortSignal): Promise<FunctionInvokeResult> {
		const { method, path, body } = task.input;
		const headers = new Headers();
		for (const [name, value] of Object.entries(task.input.headers)) {
			if (name.toLowerCase() === FUNCTION_INTERNAL_HEADER) continue;
			headers.set(name, value);
		}
		if (!headers.has('user-agent')) headers.set('user-agent', 'yoal-test-request');
		const coldStart = await this.isCold(workload);
		this.noteActivity(workload.projectId);
		const started = performance.now();
		const response = await this.doFetch(`http://localhost${path}`, {
			method,
			headers,
			...(body !== undefined ? { body } : {}),
			unix: this.socketPath(workload),
			redirect: 'manual',
			signal: AbortSignal.any([signal, AbortSignal.timeout(INVOKE_TIMEOUT_MS)]),
		} as RequestInit);
		const { bytes, size, truncated } = await readCapped(response, nodeTaskLimits.responseBodyBytes);
		const durationMs = round(performance.now() - started);
		const text = decodeUtf8(bytes);
		return {
			status: response.status,
			statusText: response.statusText.slice(0, 200),
			headers: [...response.headers.entries()].slice(0, 200),
			encoding: text === null ? 'base64' : 'utf8',
			body: text ?? Buffer.from(bytes).toString('base64'),
			size,
			truncated,
			durationMs,
			coldStart,
		};
	}

	private async functionScheduled(task: Extract<AgentNodeTask, { kind: 'function.scheduled' }>, workload: WorkloadDesired, signal: AbortSignal): Promise<FunctionScheduledResult> {
		if (!workload.function?.triggers.crons.includes(task.input.cron))
			throw new Error(`The deployment on this node has no cron "${task.input.cron}"; it may have just been redeployed.`);
		const coldStart = await this.isCold(workload);
		this.noteActivity(workload.projectId);
		const started = performance.now();
		const response = await this.doFetch('http://localhost/__yoal/scheduled', {
			method: 'POST',
			unix: this.socketPath(workload),
			headers: {
				[FUNCTION_INTERNAL_HEADER]: FUNCTION_INTERNAL_VALUE,
				'x-yoal-cron': task.input.cron,
				'x-yoal-scheduled-time': String(this.now()),
			},
			signal: AbortSignal.any([signal, AbortSignal.timeout(SCHEDULED_TIMEOUT_MS)]),
		} as RequestInit);
		const durationMs = round(performance.now() - started);
		let error: string | null = null;
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			try {
				error = String((JSON.parse(text) as { error?: unknown }).error ?? text);
			} catch {
				error = text || `${response.status} ${response.statusText}`;
			}
		}
		return { status: response.status, error: error?.slice(0, 2000) ?? null, durationMs, coldStart };
	}

	/** The host socket is named after the desired-state id, as the scheduler and Caddy dial it. */
	private socketPath(workload: WorkloadDesired): string {
		return `${this.socketDir}/${workload.id}.sock`;
	}

	private async isCold(workload: WorkloadDesired): Promise<boolean> {
		try {
			const status = await this.workloadStatus(workload.id);
			return status !== null && status !== 'running';
		} catch {
			return false;
		}
	}

	// ---------------------------------------------------------------- protocol

	private async lease(signal: AbortSignal): Promise<AgentNodeTaskLease> {
		const response = await this.doFetch(`${this.controlUrl}/api/agent/tasks/lease?wait=${this.leaseWaitSeconds}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${this.nodeToken}`, 'content-type': 'application/json' },
			body: '{}',
			signal: AbortSignal.any([signal, AbortSignal.timeout((this.leaseWaitSeconds + 15) * 1000)]),
		});
		if (response.status === 404) {
			// A control plane that predates D124: nothing will ever be queued, so ask rarely.
			await this.doSleep(60_000, signal).catch(() => undefined);
			return { tasks: [], leaseSeconds: 60 };
		}
		if (!response.ok) throw new Error(`tasks/lease answered ${response.status}`);
		return agentNodeTaskLeaseSchema.parse(await response.json());
	}

	private async report(body: AgentNodeTaskResult, signal: AbortSignal): Promise<void> {
		const response = await this.doFetch(`${this.controlUrl}/api/agent/tasks/result`, {
			method: 'POST',
			headers: { authorization: `Bearer ${this.nodeToken}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		});
		if (!response.ok) throw new Error(`tasks/result answered ${response.status}`);
	}
}

interface RawMessage {
	seq: number;
	subject: string;
	time: string | null;
	headerBytes: Uint8Array;
	data: Uint8Array;
}

/** Brokers and function hosts on this node, by desired-state id. */
export function taskTargets(state: DesiredState | null): Map<string, WorkloadDesired> {
	const out = new Map<string, WorkloadDesired>();
	for (const workload of state?.workloads ?? []) {
		if (workload.status === 'stopped') continue;
		if (workload.broker || workload.function) out.set(workload.id, workload);
	}
	return out;
}

export function peeked(message: RawMessage): PeekedMessage {
	const headers: Record<string, string> = {};
	if (message.headerBytes.length > 0) for (const [key, value] of decodeHeaders(message.headerBytes).entries()) headers[key] = value;
	const truncated = message.data.length > nodeTaskLimits.peekBodyBytes;
	const bytes = truncated ? message.data.subarray(0, nodeTaskLimits.peekBodyBytes) : message.data;
	// A cut can split a UTF-8 sequence; decode leniently then, strictly otherwise.
	const text = truncated ? new TextDecoder().decode(bytes) : decodeUtf8(bytes);
	return {
		seq: message.seq,
		subject: message.subject,
		time: message.time,
		size: message.data.length,
		headers,
		encoding: text === null ? 'base64' : 'utf8',
		body: text ?? Buffer.from(bytes).toString('base64'),
		truncated,
	};
}

async function readCapped(response: Response, cap: number): Promise<{ bytes: Uint8Array; size: number; truncated: boolean }> {
	if (!response.body) return { bytes: new Uint8Array(0), size: 0, truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let kept = 0;
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (kept < cap) {
			const part = value.subarray(0, cap - kept);
			chunks.push(part);
			kept += part.length;
		}
		// Past twice the cap the rest is not worth reading; report what we saw.
		if (size > cap * 2) {
			await reader.cancel().catch(() => undefined);
			break;
		}
	}
	const bytes = new Uint8Array(kept);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return { bytes, size, truncated: size > kept };
}

function decodeUtf8(bytes: Uint8Array): string | null {
	try {
		return utf8.decode(bytes);
	} catch {
		return null;
	}
}

function base64Bytes(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, 'base64'));
}

function jsCode(error: unknown): number {
	return (error as { errCode?: number } | null)?.errCode ?? 0;
}

function round(ms: number): number {
	return Math.round(ms * 10) / 10;
}

function friendlyError(error: unknown): string {
	const text = errorText(error);
	if (/ENOENT|ECONNREFUSED|FailedToOpenSocket/i.test(text)) return `The host is not listening on this node (${text}). Is the deployment running?`;
	if (/timed? ?out|TimeoutError|aborted/i.test(text)) return `No answer in time: ${text}`;
	return text;
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
