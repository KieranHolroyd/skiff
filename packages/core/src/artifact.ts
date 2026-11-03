import { unzipSync, zipSync } from 'fflate';
import { constants as zlibConstants, brotliCompressSync, gzipSync } from 'node:zlib';
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
	let unzipped: Record<string, Uint8Array>;
	try {
		unzipped = unzipSync(zip, {
			filter: (file) => !file.name.endsWith('/') && !file.name.split('/').some((p) => p === '.DS_Store'),
		});
	} catch {
		throw new ValidationError('Upload is not a valid zip archive.');
	}
	const entries = Object.entries(unzipped).map(([path, data]) => ({ path: normalizePath(path), data }));
	if (entries.length === 0) throw new ValidationError('The archive contains no files.');
	return entries;
}

/**
 * Build a content-addressed release: hash each file, hash the canonical manifest (zips are not
 * deterministic), optionally precompress text assets so Caddy can serve `.br`/`.gz` directly.
 */
export function buildArtifact(inputEntries: FileEntry[], options: { precompress?: boolean; maxBytes?: number } = {}): ReleaseArtifact {
	const entries = [...inputEntries].sort((a, b) => a.path.localeCompare(b.path));
	const sizeBytes = validateEntries(entries, options.maxBytes ?? limits.artifactBytes);

	const files: Record<string, Uint8Array> = {};
	let precompressBudget = MAX_PRECOMPRESS_TOTAL;
	let precompressed = false;
	let totalCompressed = 0;

	for (const entry of entries) {
		files[entry.path] = entry.data;
		const extension = entry.path.slice(entry.path.lastIndexOf('.'));
		if (
			options.precompress !== false &&
			extension &&
			TEXT_EXTENSIONS.has(extension) &&
			entry.data.byteLength <= MAX_PRECOMPRESS_FILE &&
			entry.data.byteLength <= precompressBudget &&
			!entry.path.endsWith('.br') &&
			!entry.path.endsWith('.gz')
		) {
			files[`${entry.path}.br`] = brotliCompressSync(entry.data, {
				params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
			});
			files[`${entry.path}.gz`] = gzipSync(entry.data, { level: 6 });
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
	const zip = zipSync(files, { level: 6 });

	return {
		zip,
		sha256,
		sizeBytes,
		fileCount: entries.length,
		manifest,
		precompressed: precompressed && totalCompressed > 0,
	};
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
