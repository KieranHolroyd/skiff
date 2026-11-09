import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A small OCI distribution client for `yoal/image-index` (docs/PIPELINES.md §4.3, W6): the token
 * flow (401 `WWW-Authenticate: Bearer realm,service,scope` → GET realm with Basic credentials →
 * bearer), manifests and blobs, cross-repository blob mounts and copies, and writing one OCI image
 * index from per-architecture images. No Docker, skopeo or crane in the job image.
 */

export const MEDIA_TYPES = {
	ociIndex: 'application/vnd.oci.image.index.v1+json',
	ociManifest: 'application/vnd.oci.image.manifest.v1+json',
	dockerList: 'application/vnd.docker.distribution.manifest.list.v2+json',
	dockerManifest: 'application/vnd.docker.distribution.manifest.v2+json',
} as const;

const MANIFEST_ACCEPT = [MEDIA_TYPES.ociIndex, MEDIA_TYPES.ociManifest, MEDIA_TYPES.dockerList, MEDIA_TYPES.dockerManifest].join(', ');
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export class RegistryError extends Error {
	constructor(
		message: string,
		readonly status = 0,
	) {
		super(message);
		this.name = 'RegistryError';
	}
}

export interface ImageReference {
	/** `ghcr.io`, `registry.example.com:5000`, or `docker.io`. */
	registry: string;
	/** `acme/api` (`library/<name>` on Docker Hub). */
	repository: string;
	tag: string | null;
	digest: string | null;
}

