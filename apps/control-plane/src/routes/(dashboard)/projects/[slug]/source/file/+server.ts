import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.js';
import { core } from '#lib/server/core.js';
import { requirePrincipal } from '#lib/server/principal.js';
import {
	SOURCE_SECURITY_HEADERS,
	fileNameOf,
	isPreviewableImage,
	sourceContentType
} from '#lib/server/source.js';

/**
 * One file from a release. Text is served as plain text so deployed HTML/JS/SVG can never run on
 * the platform origin; raster images are inline-previewable. `?download` forces an attachment.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const deployment = event.url.searchParams.get('deployment') ?? undefined;
		const path = event.url.searchParams.get('path') ?? '';
		const download = event.url.searchParams.get('download') === '1';
		const { file, data } = await core.source.file(principal, project, deployment, path);
		const fileName = fileNameOf(file.path);
		const headers = new Headers({
			...SOURCE_SECURITY_HEADERS,
			'content-length': String(data.byteLength),
			'x-yoal-sha256': file.sha256,
			// Releases are immutable, but the response is user-scoped: never let a shared proxy cache it.
			'cache-control': 'private, max-age=3600'
		});
		if (download) {
			headers.set('content-type', 'application/octet-stream');
			headers.set('content-disposition', disposition('attachment', fileName));
		} else {
			headers.set('content-type', sourceContentType(file.path));
			if (isPreviewableImage(file.path))
				headers.set('content-disposition', disposition('inline', fileName));
		}
		return new Response(data as unknown as BodyInit, { headers });
	});

function disposition(kind: 'inline' | 'attachment', fileName: string): string {
	// Quote-safe for any manifest path (the filename may legitimately contain spaces or unicode).
	const safe = fileName.replaceAll('\\', '_').replaceAll('"', "'");
	return `${kind}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
