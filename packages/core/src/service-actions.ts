import {
	requirePermission,
	serviceRestartSchema,
	type DatabaseBackupAllResult,
	type Principal,
	type ServiceActionSkip,
	type ServiceRestart,
	type ServiceRestartResult,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';

/**
 * Bulk actions over managed services. Each item is an ordinary `DatabaseService`/`StorageService`
 * mutation, so permissions, audit and the desired-state mechanism stay in one place; this service
 * only fans out and reports per-item failures.
 */
export class ServiceActionsService {
	constructor(private readonly ctx: CoreContext) {}

	restart(principal: Principal, raw: unknown): ServiceRestartResult {
		const input = serviceRestartSchema.parse(raw);
		const result: ServiceRestartResult = { restarted: { databases: [], storage: [] }, skipped: [] };

		const restartDatabases = input.databases ?? (input.scope === 'all' || input.scope === 'databases');
		const restartStorage = input.storage ?? (input.scope === 'all' || input.scope === 'storage');
		if (restartDatabases) requirePermission(principal, 'database:update');
		if (restartStorage) requirePermission(principal, 'storage:update');

		if (restartDatabases) {
			const names = input.databases ?? this.ctx.databases.list(principal).map((item) => item.name);
			for (const name of names) {
				try {
					this.ctx.databases.restart(principal, name);
					result.restarted.databases.push(name);
				} catch (error) {
					result.skipped.push(skip('database', name, error));
				}
			}
		}
		if (restartStorage) {
			const names = input.storage ?? this.ctx.storage.list(principal).map((item) => item.name);
			for (const name of names) {
				try {
					this.ctx.storage.restart(principal, name);
					result.restarted.storage.push(name);
				} catch (error) {
					result.skipped.push(skip('storage', name, error));
				}
			}
		}
		this.ctx.audit.record({
			principal,
			action: 'services.restart',
			resource: 'service',
			args: {
				scope: input.scope,
				databases: result.restarted.databases,
				storage: result.restarted.storage,
				skipped: result.skipped.length,
			},
			result: result.skipped.length > 0 ? 'error' : 'ok',
			...(result.skipped.length > 0 ? { error: `${result.skipped.length} item(s) skipped` } : {}),
		});
		return result;
	}

	/**
	 * Queue a backup for every live database that does not already have one running. Engines
	 * without backups (none today; unknown engines from old rows) are neither queued nor skipped.
	 */
	backupAllDatabases(principal: Principal): DatabaseBackupAllResult {
		requirePermission(principal, 'database:update');
		const result: DatabaseBackupAllResult = { queued: [], skipped: [] };
		for (const database of this.ctx.databases.list(principal)) {
			if (!database.capabilities.backups) continue;
			try {
				this.ctx.databases.createBackup(principal, database.name);
				result.queued.push(database.name);
			} catch (error) {
				result.skipped.push(skip('database', database.name, error));
			}
		}
		this.ctx.audit.record({
			principal,
			action: 'services.backup-all',
			resource: 'service',
			args: { queued: result.queued, skipped: result.skipped.length },
			result: result.skipped.length > 0 ? 'error' : 'ok',
			...(result.skipped.length > 0 ? { error: `${result.skipped.length} database(s) skipped` } : {}),
		});
		return result;
	}
}

function skip(kind: 'database' | 'storage', name: string, error: unknown): ServiceActionSkip {
	return {
		kind,
		name,
		reason: error instanceof Error ? error.message : String(error),
	};
}
