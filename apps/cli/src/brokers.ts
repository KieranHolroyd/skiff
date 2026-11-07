/**
 * Managed queue brokers (docs/BROKERS.md, D111): the wire types the CLI reads, and pure formatting
 * for `skif broker`. Types mirror `packages/contracts/src/broker.ts`; the CLI bundle stays free of
 * runtime dependencies (D40), so keep them in sync.
 */
import { UsageError } from './errors.ts';
import {
	NODE_TASK_LIMITS,
	QUEUE_HEADERS,
	QUEUE_STREAM_PREFIX,
	type BrokerQueueSendResult,
	type BrokerStreamPeekResult,
	type PeekedMessage,
} from './node-tasks.ts';
import { formatBytes, formatNumber, formatTime, plural, renderTable, truncate } from './output.ts';

/** Mirrors `brokerEngines` in @skiff/contracts. Keep in sync; the server validates. */
export const BROKER_ENGINES = ['nats'] as const;

export type BrokerStatus = 'pending' | 'starting' | 'running' | 'failed' | 'stopped';

export interface BrokerAttachmentView {
	brokerId: string;
	brokerName: string;
	projectId: string;
	projectSlug: string;
	envPrefix: string;
	envNames: string[];
	createdAt: string;
}

export interface BrokerView {
	id: string;
	name: string;
	engine: string;
	engineLabel: string;
	protocol: string;
	version: string;
	upgradeVersions: string[];
	status: BrokerStatus;
	message: string | null;
	nodeId: string;
	nodeName: string | null;
	memoryMb: number;
	cpus: number;
	storageMb: number;
	username: string;
	internalHost: { process: string; container: string };
	volume: { id: string; name: string } | null;
	attachments: BrokerAttachmentView[];
	/** Newest node sample (D123); absent from servers that predate broker metrics. */
	storeBytes?: number | null;
	messages?: number | null;
	statsAt?: string | null;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	purgeAt: string | null;
}

/** One `GET /brokers/:name/metrics` point (D123). Hourly points average gauges and sum deltas. */
export interface BrokerMetricPoint {
	bucket: string;
	up: number;
	connections: number;
	streams: number;
	consumers: number;
	storeBytes: number;
	storeLimitBytes: number;
	memoryStoreBytes: number;
	messages: number;
	pending: number;
	ackPending: number;
	redelivered: number;
	oldestAgeSeconds: number;
	published: number;
	messagesIn: number;
	messagesOut: number;
	bytesIn: number;
	bytesOut: number;
	slowConsumers: number;
	memoryBytes: number;
}

export interface BrokerConsumerStats {
	name: string;
	pending: number;
	ackPending: number;
	redelivered: number;
	waiting: number;
	lastDeliveredAt: string | null;
}

export interface BrokerStreamStats {
	stream: string;
	queue: string | null;
	subjects: string[];
	storage: 'file' | 'memory';
	retention: string;
	messages: number;
	bytes: number;
	maxBytes: number | null;
	firstAt: string | null;
	lastAt: string | null;
	consumerCount: number;
	pending: number;
	ackPending: number;
	redelivered: number;
	consumers: BrokerConsumerStats[];
}

/** `GET /brokers/:name/queues`: the newest stream listing the node reported. */
export interface BrokerQueuesView {
	brokerId: string;
	name: string;
	at: string | null;
	truncated: boolean;
	streams: BrokerStreamStats[];
}

export interface BrokerCredentials {
	brokerId: string;
	name: string;
	username: string;
	password: string;
	url: string;
	host: string;
	port: number;
	connectionSnippets: Record<string, string>;
	note: string;
}

export interface BrokerCreateInput {
	name: string;
	engine?: string;
	version?: string;
	placement?: string;
	memoryMb?: number;
	cpus?: number;
	storageMb?: number;
	volume?: string;
	project?: string;
	envPrefix?: string;
}

