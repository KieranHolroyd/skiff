import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';

/**
 * Signed streaming endpoint for a local backup target (the S3 path goes straight to the bucket).
 * A URL is produced by `LocalObjectStore.presignPut/presignGet`; the signature covers the method,
 * key and expiry, so an agent can upload or restore without a platform session.
 */
const handler: RequestHandler = async ({ params, request, url }) => {
	const id = params.id;
	const lookup = core.backupTargets.localStore(id);
	if (!lookup) return new Response('Not a local backup target', { status: 404 });
	const key = params.path ?? '';
	if (!key) return new Response('Missing key', { status: 400 });
	const exp = Number(url.searchParams.get('exp'));
	const signature = url.searchParams.get('sig') ?? '';
	const method = request.method === 'PUT' ? 'PUT' : 'GET';
	if (!lookup.store.verify(method, key, exp, signature))
		return new Response('Invalid or expired signature', { status: 403 });

	try {
		if (method === 'GET') {
			const stream = await lookup.store.getStream(key);
			return new Response(request.method === 'HEAD' ? null : (stream.body as BodyInit), {
				headers: {
					'content-type': 'application/octet-stream',
					...(stream.size !== null ? { 'content-length': String(stream.size) } : {}),
					'cache-control': 'private, max-age=300',
				},
			});
		}
		const length = Number(request.headers.get('content-length'));
		await lookup.store.putStream(
			key,
			request.body ??
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.close();
					},
				}),
			request.headers.get('content-type') ?? 'application/octet-stream',
			Number.isFinite(length) && length > 0 ? length : undefined,
		);
		return new Response(null, { status: 204 });
	} catch (error) {
		console.error('[backup-targets]', error);
		return new Response('Not found', { status: 404 });
	}
};

export const GET = handler;
export const HEAD = handler;
export const PUT = handler;
