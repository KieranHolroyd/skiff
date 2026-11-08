import { and, eq, inArray, or } from 'drizzle-orm';
import { disks, nodes, shareGrants, shareMounts, shares } from '@skiff/db';
import {
	canAdministerPlatform,
	canViewPlatform,
	shareCreateSchema,
	shareCredentialsSchema,
	shareGrantsSchema,
	shareMountCreateSchema,
	shareMountLinkSchema,
	shareMountPath,
	shareSourceKey,
	shareUpdateSchema,
	volumeInventorySchema,
	type Principal,
	type ShareCreate,
	type ShareCredentials,
	type ShareGrants,
	type ShareMountCreate,
	type ShareMountCredentials,
	type ShareMountDesired,
	type ShareMountLink,
	type ShareMountReport,
	type ShareMountView,
	type ShareUnmountDesired,
	type ShareUpdate,
	type ShareView,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { newId, parseJson } from './util.ts';

type ShareRow = typeof shares.$inferSelect;
type MountRow = typeof shareMounts.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;

/** Agent capability that mounts `shareMounts` (contracts `nodeCapabilities`). */
export const SHARE_MOUNT_CAPABILITY = 'share-mounts';
/** Shares have no org; their SMB credentials are sealed with the platform key. */
const PLATFORM_KEY_ORG = 'platform';

/**
 * Cluster shares (docs/CLUSTERING.md §5.2, docs/STORAGE.md §3, D143).
 *
 * The registry holds protocol, server/export, failure-domain zone, org grants and sealed SMB
 * credentials. A **mount** asks one node's helper to mount the share at
 * `/mnt/skiff-shares/<name>`; the node reports the result in its heartbeat. A read-write mount
 * becomes a **disk** (D169): once the node's inventory shows the share's source key at that path,
 * services can be placed on it like on any other disk, and the helper verifies it before every
 * start (D76).
 *
 * Credentials never enter desired state: the node fetches them for one mount call through the
 * node-authenticated credential endpoint, and neither values nor usernames reach audit arguments.
 */
export class ShareService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- registry

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
			credentialsSealed: input.credentials ? this.sealCredentials(input.credentials) : null,
			credentialsUsername: input.credentials?.username ?? null,
			generation: 1,
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
			args: {
				name: row.name,
				protocol: row.protocol,
				server: row.server,
				exportPath: row.exportPath,
				zone: row.zone,
				readOnly: row.readOnly,
				credentials: Boolean(row.credentialsSealed),
			},
			result: 'ok',
		});
		return this.view(row);
	}

	update(principal: Principal, name: string, raw: ShareUpdate): ShareView {
		this.assertWrite(principal);
		const input = shareUpdateSchema.parse(raw);
		const row = this.requireRow(name);
		const definitionChange =
			(input.server !== undefined && input.server !== row.server) ||
			(input.exportPath !== undefined && input.exportPath !== row.exportPath) ||
			(input.readOnly !== undefined && input.readOnly !== row.readOnly);
		if (definitionChange) {
			const mounted = this.mountRows(row.id);
			if (mounted.length > 0)
				throw new ConflictError(
					`Share "${name}" is mounted on ${this.nodeNames(mounted).join(', ')}. Unmount it before changing the server, export or mode.`,
				);
		}
		if (input.credentials && row.protocol !== 'smb')
			throw new ValidationError('NFS shares do not take a username or password.');
		const now = this.ctx.now();
		const changes: Partial<ShareRow> = { updatedAt: now };
		if (input.server !== undefined) changes.server = input.server;
		if (input.exportPath !== undefined) changes.exportPath = input.exportPath;
		if (input.zone !== undefined) changes.zone = input.zone;
		if (input.readOnly !== undefined) changes.readOnly = input.readOnly;
		if (input.credentialsRef !== undefined) changes.credentialsRef = input.credentialsRef;
		if (input.credentials !== undefined) {
			changes.credentialsSealed = input.credentials ? this.sealCredentials(input.credentials) : null;
			changes.credentialsUsername = input.credentials?.username ?? null;
			// Failed mounts retry at once with the new credentials; a working mount is left alone.
			changes.generation = row.generation + 1;
		}
		this.ctx.db.update(shares).set(changes).where(eq(shares.id, row.id)).run();
		const { credentials, ...auditInput } = input;
		this.ctx.audit.record({
			principal,
			action: input.credentials !== undefined ? 'share.credential.rotate' : 'share.update',
			resource: 'share',
			resourceId: row.id,
			args: { name, ...auditInput, ...(credentials !== undefined ? { credentials: credentials ? 'replaced' : 'cleared' } : {}) },
			result: 'ok',
		});
		if (changes.generation !== undefined) this.ctx.nodes.bump();
		return this.view({ ...row, ...changes });
	}

	remove(principal: Principal, name: string): { ok: true } {
		this.assertWrite(principal);
		const row = this.requireRow(name);
		const mounted = this.mountRows(row.id);
		if (mounted.length > 0)
			throw new ConflictError(
				`Share "${name}" is still mounted on ${this.nodeNames(mounted).join(', ')}. Unmount it first.`,
			);
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

	/** Replace every org grant for a share. */
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

	// ---------------------------------------------------------------- mounts

	/**
	 * Mount a share on a node. The node's helper mounts it at `/mnt/skiff-shares/<name>` on its
	 * next pull. A read-write share becomes the disk `diskName` (default: the share name) as soon
	 * as the node reports the mount; a read-only one stays a plain mount.
	 */
	mount(principal: Principal, name: string, raw: ShareMountCreate): ShareView {
		this.assertWrite(principal);
		const input = shareMountCreateSchema.parse(raw);
		const share = this.requireRow(name);
		const node = this.resolveNode(input.node);
		if (!parseJson<string[]>(node.capabilitiesJson, []).includes(SHARE_MOUNT_CAPABILITY))
			throw new ConflictError(
				`${node.name} runs an agent that cannot mount network shares yet. Update the node, then retry.`,
			);
		if (share.protocol === 'smb' && !share.credentialsSealed)
			throw new ValidationError(`Share "${name}" needs an SMB username and password before it can be mounted.`);
		const existing = this.mountRow(share.id, node.id);
		if (existing)
			throw new ConflictError(
				existing.status === 'unmounting'
					? `Share "${name}" is still being unmounted from ${node.name}. Wait for it to finish.`
					: `Share "${name}" is already mounted on ${node.name}.`,
			);
		const diskName = share.readOnly ? null : (input.diskName ?? share.name);
		if (diskName) this.assertLinkable(share, node, diskName);
		const now = this.ctx.now();
		const row: MountRow = {
			id: newId('shm_'),
			shareId: share.id,
			nodeId: node.id,
			status: 'pending',
			message: null,
			diskName,
			diskId: null,
			mountedAt: null,
			createdBy: principal.userId,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.db.insert(shareMounts).values(row).run();
		this.ctx.audit.record({
			principal,
			action: 'share.mount',
			resource: 'share',
			resourceId: share.id,
			args: { name, nodeId: node.id, node: node.name, mountPath: shareMountPath(share.name), diskName },
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return this.view(share);
	}

	/**
	 * Unmount a share from a node. Its disk is removed first, which is refused while anything lives
	 * on it; the mount row stays `unmounting` until the node confirms.
	 */
	unmount(principal: Principal, name: string, nodeRef: string): ShareView {
		this.assertWrite(principal);
		const share = this.requireRow(name);
		const node = this.resolveNode(nodeRef);
		const row = this.mountRow(share.id, node.id);
		if (!row) throw new NotFoundError(`Mount of "${name}" on ${node.name}`);
		if (row.status === 'unmounting') return this.view(share);
		// Removing the disk refuses (and changes nothing) while anything is placed on it.
		this.removeDisk(row, principal);
		this.ctx.db
			.update(shareMounts)
			.set({ status: 'unmounting', message: null, diskName: null, diskId: null, updatedAt: this.ctx.now() })
			.where(eq(shareMounts.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'share.unmount',
			resource: 'share',
			resourceId: share.id,
			args: { name, nodeId: node.id, node: node.name },
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return this.view(share);
	}

	/** Use an existing mount as a disk (now if the node reports it, else on its next report). */
	link(principal: Principal, name: string, nodeRef: string, raw: ShareMountLink): ShareView {
		this.assertWrite(principal);
		const input = shareMountLinkSchema.parse(raw);
		const share = this.requireRow(name);
		const node = this.resolveNode(nodeRef);
		const row = this.mountRow(share.id, node.id);
		if (!row || row.status === 'unmounting') throw new NotFoundError(`Mount of "${name}" on ${node.name}`);
		if (row.diskId && this.ctx.disks.byId(row.diskId))
			throw new ConflictError(`Share "${name}" on ${node.name} is already a disk.`);
		this.assertLinkable(share, node, input.diskName);
		this.ctx.db
			.update(shareMounts)
			.set({ diskName: input.diskName, diskId: null, message: null, updatedAt: this.ctx.now() })
			.where(eq(shareMounts.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'share.link',
			resource: 'share',
			resourceId: share.id,
			args: { name, nodeId: node.id, diskName: input.diskName },
			result: 'ok',
		});
		this.linkPending(node.id);
		return this.view(share);
	}

	/** Stop using a mount as a disk; the share stays mounted. */
	unlink(principal: Principal, name: string, nodeRef: string): ShareView {
		this.assertWrite(principal);
		const share = this.requireRow(name);
		const node = this.resolveNode(nodeRef);
		const row = this.mountRow(share.id, node.id);
		if (!row) throw new NotFoundError(`Mount of "${name}" on ${node.name}`);
		this.removeDisk(row, principal);
		this.ctx.db
			.update(shareMounts)
			.set({ diskName: null, diskId: null, updatedAt: this.ctx.now() })
			.where(eq(shareMounts.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'share.unlink',
			resource: 'share',
			resourceId: share.id,
			args: { name, nodeId: node.id },
			result: 'ok',
		});
		return this.view(share);
	}

	// ---------------------------------------------------------------- node protocol

	/** Desired share mounts for a node. Carries no credential, only whether to fetch one. */
	mountsForNode(nodeId: string): ShareMountDesired[] {
		return this.ctx.db
			.select({ mount: shareMounts, share: shares })
			.from(shareMounts)
			.innerJoin(shares, eq(shares.id, shareMounts.shareId))
			.where(and(eq(shareMounts.nodeId, nodeId), inArray(shareMounts.status, ['pending', 'mounted', 'failed'])))
			.all()
			.map(({ mount, share }) => ({
				id: mount.id,
				name: share.name,
				protocol: share.protocol,
				server: share.server,
				exportPath: share.exportPath,
				readOnly: share.readOnly,
				credentials: share.protocol === 'smb',
				generation: String(share.generation),
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	unmountsForNode(nodeId: string): ShareUnmountDesired[] {
		return this.ctx.db
			.select({ id: shareMounts.id, name: shares.name })
			.from(shareMounts)
			.innerJoin(shares, eq(shares.id, shareMounts.shareId))
			.where(and(eq(shareMounts.nodeId, nodeId), eq(shareMounts.status, 'unmounting')))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** SMB credentials for one mount, for the node that holds it. Audited without the values. */
	credentialsFor(nodeId: string, mountId: string): ShareMountCredentials {
		const row = this.ctx.db.select().from(shareMounts).where(eq(shareMounts.id, mountId)).get();
		if (!row || row.nodeId !== nodeId || row.status === 'unmounting') throw new NotFoundError('Share mount');
		const share = this.ctx.db.select().from(shares).where(eq(shares.id, row.shareId)).get();
		if (!share?.credentialsSealed) throw new NotFoundError('Share credentials');
		const credentials = shareCredentialsSchema.parse(
			JSON.parse(this.ctx.secrets.open(PLATFORM_KEY_ORG, share.credentialsSealed)),
		);
		this.ctx.audit.record({
			action: 'share.credential.use',
			resource: 'share',
			resourceId: share.id,
			args: { name: share.name, nodeId, mountId },
			result: 'ok',
		});
		return { id: row.id, username: credentials.username, password: credentials.password, domain: credentials.domain ?? null };
	}

	/**
	 * Apply a heartbeat: mount status per desired mount, unmount confirmations, then register any
	 * mounted share that is waiting to become a disk.
	 */
	applyNodeReport(nodeId: string, reports: ShareMountReport[] | undefined, unmounted: string[] | undefined): void {
		const now = this.ctx.now();
		if (reports?.length) {
			const rows = new Map(
				this.ctx.db
					.select()
					.from(shareMounts)
					.where(eq(shareMounts.nodeId, nodeId))
					.all()
					.map((row) => [row.id, row]),
			);
			for (const report of reports) {
				const row = rows.get(report.id);
				if (!row || row.status === 'unmounting') continue;
				const status = report.mounted ? 'mounted' : report.error ? 'failed' : 'pending';
				const message = report.mounted ? null : (report.error?.slice(0, 1_000) ?? null);
				if (status === row.status && message === row.message) continue;
				this.ctx.db
					.update(shareMounts)
					.set({ status, message, mountedAt: report.mounted ? (row.mountedAt ?? now) : null, updatedAt: now })
					.where(eq(shareMounts.id, row.id))
					.run();
				if (status === 'failed' && row.status !== 'failed')
					this.ctx.audit.record({
						action: 'share.mount.fail',
						resource: 'share',
						resourceId: row.shareId,
						args: { nodeId, mountId: row.id, error: message },
						result: 'error',
						error: message ?? undefined,
					});
			}
		}
		if (unmounted?.length)
			this.ctx.db
				.delete(shareMounts)
				.where(and(eq(shareMounts.nodeId, nodeId), eq(shareMounts.status, 'unmounting'), inArray(shareMounts.id, unmounted)))
				.run();
		this.linkPending(nodeId);
	}

	// ---------------------------------------------------------------- internals

	/** Register mounted shares waiting to become a disk once the node's inventory shows the mount. */
	private linkPending(nodeId: string): void {
		const pending = this.ctx.db
			.select({ mount: shareMounts, share: shares })
			.from(shareMounts)
			.innerJoin(shares, eq(shares.id, shareMounts.shareId))
			.where(and(eq(shareMounts.nodeId, nodeId), eq(shareMounts.status, 'mounted')))
			.all()
			.filter(({ mount }) => mount.diskName && !mount.diskId);
		if (pending.length === 0) return;
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		const inventory = volumeInventorySchema.safeParse(parseJson(node?.diskInventoryJson ?? null, null));
		if (!node || !inventory.success) return;
		for (const { mount, share } of pending) {
			const sourceKey = shareSourceKey(share);
			const mountPath = shareMountPath(share.name);
			const entry = inventory.data.mounts.find((item) => item.sourceKey === sourceKey);
			// Not in this inventory yet (it refreshes about once a minute): try again next heartbeat.
			if (!entry) continue;
			let diskId: string | null = null;
			let message: string | null = null;
			if (entry.mountPath !== mountPath) {
				message = `The node also mounts ${sourceKey} at ${entry.mountPath}; unmount that copy so Skiff can use ${mountPath}.`;
			} else {
				try {
					diskId = this.ctx.disks.register({
						nodeId,
						name: mount.diskName!,
						sourceKey,
						createdBy: mount.createdBy,
						auditArgs: { share: share.name },
					}).id;
				} catch (error) {
					message = `Could not use it as disk "${mount.diskName}": ${error instanceof Error ? error.message : String(error)}`;
				}
			}
			if (message === mount.message && diskId === null) continue;
			this.ctx.db
				.update(shareMounts)
				.set({ diskId, message, updatedAt: this.ctx.now() })
				.where(eq(shareMounts.id, mount.id))
				.run();
		}
	}

	/** Remove the disk a mount became, refusing while anything is placed on it. */
	private removeDisk(row: MountRow, principal: Principal): void {
		if (!row.diskId || !this.ctx.disks.byId(row.diskId)) return;
		this.ctx.disks.remove(principal, row.diskId, { viaShare: true });
	}

	private assertLinkable(share: ShareRow, node: NodeRow, diskName: string): void {
		if (share.readOnly)
			throw new ValidationError(`Share "${share.name}" is read-only, so Skiff cannot keep data on it. Make the share read-write first.`);
		const clash = this.ctx.db
			.select({ id: disks.id })
			.from(disks)
			.where(and(eq(disks.nodeId, node.id), eq(disks.name, diskName)))
			.get();
		if (clash) throw new ConflictError(`A disk named "${diskName}" already exists on ${node.name}. Pick another name.`);
	}

	private sealCredentials(raw: ShareCredentials): string {
		const credentials = shareCredentialsSchema.parse(raw);
		return this.ctx.secrets.seal(PLATFORM_KEY_ORG, JSON.stringify(credentials));
	}

	private resolveNode(ref: string): NodeRow {
		const row = this.ctx.db
			.select()
			.from(nodes)
			.where(or(eq(nodes.id, ref), eq(nodes.name, ref)))
			.get();
		if (!row) throw new NotFoundError(`Node "${ref}"`);
		return row;
	}

	private mountRow(shareId: string, nodeId: string): MountRow | null {
		return (
			this.ctx.db
				.select()
				.from(shareMounts)
				.where(and(eq(shareMounts.shareId, shareId), eq(shareMounts.nodeId, nodeId)))
				.get() ?? null
		);
	}

	private mountRows(shareId: string): MountRow[] {
		return this.ctx.db.select().from(shareMounts).where(eq(shareMounts.shareId, shareId)).all();
	}

	private nodeNames(rows: MountRow[]): string[] {
		const ids = rows.map((row) => row.nodeId);
		const names = new Map(
			this.ctx.db
				.select({ id: nodes.id, name: nodes.name })
				.from(nodes)
				.where(inArray(nodes.id, ids))
				.all()
				.map((node) => [node.id, node.name]),
		);
		return ids.map((id) => names.get(id) ?? id).sort();
	}

	private mountViews(share: ShareRow): ShareMountView[] {
		const rows = this.mountRows(share.id);
		if (rows.length === 0) return [];
		const nodeNames = new Map(
			this.ctx.db
				.select({ id: nodes.id, name: nodes.name })
				.from(nodes)
				.where(inArray(nodes.id, rows.map((row) => row.nodeId)))
				.all()
				.map((node) => [node.id, node.name]),
		);
		return rows
			.map((row) => {
				const disk = this.ctx.disks.byId(row.diskId);
				return {
					id: row.id,
					nodeId: row.nodeId,
					nodeName: nodeNames.get(row.nodeId) ?? null,
					mountPath: shareMountPath(share.name),
					status: row.status,
					message: row.message,
					diskName: disk?.name ?? row.diskName,
					disk: disk ? { id: disk.id, name: disk.name, status: disk.status, profile: this.ctx.disks.latestProfile(disk.id) } : null,
					mountedAt: row.mountedAt ? new Date(row.mountedAt).toISOString() : null,
					createdAt: new Date(row.createdAt).toISOString(),
					updatedAt: new Date(row.updatedAt).toISOString(),
				};
			})
			.sort((a, b) => (a.nodeName ?? a.nodeId).localeCompare(b.nodeName ?? b.nodeId));
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
			hasCredentials: Boolean(row.credentialsSealed),
			username: row.credentialsUsername,
			grants,
			mounts: this.mountViews(row),
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