export interface BrokerUpdateInput {
	memoryMb?: number;
	cpus?: number;
	storageMb?: number;
	version?: string;
}

function statusLabel(view: Pick<BrokerView, 'status' | 'deletedAt'>): string {
	return view.deletedAt ? 'deleted' : view.status;
}

function megabytes(mb: number): string {
	return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024}G` : `${mb}M`;
}

export function brokerTable(brokers: BrokerView[]): string {
	const rows = brokers.map((view) => [
		view.name,
		statusLabel(view),
		`${view.engineLabel} ${view.version}`,
		view.nodeName ?? view.nodeId,
		`${megabytes(view.memoryMb)} / ${megabytes(view.storageMb)}`,
		view.attachments.length ? truncate(view.attachments.map((item) => item.projectSlug).join(', '), 30) : '-',
		formatTime(view.createdAt),
	]);
	return renderTable(['NAME', 'STATUS', 'ENGINE', 'NODE', 'MEMORY / STORE', 'PROJECTS', 'CREATED'], rows);
}

/** The `skif broker info` report. */
export function brokerDetails(view: BrokerView): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(10)}  ${value}`);
	field('Broker', view.name);
	field('Status', `${statusLabel(view)}${view.message ? ` (${view.message})` : ''}`);
	field('Engine', `${view.engineLabel} ${view.version} — ${view.protocol}`);
	if (view.upgradeVersions.length > 0) field('Upgrades', view.upgradeVersions.join(', '));
	field('Node', view.nodeName ? `${view.nodeName} (${view.nodeId})` : view.nodeId);
	field('Limits', `${megabytes(view.memoryMb)} memory, ${view.cpus} CPU, ${megabytes(view.storageMb)} message store`);
	if (view.storeBytes !== null && view.storeBytes !== undefined)
		field(
			'Stored',
			`${formatBytes(view.storeBytes)} of ${megabytes(view.storageMb)}${view.messages !== null && view.messages !== undefined ? `, ${formatNumber(view.messages)} messages` : ''}`,
		);
	if (view.volume) field('Volume', view.volume.name);
	field('User', view.username);
	field('Process', view.internalHost.process);
	field('Container', view.internalHost.container);
	field('Created', formatTime(view.createdAt));
	if (view.attachments.length === 0) lines.push('\nNot attached to any project.');
	else {
		lines.push('\nAttached to:');
		for (const item of view.attachments) lines.push(`  ${item.projectSlug.padEnd(24)} ${item.envNames.join(', ')}`);
	}
	return lines.join('\n');
}

// --- metrics (D123) ---------------------------------------------------------

/** Compact seconds: 45s, 12m, 3h 5m, 2d 4h. */
export function formatAge(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m`;
	return `${Math.floor(seconds)}s`;
}

const whole = (value: number) => formatNumber(Math.round(value));

/** `skif broker metrics`: the newest sample, then totals over the range. */
export function brokerMetricsSummary(points: BrokerMetricPoint[], storageMb: number): string {
	const sorted = [...points].sort((a, b) => a.bucket.localeCompare(b.bucket));
	const latest = sorted.at(-1);
	if (!latest) return '';
	const budget = storageMb * 1024 * 1024;
	const sum = (key: 'published' | 'messagesIn' | 'messagesOut' | 'slowConsumers') =>
		sorted.reduce((total, point) => total + point[key], 0);
	const uptime = sorted.reduce((total, point) => total + point.up, 0) / sorted.length;
	const peak = Math.max(...sorted.map((point) => point.pending + point.ackPending));
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(12)}  ${value}`);
	field('Latest', `${formatTime(latest.bucket)} (${latest.up >= 0.5 ? 'up' : 'down'})`);
	field(
		'Store',
		`${formatBytes(latest.storeBytes)} of ${formatBytes(budget)}${budget > 0 ? ` (${Math.round((latest.storeBytes / budget) * 100)}%)` : ''}`,
	);
	field('Messages', `${whole(latest.messages)} held in ${whole(latest.streams)} streams`);
	field(
		'Backlog',
		`${whole(latest.pending)} pending, ${whole(latest.ackPending)} awaiting ack, ${whole(latest.redelivered)} redelivered`,
	);
	field('Oldest', latest.oldestAgeSeconds > 0 ? formatAge(latest.oldestAgeSeconds) : 'nothing waiting');
	field('Clients', `${whole(latest.connections)} connections, ${whole(latest.consumers)} consumers`);
	field('Memory', formatBytes(Math.round(latest.memoryBytes)));
	lines.push('');
	field('In range', `${whole(sum('published'))} stored, ${whole(sum('messagesIn'))} in, ${whole(sum('messagesOut'))} out`);
	field('Peak backlog', whole(peak));
	field('Uptime', `${(uptime * 100).toFixed(uptime < 1 ? 1 : 0)}%`);
	const slow = sum('slowConsumers');
	if (slow > 0) field('Slow', `${whole(slow)} clients cut off as slow consumers`);
	return lines.join('\n');
}

