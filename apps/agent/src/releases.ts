import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { limits, type DesiredState, type ReleaseSpec } from '@skiff/contracts';
import { isProductionRoute } from './caddy-config.ts';

/**
 * Release cache. Artifacts are zips in R2; the agent downloads each missing artifact once,
 * validates it, extracts it into an immutable content-addressed directory and then flips the
 * project symlink. Serving never depends on R2 (DESIGN §4, §9).
 */

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP64_U32 = 0xffffffff;
const ZIP64_U16 = 0xffff;
const MAX_ENTRY_PATH = 4096;
// The artifact limit is uncompressed content; 20k central-directory entries add a little overhead.
const MAX_ARCHIVE_BYTES = limits.artifactBytes + 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export class ReleaseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ReleaseError';
	}
}

export interface ExtractResult {
	files: number;
	totalBytes: number;
}

export interface ExtractLimits {
	maxFiles?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
}

interface ZipSource {
	readonly size: number;
	read(position: number, length: number): Promise<Buffer>;
}

class BufferSource implements ZipSource {
	readonly size: number;
	private readonly data: Buffer;

	constructor(data: Uint8Array) {
		this.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
		this.size = this.data.length;
	}

	async read(position: number, length: number): Promise<Buffer> {
		return this.data.subarray(position, position + length);
	}
}

class FileSource implements ZipSource {
	readonly size: number;
	private readonly handle: fs.FileHandle;

	private constructor(handle: fs.FileHandle, size: number) {
		this.handle = handle;
		this.size = size;
	}

	static async open(path: string): Promise<FileSource> {
		const handle = await fs.open(path, 'r');
		try {
			const stat = await handle.stat();
			return new FileSource(handle, stat.size);
		} catch (error) {
			await handle.close().catch(() => undefined);
			throw error;
		}
	}

	async read(position: number, length: number): Promise<Buffer> {
		const clamped = Math.max(0, Math.min(length, this.size - position));
		if (clamped === 0) return Buffer.alloc(0);
		const buffer = Buffer.alloc(clamped);
		let offset = 0;
		while (offset < clamped) {
			const { bytesRead } = await this.handle.read(buffer, offset, clamped - offset, position + offset);
			if (bytesRead === 0) throw new ReleaseError('Unexpected end of zip archive');
			offset += bytesRead;
		}
		return buffer;
	}

	async close(): Promise<void> {
		await this.handle.close();
	}
}

/**
 * Normalize an archive entry name and reject anything that could escape the extraction root.
 * Backslashes are treated as separators, absolute paths and `..` segments are refused.
 */
export function safeEntryPath(rawName: string): string {
	if (rawName.length === 0 || rawName.length > MAX_ENTRY_PATH)
		throw new ReleaseError(`Invalid zip entry path length: ${rawName.length}`);
	if (rawName.includes('\0')) throw new ReleaseError('Zip entry path contains a NUL byte');

	const name = rawName.replace(/\\/g, '/');
	if (name.startsWith('/')) throw new ReleaseError(`Absolute path in zip: ${rawName}`);
	if (/^[A-Za-z]:/.test(name)) throw new ReleaseError(`Drive path in zip: ${rawName}`);

	const segments: string[] = [];
	for (const segment of name.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') throw new ReleaseError(`Path traversal in zip: ${rawName}`);
		segments.push(segment);
	}
	if (segments.length === 0) throw new ReleaseError(`Empty zip entry path: ${rawName}`);
	return segments.join('/');
}

/**
 * Extract a zip from bytes. Kept exported for tests and small files; production releases use
 * `extractZipFile` so a 500 MB artifact never has to sit in memory.
 */
export function extractZip(
	archive: Uint8Array,
	destination: string,
	options: ExtractLimits = {},
): Promise<ExtractResult> {
	return extractFromSource(new BufferSource(archive), destination, options);
}

export async function extractZipFile(
	archivePath: string,
	destination: string,
	options: ExtractLimits = {},
): Promise<ExtractResult> {
	const source = await FileSource.open(archivePath);
	try {
		return await extractFromSource(source, destination, options);
	} finally {
		await source.close();
	}
}

