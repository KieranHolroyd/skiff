/**
 * Managed object storage (docs/OBJECT-STORAGE.md): the wire types the CLI reads, and pure
 * formatting and parsing for `skif storage`. Types mirror `packages/contracts/src/object-storage.ts`;
 * the CLI bundle stays free of runtime dependencies (D40), so keep them in sync.
 */
import { readFileSync } from 'node:fs';
import { UsageError } from './errors.ts';
import { formatBytes, formatNumber, formatTime, renderTable, truncate } from './output.ts';

export type StorageStatus = 'pending' | 'starting' | 'running' | 'failed' | 'stopped';
export type BucketAccess = 'private' | 'public-read';
export type StorageGrantMode = 'read' | 'read-write';

export const bucketAccesses: readonly BucketAccess[] = ['private', 'public-read'];

export interface StorageGrant {
	bucket: string;
	mode: StorageGrantMode;
}

export type BucketConfigStatus = 'pending' | 'converged' | 'error' | 'unsupported';

export interface BucketLifecycleRule {
	id: string;
	prefix?: string;
	expireDays?: number;
	noncurrentExpireDays?: number;
	abortIncompleteDays?: number;
	enabled: boolean;
}

export interface BucketCorsRule {
	origin: string[];
	method: string[];
	header: string[];
	expose: string[];
	maxAge?: number;
}

export interface BucketObjectLock {
	mode: 'governance' | 'compliance';
	retainDays: number;
}

export interface StorageBucketView {
	name: string;
	access: BucketAccess;
	state: 'ready' | 'deleting' | 'delete-blocked';
	sizeBytes: number | null;
	objects: number | null;
	versioning: boolean;
	lifecycle: BucketLifecycleRule[];
	cors: BucketCorsRule[];
	quotaBytes: number | null;
	objectLock: BucketObjectLock | null;
	configVersion: number;
	configStatus: BucketConfigStatus;
	configMessage: string | null;
	lastConvergedAt: string | null;
	createdAt: string;
	statsAt: string | null;
}

export interface BucketConfigInput {
	access?: BucketAccess;
	versioning?: boolean;
	lifecycle?: BucketLifecycleRule[];
	cors?: BucketCorsRule[];
	quotaBytes?: number | null;
}

export interface StorageShareLink {
	url: string;
	method: 'GET' | 'PUT';
	expiresIn: number;
	expiresAt: string;
	maxDownloads: number | null;
	direct: boolean;
}

export interface StorageAttachmentView {
	storageId: string;
	storageName: string;
	projectId: string;
	projectSlug: string;
	envPrefix: string;
	envNames: string[];
	grants: StorageGrant[];
	accessKeyId: string;
	createdAt: string;
}

export interface StorageView {
	id: string;
	name: string;
	engine: string;
	engineLabel: string;
	version: string;
	status: StorageStatus;
	message: string | null;
	nodeId: string;
	nodeName: string | null;
	memoryMb: number;
	cpus: number;
	storageMb: number;
	usedBytes: number | null;
	objects: number | null;
	public: boolean;
	publicUrl: string | null;
	internalEndpoint: { process: string; container: string };
	region: string;
	buckets: StorageBucketView[];
	attachments: StorageAttachmentView[];
	statsAt: string | null;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	purgeAt: string | null;
}

export interface StorageCredentials {
	storageId: string;
	name: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	endpoint: string;
	internalEndpoint: string;
	publicEndpoint: string | null;
	note: string;
}

export interface StorageMetricPoint {
	bucket: string;
	up: number;
	usedBytes: number;
	objects: number;
	bucketCount: number;
	memoryBytes: number;
}

export interface StorageCreateInput {
	name: string;
	version?: string;
	placement?: string;
	memoryMb?: number;
	cpus?: number;
	storageMb?: number;
	public?: boolean;
	buckets?: string[];
	project?: string;
	envPrefix?: string;
}

export interface StorageUpdateInput {
	memoryMb?: number;
	cpus?: number;
	storageMb?: number;
	public?: boolean;
	version?: string;
}

/** Repeatable flags also accept comma lists: `--bucket a,b --bucket c` → `a`, `b`, `c`. */
export function splitList(values: string[]): string[] {
	return values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter(Boolean);
}

