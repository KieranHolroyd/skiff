/**
 * Skiff Queue binding service (docs/FUNCTIONS.md §4.5, §4.10, FN10).
 *
 * A Worker that implements the workerd Queue *producer* protocol on top of one Durable Object, and
 * delivers batches to the function shim's internal `/__skiff/queue` route with at-least-once
 * semantics. The user Worker gets a `queue` binding pointing at this service; workerd then talks to
 * it over HTTP exactly as it would to Cloudflare's Queues producer API.
 *
 * Protocol shape adapted from Miniflare (Apache-2.0), cloudflare/workers-sdk:
 * packages/miniflare/src/workers/queues/{broker,constants,schemas}.worker.ts, against workerd's
 * src/workerd/api/queue.{h,c++}:
 *
 *   POST /message   raw body, `X-Msg-Fmt`, `X-Msg-Delay-Secs`                         -> 200 JSON
 *   POST /batch     `{ messages: [{ body: base64, contentType?, delaySecs? }] }`       -> 200 JSON
 *   GET  /metrics   no body                                                            -> 200 JSON
 *
 * Producer replies are `{ metadata: { metrics: { backlogCount, backlogBytes,
 * oldestMessageTimestamp } } }`; `/metrics` replies with the flat metrics object. Any non-200
 * status is the producer error workerd reports (it reads `cf-queues-error-code` /
 * `cf-queues-error-cause` when the expose-error-codes flag is on).
 *
 * Delivery is our own: a batch leaves this Durable Object for the main Worker's shim, which calls
 * the user's `queue(batch, env, ctx)`. A 2xx response acks the batch; anything else (or a thrown
 * fetch) retries it with exponential backoff and eventually dead-letters it.
 *
 * Storage model (plain key/value Durable Object storage, no SQL):
 * - `msg:<availableAtMillis>:<id>`: one queued message, ordered by due time then message id. The
 *   random id keeps two concurrent producers from ever sharing a key; re-keying on retry keeps
 *   `list()` ordered, so the alarm only has to read the front.
 * - `dead:<id>`: messages that exhausted `MAX_ATTEMPTS`, kept for inspection.
 * - `meta`: `{ count, bytes }`, the running counters used for the caps and `/metrics`. They are
 *   advisory: a crash between a storage change and the counter write can drift them, so a send
 *   that is about to be refused recounts storage first.
 *
 * Plain JavaScript ESM: workerd loads this file as text and embeds it as a module. No imports, no
 * Node APIs, no eval, only Web APIs and Durable Object storage.
 */

/** Messages are keyed by due time so `storage.list()` returns them oldest-due-first. */
const MESSAGE_PREFIX = 'msg:';
const DEAD_LETTER_PREFIX = 'dead:';
const META_KEY = 'meta';

/** `X-Msg-Fmt` values workerd can send; absent means the V8 serializer (Miniflare's default). */
const DEFAULT_CONTENT_TYPE = 'v8';
const CONTENT_TYPES = new Set(['text', 'json', 'bytes', 'v8']);

/** Cloudflare's Queue limits, with the brief's 128 KiB body cap. */
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_BATCH_MESSAGES = 100;
/** Cloudflare's batch byte limit (Miniflare's `(256 + 32) * 1000`). */
const MAX_BATCH_BYTES = 288 * 1000;
const MAX_DELAY_SECONDS = 86_400;
/** Per queue: refuse sends once this many messages are undelivered. */
const MAX_QUEUED_MESSAGES = 10_000;
/** Per queue: keep this many dead letters, dropping the oldest when full. */
const MAX_DEAD_LETTERS = 1_000;

/** Cloudflare's default consumer batch size is 10; ours matches. */
const DEFAULT_BATCH_SIZE = 10;
/** Deliveries per message before it is dead-lettered (the first try plus four retries). */
const MAX_ATTEMPTS = 5;
/** Exponential backoff: 1s, 2s, 4s, 8s, then capped at 60s. Dead-lettering happens first. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/**
 * How long a taken batch stays reserved before another alarm may redeliver it. This is the
 * at-least-once window after a crash between "take" and "ack": no message is ever lost, it is only
 * redelivered.
 */
