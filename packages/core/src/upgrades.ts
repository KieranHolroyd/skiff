import { readFileSync, statfsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { backupRuns, databases, migrations, nodes } from '@yoal/db';
import type { CoreContext } from './context.ts';
import {
	buildReadyzReport,
	createUpgradeSnapshotBundle,
	directoryStatus,
	evaluateUpgradePreflight,
	listUpgradeSnapshotBundles,
	markUpgradeSnapshotUnpinned,
	pruneUpgradeSnapshotBundles,
	selectRollbackSnapshot,
	type BackupTargetStatus,
	type DataDirStatus,
	type ReadyzReport,
	type UpgradeChannel,
	type UpgradeMigrationFile,
	type UpgradePreflight,
	type UpgradePreflightInput,
	type UpgradeSnapshotBundle,
	type UpgradeSnapshotInput,
	type UpgradeSnapshotManifest
} from './upgrade-plan.ts';

export * from './upgrade-plan.ts';

export interface UpgradeServiceOptions {
	/** The running platform version, baked in by the control plane build. */
	platformVersion: string;
	dataDir?: string;
	/** Defaults to `<dataDir>/yoal.db`. */
	dbPath?: string;
	/** Defaults to `<parent of dataDir>/backups`. */
	backupsDir?: string;
	/** `/etc/yoal` on an installed host. */
	envDir?: string;
	agentVersion?: string | null;
	helperVersion?: string | null;
	channel?: UpgradeChannel;
	/** Test seam; production uses statfs(2). */
	freeBytes?: (path: string) => number;
	totalBytes?: (path: string) => number;
	/** Test seam; production probes the configured object store. */
	backupTargetCheck?: () => Promise<BackupTargetStatus>;
	now?: () => number;
}

export interface UpgradePreflightOptions extends Partial<UpgradePreflightInput> {
	/** Set false for page loads so a network probe does not delay the dashboard. */
	checkBackupTarget?: boolean;
	/** Target versions requested explicitly per managed database name. */
	requestedDatabaseVersions?: Record<string, string>;
}

export interface UpgradeReadyz extends ReadyzReport {
	/** Latest pre-update snapshot the operator can restore, if any. */
	lastUpgradeSnapshot: {
		dir: string;
		createdAt: string;
		pinned: boolean;
		targetVersion: string | null;
	} | null;
}

/**
 * The service layer for upgrade safety. `preflight` refuses an upgrade that cannot be undone;
 * `createSnapshotBundle` writes the sealed control DB + config archive; `readyz` is the public
 * health document. All three are pure enough to exercise without systemd or a real host.
 */
export class UpgradeService {
	private readonly dataDir: string;
	private readonly dbPath: string;
	private readonly backupsDir: string;
	private readonly envDir: string;
	private readonly now: () => number;
	private backupCache: { at: number; value: BackupTargetStatus } | null = null;

	constructor(
		private readonly ctx: CoreContext,
		private readonly options: UpgradeServiceOptions
	) {
		this.dataDir = options.dataDir ?? ctx.config.dataDir;
		this.dbPath = options.dbPath ?? process.env.YOAL_DB_PATH ?? join(this.dataDir, 'yoal.db');
		this.backupsDir =
			options.backupsDir ?? process.env.YOAL_BACKUPS_DIR ?? join(dirname(this.dataDir), 'backups');
		this.envDir = options.envDir ?? process.env.YOAL_ETC_DIR ?? '/etc/yoal';
		this.now = options.now ?? ctx.now ?? (() => Date.now());
	}

	/** Collect the facts and apply the pure preflight rules. */
	async preflight(overrides: UpgradePreflightOptions = {}): Promise<UpgradePreflight> {
		const appliedMigrations = this.appliedMigrations();
		const targetMigrations: UpgradeMigrationFile[] =
			overrides.migrations ?? migrations.map((migration) => ({ id: migration.id, sql: migration.sql }));
		const dbBytes = overrides.controlDbBytes ?? this.controlDbBytes();
		const disk = this.diskFacts(overrides.freeBytes);
		const dataDirs = overrides.dataDirs ?? this.defaultDataDirs();
		const backupTarget =
			overrides.backupTarget !== undefined
				? overrides.backupTarget
				: overrides.checkBackupTarget === false
					? null
					: await this.checkBackupTarget();
		const managedDatabases =
			overrides.managedDatabases ??
			this.managedDatabases(overrides.requestedDatabaseVersions ?? {});
		const lastVerifiedBackupAt =
			overrides.lastVerifiedBackupAt ?? this.lastVerifiedBackupAt();

		return evaluateUpgradePreflight({
			currentVersion: this.options.platformVersion,
			targetVersion: overrides.targetVersion ?? this.options.platformVersion,
			channel: overrides.channel ?? this.options.channel ?? (process.env.YOAL_RELEASE_CHANNEL === 'edge' ? 'edge' : 'stable'),
			releaseNotes: overrides.releaseNotes,
			migrations: targetMigrations,
			appliedMigrations,
			controlDbBytes: dbBytes,
			freeBytes: disk.freeBytes,
			totalBytes: disk.totalBytes,
			dataDirs,
			backupTarget,
			lastVerifiedBackupAt,
			managedDatabases,
			allowDestructiveMigrations: overrides.allowDestructiveMigrations,
			now: overrides.now ?? this.now()
		});
	}

	/** The public readiness document. Fatal checks make the route answer 503. */
	async readyz(): Promise<UpgradeReadyz> {
		let dbOk = true;
		let dbError: string | null = null;
		try {
			this.ctx.sqlite.query('SELECT 1').get();
		} catch (error) {
			dbOk = false;
			dbError = error instanceof Error ? error.message : String(error);
		}

		const applied = this.appliedMigrations();
		const shipped = migrations.map((migration) => migration.id);
		const appliedSet = new Set(applied);
		const pending = shipped.filter((id) => !appliedSet.has(id));
		const disk = this.diskFacts(undefined);
		const target = await this.checkBackupTarget({ maxAgeMs: 60_000 });
		const latest = listUpgradeSnapshotBundles(this.backupsDir)[0] ?? null;

		const report = buildReadyzReport({
			version: this.options.platformVersion,
			schema: {
				latest: applied.at(-1) ?? null,
				expected: shipped.at(-1) ?? null,
				applied: applied.length,
				pending
			},
			dbOk,
			dbError,
			dataDirs: this.readyzDataDirs(),
			disk: {
				path: this.dataDir,
				freeBytes: disk.freeBytes,
				totalBytes: disk.totalBytes,
				requiredBytes: this.controlDbBytes() * 2
			},
			backupTarget: target,
			agent: {
				desiredVersion: this.options.agentVersion ?? null,
				nodes: this.agentNodes()
			},
			helperVersion: this.options.helperVersion ?? null,
			now: this.now()
		});
		return {
			...report,
			lastUpgradeSnapshot: latest
				? {
						dir: latest.dir,
						createdAt: latest.manifest.createdAt,
						pinned: latest.manifest.pinned,
						targetVersion: latest.manifest.targetVersion
					}
				: null
		};
	}

	/** The existing backup path: a consistent SQLite snapshot plus sealed config. */
	createSnapshotBundle(
		input: Omit<UpgradeSnapshotInput, 'backupsDir' | 'dbPath' | 'envDir' | 'dataDir'> & {
			dataDir?: string;
			envDir?: string;
			dbPath?: string;
		} = {}
	): UpgradeSnapshotBundle {
		return createUpgradeSnapshotBundle({
			...input,
			backupsDir: this.backupsDir,
			dbPath: input.dbPath ?? this.dbPath,
			envDir: input.envDir ?? this.envDir,
			dataDir: input.dataDir ?? this.dataDir,
			fromVersion: input.fromVersion ?? this.options.platformVersion,
			agentVersion: input.agentVersion ?? this.options.agentVersion ?? null,
			helperVersion: input.helperVersion ?? this.options.helperVersion ?? null,
			desiredStateVersion: input.desiredStateVersion ?? this.desiredStateVersion(),
			now: input.now ?? this.now()
		});
	}

	listSnapshotBundles(): UpgradeSnapshotBundle[] {
		return listUpgradeSnapshotBundles(this.backupsDir);
	}

	latestSnapshotBundle(): UpgradeSnapshotBundle | null {
		return selectRollbackSnapshot(this.listSnapshotBundles());
	}

	pruneSnapshotBundles(keep = 3): string[] {
		return pruneUpgradeSnapshotBundles(this.backupsDir, { keep });
	}

	markSnapshotUnpinned(dir: string): void {
		markUpgradeSnapshotUnpinned(dir);
	}

	get paths(): { dataDir: string; dbPath: string; backupsDir: string; envDir: string } {
		return {
			dataDir: this.dataDir,
			dbPath: this.dbPath,
			backupsDir: this.backupsDir,
			envDir: this.envDir
		};
	}

	// ---------------------------------------------------------------- facts

	private appliedMigrations(): string[] {
		try {
			return this.ctx.sqlite
				.query<{ id: string }, []>('SELECT id FROM yoal_migrations ORDER BY id')
				.all()
				.map((row) => row.id);
		} catch {
			return [];
		}
	}

	private controlDbBytes(): number {
		try {
			const row = this.ctx.sqlite
				.query<{ page_count: number; page_size: number }, []>(
					'SELECT page_count, page_size FROM pragma_page_count(), pragma_page_size()'
				)
				.get();
			if (row) return Math.max(0, row.page_count * row.page_size);
		} catch {
			/* fall through to the file size */
		}
		try {
			return statSync(this.dbPath).size;
		} catch {
			return 0;
		}
	}

	private diskFacts(overrideFreeBytes: number | null | undefined): { freeBytes: number | null; totalBytes: number | null } {
		if (overrideFreeBytes !== undefined)
			return {
				freeBytes: overrideFreeBytes,
				totalBytes: this.options.totalBytes?.(this.dataDir) ?? null
			};
		if (this.options.freeBytes) {
			return {
				freeBytes: this.options.freeBytes(this.dataDir),
				totalBytes: this.options.totalBytes?.(this.dataDir) ?? null
			};
		}
		try {
			const stats = statfsSync(this.dataDir);
			const blockSize = Number(stats.bsize);
			return {
				freeBytes: Number(stats.bavail) * blockSize,
				totalBytes: Number(stats.blocks) * blockSize
			};
		} catch {
			return { freeBytes: null, totalBytes: null };
		}
	}

	private defaultDataDirs(): DataDirStatus[] {
		return [
			directoryStatus('data', this.dataDir),
			directoryStatus('objects', join(this.dataDir, 'objects')),
			directoryStatus('backups', this.backupsDir)
		];
	}

	/** `/readyz` requires the serving dirs, not the backup archive (a canary has no backups dir). */
	private readyzDataDirs(): DataDirStatus[] {
		return [
			directoryStatus('data', this.dataDir),
			directoryStatus('objects', join(this.dataDir, 'objects'))
		];
	}

	private async checkBackupTarget(options: { maxAgeMs?: number } = {}): Promise<BackupTargetStatus | null> {
		const maxAge = options.maxAgeMs ?? 0;
		if (maxAge > 0 && this.backupCache && this.now() - this.backupCache.at < maxAge)
			return this.backupCache.value;
		if (this.options.backupTargetCheck) {
			const value = await this.options.backupTargetCheck();
			if (maxAge > 0) this.backupCache = { at: this.now(), value };
			return value;
		}
		if (!this.ctx.objectStore.testConnection) return null;
		try {
			const result = await Promise.race([
				this.ctx.objectStore.testConnection(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('backup target probe timed out after 5s')), 5_000).unref?.()
				)
			]);
			const value: BackupTargetStatus = {
				kind: result.kind,
				reachable: result.ok,
				checkedAt: new Date(this.now()).toISOString(),
				...(result.error ? { error: result.error } : {})
			};
			if (maxAge > 0) this.backupCache = { at: this.now(), value };
			return value;
		} catch (error) {
			const value: BackupTargetStatus = {
				kind: this.ctx.objectStore.kind,
				reachable: false,
				checkedAt: new Date(this.now()).toISOString(),
				error: error instanceof Error ? error.message : String(error)
			};
			if (maxAge > 0) this.backupCache = { at: this.now(), value };
			return value;
		}
	}

	private managedDatabases(requested: Record<string, string>): UpgradePreflightInput['managedDatabases'] {
		try {
			return this.ctx.db
				.select({ name: databases.name, version: databases.version })
				.from(databases)
				.where(isNull(databases.deletedAt))
				.all()
				.map((row) => ({
					name: row.name,
					version: row.version,
					requestedVersion: requested[row.name] ?? null
				}));
		} catch {
			return [];
		}
	}

	private lastVerifiedBackupAt(): number | null {
		let drill: number | null = null;
		try {
			const row = this.ctx.db
				.select({ finishedAt: backupRuns.finishedAt })
				.from(backupRuns)
				.where(and(eq(backupRuns.kind, 'restore-drill'), eq(backupRuns.status, 'ok')))
				.orderBy(desc(backupRuns.finishedAt))
				.limit(1)
				.get();
			drill = row?.finishedAt ?? null;
		} catch {
			/* table may not exist in an unusual migration state */
		}
		// The monthly drill runs outside the control plane and writes status.json; prefer it
		// when it is newer than the (optional) database row.
		try {
			const path =
				process.env.YOAL_RESTORE_DRILL_STATUS ??
				join(
					process.env.YOAL_RESTORE_DRILL_DIR ?? join(dirname(this.dataDir), 'drill'),
					'status.json'
				);
			const status = JSON.parse(readFileSync(path, 'utf8')) as { ok?: unknown; at?: unknown };
			const at = typeof status.at === 'string' ? Date.parse(status.at) : Number.NaN;
			if (status.ok === true && Number.isFinite(at)) drill = Math.max(drill ?? 0, at);
		} catch {
			/* no drill has run yet */
		}
		return drill;
	}

	private desiredStateVersion(): number | null {
		try {
			const row = this.ctx.sqlite
				.query<{ version: number | null }, []>('SELECT MAX(desired_state_version) AS version FROM nodes')
				.get();
			return row?.version ?? null;
		} catch {
			return null;
		}
	}

	private agentNodes(): Array<{ id: string; name: string; version: string | null }> {
		try {
			return this.ctx.db
				.select({ id: nodes.id, name: nodes.name, version: nodes.agentVersion })
				.from(nodes)
				.all();
		} catch {
			return [];
		}
	}
}

export type { UpgradeSnapshotManifest };
