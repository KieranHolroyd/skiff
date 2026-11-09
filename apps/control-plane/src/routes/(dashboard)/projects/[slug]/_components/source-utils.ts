import type { Component } from 'svelte';
import ArchiveIcon from '@lucide/svelte/icons/archive';
import BracesIcon from '@lucide/svelte/icons/braces';
import FileCode2Icon from '@lucide/svelte/icons/file-code-2';
import FileImageIcon from '@lucide/svelte/icons/file-image';
import FileJsonIcon from '@lucide/svelte/icons/file-json';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import FileTypeIcon from '@lucide/svelte/icons/file-type';
import FileIcon from '@lucide/svelte/icons/file';
import FileMusicIcon from '@lucide/svelte/icons/file-music';
import FileVideoIcon from '@lucide/svelte/icons/file-video';

/** Mirrors `SourceFileView` in @yoal/core. */
export interface SourceFile {
	path: string;
	size: number;
	sha256: string;
}

export interface DeploymentSummary {
	id: string;
	shortId: string;
	status: string;
	environmentSlug: string;
	environmentName: string;
	isProduction: boolean;
	previewUrl: string;
	release: { sha256: string; sizeBytes: number; fileCount: number; precompressed: boolean };
}

export interface SourceView {
	deployment: DeploymentSummary & { productionUrl: string; createdAt: string };
	release: {
		id: string;
		sha256: string;
		sizeBytes: number;
		fileCount: number;
		precompressed: boolean;
		createdAt: string;
	};
	files: SourceFile[];
}

export interface TreeNode {
	name: string;
	path: string;
	type: 'file' | 'dir';
	size?: number;
	children?: TreeNode[];
}

const LANGUAGES: Record<string, string> = {
	html: 'html',
	htm: 'html',
	css: 'css',
	scss: 'scss',
	sass: 'scss',
	less: 'less',
	js: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	jsx: 'javascript',
	ts: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	tsx: 'typescript',
	json: 'json',
	jsonc: 'json',
	json5: 'json',
	webmanifest: 'json',
	map: 'json',
	md: 'markdown',
	mdx: 'markdown',
	yml: 'yaml',
	yaml: 'yaml',
	toml: 'ini',
	ini: 'ini',
	conf: 'ini',
	env: 'ini',
	xml: 'xml',
	svg: 'xml',
	sh: 'shell',
	bash: 'shell',
	zsh: 'shell',
	py: 'python',
	rb: 'ruby',
	go: 'go',
	rs: 'rust',
	php: 'php',
	java: 'java',
	c: 'c',
	h: 'c',
	cpp: 'cpp',
	cc: 'cpp',
	hpp: 'cpp',
	cs: 'csharp',
	sql: 'sql',
	graphql: 'graphql',
	gql: 'graphql',
	vue: 'html',
	svelte: 'html',
	txt: 'plaintext',
	csv: 'plaintext',
	tsv: 'plaintext',
	log: 'plaintext',
	diff: 'plaintext',
	patch: 'plaintext',
	gitignore: 'plaintext',
	editorconfig: 'ini',
	dockerfile: 'dockerfile',
	makefile: 'plaintext'
};

