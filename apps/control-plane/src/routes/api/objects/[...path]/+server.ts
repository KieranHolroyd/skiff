import type { RequestHandler } from './$types';
import { LocalObjectStore } from '@yoal/core';
import { limits } from '@yoal/contracts';
import { core } from '#lib/server/core.js';

/**
 * Only used by the local filesystem object store (development and single-node installs). With R2
 * configured, clients and agents go straight to R2 with a presigned URL.
 */
function localStore(): LocalObjectStore | null {
	return core.ctx.objectStore instanceof LocalObjectStore ? core.ctx.objectStore : null;
}

const handler: RequestHandler = async ({ params, request, url }) => {
	const store = localStore();
	if (!store) return new Response('Object store is R2; use the presigned URL.', { status: 404 });
	const key = params.path ?? '';
	if (!key) return new Response('Missing key', { status: 400 });
	const exp = Number(url.searchParams.get('exp'));
	const signature = url.searchParams.get('sig') ?? '';
	if (!store.verify(request.method === 'PUT' ? 'PUT' : 'GET', key, exp, signature))
		return new Response('Invalid or expired signature', { status: 403 });

	try {
		if (request.method === 'GET' || request.method === 'HEAD') {
			const data = await store.get(key);
			return new Response(request.method === 'HEAD' ? null : new Blob([data as unknown as BlobPart]), {
				headers: {
					'content-type': key.endsWith('.zip') ? 'application/zip' : 'application/octet-stream',
					'content-length': String(data.byteLength),
					'cache-control': 'private, max-age=300',
				},
			});
		}
		if (request.method === 'PUT') {
			const body = new Uint8Array(await request.arrayBuffer());
			if (body.byteLength > limits.artifactBytes)
				return new Response('Artifact too large', { status: 413 });
			await store.put(key, body, 'application/zip');
			return new Response(null, { status: 204 });
		}
		return new Response('Method not allowed', { status: 405 });
	} catch (error) {
		console.error('[objects]', error);
		return new Response('Not found', { status: 404 });
	}
};

export const GET = handler;
export const HEAD = handler;
export const PUT = handler;
