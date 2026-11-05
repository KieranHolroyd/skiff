import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
	accessSync,
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	statfsSync,
	writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { compareSemver, parseSemver } from '../../contracts/src/semver.ts';

/**
 * Upgrade safety primitives (docs/build-plan/plans/06-upgrade-safety.md, OPS §4.2).
 *
 * No CoreContext here on purpose: the self-updater and the installer run outside the control
 * plane but must apply exactly the same preflight rules and snapshot format as the dashboard.
 * `upgrades.ts` wraps these helpers for the service layer.
 */

export type UpgradeChannel = 'stable' | 'edge';

export interface UpgradeMigrationFile {
	id: string;
	sql: string;
}

export interface DestructiveMigrationStatement {
	file: string;
	line: number;
	statement: string;
}

export interface PendingMigration extends UpgradeMigrationFile {
	destructive: boolean;
	destructiveStatements: DestructiveMigrationStatement[];
}

export interface DataDirStatus {
	/** Human label, e.g. `data`, `objects`, `backups`. */
	name: string;
	path: string;
	exists: boolean;
	writable: boolean;
}

export interface BackupTargetStatus {
	kind: string;
	reachable: boolean;
	checkedAt?: string;
	error?: string;
}

export interface ManagedDatabaseFact {
	name: string;
	version: string;
	/** An explicitly requested target version, if an operator supplied one. */
	requestedVersion?: string | null;
}

export interface UpgradeCheck {
	id: string;
	status: 'ok' | 'warn' | 'error';
	message: string;
}

export interface UpgradePreflightInput {
	currentVersion: string;
	targetVersion?: string | null;
	channel?: UpgradeChannel;
	releaseNotes?: string[];
	/** Migrations the target release ships. Omit when only the running release is known. */
	migrations?: UpgradeMigrationFile[];
	appliedMigrations?: string[];
	controlDbBytes?: number;
	freeBytes?: number | null;
	totalBytes?: number | null;
	dataDirs?: DataDirStatus[];
	backupTarget?: BackupTargetStatus | null;
	lastVerifiedBackupAt?: number | null;
	managedDatabases?: ManagedDatabaseFact[];
	/** An operator has reviewed a destructive migration and wants to proceed anyway. */
	allowDestructiveMigrations?: boolean;
	/** `--force` deliberately downgrades; the version check is then a warning, not a refusal. */
	allowDowngrade?: boolean;
	now?: number;
}

export interface UpgradePreflight {
	ok: boolean;
	currentVersion: string;
	targetVersion: string;
	channel: UpgradeChannel;
	releaseNotes: string[];
	versionChange: 'upgrade' | 'same' | 'downgrade' | 'unknown';
	migrations: {
		target: number;
		applied: number;
		pending: PendingMigration[];
		destructive: boolean;
		unknownApplied: string[];
	};
	controlDb: {
		bytes: number;
		freeBytes: number | null;
		totalBytes: number | null;
		requiredBytes: number;
	};
	dataDirs: DataDirStatus[];
	backup: {
		target: BackupTargetStatus | null;
		lastVerifiedAt: string | null;
		lastVerifiedAgeMs: number | null;
	};
	managedDatabases: {
		total: number;
		versions: Record<string, number>;
		majorChanges: Array<{ name: string; from: string; to: string }>;
	};
	postgresWizardRequired: boolean;
	checks: UpgradeCheck[];
	errors: string[];
	warnings: string[];
}

const DESTRUCTIVE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
	{ label: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/gi },
	{ label: 'DROP COLUMN', pattern: /\bDROP\s+COLUMN\b/gi },
	{ label: 'ALTER COLUMN TYPE', pattern: /\bALTER\s+COLUMN\b[\s\S]{0,120}?\bTYPE\b/gi }
];

/** Remove SQL comments so a comment mentioning DROP TABLE is not reported as destructive. */
export function stripSqlComments(sql: string): string {
	return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
}

