/**
 * Directory collection and a small, dependency-free ZIP writer.
 *
 * The control plane accepts a plain zip of the site. We deliberately keep the CLI
 * dependency-free (it is published to npm) and use `node:zlib` for deflate.
 *
 * Exclusions: `.git`, `node_modules`, `.DS_Store`, plus `.gitignore` rules from the
 * deployed directory and its subdirectories. The server enforces the same limits at
 * finalize; checking locally lets us fail before uploading 500 MB.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { CliError } from './errors.ts';
import { formatBytes } from './output.ts';

/** Mirrors `limits` in @skiff/contracts (DESIGN §4). Keep in sync. */
export const CLI_LIMITS = {
	artifactBytes: 500 * 1024 * 1024,
	fileBytes: 25 * 1024 * 1024,
	files: 20_000,
} as const;

export interface CollectedFile {
	/** Posix path relative to the deployed root. */
	path: string;
	absolutePath: string;
	size: number;
	mtimeMs: number;
}

export interface ZipEntry {
	path: string;
	data: Uint8Array;
	mtimeMs?: number;
}

export interface CollectResult {
	root: string;
	files: CollectedFile[];
	totalBytes: number;
	warnings: string[];
}

export interface ZipResult {
	zip: Uint8Array;
	files: CollectedFile[];
	fileCount: number;
	totalBytes: number;
	warnings: string[];
}

interface IgnoreRule {
	base: string;
	regex: RegExp;
	negated: boolean;
	dirOnly: boolean;
}

const HARD_EXCLUDES = new Set(['.git', 'node_modules', '.DS_Store']);

export async function collectFiles(rootInput: string): Promise<CollectResult> {
	const root = resolve(rootInput);
	let rootInfo;
	try {
		rootInfo = await stat(root);
	} catch {
		throw new CliError(`Directory not found: ${rootInput}`);
	}
	if (!rootInfo.isDirectory()) throw new CliError(`Not a directory: ${rootInput}`);

	const files: CollectedFile[] = [];
	const warnings: string[] = [];
	let totalBytes = 0;

	const walk = async (dir: string, relDir: string, inheritedRules: IgnoreRule[]): Promise<void> => {
		const rules = [...inheritedRules, ...(await readIgnoreRules(dir, relDir))];
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			throw new CliError(`Could not read ${dir}: ${messageOf(error)}`);
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));

		for (const entry of entries) {
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			// Hard excludes are never overridable by a `.gitignore` negation.
			if (HARD_EXCLUDES.has(entry.name)) continue;

			let isDir = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				warnings.push(`Skipped symlink ${rel}`);
				continue;
			}
			if (!isDir && !isFile) {
				// Sockets, FIFOs, devices: not deployable content.
				warnings.push(`Skipped special file ${rel}`);
				continue;
			}
			if (isIgnored(rel, isDir, rules)) continue;

			const absolute = join(dir, entry.name);
			if (isDir) {
				await walk(absolute, rel, rules);
				continue;
			}

			let info;
			try {
				info = await stat(absolute);
			} catch (error) {
				throw new CliError(`Could not read ${rel}: ${messageOf(error)}`);
			}
			if (info.size > CLI_LIMITS.fileBytes)
				throw new CliError(
					`"${rel}" is ${formatBytes(info.size)}; the per-file limit is ${formatBytes(CLI_LIMITS.fileBytes)}.`,
				);
			totalBytes += info.size;
			if (totalBytes > CLI_LIMITS.artifactBytes)
				throw new CliError(
					`The site is larger than ${formatBytes(CLI_LIMITS.artifactBytes)} (the artifact limit).`,
				);
			files.push({ path: rel, absolutePath: absolute, size: info.size, mtimeMs: info.mtimeMs });
			if (files.length > CLI_LIMITS.files)
				throw new CliError(`Too many files; the limit is ${CLI_LIMITS.files.toLocaleString('en-US')}.`);
		}
	};

	await walk(root, '', []);
	if (files.length === 0) throw new CliError('No files to deploy (everything was excluded or the directory is empty).');

	return { root, files, totalBytes, warnings };
}

