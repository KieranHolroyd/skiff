import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
	MAX_LOG_DRAINS_PER_ORG,
	canAdministerPlatform,
	logDrainCreateSchema,
	logDrainUpdateSchema,
	logDrainUrlError,
	type LogDrainCreate,
	type LogDrainFormat,
	type LogDrainKind,
	type LogDrainMutationResult,
	type LogDrainSource,
	type LogDrainTestResult,
	type LogDrainUpdate,
	type LogDrainView,
	type LogLevel,
	type Principal,
	type ResourceRef,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { newId, parseJson, randomBytes } from './util.ts';
import { signatureHeaders } from './webhook-signature.ts';

/**
 * Log drains (DESIGN §8 "Logs", migration 0063).
 *
 * Agents already ship every log line to the control plane (`apps/agent/src/log-drain.ts` →
 * `LogService.appendRuntime`), so the control plane fans out from its own tables and agents stay
 * simple. A drain is three cursors over the monotonic `seq` of `log_events`, `service_log_events`
 * and `broker_log_events`:
 *
 * - **Batching.** Each tick reads up to 500 lines per table after the cursors (about 1 MB), sends
 *   them in one request and moves the cursors only after a 2xx. Up to 10 batches a tick, so a
 *   drain that fell behind catches up.
 * - **Retries.** A failure backs off exponentially (5 s → 5 min) and retries the same lines.
 *   After 8 failed attempts, or at once for an answer that will never succeed (400, 413, 415,
 *   422), the batch is dropped and counted: `droppedLines`/`droppedBatches` are the dead-letter
 *   count, with the last error next to them. Delivery is at least once; every line has a stable
 *   `id` to dedupe on.
 * - **Leases.** A drain is claimed with a conditional UPDATE before it is delivered, so a standby
 *   or a second process never ships a batch twice at the same time.
 * - **Secrets.** Header values and the webhook signing secret are sealed with the org key
 *   (`SecretService.seal`) and never returned; views carry header names only.
 * - **Egress.** Drains reach public addresses only. A platform admin can allow private,
 *   loopback and link-local addresses (and plain http) for a drain to a LAN collector.
 */

const BATCH_LINES = 500;
const BATCH_BYTES = 1_000_000;
const BATCHES_PER_TICK = 10;
const DUE_LIMIT = 50;
const LEASE_MS = 120_000;
export const LOG_DRAIN_MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Answers a retry can't fix; the batch is dead-lettered at once. */
const NON_RETRYABLE = new Set([400, 413, 415, 422]);
const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const PROJECT_SOURCES = ['build', 'runtime', 'system'] as const;
const OTLP_SEVERITY: Record<LogLevel, number> = { debug: 5, info: 9, warn: 13, error: 17 };

interface DrainRow {
	id: string;
	org_id: string;
	project_id: string | null;
	name: string;
	kind: LogDrainKind;
	url: string;
	format: LogDrainFormat;
	sources_json: string;
	min_level: LogLevel | null;
	header_names_json: string;
	headers_sealed: string | null;
	signing_secret_sealed: string | null;
	allow_private_network: number;
	enabled: number;
	log_cursor: number;
	service_cursor: number;
	broker_cursor: number;
	attempts: number;
	next_attempt_at: number;
	leased_until: number;
	delivered_lines: number;
	delivered_batches: number;
	dropped_lines: number;
	dropped_batches: number;
	last_delivered_at: number | null;
	last_error: string | null;
	last_error_at: number | null;
	failing_since: number | null;
	created_by: string;
	created_at: number;
	updated_at: number;
}

/** One line as a drain sends it. */
export interface DrainLine {
	/** Stable per line: `log:<seq>`, `svc:<seq>` or `brk:<seq>`. Receivers can dedupe on it. */
	id: string;
	ts: number;
	level: LogLevel;
	message: string;
	source: string;
	stream: string;
	projectId: string | null;
	project: string | null;
	deploymentId: string | null;
	buildId: string | null;
	nodeId: string | null;
	service: { kind: string; id: string; name: string | null } | null;
}

interface Cursors {
	log: number;
	service: number;
	broker: number;
}

interface Batch {
	lines: DrainLine[];
	/** Where the cursors move once this batch is delivered (or dropped). */
	next: Cursors;
	/** More lines are waiting after this batch. */
	more: boolean;
}

type SendResult =
	| { ok: true; status: number; rejected: number; message: string | null }
	| { ok: false; status: number | null; retryable: boolean; message: string };

const iso = (ms: number | null): string | null => (ms === null || ms === 0 ? null : new Date(ms).toISOString());

