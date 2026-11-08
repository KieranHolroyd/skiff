import { describe, expect, test } from 'bun:test';
import { ImageResolveError, parseAuthChallenge, resolveImageDigest } from './oci-client.ts';

const DIGEST = `sha256:${'e'.repeat(64)}`;

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const seen: Array<{ url: string; method: string; authorization: string | null }> = [];
	const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input instanceof Request ? input.url : input);
		seen.push({ url, method: init.method ?? 'GET', authorization: new Headers(init.headers).get('authorization') });
		return handler(url, init);
	}) as typeof fetch;
	return { fn, seen };
}

describe('parseAuthChallenge', () => {
	test('reads quoted and bare parameters', () => {
		expect(parseAuthChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"')).toEqual({
			scheme: 'bearer',
			params: { realm: 'https://auth.docker.io/token', service: 'registry.docker.io', scope: 'repository:library/nginx:pull' },
		});
		expect(parseAuthChallenge('Basic realm=registry')).toEqual({ scheme: 'basic', params: { realm: 'registry' } });
		expect(parseAuthChallenge(null)).toBeNull();
	});
});

describe('resolveImageDigest', () => {
	test('follows the anonymous Docker Hub token flow and defaults the tag to latest', async () => {
		const { fn, seen } = fakeFetch((url, init) => {
			if (url.startsWith('https://auth.docker.io/token')) return Response.json({ access_token: 'anon' });
			if (new Headers(init.headers).get('authorization') !== 'Bearer anon')
				return new Response(null, {
					status: 401,
					headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' },
				});
			return new Response(null, { headers: { 'Docker-Content-Digest': DIGEST } });
		});
		expect(await resolveImageDigest('nginx', { fetch: fn })).toBe(DIGEST);
		expect(seen[0]!.url).toBe('https://registry-1.docker.io/v2/library/nginx/manifests/latest');
		const token = new URL(seen[1]!.url);
		expect(token.searchParams.get('scope')).toBe('repository:library/nginx:pull');
		expect(token.searchParams.get('service')).toBe('registry.docker.io');
		expect(seen[1]!.authorization).toBeNull();
	});

	test('uses Basic auth when the registry asks for it', async () => {
		const login = { username: 'u', password: 'p' };
		const { fn } = fakeFetch((_url, init) =>
			new Headers(init.headers).get('authorization') === `Basic ${btoa('u:p')}`
				? new Response(null, { headers: { 'Docker-Content-Digest': DIGEST } })
				: new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="r"' } }),
		);
		expect(await resolveImageDigest('registry.example.com:5000/app:1', { fetch: fn, credentials: login })).toBe(DIGEST);
	});

	test('hashes the manifest when the registry sends no digest header', async () => {
		const body = '{"schemaVersion":2}';
		const { fn } = fakeFetch((_url, init) => new Response(init.method === 'HEAD' ? null : body));
		const expected = `sha256:${new Bun.CryptoHasher('sha256').update(body).digest('hex')}`;
		expect(await resolveImageDigest('ghcr.io/acme/api:1', { fetch: fn })).toBe(expected);
	});

	test('returns an existing digest without a request and refuses local images', async () => {
		const { fn, seen } = fakeFetch(() => new Response(null));
		expect(await resolveImageDigest(`ghcr.io/acme/api:1@${DIGEST}`, { fetch: fn })).toBe(DIGEST);
		expect(seen).toEqual([]);
		await expect(resolveImageDigest('localhost/app:1', { fetch: fn })).rejects.toMatchObject({ reason: 'local' });
	});

	test('explains missing tags, missing logins and unreachable registries', async () => {
		const notFound = fakeFetch(() => new Response(null, { status: 404 }));
		await expect(resolveImageDigest('ghcr.io/acme/api:9', { fetch: notFound.fn })).rejects.toMatchObject({ reason: 'not_found' });
		const denied = fakeFetch((url) =>
			url.includes('/token')
				? new Response('no', { status: 401 })
				: new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token"' } }),
		);
		const error = await resolveImageDigest('ghcr.io/acme/private:1', { fetch: denied.fn }).catch((e) => e);
		expect(error).toBeInstanceOf(ImageResolveError);
		expect(error.reason).toBe('unauthorized');
		expect(error.message).toContain('Add a registry credential for ghcr.io');
		const down = fakeFetch(() => {
			throw new Error('ECONNREFUSED');
		});
		await expect(resolveImageDigest('ghcr.io/acme/api:1', { fetch: down.fn })).rejects.toMatchObject({ reason: 'unreachable' });
	});
});
