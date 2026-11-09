/**
 * Yoal tail-worker service.
 *
 * Cloudflare (and workerd) deliver a Worker's invocation summary to every service named in its
 * `tails` list as a `tail(events, env, ctx)` call. The composer always renders this small Worker
 * for a function host and points the main Worker's `tails` at it, so every invocation's outcome,
 * console output and exceptions reach the node's telemetry pipeline (`function_tail_events`)
 * without the user Worker opting in (docs/FUNCTIONS.md §4.5, phase 3).
 *
 * This Worker owns *redaction*. It maps each TailItem to a fixed shape and never forwards the raw
 * event: the request is reduced to `{ method, url, status }`, so headers, cookies, query-bearing
 * bodies and every other field are dropped before the event leaves the isolate. URLs are clipped to
 * the contract cap and any `user:password@` userinfo is stripped. Logs and exceptions are clipped
 * to a fixed count and per-message size, and the whole POST body is bounded, so a chatty or
 * adversarial invocation cannot flood the agent's loopback sink.
 *
 * Delivery is best-effort and fire-and-forget: `ctx.waitUntil` keeps the isolate alive for the
 * POST, and every failure (a missing binding, a dead sink, an unserialisable value) is swallowed.
 * A tail worker must never turn a successful request into a failure.
 */

/** Contract caps (`functionTailEventSchema` in `@yoal/contracts`) and the sink's body budget. */
const MAX_LOGS = 80;
const MAX_LOG_CHARS = 4 * 1024;
const MAX_EXCEPTIONS = 20;
const MAX_EXCEPTION_NAME_CHARS = 200;
const MAX_EXCEPTION_MESSAGE_CHARS = 4 * 1024;
const MAX_SCRIPT_NAME_CHARS = 200;
const MAX_OUTCOME_CHARS = 64;
const MAX_LOG_LEVEL_CHARS = 16;
const MAX_METHOD_CHARS = 16;
const MAX_URL_CHARS = 2_048;
/** The agent's sink refuses a body over 256 KiB; the envelope is a few hundred bytes at most. */
const MAX_BODY_BYTES = 256 * 1024;

const ENCODER = new TextEncoder();

export default {
	/**
	 * Handle one producer invocation's tail events.
	 *
	 * @param {unknown[]} events TailItems for the invocation(s) that just ran.
	 * @param {Record<string, unknown>} env `WORKLOAD_ID`, `PROJECT_ID` and the `SINK` service binding.
	 * @param {{ waitUntil?: (promise: Promise<unknown>) => void }} [ctx]
	 */
	async tail(events, env = {}, ctx) {
		let pending;
		try {
			const items = tailItems(Array.isArray(events) ? events : []);
			if (items.length === 0) return;
			const body = encodeBatch(env, items);
			if (body === null) return;
			pending = Promise.resolve(
				env.SINK.fetch('http://analytics/tail', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body,
				}),
			).then(
				() => undefined,
				() => undefined,
			);
		} catch {
			// A missing/misconfigured SINK binding or an unserialisable item is dropped: tailing is
			// best-effort telemetry and must never surface as an application error.
			return;
		}
		if (ctx && typeof ctx.waitUntil === 'function') {
			ctx.waitUntil(pending);
			return;
		}
		// No waitUntil (tests, older runtimes): keep the promise observed and resolve after it.
		await pending;
	},
};

/**
 * Map every delivered TailItem to the fixed wire shape. Malformed entries never throw: unknown
 * fields are ignored, a missing field falls back to the contract default.
 *
 * @param {unknown[]} events
 */
function tailItems(events) {
	const items = [];
	for (const event of events) items.push(tailItem(event));
	return items;
}

/** @param {unknown} value */
function tailItem(value) {
	const record = isRecord(value) ? value : {};
	return {
		scriptName: clipText(record.scriptName, MAX_SCRIPT_NAME_CHARS),
		outcome: clipText(record.outcome, MAX_OUTCOME_CHARS) || 'unknown',
		logs: logList(record.logs),
		exceptions: exceptionList(record.exceptions),
		request: requestOf(record),
	};
}