/** `[host/]repo[:tag][@digest]` in the usual Docker rules (a first segment with `.`/`:` or `localhost` is a host). */
export function parseImageReference(reference: string): ImageReference {
	const trimmed = reference.trim();
	if (!trimmed) throw new RegistryError('Empty image reference');
	const [nameAndTag, digest = null] = trimmed.split('@', 2) as [string, string | undefined];
	if (digest !== null && !DIGEST.test(digest)) throw new RegistryError(`Unsupported digest in "${reference}" (expected sha256:<64 hex>)`);
	const slash = nameAndTag.lastIndexOf('/');
	const colon = nameAndTag.lastIndexOf(':');
	const name = colon > slash ? nameAndTag.slice(0, colon) : nameAndTag;
	const tag = colon > slash ? nameAndTag.slice(colon + 1) : null;
	const first = name.split('/')[0]!;
	const hasHost = name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
	const registry = hasHost ? first : 'docker.io';
	let repository = hasHost ? name.slice(first.length + 1) : name;
	if (registry === 'docker.io' && !repository.includes('/')) repository = `library/${repository}`;
	if (!/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/.test(repository))
		throw new RegistryError(`Invalid repository "${repository}" in "${reference}"`);
	if (tag !== null && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new RegistryError(`Invalid tag "${tag}" in "${reference}"`);
	return { registry, repository, tag, digest: digest ?? null };
}

export function formatImageReference(ref: ImageReference, form: 'tag' | 'digest' = ref.digest ? 'digest' : 'tag'): string {
	const repository = ref.registry === 'docker.io' ? ref.repository.replace(/^library\//, '') : ref.repository;
	const name = `${ref.registry}/${repository}`;
	if (form === 'digest' && ref.digest) return `${name}@${ref.digest}`;
	return ref.tag ? `${name}:${ref.tag}` : name;
}

export interface RegistryCredentials {
	username: string;
	password: string;
}

export interface RegistryClientOptions {
	/** Credentials per registry host (Basic for the token realm, or a Basic registry). */
	credentials?: (host: string) => RegistryCredentials | null;
	/** Hosts spoken to over plain HTTP. Default: localhost, 127.0.0.0/8 and [::1]. */
	plainHttp?: (host: string) => boolean;
	fetch?: typeof fetch;
	/** Spool directory for blobs copied between registries. */
	tempDir?: string;
}

function defaultPlainHttp(host: string): boolean {
	const name = host.replace(/:\d+$/, '');
	return name === 'localhost' || name === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(name);
}

/** Parse `Bearer realm="…",service="…",scope="…"` (or `Basic realm="…"`). */
export function parseChallenge(header: string): { scheme: string; params: Record<string, string> } | null {
	const match = /^\s*(\w+)\s*(.*)$/s.exec(header);
	if (!match) return null;
	const params: Record<string, string> = {};
	for (const pair of match[2]!.matchAll(/([A-Za-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g)) params[pair[1]!.toLowerCase()] = pair[2] !== undefined ? pair[2].replace(/\\(.)/g, '$1') : pair[3]!;
	return { scheme: match[1]!.toLowerCase(), params };
}

export function sha256Digest(data: Uint8Array): string {
	return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

export interface FetchedManifest {
	mediaType: string;
	digest: string;
	bytes: Uint8Array;
	json: ManifestJson;
}

export interface Descriptor {
	mediaType: string;
	digest: string;
	size: number;
	platform?: Platform;
	annotations?: Record<string, string>;
	[key: string]: unknown;
}

export interface Platform {
	architecture: string;
	os: string;
	variant?: string;
	'os.version'?: string;
	'os.features'?: string[];
}

interface ManifestJson {
	schemaVersion?: number;
	mediaType?: string;
	config?: Descriptor;
	layers?: Descriptor[];
	manifests?: Descriptor[];
	subject?: Descriptor;
	[key: string]: unknown;
}

export function isIndexMediaType(mediaType: string): boolean {
	return mediaType === MEDIA_TYPES.ociIndex || mediaType === MEDIA_TYPES.dockerList;
}

type Body = string | Uint8Array | Blob;

export class RegistryClient {
	private readonly credentials: (host: string) => RegistryCredentials | null;
	private readonly plainHttp: (host: string) => boolean;
	private readonly fetcher: typeof fetch;
	private readonly tempDir: string | undefined;
	/** `host scope…` → Authorization header value that worked last. */
	private readonly auth = new Map<string, string>();

	constructor(options: RegistryClientOptions = {}) {
		this.credentials = options.credentials ?? (() => null);
		this.plainHttp = options.plainHttp ?? defaultPlainHttp;
		this.fetcher = options.fetch ?? fetch;
		this.tempDir = options.tempDir;
	}

	endpoint(host: string): string {
		if (host === 'docker.io') return 'https://registry-1.docker.io';
		return `${this.plainHttp(host) ? 'http' : 'https'}://${host}`;
	}

	/**
	 * One registry request with the token dance: a 401 carrying a Bearer challenge is answered by
	 * fetching a token for the challenge's scope plus `scopes`, then the request is retried once.
	 */
	async request(
		host: string,
		scopes: string[],
		method: string,
		path: string,
		init: { headers?: Record<string, string>; body?: Body; redirect?: 'follow' | 'manual' } = {},
	): Promise<Response> {
		const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${this.endpoint(host)}${path}`;
		const key = `${host} ${[...scopes].sort().join(' ')}`;
		const send = (authorization: string | undefined) =>
			this.fetcher(url, {
				method,
				headers: { ...init.headers, ...(authorization ? { authorization } : {}) },
				body: init.body,
				redirect: init.redirect ?? 'follow',
			});
		let response = await send(this.auth.get(key));
		if (response.status !== 401) return response;
		const challenge = parseChallenge(response.headers.get('www-authenticate') ?? '');
		await response.body?.cancel().catch(() => undefined);
		if (!challenge) throw new RegistryError(`${method} ${url}: 401 without a WWW-Authenticate challenge`, 401);
		const authorization = await this.authorize(host, challenge, scopes);
		this.auth.set(key, authorization);
		response = await send(authorization);
		if (response.status === 401) throw new RegistryError(`${method} ${url}: unauthorized (check the registry credentials and their access to ${scopes.join(', ')})`, 401);
		return response;
	}

	private async authorize(host: string, challenge: { scheme: string; params: Record<string, string> }, scopes: string[]): Promise<string> {
		const credentials = this.credentials(host);
		const basic = credentials ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` : null;
		if (challenge.scheme === 'basic') {
			if (!basic) throw new RegistryError(`${host} needs credentials`, 401);
			return basic;
		}
		if (challenge.scheme !== 'bearer' || !challenge.params.realm) throw new RegistryError(`${host}: unsupported auth challenge ${challenge.scheme}`, 401);
		const realm = new URL(challenge.params.realm);
		if (challenge.params.service) realm.searchParams.set('service', challenge.params.service);
		const wanted = new Set(scopes);
		if (challenge.params.scope) for (const scope of challenge.params.scope.split(' ')) if (scope) wanted.add(scope);
		for (const scope of wanted) realm.searchParams.append('scope', scope);
		const response = await this.fetcher(realm, { headers: basic ? { authorization: basic } : {} });
		if (!response.ok) {
			const text = (await response.text().catch(() => '')).slice(0, 300);
			throw new RegistryError(`Token request to ${realm.origin}${realm.pathname} failed: ${response.status} ${text}`.trim(), response.status);
		}
		const body = (await response.json().catch(() => ({}))) as { token?: string; access_token?: string };
		const token = body.token ?? body.access_token;
		if (!token) throw new RegistryError(`Token response from ${realm.origin} carried no token`);
		return `Bearer ${token}`;
	}

	private async expectOk(response: Response, what: string, ok: number[] = [200]): Promise<Response> {
		if (ok.includes(response.status)) return response;
		const text = (await response.text().catch(() => '')).slice(0, 400);
		throw new RegistryError(`${what}: ${response.status} ${text}`.trim(), response.status);
	}

	/** GET a manifest by tag or digest (verified against the digest when given). */
	async getManifest(ref: ImageReference): Promise<FetchedManifest> {
		const reference = ref.digest ?? ref.tag ?? 'latest';
		const response = await this.expectOk(
			await this.request(ref.registry, [`repository:${ref.repository}:pull`], 'GET', `/v2/${ref.repository}/manifests/${reference}`, {
				headers: { accept: MANIFEST_ACCEPT },
			}),
			`GET manifest ${formatImageReference(ref)}`,
		);
		const bytes = new Uint8Array(await response.arrayBuffer());
		const digest = sha256Digest(bytes);
		if (ref.digest && digest !== ref.digest) throw new RegistryError(`Manifest ${formatImageReference(ref)} does not match its digest (got ${digest})`);
		let json: ManifestJson;
		try {
			json = JSON.parse(new TextDecoder().decode(bytes)) as ManifestJson;
		} catch {
			throw new RegistryError(`Manifest ${formatImageReference(ref)} is not JSON`);
		}
		const header = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
		const mediaType = json.mediaType || header || (json.manifests ? MEDIA_TYPES.ociIndex : MEDIA_TYPES.ociManifest);
		return { mediaType, digest, bytes, json };
	}

	/** GET a blob; registries often redirect to object storage, which must not get our token. */
	async getBlob(host: string, repository: string, digest: string): Promise<Response> {
		let response = await this.request(host, [`repository:${repository}:pull`], 'GET', `/v2/${repository}/blobs/${digest}`, { redirect: 'manual' });
		for (let hops = 0; [301, 302, 303, 307, 308].includes(response.status) && hops < 5; hops += 1) {
			const location = response.headers.get('location');
			if (!location) break;
			response = await this.fetcher(new URL(location, response.url || this.endpoint(host)), { redirect: 'manual' });
		}
		return this.expectOk(response, `GET blob ${host}/${repository}@${digest}`);
	}

	async blobExists(host: string, repository: string, digest: string): Promise<boolean> {
		const response = await this.request(host, [`repository:${repository}:pull`], 'HEAD', `/v2/${repository}/blobs/${digest}`);
		return response.ok;
	}

	async manifestExists(host: string, repository: string, digest: string): Promise<boolean> {
		const response = await this.request(host, [`repository:${repository}:pull`], 'HEAD', `/v2/${repository}/manifests/${digest}`, {
			headers: { accept: MANIFEST_ACCEPT },
		});
		return response.ok;
	}

	/** PUT a manifest under a tag or its digest; returns the digest of the bytes sent. */
	async putManifest(host: string, repository: string, reference: string, mediaType: string, bytes: Uint8Array): Promise<string> {
		const digest = sha256Digest(bytes);
		const response = await this.request(host, [`repository:${repository}:pull,push`], 'PUT', `/v2/${repository}/manifests/${reference}`, {
			headers: { 'content-type': mediaType },
			body: bytes,
		});
		await this.expectOk(response, `PUT manifest ${host}/${repository}:${reference}`, [200, 201, 202]);
		const returned = response.headers.get('docker-content-digest');
		if (returned && returned !== digest) throw new RegistryError(`${host} stored the manifest as ${returned}, expected ${digest}`);
		return digest;
	}

	/**
	 * Make `digest` exist in `to`: nothing if it is already there, a cross-repository mount on the
	 * same registry, else download (spooled to a temp file) and a monolithic upload.
	 */
	async copyBlob(from: { host: string; repository: string }, to: { host: string; repository: string }, digest: string): Promise<'exists' | 'mounted' | 'copied'> {
		if (await this.blobExists(to.host, to.repository, digest)) return 'exists';
		const pushScope = `repository:${to.repository}:pull,push`;
		let location: string | null = null;
		if (from.host === to.host) {
			const query = `?mount=${encodeURIComponent(digest)}&from=${encodeURIComponent(from.repository)}`;
			const response = await this.request(to.host, [pushScope, `repository:${from.repository}:pull`], 'POST', `/v2/${to.repository}/blobs/uploads/${query}`, {
				headers: { 'content-length': '0' },
			});
			if (response.status === 201) return 'mounted';
			await this.expectOk(response, `Mount ${digest} into ${to.host}/${to.repository}`, [202]);
			location = response.headers.get('location');
		} else {
			const response = await this.request(to.host, [pushScope], 'POST', `/v2/${to.repository}/blobs/uploads/`, { headers: { 'content-length': '0' } });
			await this.expectOk(response, `Start an upload to ${to.host}/${to.repository}`, [202]);
			location = response.headers.get('location');
		}
		if (!location) throw new RegistryError(`${to.host} returned no upload location`);
		const spoolDir = join(this.tempDir ?? (process.env.TMPDIR || '/tmp'), `yoal-blob-${randomUUID()}`);
		await mkdir(spoolDir, { recursive: true, mode: 0o700 });
		const spool = join(spoolDir, 'blob');
		try {
			const download = await this.getBlob(from.host, from.repository, digest);
			await Bun.write(spool, download);
			const file = Bun.file(spool);
			const hash = createHash('sha256');
			for await (const chunk of file.stream()) hash.update(chunk);
			if (`sha256:${hash.digest('hex')}` !== digest) throw new RegistryError(`Blob ${digest} from ${from.host}/${from.repository} failed its checksum`);
			const target = new URL(location, this.endpoint(to.host));
			target.searchParams.set('digest', digest);
			const put = await this.request(to.host, [pushScope], 'PUT', target.toString(), {
				headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.size) },
				body: file,
			});
			await this.expectOk(put, `Upload ${digest} to ${to.host}/${to.repository}`, [201, 204]);
			return 'copied';
		} finally {
			await rm(spoolDir, { recursive: true, force: true });
		}
	}
}

// --- image index --------------------------------------------------------------------------

export interface ImageIndexResult {
	digest: string;
	/** `<registry>/<repo>@<digest>` of the index. */
	image: string;
	manifests: Descriptor[];
}

function platformKey(platform: Platform | undefined): string {
	if (!platform) return 'unknown/unknown';
	return [platform.os, platform.architecture, platform.variant].filter(Boolean).join('/');
}

function isAttestation(descriptor: Descriptor): boolean {
	return descriptor.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest' || platformKey(descriptor.platform) === 'unknown/unknown';
}

/** A source is an image ref, `@sha256:…`/`sha256:…` (in the target repository), or a full digest ref. */
export function resolveSource(source: string, target: ImageReference): ImageReference {
	const trimmed = source.trim().replace(/^@/, '');
	if (DIGEST.test(trimmed)) return { registry: target.registry, repository: target.repository, tag: null, digest: trimmed };
	return parseImageReference(trimmed);
}

/**
 * Write one OCI image index at `target` from per-architecture `sources`. Each source's platform
 * comes from its config blob (os/architecture/variant); a source that is already an index (BuildKit
 * with attestations, or a multi-arch image) contributes its manifests, attestations included.
 * Sources in another repository or registry are copied into the target repository first, so the
 * index never references a manifest the target cannot serve.
 */
export async function createImageIndex(
	client: RegistryClient,
	input: { target: string; sources: string[]; annotations?: Record<string, string>; log?: (line: string) => void },
): Promise<ImageIndexResult> {
	const log = input.log ?? (() => undefined);
	const target = parseImageReference(input.target);
	if (target.digest) throw new RegistryError('The index tag cannot be a digest');
	const tag = target.tag ?? 'latest';
	if (!input.sources.length) throw new RegistryError('No sources given');
	const manifests: Descriptor[] = [];
	const seenPlatforms = new Map<string, string>();
	const seenDigests = new Set<string>();

	const ensureInTarget = async (source: ImageReference, manifest: FetchedManifest): Promise<void> => {
		const sameRepo = source.registry === target.registry && source.repository === target.repository;
		if (sameRepo) return;
		if (await client.manifestExists(target.registry, target.repository, manifest.digest)) return;
		const blobs = [manifest.json.config, ...(manifest.json.layers ?? [])].filter((blob): blob is Descriptor => Boolean(blob?.digest));
		for (const blob of blobs) {
			const how = await client.copyBlob({ host: source.registry, repository: source.repository }, { host: target.registry, repository: target.repository }, blob.digest);
			if (how !== 'exists') log(`  ${how} ${blob.digest.slice(0, 19)}… (${blob.size} bytes)`);
		}
		await client.putManifest(target.registry, target.repository, manifest.digest, manifest.mediaType, manifest.bytes);
	};

	const add = (descriptor: Descriptor, from: string) => {
		if (seenDigests.has(descriptor.digest)) return;
		seenDigests.add(descriptor.digest);
		if (!isAttestation(descriptor)) {
			const key = platformKey(descriptor.platform);
			const earlier = seenPlatforms.get(key);
			if (earlier) throw new RegistryError(`Both ${earlier} and ${from} are ${key}; an index holds one image per platform`);
			seenPlatforms.set(key, from);
		}
		manifests.push(descriptor);
	};

	for (const raw of input.sources) {
		const source = resolveSource(raw, target);
		const manifest = await client.getManifest(source);
		const label = formatImageReference(source);
		if (isIndexMediaType(manifest.mediaType) || manifest.json.manifests) {
			for (const child of manifest.json.manifests ?? []) {
				const childRef = { ...source, tag: null, digest: child.digest };
				const fetched = await client.getManifest(childRef);
				if (isIndexMediaType(fetched.mediaType)) throw new RegistryError(`${label} nests an index (${child.digest}); flatten it first`);
				await ensureInTarget(source, fetched);
				add({ ...child, mediaType: child.mediaType || fetched.mediaType, size: child.size || fetched.bytes.byteLength }, label);
			}
			log(`${label}: ${manifest.json.manifests?.length ?? 0} manifests (${(manifest.json.manifests ?? []).map((child) => platformKey(child.platform)).join(', ')})`);
			continue;
		}
		const config = manifest.json.config;
		if (!config?.digest) throw new RegistryError(`${label} is not an image manifest (no config)`);
		const configResponse = await client.getBlob(source.registry, source.repository, config.digest);
		const configJson = (await configResponse.json().catch(() => ({}))) as Partial<Platform> & { platform?: Partial<Platform> };
		const architecture = configJson.architecture ?? configJson.platform?.architecture;
		const os = configJson.os ?? configJson.platform?.os;
		if (!architecture || !os) throw new RegistryError(`${label}: its config has no os/architecture`);
		const platform: Platform = { architecture, os };
		const variant = configJson.variant ?? configJson.platform?.variant;
		if (variant) platform.variant = variant;
		if (configJson['os.version']) platform['os.version'] = configJson['os.version'];
		await ensureInTarget(source, manifest);
		add({ mediaType: manifest.mediaType, digest: manifest.digest, size: manifest.bytes.byteLength, platform }, label);
		log(`${label}: ${platformKey(platform)} ${manifest.digest}`);
	}

	if (!seenPlatforms.size) throw new RegistryError('No platform images among the sources (only attestations)');
	const index: Record<string, unknown> = { schemaVersion: 2, mediaType: MEDIA_TYPES.ociIndex, manifests };
	if (input.annotations && Object.keys(input.annotations).length) index.annotations = input.annotations;
	const bytes = new TextEncoder().encode(JSON.stringify(index));
	const digest = await client.putManifest(target.registry, target.repository, tag, MEDIA_TYPES.ociIndex, bytes);
	return { digest, image: formatImageReference({ ...target, tag: null, digest }, 'digest'), manifests };
}
