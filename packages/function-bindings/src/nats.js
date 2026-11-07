/**
 * A minimal NATS client and the JetStream calls Skiff queues need (docs/FUNCTIONS.md §4.10, D112).
 *
 * One file serves both ends of a function queue:
 * - the queue binding service inside workerd publishes with it over a socket from
 *   `env.BROKER.connect()` (an `external` TCP service, the Hyperdrive pattern);
 * - the agent pulls batches with it over a Bun TCP socket and delivers them to the shim.
 *
 * Plain JavaScript ESM with Web APIs only (streams, TextEncoder, crypto): no imports, no Node APIs.
 * A socket is anything with `readable: ReadableStream<Uint8Array>` and
 * `writable: WritableStream<Uint8Array>`.
 *
 * Protocol reference: https://docs.nats.io/reference/reference-protocols/nats-protocol and the
 * JetStream API (`$JS.API.*`, JSON request/reply). Only what queues use is implemented: CONNECT
 * with user/password, PUB/HPUB, SUB/UNSUB, MSG/HMSG with headers, PING/PONG and request/reply.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CRLF = encoder.encode('\r\n');

/** Largest message the queue stream accepts (Cloudflare's 128 KiB body limit). */
export const QUEUE_MAX_MESSAGE_BYTES = 128 * 1024;
/** The durable pull consumer each queue stream has; one consumer per queue, as on Cloudflare. */
export const QUEUE_CONSUMER = 'skiff-consumer';
/** Message headers Skiff sets on publish. */
export const QUEUE_HEADERS = Object.freeze({
	id: 'Nats-Msg-Id',
	contentType: 'Skiff-Content-Type',
	notBefore: 'Skiff-Not-Before',
	timestamp: 'Skiff-Timestamp',
	attempts: 'Skiff-Attempts',
});

/** JetStream error codes Skiff branches on. */
const JS_STREAM_NOT_FOUND = 10059;
const JS_STREAM_NAME_IN_USE = 10058;
const JS_CONSUMER_NAME_EXISTS = 10148;
const DEFAULT_TIMEOUT_MS = 5_000;

export class NatsError extends Error {
	constructor(message, code = 'nats') {
		super(message);
		this.name = 'NatsError';
		this.code = code;
	}
}

// ---------------------------------------------------------------- names

/** Stream for one queue. Queue names are `[a-z0-9-]`, which streams and subjects both accept. */
export function queueStreamName(queue) {
	assertQueueName(queue);
	return `SKIFF_Q_${queue}`;
}

export function queueSubject(queue) {
	assertQueueName(queue);
	return `skiff.q.${queue}`;
}

function assertQueueName(queue) {
	if (typeof queue !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(queue))
		throw new NatsError(`Queue name ${JSON.stringify(queue)} is not valid (lowercase letters, digits and hyphens).`, 'invalid_queue');
}

/**
 * A work-queue stream: a message is removed once acknowledged, at most one consumer exists, the
 * file store survives restarts, and a full broker refuses new messages (`discard: new`) instead of
 * dropping old ones. The broker's own `max_file_store` is the byte cap.
 */
export function queueStreamConfig(queue) {
	return {
		name: queueStreamName(queue),
		subjects: [queueSubject(queue)],
		retention: 'workqueue',
		storage: 'file',
		discard: 'new',
		max_msg_size: QUEUE_MAX_MESSAGE_BYTES,
		max_msgs: -1,
		max_bytes: -1,
		max_age: 0,
		num_replicas: 1,
		// Two minutes of `Nats-Msg-Id` de-duplication covers a producer retrying a send.
		duplicate_window: 120_000_000_000,
	};
}

/** The single durable pull consumer. Retries and dead-lettering are Skiff's, so `max_deliver` is unlimited. */
export function queueConsumerConfig(queue, ackWaitMs) {
	return {
		durable_name: QUEUE_CONSUMER,
		name: QUEUE_CONSUMER,
		ack_policy: 'explicit',
		ack_wait: Math.max(1_000, Math.floor(ackWaitMs)) * 1_000_000,
		deliver_policy: 'all',
		filter_subject: queueSubject(queue),
		max_deliver: -1,
		max_ack_pending: 1_000,
	};
}

// ---------------------------------------------------------------- headers

