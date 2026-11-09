/**
 * Server errors (docs/SERVER-ERRORS.md, D171): a very small built-in error tracker for the control
 * plane itself, in the spirit of Sentry but with none of its moving parts.
 *
 * - `capture` takes an exception (or a bare 5xx response) with a little request context, scrubs it,
 *   fingerprints it and folds it into an issue. It never throws and never blocks on I/O beyond one
 *   or two SQLite statements, so the request hook and every background loop can call it freely.
 * - Issues group by fingerprint: source + error name + normalised message (ids, numbers and quoted
 *   values masked) + the top application stack frames without line numbers or build hashes, so one
 *   bug stays one issue across requests and releases.
 * - Exact counts are kept per issue and per hour; stored events are sampled (one per issue per
 *   second, a global per-minute budget) and capped at the newest 50 per issue.
 * - A new issue, or a resolved one that happens again, raises the `server_error` system alert
 *   (Alerts → System alerts routes or mutes it), at most ten an hour.
 *
 * Reads need `platform:read` (canView); resolving, ignoring and deleting need platform maintenance.
 */
import type {
	Principal,
	ServerErrorEventView,
	ServerErrorIssueView,
	ServerErrorListQuery,
	ServerErrorListView,
	ServerErrorSource,
	ServerErrorStatus,
} from '@yoal/contracts';
import { serverErrorListQuerySchema, serverErrorStatuses } from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from './errors.ts';
import { newId, parseJson, sha256Hex } from './util.ts';

export const SERVER_ERROR_LIMITS = {
	eventsPerIssue: 50,
	eventRetentionMs: 30 * 24 * 60 * 60 * 1000,
	issueRetentionMs: 90 * 24 * 60 * 60 * 1000,
	/** Store at most one event per issue in this window; later ones only count. */
	sampleWindowMs: 1_000,
	/** Stored events per minute across every issue. */
	eventsPerMinute: 60,
	/** New-issue and regression alerts per hour. */
	alertsPerHour: 10,
	messageLength: 2_000,
	stackLength: 16_000,
} as const;

const HOUR = 60 * 60 * 1000;

export interface ServerErrorCapture {
	source: ServerErrorSource;
	/** The thrown value. Omit for a bare 5xx response and give `name`/`message` instead. */
	error?: unknown;
	name?: string;
	message?: string;
	status?: number | null;
	method?: string | null;
	/** A URL path; anything after `?` or `#` is dropped. */
	path?: string | null;
	routeId?: string | null;
	userId?: string | null;
	orgId?: string | null;
	/** Overrides the derived culprit (a background task name, say). */
	culprit?: string | null;
	context?: Record<string, string | number | boolean | null | undefined>;
}

export interface ServerErrorDetail {
	issue: ServerErrorIssueView;
	events: ServerErrorEventView[];
	/** Hourly counts for the last 24 hours, oldest first. */
	hourly: number[];
	/** Daily counts for the last 14 days, oldest first. */
	daily: number[];
}

interface IssueRow {
	id: string;
	fingerprint: string;
	source: ServerErrorSource;
	name: string;
	message: string;
	culprit: string | null;
	status: ServerErrorStatus;
	event_count: number;
	first_seen_at: number;
	last_seen_at: number;
	first_version: string | null;
	last_version: string | null;
	regressed_at: number | null;
	resolved_at: number | null;
	resolved_by: string | null;
	count_24h?: number | null;
}

interface EventRow {
	id: string;
	issue_id: string;
	at: number;
	message: string;
	stack: string | null;
	method: string | null;
	path: string | null;
	route_id: string | null;
	status: number | null;
	user_id: string | null;
	org_id: string | null;
	version: string | null;
	context_json: string;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------

const SCRUBBERS: Array<[RegExp, string]> = [
	// Credentials in URLs: postgres://user:secret@host → postgres://user:[redacted]@host
	[/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi, '$1:[redacted]@'],
	[/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
	// Yoal keys and common provider tokens.
	[/\b(yoal|sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs])_[A-Za-z0-9_-]{8,}/g, '$1_[redacted]'],
	[/\bAKIA[0-9A-Z]{16}\b/g, '[aws-key]'],
	// key=value and "key": "value" pairs whose name says secret.
	[
		/\b((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|session)["']?\s*[:=]\s*["']?)[^\s"',;&)}\]]+/gi,
		'$1[redacted]',
	],
	// PEM blocks.
	[/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[pem]'],
];