function lineNumberAt(sql: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (sql.charCodeAt(i) === 10) line++;
	return line;
}

/** Destructive statements in one migration body, with their source line. */
export function findDestructiveStatements(file: string, sql: string): DestructiveMigrationStatement[] {
	const clean = stripSqlComments(sql);
	const found: DestructiveMigrationStatement[] = [];
	for (const { label, pattern } of DESTRUCTIVE_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of clean.matchAll(pattern)) {
			found.push({ file, line: lineNumberAt(clean, match.index ?? 0), statement: label });
		}
	}
	return found.sort((a, b) => a.line - b.line || a.statement.localeCompare(b.statement));
}

/** Migrations that have not been applied yet, classified for the preflight. */
export function pendingMigrations(
	migrations: UpgradeMigrationFile[],
	applied: Iterable<string>
): PendingMigration[] {
	const done = new Set(applied);
	return migrations
		.filter((migration) => !done.has(migration.id))
		.map((migration) => {
			const destructiveStatements = findDestructiveStatements(migration.id, migration.sql);
			return { ...migration, destructive: destructiveStatements.length > 0, destructiveStatements };
		});
}

/**
 * PostgreSQL major version from a tag such as `17`, `17.2`, `17-alpine` or `16.4-bookworm`.
 * The managed database registry only stores major tags, but this deliberately tolerates image
 * tags so an operator's request cannot sneak a major change past the guard.
 */
export function postgresMajor(version: string | null | undefined): string | null {
	if (typeof version !== 'string') return null;
	const match = /^\s*v?(\d{1,3})(?:[.\-_]|$)/.exec(version);
	return match?.[1] ?? null;
}

export function isPostgresMajorChange(from: string, to: string): boolean {
	const a = postgresMajor(from);
	const b = postgresMajor(to);
	return Boolean(a && b && a !== b);
}

function versionDirection(current: string, target: string | null | undefined): UpgradePreflight['versionChange'] {
	const a = parseSemver(current);
	const b = parseSemver(target);
	if (!a || !b) return 'unknown';
	const order = compareSemver(b, a);
	return order > 0 ? 'upgrade' : order < 0 ? 'downgrade' : 'same';
}

const MS_PER_DAY = 86_400_000;
const STALE_BACKUP_MS = 30 * MS_PER_DAY;

/**
 * Pure preflight rules. Refuse anything that could make the upgrade hard or impossible to undo:
 * an unreachable backup target, too little disk for the control DB snapshot, a missing data
 * directory, an unreviewed destructive migration, unknown applied migrations (a downgrade), or a
 * silently requested PostgreSQL major change.
 */
