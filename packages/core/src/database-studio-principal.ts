import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { databases, nodes } from '@skiff/db';
import {
	DATABASE_STUDIO_READONLY_ENV,
	DATABASE_STUDIO_READONLY_USER,
	databaseEngineRegistry,
	databaseIdentifier,
	databaseUrlDatabase,
	type DatabaseStudioPrincipalActivation,
	type DatabaseStudioPrincipalResult,
	type DatabaseStudioPrincipalState,
	type DatabaseStudioPrincipalTask,
	type NodeCapability,
} from '@skiff/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import type { DatabaseRow } from './databases.ts';
import { ConflictError, CoreError, NotFoundError } from './errors.ts';
import { randomToken } from './util.ts';

/** Why a generation was bumped; kept in the audit trail. */
export type StudioPrincipalReason = 'create' | 'open' | 'retry' | 'restore' | 'pitr-restore' | 'version-change';

export interface StudioPrincipalStatus {
	state: DatabaseStudioPrincipalState;
	error: string | null;
}

/**
 * The read-only studio principal (plan 22, track G): one `skiff_studio_ro` engine account per
 * database, created on the node by the helper's fixed `studio-principal` verb.
 *
 * It follows the named-credential pattern (plan 04b). Desired state lists `{ databaseId,
 * generation }` for every principal that is not ready at its current generation; the agent pulls
 * the password from a node-authenticated activation and reports the outcome in its heartbeat. The
 * password is generated once and kept, so a re-apply (after a restore, PITR or version change)
 * never invalidates a session the studio already activated.
 */
export class DatabaseStudioPrincipals {
	constructor(private readonly ctx: CoreContext) {}

	/**
	 * `ready` when the node confirmed the current generation; never reveals the password. A node
	 * whose agent does not declare `studio-principal` would drop the task without a word, so that
	 * is reported as a failure instead of `preparing` forever.
	 */
	status(row: DatabaseRow): StudioPrincipalStatus {
		if (row.studioRoSecret && row.studioRoGeneration > 0 && row.studioRoReadyGeneration === row.studioRoGeneration)
			return { state: 'ready', error: null };
		if (row.studioRoError) return { state: 'failed', error: row.studioRoError };
		const unsupported = this.unsupportedNode(row.nodeId);
		if (unsupported)
			return {
				state: 'failed',
				error: `${unsupported} runs an older Skiff agent that cannot create read-only accounts. Update the node, then try again.`,
			};
		return { state: 'preparing', error: null };
	}

	/**
	 * The node's name when its last heartbeat lacked the `studio-principal` capability. Null when it
	 * has it, or has not sent a heartbeat since capabilities were introduced (still unknown).
	 */
	private unsupportedNode(nodeId: string | null): string | null {
		if (!nodeId) return null;
		const node = this.ctx.db
			.select({ name: nodes.name, capabilitiesJson: nodes.capabilitiesJson })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		if (!node || node.capabilitiesJson === null) return null;
		let capabilities: unknown;
		try {
			capabilities = JSON.parse(node.capabilitiesJson);
		} catch {
			capabilities = [];
		}
		const supported: NodeCapability = 'studio-principal';
		return Array.isArray(capabilities) && capabilities.includes(supported) ? null : node.name;
	}

