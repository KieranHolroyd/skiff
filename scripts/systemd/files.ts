/**
 * Binary comparisons for release-managed payloads (the helper and Caddy).
 *
 * Both files can be well over 100 MiB and are compared on every update. Reading either whole
 * file into memory (the previous `readFileSync(a).equals(readFileSync(b))`) allocated both at
 * once and stalled the updater; these helpers walk them in fixed-size chunks instead.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';

const CHUNK = 1024 * 1024;

/** sha256 hex of a file, read in chunks so a large binary never lands in memory. */
export function sha256File(path: string): string {
	const hash = createHash('sha256');
	const fd = openSync(path, 'r');
	const buffer = Buffer.allocUnsafe(CHUNK);
	try {
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read === 0) break;
			hash.update(buffer.subarray(0, read));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest('hex');
}

/** Byte-for-byte equality without loading either file whole; a size mismatch short-circuits. */
export function filesEqual(a: string, b: string): boolean {
	let size: number;
	try {
		size = statSync(a).size;
		if (size !== statSync(b).size) return false;
	} catch {
		return false;
	}
	const left = openSync(a, 'r');
	const right = openSync(b, 'r');
	const one = Buffer.allocUnsafe(CHUNK);
	const two = Buffer.allocUnsafe(CHUNK);
	try {
		for (;;) {
			const read = readSync(left, one, 0, CHUNK, null);
			if (read === 0) return true;
			const other = readSync(right, two, 0, read, null);
			if (other !== read) return false;
			if (!one.subarray(0, read).equals(two.subarray(0, other))) return false;
		}
	} finally {
		closeSync(left);
		closeSync(right);
	}
}
