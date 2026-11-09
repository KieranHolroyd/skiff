/**
 * Yoal Queue binding service (docs/FUNCTIONS.md §4.5, §4.10, D112).
 *
 * A Worker that implements workerd's Queue *producer* protocol and stores each message in a
 * JetStream stream on the project's managed broker (docs/BROKERS.md). Delivery to consumers is not
 * done here: the node agent pulls batches from the broker and hands them to the consumer
 * function's shim, so delivery also works while that function is idle-stopped.
 *
 * Protocol (workerd src/workerd/api/queue.{h,c++}, shape as in Miniflare's broker.worker.ts):
 *
 *   POST /message   raw body, `X-Msg-Fmt`, `X-Msg-Delay-Secs`                         -> 200 JSON
 *   POST /batch     `{ messages: [{ body: base64, contentType?, delaySecs? }] }`       -> 200 JSON
 *   GET  /metrics   no body                                                            -> 200 JSON
 *
 * Producer replies are `{ metadata: { metrics: { backlogCount, backlogBytes,
 * oldestMessageTimestamp } } }`; `/metrics` replies with the flat metrics object. Any non-200
 * status is the producer error workerd reports (`cf-queues-error-code` / `-cause`).
 *
 * Bindings (rendered by the agent, apps/agent/src/function-bindings/queue.ts):
 * - `BROKER`: a service binding to an `external` TCP service at the broker's loopback port.
 * - `BROKER_USER`, `BROKER_PASSWORD`: `fromEnvironment` values from the broker attachment.
 * - `QUEUE_NAME`: the queue (JetStream stream `YOAL_Q_<name>`, subject `yoal.q.<name>`).
 *
 * workerd ties sockets to the request that opened them, so each producer call opens its own
 * connection to the broker (loopback, one round trip) and closes it before replying.
 */
import {
	NatsConnection,
	QUEUE_HEADERS,
	QUEUE_MAX_MESSAGE_BYTES,
	publishToQueue,
	queueBacklog,
} from './nats.js';

/** `X-Msg-Fmt` values workerd can send; absent means the V8 serializer. */
const DEFAULT_CONTENT_TYPE = 'v8';
const CONTENT_TYPES = new Set(['text', 'json', 'bytes', 'v8']);
const MAX_BATCH_MESSAGES = 100;
/** Cloudflare's batch byte limit (Miniflare's `(256 + 32) * 1000`). */
const MAX_BATCH_BYTES = 288 * 1000;
const MAX_DELAY_SECONDS = 86_400;
/** workerd's default "unknown internal error" queue code, used for our own refusals. */
const QUEUE_ERROR_CODE = '15000';

/** An error that maps to a producer-error HTTP response. */
export class QueueHttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function jsonResponse(value) {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

function queueErrorResponse(error) {
	return new Response(error.message, {
		status: error.status,
		headers: {
			'Content-Type': 'text/plain;charset=UTF-8',
			'cf-queues-error-code': QUEUE_ERROR_CODE,
			'cf-queues-error-cause': error.message,
		},
	});
}

function bytesFromBase64(value) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function parseContentType(raw) {
	if (raw === null || raw === undefined || raw === '') return DEFAULT_CONTENT_TYPE;
	const value = String(raw).toLowerCase();
	if (!CONTENT_TYPES.has(value))
		throw new QueueHttpError(
			400,
			`message content type ${raw} is invalid; if specified, must be one of 'text', 'json', 'bytes', or 'v8'`,
		);
	return value;
}

function parseDelay(raw) {
	const delay = Number(raw);
	if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_SECONDS)
		throw new QueueHttpError(
			400,
			`message delay ${raw} is invalid: must be an integer between 0 and ${MAX_DELAY_SECONDS} seconds`,
		);
	return delay;
}

function validateMessageSize(size) {
	if (!Number.isFinite(size)) throw new QueueHttpError(400, 'message length is invalid');
	if (size > QUEUE_MAX_MESSAGE_BYTES)
		throw new QueueHttpError(413, `message length of ${size} bytes exceeds limit of ${QUEUE_MAX_MESSAGE_BYTES}`);
}

/** A 32-character hex id, the shape Cloudflare gives queue messages; also JetStream's dedupe key. */
export function messageId() {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let id = '';
	for (const byte of bytes) id += byte.toString(16).padStart(2, '0');
	return id;
}

/** Headers stored with a message; the agent reads them back when it delivers it. */
export function messageHeaders(message, now) {
	return {
		[QUEUE_HEADERS.id]: messageId(),
		[QUEUE_HEADERS.contentType]: message.contentType,
		[QUEUE_HEADERS.timestamp]: String(now),
		...(message.delaySeconds > 0 ? { [QUEUE_HEADERS.notBefore]: String(now + message.delaySeconds * 1000) } : {}),
	};
}

