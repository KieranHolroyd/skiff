import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { serviceUnitName } from './units.ts';
import { assertId, assertRecord, ValidationError } from './validate.ts';
import { verifyMount as defaultVerifyMount, type VerifyResult, type VolumeRegistry, type VolumeRunner } from './volumes.ts';

/**
 * App-volume data verbs for the privileged helper (docs/VOLUMES.md): usage, purge, snapshot
 * and restore. The wire carries ids and the backing only; the host directory is derived here
 * exactly as for mounts (`<state dir>/apps/<project>/<volume>` or
 * `<disk mount>/yoal/apps/<project>/<volume>`), and a disk backing is verified with
 * `findmnt` before anything is read, written or deleted: an unmounted backing never falls through
 * to the root disk.
 *
 * Snapshot consistency: the agent names the workloads with a read-write attachment. Running ones
 * are paused with a cgroup freeze (`systemctl freeze`), not stopped, so nothing restarts and the
 * agent's view of the unit does not change. The helper first tries a copy-on-write clone
 * (`cp --reflink=always`: btrfs, XFS with reflink, OpenZFS 2.2+ block cloning) and thaws as soon
 * as the clone exists; without reflink support the writers stay frozen while the archive streams,
 * bounded by `maxPauseMs`. The archive is a gzip tar with numeric owners.
 */

export type AppVolumeBacking = 'node_volume' | 'state_dir';

export interface AppVolumeRef {
	id: string;
	projectId: string;
	backing: AppVolumeBacking;
	nodeVolumeId?: string;
}

export type AppVolumeSnapshotMethod = 'reflink' | 'paused' | 'idle' | 'live';

export interface AppVolumeUsage {
	id: string;
	usedBytes: number | null;
	error?: string;
}

const APP_VOLUME_ID = /^av_[A-Za-z0-9_-]{1,96}$/;
const SNAPSHOT_ID = /^avs_[A-Za-z0-9_-]{1,96}$/;
/** Staging clones live beside the volumes, under a name no volume id (`av_…`) can take. */
const STAGE_DIR = '.snapshots';
const MAX_WRITERS = 20;
export const MAX_USAGE_REFS = 1000;
/** Longest a writer stays frozen while a non-reflink archive streams. */
export const DEFAULT_MAX_PAUSE_MS = 15 * 60_000;

// ------------------------------------------------------------------ validation

export function assertAppVolumeId(value: unknown, label = 'volume.id'): string {
	if (typeof value !== 'string' || !APP_VOLUME_ID.test(value))
		throw new ValidationError(`${label} must match ${APP_VOLUME_ID}`);
	return value;
}

export function assertSnapshotId(value: unknown, label = 'snapshotId'): string {
	if (typeof value !== 'string' || !SNAPSHOT_ID.test(value))
		throw new ValidationError(`${label} must match ${SNAPSHOT_ID}`);
	return value;
}

/** One volume reference from the wire. Unknown keys are refused: there is no path field. */
export function parseAppVolumeRef(value: unknown, label = 'volume'): AppVolumeRef {
	const record = assertRecord(value, label);
	for (const key of Object.keys(record))
		if (!['id', 'projectId', 'backing', 'nodeVolumeId'].includes(key))
			throw new ValidationError(`${label}.${key} is not accepted`);
	const id = assertAppVolumeId(record.id, `${label}.id`);
	const projectId = assertId(record.projectId, `${label}.projectId`);
	const backing = record.backing;
	if (backing !== 'node_volume' && backing !== 'state_dir')
		throw new ValidationError(`${label}.backing must be "node_volume" or "state_dir"`);
	if (backing === 'node_volume')
		return { id, projectId, backing, nodeVolumeId: assertId(record.nodeVolumeId, `${label}.nodeVolumeId`) };
	if (record.nodeVolumeId !== undefined)
		throw new ValidationError(`${label}: a state-dir app volume cannot name a node volume`);
	return { id, projectId, backing };
}

export function parseAppVolumeRefs(value: unknown, max = MAX_USAGE_REFS): AppVolumeRef[] {
	if (!Array.isArray(value) || value.length > max)
		throw new ValidationError(`volumes must be an array of at most ${max} entries`);
	const seen = new Set<string>();
	return value.map((item, index) => {
		const ref = parseAppVolumeRef(item, `volumes[${index}]`);
		if (seen.has(ref.id)) throw new ValidationError(`Duplicate app volume ${ref.id}`);
		seen.add(ref.id);
		return ref;
	});
}

