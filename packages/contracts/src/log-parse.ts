import type { LogLevel } from './log.ts';

/**
 * Best-effort parsing for the common line formats a PaaS ingests (DESIGN §8). Application
 * loggers, Docker/CRI envelopes, syslog, proxies and plain text all reach the same drain, so
 * the parser pulls out a level, an event time and a human message when the line declares them.
 *
 * It is pure and total: it never throws, and callers keep the raw line for storage. Detection
 * is deliberately strict where a format is ambiguous (logfmt) and lenient where the anchor is
 * unambiguous (JSON, syslog, CRI).
 */

export const parsedLogFormats = [
	'json',
	'docker',
	'cri',
	'syslog',
	'access-log',
	'logfmt',
	'python',
	'java',
	'spring',
	'dotnet',
	'text',
	'raw',
] as const;
export type ParsedLogFormat = (typeof parsedLogFormats)[number];

export interface ParsedLogLine {
	/** Human-readable message; the structured envelope is stripped where it is unambiguous. */
	message: string;
	/** Only present when the line explicitly declares it. */
	level?: LogLevel;
	/** Epoch milliseconds. Only present when the line carries an absolute time. */
	ts?: number;
	format: ParsedLogFormat;
}

export interface ParseLogLineOptions {
	/** Clock used to infer a year for year-less timestamps (RFC 3164, journald short form). */
	now?: number;
	/** Offset applied when a timestamp has no zone. Defaults to UTC so ingestion is deterministic. */
	assumeOffsetMinutes?: number;
	/** Maximum message length. Defaults to the 16 KiB line cap used by the drain. */
	maxMessageLength?: number;
}

interface NormalizedOptions {
	now: number;
	assumeOffsetMinutes: number;
	maxMessageLength: number;
}

const DEFAULT_MESSAGE_LENGTH = 16_384;
/** A hard bound before any regex or JSON work; the drain never sends more than 16 KiB. */
const MAX_PARSE_CHARS = 65_536;
const MAX_JSON_DEPTH = 4;
const MAX_LOGFMT_PAIRS = 256;
const MAX_EPOCH_MS = 8.64e15;
const MONTHS: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dec: 11,
};

/**
 * Parse one log line. Unknown or free-form lines come back as `{ format: 'raw' }` with the
 * original text, so callers can always store something.
 */
export function parseLogLine(
	line: string,
	options: ParseLogLineOptions = {},
): ParsedLogLine {
	const opts: NormalizedOptions = {
		now: Number.isFinite(options.now) ? options.now! : Date.now(),
		assumeOffsetMinutes: Number.isFinite(options.assumeOffsetMinutes)
			? options.assumeOffsetMinutes!
			: 0,
		maxMessageLength:
			Number.isFinite(options.maxMessageLength) && options.maxMessageLength! > 0
				? Math.floor(options.maxMessageLength!)
				: DEFAULT_MESSAGE_LENGTH,
	};
	let text = line;
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	if (text.endsWith('\r')) text = text.slice(0, -1);
	if (text.length > MAX_PARSE_CHARS) return make('raw', text, opts);
	const s = text.trimStart();
	if (s.length === 0) return make('raw', '', opts);

	// RFC 6587 octet-counted framing is common for TCP syslog drains (Heroku, rsyslog).
	const octet = /^(\d{1,6}) (<\d{1,3}>[\s\S]*)$/.exec(s);
	if (octet) {
		const framed = parseSyslog(octet[2]!, opts);
		if (framed) return framed;
	}

	// JSON and Docker's JSON-file envelope. A malformed object is still tagged as JSON, but a
	// bracket-prefixed text line (`[INFO] ...`) is not an array and must fall through.
	if (s[0] === '{') {
		try {
			return parseJsonValue(JSON.parse(s) as unknown, text, opts, 0);
		} catch {
			return make('json', text, opts);
		}
	}
	if (s[0] === '[') {
		try {
			return parseJsonValue(JSON.parse(s) as unknown, text, opts, 0);
		} catch {
			// Not a JSON array; keep looking for syslog/access/text formats.
		}
	}

	// Syslog, then Kubernetes CRI. Both have strong anchors and must precede generic text.
	const syslog = parseSyslog(s, opts);
	if (syslog) return syslog;

	const cri =
		/^(\d{4}-\d{2}-\d{2}T\S+)\s+(stdout|stderr)\s+([A-Za-z][\w:-]*)\s+([\s\S]*)$/.exec(
			s,
		);
	if (cri) {
		const inner = parseLogLine(cri[4]!, opts);
		const ts = toEpochMs(cri[1], opts);
		const parsed = make('cri', inner.message, opts, {
			level: inner.level,
			ts,
		});
		return parsed;
	}

	// HTTP access and error logs carry no level token, so they must be recognised by shape.
	const accessLog = parseAccessLog(s, opts);
	if (accessLog) return accessLog;

	// logfmt is the highest false-positive format; require full-line consumption and known keys.
	const fields = parseLogfmt(s);
	if (fields) return parseLogfmtLine(fields, text, opts);

	return parseText(s, text, opts);
}