function readConfig(env) {
	const queue = env.QUEUE_NAME;
	if (typeof queue !== 'string' || queue === '')
		throw new QueueHttpError(500, 'Queue binding is misconfigured: QUEUE_NAME is missing.');
	if (!env.BROKER || typeof env.BROKER.connect !== 'function')
		throw new QueueHttpError(500, 'Queue binding is misconfigured: the BROKER service is missing.');
	if (typeof env.BROKER_USER !== 'string' || env.BROKER_USER === '' || typeof env.BROKER_PASSWORD !== 'string' || env.BROKER_PASSWORD === '')
		throw new QueueHttpError(
			500,
			'Queue binding is misconfigured: the broker credentials are missing. Attach the broker to this project and deploy again.',
		);
	return { queue, user: env.BROKER_USER, pass: env.BROKER_PASSWORD, address: env.BROKER_ADDRESS || 'broker:4222' };
}

/** Map a broker failure to a producer error the user's `send()` rejects with. */
function brokerError(error) {
	if (error instanceof QueueHttpError) return error;
	const message = error?.message ?? String(error);
	// JetStream refuses with "insufficient resources" / "maximum bytes exceeded" when the store is full.
	if (error?.code === 'jetstream' && /resources|maximum (bytes|messages)|store/i.test(message))
		return new QueueHttpError(429, `queue is full: ${message}`);
	if (error?.code === 'jetstream' && /message size/i.test(message)) return new QueueHttpError(413, message);
	return new QueueHttpError(503, `the queue broker is unavailable: ${message}`);
}

export class QueueProducer {
	/** `connect` is injectable for tests; production uses the BROKER service binding. */
	constructor(env, options = {}) {
		this.env = env;
		this.now = options.now ?? (() => Date.now());
		this.connect =
			options.connect ??
			((config) => NatsConnection.connect(env.BROKER.connect(config.address), { user: config.user, pass: config.pass, name: `yoal-queue:${config.queue}` }));
	}

	async fetch(request) {
		try {
			const url = new URL(request.url);
			if (request.method === 'POST' && url.pathname === '/message') return await this.send(request);
			if (request.method === 'POST' && url.pathname === '/batch') return await this.batch(request);
			if (request.method === 'GET' && url.pathname === '/metrics') return await this.metrics();
			return new Response('Not Found', { status: 404 });
		} catch (error) {
			return queueErrorResponse(brokerError(error));
		}
	}

	/** `queue.send(body, options)`: one raw message with optional format and delay headers. */
	async send(request) {
		const contentType = parseContentType(request.headers.get('X-Msg-Fmt'));
		const delaySeconds = parseDelay(request.headers.get('X-Msg-Delay-Secs') ?? 0);
		const declared = request.headers.get('content-length');
		if (declared !== null) validateMessageSize(Number.parseInt(declared, 10));
		const bytes = new Uint8Array(await request.arrayBuffer());
		validateMessageSize(bytes.byteLength);
		return this.store([{ bytes, contentType, delaySeconds }]);
	}

	/** `queue.sendBatch(messages, options)`: base64 bodies, per-message format and delay. */
	async batch(request) {
		let payload;
		try {
			payload = await request.json();
		} catch {
			throw new QueueHttpError(400, 'the batch body is not valid JSON');
		}
		const messages = payload?.messages;
		if (!Array.isArray(messages)) throw new QueueHttpError(400, 'the batch body must contain a "messages" array');
		if (messages.length > MAX_BATCH_MESSAGES)
			throw new QueueHttpError(413, `batch message count of ${messages.length} exceeds limit of ${MAX_BATCH_MESSAGES}`);
		const globalDelay = parseDelay(request.headers.get('X-Msg-Delay-Secs') ?? 0);
		let totalBytes = 0;
		const incoming = messages.map((message) => {
			if (message === null || typeof message !== 'object' || typeof message.body !== 'string')
				throw new QueueHttpError(400, 'each batch message needs a base64 string "body"');
			let bytes;
			try {
				bytes = bytesFromBase64(message.body);
			} catch {
				throw new QueueHttpError(400, 'a batch message body is not valid base64');
			}
			validateMessageSize(bytes.byteLength);
			totalBytes += bytes.byteLength;
			return {
				bytes,
				contentType: parseContentType(message.contentType),
				delaySeconds: message.delaySecs === undefined ? globalDelay : parseDelay(message.delaySecs),
			};
		});
		if (totalBytes > MAX_BATCH_BYTES)
			throw new QueueHttpError(413, `batch size of ${totalBytes} bytes exceeds limit of ${MAX_BATCH_BYTES}`);
		return this.store(incoming);
	}

	/** `queue.metrics()`: workerd parses the flat object, not the `{ metadata }` wrapper. */
	async metrics() {
		const config = readConfig(this.env);
		const connection = await this.connect(config);
		try {
			return jsonResponse(await queueBacklog(connection, config.queue));
		} finally {
			await connection.close();
		}
	}

	/** Publish every message and wait for JetStream to store each before replying. */
	async store(messages) {
		const config = readConfig(this.env);
		const connection = await this.connect(config);
		try {
			const now = this.now();
			for (const message of messages)
				await publishToQueue(connection, config.queue, message.bytes, messageHeaders(message, now));
			const metrics = await queueBacklog(connection, config.queue);
			return jsonResponse({ metadata: { metrics } });
		} finally {
			await connection.close();
		}
	}
}

export default {
	fetch(request, env) {
		return new QueueProducer(env).fetch(request);
	},
};
