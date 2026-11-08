import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { VolumeRegistry, VolumeRunner, VerifyResult } from './volumes.ts';

/**
 * Disk profiling (docs/STORAGE.md §5.1).
 *
 * The agent names a **registered disk id** (`volumeId` on the wire), never a path: the helper
 * resolves the mount from its own registry, proves it is mounted (D76), and benchmarks a scratch
 * file under `<mount>/skiff/.profile/`, removing it afterwards. With `fio` installed it measures
 * sequential read/write (1 MiB, queue depth 8), random 4 KiB read/write IOPS (queue depth 32) and
 * sync-write latency (4 KiB writes, `fdatasync` after each, queue depth 1 — what a database commit
 * feels).
 * Without `fio`, GNU `dd` gives sequential throughput and sync-write IOPS; random IOPS stay null.
 * All I/O uses O_DIRECT where the filesystem allows it, so the page cache does not flatter reads.
 */

export interface VolumeProfileRequest {
	volumeId: string;
	/** Scratch file size in MiB (64–4096). */
	sizeMb: number;
	/** Seconds per fio job (3–60). */
	runtimeSeconds: number;
}

export interface VolumeProfileResult {
	method: 'fio' | 'dd';
	seqReadMBps: number | null;
	seqWriteMBps: number | null;
	randReadIops: number | null;
	randWriteIops: number | null;
	syncWriteIops: number | null;
	/** Mean round trip of one 4 KiB write + fdatasync, microseconds. */
	syncWriteLatencyUs: number | null;
	/** False when the filesystem refused O_DIRECT and cached I/O was measured instead. */
	direct: boolean;
	notes: string[];
}

export interface VolumeProfilerOptions {
	runner: VolumeRunner;
	registry: () => Promise<VolumeRegistry>;
	verify: (input: { mountPath: string; sourceKey: string }) => Promise<VerifyResult>;
	fioPath?: string;
	ddPath?: string;
	/** Free bytes of a directory; injected in tests. */
	freeBytes?: (dir: string) => Promise<number>;
}

const MIB = 1024 * 1024;

export class VolumeProfiler {
	private running = false;
	private readonly fioPath: string;
	private readonly ddPath: string;

	constructor(private readonly options: VolumeProfilerOptions) {
		this.fioPath = options.fioPath ?? '/usr/bin/fio';
		this.ddPath = options.ddPath ?? '/usr/bin/dd';
	}

	async profile(request: VolumeProfileRequest): Promise<VolumeProfileResult> {
		validateRequest(request);
		if (this.running) throw new Error('A volume profile is already running on this node; try again when it finishes.');
		this.running = true;
		try {
			const entry = (await this.options.registry())[request.volumeId];
			if (!entry) throw new Error(`Volume ${request.volumeId} is not registered on this node.`);
			const verified = await this.options.verify({ mountPath: entry.mountPath, sourceKey: entry.sourceKey });
			if (!verified.ok) throw new Error(`Volume ${request.volumeId} is not mounted: ${verified.message ?? 'unknown'}`);
			const dir = join(entry.mountPath, 'skiff', '.profile');
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
			const free = await (this.options.freeBytes ?? statfsFree)(dir);
			if (free < request.sizeMb * MIB * 2)
				throw new Error(`Not enough free space: profiling needs ${request.sizeMb * 2} MiB, ${Math.floor(free / MIB)} MiB free.`);
			try {
				return (await this.hasFio()) ? await this.runFio(dir, request) : await this.runDd(dir, request);
			} finally {
				await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
			}
		} finally {
			this.running = false;
		}
	}

	private async hasFio(): Promise<boolean> {
		return fs
			.access(this.fioPath)
			.then(() => true)
			.catch(() => false);
	}

	private async runFio(dir: string, request: VolumeProfileRequest): Promise<VolumeProfileResult> {
		const jobFile = join(dir, 'profile.fio');
		const run = async (direct: boolean) => {
			await fs.writeFile(jobFile, fioJobFile(join(dir, 'profile.dat'), request, direct), { mode: 0o600 });
			return this.options.runner.run([this.fioPath, '--output-format=json', jobFile]);
		};
		let direct = true;
		let result = await run(true);
		if (result.code !== 0 && /direct|EINVAL|Invalid argument/i.test(result.stderr)) {
			direct = false;
			result = await run(false);
		}
		if (result.code !== 0) throw new Error(`fio failed: ${result.stderr.trim().slice(0, 500) || `exit ${result.code}`}`);
		const parsed = parseFioOutput(result.stdout);
		return { ...parsed, direct, notes: direct ? [] : ['The filesystem refused O_DIRECT; cached I/O was measured.'] };
	}

