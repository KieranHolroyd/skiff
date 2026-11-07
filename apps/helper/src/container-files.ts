import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, type Stats } from 'node:fs';
import { posix } from 'node:path';
import { ValidationError } from './validate.ts';

/**
 * Read-only file access to a running container (D127), done by the root helper on the host side
 * so it works for distroless images too. The container's view is rebuilt from `podman inspect`:
 * the overlay's merged directory for `/` plus the bind mounts on top of it.
 *
 * The helper is root and the container's content is tenant-controlled, so a symlink such as
 * `/app/x -> /etc/shadow` must never make the helper read a host file. Two layers keep it inside:
 *
 *  1. Symlinks are expanded here, in container path space: an absolute target restarts at the
 *     container's `/`, `..` stops at `/`. This is what makes in-container links work at all.
 *  2. The guarantee: every file or directory is opened with `O_NOFOLLOW`, and the opened
 *     descriptor's real path (`/proc/self/fd/N`) must sit under the mount root it was resolved
 *     against. A link swapped in after step 1 is caught here, after `open`, so there is no race.
 *     Directories are then read through `/proc/self/fd/N`, never by path again.
 */

export interface ContainerMountView {
	/** Path inside the container (`/` for the root filesystem). */
	destination: string;
	/** Host path, or null when the helper cannot show it (tmpfs, the secrets dir). */
	source: string | null;
	type: string;
	readOnly: boolean;
	note: string | null;
}

export interface ContainerFileEntry {
	name: string;
	kind: 'file' | 'directory' | 'symlink' | 'socket' | 'fifo' | 'block' | 'char' | 'other';
	sizeBytes: number;
	mode: string;
	uid: number;
	gid: number;
	modifiedAt: string;
	linkTarget: string | null;
}

export interface ContainerDirListing {
	path: string;
	entries: ContainerFileEntry[];
	truncated: boolean;
	mount: string;
	readOnly: boolean;
}

export interface ContainerFilePreview {
	path: string;
	sizeBytes: number;
	modifiedAt: string;
	content: string | null;
	reason: 'binary' | 'too-large' | null;
}

export interface OpenedContainerFile {
	fd: number;
	path: string;
	name: string;
	sizeBytes: number;
	modifiedAt: string;
}

/** How descriptors map back to real paths; `/proc` on Linux, injectable for tests elsewhere. */
export interface FdView {
	realPath(fd: number, openedPath: string): string;
	/** A path that names the open descriptor itself, for `readdir`/`lstat` without re-resolving. */
	dirPath(fd: number, openedPath: string): string;
}

export const procFdView: FdView = {
	realPath: (fd) => readlinkSync(`/proc/self/fd/${fd}`),
	dirPath: (fd) => `/proc/self/fd/${fd}`,
};

export const MAX_SYMLINK_HOPS = 40;
export const SECRETS_DESTINATION = '/run/skiff-secrets';

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const O_CLOEXEC = (constants as Record<string, number>).O_CLOEXEC ?? 0;

export class ContainerFileError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 404 | 409 = 404,
	) {
		super(message);
	}
}

