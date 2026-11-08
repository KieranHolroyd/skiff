import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PipelineExpressionContext, PipelineJobClaim, PipelineStatusState, TemplateMap } from '@skiff/contracts';
import { interpolate } from '@skiff/contracts';

/**
 * Pure helpers that turn a job claim into what a step sees: the `${{ }}` context, the layered
 * `env`, the process environment and the working directory. Kept apart from the runner so the
 * GitHub-compatibility rules are unit-tested without spawning anything.
 */

export class StepSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StepSetupError';
	}
}

/** Expression options shared by every evaluation in a job. */
export interface EvalOptions {
	status?: PipelineStatusState;
	hashFiles?: (patterns: string[]) => string;
}

/** The context plus `github`, GitHub's name for `skiff` (W1). */
export type JobContext = PipelineExpressionContext & { github: Record<string, unknown> };

export interface RunnerInfo {
	os: 'Linux' | 'macOS';
	arch: 'X64' | 'ARM64';
	name: string;
	temp: string;
	tool_cache: string;
	workspace: string;
}

export function runnerOs(platform: NodeJS.Platform = process.platform): RunnerInfo['os'] {
	return platform === 'darwin' ? 'macOS' : 'Linux';
}

export function runnerArch(arch: string = process.arch): RunnerInfo['arch'] {
	return arch === 'arm64' ? 'ARM64' : 'X64';
}

/**
 * Evaluate `env` maps in order (workflow < job), each value seeing the variables set before it,
 * the way GitHub resolves `env:` blocks. Later layers override earlier ones.
 */
export function layerEnv(
	layers: TemplateMap[],
	context: JobContext,
	options: EvalOptions = {},
	base: Record<string, string> = {},
): Record<string, string> {
	const env = { ...base };
	for (const layer of layers) {
		for (const [name, template] of Object.entries(layer)) {
			env[name] = interpolate(template, { ...context, env: { ...env } }, options);
		}
	}
	return env;
}

/** Build the static job context: claim context + runner + secrets, `github` aliasing `skiff`. */
export function buildJobContext(input: {
	claim: PipelineJobClaim;
	secrets: Record<string, string>;
	runner: RunnerInfo;
}): JobContext {
	const { claim } = input;
	const skiff: Record<string, unknown> = {
		sha: claim.checkout.sha,
		ref: claim.checkout.ref,
		ref_name: refName(claim.checkout.ref),
		ref_type: refType(claim.checkout.ref),
		repository: claim.repository.name,
		run_id: claim.runId,
		run_number: claim.runNumber,
		run_attempt: claim.attempt,
		job: claim.job.key,
		workflow: claim.workflow.name,
		...claim.context.skiff,
		workspace: input.runner.workspace,
	};
	return {
		...claim.context,
		skiff,
		github: skiff,
		secrets: { ...input.secrets },
		runner: { ...input.runner },
		steps: {},
		env: {},
	};
}

export function refName(ref: string): string {
	return ref.replace(/^refs\/(heads|tags)\//, '');
}

export function refType(ref: string): 'branch' | 'tag' {
	return ref.startsWith('refs/tags/') ? 'tag' : 'branch';
}

/** Variables every step gets from the runner (not from `env:`), under both prefixes. */
export function runnerVariables(input: {
	context: JobContext;
	runner: RunnerInfo;
	files: { output: string; env: string; path: string; summary: string };
}): Record<string, string> {
	const skiff = input.context.skiff;
	const text = (key: string) => {
		const value = skiff[key];
		return value === undefined || value === null ? '' : String(value);
	};
	const shared: Record<string, string> = {
		WORKSPACE: input.runner.workspace,
		SHA: text('sha'),
		REF: text('ref'),
		REF_NAME: text('ref_name'),
		REF_TYPE: text('ref_type'),
		REPOSITORY: text('repository'),
		RUN_ID: text('run_id'),
		RUN_NUMBER: text('run_number'),
		RUN_ATTEMPT: text('run_attempt'),
		JOB: text('job'),
		EVENT_NAME: text('event_name'),
		ACTOR: text('actor'),
		SERVER_URL: text('server_url'),
		WORKFLOW: text('workflow'),
		OUTPUT: input.files.output,
		ENV: input.files.env,
		PATH: input.files.path,
		STEP_SUMMARY: input.files.summary,
	};
	const variables: Record<string, string> = {
		CI: 'true',
		SKIFF_ACTIONS: 'true',
		GITHUB_ACTIONS: 'true',
		RUNNER_OS: input.runner.os,
		RUNNER_ARCH: input.runner.arch,
		RUNNER_NAME: input.runner.name,
		RUNNER_TEMP: input.runner.temp,
		RUNNER_TOOL_CACHE: input.runner.tool_cache,
	};
	for (const [key, value] of Object.entries(shared)) {
		variables[`SKIFF_${key}`] = value;
		variables[`GITHUB_${key}`] = value;
	}
	// The platform registry (docs/REGISTRY.md), when it is on: `$SKIFF_REGISTRY_NAMESPACE/<name>:<tag>`.
	if (skiff.registry) {
		variables.SKIFF_REGISTRY = text('registry');
		variables.SKIFF_REGISTRY_NAMESPACE = text('registry_namespace');
	}
	return variables;
}

/** The few variables inherited from the step runner's own environment; nothing else leaks in. */
export const INHERITED_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'USER', 'LOGNAME', 'TERM'] as const;

