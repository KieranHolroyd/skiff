import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type CommandRunner } from './wireguard.ts';

/**
 * Cluster share mounts (docs/CLUSTERING.md §5.2, C3).
 *
 * The helper is the only process that can mount: the agent passes a fixed, validated description.
 * NFS has no credentials; SMB writes a 0600 credentials file that never enters desired state. A
 * failed mount is cleaned up and reported; the caller keeps the workload stopped rather than
 * letting it write to a plain directory.
 */

export interface ShareMount {
	id: string;
	protocol: 'nfs' | 'smb';
	server: string;
	exportPath: string;
	readOnly: boolean;
	username?: string;
	password?: string;
}

export interface ShareMountStatus {
	id: string;
	mounted: boolean;
	mountPath: string;
	error: string | null;
}

export interface ShareMounterOptions {
	root?: string;
	runner?: CommandRunner;
}

export class ShareMounter {
	private readonly root: string;
	private readonly runner: CommandRunner;

	constructor(options: ShareMounterOptions = {}) {
		this.root = options.root ?? '/run/skiff-shares';
		this.runner = options.runner ?? defaultRunner;
	}

	async mount(share: ShareMount): Promise<ShareMountStatus> {
		const mountPath = this.pathFor(share.id);
		this.validate(share);
		await fs.mkdir(mountPath, { recursive: true, mode: 0o755 });
		const mounted = await this.runner(['mountpoint', '-q', mountPath]);
		if (mounted.code === 0) return { id: share.id, mounted: true, mountPath, error: null };
		const source = `${share.server}:${share.exportPath}`;
		const options = ['ro', 'nosuid', 'nodev'];
		if (!share.readOnly) options[0] = 'rw';
		let credentials: string | null = null;
		try {
			if (share.protocol === 'smb') {
				if (!share.username || !share.password) throw new Error('SMB needs a username and password');
				credentials = join(this.root, `${share.id}.cred`);
				await fs.writeFile(credentials, `username=${share.username}\npassword=${share.password}\n`, { mode: 0o600 });
				options.push('credentials=' + credentials, 'vers=3.0');
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
			if (result.code !== 0) throw new Error(result.stderr.trim() || 'mount failed');
			return { id: share.id, mounted: true, mountPath, error: null };
		} catch (error) {
			await this.runner(['umount', mountPath]).catch(() => undefined);
			await fs.rm(mountPath, { recursive: true, force: true }).catch(() => undefined);
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

	async unmount(id: string): Promise<{ id: string; mounted: false }> {
		const mountPath = this.pathFor(id);
		await this.runner(['umount', mountPath]).catch(() => undefined);
		await fs.rm(mountPath, { recursive: true, force: true }).catch(() => undefined);
		return { id, mounted: false };
	}

	private pathFor(id: string): string {
		if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(id)) throw new Error('invalid share id');
		return join(this.root, id);
	}

	private validate(share: ShareMount): void {
		if (!/^[A-Za-z0-9._:[\]-]+$/.test(share.server)) throw new Error('invalid share server');
		if (!share.exportPath.startsWith('/') || share.exportPath.includes('..')) throw new Error('invalid export path');
		if (share.protocol === 'nfs' && (share.username || share.password))
			throw new Error('NFS shares do not take SMB credentials');
	}
}