export async function readEntries(files: CollectedFile[]): Promise<ZipEntry[]> {
	const entries: ZipEntry[] = [];
	for (const file of files) {
		let data: Uint8Array;
		try {
			data = new Uint8Array(await readFile(file.absolutePath));
		} catch (error) {
			throw new CliError(`Could not read ${file.path}: ${messageOf(error)}`);
		}
		entries.push({ path: file.path, data, mtimeMs: file.mtimeMs });
	}
	return entries;
}

/** Merge `spa: true` into `skiff.json` without touching the source tree. */
export function applySpaConfig(entries: ZipEntry[]): ZipEntry[] {
	const existing = entries.find((entry) => entry.path === 'skiff.json');
	let config: Record<string, unknown> = {};
	if (existing) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder().decode(existing.data));
		} catch {
			throw new CliError('skiff.json is not valid JSON; fix it before deploying with --spa.');
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
			throw new CliError('skiff.json must contain a JSON object.');
		config = parsed as Record<string, unknown>;
	}
	config.spa = true;
	const next = entries.filter((entry) => entry.path !== 'skiff.json');
	next.push({
		path: 'skiff.json',
		data: new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`),
		mtimeMs: existing?.mtimeMs,
	});
	return next;
}

export async function zipDirectory(root: string, options: { spa?: boolean } = {}): Promise<ZipResult> {
	const collected = await collectFiles(root);
	let entries = await readEntries(collected.files);
	if (options.spa) entries = applySpaConfig(entries);
	return {
		zip: buildZip(entries),
		files: collected.files,
		fileCount: collected.files.length,
		totalBytes: collected.totalBytes,
		warnings: collected.warnings,
	};
}

interface PreparedEntry {
	name: Buffer;
	method: number;
	crc: number;
	compressedSize: number;
	uncompressedSize: number;
	mtimeMs: number;
	payload: Buffer;
	offset: number;
}

/** Build a standard (non-ZIP64) archive. The artifact limits keep us below 4 GiB. */
export function buildZip(entries: ZipEntry[]): Uint8Array {
	const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
	const seen = new Set<string>();
	const prepared: PreparedEntry[] = [];
	const chunks: Buffer[] = [];
	let offset = 0;

	for (const entry of sorted) {
		const name = entry.path.replaceAll('\\', '/');
		if (!name || name.startsWith('/') || name.split('/').some((part) => part === '..' || part === ''))
			throw new CliError(`Invalid file path in archive: "${entry.path}".`);
		if (seen.has(name)) throw new CliError(`Duplicate file in archive: "${name}".`);
		seen.add(name);

		const data = Buffer.from(entry.data);
		const deflated = deflateRawSync(data, { level: 6 });
		const store = deflated.byteLength >= data.byteLength;
		const payload = store ? data : Buffer.from(deflated);
		const method = store ? 0 : 8;
		const crc = crc32(data);
		const nameBuffer = Buffer.from(name, 'utf8');
		const { time, date } = dosDateTime(entry.mtimeMs ?? Date.now());
		const flags = /^[\x20-\x7e]*$/.test(name) ? 0 : 0x0800;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(payload.byteLength, 18);
		local.writeUInt32LE(data.byteLength, 22);
		local.writeUInt16LE(nameBuffer.byteLength, 26);
		local.writeUInt16LE(0, 28);

		chunks.push(local, nameBuffer, payload);
		prepared.push({
			name: nameBuffer,
			method,
			crc,
			compressedSize: payload.byteLength,
			uncompressedSize: data.byteLength,
			mtimeMs: entry.mtimeMs ?? Date.now(),
			payload,
			offset,
		});
		offset += local.byteLength + nameBuffer.byteLength + payload.byteLength;
	}

	const centralOffset = offset;
	for (const entry of prepared) {
		const { time, date } = dosDateTime(entry.mtimeMs);
		const flags = /^[\x20-\x7e]*$/.test(entry.name.toString('utf8')) ? 0 : 0x0800;
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x0314, 4); // made by Unix, version 2.0
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(entry.method, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(entry.crc, 16);
		central.writeUInt32LE(entry.compressedSize, 20);
		central.writeUInt32LE(entry.uncompressedSize, 24);
		central.writeUInt16LE(entry.name.byteLength, 28);
		central.writeUInt16LE(0, 30); // extra
		central.writeUInt16LE(0, 32); // comment
		central.writeUInt16LE(0, 34); // disk
		central.writeUInt16LE(0, 36); // internal attributes
		central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, 0644
		central.writeUInt32LE(entry.offset, 42);
		chunks.push(central, entry.name);
		offset += central.byteLength + entry.name.byteLength;
	}

	const centralSize = offset - centralOffset;
	if (prepared.length > 0xffff) throw new CliError('Too many files for a standard zip archive.');
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(prepared.length, 8);
	end.writeUInt16LE(prepared.length, 10);
	end.writeUInt32LE(centralSize, 12);
	end.writeUInt32LE(centralOffset, 16);
	end.writeUInt16LE(0, 20);
	chunks.push(end);

	return new Uint8Array(Buffer.concat(chunks));
}

async function readIgnoreRules(dir: string, relDir: string): Promise<IgnoreRule[]> {
	let text: string;
	try {
		text = await readFile(join(dir, '.gitignore'), 'utf8');
	} catch (error) {
		if (isRecord(error) && error.code === 'ENOENT') return [];
		throw new CliError(`Could not read ${relDir ? `${relDir}/` : ''}.gitignore: ${messageOf(error)}`);
	}
	return parseGitignore(text, relDir);
}

export function parseGitignore(text: string, base = ''): IgnoreRule[] {
	const rules: IgnoreRule[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		let line = rawLine.replace(/\s+$/, '');
		if (!line || line.startsWith('#')) continue;
		if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
		let negated = false;
		if (line.startsWith('!')) {
			negated = true;
			line = line.slice(1);
		}
		if (!line) continue;
		let dirOnly = false;
		if (line.endsWith('/')) {
			dirOnly = true;
			line = line.replace(/\/+$/, '');
		}
		let anchored = line.startsWith('/');
		if (anchored) line = line.slice(1);
		if (!line) continue;
		if (line.includes('/')) anchored = true;
		const source = globToRegex(line, anchored);
		try {
			rules.push({ base, regex: new RegExp(source), negated, dirOnly });
		} catch {
			// Ignore malformed patterns rather than making the CLI unusable.
		}
	}
	return rules;
}

function globToRegex(pattern: string, anchored: boolean): string {
	let out = '';
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]!;
		if (char === '*') {
			if (pattern[i + 1] === '*') {
				i++;
				if (pattern[i + 1] === '/') {
					i++;
					out += '(?:.*/)?';
				} else {
					out += '.*';
				}
			} else {
				out += '[^/]*';
			}
		} else if (char === '?') {
			out += '[^/]';
		} else if (char === '[') {
			const end = pattern.indexOf(']', i + 1);
			if (end === -1) {
				out += '\\[';
			} else {
				const body = pattern.slice(i + 1, end).replace(/\\/g, '\\\\');
				out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
				i = end;
			}
		} else if ('\\.+()|^${}'.includes(char)) {
			out += `\\${char}`;
		} else {
			out += char;
		}
	}
	if (anchored) return `^${out}$`;
	return `(?:^|/)${out}(?:$|/)`;
}

function isIgnored(path: string, isDir: boolean, rules: IgnoreRule[]): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (rule.base) {
			if (path !== rule.base && !path.startsWith(`${rule.base}/`)) continue;
		}
		if (rule.dirOnly && !isDir) continue;
		const relativePath = rule.base ? path.slice(rule.base.length + 1) : path;
		if (!relativePath) continue;
		if (rule.regex.test(relativePath)) ignored = !rule.negated;
	}
	return ignored;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(ms: number): { time: number; date: number } {
	const date = new Date(Number.isFinite(ms) ? ms : Date.now());
	const year = Math.min(2107, Math.max(1980, date.getFullYear()));
	const month = date.getMonth() + 1;
	const day = date.getDate();
	const hours = date.getHours();
	const minutes = date.getMinutes();
	const seconds = Math.floor(date.getSeconds() / 2);
	return {
		time: (hours << 11) | (minutes << 5) | seconds,
		date: ((year - 1980) << 9) | (month << 5) | day,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
