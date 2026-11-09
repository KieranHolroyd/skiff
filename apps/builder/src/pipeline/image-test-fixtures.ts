import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineJobClaim } from '@yoal/contracts';
import type { ActionHost } from './actions.ts';
import type { JobApi } from './client.ts';
import { MEDIA_TYPES, sha256Digest } from './image-registry.ts';
import { Masker } from './masker.ts';

/**
 * Test fixtures for the image actions: a fake OCI registry (token challenge, manifests, blobs,
 * mounts, uploads, a blob redirect to "object storage") and a minimal ActionHost.
 */

export interface FakeRegistry {
	host: string;
	url: string;
	/** Scopes asked of the token realm, per request. */
	tokenRequests: string[][];
	/** Requests that reached "object storage" with an Authorization header (must stay empty). */
	leakedAuth: string[];
	mounts: string[];
	uploads: string[];
	manifest(repository: string, reference: string): { mediaType: string; bytes: Uint8Array } | undefined;
	hasBlob(repository: string, digest: string): boolean;
	/** Seed one image (config + one layer) and tag it; returns the manifest digest. */
	seedImage(repository: string, tag: string | null, platform: { os: string; architecture: string; variant?: string }): string;
	/** Seed raw manifest bytes under a tag (and its digest). */
	seedManifest(repository: string, tag: string | null, mediaType: string, json: unknown): { digest: string; size: number; bytes: Uint8Array };
	stop(): void;
}