export function evaluateUpgradePreflight(input: UpgradePreflightInput): UpgradePreflight {
	const now = input.now ?? Date.now();
	const currentVersion = input.currentVersion;
	const targetVersion = input.targetVersion ?? currentVersion;
	const channel = input.channel ?? 'stable';
	const migrations = input.migrations ?? [];
	const applied = [...(input.appliedMigrations ?? [])].sort();
	const targetIds = new Set(migrations.map((migration) => migration.id));
	const pending = pendingMigrations(migrations, applied);
	const destructive = pending.filter((migration) => migration.destructive);
	const unknownApplied = migrations.length > 0 ? applied.filter((id) => !targetIds.has(id)) : [];
	const controlDbBytes = Math.max(0, input.controlDbBytes ?? 0);
	const freeBytes = input.freeBytes ?? null;
	const totalBytes = input.totalBytes ?? null;
	const requiredBytes = controlDbBytes * 2;
	const dataDirs = input.dataDirs ?? [];
	const managedDatabases = input.managedDatabases ?? [];
	const majorChanges = managedDatabases
		.filter(
			(database) =>
				Boolean(database.requestedVersion) &&
				isPostgresMajorChange(database.version, database.requestedVersion as string)
		)
		.map((database) => ({
			name: database.name,
			from: database.version,
			to: database.requestedVersion as string
		}));

	const checks: UpgradeCheck[] = [];
	const errors: string[] = [];
	const warnings: string[] = [];
	const check = (id: string, status: UpgradeCheck['status'], message: string) => {
		checks.push({ id, status, message });
		if (status === 'error') errors.push(message);
		if (status === 'warn') warnings.push(message);
	};

	const versionChange = versionDirection(currentVersion, targetVersion);
	if (versionChange === 'downgrade' && !input.allowDowngrade)
		check(
			'version',
			'error',
			`Target ${targetVersion} is older than the running ${currentVersion}. Downgrades are not supported; restore the pre-update snapshot instead.`
		);
	else if (versionChange === 'downgrade')
		check('version', 'warn', `Deliberate downgrade ${currentVersion} → ${targetVersion}; forward-only migrations may not undo cleanly.`);
	else if (versionChange === 'unknown')
		check('version', 'warn', `Cannot compare "${currentVersion}" with "${targetVersion}" by semantic version.`);
	else check('version', 'ok', `${currentVersion} → ${targetVersion}`);

	if (channel === 'edge')
		check('channel', 'warn', 'The edge channel is not supported for as long as stable and has no rollback guarantee beyond the control plane.');

	if (input.backupTarget === null || input.backupTarget === undefined) {
		check('backup-target', 'warn', 'The backup target was not checked. Run the preflight from the server before applying the upgrade.');
	} else if (!input.backupTarget.reachable) {
		check(
			'backup-target',
			'error',
			`The backup target (${input.backupTarget.kind}) is unreachable${input.backupTarget.error ? `: ${input.backupTarget.error}` : ''}. Fix it in Settings → Backups or check SKIFF_OBJECT_STORE / R2_* before upgrading.`
		);
	} else {
		check('backup-target', 'ok', `The ${input.backupTarget.kind} backup target is reachable.`);
	}

	if (freeBytes === null) {
		check('disk', 'warn', 'Free disk space was not measured.');
	} else if (freeBytes < requiredBytes) {
		check(
			'disk',
			'error',
			`Only ${formatBytes(freeBytes)} free, but the control database is ${formatBytes(controlDbBytes)} and the snapshot needs 2× that (${formatBytes(requiredBytes)}). Free disk space or move the data directory before upgrading.`
		);
	} else {
		check(
			'disk',
			'ok',
			`${formatBytes(freeBytes)} free; ${formatBytes(requiredBytes)} required for a 2× control database snapshot.`
		);
	}

	for (const dir of dataDirs) {
		if (!dir.exists) check(`data:${dir.name}`, 'error', `Data directory ${dir.path} is missing. Run the installer again or restore the disk before upgrading.`);
		else if (!dir.writable) check(`data:${dir.name}`, 'error', `Data directory ${dir.path} is not writable by the Skiff service. Fix its ownership and permissions before upgrading.`);
	}
	if (dataDirs.every((dir) => dir.exists && dir.writable))
		check('data-dirs', 'ok', `${dataDirs.length} data director${dataDirs.length === 1 ? 'y is' : 'ies are'} present and writable.`);

	if (unknownApplied.length > 0) {
		check(
			'migrations',
			'error',
			`The database has migrations the target release does not ship (${unknownApplied.join(', ')}). The target predates the current schema; restore the pre-update snapshot instead of downgrading.`
		);
	} else if (destructive.length > 0 && !input.allowDestructiveMigrations) {
		check(
			'migrations',
			'error',
			`Destructive migration${destructive.length === 1 ? '' : 's'} ${destructive.map((migration) => migration.id).join(', ')} must be reviewed and approved explicitly; Skiff will not apply ${destructive.length === 1 ? 'it' : 'them'} automatically.`
		);
	} else if (destructive.length > 0) {
		check('migrations', 'warn', `Destructive migrations ${destructive.map((migration) => migration.id).join(', ')} are explicitly approved.`);
	} else if (migrations.length > 0) {
		check('migrations', 'ok', `${pending.length} pending migration${pending.length === 1 ? '' : 's'}; none are destructive.`);
	}

	if (majorChanges.length > 0) {
		const list = majorChanges.map((change) => `${change.name} (${change.from} → ${change.to})`).join(', ');
		check(
			'postgres-major',
			'error',
			`PostgreSQL major change requested for ${list}. Run \`skif db upgrade <name> --to <version> --plan\`; a major upgrade is never applied automatically.`
		);
	} else if (managedDatabases.length > 0) {
		check('postgres-major', 'ok', `No PostgreSQL major-version change requested for ${managedDatabases.length} managed database${managedDatabases.length === 1 ? '' : 's'}.`);
	}

	const lastVerifiedAt = input.lastVerifiedBackupAt ?? null;
	const lastVerifiedAgeMs = lastVerifiedAt === null ? null : Math.max(0, now - lastVerifiedAt);
	if (lastVerifiedAt === null) {
		check('last-verified-backup', 'warn', 'No successful restore drill is recorded. Run one before relying on this update.');
	} else if (lastVerifiedAgeMs !== null && lastVerifiedAgeMs > STALE_BACKUP_MS) {
		check(
			'last-verified-backup',
			'warn',
			`The last verified restore is ${Math.round(lastVerifiedAgeMs / MS_PER_DAY)} days old. Run a restore drill before upgrading.`
		);
	} else {
		check('last-verified-backup', 'ok', 'A recent restore drill is recorded.');
	}

	return {
		ok: errors.length === 0,
		currentVersion,
		targetVersion,
		channel,
		releaseNotes: input.releaseNotes ?? [],
		versionChange,
		migrations: {
			target: migrations.length,
			applied: applied.length,
			pending,
			destructive: destructive.length > 0,
			unknownApplied
		},
		controlDb: { bytes: controlDbBytes, freeBytes, totalBytes, requiredBytes },
		dataDirs,
		backup: {
			target: input.backupTarget ?? null,
			lastVerifiedAt: lastVerifiedAt === null ? null : new Date(lastVerifiedAt).toISOString(),
			lastVerifiedAgeMs
		},
		managedDatabases: {
			total: managedDatabases.length,
			versions: managedDatabases.reduce<Record<string, number>>((counts, database) => {
				counts[database.version] = (counts[database.version] ?? 0) + 1;
				return counts;
			}, {}),
			majorChanges
		},
		postgresWizardRequired: majorChanges.length > 0,
		checks,
		errors,
		warnings
	};
}

