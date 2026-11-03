import { unzipSync, zipSync } from 'fflate';
import { promisify } from 'node:util';
import { constants as zlibConstants, brotliCompress, gzip } from 'node:zlib';
import { limits } from '@skiff/contracts';
import { ValidationError } from './errors.ts';
import { sha256Hex } from './util.ts';

export interface FileEntry {
	path: string;
	data: Uint8Array;
}

export interface ManifestFile {
	path: string;
	size: number;
	sha256: string;
	precompressed: boolean;
}

export interface ReleaseArtifact {
	zip: Uint8Array;
	sha256: string;
	sizeBytes: number;
	fileCount: number;
	manifest: ManifestFile[];
	precompressed: boolean;
}

const TEXT_EXTENSIONS = new Set([
	'.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.map', '.svg',
	'.txt', '.xml', '.webmanifest', '.md', '.csv', '.wasm',
]);
const MAX_PRECOMPRESS_FILE = 5 * 1024 * 1024;
const MAX_PRECOMPRESS_TOTAL = 100 * 1024 * 1024;
/** Formats that are already compressed; deflating them again only burns CPU. */
const STORED_EXTENSIONS = new Set([
	'.br', '.gz', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
	'.woff', '.woff2', '.mp4', '.webm', '.mp3', '.ogg', '.pdf',
]);
const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Reject traversal, absolute paths, NULs and duplicates before anything touches disk. */
export function normalizePath(path: string): string {
	const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
	if (!normalized || normalized === '.' || normalized.startsWith('/'))
		throw new ValidationError(`Invalid file path "${path}".`);
	if (normalized.split('/').some((part) => part === '..' || part === ''))
		throw new ValidationError(`Invalid file path "${path}".`);
	if (normalized.includes('\0') || normalized.length > 1024)
		throw new ValidationError(`Invalid file path "${path}".`);
	return normalized;
}

export function validateEntries(entries: FileEntry[], maxBytes = limits.artifactBytes): number {
	if (entries.length === 0) throw new ValidationError('No files to deploy.');
	if (entries.length > limits.files)
		throw new ValidationError(`Too many files (${entries.length}); the limit is ${limits.files}.`);
	const seen = new Set<string>();
	let total = 0;
	for (const entry of entries) {
		if (seen.has(entry.path)) throw new ValidationError(`Duplicate file "${entry.path}".`);
		seen.add(entry.path);
		if (entry.data.byteLength > limits.fileBytes)
			throw new ValidationError(
				`"${entry.path}" is ${entry.data.byteLength} bytes; the per-file limit is ${limits.fileBytes}.`,
			);
		total += entry.data.byteLength;
	}
	if (total > maxBytes)
		throw new ValidationError(`Artifact is ${total} bytes; the limit is ${maxBytes}.`);
	return total;
}

export function entriesFromFiles(files: Array<{ path: string; data: Uint8Array }>): FileEntry[] {
	const entries = files.map((file) => ({ path: normalizePath(file.path), data: file.data }));
	// Drop OS metadata that would otherwise be served.
	return entries.filter((entry) => !entry.path.split('/').some((part) => part === '.DS_Store'));
}

export function entriesFromZip(zip: Uint8Array): FileEntry[] {
	if (zip.byteLength > limits.artifactBytes)
		throw new ValidationError(`Archive is ${zip.byteLength} bytes; the limit is ${limits.artifactBytes}.`);
	// Enforce the limits on the declared (central directory) sizes *before* inflating anything, so a
	// small zip bomb can't expand into gigabytes in memory. fflate inflates into a buffer of exactly
	// `originalSize`, so an entry that lies about its size can't grow past it either.
	let rejection: ValidationError | undefined;
	let count = 0;
	let total = 0;
	let unzipped: Record<string, Uint8Array>;
	try {
		unzipped = unzipSync(zip, {
			filter: (file) => {
				if (rejection) return false;
				if (file.name.endsWith('/') || file.name.split('/').some((p) => p === '.DS_Store')) return false;
				count++;
				total += file.originalSize;
				if (file.originalSize > limits.fileBytes)
					rejection = new ValidationError(
						`"${file.name}" is ${file.originalSize} bytes; the per-file limit is ${limits.fileBytes}.`,
					);
				else if (count > limits.files)
					rejection = new ValidationError(`Too many files (more than ${limits.files}); the limit is ${limits.files}.`);
				else if (total > limits.artifactBytes)
					rejection = new ValidationError(
						`Archive expands to more than ${limits.artifactBytes} bytes; the limit is ${limits.artifactBytes}.`,
					);
				return !rejection;
			},
		});
	} catch {
		throw rejection ?? new ValidationError('Upload is not a valid zip archive.');
	}
	if (rejection) throw rejection;
	const entries = Object.entries(unzipped).map(([path, data]) => ({ path: normalizePath(path), data }));
	if (entries.length === 0) throw new ValidationError('The archive contains no files.');
	return entries;
}

