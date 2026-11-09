import { createHash } from 'node:crypto';
import { parseImageReference, registryApiHost } from '@yoal/contracts';

/**
 * A minimal OCI distribution client: resolve an image tag to its manifest digest (R1,
 * docs/REGISTRY.md). It speaks the Docker token flow (a 401 with `WWW-Authenticate: Bearer
 * realm=…,service=…,scope=…`, then a token fetched from the realm) and plain Basic auth.
 */

/** Every manifest type a node can run: an index/list (multi-arch) or a single manifest. */
export const MANIFEST_ACCEPT = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export interface RegistryLogin {
	username: string;
	password: string;
}

export interface ResolveDigestOptions {
	fetch?: typeof fetch;
	credentials?: RegistryLogin | null;
	/** A token already minted for this repository (Yoal's own registry); skips the realm. */
	bearerToken?: string;
	timeoutMs?: number;
	/** Hosts reached over plain http (a registry on loopback). */
	plainHttpHosts?: ReadonlySet<string>;
}

export class ImageResolveError extends Error {
	constructor(
		message: string,
		readonly reason: 'invalid' | 'local' | 'not_found' | 'unauthorized' | 'unreachable' | 'protocol',
	) {
		super(message);
		this.name = 'ImageResolveError';
	}
}

/** Parse a `WWW-Authenticate` challenge: `Bearer realm="…",service="…"` → scheme + params. */
export function parseAuthChallenge(header: string | null): { scheme: string; params: Record<string, string> } | null {
	if (!header) return null;
	const match = /^\s*([A-Za-z]+)\s*(.*)$/.exec(header);
	if (!match) return null;
	const params: Record<string, string> = {};
	const pattern = /([A-Za-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
	for (const part of match[2]!.matchAll(pattern)) params[part[1]!.toLowerCase()] = part[2] ?? part[3] ?? '';
	return { scheme: match[1]!.toLowerCase(), params };
}

function basic(login: RegistryLogin): string {
	return `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`;
}

/**
 * Resolve `image` to the digest of the manifest its tag points at (`latest` when it has none).
 * A reference that already carries a digest returns it unchanged without a request.
 */
export async function resolveImageDigest(image: string, options: ResolveDigestOptions = {}): Promise<string> {
	const parsed = parseImageReference(image);
	if (!parsed) throw new ImageResolveError(`"${image}" is not a valid image reference.`, 'invalid');
	if (parsed.digest) return parsed.digest;
	if (parsed.registry === 'localhost')
		throw new ImageResolveError(`"${image}" is a local image; it has no registry to resolve against.`, 'local');
	const doFetch = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? 15_000;
	const host = registryApiHost(parsed.registry);
	const scheme = options.plainHttpHosts?.has(host) ? 'http' : 'https';
	const tag = parsed.tag ?? 'latest';
	const url = `${scheme}://${host}/v2/${parsed.repository}/manifests/${encodeURIComponent(tag)}`;

	const request = async (method: 'HEAD' | 'GET', authorization?: string): Promise<Response> => {
		try {
			return await doFetch(url, {
				method,
				headers: { Accept: MANIFEST_ACCEPT, ...(authorization ? { Authorization: authorization } : {}) },
				redirect: 'follow',
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new ImageResolveError(`Could not reach ${parsed.registry}: ${detail}`, 'unreachable');
		}
	};

	let authorization: string | undefined = options.bearerToken ? `Bearer ${options.bearerToken}` : undefined;
	let response = await request('HEAD', authorization);
	if (response.status === 401 && !options.bearerToken) {
		authorization = await authorize(response, parsed.repository, options.credentials ?? null, doFetch, timeoutMs, parsed.registry);
		response = await request('HEAD', authorization);
	}
	// Some registries answer HEAD without the digest header or refuse HEAD; GET is the fallback.
	let digest = response.ok ? response.headers.get('docker-content-digest') : null;
	if (response.ok && !digest) {
		const full = await request('GET', authorization);
		if (full.ok) {
			digest = full.headers.get('docker-content-digest');
			if (!digest) digest = `sha256:${createHash('sha256').update(new Uint8Array(await full.arrayBuffer())).digest('hex')}`;
		} else response = full;
	}
	if (digest) {
		if (!/^sha256:[a-f0-9]{64}$/.test(digest))
			throw new ImageResolveError(`${parsed.registry} returned an unsupported digest "${digest}".`, 'protocol');
		return digest;
	}
	if (response.status === 404)
		throw new ImageResolveError(`${parsed.registry}/${parsed.repository}:${tag} was not found.`, 'not_found');
	if (response.status === 401 || response.status === 403)
		throw new ImageResolveError(
			options.credentials
				? `${parsed.registry} refused the stored credential for ${parsed.repository}.`
				: `${parsed.registry} needs a login to read ${parsed.repository}. Add a registry credential for ${parsed.registry}.`,
			'unauthorized',
		);
	throw new ImageResolveError(`${parsed.registry} answered ${response.status} for ${parsed.repository}:${tag}.`, 'protocol');
}

async function authorize(
	challengeResponse: Response,
	repository: string,
	login: RegistryLogin | null,
	doFetch: typeof fetch,
	timeoutMs: number,
	registry: string,
): Promise<string | undefined> {
	const challenge = parseAuthChallenge(challengeResponse.headers.get('www-authenticate'));
	if (challenge?.scheme === 'basic') return login ? basic(login) : undefined;
	if (challenge?.scheme !== 'bearer' || !challenge.params.realm) return login ? basic(login) : undefined;
	let realm: URL;
	try {
		realm = new URL(challenge.params.realm);
	} catch {
		throw new ImageResolveError(`${registry} sent an invalid token realm.`, 'protocol');
	}
	if (challenge.params.service) realm.searchParams.set('service', challenge.params.service);
	realm.searchParams.set('scope', challenge.params.scope ?? `repository:${repository}:pull`);
	let response: Response;
	try {
		response = await doFetch(realm, {
			headers: login ? { Authorization: basic(login) } : {},
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new ImageResolveError(`Could not reach the token service of ${registry}: ${detail}`, 'unreachable');
	}
	if (response.status === 401 || response.status === 403)
		throw new ImageResolveError(
			login
				? `${registry} refused the stored credential (token service answered ${response.status}).`
				: `${registry} needs a login to read ${repository}. Add a registry credential for ${registry}.`,
			'unauthorized',
		);
	if (!response.ok)
		throw new ImageResolveError(`The token service of ${registry} answered ${response.status}.`, 'protocol');
	const body = (await response.json().catch(() => null)) as { token?: unknown; access_token?: unknown } | null;
	const token = typeof body?.token === 'string' ? body.token : typeof body?.access_token === 'string' ? body.access_token : null;
	if (!token) throw new ImageResolveError(`The token service of ${registry} returned no token.`, 'protocol');
	return `Bearer ${token}`;
}