export function inheritedEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of INHERITED_ENV) if (source[name]) env[name] = source[name]!;
	if (!env.PATH) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
	return env;
}

/**
 * The process environment for one step. Precedence, lowest first: inherited, runner variables,
 * workflow/job `env`, `$SKIFF_ENV` additions, step `env` (GitHub's order), and `$SKIFF_PATH`
 * entries prepended to PATH, most recent first.
 */
export function stepProcessEnv(input: {
	inherited: Record<string, string>;
	runner: Record<string, string>;
	jobEnv: Record<string, string>;
	fileEnv: Record<string, string>;
	stepEnv: Record<string, string>;
	pathAdditions: string[];
}): Record<string, string> {
	const env = { ...input.inherited, ...input.runner, ...input.jobEnv, ...input.fileEnv, ...input.stepEnv };
	if (input.pathAdditions.length) env.PATH = [...[...input.pathAdditions].reverse(), env.PATH ?? ''].filter(Boolean).join(':');
	return env;
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Resolve a step's working directory (step > job defaults > workflow defaults) against the
 * workspace and require it to stay inside, symlinks included.
 */
export function resolveWorkingDirectory(workspace: string, value: string | null): string {
	if (!value || value === '.') return workspace;
	if (value.includes('\0')) throw new StepSetupError('working-directory contains a NUL byte');
	const target = resolve(workspace, value);
	if (!isInside(workspace, target)) throw new StepSetupError(`working-directory "${value}" is outside the workspace`);
	let real: string;
	try {
		real = realpathSync(target);
	} catch {
		throw new StepSetupError(`working-directory "${value}" does not exist`);
	}
	if (!isInside(realpathSync(workspace), real))
		throw new StepSetupError(`working-directory "${value}" resolves outside the workspace`);
	if (!statSync(real).isDirectory()) throw new StepSetupError(`working-directory "${value}" is not a directory`);
	return target;
}

/** Expand a leading `~` and make a path absolute against the workspace. */
export function resolveUserPath(workspace: string, home: string, value: string): string {
	const trimmed = value.trim();
	if (trimmed === '~') return home;
	if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2));
	return resolve(workspace, trimmed);
}

/** Non-empty trimmed lines of a multi-line `with:` input (paths, restore-keys, tags). */
export function inputLines(value: string | undefined, separators: RegExp = /\r?\n/): string[] {
	if (!value) return [];
	return value
		.split(separators)
		.map((line) => line.trim())
		.filter(Boolean);
}

/** GitHub's truthiness for `with:` booleans and `continue-on-error` templates. */
export function truthyInput(value: unknown, fallback = false): boolean {
	if (value === undefined || value === null || value === '') return fallback;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	const text = String(value).trim().toLowerCase();
	if (['true', '1', 'yes', 'on'].includes(text)) return true;
	if (['false', '0', 'no', 'off'].includes(text)) return false;
	return fallback;
}

/**
 * `hashFiles()`: GitHub's algorithm — sha256 over the concatenated sha256 digests of every
 * matching regular file inside the workspace, here in sorted path order; '' when nothing
 * matches. Patterns starting with `!` exclude.
 */
export function hashFiles(workspace: string, patterns: string[]): string {
	const include = patterns.filter((pattern) => pattern && !pattern.startsWith('!'));
	const exclude = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => new Bun.Glob(pattern.slice(1)));
	const realWorkspace = realpathSync(workspace);
	const files = new Set<string>();
	for (const pattern of include) {
		const relativePattern = isAbsolute(pattern) ? relative(workspace, pattern) : pattern;
		if (relativePattern.startsWith('..')) continue;
		for (const path of new Bun.Glob(relativePattern).scanSync({ cwd: workspace, dot: true, onlyFiles: true })) {
			if (exclude.some((glob) => glob.match(path))) continue;
			files.add(path);
		}
	}
	const sorted = [...files].sort();
	if (!sorted.length) return '';
	const result = createHash('sha256');
	let matched = 0;
	for (const path of sorted) {
		const full = join(workspace, path);
		let real: string;
		try {
			real = realpathSync(full);
		} catch {
			continue;
		}
		if (!isInside(realWorkspace, real)) continue;
		result.update(createHash('sha256').update(readFileSync(full)).digest());
		matched += 1;
	}
	return matched ? result.digest('hex') : '';
}
