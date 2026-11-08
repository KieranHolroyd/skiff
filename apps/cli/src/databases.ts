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
	/** The named credential the app connects as; null/absent for the owner. */
	credentialId?: string | null;
	credentialRole?: DatabaseCredentialRole | null;
	createdAt: string;
}

export type DatabaseCredentialRole = 'owner' | 'app' | 'monitor' | 'readonly' | 'backup';
/** The roles a human can create; owner and monitor come with the database. */
export const DATABASE_NAMED_CREDENTIAL_ROLES = ['app', 'readonly', 'backup'] as const;
export type DatabaseNamedCredentialRole = (typeof DATABASE_NAMED_CREDENTIAL_ROLES)[number];

/** Named credential metadata (docs/DATABASES.md §16); never carries a password. */
export interface DatabaseCredentialView {
	id: string;
	databaseId: string;
	role: DatabaseCredentialRole;
	username: string;
	purpose: string | null;
	status: 'pending' | 'ready' | 'failed' | 'revoking' | 'revoked';
	lastUsedAt: string | null;
	expiresAt: string | null;
	createdAt: string;
	revokedAt: string | null;
}

export function databaseCredentialTable(credentials: DatabaseCredentialView[]): string {
	return renderTable(
		['ID', 'ROLE', 'USERNAME', 'STATUS', 'PURPOSE', 'EXPIRES', 'CREATED'],
		credentials.map((item) => [
			item.id,
			item.role,
			item.username,
			item.status,
			item.purpose ? truncate(item.purpose, 32) : '-',
			item.expiresAt ? formatTime(item.expiresAt) : '-',
			formatTime(item.createdAt),
		]),
	);
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

export interface DatabaseUpgradePlan {
	databaseId: string;
	name: string;
	fromVersion: string;
	toVersion: string;
	majorChange: boolean;
	status: 'planned' | 'blocked' | 'manual';
	mode: 'dump-restore' | 'pg-upgrade';
	blockers: string[];
	warnings: string[];
	steps: Array<{ id: string; title: string; detail: string; automatic: boolean }>;
	backupId: string | null;
	docs: string;
	message: string;
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
	/** Where the backup was written; absent from control planes before 0053. */
	target?: {
		id: string | null;
		name: string;
		kind: 'platform' | 'local' | 's3';
		location: string;
		available: boolean;
		unavailableReason: string | null;
	};
}

export interface DatabaseView {
	id: string;
	name: string;
	engine: string;
	engineLabel: string;
	version: string;
	/** Image variant (D126); absent from older control planes. */
	variant?: string;
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
	pooler?: {
		enabled: boolean;
		host: { process: string; container: string };
		port: number | null;
		mode?: 'transaction';
		urlTemplate?: string | null;
	};
	tls?: { enabled: boolean; mode: string; caPem: string | null; error: string | null };
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
	directUrl?: string;
	poolerUrl?: string | null;
	host: string;
	port: number;
	sslmode?: string;
	tlsEnabled?: boolean;
	caPem?: string | null;
	connectionSnippets?: Record<string, string>;
	note: string;
}

/** Mirrors `databaseEngines` in @skiff/contracts (D95). Keep in sync; the server validates. */
export const DATABASE_ENGINES = ['postgres', 'mysql', 'mariadb', 'mongodb', 'valkey', 'redis', 'clickhouse'] as const;

export interface DatabaseCreateInput {
	name: string;
	engine?: string;
	version?: string;
	variant?: string;
	placement?: string;
	/** `system`, `fast`, `bulk` or a disk name (docs/STORAGE.md). */
	storage?: string;
	memoryMb?: number;
	cpus?: number;
	storageMb?: number;
	project?: string;
	envPrefix?: string;
	extensions?: string[];
	pooler?: boolean;
}

/** `PATCH /api/v1/databases/:name`: any subset; the server checks it against the engine. */
export interface DatabaseUpdateInput {
	memoryMb?: number;
	cpus?: number;
	storageMb?: number;
	version?: string;
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

/** Postgres image variants (D126); the server checks the version. */
export const DATABASE_VARIANTS = ['standard', 'postgis', 'pg_cron'] as const;
const VARIANT_LABELS: Record<string, string> = { postgis: 'PostGIS', pg_cron: 'pg_cron' };

export function engineLabel(view: Pick<DatabaseView, 'engineLabel' | 'engine' | 'version' | 'variant'>): string {
	const label = `${view.engineLabel || view.engine} ${view.version}`;
	return view.variant && view.variant !== 'standard' ? `${label} (${VARIANT_LABELS[view.variant] ?? view.variant})` : label;
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

/** Mirrors `DatabaseReplicaView` in @skiff/contracts (docs/CLUSTERING.md §9.2). */
export interface DatabaseReplicaView {
	id: string;
	databaseId: string;
	nodeId: string;
	nodeName: string | null;
	zone: string | null;
	status: 'pending' | 'streaming' | 'lagging' | 'lost' | 'failed' | 'stopped';
	replayLsn: string | null;
	lagBytes: number | null;
	lagSeconds: number | null;
	slot: string | null;
	primaryGeneration: number;
	workloadId: string;
	mode: 'async' | 'sync';
	hostPort: number | null;
	diskId: string | null;
	sameNode: boolean;
	message: string | null;
	removing: boolean;
	reportedAt: string | null;
	createdAt: string;
}

/** Mirrors `DatabaseFailoverView` in @skiff/contracts (docs/CLUSTERING.md §9.3). */
export interface DatabaseFailoverView {
	id: string;
	databaseId: string;
	replicaId: string | null;
	fromNodeId: string | null;
	fromNodeName: string | null;
	toNodeId: string;
	toNodeName: string | null;
	generation: number;
	stage: 'fencing' | 'promoting' | 'repointing' | 'completed' | 'failed';
	reason: string | null;
	message: string | null;
	startedAt: string;
	finishedAt: string | null;
}

/** Mirrors `databasePitrStatusSchema` in @skiff/contracts (docs/PITR.md). Credential-free. */
export interface DatabasePitrView {
	databaseId: string;
	databaseName: string;
	enabled: boolean;
	stanza: string;
	status: 'pending' | 'ok' | 'failed' | 'paused';
	repo: { kind: 's3'; endpoint: string | null; bucket: string; region: string; pathPrefix: string; forcePathStyle: boolean };
	archiveStatus: 'ok' | 'failing' | 'unknown' | null;
	archiveAt: string | null;
	lastBaseBackupAt: string | null;
	lastBaseBackupType: 'full' | 'diff' | 'incr' | null;
	nextFullAt: string | null;
	nextDiffAt: string | null;
	lastRestoreTargetAt: string | null;
	lastRestoreDatabaseId: string | null;
	verifiedAt: string | null;
	error: string | null;
	recoverableFrom: string | null;
	recoverableTo: string | null;
	windowCheckedAt: string | null;
}

/** A queued PITR node task (base backup). */
export interface DatabasePitrTaskView {
	id: string;
	action: 'basebackup' | 'restore' | 'status';
	databaseId: string;
	baseBackupType: 'full' | 'diff' | 'incr' | null;
}
