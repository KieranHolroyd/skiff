import { and, eq } from 'drizzle-orm';
import { uploadSessions } from '@skiff/db';
import { limits, requirePermission, type InlineFile, type Principal } from '@skiff/contracts';
import { entriesFromFiles, entriesFromZip, type FileEntry } from './artifact.ts';
import type { CoreContext } from './context.ts';
import { NotFoundError, ValidationError } from './errors.ts';
import { objectKeyForUpload } from './object-store.ts';
import type { DeploymentView } from './deployments.ts';
import type { ProjectRow } from './projects.ts';
import { newId } from './util.ts';

export interface UploadSessionView {
	uploadId: string;
	url: string;
	method: 'PUT';
	headers: Record<string, string>;
	expiresAt: string;
}

/**
 * Upload sessions (DESIGN §4, D12): inline `deploy_files` for chat agents, presigned R2 PUT for
 * shell agents and CI. Large uploads never touch the control plane.
 */
export class UploadService {
	constructor(private readonly ctx: CoreContext) {}

	async create(
		principal: Principal,
		project: ProjectRow,
		input: { fileCount?: number; totalBytes?: number } = {},
	): Promise<UploadSessionView> {
		requirePermission(principal, 'deployment:create');
		if (input.totalBytes) this.ctx.quota.assertCanUpload(principal.orgId, input.totalBytes);
		const id = newId('upl_');
		const objectKey = objectKeyForUpload(id);
		const now = this.ctx.now();
		const expiresAt = now + limits.uploadTtlSeconds * 1000;
		this.ctx.db
			.insert(uploadSessions)
			.values({
				id,
				orgId: principal.orgId,
				projectId: project.id,
				kind: 'presigned',
				status: 'pending',
				objectKey,
				storage: this.ctx.objectStore.kind,
				fileCount: input.fileCount ?? null,
				totalBytes: input.totalBytes ?? null,
				createdBy: principal.userId,
				expiresAt,
				createdAt: now,
			})
			.run();
		const url = await this.ctx.objectStore.presignPut(objectKey, limits.uploadTtlSeconds);
		this.ctx.audit.record({
			principal,
			action: 'upload.create',
			resource: 'upload',
			resourceId: id,
			args: { project: project.slug, fileCount: input.fileCount, totalBytes: input.totalBytes },
			result: 'ok',
		});
		return {
			uploadId: id,
			url,
			method: 'PUT',
			headers: { 'content-type': 'application/zip' },
			expiresAt: new Date(expiresAt).toISOString(),
		};
	}

	async finalize(
		principal: Principal,
		project: ProjectRow,
		uploadId: string,
		options: { promote?: boolean; message?: string } = {},
	): Promise<DeploymentView> {
		requirePermission(principal, 'deployment:create');
		const session = this.ctx.db
			.select()
			.from(uploadSessions)
			.where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.orgId, principal.orgId)))
			.get();
		if (!session) throw new NotFoundError('Upload');
		if (session.status === 'finalized' && session.sha256)
			throw new ValidationError('This upload has already been deployed.');
		if (session.status !== 'pending') throw new ValidationError(`Upload is ${session.status}.`);
		if (session.expiresAt < this.ctx.now()) {
			this.ctx.db.update(uploadSessions).set({ status: 'expired' }).where(eq(uploadSessions.id, uploadId)).run();
			throw new ValidationError('Upload expired before it was finalized.');
		}
		try {
			const zip = await this.ctx.objectStore.get(session.objectKey);
			const entries = entriesFromZip(zip);
			if (session.totalBytes && entries.reduce((sum, entry) => sum + entry.data.byteLength, 0) > session.totalBytes)
				throw new ValidationError('Uploaded artifact is larger than the declared size.');
			const view = await this.ctx.deployments.deployEntries(principal, project, entries, options);
			this.ctx.db
				.update(uploadSessions)
				.set({ status: 'finalized', sha256: view.release.sha256, finalizedAt: this.ctx.now() })
				.where(eq(uploadSessions.id, uploadId))
				.run();
			// The upload object is redundant once the release is stored.
			await this.ctx.objectStore.delete(session.objectKey);
			return view;
		} catch (error) {
			this.ctx.db
				.update(uploadSessions)
				.set({ status: 'failed', error: (error as Error).message })
				.where(eq(uploadSessions.id, uploadId))
				.run();
			throw error;
		}
	}

	/** Inline deploy: decode the files an MCP client sent, never write them to disk first. */
	static inlineEntries(files: InlineFile[]): FileEntry[] {
		const decoded = files.map((file) => ({
			path: file.path,
			data:
				file.encoding === 'base64'
					? new Uint8Array(Buffer.from(file.content, 'base64'))
					: new TextEncoder().encode(file.content),
		}));
		const total = decoded.reduce((sum, entry) => sum + entry.data.byteLength, 0);
		if (total > limits.inlineBytes)
			throw new ValidationError(
				`Inline deploy is ${total} bytes; the limit is ${limits.inlineBytes}. Use create_upload for larger sites.`,
			);
		return entriesFromFiles(decoded);
	}

	async deployInline(
		principal: Principal,
		project: ProjectRow,
		files: InlineFile[],
		options: { promote?: boolean; message?: string } = {},
	): Promise<DeploymentView> {
		const entries = UploadService.inlineEntries(files);
		const view = await this.ctx.deployments.deployEntries(principal, project, entries, options);
		this.ctx.audit.record({
			principal,
			action: 'upload.inline_deploy',
			resource: 'deployment',
			resourceId: view.id,
			args: { project: project.slug, files: files.length },
			result: 'ok',
		});
		return view;
	}

	list(principal: Principal, project: ProjectRow) {
		requirePermission(principal, 'deployment:read');
		return this.ctx.db
			.select()
			.from(uploadSessions)
			.where(and(eq(uploadSessions.orgId, principal.orgId), eq(uploadSessions.projectId, project.id)))
			.all();
	}

	/** Expire sessions that were never finalized; called by the maintenance sweep. */
	expireStale(): number {
		const now = this.ctx.now();
		const stale = this.ctx.db
			.select({ id: uploadSessions.id, objectKey: uploadSessions.objectKey })
			.from(uploadSessions)
			.where(and(eq(uploadSessions.status, 'pending'), eq(uploadSessions.kind, 'presigned')))
			.all()
			.filter((row) => {
				const session = this.ctx.db.select().from(uploadSessions).where(eq(uploadSessions.id, row.id)).get();
				return session ? session.expiresAt < now : false;
			});
		for (const row of stale) {
			this.ctx.db.update(uploadSessions).set({ status: 'expired' }).where(eq(uploadSessions.id, row.id)).run();
			void this.ctx.objectStore.delete(row.objectKey).catch(() => {});
		}
		return stale.length;
	}
}
