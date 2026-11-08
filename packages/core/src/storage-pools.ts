import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { nodeVolumes, nodes, settings, storagePools, storageRules, volumeProfiles } from '@skiff/db';
import {
	SYSTEM_POOL,
	VOLUME_PROFILE_CAPABILITY,
	canAdministerPlatform,
	canViewPlatform,
	nodeStorageKinds,
	storageKindInfo,
	storageKinds,
	storageOnboardingSchema,
	storagePoolCreateSchema,
	storagePoolUpdateSchema,
	storageDefaultsSchema,
	volumeInventorySchema,
	volumeProfileLimits,
	type Principal,
	type StorageChoices,
	type StorageKind,
	type StorageNodeView,
	type StorageOnboardingState,
	type StorageOverview,
	type StoragePoolCreate,
	type StoragePoolUpdate,
	type StoragePoolView,
	type StorageDefaultView,
	type StorageDefaultsInput,
	type VolumeClass,
	type VolumeProfileResult,
	type VolumeProfileTask,
	type VolumeProfileView,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import type { PlacementCandidate } from './placement.ts';
import { nodeDiskFreeBytes } from './app-volumes.ts';
import type { VolumeRow } from './volumes.ts';
import { newId, parseJson } from './util.ts';

type PoolRow = typeof storagePools.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;

const MB = 1024 * 1024;
const ONBOARDING_KEY = 'storage.onboarding';

/** A pool a plan can draw from: a real pool, or the system disk. */
interface PoolRef {
	id: string | null;
	name: string;
	allocation: 'most-free' | 'fill-up';
	minFreePercent: number;
}

const SYSTEM_REF: PoolRef = { id: null, name: SYSTEM_POOL, allocation: 'most-free', minFreePercent: 0 };

/**
 * The pool a new resource goes on (docs/STORAGE.md §3.2): the one its creator picked, else the
 * kind's default from Settings → Storage. `legacy` means neither exists: the node's default volume,
 * else the system disk — the behaviour before pools existed.
 */
export interface StoragePlan {
	kind: StorageKind;
	pool: PoolRef;
	legacy: boolean;
}

/**
 * Storage pools and default storage (docs/STORAGE.md, D144).
 *
 * Operators group node volumes into named pools (`ssd`, `hdd`, `nas`). Where a service's data
 * lives is chosen when it is created; Settings → Storage sets the default pool each kind starts
 * with. Every create path asks `plan()` → `filterCandidates()` → `pick()`. Skiff never swaps in a
 * different pool on its own — a pool that cannot hold the resource is a refusal — and nothing
 * already placed moves. Within the chosen pool, the volume is picked by the pool's allocation.
 */
export class StoragePoolService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	overview(principal: Principal): StorageOverview {
		this.assertRead(principal);
		this.expireProfiles();
		const pools = this.poolViews();
		return {
			onboarding: this.onboardingState(),
			pools,
			defaults: this.defaultViews(pools),
			nodes: this.nodeViews(),
		};
	}

	/**
	 * What a create form may offer for `kind`: pool names, descriptions and classes, and which one
	 * Settings → Storage preselects. Safe for any signed-in user (no nodes, paths or capacity).
	 */
	choices(kind: StorageKind): StorageChoices {
		const plan = this.plan(kind);
		const pools = this.ctx.db
			.select()
			.from(storagePools)
			.all()
			.map((row) => {
				const classes = [...new Set(this.members(row.id).map((member) => (member.classOverride ?? member.class) as VolumeClass))].sort();
				return { name: row.name, description: row.description, classes, empty: classes.length === 0 };
			})
			.filter((pool) => !pool.empty)
			.sort((a, b) => a.name.localeCompare(b.name));
		return {
			kind,
			defaultPool: plan.legacy ? null : plan.pool.name,
			pools: [{ name: SYSTEM_POOL, description: 'Each node\'s system disk', classes: [], empty: false }, ...pools],
		};
	}

	onboardingState(): StorageOnboardingState {
		const row = this.ctx.db.select().from(settings).where(eq(settings.key, ONBOARDING_KEY)).get();
		return row?.value === 'done' || row?.value === 'skipped' ? row.value : 'pending';
	}

	/** Name of the pool a volume belongs to, or `system` for the system disk (null volume). */
	poolNameOfVolume(volumeId: string | null): string | null {
		if (!volumeId) return SYSTEM_POOL;
		const volume = this.ctx.volumes.byId(volumeId);
		if (!volume?.poolId) return null;
		return this.ctx.db.select({ name: storagePools.name }).from(storagePools).where(eq(storagePools.id, volume.poolId)).get()?.name ?? null;
	}

	// ---------------------------------------------------------------- pools

	createPool(principal: Principal, raw: StoragePoolCreate): StoragePoolView {
		this.assertWrite(principal);
		const input = storagePoolCreateSchema.parse(raw);
		if (this.poolByName(input.name)) throw new ConflictError(`Pool "${input.name}" already exists.`);
		const now = this.ctx.now();
		const id = newId('pool_');
		this.ctx.db.transaction(() => {
			this.ctx.db
				.insert(storagePools)
				.values({
					id,
					name: input.name,
					description: input.description,
					allocation: input.allocation,
					minFreePercent: input.minFreePercent,
					createdBy: principal.userId,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			for (const volumeId of input.volumes) this.assignVolume(volumeId, id, now);
		});
		this.ctx.audit.record({
			principal,
			action: 'storage.pool.create',
			resource: 'storage_pool',
			resourceId: id,
			args: { name: input.name, allocation: input.allocation, minFreePercent: input.minFreePercent, volumes: input.volumes },
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return this.poolView(this.requirePool(input.name));
	}

	updatePool(principal: Principal, name: string, raw: StoragePoolUpdate): StoragePoolView {
		this.assertWrite(principal);
		const input = storagePoolUpdateSchema.parse(raw);
		const row = this.requirePool(name);
		if (input.name && input.name !== row.name && this.poolByName(input.name))
			throw new ConflictError(`Pool "${input.name}" already exists.`);
		this.ctx.db
			.update(storagePools)
			.set({ ...input, updatedAt: this.ctx.now() })
			.where(eq(storagePools.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'storage.pool.update',
			resource: 'storage_pool',
			resourceId: row.id,
			args: { name, ...input },
			result: 'ok',
		});
		return this.poolView(this.requirePool(input.name ?? name));
	}

	/** Delete a pool. Refused while it is a default; its volumes become unassigned, data untouched. */
	deletePool(principal: Principal, name: string): { ok: true } {
		this.assertWrite(principal);
		const row = this.requirePool(name);
		const usedBy = this.kindsUsing(row.id);
		if (usedBy.length > 0)
			throw new ConflictError(
				`Pool "${name}" is used by the ${usedBy.map((kind) => storageKindInfo[kind].label.toLowerCase()).join(', ')} default. Pick another default first.`,
			);
		const now = this.ctx.now();
		this.ctx.db.transaction(() => {
			this.ctx.db.update(nodeVolumes).set({ poolId: null, updatedAt: now }).where(eq(nodeVolumes.poolId, row.id)).run();
			this.ctx.db.delete(storagePools).where(eq(storagePools.id, row.id)).run();
		});
		this.ctx.audit.record({
			principal,
			action: 'storage.pool.delete',
			resource: 'storage_pool',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return { ok: true };
	}

	/** Put a volume in a pool (or take it out with null). Placed data stays where it is. */
	setVolumePool(principal: Principal, volumeId: string, poolName: string | null): StoragePoolView | null {
		this.assertWrite(principal);
		const volume = this.ctx.volumes.byId(volumeId);
		if (!volume) throw new NotFoundError('Volume');
		const pool = poolName && poolName !== SYSTEM_POOL ? this.requirePool(poolName) : null;
		if (poolName === SYSTEM_POOL)
			throw new ValidationError('The system pool is each node\'s system disk; a volume cannot join it.');
		this.assignVolume(volumeId, pool?.id ?? null, this.ctx.now());
		this.ctx.audit.record({
			principal,
			action: 'storage.volume.pool',
			resource: 'volume',
			resourceId: volumeId,
			args: { volume: volume.name, nodeId: volume.nodeId, pool: pool?.name ?? null },
			result: 'ok',
		});
		this.ctx.nodes.bump();
		return pool ? this.poolView(pool) : null;
	}

	// ---------------------------------------------------------------- defaults

	/** Set the default pool per kind. New services start with it; nothing placed moves. */
	setDefaults(principal: Principal, raw: StorageDefaultsInput): StorageDefaultView[] {
		this.assertWrite(principal);
		const input = storageDefaultsSchema.parse(raw);
		const now = this.ctx.now();
		const resolved = input.defaults.map((item) => ({ kind: item.kind, poolId: this.refByName(item.pool).id }));
		this.ctx.db.transaction(() => {
			for (const item of resolved)
				this.ctx.db
					.insert(storageRules)
					.values({ ...item, overflowPoolId: null, updatedBy: principal.userId, updatedAt: now })
					.onConflictDoUpdate({
						target: storageRules.kind,
						set: { poolId: item.poolId, overflowPoolId: null, updatedBy: principal.userId, updatedAt: now },
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
		return this.defaultViews(this.poolViews());
	}

	setOnboarding(principal: Principal, raw: { state: 'done' | 'skipped' }): { onboarding: StorageOnboardingState } {
		this.assertWrite(principal);
		const input = storageOnboardingSchema.parse(raw);
		const now = this.ctx.now();
		this.ctx.db
			.insert(settings)
			.values({ key: ONBOARDING_KEY, value: input.state, updatedAt: now })
			.onConflictDoUpdate({ target: settings.key, set: { value: input.state, updatedAt: now } })
			.run();
		this.ctx.audit.record({
			principal,
			action: 'storage.onboarding',
			resource: 'storage',
			args: input,
			result: 'ok',
		});
		return { onboarding: input.state };
	}

	// ---------------------------------------------------------------- resolution

	/** The pool a new resource of `kind` goes on: `pool` as the creator chose it, else the kind's default. */
	plan(kind: StorageKind, pool?: string | null): StoragePlan {
		if (pool) return { kind, pool: this.refByName(pool), legacy: false };
		const row = this.ctx.db.select().from(storageRules).where(eq(storageRules.kind, kind)).get();
		if (!row) return { kind, pool: SYSTEM_REF, legacy: true };
		return { kind, pool: (row.poolId ? this.refById(row.poolId) : SYSTEM_REF) ?? SYSTEM_REF, legacy: false };
	}

	/**
	 * Keep only nodes that can hold the resource under `plan`. A pinned request (`edge` or a node
	 * id) on a node that cannot is refused here with the pool's reason, not as "no capacity".
	 */
	filterCandidates(
		plan: StoragePlan,
		candidates: PlacementCandidate[],
		storageMb: number,
		pinned: { requested: string; edgeNodeId: string | null } | null = null,
	): PlacementCandidate[] {
		if (plan.legacy || plan.pool.id === null) return candidates;
		const reasons: string[] = [];
		const kept = candidates.filter((candidate) => {
			const reason = this.ineligibility(plan, candidate.id, storageMb);
			if (reason) reasons.push(`${candidate.name}: ${reason}`);
			return reason === null;
		});
		const target = pinned
			? pinned.requested === 'edge'
				? pinned.edgeNodeId
				: pinned.requested === 'auto'
					? null
					: pinned.requested
			: null;
		if (target && !kept.some((candidate) => candidate.id === target)) {
			const name = candidates.find((candidate) => candidate.id === target)?.name ?? target;
			throw new ConflictError(
				`${name} cannot hold this under ${this.describe(plan)}: ${this.ineligibility(plan, target, storageMb) ?? 'not available'}. Add a volume on that node to the pool, or pick another storage pool.`,
			);
		}
		if (kept.length === 0)
			throw new ConflictError(
				`No node can hold this under ${this.describe(plan)} (${reasons.join('; ') || 'the pool has no volumes'}). Add volumes to the pool under Settings → Storage.`,
			);
		return kept;
	}

	/**
	 * The volume on `nodeId` the resource goes on, or null for the system disk. Throws when the
	 * chosen pool has no usable member there; it never falls back to another pool.
	 */
	pick(plan: StoragePlan, nodeId: string, storageMb: number): VolumeRow | null {
		if (plan.legacy) return this.ctx.volumes.defaultFor(nodeId);
		if (plan.pool.id === null) return null;
		const member = this.bestMember(plan.pool, nodeId, storageMb, false);
		if (member) return member;
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get();
		throw new ConflictError(
			`${node?.name ?? nodeId} cannot hold this under ${this.describe(plan)}: ${this.ineligibility(plan, nodeId, storageMb) ?? 'no usable volume'}.`,
		);
	}

	/**
	 * Effective D48 directory for a node-level kind on one node, or null for the install default.
	 * Only local, ready members count: Caddy serves site data and a build cache on a share is moot.
	 */
	nodeDirectory(kind: 'builds' | 'site-data', nodeId: string): string | null {
		const plan = this.plan(kind);
		if (plan.legacy || plan.pool.id === null) return null;
		const member = this.bestMember(plan.pool, nodeId, 0, true);
		return member ? `${member.mountPath}/skiff/node/${nodeId}/${kind === 'builds' ? 'builds' : 'agent'}` : null;
	}

	// ---------------------------------------------------------------- profiling

	/**
	 * Benchmark every ready member of a pool (docs/STORAGE.md §5). Each node runs its volumes one
	 * at a time; members on nodes whose agent cannot profile, or already being profiled, are skipped.
	 */
	profilePool(principal: Principal, name: string): { queued: string[]; skipped: Array<{ volume: string; reason: string }> } {
		this.assertWrite(principal);
		const pool = this.requirePool(name);
		const result = this.queueProfiles(principal, this.members(pool.id));
		if (result.queued.length === 0)
			throw new ConflictError(
				`Nothing in pool "${name}" can be profiled right now${result.skipped.length ? `: ${result.skipped.map((item) => `${item.volume} ${item.reason}`).join('; ')}` : ' (it has no volumes)'}.`,
			);
		return result;
	}

	/** Benchmark one volume (a linked network share is one too). */
	profileVolume(principal: Principal, volumeId: string): { queued: string[]; skipped: Array<{ volume: string; reason: string }> } {
		this.assertWrite(principal);
		const volume = this.ctx.volumes.byId(volumeId);
		if (!volume) throw new NotFoundError('Volume');
		const result = this.queueProfiles(principal, [volume]);
		if (result.queued.length === 0) throw new ConflictError(`Volume "${volume.name}" ${result.skipped[0]?.reason ?? 'cannot be profiled'}.`);
		return result;
	}

	/** Queued and running benchmarks for a node's desired state. */
	profileTasksForNode(nodeId: string): VolumeProfileTask[] {
		this.expireProfiles();
		return this.ctx.db
			.select()
			.from(volumeProfiles)
			.where(and(eq(volumeProfiles.nodeId, nodeId), inArray(volumeProfiles.status, ['queued', 'running'])))
			.all()
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((row) => ({ id: row.id, volumeId: row.volumeId, sizeMb: row.sizeMb, runtimeSeconds: row.runtimeSeconds }));
	}

	/** Heartbeat results: `running` marks progress, a final status stores the numbers once. */
	applyProfileResults(nodeId: string, results: VolumeProfileResult[]): void {
		const now = this.ctx.now();
		for (const result of results) {
			const row = this.ctx.db.select().from(volumeProfiles).where(eq(volumeProfiles.id, result.taskId)).get();
			if (!row || row.nodeId !== nodeId || row.status === 'succeeded' || row.status === 'failed') continue;
			if (result.status === 'running') {
				if (row.status === 'queued')
					this.ctx.db.update(volumeProfiles).set({ status: 'running' }).where(eq(volumeProfiles.id, row.id)).run();
				continue;
			}
			const intOrNull = (value: number | null) => (value === null ? null : Math.round(value));
			this.ctx.db
				.update(volumeProfiles)
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
				.where(eq(volumeProfiles.id, row.id))
				.run();
		}
	}

	private queueProfiles(principal: Principal, volumes: VolumeRow[]): { queued: string[]; skipped: Array<{ volume: string; reason: string }> } {
		this.expireProfiles();
		const capable = new Set(
			this.ctx.db
				.select({ id: nodes.id, capabilitiesJson: nodes.capabilitiesJson })
				.from(nodes)
				.all()
				.filter((node) => parseJson<string[]>(node.capabilitiesJson, []).includes(VOLUME_PROFILE_CAPABILITY))
				.map((node) => node.id),
		);
		const queued: string[] = [];
		const skipped: Array<{ volume: string; reason: string }> = [];
		const now = this.ctx.now();
		for (const volume of volumes) {
			const busy = this.latestProfile(volume.id);
			if (volume.status !== 'ready') skipped.push({ volume: volume.name, reason: `is ${volume.status}` });
			else if (!capable.has(volume.nodeId)) skipped.push({ volume: volume.name, reason: 'is on a node whose agent cannot profile yet; update it' });
			else if (busy && (busy.status === 'queued' || busy.status === 'running')) skipped.push({ volume: volume.name, reason: 'is already being profiled' });
			else {
				const id = newId('vpr_');
				this.ctx.db
					.insert(volumeProfiles)
					.values({
						id,
						volumeId: volume.id,
						nodeId: volume.nodeId,
						status: 'queued',
						sizeMb: volumeProfileLimits.sizeMb,
						runtimeSeconds: volumeProfileLimits.runtimeSeconds,
						requestedBy: principal.userId,
						createdAt: now,
					})
					.run();
				queued.push(volume.name);
			}
		}
		if (queued.length) {
			this.ctx.audit.record({
				principal,
				action: 'storage.profile',
				resource: 'storage',
				args: { volumes: queued, skipped: skipped.map((item) => item.volume) },
				result: 'ok',
			});
			this.ctx.nodes.bump();
		}
		return { queued, skipped };
	}

	/** Fail benchmarks no node finished in time, so a lost task never blocks the next one. */
	private expireProfiles(): void {
		const cutoff = this.ctx.now() - volumeProfileLimits.timeoutMs;
		this.ctx.db
			.update(volumeProfiles)
			.set({ status: 'failed', error: 'The node did not finish the profile in time.', finishedAt: this.ctx.now() })
			.where(and(inArray(volumeProfiles.status, ['queued', 'running']), lt(volumeProfiles.createdAt, cutoff)))
			.run();
	}

	/** Latest benchmark of a volume, or null; shown wherever the volume is (shares, pools). */
	latestProfile(volumeId: string): VolumeProfileView | null {
		const row = this.ctx.db
			.select()
			.from(volumeProfiles)
			.where(eq(volumeProfiles.volumeId, volumeId))
			.orderBy(desc(volumeProfiles.createdAt))
			.limit(1)
			.get();
		if (!row) return null;
		return {
			id: row.id,
			volumeId: row.volumeId,
			status: row.status,
			method: row.method,
			seqReadMBps: row.seqReadMBps,
			seqWriteMBps: row.seqWriteMBps,
			randReadIops: row.randReadIops,
			randWriteIops: row.randWriteIops,
			syncWriteIops: row.syncWriteIops,
			syncWriteLatencyUs: row.syncWriteLatencyUs,
			direct: row.direct,
			notes: parseJson<string[]>(row.notesJson, []),
			error: row.error,
			createdAt: new Date(row.createdAt).toISOString(),
			finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
		};
	}

	// ---------------------------------------------------------------- internals

	private ineligibility(plan: StoragePlan, nodeId: string, storageMb: number): string | null {
		if (plan.pool.id === null || this.bestMember(plan.pool, nodeId, storageMb, false)) return null;
		return this.memberProblem(plan.pool, nodeId, storageMb);
	}

	private memberProblem(pool: PoolRef, nodeId: string, storageMb: number): string {
		const members = this.members(pool.id!).filter((member) => member.nodeId === nodeId);
		if (members.length === 0) return `no ${pool.name} volume`;
		return members
			.map((member) => {
				if (member.status !== 'ready') return `${pool.name} volume ${member.name} is ${member.status}`;
				return `${pool.name} volume ${member.name} would drop below ${pool.minFreePercent}% free after ${storageMb} MB`;
			})
			.join(', ');
	}

	private bestMember(pool: PoolRef, nodeId: string, storageMb: number, localOnly: boolean): VolumeRow | null {
		const usable = this.members(pool.id!)
			.filter((member) => member.nodeId === nodeId && member.status === 'ready' && (!localOnly || !member.remote))
			.filter((member) => fits(member, storageMb, pool.minFreePercent));
		if (usable.length === 0) return null;
		const free = (member: VolumeRow) => member.freeBytes ?? Number.MAX_SAFE_INTEGER;
		usable.sort((a, b) =>
			pool.allocation === 'fill-up' ? free(a) - free(b) || a.name.localeCompare(b.name) : free(b) - free(a) || a.name.localeCompare(b.name),
		);
		return usable[0]!;
	}

	private members(poolId: string): VolumeRow[] {
		return this.ctx.db.select().from(nodeVolumes).where(eq(nodeVolumes.poolId, poolId)).all();
	}

	private describe(plan: StoragePlan): string {
		return `storage pool "${plan.pool.name}"`;
	}

	private assignVolume(volumeId: string, poolId: string | null, now: number): void {
		const volume = this.ctx.volumes.byId(volumeId);
		if (!volume) throw new NotFoundError(`Volume ${volumeId}`);
		this.ctx.db.update(nodeVolumes).set({ poolId, updatedAt: now }).where(eq(nodeVolumes.id, volumeId)).run();
	}

	private kindsUsing(poolId: string): StorageKind[] {
		return this.ctx.db
			.select()
			.from(storageRules)
			.all()
			.filter((rule) => rule.poolId === poolId)
			.map((rule) => rule.kind as StorageKind)
			.filter((kind) => (storageKinds as readonly string[]).includes(kind));
	}

	private poolByName(name: string): PoolRow | null {
		return this.ctx.db.select().from(storagePools).where(eq(storagePools.name, name)).get() ?? null;
	}

	private requirePool(name: string): PoolRow {
		const row = this.poolByName(name);
		if (!row) throw new NotFoundError(`Storage pool "${name}"`);
		return row;
	}

	private refByName(name: string): PoolRef {
		if (name === SYSTEM_POOL) return SYSTEM_REF;
		return toRef(this.requirePool(name));
	}

	private refById(id: string): PoolRef | null {
		const row = this.ctx.db.select().from(storagePools).where(eq(storagePools.id, id)).get();
		return row ? toRef(row) : null;
	}

	private poolViews(): StoragePoolView[] {
		return this.ctx.db
			.select()
			.from(storagePools)
			.all()
			.map((row) => this.poolView(row))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private poolView(row: PoolRow): StoragePoolView {
		const names = this.nodeNames();
		const members = this.members(row.id)
			.map((volume) => ({
				volumeId: volume.id,
				volumeName: volume.name,
				nodeId: volume.nodeId,
				nodeName: names.get(volume.nodeId) ?? null,
				kind: volume.kind,
				class: (volume.classOverride ?? volume.class) as VolumeClass,
				remote: volume.remote,
				mountPath: volume.mountPath,
				status: volume.status,
				sizeBytes: volume.sizeBytes,
				freeBytes: volume.freeBytes,
				profile: this.latestProfile(volume.id),
			}))
			.sort((a, b) => (a.nodeName ?? a.nodeId).localeCompare(b.nodeName ?? b.nodeId) || a.volumeName.localeCompare(b.volumeName));
		const ready = members.filter((member) => member.status === 'ready');
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			allocation: row.allocation,
			minFreePercent: row.minFreePercent,
			members,
			sizeBytes: ready.reduce((sum, member) => sum + (member.sizeBytes ?? 0), 0),
			freeBytes: ready.reduce((sum, member) => sum + (member.freeBytes ?? 0), 0),
			classes: [...new Set(members.map((member) => member.class))].sort(),
			usedBy: this.kindsUsing(row.id),
			profiling: members.some((member) => member.profile?.status === 'queued' || member.profile?.status === 'running'),
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	private defaultViews(pools: StoragePoolView[]): StorageDefaultView[] {
		const rows = new Map(this.ctx.db.select().from(storageRules).all().map((row) => [row.kind, row]));
		const byId = new Map(pools.map((pool) => [pool.id, pool]));
		return storageKinds.map((kind) => {
			const row = rows.get(kind);
			const pool = row?.poolId ? byId.get(row.poolId) : undefined;
			const label = storageKindInfo[kind].label.toLowerCase();
			const warnings: string[] = [];
			if (pool) {
				if (pool.members.length === 0) warnings.push(`Pool "${pool.name}" has no volumes yet; new ${label} cannot be created on it.`);
				if (kind === 'databases' && pool.classes.some((cls) => cls === 'remote' || cls === 'bulk'))
					warnings.push(`Pool "${pool.name}" has ${pool.classes.filter((cls) => cls === 'remote' || cls === 'bulk').join(' and ')} volumes; databases want fast local disks.`);
				if (nodeStorageKinds.has(kind) && pool.members.length > 0 && pool.members.every((member) => member.remote))
					warnings.push(`Pool "${pool.name}" only has network volumes, which ${label} skips; the system disk is used.`);
			}
			return {
				kind,
				label: storageKindInfo[kind].label,
				description: storageKindInfo[kind].description,
				pool: pool?.name ?? SYSTEM_POOL,
				configured: Boolean(row),
				warnings,
			};
		});
	}

	private nodeViews(): StorageNodeView[] {
		const poolNames = new Map(this.ctx.db.select({ id: storagePools.id, name: storagePools.name }).from(storagePools).all().map((row) => [row.id, row.name]));
		const volumes = this.ctx.db.select().from(nodeVolumes).all();
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((node: NodeRow) => {
				const mine = volumes.filter((volume) => volume.nodeId === node.id);
				const inventory = volumeInventorySchema.safeParse(parseJson(node.volumeInventoryJson, null));
				const taken = new Set(mine.map((volume) => volume.sourceKey));
				const stats = parseJson<Record<string, unknown> | null>(node.statsJson, null);
				const total = stats && typeof stats.diskTotalBytes === 'number' ? stats.diskTotalBytes : null;
				return {
					id: node.id,
					name: node.name,
					status: node.status,
					volumes: mine
						.map((volume) => ({
							id: volume.id,
							name: volume.name,
							kind: volume.kind,
							class: (volume.classOverride ?? volume.class) as VolumeClass,
							remote: volume.remote,
							mountPath: volume.mountPath,
							status: volume.status,
							sizeBytes: volume.sizeBytes,
							freeBytes: volume.freeBytes,
							pool: volume.poolId ? (poolNames.get(volume.poolId) ?? null) : null,
							profile: this.latestProfile(volume.id),
						}))
						.sort((a, b) => a.name.localeCompare(b.name)),
					adoptable: inventory.success ? inventory.data.mounts.filter((mount) => !taken.has(mount.sourceKey)) : [],
					freeDevices: inventory.success ? inventory.data.devices.filter((device) => device.free).length : 0,
					systemFreeBytes: nodeDiskFreeBytes(stats),
					systemSizeBytes: total,
				};
			});
	}

	private nodeNames(): Map<string, string> {
		return new Map(this.ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes).all().map((node) => [node.id, node.name]));
	}

	private assertRead(principal: Principal): void {
		if (!canViewPlatform(principal)) throw new CoreError('forbidden', 'Platform admin required.', 403);
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

function toRef(row: PoolRow): PoolRef {
	return { id: row.id, name: row.name, allocation: row.allocation, minFreePercent: row.minFreePercent };
}

/** Room for `storageMb` while keeping `minFreePercent` of the volume free. Unknown capacity fits. */
function fits(volume: VolumeRow, storageMb: number, minFreePercent: number): boolean {
	if (volume.freeBytes === null) return true;
	const after = volume.freeBytes - storageMb * MB;
	const floor = volume.sizeBytes ? (volume.sizeBytes * minFreePercent) / 100 : 0;
	return after >= floor;
}