/**
 * Build a content-addressed release: hash each file, hash the canonical manifest (zips are not
 * deterministic), optionally precompress text assets so Caddy can serve `.br`/`.gz` directly.
 *
 * Compression uses the async zlib APIs (libuv threadpool), so a large finalize doesn't block the
 * event loop that also serves the dashboard, MCP and agent long-polls (DESIGN §4). Already-compressed
 * files are stored rather than deflated again.
 */
export async function buildArtifact(
	inputEntries: FileEntry[],
	options: { precompress?: boolean; maxBytes?: number } = {},
): Promise<ReleaseArtifact> {
	const entries = [...inputEntries].sort((a, b) => a.path.localeCompare(b.path));
	const sizeBytes = validateEntries(entries, options.maxBytes ?? limits.artifactBytes);

	const files: Record<string, Uint8Array> = {};
	let precompressBudget = MAX_PRECOMPRESS_TOTAL;
	let precompressed = false;
	let totalCompressed = 0;

	for (const entry of entries) {
		files[entry.path] = entry.data;
		const extension = extensionOf(entry.path);
		if (
			options.precompress !== false &&
			extension &&
			TEXT_EXTENSIONS.has(extension) &&
			entry.data.byteLength <= MAX_PRECOMPRESS_FILE &&
			entry.data.byteLength <= precompressBudget &&
			!entry.path.endsWith('.br') &&
			!entry.path.endsWith('.gz')
		) {
			const [br, gz] = await Promise.all([
				brotliAsync(entry.data, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
				gzipAsync(entry.data, { level: 6 }),
			]);
			files[`${entry.path}.br`] = new Uint8Array(br);
			files[`${entry.path}.gz`] = new Uint8Array(gz);
			precompressBudget -= entry.data.byteLength;
			totalCompressed += entry.data.byteLength;
			precompressed = true;
		}
	}

	const manifest: ManifestFile[] = entries.map((entry) => ({
		path: entry.path,
		size: entry.data.byteLength,
		sha256: sha256Hex(entry.data),
		precompressed: files[`${entry.path}.br`] !== undefined,
	}));

	const sha256 = sha256Hex(JSON.stringify(manifest));
	const zip = zipSync(
		Object.fromEntries(
			Object.entries(files).map(([path, data]) => [
				path,
				[data, { level: STORED_EXTENSIONS.has(extensionOf(path).toLowerCase()) ? 0 : 6 }] as const,
			]),
		) as Parameters<typeof zipSync>[0],
	);

	return {
		zip,
		sha256,
		sizeBytes,
		fileCount: entries.length,
		manifest,
		precompressed: precompressed && totalCompressed > 0,
	};
}

function extensionOf(path: string): string {
	const slash = path.lastIndexOf('/');
	const dot = path.lastIndexOf('.');
	return dot > slash ? path.slice(dot) : '';
}

export function parseManifest(json: string): ManifestFile[] {
	try {
		const parsed = JSON.parse(json) as ManifestFile[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** The file map used by site-config parsing (only the canonical entries, not precompressed twins). */
export function entryMap(entries: FileEntry[]): Map<string, Uint8Array> {
	return new Map(entries.map((entry) => [entry.path, entry.data]));
}