/** Normalise a requested container path: absolute, no NUL, `.`/`..` collapsed, no trailing `/`. */
export function normalizeContainerPath(raw: string, maxLength = 4_096): string {
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxLength)
		throw new ValidationError(`path must be 1-${maxLength} characters`);
	if (!raw.startsWith('/')) throw new ValidationError('path must be absolute');
	if (raw.includes('\0')) throw new ValidationError('path must not contain NUL');
	const normalized = posix.normalize(raw);
	// `posix.normalize('/..')` is `/`; a trailing slash is dropped except on the root.
	return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export class ContainerFilesystem {
	/** Mounts sorted longest destination first, so the most specific one wins. */
	private readonly mounts: Array<ContainerMountView & { root: string | null }>;

	constructor(
		mounts: ContainerMountView[],
		private readonly fdView: FdView = procFdView,
	) {
		if (!mounts.some((mount) => mount.destination === '/'))
			throw new ContainerFileError('The container has no root filesystem to browse.', 409);
		this.mounts = mounts
			.map((mount) => ({
				...mount,
				destination: normalizeContainerPath(mount.destination),
				// Real paths, so the descriptor check compares like with like (e.g. a symlinked
				// /var/lib/containers on the host).
				root: mount.source === null ? null : safeRealpath(mount.source),
			}))
			.sort((a, b) => b.destination.length - a.destination.length);
	}

	/** List one directory. Symlinks are listed as links, not followed (the dashboard follows them). */
	list(rawPath: string, maxEntries: number): ContainerDirListing {
		const path = this.resolve(normalizeContainerPath(rawPath));
		const mount = this.mountOf(path);
		const host = this.hostPath(path, mount);
		const fd = this.openVerified(host, mount, O_DIRECTORY);
		try {
			const base = this.fdView.dirPath(fd, host);
			const names = readdirSync(base).sort((a, b) => a.localeCompare(b));
			const entries: ContainerFileEntry[] = [];
			for (const name of names.slice(0, maxEntries)) {
				let stats: Stats;
				try {
					stats = lstatSync(`${base}/${name}`);
				} catch {
					continue; // Removed while listing.
				}
				const kind = kindOf(stats);
				let linkTarget: string | null = null;
				if (kind === 'symlink') {
					try {
						linkTarget = readlinkSync(`${base}/${name}`);
					} catch {
						linkTarget = null;
					}
				}
				entries.push(entryOf(name, stats, kind, linkTarget));
			}
			// A mount point inside this directory hides what the image has there: show the mount.
			for (const child of this.mounts) {
				if (child.destination === '/' || posix.dirname(child.destination) !== path) continue;
				const name = posix.basename(child.destination);
				if (!entries.some((entry) => entry.name === name) && entries.length < maxEntries)
					entries.push({
						name,
						kind: 'directory',
						sizeBytes: 0,
						mode: '0755',
						uid: 0,
						gid: 0,
						modifiedAt: new Date(0).toISOString(),
						linkTarget: null,
					});
			}
			entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
			return { path, entries, truncated: names.length > maxEntries, mount: mount.destination, readOnly: mount.readOnly };
		} finally {
			closeSync(fd);
		}
	}

	/** Open a regular file for reading; the caller owns (and must close) the descriptor. */
	open(rawPath: string): OpenedContainerFile {
		const path = this.resolve(normalizeContainerPath(rawPath));
		const mount = this.mountOf(path);
		const host = this.hostPath(path, mount);
		const fd = this.openVerified(host, mount, 0);
		try {
			const stats = fstatSync(fd);
			if (!stats.isFile()) throw new ContainerFileError('Only regular files can be read.', 400);
			return {
				fd,
				path,
				name: posix.basename(path) || 'file',
				sizeBytes: stats.size,
				modifiedAt: stats.mtime.toISOString(),
			};
		} catch (error) {
			closeSync(fd);
			throw error;
		}
	}

	/** Up to `maxBytes` of a text file; binary or larger files come back without content. */
	preview(rawPath: string, maxBytes: number): ContainerFilePreview {
		const file = this.open(rawPath);
		try {
			const base = { path: file.path, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt };
			if (file.sizeBytes > maxBytes) return { ...base, content: null, reason: 'too-large' };
			const buffer = Buffer.alloc(file.sizeBytes);
			let offset = 0;
			while (offset < buffer.length) {
				const read = readSync(file.fd, buffer, offset, buffer.length - offset, offset);
				if (read === 0) break;
				offset += read;
			}
			const bytes = buffer.subarray(0, offset);
			if (looksBinary(bytes)) return { ...base, content: null, reason: 'binary' };
			return { ...base, content: bytes.toString('utf8'), reason: null };
		} finally {
			closeSync(file.fd);
		}
	}

	/**
	 * Expand symlinks in container path space, like a chroot would: absolute targets restart at
	 * `/`, `..` never climbs above it. Paths inside unbrowsable mounts are refused.
	 */
	resolve(path: string): string {
		let hops = 0;
		let resolved = '/';
		const pending = path.split('/').filter(Boolean);
		while (pending.length > 0) {
			const part = pending.shift()!;
			if (part === '.') continue;
			if (part === '..') {
				resolved = posix.dirname(resolved);
				continue;
			}
			const candidate = resolved === '/' ? `/${part}` : `${resolved}/${part}`;
			const mount = this.mountOf(candidate);
			if (mount.destination === candidate) {
				// A mount point is always a directory from the container's point of view.
				resolved = candidate;
				continue;
			}
			let stats: Stats;
			try {
				stats = lstatSync(this.hostPath(candidate, mount));
			} catch {
				// Podman creates a mount point's parents; an image without them still has them.
				if (this.mounts.some((item) => item.destination.startsWith(`${candidate}/`))) {
					resolved = candidate;
					continue;
				}
				throw new ContainerFileError(`No such file or directory: ${candidate}`);
			}
			if (!stats.isSymbolicLink()) {
				resolved = candidate;
				continue;
			}
			hops += 1;
			if (hops > MAX_SYMLINK_HOPS) throw new ContainerFileError('Too many levels of symbolic links.', 400);
			const target = readlinkSync(this.hostPath(candidate, mount));
			pending.unshift(...target.split('/').filter(Boolean));
			if (target.startsWith('/')) resolved = '/';
		}
		return resolved;
	}

	private mountOf(path: string): ContainerMountView & { root: string | null } {
		const mount = this.mounts.find(
			(item) => item.destination === '/' || path === item.destination || path.startsWith(`${item.destination}/`),
		)!;
		if (mount.root === null)
			throw new ContainerFileError(
				mount.note === 'secrets'
					? 'Secret files are not shown in the file browser.'
					: `${mount.destination} is a ${mount.type} mount; open a shell to look inside it.`,
				403,
			);
		return mount;
	}

	private hostPath(path: string, mount: { destination: string; root: string | null }): string {
		const rest = mount.destination === '/' ? path : path.slice(mount.destination.length);
		return `${mount.root}${rest === '/' ? '' : rest}` || '/';
	}

	/** Open without following a final link, then prove the descriptor is inside the mount root. */
	private openVerified(host: string, mount: { root: string | null }, extraFlags: number): number {
		let fd: number;
		try {
			fd = openSync(host, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | extraFlags);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOTDIR') throw new ContainerFileError('Not a directory.', 400);
			if (code === 'ELOOP') throw new ContainerFileError('The path changed while it was being read.', 409);
			if (code === 'EACCES' || code === 'EPERM') throw new ContainerFileError('Permission denied.', 403);
			throw new ContainerFileError('No such file or directory.');
		}
		let real: string;
		try {
			real = this.fdView.realPath(fd, host);
		} catch {
			closeSync(fd);
			throw new ContainerFileError('The path could not be verified.', 409);
		}
		const root = mount.root!;
		if (real !== root && !real.startsWith(root.endsWith('/') ? root : `${root}/`)) {
			closeSync(fd);
			throw new ContainerFileError('The path leaves the container.', 403);
		}
		return fd;
	}
}

