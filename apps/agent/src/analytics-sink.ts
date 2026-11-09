import {
	functionTailEventSchema,
	type AnalyticsEvent,
	type FunctionTailEvent,
} from '@yoal/contracts';

/**
 * Analytics Engine and tail-worker sink (docs/FUNCTIONS.md §4.5, D101, FN10, phase 3).
 *
 * A function host renders each `analytics_engine` binding as a wrapped module that POSTs datapoints
 * to `http://analytics/event` over an `external` service pointing at this loopback port. The agent
 * validates the event and hands it to `TelemetryClient.recordAnalytics`, which batches it into the
 * regular telemetry POST; the control plane writes it to ClickHouse (`function_analytics`).
 *
 * The same server exposes `POST /tail` for the phase-3 tail Worker: workerd delivers each
 * invocation's tail events to `tail-api`, which forwards a redacted batch here. Each event is
 * recorded through `recordTail` and lands in `function_tail_events`, beside the Analytics Engine
 * rows and the access-log buckets.
 *
 * Why a loopback HTTP hop instead of a direct in-process call: workerd is a separate process with
 * its own sandbox, so the agent's only channel to a function host is a service binding. Keeping the
 * sink off every other interface (127.0.0.1 only) means only a function's own declared binding can
 * reach it, and the systemd IP filter already blocks the rest of the node.
 *
 * The sink is deliberately dumb and fail-open: an invalid or oversized event is refused (400/413),
 * a recording failure is swallowed, and it never touches disk. Losing telemetry must never fail a
 * function's request.
 */

/** The Analytics Engine route the wrapper calls. */
export const ANALYTICS_SINK_PATH = '/event';
/** The tail-worker route the tail Worker calls. */
export const TAIL_SINK_PATH = '/tail';
/** Hard cap on one POST body, before JSON parsing. Both routes share it. */
export const ANALYTICS_SINK_MAX_BODY_BYTES = 256 * 1024;
export const TAIL_SINK_MAX_BODY_BYTES = 256 * 1024;
/** Caps mirror `analyticsEventSchema` in `@yoal/contracts` and the wrapper module's own clipping. */
export const ANALYTICS_SINK_MAX_BLOBS = 20;
export const ANALYTICS_SINK_MAX_DOUBLES = 20;
export const ANALYTICS_SINK_MAX_INDEXES = 20;
export const ANALYTICS_SINK_MAX_BLOB_CHARS = 16_384;
export const ANALYTICS_SINK_MAX_INDEX_CHARS = 1_024;
const MAX_NAME_CHARS = 100;
/**
 * `functionTailEventSchema` caps a tail item at 50 logs and 20 exceptions. The tail Worker allows
 * 80 logs (so one chatty invocation does not lose everything), and this sink clips the extra ones:
 * an event that would not validate is worse than a trimmed one.
 */
const TAIL_MAX_LOGS = 50;
const TAIL_MAX_EXCEPTIONS = 20;
const TAIL_MAX_LOG_CHARS = 4_096;
const TAIL_MAX_EXCEPTION_NAME_CHARS = 200;
const TAIL_MAX_EXCEPTION_MESSAGE_CHARS = 4_096;
const TAIL_MAX_SCRIPT_NAME_CHARS = 200;
const TAIL_MAX_OUTCOME_CHARS = 64;
const TAIL_MAX_LOG_LEVEL_CHARS = 16;
const TAIL_MAX_METHOD_CHARS = 16;
const TAIL_MAX_URL_CHARS = 2_048;
/** The telemetry batch's own cap; a single tail invocation is never anywhere near it. */
const TAIL_MAX_EVENTS = 2_000;

export type AnalyticsSinkLog = (level: 'info' | 'warn', message: string) => void;

export interface AnalyticsSinkOptions {
	/** Loopback port; `0` lets the kernel choose one (tests). */
	port: number;
	/** Called once per valid Analytics Engine datapoint. Must not throw; the sink catches just in case. */
	record: (event: AnalyticsEvent) => void;
	/** Called once per valid tail event. Optional: without it `POST /tail` answers 404. */
	recordTail?: (event: FunctionTailEvent) => void;
	log?: AnalyticsSinkLog;
}

export interface AnalyticsSink {
	readonly port: number;
	readonly url: string;
	stop(): void;
}

/** JSON reply with no caching and a fixed content type. */
function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
	});
}

/**
 * Handle one sink request. Exported so tests can drive it without binding a port.
 *
 * Status contract: 202 accepted, 400 malformed, 405 wrong method, 413 body too large, 404 for any
 * other path. `/event` is the Analytics Engine route; `/tail` is the phase-3 tail-worker route and
 * is only served when a `recordTail` callback is configured.
 */
