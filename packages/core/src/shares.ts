import { eq } from 'drizzle-orm';
import { shareGrants, shares } from '@skiff/db';
import {
	canAdministerPlatform,
	canViewPlatform,
	shareCreateSchema,
	shareGrantsSchema,
	shareUpdateSchema,
	type Principal,
	type ShareCreate,
	type ShareGrants,
	type ShareUpdate,
	type ShareView,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { newId } from './util.ts';

type ShareRow = typeof shares.$inferSelect;

/**
 * Cluster shares (docs/CLUSTERING.md §5.2, phase C3).
 *
 * This is the registry: protocol, server/export, failure-domain zone and org grants. Mounting is
 * the agent/helper's job and is additive; the control plane never handles a mount secret value.
 */
export class ShareService {
	constructor(private readonly ctx: CoreContext) {}

	list(principal: Principal): ShareView[] {
		this.assertRead(principal);
		return this.ctx.db
			.select()
			.from(shares)
			.all()
			.map((row) => this.view(row))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	get(principal: Principal, name: string): ShareView {
		this.assertRead(principal);
		return this.view(this.requireRow(name));
	}

	create(principal: Principal, raw: ShareCreate): ShareView {
		this.assertWrite(principal);
		const input = shareCreateSchema.parse(raw);
		if (this.ctx.db.select({ id: shares.id }).from(shares).where(eq(shares.name, input.name)).get())
			throw new ConflictError(`Share "${input.name}" already exists.`);
		const now = this.ctx.now();
		const row: ShareRow = {
			id: newId('shr_'),
			name: input.name,
			protocol: input.protocol,
			server: input.server,
			exportPath: input.exportPath,
			zone: input.zone,
			readOnly: input.readOnly,
			credentialsRef: input.credentialsRef ?? null,
			createdBy: principal.userId,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.db.insert(shares).values(row).run();
		this.ctx.audit.record({
			principal,
			action: 'share.create',
			resource: 'share',
			resourceId: row.id,
			args: { name: row.name, protocol: row.protocol, server: row.server, exportPath: row.exportPath, zone: row.zone },
			result: 'ok',
		});
		return this.view(row);
	}

	update(principal: Principal, name: string, raw: ShareUpdate): ShareView {
		this.assertWrite(principal);
		const input = shareUpdateSchema.parse(raw);
		const row = this.requireRow(name);
		const now = this.ctx.now();
		const changes: Partial<ShareRow> = { updatedAt: now };
		if (input.server !== undefined) changes.server = input.server;
		if (input.exportPath !== undefined) changes.exportPath = input.exportPath;
		if (input.zone !== undefined) changes.zone = input.zone;
		if (input.readOnly !== undefined) changes.readOnly = input.readOnly;
		if (input.credentialsRef !== undefined) changes.credentialsRef = input.credentialsRef;
		this.ctx.db.update(shares).set(changes).where(eq(shares.id, row.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'share.update',
			resource: 'share',
			resourceId: row.id,
			args: { name, ...input },
			result: 'ok',
		});
		return this.view({ ...row, ...changes });
	}

	remove(principal: Principal, name: string): { ok: true } {
		this.assertWrite(principal);
		const row = this.requireRow(name);
		this.ctx.db.transaction(() => {
			this.ctx.db.delete(shareGrants).where(eq(shareGrants.shareId, row.id)).run();
			this.ctx.db.delete(shares).where(eq(shares.id, row.id)).run();
		});
		this.ctx.audit.record({
			principal,
			action: 'share.delete',
			resource: 'share',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		return { ok: true };
	}

	/** Replace every org grant for a share. Credentials are still only an opaque reference. */
	setGrants(principal: Principal, name: string, raw: ShareGrants): ShareView {
		this.assertWrite(principal);
		const input = shareGrantsSchema.parse(raw);
		const row = this.requireRow(name);
		const now = this.ctx.now();
		this.ctx.db.transaction(() => {
			this.ctx.db.delete(shareGrants).where(eq(shareGrants.shareId, row.id)).run();
			for (const grant of input.grants)
				this.ctx.db
					.insert(shareGrants)
					.values({
						shareId: row.id,
						orgId: grant.orgId,
						mode: grant.mode,
						pathPrefix: grant.pathPrefix,
						createdAt: now,
					})
					.run();
		});
		this.ctx.audit.record({
			principal,
			action: 'share.grant',
			resource: 'share',
			resourceId: row.id,
			args: { name, grants: input.grants.map((grant) => ({ orgId: grant.orgId, mode: grant.mode })) },
			result: 'ok',
		});
		return this.view(row);
	}

	private view(row: ShareRow): ShareView {
		const grants = this.ctx.db
			.select()
			.from(shareGrants)
			.where(eq(shareGrants.shareId, row.id))
			.all()
			.map((grant) => ({ orgId: grant.orgId, mode: grant.mode, pathPrefix: grant.pathPrefix }));
		return {
			id: row.id,
			name: row.name,
			protocol: row.protocol,
			server: row.server,
			exportPath: row.exportPath,
			zone: row.zone,
			readOnly: row.readOnly,
			credentialsRef: row.credentialsRef,
			grants,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	private requireRow(name: string): ShareRow {
		const row = this.ctx.db.select().from(shares).where(eq(shares.name, name)).get();
		if (!row) throw new NotFoundError('Share');
		return row;
	}

	private assertRead(principal: Principal): void {
		if (!canViewPlatform(principal)) throw new CoreError('forbidden', 'Platform admin required.', 403);
	}

	private assertWrite(principal: Principal): void {
		if (!canAdministerPlatform(principal))
			throw new CoreError(
				'forbidden',
				principal.platformAdmin
					? 'Share changes need a platform admin signed in to the dashboard (not an API key or MCP token).'
					: 'Platform admin required.',
				403,
			);
	}
}
