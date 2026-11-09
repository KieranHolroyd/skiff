import type { RequestHandler } from './$types';
import { CoreError } from '@yoal/core';
import { bucketNameSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { inlineMediaType } from '#lib/storage-preview.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * One object: download (GET), metadata (HEAD), upload (PUT) or delete (DELETE).
 *
 * The object key is a query parameter, not a path segment, so slashes in keys are unambiguous.
 * Uploads are buffered and capped by `storageObjectMaxBytes`; larger files belong in a presigned
 * upload or the CLI.
 */

function bucketOf(event: { url: URL }): string {
	return bucketNameSchema.parse(event.url.searchParams.get('bucket') ?? '');
}

function keyOf(event: { url: URL }): string {
	const key = event.url.searchParams.get('key');
	if (!key) throw new CoreError('validation', 'key is required', 400);
	return key;
}

function disposition(key: string, inline: boolean): string {
	const filename = key.split('/').pop() || 'download';
	const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const bucket = bucketOf(event);
		const key = keyOf(event);
		const result = await core.storageObjects.download(
			principal,
			event.params.name,
			bucket,
			key,
			event.request.headers.get('range')
		);
		const headers = new Headers();
		const length = result.response.headers.get('content-length');
		if (length) headers.set('content-length', length);
		// Byte ranges let media previews seek (and Safari play video at all) and downloads resume.
		headers.set('accept-ranges', 'bytes');
		const contentRange = result.response.headers.get('content-range');
		if (contentRange) headers.set('content-range', contentRange);
		if (result.etag) headers.set('etag', `"${result.etag}"`);
		headers.set('x-content-type-options', 'nosniff');

		// `inline=1` is the dashboard preview. Only allowlisted media is ever served inline, under a
		// type derived from the key, so an uploaded HTML or script can't run on the platform origin.
		const inlineType =
			event.url.searchParams.get('inline') === '1'
				? inlineMediaType(key, result.contentType)
				: null;
		if (inlineType) {
			headers.set('content-type', inlineType);
			headers.set('content-disposition', disposition(key, true));
			// Preview URLs carry the etag (`v=`), so a short private cache is safe and keeps thumbnails cheap.
			headers.set('cache-control', 'private, max-age=600');
			headers.set(
				'content-security-policy',
				inlineType === 'application/pdf'
					? // The browser's PDF viewer needs an unsandboxed document; the dashboard frames it.
						"frame-ancestors 'self'"
					: "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'"
			);
		} else {
			headers.set('content-type', result.contentType ?? 'application/octet-stream');
			headers.set('content-disposition', disposition(key, false));
			headers.set('cache-control', 'private, no-store');
		}
		const status = result.response.status === 206 && contentRange ? 206 : 200;
		return new Response(result.response.body, { status, headers });
	});

export const HEAD: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const bucket = bucketOf(event);
		const key = keyOf(event);
		const stat = await core.storageObjects.stat(principal, event.params.name, bucket, key);
		const headers = new Headers();
		headers.set('content-type', stat.contentType ?? 'application/octet-stream');
		headers.set('content-length', String(stat.sizeBytes));
		if (stat.etag) headers.set('etag', `"${stat.etag}"`);
		headers.set('cache-control', 'private, no-store');
		return new Response(null, { status: 200, headers });
	});

export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const bucket = bucketOf(event);
		const key = keyOf(event);
		const max = core.storageObjects.maxUploadBytes;
		const declared = Number(event.request.headers.get('content-length') ?? 0);
		if (Number.isFinite(declared) && declared > max)
			throw new CoreError(
				'payload_too_large',
				`Objects uploaded through the control plane are limited to ${Math.floor(max / 1024 / 1024)} MB.`,
				413
			);
		const body = new Uint8Array(await event.request.arrayBuffer());
		if (body.byteLength > max)
			throw new CoreError('payload_too_large', 'Upload exceeds the control-plane limit.', 413);
		const object = await core.storageObjects.upload(
			principal,
			event.params.name,
			bucket,
			key,
			body,
			event.request.headers.get('content-type')
		);
		return json({ object }, 201);
	});

export const DELETE: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const bucket = bucketOf(event);
		const key = keyOf(event);
		return core.storageObjects.remove(principal, event.params.name, bucket, { keys: [key] });
	});