function make(
	format: ParsedLogFormat,
	message: string,
	opts: NormalizedOptions,
	extra: { level?: LogLevel | undefined; ts?: number | undefined } = {},
): ParsedLogLine {
	const result: ParsedLogLine = { message: clip(message, opts), format };
	if (extra.level) result.level = extra.level;
	if (extra.ts !== undefined) result.ts = extra.ts;
	return result;
}

function clip(message: string, opts: NormalizedOptions): string {
	return message.length > opts.maxMessageLength
		? message.slice(0, opts.maxMessageLength)
		: message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getField(record: Record<string, unknown>, path: string): unknown {
	if (path in record) return record[path];
	let current: unknown = record;
	for (const part of path.split('.')) {
		if (!isRecord(current)) return undefined;
		current = current[part];
	}
	return current;
}

function parseJsonValue(
	value: unknown,
	raw: string,
	opts: NormalizedOptions,
	depth: number,
): ParsedLogLine {
	if (Array.isArray(value)) {
		if (depth > MAX_JSON_DEPTH) return make('json', raw, opts);
		const record = value.find(isRecord);
		return record
			? parseJsonRecord(record, raw, opts, depth + 1)
			: make('json', raw, opts);
	}
	if (!isRecord(value)) return make('json', raw, opts);
	return parseJsonRecord(value, raw, opts, depth + 1);
}

function parseJsonRecord(
	record: Record<string, unknown>,
	raw: string,
	opts: NormalizedOptions,
	depth: number,
): ParsedLogLine {
	// Docker JSON-file: { log, stream, time }. Unwrap the payload once; the outer time is the
	// container's receive time, the inner line may be JSON or logfmt itself.
	if (
		typeof record.log === 'string' &&
		(record.stream === 'stdout' || record.stream === 'stderr')
	) {
		const inner = parseEnvelopePayload(record.log, opts, depth);
		const ts = toEpochMs(record.time, opts) ?? inner.ts;
		return make('docker', inner.message, opts, { level: inner.level, ts });
	}

	// OTLP/JSON batch: resourceLogs[].scopeLogs[].logRecords[].
	const otelRecord = firstOtelRecord(record);
	if (otelRecord) return parseJsonRecord(otelRecord, raw, opts, depth + 1);

	const ts = firstTimestamp(record, opts);
	const level = levelFromRecord(record);
	const message = firstMessage(record) ?? raw;
	// Journald's JSON export uses MESSAGE/PRIORITY/__REALTIME_TIMESTAMP through the same keys.
	return make('json', message, opts, { level, ts });
}

function parseEnvelopePayload(
	payload: string,
	opts: NormalizedOptions,
	depth: number,
): ParsedLogLine {
	const text = payload.replace(/\n$/, '');
	if (depth <= MAX_JSON_DEPTH && (text.startsWith('{') || text.startsWith('['))) {
		try {
			const value = JSON.parse(text) as unknown;
			if (isRecord(value) || Array.isArray(value))
				return parseJsonValue(value, text, opts, depth + 1);
		} catch {
			// Not JSON after all; fall through to the text parsers.
		}
	}
	return parseLogLine(text, opts);
}

function firstOtelRecord(
	record: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const resources = record.resourceLogs;
	if (!Array.isArray(resources)) return undefined;
	for (const resource of resources) {
		if (!isRecord(resource) || !Array.isArray(resource.scopeLogs)) continue;
		for (const scope of resource.scopeLogs) {
			if (!isRecord(scope) || !Array.isArray(scope.logRecords)) continue;
			for (const logRecord of scope.logRecords) {
				if (isRecord(logRecord)) return logRecord;
			}
		}
	}
	return undefined;
}

const MESSAGE_KEYS = [
	'message',
	'msg',
	'@m',
	'@mt',
	'event',
	'log',
	'MESSAGE',
	'Message',
	'body.stringValue',
	'body',
	'err.message',
	'error.message',
	'exception.message',
	'stacktrace',
	'stack',
	'@x',
];
const TIMESTAMP_KEYS = [
	'@timestamp',
	'time',
	'ts',
	'@t',
	'timestamp',
	'Timestamp',
	'timeUnixNano',
	'observedTimeUnixNano',
	'__REALTIME_TIMESTAMP',
	'date',
	'datetime',
];
const LEVEL_KEYS = [
	'level',
	'log.level',
	'severityText',
	'severity',
	'@l',
	'LogLevel',
	'levelname',
	'PRIORITY',
	'severityNumber',
	'lvl',
	'l',
	'log_level',
];

function firstMessage(record: Record<string, unknown>): string | undefined {
	for (const key of MESSAGE_KEYS) {
		const text = messageText(getField(record, key));
		if (text !== undefined && text.length > 0) return text;
	}
	return undefined;
}

function messageText(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (isRecord(value)) {
		for (const key of ['message', 'stringValue', 'text', 'msg']) {
			const text = messageText(value[key]);
			if (text !== undefined) return text;
		}
	}
	return undefined;
}

function firstTimestamp(
	record: Record<string, unknown>,
	opts: NormalizedOptions,
): number | undefined {
	for (const key of TIMESTAMP_KEYS) {
		const ts = toEpochMs(getField(record, key), opts);
		if (ts !== undefined) return ts;
	}
	return undefined;
}

function levelFromRecord(record: Record<string, unknown>): LogLevel | undefined {
	for (const key of LEVEL_KEYS) {
		const level = levelFromValue(getField(record, key), key, record);
		if (level) return level;
	}
	return undefined;
}

function levelFromValue(
	value: unknown,
	key: string,
	record: Record<string, unknown>,
): LogLevel | undefined {
	if (typeof value === 'string') {
		if (key === 'PRIORITY' && /^\d{1,3}$/.test(value.trim()))
			return levelForSeverity(Number(value));
		if (key === 'severityNumber' && /^\d{1,3}$/.test(value.trim()))
			return levelForOtel(Number(value));
		return levelFromWord(value);
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	if (key === 'PRIORITY') return levelForSeverity(value);
	if (key === 'severityNumber') return levelForOtel(value);
	// pino/bunyan numeric levels are 10..60 in steps of ten. Only apply the mapping when the
	// value actually matches that shape; a bare 0..6 is too ambiguous to guess from context.
	if (value >= 10 && value <= 60 && value % 10 === 0) return levelForPino(value);
	// Winston/npm levels are 0..6, but only trust them when the document looks like Winston.
	if (
		value >= 0 &&
		value <= 6 &&
		('message' in record || 'timestamp' in record)
	)
		return levelForNpm(value);
	return undefined;
}

function levelFromWord(input: string): LogLevel | undefined {
	const word = input
		.trim()
		.replace(/^\[|\]$/g, '')
		.replace(/\+\d+$/, '')
		.toLowerCase();
	switch (word) {
		case 'trace':
		case 'trc':
		case 'verbose':
		case 'silly':
		case 'finest':
		case 'fine':
		case 'debug':
		case 'dbg':
		case 'dbug':
			return 'debug';
		case 'info':
		case 'information':
		case 'informational':
		case 'notice':
		case 'config':
		case 'http':
		case 'log':
		case 'i':
			return 'info';
		case 'warn':
		case 'warning':
		case 'wrn':
			return 'warn';
		case 'error':
		case 'err':
		case 'fail':
		case 'failed':
		case 'failure':
		case 'severe':
		case 'dpanic':
		case 'fatal':
		case 'crit':
		case 'critical':
		case 'panic':
		case 'emerg':
		case 'emergency':
		case 'alert':
			return 'error';
		default:
			return undefined;
	}
}

function levelForSeverity(value: number): LogLevel | undefined {
	if (!Number.isInteger(value) || value < 0) return undefined;
	if (value <= 3) return 'error';
	if (value === 4) return 'warn';
	if (value <= 6) return 'info';
	if (value === 7) return 'debug';
	return undefined;
}

function levelForPino(value: number): LogLevel | undefined {
	if (value <= 20) return 'debug';
	if (value <= 30) return 'info';
	if (value <= 40) return 'warn';
	return 'error';
}

function levelForOtel(value: number): LogLevel | undefined {
	if (value >= 1 && value <= 4) return 'debug';
	if (value >= 5 && value <= 8) return 'debug';
	if (value >= 9 && value <= 12) return 'info';
	if (value >= 13 && value <= 16) return 'warn';
	if (value >= 17 && value <= 24) return 'error';
	return undefined;
}

function levelForNpm(value: number): LogLevel | undefined {
	if (value === 0) return 'error';
	if (value === 1) return 'warn';
	if (value === 2) return 'info';
	if (value === 3) return 'info';
	if (value === 4) return 'debug';
	if (value === 5) return 'debug';
	if (value === 6) return 'debug';
	return undefined;
}

function levelForStatus(status: number): LogLevel {
	if (status >= 500) return 'error';
	if (status >= 400) return 'warn';
	return 'info';
}

/** Parse RFC 5424/3164, with or without the RFC 6587 octet-count prefix already removed. */
function parseSyslog(line: string, opts: NormalizedOptions): ParsedLogLine | undefined {
	const rfc5424 =
		/^<(\d{1,3})>(\d{1,2}) (\S+) (\S+) (\S+) (\S+) (\S+) ([\s\S]*)$/.exec(line);
	if (rfc5424 && Number(rfc5424[2]) === 1) {
		const severity = levelForSeverity(Number(rfc5424[1]) % 8);
		const message = split5424Message(rfc5424[8]!);
		const inner = looksStructured(message) ? parseLogLine(message, opts) : undefined;
		const text = (inner?.message ?? message).replace(/^\uFEFF/, '');
		return make('syslog', text, opts, {
			level: inner?.level ?? severity,
			ts: toEpochMs(rfc5424[3], opts),
		});
	}

	const rfc3164 =
		/^<(\d{1,3})>([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\S+) ([\s\S]*)$/.exec(
			line,
		);
	if (!rfc3164) return undefined;
	const severity = levelForSeverity(Number(rfc3164[1]) % 8);
	const body = stripSyslogTag(rfc3164[8]!);
	const inner = looksStructured(body) ? parseLogLine(body, opts) : undefined;
	return make('syslog', inner?.message ?? body, opts, {
		level: inner?.level ?? severity,
		ts: fromMonthDay(
			rfc3164[2]!,
			Number(rfc3164[3]),
			Number(rfc3164[4]),
			Number(rfc3164[5]),
			Number(rfc3164[6]),
			opts,
		),
	});
}

/** Remove the structured-data section from an RFC 5424 tail, returning only MSG. */
function split5424Message(rest: string): string {
	if (rest.startsWith('-')) return rest.slice(1).trimStart();
	if (!rest.startsWith('[')) return rest;
	let index = 0;
	while (index < rest.length && rest[index] === '[') {
		index++;
		let quoted = false;
		while (index < rest.length) {
			const char = rest[index]!;
			if (quoted) {
				if (char === '\\') {
					index += 2;
					continue;
				}
				if (char === '"') quoted = false;
				index++;
				continue;
			}
			if (char === '"') {
				quoted = true;
				index++;
			} else if (char === ']') {
				index++;
				break;
			} else {
				index++;
			}
		}
	}
	return rest.slice(index).trimStart();
}

function stripSyslogTag(body: string): string {
	const match = /^[A-Za-z0-9_./-]+(?:\[\d+\])?:\s?([\s\S]*)$/.exec(body);
	return match ? match[1]! : body;
}

function looksStructured(text: string): boolean {
	return text.startsWith('{') || /^[A-Za-z_][\w.-]*=/.test(text);
}

function parseAccessLog(
	line: string,
	opts: NormalizedOptions,
): ParsedLogLine | undefined {
	const combined =
		/^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\S+)(?: "[^"]*" "[^"]*")?(?: .*)?$/.exec(
			line,
		);
	if (combined) {
		const status = Number(combined[4]);
		const request = combined[3]!.trim();
		return make(
			'access-log',
			request ? `${request} ${status}` : line,
			opts,
			{ level: levelForStatus(status), ts: toEpochMs(combined[2], opts) },
		);
	}

	const nginx =
		/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \[([a-z]+)\] (?:\d+#\d+: )?(?:\*\d+ )?([\s\S]*)$/.exec(
			line,
		);
	if (nginx) {
		return make('text', nginx[3]!, opts, {
			level: levelFromWord(nginx[2]!),
			ts: toEpochMs(nginx[1], opts),
		});
	}

	const apache =
		/^\[([A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})? \d{4})\] \[(?:[^\]:]+:)?([A-Za-z0-9]+)\] ([\s\S]*)$/.exec(
			line,
		);
	if (apache) {
		return make('text', apache[3]!.replace(/^(?:\[[^\]]*\]\s*)+/, ''), opts, {
			level: levelFromWord(apache[2]!),
			ts: toEpochMs(apache[1], opts),
		});
	}

	return undefined;
}

