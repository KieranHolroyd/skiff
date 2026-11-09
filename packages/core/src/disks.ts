import { and, desc, eq, inArray, isNull, lt, ne } from 'drizzle-orm';
import {
	appVolumes,
	brokers,
	databaseReplicas,
	databases,
	diskProfiles,
	disks,
	nodes,
	settings,
	shareMounts,
	shares,
	storageDefaults,
	storageInstances,
} from '@yoal/db';
import {
	DISK_ID_PREFIX,
	DISK_MIN_FREE_PERCENT,
	DISK_MOUNT_CAPABILITY,

	VOLUME_PROFILE_CAPABILITY,
	diskAddSchema,
	diskMountPath,
	diskUpdateSchema,
	isMountableFsType,
	isRemoteVolumeKind,
	isTierTarget,
	mountableFsTypes,
	nodeStorageKinds,
	storageDefaultTargets,
	storageDefaultsSchema,
	storageKindInfo,
	storageKinds,
	storageOnboardingSchema,
	storageTierInfo,
	volumeInventorySchema,
	volumeProfileLimits,
	type DiskAdd,
	type DiskCandidateView,
	type DiskMountDesired,
	type DiskMountReport,
	type DiskProfileView,
	type DiskSummary,
	type DiskUnmountDesired,
	type DiskUpdate,
	type DiskView,
	type NodeVolumeDesired,
	type Principal,
	type StorageChoices,
	type StorageDefaultTarget,
	type StorageDefaultView,
	type StorageDefaultsInput,
	type StorageKind,
	type StorageNodeView,
	type StorageOnboardingState,
	type StorageOverview,
	type StorageTier,
	type VolumeDevice,
	type VolumeInventory,
	type VolumeInventoryEntry,
	type VolumeProfileResult,
	type VolumeProfileTask,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import type { PlacementCandidate } from './placement.ts';
import { nodeDiskFreeBytes } from './app-volumes.ts';
import { newId, parseJson } from './util.ts';

export type DiskRow = typeof disks.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;

const MB = 1024 * 1024;
const ONBOARDING_KEY = 'storage.onboarding';
const SHARE_MOUNT_ROOT = '/mnt/yoal-shares';

/**
 * Where a new resource goes (docs/STORAGE.md §2.2): the system disk, a tier, or one disk.
 * `chosen` is false when the target came from the kind's default rather than the request.
 */
export interface StoragePlan {
	kind: StorageKind;
	target: StorageDefaultTarget | 'disk';
	disk: DiskRow | null;
	chosen: boolean;
}

/**
 * Disks and default storage (docs/STORAGE.md, D169).
 *
 * A disk is a mounted filesystem on one node; each is `fast` or `bulk`. Settings → Storage holds
 * one default target per kind of service (`system`, `fast` or `bulk`), and every create path asks
 * `prepare()` → placement → `pick()`. A tier that cannot hold the resource is a refusal; Yoal
 * never swaps in another tier or the system disk, and nothing already placed moves.
 *
 * The node protocol (registry, partition mounts, profiles) keeps its "volume" wire names.
 */
export class DiskService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	overview(principal: Principal): StorageOverview {
		this.assertRead(principal);
		this.expireProfiles();
		const rows = this.allRows();
		const nodeRows = this.ctx.db.select().from(nodes).all().sort((a, b) => a.name.localeCompare(b.name));
		const names = new Map(nodeRows.map((node) => [node.id, node.name]));
		const tiers = {
			fast: { disks: 0, sizeBytes: 0, freeBytes: 0 },
			bulk: { disks: 0, sizeBytes: 0, freeBytes: 0 },
		};
		for (const row of rows.filter((item) => item.status === 'ready')) {
			const tier = tiers[row.tier];
			tier.disks += 1;
			tier.sizeBytes += row.sizeBytes ?? 0;
			tier.freeBytes += row.freeBytes ?? 0;
		}
		return {
			onboarding: this.onboardingState(),
			defaults: this.defaultViews(rows),
			tiers,
			nodes: nodeRows.map((node) => this.nodeView(node, rows.filter((row) => row.nodeId === node.id), names)),
		};
	}

	/** What a create form may offer for `kind`. Safe for any signed-in user (no nodes, paths or capacity). */
	choices(kind: StorageKind): StorageChoices {
		const ready = new Set(this.allRows().filter((row) => row.status === 'ready').map((row) => row.tier));
		return {
			kind,
			defaultTarget: this.defaultTarget(kind) ?? 'system',
			targets: storageDefaultTargets.map((value) => ({
				value,
				label: storageTierInfo[value].label,
				description: storageTierInfo[value].description,
				available: value === 'system' || ready.has(value),
			})),
		};
	}

	onboardingState(): StorageOnboardingState {
		const row = this.ctx.db.select().from(settings).where(eq(settings.key, ONBOARDING_KEY)).get();
		return row?.value === 'done' || row?.value === 'skipped' ? row.value : 'pending';
	}

	byId(id: string | null | undefined): DiskRow | null {
		if (!id) return null;
		return this.ctx.db.select().from(disks).where(eq(disks.id, id)).get() ?? null;
	}

	/** What a resource's detail view shows; null is the system disk. */
	summary(diskId: string | null): DiskSummary | null {
		const row = this.byId(diskId);
		return row ? { id: row.id, name: row.name, tier: row.tier, remote: row.remote } : null;
	}

	/** The target that keeps a placed resource where it is when it moves: its disk's tier, or `system`. */
	targetOf(diskId: string | null): StorageDefaultTarget {
		if (!diskId) return 'system';
		return this.byId(diskId)?.tier ?? 'system';
	}

	/** Latest benchmark of a disk, or null. */
	latestProfile(diskId: string): DiskProfileView | null {
		const row = this.ctx.db
			.select()
			.from(diskProfiles)
			.where(eq(diskProfiles.diskId, diskId))
			.orderBy(desc(diskProfiles.createdAt))
			.limit(1)
			.get();
		if (!row) return null;
		return {
			id: row.id,
			diskId: row.diskId,
			status: row.status,
			method: row.method,
			seqReadMBps: row.seqReadMBps,
			seqWriteMBps: row.seqWriteMBps,
			randReadIops: row.randReadIops,
			randWriteIops: row.randWriteIops,
			syncWriteIops: row.syncWriteIops,
			syncWriteLatencyUs: row.syncWriteLatencyUs,
			direct: row.direct,
			notes: stringArray(parseJson<unknown>(row.notesJson, [])),
			error: row.error,
			createdAt: isoOrEpoch(row.createdAt),
			finishedAt: isoOrNull(row.finishedAt),
		};
	}

	// ---------------------------------------------------------------- disks

	/**
	 * *Use this disk*: register a mounted filesystem at once, or ask the node to mount an unmounted
	 * one by UUID at /mnt/yoal-disks/<name> (the disk is `pending` until the node reports it there).
	 */
	add(principal: Principal, raw: DiskAdd): DiskView {
		this.assertWrite(principal, 'storage:create');
		const input = diskAddSchema.parse(raw);
		const node = this.requireNode(input.node);
		const inventory = parseInventory(node.diskInventoryJson);
		if (!inventory)
			throw new ConflictError(`${node.name} has not reported its disks yet. Wait for the next heartbeat (about a minute) and retry.`);
		const mine = this.rowsForNode(node.id);
		const candidate = diskCandidates({ inventory, disks: mine, canMount: canMount(node) }).find(
			(item) => item.key === input.candidate,
		);
		if (!candidate) throw new ValidationError(`${node.name} does not report ${input.candidate} any more. Refresh the page and retry.`);
		if (!candidate.usable) throw new ValidationError(`${candidate.device}: ${candidate.reason}`);
		const name = input.name ?? this.freeName(node.id, candidate.suggestedName);
		this.assertNameFree(node, name);
		const tier = input.tier ?? candidate.suggestedTier;

		let row: DiskRow;
		if (candidate.needsMount) {
			const uuid = input.candidate.slice('uuid:'.length);
			const device = inventory.devices.find((item) => item.uuid?.toLowerCase() === uuid.toLowerCase())!;
			const mountPath = diskMountPath(name);
			if (mine.some((item) => item.mountPath === mountPath))
				throw new ConflictError(`${mountPath} is already used on ${node.name}. Pick another name.`);
			row = this.insert({
				nodeId: node.id,
				name,
				kind: 'filesystem',
				sourceKey: `fs:${device.uuid!}`,
				mountPath,
				fsType: device.fsType!.toLowerCase(),
				remote: false,
				tier,
				tierSet: input.tier !== undefined,
				mountUuid: device.uuid!,
				status: 'pending',
				sizeBytes: device.sizeBytes,
				freeBytes: null,
				createdBy: principal.userId,
			});
		} else {
			const sourceKey = input.candidate.slice('mount:'.length);
			const mount = inventory.mounts.find((item) => item.sourceKey === sourceKey)!;
			row = this.insert({
				nodeId: node.id,
				name,
				kind: mount.kind,
				sourceKey: mount.sourceKey,
				mountPath: mount.mountPath,
				fsType: mount.fsType,
				remote: mount.remote || isRemoteVolumeKind(mount.kind),
				tier,
				tierSet: input.tier !== undefined,
				mountUuid: null,
				status: 'ready',
				sizeBytes: mount.sizeBytes,
				freeBytes: mount.freeBytes,
				createdBy: principal.userId,
			});
		}
		this.ctx.audit.record({
			principal,
			action: 'storage.disk.add',
			resource: 'disk',
			resourceId: row.id,
			args: {
				node: node.name,
				name,
				tier,
				sourceKey: row.sourceKey,
				mountPath: row.mountPath,
				device: candidate.device,
				mount: candidate.needsMount,
			},
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return this.view(row);
	}

	/**
	 * Register a mount the node reports as a disk, without the candidate checks. Network shares use
	 * it once their mount appears (D143); callers check permissions.
	 */
	register(input: {
		nodeId: string;
		name: string;
		sourceKey: string;
		createdBy: string;
		auditArgs?: Record<string, unknown>;
	}): DiskRow {
		const node = this.requireNode(input.nodeId);
		const inventory = parseInventory(node.diskInventoryJson);
		const mount = inventory?.mounts.find((item) => item.sourceKey === input.sourceKey);
		if (!mount) throw new ValidationError(`${input.sourceKey} is not mounted on ${node.name} right now.`);
		this.assertNameFree(node, input.name);
		const sameSource = this.rowsForNode(node.id).find((row) => row.sourceKey === input.sourceKey);
		if (sameSource) throw new ConflictError(`That mount is already the disk "${sameSource.name}" on ${node.name}.`);
		const row = this.insert({
			nodeId: node.id,
			name: input.name,
			kind: mount.kind,
			sourceKey: mount.sourceKey,
			mountPath: mount.mountPath,
			fsType: mount.fsType,
			remote: mount.remote || isRemoteVolumeKind(mount.kind),
			tier: deriveTier(mount, inventory!.devices),
			tierSet: false,
			mountUuid: null,
			status: 'ready',
			sizeBytes: mount.sizeBytes,
			freeBytes: mount.freeBytes,
			createdBy: input.createdBy,
		});
		this.ctx.audit.record({
			action: 'storage.disk.add',
			resource: 'disk',
			resourceId: row.id,
			args: { node: node.name, name: input.name, sourceKey: row.sourceKey, mountPath: row.mountPath, ...input.auditArgs },
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return row;
	}

	/** Rename a disk or set its tier. New services follow the tier; nothing placed moves. */
	update(principal: Principal, id: string, raw: DiskUpdate): DiskView {
		this.assertWrite(principal, 'storage:update');
		const input = diskUpdateSchema.parse(raw);
		const row = this.requireRow(id);
		const changes: Partial<typeof disks.$inferInsert> = { updatedAt: this.ctx.now() };
		if (input.name !== undefined && input.name !== row.name) {
			this.assertNameFree(this.requireNode(row.nodeId), input.name);
			changes.name = input.name;
		}
		if (input.tier !== undefined) {
			changes.tier = input.tier;
			changes.tierSet = true;
		}
		this.ctx.db.update(disks).set(changes).where(eq(disks.id, row.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'storage.disk.update',
			resource: 'disk',
			resourceId: row.id,
			args: { name: row.name, ...input },
			result: 'ok',
		});
		return this.view(this.requireRow(row.id));
	}

	/**
	 * Stop using a disk. Refused while anything is stored on it. A disk Yoal mounted is unmounted
	 * by its node first (the row is `removing` until the node confirms); its files stay.
	 */
	remove(principal: Principal, id: string, opts: { viaShare?: boolean } = {}): { ok: true; unmounting: boolean } {
		this.assertWrite(principal, 'storage:delete');
		const row = this.requireRow(id);
		if (row.status === 'removing') return { ok: true, unmounting: true };
		const share = this.shareOf(row.id);
		if (share && !opts.viaShare)
			throw new ConflictError(`"${row.name}" is the network share "${share}". Unmount it under Settings → Network shares.`);
		const holds = this.holds(row);
		if (holds.length > 0)
			throw new ConflictError(`"${row.name}" still holds ${holds.join(', ')}. Move or delete them first.`);
		const unmounting = row.mountUuid !== null;
		this.ctx.db.transaction(() => {
			if (unmounting)
				this.ctx.db
					.update(disks)
					.set({ status: 'removing', message: null, updatedAt: this.ctx.now() })
					.where(eq(disks.id, row.id))
					.run();
			else this.deleteRow(row.id);
			this.ctx.db
				.update(shareMounts)
				.set({ diskId: null, diskName: null, updatedAt: this.ctx.now() })
				.where(eq(shareMounts.diskId, row.id))
				.run();
		});
		this.ctx.audit.record({
			principal,
			action: 'storage.disk.remove',
			resource: 'disk',
			resourceId: row.id,
			args: { name: row.name, nodeId: row.nodeId, sourceKey: row.sourceKey, unmount: unmounting },
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return { ok: true, unmounting };
	}

	/** What is stored on a disk, as short phrases; empty means it can be removed. */
	holds(row: DiskRow): string[] {
		const out: string[] = [];
		const named = (label: string, items: Array<{ name: string }>) => {
			for (const item of items.map((entry) => entry.name).sort()) out.push(`${label} ${item}`);
		};
		named(
			'database',
			this.ctx.db.select({ name: databases.name }).from(databases).where(eq(databases.diskId, row.id)).all(),
		);
		const replicas = this.ctx.db
			.select({ name: databases.name })
			.from(databaseReplicas)
			.innerJoin(databases, eq(databases.id, databaseReplicas.databaseId))
			.where(eq(databaseReplicas.diskId, row.id))
			.all();
		named('a replica of database', replicas);
		named(
			'object storage',
			this.ctx.db.select({ name: storageInstances.name }).from(storageInstances).where(eq(storageInstances.diskId, row.id)).all(),
		);
		named('queue', this.ctx.db.select({ name: brokers.name }).from(brokers).where(eq(brokers.diskId, row.id)).all());
		named(
			'app volume',
			this.ctx.db.select({ name: appVolumes.name }).from(appVolumes).where(eq(appVolumes.diskId, row.id)).all(),
		);
		for (const kind of ['site-data', 'builds'] as const) {
			const dir = this.nodeDirectory(kind, row.nodeId);
			if (dir?.startsWith(`${row.mountPath}/`)) out.push(kind === 'builds' ? "the node's builds" : "the node's site data");
		}
		return out;
	}

	// ---------------------------------------------------------------- defaults

	/** Set the default target per kind. New services start with it; nothing placed moves. */
	setDefaults(principal: Principal, raw: StorageDefaultsInput): StorageDefaultView[] {
		this.assertWrite(principal, 'storage:update');
		const input = storageDefaultsSchema.parse(raw);
		const now = this.ctx.now();
		this.ctx.db.transaction(() => {
			for (const item of input.defaults)
				this.ctx.db
					.insert(storageDefaults)
					.values({ kind: item.kind, target: item.target, updatedBy: principal.userId, updatedAt: now })
					.onConflictDoUpdate({
						target: storageDefaults.kind,
						set: { target: item.target, updatedBy: principal.userId, updatedAt: now },
					})
					.run();
		});
		this.ctx.audit.record({
			principal,
			action: 'storage.defaults.update',
			resource: 'storage',
			args: { defaults: input.defaults },
			result: 'ok',
		});
		// Node-level kinds (builds, site data) change the D48 directories in desired state.
		this.ctx.nodes.bump();
		return this.defaultViews(this.allRows());
	}

	setOnboarding(principal: Principal, raw: { state: 'done' | 'skipped' }): { onboarding: StorageOnboardingState } {
		this.assertWrite(principal, 'storage:update');
		const input = storageOnboardingSchema.parse(raw);
		const now = this.ctx.now();
		this.ctx.db
			.insert(settings)
			.values({ key: ONBOARDING_KEY, value: input.state, updatedAt: now })
			.onConflictDoUpdate({ target: settings.key, set: { value: input.state, updatedAt: now } })
			.run();
		this.ctx.audit.record({ principal, action: 'storage.onboarding', resource: 'storage', args: input, result: 'ok' });
		return { onboarding: input.state };
	}

	// ---------------------------------------------------------------- placement

	/**
	 * The target for a new resource: `storage` as the creator gave it (`system`, `fast`, `bulk` or a
	 * disk name), else the kind's default, else the system disk. A disk name that exists on several
	 * nodes needs `nodeId` (the node the resource is pinned to).
	 */
	plan(kind: StorageKind, storage?: string | null, nodeId?: string | null): StoragePlan {
		if (!storage) return { kind, target: this.defaultTarget(kind) ?? 'system', disk: null, chosen: false };
		if (storage === 'system' || isTierTarget(storage)) return { kind, target: storage, disk: null, chosen: true };
		const named = this.ctx.db
			.select()
			.from(disks)
			.where(and(eq(disks.name, storage), ne(disks.status, 'removing')))
			.all();
		const rows = named.filter((row) => !nodeId || row.nodeId === nodeId);
		if (rows.length === 0 && named.length > 0)
			throw new ValidationError(`Disk "${storage}" is on another node; place the service there or pick a disk on the target node.`);
		if (rows.length === 0) throw new NotFoundError(`Disk "${storage}"`);
		if (rows.length > 1)
			throw new ValidationError(`Disk "${storage}" exists on more than one node; place the service on the node that owns it.`);
		return { kind, target: 'disk', disk: rows[0]!, chosen: true };
	}

	/**
	 * Narrow placement to the nodes that can hold the resource. A disk target pins its node (and
	 * refuses a different pinned node); a tier keeps nodes with a ready disk of that tier with room.
	 * `requested` is `auto`, `edge` or a node id, as `resolvePlacement` takes it.
	 */
	prepare(input: {
		kind: StorageKind;
		storage?: string | null;
		requested: string;
		storageMb: number;
		edgeNodeId: string | null;
		candidates: PlacementCandidate[];
	}): { plan: StoragePlan; requested: string; candidates: PlacementCandidate[] } {
		const pinnedNode = input.requested === 'auto' ? null : input.requested === 'edge' ? input.edgeNodeId : input.requested;
		const plan = this.plan(input.kind, input.storage, pinnedNode);
		if (plan.target === 'system') return { plan, requested: input.requested, candidates: input.candidates };
		if (plan.target === 'disk') {
			const disk = plan.disk!;
			if (pinnedNode && pinnedNode !== disk.nodeId)
				throw new ValidationError(`Disk "${disk.name}" is on another node; place the service there or pick a disk on the target node.`);
			return { plan, requested: disk.nodeId, candidates: input.candidates };
		}
		const tier = plan.target;
		const reasons: string[] = [];
		const kept = input.candidates.filter((candidate) => {
			const reason = this.tierProblem(tier, candidate.id, input.storageMb);
			if (reason) reasons.push(`${candidate.name}: ${reason}`);
			return reason === null;
		});
		const how = this.describe(plan);
		if (pinnedNode && !kept.some((candidate) => candidate.id === pinnedNode)) {
			const name = input.candidates.find((candidate) => candidate.id === pinnedNode)?.name ?? pinnedNode;
			throw new ConflictError(
				`${name} cannot hold this on ${how}: ${this.tierProblem(tier, pinnedNode, input.storageMb) ?? 'not available'}. Add a ${tier} disk on that node under Settings → Storage, or pick other storage.`,
			);
		}
		if (kept.length === 0)
			throw new ConflictError(
				`No node can hold this on ${how} (${reasons.join('; ') || `there are no ${tier} disks`}). Add a ${tier} disk under Settings → Storage, or pick other storage.`,
			);
		return { plan, requested: input.requested, candidates: kept };
	}

	/**
	 * The disk on `nodeId` the resource goes on, or null for the system disk. Throws when the plan
	 * cannot be met there; it never falls back to another tier.
	 */
	pick(plan: StoragePlan, nodeId: string, storageMb: number): DiskRow | null {
		if (plan.target === 'system') return null;
		if (plan.target === 'disk') {
			const disk = this.byId(plan.disk!.id);
			if (!disk) throw new ConflictError(`Disk "${plan.disk!.name}" no longer exists.`);
			if (disk.nodeId !== nodeId) throw new ConflictError(`Disk "${disk.name}" is on another node.`);
			this.assertRoom(disk, storageMb);
			return disk;
		}
		const best = this.bestDisk(plan.target, nodeId, storageMb, false);
		if (best) return best;
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get();
		throw new ConflictError(
			`${node?.name ?? nodeId} cannot hold this on ${this.describe(plan)}: ${this.tierProblem(plan.target, nodeId, storageMb) ?? 'no usable disk'}.`,
		);
	}

	/** Capacity and status guard for one disk. */
	assertRoom(disk: DiskRow, storageMb: number): void {
		if (disk.status !== 'ready')
			throw new ConflictError(`Disk "${disk.name}" is ${disk.status}${disk.message ? `: ${disk.message}` : ''}.`);
		if (!fits(disk, storageMb))
			throw new ConflictError(
				`Disk "${disk.name}" has ${Math.floor((disk.freeBytes ?? 0) / MB)} MB free; ${storageMb} MB more would leave less than ${DISK_MIN_FREE_PERCENT}% free. Pick another disk or lower the storage budget.`,
			);
	}

	/** Re-check the disk a resource was placed on before it is restored or grown there. */
	assertReady(diskId: string | null, storageMb: number): void {
		if (!diskId) return;
		const row = this.byId(diskId);
		if (!row) throw new ConflictError('The disk this was placed on no longer exists.');
		this.assertRoom(row, storageMb);
	}

	/**
	 * Effective D48 directory for a node-level kind on one node, or null for the install default.
	 * Only local, ready disks count: Caddy serves site data and a build cache on a share is moot.
	 */
	nodeDirectory(kind: 'builds' | 'site-data', nodeId: string): string | null {
		const target = this.defaultTarget(kind);
		if (!target || target === 'system') return null;
		const disk = this.bestDisk(target, nodeId, 0, true);
		return disk ? `${disk.mountPath}/yoal/node/${nodeId}/${kind === 'builds' ? 'builds' : 'agent'}` : null;
	}

	/** Facts for workload placement constraints (`volumeClass`, `volumeId`): tiers plus `remote`. */
	placementFacts(): Map<string, { classes: string[]; ids: string[] }> {
		const facts = new Map<string, { classes: string[]; ids: string[] }>();
		for (const row of this.allRows()) {
			if (row.status === 'removing') continue;
			const fact = facts.get(row.nodeId) ?? { classes: [], ids: [] };
			fact.classes.push(row.tier);
			if (row.remote) fact.classes.push('remote');
			fact.ids.push(row.id);
			facts.set(row.nodeId, fact);
		}
		return facts;
	}

	// ---------------------------------------------------------------- profiling

	/** Benchmark one disk (docs/STORAGE.md §5.1). */
	profile(principal: Principal, id: string): { queued: true } {
		this.assertWrite(principal, 'storage:update');
		this.expireProfiles();
		const row = this.requireRow(id);
		const node = this.requireNode(row.nodeId);
		if (row.status !== 'ready') throw new ConflictError(`Disk "${row.name}" is ${row.status}.`);
		if (!parseJson<string[]>(node.capabilitiesJson, []).includes(VOLUME_PROFILE_CAPABILITY))
			throw new ConflictError(`${node.name} runs an agent that cannot profile disks yet. Update it, then retry.`);
		const busy = this.latestProfile(row.id);
		if (busy && (busy.status === 'queued' || busy.status === 'running'))
			throw new ConflictError(`Disk "${row.name}" is already being profiled.`);
		this.ctx.db
			.insert(diskProfiles)
			.values({
				id: newId('vpr_'),
				diskId: row.id,
				nodeId: row.nodeId,
				status: 'queued',
				sizeMb: volumeProfileLimits.sizeMb,
				runtimeSeconds: volumeProfileLimits.runtimeSeconds,
				requestedBy: principal.userId,
				createdAt: this.ctx.now(),
			})
			.run();
		this.ctx.audit.record({ principal, action: 'storage.profile', resource: 'disk', resourceId: row.id, args: { name: row.name }, result: 'ok' });
		this.ctx.nodes.bump();
		return { queued: true };
	}

	// ---------------------------------------------------------------- node protocol

	/** The disk registry for a node's desired state (`volumes`); the helper verifies against it (D76). */
	desiredForNode(nodeId: string): NodeVolumeDesired[] {
		return this.rowsForNode(nodeId)
			.filter((row) => row.status !== 'removing')
			.map((row) => ({ id: row.id, mountPath: row.mountPath, sourceKey: row.sourceKey, fsType: row.fsType }))
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	/** Disks Yoal mounts on this node (`diskMounts`): the directory name, UUID and filesystem. */
	mountsForNode(nodeId: string): DiskMountDesired[] {
		return this.rowsForNode(nodeId)
			.filter((row) => row.mountUuid && row.status !== 'removing' && (mountableFsTypes as readonly string[]).includes(row.fsType))
			.map((row) => ({
				id: row.id,
				name: mountDirName(row.mountPath),
				fsUuid: row.mountUuid!,
				fsType: row.fsType as DiskMountDesired['fsType'],
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Disks Yoal mounted that are being removed (`diskUnmounts`). */
	unmountsForNode(nodeId: string): DiskUnmountDesired[] {
		return this.rowsForNode(nodeId)
			.filter((row) => row.mountUuid && row.status === 'removing')
			.map((row) => ({ id: row.id, name: mountDirName(row.mountPath) }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	profileTasksForNode(nodeId: string): VolumeProfileTask[] {
		this.expireProfiles();
		return this.ctx.db
			.select()
			.from(diskProfiles)
			.where(and(eq(diskProfiles.nodeId, nodeId), inArray(diskProfiles.status, ['queued', 'running'])))
			.all()
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((row) => ({ id: row.id, volumeId: row.diskId, sizeMb: row.sizeMb, runtimeSeconds: row.runtimeSeconds }));
	}

	/**
	 * Reconcile the heartbeat inventory: refresh capacity and the derived tier, turn a pending Yoal
	 * mount `ready` once its UUID shows at its path, and mark a ready disk `missing` when its mount
	 * disappears or moves (D80). A missing disk fails the next workload start (D76).
	 */
	applyInventory(nodeId: string, raw: unknown): void {
		const parsed = volumeInventorySchema.safeParse(raw);
		if (!parsed.success) return;
		const inventory = parsed.data;
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) return;
		const now = this.ctx.now();
		const bySource = new Map(inventory.mounts.map((mount) => [mount.sourceKey, mount]));
		const byPath = new Map(inventory.mounts.map((mount) => [mount.mountPath, mount]));
		this.ctx.db.transaction(() => {
			this.ctx.db.update(nodes).set({ diskInventoryJson: JSON.stringify(inventory), updatedAt: now }).where(eq(nodes.id, nodeId)).run();
			for (const row of this.rowsForNode(nodeId)) {
				if (row.status === 'removing') continue;
				let mount = bySource.get(row.sourceKey);
				if (!mount && row.mountUuid) {
					// A Yoal mount: the key is final only once findmnt reports it (btrfs adds `#<subvol>`).
					const atPath = byPath.get(row.mountPath);
					if (atPath && (atPath.sourceKey === `fs:${row.mountUuid}` || atPath.sourceKey.startsWith(`fs:${row.mountUuid}#`)))
						mount = atPath;
				}
				if (!mount) {
					// Pending and failed Yoal mounts wait for the node's mount report instead.
					if (row.status === 'pending' || row.status === 'failed') continue;
					if (row.status !== 'missing')
						this.setStatus(row.id, 'missing', 'The node no longer reports this filesystem as mounted.', now);
					continue;
				}
				if (mount.mountPath !== row.mountPath) {
					// A mount that moved is a different thing than what services were placed on.
					this.setStatus(row.id, 'missing', `Mounted at ${mount.mountPath}, but this disk is registered at ${row.mountPath}.`, now);
					continue;
				}
				this.ctx.db
					.update(disks)
					.set({
						status: 'ready',
						message: null,
						sourceKey: mount.sourceKey,
						sizeBytes: mount.sizeBytes,
						freeBytes: mount.freeBytes,
						fsType: mount.fsType,
						...(row.tierSet ? {} : { tier: deriveTier(mount, inventory.devices) }),
						statsAt: now,
						updatedAt: now,
					})
					.where(eq(disks.id, row.id))
					.run();
			}
		});
	}

	/** Heartbeat: mount results for disks Yoal mounts, and unmounts the node finished. */
	applyMountReport(nodeId: string, reports: DiskMountReport[] | undefined, unmounted: string[] | undefined): void {
		const now = this.ctx.now();
		const rows = new Map(this.rowsForNode(nodeId).map((row) => [row.id, row]));
		for (const report of reports ?? []) {
			const row = rows.get(report.id);
			if (!row || !row.mountUuid || row.status === 'removing' || row.status === 'ready') continue;
			if (report.mounted) {
				// The next inventory turns it ready; clear an earlier failure meanwhile.
				if (row.status === 'failed') this.setStatus(row.id, 'pending', null, now);
				continue;
			}
			if (!report.error) continue;
			const message = report.error.slice(0, 1_000);
			if (row.status === 'failed' && row.message === message) continue;
			this.setStatus(row.id, 'failed', message, now);
			this.ctx.audit.record({
				action: 'storage.disk.mount.fail',
				resource: 'disk',
				resourceId: row.id,
				args: { name: row.name, fsUuid: row.mountUuid, error: message },
				result: 'error',
				error: message,
			});
		}
		for (const id of unmounted ?? []) {
			const row = rows.get(id);
			if (row?.status === 'removing') this.deleteRow(row.id);
		}
	}

	/** Heartbeat results: `running` marks progress, a final status stores the numbers once. */
	applyProfileResults(nodeId: string, results: VolumeProfileResult[]): void {
		const now = this.ctx.now();
		for (const result of results) {
			const row = this.ctx.db.select().from(diskProfiles).where(eq(diskProfiles.id, result.taskId)).get();
			if (!row || row.nodeId !== nodeId || row.status === 'succeeded' || row.status === 'failed') continue;
			if (result.status === 'running') {
				if (row.status === 'queued') this.ctx.db.update(diskProfiles).set({ status: 'running' }).where(eq(diskProfiles.id, row.id)).run();
				continue;
			}
			const intOrNull = (value: number | null) => (value === null ? null : Math.round(value));
			this.ctx.db
				.update(diskProfiles)
				.set({
					status: result.status,
					method: result.method,
					seqReadMBps: result.seqReadMBps,
					seqWriteMBps: result.seqWriteMBps,
					randReadIops: intOrNull(result.randReadIops),
					randWriteIops: intOrNull(result.randWriteIops),
					syncWriteIops: intOrNull(result.syncWriteIops),
					syncWriteLatencyUs: intOrNull(result.syncWriteLatencyUs),
					direct: result.direct,
					notesJson: JSON.stringify(result.notes),
					error: result.error,
					finishedAt: now,
				})
				.where(eq(diskProfiles.id, row.id))
				.run();
		}
	}

	/** A deleted node takes its disk rows with it (its services are gone already). */
	forgetNode(nodeId: string): void {
		for (const row of this.rowsForNode(nodeId)) this.deleteRow(row.id);
	}

	// ---------------------------------------------------------------- internals

	private defaultTarget(kind: StorageKind): StorageDefaultTarget | null {
		return this.ctx.db.select().from(storageDefaults).where(eq(storageDefaults.kind, kind)).get()?.target ?? null;
	}

	private describe(plan: StoragePlan): string {
		if (plan.target === 'disk') return `disk "${plan.disk!.name}"`;
		return plan.target === 'system' ? 'the system disk' : `${plan.target} disks${plan.chosen ? '' : ` (the ${storageKindInfo[plan.kind].label.toLowerCase()} default)`}`;
	}

	private tierProblem(tier: StorageTier, nodeId: string, storageMb: number): string | null {
		if (this.bestDisk(tier, nodeId, storageMb, false)) return null;
		const mine = this.rowsForNode(nodeId).filter((row) => row.tier === tier && row.status !== 'removing');
		if (mine.length === 0) return `no ${tier} disk`;
		return mine
			.map((row) =>
				row.status !== 'ready'
					? `${tier} disk ${row.name} is ${row.status}`
					: `${tier} disk ${row.name} would drop below ${DISK_MIN_FREE_PERCENT}% free after ${storageMb} MB`,
			)
			.join(', ');
	}

	private bestDisk(tier: StorageTier, nodeId: string, storageMb: number, localOnly: boolean): DiskRow | null {
		const usable = this.rowsForNode(nodeId)
			.filter((row) => row.tier === tier && row.status === 'ready' && (!localOnly || !row.remote))
			.filter((row) => fits(row, storageMb));
		const free = (row: DiskRow) => row.freeBytes ?? Number.MAX_SAFE_INTEGER;
		usable.sort((a, b) => free(b) - free(a) || a.name.localeCompare(b.name));
		return usable[0] ?? null;
	}

	private defaultViews(rows: DiskRow[]): StorageDefaultView[] {
		const saved = new Map(this.ctx.db.select().from(storageDefaults).all().map((row) => [row.kind, row.target]));
		const ready = rows.filter((row) => row.status === 'ready');
		return storageKinds.map((kind) => {
			const target = saved.get(kind) ?? 'system';
			const label = storageKindInfo[kind].label.toLowerCase();
			const warnings: string[] = [];
			if (isTierTarget(target)) {
				const tierDisks = ready.filter((row) => row.tier === target);
				if (tierDisks.length === 0) warnings.push(`There are no ready ${target} disks, so new ${label} cannot be created until you add one.`);
				else if (nodeStorageKinds.has(kind) && tierDisks.every((row) => row.remote))
					warnings.push(`Every ${target} disk is a network share, which ${label} skips; the system disk is used.`);
				else if (kind === 'databases' && tierDisks.some((row) => row.remote))
					warnings.push(`Some ${target} disks are network shares; databases want local disks.`);
			}
			return {
				kind,
				label: storageKindInfo[kind].label,
				description: storageKindInfo[kind].description,
				target,
				configured: saved.has(kind),
				warnings,
			};
		});
	}

	private nodeView(node: NodeRow, rows: DiskRow[], names: Map<string, string>): StorageNodeView {
		const inventory = parseInventory(node.diskInventoryJson);
		const stats = parseJson<Record<string, unknown> | null>(node.statsJson, null);
		return {
			id: node.id,
			name: node.name,
			status: node.status,
			system: {
				sizeBytes: stats && typeof stats.diskTotalBytes === 'number' ? stats.diskTotalBytes : null,
				freeBytes: nodeDiskFreeBytes(stats),
			},
			disks: rows.sort((a, b) => a.name.localeCompare(b.name)).map((row) => this.view(row, names)),
			candidates: inventory ? diskCandidates({ inventory, disks: rows, canMount: canMount(node) }) : [],
			inventoryReported: inventory !== null,
		};
	}

	private view(row: DiskRow, names?: Map<string, string>): DiskView {
		const nodeName =
			names?.get(row.nodeId) ?? this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, row.nodeId)).get()?.name ?? null;
		return {
			id: row.id,
			name: row.name,
			nodeId: row.nodeId,
			nodeName,
			kind: row.kind,
			sourceKey: row.sourceKey,
			mountPath: row.mountPath,
			fsType: row.fsType,
			remote: row.remote,
			tier: row.tier,
			tierSet: row.tierSet,
			mountedByYoal: row.mountUuid !== null,
			share: this.shareOf(row.id),
			status: row.status,
			message: row.message,
			sizeBytes: row.sizeBytes,
			freeBytes: row.freeBytes,
			statsAt: isoOrNull(row.statsAt),
			holds: this.holds(row),
			profile: this.latestProfile(row.id),
			createdAt: isoOrEpoch(row.createdAt),
			updatedAt: isoOrEpoch(row.updatedAt),
		};
	}

	private shareOf(diskId: string): string | null {
		return (
			this.ctx.db
				.select({ name: shares.name })
				.from(shareMounts)
				.innerJoin(shares, eq(shares.id, shareMounts.shareId))
				.where(eq(shareMounts.diskId, diskId))
				.get()?.name ?? null
		);
	}

	private insert(values: Omit<typeof disks.$inferInsert, 'id' | 'createdAt' | 'updatedAt' | 'statsAt' | 'message'>): DiskRow {
		const now = this.ctx.now();
		const id = newId(DISK_ID_PREFIX);
		this.ctx.db
			.insert(disks)
			.values({ ...values, id, message: null, statsAt: values.status === 'ready' ? now : null, createdAt: now, updatedAt: now })
			.run();
		return this.requireRow(id);
	}

	private deleteRow(id: string): void {
		this.ctx.db.delete(disks).where(eq(disks.id, id)).run();
		this.ctx.db.delete(diskProfiles).where(eq(diskProfiles.diskId, id)).run();
	}

	private setStatus(id: string, status: DiskRow['status'], message: string | null, now: number): void {
		this.ctx.db.update(disks).set({ status, message, updatedAt: now }).where(eq(disks.id, id)).run();
	}

	private assertNameFree(node: NodeRow, name: string): void {
		if (this.rowsForNode(node.id).some((row) => row.name === name))
			throw new ConflictError(`A disk named "${name}" already exists on ${node.name}. Pick another name.`);
	}

	private freeName(nodeId: string, base: string): string {
		const taken = new Set(this.rowsForNode(nodeId).map((row) => row.name));
		if (!taken.has(base)) return base;
		for (let n = 2; n < 100; n += 1) {
			const name = `${base.slice(0, 36)}-${n}`;
			if (!taken.has(name)) return name;
		}
		return base;
	}

	private allRows(): DiskRow[] {
		return this.ctx.db.select().from(disks).all();
	}

	private rowsForNode(nodeId: string): DiskRow[] {
		return this.ctx.db.select().from(disks).where(eq(disks.nodeId, nodeId)).all();
	}

	private requireRow(id: string): DiskRow {
		const row = this.byId(id);
		if (!row) throw new NotFoundError('Disk');
		return row;
	}

	private requireNode(idOrName: string): NodeRow {
		const node =
			this.ctx.db.select().from(nodes).where(eq(nodes.id, idOrName)).get() ??
			this.ctx.db.select().from(nodes).where(eq(nodes.name, idOrName)).get();
		if (!node) throw new NotFoundError(`Node ${idOrName}`);
		return node;
	}

	/** Fail benchmarks no node finished in time, so a lost task never blocks the next one. */
	private expireProfiles(): void {
		const cutoff = this.ctx.now() - volumeProfileLimits.timeoutMs;
		this.ctx.db
			.update(diskProfiles)
			.set({ status: 'failed', error: 'The node did not finish the profile in time.', finishedAt: this.ctx.now() })
			.where(and(inArray(diskProfiles.status, ['queued', 'running']), lt(diskProfiles.createdAt, cutoff), isNull(diskProfiles.finishedAt)))
			.run();
	}

	private assertRead(principal: Principal): void {
		// Platform IAM (I24/D129): the engine at platform scope, with the pre-I8 platform admin
		// as the fallback until bindings are seeded. An org `storage:read` at platform scope is
		// kept so the existing platform-wide storage grants continue to work.
		if (this.ctx.platformIam.allows(principal, 'platform:read')) return;
		this.ctx.iam.require(principal, 'storage:read', { type: 'platform' });
	}

	private assertWrite(
		principal: Principal,
		permission: 'storage:create' | 'storage:update' | 'storage:delete' = 'storage:update',
	): void {
		if (this.ctx.platformIam.allows(principal, 'platform:storage')) return;
		this.ctx.iam.require(principal, permission, { type: 'platform' });
	}
}

// ------------------------------------------------------------------ pure helpers

function parseInventory(json: string | null): VolumeInventory | null {
	if (!json) return null;
	const parsed = volumeInventorySchema.safeParse(parseJson(json, null));
	return parsed.success ? parsed.data : null;
}

/** ISO for a stored timestamp; a malformed value must not take the whole page down. */
function isoOrNull(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	const date = new Date(value as string | number | Date);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoOrEpoch(value: unknown): string {
	return isoOrNull(value) ?? new Date(0).toISOString();
}

/** `notes_json` is written as a string array, but an import or older row may hold anything. */
function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function canMount(node: NodeRow): boolean {
	return parseJson<string[]>(node.capabilitiesJson, []).includes(DISK_MOUNT_CAPABILITY);
}

function mountDirName(mountPath: string): string {
	return mountPath.split('/').filter(Boolean).at(-1) ?? mountPath;
}

/** Room for `storageMb` while keeping DISK_MIN_FREE_PERCENT of the disk free. Unknown capacity fits. */
function fits(disk: Pick<DiskRow, 'freeBytes' | 'sizeBytes'>, storageMb: number): boolean {
	if (disk.freeBytes === null) return true;
	const after = disk.freeBytes - storageMb * MB;
	const floor = disk.sizeBytes ? (disk.sizeBytes * DISK_MIN_FREE_PERCENT) / 100 : 0;
	return after >= floor;
}

/**
 * The tier the hardware suggests: network shares and spinning disks are bulk, SSD/NVMe fast. An
 * unknown device (older helpers do not report ROTA) is fast only when it is NVMe.
 */
export function deriveTier(
	mount: Pick<VolumeInventoryEntry, 'remote' | 'kind' | 'device' | 'sourceKey' | 'rotational'>,
	devices: VolumeDevice[] = [],
): StorageTier {
	if (mount.remote || isRemoteVolumeKind(mount.kind)) return 'bulk';
	const rotational = mount.rotational ?? devices.find((device) => device.name === mount.device)?.rotational ?? null;
	if (rotational !== null) return rotational ? 'bulk' : 'fast';
	return /nvme/i.test(mount.device ?? '') ? 'fast' : 'bulk';
}

function deviceTier(device: VolumeDevice, parent: VolumeDevice | undefined): StorageTier {
	const rotational = device.rotational ?? parent?.rotational ?? null;
	if (rotational !== null) return rotational ? 'bulk' : 'fast';
	return /nvme/i.test(device.name) ? 'fast' : 'bulk';
}

const MEMBER_FS: Record<string, string> = {
	lvm2_member: 'LVM physical volume; its logical volumes are listed on their own.',
	linux_raid_member: 'RAID member; the assembled array is listed on its own.',
	crypto_luks: 'Encrypted (LUKS) container; unlock it on the node and the opened device is listed on its own.',
	zfs_member: 'ZFS pool member; mounted datasets are listed on their own.',
	bcache: 'bcache backing device.',
	swap: 'Swap space.',
};

const SYSTEM_PATHS = ['/', '/boot', '/boot/efi', '/efi', '/home', '/var', '/usr', '/opt', '/srv', '/tmp'];

function slugName(raw: string): string {
	const base = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/g, '');
	const name = base.length >= 3 ? base : `disk-${base || '1'}`.slice(0, 40);
	return name === 'system' || name === 'fast' || name === 'bulk' ? `${name}-disk` : name;
}

/**
 * What a node could use as a disk, plus every device it reports that it cannot (with the reason).
 * Already-registered disks are left out. Usable candidates come first.
 */
export function diskCandidates(input: {
	inventory: VolumeInventory;
	disks: Array<Pick<DiskRow, 'sourceKey' | 'mountPath' | 'mountUuid'>>;
	canMount: boolean;
}): DiskCandidateView[] {
	const { inventory } = input;
	const takenSources = new Set(input.disks.map((disk) => disk.sourceKey));
	const takenPaths = new Set(input.disks.map((disk) => disk.mountPath));
	const takenUuids = new Set(input.disks.map((disk) => disk.mountUuid?.toLowerCase()).filter(Boolean));
	const byName = new Map(inventory.devices.map((device) => [device.name.replace(/^\/dev\//, ''), device]));
	const mountPaths = new Set(inventory.mounts.map((mount) => mount.mountPath));
	const out: DiskCandidateView[] = [];

	// Mounted filesystems at usable paths (local disks, assembled arrays, ZFS datasets).
	for (const mount of inventory.mounts) {
		if (takenSources.has(mount.sourceKey) || takenPaths.has(mount.mountPath)) continue;
		// Share mounts belong to Settings → Network shares, which turns them into disks itself.
		if (mount.mountPath.startsWith(`${SHARE_MOUNT_ROOT}/`)) continue;
		const device = mount.device ? byName.get(mount.device.replace(/^\/dev\//, '')) : undefined;
		const fs = mount.fsType.toLowerCase();
		const usable = mount.remote || isMountableFsType(fs) || fs === 'zfs';
		out.push({
			key: `mount:${mount.sourceKey}`,
			usable,
			reason: usable ? null : `${mount.fsType} has no Unix ownership and permissions; managed data needs ${mountableFsTypes.join(', ')} or ZFS.`,
			device: mount.device ?? mount.sourceKey,
			model: device?.model ?? (device?.parent ? (byName.get(device.parent)?.model ?? null) : null),
			fsType: mount.fsType,
			label: mount.label,
			mountPath: mount.mountPath,
			sizeBytes: mount.sizeBytes,
			freeBytes: mount.freeBytes,
			remote: mount.remote,
			needsMount: false,
			suggestedName: slugName(mount.label ?? mount.mountPath.split('/').filter(Boolean).at(-1) ?? 'data'),
			suggestedTier: deriveTier(mount, inventory.devices),
		});
	}

	// Block devices: unmounted filesystems Yoal can mount, and everything it cannot use.
	const seen = new Set<string>();
	for (const device of inventory.devices) {
		if (seen.has(device.name)) continue;
		seen.add(device.name);
		if (/^\/dev\/(zram|loop|ram)\d/.test(device.name)) continue;
		const isDisk = device.type === 'disk' || device.type === null;
		// A disk with partitions is not a row; its partitions are.
		if (isDisk && device.holders.length > 0 && !device.fsType) continue;
		if (device.uuid && takenUuids.has(device.uuid.toLowerCase())) continue;
		// Mounted ones are either listed above (usable path) or part of the OS.
		if (device.mountPath && device.mountPath !== '[SWAP]' && mountPaths.has(device.mountPath)) continue;
		if (device.mountPath && takenPaths.has(device.mountPath)) continue;
		const parent = device.parent ? byName.get(device.parent) : undefined;
		const fs = device.fsType?.toLowerCase() ?? null;
		let reason: string | null = null;
		if (device.mountPath === '[SWAP]' || fs === 'swap') reason = MEMBER_FS.swap!;
		else if (device.mountPath)
			reason =
				SYSTEM_PATHS.includes(device.mountPath) || device.mountPath.startsWith('/boot')
					? `Mounted at ${device.mountPath}; part of the operating system.`
					: `Mounted at ${device.mountPath}, which cannot hold managed data. Mount it under /mnt instead, or unmount it and Yoal will mount it.`;
		else if (fs && MEMBER_FS[fs]) reason = MEMBER_FS[fs]!;
		else if (device.holders.length > 0) reason = `Holds ${device.holders.join(', ')}.`;
		else if (!fs) reason = 'No filesystem. Yoal does not format disks; create one on the node (e.g. mkfs.ext4) and it appears here.';
		else if (!isMountableFsType(fs)) reason = `${device.fsType} has no Unix ownership and permissions; managed data needs ${mountableFsTypes.join(', ')}.`;
		else if (!device.uuid) reason = 'The filesystem has no UUID, so it cannot be found reliably after a reboot.';
		else if (!input.canMount) reason = "This node's agent cannot mount disks yet. Update the node, or mount it yourself under /mnt.";
		out.push({
			key: device.uuid ? `uuid:${device.uuid}` : `device:${device.name}`,
			usable: reason === null,
			reason,
			device: device.name,
			model: device.model ?? parent?.model ?? null,
			fsType: device.fsType,
			label: device.label,
			mountPath: device.mountPath,
			sizeBytes: device.sizeBytes,
			freeBytes: null,
			remote: false,
			needsMount: reason === null,
			suggestedName: slugName(device.label ?? device.name.split('/').at(-1) ?? 'disk'),
			suggestedTier: deviceTier(device, parent),
		});
	}
	return out.sort(
		(a, b) => Number(b.usable) - Number(a.usable) || a.device.localeCompare(b.device, undefined, { numeric: true }),
	);
}