/** Remove credentials from free text before it is stored. */
export function scrubText(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
	return out;
}

/** A path without its query or fragment, with long token-looking segments masked. */
export function scrubPath(path: string | null | undefined): string | null {
	if (!path) return null;
	const bare = path.split(/[?#]/, 1)[0] ?? '';
	return (
		bare
			.split('/')
			.map((segment) => (/^[A-Za-z0-9_.~-]{32,}$/.test(segment) ? ':token' : segment))
			.join('/')
			.slice(0, 512) || '/'
	);
}

/** Mask the parts of a message that vary between occurrences of the same bug. */
export function normalizeMessage(message: string): string {
	return message
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
		.replace(/\b[a-z]{2,6}_[A-Za-z0-9]{6,}\b/g, '<id>')
		.replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
		.replace(/"[^"]{0,200}"|'[^']{0,200}'|`[^`]{0,200}`/g, '<str>')
		.replace(/\b\d+(\.\d+)?\b/g, '<n>')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 500);
}

export interface StackFrame {
	fn: string;
	file: string;
}

/**
 * The application frames of a V8/JSC stack, top first, without line or column numbers, build
 * hashes or the install prefix: `load (routes/projects/+page.server.ts)`. Dependencies and
 * runtime internals are skipped so the fingerprint follows our code, not a library's.
 */
export function appFrames(stack: string | undefined, limit = 3): StackFrame[] {
	if (!stack) return [];
	const frames: StackFrame[] = [];
	for (const line of stack.split('\n')) {
		const match = /^\s*at (?:(.+?) \()?(.+?)(?::\d+)?(?::\d+)?\)?\s*$/.exec(line);
		if (!match) continue;
		const fn = (match[1] ?? '<anonymous>').replace(/^async /, '');
		const raw = match[2] ?? '';
		if (!raw || /node_modules|^node:|^native|^bun:|<anonymous>|internal\//.test(raw)) continue;
		const file = raw
			.replace(/^file:\/\//, '')
			.replace(/\?.*$/, '')
			.replace(/^.*?\/(apps|packages|build|src)\//, '$1/')
			// Vite/Rollup chunk hashes: `chunks/index-B3kd9fQ2.js` → `chunks/index.js`.
			.replace(/[-.][A-Za-z0-9_]{8}(\.m?js)$/, '$1');
		frames.push({ fn, file });
		if (frames.length >= limit) break;
	}
	return frames;
}

function errorParts(input: ServerErrorCapture): { name: string; message: string; stack: string | null } {
	const error = input.error;
	if (error instanceof Error) {
		const name = error.name && error.name !== 'Error' ? error.name : error.constructor?.name || 'Error';
		let stack = error.stack ?? null;
		// Keep the first cause's stack too: wrapped errors are common in the service layer.
		const cause = (error as { cause?: unknown }).cause;
		if (cause instanceof Error && cause.stack) stack = `${stack ?? ''}\nCaused by: ${cause.stack}`;
		return { name, message: error.message || name, stack };
	}
	if (error !== undefined && error !== null) {
		const message = typeof error === 'string' ? error : safeStringify(error);
		return { name: input.name ?? 'NonErrorThrown', message, stack: null };
	}
	return { name: input.name ?? 'Error', message: input.message ?? input.name ?? 'Unknown error', stack: null };
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** The grouping key for an event. Exported for tests. */
export function fingerprintFor(input: ServerErrorCapture): string {
	if (input.source === 'response' && input.error === undefined)
		return sha256Hex(['response', input.status ?? 0, input.method ?? '', input.routeId ?? scrubPath(input.path) ?? ''].join('|')).slice(0, 32);
	const { name, message, stack } = errorParts(input);
	const frames = appFrames(stack ?? undefined).map((frame) => `${frame.fn}@${frame.file}`);
	return sha256Hex(
		[input.source, name, normalizeMessage(scrubText(message)), input.culprit ?? '', ...frames].join('|'),
	).slice(0, 32);
}

function toIssueView(row: IssueRow): ServerErrorIssueView {
	return {
		id: row.id,
		source: row.source,
		name: row.name,
		message: row.message,
		culprit: row.culprit,
		status: row.status,
		count: row.event_count,
		count24h: row.count_24h ?? 0,
		firstSeenAt: row.first_seen_at,
		lastSeenAt: row.last_seen_at,
		firstVersion: row.first_version,
		lastVersion: row.last_version,
		regressedAt: row.regressed_at,
		resolvedAt: row.resolved_at,
		resolvedBy: row.resolved_by,
	};
}

function toEventView(row: EventRow): ServerErrorEventView {
	return {
		id: row.id,
		issueId: row.issue_id,
		at: row.at,
		message: row.message,
		stack: row.stack,
		method: row.method,
		path: row.path,
		routeId: row.route_id,
		status: row.status,
		userId: row.user_id,
		orgId: row.org_id,
		version: row.version,
		context: parseJson<ServerErrorEventView['context']>(row.context_json, {}),
	};
}

function cleanContext(context: ServerErrorCapture['context']): Record<string, string | number | boolean | null> {
	const out: Record<string, string | number | boolean | null> = {};
	if (!context) return out;
	for (const [key, value] of Object.entries(context).slice(0, 20)) {
		if (value === undefined) continue;
		out[key.slice(0, 64)] = typeof value === 'string' ? scrubText(value).slice(0, 500) : value;
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export class ServerErrorService {
	/** fingerprint → when its last event was stored. */
	readonly #lastStored = new Map<string, number>();
	#minute = { start: 0, stored: 0 };
	#alertTimes: number[] = [];
	#capturing = false;

	constructor(
		private readonly ctx: CoreContext,
		private readonly version: string | null = null,
	) {}

	/**
	 * Record one error. Returns its issue and, unless the event was only counted (sampling), the
	 * stored event id; null if recording itself failed. Never throws.
	 */
	capture(input: ServerErrorCapture): { issueId: string; eventId: string | null } | null {
		// An error raised while recording an error is dropped rather than recursing.
		if (this.#capturing) return null;
		this.#capturing = true;
		try {
			return this.#capture(input);
		} catch (cause) {
			console.error('[server-errors] could not record an error:', cause);
			return null;
		} finally {
			this.#capturing = false;
		}
	}

	#capture(input: ServerErrorCapture): { issueId: string; eventId: string | null } {
		const now = this.ctx.now();
		const fingerprint = fingerprintFor(input);
		const parts = errorParts(input);
		const name = parts.name.slice(0, 200);
		const message = scrubText(parts.message).slice(0, SERVER_ERROR_LIMITS.messageLength);
		const stack = parts.stack ? scrubText(parts.stack).slice(0, SERVER_ERROR_LIMITS.stackLength) : null;
		const frames = appFrames(parts.stack ?? undefined, 1);
		const culprit =
			(input.culprit ??
				(input.routeId
					? `${input.method ? `${input.method} ` : ''}${input.routeId}`
					: frames[0]
						? `${frames[0].fn} (${frames[0].file})`
						: null))?.slice(0, 300) ?? null;
		const sqlite = this.ctx.sqlite;

		const existing = sqlite
			.query<Pick<IssueRow, 'id' | 'status'>, [string]>('SELECT id, status FROM server_error_issues WHERE fingerprint = ?')
			.get(fingerprint);
		let issueId: string;
		let alert: 'new' | 'regressed' | null = null;
		if (!existing) {
			issueId = newId('err_');
			sqlite.run(
				`INSERT INTO server_error_issues (id, fingerprint, source, name, message, culprit, status, event_count,
				   first_seen_at, last_seen_at, first_version, last_version)
				 VALUES (?, ?, ?, ?, ?, ?, 'unresolved', 1, ?, ?, ?, ?)
				 ON CONFLICT(fingerprint) DO UPDATE SET event_count = event_count + 1, last_seen_at = excluded.last_seen_at`,
				[issueId, fingerprint, input.source, name, message, culprit, now, now, this.version, this.version],
			);
			// Another process may have inserted it first; read back the winner.
			issueId =
				sqlite.query<{ id: string }, [string]>('SELECT id FROM server_error_issues WHERE fingerprint = ?').get(fingerprint)?.id ?? issueId;
			alert = 'new';
		} else {
			issueId = existing.id;
			const regressed = existing.status === 'resolved';
			sqlite.run(
				`UPDATE server_error_issues SET event_count = event_count + 1, last_seen_at = ?, last_version = ?,
				   message = ?, culprit = COALESCE(?, culprit)
				   ${regressed ? ", status = 'unresolved', regressed_at = ?, resolved_at = NULL, resolved_by = NULL" : ''}
				 WHERE id = ?`,
				regressed ? [now, this.version, message, culprit, now, issueId] : [now, this.version, message, culprit, issueId],
			);
			if (regressed) alert = 'regressed';
		}
		sqlite.run(
			`INSERT INTO server_error_hourly (issue_id, hour, count) VALUES (?, ?, 1)
			 ON CONFLICT(issue_id, hour) DO UPDATE SET count = count + 1`,
			[issueId, Math.floor(now / HOUR) * HOUR],
		);

		if (alert) this.#alert(issueId, alert, name, message, culprit, now);
		if (!this.#shouldStore(fingerprint, now)) return { issueId, eventId: null };

		const eventId = newId('erv_');
		sqlite.run(
			`INSERT INTO server_error_events (id, issue_id, at, message, stack, method, path, route_id, status, user_id, org_id, version, context_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				eventId,
				issueId,
				now,
				message,
				stack,
				input.method?.slice(0, 16) ?? null,
				scrubPath(input.path),
				input.routeId?.slice(0, 300) ?? null,
				input.status ?? null,
				input.userId ?? null,
				input.orgId ?? null,
				this.version,
				JSON.stringify(cleanContext(input.context)),
			],
		);
		sqlite.run(
			`DELETE FROM server_error_events WHERE issue_id = ? AND id NOT IN (
			   SELECT id FROM server_error_events WHERE issue_id = ? ORDER BY at DESC, id DESC LIMIT ?)`,
			[issueId, issueId, SERVER_ERROR_LIMITS.eventsPerIssue],
		);
		return { issueId, eventId };
	}

	#shouldStore(fingerprint: string, now: number): boolean {
		const last = this.#lastStored.get(fingerprint);
		if (last !== undefined && now - last < SERVER_ERROR_LIMITS.sampleWindowMs) return false;
		if (now - this.#minute.start >= 60_000) this.#minute = { start: now, stored: 0 };
		if (this.#minute.stored >= SERVER_ERROR_LIMITS.eventsPerMinute) return false;
		this.#minute.stored++;
		this.#lastStored.set(fingerprint, now);
		if (this.#lastStored.size > 5_000) this.#lastStored.clear();
		return true;
	}

	#alert(issueId: string, kind: 'new' | 'regressed', name: string, message: string, culprit: string | null, now: number): void {
		this.#alertTimes = this.#alertTimes.filter((at) => now - at < HOUR);
		if (this.#alertTimes.length >= SERVER_ERROR_LIMITS.alertsPerHour) return;
		this.#alertTimes.push(now);
		const alerts = this.ctx.alerts;
		if (!alerts) return;
		const origin = this.ctx.config.platformOrigin?.replace(/\/$/, '') ?? '';
		void alerts
			.deliverSystem({
				key: `server_error:${issueId}`,
				title: kind === 'new' ? 'New server error' : 'Server error is back',
				detail: `${name}: ${message.slice(0, 300)}${culprit ? `\nIn ${culprit}` : ''}${kind === 'regressed' ? '\nIt was marked resolved and happened again.' : ''}`,
				severity: 'warning',
				url: origin ? `${origin}/settings/errors/${issueId}` : undefined,
			})
			.catch(() => undefined);
	}

	// -------------------------------------------------------------------------------------------
	// Reads
	// -------------------------------------------------------------------------------------------

	#requireRead(principal: Principal): void {
		if (!this.ctx.platformIam.canView(principal))
			throw new ForbiddenError('platform:read', 'server errors are platform-wide');
	}

	#requireWrite(principal: Principal): void {
		if (!this.ctx.platformIam.canMaintain(principal))
			throw new ForbiddenError('platform:maintenance', 'only a platform admin can change server errors');
	}

	list(principal: Principal, query: ServerErrorListQuery = {}): ServerErrorListView {
		this.#requireRead(principal);
		const parsed = serverErrorListQuerySchema.safeParse(query);
		if (!parsed.success) throw new ValidationError('Invalid server error filters.', parsed.error.issues);
		const { status, source, q, before, limit } = parsed.data;
		const now = this.ctx.now();
		const since = Math.floor(now / HOUR) * HOUR - 23 * HOUR;

		const where: string[] = [];
		const params: Array<string | number> = [];
		if (status !== 'all') {
			where.push('i.status = ?');
			params.push(status);
		}
		if (source) {
			where.push('i.source = ?');
			params.push(source);
		}
		if (q) {
			where.push("(i.name LIKE ? ESCAPE '\\' OR i.message LIKE ? ESCAPE '\\' OR i.culprit LIKE ? ESCAPE '\\' OR i.id = ?)");
			const like = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
			params.push(like, like, like, q);
		}
		if (before) {
			where.push('i.last_seen_at < ?');
			params.push(before);
		}
		const rows = this.ctx.sqlite
			.query<IssueRow, Array<string | number>>(
				`SELECT i.*, (SELECT COALESCE(SUM(h.count), 0) FROM server_error_hourly h WHERE h.issue_id = i.id AND h.hour >= ?) AS count_24h
				 FROM server_error_issues i
				 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
				 ORDER BY i.last_seen_at DESC, i.id DESC
				 LIMIT ?`,
			)
			.all(since, ...params, limit + 1);
		const page = rows.slice(0, limit);

		const counts = this.ctx.sqlite
			.query<{ status: ServerErrorStatus; n: number }, []>('SELECT status, COUNT(*) AS n FROM server_error_issues GROUP BY status')
			.all();
		const summary = { unresolved: 0, resolved: 0, ignored: 0, events24h: 0 };
		for (const row of counts) summary[row.status] = row.n;

		const hourly = this.#buckets(
			this.ctx.sqlite
				.query<{ hour: number; n: number }, [number]>('SELECT hour, SUM(count) AS n FROM server_error_hourly WHERE hour >= ? GROUP BY hour')
				.all(since),
			since,
			HOUR,
			24,
		);
		summary.events24h = hourly.reduce((total, value) => total + value, 0);
		return {
			issues: page.map(toIssueView),
			summary,
			hourly,
			nextBefore: rows.length > limit ? (page.at(-1)?.last_seen_at ?? null) : null,
		};
	}

	get(principal: Principal, issueId: string): ServerErrorDetail {
		this.#requireRead(principal);
		const now = this.ctx.now();
		const hourStart = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
		const row = this.ctx.sqlite
			.query<IssueRow, [number, string]>(
				`SELECT i.*, (SELECT COALESCE(SUM(h.count), 0) FROM server_error_hourly h WHERE h.issue_id = i.id AND h.hour >= ?) AS count_24h
				 FROM server_error_issues i WHERE i.id = ?`,
			)
			.get(hourStart, issueId);
		if (!row) throw new NotFoundError(`Server error ${issueId}`);
		const events = this.ctx.sqlite
			.query<EventRow, [string, number]>('SELECT * FROM server_error_events WHERE issue_id = ? ORDER BY at DESC, id DESC LIMIT ?')
			.all(issueId, SERVER_ERROR_LIMITS.eventsPerIssue)
			.map(toEventView);
		const hours = this.ctx.sqlite
			.query<{ hour: number; n: number }, [string, number]>('SELECT hour, count AS n FROM server_error_hourly WHERE issue_id = ? AND hour >= ?')
			.all(issueId, Math.floor(now / HOUR) * HOUR - 14 * 24 * HOUR);
		const day = 24 * HOUR;
		const dayStart = Math.floor(now / day) * day - 13 * day;
		return {
			issue: toIssueView(row),
			events,
			hourly: this.#buckets(hours, hourStart, HOUR, 24),
			daily: this.#buckets(hours, dayStart, day, 14),
		};
	}

	#buckets(rows: Array<{ hour: number; n: number }>, start: number, size: number, count: number): number[] {
		const out = new Array<number>(count).fill(0);
		for (const row of rows) {
			const index = Math.floor((row.hour - start) / size);
			if (index >= 0 && index < count) out[index]! += row.n;
		}
		return out;
	}

	// -------------------------------------------------------------------------------------------
	// Writes
	// -------------------------------------------------------------------------------------------

	setStatus(principal: Principal, issueIds: readonly string[], status: ServerErrorStatus): number {
		this.#requireWrite(principal);
		if (!(serverErrorStatuses as readonly string[]).includes(status))
			throw new ValidationError(`"${status}" is not a server error status.`);
		const ids = [...new Set(issueIds)].slice(0, 500);
		if (ids.length === 0) return 0;
		const now = this.ctx.now();
		const placeholders = ids.map(() => '?').join(', ');
		const result =
			status === 'resolved'
				? this.ctx.sqlite.run(
						`UPDATE server_error_issues SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id IN (${placeholders})`,
						[now, principal.userId ?? null, ...ids],
					)
				: this.ctx.sqlite.run(
						`UPDATE server_error_issues SET status = ?, resolved_at = NULL, resolved_by = NULL WHERE id IN (${placeholders})`,
						[status, ...ids],
					);
		this.ctx.audit.record({
			principal,
			action: 'server_errors.update',
			resource: 'platform',
			args: { status, issues: ids.length },
			result: 'ok',
		});
		return result.changes;
	}

	delete(principal: Principal, issueIds: readonly string[]): number {
		this.#requireWrite(principal);
		const ids = [...new Set(issueIds)].slice(0, 500);
		if (ids.length === 0) return 0;
		const placeholders = ids.map(() => '?').join(', ');
		let changes = 0;
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run(`DELETE FROM server_error_events WHERE issue_id IN (${placeholders})`, ids);
			this.ctx.sqlite.run(`DELETE FROM server_error_hourly WHERE issue_id IN (${placeholders})`, ids);
			changes = this.ctx.sqlite.run(`DELETE FROM server_error_issues WHERE id IN (${placeholders})`, ids).changes;
		})();
		this.ctx.audit.record({
			principal,
			action: 'server_errors.delete',
			resource: 'platform',
			args: { issues: ids.length },
			result: 'ok',
		});
		return changes;
	}

	/** Maintenance sweep: drop old events, hourly counts and issues nobody has seen in a while. */
	prune(now = this.ctx.now()): { events: number; issues: number } {
		const sqlite = this.ctx.sqlite;
		const eventCutoff = now - SERVER_ERROR_LIMITS.eventRetentionMs;
		const issueCutoff = now - SERVER_ERROR_LIMITS.issueRetentionMs;
		const events = sqlite.run('DELETE FROM server_error_events WHERE at < ?', [eventCutoff]).changes;
		sqlite.run('DELETE FROM server_error_hourly WHERE hour < ?', [eventCutoff]);
		const stale = sqlite
			.query<{ id: string }, [number]>('SELECT id FROM server_error_issues WHERE last_seen_at < ?')
			.all(issueCutoff)
			.map((row) => row.id);
		for (const id of stale) {
			sqlite.run('DELETE FROM server_error_events WHERE issue_id = ?', [id]);
			sqlite.run('DELETE FROM server_error_hourly WHERE issue_id = ?', [id]);
			sqlite.run('DELETE FROM server_error_issues WHERE id = ?', [id]);
		}
		return { events, issues: stale.length };
	}
}

