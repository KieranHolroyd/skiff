/**
 * App errors (docs/APP-ERRORS.md): the app-facing error tracker.
 *
 * Ingest is Sentry-compatible at the edge: the control plane exposes
 * `POST /ingest/api/<numeric-dsn-id>/{envelope,store}/`, accepts the Sentry auth forms
 * SDKs use, and normalises envelope/store payloads into one internal event. Everything after that
 * is Yoal: SQLite rows, organization permissions, the audit log and the top-level Errors page.
 *
 * A target is a linked Yoal project or a standalone off-platform app. Auto-linking creates targets
 * for every project in an organization; a target can also be linked by hand or created standalone,
 * and each has its own DSN, issues, events and usage.
 *
 * Stored events are sampled (one per issue per second, 500 per project per minute) and capped at
 * 50 per issue; counts are exact. Messages, stacks, tags and extra are scrubbed with the same
 * credential scrubbers as server errors. Request headers, cookies, bodies and query strings are
 * never stored, and user email/IP are dropped.
 *
 * The public DSN uses a numeric `dsn_project_id`, not Yoal's `prj_…` id, because the Sentry SDKs
 * validate the project id as a number (the JavaScript SDK rejects `prj_…` outright).
 */
import type {
	AppErrorDetail,
	AppErrorEventView,
	AppErrorExceptionView,
	AppErrorFrameView,
	AppErrorIssueView,
	AppErrorLevel,
	AppErrorListView,
	AppErrorListQuery,
	AppErrorServiceView,
	AppErrorSettingsView,
	AppErrorSettingsUpdate,
	AppErrorStatus,
	AppErrorStatusUpdate,
	AppErrorTargetCreate,
	AppErrorTargetKind,
	AppErrorTargetUpdate,
	AppErrorTargetView,
	AppErrorUsageView,
	Principal,
} from '@yoal/contracts';
import {
	APP_ERROR_MONTHLY_LIMIT,
	appErrorLevels,
	appErrorListQuerySchema,
	appErrorSettingsUpdateSchema,
	appErrorStatuses,
	appErrorStatusUpdateSchema,
	appErrorTargetCreateSchema,
	appErrorTargetUpdateSchema,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { NotFoundError, ValidationError } from './errors.ts';
import { normalizeMessage, scrubPath, scrubText } from './server-errors.ts';
import { newId, parseJson, sha256Hex } from './util.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const KEY_GRACE_MS = 24 * HOUR;
const EVENT_RETENTION_MS = 30 * DAY;
const ISSUE_RETENTION_MS = 90 * DAY;
const USAGE_RETENTION_MONTHS = 13;

export const APP_ERROR_LIMITS = {
	eventsPerIssue: 50,
	sampleWindowMs: 1_000,
	eventsPerProjectMinute: 500,
	eventsPerMinute: 5_000,
	requestsPerMinute: 600,
	requestBurst: 50,
	monthlyEvents: APP_ERROR_MONTHLY_LIMIT,
	alertsPerHour: 10,
	messageLength: 2_000,
	stackLength: 16_000,
	payloadBytes: 1024 * 1024,
	eventBytes: 512 * 1024,
} as const;

export interface AppErrorProjectRef {
	id: string;
	slug: string;
	name: string;
	/** Present when the caller has the project row; used to backfill a target's organisation. */
	orgId?: string;
}

interface TargetMetadata {
	id: string;
	name: string;
	kind: AppErrorTargetKind;
	projectSlug: string | null;
}

export interface AppErrorIngestInput {
	dsnProjectId: string;
	endpoint: 'envelope' | 'store';
	body: Uint8Array;
	headerKey?: string | null;
	queryKey?: string | null;
}

export type AppErrorIngestOutcome =
	| { status: 200; eventId: string | null; ignored: number }
	| { status: 400 | 401 | 413 | 429; error: string; retryAfter?: number; rateLimit?: string };

export interface AppErrorTestResult {
	issueId: string;
	eventId: string;
}

/** A single Sentry event is over the per-event cap (as opposed to a whole envelope). */
export class AppErrorPayloadTooLarge extends Error {
	constructor() {
		super('Sentry event is too large.');
		this.name = 'AppErrorPayloadTooLarge';
	}
}

interface ProjectRow {
	dsn_project_id: number;
	project_id: string;
	org_id: string | null;
	name: string | null;
	kind: AppErrorTargetKind;
	auto_linked: number;
	enabled: number;
	sample_rate: number;
	notify: number;
	created_at: number;
	updated_at: number;
}

interface IssueRow {
	id: string;
	project_id: string;
	fingerprint: string;
	platform: string;
	environment: string;
	name: string;
	message: string;
	culprit: string | null;
	level: string;
	status: AppErrorStatus;
	event_count: number;
	first_seen_at: number;
	last_seen_at: number;
	first_release: string | null;
	last_release: string | null;
	regressed_at: number | null;
	resolved_at: number | null;
	resolved_by: string | null;
	count_24h?: number | null;
}

interface EventRow {
	id: string;
	issue_id: string;
	event_id: string;
	at: number;
	level: string;
	message: string;
	exceptions_json: string;
	method: string | null;
	path: string | null;
	release: string | null;
	environment: string | null;
	tags_json: string;
	contexts_json: string;
	extra_json: string | null;
	user_id: string | null;
	platform: string | null;
	sdk: string | null;
}

interface NormalizedEvent {
	eventId: string;
	at: number;
	level: AppErrorLevel;
	name: string;
	message: string;
	culprit: string | null;
	platform: string;
	environment: string;
	release: string | null;
	fingerprint: string;
	exceptions: AppErrorExceptionView[];
	method: string | null;
	path: string | null;
	tags: Record<string, string>;
	contexts: Record<string, string>;
	extra: unknown;
	userId: string | null;
	sdk: string | null;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, limit = 2_000): string {
	return typeof value === 'string' ? value.slice(0, limit) : '';
}

function int(value: unknown): number | null {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function eventId(value: unknown): string {
	const raw = typeof value === 'string' ? value.replace(/-/g, '') : '';
	return /^[0-9a-f]{32}$/i.test(raw) ? raw.toLowerCase() : newId('').toLowerCase();
}

/** Sentry sends `exception` as `{ values: [...] }` (JS/PHP/Python) or a bare array (Go). */
export function exceptionValues(event: Record<string, unknown>): Array<Record<string, unknown>> {
	const exception = event.exception;
	if (Array.isArray(exception)) return exception.filter((value): value is Record<string, unknown> => record(value) !== null);
	const values = record(exception)?.values;
	return Array.isArray(values) ? values.filter((value): value is Record<string, unknown> => record(value) !== null) : [];
}

function stackFrames(exception: Record<string, unknown> | undefined, event: Record<string, unknown>): Array<Record<string, unknown>> {
	const direct = record(exception?.stacktrace)?.frames;
	if (Array.isArray(direct)) return direct.filter((value): value is Record<string, unknown> => record(value) !== null);
	const threads = event.threads;
	if (Array.isArray(threads)) {
		const crashed = threads.find((thread) => record(thread)?.crashed === true) ?? threads.find((thread) => record(thread)?.current === true);
		const frames = record(record(crashed)?.stacktrace)?.frames;
		if (Array.isArray(frames)) return frames.filter((value): value is Record<string, unknown> => record(value) !== null);
	}
	return [];
}

function normalizeFile(value: unknown): string {
	const file = str(value, 500)
		.replace(/^file:\/\//, '')
		.replace(/[?#].*$/, '')
		.replace(/^.*?\/(apps|packages|build|src)\//, '$1/')
		.replace(/[-.][A-Za-z0-9_]{8}(\.m?js)$/, '$1');
	return scrubText(file);
}

function normalizeFrame(frame: Record<string, unknown>): AppErrorFrameView {
	return {
		fn: scrubText(str(frame.function, 200) || '<anonymous>').replace(/^async /, ''),
		file: normalizeFile(frame.filename ?? frame.abs_path),
		line: int(frame.lineno),
		column: int(frame.colno),
		inApp: frame.in_app !== false,
	};
}

/** Frames arrive oldest-to-newest in Sentry; store and display top-first. */
function normalizeFrames(frames: Array<Record<string, unknown>>, limit = 100): AppErrorFrameView[] {
	return frames.slice(-limit).map(normalizeFrame).reverse();
}

/**
 * Keep the whole exception chain under the stack budget. Frames are top-first, so trimming the
 * tail drops the oldest callers (the least useful ones); only then are the values shortened.
 */
function capStack(exceptions: AppErrorExceptionView[]): AppErrorExceptionView[] {
	let size = JSON.stringify(exceptions).length;
	for (const exception of exceptions) {
		while (size > APP_ERROR_LIMITS.stackLength && exception.frames.length > 0) {
			exception.frames.pop();
			size = JSON.stringify(exceptions).length;
		}
	}
	for (const exception of exceptions) {
		while (size > APP_ERROR_LIMITS.stackLength && exception.value.length > 0) {
			const over = size - APP_ERROR_LIMITS.stackLength;
			exception.value = exception.value.slice(0, Math.max(0, exception.value.length - over - 1));
			size = JSON.stringify(exceptions).length;
		}
	}
	return exceptions;
}

function isLibraryFrame(frame: AppErrorFrameView): boolean {
	return (
		!frame.file ||
		/node_modules|node:|bun:|^native$|internal\//.test(frame.file) ||
		/^chrome-extension:|^moz-extension:/.test(frame.file)
	);
}

function normalizeCulprit(value: string): string {
	return scrubText(value)
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
		.replace(/\b[a-z]{2,6}_[A-Za-z0-9]{6,}\b/g, '<id>')
		.replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
		.replace(/\b\d+\b/g, '<n>')
		.slice(0, 300);
}

/** The grouping key for an app error. Exported for tests. */
export function appErrorFingerprint(input: {
	platform: string;
	environment: string;
	name: string;
	message: string;
	culprit: string | null;
	frames: AppErrorFrameView[];
	fingerprint?: unknown;
}): string {
	const frames = input.frames.filter((frame) => frame.inApp && !isLibraryFrame(frame)).slice(0, 3);
	const base = [
		input.platform,
		input.environment,
		input.name,
		normalizeMessage(scrubText(input.message)),
		input.culprit ? normalizeCulprit(input.culprit) : '',
		...frames.map((frame) => `${frame.fn}@${frame.file}`),
	].join('|');

	const custom = Array.isArray(input.fingerprint) ? input.fingerprint : null;
	if (!custom || custom.length === 0) return sha256Hex(base).slice(0, 32);
	const resolved = custom.map((part) => {
		const text = typeof part === 'string' ? part : String(part);
		if (text === '{{ default }}') return base;
		if (text === '{{ transaction }}') return input.culprit ?? '';
		if (text === '{{ error.type }}') return input.name;
		if (text === '{{ error.value }}') return normalizeMessage(scrubText(input.message));
		return text;
	});
	return sha256Hex(resolved.join('|')).slice(0, 32);
}

function normalizeTags(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	const entries = Array.isArray(value)
		? value
				.map((item) => (Array.isArray(item) && item.length >= 2 ? [item[0], item[1]] : null))
				.filter((item): item is [unknown, unknown] => item !== null)
		: Object.entries(record(value) ?? {});
	for (const [key, tagValue] of entries.slice(0, 20)) {
		const name = str(key, 64);
		if (!name) continue;
		out[name] = scrubText(str(tagValue, 200));
	}
	return out;
}

function normalizeContexts(value: unknown): Record<string, string> {
	const contexts = record(value) ?? {};
	const out: Record<string, string> = {};
	for (const key of ['browser', 'os', 'runtime'] as const) {
		const context = record(contexts[key]);
		if (!context) continue;
		const name = str(context.name, 60);
		const version = str(context.version, 60);
		if (name) out[key] = scrubText(version ? `${name} ${version}` : name);
	}
	return out;
}

function scrubValue(value: unknown, depth = 0): unknown {
	if (depth > 3) return undefined;
	if (typeof value === 'string') return scrubText(value.slice(0, 1_000));
	if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrubValue(item, depth + 1));
	const object = record(value);
	if (!object) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(object).slice(0, 20)) {
		const name = scrubText(key.slice(0, 64));
		if (/(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|session)/i.test(name)) {
			out[name] = '[redacted]';
			continue;
		}
		out[name] = scrubValue(item, depth + 1);
	}
	return out;
}

function normalizeExtra(value: unknown): unknown {
	if (value === undefined || value === null) return null;
	try {
		const json = JSON.stringify(scrubValue(value));
		return json && json.length <= 4_096 ? JSON.parse(json) : null;
	} catch {
		return null;
	}
}

function normalizeTimestamp(value: unknown, now: number): number {
	let at = Number.NaN;
	if (typeof value === 'number') at = value > 1e12 ? value : value * 1000;
	else if (typeof value === 'string') {
		const numeric = Number(value);
		at = Number.isFinite(numeric) ? (numeric > 1e12 ? numeric : numeric * 1000) : Date.parse(value);
	}
	if (!Number.isFinite(at)) return now;
	return Math.min(now + HOUR, Math.max(now - HOUR, Math.trunc(at)));
}

function normalizeLevel(value: unknown): AppErrorLevel {
	const level = str(value, 16).toLowerCase();
	return (appErrorLevels as readonly string[]).includes(level) ? (level as AppErrorLevel) : 'error';
}

function messageOf(event: Record<string, unknown>): string {
	const message = event.message;
	if (typeof message === 'string') return message;
	const formatted = record(message)?.formatted;
	if (typeof formatted === 'string') return formatted;
	const logentry = record(event.logentry)?.formatted;
	return typeof logentry === 'string' ? logentry : '';
}

/** Normalise one Sentry event into what the tracker stores. Exported for tests. */
export function normalizeSentryEvent(
	event: Record<string, unknown>,
	envelopeHeader: Record<string, unknown> | null,
	now: number,
): NormalizedEvent {
	const values = exceptionValues(event);
	const last = values.at(-1);
	const exceptions: AppErrorExceptionView[] = values.map((value) => ({
		type: scrubText(str(value.type, 200) || 'Error'),
		value: scrubText(str(value.value, APP_ERROR_LIMITS.messageLength) || 'Unknown error'),
		frames: normalizeFrames(stackFrames(value, event)),
	}));
	capStack(exceptions);
	const rawMessage = messageOf(event);
	const fallback = last ? str(last.value, APP_ERROR_LIMITS.messageLength) : rawMessage;
	const name = last ? scrubText(str(last.type, 200) || 'Error') : 'Message';
	const message = scrubText(fallback || rawMessage || name).slice(0, APP_ERROR_LIMITS.messageLength);
	const platform = str(event.platform, 40) || 'other';
	const environment = str(event.environment, 40) || 'production';
	const release = str(event.release, 200) || null;
	const primary = exceptions.at(-1);
	const topFrame = primary?.frames.find((frame) => frame.inApp && !isLibraryFrame(frame)) ?? primary?.frames[0];
	const transaction = str(event.transaction, 300);
	const culpritRaw = transaction || (topFrame ? `${topFrame.fn} (${topFrame.file || 'unknown'})` : '');
	const culprit = culpritRaw ? normalizeCulprit(culpritRaw) : null;
	const request = record(event.request);
	const url = str(request?.url, 1_000);
	const path = url ? scrubPath(url.startsWith('http') ? (() => { try { return new URL(url).pathname; } catch { return url; } })() : url) : null;
	const sdk = record(event.sdk);
	const sdkName = str(sdk?.name, 60);
	const sdkVersion = str(sdk?.version, 60);
	const userId = str(record(event.user)?.id, 200) || null;

	return {
		eventId: eventId(envelopeHeader?.event_id ?? event.event_id),
		at: normalizeTimestamp(event.timestamp ?? envelopeHeader?.sent_at, now),
		level: normalizeLevel(event.level),
		name,
		message,
		culprit,
		platform,
		environment,
		release,
		fingerprint: appErrorFingerprint({
			platform,
			environment,
			name,
			message,
			culprit,
			frames: primary?.frames ?? [],
			fingerprint: event.fingerprint,
		}),
		exceptions,
		method: str(request?.method, 16) || null,
		path,
		tags: normalizeTags(event.tags),
		contexts: normalizeContexts(event.contexts),
		extra: normalizeExtra(event.extra),
		userId,
		sdk: sdkName ? `${sdkName}${sdkVersion ? `/${sdkVersion}` : ''}` : null,
	};
}

/** Extract `sentry_key` from an `X-Sentry-Auth` header. */
export function authHeaderKey(value: string | null | undefined): string | null {
	if (!value) return null;
	for (const part of value.replace(/^Sentry\s+/i, '').split(',')) {
		const [name, ...rest] = part.trim().split('=');
		if (name?.toLowerCase() === 'sentry_key') return rest.join('=').trim() || null;
	}
	return null;
}

/** Extract the public key from an envelope's `dsn` header. */
export function dsnKey(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value);
		return decodeURIComponent(url.username) || null;
	} catch {
		return null;
	}
}

export interface ParsedEnvelope {
	header: Record<string, unknown> | null;
	event: Record<string, unknown> | null;
	ignored: string[];
}

/** Parse a Sentry envelope on bytes: `length` is bytes, and a payload may be any UTF-8. */
export function parseSentryEnvelope(body: Uint8Array): ParsedEnvelope {
	const buffer = Buffer.from(body);
	const readLine = (offset: number): { line: string; next: number } => {
		const end = buffer.indexOf(0x0a, offset);
		if (end === -1) return { line: buffer.subarray(offset).toString('utf8'), next: buffer.length };
		return { line: buffer.subarray(offset, end).toString('utf8'), next: end + 1 };
	};
	const first = readLine(0);
	let header: Record<string, unknown> | null = null;
	try {
		header = record(JSON.parse(first.line));
	} catch {
		throw new ValidationError('Malformed Sentry envelope header.');
	}
	const ignored: string[] = [];
	let event: Record<string, unknown> | null = null;
	let offset = first.next;
	while (offset < buffer.length) {
		if (buffer[offset] === 0x0a) {
			offset++;
			continue;
		}
		const line = readLine(offset);
		let itemHeader: Record<string, unknown>;
		try {
			const parsed = record(JSON.parse(line.line));
			if (!parsed) throw new Error('not an object');
			itemHeader = parsed;
		} catch {
			throw new ValidationError('Malformed Sentry envelope item header.');
		}
		offset = line.next;
		const length = typeof itemHeader.length === 'number' ? itemHeader.length : null;
		let payload: Buffer;
		if (length !== null && Number.isFinite(length) && length >= 0) {
			if (offset + length > buffer.length) throw new ValidationError('Truncated Sentry envelope item.');
			payload = buffer.subarray(offset, offset + length);
			offset += length;
			if (buffer[offset] === 0x0a) offset++;
		} else {
			const implicit = readLine(offset);
			payload = Buffer.from(implicit.line, 'utf8');
			offset = implicit.next;
		}
		const type = str(itemHeader.type, 40) || 'unknown';
		if (type === 'event') {
			if (payload.byteLength > APP_ERROR_LIMITS.eventBytes) throw new AppErrorPayloadTooLarge();
			try {
				const parsed = record(JSON.parse(payload.toString('utf8')));
				if (!parsed) throw new Error('not an object');
				event = parsed;
			} catch {
				throw new ValidationError('Malformed Sentry event item.');
			}
		} else {
			ignored.push(type);
		}
	}
	return { header, event, ignored };
}

function toUsage(projectId: string, month: string, row: { accepted?: number; dropped?: number; ignored?: number } | undefined): AppErrorUsageView {
	return {
		month,
		accepted: row?.accepted ?? 0,
		dropped: row?.dropped ?? 0,
		ignored: row?.ignored ?? 0,
		limit: APP_ERROR_LIMITS.monthlyEvents,
	};
}

function monthKey(now: number): string {
	return new Date(now).toISOString().slice(0, 7);
}

function toIssueView(row: IssueRow, target?: TargetMetadata | null): AppErrorIssueView {
	return {
		id: row.id,
		projectId: row.project_id,
		...(target
			? {
					targetId: target.id,
					targetName: target.name,
					targetKind: target.kind,
					projectSlug: target.projectSlug,
				}
			: {}),
		platform: row.platform,
		environment: row.environment,
		name: row.name,
		message: row.message,
		culprit: row.culprit,
		level: (appErrorLevels as readonly string[]).includes(row.level) ? (row.level as AppErrorLevel) : 'error',
		status: row.status,
		count: row.event_count,
		count24h: row.count_24h ?? 0,
		firstSeenAt: row.first_seen_at,
		lastSeenAt: row.last_seen_at,
		firstRelease: row.first_release,
		lastRelease: row.last_release,
		regressedAt: row.regressed_at,
		resolvedAt: row.resolved_at,
		resolvedBy: row.resolved_by,
	};
}

function toEventView(row: EventRow): AppErrorEventView {
	return {
		id: row.id,
		issueId: row.issue_id,
		eventId: row.event_id,
		at: row.at,
		level: (appErrorLevels as readonly string[]).includes(row.level) ? (row.level as AppErrorLevel) : 'error',
		message: row.message,
		exceptions: parseJson<AppErrorExceptionView[]>(row.exceptions_json, []),
		method: row.method,
		path: row.path,
		release: row.release,
		environment: row.environment,
		tags: parseJson<Record<string, string>>(row.tags_json, {}),
		contexts: parseJson<Record<string, string>>(row.contexts_json, {}),
		extra: parseJson<unknown>(row.extra_json, null),
		userId: row.user_id,
		platform: row.platform,
		sdk: row.sdk,
	};
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export class AppErrorService {
	/** fingerprint → when its last event was stored. */
	readonly #lastStored = new Map<string, number>();
	/** project → { minute, stored }. */
	readonly #projectMinute = new Map<string, { start: number; stored: number }>();
	#minute = { start: 0, stored: 0 };
	readonly #buckets = new Map<string, { tokens: number; at: number }>();
	readonly #globalMinute = { start: 0, accepted: 0 };
	readonly #keyTouched = new Map<string, number>();
	readonly #alertTimes = new Map<string, number[]>();
	readonly #droppedAt = new Map<string, number>();

	constructor(
		private readonly ctx: CoreContext,
		private readonly version: string | null = null,
	) {}

	// --- permissions ---------------------------------------------------------------------------

	#requireRead(principal: Principal, project: AppErrorProjectRef): void {
		this.ctx.iam.require(principal, 'project:read', { type: 'project', id: project.id });
	}

	#requireWrite(principal: Principal, project: AppErrorProjectRef): void {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
	}

	#requireOrgRead(principal: Principal): void {
		this.ctx.iam.require(principal, 'project:read', { type: 'org' });
	}

	#requireOrgWrite(principal: Principal): void {
		this.ctx.iam.require(principal, 'project:update', { type: 'org' });
	}

	/** A target is visible only to its organisation, and a linked one also needs project access. */
	#requireTargetRead(principal: Principal, row: ProjectRow): void {
		if (!row.org_id || row.org_id !== principal.orgId) throw new NotFoundError('App error target');
		if (row.kind === 'project')
			this.ctx.iam.require(principal, 'project:read', { type: 'project', id: row.project_id });
		else this.#requireOrgRead(principal);
	}

	#requireTargetWrite(principal: Principal, row: ProjectRow): void {
		if (!row.org_id || row.org_id !== principal.orgId) throw new NotFoundError('App error target');
		if (row.kind === 'project')
			this.ctx.iam.require(principal, 'project:update', { type: 'project', id: row.project_id });
		else this.#requireOrgWrite(principal);
	}

	#usageFor(projectId: string): AppErrorUsageView {
		const now = this.ctx.now();
		const month = monthKey(now);
		const row = this.ctx.sqlite
			.query<{ accepted: number; dropped: number; ignored: number }, [string, string]>(
				'SELECT accepted, dropped, ignored FROM app_error_usage WHERE project_id = ? AND month = ?',
			)
			.get(projectId, month);
		return toUsage(projectId, month, row ?? undefined);
	}

	#settingsView(project: AppErrorProjectRef): AppErrorSettingsView {
		const row = this.#projectRow(project.id);
		const now = this.ctx.now();
		const month = monthKey(now);
		const usageRow = this.ctx.sqlite
			.query<{ accepted: number; dropped: number; ignored: number }, [string, string]>(
				'SELECT accepted, dropped, ignored FROM app_error_usage WHERE project_id = ? AND month = ?',
			)
			.get(project.id, month);
		const usage = toUsage(project.id, month, usageRow ?? undefined);
		if (!row || !row.enabled) {
			return { enabled: false, dsn: null, publicKey: null, sampleRate: row?.sample_rate ?? 1, notify: row?.notify === 1, usage };
		}
		const key = this.#activeKey(project.id);
		return {
			enabled: true,
			dsn: key ? this.#dsn(row, key.public_key) : null,
			publicKey: key?.public_key ?? null,
			sampleRate: row.sample_rate,
			notify: row.notify === 1,
			usage,
		};
	}

	settings(principal: Principal, project: AppErrorProjectRef): AppErrorSettingsView {
		this.#requireRead(principal, project);
		return this.#settingsView(project);
	}

	enable(principal: Principal, project: AppErrorProjectRef): AppErrorSettingsView {
		this.#requireWrite(principal, project);
		const now = this.ctx.now();
		const row = this.#projectRow(project.id);
		const orgId = project.orgId ?? this.#projectOrgId(project.id);
		if (row) {
			this.ctx.sqlite.run(
				`UPDATE app_error_projects SET enabled = 1, org_id = COALESCE(org_id, ?), name = COALESCE(name, ?),
				   kind = 'project', updated_at = ? WHERE project_id = ?`,
				[orgId, project.name, now, project.id],
			);
		} else {
			this.ctx.sqlite.run(
				`INSERT INTO app_error_projects
				   (project_id, org_id, name, kind, auto_linked, enabled, sample_rate, notify, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', 0, 1, 1, 0, ?, ?)`,
				[project.id, orgId, project.name, now, now],
			);
		}
		if (!this.#activeKey(project.id)) this.#createKey(project.id, now);
		this.ctx.audit.record({
			principal,
			action: 'app_errors.enable',
			resource: 'project',
			resourceId: project.id,
			args: { project: project.slug },
			result: 'ok',
		});
		return this.#settingsView(project);
	}

	updateSettings(principal: Principal, project: AppErrorProjectRef, input: AppErrorSettingsUpdate): AppErrorSettingsView {
		this.#requireWrite(principal, project);
		const parsed = appErrorSettingsUpdateSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid app error settings.', parsed.error.issues);
		const now = this.ctx.now();
		const row = this.#projectRow(project.id);
		if (!row) {
			if (parsed.data.enabled === false) return this.#settingsView(project);
			return this.enable(principal, project);
		}
		const enabled = parsed.data.enabled === undefined ? row.enabled : parsed.data.enabled ? 1 : 0;
		const sampleRate = parsed.data.sampleRate ?? row.sample_rate;
		const notify = parsed.data.notify === undefined ? row.notify : parsed.data.notify ? 1 : 0;
		this.ctx.sqlite.run(
			'UPDATE app_error_projects SET enabled = ?, sample_rate = ?, notify = ?, updated_at = ? WHERE project_id = ?',
			[enabled, sampleRate, notify, now, project.id],
		);
		if (enabled && !this.#activeKey(project.id)) this.#createKey(project.id, now);
		this.ctx.audit.record({
			principal,
			action: 'app_errors.settings',
			resource: 'project',
			resourceId: project.id,
			args: { enabled: enabled === 1, sampleRate, notify: notify === 1 },
			result: 'ok',
		});
		return this.#settingsView(project);
	}

	rotateKey(principal: Principal, project: AppErrorProjectRef): AppErrorSettingsView {
		this.#requireWrite(principal, project);
		const now = this.ctx.now();
		if (!this.#projectRow(project.id)) this.enable(principal, project);
		this.ctx.sqlite.run('UPDATE app_error_keys SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL', [now, project.id]);
		this.#createKey(project.id, now);
		this.ctx.audit.record({
			principal,
			action: 'app_errors.key.rotate',
			resource: 'project',
			resourceId: project.id,
			args: { project: project.slug },
			result: 'ok',
		});
		return this.#settingsView(project);
	}

	// --- top-level service ---------------------------------------------------------------------

	/** The Errors page's configuration and every target the caller may read. */
	serviceView(principal: Principal): AppErrorServiceView {
		this.#requireOrgRead(principal);
		const targets = this.#accessibleTargets(principal);
		const now = this.ctx.now();
		const hourStart = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
		const dayStart = Math.floor(now / DAY) * DAY - 13 * DAY;
		const projectIds = targets.map((row) => row.project_id);
		const emptySummary = {
			unresolved: 0,
			resolved: 0,
			ignored: 0,
			events24h: 0,
			new24h: 0,
			reporting24h: 0,
			targets: targets.length,
		};
		if (projectIds.length === 0) {
			return {
				autoLink: this.#autoLinkForOrg(principal.orgId),
				targets: [],
				summary: emptySummary,
				daily: new Array<number>(14).fill(0),
				newDaily: new Array<number>(14).fill(0),
				hourly: new Array<number>(24).fill(0),
			};
		}
		const placeholders = projectIds.map(() => '?').join(', ');
		const counts = this.ctx.sqlite
			.query<{ status: AppErrorStatus; n: number }, Array<string>>(
				`SELECT status, COUNT(*) AS n FROM app_error_issues WHERE project_id IN (${placeholders}) GROUP BY status`,
			)
			.all(...projectIds);
		const summary = { ...emptySummary };
		for (const row of counts) summary[row.status] = row.n;
		summary.new24h =
			this.ctx.sqlite
				.query<{ n: number }, Array<string | number>>(
					`SELECT COUNT(*) AS n FROM app_error_issues WHERE project_id IN (${placeholders}) AND first_seen_at >= ?`,
				)
				.get(...projectIds, now - DAY)?.n ?? 0;
		summary.reporting24h =
			this.ctx.sqlite
				.query<{ n: number }, Array<string | number>>(
					`SELECT COUNT(DISTINCT project_id) AS n FROM app_error_issues
					 WHERE project_id IN (${placeholders}) AND last_seen_at >= ?`,
				)
				.get(...projectIds, now - DAY)?.n ?? 0;
		const hourly = this.ctx.sqlite
			.query<{ hour: number; n: number }, Array<string | number>>(
				`SELECT h.hour AS hour, SUM(h.count) AS n FROM app_error_hourly h
				 JOIN app_error_issues i ON i.id = h.issue_id
				 WHERE i.project_id IN (${placeholders}) AND h.hour >= ? GROUP BY h.hour`,
			)
			.all(...projectIds, hourStart);
		summary.events24h = this.ctx.sqlite
			.query<{ n: number }, Array<string | number>>(
				`SELECT COALESCE(SUM(h.count), 0) AS n FROM app_error_hourly h
				 JOIN app_error_issues i ON i.id = h.issue_id
				 WHERE i.project_id IN (${placeholders}) AND h.hour >= ?`,
			)
			.get(...projectIds, hourStart)?.n ?? 0;
		const dailyRows = this.ctx.sqlite
			.query<{ hour: number; n: number }, Array<string | number>>(
				`SELECT h.hour AS hour, SUM(h.count) AS n FROM app_error_hourly h
				 JOIN app_error_issues i ON i.id = h.issue_id
				 WHERE i.project_id IN (${placeholders}) AND h.hour >= ? GROUP BY h.hour`,
			)
			.all(...projectIds, dayStart);
		const newRows = this.ctx.sqlite
			.query<{ hour: number; n: number }, Array<string | number>>(
				`SELECT first_seen_at AS hour, COUNT(*) AS n FROM app_error_issues
				 WHERE project_id IN (${placeholders}) AND first_seen_at >= ? GROUP BY first_seen_at`,
			)
			.all(...projectIds, dayStart);
		return {
			autoLink: this.#autoLinkForOrg(principal.orgId),
			targets: targets.map((row) => this.#targetView(row)),
			summary,
			daily: this.#bucketsFor(dailyRows, dayStart, DAY, 14),
			newDaily: this.#bucketsFor(newRows, dayStart, DAY, 14),
			hourly: this.#bucketsFor(hourly, hourStart, HOUR, 24),
		};
	}

	/**
	 * Turn automatic linking on for the organisation. On creates (and enables) a target for every
	 * current project; new projects get one from `onProjectCreated`. Off disables the targets that
	 * are still marked auto-linked; a target enabled by hand stays on.
	 */
	setAutoLink(principal: Principal, enabled: boolean): AppErrorServiceView {
		this.#requireOrgWrite(principal);
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO app_error_settings (org_id, auto_link, created_at, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(org_id) DO UPDATE SET auto_link = excluded.auto_link, updated_at = excluded.updated_at`,
			[principal.orgId, enabled ? 1 : 0, now, now],
		);
		if (enabled) {
			const projects = this.ctx.sqlite
				.query<{ id: string; name: string; slug: string }, [string]>(
					'SELECT id, name, slug FROM projects WHERE org_id = ? AND deleted_at IS NULL',
				)
				.all(principal.orgId);
			for (const project of projects)
				this.#ensureTarget({ id: project.id, name: project.name, slug: project.slug }, true);
		} else {
			this.ctx.sqlite.run(
				"UPDATE app_error_projects SET enabled = 0, updated_at = ? WHERE org_id = ? AND kind = 'project' AND auto_linked = 1",
				[now, principal.orgId],
			);
		}
		this.ctx.audit.record({
			principal,
			action: 'app_errors.auto_link',
			resource: 'org',
			resourceId: principal.orgId,
			args: { enabled },
			result: 'ok',
		});
		return this.serviceView(principal);
	}

	/** Called by `ProjectService.create`; a no-op unless the organisation has auto-linking on. */
	onProjectCreated(project: AppErrorProjectRef): void {
		if (!project.orgId || !this.#autoLinkForOrg(project.orgId)) return;
		this.#ensureTarget(project, true);
	}

	/** Link one Yoal project by hand, even when automatic linking is off. */
	createProjectTarget(principal: Principal, project: AppErrorProjectRef): AppErrorTargetView {
		this.#requireOrgWrite(principal);
		this.#requireWrite(principal, project);
		const row = this.#ensureTarget(project, false);
		this.ctx.audit.record({
			principal,
			action: 'app_errors.target.link',
			resource: 'org',
			resourceId: principal.orgId,
			args: { target: project.id, project: project.slug },
			result: 'ok',
		});
		return this.#targetView(row);
	}

	createStandaloneTarget(principal: Principal, input: AppErrorTargetCreate): AppErrorTargetView {
		this.#requireOrgWrite(principal);
		const parsed = appErrorTargetCreateSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid app error target.', parsed.error.issues);
		const now = this.ctx.now();
		const id = `ext_${newId('').toLowerCase()}`;
		this.ctx.sqlite.run(
			`INSERT INTO app_error_projects
			   (project_id, org_id, name, kind, auto_linked, enabled, sample_rate, notify, created_at, updated_at)
			 VALUES (?, ?, ?, 'standalone', 0, 1, 1, 0, ?, ?)`,
			[id, principal.orgId, parsed.data.name, now, now],
		);
		this.#createKey(id, now);
		this.ctx.audit.record({
			principal,
			action: 'app_errors.target.create',
			resource: 'org',
			resourceId: principal.orgId,
			args: { target: id, name: parsed.data.name },
			result: 'ok',
		});
		return this.#targetView(this.#projectRow(id)!);
	}

	updateTarget(principal: Principal, targetId: string, input: AppErrorTargetUpdate): AppErrorTargetView {
		const row = this.#targetRow(targetId);
		if (!row) throw new NotFoundError('App error target');
		this.#requireTargetWrite(principal, row);
		const parsed = appErrorTargetUpdateSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid app error target.', parsed.error.issues);
		const now = this.ctx.now();
		const enabled = parsed.data.enabled === undefined ? row.enabled : parsed.data.enabled ? 1 : 0;
		const sampleRate = parsed.data.sampleRate ?? row.sample_rate;
		const notify = parsed.data.notify === undefined ? row.notify : parsed.data.notify ? 1 : 0;
		const name = parsed.data.name ?? row.name ?? row.project_id;
		// A manual enable/disable is a deliberate override: auto-link off must not undo it later.
		const autoLinked = parsed.data.enabled === undefined ? row.auto_linked : 0;
		this.ctx.sqlite.run(
			'UPDATE app_error_projects SET name = ?, enabled = ?, sample_rate = ?, notify = ?, auto_linked = ?, updated_at = ? WHERE project_id = ?',
			[name, enabled, sampleRate, notify, autoLinked, now, targetId],
		);
		if (enabled && !this.#activeKey(targetId)) this.#createKey(targetId, now);
		this.ctx.audit.record({
			principal,
			action: 'app_errors.target.update',
			resource: 'org',
			resourceId: principal.orgId,
			args: { target: targetId, enabled: enabled === 1, sampleRate, notify: notify === 1 },
			result: 'ok',
		});
		return this.#targetView(this.#projectRow(targetId)!);
	}

	rotateTargetKey(principal: Principal, targetId: string): AppErrorTargetView {
		const row = this.#targetRow(targetId);
		if (!row) throw new NotFoundError('App error target');
		this.#requireTargetWrite(principal, row);
		const now = this.ctx.now();
		this.ctx.sqlite.run('UPDATE app_error_keys SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL', [now, targetId]);
		this.#createKey(targetId, now);
		this.ctx.audit.record({
			principal,
			action: 'app_errors.target.rotate',
			resource: 'org',
			resourceId: principal.orgId,
			args: { target: targetId },
			result: 'ok',
		});
		return this.#targetView(this.#projectRow(targetId)!);
	}

	deleteTarget(principal: Principal, targetId: string): boolean {
		const row = this.#targetRow(targetId);
		if (!row) throw new NotFoundError('App error target');
		this.#requireTargetWrite(principal, row);
		this.#deleteTargetData(targetId);
		this.ctx.audit.record({
			principal,
			action: 'app_errors.target.delete',
			resource: 'org',
			resourceId: principal.orgId,
			args: { target: targetId, kind: row.kind },
			result: 'ok',
		});
		return true;
	}

	testTarget(principal: Principal, targetId: string): AppErrorTestResult {
		const row = this.#targetRow(targetId);
		if (!row) throw new NotFoundError('App error target');
		this.#requireTargetWrite(principal, row);
		const normalized = normalizeSentryEvent(
			{
				event_id: newId(''),
				platform: 'node',
				level: 'error',
				environment: 'test',
				release: 'test',
				message: `Yoal test error for ${row.name ?? targetId}`,
				exception: {
					values: [
						{
							type: 'Error',
							value: `Yoal test error for ${row.name ?? targetId}`,
							stacktrace: { frames: [{ function: 'testTarget', filename: 'yoal-test.ts', lineno: 1, in_app: true }] },
						},
					],
				},
				tags: { 'yoal.test': 'true' },
			},
			null,
			this.ctx.now(),
		);
		const stored = this.#record(row, normalized, true);
		return { issueId: stored.issueId, eventId: normalized.eventId };
	}

	/** The unresolved count for the sidebar badge; 0 when the caller cannot see errors. */
	unresolvedCount(principal: Principal): number {
		if (!this.ctx.iam.can(principal, 'project:read', { type: 'org' })) return 0;
		const targets = this.#accessibleTargets(principal);
		if (targets.length === 0) return 0;
		const placeholders = targets.map(() => '?').join(', ');
		return (
			this.ctx.sqlite
				.query<{ n: number }, Array<string>>(
					`SELECT COUNT(*) AS n FROM app_error_issues
					 WHERE project_id IN (${placeholders}) AND status = 'unresolved'`,
				)
				.get(...targets.map((target) => target.project_id))?.n ?? 0
		);
	}

	// --- top-level issues ----------------------------------------------------------------------

	/** Issues across every target the caller may read, optionally narrowed to one target. */
	orgList(principal: Principal, query: AppErrorListQuery = {}): AppErrorListView {
		this.#requireOrgRead(principal);
		const targets = this.#accessibleTargets(principal);
		const targetId = (query as { target?: string }).target;
		const selected = targetId ? targets.filter((row) => row.project_id === targetId) : targets;
		return this.#listForTargets(selected, query);
	}

	orgGet(principal: Principal, issueId: string): AppErrorDetail {
		this.#requireOrgRead(principal);
		const issue = this.ctx.sqlite
			.query<{ project_id: string }, [string]>('SELECT project_id FROM app_error_issues WHERE id = ?')
			.get(issueId);
		if (!issue) throw new NotFoundError('App error');
		const target = this.#targetRow(issue.project_id);
		if (!target) throw new NotFoundError('App error');
		this.#requireTargetRead(principal, target);
		return this.#detailFor(target, issueId);
	}

	orgSetStatus(principal: Principal, input: AppErrorStatusUpdate): number {
		this.#requireOrgWrite(principal);
		const parsed = appErrorStatusUpdateSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid app error status.', parsed.error.issues);
		const ids = [...new Set(parsed.data.ids)];
		if (ids.length === 0) return 0;
		const targets = this.#targetsForIssueIds(ids);
		for (const target of targets) this.#requireTargetWrite(principal, target);
		const changed = this.#setStatusFor(ids, parsed.data.status, principal.userId);
		this.ctx.audit.record({
			principal,
			action: 'app_errors.status',
			resource: 'org',
			resourceId: principal.orgId,
			args: { status: parsed.data.status, issues: changed },
			result: 'ok',
		});
		return changed;
	}

	orgDeleteIssues(principal: Principal, ids: string[]): number {
		this.#requireOrgWrite(principal);
		const unique = [...new Set(ids)].filter(Boolean);
		if (unique.length === 0) return 0;
		const targets = this.#targetsForIssueIds(unique);
		for (const target of targets) this.#requireTargetWrite(principal, target);
		let deleted = 0;
		for (const id of unique) {
			const issue = this.ctx.sqlite
				.query<{ project_id: string }, [string]>('SELECT project_id FROM app_error_issues WHERE id = ?')
				.get(id);
			if (issue && this.#deleteIssueFor(issue.project_id, id)) deleted++;
		}
		this.ctx.audit.record({
			principal,
			action: 'app_errors.delete',
			resource: 'org',
			resourceId: principal.orgId,
			args: { issues: deleted },
			result: 'ok',
		});
		return deleted;
	}

	orgDeleteIssue(principal: Principal, issueId: string): boolean {
		this.#requireOrgWrite(principal);
		const issue = this.ctx.sqlite
			.query<{ project_id: string }, [string]>('SELECT project_id FROM app_error_issues WHERE id = ?')
			.get(issueId);
		if (!issue) throw new NotFoundError('App error');
		const target = this.#targetRow(issue.project_id);
		if (!target) throw new NotFoundError('App error');
		this.#requireTargetWrite(principal, target);
		const deleted = this.#deleteIssueFor(target.project_id, issueId);
		this.ctx.audit.record({
			principal,
			action: 'app_errors.delete',
			resource: 'org',
			resourceId: principal.orgId,
			args: { issue: issueId },
			result: 'ok',
		});
		return deleted;
	}

	// --- issues --------------------------------------------------------------------------------

	list(principal: Principal, project: AppErrorProjectRef, query: AppErrorListQuery = {}): AppErrorListView {
		this.#requireRead(principal, project);
		const target = this.#targetRow(project.id);
		return this.#listForTargets(target ? [target] : [], query);
	}

	#listForTargets(targets: ProjectRow[], query: AppErrorListQuery): AppErrorListView {
		const parsed = appErrorListQuerySchema.safeParse(query);
		if (!parsed.success) throw new ValidationError('Invalid app error filters.', parsed.error.issues);
		const { status, level, environment, release, q, range, sort, before, offset, limit } = parsed.data;
		const now = this.ctx.now();
		const since = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
		const rangeStart =
			range === 'all' ? null : now - (range === '24h' ? DAY : range === '7d' ? 7 * DAY : 30 * DAY);
		const projectIds = [...new Set(targets.map((row) => row.project_id))];
		const empty = (): AppErrorListView => ({
			issues: [],
			summary: { unresolved: 0, resolved: 0, ignored: 0, events24h: 0 },
			hourly: new Array<number>(24).fill(0),
			nextBefore: null,
			nextOffset: null,
			environments: [],
			releases: [],
		});
		if (projectIds.length === 0) return empty();
		const placeholders = projectIds.map(() => '?').join(', ');
		const where = [`i.project_id IN (${placeholders})`];
		const params: Array<string | number> = [...projectIds];
		if (status !== 'all') {
			where.push('i.status = ?');
			params.push(status);
		}
		if (level) {
			where.push('i.level = ?');
			params.push(level);
		}
		if (rangeStart !== null) {
			where.push('i.last_seen_at >= ?');
			params.push(rangeStart);
		}
		if (environment) {
			where.push('i.environment = ?');
			params.push(environment);
		}
		if (release) {
			where.push('i.last_release = ?');
			params.push(release);
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
		const order =
			sort === 'first_seen'
				? 'i.first_seen_at DESC, i.id DESC'
				: sort === 'events'
					? 'i.event_count DESC, i.last_seen_at DESC, i.id DESC'
					: 'i.last_seen_at DESC, i.id DESC';
		const pageQuery =
			offset === undefined
				? `LIMIT ?`
				: `LIMIT ? OFFSET ?`;
		const pageParams = offset === undefined ? [limit + 1] : [limit + 1, offset];
		const rows = this.ctx.sqlite
			.query<IssueRow, Array<string | number>>(
				`SELECT i.*, (SELECT COALESCE(SUM(h.count), 0) FROM app_error_hourly h WHERE h.issue_id = i.id AND h.hour >= ?) AS count_24h
				 FROM app_error_issues i
				 WHERE ${where.join(' AND ')}
				 ORDER BY ${order}
				 ${pageQuery}`,
			)
			.all(since, ...params, ...pageParams);
		const page = rows.slice(0, limit);
		const counts = this.ctx.sqlite
			.query<{ status: AppErrorStatus; n: number }, Array<string>>(
				`SELECT status, COUNT(*) AS n FROM app_error_issues WHERE project_id IN (${placeholders}) GROUP BY status`,
			)
			.all(...projectIds);
		const summary = { unresolved: 0, resolved: 0, ignored: 0, events24h: 0 };
		for (const row of counts) summary[row.status] = row.n;
		const hourly = this.#bucketsFor(
			this.ctx.sqlite
				.query<{ hour: number; n: number }, Array<string | number>>(
					`SELECT h.hour AS hour, SUM(h.count) AS n FROM app_error_hourly h JOIN app_error_issues i ON i.id = h.issue_id
					 WHERE i.project_id IN (${placeholders}) AND h.hour >= ? GROUP BY h.hour`,
				)
				.all(...projectIds, since),
			since,
			HOUR,
			24,
		);
		summary.events24h = hourly.reduce((total, value) => total + value, 0);
		const environments = this.ctx.sqlite
			.query<{ value: string }, Array<string>>(
				`SELECT environment AS value FROM app_error_issues WHERE project_id IN (${placeholders})
				 GROUP BY environment ORDER BY MAX(last_seen_at) DESC LIMIT 50`,
			)
			.all(...projectIds)
			.map((row) => row.value);
		const releases = this.ctx.sqlite
			.query<{ value: string }, Array<string>>(
				`SELECT last_release AS value FROM app_error_issues WHERE project_id IN (${placeholders}) AND last_release IS NOT NULL
				 GROUP BY last_release ORDER BY MAX(last_seen_at) DESC LIMIT 50`,
			)
			.all(...projectIds)
			.map((row) => row.value);
		const metadata = this.#metadataFor(targets);
		return {
			issues: page.map((row) => toIssueView(row, metadata.get(row.project_id))),
			summary,
			hourly,
			nextBefore: offset === undefined && rows.length > limit ? (page.at(-1)?.last_seen_at ?? null) : null,
			nextOffset: offset !== undefined && rows.length > limit ? offset + limit : null,
			environments,
			releases,
		};
	}

	get(principal: Principal, project: AppErrorProjectRef, issueId: string): AppErrorDetail {
		this.#requireRead(principal, project);
		const target = this.#targetRow(project.id);
		if (!target) throw new NotFoundError('App error');
		return this.#detailFor(target, issueId);
	}

	#detailFor(target: ProjectRow, issueId: string): AppErrorDetail {
		const projectId = target.project_id;
		const now = this.ctx.now();
		const hourStart = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
		const row = this.ctx.sqlite
			.query<IssueRow, [number, string, string]>(
				`SELECT i.*, (SELECT COALESCE(SUM(h.count), 0) FROM app_error_hourly h WHERE h.issue_id = i.id AND h.hour >= ?) AS count_24h
				 FROM app_error_issues i WHERE i.project_id = ? AND i.id = ?`,
			)
			.get(hourStart, projectId, issueId);
		if (!row) throw new NotFoundError('App error');
		const events = this.ctx.sqlite
			.query<EventRow, [string, number]>('SELECT * FROM app_error_events WHERE issue_id = ? ORDER BY at DESC, id DESC LIMIT ?')
			.all(issueId, APP_ERROR_LIMITS.eventsPerIssue)
			.map(toEventView);
		const hours = this.ctx.sqlite
			.query<{ hour: number; n: number }, [string, number]>('SELECT hour, count AS n FROM app_error_hourly WHERE issue_id = ? AND hour >= ?')
			.all(issueId, Math.floor(now / HOUR) * HOUR - 14 * DAY);
		const day = DAY;
		const dayStart = Math.floor(now / day) * day - 13 * day;
		return {
			issue: toIssueView(row, this.#metadataFor([target]).get(projectId)),
			events,
			hourly: this.#bucketsFor(hours, hourStart, HOUR, 24),
			daily: this.#bucketsFor(hours, dayStart, day, 14),
		};
	}

	#bucketsFor(rows: Array<{ hour: number; n: number }>, start: number, size: number, count: number): number[] {
		const out = new Array<number>(count).fill(0);
		for (const row of rows) {
			const index = Math.floor((row.hour - start) / size);
			if (index >= 0 && index < count) out[index]! += row.n;
		}
		return out;
	}

	setStatus(principal: Principal, project: AppErrorProjectRef, input: AppErrorStatusUpdate): number {
		this.#requireWrite(principal, project);
		const parsed = appErrorStatusUpdateSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid app error status.', parsed.error.issues);
		const ids = [...new Set(parsed.data.ids)];
		if (ids.length === 0) return 0;
		const now = this.ctx.now();
		const placeholders = ids.map(() => '?').join(', ');
		const result =
			parsed.data.status === 'resolved'
				? this.ctx.sqlite.run(
						`UPDATE app_error_issues SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE project_id = ? AND id IN (${placeholders})`,
						[now, principal.userId, project.id, ...ids],
					)
				: this.ctx.sqlite.run(
						`UPDATE app_error_issues SET status = ?, resolved_at = NULL, resolved_by = NULL WHERE project_id = ? AND id IN (${placeholders})`,
						[parsed.data.status, project.id, ...ids],
					);
		this.ctx.audit.record({
			principal,
			action: 'app_errors.status',
			resource: 'project',
			resourceId: project.id,
			args: { status: parsed.data.status, issues: result.changes },
			result: 'ok',
		});
		return result.changes;
	}

	deleteIssue(principal: Principal, project: AppErrorProjectRef, issueId: string): boolean {
		this.#requireWrite(principal, project);
		let changes = 0;
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run('DELETE FROM app_error_events WHERE project_id = ? AND issue_id = ?', [project.id, issueId]);
			this.ctx.sqlite.run('DELETE FROM app_error_hourly WHERE issue_id = ?', [issueId]);
			changes = this.ctx.sqlite.run('DELETE FROM app_error_issues WHERE project_id = ? AND id = ?', [project.id, issueId]).changes;
		})();
		if (changes === 0) throw new NotFoundError('App error');
		this.ctx.audit.record({
			principal,
			action: 'app_errors.delete',
			resource: 'project',
			resourceId: project.id,
			args: { issue: issueId },
			result: 'ok',
		});
		return true;
	}

	deleteAll(principal: Principal, project: AppErrorProjectRef): number {
		this.#requireWrite(principal, project);
		let changes = 0;
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run('DELETE FROM app_error_events WHERE project_id = ?', [project.id]);
			this.ctx.sqlite.run(
				'DELETE FROM app_error_hourly WHERE issue_id IN (SELECT id FROM app_error_issues WHERE project_id = ?)',
				[project.id],
			);
			changes = this.ctx.sqlite.run('DELETE FROM app_error_issues WHERE project_id = ?', [project.id]).changes;
		})();
		this.ctx.audit.record({
			principal,
			action: 'app_errors.delete_all',
			resource: 'project',
			resourceId: project.id,
			args: { issues: changes },
			result: 'ok',
		});
		return changes;
	}

	// --- ingest --------------------------------------------------------------------------------

	ingest(input: AppErrorIngestInput): AppErrorIngestOutcome {
		const now = this.ctx.now();
		if (!/^\d+$/.test(input.dsnProjectId)) return { status: 401, error: 'invalid_dsn' };
		if (input.body.byteLength > APP_ERROR_LIMITS.payloadBytes) return { status: 413, error: 'payload_too_large' };
		const row = this.ctx.sqlite
			.query<ProjectRow, [number]>('SELECT * FROM app_error_projects WHERE dsn_project_id = ?')
			.get(Number(input.dsnProjectId));
		if (!row || !row.enabled) return { status: 401, error: 'invalid_dsn' };

		let envelope: ParsedEnvelope | null = null;
		let event: Record<string, unknown> | null = null;
		let ignored: string[] = [];
		try {
			if (input.endpoint === 'envelope') {
				envelope = parseSentryEnvelope(input.body);
				event = envelope.event;
				ignored = envelope.ignored;
			} else {
				if (input.body.byteLength > APP_ERROR_LIMITS.eventBytes)
					return { status: 413, error: 'payload_too_large' };
				const parsed = record(JSON.parse(Buffer.from(input.body).toString('utf8')));
				if (!parsed) throw new ValidationError('Malformed Sentry store payload.');
				if (parsed.type === 'transaction') ignored = ['transaction'];
				else event = parsed;
			}
		} catch (error) {
			if (error instanceof AppErrorPayloadTooLarge) return { status: 413, error: 'payload_too_large' };
			return { status: 400, error: 'malformed_payload' };
		}

		const keys = [input.headerKey ?? null, input.queryKey ?? null, dsnKey(envelope?.header?.dsn)]
			.map((key) => (typeof key === 'string' && key.trim() ? key.trim().toLowerCase() : null))
			.filter((key): key is string => key !== null);
		if (keys.length === 0) return { status: 401, error: 'missing_auth' };
		if (new Set(keys).size !== 1) return { status: 401, error: 'auth_mismatch' };
		const validKey = this.#validKey(row.project_id, keys[0]!, now);
		if (!validKey) return { status: 401, error: 'invalid_auth' };
		this.touchKey(validKey.id);

		const limited = this.#rateLimit(row.project_id, now);
		if (limited) return limited;

		if (!event) {
			this.recordIgnored(row.project_id, ignored);
			return { status: 200, eventId: null, ignored: ignored.length };
		}

		const monthly = this.#monthlyLimit(row.project_id, now);
		if (monthly) return monthly;

		const normalized = normalizeSentryEvent(event, envelope?.header ?? null, now);
		const stored = this.#record(row, normalized, false);
		return { status: 200, eventId: stored.eventId ?? normalized.eventId, ignored: ignored.length };
	}

	recordIgnored(projectId: string, types: string[]): void {
		if (types.length === 0) return;
		const now = this.ctx.now();
		const month = monthKey(now);
		this.ctx.sqlite.run(
			`INSERT INTO app_error_usage (project_id, month, accepted, dropped, ignored) VALUES (?, ?, 0, 0, ?)
			 ON CONFLICT(project_id, month) DO UPDATE SET ignored = ignored + excluded.ignored`,
			[projectId, month, types.length],
		);
	}

	/** The environment defaults injected into a Yoal workload or function when tracking is on. */
	consumerEnv(projectId: string): Record<string, string> {
		const row = this.#projectRow(projectId);
		if (!row || !row.enabled) return {};
		const key = this.#activeKey(projectId);
		return key ? { SENTRY_DSN: this.#dsn(row, key.public_key) } : {};
	}

	testEvent(principal: Principal, project: AppErrorProjectRef): AppErrorTestResult {
		this.#requireWrite(principal, project);
		const row = this.#projectRow(project.id);
		if (!row || !row.enabled) this.enable(principal, project);
		const current = this.#projectRow(project.id)!;
		const normalized = normalizeSentryEvent(
			{
				event_id: newId(''),
				platform: 'node',
				level: 'error',
				environment: 'test',
				release: 'test',
				message: `Yoal test error for ${project.slug}`,
				exception: {
					values: [
						{
							type: 'Error',
							value: `Yoal test error for ${project.slug}`,
							stacktrace: { frames: [{ function: 'testEvent', filename: 'yoal-test.ts', lineno: 1, in_app: true }] },
						},
					],
				},
				tags: { 'yoal.test': 'true' },
			},
			null,
			this.ctx.now(),
		);
		const stored = this.#record(current, normalized, true);
		return { issueId: stored.issueId, eventId: normalized.eventId };
	}

	#record(row: ProjectRow, event: NormalizedEvent, force: boolean): { issueId: string; eventId: string | null } {
		const sqlite = this.ctx.sqlite;
		const now = this.ctx.now();
		const existingEvent = sqlite
			.query<{ issue_id: string }, [string, string]>('SELECT issue_id FROM app_error_events WHERE project_id = ? AND event_id = ?')
			.get(row.project_id, event.eventId);
		if (existingEvent) return { issueId: existingEvent.issue_id, eventId: event.eventId };

		let issueId = '';
		let alert: 'new' | 'regressed' | null = null;
		const sampled = row.sample_rate >= 1 || Math.random() < row.sample_rate;
		const shouldStore = force || (sampled && this.#shouldStore(row.project_id, event.fingerprint, now));
		const month = monthKey(now);
		sqlite.transaction(() => {
			const existing = sqlite
				.query<{ id: string; status: AppErrorStatus }, [string, string]>(
					'SELECT id, status FROM app_error_issues WHERE project_id = ? AND fingerprint = ?',
				)
				.get(row.project_id, event.fingerprint);
			if (!existing) {
				issueId = newId('aei_');
				sqlite.run(
					`INSERT INTO app_error_issues (id, project_id, fingerprint, platform, environment, name, message, culprit, level, status, event_count, first_seen_at, last_seen_at, first_release, last_release)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', 1, ?, ?, ?, ?)
					 ON CONFLICT(project_id, fingerprint) DO UPDATE SET event_count = event_count + 1, last_seen_at = excluded.last_seen_at`,
					[
						issueId,
						row.project_id,
						event.fingerprint,
						event.platform,
						event.environment,
						event.name,
						event.message,
						event.culprit,
						event.level,
						now,
						now,
						event.release,
						event.release,
					],
				);
				issueId =
					sqlite
						.query<{ id: string }, [string, string]>('SELECT id FROM app_error_issues WHERE project_id = ? AND fingerprint = ?')
						.get(row.project_id, event.fingerprint)?.id ?? issueId;
				alert = 'new';
			} else {
				issueId = existing.id;
				const regressed = existing.status === 'resolved';
				sqlite.run(
					`UPDATE app_error_issues SET event_count = event_count + 1, last_seen_at = ?, last_release = ?,
					   level = ?, message = ?, culprit = COALESCE(?, culprit)
					   ${regressed ? ", status = 'unresolved', regressed_at = ?, resolved_at = NULL, resolved_by = NULL" : ''}
					 WHERE id = ?`,
					regressed
						? [now, event.release, event.level, event.message, event.culprit, now, issueId]
						: [now, event.release, event.level, event.message, event.culprit, issueId],
				);
				if (regressed) alert = 'regressed';
			}
			sqlite.run(
				`INSERT INTO app_error_hourly (issue_id, hour, count) VALUES (?, ?, 1)
				 ON CONFLICT(issue_id, hour) DO UPDATE SET count = count + 1`,
				[issueId, Math.floor(now / HOUR) * HOUR],
			);
			sqlite.run(
				`INSERT INTO app_error_usage (project_id, month, accepted, dropped, ignored) VALUES (?, ?, 1, 0, 0)
				 ON CONFLICT(project_id, month) DO UPDATE SET accepted = accepted + 1`,
				[row.project_id, month],
			);
			if (!shouldStore) return;
			sqlite.run(
				`INSERT OR IGNORE INTO app_error_events (id, project_id, issue_id, event_id, at, level, message, exceptions_json, method, path, release, environment, tags_json, contexts_json, extra_json, user_id, platform, sdk)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					newId('aev_'),
					row.project_id,
					issueId,
					event.eventId,
					event.at,
					event.level,
					event.message,
					JSON.stringify(event.exceptions),
					event.method,
					event.path,
					event.release,
					event.environment,
					JSON.stringify(event.tags),
					JSON.stringify(event.contexts),
					event.extra === null ? null : JSON.stringify(event.extra),
					event.userId,
					event.platform,
					event.sdk,
				],
			);
			sqlite.run(
				`DELETE FROM app_error_events WHERE issue_id = ? AND id NOT IN (
				   SELECT id FROM app_error_events WHERE issue_id = ? ORDER BY at DESC, id DESC LIMIT ?)`,
				[issueId, issueId, APP_ERROR_LIMITS.eventsPerIssue],
			);
		})();
		if (alert) this.#alert(row, issueId, alert, event);
		return { issueId, eventId: shouldStore ? event.eventId : null };
	}

	#shouldStore(projectId: string, fingerprint: string, now: number): boolean {
		const last = this.#lastStored.get(`${projectId}:${fingerprint}`);
		if (last !== undefined && now - last < APP_ERROR_LIMITS.sampleWindowMs) return false;
		const project = this.#projectMinute.get(projectId);
		if (!project || now - project.start >= 60_000) this.#projectMinute.set(projectId, { start: now, stored: 1 });
		else if (project.stored >= APP_ERROR_LIMITS.eventsPerProjectMinute) return false;
		else project.stored++;
		if (now - this.#minute.start >= 60_000) this.#minute = { start: now, stored: 1 };
		else if (this.#minute.stored >= APP_ERROR_LIMITS.eventsPerMinute) return false;
		else this.#minute.stored++;
		this.#lastStored.set(`${projectId}:${fingerprint}`, now);
		if (this.#lastStored.size > 5_000) this.#lastStored.clear();
		return true;
	}

	#rateLimit(projectId: string, now: number): AppErrorIngestOutcome | null {
		if (now - this.#globalMinute.start >= 60_000) {
			this.#globalMinute.start = now;
			this.#globalMinute.accepted = 0;
		}
		if (this.#globalMinute.accepted >= APP_ERROR_LIMITS.eventsPerMinute) {
			this.#dropped(projectId);
			return { status: 429, error: 'rate_limited', retryAfter: 60, rateLimit: '60:error:project:rate_limited' };
		}
		this.#globalMinute.accepted++;
		const bucket = this.#buckets.get(projectId) ?? { tokens: APP_ERROR_LIMITS.requestBurst, at: now };
		const elapsed = Math.max(0, now - bucket.at) / 60_000;
		bucket.tokens = Math.min(APP_ERROR_LIMITS.requestBurst, bucket.tokens + elapsed * APP_ERROR_LIMITS.requestsPerMinute);
		bucket.at = now;
		if (bucket.tokens < 1) {
			this.#buckets.set(projectId, bucket);
			const retry = Math.ceil((1 - bucket.tokens) / (APP_ERROR_LIMITS.requestsPerMinute / 60));
			this.#dropped(projectId);
			return { status: 429, error: 'rate_limited', retryAfter: retry, rateLimit: `${retry}:error:project:rate_limited` };
		}
		bucket.tokens--;
		this.#buckets.set(projectId, bucket);
		return null;
	}

	#monthlyLimit(projectId: string, now: number): AppErrorIngestOutcome | null {
		const month = monthKey(now);
		const row = this.ctx.sqlite
			.query<{ accepted: number }, [string, string]>('SELECT accepted FROM app_error_usage WHERE project_id = ? AND month = ?')
			.get(projectId, month);
		if ((row?.accepted ?? 0) < APP_ERROR_LIMITS.monthlyEvents) return null;
		this.#dropped(projectId);
		return { status: 429, error: 'quota_exceeded', retryAfter: 3_600, rateLimit: '3600:error:project:quota_exceeded' };
	}

	#dropped(projectId: string): void {
		const now = this.ctx.now();
		// A 429 storm must not become a write storm: at most one dropped row per project per 5 s.
		if (now - (this.#droppedAt.get(projectId) ?? 0) < 5_000) return;
		this.#droppedAt.set(projectId, now);
		const month = monthKey(now);
		this.ctx.sqlite.run(
			`INSERT INTO app_error_usage (project_id, month, accepted, dropped, ignored) VALUES (?, ?, 0, 1, 0)
			 ON CONFLICT(project_id, month) DO UPDATE SET dropped = dropped + 1`,
			[projectId, month],
		);
	}

	#alert(row: ProjectRow, issueId: string, kind: 'new' | 'regressed', event: NormalizedEvent): void {
		if (!row.notify) return;
		const now = this.ctx.now();
		const times = (this.#alertTimes.get(row.project_id) ?? []).filter((at) => now - at < HOUR);
		if (times.length >= APP_ERROR_LIMITS.alertsPerHour) return;
		times.push(now);
		this.#alertTimes.set(row.project_id, times);
		const project =
			row.kind === 'project'
				? this.ctx.sqlite
						.query<{ slug: string; name: string }, [string]>('SELECT slug, name FROM projects WHERE id = ?')
						.get(row.project_id)
				: undefined;
		const name =
			row.kind === 'project'
				? (project?.name ?? row.name ?? row.project_id)
				: (row.name ?? row.project_id);
		const origin = this.ctx.config.platformOrigin?.replace(/\/$/, '') ?? '';
		const link = new URLSearchParams({ issue: issueId });
		const url = origin ? `${origin}/errors?${link.toString()}` : undefined;
		const message = {
			key: `app_error:${issueId}`,
			title: kind === 'new' ? `New error in ${name}` : `Error is back in ${name}`,
			detail: `${event.name}: ${event.message.slice(0, 300)}${event.culprit ? `\nIn ${event.culprit}` : ''}${kind === 'regressed' ? '\nIt was marked resolved and happened again.' : ''}`,
			severity: 'warning' as const,
			url,
		};
		for (const notifier of this.ctx.notifiers) {
			void notifier.notify(message).catch(() => undefined);
		}
	}

	// --- maintenance ---------------------------------------------------------------------------

	prune(now = this.ctx.now()): { events: number; issues: number; usage: number } {
		const sqlite = this.ctx.sqlite;
		const eventCutoff = now - EVENT_RETENTION_MS;
		const issueCutoff = now - ISSUE_RETENTION_MS;
		const events = sqlite.run('DELETE FROM app_error_events WHERE at < ?', [eventCutoff]).changes;
		sqlite.run('DELETE FROM app_error_hourly WHERE hour < ?', [eventCutoff]);
		const stale = sqlite
			.query<{ id: string }, [number]>('SELECT id FROM app_error_issues WHERE last_seen_at < ?')
			.all(issueCutoff)
			.map((row) => row.id);
		for (const id of stale) {
			sqlite.run('DELETE FROM app_error_events WHERE issue_id = ?', [id]);
			sqlite.run('DELETE FROM app_error_hourly WHERE issue_id = ?', [id]);
			sqlite.run('DELETE FROM app_error_issues WHERE id = ?', [id]);
		}
		const cutoff = new Date(now);
		cutoff.setUTCMonth(cutoff.getUTCMonth() - USAGE_RETENTION_MONTHS);
		const usage = sqlite.run('DELETE FROM app_error_usage WHERE month < ?', [cutoff.toISOString().slice(0, 7)]).changes;
		return { events, issues: stale.length, usage };
	}

	// --- internals -----------------------------------------------------------------------------

	#projectOrgId(projectId: string): string | null {
		return (
			this.ctx.sqlite
				.query<{ org_id: string }, [string]>('SELECT org_id FROM projects WHERE id = ?')
				.get(projectId)?.org_id ?? null
		);
	}

	#autoLinkForOrg(orgId: string): boolean {
		return (
			this.ctx.sqlite
				.query<{ auto_link: number }, [string]>('SELECT auto_link FROM app_error_settings WHERE org_id = ?')
				.get(orgId)?.auto_link === 1
		);
	}

	/** Targets in the caller's organisation that they may read; linked ones also need project read. */
	#accessibleTargets(principal: Principal): ProjectRow[] {
		this.#requireOrgRead(principal);
		const rows = this.ctx.sqlite
			.query<ProjectRow, [string]>(
				'SELECT * FROM app_error_projects WHERE org_id = ? ORDER BY enabled DESC, name COLLATE NOCASE ASC',
			)
			.all(principal.orgId);
		return rows.filter(
			(row) =>
				row.kind !== 'project' ||
				this.ctx.iam.can(principal, 'project:read', { type: 'project', id: row.project_id }),
		);
	}

	#targetRow(targetId: string): ProjectRow | null {
		return this.#projectRow(targetId);
	}

	/** Create or refresh a linked target for a Yoal project. */
	#ensureTarget(project: AppErrorProjectRef, autoLinked: boolean): ProjectRow {
		const now = this.ctx.now();
		const orgId = project.orgId ?? this.#projectOrgId(project.id);
		const existing = this.#projectRow(project.id);
		if (existing) {
			this.ctx.sqlite.run(
				`UPDATE app_error_projects
				 SET org_id = COALESCE(org_id, ?), name = COALESCE(name, ?), kind = 'project', enabled = 1,
				     auto_linked = CASE WHEN ? THEN 1 ELSE auto_linked END,
				     updated_at = ?
				 WHERE project_id = ?`,
				[orgId, project.name, autoLinked ? 1 : 0, now, project.id],
			);
		} else {
			this.ctx.sqlite.run(
				`INSERT INTO app_error_projects
				   (project_id, org_id, name, kind, auto_linked, enabled, sample_rate, notify, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', ?, 1, 1, 0, ?, ?)`,
				[project.id, orgId, project.name, autoLinked ? 1 : 0, now, now],
			);
		}
		if (!this.#activeKey(project.id)) this.#createKey(project.id, now);
		return this.#projectRow(project.id)!;
	}

	#metadataFor(targets: ProjectRow[]): Map<string, TargetMetadata> {
		const out = new Map<string, TargetMetadata>();
		for (const target of targets) {
			const project =
				target.kind === 'project'
					? this.ctx.sqlite
							.query<{ slug: string; name: string }, [string]>('SELECT slug, name FROM projects WHERE id = ?')
							.get(target.project_id)
					: undefined;
			out.set(target.project_id, {
				id: target.project_id,
				name:
					target.kind === 'project'
						? (project?.name ?? target.name ?? target.project_id)
						: (target.name ?? target.project_id),
				kind: target.kind,
				projectSlug: project?.slug ?? null,
			});
		}
		return out;
	}

	#targetView(row: ProjectRow): AppErrorTargetView {
		const project =
			row.kind === 'project'
				? this.ctx.sqlite
						.query<{ slug: string; name: string }, [string]>('SELECT slug, name FROM projects WHERE id = ?')
						.get(row.project_id)
				: undefined;
		const key = this.#activeKey(row.project_id);
		const now = this.ctx.now();
		const stats = this.ctx.sqlite
			.query<{
				unresolved: number;
				events24h: number;
				last_seen_at: number | null;
				first_seen_at: number | null;
			}, [string, string, number, string, string]>(
				`SELECT
				   (SELECT COUNT(*) FROM app_error_issues WHERE project_id = ? AND status = 'unresolved') AS unresolved,
				   (SELECT COALESCE(SUM(h.count), 0) FROM app_error_hourly h
				      JOIN app_error_issues i ON i.id = h.issue_id
				     WHERE i.project_id = ? AND h.hour >= ?) AS events24h,
				   (SELECT MAX(last_seen_at) FROM app_error_issues WHERE project_id = ?) AS last_seen_at,
				   (SELECT MIN(first_seen_at) FROM app_error_issues WHERE project_id = ?) AS first_seen_at`,
			)
			.get(row.project_id, row.project_id, now - 24 * HOUR, row.project_id, row.project_id)!;
		const dayStart = Math.floor(now / DAY) * DAY - 6 * DAY;
		const daily = this.#bucketsFor(
			this.ctx.sqlite
				.query<{ hour: number; n: number }, [string, number]>(
					`SELECT h.hour AS hour, SUM(h.count) AS n FROM app_error_hourly h
					 JOIN app_error_issues i ON i.id = h.issue_id
					 WHERE i.project_id = ? AND h.hour >= ? GROUP BY h.hour`,
				)
				.all(row.project_id, dayStart),
			dayStart,
			DAY,
			7,
		);
		return {
			id: row.project_id,
			kind: row.kind,
			name:
				row.kind === 'project'
					? (project?.name ?? row.name ?? row.project_id)
					: (row.name ?? row.project_id),
			projectId: row.kind === 'project' ? row.project_id : null,
			projectSlug: project?.slug ?? null,
			dsnProjectId: row.dsn_project_id,
			dsn: key ? this.#dsn(row, key.public_key) : null,
			publicKey: key?.public_key ?? null,
			enabled: row.enabled === 1,
			autoLinked: row.auto_linked === 1,
			sampleRate: row.sample_rate,
			notify: row.notify === 1,
			usage: this.#usageFor(row.project_id),
			unresolved: stats.unresolved,
			events24h: stats.events24h,
			lastSeenAt: stats.last_seen_at,
			firstSeenAt: stats.first_seen_at,
			daily,
		};
	}

	#targetsForIssueIds(ids: string[]): ProjectRow[] {
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => '?').join(', ');
		const projectIds = this.ctx.sqlite
			.query<{ project_id: string }, Array<string>>(
				`SELECT DISTINCT project_id FROM app_error_issues WHERE id IN (${placeholders})`,
			)
			.all(...ids)
			.map((row) => row.project_id);
		return projectIds.map((id) => this.#targetRow(id)).filter((row): row is ProjectRow => row !== null);
	}

	#setStatusFor(ids: string[], status: AppErrorStatus, userId: string, projectId?: string): number {
		const placeholders = ids.map(() => '?').join(', ');
		const now = this.ctx.now();
		const scope = projectId ? ' AND project_id = ?' : '';
		const tail = projectId ? [...ids, projectId] : ids;
		return status === 'resolved'
			? this.ctx.sqlite.run(
					`UPDATE app_error_issues SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id IN (${placeholders})${scope}`,
					[now, userId, ...tail],
				).changes
			: this.ctx.sqlite.run(
					`UPDATE app_error_issues SET status = ?, resolved_at = NULL, resolved_by = NULL WHERE id IN (${placeholders})${scope}`,
					[status, ...tail],
				).changes;
	}

	#deleteIssueFor(projectId: string, issueId: string): boolean {
		let changes = 0;
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run('DELETE FROM app_error_events WHERE project_id = ? AND issue_id = ?', [projectId, issueId]);
			this.ctx.sqlite.run('DELETE FROM app_error_hourly WHERE issue_id = ?', [issueId]);
			changes = this.ctx.sqlite.run('DELETE FROM app_error_issues WHERE project_id = ? AND id = ?', [projectId, issueId]).changes;
		})();
		return changes > 0;
	}

	#deleteTargetData(targetId: string): void {
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run('DELETE FROM app_error_events WHERE project_id = ?', [targetId]);
			this.ctx.sqlite.run(
				'DELETE FROM app_error_hourly WHERE issue_id IN (SELECT id FROM app_error_issues WHERE project_id = ?)',
				[targetId],
			);
			this.ctx.sqlite.run('DELETE FROM app_error_issues WHERE project_id = ?', [targetId]);
			this.ctx.sqlite.run('DELETE FROM app_error_keys WHERE project_id = ?', [targetId]);
			this.ctx.sqlite.run('DELETE FROM app_error_usage WHERE project_id = ?', [targetId]);
			this.ctx.sqlite.run('DELETE FROM app_error_projects WHERE project_id = ?', [targetId]);
		})();
	}

	#projectRow(projectId: string): ProjectRow | null {
		return this.ctx.sqlite
			.query<ProjectRow, [string]>('SELECT * FROM app_error_projects WHERE project_id = ?')
			.get(projectId);
	}

	#activeKey(projectId: string): { id: string; public_key: string } | null {
		return this.ctx.sqlite
			.query<{ id: string; public_key: string }, [string]>(
				'SELECT id, public_key FROM app_error_keys WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
			)
			.get(projectId);
	}

	#validKey(projectId: string, key: string, now: number): { id: string } | null {
		const row = this.ctx.sqlite
			.query<{ id: string }, [string, string, number]>(
				`SELECT id FROM app_error_keys
				 WHERE project_id = ? AND public_key = ? AND (revoked_at IS NULL OR revoked_at > ?)
				 LIMIT 1`,
			)
			.get(projectId, key, now - KEY_GRACE_MS);
		return row ?? null;
	}

	#createKey(projectId: string, now: number): void {
		this.ctx.sqlite.run(
			'INSERT INTO app_error_keys (id, project_id, public_key, label, created_at) VALUES (?, ?, ?, ?, ?)',
			[newId('aek_'), projectId, newId('').toLowerCase(), 'default', now],
		);
	}

	#dsn(row: ProjectRow, key: string): string {
		const origin = (this.ctx.config.platformOrigin ?? 'http://localhost:5173').replace(/\/$/, '');
		return `${origin.replace(/^([a-z][a-z0-9+.-]*:\/\/)/i, `$1${key}@`)}/ingest/${row.dsn_project_id}`;
	}

	/** Touch a key at most once a minute; used by the ingest path in a later iteration. */
	touchKey(keyId: string): void {
		const now = this.ctx.now();
		if (now - (this.#keyTouched.get(keyId) ?? 0) < 60_000) return;
		this.#keyTouched.set(keyId, now);
		this.ctx.sqlite.run('UPDATE app_error_keys SET last_used_at = ? WHERE id = ?', [now, keyId]);
	}
}
