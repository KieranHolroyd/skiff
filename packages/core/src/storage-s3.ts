import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { STORAGE_REGION, type StorageObjectList } from '@skiff/contracts';
import { CoreError, NotFoundError } from './errors.ts';

/**
 * A minimal S3 client for the control plane's object browser (D82).
 *
 * Requests are SigV4-signed for the instance's *internal* host
 * (`s3-<id>.storage.internal`) but sent to the edge's loopback gateway, which routes them to the
 * right node. Signing the internal host and then overriding `Host` on the wire keeps the signature
 * valid end-to-end: Caddy preserves `Host` on both hops and RustFS verifies the same value.
 *
 * This is deliberately not a general S3 SDK: ListObjectsV2, Get/Head/Put/Delete and DeleteObjects
 * are all the control plane needs.
 */

export interface S3ClientOptions {
	/** Loopback gateway, e.g. `http://127.0.0.1:8081`. */
	endpoint: string;
	/** Host the request is signed for and routed by, e.g. `s3-abc.storage.internal`. */
	host: string;
	accessKeyId: string;
	secretAccessKey: string;
	region?: string;
	/** Injected for tests. */
	fetch?: typeof fetch;
}

export interface S3ListOptions {
	prefix?: string;
	delimiter?: string;
	token?: string;
	maxKeys?: number;
}

export interface S3DeleteResult {
	deleted: string[];
	errors: Array<{ key: string; code: string; message: string }>;
}

export class S3Client {
	private readonly endpoint: string;
	private readonly host: string;
	private readonly aws: AwsClient;
	private readonly transport: typeof fetch;

	constructor(options: S3ClientOptions) {
		this.endpoint = options.endpoint.replace(/\/+$/, '');
		this.host = options.host;
		this.aws = new AwsClient({
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			service: 's3',
			region: options.region ?? STORAGE_REGION,
		});
		this.transport = options.fetch ?? fetch;
	}

	/** Path-style URL for a bucket or object (`/bucket/key`). */
	private path(bucket: string, key?: string): string {
		const encodedBucket = encodeURIComponent(bucket);
		if (key === undefined) return `/${encodedBucket}`;
		return `/${encodedBucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
	}

	private async send(
		method: string,
		path: string,
		options: {
			query?: Record<string, string | number | undefined>;
			headers?: Record<string, string>;
			body?: Uint8Array;
		} = {},
	): Promise<Response> {
		const signUrl = new URL(path, `http://${this.host}`);
		for (const [name, value] of Object.entries(options.query ?? {}))
			if (value !== undefined) signUrl.searchParams.set(name, String(value));

		const headers: Record<string, string> = { ...(options.headers ?? {}) };
		// Bun's `BodyInit` does not include a typed array; an ArrayBuffer keeps the bytes and the
		// payload hash identical.
		const payload = options.body
			? (options.body.slice().buffer as ArrayBuffer)
			: undefined;
		const signed = await this.aws.sign(signUrl.toString(), {
			method,
			headers,
			...(payload ? { body: payload } : {}),
		});
		const outgoing = new Headers(signed.headers);
		// The gateway routes by this Host and RustFS verifies it; the connection still goes to the
		// loopback endpoint above.
		outgoing.set('host', this.host);
		return this.transport(`${this.endpoint}${path}${signUrl.search}`, {
			method,
			headers: outgoing,
			...(payload ? { body: payload } : {}),
		});
	}

	private async fail(response: Response): Promise<never> {
		const text = await response.text().catch(() => '');
		const code = xmlTag(text, 'Code') ?? `HTTP${response.status}`;
		const message = xmlTag(text, 'Message') ?? response.statusText;
		if (response.status === 404 || code === 'NoSuchKey' || code === 'NoSuchBucket')
			throw new NotFoundError(message || code);
		if (response.status === 403 || code === 'AccessDenied')
			throw new CoreError('forbidden', message || code, 403);
		throw new CoreError(code.toLowerCase(), `${code}: ${message}`, 502);
	}

