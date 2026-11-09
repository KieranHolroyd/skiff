import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { LSBLK, parseLsblk, type LsblkNode } from './volumes.ts';
import { defaultRunner, type CommandRunner } from './wireguard.ts';

/**
 * Disks Yoal mounts (docs/STORAGE.md §3, §3.1).
 *
 * The control plane asks for a filesystem UUID and a name; the helper mounts that filesystem at
 * `/mnt/yoal-disks/<name>` with fixed options, a path the volume inventory reports so the disk
 * turns ready once it is mounted. It never formats anything and never takes a device path
 * from the wire: before every mount it re-reads `lsblk` and refuses unless exactly one device
 * carries the UUID, that device is unmounted, holds nothing, and has the expected filesystem type
 * (D76 rule 2: only provably free devices).
 *
 * Unmount never forces, and the mount point is removed with a plain `rmdir` only once nothing is
 * mounted there, so a busy unmount can never reach the filesystem's own files.
 */

export interface DiskMountRequest {
	id: string;
	fsUuid: string;
	fsType: string;
}

export interface DiskMountStatus {
	id: string;
	mounted: boolean;
	mountPath: string;
	error: string | null;
}

export interface DiskMounterOptions {
	/** Parent of every disk mount point. Must be a path the volume inventory reports. */
	root?: string;
	runner?: CommandRunner;
}