export async function handleAnalyticsRequest(
	request: Request,
	record: (event: AnalyticsEvent) => void,
	recordTail?: (event: FunctionTailEvent) => void,
): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (path === TAIL_SINK_PATH) {
		if (!recordTail) return json({ error: 'not_found' }, 404);
		return handleTailRequest(request, recordTail);
	}
	if (path !== ANALYTICS_SINK_PATH) return json({ error: 'not_found' }, 404);
	if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });

	const body = await readJsonBody(request, ANALYTICS_SINK_MAX_BODY_BYTES);
	if (!body.ok) return body.response;

	const event = parseAnalyticsEvent(body.value, Date.now());
	if (!event) return json({ error: 'invalid_event' }, 400);

	try {
		record(event);
	} catch {
		// Recording is best-effort telemetry: a broken batch buffer must not fail the writer.
	}
	return json({ ok: true }, 202);
}

/**
 * Handle the tail Worker's `POST /tail`. One request carries one producer invocation's items:
 * `{ workloadId, projectId, events: [...] }`. The agent stamps `ts` on receipt, and every event is
 * normalised to `functionTailEventSchema` before a recorder sees it.
 */
export async function handleTailRequest(
	request: Request,
	recordTail: (event: FunctionTailEvent) => void,
): Promise<Response> {
	if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });

	const body = await readJsonBody(request, TAIL_SINK_MAX_BODY_BYTES);
	if (!body.ok) return body.response;

	const batch = parseTailBatch(body.value, Date.now());
	if (!batch) return json({ error: 'invalid_event' }, 400);

	for (const event of batch.events) {
		try {
			recordTail(event);
		} catch {
			// Recording is best-effort telemetry: a broken batch buffer must not fail the tail Worker.
		}
	}
	return json({ ok: true }, 202);
}

type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

/** Read and parse a JSON body under a byte cap. A missing body is invalid JSON, as before. */
async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
	const declared = Number(request.headers.get('content-length') ?? Number.NaN);
	if (Number.isFinite(declared) && declared > maxBytes) {
		return { ok: false, response: json({ error: 'body_too_large' }, 413) };
	}

	let text: string;
	try {
		text = await request.text();
	} catch {
		return { ok: false, response: json({ error: 'invalid_body' }, 400) };
	}
	if (Buffer.byteLength(text, 'utf8') > maxBytes) {
		return { ok: false, response: json({ error: 'body_too_large' }, 413) };
	}

	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch {
		return { ok: false, response: json({ error: 'invalid_json' }, 400) };
	}
}

/** Start the sink on `127.0.0.1:<port>`. Throws when the port cannot be bound; the caller logs it. */
export function startAnalyticsSink(options: AnalyticsSinkOptions): AnalyticsSink {
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: options.port,
		fetch: (request) => handleAnalyticsRequest(request, options.record, options.recordTail),
	});
	const port = server.port ?? options.port;
	options.log?.('info', `Analytics Engine sink listening on 127.0.0.1:${port}`);
	return {
		port,
		url: `http://127.0.0.1:${port}`,
		stop: () => {
			server.stop(true);
		},
	};
}

/**
 * Validate the wrapper's JSON into an `AnalyticsEvent`. The dataset and ownership must be present:
 * the wrapper always stamps them, and an event without them cannot be attributed to a tenant.
 * Unknown fields are ignored so the wrapper can grow without a lockstep agent deploy.
 */
export function parseAnalyticsEvent(value: unknown, ts: number): AnalyticsEvent | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;

	const dataset = nameField(record.dataset);
	const projectId = nameField(record.projectId);
	const workloadId = nameField(record.workloadId);
	if (!dataset || !projectId || !workloadId) return null;

	const blobs = stringArray(record.blobs, ANALYTICS_SINK_MAX_BLOBS, ANALYTICS_SINK_MAX_BLOB_CHARS);
	const indexes = stringArray(record.indexes, ANALYTICS_SINK_MAX_INDEXES, ANALYTICS_SINK_MAX_INDEX_CHARS);
	const doubles = numberArray(record.doubles, ANALYTICS_SINK_MAX_DOUBLES);
	if (blobs === null || indexes === null || doubles === null) return null;

	return { ts, projectId, workloadId, dataset, blobs, doubles, indexes };
}

function nameField(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_CHARS ? value : null;
}

