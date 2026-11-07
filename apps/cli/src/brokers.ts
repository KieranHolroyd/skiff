/**
 * Managed queue brokers (docs/BROKERS.md, D111): the wire types the CLI reads, and pure formatting
 * for `skif broker`. Types mirror `packages/contracts/src/broker.ts`; the CLI bundle stays free of
 * runtime dependencies (D40), so keep them in sync.
 */
import { formatBytes, formatNumber, formatTime, renderTable, truncate } from './output.ts';

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