function safeRealpath(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

function kindOf(stats: Stats): ContainerFileEntry['kind'] {
	if (stats.isFile()) return 'file';
	if (stats.isDirectory()) return 'directory';
	if (stats.isSymbolicLink()) return 'symlink';
	if (stats.isSocket()) return 'socket';
	if (stats.isFIFO()) return 'fifo';
	if (stats.isBlockDevice()) return 'block';
	if (stats.isCharacterDevice()) return 'char';
	return 'other';
}

function entryOf(name: string, stats: Stats, kind: ContainerFileEntry['kind'], linkTarget: string | null): ContainerFileEntry {
	return {
		name,
		kind,
		sizeBytes: kind === 'file' || kind === 'symlink' ? stats.size : 0,
		mode: `0${(stats.mode & 0o7777).toString(8).padStart(3, '0')}`,
		uid: stats.uid,
		gid: stats.gid,
		modifiedAt: stats.mtime.toISOString(),
		linkTarget,
	};
}

/** NUL bytes or invalid UTF-8 in the first 8 KiB mean binary. */
export function looksBinary(bytes: Uint8Array): boolean {
	const head = bytes.subarray(0, 8_192);
	if (head.includes(0)) return true;
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(head.length === bytes.length ? head : trimPartial(head));
		return false;
	} catch {
		return true;
	}
}

/** Drop a multi-byte sequence the 8 KiB cut may have split. */
function trimPartial(bytes: Uint8Array): Uint8Array {
	let end = bytes.length;
	for (let back = 1; back <= 3 && end - back >= 0; back++) {
		const byte = bytes[end - back]!;
		if ((byte & 0xc0) === 0x80) continue;
		if ((byte & 0xc0) === 0xc0) end -= back;
		break;
	}
	return bytes.subarray(0, end);
}
