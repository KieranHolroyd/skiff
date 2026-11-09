import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BuildValidationError, gitAuthEnv, gitSshEnv, validateGitRef } from '../command.ts';

/**
 * Git helpers shared by the git Builder (runner.ts), workflow resolution and pipeline jobs. The
 * credentials (HTTPS token header, SSH deploy key) only ever live in the clone process's
 * environment, never in argv, the remote URL or `.git/config` (D45, D138).
 */

export interface CaptureResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function streamText(stream: ReadableStream<Uint8Array> | number | undefined): Promise<string> {
	if (!stream || typeof stream === 'number') return '';
	return new Response(stream).text();
}

/** Run a command to completion and capture its output; argv only, never a shell. */
export async function capture(
	argv: string[],
	options: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string } = {},
): Promise<CaptureResult> {
	const proc = Bun.spawn(argv, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([streamText(proc.stdout), streamText(proc.stderr), proc.exited]);
	return { code, stdout, stderr };
}

/** What a clone may authenticate with; a subset of BuilderConfig so tests need no full config. */
export interface GitCredentials {
	gitToken: string | null;
	gitTokenHosts: string[];
	/** HTTP basic user name for `gitToken`; `x-access-token` (GitHub's) when absent. */
	gitTokenUsername?: string | null;
	gitSshKey: string | null;
	gitSshKnownHosts: string | null;
	/** Holds `known_hosts` when no pinned file is configured. */
	buildDir: string;
}

/**
 * Credentials for one clone when the control plane sent a token (D164, D175): a read-only token
 * for that repository alone — from Yoal's GitHub App (github.com) or a forge connection (its
 * host, with the user name the forge checks) — used instead of the node's own `YOAL_GIT_TOKEN`.
 * Without one the node's credentials apply unchanged.
 */
export function withCloneToken<T extends GitCredentials>(
	credentials: T,
	token: string | null | undefined,
	options: { host?: string | null; username?: string | null } = {},
): T {
	if (!token) return credentials;
	const host = options.host && /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(options.host) ? options.host.toLowerCase() : 'github.com';
	return { ...credentials, gitToken: token, gitTokenHosts: [host], gitTokenUsername: options.username ?? null };
}

/** Environment for one git process against `url`: no prompts, plus credentials scoped to that URL. */
export function gitEnv(url: string, credentials: GitCredentials): Record<string, string> {
	return {
		GIT_TERMINAL_PROMPT: '0',
		...gitAuthEnv(url, credentials.gitToken, credentials.gitTokenHosts, credentials.gitTokenUsername ?? undefined),
		...gitSshEnv(url, {
			keyPath: credentials.gitSshKey,
			knownHostsPath: credentials.gitSshKnownHosts,
			fallbackKnownHostsPath: join(credentials.buildDir, 'known_hosts'),
		}),
	};
}

async function runGitSteps(steps: string[][], dir: string, env: Record<string, string>): Promise<void> {
	for (const step of steps) {
		const result = await capture(step, { cwd: dir, env });
		if (result.code !== 0)
			throw new BuildValidationError(
				`git ${step[1] ?? 'command'} failed: ${result.stderr.trim().slice(0, 1000) || `exit ${result.code}`}`,
			);
	}
}

/**
 * Shallow clone of a branch or tag; a commit SHA (which `--branch` rejects) falls back to
 * fetch + checkout. This is the git Builder's historical behaviour, kept byte-for-byte.
 */
export async function cloneRef(input: { url: string; ref: string; dir: string; credentials: GitCredentials }): Promise<void> {
	const ref = validateGitRef(input.ref);
	const env = gitEnv(input.url, input.credentials);
	const direct = await capture(['git', 'clone', '--depth', '1', '--single-branch', '--branch', ref, '--', input.url, input.dir], {
		cwd: input.credentials.buildDir,
		env,
	});
	if (direct.code === 0) return;

	await rm(input.dir, { recursive: true, force: true });
	await mkdir(input.dir, { recursive: true });
	await runGitSteps(
		[
			['git', 'init'],
			['git', 'remote', 'add', 'origin', input.url],
			['git', 'fetch', '--depth', '1', 'origin', ref],
			['git', 'checkout', '--detach', 'FETCH_HEAD'],
		],
		input.dir,
		env,
	);
}

/** A full or abbreviated hex commit id; anything else would be parsed by git as a ref or option. */
export function validateSha(sha: string): string {
	if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new BuildValidationError(`Invalid commit sha "${sha.slice(0, 100)}"`);
	return sha;
}

/**
 * Check out exactly `sha` (a pipeline job must run the commit its workflow was planned from, even
 * if the branch has moved since). Fetching a bare sha works on GitHub and any server with
 * `uploadpack.allowReachableSHA1InWant`; otherwise fall back to the ref with a little history and
 * insist that HEAD ends up at the sha.
 */
export async function cloneAtSha(input: {
	url: string;
	ref: string;
	sha: string;
	dir: string;
	credentials: GitCredentials;
}): Promise<void> {
	const sha = validateSha(input.sha.toLowerCase());
	const ref = validateGitRef(input.ref);
	const env = gitEnv(input.url, input.credentials);
	await mkdir(input.dir, { recursive: true });
	await runGitSteps(
		[
			['git', 'init', '--quiet'],
			['git', 'remote', 'add', 'origin', input.url],
		],
		input.dir,
		env,
	);
	const bySha = await capture(['git', 'fetch', '--no-tags', '--depth', '1', 'origin', sha], { cwd: input.dir, env });
	if (bySha.code === 0) {
		await runGitSteps([['git', 'checkout', '--quiet', '--detach', 'FETCH_HEAD']], input.dir, env);
	} else {
		await runGitSteps([['git', 'fetch', '--no-tags', '--depth', '50', 'origin', ref]], input.dir, env);
		const checkout = await capture(['git', 'checkout', '--quiet', '--detach', sha], { cwd: input.dir, env });
		if (checkout.code !== 0)
			throw new BuildValidationError(
				`Commit ${sha} is not reachable from ${ref} (the ref may have been force-pushed): ` +
					(checkout.stderr.trim().slice(0, 500) || `exit ${checkout.code}`),
			);
	}
	const head = await capture(['git', 'rev-parse', 'HEAD'], { cwd: input.dir });
	if (head.code !== 0 || !head.stdout.trim().startsWith(sha))
		throw new BuildValidationError(`Checked out ${head.stdout.trim().slice(0, 64) || 'nothing'}, expected ${sha}`);
}

/** HEAD's sha and message, or nulls when git cannot tell (never fatal). */
export async function commitInfo(dir: string): Promise<{ sha: string | null; message: string | null }> {
	const sha = await capture(['git', '-C', dir, 'rev-parse', 'HEAD']);
	const message = await capture(['git', '-C', dir, 'log', '-1', '--pretty=%B']);
	return {
		sha: sha.code === 0 ? sha.stdout.trim().slice(0, 64) : null,
		message: message.code === 0 ? message.stdout.trim().slice(0, 2000) : null,
	};
}