/** The same reference carried in a restore's query string (its body is the archive). */
export function parseAppVolumeRefQuery(params: URLSearchParams): AppVolumeRef {
	const record: Record<string, unknown> = {};
	for (const [key, value] of params) {
		if (key in record) throw new ValidationError(`${key} is repeated`);
		record[key] = value;
	}
	return parseAppVolumeRef(record, 'query');
}

export interface SnapshotRequest {
	volume: AppVolumeRef;
	snapshotId: string;
	/** Pause running writers for a consistent copy. */
	quiesce: boolean;
	/** Workload ids with a read-write attachment; only these units are ever frozen. */
	writers: string[];
}

export function parseSnapshotRequest(value: unknown): SnapshotRequest {
	const record = assertRecord(value, 'request');
	for (const key of Object.keys(record))
		if (!['volume', 'snapshotId', 'quiesce', 'writers'].includes(key))
			throw new ValidationError(`request.${key} is not accepted`);
	if (typeof record.quiesce !== 'boolean') throw new ValidationError('quiesce must be a boolean');
	const writersRaw = record.writers ?? [];
	if (!Array.isArray(writersRaw) || writersRaw.length > MAX_WRITERS)
		throw new ValidationError(`writers must be an array of at most ${MAX_WRITERS} workload ids`);
	const writers = [...new Set(writersRaw.map((item, index) => assertId(item, `writers[${index}]`)))];
	return {
		volume: parseAppVolumeRef(record.volume),
		snapshotId: assertSnapshotId(record.snapshotId),
		quiesce: record.quiesce,
		writers,
	};
}

// ------------------------------------------------------------------ fixed argv

export function duArgv(duPath: string, dir: string): string[] {
	// Allocated bytes, this filesystem only: a bind mount inside the volume is not counted twice.
	return [duPath, '--summarize', '--block-size=1', '--one-file-system', '--', dir];
}

/** Parse `du --summarize --block-size=1` output: `<bytes>\t<path>`. */
export function parseDuOutput(stdout: string): number | null {
	const match = /^(\d+)\s/.exec(stdout.trimStart());
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isSafeInteger(value) ? value : null;
}

export function reflinkArgv(cpPath: string, source: string, stage: string): string[] {
	return [cpPath, '--archive', '--reflink=always', '--no-target-directory', '--', source, stage];
}

export function tarCreateArgv(tarPath: string, source: string): string[] {
	return [
		tarPath,
		'--create',
		'--gzip',
		'--file=-',
		'--numeric-owner',
		'--sparse',
		'--one-file-system',
		'--directory',
		source,
		'--',
		'.',
	];
}

/**
 * GNU tar already strips leading `/`, skips members with `..` and delays symlink creation, so an
 * archive cannot write outside `target`. Owners and modes are kept as the source had them.
 */
export function tarExtractArgv(tarPath: string, target: string): string[] {
	return [
		tarPath,
		'--extract',
		'--gzip',
		'--file=-',
		'--numeric-owner',
		'--same-owner',
		'--same-permissions',
		'--no-overwrite-dir',
		'--delay-directory-restore',
		'--directory',
		target,
	];
}

// ------------------------------------------------------------------ process seam

export interface SpawnedArchive {
	stdout: ReadableStream<Uint8Array> | null;
	stdin: { write(chunk: Uint8Array): unknown; flush(): unknown; end(): unknown } | null;
	stderr: ReadableStream<Uint8Array> | null;
	exited: Promise<number>;
	kill(): void;
}

export type ArchiveSpawner = (argv: string[], options: { stdin: 'pipe' | 'ignore' }) => SpawnedArchive;

export const bunArchiveSpawner: ArchiveSpawner = (argv, options) => {
	const child = Bun.spawn(argv, { stdin: options.stdin, stdout: options.stdin === 'pipe' ? 'ignore' : 'pipe', stderr: 'pipe' });
	return {
		stdout: (child.stdout as ReadableStream<Uint8Array> | undefined) ?? null,
		stdin: options.stdin === 'pipe' ? (child.stdin as unknown as SpawnedArchive['stdin']) : null,
		stderr: (child.stderr as ReadableStream<Uint8Array> | undefined) ?? null,
		exited: child.exited,
		kill: () => child.kill(),
	};
};

