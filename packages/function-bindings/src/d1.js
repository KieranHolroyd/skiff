/**
 * Skiff D1 binding service (docs/FUNCTIONS.md §4.5, FN10).
 *
 * workerd has no native D1. It ships an internal module, `cloudflare-internal:d1-api`, which turns a
 * `wrapped` binding into a `D1Database` for the user's Worker: `prepare()`, `bind()`, `all()`,
 * `run()`, `batch()` and `exec()` all become HTTP POSTs to the wrapped binding's inner `fetcher`
 * service. This Worker is that service, and one Durable Object's `storage.sql` is the database.
 *
 * Protocol shape adapted from Miniflare (Apache-2.0), cloudflare/workers-sdk:
 * packages/miniflare/src/workers/d1/database.worker.ts.
 *
 * Plain JavaScript ESM: workerd loads this file as text and embeds it as a module. No imports, no
 * Node APIs, no eval, only Web APIs and Durable Object SQL storage.
 *
 * Protocol (what workerd's d1-api module sends):
 *   POST /query?resultsFormat=ARRAY_OF_OBJECTS|ROWS_AND_COLUMNS|NONE
 *   POST /execute?resultsFormat=NONE
 *   body: { sql, params? } or [ { sql, params? }, … ]
 *   reply: an array of { success: true, results, meta } in request order, or one
 *          { success: false, error } when the whole request fails (workerd reads the body, not the
 *          status code, so a D1 failure is HTTP 200 as in Miniflare).
 *
 * `exec()` splits its SQL into lines inside workerd's d1-api module, so `/execute` already receives
 * an array of statements. Every request runs inside one `storage.transaction`, which is what makes
 * `batch()` atomic; a single statement is transactional too. Session bookmarks are not implemented:
 * this database is always the primary, so `withSession()` behaves as `first-primary` with no
 * bookmark, which is a correct (if simple) answer on one node.
 */

/** Request bodies are JSON; 1 MiB is far beyond any D1 statement Cloudflare accepts. */
const MAX_REQUEST_BYTES = 1024 * 1024;
/** One request is one transaction; cap the batch so a hostile body cannot hold the DO open. */
const MAX_STATEMENTS = 100;
/**
 * Skiff's own result cap. Cloudflare limits D1 responses by byte size instead; bounding rows here
 * keeps a `SELECT *` from materialising the whole database inside the function host's memory.
 */
const MAX_RESULT_ROWS = 100_000;

/** `meta.served_by`: local, so no region/colo claims. */
const SERVED_BY = 'skiff.d1';

const RESULTS_FORMATS = new Set(['ARRAY_OF_OBJECTS', 'ROWS_AND_COLUMNS', 'NONE']);