// ------------------------------------------------------------------ /readyz

export interface ReadyzSchema {
	/** Newest applied migration id. */
	latest: string | null;
	/** The newest migration the running release ships. */
	expected: string | null;
	applied: number;
	pending: string[];
}

export interface ReadyzInput {
	version: string;
	schema: ReadyzSchema;
	dbOk: boolean;
	dbError?: string | null;
	dataDirs: DataDirStatus[];
	disk: { path: string; freeBytes: number | null; totalBytes: number | null; requiredBytes: number };
	backupTarget: BackupTargetStatus | null;
	agent: { desiredVersion: string | null; nodes: Array<{ id: string; name: string; version: string | null }> };
	helperVersion?: string | null;
	now?: number;
}

export interface ReadyzReport {
	ok: boolean;
	status: 'ok' | 'degraded' | 'failed';
	version: string;
	schema: ReadyzSchema;
	database: { ok: boolean; error?: string };
	disk: { path: string; freeBytes: number | null; totalBytes: number | null; requiredBytes: number; headroom: boolean };
	dataDirs: DataDirStatus[];
	backupTarget: BackupTargetStatus | null;
	agent: ReadyzInput['agent'];
	helper: { version: string | null };
	checks: UpgradeCheck[];
	warnings: string[];
	checkedAt: string;
}

