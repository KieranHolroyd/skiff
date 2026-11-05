/**
 * Managed databases (docs/DATABASES.md): the wire types the CLI reads, and pure formatting for
 * `skif db`. Types mirror `packages/contracts/src/database.ts`; the CLI bundle stays free of
 * runtime dependencies (D40), so keep them in sync.
 */
import { UsageError } from './errors.ts';
import { formatBytes, formatNumber, formatTime, plural, renderTable, truncate } from './output.ts';

export type DatabaseStatus = 'pending' | 'starting' | 'running' | 'failed' | 'stopped';

export interface DatabaseAttachmentView {
	databaseId: string;
	databaseName: string;
	projectId: string;
	projectSlug: string;
	envPrefix: string;
	envNames: string[];
	createdAt: string;
}

export interface DatabaseTableStat {
	schema: string;
	name: string;
	rows: number;
	totalBytes: number;
	seqScans: number;
	idxScans: number;
	lastAutovacuum: string | null;
	lastAutoanalyze: string | null;
}

export interface ServiceActionSkip {
	kind: 'database' | 'storage';
	name: string;
	reason: string;
}

export interface ServiceRestartResult {
	restarted: { databases: string[]; storage: string[] };
	skipped: ServiceActionSkip[];
}

export interface DatabaseBackupAllResult {
	queued: string[];
	skipped: ServiceActionSkip[];
}

export interface DatabaseRotationView {
	id: string;
	databaseId: string;
	role: 'owner' | 'monitor';
	status: 'pending' | 'running' | 'ok' | 'failed';
	error: string | null;
	createdAt: string;
	finishedAt: string | null;
}

export interface DatabaseBackupSummary {
	enabled: boolean;
	schedule: string;
	retentionDays: number;
	nextBackupAt: string | null;
	lastBackupAt: string | null;
	lastBackupStatus: string | null;
	lastBackupError: string | null;
	lastVerifiedAt: string | null;
	pendingRestoreId: string | null;
}

export interface DatabaseBackupView {
	id: string;
	databaseId: string;
	databaseName: string;
	kind: 'manual' | 'scheduled';
	status: 'pending' | 'running' | 'ok' | 'failed';
	format: string;
	sizeBytes: number | null;
	sha256: string | null;
	objectKey: string;
	pinned: boolean;
	error: string | null;
	verifiedAt: string | null;
	restoredDatabaseId: string | null;
	startedAt: string;
	finishedAt: string | null;
	expiresAt: string | null;
}

export interface DatabaseView {
	id: string;
	name: string;
	engine: string;
	engineLabel: string;
	version: string;
	status: DatabaseStatus;
	message: string | null;
	nodeId: string;
	nodeName: string | null;
	memoryMb: number;
	cpus: number;
	storageMb: number;
	sizeBytes: number | null;
	databaseName: string;
	username: string;
	internalHost: { process: string; container: string };
	attachments: DatabaseAttachmentView[];
	tables: DatabaseTableStat[];
	statsAt: string | null;
	extensions?: string[];
	slowQueries?: Array<{
		queryId: string;
		query: string;
		calls: number;
		totalMs: number;
		meanMs: number;
		rows: number;
	}>;
	slowQueriesAt?: string | null;
	pooler?: { enabled: boolean; host: { process: string; container: string }; port: number | null };
	backup?: DatabaseBackupSummary;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	purgeAt: string | null;
}

export interface DatabaseCredentials {
	databaseId: string;
	name: string;
	username: string;
	password: string;
	databaseName: string;
	url: string;
	host: string;
	port: number;
	note: string;
}

export interface DatabaseCreateInput {
	name: string;
	version?: string;
	placement?: string;
	memoryMb?: number;
	cpus?: number;
	storageMb?: number;
	project?: string;
	envPrefix?: string;
	extensions?: string[];
	pooler?: boolean;
}

/** `--storage 10G`, `--memory 512M`, `--memory 512` (MB): a whole number of megabytes. */
export function parseMegabytes(value: string, flag: string): number {
	const match = /^(\d+(?:\.\d+)?)\s*([mg]i?b?)?$/i.exec(value.trim());
	if (!match) throw new UsageError(`${flag} expects a size in MB, or with a unit: 512M, 10G.`);
	const amount = Number(match[1]);
	const unit = (match[2] ?? 'm').toLowerCase()[0];
	const mb = unit === 'g' ? amount * 1024 : amount;
	if (!Number.isFinite(mb) || mb <= 0 || !Number.isInteger(mb))
		throw new UsageError(`${flag} must be a whole number of megabytes.`);
	return mb;
}

export function parseCpus(value: string): number {
	const cpus = Number(value);
	if (!Number.isFinite(cpus) || cpus <= 0) throw new UsageError('--cpus expects a positive number, e.g. 1 or 0.5.');
	return cpus;
}

