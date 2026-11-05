/**
 * Which stored objects the object browser can preview, and how.
 *
 * Shared by the dashboard (to pick a viewer) and the object REST endpoint (to decide what may be
 * served `inline`). Only types a browser renders without running the object's own code are
 * previewed as media; everything that is text — including HTML and SVG source — is fetched and
 * shown as plain text, never rendered as a document.
 */

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text';

export interface Preview {
	kind: PreviewKind;
	/** The media type to serve the object as when the stored one is missing or generic. */
	mime: string;
}

/** Text previews download the whole object, so they are capped. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** Row thumbnails load the full image; skip ones too big to be worth it in a list. */
export const THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024;

const media: Record<string, Preview> = {
	png: { kind: 'image', mime: 'image/png' },
	apng: { kind: 'image', mime: 'image/apng' },
	jpg: { kind: 'image', mime: 'image/jpeg' },
	jpeg: { kind: 'image', mime: 'image/jpeg' },
	jfif: { kind: 'image', mime: 'image/jpeg' },
	gif: { kind: 'image', mime: 'image/gif' },
	webp: { kind: 'image', mime: 'image/webp' },
	avif: { kind: 'image', mime: 'image/avif' },
	svg: { kind: 'image', mime: 'image/svg+xml' },
	bmp: { kind: 'image', mime: 'image/bmp' },
	ico: { kind: 'image', mime: 'image/x-icon' },
	mp4: { kind: 'video', mime: 'video/mp4' },
	m4v: { kind: 'video', mime: 'video/mp4' },
	mov: { kind: 'video', mime: 'video/quicktime' },
	webm: { kind: 'video', mime: 'video/webm' },
	ogv: { kind: 'video', mime: 'video/ogg' },
	mp3: { kind: 'audio', mime: 'audio/mpeg' },
	wav: { kind: 'audio', mime: 'audio/wav' },
	flac: { kind: 'audio', mime: 'audio/flac' },
	ogg: { kind: 'audio', mime: 'audio/ogg' },
	oga: { kind: 'audio', mime: 'audio/ogg' },
	opus: { kind: 'audio', mime: 'audio/ogg' },
	m4a: { kind: 'audio', mime: 'audio/mp4' },
	aac: { kind: 'audio', mime: 'audio/aac' },
	pdf: { kind: 'pdf', mime: 'application/pdf' }
};

const text = new Set([
	'txt',
	'text',
	'md',
	'markdown',
	'log',
	'csv',
	'tsv',
	'json',
	'jsonl',
	'ndjson',
	'yaml',
	'yml',
	'toml',
	'ini',
	'conf',
	'cfg',
	'env',
	'xml',
	'html',
	'htm',
	'css',
	'js',
	'mjs',
	'cjs',
	'ts',
	'tsx',
	'jsx',
	'svelte',
	'vue',
	'py',
	'go',
	'rs',
	'rb',
	'php',
	'java',
	'kt',
	'swift',
	'c',
	'h',
	'cpp',
	'sh',
	'bash',
	'zsh',
	'sql',
	'graphql',
	'proto',
	'tf',
	'dockerfile'
]);

const textNames = new Set(['dockerfile', 'makefile', 'readme', 'license', 'caddyfile', 'procfile']);

function extensionOf(key: string): string {
	const name = (key.split('/').pop() ?? '').toLowerCase();
	const dot = name.lastIndexOf('.');
	return dot <= 0 ? '' : name.slice(dot + 1);
}

/** How the object at `key` can be previewed, judged by its name; `null` when it can't. */
export function previewOf(key: string): Preview | null {
	if (key.endsWith('/')) return null;
	const ext = extensionOf(key);
	if (ext && media[ext]) return media[ext]!;
	if (ext && text.has(ext)) return { kind: 'text', mime: 'text/plain; charset=utf-8' };
	const name = (key.split('/').pop() ?? '').toLowerCase();
	if (!ext && textNames.has(name)) return { kind: 'text', mime: 'text/plain; charset=utf-8' };
	return null;
}

const families: Record<Exclude<PreviewKind, 'text'>, (type: string) => boolean> = {
	image: (type) => type.startsWith('image/'),
	video: (type) => type.startsWith('video/'),
	audio: (type) => type.startsWith('audio/'),
	pdf: (type) => type === 'application/pdf'
};

/**
 * The media type to serve an inline media preview as: the stored type when it agrees with the
 * extension's family (so a correct `image/jpeg` on a `.jpg` is kept), otherwise the extension's.
 * Returns `null` for anything that must not be served inline.
 */
export function inlineMediaType(key: string, stored: string | null): string | null {
	const preview = previewOf(key);
	if (!preview || preview.kind === 'text') return null;
	const type = (stored ?? '').split(';')[0]!.trim().toLowerCase();
	return families[preview.kind](type) ? type : preview.mime;
}