const LOGFMT_KNOWN_KEYS = new Set([
	'level',
	'lvl',
	'severity',
	'msg',
	'message',
	'event',
	'time',
	'ts',
	'timestamp',
	'at',
	'method',
	'path',
	'status',
	'host',
	'request_id',
	'error',
	'err',
	'caller',
	'logger',
	'service',
	'pid',
	'duration',
	'bytes',
]);

/** Strict, quote-aware logfmt scanner. Returns undefined unless the whole line is pairs. */
function parseLogfmt(line: string): Map<string, string> | undefined {
	const fields = new Map<string, string>();
	let index = 0;
	let pairs = 0;
	let known = false;
	const length = line.length;

	while (index < length) {
		while (index < length && (line[index] === ' ' || line[index] === '\t')) index++;
		if (index >= length) break;
		const keyStart = index;
		while (index < length) {
			const char = line[index]!;
			if (char === '=' || char === ' ' || char === '\t') break;
			if (char === '"') return undefined;
			index++;
		}
		const key = line.slice(keyStart, index);
		if (key.length === 0 || line[index] !== '=') return undefined;
		index++;

		let value = '';
		if (line[index] === '"') {
			index++;
			let closed = false;
			while (index < length) {
				const char = line[index++]!;
				if (char === '"') {
					closed = true;
					break;
				}
				if (char !== '\\') {
					value += char;
					continue;
				}
				if (index >= length) return undefined;
				const escape = line[index++]!;
				if (escape === 'u' || escape === 'x') {
					const width = escape === 'u' ? 4 : 2;
					const hex = line.slice(index, index + width);
					if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex))
						return undefined;
					value += String.fromCharCode(parseInt(hex, 16));
					index += width;
					continue;
				}
				const decoded = decodeLogfmtEscape(escape);
				if (decoded === undefined) return undefined;
				value += decoded;
			}
			if (!closed) return undefined;
			if (
				index < length &&
				line[index] !== ' ' &&
				line[index] !== '\t'
			)
				return undefined;
		} else {
			const valueStart = index;
			while (index < length && line[index] !== ' ' && line[index] !== '\t') index++;
			value = line.slice(valueStart, index);
		}

		fields.set(key, value);
		pairs++;
		if (LOGFMT_KNOWN_KEYS.has(key)) known = true;
		if (pairs > MAX_LOGFMT_PAIRS) return undefined;
	}

	// A single pair or a pair of unknown keys is far more likely to be prose than a log record.
	if (pairs < 2 || (!known && pairs < 3)) return undefined;
	return fields;
}