/**
 * Build the public `/readyz` document. Fatal errors (database, schema, data dirs) make the route
 * return 503 so a bad release can be rolled back; a degraded backup target or low disk is reported
 * but does not take down a serving platform.
 */
export function buildReadyzReport(input: ReadyzInput): ReadyzReport {
	const checks: UpgradeCheck[] = [];
	const warnings: string[] = [];
	const error = (id: string, message: string) => checks.push({ id, status: 'error', message });
	const warn = (id: string, message: string) => {
		checks.push({ id, status: 'warn', message });
		warnings.push(message);
	};
	const ok = (id: string, message: string) => checks.push({ id, status: 'ok', message });

	if (!input.dbOk) error('database', input.dbError ?? 'The control database did not answer a query.');
	else ok('database', 'The control database answers queries.');

	if (input.schema.pending.length > 0)
		error(
			'schema',
			`${input.schema.pending.length} migration${input.schema.pending.length === 1 ? ' is' : 's are'} pending (${input.schema.pending.slice(0, 5).join(', ')}${input.schema.pending.length > 5 ? '…' : ''}).`
		);
	else ok('schema', `Schema ${input.schema.latest ?? 'unknown'} is applied.`);

	for (const dir of input.dataDirs) {
		if (!dir.exists) error(`data:${dir.name}`, `Data directory ${dir.path} is missing.`);
		else if (!dir.writable) error(`data:${dir.name}`, `Data directory ${dir.path} is not writable.`);
	}
	if (input.dataDirs.every((dir) => dir.exists && dir.writable))
		ok('data-dirs', `${input.dataDirs.length} data director${input.dataDirs.length === 1 ? 'y' : 'ies'} present and writable.`);

	const headroom =
		input.disk.freeBytes === null || input.disk.freeBytes >= input.disk.requiredBytes;
	if (!headroom)
		warn(
			'disk',
			`Only ${formatBytes(input.disk.freeBytes ?? 0)} free; ${formatBytes(input.disk.requiredBytes)} is the 2× control database snapshot headroom.`
		);
	else ok('disk', input.disk.freeBytes === null ? 'Disk headroom was not measured.' : `${formatBytes(input.disk.freeBytes)} free.`);

	if (input.backupTarget === null) warn('backup-target', 'The backup target was not checked.');
	else if (!input.backupTarget.reachable)
		warn(
			'backup-target',
			`The ${input.backupTarget.kind} backup target is unreachable${input.backupTarget.error ? `: ${input.backupTarget.error}` : ''}. Serving continues, but upgrades will be refused.`
		);
	else ok('backup-target', `The ${input.backupTarget.kind} backup target is reachable.`);

	const failed = checks.some((check) => check.status === 'error');
	return {
		ok: !failed,
		status: failed ? 'failed' : warnings.length > 0 ? 'degraded' : 'ok',
		version: input.version,
		schema: input.schema,
		database: { ok: input.dbOk, ...(input.dbError ? { error: input.dbError } : {}) },
		disk: { ...input.disk, headroom },
		dataDirs: input.dataDirs,
		backupTarget: input.backupTarget,
		agent: input.agent,
		helper: { version: input.helperVersion ?? null },
		checks,
		warnings,
		checkedAt: new Date(input.now ?? Date.now()).toISOString()
	};
}

// ------------------------------------------------------------ snapshot bundles

export interface UpgradeSnapshotManifest {
	format: 1;
	kind: 'pre-update' | 'pre-rollback' | 'manual';
	createdAt: string;
	fromVersion: string | null;
	targetVersion: string | null;
	pinned: boolean;
	sealed: 'root-only';
	controlDb: string | null;
	migrations: string[];
	files: Array<{ path: string; bytes: number; sha256: string }>;
	versions: {
		agent: string | null;
		helper: string | null;
		desiredState: number | null;
	};
	restore: {
		controlDb: string | null;
		note: string;
	};
}