// ------------------------------------------------------------------ the verbs

export interface AppVolumeDataOptions {
	stateDir: string;
	registry: () => Promise<VolumeRegistry>;
	runner: VolumeRunner;
	verifyMount?: (runner: VolumeRunner, mountPath: string, sourceKey: string) => Promise<VerifyResult>;
	spawn?: ArchiveSpawner;
	systemctlPath?: string;
	tarPath?: string;
	cpPath?: string;
	duPath?: string;
	maxPauseMs?: number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** Thrown when a disk backing is registered but not mounted: retry later, never fall back. */
export class BackingUnavailableError extends ValidationError {}

export class AppVolumeData {
	private readonly stateDir: string;
	private readonly registry: () => Promise<VolumeRegistry>;
	private readonly runner: VolumeRunner;
	private readonly verify: NonNullable<AppVolumeDataOptions['verifyMount']>;
	private readonly spawn: ArchiveSpawner;
	private readonly systemctlPath: string;
	private readonly tarPath: string;
	private readonly cpPath: string;
	private readonly duPath: string;
	private readonly maxPauseMs: number;
	private readonly log: NonNullable<AppVolumeDataOptions['log']>;
	/** One snapshot or restore per volume at a time. */
	private readonly busy = new Set<string>();

	constructor(options: AppVolumeDataOptions) {
		this.stateDir = options.stateDir;
		this.registry = options.registry;
		this.runner = options.runner;
		this.verify = options.verifyMount ?? defaultVerifyMount;
		this.spawn = options.spawn ?? bunArchiveSpawner;
		this.systemctlPath = options.systemctlPath ?? '/usr/bin/systemctl';
		this.tarPath = options.tarPath ?? '/usr/bin/tar';
		this.cpPath = options.cpPath ?? '/usr/bin/cp';
		this.duPath = options.duPath ?? '/usr/bin/du';
		this.maxPauseMs = options.maxPauseMs ?? DEFAULT_MAX_PAUSE_MS;
		this.log = options.log ?? (() => undefined);
	}

	/**
	 * The project directory that holds `ref`, or null when its disk is not registered here
	 * (removed from Yoal: nothing on this node is Yoal's to touch). A registered but unmounted
	 * backing throws `BackingUnavailableError`.
	 */
	async base(ref: AppVolumeRef, verified = new Map<string, string | null>()): Promise<string | null> {
		if (ref.backing === 'state_dir') return join(this.stateDir, 'apps', ref.projectId);
		const nodeVolumeId = ref.nodeVolumeId!;
		if (verified.has(nodeVolumeId)) {
			const mountPath = verified.get(nodeVolumeId)!;
			return mountPath === null ? null : join(mountPath, 'yoal', 'apps', ref.projectId);
		}
		const entry = (await this.registry())[nodeVolumeId];
		if (!entry) {
			verified.set(nodeVolumeId, null);
			return null;
		}
		const mounted = await this.verify(this.runner, entry.mountPath, entry.sourceKey);
		if (!mounted.ok)
			throw new BackingUnavailableError(
				`App volume ${ref.id}: node volume ${nodeVolumeId} is not mounted (${mounted.message ?? 'unknown error'}); the root disk is never used instead.`,
			);
		verified.set(nodeVolumeId, entry.mountPath);
		return join(entry.mountPath, 'yoal', 'apps', ref.projectId);
	}

	/** The volume directory; created (0700) when `create`, otherwise null when it does not exist. */
	private async dir(ref: AppVolumeRef, create: boolean): Promise<{ base: string; dir: string } | null> {
		const base = await this.base(ref);
		if (base === null) {
			if (!create) return null;
			throw new ValidationError(`App volume ${ref.id}: node volume ${ref.nodeVolumeId} is not registered on this node.`);
		}
		const dir = childOf(base, ref.id);
		if (create) {
			await fs.mkdir(base, { recursive: true, mode: 0o755 });
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		}
		const info = await fs.lstat(dir).catch(() => null);
		if (!info) return null;
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new ValidationError(`App volume ${ref.id} resolves to something that is not a directory.`);
		return { base, dir };
	}