	async listObjects(bucket: string, options: S3ListOptions = {}): Promise<StorageObjectList> {
		const response = await this.send('GET', this.path(bucket), {
			query: {
				'list-type': 2,
				prefix: options.prefix || undefined,
				delimiter: options.delimiter || undefined,
				'continuation-token': options.token || undefined,
				'max-keys': Math.min(1000, Math.max(1, options.maxKeys ?? 100)),
			},
		});
		if (!response.ok) await this.fail(response);
		const xml = await response.text();
		const objects = xmlBlocks(xml, 'Contents').map((block) => ({
			key: unescapeXml(xmlTag(block, 'Key') ?? ''),
			sizeBytes: Number(xmlTag(block, 'Size') ?? 0),
			etag: trimEtag(xmlTag(block, 'ETag') ? unescapeXml(xmlTag(block, 'ETag')!) : null),
			lastModified: xmlTag(block, 'LastModified'),
			storageClass: xmlTag(block, 'StorageClass'),
		}));
		const prefixes = xmlBlocks(xml, 'CommonPrefixes')
			.map((block) => unescapeXml(xmlTag(block, 'Prefix') ?? ''))
			.filter(Boolean);
		return {
			bucket,
			prefix: options.prefix ?? '',
			delimiter: options.delimiter ?? '',
			objects,
			prefixes,
			isTruncated: xmlTag(xml, 'IsTruncated') === 'true',
			nextToken: xmlTag(xml, 'NextContinuationToken'),
		};
	}

	async headObject(bucket: string, key: string): Promise<{ sizeBytes: number; contentType: string | null; etag: string | null; lastModified: string | null }> {
		const response = await this.send('HEAD', this.path(bucket, key));
		if (!response.ok) await this.fail(response);
		return {
			sizeBytes: Number(response.headers.get('content-length') ?? 0),
			contentType: response.headers.get('content-type'),
			etag: trimEtag(response.headers.get('etag')),
			lastModified: response.headers.get('last-modified'),
		};
	}

	/** Raw GET; the caller streams the body to the browser. */
	/** `range` is a single `bytes=` range, passed through so media can seek (206 is returned as-is). */
	async getObject(bucket: string, key: string, range?: string): Promise<Response> {
		const response = await this.send('GET', this.path(bucket, key), {
			...(range ? { headers: { range } } : {}),
		});
		if (response.status === 416)
			throw new CoreError('range_not_satisfiable', 'The requested range is outside the object.', 416);
		if (!response.ok) await this.fail(response);
		return response;
	}

	async putObject(
		bucket: string,
		key: string,
		body: Uint8Array,
		contentType = 'application/octet-stream',
	): Promise<{ etag: string | null }> {
		const response = await this.send('PUT', this.path(bucket, key), {
			headers: { 'content-type': contentType },
			body,
		});
		if (!response.ok) await this.fail(response);
		return { etag: trimEtag(response.headers.get('etag')) };
	}

	async deleteObjects(bucket: string, keys: string[]): Promise<S3DeleteResult> {
		const xml =
			'<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>false</Quiet>' +
			keys.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join('') +
			'</Delete>';
		const body = new TextEncoder().encode(xml);
		const md5 = createHash('md5').update(body).digest('base64');
		const response = await this.send('POST', this.path(bucket), {
			query: { delete: '' },
			headers: { 'content-type': 'application/xml', 'content-md5': md5 },
			body,
		});
		if (!response.ok) await this.fail(response);
		const result = await response.text();
		return {
			deleted: xmlBlocks(result, 'Deleted')
				.map((block) => unescapeXml(xmlTag(block, 'Key') ?? ''))
				.filter(Boolean),
			errors: xmlBlocks(result, 'Error').map((block) => ({
				key: unescapeXml(xmlTag(block, 'Key') ?? ''),
				code: xmlTag(block, 'Code') ?? 'Error',
				message: xmlTag(block, 'Message') ?? 'Delete failed',
			})),
		};
	}
}

/** Sign a browser-facing URL for a public instance. Private instances have no reachable host. */
export async function presignPublicUrl(options: {
	endpoint: string;
	bucket: string;
	key: string;
	method: 'GET' | 'PUT';
	expiresIn: number;
	accessKeyId: string;
	secretAccessKey: string;
	region?: string;
}): Promise<string> {
	const url = new URL(`${options.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(options.bucket)}/${options.key
		.split('/')
		.map(encodeURIComponent)
		.join('/')}`);
	url.searchParams.set('X-Amz-Expires', String(options.expiresIn));
	const client = new AwsClient({
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		service: 's3',
		region: options.region ?? STORAGE_REGION,
	});
	const signed = await client.sign(url, { method: options.method, aws: { signQuery: true } });
	return signed.url;
}

// -------------------------------------------------------------------- XML

export function xmlTag(xml: string, tag: string): string | null {
	const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
	return match ? match[1]!.trim() : null;
}

export function xmlBlocks(xml: string, tag: string): string[] {
	const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
	return [...xml.matchAll(pattern)].map((match) => match[1]!);
}

export function unescapeXml(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function trimEtag(value: string | null): string | null {
	return value ? value.replace(/^"|"$/g, '') : null;
}