/** `skif broker metrics` sample rows. */
export function brokerMetricsTable(points: BrokerMetricPoint[]): string {
	const sorted = [...points].sort((a, b) => a.bucket.localeCompare(b.bucket));
	return renderTable(
		['TIME', 'UP', 'CONNS', 'STORE', 'MESSAGES', 'PENDING', 'ACK', 'IN', 'OUT', 'OLDEST'],
		sorted.map((point) => [
			formatTime(point.bucket),
			point.up >= 0.999 ? 'yes' : point.up <= 0.001 ? 'no' : `${Math.round(point.up * 100)}%`,
			whole(point.connections),
			formatBytes(Math.round(point.storeBytes)),
			whole(point.messages),
			whole(point.pending),
			whole(point.ackPending),
			whole(point.messagesIn),
			whole(point.messagesOut),
			point.oldestAgeSeconds > 0 ? formatAge(point.oldestAgeSeconds) : '-',
		]),
	);
}

/** `skif broker queues`: one row per stream, consumers indented below it. */
export function brokerQueuesTable(view: BrokerQueuesView): string {
	const listed = view.at ? Date.parse(view.at) : Number.NaN;
	const rows: string[][] = [];
	for (const stream of view.streams) {
		const first = stream.firstAt ? Date.parse(stream.firstAt) : Number.NaN;
		const oldest =
			stream.messages > 0 && Number.isFinite(first) && Number.isFinite(listed) ? formatAge((listed - first) / 1000) : '-';
		rows.push([
			truncate(stream.queue ?? stream.stream, 40),
			stream.queue ? 'queue' : stream.retention,
			whole(stream.messages),
			formatBytes(stream.bytes),
			whole(stream.consumerCount),
			whole(stream.pending),
			whole(stream.ackPending),
			whole(stream.redelivered),
			oldest,
		]);
		for (const consumer of stream.consumers)
			rows.push([
				`  └ ${truncate(consumer.name, 36)}`,
				'consumer',
				'',
				'',
				'',
				whole(consumer.pending),
				whole(consumer.ackPending),
				whole(consumer.redelivered),
				'',
			]);
	}
	return renderTable(['STREAM', 'KIND', 'MESSAGES', 'BYTES', 'CONSUMERS', 'PENDING', 'ACK', 'REDELIVERED', 'OLDEST'], rows);
}

// --- queue tools (D124) -----------------------------------------------------

/** Mirrors `functionQueueNameSchema` in @skiff/contracts. */
const QUEUE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function assertQueueName(value: string, what = 'queue'): void {
	if (value.length > 63 || !QUEUE_NAME.test(value))
		throw new UsageError(
			`"${value}" is not a function ${what} name: lowercase letters, digits and hyphens (at most 63). For a stream your app created itself, pass --stream <name>.`,
		);
}