/** Absent (or null) becomes an empty list; `null` means invalid. */
function stringArray(value: unknown, maxItems: number, maxChars: number): string[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > maxItems) return null;
	const strings: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string' || item.length > maxChars) return null;
		strings.push(item);
	}
	return strings;
}

function numberArray(value: unknown, maxItems: number): number[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > maxItems) return null;
	const numbers: number[] = [];
	for (const item of value) {
		if (typeof item !== 'number' || !Number.isFinite(item)) return null;
		numbers.push(item);
	}
	return numbers;
}

export interface TailBatch {
	workloadId: string;
	projectId: string;
	events: FunctionTailEvent[];
}

/**
 * Validate the tail Worker's JSON into the telemetry contract. The wrapper and the workload must be
 * present: the tail Worker always stamps them, and an event without them cannot be attributed.
 *
 * Sizes are clipped to the contract caps rather than rejected (the tail Worker already clips; a
 * slightly oversized message must not cost the whole invocation). The final `safeParse` against
 * `functionTailEventSchema` is the authoritative check — if anything slipped through, the event is
 * refused rather than allowed to break the next telemetry POST.
 */
export function parseTailBatch(value: unknown, ts: number): TailBatch | null {
	if (!isRecord(value)) return null;

	const workloadId = nameField(value.workloadId);
	const projectId = nameField(value.projectId);
	if (!workloadId || !projectId) return null;

	const rawEvents = value.events;
	if (!Array.isArray(rawEvents) || rawEvents.length > TAIL_MAX_EVENTS) return null;

	const events: FunctionTailEvent[] = [];
	for (const raw of rawEvents) {
		const event = parseTailEvent(raw, ts, workloadId, projectId);
		if (!event) return null;
		events.push(event);
	}
	return { workloadId, projectId, events };
}

function parseTailEvent(
	value: unknown,
	ts: number,
	workloadId: string,
	projectId: string,
): FunctionTailEvent | null {
	if (!isRecord(value)) return null;

	const logs = tailLogs(value.logs);
	const exceptions = tailExceptions(value.exceptions);
	const request = tailRequest(value.request);
	if (logs === null || exceptions === null || request === undefined) return null;

	const parsed = functionTailEventSchema.safeParse({
		ts,
		projectId,
		workloadId,
		scriptName: clipped(value.scriptName, TAIL_MAX_SCRIPT_NAME_CHARS) ?? '',
		outcome: clipped(value.outcome, TAIL_MAX_OUTCOME_CHARS) ?? 'unknown',
		logs,
		exceptions,
		request,
	});
	return parsed.success ? parsed.data : null;
}

function tailLogs(value: unknown): FunctionTailEvent['logs'] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) return null;
	const logs: FunctionTailEvent['logs'] = [];
	for (const entry of value.slice(0, TAIL_MAX_LOGS)) {
		if (!isRecord(entry) || typeof entry.message !== 'string') return null;
		logs.push({
			level: clipped(entry.level, TAIL_MAX_LOG_LEVEL_CHARS) ?? 'log',
			message: entry.message.slice(0, TAIL_MAX_LOG_CHARS),
		});
	}
	return logs;
}

function tailExceptions(value: unknown): FunctionTailEvent['exceptions'] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) return null;
	const exceptions: FunctionTailEvent['exceptions'] = [];
	for (const entry of value.slice(0, TAIL_MAX_EXCEPTIONS)) {
		if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.message !== 'string') return null;
		exceptions.push({
			name: entry.name.slice(0, TAIL_MAX_EXCEPTION_NAME_CHARS),
			message: entry.message.slice(0, TAIL_MAX_EXCEPTION_MESSAGE_CHARS),
		});
	}
	return exceptions;
}

/**
 * `null` means no request, `undefined` means malformed. Only method, URL and status survive: the
 * sink never stores or forwards headers, cookies or bodies.
 */
function tailRequest(value: unknown): FunctionTailEvent['request'] | undefined {
	if (value === undefined || value === null) return null;
	if (!isRecord(value) || typeof value.method !== 'string' || typeof value.url !== 'string') {
		return undefined;
	}
	const request: NonNullable<FunctionTailEvent['request']> = {
		method: value.method.slice(0, TAIL_MAX_METHOD_CHARS),
		url: value.url.slice(0, TAIL_MAX_URL_CHARS),
	};
	const status = value.status;
	if (typeof status === 'number' && Number.isInteger(status) && status >= 0) request.status = status;
	return request;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clip a string field to the contract cap; a non-string is absent, not "undefined". */
function clipped(value: unknown, maxChars: number): string | undefined {
	return typeof value === 'string' ? value.slice(0, maxChars) : undefined;
}
