import { and, eq, inArray } from 'drizzle-orm';
import { diskMounts, nodeVolumes, nodes, storagePools } from '@skiff/db';
import {
	DISK_MOUNT_CAPABILITY,
	canAdministerPlatform,
	diskMountCreateSchema,
	diskMountPath,
	isMountableFsType,
	mountableFsTypes,
	volumeInventorySchema,
	type DiskMountCreate,
	type DiskMountDesired,
	type DiskMountReport,
	type DiskUnmountDesired,
	type Principal,
	type StoragePartitionView,
	type VolumeDevice,
	type VolumeInventory,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { newId, parseJson } from './util.ts';

export type DiskMountRow = typeof diskMounts.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;

/**
 * Partition mounts (docs/VOLUMES.md §3.1).
 *
 * Settings → Storage lists every partition a node reports. *Add as volume* on an unmounted
 * ext4/xfs/btrfs/f2fs filesystem records a mount here; the node's helper mounts that filesystem by
 * UUID at `/mnt/skiff-disks/<name>` (the agent remounts it after a reboot), and once the node's
 * inventory shows the UUID at that path it is adopted as a node volume and put in the requested
 * pool. Nothing is formatted, and only a filesystem the inventory shows as unmounted and unheld can
 * be requested; the helper re-checks that against its own `lsblk` before it mounts.
 */
export class DiskMountService {
	constructor(private readonly ctx: CoreContext) {}

	/** Ask the node to mount an unmounted partition and adopt it as volume `name`. */
	mount(principal: Principal, nodeId: string, raw: DiskMountCreate): DiskMountRow {
		this.assertWrite(principal);
		const input = diskMountCreateSchema.parse(raw);
		const node = this.requireNode(nodeId);
		if (!parseJson<string[]>(node.capabilitiesJson, []).includes(DISK_MOUNT_CAPABILITY))
			throw new ConflictError(`${node.name} runs an agent that cannot mount partitions yet. Update the node, then retry.`);
		const inventory = parseInventory(node.volumeInventoryJson);
		if (!inventory)
			throw new ConflictError(`${node.name} has not reported its disks yet. Wait for the next heartbeat (about a minute) and retry.`);
		const matches = inventory.devices.filter((device) => device.uuid?.toLowerCase() === input.fsUuid.toLowerCase());
		if (matches.length === 0)
			throw new ValidationError(`${node.name} does not report a filesystem with UUID ${input.fsUuid}. Refresh the page and retry.`);
		if (matches.length > 1)
			throw new ConflictError(
				`${node.name} reports ${matches.length} devices with UUID ${input.fsUuid} (a cloned disk?). Give one a new UUID first; Skiff cannot tell them apart.`,
			);
		const device = matches[0]!;
		const problem = mountProblem(device);
		if (problem) throw new ValidationError(`${device.name}: ${problem}`);

		const existing = this.rowsForNode(node.id);
		const sameUuid = existing.find((row) => row.fsUuid.toLowerCase() === input.fsUuid.toLowerCase());
		if (sameUuid)
			throw new ConflictError(
				sameUuid.status === 'unmounting'
					? `${device.name} is still being unmounted from ${node.name}. Wait for it to finish.`
					: `${device.name} is already being mounted as "${sameUuid.name}".`,
			);
		if (existing.some((row) => row.name === input.name))
			throw new ConflictError(`A partition on ${node.name} is already mounted as "${input.name}". Pick another name.`);
		const clash = this.ctx.db
			.select({ id: nodeVolumes.id })
			.from(nodeVolumes)
			.where(and(eq(nodeVolumes.nodeId, node.id), eq(nodeVolumes.name, input.name)))
			.get();
		if (clash) throw new ConflictError(`Volume "${input.name}" already exists on ${node.name}. Pick another name.`);
		let poolId: string | null = null;
		if (input.pool) {
			const pool = this.ctx.db.select().from(storagePools).where(eq(storagePools.name, input.pool)).get();
			if (!pool) throw new NotFoundError(`Storage pool "${input.pool}"`);
			poolId = pool.id;
		}

		const now = this.ctx.now();
		const row: DiskMountRow = {
			id: newId('dkm_'),
			nodeId: node.id,
			name: input.name,
			fsUuid: device.uuid!,
			fsType: device.fsType!.toLowerCase(),
			device: device.name,
			status: 'pending',
			message: null,
			volumeName: input.name,
			volumeDefault: input.defaultVolume,
			poolId,
			volumeId: null,
			mountedAt: null,
			createdBy: principal.userId,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.db.insert(diskMounts).values(row).run();
		this.ctx.audit.record({
			principal,
			action: 'volume.disk.mount',
			resource: 'node',
			resourceId: node.id,
			args: {
				node: node.name,
				name: input.name,
				fsUuid: row.fsUuid,
				fsType: row.fsType,
				device: device.name,
				mountPath: diskMountPath(input.name),
				pool: input.pool ?? null,
			},
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return row;
	}

	/**
	 * Unmount a partition Skiff mounted. Its volume is unregistered first, which is refused while
	 * anything is placed on it; the row stays `unmounting` until the node confirms.
	 */
	unmount(principal: Principal, nodeId: string, id: string): void {
		this.assertWrite(principal);
		const node = this.requireNode(nodeId);
		const row = this.ctx.db.select().from(diskMounts).where(eq(diskMounts.id, id)).get();
		if (!row || row.nodeId !== node.id) throw new NotFoundError('Partition mount');
		if (row.status === 'unmounting') return;
		if (row.volumeId) {
			const volume = this.ctx.volumes.byId(row.volumeId);
			// Refuses (and changes nothing) while anything lives on the volume.
			if (volume) this.ctx.volumes.remove(principal, volume.nodeId, volume.name);
		}
		this.ctx.db
			.update(diskMounts)
			.set({ status: 'unmounting', message: null, volumeName: null, volumeId: null, volumeDefault: false, updatedAt: this.ctx.now() })
			.where(eq(diskMounts.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'volume.disk.unmount',
			resource: 'node',
			resourceId: node.id,
			args: { node: node.name, name: row.name, fsUuid: row.fsUuid },
			result: 'ok',
		});
		this.ctx.nodes.bump();
	}

	rowsForNode(nodeId: string): DiskMountRow[] {
		return this.ctx.db.select().from(diskMounts).where(eq(diskMounts.nodeId, nodeId)).all();
	}

	// ---------------------------------------------------------------- node protocol

	mountsForNode(nodeId: string): DiskMountDesired[] {
		return this.ctx.db
			.select()
			.from(diskMounts)
			.where(and(eq(diskMounts.nodeId, nodeId), inArray(diskMounts.status, ['pending', 'mounted', 'failed'])))
			.all()
			.filter((row) => (mountableFsTypes as readonly string[]).includes(row.fsType))
			.map((row) => ({ id: row.id, name: row.name, fsUuid: row.fsUuid, fsType: row.fsType as DiskMountDesired['fsType'] }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	unmountsForNode(nodeId: string): DiskUnmountDesired[] {
		return this.ctx.db
			.select({ id: diskMounts.id, name: diskMounts.name })
			.from(diskMounts)
			.where(and(eq(diskMounts.nodeId, nodeId), eq(diskMounts.status, 'unmounting')))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Apply a heartbeat: mount status, unmount confirmations, then adopt mounts waiting for it. */
	applyNodeReport(nodeId: string, reports: DiskMountReport[] | undefined, unmounted: string[] | undefined): void {
		const now = this.ctx.now();
		if (reports?.length) {
			const rows = new Map(this.rowsForNode(nodeId).map((row) => [row.id, row]));
			for (const report of reports) {
				const row = rows.get(report.id);
				if (!row || row.status === 'unmounting') continue;
				const status = report.mounted ? 'mounted' : report.error ? 'failed' : 'pending';
				const message = report.mounted ? null : (report.error?.slice(0, 1_000) ?? null);
				if (status === row.status && message === row.message) continue;
				this.ctx.db
					.update(diskMounts)
					.set({ status, message, mountedAt: report.mounted ? (row.mountedAt ?? now) : null, updatedAt: now })
					.where(eq(diskMounts.id, row.id))
					.run();
				if (status === 'failed' && row.status !== 'failed')
					this.ctx.audit.record({
						action: 'volume.disk.mount.fail',
						resource: 'node',
						resourceId: nodeId,
						args: { mountId: row.id, name: row.name, fsUuid: row.fsUuid, error: message },
						result: 'error',
						error: message ?? undefined,
					});
			}
		}
		if (unmounted?.length)
			this.ctx.db
				.delete(diskMounts)
				.where(and(eq(diskMounts.nodeId, nodeId), eq(diskMounts.status, 'unmounting'), inArray(diskMounts.id, unmounted)))
				.run();
		this.linkPending(nodeId);
	}

	/** A removed volume stays mounted but must not re-adopt itself. */
	forgetVolume(volumeId: string): void {
		this.ctx.db
			.update(diskMounts)
			.set({ volumeId: null, volumeName: null, volumeDefault: false, poolId: null, updatedAt: this.ctx.now() })
			.where(eq(diskMounts.volumeId, volumeId))
			.run();
	}

	forgetNode(nodeId: string): void {
		this.ctx.db.delete(diskMounts).where(eq(diskMounts.nodeId, nodeId)).run();
	}

	// ---------------------------------------------------------------- internals

	/** Adopt mounted partitions whose UUID the node's inventory shows at their mount path. */
	private linkPending(nodeId: string): void {
		const pending = this.rowsForNode(nodeId).filter((row) => row.status === 'mounted' && row.volumeName && !row.volumeId);
		if (pending.length === 0) return;
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		const inventory = parseInventory(node?.volumeInventoryJson ?? null);
		if (!node || !inventory) return;
		for (const row of pending) {
			const mountPath = diskMountPath(row.name);
			const device = inventory.devices.find((item) => item.uuid?.toLowerCase() === row.fsUuid.toLowerCase());
			const entry = inventory.mounts.find((item) => item.mountPath === mountPath);
			// Not in this inventory yet (the agent refreshes it after a mount): try next heartbeat.
			if (!device || !entry) continue;
			let volumeId: string | null = null;
			let message: string | null = null;
			if (device.mountPath !== mountPath) {
				message = `The node reports ${mountPath} as another filesystem than ${row.fsUuid}; unmount whatever is there.`;
			} else {
				try {
					const volume = this.ctx.volumes.adoptMount({
						nodeId,
						name: row.volumeName!,
						sourceKey: entry.sourceKey,
						makeDefault: row.volumeDefault,
						createdBy: row.createdBy,
						auditArgs: { fsUuid: row.fsUuid, device: row.device },
					});
					volumeId = volume.id;
					const pool = row.poolId ? this.ctx.db.select().from(storagePools).where(eq(storagePools.id, row.poolId)).get() : null;
					if (pool)
						this.ctx.db
							.update(nodeVolumes)
							.set({ poolId: pool.id, updatedAt: this.ctx.now() })
							.where(eq(nodeVolumes.id, volume.id))
							.run();
				} catch (error) {
					message = `Could not add as volume "${row.volumeName}": ${error instanceof Error ? error.message : String(error)}`;
				}
			}
			if (message === row.message && volumeId === null) continue;
			this.ctx.db.update(diskMounts).set({ volumeId, message, updatedAt: this.ctx.now() }).where(eq(diskMounts.id, row.id)).run();
		}
	}

	private requireNode(nodeId: string): NodeRow {
		const node =
			this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get() ??
			this.ctx.db.select().from(nodes).where(eq(nodes.name, nodeId)).get();
		if (!node) throw new NotFoundError(`Node ${nodeId}`);
		return node;
	}

	private assertWrite(principal: Principal): void {
		if (!canAdministerPlatform(principal))
			throw new CoreError(
				'forbidden',
				principal.platformAdmin
					? 'Storage changes need a platform admin signed in to the dashboard (not an API key or MCP token).'
					: 'Platform admin required.',
				403,
			);
	}
}

function parseInventory(json: string | null): VolumeInventory | null {
	const parsed = volumeInventorySchema.safeParse(parseJson(json, null));
	return parsed.success ? parsed.data : null;
}

/** Why an unmounted device cannot be mounted as a volume, or null. */
function mountProblem(device: VolumeDevice): string | null {
	if (device.mountPath) return `already mounted at ${device.mountPath}.`;
	if (device.holders.length > 0) return `it holds ${device.holders.join(', ')}; add the volume on top of that instead.`;
	if (!device.fsType) return 'it has no filesystem. Skiff does not format disks; create one with mkfs first.';
	if (!isMountableFsType(device.fsType)) return `${device.fsType} cannot hold managed data; Skiff mounts ${mountableFsTypes.join(', ')}.`;
	if (!device.uuid) return 'the filesystem has no UUID, so it cannot be found reliably after a reboot.';
	return null;
}

// ------------------------------------------------------------------ partition list

const MEMBER_FS: Record<string, string> = {
	lvm2_member: 'LVM physical volume; its logical volumes are listed on their own.',
	linux_raid_member: 'RAID member; the assembled array is listed on its own.',
	crypto_luks: 'Encrypted (LUKS) container; unlock it on the node and the opened device is listed on its own.',
	zfs_member: 'ZFS pool member; mounted datasets appear as adoptable mounts.',
	bcache: 'bcache backing device.',
	swap: 'Swap space.',
};

const SYSTEM_PATHS = ['/', '/boot', '/boot/efi', '/efi', '/home', '/var', '/usr', '/opt', '/srv', '/tmp'];

function suggestName(device: VolumeDevice): string {
	const base = (device.label ?? device.name.split('/').at(-1) ?? 'disk')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return base.length >= 3 ? base : `disk-${base || '1'}`.slice(0, 40);
}

/**
 * Every partition a node reports, with what *Add as volume* would do for it. Disks that only hold
 * partitions (and loop/rom devices, which the helper never reports) are left out: the partitions
 * themselves are the rows.
 */
export function partitionViews(input: {
	inventory: VolumeInventory | null;
	volumes: Array<{ name: string; mountPath: string; sourceKey: string }>;
	diskMounts: DiskMountRow[];
	canMount: boolean;
}): StoragePartitionView[] {
	const inventory = input.inventory;
	if (!inventory) return [];
	const byName = new Map(inventory.devices.map((device) => [device.name.replace(/^\/dev\//, ''), device]));
	const mountByPath = new Map(inventory.mounts.map((mount) => [mount.mountPath, mount]));
	const volumeByPath = new Map(input.volumes.map((volume) => [volume.mountPath, volume]));
	const volumeBySource = new Map(input.volumes.map((volume) => [volume.sourceKey, volume]));
	const rowByUuid = new Map(input.diskMounts.map((row) => [row.fsUuid.toLowerCase(), row]));

	const out: StoragePartitionView[] = [];
	// Helpers before 2026-11-08 reported a RAID array's partitions once per member disk; the rows are keyed by device.
	const seen = new Set<string>();
	for (const device of inventory.devices) {
		if (seen.has(device.name)) continue;
		seen.add(device.name);
		const isDisk = device.type === 'disk' || device.type === null;
		// A disk with partitions is a header, not a row; its partitions follow.
		if (isDisk && device.holders.length > 0 && !device.fsType) continue;
		if (/^\/dev\/(zram|loop|ram)\d/.test(device.name)) continue;
		const parent = device.parent ? byName.get(device.parent) : undefined;
		const row = device.uuid ? rowByUuid.get(device.uuid.toLowerCase()) : undefined;
		const mount = device.mountPath ? mountByPath.get(device.mountPath) : undefined;
		const volume = (device.mountPath ? volumeByPath.get(device.mountPath) : undefined) ?? (mount ? volumeBySource.get(mount.sourceKey) : undefined);
		const view: StoragePartitionView = {
			device: device.name,
			type: device.type,
			parent: device.parent,
			model: device.model ?? parent?.model ?? null,
			sizeBytes: device.sizeBytes,
			fsType: device.fsType,
			uuid: device.uuid,
			label: device.label,
			mountPath: device.mountPath,
			state: 'unsupported',
			reason: null,
			volumeName: null,
			sourceKey: null,
			diskMountId: row?.id ?? null,
			suggestedName: suggestName(device),
			freeBytes: mount?.freeBytes ?? null,
		};
		const fs = device.fsType?.toLowerCase() ?? null;
		if (volume) {
			view.state = 'volume';
			view.volumeName = volume.name;
		} else if (row && (row.status !== 'mounted' || (row.volumeName && !row.volumeId && !row.message))) {
			// Mounted but not adopted yet counts as mounting: the next inventory links it.
			view.state = row.status === 'pending' || row.status === 'mounted' ? 'mounting' : row.status;
			view.reason = row.message;
		} else if (device.mountPath === '[SWAP]' || fs === 'swap') {
			view.state = 'in-use';
			view.reason = MEMBER_FS.swap!;
		} else if (device.mountPath) {
			if (mount) {
				view.state = 'adoptable';
				view.sourceKey = mount.sourceKey;
				view.reason = row?.message ?? null;
			} else {
				view.state = 'system';
				view.reason = SYSTEM_PATHS.includes(device.mountPath) || device.mountPath.startsWith('/boot')
					? `Mounted at ${device.mountPath}; part of the operating system.`
					: `Mounted at ${device.mountPath}, which cannot hold managed data. Remount it elsewhere (e.g. under /mnt) to add it.`;
			}
		} else if (fs && MEMBER_FS[fs]) {
			view.state = 'in-use';
			view.reason = MEMBER_FS[fs]!;
		} else if (device.holders.length > 0) {
			view.state = 'in-use';
			view.reason = `Holds ${device.holders.join(', ')}.`;
		} else if (!fs) {
			view.state = 'unformatted';
			view.reason = 'No filesystem. Skiff does not format disks; create one (e.g. mkfs.ext4) on the node and it can be added.';
		} else if (!isMountableFsType(fs)) {
			view.state = 'unsupported';
			view.reason = `${device.fsType} has no Unix ownership and permissions; managed data needs ${mountableFsTypes.join(', ')}.`;
		} else if (!device.uuid) {
			view.state = 'unsupported';
			view.reason = 'No filesystem UUID, so it cannot be found reliably after a reboot.';
		} else if (!input.canMount) {
			view.state = 'unsupported';
			view.reason = 'Update this node to mount partitions from the dashboard, or mount it yourself and adopt it.';
		} else {
			view.state = 'mountable';
		}
		out.push(view);
	}
	return out.sort((a, b) => a.device.localeCompare(b.device, undefined, { numeric: true }));
}