/** An error that carries the HTTP status of its reply; every other throw is a D1 failure (200). */
class D1HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function jsonResponse(value, status) {
	return new Response(JSON.stringify(value), {
		status: status ?? 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

/** A D1 upstream failure. workerd's d1-api parses the body whatever the status code is. */
function failureResponse(error, status) {
	const message = error instanceof Error ? error.message : String(error);
	return jsonResponse({ success: false, error: message }, status);
}

/** Miniflare's permissive reader: an unknown or missing format means ARRAY_OF_OBJECTS. */
function resultsFormat(raw) {
	return RESULTS_FORMATS.has(raw) ? raw : 'ARRAY_OF_OBJECTS';
}

/**
 * D1 sends blobs as arrays of bytes (d1-api's `bind()` normalises typed arrays to plain arrays), and
 * workerd's SQL API binds a blob from an ArrayBuffer.
 */
function convertParams(params) {
	return (params ?? []).map((param) =>
		Array.isArray(param) ? new Uint8Array(param).buffer : param,
	);
}

/** Blobs come back as ArrayBuffer from workerd SQL (a typed array in the test adapter). */
function normalizeValue(value) {
	if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
	if (ArrayBuffer.isView(value)) {
		return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	}
	return value;
}

/**
 * Miniflare's ARRAY_OF_OBJECTS conversion. Duplicate column names keep the last value, exactly as
 * `Object.fromEntries` does there (D1 has the same quirk).
 */
function rowsToObjects(columns, rows) {
	return rows.map((row) => Object.fromEntries(columns.map((name, index) => [name, row[index]])));
}

export class D1DatabaseObject {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		// Instance fields so tests can shrink the limits without allocating megabytes of fixtures;
		// production always uses the constants above.
		this.maxRequestBytes = MAX_REQUEST_BYTES;
		this.maxStatements = MAX_STATEMENTS;
		this.maxResultRows = MAX_RESULT_ROWS;
	}

	async fetch(request) {
		try {
			return await this.route(request);
		} catch (error) {
			const status = error instanceof D1HttpError ? error.status : 200;
			return failureResponse(error, status);
		}
	}

	async route(request) {
		const url = new URL(request.url);
		if (request.method !== 'POST') {
			throw new D1HttpError(404, `Unsupported D1 method ${request.method}.`);
		}
		if (url.pathname !== '/query' && url.pathname !== '/execute') {
			throw new D1HttpError(404, `Unknown D1 endpoint ${url.pathname}.`);
		}

		const queries = await this.readQueries(request);
		const format = resultsFormat(url.searchParams.get('resultsFormat'));
		// One storage transaction per request: `batch()` and a multi-line `exec()` are atomic, and
		// a single statement still commits or rolls back as a unit.
		const results = await this.state.storage.transaction(() =>
			queries.map((query) => this.queryOne(format, query)),
		);
		return jsonResponse(results);
	}

	async readQueries(request) {
		const body = await request.arrayBuffer();
		if (body.byteLength > this.maxRequestBytes) {
			throw new D1HttpError(
				200,
				`D1 request body is ${body.byteLength} bytes, over the ${this.maxRequestBytes}-byte limit.`,
			);
		}

		let payload;
		try {
			payload = JSON.parse(new TextDecoder().decode(body));
		} catch {
			throw new D1HttpError(200, 'D1 request body is not valid JSON.');
		}

		const items = Array.isArray(payload) ? payload : [payload];
		const queries = [];
		for (const item of items) {
			if (typeof item !== 'object' || item === null || typeof item.sql !== 'string') {
				throw new D1HttpError(200, 'D1 queries must be objects of the form { sql, params? }.');
			}
			if (item.params !== undefined && item.params !== null && !Array.isArray(item.params)) {
				throw new D1HttpError(200, 'D1 query params must be an array.');
			}
			// SQLite rejects a statement that is only comments. Remote D1 filters `--` comments too,
			// and Miniflare filters them before counting statements.
			if (item.sql.replace(/^\s*--.*/gm, '').trim().length === 0) continue;
			queries.push({ sql: item.sql, params: item.params ?? [] });
		}

		if (queries.length === 0) throw new D1HttpError(200, 'No SQL statements detected.');
		if (queries.length > this.maxStatements) {
			const noun = this.maxStatements === 1 ? 'statement' : 'statements';
			throw new D1HttpError(
				200,
				`A D1 request can run at most ${this.maxStatements} ${noun}; this one has ${queries.length}.`,
			);
		}
		return queries;
	}

	/**
	 * Run one statement and shape one `D1SuccessResponse`.
	 *
	 * The change counters are SQLite connection counters read before and after, as Miniflare does:
	 * `changes` is the delta, `last_row_id` is the connection's last insert id, and `changed_db` is
	 * true when any of changes/last row id/database size moved.
	 */
	queryOne(format, query) {
		const sql = this.state.storage.sql;
		const beforeSize = sql.databaseSize;
		const before = this.readChanges();

		const params = convertParams(query.params);
		// Include cursor consumption in SQL time, but exclude the metadata reads and row conversion,
		// so `duration` means the same thing it does in D1.
		const started = performance.now();
		const cursor = sql.exec(query.sql, ...params);
		const columns = Array.from(cursor.columnNames);
		const rawRows = [];
		for (const row of cursor.raw()) {
			if (rawRows.length >= this.maxResultRows) {
				throw new D1HttpError(
					200,
					`D1 query returned more than ${this.maxResultRows} rows, over the per-query limit.`,
				);
			}
			rawRows.push(row);
		}
		const duration = performance.now() - started;

		const rows = rawRows.map((row) => Array.from(row, normalizeValue));
		// Miniflare returns rows for NONE as well as ARRAY_OF_OBJECTS; only ROWS_AND_COLUMNS changes
		// the envelope. D1's `run()`/`exec()` read `meta` and ignore the extra rows, so this stays a
		// correct (and smaller-code) subset.
		const results = format === 'ROWS_AND_COLUMNS' ? { columns, rows } : rowsToObjects(columns, rows);

		const afterSize = sql.databaseSize;
		const after = this.readChanges();
		const changes = after.totalChanges - before.totalChanges;
		const changed =
			changes !== 0 || after.lastRowId !== before.lastRowId || afterSize !== beforeSize;

		return {
			success: true,
			results,
			meta: {
				served_by: SERVED_BY,
				served_by_primary: true,
				total_attempts: 1,
				timings: { sql_duration_ms: duration },
				duration,
				changes,
				last_row_id: after.lastRowId,
				changed_db: changed,
				size_after: afterSize,
				rows_read: cursor.rowsRead,
				rows_written: cursor.rowsWritten,
			},
		};
	}

	/** SQLite's connection-wide change counters, used to derive one statement's `meta`. */
	readChanges() {
		const rows = Array.from(
			this.state.storage.sql
				.exec('SELECT total_changes() AS totalChanges, last_insert_rowid() AS lastRowId')
				.raw(),
		);
		const row = rows[0];
		if (!row) throw new Error('Could not read the D1 change counters.');
		return { totalChanges: Number(row[0]), lastRowId: Number(row[1]) };
	}
}

export default {
	async fetch(request, env) {
		// One database per binding service: the namespace is per binding, so a single named object
		// holds all of it. `default` is deliberately fixed so a deploy never moves the data.
		const id = env.DO.idFromName('default');
		return env.DO.get(id).fetch(request);
	},
};
