/**
 * A minimal ClickHouse HTTP client (D101). `fetch` only: no native addon, so nothing can fail to
 * load under Bun the way the embedded DuckDB binding did.
 *
 * Values travel as ClickHouse query parameters (`{name:Type}` in the SQL, `param_name` in the
 * URL), never spliced into SQL text.
 */

export interface ClickHouseConfig {
	/** e.g. `http://127.0.0.1:18123` */
	url: string;
	user: string;
	password: string;
	/** Default database for unqualified table names. */
	database?: string;
	/** Per-request timeout (default 30 s). */
	timeoutMs?: number;
	/** Injected for tests. */
	fetch?: typeof fetch;
}

export type ClickHouseSettings = Record<string, string | number | boolean>;
export type ClickHouseParams = Record<string, string | number | boolean | null | ReadonlyArray<string | number>>;

export interface ClickHouseRequest {
	params?: ClickHouseParams;
	settings?: ClickHouseSettings;
	/** Overrides the configured database (use '' to send none). */
	database?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface ClickHouseJsonMeta {
	name: string;
	type: string;
}

export interface ClickHouseCompactResult {
	meta: ClickHouseJsonMeta[];
	data: unknown[][];
	rows: number;
	rows_before_limit_at_least?: number;
	statistics?: { elapsed: number; rows_read: number; bytes_read: number };
}

/** A server-side error with ClickHouse's code and message (e.g. 62 SYNTAX_ERROR). */
export class ClickHouseError extends Error {
	constructor(
		message: string,
		readonly code: number | null,
		readonly status: number,
	) {
		super(message);
		this.name = 'ClickHouseError';
	}

	/** The query itself was wrong (syntax, unknown column, limits), not the server. */
	get isQueryError(): boolean {
		return this.status >= 400 && this.status < 500 && this.status !== 401 && this.status !== 403 && this.code !== 516;
	}
}

/** The caller aborted the request (its `signal`); says nothing about the server. */
export class ClickHouseAbortedError extends Error {
	constructor(options?: { cause?: unknown }) {
		super('The query was cancelled.', options);
		this.name = 'AbortError';
	}
}

/** Connection refused, DNS, reset: the server is unreachable rather than the query wrong. */
export class ClickHouseUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'ClickHouseUnavailableError';
	}
}

/** Render a parameter value in ClickHouse's text format for `param_*`. */
export function encodeParam(value: ClickHouseParams[string]): string {
	if (value === null) return '\\N';
	if (Array.isArray(value)) return `[${value.map((item) => (typeof item === 'number' ? String(item) : quoteString(item))).join(',')}]`;
	if (typeof value === 'boolean') return value ? '1' : '0';
	return String(value);
}

