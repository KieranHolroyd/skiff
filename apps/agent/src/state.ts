import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { desiredStateSchema, type DesiredState } from '@skiff/contracts';

/**
 * On-disk cache of the last desired state (D23). If the control plane is down the agent still
 * has everything it needs to keep serving: the exact routes, access keys and release hashes.
 */

export interface CachedDesiredState {
	state: DesiredState;
	/** Strong ETag to send as If-None-Match on the next pull. */
	etag: string;
}

/** Write via a sibling temp file + rename(2), so a crash can never leave truncated JSON. */
export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		handle = await fs.open(tmp, 'w', 0o600);
		await handle.writeFile(data);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(tmp, path);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function desiredStateEtag(state: DesiredState): string {
	// Matches the control plane's `"v<version>"` ETag, so a cached-state fallback still 304s.
	return `"v${state.version}"`;
}

/**
 * How to ask for desired state. Only revalidate (If-None-Match plus a long-poll) a copy this
 * process pulled itself: the cache on disk was parsed by whichever agent build wrote it, which
 * strips fields that build did not know (Zod drops unknown keys). The ETag is only the version,
 * so revalidating that cache would 304, and a newly installed agent would never see work its
 * predecessor dropped (it hung read-only studio principals until the next unrelated change).
 * `force` asks for a fresh copy too, for newly presigned release URLs after a failed converge.
 */
export function desiredStateRequest(input: {
	etag: string | null;
	force: boolean;
	pulledThisRun: boolean;
	longPollSeconds: number;
}): { ifNoneMatch: string | null; waitSeconds: number } {
	const revalidate = input.etag !== null && !input.force && input.pulledThisRun;
	return revalidate
		? { ifNoneMatch: input.etag, waitSeconds: input.longPollSeconds }
		: { ifNoneMatch: null, waitSeconds: 0 };
}

export class DesiredStateStore {
	readonly statePath: string;
	readonly etagPath: string;

	constructor(dataDir: string) {
		this.statePath = join(dataDir, 'desired-state.json');
		this.etagPath = join(dataDir, 'desired-state.etag');
	}

	/** Read and validate the cache. Corrupt files are quarantined rather than crashing the agent. */
	async read(): Promise<DesiredState | null> {
		let text: string;
		try {
			text = await fs.readFile(this.statePath, 'utf8');
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}

		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			await this.quarantine();
			return null;
		}
		const parsed = desiredStateSchema.safeParse(value);
		if (!parsed.success) {
			await this.quarantine();
			return null;
		}
		return parsed.data;
	}

	async readEtag(): Promise<string | null> {
		try {
			const etag = (await fs.readFile(this.etagPath, 'utf8')).trim();
			return etag.length > 0 ? etag : null;
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	}

	async readCached(): Promise<CachedDesiredState | null> {
		const state = await this.read();
		if (!state) return null;
		const etag = (await this.readEtag()) ?? desiredStateEtag(state);
		return { state, etag };
	}

	/**
	 * Persist state then its ETag. The order matters: if we crash between the two, the stale ETag
	 * only causes an unnecessary 200, never an incorrect 304.
	 */
	async write(state: DesiredState, etag = desiredStateEtag(state)): Promise<void> {
		await atomicWriteFile(this.statePath, `${JSON.stringify(state)}\n`);
		await atomicWriteFile(this.etagPath, `${etag}\n`);
	}

	private async quarantine(): Promise<void> {
		try {
			await fs.rename(this.statePath, `${this.statePath}.invalid-${Date.now()}`);
		} catch {
			// Best effort — a read-only data dir must not take the agent down.
		}
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
