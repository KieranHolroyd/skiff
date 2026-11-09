import { and, eq } from 'drizzle-orm';
import { configSnapshots, releases } from '@skiff/db';
import { parseSiteConfig, SiteConfigError, type ParsedConfig } from '@skiff/site-config';
import type { Principal } from '@skiff/contracts';
import { buildArtifact, entryMap, type FileEntry, type ReleaseArtifact } from './artifact.ts';
import type { CoreContext } from './context.ts';
import { NotFoundError, ValidationError } from './errors.ts';
import { objectKeyForRelease, storageKindForDb } from './object-store.ts';
import { newId, sha256Hex } from './util.ts';

export interface PreparedRelease {
	release: typeof releases.$inferSelect;
	config: ParsedConfig;
	snapshotId: string;
	artifact: ReleaseArtifact;
}

/**
 * Turn an uploaded file set into a content-addressed release + config snapshot (DESIGN §4, D17).
 * The same artifact can back many deployments; changing only config creates a new snapshot.
 */
export class ReleaseService {
	constructor(private readonly ctx: CoreContext) {}

	async prepare(
		principal: Principal,
		entries: FileEntry[],
		options: { precompress?: boolean; project?: { id: string } } = {},
	): Promise<PreparedRelease> {
		// A deploy always names its project, so the check is project-scoped. The org-scope fallback
		// stays for callers that have no project yet (none today).
		this.ctx.iam.require(
			principal,
			'deployment:create',
			options.project ? { type: 'project', id: options.project.id } : { type: 'org' },
		);
		let config: ParsedConfig;
		try {
			config = parseSiteConfig(entryMap(entries));
		} catch (error) {
			if (error instanceof SiteConfigError) throw new ValidationError(error.message, error.issues);
			throw error;
		}
		const artifact = await buildArtifact(entries, { precompress: options.precompress });
		this.ctx.quota.assertCanUpload(principal.orgId, artifact.sizeBytes);

		const existing = this.ctx.db
			.select()
			.from(releases)
			.where(and(eq(releases.orgId, principal.orgId), eq(releases.sha256, artifact.sha256)))
			.get();
		const release =
			existing ??
			(await this.store(principal, artifact));

		const snapshot = this.snapshot(principal.orgId, config);
		return { release, config, snapshotId: snapshot, artifact };
	}

	/**
	 * Insert (or return) the org's release row for an artifact and upload its object. The row goes in
	 * first so a concurrent GC in another org sees the shared content-addressed key as in use.
	 */
	async store(principal: Principal, artifact: ReleaseArtifact) {
		const objectKey = objectKeyForRelease(artifact.sha256);
		// Another org's GC may be deleting this key right now; wait for that before re-uploading.
		await this.ctx.deployments.objectDeleteSettled(objectKey);
		const id = newId('rel_');
		const row: typeof releases.$inferInsert = {
			id,
			orgId: principal.orgId,
			sha256: artifact.sha256,
			objectKey,
			storage: storageKindForDb(this.ctx.objectStore.kind),
			sizeBytes: artifact.sizeBytes,
			fileCount: artifact.fileCount,
			manifestJson: JSON.stringify(artifact.manifest),
			precompressed: artifact.precompressed,
			createdBy: principal.userId,
		};
		this.ctx.db.insert(releases).values(row).onConflictDoNothing().run();
		const stored = this.ctx.db
			.select()
			.from(releases)
			.where(and(eq(releases.orgId, principal.orgId), eq(releases.sha256, artifact.sha256)))
			.get()!;
		try {
			await this.ctx.objectStore.put(objectKey, artifact.zip, 'application/zip');
		} catch (error) {
			if (stored.id === id) this.ctx.db.delete(releases).where(eq(releases.id, id)).run();
			throw error;
		}
		return stored;
	}

	private snapshot(orgId: string, config: ParsedConfig): string {
		const hash = sha256Hex(JSON.stringify(config));
		const existing = this.ctx.db
			.select({ id: configSnapshots.id })
			.from(configSnapshots)
			.where(and(eq(configSnapshots.orgId, orgId), eq(configSnapshots.hash, hash)))
			.get();
		if (existing) {
			// Reuse refreshes the timestamp so snapshot GC's grace window covers an in-flight deploy
			// that picked up an old, currently unreferenced snapshot.
			this.ctx.db.update(configSnapshots).set({ createdAt: this.ctx.now() }).where(eq(configSnapshots.id, existing.id)).run();
			return existing.id;
		}
		const id = newId('cfg_');
		this.ctx.db
			.insert(configSnapshots)
			.values({ id, orgId, hash, siteConfigJson: JSON.stringify(config) })
			.run();
		return id;
	}

	/**
	 * Delete config snapshots no deployment references and that are older than `graceMs`
	 * (docs/OPERATIONS.md L4). Returns how many were removed.
	 */
	gcSnapshots(graceMs: number, orgId?: string): number {
		const cutoff = this.ctx.now() - graceMs;
		const result = this.ctx.sqlite.run(
			`DELETE FROM config_snapshots WHERE created_at < ? ${orgId ? 'AND org_id = ?' : ''}
			 AND NOT EXISTS (SELECT 1 FROM deployments d WHERE d.config_snapshot_id = config_snapshots.id)`,
			orgId ? [cutoff, orgId] : [cutoff],
		);
		return result.changes;
	}

	get(orgId: string, id: string) {
		const row = this.ctx.db
			.select()
			.from(releases)
			.where(and(eq(releases.orgId, orgId), eq(releases.id, id)))
			.get();
		if (!row) throw new NotFoundError('Release');
		return row;
	}

	async download(release: { objectKey: string }): Promise<Uint8Array> {
		return this.ctx.objectStore.get(release.objectKey);
	}
}
