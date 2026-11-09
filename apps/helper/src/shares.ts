import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type CommandRunner } from './wireguard.ts';

/**
 * Network share mounts (docs/CLUSTERING.md §5.2, docs/STORAGE.md §3, D143).
 *
 * The helper is the only process that can mount: the agent passes a fixed, validated description
 * and never a command or an option string. Shares mount at `/mnt/yoal-shares/<id>`, a path the
 * volume inventory reports, so a mounted share can become a disk and be verified by source key
 * before a workload starts (D76).
 *
 * NFS has no credentials. SMB writes a 0600 credentials file under `/run/yoal-shares` (tmpfs,
 * never inside the mount root) for the duration of the mount call only; the kernel keeps the
 * session afterwards. A failed mount is cleaned up and reported.
 *
 * Cleanup never deletes recursively: the mount directory is removed with a plain `rmdir` and only
 * once `mountpoint` says nothing is mounted there, so a busy or stuck unmount can never reach the
 * share's own files.
 */

export interface ShareMount {
	id: string;
	protocol: 'nfs' | 'smb';
	server: string;
	exportPath: string;
	readOnly: boolean;
	username?: string;
	password?: string;
	domain?: string;
}

export interface ShareMountStatus {
	id: string;
	mounted: boolean;
	mountPath: string;
	error: string | null;
}

export interface ShareMounterOptions {
	/** Parent of every share mount point. Must be a path the volume inventory reports. */
	root?: string;
	/** Where SMB credential files live during a mount call (tmpfs). */
	credentialsDir?: string;
	runner?: CommandRunner;
}

export const DEFAULT_SHARE_ROOT = '/mnt/yoal-shares';
export const DEFAULT_SHARE_CREDENTIALS_DIR = '/run/yoal-shares';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
/** The characters a share path may use; it must survive findmnt and become a volume source key. */
const EXPORT_PATTERN = /^\/[A-Za-z0-9._@+/-]*$/;
const SERVER_PATTERN = /^[A-Za-z0-9._:[\]-]+$/;
/** No separators a credentials file or mount option could be split on. */
const CREDENTIAL_PATTERN = /^[^\n\r\0]+$/;

/** Fixed options; nothing here comes from the request except read-only vs read-write. */
const NFS_OPTIONS = ['hard', 'proto=tcp', 'noatime', 'nosuid', 'nodev'];
const SMB_OPTIONS = ['vers=3.0', 'noatime', 'nosuid', 'nodev', 'mfsymlinks', 'file_mode=0770', 'dir_mode=0770'];

export class ShareMounter {
	private readonly root: string;
	private readonly credentialsDir: string;
	private readonly runner: CommandRunner;

	constructor(options: ShareMounterOptions = {}) {
		this.root = options.root ?? DEFAULT_SHARE_ROOT;
		this.credentialsDir = options.credentialsDir ?? DEFAULT_SHARE_CREDENTIALS_DIR;
		this.runner = options.runner ?? defaultRunner;
	}

	/** Is each share mounted at its mount point? Read-only; never needs credentials. */
	async status(ids: string[]): Promise<ShareMountStatus[]> {
		return Promise.all(
			ids.map(async (id) => {
				const mountPath = this.pathFor(id);
				return { id, mounted: await this.isMounted(mountPath), mountPath, error: null };
			}),
		);
	}

	async mount(share: ShareMount): Promise<ShareMountStatus> {
		const mountPath = this.pathFor(share.id);
		this.validate(share);
		await fs.mkdir(this.root, { recursive: true, mode: 0o755 });
		await fs.mkdir(mountPath, { recursive: true, mode: 0o755 });
		if (await this.isMounted(mountPath)) return { id: share.id, mounted: true, mountPath, error: null };
		const options = [share.readOnly ? 'ro' : 'rw'];
		let source: string;
		let credentials: string | null = null;
		try {
			if (share.protocol === 'smb') {
				if (!share.username || !share.password) throw new Error('SMB needs a username and password');
				await fs.mkdir(this.credentialsDir, { recursive: true, mode: 0o700 });
				credentials = join(this.credentialsDir, `${share.id}.cred`);
				const lines = [`username=${share.username}`, `password=${share.password}`];
				if (share.domain) lines.push(`domain=${share.domain}`);
				await fs.writeFile(credentials, `${lines.join('\n')}\n`, { mode: 0o600 });
				options.push(...SMB_OPTIONS, `credentials=${credentials}`);
				source = `//${share.server}${share.exportPath}`;
			} else {
				options.push(...NFS_OPTIONS);
				source = `${share.server}:${share.exportPath}`;
			}
			const result = await this.runner([
				'mount',
				'-t',
				share.protocol === 'smb' ? 'cifs' : 'nfs',
				'-o',
				options.join(','),
				source,
				mountPath,
			]);
			if (result.code !== 0) throw new Error(explainMountError(share.protocol, result.stderr.trim()));
			return { id: share.id, mounted: true, mountPath, error: null };
		} catch (error) {
			await this.removeMountPoint(mountPath);
			return {
				id: share.id,
				mounted: false,
				mountPath,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			if (credentials) await fs.rm(credentials, { force: true }).catch(() => undefined);
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
		if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('invalid share id');
		return join(this.root, id);
	}

	private validate(share: ShareMount): void {
		if (share.protocol !== 'nfs' && share.protocol !== 'smb') throw new Error('invalid share protocol');
		if (typeof share.server !== 'string' || !SERVER_PATTERN.test(share.server)) throw new Error('invalid share server');
		if (
			typeof share.exportPath !== 'string' ||
			!EXPORT_PATTERN.test(share.exportPath) ||
			share.exportPath.split('/').some((part) => part === '..' || part === '.')
		)
			throw new Error('invalid export path');
		if (share.protocol === 'smb' && share.exportPath.length < 2) throw new Error('SMB needs a share name');
		if (typeof share.readOnly !== 'boolean') throw new Error('readOnly must be a boolean');
		if (share.protocol === 'nfs' && (share.username || share.password || share.domain))
			throw new Error('NFS shares do not take SMB credentials');
		for (const [name, value] of [
			['username', share.username],
			['password', share.password],
			['domain', share.domain],
		] as const) {
			if (value === undefined) continue;
			if (typeof value !== 'string' || value.length > 256 || !CREDENTIAL_PATTERN.test(value))
				throw new Error(`invalid SMB ${name}`);
		}
	}
}

/** Turn the common mount failures into something an operator can act on. */
export function explainMountError(protocol: 'nfs' | 'smb', stderr: string): string {
	const text = stderr || 'mount failed';
	if (/wrong fs type|bad option|helper program|mount\.(nfs|cifs).*not found/i.test(text))
		return `${text} — install ${protocol === 'smb' ? 'cifs-utils' : 'nfs-common (Debian/Ubuntu) or nfs-utils'} on the node.`;
	if (/permission denied|access denied|error\(13\)/i.test(text))
		return `${text} — the server refused this node; check the export's allowed clients or the SMB username and password.`;
	if (/no such file|error\(2\)|not exported/i.test(text))
		return `${text} — the export path or share name does not exist on the server.`;
	if (/timed out|no route|connection refused|host is down|error\(112\)|error\(113\)/i.test(text))
		return `${text} — the node cannot reach the server (port ${protocol === 'smb' ? 445 : 2049}).`;
	return text;
}
