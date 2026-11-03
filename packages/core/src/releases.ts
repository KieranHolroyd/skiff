import { and, eq } from 'drizzle-orm';
import { configSnapshots, releases } from '@skiff/db';
import { parseSiteConfig, SiteConfigError, type ParsedConfig } from '@skiff/site-config';
import { requirePermission, type Principal } from '@skiff/contracts';
import { buildArtifact, entryMap, type FileEntry, type ReleaseArtifact } from './artifact.ts';
import type { CoreContext } from './context.ts';
import { NotFoundError, ValidationError } from './errors.ts';
import { objectKeyForRelease } from './object-store.ts';
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

	async prepare(principal: Principal, entries: FileEntry[], options: { precompress?: boolean } = {}): Promise<PreparedRelease> {
		requirePermission(principal, 'deployment:create');
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

	private async store(principal: Principal, artifact: ReleaseArtifact) {
		const objectKey = objectKeyForRelease(artifact.sha256);
		await this.ctx.objectStore.put(objectKey, artifact.zip, 'application/zip');
		const row: typeof releases.$inferInsert = {
			id: newId('rel_'),
			orgId: principal.orgId,
			sha256: artifact.sha256,
			objectKey,
			storage: this.ctx.objectStore.kind,
			sizeBytes: artifact.sizeBytes,
			fileCount: artifact.fileCount,
			manifestJson: JSON.stringify(artifact.manifest),
			precompressed: artifact.precompressed,
			createdBy: principal.userId,
		};
		this.ctx.db.insert(releases).values(row).run();
		return this.ctx.db
			.select()
			.from(releases)
			.where(and(eq(releases.orgId, principal.orgId), eq(releases.sha256, artifact.sha256)))
			.get()!;
	}

	private snapshot(orgId: string, config: ParsedConfig): string {
		const hash = sha256Hex(JSON.stringify(config));
		const existing = this.ctx.db
			.select({ id: configSnapshots.id })
			.from(configSnapshots)
			.where(and(eq(configSnapshots.orgId, orgId), eq(configSnapshots.hash, hash)))
			.get();
		if (existing) return existing.id;
		const id = newId('cfg_');
		this.ctx.db
			.insert(configSnapshots)
			.values({ id, orgId, hash, siteConfigJson: JSON.stringify(config) })
			.run();
		return id;
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