/** The JetStream stream that holds function queue `queue`. */
export function queueStreamName(queue: string): string {
	return `${QUEUE_STREAM_PREFIX}${queue}`;
}

/** The function queue a stream name holds, or null for a stream an app created itself. */
export function queueOfStream(stream: string): string | null {
	return stream.startsWith(QUEUE_STREAM_PREFIX) ? stream.slice(QUEUE_STREAM_PREFIX.length) || null : null;
}

/**
 * The stream a queue command acts on: a function queue name maps to `SKIFF_Q_<queue>`, and
 * `--stream` names a raw JetStream stream. Exactly one of the two.
 */
export function resolveStream(queue: string | undefined, stream: string | undefined): { stream: string; label: string } {
	if (queue !== undefined && stream !== undefined)
		throw new UsageError('Name a queue or pass --stream <name>, not both.');
	if (stream !== undefined) {
		if (!stream || /[\s.*>/\\\u0000-\u001f]/.test(stream) || stream.length > 256)
			throw new UsageError('Stream names cannot contain spaces, dots, wildcards or slashes.');
		return { stream, label: `stream ${stream}` };
	}
	if (queue === undefined) throw new UsageError('Name a queue, or pass --stream <name>.');
	assertQueueName(queue);
	return { stream: queueStreamName(queue), label: `queue ${queue} (${queueStreamName(queue)})` };
}

/** A whole number flag in a range. */
export function parseCount(value: string, flag: string, min: number, max: number): number {
	const trimmed = value.trim();
	const number = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
	if (!Number.isInteger(number) || number < min || number > max)
		throw new UsageError(`${flag} must be a whole number from ${formatNumber(min)} to ${formatNumber(max)}.`);
	return number;
}

/** `--delay`: seconds, or a duration like 30s, 5m or 2h (at most 12h, as Cloudflare's `delaySeconds`). */
export function parseDelaySeconds(value: string): number {
	const match = /^(\d+)\s*([smh]?)$/i.exec(value.trim());
	if (!match) throw new UsageError('--delay expects seconds or a duration like 30s, 5m or 2h.');
	const unit = (match[2] ?? '').toLowerCase();
	const seconds = Number(match[1]) * (unit === 'm' ? 60 : unit === 'h' ? 3_600 : 1);
	if (seconds > NODE_TASK_LIMITS.maxDelaySeconds) throw new UsageError('--delay can be at most 12h (43200 seconds).');
	return seconds;
}

/** Check a message body before sending: `json` bodies must parse (the consumer gets the value). */
export function checkMessageBody(body: string, contentType: 'json' | 'text'): void {
	if (contentType !== 'json') return;
	try {
		JSON.parse(body);
	} catch {
		throw new UsageError('The body is not valid JSON. Pass --text to send it as plain text, or fix the JSON.');
	}
}

/** Drop one trailing newline, as editors and `echo` add it. */
export function trimFinalNewline(text: string): string {
	return text.replace(/\r?\n$/, '');
}

/** `17`, `17–26`, `3, 5–7`: sequences with consecutive runs folded. */
export function formatSeqs(seqs: number[]): string {
	const sorted = [...new Set(seqs)].sort((a, b) => a - b);
	const parts: string[] = [];
	for (let i = 0; i < sorted.length; i++) {
		const start = sorted[i]!;
		let end = start;
		while (sorted[i + 1] === end + 1) end = sorted[++i]!;
		parts.push(end === start ? String(start) : end === start + 1 ? `${start}, ${end}` : `${start}–${end}`);
	}
	return parts.join(', ');
}