export function startFakeRegistry(options: { username: string; password: string }): FakeRegistry {
	const blobs = new Map<string, Map<string, Uint8Array>>();
	const manifests = new Map<string, Map<string, { mediaType: string; bytes: Uint8Array }>>();
	const tokens = new Map<string, Set<string>>();
	const uploads = new Map<string, string>();
	const state = { tokenRequests: [] as string[][], leakedAuth: [] as string[], mounts: [] as string[], uploads: [] as string[] };
	let counter = 0;
	const repoBlobs = (repository: string) => blobs.get(repository) ?? blobs.set(repository, new Map()).get(repository)!;
	const repoManifests = (repository: string) => manifests.get(repository) ?? manifests.set(repository, new Map()).get(repository)!;
	const findBlob = (digest: string) => [...blobs.values()].find((map) => map.has(digest))?.get(digest);

	const putBlob = (repository: string, data: Uint8Array) => {
		const digest = sha256Digest(data);
		repoBlobs(repository).set(digest, data);
		return { digest, size: data.byteLength };
	};
	const putManifest = (repository: string, tag: string | null, mediaType: string, bytes: Uint8Array) => {
		const digest = sha256Digest(bytes);
		repoManifests(repository).set(digest, { mediaType, bytes });
		if (tag) repoManifests(repository).set(tag, { mediaType, bytes });
		return digest;
	};

	let base = '';
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			const url = new URL(request.url);
			const path = url.pathname;
			if (path === '/token') {
				const scopes = url.searchParams.getAll('scope');
				state.tokenRequests.push(scopes);
				const expected = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;
				if (request.headers.get('authorization') !== expected) return new Response('bad credentials', { status: 401 });
				const token = `tok${++counter}`;
				const grants = new Set<string>();
				for (const scope of scopes) {
					const [, name, actions] = /^repository:(.+):([a-z,]+)$/.exec(scope) ?? [];
					if (name) for (const action of actions!.split(',')) grants.add(`${name}:${action}`);
				}
				tokens.set(token, grants);
				return Response.json({ token, expires_in: 300 });
			}
			if (path.startsWith('/storage/')) {
				if (request.headers.get('authorization')) state.leakedAuth.push(path);
				const data = findBlob(path.slice('/storage/'.length));
				return data ? new Response(data) : new Response('missing', { status: 404 });
			}

			const allowed = (repository: string, action: string) => {
				const header = request.headers.get('authorization') ?? '';
				return header.startsWith('Bearer ') && Boolean(tokens.get(header.slice(7))?.has(`${repository}:${action}`));
			};
			const challenge = (repository: string, actions: string) =>
				new Response('unauthorized', {
					status: 401,
					headers: { 'www-authenticate': `Bearer realm="${base}/token",service="fake-registry",scope="repository:${repository}:${actions}"` },
				});

			const upload = /^\/upload\/([^/]+)$/.exec(path);
			if (upload) {
				const repository = uploads.get(upload[1]!);
				if (!repository) return new Response('unknown upload', { status: 404 });
				if (!allowed(repository, 'push')) return challenge(repository, 'pull,push');
				const data = new Uint8Array(await request.arrayBuffer());
				const { digest } = putBlob(repository, data);
				if (digest !== url.searchParams.get('digest')) return new Response('digest mismatch', { status: 400 });
				state.uploads.push(`${repository}@${digest}`);
				return new Response(null, { status: 201, headers: { 'docker-content-digest': digest } });
			}
			const start = /^\/v2\/(.+)\/blobs\/uploads\/$/.exec(path);
			if (start && request.method === 'POST') {
				const repository = start[1]!;
				const from = url.searchParams.get('from');
				const mount = url.searchParams.get('mount');
				if (!allowed(repository, 'push')) return challenge(repository, 'pull,push');
				if (mount && from && allowed(from, 'pull') && blobs.get(from)?.has(mount)) {
					repoBlobs(repository).set(mount, blobs.get(from)!.get(mount)!);
					state.mounts.push(`${from}→${repository}@${mount}`);
					return new Response(null, { status: 201 });
				}
				const id = `u${++counter}`;
				uploads.set(id, repository);
				return new Response(null, { status: 202, headers: { location: `/upload/${id}?state=abc` } });
			}
			const match = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(path);
			if (!match) return new Response(`not found: ${path}`, { status: 404 });
			const [, repository, kind, reference] = match as unknown as [string, string, string, string];
			const write = request.method === 'PUT';
			if (!allowed(repository, write ? 'push' : 'pull')) return challenge(repository, write ? 'pull,push' : 'pull');
			if (kind === 'blobs') {
				const data = blobs.get(repository)?.get(reference);
				if (!data) return new Response('blob unknown', { status: 404 });
				if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(data.byteLength) } });
				return new Response(null, { status: 307, headers: { location: `${base}/storage/${reference}` } });
			}
			if (write) {
				const bytes = new Uint8Array(await request.arrayBuffer());
				const mediaType = request.headers.get('content-type') ?? '';
				const json = JSON.parse(new TextDecoder().decode(bytes)) as { manifests?: Array<{ digest: string }>; config?: { digest: string }; layers?: Array<{ digest: string }> };
				for (const child of json.manifests ?? [])
					if (!repoManifests(repository).has(child.digest)) return new Response(`manifest unknown: ${child.digest}`, { status: 400 });
				for (const blob of [json.config, ...(json.layers ?? [])])
					if (blob && !repoBlobs(repository).has(blob.digest)) return new Response(`blob unknown: ${blob.digest}`, { status: 400 });
				const digest = putManifest(repository, reference.startsWith('sha256:') ? null : reference, mediaType, bytes);
				if (reference.startsWith('sha256:') && reference !== digest) return new Response('digest mismatch', { status: 400 });
				return new Response(null, { status: 201, headers: { 'docker-content-digest': digest } });
			}
			const stored = manifests.get(repository)?.get(reference);
			if (!stored) return new Response('manifest unknown', { status: 404 });
			const headers = { 'content-type': stored.mediaType, 'docker-content-digest': sha256Digest(stored.bytes) };
			return new Response(request.method === 'HEAD' ? null : stored.bytes, { status: 200, headers });
		},
	});
	base = `http://127.0.0.1:${server.port}`;
	return {
		host: `127.0.0.1:${server.port}`,
		url: base,
		...state,
		manifest: (repository, reference) => manifests.get(repository)?.get(reference),
		hasBlob: (repository, digest) => Boolean(blobs.get(repository)?.has(digest)),
		seedImage(repository, tag, platform) {
			const config = putBlob(repository, new TextEncoder().encode(JSON.stringify({ ...platform, rootfs: { type: 'layers', diff_ids: [] }, config: {} })));
			const layer = putBlob(repository, new TextEncoder().encode(`layer for ${platform.architecture} ${Math.random()}`));
			const manifest = {
				schemaVersion: 2,
				mediaType: MEDIA_TYPES.ociManifest,
				config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config },
				layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...layer }],
			};
			return putManifest(repository, tag, MEDIA_TYPES.ociManifest, new TextEncoder().encode(JSON.stringify(manifest)));
		},
		seedManifest(repository, tag, mediaType, json) {
			const bytes = new TextEncoder().encode(JSON.stringify(json));
			return { digest: putManifest(repository, tag, mediaType, bytes), size: bytes.byteLength, bytes };
		},
		stop: () => server.stop(true),
	};
}

/** A minimal ActionHost: real processes, logs collected in memory, posts collected. */
export function testHost(input: { claim: PipelineJobClaim; workspace: string; temp: string; env?: Record<string, string> }): ActionHost & { lines: string[]; masker: Masker } {
	mkdirSync(input.temp, { recursive: true });
	const lines: string[] = [];
	const masker = new Masker();
	const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', ...input.env };
	const host = {
		api: null as unknown as JobApi,
		claim: input.claim,
		workspace: input.workspace,
		temp: input.temp,
		home: join(input.temp, 'home'),
		cwd: input.workspace,
		env,
		masker,
		secretNames: [],
		lines,
		log: (text: string) => void lines.push(masker.mask(text)),
		async exec(argv: string[], options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}) {
			const proc = Bun.spawn(argv, {
				cwd: options.cwd ?? input.workspace,
				env: { ...env, ...options.env },
				stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			for (const line of `${out}${err}`.split('\n')) if (line) lines.push(masker.mask(line));
			return proc.exited;
		},
		addPost: () => undefined,
		isCancelled: () => false,
	};
	return host;
}
