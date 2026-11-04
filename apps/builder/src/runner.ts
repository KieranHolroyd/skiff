import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { BuildJob, BuildLogChunk } from '@skiff/contracts';
import type { BuilderConfig } from './config.ts';
import type { ControlClient } from './client.ts';
import {
	BuildValidationError,
	directRunArgs,
	redactSecret,
	repoUrlWithToken,
	safeRelativeDir,
	systemdRunArgs,
	unitName,
	validateBuildCommand,
} from './command.ts';
import { zipDirectory } from './zip.ts';

type StreamName = 'stdout' | 'stderr';

export class BuildFailure extends Error {
	constructor(
		message: string,
		readonly exitCode: number | null,
	) {
		super(message);
		this.name = 'BuildFailure';
	}
}

interface CaptureResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function streamText(stream: ReadableStream<Uint8Array> | number | undefined): Promise<string> {
	if (!stream || typeof stream === 'number') return '';
	return new Response(stream).text();
}

async function capture(
	argv: string[],
	options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<CaptureResult> {
	const proc = Bun.spawn(argv, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		streamText(proc.stdout),
		streamText(proc.stderr),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

async function pumpLines(
	stream: ReadableStream<Uint8Array> | number | undefined,
	name: StreamName,
	onLine: (stream: StreamName, line: string) => void,
): Promise<void> {
	if (!stream || typeof stream === 'number') return;
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const emit = (line: string) => onLine(name, line.slice(0, 16_384));
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index = buffer.indexOf('\n');
			while (index >= 0) {
				emit(buffer.slice(0, index).replace(/\r$/, ''));
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf('\n');
			}
			// A single pathological line must not grow without bound.
			if (buffer.length > 16_384) {
				emit(buffer.slice(0, 16_384));
				buffer = buffer.slice(16_384);
			}
		}
		buffer += decoder.decode();
		if (buffer) emit(buffer.replace(/\r$/, ''));
	} finally {
		reader.releaseLock();
	}
}

async function runLogged(
	argv: string[],
	options: {
		cwd: string;
		env: Record<string, string | undefined>;
		timeoutMs: number;
		onLine: (stream: StreamName, line: string) => void;
	},
): Promise<{ code: number; timedOut: boolean }> {
	const proc = Bun.spawn(argv, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill('SIGKILL');
		} catch {
			/* already gone */
		}
	}, options.timeoutMs);
	try {
		const pumps = [
			pumpLines(proc.stdout, 'stdout', options.onLine),
			pumpLines(proc.stderr, 'stderr', options.onLine),
		];
		const code = await proc.exited;
		await Promise.all(pumps);
		return { code, timedOut };
	} finally {
		clearTimeout(timer);
	}
}