function decodeLogfmtEscape(escape: string): string | undefined {
	switch (escape) {
		case '"':
			return '"';
		case '\\':
			return '\\';
		case '/':
			return '/';
		case 'b':
			return '\b';
		case 'f':
			return '\f';
		case 'n':
			return '\n';
		case 'r':
			return '\r';
		case 't':
			return '\t';
		default:
			return undefined;
	}
}

function parseLogfmtLine(
	fields: Map<string, string>,
	raw: string,
	opts: NormalizedOptions,
): ParsedLogLine {
	let level: LogLevel | undefined;
	for (const key of ['level', 'lvl', 'severity', 'at']) {
		const value = fields.get(key);
		if (value === undefined) continue;
		level = levelFromWord(value);
		if (level) break;
	}

	let ts: number | undefined;
	for (const key of ['time', 'ts', 'timestamp', 'at']) {
		ts = toEpochMs(fields.get(key), opts);
		if (ts !== undefined) break;
	}

	const message =
		fields.get('msg') ??
		fields.get('message') ??
		fields.get('event') ??
		raw;
	return make('logfmt', message, opts, { level, ts });
}

function parseText(
	line: string,
	raw: string,
	opts: NormalizedOptions,
): ParsedLogLine {
	// Python logging.basicConfig(): LEVEL:name:message
	let match =
		/^(DEBUG|INFO|WARNING|ERROR|CRITICAL|NOTSET):([^:]+):\s?([\s\S]*)$/.exec(line);
	if (match) {
		return make('python', match[3]!, opts, { level: levelFromWord(match[1]!) });
	}

	// Python logging with asctime and " - name - LEVEL - " formatter.
	match =
		/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[,.]\d{1,6})\s+-\s+([^-]+?)\s+-\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+-\s+([\s\S]*)$/.exec(
			line,
		);
	if (match) {
		return make('python', match[4]!, opts, {
			level: levelFromWord(match[3]!),
			ts: toEpochMs(match[1], opts),
		});
	}

	// Spring Boot default: ISO timestamp, level, PID, --- [app] [thread] logger : message
	match =
		/^(\d{4}-\d{2}-\d{2}T\S+)\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+\d+\s+---\s+\[[^\]]*\]\s+\[[^\]]*\]\s+\S+\s+:\s+([\s\S]*)$/.exec(
			line,
		);
	if (match) {
		return make('spring', match[3]!, opts, {
			level: levelFromWord(match[2]!),
			ts: toEpochMs(match[1], opts),
		});
	}

	// log4j2/Logback default with a full date.
	match =
		/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[,.]\d{1,6})\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\s+(?:\[[^\]]+\]\s+)?(\S+)\s+-\s+([\s\S]*)$/.exec(
			line,
		);
	if (match) {
		return make('java', match[4]!, opts, {
			level: levelFromWord(match[2]!),
			ts: toEpochMs(match[1], opts),
		});
	}

	// log4j2's default pattern is time-only, so it has no absolute date to extract.
	match =
		/^(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s+\[[^\]]*\]\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\s+(\S+)\s+-\s+([\s\S]*)$/.exec(
			line,
		);
	if (match) {
		return make('java', match[4]!, opts, { level: levelFromWord(match[2]!) });
	}

	// .NET console default: level: Category[EventId], with the message on following indented lines.
	match = /^(trce|dbug|info|warn|fail|crit):\s+([\s\S]*)$/.exec(line);
	if (match) {
		return make('dotnet', raw, opts, { level: levelFromWord(match[1]!) });
	}

	// journald short form (no PRI): Mmm dd HH:mm:ss host app[pid]: message
	match =
		/^([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\S+) ([\s\S]*)$/.exec(
			line,
		);
	if (match) {
		return make('text', stripSyslogTag(match[7]!), opts, {
			ts: fromMonthDay(
				match[1]!,
				Number(match[2]),
				Number(match[3]),
				Number(match[4]),
				Number(match[5]),
				opts,
			),
		});
	}

	// Generic ISO/space timestamp + LEVEL, with optional brackets and separators.
	match =
		/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)\s+[\[(]?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT|NOTICE|SEVERE)[\])]?\s*[:\-|]?\s+([\s\S]*)$/i.exec(
			line,
		);
	if (match) {
		return make('text', match[3]!, opts, {
			level: levelFromWord(match[2]!),
			ts: toEpochMs(match[1], opts),
		});
	}

	// Prefix with a source name and timestamp inside brackets: [skiff-agent 2026-11-03T23:23:02Z] INFO ...
	match =
		/^\[([^\]\s]+)\s+(\d{4}-\d{2}-\d{2}T\S+)\]\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|NOTICE|SEVERE)\s+([\s\S]*)$/.exec(
			line,
		);
	if (match) {
		return make('text', match[4]!, opts, {
			level: levelFromWord(match[3]!),
			ts: toEpochMs(match[2], opts),
		});
	}

	// Bracket-prefixed level: [INFO] message
	match =
		/^\[(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|NOTICE|SEVERE)\]\s*([\s\S]*)$/i.exec(
			line,
		);
	if (match) {
		return make('text', match[2]!, opts, { level: levelFromWord(match[1]!) });
	}

	// Bare upper-case level at the start: INFO message, WARN: message, ERROR - message
	match =
		/^(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|NOTICE|SEVERE)\s*[:\-|]?\s+([\s\S]+)$/.exec(
			line,
		);
	if (match) {
		return make('text', match[2]!, opts, { level: levelFromWord(match[1]!) });
	}

	// The diagnostics below carry their level in prose rather than a level column, so the
	// whole line stays as the message; only the level is inferred.
	const diagnostic = diagnosticLevel(line, raw);
	if (diagnostic) return make('text', raw, opts, { level: diagnostic });

	return make('raw', raw, opts);
}