/** `media`, `media:read`, `media:read-write` → a grant (read-write by default). */
export function parseGrant(spec: string): StorageGrant {
	const [bucket, mode, ...rest] = spec.split(':');
	if (!bucket || rest.length > 0)
		throw new UsageError(`"${spec}" is not a bucket grant. Use <bucket>, <bucket>:read or <bucket>:read-write.`);
	if (mode === undefined || mode === 'read-write' || mode === 'rw') return { bucket, mode: 'read-write' };
	if (mode === 'read' || mode === 'ro') return { bucket, mode: 'read' };
	throw new UsageError(`Unknown access "${mode}" for bucket "${bucket}". Use :read or :read-write.`);
}

export function parseGrants(values: string[]): StorageGrant[] {
	const grants = splitList(values).map(parseGrant);
	const seen = new Set<string>();
	for (const grant of grants) {
		if (seen.has(grant.bucket)) throw new UsageError(`Bucket "${grant.bucket}" is granted twice.`);
		seen.add(grant.bucket);
	}
	return grants;
}

/** `attach` with no `--bucket`: read-write on the instance's only bucket, else ask for `--bucket`. */
export function defaultGrants(view: Pick<StorageView, 'name' | 'buckets'>): StorageGrant[] {
	const buckets = view.buckets.filter((bucket) => bucket.state === 'ready');
	if (buckets.length === 1) return [{ bucket: buckets[0]!.name, mode: 'read-write' }];
	if (buckets.length === 0)
		throw new UsageError(
			`Storage "${view.name}" has no buckets yet. Create one first: skif storage buckets create ${view.name} <bucket>`,
		);
	throw new UsageError(
		`Storage "${view.name}" has ${buckets.length} buckets (${buckets.map((bucket) => bucket.name).join(', ')}). ` +
			'Pick them with --bucket <name>[:read|:read-write] (repeatable).',
	);
}

export function parseAccess(value: string): BucketAccess {
	if ((bucketAccesses as readonly string[]).includes(value)) return value as BucketAccess;
	throw new UsageError(`--access expects ${bucketAccesses.join(' or ')}.`);
}

/** `30m`, `6h`, `7d` → milliseconds. */
export function parseDuration(value: string, flag: string): number {
	const match = /^(\d+)\s*([mhd])$/i.exec(value.trim());
	if (!match) throw new UsageError(`${flag} expects a duration like 30m, 6h or 7d.`);
	const amount = Number(match[1]);
	const unit = match[2]!.toLowerCase();
	const ms = amount * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
	if (ms <= 0) throw new UsageError(`${flag} must be longer than zero.`);
	return ms;
}

export function statusLabel(view: Pick<StorageView, 'status' | 'deletedAt'>): string {
	return view.deletedAt ? 'deleted' : view.status;
}

export function nodeLabel(view: Pick<StorageView, 'nodeName' | 'nodeId'>): string {
	return view.nodeName ?? view.nodeId;
}

/** `1.2 GiB / 10 GiB (12%)`, or the budget alone before the first sample. */
export function usedVsBudget(view: Pick<StorageView, 'usedBytes' | 'storageMb'>): string {
	const budget = view.storageMb * 1024 * 1024;
	if (view.usedBytes === null || view.usedBytes === undefined) return `- / ${formatBytes(budget)}`;
	const percent = budget > 0 ? Math.round((view.usedBytes / budget) * 100) : 0;
	return `${formatBytes(view.usedBytes)} / ${formatBytes(budget)} (${percent}%)`;
}

export function grantsLabel(grants: StorageGrant[]): string {
	return grants.map((grant) => `${grant.bucket}:${grant.mode}`).join(', ');
}

export function storageTable(list: StorageView[]): string {
	const rows = list.map((view) => [
		view.name,
		statusLabel(view),
		nodeLabel(view),
		String(view.buckets.length),
		usedVsBudget(view),
		view.public ? 'yes' : 'no',
		view.attachments.length ? truncate(view.attachments.map((item) => item.projectSlug).join(', '), 30) : '-',
		formatTime(view.createdAt),
	]);
	return renderTable(['NAME', 'STATUS', 'NODE', 'BUCKETS', 'USED / BUDGET', 'PUBLIC', 'PROJECTS', 'CREATED'], rows);
}