const BINARY_EXTENSIONS = new Set([
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'avif',
	'ico',
	'bmp',
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

const PREVIEWABLE_IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp']);
/** Monaco can handle a lot, but a 25 MB minified bundle is not useful source. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Everything after the last dot, lowercased; dotfiles keep their whole name as the "extension". */
export function extensionOf(path: string): string {
	const name = path.split('/').pop() ?? path;
	const dot = name.lastIndexOf('.');
	if (dot > 0) return name.slice(dot + 1).toLowerCase();
	return name.startsWith('.') ? name.slice(1).toLowerCase() : '';
}

export function languageFor(path: string): string {
	return LANGUAGES[extensionOf(path)] ?? 'plaintext';
}

export function isPreviewableImage(path: string): boolean {
	return PREVIEWABLE_IMAGES.has(extensionOf(path));
}

/** SVG is text (and is shown as XML) because inline SVG can execute script. */
export function isBinary(path: string): boolean {
	return BINARY_EXTENSIONS.has(extensionOf(path));
}

export type FileKind =
	'code' | 'markup' | 'style' | 'data' | 'image' | 'font' | 'media' | 'archive' | 'text';

export function kindOf(path: string): FileKind {
	const extension = extensionOf(path);
	if (PREVIEWABLE_IMAGES.has(extension)) return 'image';
	if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(extension)) return 'font';
	if (['mp4', 'webm', 'mp3', 'ogg', 'wav', 'flac', 'aac'].includes(extension)) return 'media';
	if (['zip', 'gz', 'br', 'pdf', 'wasm'].includes(extension)) return 'archive';
	if (['html', 'htm', 'xml', 'svg', 'vue', 'svelte', 'md', 'mdx'].includes(extension))
		return 'markup';
	if (['css', 'scss', 'sass', 'less'].includes(extension)) return 'style';
	if (
		['json', 'jsonc', 'json5', 'map', 'webmanifest', 'yaml', 'yml', 'toml', 'ini', 'csv'].includes(
			extension
		)
	)
		return 'data';
	if (['txt', 'log', 'diff', 'patch', 'gitignore', 'env'].includes(extension)) return 'text';
	return 'code';
}

const ICONS: Record<FileKind, Component<{ class?: string }>> = {
	code: FileCode2Icon,
	markup: BracesIcon,
	style: FileCode2Icon,
	data: FileJsonIcon,
	image: FileImageIcon,
	font: FileTypeIcon,
	media: FileMusicIcon,
	archive: ArchiveIcon,
	text: FileTextIcon
};

export function iconFor(path: string): Component<{ class?: string }> {
	if (kindOf(path) === 'media' && extensionOf(path) && ['mp4', 'webm'].includes(extensionOf(path)))
		return FileVideoIcon;
	return ICONS[kindOf(path)] ?? FileIcon;
}

const KIND_CLASSES: Record<FileKind, string> = {
	code: 'text-info',
	markup: 'text-brand',
	style: 'text-[oklch(0.62_0.16_330)] dark:text-[oklch(0.76_0.13_330)]',
	data: 'text-warning',
	image: 'text-success',
	font: 'text-[oklch(0.58_0.14_290)] dark:text-[oklch(0.76_0.1_290)]',
	media: 'text-destructive',
	archive: 'text-muted-foreground',
	text: 'text-muted-foreground'
};

export function iconClassFor(path: string): string {
	return KIND_CLASSES[kindOf(path)];
}

/** Build a nested, directories-first tree from flat manifest paths. */
export function buildTree(files: SourceFile[]): TreeNode[] {
	const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
	for (const file of files) {
		const parts = file.path.split('/');
		let cursor = root;
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index]!;
			const isLeaf = index === parts.length - 1;
			const path = parts.slice(0, index + 1).join('/');
			if (isLeaf) {
				cursor.children!.push({ name: part, path, type: 'file', size: file.size });
				break;
			}
			let next = cursor.children!.find((child) => child.type === 'dir' && child.name === part);
			if (!next) {
				next = { name: part, path, type: 'dir', children: [] };
				cursor.children!.push(next);
			}
			cursor = next;
		}
	}
	sortTree(root);
	return root.children ?? [];
}

function sortTree(node: TreeNode): void {
	if (!node.children) return;
	node.children.sort((a, b) => {
		if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
	});
	for (const child of node.children) sortTree(child);
}

export function basename(path: string): string {
	return path.split('/').pop() ?? path;
}

/** The URL of a release file or artifact, scoped to one project and deployment. */
export function sourceFileUrl(
	slug: string,
	deployment: string,
	path: string,
	download = false
): string {
	const params = new URLSearchParams({ deployment, path });
	if (download) params.set('download', '1');
	return `/projects/${encodeURIComponent(slug)}/source/file?${params.toString()}`;
}

export function dirname(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? '' : path.slice(0, index);
}

/**
 * Subsequence match with bonuses for segment starts and a strong basename hit, so typing `app`
 * ranks `assets/app.js` above `_app/immutable/graph.js`.
 */
export function fuzzyScore(query: string, path: string): number | null {
	const needle = query.trim().toLowerCase();
	if (!needle) return 0;
	const haystack = path.toLowerCase();
	let score = 0;
	let cursor = 0;
	for (const char of needle) {
		const index = haystack.indexOf(char, cursor);
		if (index === -1) return null;
		score += index === cursor ? 2 : 1;
		const before = haystack[index - 1];
		if (index === 0 || before === '/' || before === '.' || before === '-' || before === '_')
			score += 6;
		cursor = index + 1;
	}
	const name = haystack.slice(haystack.lastIndexOf('/') + 1);
	if (name.startsWith(needle)) score += 30;
	else if (name.includes(needle)) score += 15;
	score -= path.length * 0.01;
	return score;
}

export function searchFiles(files: SourceFile[], query: string): SourceFile[] {
	const needle = query.trim();
	if (!needle) return files;
	return files
		.map((file) => ({ file, score: fuzzyScore(needle, file.path) }))
		.filter((entry): entry is { file: SourceFile; score: number } => entry.score !== null)
		.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
		.map((entry) => entry.file);
}

/** Ancestor directory paths, outermost first, for expanding the tree to a file. */
export function ancestorsOf(path: string): string[] {
	const parts = path.split('/');
	const out: string[] = [];
	for (let index = 1; index < parts.length; index++) out.push(parts.slice(0, index).join('/'));
	return out;
}