/**
 * CLI and runtime diagnostics that most app output actually consists of: bun/cargo/go/git
 * (`error: …`, `warning: …`), package managers (`npm ERR!`), uncaught exceptions
 * (`TypeError: …`, `java.lang.IllegalStateException: …`), Python tracebacks and stack frames.
 */
function diagnosticLevel(line: string, raw: string): LogLevel | undefined {
	if (/^(?:error|fatal|panic)(?:\[[^\]\s]*\])?:\s/i.test(line)) return 'error';
	if (/^(?:warning|warn)(?:\[[^\]\s]*\])?:\s/i.test(line)) return 'warn';
	if (/^(?:npm|pnpm|yarn)\s+(?:ERR!|error)(?:\s|$)/i.test(line)) return 'error';
	if (/^(?:npm|pnpm|yarn)\s+(?:WARN|warning)(?:\s|$)/i.test(line)) return 'warn';
	if (/^ERR_PNPM_\w+/.test(line)) return 'error';
	if (
		/^(?:Uncaught |Unhandled )?(?:[a-z_$][\w$]*\.)*(?:[A-Z][\w$]*)?(?:Error|Exception)(?: \[[A-Z0-9_]+\])?(?::\s|$)/.test(
			line,
		)
	)
		return 'error';
	if (/^Exception in thread /.test(line)) return 'error';
	if (/^Traceback \(most recent call last\):$/.test(line)) return 'error';
	// Stack frames only count when indented, so a sentence starting with "at" stays plain text.
	if (/^\s/.test(raw)) {
		if (/^at \S.*(?::\d+(?::\d+)?\)?|\((?:native|<anonymous>|Unknown Source)\))$/.test(line))
			return 'error';
		if (/^File "[^"]+", line \d+/.test(line)) return 'error';
	}
	return undefined;
}