export class LogDrainService {
	/** Test seams: the HTTP client and the resolver used for the egress check. */
	fetch: (input: URL, init: RequestInit) => Promise<Response> = (input, init) => globalThis.fetch(input, init);
	resolveHost: (hostname: string) => Promise<string[]> = async (hostname) =>
		(await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
	#running = false;

	constructor(
		private readonly ctx: CoreContext,
		private readonly version = '0.0.0',
	) {}

	// ---------------------------------------------------------------- access

	#requireRead(principal: Principal, resource: ResourceRef = { type: 'org' }): void {
		this.ctx.iam.require(principal, 'logs:read', resource);
	}

	/** A drain is org-wide unless it names a project. */
	#resource(row: DrainRow): ResourceRef {
		return row.project_id ? { type: 'project', id: row.project_id } : { type: 'org' };
	}

	/** A drain copies every log line out of Skiff, so org owners and admins manage them (as alert rules). */
	canEdit(principal: Principal): boolean {
		return (
			principal.permissions.has('logs:read') &&
			(principal.role === 'owner' || principal.role === 'admin' || principal.platformAdmin === true)
		);
	}

	#requireEdit(principal: Principal, resource: ResourceRef = { type: 'org' }): void {
		this.#requireRead(principal, resource);
		if (!this.canEdit(principal))
			throw new CoreError('forbidden', 'Only org owners and admins can change log drains.', 403);
	}

	// ---------------------------------------------------------------- reads

	list(principal: Principal): LogDrainView[] {
		this.#requireRead(principal);
		return this.ctx.sqlite
			.query<DrainRow, [string]>('SELECT * FROM log_drains WHERE org_id = ? ORDER BY created_at')
			.all(principal.orgId)
			.map((row) => this.#view(row));
	}

	get(principal: Principal, id: string): LogDrainView {
		const row = this.#row(principal, id);
		this.#requireRead(principal, this.#resource(row));
		return this.#view(row);
	}

	#row(principal: Principal, id: string): DrainRow {
		const row = this.ctx.sqlite
			.query<DrainRow, [string, string]>('SELECT * FROM log_drains WHERE id = ? AND org_id = ?')
			.get(id, principal.orgId);
		if (!row) throw new NotFoundError('Log drain');
		return row;
	}

	// ---------------------------------------------------------------- mutations

	create(principal: Principal, raw: LogDrainCreate): LogDrainMutationResult {
		const parsed = logDrainCreateSchema.safeParse(raw);
		if (!parsed.success) throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join(' '));
		const input = parsed.data;
		const project = input.project ? this.ctx.projects.requireRow(principal, input.project) : null;
		this.#requireEdit(principal, project ? { type: 'project', id: project.id } : { type: 'org' });
		if (input.allowPrivateNetwork && !canAdministerPlatform(principal))
			throw new CoreError('forbidden', 'Only a platform admin, from the dashboard, can let a drain reach private addresses.', 403);
		const count = this.ctx.sqlite
			.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM log_drains WHERE org_id = ?')
			.get(principal.orgId)!.n;
		if (count >= MAX_LOG_DRAINS_PER_ORG)
			throw new ConflictError(`An organisation can have at most ${MAX_LOG_DRAINS_PER_ORG} log drains.`);
		const name = input.name.trim();
		if (this.ctx.sqlite.query('SELECT 1 FROM log_drains WHERE org_id = ? AND name = ?').get(principal.orgId, name))
			throw new ConflictError(`A log drain named "${name}" already exists.`);
		const projectId = project?.id ?? null;

		const id = newId('ldr_');
		const now = this.ctx.now();
		const heads = this.#heads();
		const signingSecret = input.kind === 'webhook' ? newSigningSecret() : null;
		const headers = input.headers ?? {};
		const headerNames = Object.keys(headers);
		this.ctx.sqlite.run(
			`INSERT INTO log_drains (id, org_id, project_id, name, kind, url, format, sources_json, min_level, header_names_json,
				headers_sealed, signing_secret_sealed, allow_private_network, enabled, log_cursor, service_cursor, broker_cursor,
				created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				principal.orgId,
				projectId,
				name,
				input.kind,
				normalizeUrl(input.kind, input.url),
				input.kind === 'webhook' ? (input.format ?? 'ndjson') : 'json',
				JSON.stringify(input.sources),
				input.minLevel ?? null,
				JSON.stringify(headerNames),
				headerNames.length ? this.ctx.secrets.seal(principal.orgId, JSON.stringify(headers)) : null,
				signingSecret ? this.ctx.secrets.seal(principal.orgId, signingSecret) : null,
				input.allowPrivateNetwork ? 1 : 0,
				input.enabled ? 1 : 0,
				heads.log,
				heads.service,
				heads.broker,
				principal.userId,
				now,
				now,
			],
		);
		this.ctx.audit.record({
			principal,
			action: 'log_drain.create',
			resource: 'log_drain',
			resourceId: id,
			args: {
				name,
				kind: input.kind,
				url: maskUrl(input.url),
				project: input.project ?? null,
				sources: input.sources,
				minLevel: input.minLevel ?? null,
				headerNames,
				allowPrivateNetwork: input.allowPrivateNetwork,
			},
			result: 'ok',
		});
		return { drain: this.get(principal, id), signingSecret };
	}

	update(principal: Principal, id: string, raw: LogDrainUpdate): LogDrainMutationResult {
		const parsed = logDrainUpdateSchema.safeParse(raw);
		if (!parsed.success) throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join(' '));
		const input = parsed.data;
		const row = this.#row(principal, id);
		this.#requireEdit(principal, this.#resource(row));
		const platform = canAdministerPlatform(principal);
		const allowPrivate = input.allowPrivateNetwork ?? row.allow_private_network === 1;
		// Pointing a private-network drain somewhere else is as sensitive as allowing it.
		if ((input.allowPrivateNetwork === true || (row.allow_private_network === 1 && input.url !== undefined)) && !platform)
			throw new CoreError('forbidden', 'Only a platform admin, from the dashboard, can change where a private-network drain sends.', 403);

		const sets: string[] = [];
		const values: Array<string | number | null> = [];
		const set = (column: string, value: string | number | null) => {
			sets.push(`${column} = ?`);
			values.push(value);
		};
		if (input.name !== undefined && input.name.trim() !== row.name) {
			if (this.ctx.sqlite.query('SELECT 1 FROM log_drains WHERE org_id = ? AND name = ? AND id != ?').get(principal.orgId, input.name.trim(), id))
				throw new ConflictError(`A log drain named "${input.name.trim()}" already exists.`);
			set('name', input.name.trim());
		}
		const url = input.url ?? row.url;
		if (input.url !== undefined || input.allowPrivateNetwork !== undefined) {
			const error = logDrainUrlError(url, { allowHttp: allowPrivate });
			if (error) throw new ValidationError(error);
		}
		if (input.url !== undefined) set('url', normalizeUrl(row.kind, input.url));
		if (input.allowPrivateNetwork !== undefined) set('allow_private_network', input.allowPrivateNetwork ? 1 : 0);
		if (input.format !== undefined) {
			if (row.kind !== 'webhook') throw new ValidationError('OTLP drains always send OTLP/JSON.');
			set('format', input.format);
		}
		if (input.sources !== undefined) {
			if (row.project_id && input.sources.includes('services'))
				throw new ValidationError('A project drain has no managed-service logs; services is for org-wide drains.');
			set('sources_json', JSON.stringify(input.sources));
		}
		if (input.minLevel !== undefined) set('min_level', input.minLevel);
		if (input.headers !== undefined) {
			const headers = input.headers ?? {};
			const names = Object.keys(headers);
			set('header_names_json', JSON.stringify(names));
			set('headers_sealed', names.length ? this.ctx.secrets.seal(principal.orgId, JSON.stringify(headers)) : null);
		}
		if (input.enabled !== undefined && input.enabled !== (row.enabled === 1)) {
			set('enabled', input.enabled ? 1 : 0);
			if (input.enabled) {
				// Resume from now: a drain switched off for a week must not replay the week.
				const heads = this.#heads();
				set('log_cursor', Math.max(row.log_cursor, heads.log));
				set('service_cursor', Math.max(row.service_cursor, heads.service));
				set('broker_cursor', Math.max(row.broker_cursor, heads.broker));
				set('attempts', 0);
				set('next_attempt_at', 0);
				set('failing_since', null);
			}
		}
		let signingSecret: string | null = null;
		if (input.rotateSigningSecret) {
			if (row.kind !== 'webhook') throw new ValidationError('Only webhook drains are signed.');
			signingSecret = newSigningSecret();
			set('signing_secret_sealed', this.ctx.secrets.seal(principal.orgId, signingSecret));
		}
		set('updated_at', this.ctx.now());
		this.ctx.sqlite.run(`UPDATE log_drains SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
		const { headers, rotateSigningSecret, ...rest } = input;
		this.ctx.audit.record({
			principal,
			action: 'log_drain.update',
			resource: 'log_drain',
			resourceId: id,
			args: {
				...rest,
				...(rest.url !== undefined ? { url: maskUrl(rest.url) } : {}),
				...(headers !== undefined ? { headerNames: Object.keys(headers ?? {}) } : {}),
				...(rotateSigningSecret ? { rotateSigningSecret: true } : {}),
			},
			result: 'ok',
		});
		return { drain: this.get(principal, id), signingSecret };
	}

	delete(principal: Principal, id: string): void {
		const row = this.#row(principal, id);
		this.#requireEdit(principal, this.#resource(row));
		this.ctx.sqlite.run('DELETE FROM log_drains WHERE id = ?', [id]);
		this.ctx.audit.record({
			principal,
			action: 'log_drain.delete',
			resource: 'log_drain',
			resourceId: id,
			args: { name: row.name, kind: row.kind },
			result: 'ok',
		});
	}

	/** Send one test line now. Delivery counters and cursors are left alone. */
	async test(principal: Principal, id: string): Promise<LogDrainTestResult> {
		const row = this.#row(principal, id);
		this.#requireEdit(principal, this.#resource(row));
		const now = this.ctx.now();
		const project = row.project_id ? this.#projectSlugs([row.project_id]).get(row.project_id) ?? null : null;
		const line: DrainLine = {
			id: `test:${now}`,
			ts: now,
			level: 'info',
			message: `Test line from the Skiff log drain "${row.name}".`,
			source: 'system',
			stream: 'system',
			projectId: row.project_id,
			project,
			deploymentId: null,
			buildId: null,
			nodeId: null,
			service: null,
		};
		const result = await this.#send(row, [line], `${row.id}.test.${now}`);
		const outcome: LogDrainTestResult = result.ok
			? {
					ok: true,
					status: result.status,
					message: result.message ?? `The receiver accepted the test line (HTTP ${result.status}).`,
				}
			: { ok: false, status: result.status, message: result.message };
		this.ctx.audit.record({
			principal,
			action: 'log_drain.test',
			resource: 'log_drain',
			resourceId: id,
			args: { name: row.name },
			result: outcome.ok ? 'ok' : 'error',
			...(outcome.ok ? {} : { error: outcome.message }),
		});
		return outcome;
	}

	// ---------------------------------------------------------------- delivery

	/**
	 * The fan-out loop (hooks.server.ts, every few seconds on the primary). Drains are delivered in
	 * parallel; a tick that is still running when the next one fires is skipped.
	 */
	async deliverDue(now = this.ctx.now()): Promise<{ drains: number; lines: number }> {
		if (this.#running) return { drains: 0, lines: 0 };
		this.#running = true;
		try {
			const due = this.ctx.sqlite
				.query<DrainRow, [number, number, number]>(
					'SELECT * FROM log_drains WHERE enabled = 1 AND next_attempt_at <= ? AND leased_until <= ? ORDER BY next_attempt_at LIMIT ?',
				)
				.all(now, now, DUE_LIMIT);
			const claim = this.ctx.sqlite.prepare(
				'UPDATE log_drains SET leased_until = ? WHERE id = ? AND enabled = 1 AND next_attempt_at <= ? AND leased_until <= ?',
			);
			const claimed = due.filter((row) => claim.run(now + LEASE_MS, row.id, now, now).changes === 1);
			const shipped = await Promise.all(
				claimed.map(async (row) => {
					try {
						return await this.#deliver(row.id);
					} catch (error) {
						console.error(`[log-drains] ${row.id}:`, error);
						return 0;
					} finally {
						this.ctx.sqlite.run('UPDATE log_drains SET leased_until = 0 WHERE id = ?', [row.id]);
					}
				}),
			);
			return { drains: claimed.length, lines: shipped.reduce((sum, count) => sum + count, 0) };
		} finally {
			this.#running = false;
		}
	}

	async #deliver(id: string): Promise<number> {
		let shipped = 0;
		for (let round = 0; round < BATCHES_PER_TICK; round += 1) {
			const row = this.ctx.sqlite.query<DrainRow, [string]>('SELECT * FROM log_drains WHERE id = ?').get(id);
			if (!row || row.enabled !== 1) break;
			const from: Cursors = { log: row.log_cursor, service: row.service_cursor, broker: row.broker_cursor };
			const batch = this.#readBatch(row);
			if (batch.lines.length === 0) {
				this.#moveCursors(row, from, batch.next, {});
				break;
			}
			const now = this.ctx.now();
			const result = await this.#send(row, batch.lines, `${row.id}.${from.log}.${from.service}.${from.broker}`);
			if (result.ok) {
				const delivered = Math.max(0, batch.lines.length - result.rejected);
				this.#moveCursors(row, from, batch.next, {
					delivered_lines: row.delivered_lines + delivered,
					delivered_batches: row.delivered_batches + 1,
					dropped_lines: row.dropped_lines + result.rejected,
					attempts: 0,
					next_attempt_at: 0,
					last_delivered_at: now,
					failing_since: null,
					...(result.rejected > 0 ? { last_error: result.message, last_error_at: now } : {}),
				});
				shipped += batch.lines.length;
				if (!batch.more) break;
				continue;
			}
			const attempts = row.attempts + 1;
			const failure = {
				last_error: result.message.slice(0, 500),
				last_error_at: now,
				failing_since: row.failing_since ?? now,
				next_attempt_at: now + backoff(attempts),
			};
			if (!result.retryable || attempts >= LOG_DRAIN_MAX_ATTEMPTS) {
				// Dead letter: give up on these lines, count them, and move on to the next batch.
				this.#moveCursors(row, from, batch.next, {
					...failure,
					attempts: 0,
					dropped_lines: row.dropped_lines + batch.lines.length,
					dropped_batches: row.dropped_batches + 1,
				});
				console.warn(
					`[log-drains] ${row.id} dropped ${batch.lines.length} line(s) after ${attempts} attempt(s): ${failure.last_error}`,
				);
			} else {
				this.#moveCursors(row, from, from, { ...failure, attempts });
			}
			break;
		}
		return shipped;
	}

	/**
	 * Move the cursors and write counters, but only if nobody else moved them meanwhile (a
	 * re-enable jumps them to now while a batch is in flight).
	 */
	#moveCursors(row: DrainRow, from: Cursors, to: Cursors, fields: Partial<Record<keyof DrainRow, string | number | null>>): void {
		const entries = Object.entries(fields);
		if (entries.length === 0 && from.log === to.log && from.service === to.service && from.broker === to.broker) return;
		const sets = ['log_cursor = ?', 'service_cursor = ?', 'broker_cursor = ?', ...entries.map(([column]) => `${column} = ?`)];
		this.ctx.sqlite.run(
			`UPDATE log_drains SET ${sets.join(', ')} WHERE id = ? AND log_cursor = ? AND service_cursor = ? AND broker_cursor = ?`,
			[to.log, to.service, to.broker, ...entries.map(([, value]) => value ?? null), row.id, from.log, from.service, from.broker],
		);
	}

	/** The newest `seq` of each table: where a new (or re-enabled) drain starts. */
	#heads(): Cursors {
		const head = (table: string) =>
			this.ctx.sqlite.query<{ head: number }, []>(`SELECT COALESCE(MAX(seq), 0) AS head FROM ${table}`).get()!.head;
		return { log: head('log_events'), service: head('service_log_events'), broker: head('broker_log_events') };
	}

	#readBatch(row: DrainRow): Batch {
		const heads = this.#heads();
		const sources = parseJson<LogDrainSource[]>(row.sources_json, []);
		const levels = row.min_level ? LEVELS.slice(Math.max(0, LEVELS.indexOf(row.min_level))) : null;
		const projectSources = sources.length ? PROJECT_SOURCES.filter((source) => sources.includes(source)) : [...PROJECT_SOURCES];
		const services = !row.project_id && (sources.length === 0 || sources.includes('services'));
		const activeStreams = (projectSources.length ? 1 : 0) + (services ? 2 : 0);
		const byteBudget = Math.floor(BATCH_BYTES / Math.max(1, activeStreams));
		const next: Cursors = { log: row.log_cursor, service: row.service_cursor, broker: row.broker_cursor };
		let more = false;

		const levelSql = levels ? ` AND level IN (${levels.map(() => '?').join(', ')})` : '';
		/** Read one table after its cursor, cut to the byte budget, and work out the next cursor. */
		const read = <T extends { seq: number; message: string }>(sql: string, params: Array<string | number>, cursor: number, head: number) => {
			const rows = this.ctx.sqlite.query<T, Array<string | number>>(sql).all(...params, cursor, head, ...(levels ?? []), BATCH_LINES);
			let bytes = 0;
			let kept = rows.length;
			for (let index = 0; index < rows.length; index += 1) {
				bytes += rows[index]!.message.length + 256;
				if (bytes > byteBudget && index > 0) {
					kept = index;
					break;
				}
			}
			const included = rows.slice(0, kept);
			const full = rows.length >= BATCH_LINES || kept < rows.length;
			if (full) more = true;
			// Nothing more to read up to the head: jump there, past other orgs' and filtered rows.
			const nextCursor = full ? included.at(-1)!.seq : Math.max(cursor, head);
			return { rows: included, nextCursor };
		};

		const lines: DrainLine[] = [];
		if (projectSources.length) {
			const projectSql = row.project_id ? ' AND project_id = ?' : '';
			const { rows, nextCursor } = read<{
				seq: number;
				ts: number;
				level: LogLevel;
				message: string;
				source: string;
				stream: string;
				project_id: string;
				deployment_id: string | null;
				build_id: string | null;
				node_id: string | null;
			}>(
				`SELECT seq, ts, level, message, source, stream, project_id, deployment_id, build_id, node_id FROM log_events
				 WHERE org_id = ?${projectSql} AND source IN (${projectSources.map(() => '?').join(', ')})
				   AND seq > ? AND seq <= ?${levelSql} ORDER BY seq LIMIT ?`,
				[row.org_id, ...(row.project_id ? [row.project_id] : []), ...projectSources],
				row.log_cursor,
				heads.log,
			);
			next.log = nextCursor;
			const slugs = this.#projectSlugs([...new Set(rows.map((entry) => entry.project_id))]);
			for (const entry of rows)
				lines.push({
					id: `log:${entry.seq}`,
					ts: entry.ts,
					level: entry.level,
					message: entry.message,
					source: entry.source,
					stream: entry.stream,
					projectId: entry.project_id,
					project: slugs.get(entry.project_id) ?? null,
					deploymentId: entry.deployment_id,
					buildId: entry.build_id,
					nodeId: entry.node_id,
					service: null,
				});
		} else next.log = Math.max(row.log_cursor, heads.log);

		if (services) {
			type ServiceRow = { seq: number; ts: number; level: LogLevel; message: string; source: string; stream: string; kind: string; service_id: string; node_id: string | null };
			const service = read<ServiceRow>(
				`SELECT seq, ts, level, message, source, stream, kind, service_id, node_id FROM service_log_events
				 WHERE org_id = ? AND seq > ? AND seq <= ?${levelSql} ORDER BY seq LIMIT ?`,
				[row.org_id],
				row.service_cursor,
				heads.service,
			);
			const broker = read<ServiceRow>(
				`SELECT seq, ts, level, message, source, stream, 'broker' AS kind, broker_id AS service_id, node_id FROM broker_log_events
				 WHERE org_id = ? AND seq > ? AND seq <= ?${levelSql} ORDER BY seq LIMIT ?`,
				[row.org_id],
				row.broker_cursor,
				heads.broker,
			);
			next.service = service.nextCursor;
			next.broker = broker.nextCursor;
			const names = this.#serviceNames([...service.rows, ...broker.rows]);
			for (const [prefix, rows] of [['svc', service.rows], ['brk', broker.rows]] as const)
				for (const entry of rows)
					lines.push({
						id: `${prefix}:${entry.seq}`,
						ts: entry.ts,
						level: entry.level,
						message: entry.message,
						source: entry.source,
						stream: entry.stream,
						projectId: null,
						project: null,
						deploymentId: null,
						buildId: null,
						nodeId: entry.node_id,
						service: { kind: entry.kind, id: entry.service_id, name: names.get(entry.service_id) ?? null },
					});
		} else {
			next.service = Math.max(row.service_cursor, heads.service);
			next.broker = Math.max(row.broker_cursor, heads.broker);
		}
		lines.sort((a, b) => a.ts - b.ts);
		return { lines, next, more };
	}

	#projectSlugs(ids: string[]): Map<string, string> {
		if (ids.length === 0) return new Map();
		const rows = this.ctx.sqlite
			.query<{ id: string; slug: string }, string[]>(`SELECT id, slug FROM projects WHERE id IN (${ids.map(() => '?').join(', ')})`)
			.all(...ids);
		return new Map(rows.map((entry) => [entry.id, entry.slug]));
	}

	#serviceNames(rows: Array<{ kind: string; service_id: string }>): Map<string, string> {
		const out = new Map<string, string>();
		const tables: Record<string, string> = { database: 'databases', storage: 'storage_instances', broker: 'brokers' };
		for (const [kind, table] of Object.entries(tables)) {
			const ids = [...new Set(rows.filter((entry) => entry.kind === kind).map((entry) => entry.service_id))];
			if (ids.length === 0) continue;
			for (const entry of this.ctx.sqlite
				.query<{ id: string; name: string }, string[]>(`SELECT id, name FROM ${table} WHERE id IN (${ids.map(() => '?').join(', ')})`)
				.all(...ids))
				out.set(entry.id, entry.name);
		}
		return out;
	}

	async #send(row: DrainRow, lines: DrainLine[], batchId: string): Promise<SendResult> {
		let url: URL;
		try {
			url = new URL(row.url);
			await this.#checkEgress(url, row.allow_private_network === 1);
		} catch (error) {
			return { ok: false, status: null, retryable: !(error instanceof EgressError), message: (error as Error).message };
		}
		let headers: Record<string, string> = {};
		try {
			headers = row.headers_sealed ? parseJson<Record<string, string>>(this.ctx.secrets.open(row.org_id, row.headers_sealed), {}) : {};
		} catch {
			return { ok: false, status: null, retryable: false, message: 'The drain’s headers could not be unsealed; set them again.' };
		}
		let body: string;
		let contentType: string;
		if (row.kind === 'otlp') {
			body = JSON.stringify(otlpLogsPayload(lines, { orgId: row.org_id, version: this.version, now: this.ctx.now() }));
			contentType = 'application/json';
		} else if (row.format === 'json') {
			body = JSON.stringify(lines.map((line) => webhookLine(line, row.org_id)));
			contentType = 'application/json';
		} else {
			body = `${lines.map((line) => JSON.stringify(webhookLine(line, row.org_id))).join('\n')}\n`;
			contentType = 'application/x-ndjson';
		}
		const secret = row.signing_secret_sealed ? this.ctx.secrets.open(row.org_id, row.signing_secret_sealed) : undefined;
		let response: Response;
		try {
			response = await this.fetch(url, {
				method: 'POST',
				redirect: 'manual',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: {
					...headers,
					'content-type': contentType,
					'user-agent': `Skiff-Log-Drain/${this.version}`,
					'x-skiff-drain': row.id,
					'x-skiff-batch': batchId,
					...(row.kind === 'webhook' ? signatureHeaders(secret, body, this.ctx.now()) : {}),
				},
				body,
			});
		} catch (error) {
			const message = (error as Error).name === 'TimeoutError' ? `No answer within ${REQUEST_TIMEOUT_MS / 1000} s.` : (error as Error).message;
			return { ok: false, status: null, retryable: true, message: `Could not reach ${url.host}: ${message}` };
		}
		const text = await response.text().catch(() => '');
		if (response.status >= 300 && response.status < 400)
			return { ok: false, status: response.status, retryable: false, message: `The receiver redirected (HTTP ${response.status}); drains don’t follow redirects. Use the final URL.` };
		if (!response.ok) {
			const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
			return {
				ok: false,
				status: response.status,
				retryable: !NON_RETRYABLE.has(response.status),
				message: `${url.host} answered HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`,
			};
		}
		// OTLP partial success: the receiver kept some records and says how many it rejected.
		if (row.kind === 'otlp' && text) {
			const partial = parseJson<{ partialSuccess?: { rejectedLogRecords?: number | string; errorMessage?: string } }>(text, {}).partialSuccess;
			const rejected = Math.min(lines.length, Math.max(0, Number(partial?.rejectedLogRecords ?? 0) || 0));
			if (rejected > 0)
				return {
					ok: true,
					status: response.status,
					rejected,
					message: `The receiver rejected ${rejected} of ${lines.length} line(s)${partial?.errorMessage ? `: ${partial.errorMessage.slice(0, 200)}` : '.'}`,
				};
		}
		return { ok: true, status: response.status, rejected: 0, message: null };
	}

	async #checkEgress(url: URL, allowPrivate: boolean): Promise<void> {
		if (allowPrivate) return;
		if (url.protocol !== 'https:') throw new EgressError('Only https:// drains can be delivered.');
		const host = url.hostname.replace(/^\[|\]$/g, '');
		if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host))
			throw new EgressError(`${host} is a private name. A platform admin can allow private networks for this drain.`);
		const addresses = isIP(host) ? [host] : await this.resolveHost(host);
		if (addresses.length === 0) throw new Error(`${host} did not resolve.`);
		const blocked = addresses.find(isPrivateAddress);
		if (blocked)
			throw new EgressError(`${host} resolves to a private address (${blocked}). A platform admin can allow private networks for this drain.`);
	}

	#view(row: DrainRow): LogDrainView {
		const status: LogDrainView['status'] =
			row.enabled !== 1 ? 'disabled' : row.attempts > 0 || row.failing_since ? 'failing' : row.last_delivered_at ? 'healthy' : 'pending';
		return {
			id: row.id,
			name: row.name,
			kind: row.kind,
			url: maskUrl(row.url),
			format: row.kind === 'webhook' ? row.format : null,
			projectId: row.project_id,
			project: row.project_id ? (this.#projectSlugs([row.project_id]).get(row.project_id) ?? null) : null,
			sources: parseJson<LogDrainSource[]>(row.sources_json, []),
			minLevel: row.min_level,
			headerNames: parseJson<string[]>(row.header_names_json, []),
			signed: row.signing_secret_sealed !== null,
			allowPrivateNetwork: row.allow_private_network === 1,
			enabled: row.enabled === 1,
			status,
			delivery: {
				deliveredLines: row.delivered_lines,
				deliveredBatches: row.delivered_batches,
				droppedLines: row.dropped_lines,
				droppedBatches: row.dropped_batches,
				attempts: row.attempts,
				nextAttemptAt: row.attempts > 0 ? iso(row.next_attempt_at) : null,
				lastDeliveredAt: iso(row.last_delivered_at),
				lastError: row.last_error,
				lastErrorAt: iso(row.last_error_at),
				failingSince: iso(row.failing_since),
			},
			createdAt: new Date(row.created_at).toISOString(),
			updatedAt: new Date(row.updated_at).toISOString(),
		};
	}
}

