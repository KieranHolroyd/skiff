import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
	nodeStorageStatusSchema,
	storageNeedsApply,
	type NodeStorage,
	type NodeStorageStatus,
} from '@skiff/contracts';

/**
 * Agent side of node storage moves (D48). The agent cannot move its own data: its sandbox only
 * writes the current directories. It reads what the root `skiff-storage.service` last did from
 * `/etc/skiff/storage.json` (relayed in heartbeats) and, while desired state asks for something
 * else, drops `/run/skiff/storage.request` to trigger that service. The request carries no
 * authority: the service fetches the paths from the control plane itself.
 */

export const STORAGE_STATE_FILE = '/etc/skiff/storage.json';
export const STORAGE_REQUEST_FILE = '/run/skiff/storage.request';
/** A pending move (waiting on a build) is retried at most this often. */
const REQUEST_EVERY_MS = 60_000;

export async function readStorageStatus(path: string): Promise<NodeStorageStatus | null> {
	try {
		const parsed = nodeStorageStatusSchema.safeParse(JSON.parse(await fs.readFile(path, 'utf8')));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export class StorageRequester {
	private last: { key: string; at: number } | null = null;

	constructor(
		private readonly statePath: string = STORAGE_STATE_FILE,
		private readonly requestPath: string = STORAGE_REQUEST_FILE,
		private readonly now: () => number = Date.now,
	) {}

	status(): Promise<NodeStorageStatus | null> {
		return readStorageStatus(this.statePath);
	}

	/** Ask the storage service to act when `desired` is not what it last applied. */
	async reconcile(desired: NodeStorage | undefined, status: NodeStorageStatus | null): Promise<boolean> {
		if (!desired || !storageNeedsApply(desired, status)) return false;
		const key = JSON.stringify({ dataDir: desired.dataDir, buildDir: desired.buildDir });
		const now = this.now();
		if (this.last && this.last.key === key && now - this.last.at < REQUEST_EVERY_MS) return false;
		await fs.mkdir(dirname(this.requestPath), { recursive: true }).catch(() => undefined);
		await fs.writeFile(this.requestPath, `${key}\n`, { mode: 0o660 });
		this.last = { key, at: now };
		return true;
	}
}
