/**
 * Log drains and the audit log (DESIGN §8): the wire types the CLI reads and pure formatting for
 * `yoal log-drain` and `yoal audit`. Types mirror `packages/contracts/src/log-drain.ts` and the
 * `audit_log` row; the CLI bundle stays free of runtime dependencies (D40), so keep them in sync.
 * The server validates everything.
 */
import { UsageError } from './errors.ts';
import { formatTime, renderTable, truncate } from './output.ts';

export const LOG_DRAIN_KINDS = ['webhook', 'otlp'] as const;
export const LOG_DRAIN_FORMATS = ['ndjson', 'json'] as const;
export const LOG_DRAIN_SOURCES = ['build', 'runtime', 'system', 'services'] as const;
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export interface LogDrainView {
	id: string;
	name: string;
	kind: (typeof LOG_DRAIN_KINDS)[number];
	url: string;
	format: (typeof LOG_DRAIN_FORMATS)[number] | null;
	projectId: string | null;
	project: string | null;
	sources: string[];
	minLevel: string | null;
	headerNames: string[];
	signed: boolean;
	allowPrivateNetwork: boolean;
	enabled: boolean;
	status: 'healthy' | 'failing' | 'disabled' | 'pending';
	delivery: {
		deliveredLines: number;
		deliveredBatches: number;
		droppedLines: number;
		droppedBatches: number;
		attempts: number;
		nextAttemptAt: string | null;
		lastDeliveredAt: string | null;
		lastError: string | null;
		lastErrorAt: string | null;
		failingSince: string | null;
	};
	createdAt: string;
	updatedAt: string;
}

export interface LogDrainCreateInput {
	name: string;
	kind: (typeof LOG_DRAIN_KINDS)[number];
	url: string;
	format?: (typeof LOG_DRAIN_FORMATS)[number];
	project?: string;
	sources?: string[];
	minLevel?: string;
	headers?: Record<string, string>;
	enabled?: boolean;
}

export interface LogDrainUpdateInput {
	name?: string;
	url?: string;
	format?: (typeof LOG_DRAIN_FORMATS)[number];
	sources?: string[];
	minLevel?: string | null;
	headers?: Record<string, string> | null;
	enabled?: boolean;
	rotateSigningSecret?: boolean;
}

export interface LogDrainTestResult {
	ok: boolean;
	status: number | null;
	message: string;
}

export interface AuditEntryView {
	id: string;
	actorType: string;
	actorId: string | null;
	clientId: string | null;
	action: string;
	resource: string;
	resourceId: string | null;
	argsJson: string | null;
	result: 'ok' | 'error';
	error: string | null;
	createdAt: number;
}

/** `-H "Authorization: Bearer x"` (curl style) or `-H Authorization=Bearer x`, repeatable. */
export function parseHeaderFlags(values: string[]): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const value of values) {
		const match = /^([^:=\s]+)\s*[:=]\s*(.*)$/.exec(value);
		if (!match || !match[2]) throw new UsageError(`--header "${value}" needs a name and a value, e.g. --header "Authorization: Bearer …".`);
		headers[match[1]!] = match[2].trim();
	}
	return headers;
}

export function parseChoice<T extends string>(value: string | undefined, choices: readonly T[], flag: string): T | undefined {
	if (value === undefined) return undefined;
	if (!(choices as readonly string[]).includes(value)) throw new UsageError(`${flag} must be one of ${choices.join(', ')}.`);
	return value as T;
}

/** Sources may be repeated or comma-separated: `--source runtime --source build` or `--source runtime,build`. */
export function parseSources(values: string[]): string[] {
	const sources = values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
	for (const source of sources) parseChoice(source, LOG_DRAIN_SOURCES, '--source');
	return [...new Set(sources)];
}

function scope(drain: LogDrainView): string {
	const what = drain.sources.length ? drain.sources.join(',') : 'all logs';
	const level = drain.minLevel ? ` ≥ ${drain.minLevel}` : '';
	return `${drain.project ? `project ${drain.project}` : 'org'}: ${what}${level}`;
}

export function logDrainTable(drains: LogDrainView[]): string {
	const rows = drains.map((drain) => [
		drain.id,
		drain.name,
		drain.kind === 'otlp' ? 'otlp' : `webhook/${drain.format ?? 'ndjson'}`,
		truncate(drain.url, 40),
		truncate(scope(drain), 30),
		drain.status,
		`${drain.delivery.deliveredLines} sent, ${drain.delivery.droppedLines} dropped`,
	]);
	return renderTable(['ID', 'NAME', 'KIND', 'URL', 'FORWARDS', 'STATUS', 'LINES'], rows);
}

export function logDrainDetails(drain: LogDrainView): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(10)}  ${value}`);
	const delivery = drain.delivery;
	field('Drain', `${drain.id} (${drain.name})`);
	field('Kind', drain.kind === 'otlp' ? 'OTLP/HTTP JSON' : `webhook, ${drain.format ?? 'ndjson'}${drain.signed ? ', signed (X-Yoal-Signature)' : ''}`);
	field('URL', drain.url);
	field('Forwards', scope(drain));
	if (drain.headerNames.length) field('Headers', `${drain.headerNames.join(', ')} (values hidden)`);
	if (drain.allowPrivateNetwork) field('Network', 'private addresses allowed (platform admin)');
	field('Status', drain.status);
	field('Delivered', `${delivery.deliveredLines} lines in ${delivery.deliveredBatches} batches, last ${delivery.lastDeliveredAt ? formatTime(delivery.lastDeliveredAt) : 'never'}`);
	field('Dropped', `${delivery.droppedLines} lines in ${delivery.droppedBatches} batches`);
	if (delivery.attempts > 0)
		field('Retrying', `attempt ${delivery.attempts + 1}${delivery.nextAttemptAt ? ` at ${formatTime(delivery.nextAttemptAt)}` : ''}`);
	if (delivery.lastError) field('Error', `${delivery.lastError}${delivery.lastErrorAt ? ` (${formatTime(delivery.lastErrorAt)})` : ''}`);
	field('Created', formatTime(drain.createdAt));
	return lines.join('\n');
}

export function auditTable(entries: AuditEntryView[]): string {
	const rows = entries.map((entry) => [
		formatTime(entry.createdAt),
		entry.clientId ? `${entry.actorType}:${entry.clientId}` : `${entry.actorType}${entry.actorId ? `:${entry.actorId}` : ''}`,
		entry.action,
		truncate(`${entry.resource}${entry.resourceId ? ` ${entry.resourceId}` : ''}`, 40),
		entry.result === 'ok' ? 'ok' : truncate(`error: ${entry.error ?? ''}`, 40),
	]);
	return renderTable(['TIME', 'ACTOR', 'ACTION', 'RESOURCE', 'RESULT'], rows);
}
