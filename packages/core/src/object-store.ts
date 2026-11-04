import { AwsClient } from 'aws4fetch';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
	/** Stored size in bytes, or null when the object is missing. Lets finalize reject oversize uploads before downloading them. */
	size?(key: string): Promise<number | null>;
	/** Browser/CLI PUT URL. */
	presignPut(key: string, ttlSeconds: number, contentType?: string): Promise<string>;
	/** Agent GET URL. */
	presignGet(key: string, ttlSeconds: number): Promise<string>;
	/**
	 * Every object under `prefix` (e.g. `releases/`), in pages. Prune uses it to find objects with
	 * no row (docs/OPERATIONS.md L6). Optional so third-party stores without listing still work;
	 * prune then skips the `objects` category and says why.
	 */
	list?(prefix: string): AsyncIterable<StoredObject>;
}

export interface StoredObject {
	key: string;
	size: number;
	/** Epoch milliseconds. */
	lastModified: number;
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

	async size(key: string): Promise<number | null> {
		try {
			const info = await stat(this.path(key));
			return info.isFile() ? info.size : null;
		} catch {
			return null;
		}
	}

	async *list(prefix: string): AsyncIterable<StoredObject> {
		const base = resolve(this.root);
		const start = resolve(join(base, normalize(prefix)));
		if (start !== base && !start.startsWith(base + '/')) throw new Error('Invalid object prefix');
		let entries: string[];
		try {
			entries = (await readdir(start, { recursive: true })) as string[];
		} catch {
			return;
		}
		for (const entry of entries.sort()) {
			const full = join(start, entry);
			const info = await stat(full).catch(() => null);
			if (!info?.isFile()) continue;
			yield { key: full.slice(base.length + 1), size: info.size, lastModified: info.mtimeMs };
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

	async size(key: string): Promise<number | null> {
		const response = await this.client.fetch(this.url(key), { method: 'HEAD' });
		if (!response.ok) return null;
		const length = Number(response.headers.get('content-length'));
		return Number.isFinite(length) ? length : null;
	}

	async *list(prefix: string): AsyncIterable<StoredObject> {
		let token: string | undefined;
		do {
			const url = new URL(`${this.endpoint}/${this.options.bucket}`);
			url.searchParams.set('list-type', '2');
			url.searchParams.set('prefix', prefix);
			url.searchParams.set('max-keys', '1000');
			if (token) url.searchParams.set('continuation-token', token);
			const response = await this.client.fetch(url);
			if (!response.ok) throw new Error(`R2 LIST ${prefix} failed: ${response.status} ${await response.text()}`);
			const page = parseListObjects(await response.text());
			yield* page.objects;
			token = page.nextToken;
		} while (token);
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

const xmlEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (value: string): string =>
	value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, name: string) => xmlEntities[name]!);
const xmlTag = (xml: string, tag: string): string | undefined =>
	xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];

/** Parse one S3 ListObjectsV2 response page (R2, MinIO and Garage all speak it). */
export function parseListObjects(xml: string): { objects: StoredObject[]; nextToken?: string } {
	const objects: StoredObject[] = [];
	for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
		const body = match[1]!;
		const key = xmlTag(body, 'Key');
		if (key === undefined) continue;
		const modified = Date.parse(xmlTag(body, 'LastModified') ?? '');
		objects.push({
			key: unescapeXml(key),
			size: Number(xmlTag(body, 'Size') ?? 0),
			lastModified: Number.isFinite(modified) ? modified : 0,
		});
	}
	const truncated = xmlTag(xml, 'IsTruncated') === 'true';
	const next = xmlTag(xml, 'NextContinuationToken');
	return { objects, ...(truncated && next ? { nextToken: unescapeXml(next) } : {}) };
}

export function objectKeyForUpload(id: string): string {
	return `uploads/${id}.zip`;
}

export function objectKeyForRelease(sha256: string): string {
	return `releases/${sha256}.zip`;
}

export { randomToken };