/** A ClickHouse single-quoted string literal. */
export function quoteString(value: string): string {
	return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** A ClickHouse identifier, back-quoted. */
export function quoteIdentifier(value: string): string {
	return `\`${value.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``;
}

const ERROR_CODE = /^Code: (\d+)\./;

export class ClickHouseClient {
	readonly url: string;
	readonly user: string;
	readonly database: string | undefined;
	readonly #password: string;
	readonly #timeoutMs: number;
	readonly #fetch: typeof fetch;

	constructor(config: ClickHouseConfig) {
		this.url = config.url.replace(/\/+$/, '');
		this.user = config.user;
		this.#password = config.password;
		this.database = config.database;
		this.#timeoutMs = config.timeoutMs ?? 30_000;
		this.#fetch = config.fetch ?? fetch;
	}

	/** A client for the same server with other credentials or database. */
	with(overrides: Partial<Pick<ClickHouseConfig, 'user' | 'password' | 'database' | 'timeoutMs'>>): ClickHouseClient {
		return new ClickHouseClient({
			url: this.url,
			user: overrides.user ?? this.user,
			password: overrides.password ?? this.#password,
			database: 'database' in overrides ? overrides.database : this.database,
			timeoutMs: overrides.timeoutMs ?? this.#timeoutMs,
			fetch: this.#fetch,
		});
	}

	async ping(signal?: AbortSignal): Promise<boolean> {
		try {
			const response = await this.#fetch(`${this.url}/ping`, { signal: signal ?? AbortSignal.timeout(5_000) });
			return response.ok && (await response.text()).trim() === 'Ok.';
		} catch {
			return false;
		}
	}

	/** Run a statement that returns nothing useful (DDL, DELETE, INSERT … SELECT). */
	async exec(sql: string, request: ClickHouseRequest = {}): Promise<void> {
		const response = await this.#send(sql, request);
		await response.arrayBuffer();
	}

	/** Rows as objects (`JSONEachRow`), 64-bit integers as numbers. */
	async query<T = Record<string, unknown>>(sql: string, request: ClickHouseRequest = {}): Promise<T[]> {
		const response = await this.#send(`${sql}\nFORMAT JSONEachRow`, {
			...request,
			settings: { output_format_json_quote_64bit_integers: 0, ...request.settings },
		});
		const text = await response.text();
		const rows: T[] = [];
		for (const line of text.split('\n')) if (line) rows.push(JSON.parse(line) as T);
		return rows;
	}

	/** Column metadata plus positional rows (`JSONCompact`), for ad-hoc results. */
	async queryCompact(sql: string, request: ClickHouseRequest = {}): Promise<ClickHouseCompactResult> {
		const response = await this.#send(`${sql}\nFORMAT JSONCompact`, {
			...request,
			settings: {
				output_format_json_quote_64bit_integers: 0,
				output_format_json_quote_denormals: 0,
				...request.settings,
			},
		});
		return (await response.json()) as ClickHouseCompactResult;
	}

	/** Raw bytes in any output format (e.g. `Parquet`). The SQL must end with its FORMAT clause. */
	async queryBytes(sql: string, request: ClickHouseRequest = {}): Promise<Uint8Array> {
		const response = await this.#send(sql, request);
		return new Uint8Array(await response.arrayBuffer());
	}

	/** Insert rows as `JSONEachRow`. Unknown keys fail; missing keys take column defaults. */
	async insert(table: string, rows: ReadonlyArray<Record<string, unknown>>, request: ClickHouseRequest = {}): Promise<void> {
		if (rows.length === 0) return;
		const body = rows.map((row) => JSON.stringify(row)).join('\n');
		const response = await this.#send(`INSERT INTO ${table} FORMAT JSONEachRow`, {
			...request,
			settings: { date_time_input_format: 'best_effort', input_format_skip_unknown_fields: 0, ...request.settings },
			body,
		});
		await response.arrayBuffer();
	}

	async #send(sql: string, request: ClickHouseRequest & { body?: string }): Promise<Response> {
		const url = new URL(`${this.url}/`);
		const database = request.database ?? this.database;
		if (database) url.searchParams.set('database', database);
		for (const [key, value] of Object.entries(request.settings ?? {}))
			url.searchParams.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
		for (const [key, value] of Object.entries(request.params ?? {})) url.searchParams.set(`param_${key}`, encodeParam(value));

		let body: string;
		if (request.body !== undefined) {
			url.searchParams.set('query', sql);
			body = request.body;
		} else {
			body = sql;
		}
		const timeout = AbortSignal.timeout(request.timeoutMs ?? this.#timeoutMs);
		const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

		let response: Response;
		try {
			response = await this.#fetch(url, {
				method: 'POST',
				body,
				signal,
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'x-clickhouse-user': this.user,
					'x-clickhouse-key': this.#password,
				},
			});
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			// The caller gave up (a panel re-ran its query): not a server problem at all.
			if (request.signal?.aborted) throw new ClickHouseAbortedError({ cause });
			// Our own deadline: a slow query, not a dead server (a down server refuses at once).
			if (timeout.aborted || cause.name === 'TimeoutError')
				throw new ClickHouseError(`The query took longer than ${Math.round((request.timeoutMs ?? this.#timeoutMs) / 1000)} s and was stopped.`, 159, 408);
			throw new ClickHouseUnavailableError(`ClickHouse at ${this.url} is unreachable: ${cause.message}`, { cause });
		}
		if (!response.ok) {
			const text = (await response.text()).trim();
			const code = Number(response.headers.get('x-clickhouse-exception-code') ?? ERROR_CODE.exec(text)?.[1] ?? NaN);
			throw new ClickHouseError(cleanMessage(text) || `ClickHouse answered ${response.status}`, Number.isFinite(code) ? code : null, response.status);
		}
		return response;
	}
}

/** Drop the `Code: NN. DB::Exception:` prefix and the version suffix; keep the useful sentence. */
function cleanMessage(text: string): string {
	return text
		.replace(/^Code: \d+\.\s*DB::Exception:\s*/, '')
		.replace(/\s*\(version [^)]*\)\s*$/, '')
		.replace(/\s*Stack trace[\s\S]*$/, '')
		.trim();
}
