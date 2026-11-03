import { AwsClient } from 'aws4fetch';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { hmac, randomToken, safeEqual } from './util.ts';

/**
 * Artifact storage (DESIGN §10, D25). R2 is canonical in v1; a local filesystem store exists
 * for development and single-node installs. Presigned URLs let large uploads go direct to R2
 * and let agents download releases without an extra hop through the control plane.
 */
export interface ObjectStore {
	readonly kind: 'local' | 'r2';
	put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
	get(key: string): Promise<Uint8Array>;
	delete(key: string): Promise<void>;
	exists(key: string): Promise<boolean>;
	/** Browser/CLI PUT URL. */
	presignPut(key: string, ttlSeconds: number, contentType?: string): Promise<string>;
	/** Agent GET URL. */
	presignGet(key: string, ttlSeconds: number): Promise<string>;
}

export class LocalObjectStore implements ObjectStore {
	readonly kind = 'local' as const;
	constructor(
		private readonly root: string,
		private readonly publicUrl: string,
		private readonly signingSecret: string,
	) {}

	private path(key: string): string {
		const full = resolve(join(this.root, normalize(key)));
		if (!full.startsWith(resolve(this.root) + '/')) throw new Error('Invalid object key');
		return full;
	}

	async put(key: string, data: Uint8Array, _contentType?: string): Promise<void> {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, data);
	}

	async get(key: string): Promise<Uint8Array> {
		return new Uint8Array(await readFile(this.path(key)));
	}

	async delete(key: string): Promise<void> {
		await rm(this.path(key), { force: true });
	}

	async exists(key: string): Promise<boolean> {
		try {
			return (await stat(this.path(key))).isFile();
		} catch {
			return false;
		}
	}

	async presignPut(key: string, ttlSeconds: number): Promise<string> {
		return this.sign('PUT', key, ttlSeconds);
	}

	async presignGet(key: string, ttlSeconds: number): Promise<string> {
		return this.sign('GET', key, ttlSeconds);
	}

	private sign(method: 'GET' | 'PUT', key: string, ttlSeconds: number): string {
		const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
		const signature = hmac(this.signingSecret, `${method}\n${key}\n${exp}`);
		return `${this.publicUrl}/api/objects/${key}?exp=${exp}&sig=${signature}`;
	}

	/** Verify a presigned URL produced by `presignPut` / `presignGet`. */
	verify(method: 'GET' | 'PUT', key: string, exp: number, signature: string): boolean {
		if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
		return safeEqual(hmac(this.signingSecret, `${method}\n${key}\n${exp}`), signature);
	}
}

export interface R2Options {
	accountId: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Optional custom endpoint (MinIO, Garage); defaults to R2. */
	endpoint?: string;
}

export class R2ObjectStore implements ObjectStore {
	readonly kind = 'r2' as const;
	private readonly client: AwsClient;
	private readonly endpoint: string;
	constructor(private readonly options: R2Options) {
		this.client = new AwsClient({
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			service: 's3',
			region: 'auto',
		});
		this.endpoint =
			options.endpoint?.replace(/\/$/, '') ?? `https://${options.accountId}.r2.cloudflarestorage.com`;
	}

	private url(key: string): URL {
		return new URL(`${this.endpoint}/${this.options.bucket}/${key}`);
	}

	async put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
		const headers: Record<string, string> = {};
		if (contentType) headers['content-type'] = contentType;
		const response = await this.client.fetch(this.url(key), {
			method: 'PUT',
			body: data as never,
			headers,
		});
		if (!response.ok)
			throw new Error(`R2 PUT ${key} failed: ${response.status} ${await response.text()}`);
	}

	async get(key: string): Promise<Uint8Array> {
		const response = await this.client.fetch(this.url(key));
		if (!response.ok) throw new Error(`R2 GET ${key} failed: ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	}

	async delete(key: string): Promise<void> {
		const response = await this.client.fetch(this.url(key), { method: 'DELETE' });
		if (!response.ok && response.status !== 404)
			throw new Error(`R2 DELETE ${key} failed: ${response.status}`);
	}

	async exists(key: string): Promise<boolean> {
		const response = await this.client.fetch(this.url(key), { method: 'HEAD' });
		return response.ok;
	}

	private async presign(method: 'GET' | 'PUT', key: string, ttlSeconds: number): Promise<string> {
		const url = this.url(key);
		url.searchParams.set('X-Amz-Expires', String(ttlSeconds));
		const signed = await this.client.sign(new Request(url.toString(), { method }), {
			aws: { signQuery: true },
		});
		return signed.url;
	}

	presignPut(key: string, ttlSeconds: number): Promise<string> {
		return this.presign('PUT', key, ttlSeconds);
	}

	presignGet(key: string, ttlSeconds: number): Promise<string> {
		return this.presign('GET', key, ttlSeconds);
	}
}

export function objectKeyForUpload(id: string): string {
	return `uploads/${id}.zip`;
}

export function objectKeyForRelease(sha256: string): string {
	return `releases/${sha256}.zip`;
}

export { randomToken };