const INFLIGHT_LEASE_MS = 5 * 60_000;
/** Only the first `SCAN_LIMIT` messages are examined per alarm; batches are 10, so this is ample. */
const SCAN_LIMIT = 1_000;

/** The shim's internal queue route. Fixed contract with `function-shim.ts`. */
const CONSUMER_URL = 'http://main/__skiff/queue';
/** workerd's default "unknown internal error" queue code, used for our own refusals. */
const QUEUE_ERROR_CODE = '15000';

const textDecoder = new TextDecoder();

/** An error that maps to a producer-error HTTP response, mirroring Miniflare's `HttpError`. */
class QueueHttpError extends Error {
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

/**
 * A producer error. workerd treats any non-200 as `send()` rejection; the two `cf-queues-error-*`
 * headers become the message when the queue-expose-error-codes compatibility flag is on.
 */
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

// ---------------------------------------------------------------- encoding helpers

/** Base64 without spreading megabytes into `String.fromCharCode` arguments. */
function base64FromBytes(bytes) {
	let binary = '';
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}

function bytesFromBase64(value) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

// ---------------------------------------------------------------- validation

function parseContentType(raw) {
	if (raw === null || raw === undefined || raw === '') return DEFAULT_CONTENT_TYPE;
	const value = String(raw).toLowerCase();
	if (!CONTENT_TYPES.has(value)) {
		throw new QueueHttpError(
			400,
			`message content type ${raw} is invalid; if specified, must be one of 'text', 'json', 'bytes', or 'v8'`,
		);
	}
	return value;
}

function parseDelay(raw) {
	const delay = Number(raw);
	if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_SECONDS) {
		throw new QueueHttpError(
			400,
			`message delay ${raw} is invalid: must be an integer between 0 and ${MAX_DELAY_SECONDS} seconds`,
		);
	}
	return delay;
}

function validateMessageSize(size) {
	if (!Number.isFinite(size)) throw new QueueHttpError(400, 'message length is invalid');
	if (size > MAX_MESSAGE_BYTES) {
		throw new QueueHttpError(
			413,
			`message length of ${size} bytes exceeds limit of ${MAX_MESSAGE_BYTES}`,
		);
	}
}

// ---------------------------------------------------------------- storage helpers

function messageKey(availableAt, id) {
	return `${MESSAGE_PREFIX}${String(Math.max(0, Math.floor(availableAt))).padStart(13, '0')}:${id}`;
}

function deadLetterKey(id) {
	return `${DEAD_LETTER_PREFIX}${id}`;
}

/** A record is due when its delivery time (or its reservation lease) has passed. */
function dueAt(record) {
	if (record.inflight === true) return (record.inflightAt ?? 0) + INFLIGHT_LEASE_MS;
	return record.availableAt ?? 0;
}

function retryDelay(attempts) {
	return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
}

async function readMeta(storage) {
	const meta = await storage.get(META_KEY);
	return {
		count: Number(meta?.count ?? 0) || 0,
		bytes: Number(meta?.bytes ?? 0) || 0,
	};
}

async function writeMeta(storage, meta) {
	await storage.put(META_KEY, meta);
}

async function adjustMeta(storage, countDelta, bytesDelta) {
	const meta = await readMeta(storage);
	await writeMeta(storage, {
		count: Math.max(0, meta.count + countDelta),
		bytes: Math.max(0, meta.bytes + bytesDelta),
	});
}

/**
 * The single Durable Object behind one function host's queue.
 *
 * `this.now`, `this.batchSize`, `this.maxQueuedMessages` and `this.maxDeadLetters` are instance
 * fields only so tests can shrink the clock and the caps without 10,000-message fixtures;
 * production always uses the module constants.
 */