/** `skif broker send`: what was stored where. */
export function sendSummary(result: BrokerQueueSendResult, delaySeconds?: number): string {
	const queue = queueOfStream(result.stream);
	const where = queue ? `queue ${queue}` : `stream ${result.stream}`;
	const seqs = result.seqs.length > 0 ? ` (seq ${formatSeqs(result.seqs)})` : '';
	const lines = [`Sent ${plural(result.sent, 'message')} to ${where}${seqs} in ${formatMs(result.durationMs)}.`];
	if (delaySeconds) lines.push(`Consumers see ${result.sent === 1 ? 'it' : 'them'} after ${delaySeconds}s.`);
	if (result.state) lines.push(`${result.stream} now holds ${plural(result.state.messages, 'message')} (${formatBytes(result.state.bytes)}).`);
	return lines.join('\n');
}

export function formatMs(ms: number): string {
	if (ms < 1) return `${ms.toFixed(2)} ms`;
	if (ms < 1_000) return `${Math.round(ms)} ms`;
	return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** A body as a person reads it: JSON pretty-printed, binary noted, cuts marked. */
export function formatPeekedBody(message: PeekedMessage): string {
	if (message.encoding === 'base64')
		return `<binary, ${formatBytes(message.size)}, base64> ${truncate(message.body, 76)}`;
	let body = message.body;
	if (!message.truncated && message.headers[QUEUE_HEADERS.contentType] !== 'text') {
		try {
			body = JSON.stringify(JSON.parse(message.body), null, 2);
		} catch {
			// Not JSON: show it as it is.
		}
	}
	if (body === '') body = '<empty>';
	if (message.truncated) body += `\n… (cut; ${formatBytes(message.size)} in all)`;
	return body;
}

/** The Skiff queue headers as one short line, then any other headers. */
export function peekedHeaderLines(message: PeekedMessage): string[] {
	const headers = message.headers;
	const facts: string[] = [];
	const contentType = headers[QUEUE_HEADERS.contentType];
	if (contentType) facts.push(contentType);
	const attempts = headers[QUEUE_HEADERS.attempts];
	if (attempts) facts.push(`attempts ${attempts}`);
	const notBefore = Number(headers[QUEUE_HEADERS.notBefore]);
	if (Number.isFinite(notBefore) && notBefore > 0) facts.push(`not before ${formatTime(notBefore)}`);
	const id = headers[QUEUE_HEADERS.id];
	if (id) facts.push(`id ${truncate(id, 48)}`);
	const known = new Set<string>(Object.values(QUEUE_HEADERS).map((name) => name.toLowerCase()));
	const others = Object.entries(headers)
		.filter(([name]) => !known.has(name.toLowerCase()))
		.map(([name, value]) => `${name}: ${truncate(value, 120)}`);
	return [...(facts.length > 0 ? [facts.join(' · ')] : []), ...others];
}

/** `skif broker peek`: a header line, then each message with its body indented. */
export function peekReport(result: BrokerStreamPeekResult, nextCommand?: (seq: number) => string): string {
	const queue = queueOfStream(result.stream);
	const name = queue ? `${queue} (${result.stream})` : result.stream;
	if (result.total === 0) return `${name} is empty.`;
	const range =
		result.firstSeq > 0 && result.lastSeq >= result.firstSeq
			? `, seq ${result.firstSeq === result.lastSeq ? result.firstSeq : `${result.firstSeq}–${result.lastSeq}`}`
			: '';
	const lines = [`${name}: ${plural(result.total, 'message')} held${range}. Showing ${result.messages.length}.`];
	for (const message of result.messages) {
		lines.push('');
		const subject = queue ? '' : `  ${message.subject}`;
		lines.push(`#${message.seq}  ${formatTime(message.time ?? undefined)}  ${formatBytes(message.size)}${subject}`);
		for (const header of peekedHeaderLines(message)) lines.push(`    ${header}`);
		for (const line of formatPeekedBody(message).split('\n')) lines.push(`    ${line}`);
	}
	if (result.nextSeq !== null && nextCommand) lines.push('', `More: ${nextCommand(result.nextSeq)}`);
	return lines.join('\n');
}
