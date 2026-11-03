import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { zipSync } from 'fflate';
import { limits } from '@skiff/contracts';
import { BuildValidationError } from './command.ts';

export interface ZipDirectoryOptions {
	/** Uncompressed size cap for the whole artifact. */
	maxBytes?: number;
	/** Per-file uncompressed size cap. */
	maxFileBytes?: number;
	maxFiles?: number;
}

export interface ZippedDirectory {
	zip: Uint8Array;
	fileCount: number;
	sizeBytes: number;
}

/**
 * Zip an output directory for the control plane. Traversal cannot occur (paths are derived from
 * the directory walk), symlinks are skipped, and the same limits the server enforces are checked
 * before the upload so a huge build fails on the Builder instead of after a long transfer.
 */
export async function zipDirectory(root: string, options: ZipDirectoryOptions = {}): Promise<ZippedDirectory> {
	const maxBytes = options.maxBytes ?? limits.artifactBytes;
	const maxFileBytes = options.maxFileBytes ?? limits.fileBytes;
	const maxFiles = options.maxFiles ?? limits.files;
	const rootStat = await stat(root).catch(() => null);
	if (!rootStat?.isDirectory()) throw new BuildValidationError(`outputDir "${root}" is not a directory`);

	const files: Record<string, Uint8Array> = {};
	let fileCount = 0;
	let sizeBytes = 0;

	async function walk(directory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (entry.name === '.DS_Store') continue;
			const full = join(directory, entry.name);
			// Never follow a symlink: an output directory must not reach outside itself.
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			const data = new Uint8Array(await readFile(full));
			if (data.byteLength > maxFileBytes)
				throw new BuildValidationError(`"${relative(root, full)}" is larger than ${maxFileBytes} bytes`);
			fileCount += 1;
			sizeBytes += data.byteLength;
			if (fileCount > maxFiles) throw new BuildValidationError(`outputDir has more than ${maxFiles} files`);
			if (sizeBytes > maxBytes) throw new BuildValidationError(`outputDir is larger than ${maxBytes} bytes`);
			files[relative(root, full).split(sep).join('/')] = data;
		}
	}

	await walk(root);
	if (fileCount === 0) throw new BuildValidationError('outputDir contains no files');
	const zip = zipSync(files, { level: 6 });
	if (zip.byteLength > maxBytes) throw new BuildValidationError(`zip is larger than ${maxBytes} bytes`);
	return { zip, fileCount, sizeBytes };
}