export interface UpgradeSnapshotBundle {
	dir: string;
	controlDb: string | null;
	manifest: UpgradeSnapshotManifest;
}

export interface UpgradeSnapshotInput {
	backupsDir: string;
	dbPath?: string | null;
	envDir?: string | null;
	dataDir?: string | null;
	fromVersion?: string | null;
	targetVersion?: string | null;
	kind?: UpgradeSnapshotManifest['kind'];
	agentVersion?: string | null;
	helperVersion?: string | null;
	desiredStateVersion?: number | null;
	migrations?: string[];
	pinned?: boolean;
	retain?: number;
	now?: number;
	label?: string;
}

function stamp(date: Date): string {
	return date.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

function safeName(value: string | null | undefined): string {
	return (value ?? 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'unknown';
}

function sha256File(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeSealed(path: string, data: Uint8Array | string, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, data, { mode });
	chmodSync(path, mode);
}

function copySealed(source: string, destination: string, mode = 0o600): boolean {
	if (!existsSync(source)) return false;
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	copyFileSync(source, destination);
	chmodSync(destination, mode);
	return true;
}

/** `VACUUM INTO` is consistent while the control plane is writing WAL. */
export function snapshotSqlite(source: string, destination: string): void {
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	rmSync(destination, { force: true });
	const db = new Database(source, { readwrite: true, create: false });
	try {
		db.run('PRAGMA busy_timeout = 10000');
		db.run('VACUUM INTO ?', [destination]);
	} finally {
		db.close();
	}
	chmodSync(destination, 0o600);
}

/**
 * A sealed, versioned pre-update bundle: control SQLite, `.env`, the APP_KEY/master key, platform
 * settings, the helper/agent versions and the migration list. The directory is 0700 and every
 * file is 0600 (root/TYPE only); it is never world-readable. Nothing here is restored
 * automatically — the operator decides.
 */
export function createUpgradeSnapshotBundle(input: UpgradeSnapshotInput): UpgradeSnapshotBundle {
	const now = input.now ?? Date.now();
	const at = new Date(now);
	const kind = input.kind ?? 'pre-update';
	const pinned = input.pinned ?? kind === 'pre-update';
	const label = safeName(input.label ?? input.targetVersion);
	let dir = join(input.backupsDir, `upgrade-${stamp(at)}-v${label}`);
	if (existsSync(dir)) dir = `${dir}-${process.pid}`;
	const temporary = `${dir}.tmp-${process.pid}`;
	rmSync(temporary, { recursive: true, force: true });
	mkdirSync(join(temporary, 'config'), { recursive: true, mode: 0o700 });
	mkdirSync(join(temporary, 'db'), { recursive: true, mode: 0o700 });
	chmodSync(temporary, 0o700);

	const files: UpgradeSnapshotManifest['files'] = [];
	let controlDb: string | null = null;
	if (input.dbPath && existsSync(input.dbPath)) {
		const destination = join(temporary, 'db', 'control.db');
		snapshotSqlite(input.dbPath, destination);
		controlDb = destination;
		files.push({ path: 'db/control.db', bytes: statSync(destination).size, sha256: sha256File(destination) });
	}

	const copies: Array<{ source: string; destination: string; mode?: number }> = [];
	if (input.envDir) {
		copies.push(
			{ source: join(input.envDir, 'skiff.env'), destination: join(temporary, 'config', 'skiff.env') },
			{ source: join(input.envDir, 'agent.env'), destination: join(temporary, 'config', 'agent.env') },
			{ source: join(input.envDir, 'master.key'), destination: join(temporary, 'config', 'master.key'), mode: 0o400 },
			{ source: join(input.envDir, 'litestream.yml'), destination: join(temporary, 'config', 'litestream.yml') }
		);
	}
	if (input.dataDir)
		copies.push({
			source: join(input.dataDir, 'platform-settings.json'),
			destination: join(temporary, 'config', 'platform-settings.json')
		});
	for (const copy of copies) {
		if (!copySealed(copy.source, copy.destination, copy.mode)) continue;
		files.push({
			path: `config/${basename(copy.destination)}`,
			bytes: statSync(copy.destination).size,
			sha256: sha256File(copy.destination)
		});
	}

	const manifest: UpgradeSnapshotManifest = {
		format: 1,
		kind,
		createdAt: at.toISOString(),
		fromVersion: input.fromVersion ?? null,
		targetVersion: input.targetVersion ?? null,
		pinned,
		sealed: 'root-only',
		controlDb: controlDb ? 'db/control.db' : null,
		migrations: input.migrations ?? [],
		files,
		versions: {
			agent: input.agentVersion ?? null,
			helper: input.helperVersion ?? null,
			desiredState: input.desiredStateVersion ?? null
		},
		restore: {
			controlDb: controlDb ? 'db/control.db' : null,
			note: 'Restoring this bundle is a human decision. Stop skiff-control-plane, copy db/control.db over the live database, restore config/* only from the same point in time, then start the service. Data volumes and managed databases are never restored automatically.'
		}
	};
	writeSealed(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	chmodSync(join(temporary, 'config'), 0o700);
	chmodSync(join(temporary, 'db'), 0o700);
	renameSync(temporary, dir);

	const created: UpgradeSnapshotBundle = {
		dir,
		controlDb: controlDb ? join(dir, 'db', 'control.db') : null,
		manifest
	};
	pruneUpgradeSnapshotBundles(input.backupsDir, {
		keep: input.retain ?? 3,
		protect: [dir]
	});
	return created;
}

export function readUpgradeSnapshotManifest(dir: string): UpgradeSnapshotManifest | null {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Partial<UpgradeSnapshotManifest>;
		if (parsed.format !== 1 || typeof parsed.createdAt !== 'string') return null;
		return parsed as UpgradeSnapshotManifest;
	} catch {
		return null;
	}
}

/** Newest first. */
export function listUpgradeSnapshotBundles(backupsDir: string): UpgradeSnapshotBundle[] {
	if (!existsSync(backupsDir)) return [];
	const bundles: UpgradeSnapshotBundle[] = [];
	for (const entry of readdirSync(backupsDir)) {
		if (!entry.startsWith('upgrade-') || entry.endsWith('.tmp')) continue;
		const dir = join(backupsDir, entry);
		const manifest = readUpgradeSnapshotManifest(dir);
		if (!manifest) continue;
		bundles.push({
			dir,
			controlDb: manifest.controlDb ? join(dir, manifest.controlDb) : null,
			manifest
		});
	}
	return bundles.sort((a, b) => Date.parse(b.manifest.createdAt) - Date.parse(a.manifest.createdAt));
}

/**
 * Keep the protected (just-created or last-known-good) bundle and the newest `keep` bundles.
 * Pinned bundles are never pruned, even if that raises the count above `keep`.
 */
export function pruneUpgradeSnapshotBundles(
	backupsDir: string,
	options: { keep?: number; protect?: string[] } = {}
): string[] {
	const keep = Math.max(1, options.keep ?? 3);
	const protect = new Set(options.protect ?? []);
	const removed: string[] = [];
	for (const [index, bundle] of listUpgradeSnapshotBundles(backupsDir).entries()) {
		if (protect.has(bundle.dir) || bundle.manifest.pinned || index < keep) continue;
		rmSync(bundle.dir, { recursive: true, force: true });
		removed.push(bundle.dir);
	}
	return removed;
}

/** The newest pinned bundle, else the newest bundle whose control DB still exists. */
export function selectRollbackSnapshot(
	bundles: UpgradeSnapshotBundle[]
): UpgradeSnapshotBundle | null {
	const pinned = bundles.find((bundle) => bundle.manifest.pinned && Boolean(bundle.controlDb));
	if (pinned) return pinned;
	return bundles.find((bundle) => Boolean(bundle.controlDb)) ?? null;
}

export function markUpgradeSnapshotUnpinned(dir: string): void {
	const manifest = readUpgradeSnapshotManifest(dir);
	if (!manifest || !manifest.pinned) return;
	manifest.pinned = false;
	writeSealed(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * A successful upgrade retires every older pin. The just-created bundle is marked unpinned too,
 * so normal retention takes over; call before `pruneUpgradeSnapshotBundles`.
 */
export function retireUpgradeSnapshotBundles(backupsDir: string, current?: string | null): string[] {
	const retired: string[] = [];
	for (const bundle of listUpgradeSnapshotBundles(backupsDir)) {
		if (bundle.dir === current) {
			markUpgradeSnapshotUnpinned(bundle.dir);
			continue;
		}
		if (!bundle.manifest.pinned) continue;
		markUpgradeSnapshotUnpinned(bundle.dir);
		retired.push(bundle.dir);
	}
	return retired;
}

// ------------------------------------------------------------------ helpers

/** Migration ids already applied in a SQLite database; empty when the table/file is absent. */
export function readAppliedMigrations(dbPath: string): string[] {
	if (!existsSync(dbPath)) return [];
	const db = new Database(dbPath, { readonly: true });
	try {
		const table = db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='skiff_migrations'")
			.get();
		if (!table) return [];
		return db
			.query<{ id: string }, []>('SELECT id FROM skiff_migrations ORDER BY id')
			.all()
			.map((row) => row.id);
	} finally {
		db.close();
	}
}

/** Read a release's `packages/db/migrations` directory, sorted by its numeric prefix. */
export function readMigrationsFromDir(dir: string): UpgradeMigrationFile[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => /^\d{4}_.*\.sql$/.test(name))
		.sort()
		.map((name) => ({ id: name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/**
 * Managed database versions from a live SQLite file without importing the whole service layer.
 * Returns [] on a pre-databases schema or an unreadable database.
 */
export function readManagedDatabaseFacts(dbPath: string): ManagedDatabaseFact[] {
	if (!existsSync(dbPath)) return [];
	const db = new Database(dbPath, { readonly: true });
	try {
		const table = db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='databases'")
			.get();
		if (!table) return [];
		return db
			.query<{ name: string; version: string }, []>(
				'SELECT name, version FROM databases WHERE deleted_at IS NULL ORDER BY name'
			)
			.all();
	} catch {
		return [];
	} finally {
		db.close();
	}
}

/** The highest desired-state watermark across nodes, recorded in an upgrade bundle. */
export function readDesiredStateVersion(dbPath: string): number | null {
	if (!existsSync(dbPath)) return null;
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.query<{ version: number | null }, []>('SELECT MAX(desired_state_version) AS version FROM nodes')
			.get();
		return row?.version ?? null;
	} catch {
		return null;
	} finally {
		db.close();
	}
}

function nodeStatfs(path: string): { freeBytes: number | null; totalBytes: number | null } {
	try {
		const stats = statfsSync(path);
		const blockSize = Number(stats.bsize);
		return {
			freeBytes: Number(stats.bavail) * blockSize,
			totalBytes: Number(stats.blocks) * blockSize
		};
	} catch {
		return { freeBytes: null, totalBytes: null };
	}
}

export function diskFacts(path: string): { freeBytes: number | null; totalBytes: number | null } {
	return nodeStatfs(path);
}

export function fileBytes(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function directoryStatus(name: string, path: string): DataDirStatus {
	const exists = existsSync(path);
	let writable = false;
	if (exists) {
		try {
			accessSync(path, constants.W_OK);
			writable = true;
		} catch {
			writable = false;
		}
	}
	return { name, path, exists, writable };
}