export function bucketTable(buckets: StorageBucketView[]): string {
	return renderTable(
		['BUCKET', 'ACCESS', 'STATE', 'SIZE', 'OBJECTS'],
		buckets.map((bucket) => [
			bucket.name,
			bucket.access,
			bucket.state,
			bucket.sizeBytes === null ? '-' : formatBytes(bucket.sizeBytes),
			bucket.objects === null ? '-' : formatNumber(bucket.objects),
		]),
	);
}

/** The `skif storage info` report. */
export function storageDetails(view: StorageView): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(10)}  ${value}`);
	field('Storage', view.name);
	field('Status', `${statusLabel(view)}${view.message ? ` (${view.message})` : ''}`);
	field('Engine', `${view.engineLabel || view.engine} ${view.version}`);
	field('Node', view.nodeName ? `${view.nodeName} (${view.nodeId})` : view.nodeId);
	field('Used', `${usedVsBudget(view)}${view.objects === null ? '' : `, ${formatNumber(view.objects)} objects`}`);
	field('Limits', `${view.memoryMb} MB memory, ${view.cpus} CPU${view.cpus === 1 ? '' : 's'}`);
	field('Public', view.publicUrl ?? 'no (apps on its node only)');
	field('Apps reach', `${view.internalEndpoint.process} (process), ${view.internalEndpoint.container} (container)`);
	field('Region', `${view.region} (path-style addressing)`);
	field('Created', formatTime(view.createdAt));
	if (view.deletedAt) {
		field('Deleted', formatTime(view.deletedAt));
		if (view.purgeAt) field('Purges', formatTime(view.purgeAt));
	}

	lines.push('');
	if (view.buckets.length === 0) {
		lines.push(`Buckets: none. Create one with \`skif storage buckets create ${view.name} <bucket>\`.`);
	} else {
		lines.push(`Buckets${view.statsAt ? ` (as of ${formatTime(view.statsAt)})` : ''}:`);
		lines.push(bucketTable(view.buckets));
	}

	lines.push('');
	if (view.attachments.length === 0) {
		lines.push(`Attached projects: none. Attach one with \`skif storage attach ${view.name} --project <slug>\`.`);
	} else {
		lines.push('Attached projects:');
		lines.push(
			renderTable(
				['PROJECT', 'PREFIX', 'GRANTS', 'ACCESS KEY'],
				view.attachments.map((item) => [item.projectSlug, item.envPrefix, grantsLabel(item.grants), item.accessKeyId]),
			),
		);
	}
	return lines.join('\n');
}

/**
 * The root key as dotenv lines, named like an attachment's variables. `AWS` (the default) is what
 * the AWS CLI and SDKs read, so `set -a; eval "$(skif storage credentials media)"; set +a` works.
 */
export function credentialsEnv(credentials: StorageCredentials, prefix = 'AWS'): string {
	const entries: Array<[string, string]> = [
		['ENDPOINT_URL', credentials.endpoint],
		['ACCESS_KEY_ID', credentials.accessKeyId],
		['SECRET_ACCESS_KEY', credentials.secretAccessKey],
		['REGION', credentials.region],
		['FORCE_PATH_STYLE', 'true'],
	];
	return entries.map(([suffix, value]) => `${prefix}_${suffix}=${value}`).join('\n');
}

export function metricsTable(points: StorageMetricPoint[]): string {
	const sorted = [...points].sort((a, b) => a.bucket.localeCompare(b.bucket));
	return renderTable(
		['TIME', 'UP', 'USED', 'OBJECTS', 'BUCKETS', 'MEMORY'],
		sorted.map((point) => [
			formatTime(point.bucket),
			point.up >= 0.999 ? 'yes' : point.up <= 0.001 ? 'no' : `${Math.round(point.up * 100)}%`,
			formatBytes(point.usedBytes),
			formatNumber(Math.round(point.objects)),
			formatNumber(Math.round(point.bucketCount)),
			formatBytes(Math.round(point.memoryBytes)),
		]),
	);
}

// --- object browser (D82) ---------------------------------------------------