/** `NATS/1.0[ code[ description]]` then `Key: Value` lines. */
export function encodeHeaders(headers) {
	let text = 'NATS/1.0\r\n';
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (value === undefined || value === null) continue;
		const name = String(key);
		const line = String(value);
		if (!/^[!-9;-~]+$/.test(name)) throw new NatsError(`Header name ${JSON.stringify(name)} is not valid.`, 'invalid_header');
		if (/[\r\n]/.test(line)) throw new NatsError(`Header ${name} contains a line break.`, 'invalid_header');
		text += `${name}: ${line}\r\n`;
	}
	return encoder.encode(`${text}\r\n`);
}

export function decodeHeaders(bytes) {
	const text = decoder.decode(bytes);
	const lines = text.split('\r\n');
	const first = lines.shift() ?? '';
	const match = /^NATS\/1\.0(?:\s+(\d{3}))?(?:\s+(.*))?$/.exec(first.trim());
	const values = new Map();
	for (const line of lines) {
		if (line === '') continue;
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		const lower = key.toLowerCase();
		if (!values.has(lower)) values.set(lower, value);
	}
	return {
		status: match?.[1] ? Number(match[1]) : 0,
		description: match?.[2] ?? '',
		get: (name) => values.get(String(name).toLowerCase()),
		entries: () => [...values.entries()],
	};
}

// ---------------------------------------------------------------- connection