/**
 * Cloudflare log messages are arrays of arbitrary values (`console.log('a', {b: 1})`). Render each
 * value like the console would — JSON for objects and arrays, `String` for everything else — and
 * join them into the single clipped string the contract stores.
 *
 * @param {unknown} logs
 */
function logList(logs) {
	if (!Array.isArray(logs)) return [];
	const entries = [];
	for (const entry of logs.slice(0, MAX_LOGS)) {
		if (!isRecord(entry)) continue;
		entries.push({
			level: clipText(entry.level, MAX_LOG_LEVEL_CHARS) || 'log',
			message: messageText(entry.message),
		});
	}
	return entries;
}

/** @param {unknown} message */
function messageText(message) {
	const values = Array.isArray(message) ? message : [message];
	return clipText(values.map(stringifyValue).join(' '), MAX_LOG_CHARS);
}

/** JSON for objects/arrays, `String` otherwise; a value that cannot be rendered degrades safely. */
function stringifyValue(value) {
	if (typeof value === 'string') return value;
	if (typeof value === 'object' && value !== null) {
		try {
			const json = JSON.stringify(value);
			if (typeof json === 'string') return json;
		} catch {
			// Circular structures and BigInts cannot be serialised; fall through to String.
		}
	}
	try {
		return String(value);
	} catch {
		return '[unserialisable]';
	}
}

/** @param {unknown} exceptions */
function exceptionList(exceptions) {
	if (!Array.isArray(exceptions)) return [];
	const entries = [];
	for (const entry of exceptions.slice(0, MAX_EXCEPTIONS)) {
		if (!isRecord(entry)) continue;
		entries.push({
			name: clipText(entry.name, MAX_EXCEPTION_NAME_CHARS),
			message: clipText(entry.message, MAX_EXCEPTION_MESSAGE_CHARS),
		});
	}
	return entries;
}

/**
 * Reduce the invocation's request to method, URL and response status. Headers (cookies,
 * authorization) and bodies are never read, so they can never be forwarded.
 *
 * @param {Record<string, unknown>} record
 */
function requestOf(record) {
	const source = isRecord(record.event) ? record.event : null;
	const request = source && isRecord(source.request) ? source.request : null;
	if (!request) return null;
	const response = source && isRecord(source.response) ? source.response : null;
	const status = response ? statusOf(response.status) : undefined;
	const item = {
		method: clipText(request.method, MAX_METHOD_CHARS),
		url: redactUrl(clipText(request.url, MAX_URL_CHARS)),
	};
	return status === undefined ? item : { ...item, status };
}

/** A response status must be a non-negative integer; anything else is treated as absent. */
function statusOf(value) {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Drop `user:password@` userinfo from an absolute URL; it is a credential, not an address. */
function redactUrl(url) {
	return url.replace(/\/\/[^/?#@]*@/, '//');
}

/** Serialise a bounded batch. Whole events are dropped from the end once the byte budget is spent. */
function encodeBatch(env, items) {
	const workloadId = textOf(env.WORKLOAD_ID);
	const projectId = textOf(env.PROJECT_ID);
	let bytes = byteLength(
		JSON.stringify({ workloadId, projectId, events: [] }),
	);
	const events = [];
	for (const item of items) {
		const json = JSON.stringify(item);
		// Leave room for the separating comma and the closing bracket.
		const cost = byteLength(json) + 1;
		if (bytes + cost > MAX_BODY_BYTES) break;
		bytes += cost;
		events.push(json);
	}
	if (events.length === 0) return null;
	return `{"workloadId":${JSON.stringify(workloadId)},"projectId":${JSON.stringify(projectId)},"events":[${events.join(',')}]}`;
}

/** @param {unknown} value */
function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce a text binding to a string; absent bindings become an empty string, not "undefined". */
function textOf(value) {
	return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/** Strings only; anything else becomes empty so the field's type is stable. */
function clipText(value, limit) {
	if (typeof value !== 'string') return '';
	return value.length > limit ? value.slice(0, limit) : value;
}

/** UTF-8 byte length, which is what the sink's 256 KiB cap measures. */
function byteLength(value) {
	return ENCODER.encode(value).byteLength;
}