export class QueueBroker {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.now = () => Date.now();
		this.batchSize = DEFAULT_BATCH_SIZE;
		this.maxQueuedMessages = MAX_QUEUED_MESSAGES;
		this.maxDeadLetters = MAX_DEAD_LETTERS;
	}

	async fetch(request) {
		try {
			const url = new URL(request.url);
			if (request.method === 'POST' && url.pathname === '/message') return await this.send(request);
			if (request.method === 'POST' && url.pathname === '/batch') return await this.batch(request);
			if (request.method === 'GET' && url.pathname === '/metrics') return await this.metrics();
			return new Response('Not Found', { status: 404 });
		} catch (error) {
			if (error instanceof QueueHttpError) return queueErrorResponse(error);
			throw error;
		}
	}

	/** `queue.send(body, options)`: one raw message with optional format and delay headers. */
	async send(request) {
		const storage = this.state.storage;
		const contentType = parseContentType(request.headers.get('X-Msg-Fmt'));
		const delaySeconds = parseDelay(request.headers.get('X-Msg-Delay-Secs') ?? 0);
		const declared = request.headers.get('content-length');
		if (declared !== null) validateMessageSize(Number.parseInt(declared, 10));

		const bytes = new Uint8Array(await request.arrayBuffer());
		validateMessageSize(bytes.byteLength);

		// Miniflare reports the backlog as it was when the producer call arrived.
		const metrics = await this.metricsObject(storage);
		await this.enqueue(storage, [
			{
				body: base64FromBytes(bytes),
				contentType,
				delaySeconds,
				bytes: bytes.byteLength,
			},
		]);
		return jsonResponse({ metadata: { metrics } });
	}

	/** `queue.sendBatch(messages, options)`: base64 bodies, per-message format and delay. */
	async batch(request) {
		const storage = this.state.storage;
		let payload;
		try {
			payload = await request.json();
		} catch {
			throw new QueueHttpError(400, 'the batch body is not valid JSON');
		}

		const messages = payload?.messages;
		if (!Array.isArray(messages)) {
			throw new QueueHttpError(400, 'the batch body must contain a "messages" array');
		}
		if (messages.length > MAX_BATCH_MESSAGES) {
			throw new QueueHttpError(
				413,
				`batch message count of ${messages.length} exceeds limit of ${MAX_BATCH_MESSAGES}`,
			);
		}

		const globalDelay = parseDelay(request.headers.get('X-Msg-Delay-Secs') ?? 0);
		let totalBytes = 0;
		const incoming = messages.map((message) => {
			if (message === null || typeof message !== 'object' || typeof message.body !== 'string') {
				throw new QueueHttpError(400, 'each batch message needs a base64 string "body"');
			}
			let bytes;
			try {
				bytes = bytesFromBase64(message.body);
			} catch {
				throw new QueueHttpError(400, 'a batch message body is not valid base64');
			}
			validateMessageSize(bytes.byteLength);
			totalBytes += bytes.byteLength;
			return {
				body: message.body,
				contentType: parseContentType(message.contentType),
				delaySeconds:
					message.delaySecs === undefined ? globalDelay : parseDelay(message.delaySecs),
				bytes: bytes.byteLength,
			};
		});
		if (totalBytes > MAX_BATCH_BYTES) {
			throw new QueueHttpError(
				413,
				`batch size of ${totalBytes} bytes exceeds limit of ${MAX_BATCH_BYTES}`,
			);
		}

		const metrics = await this.metricsObject(storage);
		await this.enqueue(storage, incoming);
		return jsonResponse({ metadata: { metrics } });
	}

	/** `queue.metrics()`: workerd parses the flat object, not the `{ metadata }` wrapper. */
	async metrics() {
		return jsonResponse(await this.metricsObject(this.state.storage));
	}

	async metricsObject(storage) {
		const meta = await readMeta(storage);
		const first = await storage.list({ prefix: MESSAGE_PREFIX, limit: 1 });
		const oldest = first.values().next().value;
		return {
			backlogCount: meta.count,
			backlogBytes: meta.bytes,
			// 0 is workerd's "no data" sentinel and becomes `undefined` in JS.
			oldestMessageTimestamp: oldest ? oldest.timestamp : 0,
		};
	}

	/** Store one producer call's messages under due-time keys and arm the alarm for the earliest. */
	async enqueue(storage, incoming) {
		if (incoming.length === 0) return;
		let meta = await readMeta(storage);
		if (meta.count + incoming.length > this.maxQueuedMessages) {
			// A crash between an ack/DLQ and the counter write can over-count and block the queue
			// forever, so recount the real storage once, only when a send is about to be refused.
			const actual = await storage.list({
				prefix: MESSAGE_PREFIX,
				limit: this.maxQueuedMessages + 1,
			});
			if (actual.size + incoming.length > this.maxQueuedMessages) {
				throw new QueueHttpError(
					429,
					`queue is full: ${actual.size} messages are already queued (limit ${this.maxQueuedMessages})`,
				);
			}
			let actualBytes = 0;
			for (const record of actual.values()) actualBytes += record.bytes ?? 0;
			meta = { count: actual.size, bytes: actualBytes };
		}

		const now = this.now();
		let earliest = null;
		let addedBytes = 0;
		for (const message of incoming) {
			addedBytes += message.bytes;
			const availableAt = now + message.delaySeconds * 1000;
			if (earliest === null || availableAt < earliest) earliest = availableAt;
		}

		// Counters first, messages second: a crash can leave an over-count (harmless, and healed
		// above), but never leaves a message outside the counter's knowledge.
		await writeMeta(storage, {
			count: meta.count + incoming.length,
			bytes: meta.bytes + addedBytes,
		});

		for (const message of incoming) {
			const record = {
				id: messageId(),
				timestamp: now,
				body: message.body,
				contentType: message.contentType,
				attempts: 0,
				delaySeconds: message.delaySeconds,
				availableAt: now + message.delaySeconds * 1000,
				bytes: message.bytes,
			};
			// The key carries a random id, so two concurrent producers can never overwrite each
			// other even if they read the same counters.
			await storage.put(messageKey(record.availableAt, record.id), record);
		}

		await this.arm(storage, earliest);
	}

	/** Bring the alarm forward to `dueAt` when it would otherwise fire later (or not at all). */
	async arm(storage, dueAtMillis) {
		if (dueAtMillis === null) return;
		const existing = await storage.getAlarm();
		if (existing === null || existing === undefined || dueAtMillis < existing) {
			await storage.setAlarm(dueAtMillis);
		}
	}

	/**
	 * Dispatch one batch. The alarm is the only caller: messages are reserved (`inflight`) before
	 * the delivery fetch, so a crash can delay them but never lose them.
	 */
	async alarm() {
		const storage = this.state.storage;
		const now = this.now();
		const snapshot = await storage.list({ prefix: MESSAGE_PREFIX, limit: SCAN_LIMIT });
		const taken = [];
		let nextAt = null;
		let lastAvailableAt = null;

		for (const [key, record] of snapshot) {
			lastAvailableAt = record.availableAt ?? 0;
			const when = dueAt(record);
			if (when <= now && taken.length < this.batchSize) {
				taken.push({ key, record });
			} else if (nextAt === null || when < nextAt) {
				nextAt = when;
			}
		}
		// A truncated scan cannot see the rest; the tail is due no earlier than the last key read.
		if (snapshot.size >= SCAN_LIMIT && lastAvailableAt !== null) {
			nextAt = nextAt === null ? lastAvailableAt : Math.min(nextAt, lastAvailableAt);
		}

		if (taken.length === 0) {
			await this.reschedule(nextAt);
			return;
		}

		// Take: a lease-length alarm first, then the reservation. If this invocation dies before the
		// reservation is written, the alarm still redelivers; if it dies mid-delivery, the lease
		// expiry redelivers. Either way no message is lost, only delivered again.
		await storage.setAlarm(now + INFLIGHT_LEASE_MS);
		for (const { key, record } of taken) {
			await storage.put(key, { ...record, inflight: true, inflightAt: now });
		}

		const delivered = await this.deliver(taken.map(({ record }) => record));
		if (delivered) {
			await storage.delete(taken.map(({ key }) => key));
			await adjustMeta(
				storage,
				-taken.length,
				-taken.reduce((total, { record }) => total + (record.bytes ?? 0), 0),
			);
		} else {
			await this.retryOrDeadLetter(taken, now);
		}
		await this.reschedule(null);
	}

	/** POST the JSON batch the shim turns into `queue(batch, env, ctx)`; 2xx acks. */
	async deliver(records) {
		try {
			const messages = records.map(consumerMessage);
			const response = await this.env.CONSUMER.fetch(CONSUMER_URL, {
				method: 'POST',
				headers: {
					'x-skiff-internal': '1',
					'x-skiff-queue': this.env.QUEUE_NAME ?? '',
					'content-type': 'application/json',
				},
				body: JSON.stringify(messages),
			});
			// Drain so the subrequest is fully settled even on a failure status.
			try {
				await response.arrayBuffer();
			} catch {
				// A body that cannot be read does not change the verdict.
			}
			return response.ok;
		} catch {
			return false;
		}
	}

	/** Increment attempts, re-key for the backoff, or move to the dead-letter prefix. */
	async retryOrDeadLetter(taken, now) {
		const storage = this.state.storage;
		let removed = 0;
		let removedBytes = 0;

		for (const { key, record } of taken) {
			const attempts = (record.attempts ?? 0) + 1;
			if (attempts >= MAX_ATTEMPTS) {
				await this.pushDeadLetter({ ...record, attempts }, now);
				await storage.delete(key);
				removed += 1;
				removedBytes += record.bytes ?? 0;
				continue;
			}
			const availableAt = now + retryDelay(attempts);
			const next = { ...record, attempts, availableAt, inflight: false, inflightAt: 0 };
			// Put the new key before deleting the old one: a crash here leaves a duplicate, which
			// at-least-once permits, rather than a lost message.
			await storage.put(messageKey(availableAt, record.id), next);
			await storage.delete(key);
		}

		if (removed > 0) await adjustMeta(storage, -removed, -removedBytes);
	}

	async pushDeadLetter(record, now) {
		const storage = this.state.storage;
		const dead = await storage.list({
			prefix: DEAD_LETTER_PREFIX,
			limit: this.maxDeadLetters + 1,
		});
		if (dead.size >= this.maxDeadLetters) {
			const oldest = dead.keys().next().value;
			if (oldest !== undefined) await storage.delete(oldest);
		}
		await storage.put(deadLetterKey(record.id), {
			id: record.id,
			timestamp: record.timestamp,
			body: record.body,
			contentType: record.contentType,
			attempts: record.attempts,
			failedAt: now,
			queue: this.env.QUEUE_NAME ?? '',
		});
	}

	/**
	 * Set the next alarm from what is actually stored (a re-key or ack may have changed the front),
	 * or clear it when the queue is empty. A past due time fires immediately.
	 */
	async reschedule(nextAt) {
		const storage = this.state.storage;
		if (nextAt === null || nextAt === undefined) {
			const entries = await storage.list({ prefix: MESSAGE_PREFIX, limit: SCAN_LIMIT });
			let lastAvailableAt = null;
			for (const record of entries.values()) {
				const when = dueAt(record);
				if (nextAt === null || nextAt === undefined || when < nextAt) nextAt = when;
				lastAvailableAt = record.availableAt ?? 0;
			}
			if (entries.size >= SCAN_LIMIT && nextAt !== null && lastAvailableAt !== null) {
				nextAt = Math.min(nextAt, lastAvailableAt);
			}
		}
		if (nextAt === null || nextAt === undefined) {
			await storage.deleteAlarm();
			return;
		}
		await storage.setAlarm(nextAt);
	}
}

/** Turn a stored record into the message object the shim hands to the user's `queue()`. */
function consumerMessage(record) {
	const text = textDecoder.decode(bytesFromBase64(record.body));
	let body;
	if (record.contentType === 'json') {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	} else if (record.contentType === 'text') {
		body = text;
	} else {
		// The internal route is JSON, so `bytes`/`v8` bodies travel base64-encoded (the same
		// representation the producer used). Decoding them needs the consumer's own format.
		body = record.body;
	}
	return {
		id: record.id,
		timestamp: record.timestamp,
		attempts: (record.attempts ?? 0) + 1,
		contentType: record.contentType,
		body,
	};
}

/** A 32-character hex id, the shape Cloudflare gives queue messages. */
function messageId() {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let id = '';
	for (const byte of bytes) id += byte.toString(16).padStart(2, '0');
	return id;
}

export default {
	async fetch(request, env) {
		const id = env.DO.idFromName('default');
		return env.DO.get(id).fetch(request);
	},
};