/** Batches lines so the control plane sees a build log without one request per line. */
class LogPump {
	private readonly pending: Record<StreamName, string[]> = { stdout: [], stderr: [] };
	private chain: Promise<void> = Promise.resolve();
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly buildId: string,
		private readonly client: ControlClient,
	) {
		this.timer = setInterval(() => void this.flush(), 1_000);
	}

	push = (stream: StreamName, line: string): void => {
		const lines = this.pending[stream];
		lines.push(line);
		if (lines.length >= 50) void this.flush();
	};

	async flush(): Promise<void> {
		const chunks: BuildLogChunk[] = [];
		for (const stream of ['stdout', 'stderr'] as const) {
			const lines = this.pending[stream].splice(0, 500);
			if (lines.length) chunks.push({ stream, lines });
		}
		if (!chunks.length) return;
		this.chain = this.chain
			.then(async () => {
				for (const chunk of chunks) await this.client.log(this.buildId, chunk);
			})
			.catch((error: unknown) => {
				console.error(`[builder] ${this.buildId} log stream failed: ${errorText(error)}`);
			});
		await this.chain;
	}

	async stop(): Promise<void> {
		clearInterval(this.timer);
		await this.flush();
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Executes one claimed job: clone, build inside the sandbox, upload the output zip, report. Every
 * failure path reports `failed`; a report that never arrives is recovered by the control plane's
 * stale-claim sweep.
 */
export class JobRunner {
	constructor(
		private readonly config: BuilderConfig,
		private readonly client: ControlClient,
	) {}

	async run(job: BuildJob): Promise<void> {
		let tempDir: string | null = null;
		let commitSha = job.commitSha;
		let commitMessage: string | null = null;
		let logs: LogPump | null = null;
		try {
			validateBuildCommand(job.buildCommand);
			const rootDir = safeRelativeDir(job.rootDir, 'rootDir');
			const outputDir = safeRelativeDir(job.outputDir, 'outputDir');

			await mkdir(this.config.buildDir, { recursive: true });
			tempDir = await mkdtemp(join(this.config.buildDir, 'build-'));
			await this.clone(job, tempDir);

			const info = await commitInfo(tempDir);
			commitSha = info.sha ?? commitSha;
			commitMessage = info.message;
			// A useful commit in the dashboard as soon as the clone succeeds.
			await this.client
				.report(job.buildId, {
					status: 'building',
					commitSha: commitSha ?? undefined,
					commitMessage: commitMessage?.slice(0, 2000),
				})
				.catch((error: unknown) => console.error(`[builder] ${job.buildId} progress report failed: ${errorText(error)}`));

			// A repository can make rootDir a symlink; never build (or later zip) outside the checkout.
			const workDir = await insideCheckout(tempDir, rootDir === '.' ? tempDir : join(tempDir, rootDir), 'rootDir');
			// A sandboxed build starts from an empty environment, so give it a HOME it can write and the
			// node's toolchains. Direct execution (development) keeps the developer's own.
			const buildEnv: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', CI: '1' };
			if (this.config.systemd) {
				buildEnv.HOME = join(tempDir, '.home');
				buildEnv.PATH = this.config.buildPath;
				await mkdir(buildEnv.HOME, { recursive: true });
			}
			if (this.config.buildUser) await this.handOver(tempDir);
			logs = new LogPump(job.buildId, this.client);
			const argv = this.config.systemd
				? systemdRunArgs({
						workDir,
						writableDir: tempDir,
						command: job.buildCommand,
						unit: unitName(job.buildId),
						memoryMax: this.config.memoryMax,
						cpuQuota: this.config.cpuQuota,
						timeoutSeconds: this.config.timeoutSeconds,
						user: this.config.buildUser,
						env: buildEnv,
					})
				: directRunArgs(job.buildCommand);
			const result = await runLogged(argv, {
				cwd: workDir,
				env: buildEnv,
				// The unit enforces the real timeout; this is the local watchdog.
				timeoutMs: (this.config.timeoutSeconds + 30) * 1_000,
				onLine: logs.push,
			});
			await logs.stop();
			logs = null;
			if (result.timedOut)
				throw new BuildFailure(`Build exceeded ${this.config.timeoutSeconds}s and was killed.`, null);
			if (result.code !== 0) throw new BuildFailure(`Build command exited with code ${result.code}.`, result.code);

			// Resolved after the build, which may have replaced outputDir with a symlink.
			const outputPath = await insideCheckout(
				tempDir,
				outputDir === '.' ? workDir : join(workDir, outputDir),
				'outputDir',
			);
			const zipped = await zipDirectory(outputPath);
			const upload = await fetch(job.uploadUrl, {
				method: 'PUT',
				headers: { 'content-type': 'application/zip' },
				body: zipped.zip,
			});
			if (!upload.ok) throw new Error(`Artifact upload failed: ${upload.status} ${await upload.text()}`);
			await this.client.report(job.buildId, {
				status: 'succeeded',
				commitSha: commitSha ?? undefined,
				commitMessage: commitMessage?.slice(0, 2000),
			});
			console.log(
				`[builder] ${job.buildId} succeeded (${zipped.fileCount} files, ${zipped.sizeBytes} bytes before zip)`,
			);
		} catch (error) {
			await logs?.stop().catch(() => undefined);
			const message = redactSecret(errorText(error), this.config.gitToken).slice(0, 4000);
			console.error(`[builder] ${job.buildId} failed: ${message}`);
			try {
				await this.client.report(job.buildId, {
					status: 'failed',
					error: message,
					commitSha: commitSha ?? undefined,
					commitMessage: commitMessage?.slice(0, 2000),
				});
			} catch (reportError) {
				console.error(`[builder] ${job.buildId} failure report failed: ${errorText(reportError)}`);
			}
		} finally {
			if (logs) await logs.stop().catch(() => undefined);
			if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** Give the checkout to the unprivileged build account; the daemon keeps only its own scratch. */
	private async handOver(dir: string): Promise<void> {
		const user = this.config.buildUser!;
		const result = await capture(['chown', '-R', '--no-dereference', `${user}:${user}`, dir]);
		if (result.code !== 0)
			throw new Error(`Could not hand the checkout to ${user}: ${result.stderr.trim().slice(0, 500) || `exit ${result.code}`}`);
	}

	/** Branch/tag clone first; a commit SHA (which `--branch` rejects) falls back to fetch + checkout. */
	private async clone(job: BuildJob, dir: string): Promise<void> {
		const url = repoUrlWithToken(job.repoUrl, this.config.gitToken);
		const env = { GIT_TERMINAL_PROMPT: '0' };
		const direct = await capture(
			['git', 'clone', '--depth', '1', '--single-branch', '--branch', job.ref, url, dir],
			{ cwd: this.config.buildDir, env },
		);
		if (direct.code === 0) return;

		await rm(dir, { recursive: true, force: true });
		await mkdir(dir, { recursive: true });
		const steps: string[][] = [
			['git', 'init'],
			['git', 'remote', 'add', 'origin', url],
			['git', 'fetch', '--depth', '1', 'origin', job.ref],
			['git', 'checkout', '--detach', 'FETCH_HEAD'],
		];
		for (const step of steps) {
			const result = await capture(step, { cwd: dir, env });
			if (result.code !== 0)
				throw new BuildValidationError(
					`git ${step[1] ?? 'command'} failed: ${result.stderr.trim().slice(0, 1000) || `exit ${result.code}`}`,
				);
		}
	}
}

/** Resolve `path` (following symlinks) and require it to stay inside `root`. */
export async function insideCheckout(root: string, path: string, label: string): Promise<string> {
	const realRoot = await realpath(root);
	let resolved: string;
	try {
		resolved = await realpath(path);
	} catch {
		throw new BuildValidationError(`${label} "${relative(root, path) || '.'}" does not exist in the checkout`);
	}
	const rel = relative(realRoot, resolved);
	if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new BuildValidationError(`${label} resolves outside the repository`);
	return resolved;
}

async function commitInfo(dir: string): Promise<{ sha: string | null; message: string | null }> {
	const sha = await capture(['git', '-C', dir, 'rev-parse', 'HEAD']);
	const message = await capture(['git', '-C', dir, 'log', '-1', '--pretty=%B']);
	return {
		sha: sha.code === 0 ? sha.stdout.trim().slice(0, 64) : null,
		message: message.code === 0 ? message.stdout.trim().slice(0, 2000) : null,
	};
}