const ISO_DATE =
	/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;
const SLASH_DATE =
	/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?$/;
const ACCESS_DATE =
	/^(\d{1,2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;
const MONTH_DAY = /^([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2})$/;
const APACHE_DATE =
	/^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))? (\d{4})$/;

function toEpochMs(
	value: unknown,
	opts: NormalizedOptions,
): number | undefined {
	if (typeof value === 'number') return epochFromNumber(value);
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	if (text.length === 0) return undefined;
	if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return epochFromNumber(Number(text));

	const iso = ISO_DATE.exec(text);
	if (iso) {
		return fromParts(
			Number(iso[1]),
			Number(iso[2]),
			Number(iso[3]),
			Number(iso[4]),
			Number(iso[5]),
			Number(iso[6]),
			iso[7],
			iso[8],
			opts,
		);
	}

	const slash = SLASH_DATE.exec(text);
	if (slash) {
		return fromParts(
			Number(slash[1]),
			Number(slash[2]),
			Number(slash[3]),
			Number(slash[4]),
			Number(slash[5]),
			Number(slash[6]),
			slash[7],
			undefined,
			opts,
		);
	}

	const access = ACCESS_DATE.exec(text);
	if (access) {
		const month = MONTHS[access[2]!.toLowerCase()];
		if (month === undefined) return undefined;
		const sign = access[7] === '-' ? -1 : 1;
		const offset = sign * (Number(access[8]) * 60 + Number(access[9]));
		return validEpoch(
			Date.UTC(
				Number(access[3]),
				month,
				Number(access[1]),
				Number(access[4]),
				Number(access[5]),
				Number(access[6]),
			) -
				offset * 60_000,
		);
	}

	const monthDay = MONTH_DAY.exec(text);
	if (monthDay) {
		return fromMonthDay(
			monthDay[1]!,
			Number(monthDay[2]),
			Number(monthDay[3]),
			Number(monthDay[4]),
			Number(monthDay[5]),
			opts,
		);
	}

	const apache = APACHE_DATE.exec(text);
	if (apache) {
		const month = MONTHS[apache[1]!.toLowerCase()];
		if (month === undefined) return undefined;
		return validEpoch(
			Date.UTC(
				Number(apache[7]),
				month,
				Number(apache[2]),
				Number(apache[3]),
				Number(apache[4]),
				Number(apache[5]),
				fractionMs(apache[6]),
			) -
				opts.assumeOffsetMinutes * 60_000,
		);
	}

	return undefined;
}