export const DEFAULT_DISK_ROOT = '/mnt/yoal-disks';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const UUID_PATTERN = /^[A-Fa-f0-9-]{4,64}$/;
/** Filesystems with POSIX ownership; mirrors the contract's `mountableFsTypes`. */
const FS_TYPES = new Set(['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'f2fs']);
/** Fixed options; nothing here comes from the request. */
const MOUNT_OPTIONS = ['rw', 'noatime', 'nosuid', 'nodev'];

export class DiskMounter {
	private readonly root: string;
	private readonly runner: CommandRunner;

	constructor(options: DiskMounterOptions = {}) {
		this.root = options.root ?? DEFAULT_DISK_ROOT;
		this.runner = options.runner ?? defaultRunner;
	}

	/** Is each disk mounted at its mount point? Read-only. */
	async status(ids: string[]): Promise<DiskMountStatus[]> {
		return Promise.all(
			ids.map(async (id) => {
				const mountPath = this.pathFor(id);
				return { id, mounted: await this.isMounted(mountPath), mountPath, error: null };
			}),
		);
	}

	async mount(request: DiskMountRequest): Promise<DiskMountStatus> {
		const mountPath = this.pathFor(request.id);
		try {
			this.validate(request);
			if (await this.isMounted(mountPath)) return { id: request.id, mounted: true, mountPath, error: null };
			await this.assertFree(request);
			await fs.mkdir(this.root, { recursive: true, mode: 0o755 });
			await fs.mkdir(mountPath, { recursive: true, mode: 0o755 });
			const result = await this.runner([
				'mount',
				'-t',
				request.fsType,
				'-o',
				MOUNT_OPTIONS.join(','),
				`/dev/disk/by-uuid/${request.fsUuid}`,
				mountPath,
			]);
			if (result.code !== 0) throw new Error(explainDiskMountError(request.fsType, result.stderr.trim()));
			return { id: request.id, mounted: true, mountPath, error: null };
		} catch (error) {
			await this.removeMountPoint(mountPath);
			return { id: request.id, mounted: false, mountPath, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Unmount and remove the (now empty) mount point. A busy mount is reported, never forced. */
	async unmount(id: string): Promise<{ id: string; mounted: boolean; error: string | null }> {
		const mountPath = this.pathFor(id);
		if (await this.isMounted(mountPath)) {
			const result = await this.runner(['umount', mountPath]);
			if (result.code !== 0 && (await this.isMounted(mountPath)))
				return { id, mounted: true, error: result.stderr.trim() || `umount exited ${result.code}` };
		}
		await this.removeMountPoint(mountPath);
		return { id, mounted: false, error: null };
	}

	/** The helper's own view: exactly one unmounted, unheld device carries the UUID and type. */
	private async assertFree(request: DiskMountRequest): Promise<void> {
		const result = await this.runner([LSBLK, '-J', '-b', '-o', 'NAME,KNAME,TYPE,UUID,LABEL,MOUNTPOINT,SERIAL,MODEL,SIZE,FSTYPE']);
		if (result.code !== 0) throw new Error(`could not read block devices: ${result.stderr.trim() || `lsblk exited ${result.code}`}`);
		const problem = diskMountProblem(parseLsblk(result.stdout), request);
		if (problem) throw new Error(problem);
	}

	private async isMounted(mountPath: string): Promise<boolean> {
		const result = await this.runner(['mountpoint', '-q', mountPath]).catch(() => ({ code: 1 }));
		return result.code === 0;
	}

	/** `rmdir`, not `rm -r`: only an empty, unmounted directory is ever removed. */
	private async removeMountPoint(mountPath: string): Promise<void> {
		if (await this.isMounted(mountPath)) return;
		await fs.rmdir(mountPath).catch(() => undefined);
	}

	private pathFor(id: string): string {
		if (typeof id !== 'string' || !ID_PATTERN.test(id) || id.includes('--')) throw new Error('invalid partition mount id');
		return join(this.root, id);
	}

	private validate(request: DiskMountRequest): void {
		if (typeof request.fsUuid !== 'string' || !UUID_PATTERN.test(request.fsUuid)) throw new Error('invalid filesystem UUID');
		if (typeof request.fsType !== 'string' || !FS_TYPES.has(request.fsType))
			throw new Error(`filesystem type must be one of ${[...FS_TYPES].join(', ')}`);
	}
}

/** Why the device with `fsUuid` must not be mounted, or null when it is provably free. */
export function diskMountProblem(nodes: LsblkNode[], request: { fsUuid: string; fsType: string }): string | null {
	const matches: Array<{ node: LsblkNode; parentMounted: boolean }> = [];
	const walk = (node: LsblkNode, parentMounted: boolean): void => {
		if (node.uuid?.toLowerCase() === request.fsUuid.toLowerCase()) matches.push({ node, parentMounted });
		for (const child of node.children) walk(child, parentMounted || node.mountPath !== null);
	};
	for (const node of nodes) walk(node, false);
	if (matches.length === 0) return `no filesystem with UUID ${request.fsUuid} on this node`;
	if (matches.length > 1) return `${matches.length} devices carry UUID ${request.fsUuid}; give one a new UUID first`;
	const { node, parentMounted } = matches[0]!;
	if (node.mountPath) return `/dev/${node.name} is already mounted at ${node.mountPath}`;
	if (parentMounted) return `/dev/${node.name} sits on a mounted device`;
	if (node.children.length > 0) return `/dev/${node.name} holds ${node.children.map((child) => child.name).join(', ')}`;
	if ((node.fsType ?? '').toLowerCase() !== request.fsType)
		return `/dev/${node.name} is ${node.fsType ?? 'unformatted'}, not ${request.fsType}`;
	if (node.type === 'loop' || node.type === 'rom') return `/dev/${node.name} is a ${node.type} device`;
	return null;
}

/** Turn the common mount failures into something an operator can act on. */
export function explainDiskMountError(fsType: string, stderr: string): string {
	const text = stderr || 'mount failed';
	if (/wrong fs type|bad superblock|unknown filesystem type/i.test(text))
		return `${text} — check the filesystem with fsck${fsType === 'xfs' ? ' (xfs_repair)' : ''}, or install its tools on the node.`;
	if (/needs? (a )?(journal )?recovery|structure needs cleaning|dirty/i.test(text))
		return `${text} — the filesystem was not cleanly unmounted; run fsck on the node first.`;
	if (/special device .* does not exist|no such file/i.test(text))
		return `${text} — the disk is gone or its UUID changed; refresh the page.`;
	return text;
}
