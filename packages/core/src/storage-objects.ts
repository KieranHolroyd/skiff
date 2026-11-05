import { and, eq } from 'drizzle-orm';
import { storageBuckets } from '@skiff/db';
import {
	STORAGE_REGION,
	requirePermission,
	storageFolderSchema,
	storageGatewayHost,
	storageObjectKeySchema,
	type Principal,
	type StorageObjectDelete,
	type StorageObjectList,
	type StorageObjectStat,
	type StoragePresign,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError } from './errors.ts';
import type { StorageRow } from './storage-instances.ts';
import { S3Client, presignPublicUrl } from './storage-s3.ts';

type BucketRow = typeof storageBuckets.$inferSelect;

/**
 * The control plane's object browser (D82): list, stat, download, upload, delete and folder
 * creation for one managed storage instance.
 *
 * Every request goes through the instance's node gateway with the root key. The root key never
 * leaves the control plane; downloads are streamed back to the browser and uploads are capped.
 * Mutations are audited; reads are not (they would drown the audit log).
 */
function formatLimit(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${Math.floor(bytes / 1024 / 1024)} MB` : `${bytes} bytes`;
}

export class StorageObjectsService {
	constructor(private readonly ctx: CoreContext) {}

	private client(row: StorageRow): S3Client {
		return new S3Client({
			endpoint: `http://127.0.0.1:${this.ctx.config.storageGatewayPort ?? 8081}`,
			host: storageGatewayHost(row.id),
			accessKeyId: row.rootAccessKey,
			secretAccessKey: this.ctx.secrets.open(row.orgId, row.rootSecret),
			region: STORAGE_REGION,
			fetch: this.ctx.config.storageFetch,
		});
	}

	private bucket(row: StorageRow, name: string): BucketRow {
		const bucket = this.ctx.db
			.select()
			.from(storageBuckets)
			.where(and(eq(storageBuckets.storageId, row.id), eq(storageBuckets.name, name)))
			.get();
		if (!bucket) throw new NotFoundError(`Bucket "${name}"`);
		return bucket;
	}

	private writable(bucket: BucketRow): void {
		if (bucket.deleteRequestedAt)
			throw new ConflictError(
				`Bucket "${bucket.name}" is being deleted. Re-create it to cancel the delete before changing objects.`,
			);
	}

	private limit(): number {
		return this.ctx.config.storageObjectMaxBytes ?? 104_857_600;
	}

	/** Largest single upload accepted through the control plane. */
	get maxUploadBytes(): number {
		return this.limit();
	}

	// ---------------------------------------------------------------- reads

	async list(
		principal: Principal,
		name: string,
		input: { bucket: string; prefix?: string; delimiter?: string; token?: string; limit?: number },
	): Promise<StorageObjectList> {
		requirePermission(principal, 'storage:read');
		const row = this.ctx.storage.requireRow(principal, name);
		this.bucket(row, input.bucket);
		return this.client(row).listObjects(input.bucket, {
			prefix: input.prefix ?? '',
			delimiter: input.delimiter ?? '/',
			token: input.token,
			maxKeys: input.limit,
		});
	}

	async stat(principal: Principal, name: string, bucket: string, key: string): Promise<StorageObjectStat> {
		requirePermission(principal, 'storage:read');
		const row = this.ctx.storage.requireRow(principal, name);
		this.bucket(row, bucket);
		const safeKey = storageObjectKeySchema.parse(key);
		const head = await this.client(row).headObject(bucket, safeKey);
		return {
			key: safeKey,
			sizeBytes: head.sizeBytes,
			etag: head.etag,
			lastModified: head.lastModified,
			storageClass: null,
			contentType: head.contentType,
		};
	}

	/** Raw object response; the REST layer streams it and sets the download headers. */
	async download(
		principal: Principal,
		name: string,
		bucket: string,
		key: string,
	): Promise<{ response: Response; key: string; contentType: string | null; etag: string | null }> {
		requirePermission(principal, 'storage:read');
		const row = this.ctx.storage.requireRow(principal, name);
		this.bucket(row, bucket);
		const safeKey = storageObjectKeySchema.parse(key);
		const response = await this.client(row).getObject(bucket, safeKey);
		return {
			response,
			key: safeKey,
			contentType: response.headers.get('content-type'),
			etag: response.headers.get('etag')?.replace(/^"|"$/g, '') ?? null,
		};
	}

	// ---------------------------------------------------------------- mutations

	async upload(
		principal: Principal,
		name: string,
		bucket: string,
		key: string,
		body: Uint8Array,
		contentType?: string | null,
	): Promise<StorageObjectStat> {
		requirePermission(principal, 'storage:update');
		const row = this.ctx.storage.requireRow(principal, name);
		const bucketRow = this.bucket(row, bucket);
		this.writable(bucketRow);
		const safeKey = storageObjectKeySchema.parse(key);
		const max = this.limit();
		if (body.byteLength > max)
			throw new CoreError(
				'payload_too_large',
				`Objects uploaded through the control plane are limited to ${formatLimit(max)}; use a presigned upload for larger files.`,
				413,
			);
		this.ctx.quota.assertCanCreateObject(row.orgId, null, 1, body.byteLength);
		const result = await this.client(row).putObject(
			bucket,
			safeKey,
			body,
			contentType || 'application/octet-stream',
		);
		this.ctx.audit.record({
			principal,
			action: 'storage.object.upload',
			resource: 'storage',
			resourceId: row.id,
			args: { name, bucket, key: safeKey, bytes: body.byteLength },
			result: 'ok',
		});
		return {
			key: safeKey,
			sizeBytes: body.byteLength,
			etag: result.etag,
			lastModified: new Date(this.ctx.now()).toISOString(),
			storageClass: null,
			contentType: contentType || 'application/octet-stream',
		};
	}

	async remove(principal: Principal, name: string, bucket: string, input: StorageObjectDelete): Promise<{ deleted: string[]; errors: Array<{ key: string; code: string; message: string }> }> {
		requirePermission(principal, 'storage:update');
		const row = this.ctx.storage.requireRow(principal, name);
		const bucketRow = this.bucket(row, bucket);
		this.writable(bucketRow);
		const keys = input.keys.map((key) => storageObjectKeySchema.parse(key));
		const result = await this.client(row).deleteObjects(bucket, keys);
		this.ctx.audit.record({
			principal,
			action: 'storage.object.delete',
			resource: 'storage',
			resourceId: row.id,
			args: { name, bucket, keys, deleted: result.deleted.length, failed: result.errors.length },
			result: 'ok',
		});
		return result;
	}

	/** Create a folder marker (a zero-byte object whose key ends in `/`). */
	async folder(principal: Principal, name: string, bucket: string, rawPrefix: string): Promise<{ prefix: string }> {
		requirePermission(principal, 'storage:update');
		const row = this.ctx.storage.requireRow(principal, name);
		const bucketRow = this.bucket(row, bucket);
		this.writable(bucketRow);
		const { prefix } = storageFolderSchema.parse({ prefix: rawPrefix });
		this.ctx.quota.assertCanCreateObject(row.orgId, null, 1, 0);
		await this.client(row).putObject(bucket, prefix, new Uint8Array(), 'application/x-directory');
		this.ctx.audit.record({
			principal,
			action: 'storage.object.folder',
			resource: 'storage',
			resourceId: row.id,
			args: { name, bucket, prefix },
			result: 'ok',
		});
		return { prefix };
	}

	/** Presigned browser URL; only public instances have a reachable endpoint (D64). */
	async presign(principal: Principal, name: string, bucket: string, input: StoragePresign): Promise<{ url: string; method: 'GET' | 'PUT'; expiresIn: number }> {
		requirePermission(principal, 'storage:read');
		const row = this.ctx.storage.requireRow(principal, name);
		this.bucket(row, bucket);
		if (!row.public || !row.publicHost)
			throw new ConflictError(
				'Presigned URLs need a public instance. Private instances are only reachable through the control-plane download, or attach the instance to an app.',
			);
		const url = await presignPublicUrl({
			endpoint: `https://${row.publicHost}`,
			bucket,
			key: input.key,
			method: input.method,
			expiresIn: input.expiresIn,
			accessKeyId: row.rootAccessKey,
			secretAccessKey: this.ctx.secrets.open(row.orgId, row.rootSecret),
		});
		return { url, method: input.method, expiresIn: input.expiresIn };
	}
}