/** UPPER_SNAKE, matching the server's rule (checked there too). */
export function assertEnvPrefix(prefix: string): void {
	if (!/^[A-Z][A-Z0-9_]*$/.test(prefix) || prefix.endsWith('_'))
		throw new UsageError(`"${prefix}" is not a valid env prefix. Use UPPER_SNAKE_CASE, e.g. DATABASE or ANALYTICS_DB.`);
}

export function statusLabel(view: Pick<DatabaseView, 'status' | 'deletedAt'>): string {
	return view.deletedAt ? 'deleted' : view.status;
}

export function engineLabel(view: Pick<DatabaseView, 'engineLabel' | 'engine' | 'version'>): string {
	return `${view.engineLabel || view.engine} ${view.version}`;
}

/** `1.2 GiB / 10 GiB (12%)`, or the budget alone before the first sample. */
export function sizeVsBudget(view: Pick<DatabaseView, 'sizeBytes' | 'storageMb'>): string {
	const budget = view.storageMb * 1024 * 1024;
	if (view.sizeBytes === null || view.sizeBytes === undefined) return `- / ${formatBytes(budget)}`;
	const percent = budget > 0 ? Math.round((view.sizeBytes / budget) * 100) : 0;
	return `${formatBytes(view.sizeBytes)} / ${formatBytes(budget)} (${percent}%)`;
}

export function nodeLabel(view: Pick<DatabaseView, 'nodeName' | 'nodeId'>): string {
	return view.nodeName ?? view.nodeId;
}

export function databaseTable(databases: DatabaseView[]): string {
	const rows = databases.map((view) => [
		view.name,
		statusLabel(view),
		engineLabel(view),
		nodeLabel(view),
		sizeVsBudget(view),
		view.attachments.length ? truncate(view.attachments.map((item) => item.projectSlug).join(', '), 30) : '-',
		formatTime(view.createdAt),
	]);
	return renderTable(['NAME', 'STATUS', 'ENGINE', 'NODE', 'SIZE / BUDGET', 'PROJECTS', 'CREATED'], rows);
}

/** Largest tables first (the server keeps the latest top-50 snapshot). */
export function topTables(tables: DatabaseTableStat[], limit = 10): DatabaseTableStat[] {
	return [...tables].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, limit);
}

/** The `skif db info` report. */
export function databaseDetails(view: DatabaseView, options: { now?: number; tables?: number } = {}): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(10)}  ${value}`);
	field('Database', view.name);
	field('Status', `${statusLabel(view)}${view.message ? ` (${view.message})` : ''}`);
	field('Engine', engineLabel(view));
	field('Node', view.nodeName ? `${view.nodeName} (${view.nodeId})` : view.nodeId);
	field('Size', sizeVsBudget(view));
	field('Limits', `${view.memoryMb} MB memory, ${view.cpus} CPU${view.cpus === 1 ? '' : 's'}`);
	field('Postgres', `database ${view.databaseName}, user ${view.username}`);
	field('Apps reach', `${view.internalHost.process} (process), ${view.internalHost.container} (container)`);
	if (view.pooler?.enabled)
		field(
			'Pooled',
			`${view.pooler.host.process} (process), ${view.pooler.host.container} (container)`,
		);
	if (view.extensions?.length) field('Extensions', view.extensions.join(', '));
	field('Created', formatTime(view.createdAt));
	if (view.deletedAt) {
		field('Deleted', formatTime(view.deletedAt));
		if (view.purgeAt) field('Purges', formatTime(view.purgeAt));
	}

	lines.push('');
	if (view.attachments.length === 0) {
		lines.push(`Attached projects: none. Attach one with \`skif db attach ${view.name} --project <slug>\`.`);
	} else {
		lines.push('Attached projects:');
		lines.push(
			renderTable(
				['PROJECT', 'PREFIX', 'VARIABLES'],
				view.attachments.map((item) => [item.projectSlug, item.envPrefix, item.envNames.join(', ')]),
			),
		);
	}

	lines.push('');
	const tables = topTables(view.tables, options.tables ?? 10);
	if (tables.length === 0) {
		lines.push(view.statsAt ? 'Tables: none yet.' : 'Tables: no snapshot yet (the agent samples every five minutes).');
	} else {
		const more = view.tables.length - tables.length;
		lines.push(`Top tables${view.statsAt ? ` (as of ${formatTime(view.statsAt)})` : ''}:`);
		lines.push(
			renderTable(
				['TABLE', 'ROWS (EST.)', 'SIZE', 'SEQ SCANS', 'IDX SCANS'],
				tables.map((table) => [
					`${table.schema}.${table.name}`,
					formatNumber(table.rows),
					formatBytes(table.totalBytes),
					formatNumber(table.seqScans),
					formatNumber(table.idxScans),
				]),
			),
		);
		if (more > 0) lines.push(`…and ${plural(more, 'more table')} (\`--json\` lists them all).`);
	}
	return lines.join('\n');
}