class EgressError extends Error {}

function newSigningSecret(): string {
	return `whsec_${Buffer.from(randomBytes(24)).toString('base64url')}`;
}

function backoff(attempts: number): number {
	return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

/** OTLP/HTTP posts to `/v1/logs`; a bare origin gets the path added. */
function normalizeUrl(kind: LogDrainKind, raw: string): string {
	const url = new URL(raw.trim());
	if (kind === 'otlp' && (url.pathname === '' || url.pathname === '/')) url.pathname = '/v1/logs';
	return url.toString();
}

/** Query-string values can be credentials (`?api_key=…`); show the names only. */
export function maskUrl(raw: string): string {
	try {
		const url = new URL(raw);
		const keys = [...new Set(url.searchParams.keys())];
		return `${url.origin}${url.pathname}${keys.length ? `?${keys.map((key) => `${encodeURIComponent(key)}=***`).join('&')}` : ''}`;
	} catch {
		return raw;
	}
}

/** Loopback, private, link-local, CGNAT, multicast and reserved ranges, IPv4 and IPv6. */
export function isPrivateAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) {
		const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 0 && c === 0) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224
		);
	}
	if (version === 6) {
		const lower = address.toLowerCase();
		if (lower === '::' || lower === '::1') return true;
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
		if (mapped) return isPrivateAddress(mapped[1]!);
		if (lower.startsWith('::ffff:') || lower.startsWith('64:ff9b:')) return true;
		const first = Number.parseInt(lower.split(':')[0] || '0', 16);
		return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
	}
	return true;
}

