import { and, eq } from 'drizzle-orm';
import { appVolumes, databases, nodeVolumes, nodes, shareMounts, storageInstances, volumeProfiles } from '@skiff/db';
import {
	VOLUME_ID_PREFIX,
	canAdministerPlatform,
	canViewPlatform,
	isRemoteVolumeKind,
	nodeStoragePathSchema,
	volumeAdoptSchema,
	volumeInventorySchema,
	volumeUpdateSchema,
	type NodeVolumesView,
	type Principal,
	type VolumeAdopt,
	type VolumeInventory,
	type VolumeStatus,
	type VolumeSummary,
	type VolumeUpdate,
	type VolumeView,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { newId, parseJson } from './util.ts';

export type VolumeRow = typeof nodeVolumes.$inferSelect;

const MB = 1024 * 1024;

/**
 * Node volumes (docs/VOLUMES.md, D72–D80). P0 only **adopts** a mount the node already reports:
 * the control plane stores the stable source key, mount path, filesystem type and capacity, and
 * the node's helper verifies the mount before a managed workload starts (D76). Provisioning
 * (format/LVM/mdadm/ZFS/LUKS/network) is added in later phases behind plan/confirm/apply.
 *
 * Volumes are infrastructure: reading and mutating them needs a platform admin. Org users only
 * ever see the name/path of the volume an instance they can read is placed on.
 */
export class VolumeService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	list(principal: Principal, nodeId: string): NodeVolumesView {
		this.assertPlatformAdmin(principal, 'read');
		const node = this.requireNode(nodeId);
		const rows = this.ctx.db
			.select()
			.from(nodeVolumes)
			.where(eq(nodeVolumes.nodeId, nodeId))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name));
		return {
			volumes: rows.map((row) => this.toView(row, node)),
			inventory: parseInventory(node.volumeInventoryJson),
		};
	}

	/** The volume an instance names, or the node default. Used by create and the dashboard. */
	findByName(name: string): VolumeRow {
		const rows = this.ctx.db.select().from(nodeVolumes).where(eq(nodeVolumes.name, name)).all();
		if (rows.length === 0) throw new NotFoundError(`Volume "${name}"`);
		if (rows.length > 1)
			throw new ValidationError(
				`Volume "${name}" exists on more than one node; set placement to the node that owns it.`,
			);
		return rows[0]!;
	}

	requireOnNode(nodeId: string, name: string): VolumeRow {
		const row = this.ctx.db
			.select()
			.from(nodeVolumes)
			.where(and(eq(nodeVolumes.nodeId, nodeId), eq(nodeVolumes.name, name)))
			.get();
		if (!row) throw new NotFoundError(`Volume "${name}" on this node`);
		return row;
	}

	defaultFor(nodeId: string): VolumeRow | null {
		const node = this.requireNode(nodeId);
		if (!node.defaultVolumeId) return null;
		return (
			this.ctx.db
				.select()
				.from(nodeVolumes)
				.where(and(eq(nodeVolumes.nodeId, nodeId), eq(nodeVolumes.id, node.defaultVolumeId)))
				.get() ?? null
		);
	}

	/** View for a resource's detail page: name, path and whether it is a network mount. */
	summary(volumeId: string | null): VolumeSummary | null {
		if (!volumeId) return null;
		const row = this.ctx.db.select().from(nodeVolumes).where(eq(nodeVolumes.id, volumeId)).get();
		if (!row) return null;
		return { id: row.id, name: row.name, mountPath: row.mountPath, remote: row.remote };
	}

	// ---------------------------------------------------------------- lifecycle

	/** Adopt a mount from the node's latest inventory. Nothing is formatted or mounted here. */
	adopt(principal: Principal, nodeId: string, raw: VolumeAdopt): VolumeView {
		this.assertPlatformAdmin(principal, 'write');
		const input = volumeAdoptSchema.parse(raw);
		const row = this.adoptMount({
			nodeId,
			name: input.name,
			sourceKey: input.sourceKey,
			makeDefault: input.default,
			createdBy: principal.userId,
			principal,
		});
		return this.toView(row, this.requireNode(nodeId));
	}

	/**
	 * Register a mount the node reports as a volume. Shared by `adopt` and by share mounts, which
	 * link themselves once the node reports them (docs/VOLUMES.md §5); callers check permissions.
	 */
	adoptMount(input: {
		nodeId: string;
		name: string;
		sourceKey: string;
		makeDefault: boolean;
		createdBy: string;
		principal?: Principal;
		/** Extra audit arguments (e.g. the share the mount came from). */
		auditArgs?: Record<string, unknown>;
	}): VolumeRow {
		const { nodeId } = input;
		const node = this.requireNode(nodeId);
		const inventory = parseInventory(node.volumeInventoryJson);
		if (!inventory)
			throw new ConflictError(
				`${node.name} has not reported its mounts yet. Wait for the next heartbeat (about 10 s) and retry.`,
			);
		const entry = inventory.mounts.find((mount) => mount.sourceKey === input.sourceKey);
		if (!entry)
			throw new ValidationError(
				`${input.sourceKey} is not mounted on ${node.name} right now. Refresh the inventory after mounting it.`,
			);

		const existing = this.ctx.db
			.select()
			.from(nodeVolumes)
			.where(and(eq(nodeVolumes.nodeId, nodeId), eq(nodeVolumes.name, input.name)))
			.get();
		if (existing) throw new ConflictError(`Volume "${input.name}" already exists on ${node.name}.`);
		const sameSource = this.ctx.db
			.select()
			.from(nodeVolumes)
			.where(and(eq(nodeVolumes.nodeId, nodeId), eq(nodeVolumes.sourceKey, input.sourceKey)))
			.get();
		if (sameSource)
			throw new ConflictError(
				`That mount is already adopted as "${sameSource.name}" on ${node.name}.`,
			);

		const now = this.ctx.now();
		const id = newId(VOLUME_ID_PREFIX);
		const makeDefault = input.makeDefault || node.defaultVolumeId === null;
		this.ctx.db.transaction(() => {
			this.ctx.db
				.insert(nodeVolumes)
				.values({
					id,
					nodeId,
					name: input.name,
					kind: entry.kind,
					sourceKey: entry.sourceKey,
					mountPath: entry.mountPath,
					fsType: entry.fsType,
					options: '',
					remote: entry.remote || isRemoteVolumeKind(entry.kind),
					class: deriveVolumeClass(entry),
					status: 'ready',
					message: null,
					sizeBytes: entry.sizeBytes,
					freeBytes: entry.freeBytes,
					statsAt: now,
					createdBy: input.createdBy,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			if (makeDefault)
				this.ctx.db.update(nodes).set({ defaultVolumeId: id, updatedAt: now }).where(eq(nodes.id, nodeId)).run();
		});
		this.ctx.audit.record({
			principal: input.principal,
			action: 'volume.adopt',
			resource: 'volume',
			resourceId: id,
			args: {
				nodeId,
				name: input.name,
				sourceKey: entry.sourceKey,
				mountPath: entry.mountPath,
				kind: entry.kind,
				remote: entry.remote,
				default: makeDefault,
				...input.auditArgs,
			},
			result: 'ok',
		});
		// Agents must pull the new desired-state volume list to write their registry (D74).
		this.ctx.nodes.bump();
		return this.requireRow(id);
	}

	/** Rename a volume or make it (or stop it being) the node's default. */
	update(principal: Principal, nodeId: string, name: string, raw: VolumeUpdate): VolumeView {
		this.assertPlatformAdmin(principal, 'write');
		const input = volumeUpdateSchema.parse(raw);
		const node = this.requireNode(nodeId);
		const row = this.requireOnNode(nodeId, name);
		const now = this.ctx.now();
		const changes: Partial<typeof nodeVolumes.$inferInsert> = { updatedAt: now };
		if (input.classOverride !== undefined || input.classOverrideReason !== undefined) {
			const override = input.classOverride === undefined ? row.classOverride : input.classOverride;
			const reason = input.classOverrideReason === undefined ? row.classOverrideReason : input.classOverrideReason;
			if (override && !reason)
				throw new ValidationError('A volume class override needs a reason; it is shown next to the derived class.');
			if (override !== undefined) changes.classOverride = override;
			if (input.classOverrideReason !== undefined) changes.classOverrideReason = input.classOverrideReason;
			else if (override === null) changes.classOverrideReason = null;
		}
		if (input.name !== undefined && input.name !== row.name) {
			const clash = this.ctx.db
				.select()
				.from(nodeVolumes)
				.where(and(eq(nodeVolumes.nodeId, nodeId), eq(nodeVolumes.name, input.name)))
				.get();
			if (clash) throw new ConflictError(`Volume "${input.name}" already exists on ${node.name}.`);
			changes.name = input.name;
		}
		this.ctx.db.transaction(() => {
			if (input.default === true)
				this.ctx.db.update(nodes).set({ defaultVolumeId: row.id, updatedAt: now }).where(eq(nodes.id, nodeId)).run();
			else if (input.default === false && node.defaultVolumeId === row.id)
				this.ctx.db.update(nodes).set({ defaultVolumeId: null, updatedAt: now }).where(eq(nodes.id, nodeId)).run();
			if (changes.name !== undefined)
				this.ctx.db.update(nodeVolumes).set(changes).where(eq(nodeVolumes.id, row.id)).run();
		});
		this.ctx.audit.record({
			principal,
			action: 'volume.update',
			resource: 'volume',
			resourceId: row.id,
			args: { nodeId, name, ...input },
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return this.toView(this.requireRow(row.id), this.requireNode(nodeId));
	}

	/** Remove the registration. The mount itself stays; instances using it block the removal. */
	remove(principal: Principal, nodeId: string, name: string): { ok: true } {
		this.assertPlatformAdmin(principal, 'write');
		const node = this.requireNode(nodeId);
		const row = this.requireOnNode(nodeId, name);
		this.assertRemovable(row);
		const now = this.ctx.now();
		this.ctx.db.transaction(() => {
			this.ctx.db.delete(nodeVolumes).where(eq(nodeVolumes.id, row.id)).run();
			this.ctx.db.delete(volumeProfiles).where(eq(volumeProfiles.volumeId, row.id)).run();
			// A share mount linked to this volume stays mounted but must not re-link itself.
			this.ctx.db
				.update(shareMounts)
				.set({ volumeId: null, volumeName: null, volumeDefault: false, updatedAt: now })
				.where(eq(shareMounts.volumeId, row.id))
				.run();
			// Likewise a partition Skiff mounted (VOLUMES §3.1).
			this.ctx.diskMounts.forgetVolume(row.id);
			if (node.defaultVolumeId === row.id)
				this.ctx.db.update(nodes).set({ defaultVolumeId: null, updatedAt: now }).where(eq(nodes.id, nodeId)).run();
		});
		this.ctx.audit.record({
			principal,
			action: 'volume.remove',
			resource: 'volume',
			resourceId: row.id,
			args: { nodeId, name, sourceKey: row.sourceKey },
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return { ok: true };
	}

	/** Refuse removing a volume anything still lives on: managed instances or app volumes. */
	assertRemovable(row: VolumeRow): void {
		const onVolume = this.instancesOf(row.id);
		const apps = this.ctx.db
			.select({ name: appVolumes.name })
			.from(appVolumes)
			.where(eq(appVolumes.nodeVolumeId, row.id))
			.all()
			.map((item) => `app volume ${item.name}`)
			.sort();
		// Node-level storage defaults (docs/STORAGE.md §3.2) may have put builds or site data here.
		for (const kind of ['site-data', 'builds'] as const) {
			const dir = this.ctx.storagePools.nodeDirectory(kind, row.nodeId);
			if (dir?.startsWith(`${row.mountPath}/`)) apps.push(kind === 'builds' ? 'the node\'s builds' : 'the node\'s site data');
		}
		const holders = [...onVolume.storage, ...onVolume.databases, ...apps];
		if (holders.length > 0)
			throw new ConflictError(`Volume "${row.name}" still holds ${holders.join(', ')}. Move or delete them first.`);
	}

	// ---------------------------------------------------------------- node reports

	/**
	 * Reconcile the heartbeat inventory against the registered volumes: refresh capacity and
	 * mark a registered volume `missing` when the node no longer reports its mount (D80). A
	 * transient unmount therefore fails the next workload start (D76) instead of writing to the
	 * local disk.
	 */
	applyInventory(nodeId: string, raw: unknown): void {
		const parsed = volumeInventorySchema.safeParse(raw);
		if (!parsed.success) return;
		const inventory = parsed.data;
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) return;
		const now = this.ctx.now();
		const bySource = new Map(inventory.mounts.map((mount) => [mount.sourceKey, mount]));
		const rows = this.ctx.db.select().from(nodeVolumes).where(eq(nodeVolumes.nodeId, nodeId)).all();
		this.ctx.db.transaction(() => {
			this.ctx.db
				.update(nodes)
				.set({ volumeInventoryJson: JSON.stringify(inventory), updatedAt: now })
				.where(eq(nodes.id, nodeId))
				.run();
			for (const row of rows) {
				const mount = bySource.get(row.sourceKey);
				if (!mount) {
					if (row.status !== 'missing' || row.message === null)
						this.ctx.db
							.update(nodeVolumes)
							.set({
								status: 'missing',
								message: 'The node no longer reports this filesystem as mounted.',
								updatedAt: now,
							})
							.where(eq(nodeVolumes.id, row.id))
							.run();
					continue;
				}
				if (mount.mountPath !== row.mountPath) {
					// A mount that moved is a different thing than what an instance was placed on.
					this.ctx.db
						.update(nodeVolumes)
						.set({
							status: 'missing',
							message: `Mounted at ${mount.mountPath}, but this volume is registered at ${row.mountPath}.`,
							updatedAt: now,
						})
						.where(eq(nodeVolumes.id, row.id))
						.run();
					continue;
				}
				this.ctx.db
					.update(nodeVolumes)
					.set({
						status: 'ready',
						message: null,
						sizeBytes: mount.sizeBytes,
						freeBytes: mount.freeBytes,
						fsType: mount.fsType,
						class: deriveVolumeClass(mount),
						statsAt: now,
						updatedAt: now,
					})
					.where(eq(nodeVolumes.id, row.id))
					.run();
			}
		});
	}

	byId(id: string): VolumeRow | null {
		return this.ctx.db.select().from(nodeVolumes).where(eq(nodeVolumes.id, id)).get() ?? null;
	}

	/** Re-check a volume before restoring an instance that was placed on it (D74). */
	assertVolumeReady(volumeId: string | null, storageMb: number): void {
		if (!volumeId) return;
		const row = this.byId(volumeId);
		if (!row)
			throw new ConflictError('The volume this instance was placed on no longer exists. Restore is not possible.');
		this.assertRoom(row, storageMb);
	}

	/** Registered volumes for a node's desired state (the helper writes its registry from this). */
	desiredForNode(nodeId: string): Array<{ id: string; mountPath: string; sourceKey: string; fsType: string }> {
		return this.ctx.db
			.select({
				id: nodeVolumes.id,
				mountPath: nodeVolumes.mountPath,
				sourceKey: nodeVolumes.sourceKey,
				fsType: nodeVolumes.fsType,
			})
			.from(nodeVolumes)
			.where(eq(nodeVolumes.nodeId, nodeId))
			.all()
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	// ---------------------------------------------------------------- create helpers

	/** Capacity guard for placing a new instance on a volume. */
	assertRoom(volume: VolumeRow, storageMb: number): void {
		if (volume.status !== 'ready')
			throw new ConflictError(
				`Volume "${volume.name}" is ${volume.status}${volume.message ? `: ${volume.message}` : ''}.`,
			);
		if (volume.freeBytes === null) return;
		if (volume.freeBytes < storageMb * MB)
			throw new ConflictError(
				`Volume "${volume.name}" has ${Math.floor(volume.freeBytes / MB)} MB free; "${storageMb}" MB is requested. Pick a larger volume or lower the storage budget.`,
			);
	}

	// ---------------------------------------------------------------- internals

	private requireNode(nodeId: string): typeof nodes.$inferSelect {
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		return node;
	}

	private requireRow(id: string): VolumeRow {
		const row = this.ctx.db.select().from(nodeVolumes).where(eq(nodeVolumes.id, id)).get();
		if (!row) throw new NotFoundError('Volume');
		return row;
	}

	private instancesOf(volumeId: string): { storage: string[]; databases: string[] } {
		const storage = this.ctx.db
			.select({ name: storageInstances.name })
			.from(storageInstances)
			.where(eq(storageInstances.volumeId, volumeId))
			.all()
			.map((item) => item.name)
			.sort();
		const dbs = this.ctx.db
			.select({ name: databases.name })
			.from(databases)
			.where(eq(databases.volumeId, volumeId))
			.all()
			.map((item) => item.name)
			.sort();
		return { storage, databases: dbs };
	}

	private toView(row: VolumeRow, node: typeof nodes.$inferSelect): VolumeView {
		return {
			id: row.id,
			name: row.name,
			nodeId: row.nodeId,
			nodeName: node.name,
			kind: row.kind,
			sourceKey: row.sourceKey,
			mountPath: row.mountPath,
			fsType: row.fsType,
			remote: row.remote,
			class: (row.classOverride ?? row.class) as VolumeView['class'],
			classOverride: row.classOverride,
			classOverrideReason: row.classOverrideReason,
			status: row.status as VolumeStatus,
			message: row.message,
			sizeBytes: row.sizeBytes,
			freeBytes: row.freeBytes,
			statsAt: row.statsAt ? new Date(row.statsAt).toISOString() : null,
			isDefault: node.defaultVolumeId === row.id,
			instances: this.instancesOf(row.id),
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	private assertPlatformAdmin(principal: Principal, access: 'read' | 'write'): void {
		const allowed = access === 'read' ? canViewPlatform(principal) : canAdministerPlatform(principal);
		if (!allowed)
			throw new CoreError(
				'forbidden',
				principal.platformAdmin
					? 'Volume changes need a platform admin signed in to the dashboard (not an API key or MCP token).'
					: 'Platform admin required.',
				403,
			);
	}
}

/** Path check for a volume mount path (shared with the node storage settings). */
export function mountPathProblem(path: string): string | null {
	const result = nodeStoragePathSchema.safeParse(path);
	return result.success ? null : (result.error.issues[0]?.message ?? 'Invalid mount path');
}

function parseInventory(json: string | null): VolumeInventory | null {
	if (!json) return null;
	const parsed = volumeInventorySchema.safeParse(parseJson(json, null));
	return parsed.success ? parsed.data : null;
}

/** A conservative class from what the inventory knows; hardware/rotation refines it in C0. */
function deriveVolumeClass(mount: { remote: boolean; kind: string; device?: string | null; sourceKey: string }): 'fast' | 'remote' | 'unknown' {
	if (mount.remote || mount.kind === 'nfs' || mount.kind === 'cifs') return 'remote';
	if (/nvme/i.test(mount.device ?? '') || /nvme/i.test(mount.sourceKey)) return 'fast';
	return 'unknown';
}