async function extractFromSource(
	source: ZipSource,
	destination: string,
	options: ExtractLimits,
): Promise<ExtractResult> {
	const maxFiles = options.maxFiles ?? limits.files;
	const maxFileBytes = options.maxFileBytes ?? limits.fileBytes;
	const maxTotalBytes = options.maxTotalBytes ?? limits.artifactBytes;
	const extracted = await prepareDestination(destination);

	const tailLength = Math.min(source.size, 22 + 0xffff);
	const tail = await source.read(source.size - tailLength, tailLength);
	const eocd = findEocd(tail);
	if (eocd < 0) throw new ReleaseError('Not a valid zip archive (no end-of-central-directory record)');

	const totalEntries = tail.readUInt16LE(eocd + 10);
	const cdSize = tail.readUInt32LE(eocd + 12);
	const cdOffset = tail.readUInt32LE(eocd + 16);
	const disk = tail.readUInt16LE(eocd + 4);
	const cdDisk = tail.readUInt16LE(eocd + 6);

	if (disk !== 0 || cdDisk !== 0) throw new ReleaseError('Multi-disk zip archives are not supported');
	if (totalEntries === ZIP64_U16 || cdSize === ZIP64_U32 || cdOffset === ZIP64_U32)
		throw new ReleaseError('ZIP64 archives are not supported');
	if (totalEntries > maxFiles + 5_000)
		throw new ReleaseError(`Zip has too many entries (${totalEntries})`);
	if (cdOffset + cdSize > source.size) throw new ReleaseError('Zip central directory is out of bounds');

	const central = await source.read(cdOffset, cdSize);
	let cursor = 0;
	let files = 0;
	let totalBytes = 0;
	const seen = new Set<string>();

	for (let index = 0; index < totalEntries; index++) {
		if (cursor + 46 > central.length) throw new ReleaseError('Truncated zip central directory');
		if (central.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER)
			throw new ReleaseError('Invalid zip central directory signature');

		const flags = central.readUInt16LE(cursor + 8);
		const method = central.readUInt16LE(cursor + 10);
		const crc = central.readUInt32LE(cursor + 16);
		const compressedSize = central.readUInt32LE(cursor + 20);
		const uncompressedSize = central.readUInt32LE(cursor + 24);
		const nameLength = central.readUInt16LE(cursor + 28);
		const extraLength = central.readUInt16LE(cursor + 30);
		const commentLength = central.readUInt16LE(cursor + 32);
		const externalAttributes = central.readUInt32LE(cursor + 38);
		const localOffset = central.readUInt32LE(cursor + 42);
		const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
		if (entryEnd > central.length) throw new ReleaseError('Truncated zip central directory entry');
		if (compressedSize === ZIP64_U32 || uncompressedSize === ZIP64_U32 || localOffset === ZIP64_U32)
			throw new ReleaseError('ZIP64 archives are not supported');

		const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameLength);
		let rawName: string;
		try {
			rawName = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
		} catch {
			throw new ReleaseError('Zip entry names must be valid UTF-8');
		}

		if (flags & 0x1) throw new ReleaseError(`Encrypted zip entry is not supported: ${rawName}`);
		if (method !== 0 && method !== 8)
			throw new ReleaseError(`Unsupported zip compression method ${method}: ${rawName}`);

		const mode = (externalAttributes >>> 16) & 0xffff;
		const fileType = mode & 0o170000;
		if (fileType === 0o120000) throw new ReleaseError(`Symlink in zip: ${rawName}`);
		if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000)
			throw new ReleaseError(`Unsupported zip entry type: ${rawName}`);

		const entryPath = safeEntryPath(rawName);
		const isDirectory = rawName.endsWith('/') || fileType === 0o040000;
		cursor = entryEnd;
		if (isDirectory) continue;

		if (seen.has(entryPath)) throw new ReleaseError(`Duplicate zip entry: ${entryPath}`);
		seen.add(entryPath);
		if (++files > maxFiles) throw new ReleaseError(`Zip has more than ${maxFiles} files`);

		const compressed = await readLocalData(source, localOffset, compressedSize);
		let data: Buffer;
		if (method === 0) {
			data = Buffer.from(compressed);
		} else {
			try {
				data = inflateRawSync(compressed, { maxOutputLength: maxFileBytes + 1 });
			} catch (error) {
				throw new ReleaseError(
					`Failed to inflate ${entryPath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		if (data.length !== uncompressedSize)
			throw new ReleaseError(`Size mismatch for ${entryPath}`);
		if (data.length > maxFileBytes)
			throw new ReleaseError(`File ${entryPath} exceeds the ${maxFileBytes}-byte limit`);
		totalBytes += data.length;
		if (totalBytes > maxTotalBytes)
			throw new ReleaseError(`Archive exceeds the ${maxTotalBytes}-byte uncompressed limit`);
		if ((crc32(data) >>> 0) !== crc) throw new ReleaseError(`CRC mismatch for ${entryPath}`);

		const target = resolve(extracted, entryPath);
		if (!target.startsWith(`${extracted}${sep}`))
			throw new ReleaseError(`Refusing to write outside the release directory: ${entryPath}`);
		await fs.mkdir(dirname(target), { recursive: true, mode: 0o755 });
		const executable = (mode & 0o111) !== 0;
		await fs.writeFile(target, data, { flag: 'wx', mode: executable ? 0o755 : 0o644 });
	}

	return { files, totalBytes };
}

async function readLocalData(
	source: ZipSource,
	localOffset: number,
	compressedSize: number,
): Promise<Buffer> {
	if (localOffset + 30 > source.size) throw new ReleaseError('Zip local header is out of bounds');
	const header = await source.read(localOffset, 30);
	if (header.readUInt32LE(0) !== ZIP_LOCAL_HEADER)
		throw new ReleaseError('Invalid zip local header signature');
	const nameLength = header.readUInt16LE(26);
	const extraLength = header.readUInt16LE(28);
	const dataStart = localOffset + 30 + nameLength + extraLength;
	if (dataStart + compressedSize > source.size)
		throw new ReleaseError('Zip entry data is out of bounds');
	return source.read(dataStart, compressedSize);
}

function findEocd(tail: Buffer): number {
	for (let i = tail.length - 22; i >= 0; i--) {
		if (tail.readUInt32LE(i) !== ZIP_EOCD) continue;
		const commentLength = tail.readUInt16LE(i + 20);
		if (i + 22 + commentLength <= tail.length) return i;
	}
	return -1;
}

async function prepareDestination(destination: string): Promise<string> {
	await fs.mkdir(destination, { recursive: true, mode: 0o755 });
	const stat = await fs.lstat(destination);
	if (!stat.isDirectory()) throw new ReleaseError(`Extraction destination is not a directory: ${destination}`);
	const existing = await fs.readdir(destination);
	if (existing.length > 0) throw new ReleaseError(`Extraction directory is not empty: ${destination}`);
	return resolve(destination);
}

export interface ReleaseInfo {
	sha256: string;
	sizeBytes: number;
}

/**
 * Owns `${dataDir}/releases/<sha256>/` and `${dataDir}/sites/<projectId>`.
 * The latter is a symlink, so promote/rollback needs only an atomic rename and no Caddy call.
 */
export class ReleaseManager {
	readonly dataDir: string;
	readonly releasesDir: string;
	readonly sitesDir: string;
	readonly tmpDir: string;
	private readonly sizes = new Map<string, number>();
	private ready = false;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
		this.releasesDir = join(dataDir, 'releases');
		this.sitesDir = join(dataDir, 'sites');
		this.tmpDir = join(dataDir, 'tmp');
	}

	/** Create directories, drop debris from a crash and learn current release sizes. */
	async init(): Promise<void> {
		await fs.mkdir(this.releasesDir, { recursive: true, mode: 0o755 });
		await fs.mkdir(this.sitesDir, { recursive: true, mode: 0o755 });
		await fs.mkdir(this.tmpDir, { recursive: true, mode: 0o700 });

		for (const name of await fs.readdir(this.tmpDir)) {
			await fs.rm(join(this.tmpDir, name), { recursive: true, force: true }).catch(() => undefined);
		}
		for (const entry of await fs.readdir(this.releasesDir, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.startsWith('.tmp-'))
				await fs.rm(join(this.releasesDir, entry.name), { recursive: true, force: true }).catch(() => undefined);
		}

		for (const entry of await fs.readdir(this.releasesDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || !SHA256_PATTERN.test(entry.name)) continue;
			this.sizes.set(entry.name, await directorySize(join(this.releasesDir, entry.name)));
		}
		this.ready = true;
	}

	releasePath(sha256: string): string {
		if (!SHA256_PATTERN.test(sha256)) throw new ReleaseError(`Invalid release hash: ${sha256}`);
		return join(this.releasesDir, sha256);
	}

	sitePath(projectId: string): string {
		if (!PROJECT_ID_PATTERN.test(projectId) || projectId === '.' || projectId === '..')
			throw new ReleaseError(`Invalid project id: ${projectId}`);
		return join(this.sitesDir, projectId);
	}

	async hasRelease(sha256: string): Promise<boolean> {
		try {
			const stat = await fs.stat(this.releasePath(sha256));
			return stat.isDirectory();
		} catch {
			return false;
		}
	}

	/**
	 * Download and install a release if it is missing. The destination appears atomically, so a
	 * half-written archive can never be served or activated.
	 */
	async ensureRelease(spec: ReleaseSpec, signal?: AbortSignal): Promise<boolean> {
		if (!SHA256_PATTERN.test(spec.sha256)) throw new ReleaseError(`Invalid release hash: ${spec.sha256}`);
		if (await this.hasRelease(spec.sha256)) return false;
		if (!spec.url) throw new ReleaseError(`Release ${spec.sha256} is missing locally and has no download URL`);

		let url: URL;
		try {
			url = new URL(spec.url);
		} catch {
			throw new ReleaseError(`Release ${spec.sha256} has an invalid download URL`);
		}
		if (url.protocol !== 'https:' && url.protocol !== 'http:')
			throw new ReleaseError(`Release ${spec.sha256} must be downloaded over http(s)`);

		const zipPath = join(this.tmpDir, `${spec.sha256}-${randomUUID()}.zip`);
		const extractPath = join(this.releasesDir, `.tmp-${spec.sha256}-${randomUUID()}`);
		const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

		try {
			const response = await fetch(url, { signal: combined });
			if (!response.ok) {
				throw new ReleaseError(
					`Download of release ${spec.sha256} failed: ${response.status} ${await response.text().catch(() => '')}`,
				);
			}
			await Bun.write(zipPath, response);
			const stat = await fs.stat(zipPath);
			if (stat.size > MAX_ARCHIVE_BYTES)
				throw new ReleaseError(`Release archive ${spec.sha256} exceeds the size limit`);

			// `sizeBytes`/`fileCount` describe the original artifact, while the zip also contains
			// precompressed `.br`/`.gz` siblings. Only use them as a lower-bound sanity check;
			// per-entry CRC verification is the real integrity check.
			const result = await extractZipFile(zipPath, extractPath);
			if (spec.sizeBytes > 0 && result.totalBytes < spec.sizeBytes)
				throw new ReleaseError(`Release ${spec.sha256} extracted smaller than the manifest size`);
			if (spec.fileCount > 0 && result.files < spec.fileCount)
				throw new ReleaseError(`Release ${spec.sha256} extracted fewer files than the manifest count`);
			try {
				await fs.rename(extractPath, this.releasePath(spec.sha256));
			} catch (error) {
				// Another process (or a retry) won the race; the content-addressed dir is identical.
				if (await this.hasRelease(spec.sha256)) {
					await fs.rm(extractPath, { recursive: true, force: true });
					return false;
				}
				throw error;
			}
			this.sizes.set(spec.sha256, result.totalBytes);
			return true;
		} catch (error) {
			await fs.rm(extractPath, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		} finally {
			await fs.rm(zipPath, { force: true }).catch(() => undefined);
		}
	}

	/** Atomically point a project at a release (rename over the old symlink). */
	async activate(projectId: string, sha256: string): Promise<void> {
		const target = this.releasePath(sha256);
		const link = this.sitePath(projectId);
		if (!(await this.hasRelease(sha256)))
			throw new ReleaseError(`Cannot activate missing release ${sha256} for ${projectId}`);

		try {
			const current = await fs.readlink(link);
			if (current === target) return;
		} catch {
			// Missing or not a symlink — replace it below.
		}

		await fs.mkdir(this.sitesDir, { recursive: true, mode: 0o755 });
		const tmp = join(this.sitesDir, `.${projectId}.tmp-${randomUUID()}`);
		try {
			await fs.symlink(target, tmp);
			await fs.rename(tmp, link);
		} catch (error) {
			await fs.rm(tmp, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	/** Actual releases on disk, for heartbeats. */
	listReleases(): ReleaseInfo[] {
		if (!this.ready) return [];
		return [...this.sizes.entries()]
			.map(([sha256, sizeBytes]) => ({ sha256, sizeBytes }))
			.sort((a, b) => a.sha256.localeCompare(b.sha256));
	}

	/** Keep every release in desired state plus two older ones; delete stale site symlinks. */
	async gc(desired: DesiredState): Promise<void> {
		const keep = new Set<string>(desired.releases.map((release) => release.sha256));
		for (const route of desired.routes) if (!route.upstream) keep.add(route.release);

		const candidates: Array<{ sha: string; mtimeMs: number }> = [];
		for (const entry of await fs.readdir(this.releasesDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || !SHA256_PATTERN.test(entry.name) || keep.has(entry.name)) continue;
			const stat = await fs.stat(join(this.releasesDir, entry.name));
			candidates.push({ sha: entry.name, mtimeMs: stat.mtimeMs });
		}
		candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
		for (const stale of candidates.slice(2)) {
			await fs.rm(join(this.releasesDir, stale.sha), { recursive: true, force: true });
			this.sizes.delete(stale.sha);
		}

		// Only production routes go through `sites/<projectId>`; previews are rooted at releases.
		const projects = new Set(
			desired.routes
				.filter((route) => !route.upstream && isProductionRoute(route, desired.contentDomain))
				.map((route) => route.projectId),
		);
		for (const entry of await fs.readdir(this.sitesDir, { withFileTypes: true })) {
			if (!entry.isSymbolicLink() || projects.has(entry.name)) continue;
			await fs.rm(join(this.sitesDir, entry.name), { force: true }).catch(() => undefined);
		}
	}
}

async function directorySize(path: string): Promise<number> {
	let total = 0;
	const entries = await fs.readdir(path, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(path, entry.name);
		if (entry.isDirectory()) total += await directorySize(full);
		else if (entry.isFile()) total += (await fs.stat(full)).size;
	}
	return total;
}
