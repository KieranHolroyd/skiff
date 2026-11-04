/**
 * Content types for the read-only source viewer.
 *
 * Anything that can execute in a document context (HTML, SVG, XML, JS) is deliberately served as
 * `text/plain`; the platform origin must never be able to render deployed content. Only raster
 * images get a previewable type, and every response carries a `sandbox` CSP as a second line of
 * defence. Downloads are always `application/octet-stream` attachments.
 */
const IMAGE_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	ico: 'image/x-icon'
};

const BINARY_EXTENSIONS = new Set([
	'woff',
	'woff2',
	'ttf',
	'otf',
	'eot',
	'wasm',
	'zip',
	'gz',
	'br',
	'pdf',
	'mp4',
	'webm',
	'mp3',
	'ogg',
	'wav',
	'flac',
	'aac'
]);

export function extensionOf(path: string): string {
	const name = path.split('/').pop() ?? path;
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isPreviewableImage(path: string): boolean {
	return extensionOf(path) in IMAGE_TYPES;
}

/** Safe response type for inline viewing. */
export function sourceContentType(path: string): string {
	const extension = extensionOf(path);
	const type = IMAGE_TYPES[extension];
	if (type) return type;
	if (BINARY_EXTENSIONS.has(extension)) return 'application/octet-stream';
	return 'text/plain; charset=utf-8';
}

export function fileNameOf(path: string): string {
	return path.split('/').pop() ?? 'file';
}

export const SOURCE_SECURITY_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
};