export interface StorageObject {
	key: string;
	sizeBytes: number;
	etag: string | null;
	lastModified: string | null;
	storageClass: string | null;
}

export interface StorageObjectStat extends StorageObject {
	contentType: string | null;
}

export interface StorageObjectList {
	bucket: string;
	prefix: string;
	delimiter: string;
	objects: StorageObject[];
	prefixes: string[];
	isTruncated: boolean;
	nextToken: string | null;
}

export interface StorageObjectDeleteResult {
	deleted: string[];
	errors: Array<{ key: string; code: string; message: string }>;
}

// --- bucket configuration (plan 02b) ---------------------------------------

/** `@file.json` or inline JSON → lifecycle rules. The server does the real validation. */
export function parseLifecycleRules(value: string, flag: string): BucketLifecycleRule[] {
	const parsed = parseJsonValue(value, flag);
	if (!Array.isArray(parsed)) throw new UsageError(`${flag} expects a JSON array of lifecycle rules.`);
	return parsed as BucketLifecycleRule[];
}

/** `@file.json` or inline JSON → CORS rules. */
export function parseCorsRules(value: string, flag: string): BucketCorsRule[] {
	const parsed = parseJsonValue(value, flag);
	if (!Array.isArray(parsed)) throw new UsageError(`${flag} expects a JSON array of CORS rules.`);
	return parsed as BucketCorsRule[];
}

function parseJsonValue(value: string, flag: string): unknown {
	let text = value;
	if (value.startsWith('@')) {
		const path = value.slice(1);
		try {
			text = readFileSync(path, 'utf8');
		} catch {
			throw new UsageError(`${flag}: cannot read ${path}.`);
		}
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new UsageError(`${flag}: invalid JSON.`);
	}
}

/** `governance:30` / `compliance:365` → object lock; only valid when creating a bucket. */
export function parseObjectLock(value: string): BucketObjectLock {
	const match = /^(governance|compliance):(\d+)$/i.exec(value.trim());
	if (!match) throw new UsageError('--object-lock expects governance:<days> or compliance:<days>.');
	const days = Number(match[2]);
	if (!Number.isInteger(days) || days < 1 || days > 36_500)
		throw new UsageError('--object-lock retention must be 1–36500 days.');
	return { mode: match[1]!.toLowerCase() as BucketObjectLock['mode'], retainDays: days };
}

/** The one-line summary `skif storage bucket config` prints without --json. */
export function bucketConfigDetails(bucket: StorageBucketView): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(16)}  ${value}`);
	field('Bucket', bucket.name);
	field('Access', bucket.access);
	field('Versioning', bucket.versioning ? 'on' : 'off');
	field('Quota', bucket.quotaBytes === null ? 'unlimited' : formatBytes(bucket.quotaBytes));
	field('Object lock', bucket.objectLock ? `${bucket.objectLock.mode}, ${bucket.objectLock.retainDays} days` : 'off');
	field('Lifecycle rules', String(bucket.lifecycle.length));
	field('CORS rules', String(bucket.cors.length));
	field('Config version', String(bucket.configVersion));
	field('Convergence', `${bucket.configStatus}${bucket.configMessage ? ` (${bucket.configMessage})` : ''}`);
	field('Last converged', bucket.lastConvergedAt ? formatTime(bucket.lastConvergedAt) : 'never');
	if (bucket.lifecycle.length > 0) {
		lines.push('');
		lines.push('Lifecycle:');
		for (const rule of bucket.lifecycle)
			lines.push(
				`  ${rule.id}${rule.enabled ? '' : ' (disabled)'}${rule.prefix ? ` prefix=${rule.prefix}` : ''}` +
					`${rule.expireDays ? ` expire=${rule.expireDays}d` : ''}` +
					`${rule.noncurrentExpireDays ? ` noncurrent=${rule.noncurrentExpireDays}d` : ''}` +
					`${rule.abortIncompleteDays ? ` abort=${rule.abortIncompleteDays}d` : ''}`,
			);
	}
	if (bucket.cors.length > 0) {
		lines.push('');
		lines.push('CORS:');
		for (const rule of bucket.cors)
			lines.push(`  ${rule.method.join(',')} ${rule.origin.join(', ')}`);
	}
	return lines.join('\n');
}