	/** Allocated bytes per volume. A volume never mounted yet uses 0; an unreadable one is null. */
	async usage(refs: AppVolumeRef[]): Promise<AppVolumeUsage[]> {
		const verified = new Map<string, string | null>();
		const out: AppVolumeUsage[] = [];
		for (const ref of refs) {
			try {
				const base = await this.base(ref, verified);
				if (base === null) {
					out.push({ id: ref.id, usedBytes: null, error: `node volume ${ref.nodeVolumeId} is not registered` });
					continue;
				}
				const dir = childOf(base, ref.id);
				const info = await fs.lstat(dir).catch(() => null);
				if (!info) {
					out.push({ id: ref.id, usedBytes: 0 });
					continue;
				}
				if (!info.isDirectory() || info.isSymbolicLink()) throw new ValidationError('not a directory');
				const result = await this.runner.run(duArgv(this.duPath, dir));
				const used = parseDuOutput(result.stdout);
				// du exits 1 when a file vanished mid-walk; its total is still the right order of size.
				if (used === null) throw new Error(result.stderr.trim().slice(0, 200) || `du exited ${result.code}`);
				out.push({ id: ref.id, usedBytes: used });
			} catch (error) {
				out.push({ id: ref.id, usedBytes: null, error: errorText(error).slice(0, 300) });
			}
		}
		return out;
	}

	/** Delete a trashed volume's directory (and any staging clone). Idempotent. */
	async purge(ref: AppVolumeRef): Promise<void> {
		const base = await this.base(ref);
		// The disk was removed from Yoal: it is the operator's, nothing to delete.
		if (base === null) return;
		await fs.rm(childOf(base, ref.id), { recursive: true, force: true });
		await fs.rm(childOf(join(base, STAGE_DIR), ref.id), { recursive: true, force: true });
		// Tidy empty parents; a non-empty one (other volumes) is left alone.
		await fs.rmdir(join(base, STAGE_DIR)).catch(() => undefined);
		await fs.rmdir(base).catch(() => undefined);
	}

