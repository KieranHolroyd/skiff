import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { nodes, projects, storageAttachments, storageBuckets, storageInstances, workloads } from '@skiff/db';
import {
	STORAGE_ID_PREFIX,
	STORAGE_PORT_MAX,
	STORAGE_PORT_MIN,
	STORAGE_REGION,
	STORAGE_ROOT_KEY_PREFIX,
	STORAGE_USER_KEY_PREFIX,
	bucketCreateSchema,
	bucketUpdateSchema,
	limits,
	requirePermission,
	storageAlias,
	storageAttachSchema,
	storageAttachmentUpdateSchema,
	storageCreateSchema,
	storageEngineRegistry,
	storageEnvNames,
	storageImage,
	storageGatewayHost,
	storagePublicHost,
	storageUpdateSchema,
	type BucketCreate,
	type BucketUpdate,
	type Principal,
	type StorageAttach,
	type StorageAttachmentUpdate,
	type StorageAttachmentView,
	type StorageBucketDeletion,
	type StorageBucketSnapshot,
	type StorageBucketView,
	type StorageCreate,
	type StorageCredentials,
	type StorageGrant,
	type StorageMetricBucket,
	type StorageMetricPoint,
	type StorageRoute,
	type StorageStatus,
	type StorageUpdate,
	type StorageView,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadRuntime,
	type WorkloadStatus,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { resolvePlacement } from './placement.ts';
import type { ProjectRow } from './projects.ts';
import type { VolumeRow } from './volumes.ts';
import { newId, parseJson, randomBytes, sha256Hex } from './util.ts';

export type StorageRow = typeof storageInstances.$inferSelect;
export type StorageBucketRow = typeof storageBuckets.$inferSelect;
type AttachmentRow = typeof storageAttachments.$inferSelect;

const ACTIVE: StorageStatus[] = ['pending', 'starting', 'running'];
const DAY_MS = 86_400_000;

/**
 * Fixed RustFS settings. The helper forces the same values in its `objectStorage` profile; they
 * are sent too so the activation version (and so a restart) follows any change to them.
 */
const RUSTFS_ENV: Record<string, string> = {
	RUSTFS_VOLUMES: '/data',
	RUSTFS_ADDRESS: ':9000',
	RUSTFS_CONSOLE_ENABLE: 'false',
	// Empty sends logs to stdout, so they reach the journal like every other workload.
	RUSTFS_OBS_LOG_DIRECTORY: '',
};

/** One consumer's view of an attachment, resolved for the node and runtime it runs on. */
interface ResolvedAttachment {
	storage: StorageRow;
	attachment: AttachmentRow;
	grants: StorageGrant[];
	endpoint: string;
}

/**
 * Managed object storage (docs/OBJECT-STORAGE.md, S1–S10). A storage instance is an org resource:
 * one RustFS server run as a tier-3 container on one node. Buckets and scoped access keys are
 * desired state the node's agent converges; key values reach the agent only through activation
 * and attached apps only at their own activation (S4, S6).
 */
export class StorageService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	list(principal: Principal, options: { includeDeleted?: boolean } = {}): StorageView[] {
		requirePermission(principal, 'storage:read');
		const filters = [eq(storageInstances.orgId, principal.orgId)];
		if (!options.includeDeleted) filters.push(isNull(storageInstances.deletedAt));
		return this.ctx.db
			.select()
			.from(storageInstances)
			.where(and(...filters))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((row) => this.toView(row));
	}

	get(principal: Principal, name: string, options: { includeDeleted?: boolean } = {}): StorageView {
		requirePermission(principal, 'storage:read');
		return this.toView(this.requireRow(principal, name, options));
	}

	requireRow(principal: Principal, name: string, options: { includeDeleted?: boolean } = {}): StorageRow {
		const row = this.ctx.db
			.select()
			.from(storageInstances)
			.where(and(eq(storageInstances.orgId, principal.orgId), eq(storageInstances.name, name)))
			.get();
		if (!row || (row.deletedAt && !options.includeDeleted)) throw new NotFoundError(`Storage "${name}"`);
		return row;
	}

	// ---------------------------------------------------------------- lifecycle

	create(principal: Principal, raw: StorageCreate): StorageView {
		requirePermission(principal, 'storage:create');
		const input = storageCreateSchema.parse(raw);
		const info = storageEngineRegistry[input.engine];
		const version = input.version ?? info.defaultVersion;
		const memoryMb = input.memoryMb ?? info.defaultMemoryMb;

		const existing = this.ctx.db
			.select({ id: storageInstances.id, deletedAt: storageInstances.deletedAt })
			.from(storageInstances)
			.where(and(eq(storageInstances.orgId, principal.orgId), eq(storageInstances.name, input.name)))
			.get();
		if (existing)
			throw new ConflictError(
				existing.deletedAt
					? `Storage "${input.name}" is in the trash. Restore it or pick another name.`
					: `Storage "${input.name}" already exists.`,
			);
		const publicHost = input.public ? this.claimPublicHost(input.name, null) : null;

		let project: ProjectRow | null = null;
		let requested = input.placement;
		if (input.project) {
			requirePermission(principal, 'project:update');
			project = this.requireAppProject(principal, input.project);
			if (!input.public) {
				// Private instances are reachable on their own node only: co-locate with the app.
				const workloadNode = this.workloadNodeOf(project.id);
				const pinned = this.ctx.workloads.attachmentNode(project.id);
				requested = pinned ?? workloadNode ?? project.placement;
			}
		}

		// A named volume pins the node: the data dir has to be on the same node as the container.
		let volume: VolumeRow | null = null;
		if (input.volume) {
			volume = this.ctx.volumes.findByName(input.volume);
			const edgeNodeId = this.ctx.workloads.edgeNode();
			const target = requested === 'auto' ? null : requested === 'edge' ? edgeNodeId : requested;
			if (target && target !== volume.nodeId)
				throw new ValidationError(
					`Volume "${volume.name}" is on another node; place this instance there or pick a volume on the target node.`,
				);
			requested = volume.nodeId;
		}

		const decision = resolvePlacement({
			runtime: 'container',
			requested,
			memoryMb,
			edgeNodeId: this.ctx.workloads.edgeNode(),
			candidates: this.ctx.workloads.placementCandidates(),
		});
		if (!decision.ok)
			throw new ValidationError(
				decision.message.replace('this app reserves', 'this storage instance reserves'),
				decision.freeByNode,
			);

		const id = newId(STORAGE_ID_PREFIX);
		const now = this.ctx.now();
		// No explicit volume: use the node's default, so an operator only sets it once.
		if (!volume) volume = this.ctx.volumes.defaultFor(decision.nodeId);
		if (volume) this.ctx.volumes.assertRoom(volume, input.storageMb);
		const hostPort = this.allocatePort(decision.nodeId);
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.insert(storageInstances)
				.values({
					id,
					orgId: principal.orgId,
					name: input.name,
					engine: input.engine,
					version,
					nodeId: decision.nodeId,
					hostPort,
					memoryMb,
					cpus: input.cpus,
					storageMb: input.storageMb,
					volumeId: volume?.id ?? null,
					public: input.public,
					publicHost,
					status: 'pending',
					rootAccessKey: accessKeyId(STORAGE_ROOT_KEY_PREFIX),
					rootSecret: this.ctx.secrets.seal(principal.orgId, secretKey()),
					createdBy: principal.userId,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			for (const bucket of input.buckets) this.insertBucket(principal, id, bucket, 'private');
			if (project)
				this.insertAttachment(
					principal,
					id,
					project,
					input.envPrefix ?? 'S3',
					input.buckets.map((bucket) => ({ bucket, mode: 'read-write' as const })),
				);
		})();
		this.ctx.audit.record({
			principal,
			action: 'storage.create',
			resource: 'storage',
			resourceId: id,
			args: {
				name: input.name,
				engine: input.engine,
				version,
				nodeId: decision.nodeId,
				memoryMb,
				public: input.public,
				buckets: input.buckets,
				...(volume ? { volume: volume.name } : {}),
				...(project ? { project: project.slug } : {}),
			},
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, input.name));
	}

	update(principal: Principal, name: string, raw: StorageUpdate): StorageView {
		requirePermission(principal, 'storage:update');
		const patch = storageUpdateSchema.parse(raw);
		const row = this.requireRow(principal, name);
		const info = storageEngineRegistry[row.engine];
		if (patch.memoryMb !== undefined) {
			if (patch.memoryMb < info.minMemoryMb)
				throw new ValidationError(`${info.label} needs at least ${info.minMemoryMb} MB.`);
			if (patch.memoryMb > row.memoryMb) this.admit(row, patch.memoryMb);
		}
		if (patch.version !== undefined && !info.versions.includes(patch.version))
			throw new ValidationError(`${info.label} versions: ${info.versions.join(', ')}.`);
		const set: Partial<typeof storageInstances.$inferInsert> = { updatedAt: this.ctx.now() };
		if (patch.memoryMb !== undefined) set.memoryMb = patch.memoryMb;
		if (patch.cpus !== undefined) set.cpus = patch.cpus;
		if (patch.storageMb !== undefined) set.storageMb = patch.storageMb;
		if (patch.version !== undefined) set.version = patch.version;
		if (patch.public !== undefined && patch.public !== row.public) {
			if (patch.public) {
				set.public = true;
				set.publicHost = this.claimPublicHost(row.name, row.id);
			} else {
				// Going private: apps on other nodes lose their endpoint at their next activation.
				const remote = this.remoteConsumers(row);
				if (remote.length > 0)
					throw new ConflictError(
						`Storage "${name}" is used from another node by ${remote.join(', ')}. Detach them or move them next to it before making it private.`,
					);
				set.public = false;
				set.publicHost = null;
			}
		}
		this.ctx.db.update(storageInstances).set(set).where(eq(storageInstances.id, row.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'storage.update',
			resource: 'storage',
			resourceId: row.id,
			args: { name, ...patch },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name));
	}

	/** Soft delete (S8): the container stops and the route goes; the data dir stays for `trashDays`. */
	delete(principal: Principal, name: string): StorageView {
		requirePermission(principal, 'storage:delete');
		const row = this.requireRow(principal, name);
		const attached = this.attachmentsOf(row.id);
		if (attached.length > 0)
			throw new ConflictError(
				`Storage "${name}" is attached to ${attached.map((item) => item.projectSlug).join(', ')}. Detach it first.`,
			);
		const now = this.ctx.now();
		this.ctx.db
			.update(storageInstances)
			.set({ deletedAt: now, purgeAt: now + limits.trashDays * DAY_MS, status: 'stopped', updatedAt: now })
			.where(eq(storageInstances.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'storage.delete',
			resource: 'storage',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name, { includeDeleted: true }));
	}

	restore(principal: Principal, name: string): StorageView {
		requirePermission(principal, 'storage:delete');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		if (!row.deletedAt) return this.toView(row);
		if (row.purgeRequestedAt)
			throw new ConflictError(`Storage "${name}" is being purged and can no longer be restored.`);
		this.admit(row, row.memoryMb);
		this.ctx.volumes.assertVolumeReady(row.volumeId, row.storageMb);
		this.ctx.db
			.update(storageInstances)
			.set({ deletedAt: null, purgeAt: null, status: 'pending', message: null, updatedAt: this.ctx.now() })
			.where(eq(storageInstances.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'storage.restore',
			resource: 'storage',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name));
	}

	/** Permanently delete a trashed instance now. The node deletes the data, then the rows go. */
	purgeNow(principal: Principal, name: string): void {
		requirePermission(principal, 'storage:delete');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		if (!row.deletedAt) throw new ConflictError(`Storage "${name}" must be deleted before it can be purged.`);
		const now = this.ctx.now();
		this.ctx.db
			.update(storageInstances)
			.set({ purgeAt: now, purgeRequestedAt: now, updatedAt: now })
			.where(eq(storageInstances.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'storage.purge',
			resource: 'storage',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
	}

	/** Maintenance sweep: hand expired trash to its node. Returns how many purges were requested. */
	requestExpiredPurges(): number {
		const now = this.ctx.now();
		const due = this.ctx.db
			.select({ id: storageInstances.id })
			.from(storageInstances)
			.where(
				and(
					isNotNull(storageInstances.deletedAt),
					isNotNull(storageInstances.purgeAt),
					lte(storageInstances.purgeAt, now),
					isNull(storageInstances.purgeRequestedAt),
				),
			)
			.all();
		if (due.length === 0) return 0;
		this.ctx.db
			.update(storageInstances)
			.set({ purgeRequestedAt: now })
			.where(inArray(storageInstances.id, due.map((row) => row.id)))
			.run();
		this.ctx.projects.bump();
		return due.length;
	}

	/** The root key, for humans with `storage:credentials` (S6). Audited; MCP never calls this. */
	credentials(principal: Principal, name: string): StorageCredentials {
		requirePermission(principal, 'storage:credentials');
		const row = this.requireRow(principal, name);
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, row.nodeId)).get();
		const internalEndpoint = `http://127.0.0.1:${row.hostPort}`;
		const publicEndpoint = this.publicUrl(row);
		this.ctx.audit.record({
			principal,
			action: 'storage.credentials',
			resource: 'storage',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		return {
			storageId: row.id,
			name: row.name,
			accessKeyId: row.rootAccessKey,
			secretAccessKey: this.ctx.secrets.open(row.orgId, row.rootSecret),
			region: STORAGE_REGION,
			endpoint: publicEndpoint ?? internalEndpoint,
			internalEndpoint,
			publicEndpoint,
			note: publicEndpoint
				? 'This is the root key: it can manage every bucket. Prefer attaching projects, which get scoped keys. Use path-style addressing.'
				: `Private: listens on loopback on node "${node?.name ?? row.nodeId}" only. From elsewhere, tunnel: ssh -L ${row.hostPort}:127.0.0.1:${row.hostPort} <node>, or make it public.`,
		};
	}

	/**
	 * Restart the RustFS container. Bumping the generation changes the activation version, so the
	 * node re-fetches activation and re-applies the unit; systemd restarts it. Buckets, objects and
	 * keys are untouched (D82).
	 */
	restart(principal: Principal, name: string): StorageView {
		requirePermission(principal, 'storage:update');
		const row = this.requireRow(principal, name);
		const now = this.ctx.now();
		this.ctx.db
			.update(storageInstances)
			.set({
				restartGeneration: row.restartGeneration + 1,
				message: 'Restart requested.',
				updatedAt: now,
			})
			.where(eq(storageInstances.id, row.id))
			.run();
		this.ctx.logs.appendServiceSystem({
			kind: 'storage',
			serviceId: row.id,
			orgId: row.orgId,
			nodeId: row.nodeId,
			level: 'warn',
			message: `Restart requested by ${principal.userId}.`,
		});
		this.ctx.audit.record({
			principal,
			action: 'storage.restart',
			resource: 'storage',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name));
	}

	// ---------------------------------------------------------------- buckets

	createBucket(principal: Principal, name: string, raw: BucketCreate): StorageBucketView {
		requirePermission(principal, 'storage:update');
		const input = bucketCreateSchema.parse(raw);
		const row = this.requireRow(principal, name);
		const existing = this.bucketRow(row.id, input.name);
		// Re-creating a bucket whose delete was blocked (not empty) cancels that delete.
		if (existing?.deleteRequestedAt && existing.deleteBlocked && !existing.deleteForce) {
			this.ctx.db
				.update(storageBuckets)
				.set({ deleteRequestedAt: null, deleteBlocked: false, access: input.access })
				.where(eq(storageBuckets.id, existing.id))
				.run();
			this.ctx.projects.bump(principal.orgId);
			return bucketView(this.bucketRow(row.id, input.name)!);
		}
		if (existing)
			throw new ConflictError(
				existing.deleteRequestedAt
					? `Bucket "${input.name}" is being deleted. Try again once it is gone.`
					: `Bucket "${input.name}" already exists in "${name}".`,
			);
		if (this.liveBuckets(row.id).length >= 200) throw new ValidationError('A storage instance holds at most 200 buckets.');
		this.insertBucket(principal, row.id, input.name, input.access);
		this.ctx.audit.record({
			principal,
			action: 'storage.bucket.create',
			resource: 'storage',
			resourceId: row.id,
			args: { name, bucket: input.name, access: input.access },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return bucketView(this.bucketRow(row.id, input.name)!);
	}

	updateBucket(principal: Principal, name: string, bucket: string, raw: BucketUpdate): StorageBucketView {
		requirePermission(principal, 'storage:update');
		const input = bucketUpdateSchema.parse(raw);
		const row = this.requireRow(principal, name);
		const target = this.requireBucket(row, bucket);
		this.ctx.db.update(storageBuckets).set({ access: input.access }).where(eq(storageBuckets.id, target.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'storage.bucket.update',
			resource: 'storage',
			resourceId: row.id,
			args: { name, bucket, access: input.access },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return bucketView(this.bucketRow(row.id, bucket)!);
	}

	/**
	 * Ask the node to delete a bucket. Without `force` the agent only deletes it when empty and
	 * reports `not-empty` otherwise; `force` empties it first (humans with `storage:delete` only).
	 */
	deleteBucket(principal: Principal, name: string, bucket: string, options: { force?: boolean } = {}): StorageBucketView {
		requirePermission(principal, options.force ? 'storage:delete' : 'storage:update');
		const row = this.requireRow(principal, name);
		const target = this.bucketRow(row.id, bucket);
		if (!target) throw new NotFoundError(`Bucket "${bucket}" in "${name}"`);
		const users = this.attachmentsOf(row.id).filter((item) => item.grants.some((grant) => grant.bucket === bucket));
		if (users.length > 0)
			throw new ConflictError(
				`Bucket "${bucket}" is granted to ${users.map((item) => item.projectSlug).join(', ')}. Remove it from their grants first.`,
			);
		if (!options.force && (target.objects ?? 0) > 0)
			throw new ConflictError(
				`Bucket "${bucket}" holds ${target.objects} objects. Empty it, or delete it with force to remove the objects too.`,
			);
		this.ctx.db
			.update(storageBuckets)
			.set({ deleteRequestedAt: this.ctx.now(), deleteForce: options.force ?? false, deleteBlocked: false })
			.where(eq(storageBuckets.id, target.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'storage.bucket.delete',
			resource: 'storage',
			resourceId: row.id,
			args: { name, bucket, force: options.force ?? false },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return bucketView(this.bucketRow(row.id, bucket)!);
	}

	// ---------------------------------------------------------------- attachments

	attachments(principal: Principal, project: ProjectRow): StorageAttachmentView[] {
		requirePermission(principal, 'storage:read');
		return this.attachmentsForProject(project.id);
	}

	attach(
		principal: Principal,
		project: ProjectRow,
		raw: StorageAttach,
	): { attachment: StorageAttachmentView; warning: string | null } {
		requirePermission(principal, 'storage:update');
		requirePermission(principal, 'project:update');
		const input = storageAttachSchema.parse(raw);
		this.assertAppProject(project);
		const row = this.requireRow(principal, input.storage);
		const current = this.attachmentsForProject(project.id);
		if (current.some((item) => item.storageId === row.id))
			throw new ConflictError(`Storage "${row.name}" is already attached to "${project.slug}".`);
		if (current.some((item) => item.envPrefix === input.envPrefix))
			throw new ConflictError(
				`"${project.slug}" already uses the env prefix ${input.envPrefix} for storage. Pick another, e.g. ${input.envPrefix}_2.`,
			);
		this.assertGrants(row, input.grants);
		if (!row.public) {
			const pinned = this.ctx.workloads.attachmentNode(project.id);
			if (pinned && pinned !== row.nodeId)
				throw new ValidationError(
					`"${project.slug}" already uses a database or private storage on another node. Private storage must share that node; make "${row.name}" public to use it from anywhere.`,
				);
			const placementProblem = this.placementConflict(project, row.nodeId);
			if (placementProblem) throw new ValidationError(placementProblem);
		}

		this.insertAttachment(principal, row.id, project, input.envPrefix, input.grants);
		this.ctx.audit.record({
			principal,
			action: 'storage.attach',
			resource: 'storage',
			resourceId: row.id,
			args: { name: row.name, project: project.slug, envPrefix: input.envPrefix, grants: input.grants },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);

		const workloadNode = this.workloadNodeOf(project.id);
		const warning = row.public
			? null
			: workloadNode && workloadNode !== row.nodeId
				? `"${project.slug}" currently runs on another node. Redeploy it to move it next to "${row.name}"; until then it gets no ${input.envPrefix}_ENDPOINT_URL.`
				: workloadNode
					? null
					: `"${project.slug}" has no running workload yet. Its next deploy is placed next to "${row.name}".`;
		const attachment = this.attachmentsForProject(project.id).find((item) => item.storageId === row.id)!;
		return { attachment, warning };
	}

	updateAttachment(
		principal: Principal,
		project: ProjectRow,
		name: string,
		raw: StorageAttachmentUpdate,
	): StorageAttachmentView {
		requirePermission(principal, 'storage:update');
		requirePermission(principal, 'project:update');
		const input = storageAttachmentUpdateSchema.parse(raw);
		const row = this.requireRow(principal, name);
		this.assertGrants(row, input.grants);
		const result = this.ctx.sqlite.run(
			'UPDATE storage_attachments SET grants_json = ?, updated_at = ? WHERE storage_id = ? AND project_id = ?',
			[JSON.stringify(input.grants), this.ctx.now(), row.id, project.id],
		);
		if (result.changes === 0) throw new NotFoundError(`Attachment of "${name}" to "${project.slug}"`);
		this.ctx.audit.record({
			principal,
			action: 'storage.attachment.update',
			resource: 'storage',
			resourceId: row.id,
			args: { name, project: project.slug, grants: input.grants },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.attachmentsForProject(project.id).find((item) => item.storageId === row.id)!;
	}

	detach(principal: Principal, project: ProjectRow, name: string): void {
		requirePermission(principal, 'storage:update');
		requirePermission(principal, 'project:update');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		const result = this.ctx.sqlite.run('DELETE FROM storage_attachments WHERE storage_id = ? AND project_id = ?', [
			row.id,
			project.id,
		]);
		if (result.changes === 0) throw new NotFoundError(`Attachment of "${name}" to "${project.slug}"`);
		this.ctx.audit.record({
			principal,
			action: 'storage.detach',
			resource: 'storage',
			resourceId: row.id,
			args: { name, project: project.slug },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
	}

	/**
	 * The node every *private* instance attached to this project lives on, or null. Public
	 * instances are reachable from anywhere and never pin (S5).
	 */
	requiredNode(projectId: string): string | null {
		const nodeIds = [
			...new Set(
				this.liveAttachmentRows(projectId)
					.filter(({ storage }) => !storage.public)
					.map(({ storage }) => storage.nodeId),
			),
		];
		if (nodeIds.length > 1)
			throw new ValidationError('Attached private storage lives on different nodes; detach one or make it public.');
		return nodeIds[0] ?? null;
	}

	/** Problem message when a project's explicit placement can't reach private storage on `nodeId`. */
	placementConflict(project: ProjectRow, nodeId: string): string | null {
		if (project.placement === 'auto' || project.placement === nodeId) return null;
		if (project.placement === 'edge' && this.ctx.workloads.edgeNode() === nodeId) return null;
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get();
		return `"${project.slug}" is placed on "${project.placement}" but the storage runs on "${node?.name ?? nodeId}". Set the project's placement to "auto" or that node, or make the storage public (S5).`;
	}

	/** Env vars one consumer workload receives, resolved for its node and runtime (S4). */
	consumerEnv(projectId: string, nodeId: string | null, runtime: WorkloadRuntime): Record<string, string> {
		const env: Record<string, string> = {};
		for (const item of this.resolveForConsumer(projectId, nodeId, runtime)) {
			const prefix = item.attachment.envPrefix;
			const publicUrl = this.publicUrl(item.storage);
			env[`${prefix}_ENDPOINT_URL`] = item.endpoint;
			if (publicUrl) env[`${prefix}_PUBLIC_ENDPOINT_URL`] = publicUrl;
			env[`${prefix}_ACCESS_KEY_ID`] = item.attachment.accessKeyId;
			env[`${prefix}_SECRET_ACCESS_KEY`] = this.ctx.secrets.open(item.attachment.orgId, item.attachment.secretSealed);
			env[`${prefix}_REGION`] = STORAGE_REGION;
			env[`${prefix}_FORCE_PATH_STYLE`] = 'true';
			if (item.grants.length === 1) env[`${prefix}_BUCKET`] = item.grants[0]!.bucket;
		}
		return env;
	}

	/** Fingerprint of a consumer's storage attachments (no secrets), folded into its activation version. */
	consumerVersion(projectId: string, nodeId: string | null, runtime: WorkloadRuntime): string {
		const items = this.resolveForConsumer(projectId, nodeId, runtime).map((item) => ({
			id: item.storage.id,
			prefix: item.attachment.envPrefix,
			endpoint: item.endpoint,
			public: this.publicUrl(item.storage),
			key: item.attachment.accessKeyId,
			bucket: item.grants.length === 1 ? item.grants[0]!.bucket : null,
		}));
		return items.length === 0 ? '' : sha256Hex(JSON.stringify(items));
	}

	// ---------------------------------------------------------------- node protocol

	/** Live instances placed on a node, as container workloads with the object-storage profile. */
	desiredForNode(nodeId: string): WorkloadDesired[] {
		return this.ctx.db
			.select()
			.from(storageInstances)
			.where(and(eq(storageInstances.nodeId, nodeId), isNull(storageInstances.deletedAt)))
			.all()
			.map((row) => {
				const buckets = this.ctx.db.select().from(storageBuckets).where(eq(storageBuckets.storageId, row.id)).all();
				const attachments = this.liveAttachmentsOf(row.id);
				const users = attachments.map((item) => ({
					accessKeyId: item.accessKeyId,
					grants: parseGrants(item.grantsJson),
				}));
				return {
					id: row.id,
					projectId: row.id,
					projectSlug: row.name,
					deploymentId: row.id,
					runtime: 'container' as const,
					// Desired, not observed: an instance on this list must run (see DatabaseService).
					status: 'running' as const,
					release: null,
					image: storageImage(row.engine, row.version),
					...(row.volumeId ? { volumeId: row.volumeId } : {}),
					upstream: `127.0.0.1:${row.hostPort}`,
					memoryMb: row.memoryMb,
					cpus: row.cpus,
					port: row.hostPort,
					healthPath: '/health',
					socketActivation: false,
					activationVersion: storageActivationVersion(row),
					env: { ...RUSTFS_ENV },
					secrets: [],
					dataSizeMb: null,
					objectStorage: {
						engine: row.engine,
						version: row.version,
						buckets: buckets
							.filter((bucket) => !bucket.deleteRequestedAt)
							.map((bucket) => ({ name: bucket.name, access: bucket.access })),
						users,
						deleteBuckets: buckets
							.filter((bucket) => bucket.deleteRequestedAt && (!bucket.deleteBlocked || bucket.deleteForce))
							.map((bucket) => ({ name: bucket.name, force: bucket.deleteForce })),
						keysVersion: keysVersion(row, attachments),
					},
				};
			});
	}

	/**
	 * Public endpoints this node serves (S3). The instance's own node proxies to its loopback port;
	 * the edge reaches a worker-placed instance through that worker's Caddy, like worker apps.
	 */
	/**
	 * Internal gateway routes for the control plane's object browser (D82). The edge gets a
	 * loopback listener covering every instance (local loopback, remote through the worker's
	 * Caddy); a worker gets its own routes, which the agent puts on the WireGuard-only server.
	 */
	gatewayForNode(
		nodeId: string,
		isEdge: boolean,
		publicAddressOf: (nodeId: string) => string | null,
	): { listen: string | null; routes: Array<{ host: string; upstream: string }> } {
		const rows = this.ctx.db
			.select()
			.from(storageInstances)
			.where(isNull(storageInstances.deletedAt))
			.all();
		const routes: Array<{ host: string; upstream: string }> = [];
		for (const row of rows) {
			const host = storageGatewayHost(row.id);
			if (row.nodeId === nodeId) {
				routes.push({ host, upstream: `127.0.0.1:${row.hostPort}` });
				continue;
			}
			if (!isEdge) continue;
			routes.push({
				host,
				upstream: `http://${publicAddressOf(row.nodeId) ?? '127.0.0.1:1'}`,
			});
		}
		routes.sort((a, b) => a.host.localeCompare(b.host));
		const port = this.ctx.config.storageGatewayPort ?? 8081;
		return { listen: isEdge ? `127.0.0.1:${port}` : null, routes };
	}

	routesForNode(nodeId: string, isEdge: boolean, publicAddressOf: (nodeId: string) => string | null): StorageRoute[] {
		return this.ctx.db
			.select()
			.from(storageInstances)
			.where(and(eq(storageInstances.public, true), isNull(storageInstances.deletedAt), isNotNull(storageInstances.publicHost)))
			.all()
			.flatMap((row) => {
				if (row.nodeId === nodeId) return [{ storageId: row.id, host: row.publicHost!, upstream: `127.0.0.1:${row.hostPort}` }];
				if (!isEdge) return [];
				return [{ storageId: row.id, host: row.publicHost!, upstream: `http://${publicAddressOf(row.nodeId) ?? '127.0.0.1:1'}` }];
			})
			.sort((a, b) => a.host.localeCompare(b.host));
	}

	/** Trashed instances whose purge is due on this node (S8). */
	purgesForNode(nodeId: string): string[] {
		return this.ctx.db
			.select({ id: storageInstances.id })
			.from(storageInstances)
			.where(
				and(
					eq(storageInstances.nodeId, nodeId),
					isNotNull(storageInstances.deletedAt),
					isNotNull(storageInstances.purgeRequestedAt),
				),
			)
			.all()
			.map((row) => row.id);
	}

	isStorageId(id: string): boolean {
		return id.startsWith(STORAGE_ID_PREFIX);
	}

	activation(nodeId: string, id: string): WorkloadActivation {
		const row = this.rowById(id);
		if (!row || row.deletedAt) throw new NotFoundError('Storage');
		if (row.nodeId !== nodeId) throw new CoreError('forbidden', 'This storage instance is placed on another node.', 403);
		const rootSecret = this.ctx.secrets.open(row.orgId, row.rootSecret);
		const attachments = this.liveAttachmentsOf(row.id);
		return {
			workloadId: row.id,
			activationVersion: storageActivationVersion(row),
			env: { RUSTFS_ACCESS_KEY: row.rootAccessKey, RUSTFS_SECRET_KEY: rootSecret },
			files: {},
			storageAdmin: {
				rootAccessKeyId: row.rootAccessKey,
				rootSecretAccessKey: rootSecret,
				port: row.hostPort,
				keysVersion: keysVersion(row, attachments),
				users: Object.fromEntries(
					attachments.map((item) => [item.accessKeyId, this.ctx.secrets.open(item.orgId, item.secretSealed)]),
				),
			},
		};
	}

	applyHeartbeat(nodeId: string, reports: Array<{ id: string; status: WorkloadStatus; restarts: number }>): void {
		for (const report of reports) {
			if (!this.isStorageId(report.id)) continue;
			const row = this.rowById(report.id);
			if (!row || row.nodeId !== nodeId || row.deletedAt) continue;
			const status: StorageStatus = report.status === 'running' && report.restarts >= 5 ? 'failed' : report.status;
			if (status === row.status) continue;
			this.ctx.db
				.update(storageInstances)
				.set({
					status,
					message: report.restarts >= 5 ? `Restart loop (${report.restarts} restarts)` : null,
					updatedAt: this.ctx.now(),
				})
				.where(eq(storageInstances.id, row.id))
				.run();
		}
	}

	/** The node deleted these data dirs; drop the rows (S8). */
	applyPurged(nodeId: string, ids: string[]): void {
		for (const id of ids) {
			const row = this.rowById(id);
			if (!row || row.nodeId !== nodeId || !row.deletedAt || !row.purgeRequestedAt) continue;
			this.ctx.sqlite.transaction(() => {
				this.ctx.db.delete(storageAttachments).where(eq(storageAttachments.storageId, id)).run();
				this.ctx.db.delete(storageBuckets).where(eq(storageBuckets.storageId, id)).run();
				this.ctx.db.delete(storageInstances).where(eq(storageInstances.id, id)).run();
			})();
			this.ctx.audit.record({
				orgId: row.orgId,
				action: 'storage.purged',
				resource: 'storage',
				resourceId: id,
				args: { name: row.name, nodeId },
				result: 'ok',
			});
		}
		if (ids.length > 0) this.ctx.projects.bump();
	}

	/** Outcomes of `deleteBuckets`: a deleted bucket's row goes; a non-empty one is marked blocked. */
	applyBucketDeletions(nodeId: string, reports: StorageBucketDeletion[]): void {
		let changed = false;
		for (const report of reports) {
			const row = this.rowById(report.storageId);
			if (!row || row.nodeId !== nodeId) continue;
			const bucket = this.bucketRow(row.id, report.bucket);
			if (!bucket?.deleteRequestedAt) continue;
			changed = true;
			if (report.result === 'deleted') {
				this.ctx.db.delete(storageBuckets).where(eq(storageBuckets.id, bucket.id)).run();
				this.ctx.audit.record({
					orgId: row.orgId,
					action: 'storage.bucket.deleted',
					resource: 'storage',
					resourceId: row.id,
					args: { name: row.name, bucket: bucket.name, force: bucket.deleteForce },
					result: 'ok',
				});
			} else {
				this.ctx.db.update(storageBuckets).set({ deleteBlocked: true }).where(eq(storageBuckets.id, bucket.id)).run();
			}
		}
		if (changed) this.ctx.projects.bump();
	}

	/**
	 * Telemetry from a node (S7). Samples for instances not placed on that node are dropped; the
	 * latest totals and per-bucket usage go to SQLite, the time series to DuckDB.
	 */
	async ingestTelemetry(
		nodeId: string,
		samples: StorageMetricBucket[],
		snapshots: StorageBucketSnapshot[],
	): Promise<{ stored: number }> {
		const owned = new Set(
			this.ctx.db
				.select({ id: storageInstances.id })
				.from(storageInstances)
				.where(eq(storageInstances.nodeId, nodeId))
				.all()
				.map((row) => row.id),
		);
		const accepted = samples.filter((sample) => owned.has(sample.storageId));
		const latest = new Map<string, StorageMetricBucket>();
		for (const sample of accepted) {
			const previous = latest.get(sample.storageId);
			if (!previous || previous.bucket < sample.bucket) latest.set(sample.storageId, sample);
		}
		for (const [id, sample] of latest) {
			if (!sample.up) continue;
			this.ctx.db
				.update(storageInstances)
				.set({ usedBytes: sample.usedBytes, objects: sample.objects })
				.where(eq(storageInstances.id, id))
				.run();
		}
		for (const snapshot of snapshots) {
			if (!owned.has(snapshot.storageId)) continue;
			const parsed = Date.parse(snapshot.at);
			const at = Number.isFinite(parsed) ? parsed : this.ctx.now();
			for (const usage of snapshot.buckets) {
				this.ctx.db
					.update(storageBuckets)
					.set({ sizeBytes: Math.trunc(usage.sizeBytes), objects: Math.trunc(usage.objects), statsAt: at })
					.where(and(eq(storageBuckets.storageId, snapshot.storageId), eq(storageBuckets.name, usage.name)))
					.run();
			}
			this.ctx.db.update(storageInstances).set({ statsAt: at }).where(eq(storageInstances.id, snapshot.storageId)).run();
		}
		if (accepted.length === 0 || !this.ctx.telemetry) return { stored: 0 };
		const result = await this.ctx.telemetry.ingestStorageMetrics(accepted);
		return { stored: result.inserted };
	}

	async metrics(
		principal: Principal,
		name: string,
		input: { from: string | number | Date; to: string | number | Date; interval?: '1m' | '1h' },
	): Promise<StorageMetricPoint[]> {
		requirePermission(principal, 'storage:read');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		if (!this.ctx.telemetry) return [];
		return this.ctx.telemetry.queryStorageMetrics({
			storageId: row.id,
			from: input.from,
			to: input.to,
			interval: input.interval ?? '1m',
		});
	}

	/** Instances above 85% of their storage budget, for the maintenance alert pass. */
	alertCandidates(): Array<{ row: StorageRow; ratio: number }> {
		return this.ctx.db
			.select()
			.from(storageInstances)
			.where(and(isNull(storageInstances.deletedAt), isNotNull(storageInstances.usedBytes)))
			.all()
			.flatMap((row) => {
				const ratio = (row.usedBytes ?? 0) / (row.storageMb * 1024 * 1024);
				return ratio >= 0.85 ? [{ row, ratio }] : [];
			});
	}

	/** Memory reserved by live instances per node (D42 admission). */
	reservedByNode(): Map<string, number> {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string; total: number | null }, [string, string, string]>(
				`SELECT node_id AS nodeId, SUM(memory_mb) AS total FROM storage_instances
				 WHERE deleted_at IS NULL AND status IN (?, ?, ?) GROUP BY node_id`,
			)
			.all(...(ACTIVE as [string, string, string]));
		return new Map(rows.map((row) => [row.nodeId, row.total ?? 0]));
	}

	countByNode(): Map<string, number> {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string; n: number }, []>(
				'SELECT node_id AS nodeId, COUNT(*) AS n FROM storage_instances WHERE deleted_at IS NULL GROUP BY node_id',
			)
			.all();
		return new Map(rows.map((row) => [row.nodeId, row.n]));
	}

	// ---------------------------------------------------------------- internals

	private rowById(id: string): StorageRow | undefined {
		return this.ctx.db.select().from(storageInstances).where(eq(storageInstances.id, id)).get();
	}

	private publicUrl(row: StorageRow): string | null {
		return row.public && row.publicHost ? `https://${row.publicHost}` : null;
	}

	/** Reserve `<name>--s3.<contentDomain>`; the host is global, names are only unique per org. */
	private claimPublicHost(name: string, selfId: string | null): string {
		const host = storagePublicHost(name, this.ctx.config.contentDomain);
		const holder = this.ctx.db
			.select({ id: storageInstances.id })
			.from(storageInstances)
			.where(eq(storageInstances.publicHost, host))
			.get();
		if (holder && holder.id !== selfId)
			throw new ConflictError(`${host} is already used by another storage instance. Pick another name to make it public.`);
		return host;
	}

	/** Admission for an instance growing to (or coming back with) `memoryMb` on its node. */
	private admit(row: StorageRow, memoryMb: number): void {
		const capacity = this.ctx.workloads.capacityInternal().find((item) => item.nodeId === row.nodeId);
		if (!capacity) throw new ValidationError('The storage node is no longer registered.');
		const counted = !row.deletedAt && ACTIVE.includes(row.status) ? row.memoryMb : 0;
		const free = capacity.freeMemoryMb + counted;
		if (free < memoryMb)
			throw new ValidationError(
				`Node "${capacity.name}" only has ${free} MB of workload budget free, but this storage instance needs ${memoryMb} MB.`,
			);
	}

	private allocatePort(nodeId: string): number {
		const used = new Set(
			this.ctx.db
				.select({ port: storageInstances.hostPort })
				.from(storageInstances)
				.where(eq(storageInstances.nodeId, nodeId))
				.all()
				.map((row) => row.port),
		);
		for (let port = STORAGE_PORT_MIN; port <= STORAGE_PORT_MAX; port++) if (!used.has(port)) return port;
		throw new ValidationError('This node has no free storage ports left.');
	}

	private requireAppProject(principal: Principal, slug: string): ProjectRow {
		const project = this.ctx.projects.requireRow(principal, slug);
		this.assertAppProject(project);
		return project;
	}

	private assertAppProject(project: ProjectRow): void {
		if (project.runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static; only process or container projects can use storage. Static sites can read public-read buckets by URL.`,
			);
	}

	private workloadNodeOf(projectId: string): string | null {
		return (
			this.ctx.db.select({ nodeId: workloads.nodeId }).from(workloads).where(eq(workloads.projectId, projectId)).get()
				?.nodeId ?? null
		);
	}

	/** Attached projects whose workload runs on another node (they rely on the public endpoint). */
	private remoteConsumers(row: StorageRow): string[] {
		return this.attachmentsOf(row.id)
			.filter((item) => {
				const node = this.workloadNodeOf(item.projectId);
				return node !== null && node !== row.nodeId;
			})
			.map((item) => item.projectSlug);
	}

	private assertGrants(row: StorageRow, grants: StorageGrant[]): void {
		const live = new Set(this.liveBuckets(row.id).map((bucket) => bucket.name));
		const missing = grants.filter((grant) => !live.has(grant.bucket)).map((grant) => grant.bucket);
		if (missing.length > 0)
			throw new ValidationError(`"${row.name}" has no bucket named ${missing.map((name) => `"${name}"`).join(', ')}.`);
	}

	private bucketRow(storageId: string, name: string): StorageBucketRow | undefined {
		return this.ctx.db
			.select()
			.from(storageBuckets)
			.where(and(eq(storageBuckets.storageId, storageId), eq(storageBuckets.name, name)))
			.get();
	}

	private requireBucket(row: StorageRow, name: string): StorageBucketRow {
		const bucket = this.bucketRow(row.id, name);
		if (!bucket || bucket.deleteRequestedAt) throw new NotFoundError(`Bucket "${name}" in "${row.name}"`);
		return bucket;
	}

	private liveBuckets(storageId: string): StorageBucketRow[] {
		return this.ctx.db
			.select()
			.from(storageBuckets)
			.where(and(eq(storageBuckets.storageId, storageId), isNull(storageBuckets.deleteRequestedAt)))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private insertBucket(principal: Principal, storageId: string, name: string, access: 'private' | 'public-read'): void {
		this.ctx.db
			.insert(storageBuckets)
			.values({
				id: newId('stb_'),
				orgId: principal.orgId,
				storageId,
				name,
				access,
				createdBy: principal.userId,
				createdAt: this.ctx.now(),
			})
			.run();
	}

	private insertAttachment(
		principal: Principal,
		storageId: string,
		project: ProjectRow,
		envPrefix: string,
		grants: StorageGrant[],
	): void {
		const now = this.ctx.now();
		this.ctx.db
			.insert(storageAttachments)
			.values({
				id: newId('sta_'),
				orgId: project.orgId,
				storageId,
				projectId: project.id,
				envPrefix,
				grantsJson: JSON.stringify(grants),
				accessKeyId: accessKeyId(STORAGE_USER_KEY_PREFIX),
				secretSealed: this.ctx.secrets.seal(project.orgId, secretKey()),
				createdBy: principal.userId,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}

	/** Attachments whose project is live (trashed projects' keys are revoked by leaving desired state). */
	private liveAttachmentsOf(storageId: string): AttachmentRow[] {
		return this.ctx.db
			.select({ attachment: storageAttachments })
			.from(storageAttachments)
			.innerJoin(projects, eq(projects.id, storageAttachments.projectId))
			.where(and(eq(storageAttachments.storageId, storageId), isNull(projects.deletedAt)))
			.all()
			.map(({ attachment }) => attachment)
			.sort((a, b) => a.accessKeyId.localeCompare(b.accessKeyId));
	}

	private attachmentsOf(storageId: string): StorageAttachmentView[] {
		return this.attachmentViews(eq(storageAttachments.storageId, storageId));
	}

	private attachmentsForProject(projectId: string): StorageAttachmentView[] {
		return this.attachmentViews(eq(storageAttachments.projectId, projectId));
	}

	private attachmentViews(filter: ReturnType<typeof eq>): StorageAttachmentView[] {
		return this.ctx.db
			.select({ attachment: storageAttachments, storage: storageInstances, project: projects })
			.from(storageAttachments)
			.innerJoin(storageInstances, eq(storageInstances.id, storageAttachments.storageId))
			.innerJoin(projects, eq(projects.id, storageAttachments.projectId))
			.where(and(filter, isNull(projects.deletedAt)))
			.all()
			.map(({ attachment, storage, project }) => {
				const grants = parseGrants(attachment.grantsJson);
				return {
					storageId: storage.id,
					storageName: storage.name,
					projectId: project.id,
					projectSlug: project.slug,
					envPrefix: attachment.envPrefix,
					envNames: storageEnvNames(attachment.envPrefix, { public: storage.public, singleBucket: grants.length === 1 }),
					grants,
					accessKeyId: attachment.accessKeyId,
					createdAt: new Date(attachment.createdAt).toISOString(),
				};
			})
			.sort((a, b) => a.projectSlug.localeCompare(b.projectSlug) || a.storageName.localeCompare(b.storageName));
	}

	private liveAttachmentRows(projectId: string): Array<{ storage: StorageRow; attachment: AttachmentRow }> {
		return this.ctx.db
			.select({ attachment: storageAttachments, storage: storageInstances })
			.from(storageAttachments)
			.innerJoin(storageInstances, eq(storageInstances.id, storageAttachments.storageId))
			.where(and(eq(storageAttachments.projectId, projectId), isNull(storageInstances.deletedAt)))
			.all()
			.sort((a, b) => a.attachment.envPrefix.localeCompare(b.attachment.envPrefix));
	}

	private resolveForConsumer(projectId: string, nodeId: string | null, runtime: WorkloadRuntime): ResolvedAttachment[] {
		if (!nodeId) return [];
		return this.liveAttachmentRows(projectId).flatMap(({ storage, attachment }) => {
			const grants = parseGrants(attachment.grantsJson);
			if (storage.nodeId === nodeId) {
				const info = storageEngineRegistry[storage.engine];
				const endpoint =
					runtime === 'container'
						? `http://${storageAlias(storage.id)}:${info.containerPort}`
						: `http://127.0.0.1:${storage.hostPort}`;
				return [{ storage, attachment, grants, endpoint }];
			}
			// Another node: only public instances are reachable, through the edge (S5).
			const publicUrl = this.publicUrl(storage);
			return publicUrl ? [{ storage, attachment, grants, endpoint: publicUrl }] : [];
		});
	}

	private toView(row: StorageRow): StorageView {
		const info = storageEngineRegistry[row.engine];
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, row.nodeId)).get();
		return {
			id: row.id,
			name: row.name,
			engine: row.engine,
			engineLabel: info.label,
			version: row.version,
			status: row.status,
			message: row.message,
			nodeId: row.nodeId,
			nodeName: node?.name ?? null,
			memoryMb: row.memoryMb,
			cpus: row.cpus,
			storageMb: row.storageMb,
			usedBytes: row.usedBytes,
			objects: row.objects,
			public: row.public,
			publicUrl: this.publicUrl(row),
			internalEndpoint: {
				process: `http://127.0.0.1:${row.hostPort}`,
				container: `http://${storageAlias(row.id)}:${info.containerPort}`,
			},
			volume: this.ctx.volumes.summary(row.volumeId),
			region: STORAGE_REGION,
			buckets: this.ctx.db
				.select()
				.from(storageBuckets)
				.where(eq(storageBuckets.storageId, row.id))
				.all()
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(bucketView),
			attachments: this.attachmentsOf(row.id),
			statsAt: row.statsAt ? new Date(row.statsAt).toISOString() : null,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
			deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
			purgeAt: row.purgeAt ? new Date(row.purgeAt).toISOString() : null,
		};
	}
}

function bucketView(row: StorageBucketRow): StorageBucketView {
	return {
		name: row.name,
		access: row.access,
		state: !row.deleteRequestedAt ? 'ready' : row.deleteBlocked && !row.deleteForce ? 'delete-blocked' : 'deleting',
		sizeBytes: row.sizeBytes,
		objects: row.objects,
		createdAt: new Date(row.createdAt).toISOString(),
		statsAt: row.statsAt ? new Date(row.statsAt).toISOString() : null,
	};
}

function parseGrants(json: string): StorageGrant[] {
	return parseJson<StorageGrant[]>(json, []);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** `SKF`/`SKR` + 17 base32 chars: 20 characters, like AWS access key ids. */
function accessKeyId(prefix: string): string {
	const bytes = randomBytes(17);
	let out = prefix;
	for (let i = 0; i < 17; i++) out += BASE32[bytes[i]! % 32];
	return out;
}

/** 40 URL-safe characters; RustFS accepts 8–40. */
function secretKey(): string {
	return Buffer.from(randomBytes(30)).toString('base64url');
}

/** Covers what the container itself depends on; bucket and key changes never restart it. */
function storageActivationVersion(row: StorageRow): string {
	return sha256Hex(
		JSON.stringify({
			id: row.id,
			engine: row.engine,
			version: row.version,
			port: row.hostPort,
			root: row.rootAccessKey,
			// A restart must re-activate (and so restart) the container without touching data.
			restartGeneration: row.restartGeneration,
			env: RUSTFS_ENV,
		}),
	);
}

/** Changes whenever the set of scoped keys changes, so the agent re-fetches their secrets. */
function keysVersion(row: StorageRow, attachments: AttachmentRow[]): string {
	return sha256Hex(
		JSON.stringify({
			root: row.rootAccessKey,
			users: attachments.map((item) => [item.accessKeyId, item.secretSealed]),
		}),
	);
}
