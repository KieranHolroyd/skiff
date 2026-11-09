/**
 * Yoal Analytics Engine binding service.
 *
 * workerd has no built-in Analytics Engine backend: upstream (and Miniflare) implement the
 * `analyticsEngine` capability as a *wrapped* binding whose wrapper is an extension module
 * (`Worker_Binding.wrapped` in workerd.capnp). The composer renders
 *
 *     ( name = "ANALYTICS", wrapped = (
 *         moduleName = "yoal-analytics:writer",
 *         innerBindings = [
 *           ( name = "sink", service = "analytics-sink-0" ),
 *           ( name = "dataset", text = "…" ),
 *           ( name = "projectId", text = "prj_…" ),
 *           ( name = "workloadId", text = "wl_…" ),
 *         ] ) )
 *
 * so the user Worker sees `env.ANALYTICS.writeDataPoint(...)` exactly as on Cloudflare, while
 * this module turns each call into one HTTP POST to the node agent's loopback sink
 * (`apps/agent/src/analytics-sink.ts`). The agent batches the events into its telemetry POST and
 * the control plane writes them to ClickHouse (`function_analytics`, D101).
 *
 * Semantics that matter:
 * - `writeDataPoint` is **synchronous** and **fire-and-forget**, like Cloudflare's. A slow or dead
 *   sink must never add latency to, or fail, the user's request; the promise is caught and dropped.
 * - The dataset and the owning project/workload come from the inner text bindings, never from the
 *   user's event, so a Worker cannot forge another tenant's rows (the sink re-validates too).
 * - Values are clipped to Cloudflare's documented caps before they leave the isolate: 20 blobs of
 *   at most 16 KiB, 20 indexes of at most 1 KiB, 20 finite doubles. A total blob budget keeps the
 *   JSON body under the sink's 256 KiB cap even when every blob is at its individual maximum.
 *
 * Shape adapted from Miniflare's analytics-engine plugin (Apache-2.0), cloudflare/workers-sdk
 * (`packages/miniflare/src/plugins/analytics-engine`). The backend (a Yoal service, not a
 * simulator) and the caps are Yoal's.
 */

/** Cloudflare's per-write limits (Workers Analytics Engine data point size limits). */
const MAX_BLOBS = 20;
const MAX_DOUBLES = 20;
const MAX_INDEXES = 20;
const MAX_BLOB_CHARS = 16 * 1024;
const MAX_INDEX_CHARS = 1024;
/**
 * Total UTF-16 units across all blobs. 20 × 16 KiB would exceed the sink's 256 KiB body cap, so
 * stop adding blobs once the budget is spent. Kept well below 256 KiB to leave room for JSON
 * escaping of the surrounding fields.
 */
const MAX_TOTAL_BLOB_CHARS = 160 * 1024;

const DECODER = new TextDecoder();

/**
 * Build the wrapper the composer embeds for one Analytics Engine dataset.
 *
 * @param {Record<string, unknown>} [env] inner bindings: `dataset`, `projectId`, `workloadId`,
 *   `sink` (an HTTP service binding to the agent's loopback sink).
 */
export default function analyticsWriter(env = {}) {
	const dataset = textOf(env.dataset);
	const projectId = textOf(env.projectId);
	const workloadId = textOf(env.workloadId);

	return {
		/**
		 * Record one data point. Never throws, never returns a promise to the caller.
		 * @param {{ blobs?: unknown[], doubles?: unknown[], indexes?: unknown[] }} [event]
		 */
		writeDataPoint(event = {}) {
			try {
				const body = JSON.stringify({
					dataset,
					projectId,
					workloadId,
					blobs: blobList(event.blobs),
					doubles: doubleList(event.doubles),
					indexes: indexList(event.indexes),
				});
				const pending = env.sink.fetch('http://analytics/event', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body,
				});
				// Fire and forget: workerd does not await this, and a rejecting sink is the node's
				// problem, not the user's request.
				Promise.resolve(pending).catch(() => {});
			} catch {
				// A missing/misconfigured sink binding or an unserialisable event is dropped. A write
				// is best-effort telemetry; it must never surface as an application error.
			}
		},
	};
}

/** Coerce a text binding to a string; absent bindings become an empty string, not "undefined". */
function textOf(value) {
	return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/** Blobs accept strings and binary data (Cloudflare allows ArrayBuffer/views); anything else drops. */
function blobList(values) {
	if (!Array.isArray(values)) return [];
	const blobs = [];
	let budget = MAX_TOTAL_BLOB_CHARS;
	for (const value of values.slice(0, MAX_BLOBS)) {
		const text = blobText(value);
		if (text === undefined) continue;
		const clipped = clip(text, MAX_BLOB_CHARS);
		// JSON escaping can double a string's length; measure the escaped form against the budget.
		const cost = JSON.stringify(clipped).length;
		if (cost > budget) break;
		budget -= cost;
		blobs.push(clipped);
	}
	return blobs;
}

function blobText(value) {
	if (typeof value === 'string') return value;
	if (value instanceof ArrayBuffer) return DECODER.decode(new Uint8Array(value));
	if (ArrayBuffer.isView(value)) return DECODER.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	return undefined;
}

/** Doubles are numbers only; NaN/Infinity cannot be represented in ClickHouse's Float64 JSON. */
function doubleList(values) {
	if (!Array.isArray(values)) return [];
	const doubles = [];
	for (const value of values.slice(0, MAX_DOUBLES)) {
		if (typeof value === 'number' && Number.isFinite(value)) doubles.push(value);
	}
	return doubles;
}

/** Indexes are low-cardinality strings; cap each at 1 KiB so a stray blob cannot bloat the key. */
function indexList(values) {
	if (!Array.isArray(values)) return [];
	const indexes = [];
	for (const value of values.slice(0, MAX_INDEXES)) {
		if (typeof value === 'string') indexes.push(clip(value, MAX_INDEX_CHARS));
	}
	return indexes;
}

function clip(value, limit) {
	return value.length > limit ? value.slice(0, limit) : value;
}