	/**
	 * Start a snapshot: pause what must be paused, pick the method, and return the archive stream.
	 * Writers are thawed and staging clones removed when the stream ends, fails or is cancelled.
	 */
	async snapshot(request: SnapshotRequest): Promise<{ method: AppVolumeSnapshotMethod; body: ReadableStream<Uint8Array> }> {
		const { volume, snapshotId } = request;
		this.claim(volume.id);
		let release = async (): Promise<void> => {
			this.busy.delete(volume.id);
		};
		try {
			const resolved = (await this.dir(volume, true))!;
			const active: string[] = [];
			for (const id of request.writers) if (await this.isActive(id)) active.push(id);

			let method: AppVolumeSnapshotMethod;
			let source = resolved.dir;
			const frozen: string[] = [];
			const thaw = async (): Promise<void> => {
				while (frozen.length > 0) {
					const id = frozen.pop()!;
					const result = await this.runner.run([this.systemctlPath, 'thaw', serviceUnitName(id)]);
					if (result.code !== 0)
						this.log('error', `Could not thaw ${serviceUnitName(id)}: ${result.stderr.trim() || `exit ${result.code}`}`);
				}
			};
			const stageParent = childOf(join(resolved.base, STAGE_DIR), volume.id);
			const stage = childOf(stageParent, snapshotId);
			let staged = false;
			const previous = release;
			release = async () => {
				await thaw();
				if (staged) await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
				await fs.rmdir(stageParent).catch(() => undefined);
				await previous();
			};

			if (active.length === 0) method = 'idle';
			else if (!request.quiesce) method = 'live';
			else {
				for (const id of active) {
					const result = await this.runner.run([this.systemctlPath, 'freeze', serviceUnitName(id)]);
					if (result.code !== 0)
						throw new Error(
							`Could not pause ${id} for a consistent copy (${result.stderr.trim() || `exit ${result.code}`}). This needs systemd 246+ with cgroup v2; retry with quiesce off to copy it live.`,
						);
					frozen.push(id);
				}
				await fs.mkdir(stageParent, { recursive: true, mode: 0o700 });
				await fs.rm(stage, { recursive: true, force: true });
				staged = true;
				const clone = await this.runner.run(reflinkArgv(this.cpPath, resolved.dir, stage));
				if (clone.code === 0) {
					method = 'reflink';
					source = stage;
					await thaw();
				} else {
					await fs.rm(stage, { recursive: true, force: true });
					staged = false;
					method = 'paused';
				}
			}

			const child = this.spawn(tarCreateArgv(this.tarPath, source), { stdin: 'ignore' });
			if (!child.stdout) throw new Error('tar produced no output stream');
			const stderr = child.stderr ? new Response(child.stderr).text() : Promise.resolve('');
			const timer =
				method === 'paused'
					? setTimeout(() => {
							this.log('warn', `Snapshot ${snapshotId} kept ${volume.id}'s writers paused for ${this.maxPauseMs} ms; aborting it.`);
							child.kill();
						}, this.maxPauseMs)
					: null;
			let finished = false;
			const finish = async (): Promise<void> => {
				if (finished) return;
				finished = true;
				if (timer) clearTimeout(timer);
				await release();
			};
			const reader = child.stdout.getReader();
			// tar exits 1 when a file changed while it was read: expected for a live copy only.
			const okCodes = method === 'live' ? [0, 1] : [0];
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const { done, value } = await reader.read();
						if (!done) {
							if (value?.byteLength) controller.enqueue(value);
							return;
						}
						const code = await child.exited;
						await finish();
						if (okCodes.includes(code)) controller.close();
						else controller.error(new Error(`tar exited ${code}: ${(await stderr).trim().slice(0, 300) || 'no detail'}`));
					} catch (error) {
						child.kill();
						await finish();
						controller.error(error);
					}
				},
				async cancel() {
					child.kill();
					await finish();
				},
			});
			return { method, body };
		} catch (error) {
			await release();
			throw error;
		}
	}

	/** Fill a new, empty volume from a snapshot archive. A failure leaves it empty again. */
	async restore(ref: AppVolumeRef, body: ReadableStream<Uint8Array> | null): Promise<void> {
		if (!body) throw new ValidationError('A restore needs the archive as its request body');
		this.claim(ref.id);
		try {
			const { dir } = (await this.dir(ref, true))!;
			if ((await fs.readdir(dir)).length > 0)
				throw new ValidationError(`App volume ${ref.id} is not empty; a snapshot is only restored into a new volume.`);
			const child = this.spawn(tarExtractArgv(this.tarPath, dir), { stdin: 'pipe' });
			const stderr = child.stderr ? new Response(child.stderr).text() : Promise.resolve('');
			const reader = body.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value?.byteLength) {
						child.stdin!.write(value);
						await child.stdin!.flush();
					}
				}
			} catch (error) {
				child.kill();
				await child.exited.catch(() => undefined);
				await emptyDirectory(dir);
				throw error;
			} finally {
				await child.stdin?.end();
			}
			const code = await child.exited;
			if (code !== 0) {
				await emptyDirectory(dir);
				throw new Error(`tar exited ${code}: ${(await stderr).trim().slice(0, 300) || 'no detail'}`);
			}
		} finally {
			this.busy.delete(ref.id);
		}
	}

	private claim(id: string): void {
		if (this.busy.has(id)) throw new ValidationError(`App volume ${id} already has a snapshot or restore running.`);
		this.busy.add(id);
	}

	private async isActive(workloadId: string): Promise<boolean> {
		const result = await this.runner.run([this.systemctlPath, 'is-active', '--quiet', serviceUnitName(workloadId)]);
		return result.code === 0;
	}
}

/** `parent/name` after proving `name` is one plain path component (ids are validated too). */
function childOf(parent: string, name: string): string {
	const root = resolve(parent);
	const target = resolve(root, name);
	if (dirname(target) !== root || basename(target) !== name)
		throw new ValidationError(`Refusing ${target}: not a direct child of ${root}`);
	return target;
}

async function emptyDirectory(dir: string): Promise<void> {
	for (const name of await fs.readdir(dir).catch(() => [] as string[]))
		await fs.rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