	private async runDd(dir: string, request: VolumeProfileRequest): Promise<VolumeProfileResult> {
		const file = join(dir, 'profile.dat');
		const dd = (args: string[]) => this.options.runner.run([this.ddPath, ...args]);
		let direct = true;
		let write = await dd(['if=/dev/zero', `of=${file}`, 'bs=1M', `count=${request.sizeMb}`, 'oflag=direct', 'conv=fsync']);
		if (write.code !== 0) {
			direct = false;
			write = await dd(['if=/dev/zero', `of=${file}`, 'bs=1M', `count=${request.sizeMb}`, 'conv=fsync']);
		}
		if (write.code !== 0) throw new Error(`dd write failed: ${write.stderr.trim().slice(0, 300)}`);
		const read = await dd([`if=${file}`, 'of=/dev/null', 'bs=1M', ...(direct ? ['iflag=direct'] : [])]);
		const syncCount = 500;
		const sync = await dd(['if=/dev/zero', `of=${join(dir, 'sync.dat')}`, 'bs=4k', `count=${syncCount}`, 'oflag=dsync']);
		const writeStats = parseDdStats(write.stderr);
		const readStats = read.code === 0 ? parseDdStats(read.stderr) : null;
		const syncStats = sync.code === 0 ? parseDdStats(sync.stderr) : null;
		const syncIops = syncStats && syncStats.seconds > 0 ? Math.round(syncCount / syncStats.seconds) : null;
		return {
			method: 'dd',
			seqWriteMBps: writeStats ? round(writeStats.bytes / MIB / writeStats.seconds) : null,
			seqReadMBps: readStats ? round(readStats.bytes / MIB / readStats.seconds) : null,
			randReadIops: null,
			randWriteIops: null,
			syncWriteIops: syncIops,
			syncWriteLatencyUs: syncIops ? Math.round(1_000_000 / syncIops) : null,
			direct,
			notes: [
				'fio is not installed on this node, so random IOPS were not measured. Install fio for the full profile.',
				...(direct ? [] : ['The filesystem refused O_DIRECT; cached I/O was measured.']),
			],
		};
	}
}

export function validateRequest(request: VolumeProfileRequest): void {
	if (typeof request.volumeId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(request.volumeId))
		throw new Error('volumeId must match [A-Za-z0-9_-]{1,100}');
	if (!Number.isInteger(request.sizeMb) || request.sizeMb < 64 || request.sizeMb > 4096)
		throw new Error('sizeMb must be an integer between 64 and 4096');
	if (!Number.isInteger(request.runtimeSeconds) || request.runtimeSeconds < 3 || request.runtimeSeconds > 60)
		throw new Error('runtimeSeconds must be an integer between 3 and 60');
}

/** The fio job file: every value is a number or a path the helper built. */
export function fioJobFile(file: string, request: VolumeProfileRequest, direct: boolean): string {
	const global = [
		'[global]',
		`filename=${file}`,
		`size=${request.sizeMb}M`,
		`direct=${direct ? 1 : 0}`,
		'ioengine=libaio',
		'time_based=1',
		`runtime=${request.runtimeSeconds}`,
		'ramp_time=1',
		'group_reporting=1',
		'stonewall=1',
	];
	const job = (name: string, lines: string[]) => [``, `[${name}]`, ...lines];
	return [
		...global,
		...job('seq-write', ['rw=write', 'bs=1M', 'iodepth=8']),
		...job('seq-read', ['rw=read', 'bs=1M', 'iodepth=8']),
		...job('rand-read', ['rw=randread', 'bs=4k', 'iodepth=32']),
		...job('rand-write', ['rw=randwrite', 'bs=4k', 'iodepth=32']),
		...job('sync-write', ['rw=randwrite', 'bs=4k', 'iodepth=1', 'ioengine=psync', 'fdatasync=1']),
		'',
	].join('\n');
}

interface FioSide {
	bw?: number;
	iops?: number;
}

/** Pull the five numbers out of `fio --output-format=json`; `bw` is KiB/s. */
export function parseFioOutput(stdout: string): Omit<VolumeProfileResult, 'direct' | 'notes'> {
	// fio may print warnings before the JSON document.
	const start = stdout.indexOf('{');
	if (start < 0) throw new Error('fio produced no JSON output');
	const parsed = JSON.parse(stdout.slice(start)) as { jobs?: Array<{ jobname?: string; read?: FioSide; write?: FioSide }> };
	const jobs = new Map((parsed.jobs ?? []).map((job) => [job.jobname ?? '', job]));
	const mbps = (side: FioSide | undefined) => (side?.bw ? round(side.bw / 1024) : null);
	const iops = (side: FioSide | undefined) => (side?.iops ? Math.round(side.iops) : null);
	const syncIops = iops(jobs.get('sync-write')?.write);
	return {
		method: 'fio',
		seqWriteMBps: mbps(jobs.get('seq-write')?.write),
		seqReadMBps: mbps(jobs.get('seq-read')?.read),
		randReadIops: iops(jobs.get('rand-read')?.read),
		randWriteIops: iops(jobs.get('rand-write')?.write),
		syncWriteIops: syncIops,
		syncWriteLatencyUs: syncIops ? Math.round(1_000_000 / syncIops) : null,
	};
}

/** GNU dd's summary: "268435456 bytes (268 MB, 256 MiB) copied, 1.234 s, 217 MB/s". */
export function parseDdStats(stderr: string): { bytes: number; seconds: number } | null {
	const match = /(\d+) bytes[^\n]*copied, ([\d.]+) s/.exec(stderr);
	if (!match) return null;
	const seconds = Number(match[2]);
	return seconds > 0 ? { bytes: Number(match[1]), seconds } : null;
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

async function statfsFree(dir: string): Promise<number> {
	const stats = await fs.statfs(dir);
	return Number(stats.bavail) * Number(stats.bsize);
}