/** A webhook line: flat JSON, one object per line in NDJSON. */
export function webhookLine(line: DrainLine, orgId: string): Record<string, unknown> {
	return {
		id: line.id,
		time: new Date(line.ts).toISOString(),
		level: line.level,
		message: line.message,
		source: line.source,
		stream: line.stream,
		org: orgId,
		project: line.project,
		projectId: line.projectId,
		deploymentId: line.deploymentId,
		buildId: line.buildId,
		node: line.nodeId,
		service: line.service,
	};
}

type OtlpValue = { stringValue: string };
type OtlpAttribute = { key: string; value: OtlpValue };
const attr = (key: string, value: string | null | undefined): OtlpAttribute[] => (value ? [{ key, value: { stringValue: value } }] : []);
const nanos = (ms: number): string => (BigInt(Math.max(0, Math.floor(ms))) * 1_000_000n).toString();

/**
 * OTLP/HTTP JSON (`ExportLogsServiceRequest`). One resource per project/deployment or managed
 * service, with semantic-convention attributes (`service.name` is the project slug or service
 * name, as DESIGN §8 uses for metrics).
 */
export function otlpLogsPayload(lines: DrainLine[], options: { orgId: string; version: string; now: number }) {
	const groups = new Map<string, { attributes: OtlpAttribute[]; records: unknown[] }>();
	for (const line of lines) {
		const key = line.service ? `svc:${line.service.id}` : `prj:${line.projectId}:${line.deploymentId ?? ''}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				attributes: [
					...attr('service.name', line.service ? (line.service.name ?? line.service.id) : (line.project ?? line.projectId)),
					...attr('service.namespace', 'skiff'),
					...attr('skiff.org.id', options.orgId),
					...attr('skiff.project.id', line.projectId),
					...attr('deployment.id', line.deploymentId),
					...attr('skiff.service.kind', line.service?.kind),
					...attr('skiff.service.id', line.service?.id),
				],
				records: [],
			};
			groups.set(key, group);
		}
		group.records.push({
			timeUnixNano: nanos(line.ts),
			observedTimeUnixNano: nanos(options.now),
			severityNumber: OTLP_SEVERITY[line.level] ?? 9,
			severityText: line.level.toUpperCase(),
			body: { stringValue: line.message },
			attributes: [
				...attr('log.record.uid', line.id),
				...attr('log.iostream', line.stream === 'stdout' || line.stream === 'stderr' ? line.stream : null),
				...attr('skiff.log.source', line.source),
				...attr('skiff.build.id', line.buildId),
				...attr('host.id', line.nodeId),
			],
		});
	}
	return {
		resourceLogs: [...groups.values()].map((group) => ({
			resource: { attributes: group.attributes },
			scopeLogs: [{ scope: { name: 'skiff.log-drain', version: options.version }, logRecords: group.records }],
		})),
	};
}