function fromParts(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	fraction: string | undefined,
	zone: string | undefined,
	opts: NormalizedOptions,
): number | undefined {
	const offset = zone ? zoneOffsetMinutes(zone) : opts.assumeOffsetMinutes;
	if (offset === undefined) return undefined;
	return validEpoch(
		Date.UTC(year, month - 1, day, hour, minute, second, fractionMs(fraction)) -
			offset * 60_000,
	);
}

function fromMonthDay(
	monthText: string,
	day: number,
	hour: number,
	minute: number,
	second: number,
	opts: NormalizedOptions,
): number | undefined {
	const month = MONTHS[monthText.toLowerCase()];
	if (month === undefined) return undefined;
	const year = new Date(opts.now).getUTCFullYear();
	let ms = Date.UTC(year, month, day, hour, minute, second) - opts.assumeOffsetMinutes * 60_000;
	// A year-less date more than a day in the future is from last year.
	if (ms > opts.now + 86_400_000)
		ms = Date.UTC(year - 1, month, day, hour, minute, second) - opts.assumeOffsetMinutes * 60_000;
	return validEpoch(ms);
}

function zoneOffsetMinutes(zone: string): number | undefined {
	if (zone === 'Z') return 0;
	const match = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
	if (!match) return undefined;
	const sign = match[1] === '-' ? -1 : 1;
	return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function fractionMs(fraction: string | undefined): number {
	if (!fraction) return 0;
	return Number(fraction.padEnd(3, '0').slice(0, 3));
}

function epochFromNumber(value: number): number | undefined {
	if (!Number.isFinite(value)) return undefined;
	const magnitude = Math.abs(value);
	let ms: number;
	if (magnitude === 0) ms = 0;
	else if (magnitude < 1e11) ms = value * 1_000;
	else if (magnitude < 1e14) ms = value;
	else if (magnitude < 1e17) ms = value / 1_000;
	else ms = value / 1_000_000;
	return validEpoch(ms);
}

function validEpoch(ms: number): number | undefined {
	if (!Number.isFinite(ms) || Math.abs(ms) > MAX_EPOCH_MS) return undefined;
	return Math.floor(ms);
}
