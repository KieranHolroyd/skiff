import { and, eq, inArray, lt } from 'drizzle-orm';
import { uploadSessions } from '@yoal/db';
import { limits, type InlineFile, type Principal } from '@yoal/contracts';
import { entriesFromFiles, entriesFromZip, type FileEntry } from './artifact.ts';
import type { CoreContext } from './context.ts';
import { NotFoundError, ValidationError } from './errors.ts';
import { objectKeyForUpload, storageKindForDb } from './object-store.ts';
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
		this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
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
				storage: storageKindForDb(this.ctx.objectStore.kind),
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
		options: { promote?: boolean; message?: string; environment?: string } = {},
	): Promise<DeploymentView> {
		this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
		const session = this.ctx.db
			.select()
			.from(uploadSessions)
			.where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.orgId, principal.orgId)))
			.get();
		if (!session) throw new NotFoundError('Upload');
		if (session.projectId && session.projectId !== project.id)
			throw new ValidationError(`Upload ${uploadId} was created for a different project.`);
		if (session.status === 'finalized' && session.sha256)
			throw new ValidationError('This upload has already been deployed.');
		if (session.status !== 'pending') throw new ValidationError(`Upload is ${session.status}.`);
		if (session.expiresAt < this.ctx.now()) {
			this.ctx.db.update(uploadSessions).set({ status: 'expired' }).where(eq(uploadSessions.id, uploadId)).run();
			throw new ValidationError('Upload expired before it was finalized.');
		}
		// Reject oversize uploads before buffering them (presigned PUTs carry no size cap). A finalize
		// that arrives before the PUT leaves the session pending so the client can retry.
		const storedBytes = await this.ctx.objectStore.size?.(session.objectKey);
		if (storedBytes === null)
			throw new ValidationError('Nothing has been uploaded for this session yet. PUT the zip to the upload URL first.');
		try {
			if (storedBytes !== undefined && storedBytes > limits.artifactBytes)
				throw new ValidationError(`Archive is ${storedBytes} bytes; the limit is ${limits.artifactBytes}.`);
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
			// A failed session can't be retried, so its object is dead weight.
			await this.ctx.objectStore.delete(session.objectKey).catch(() => undefined);
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
		options: { promote?: boolean; message?: string; environment?: string } = {},
	): Promise<DeploymentView> {
		const entries = UploadService.inlineEntries(files);
		const view = await this.ctx.deployments.deployEntries(principal, project, entries, options);
		this.ctx.audit.record({
			principal,
			action: 'upload.inline_deploy',
			resource: 'deployment',
			resourceId: view.id,
			args: { project: project.slug, files: files.length, environment: options.environment ?? 'production' },
			result: 'ok',
		});
		return view;
	}

	list(principal: Principal, project: ProjectRow) {
		this.ctx.iam.require(principal, 'deployment:read', { type: 'project', id: project.id });
		return this.ctx.db
			.select()
			.from(uploadSessions)
			.where(and(eq(uploadSessions.orgId, principal.orgId), eq(uploadSessions.projectId, project.id)))
			.all();
	}

	/**
	 * Expire presigned sessions past their TTL and delete their objects; called by the maintenance
	 * sweep. Failed sessions are swept too, because a client can still PUT to the presigned URL
	 * after finalize failed. The `error` column is kept for failed sessions.
	 */
	expireStale(): number {
		const stale = this.ctx.db
			.select({ id: uploadSessions.id, objectKey: uploadSessions.objectKey })
			.from(uploadSessions)
			.where(
				and(
					inArray(uploadSessions.status, ['pending', 'failed']),
					eq(uploadSessions.kind, 'presigned'),
					lt(uploadSessions.expiresAt, this.ctx.now()),
				),
			)
			.all();
		for (const row of stale) {
			this.ctx.db.update(uploadSessions).set({ status: 'expired' }).where(eq(uploadSessions.id, row.id)).run();
			void this.ctx.objectStore.delete(row.objectKey).catch(() => {});
		}
		return stale.length;
	}
}