	/**
	 * Make sure the principal exists or is on its way: mint the password the first time, and start
	 * a new generation after a failure (the dashboard's retry). A pending or ready principal is
	 * left alone. Returns the status after the call.
	 */
	ensure(databaseId: string, reason: StudioPrincipalReason): StudioPrincipalStatus {
		const row = this.row(databaseId);
		if (!row || row.deletedAt) throw new NotFoundError('Database');
		const current = this.status(row);
		if (current.state === 'ready') return current;
		if (row.studioRoSecret && current.state === 'preparing' && row.studioRoGeneration > 0) return current;
		const now = this.ctx.now();
		this.ctx.db
			.update(databases)
			.set({
				...(row.studioRoSecret ? {} : { studioRoSecret: this.ctx.secrets.seal(row.orgId, newPassword()) }),
				studioRoGeneration: row.studioRoGeneration + 1,
				studioRoError: null,
				updatedAt: now,
			})
			.where(eq(databases.id, row.id))
			.run();
		this.ctx.audit.record({
			orgId: row.orgId,
			action: 'database.studio.principal-requested',
			resource: 'database',
			resourceId: row.id,
			args: { name: row.name, generation: row.studioRoGeneration + 1, reason: current.state === 'failed' ? 'retry' : reason },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
		return this.status(this.row(databaseId)!);
	}

	/**
	 * The account may have been lost (restore, PITR restore, version change): re-apply it. A
	 * database without a principal yet is left alone; the next read-only open creates it.
	 */
	invalidate(databaseId: string, reason: StudioPrincipalReason): void {
		const row = this.row(databaseId);
		if (!row || !row.studioRoSecret) return;
		this.ctx.db
			.update(databases)
			.set({ studioRoGeneration: row.studioRoGeneration + 1, studioRoError: null, updatedAt: this.ctx.now() })
			.where(eq(databases.id, row.id))
			.run();
		this.ctx.audit.record({
			orgId: row.orgId,
			action: 'database.studio.principal-requested',
			resource: 'database',
			resourceId: row.id,
			args: { name: row.name, generation: row.studioRoGeneration + 1, reason },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
	}

	/**
	 * Desired state: running, live databases on the node whose principal is behind and has not
	 * failed at this generation. A database still restoring waits; its restore bumps the
	 * generation again anyway. Off with the studio flag, so an older helper is never asked.
	 */
	tasksForNode(nodeId: string): DatabaseStudioPrincipalTask[] {
		if (!featureEnabled(this.ctx.config, 'DB_STUDIO')) return [];
		return this.ctx.db
			.select({ id: databases.id, generation: databases.studioRoGeneration })
			.from(databases)
			.where(
				and(
					eq(databases.nodeId, nodeId),
					isNull(databases.deletedAt),
					eq(databases.status, 'running'),
					isNull(databases.pendingRestoreId),
					isNotNull(databases.studioRoSecret),
					isNull(databases.studioRoError),
					gt(databases.studioRoGeneration, databases.studioRoReadyGeneration),
				),
			)
			.orderBy(databases.id)
			.limit(100)
			.all()
			.map((row) => ({ databaseId: row.id, generation: row.generation }));
	}

	/**
	 * Node-authenticated activation (`GET /api/agent/database-studio-principal/:id`). Answers only
	 * the node the database is placed on; the password never appears anywhere else.
	 */
	activation(nodeId: string, databaseId: string): DatabaseStudioPrincipalActivation {
		const row = this.row(databaseId);
		if (!row || row.deletedAt) throw new NotFoundError('Database');
		if (row.nodeId !== nodeId) throw new CoreError('forbidden', 'This database is placed on another node.', 403);
		if (!row.studioRoSecret || row.studioRoGeneration === 0)
			throw new ConflictError('This database has no read-only studio principal yet.');
		return {
			databaseId: row.id,
			generation: row.studioRoGeneration,
			engine: row.engine,
			user: DATABASE_STUDIO_READONLY_USER,
			password: this.ctx.secrets.open(row.orgId, row.studioRoSecret),
			database: principalDatabase(row),
		};
	}

	/** Heartbeat outcomes. Only the current generation counts; an older one is ignored. */
	applyResults(nodeId: string, results: readonly DatabaseStudioPrincipalResult[]): void {
		let changed = false;
		for (const result of results) {
			const row = this.row(result.databaseId);
			if (!row || row.nodeId !== nodeId || row.deletedAt) continue;
			if (result.generation !== row.studioRoGeneration) continue;
			if (result.status === 'ok' && row.studioRoReadyGeneration === result.generation) continue;
			const ok = result.status === 'ok';
			const error = ok ? null : (result.error?.trim() || 'The node could not apply the read-only principal.').slice(0, 500);
			this.ctx.db
				.update(databases)
				.set(
					ok
						? { studioRoReadyGeneration: result.generation, studioRoError: null, updatedAt: this.ctx.now() }
						: { studioRoError: error, updatedAt: this.ctx.now() },
				)
				.where(and(eq(databases.id, row.id), eq(databases.studioRoGeneration, result.generation)))
				.run();
			this.ctx.audit.record({
				orgId: row.orgId,
				action: ok ? 'database.studio.principal-ready' : 'database.studio.principal-failed',
				resource: 'database',
				resourceId: row.id,
				args: { name: row.name, generation: result.generation },
				result: ok ? 'ok' : 'error',
				...(ok ? {} : { error: error! }),
			});
			changed = true;
		}
		if (changed) this.ctx.projects.bump();
	}

	/** The principal's password for a read-only studio activation, or null when not ready. */
	readyPassword(row: DatabaseRow): string | null {
		if (this.status(row).state !== 'ready' || !row.studioRoSecret) return null;
		return this.ctx.secrets.open(row.orgId, row.studioRoSecret);
	}

	/**
	 * Workload activation env for Valkey/Redis: the helper renders the ACL user into the generated
	 * server config from it, so the principal survives restarts. Other engines keep their accounts
	 * in the data dir and get nothing. Not part of the activation version: adding it never restarts
	 * the database.
	 */
	workloadEnv(row: DatabaseRow): Record<string, string> {
		if (!row.studioRoSecret || databaseEngineRegistry[row.engine].family !== 'key-value') return {};
		return { [DATABASE_STUDIO_READONLY_ENV]: this.ctx.secrets.open(row.orgId, row.studioRoSecret) };
	}

	private row(id: string): DatabaseRow | undefined {
		return this.ctx.db.select().from(databases).where(eq(databases.id, id)).get();
	}
}

/** Database the principal reads: the owner's database, or Valkey/Redis logical database `0`. */
function principalDatabase(row: DatabaseRow): string {
	return databaseUrlDatabase(row.engine, databaseIdentifier(row.name));
}

/** 24 random bytes in base64url: 32 characters, inside every engine's quoting-free charset. */
function newPassword(): string {
	return randomToken(24);
}