function concat(a, b) {
	if (a.length === 0) return b;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

function indexOfCrlf(buffer, from = 0) {
	for (let index = from; index < buffer.length - 1; index += 1)
		if (buffer[index] === 13 && buffer[index + 1] === 10) return index;
	return -1;
}

function randomToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

function toBytes(data) {
	if (data === undefined || data === null) return new Uint8Array(0);
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return encoder.encode(typeof data === 'string' ? data : JSON.stringify(data));
}

/**
 * One NATS connection. Created with `NatsConnection.connect(socket, options)`, which waits for the
 * server's INFO, sends CONNECT and proves it with a PING/PONG round trip, so a wrong password fails
 * the connect rather than the first publish.
 */
export class NatsConnection {
	constructor(socket) {
		this.socket = socket;
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
		this.buffer = new Uint8Array(0);
		this.info = null;
		this.closed = false;
		this.closeError = null;
		this.nextSid = 1;
		this.subscriptions = new Map();
		this.pongs = [];
		this.inbox = `_INBOX.${randomToken()}`;
		this.requests = new Map();
		this.requestCounter = 0;
		this.infoWaiter = null;
		this.readLoop = this.read();
	}

	static async connect(socket, options = {}) {
		const connection = new NatsConnection(socket);
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		try {
			await connection.withTimeout(connection.waitForInfo(), timeoutMs, 'the broker did not greet');
			if (connection.info?.headers === false)
				throw new NatsError('The broker does not support message headers.', 'unsupported');
			const connect = {
				verbose: false,
				pedantic: false,
				tls_required: false,
				name: options.name ?? 'skiff',
				lang: 'skiff',
				version: '1',
				protocol: 1,
				headers: true,
				no_responders: true,
				...(options.user ? { user: options.user, pass: options.pass ?? '' } : {}),
			};
			await connection.write(encoder.encode(`CONNECT ${JSON.stringify(connect)}\r\n`));
			await connection.withTimeout(connection.ping(), timeoutMs, 'the broker did not answer PING');
			// One wildcard inbox carries every request's reply.
			connection.subscribe(`${connection.inbox}.*`, (message) => connection.resolveRequest(message));
			return connection;
		} catch (error) {
			await connection.close();
			throw connection.closeError ?? error;
		}
	}

	withTimeout(promise, ms, what) {
		let timer;
		return Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new NatsError(`Timed out: ${what} within ${ms} ms.`, 'timeout')), ms);
			}),
		]).finally(() => clearTimeout(timer));
	}

	waitForInfo() {
		if (this.info) return Promise.resolve(this.info);
		return new Promise((resolve, reject) => {
			this.infoWaiter = { resolve, reject };
		});
	}

	async write(bytes) {
		if (this.closed) throw this.closeError ?? new NatsError('The broker connection is closed.', 'closed');
		await this.writer.write(bytes);
	}

	ping() {
		return new Promise((resolve, reject) => {
			this.pongs.push({ resolve, reject });
			this.write(encoder.encode('PING\r\n')).catch(reject);
		});
	}

	/** Publish, optionally with headers and a reply subject. Resolves once written. */
	async publish(subject, data, options = {}) {
		const payload = toBytes(data);
		const reply = options.reply ? ` ${options.reply}` : '';
		if (options.headers && Object.keys(options.headers).length > 0) {
			const header = encodeHeaders(options.headers);
			const head = encoder.encode(`HPUB ${subject}${reply} ${header.length} ${header.length + payload.length}\r\n`);
			await this.write(concat(concat(concat(head, header), payload), CRLF));
			return;
		}
		const head = encoder.encode(`PUB ${subject}${reply} ${payload.length}\r\n`);
		await this.write(concat(concat(head, payload), CRLF));
	}

	subscribe(subject, handler) {
		const sid = String(this.nextSid++);
		this.subscriptions.set(sid, handler);
		this.write(encoder.encode(`SUB ${subject} ${sid}\r\n`)).catch(() => undefined);
		return sid;
	}

	unsubscribe(sid) {
		this.subscriptions.delete(sid);
		if (!this.closed) this.write(encoder.encode(`UNSUB ${sid}\r\n`)).catch(() => undefined);
	}

	/** Request/reply through the shared inbox. A 503 status means nothing is listening on `subject`. */
	request(subject, data, options = {}) {
		const token = String(++this.requestCounter);
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.requests.delete(token);
				reject(new NatsError(`Timed out waiting for a reply on ${subject}.`, 'timeout'));
			}, timeoutMs);
			this.requests.set(token, {
				resolve: (message) => {
					clearTimeout(timer);
					if (message.headers?.status === 503)
						reject(new NatsError(`No responders on ${subject}.`, 'no_responders'));
					else resolve(message);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.publish(subject, data, { headers: options.headers, reply: `${this.inbox}.${token}` }).catch((error) => {
				this.requests.delete(token);
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	resolveRequest(message) {
		const token = message.subject.slice(this.inbox.length + 1);
		const pending = this.requests.get(token);
		if (!pending) return;
		this.requests.delete(token);
		pending.resolve(message);
	}

	/** Flush pending writes and close. Idempotent; never throws. */
	async close() {
		if (this.closed) return;
		this.fail(new NatsError('The broker connection is closed.', 'closed'));
		try {
			await this.writer.close();
		} catch {
			// Already gone.
		}
		try {
			await this.reader.cancel();
		} catch {
			// Already gone.
		}
		try {
			this.socket.close?.();
		} catch {
			// Already gone.
		}
	}

	fail(error) {
		if (this.closed) return;
		this.closed = true;
		this.closeError = error;
		this.infoWaiter?.reject(error);
		for (const pong of this.pongs.splice(0)) pong.reject(error);
		for (const pending of this.requests.values()) pending.reject(error);
		this.requests.clear();
		for (const handler of this.subscriptions.values()) {
			try {
				handler(null, error);
			} catch {
				// A subscriber's own failure must not stop the others from hearing about it.
			}
		}
		this.subscriptions.clear();
	}

	async read() {
		try {
			for (;;) {
				const { value, done } = await this.reader.read();
				if (done) break;
				this.buffer = concat(this.buffer, value);
				this.drain();
			}
			this.fail(new NatsError('The broker closed the connection.', 'closed'));
		} catch (error) {
			this.fail(error instanceof NatsError ? error : new NatsError(`The broker connection failed: ${error?.message ?? error}`, 'io'));
		}
	}

	/** Parse every complete protocol frame in the buffer. */
	drain() {
		for (;;) {
			const end = indexOfCrlf(this.buffer);
			if (end < 0) return;
			const line = decoder.decode(this.buffer.subarray(0, end));
			const op = line.split(' ', 1)[0].toUpperCase();
			if (op === 'MSG' || op === 'HMSG') {
				const parts = line.split(' ').filter(Boolean);
				const headered = op === 'HMSG';
				// MSG subject sid [reply] size | HMSG subject sid [reply] hdrSize totalSize
				const fixed = headered ? 5 : 4;
				const reply = parts.length === fixed + 1 ? parts[3] : undefined;
				const total = Number(parts[parts.length - 1]);
				const headerSize = headered ? Number(parts[parts.length - 2]) : 0;
				if (!Number.isInteger(total) || total < 0 || !Number.isInteger(headerSize))
					throw new NatsError(`Malformed frame from the broker: ${line.slice(0, 120)}`, 'protocol');
				const start = end + 2;
				if (this.buffer.length < start + total + 2) return;
				const body = this.buffer.slice(start, start + total);
				this.buffer = this.buffer.slice(start + total + 2);
				this.dispatch({
					subject: parts[1],
					sid: parts[2],
					reply,
					headers: headered ? decodeHeaders(body.subarray(0, headerSize)) : null,
					data: body.subarray(headerSize),
				});
				continue;
			}
			this.buffer = this.buffer.slice(end + 2);
			if (op === 'INFO') {
				try {
					this.info = JSON.parse(line.slice(5));
				} catch {
					this.info = {};
				}
				this.infoWaiter?.resolve(this.info);
				this.infoWaiter = null;
			} else if (op === 'PING') {
				this.write(encoder.encode('PONG\r\n')).catch(() => undefined);
			} else if (op === 'PONG') {
				this.pongs.shift()?.resolve();
			} else if (op === '-ERR') {
				const reason = line.slice(4).trim().replace(/^'|'$/g, '');
				const error = new NatsError(`The broker refused the connection: ${reason}`, /authoriz/i.test(reason) ? 'auth' : 'server');
				this.fail(error);
				return;
			}
			// `+OK` (verbose mode is off) and unknown ops are ignored.
		}
	}

	dispatch(message) {
		const handler = this.subscriptions.get(message.sid);
		if (!handler) return;
		try {
			handler(message, null);
		} catch {
			// A subscriber's failure is its own; the read loop keeps going.
		}
	}
}

// ---------------------------------------------------------------- JetStream

/** One `$JS.API.*` call. A JSON `error` in the reply becomes a NatsError carrying `err_code`. */
export async function jsApi(connection, api, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
	let reply;
	try {
		reply = await connection.request(`$JS.API.${api}`, body === undefined ? '' : JSON.stringify(body), { timeoutMs });
	} catch (error) {
		if (error?.code === 'no_responders')
			throw new NatsError('JetStream is not enabled on this broker.', 'jetstream_unavailable');
		throw error;
	}
	let json;
	try {
		json = JSON.parse(decoder.decode(reply.data));
	} catch {
		throw new NatsError(`JetStream returned a reply that is not JSON for ${api}.`, 'protocol');
	}
	if (json?.error) {
		const error = new NatsError(json.error.description ?? `JetStream error on ${api}`, 'jetstream');
		error.errCode = json.error.err_code ?? 0;
		error.status = json.error.code ?? 0;
		throw error;
	}
	return json;
}

/** Create the queue's stream unless it exists. Safe to call from many producers at once. */
export async function ensureQueueStream(connection, queue) {
	try {
		return await jsApi(connection, `STREAM.INFO.${queueStreamName(queue)}`);
	} catch (error) {
		if (error?.errCode !== JS_STREAM_NOT_FOUND) throw error;
	}
	try {
		return await jsApi(connection, `STREAM.CREATE.${queueStreamName(queue)}`, queueStreamConfig(queue));
	} catch (error) {
		// Another producer created it between our INFO and CREATE.
		if (error?.errCode === JS_STREAM_NAME_IN_USE) return jsApi(connection, `STREAM.INFO.${queueStreamName(queue)}`);
		throw error;
	}
}

/** Create (or update to the current settings) the queue's single durable pull consumer. */
export async function ensureQueueConsumer(connection, queue, ackWaitMs) {
	await ensureQueueStream(connection, queue);
	const stream = queueStreamName(queue);
	try {
		return await jsApi(connection, `CONSUMER.CREATE.${stream}.${QUEUE_CONSUMER}`, {
			stream_name: stream,
			config: queueConsumerConfig(queue, ackWaitMs),
			action: '',
		});
	} catch (error) {
		if (error?.errCode === JS_CONSUMER_NAME_EXISTS) return jsApi(connection, `CONSUMER.INFO.${stream}.${QUEUE_CONSUMER}`);
		throw error;
	}
}

/**
 * Publish one message to a queue and wait for JetStream's acknowledgement (so `send()` resolves
 * only once the message is stored). The stream is created on first use.
 */
export async function publishToQueue(connection, queue, body, headers, timeoutMs = DEFAULT_TIMEOUT_MS) {
	const attempt = () => connection.request(queueSubject(queue), body, { headers, timeoutMs });
	let reply;
	try {
		reply = await attempt();
	} catch (error) {
		if (error?.code !== 'no_responders') throw error;
		await ensureQueueStream(connection, queue);
		reply = await attempt();
	}
	let ack;
	try {
		ack = JSON.parse(decoder.decode(reply.data));
	} catch {
		throw new NatsError('JetStream did not acknowledge the message.', 'protocol');
	}
	if (ack?.error) {
		const error = new NatsError(ack.error.description ?? 'JetStream refused the message.', 'jetstream');
		error.errCode = ack.error.err_code ?? 0;
		error.status = ack.error.code ?? 0;
		throw error;
	}
	return ack;
}

/** Backlog for `queue.metrics()`: count, bytes and the oldest message's publish time (ms, 0 = none). */
export async function queueBacklog(connection, queue) {
	let info;
	try {
		info = await jsApi(connection, `STREAM.INFO.${queueStreamName(queue)}`);
	} catch (error) {
		if (error?.errCode === JS_STREAM_NOT_FOUND) return { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 };
		throw error;
	}
	const state = info?.state ?? {};
	const messages = Number(state.messages ?? 0) || 0;
	const firstTs = messages > 0 && typeof state.first_ts === 'string' ? Date.parse(state.first_ts) : Number.NaN;
	return {
		backlogCount: messages,
		backlogBytes: Number(state.bytes ?? 0) || 0,
		oldestMessageTimestamp: Number.isFinite(firstTs) && firstTs > 0 ? firstTs : 0,
	};
}

/**
 * Delivery facts from a JetStream ack subject:
 * `$JS.ACK.<stream>.<consumer>.<delivered>.<sseq>.<dseq>.<ts>.<pending>` (v1) or the v2 form with a
 * domain and account hash in front and a random token at the end.
 */
export function ackInfo(reply) {
	const tokens = String(reply ?? '').split('.');
	if (tokens[0] !== '$JS' || tokens[1] !== 'ACK') return null;
	const offset = tokens.length === 9 ? 2 : tokens.length >= 11 ? 4 : -1;
	if (offset < 0) return null;
	const delivered = Number(tokens[offset + 2]);
	const streamSequence = Number(tokens[offset + 3]);
	const timestampNs = tokens[offset + 5];
	return {
		stream: tokens[offset],
		consumer: tokens[offset + 1],
		delivered: Number.isFinite(delivered) ? delivered : 1,
		streamSequence: Number.isFinite(streamSequence) ? streamSequence : 0,
		// Nanoseconds overflow a double's integer range; milliseconds do not.
		timestampMs: /^\d+$/.test(timestampNs ?? '') ? Number(timestampNs.slice(0, -6) || '0') : 0,
	};
}

/**
 * One pull: up to `batch` messages, waiting at most `expiresMs` for the batch to fill. Messages
 * arrive as the server has them; a `404`/`408`/`409` status (nothing left, request expired, or a
 * consumer change) ends the pull early. Each returned message carries its ack subject.
 */
export function pullQueue(connection, queue, options) {
	const batch = Math.max(1, Math.min(100, Math.floor(options.batch ?? 10)));
	const expiresMs = Math.max(100, Math.floor(options.expiresMs ?? 5_000));
	const stream = queueStreamName(queue);
	const inbox = `${connection.inbox}.pull.${randomToken()}`;
	return new Promise((resolve, reject) => {
		const messages = [];
		let settled = false;
		let sid = null;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (sid !== null) connection.unsubscribe(sid);
			if (error && messages.length === 0) reject(error);
			else resolve(messages);
		};
		// The server ends the request at `expires`; this guard only covers a lost status frame.
		const timer = setTimeout(() => finish(), expiresMs + 2_000);
		sid = connection.subscribe(inbox, (message, error) => {
			if (error) return finish(error);
			const status = message.headers?.status ?? 0;
			if (status === 100) return; // Idle heartbeat.
			if (status !== 0) return finish(status === 404 || status === 408 || status === 409 ? undefined : new NatsError(`Pull failed: ${status} ${message.headers.description}`, 'jetstream'));
			messages.push({
				data: message.data,
				headers: message.headers,
				reply: message.reply,
				info: ackInfo(message.reply),
			});
			if (messages.length >= batch) finish();
		});
		connection
			.publish(`$JS.API.CONSUMER.MSG.NEXT.${stream}.${QUEUE_CONSUMER}`, JSON.stringify({ batch, expires: expiresMs * 1_000_000 }), { reply: inbox })
			.catch((error) => finish(error));
	});
}

/** Acknowledge (the message is removed), negatively acknowledge with a delay, or terminate. */
export function ackMessage(connection, message) {
	return connection.publish(message.reply, '+ACK');
}

export function nakMessage(connection, message, delayMs = 0) {
	const delay = Math.max(0, Math.floor(delayMs));
	return connection.publish(message.reply, delay > 0 ? `-NAK ${JSON.stringify({ delay: delay * 1_000_000 })}` : '-NAK');
}

export function termMessage(connection, message) {
	return connection.publish(message.reply, '+TERM');
}
