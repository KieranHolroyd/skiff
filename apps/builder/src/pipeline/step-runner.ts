import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type {
	PipelineActionRef,
	PipelineActionRuns,
	PipelineBuiltinAction,
	PipelineJobClaim,
	PipelineJobComplete,
	PipelineStatusState,
	PipelineStepContext,
	PipelineStepReport,
	PipelineStepSpec,
} from '@yoal/contracts';
import { evaluateCondition, interpolate, interpolateValue, parsePipelineActionRef, PIPELINE_DEFAULT_IMAGE } from '@yoal/contracts';
import { runAction, type ActionHost } from './actions.ts';
import type { JobApi } from './client.ts';
import { PROTECTED_ENV_NAMES, WorkflowCommandProcessor, parseKeyValueFile, parsePathFile } from './commands.ts';
import {
	buildJobContext,
	hashFiles,
	inheritedEnv,
	layerEnv,
	resolveWorkingDirectory,
	runnerArch,
	runnerOs,
	runnerVariables,
	stepProcessEnv,
	truthyInput,
	type EvalOptions,
	type JobContext,
	type RunnerInfo,
} from './context.ts';
import { LogBatcher, pumpLines } from './logs.ts';
import { Masker } from './masker.ts';
import {
	ActionResolver,
	MAX_ACTION_DEPTH,
	actionFile,
	actionInputs,
	inputEnvName,
	stateEnv,
	type ResolvedAction,
} from './remote-actions.ts';

/**
 * The in-job step runner (`yoal-step`, W5). It runs inside the job container (or the sandbox
 * unit) as the job's own user, talks to the control plane with the job token only, and runs the
 * steps one after another as child processes so the workspace, `$PATH` additions and files carry
 * between steps exactly as on a GitHub runner.
 *
 * It owns the job's semantics: `if:` with success()/failure()/cancelled()/always(), env layering,
 * file and workflow commands, masking, per-step and job timeouts, built-in actions, job outputs
 * and the final `/complete`. The host daemon only provides the box, the heartbeat and a hard kill.
 */

type Outcome = PipelineStepContext['outcome'];

export interface StepRunnerPaths {
	workspace: string;
	/** `RUNNER_TEMP`: scripts, file-command files and downloads. */
	temp: string;
	home: string;
	toolCache: string;
}

export interface StepRunnerOptions {
	claim: PipelineJobClaim;
	api: JobApi;
	paths: StepRunnerPaths;
	runnerName?: string;
	/** Environment the steps inherit PATH/HOME/LANG from; defaults to this process's. */
	baseEnv?: Record<string, string | undefined>;
	/** Diagnostics for the runner's own stdout (never job output). */
	diagnostics?: (message: string) => void;
	logFlushMs?: number;
	/** Grace between SIGTERM and SIGKILL for a step's process group. */
	killGraceMs?: number;
	/** Remote actions: download base (default codeload.github.com) and size cap. */
	actions?: { baseUrl?: string; maxBytes?: number };
}

/**
 * A repository secret that, when set, authenticates action downloads (private action repositories).
 * A step-level `GITHUB_TOKEN` env var is used first.
 */
export const ACTIONS_TOKEN_SECRET = 'ACTIONS_GITHUB_TOKEN';

/** Where steps run: the job itself, or a composite action (whose steps log under the calling step). */
interface Scope {
	/** Step index that logs and post steps belong to. */
	index: number;
	/** Expression context: the job's, or the composite's own `inputs`/`steps`. */
	context: JobContext;
	status(): PipelineStatusState;
	markFailed(): void;
	/** `env:` of the enclosing composite `uses:` step(s), under each nested step's own env. */
	outerEnv: Record<string, string>;
	/** `GITHUB_ACTION_PATH` and friends, for steps inside an action. */
	actionEnv: Record<string, string>;
	/** Composite nesting depth (0 for job steps). */
	depth: number;
	/** `defaults.run`, which applies to the job's own run steps only. */
	defaults: { shell: string | null; workingDirectory: string | null };
}

interface StepResult {
	outcome: Outcome;
	outputs: Record<string, string>;
}

interface TrackedProcess {
	pid: number;
	exited: Promise<number>;
}

const SHELL_TEMPLATES: Record<string, { argv: string[]; extension: string }> = {
	bash: { argv: ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '{0}'], extension: '.sh' },
	sh: { argv: ['sh', '-e', '{0}'], extension: '.sh' },
	python: { argv: ['python', '{0}'], extension: '.py' },
};

/**
 * Turn `shell:` into argv with `{0}` as the script path. No `shell:` at all means GitHub's
 * `bash -e {0}` (no pipefail), or `sh -e {0}` in an image without bash.
 */
export function shellCommand(shell: string | null, scriptPath: string, hasBash: boolean): string[] {
	let template: string[];
	if (!shell) template = hasBash ? ['bash', '-e', '{0}'] : ['sh', '-e', '{0}'];
	else if (SHELL_TEMPLATES[shell]) template = SHELL_TEMPLATES[shell]!.argv;
	else {
		template = shell.trim().split(/\s+/);
		if (!template.some((part) => part.includes('{0}')))
			throw new Error(`Custom shell "${shell}" must contain {0} where the script path goes`);
	}
	return template.map((part) => part.replaceAll('{0}', scriptPath));
}

function scriptExtension(shell: string | null): string {
	return (shell && SHELL_TEMPLATES[shell]?.extension) || (shell?.startsWith('python') ? '.py' : '.sh');
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			/* already gone */
		}
	}
}

export class StepRunner {
	private readonly claim: PipelineJobClaim;
	private readonly api: JobApi;
	private readonly paths: StepRunnerPaths;
	private readonly masker = new Masker();
	private readonly logs: LogBatcher;
	private readonly runner: RunnerInfo;
	private readonly inherited: Record<string, string>;
	private readonly killGraceMs: number;
	private readonly diagnostics: (message: string) => void;

	private context!: JobContext;
	private jobEnv: Record<string, string> = {};
	/** `$YOAL_ENV` additions, carried to later steps. */
	private fileEnv: Record<string, string> = {};
	private pathAdditions: string[] = [];
	private failed = false;
	private cancelled = false;
	private timedOut = false;
	private currentStep = -1;
	/** Every process group started, so cancellation and job end reach background children too. */
	private readonly processes = new Set<TrackedProcess>();
	/** Groups started by the running step, which its own timeout stops. */
	private stepProcesses = new Set<TrackedProcess>();
	private readonly posts: Array<{ index: number; if: string; failsJob: boolean; run: () => Promise<void> }> = [];
	private readonly actions: ActionResolver;
	private reports: Promise<void> = Promise.resolve();

	constructor(options: StepRunnerOptions) {
		this.claim = options.claim;
		this.api = options.api;
		this.paths = options.paths;
		this.killGraceMs = options.killGraceMs ?? 7_500;
		this.diagnostics = options.diagnostics ?? ((message) => console.log(`[yoal-step] ${message}`));
		this.inherited = inheritedEnv(options.baseEnv ?? process.env);
		this.inherited.HOME = options.paths.home;
		this.runner = {
			os: runnerOs(),
			arch: runnerArch(),
			name: options.runnerName ?? hostname(),
			temp: options.paths.temp,
			tool_cache: options.paths.toolCache,
			workspace: options.paths.workspace,
		};
		this.actions = new ActionResolver({
			workspace: options.paths.workspace,
			toolCache: options.paths.toolCache,
			baseUrl: options.actions?.baseUrl,
			maxBytes: options.actions?.maxBytes,
		});
		this.logs = new LogBatcher(options.api, this.masker, {
			flushMs: options.logFlushMs,
			onError: (error) => this.diagnostics(`log upload failed: ${errorText(error)}`),
		});
	}

	/** SIGTERM from the host (cancel) or the job timeout: stop the running step, then let always() steps run. */
	cancel(reason: 'cancelled' | 'timed_out' = 'cancelled'): void {
		if (reason === 'timed_out') this.timedOut = true;
		else this.cancelled = true;
		this.logs.system(this.currentStep, reason === 'timed_out' ? 'The job has exceeded its time limit; cancelling.' : 'The job was cancelled.');
		this.terminate(this.processes);
	}

	private terminate(processes: Set<TrackedProcess>): void {
		for (const tracked of processes) {
			killGroup(tracked.pid, 'SIGTERM');
			const timer = setTimeout(() => killGroup(tracked.pid, 'SIGKILL'), this.killGraceMs);
			void tracked.exited.finally(() => clearTimeout(timer));
		}
	}

	private get status(): PipelineStatusState {
		return { failed: this.failed, cancelled: this.cancelled || this.timedOut };
	}

	private evalOptions(scope?: Scope): EvalOptions {
		const status = scope ? scope.status() : this.status;
		// `${{ job.status }}` follows the job as it runs, like GitHub's (success → failure/cancelled).
		const jobStatus = status.cancelled ? 'cancelled' : status.failed ? 'failure' : 'success';
		for (const context of [this.context, scope?.context])
			if (context) context.job = { ...(context.job ?? {}), status: jobStatus };
		return { status, hashFiles: (patterns) => hashFiles(this.paths.workspace, patterns) };
	}

	private report(index: number, report: PipelineStepReport): void {
		this.reports = this.reports.then(() =>
			this.api.step(index, report).then(
				() => undefined,
				(error: unknown) => this.diagnostics(`step ${index} report failed: ${errorText(error)}`),
			),
		);
	}

	/** Run the job and post `/complete`. Returns the completion and whether the control plane took it. */
	async run(): Promise<{ complete: PipelineJobComplete; delivered: boolean }> {
		const job = this.claim.job;
		const limit = Math.min(job.timeoutMinutes || Infinity, this.claim.limits.timeoutMinutes || Infinity);
		const jobTimer = Number.isFinite(limit) ? setTimeout(() => this.cancel('timed_out'), limit * 60_000) : null;
		let setupError: string | null = null;
		try {
			await mkdir(this.paths.temp, { recursive: true });
			await mkdir(this.paths.toolCache, { recursive: true });
			await mkdir(join(this.paths.temp, '_commands'), { recursive: true });
			const secrets = await this.api.secrets();
			this.masker.addAll(Object.values(secrets));
			this.context = buildJobContext({ claim: this.claim, secrets, runner: this.runner });
			this.jobEnv = layerEnv([this.claim.workflowEnv, job.env], this.context, this.evalOptions());
			this.context.env = { ...this.jobEnv };
			this.logs.system(-1, `Running job ${job.name} on ${this.runner.name} (${this.runner.os} ${this.runner.arch})`);
		} catch (error) {
			setupError = `Job setup failed: ${errorText(error)}`;
			this.logs.system(-1, setupError);
			this.failed = true;
		}

		if (!setupError) {
			for (let index = 0; index < job.steps.length; index += 1) await this.runStep(index, job.steps[index]!);
			await this.runPosts();
		}
		if (jobTimer) clearTimeout(jobTimer);

		const outputs = setupError ? {} : this.jobOutputs();
		const conclusion: PipelineJobComplete['conclusion'] = this.timedOut
			? 'timed_out'
			: this.cancelled
				? 'cancelled'
				: this.failed
					? 'failure'
					: 'success';
		this.logs.system(-1, `Job completed: ${conclusion}`);
		this.cleanupProcesses();
		await this.reports;
		await this.logs.close();
		const complete: PipelineJobComplete = { conclusion, outputs, ...(setupError ? { error: setupError.slice(0, 4000) } : {}) };
		try {
			await this.api.complete(complete);
			return { complete, delivered: true };
		} catch (error) {
			this.diagnostics(`complete failed: ${errorText(error)}`);
			return { complete, delivered: false };
		}
	}

	/** Background processes a step left behind die with the job, as on GitHub. */
	private cleanupProcesses(): void {
		for (const tracked of this.processes) killGroup(tracked.pid, 'SIGKILL');
		this.processes.clear();
	}

	private safeInterpolate(template: string, fallback: string, scope?: Scope): string {
		try {
			return interpolate(template, scope?.context ?? this.context, this.evalOptions(scope));
		} catch {
			return fallback;
		}
	}

	/** The job's own steps: the job context, job status, and `defaults.run`. */
	private jobScope(index: number): Scope {
		const job = this.claim.job;
		return {
			index,
			context: this.context,
			status: () => this.status,
			markFailed: () => {
				this.failed = true;
			},
			outerEnv: {},
			actionEnv: {},
			depth: 0,
			defaults: {
				shell: job.defaults.shell ?? this.claim.workflowDefaults.shell,
				workingDirectory: job.defaults.workingDirectory ?? this.claim.workflowDefaults.workingDirectory,
			},
		};
	}

	private async runStep(index: number, spec: PipelineStepSpec): Promise<void> {
		this.currentStep = index;
		const scope = this.jobScope(index);
		const name = this.safeInterpolate(spec.name, spec.name).slice(0, 500);
		let shouldRun: boolean;
		try {
			shouldRun = evaluateCondition(spec.if, this.context, this.evalOptions());
		} catch (error) {
			this.logs.system(index, `Error evaluating if: ${errorText(error)}`);
			this.failed = true;
			this.record(scope, spec, 'failure', 'failure', {});
			this.report(index, { status: 'completed', conclusion: 'failure', name });
			return;
		}
		if (!shouldRun) {
			this.record(scope, spec, 'skipped', 'skipped', {});
			this.report(index, { status: 'completed', conclusion: 'skipped', name });
			return;
		}

		this.report(index, { status: 'in_progress', name });
		const started = Date.now();
		this.stepProcesses = new Set();
		const timeoutMs = spec.timeoutMinutes ? spec.timeoutMinutes * 60_000 : null;
		let stepTimedOut = false;
		const stepTimer = timeoutMs
			? setTimeout(() => {
					stepTimedOut = true;
					this.logs.system(index, `The step has timed out after ${spec.timeoutMinutes} minutes.`);
					this.terminate(this.stepProcesses);
				}, timeoutMs)
			: null;
		let result: StepResult;
		try {
			result = await this.execute(scope, spec);
		} catch (error) {
			this.logs.push(index, 'stderr', `Error: ${errorText(error)}`);
			result = { outcome: 'failure', outputs: {} };
		} finally {
			if (stepTimer) clearTimeout(stepTimer);
		}
		if (stepTimedOut && result.outcome !== 'success') result.outcome = 'failure';
		else if ((this.cancelled || this.timedOut) && result.outcome === 'failure') result.outcome = 'cancelled';

		const conclusion = this.conclude(scope, spec, result);
		this.logs.system(index, `Step finished: ${conclusion} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
		const reportedOutputs = Object.fromEntries(Object.entries(result.outputs).map(([key, value]) => [key, this.masker.mask(value)]));
		this.report(index, { status: 'completed', conclusion, name, outputs: reportedOutputs });
	}

	/** Apply `continue-on-error`, mark the scope failed, and record `steps.<id>`. */
	private conclude(scope: Scope, spec: PipelineStepSpec, result: StepResult): Outcome {
		let continueOnError = false;
		try {
			continueOnError =
				typeof spec.continueOnError === 'boolean'
					? spec.continueOnError
					: truthyInput(interpolateValue(spec.continueOnError, scope.context, this.evalOptions(scope)));
		} catch (error) {
			this.logs.system(scope.index, `Error evaluating continue-on-error: ${errorText(error)}`);
		}
		const conclusion: Outcome = result.outcome === 'failure' && continueOnError ? 'success' : result.outcome;
		if (conclusion === 'failure') scope.markFailed();
		if (result.outcome === 'failure' && continueOnError)
			this.logs.system(scope.index, 'The step failed, but continue-on-error is set; the job carries on.');
		this.record(scope, spec, result.outcome, conclusion, result.outputs);
		return conclusion;
	}

	/** A step of a composite action: same rules as a job step, scoped to the action. */
	private async runNestedStep(scope: Scope, spec: PipelineStepSpec): Promise<void> {
		const name = this.safeInterpolate(spec.name, spec.name, scope).slice(0, 500);
		let shouldRun: boolean;
		try {
			shouldRun = evaluateCondition(spec.if, scope.context, this.evalOptions(scope));
		} catch (error) {
			this.logs.system(scope.index, `Error evaluating if of ${name}: ${errorText(error)}`);
			scope.markFailed();
			this.record(scope, spec, 'failure', 'failure', {});
			return;
		}
		if (!shouldRun) {
			this.record(scope, spec, 'skipped', 'skipped', {});
			return;
		}
		this.logs.system(scope.index, `${'>'.repeat(scope.depth)} ${name}`);
		let result: StepResult;
		try {
			result = await this.execute(scope, spec);
		} catch (error) {
			this.logs.push(scope.index, 'stderr', `Error: ${errorText(error)}`);
			result = { outcome: 'failure', outputs: {} };
		}
		if ((this.cancelled || this.timedOut) && result.outcome === 'failure') result.outcome = 'cancelled';
		this.conclude(scope, spec, result);
	}

	private record(scope: Scope, spec: PipelineStepSpec, outcome: Outcome, conclusion: Outcome, outputs: Record<string, string>): void {
		if (spec.id) scope.context.steps = { ...scope.context.steps, [spec.id]: { outcome, conclusion, outputs } };
	}

	/** Evaluate the step's own `env:` in order, each value seeing `base` plus the ones before it. */
	private stepEnv(spec: PipelineStepSpec, scope: Scope, base: Record<string, string>): Record<string, string> {
		const env: Record<string, string> = {};
		for (const [name, template] of Object.entries(spec.env))
			env[name] = interpolate(template, { ...scope.context, env: { ...base, ...env } }, this.evalOptions(scope));
		return env;
	}

	private async execute(scope: Scope, spec: PipelineStepSpec): Promise<StepResult> {
		// Step env sees the job env, $YOAL_ENV additions and an enclosing composite step's env.
		const base = { ...this.jobEnv, ...this.fileEnv, ...scope.outerEnv };
		const stepEnv = { ...scope.outerEnv, ...this.stepEnv(spec, scope, base) };
		// The env context during this step, for `run:` and `with:` templates.
		scope.context.env = { ...this.jobEnv, ...this.fileEnv, ...stepEnv };
		const files = {
			output: join(this.paths.temp, '_commands', `output_${scope.index}_${randomUUID()}`),
			env: join(this.paths.temp, '_commands', `env_${scope.index}_${randomUUID()}`),
			path: join(this.paths.temp, '_commands', `path_${scope.index}_${randomUUID()}`),
			summary: join(this.paths.temp, '_commands', `summary_${scope.index}_${randomUUID()}`),
		};
		await Promise.all(Object.values(files).map((path) => writeFile(path, '', { mode: 0o644 })));
		const env = stepProcessEnv({
			inherited: this.inherited,
			runner: { ...runnerVariables({ context: scope.context, runner: this.runner, files }), ...scope.actionEnv },
			jobEnv: this.jobEnv,
			fileEnv: this.fileEnv,
			stepEnv,
			pathAdditions: this.pathAdditions,
		});
		const outputs: Record<string, string> = {};
		let outcome: Outcome;
		try {
			if (spec.run !== null) {
				outcome = await this.executeRun(scope, spec, env, outputs);
			} else if (spec.uses) {
				outcome = await this.executeUses(scope, spec, env, stepEnv, outputs);
			} else {
				throw new Error('Step has neither run nor uses');
			}
		} finally {
			scope.context.env = { ...this.jobEnv, ...this.fileEnv, ...scope.outerEnv };
		}

		// File commands are applied whatever the outcome, as on GitHub.
		try {
			Object.assign(outputs, parseKeyValueFile(await readFile(files.output, 'utf8')));
			for (const [name, value] of Object.entries(parseKeyValueFile(await readFile(files.env, 'utf8')))) {
				if (PROTECTED_ENV_NAMES.has(name)) {
					this.logs.system(scope.index, `Warning: ${name} cannot be set through $YOAL_ENV; ignored.`);
					continue;
				}
				this.fileEnv[name] = value;
			}
			this.pathAdditions.push(...parsePathFile(await readFile(files.path, 'utf8')));
		} catch (error) {
			this.logs.push(scope.index, 'stderr', `Error: ${errorText(error)}`);
			outcome = outcome === 'success' ? 'failure' : outcome;
		}
		scope.context.env = { ...this.jobEnv, ...this.fileEnv, ...scope.outerEnv };
		return { outcome, outputs };
	}

	/** Log lines with workflow commands applied (masks, `::set-output`, warnings). */
	private commandLines(index: number, outputs: Record<string, string>): (stream: 'stdout' | 'stderr', line: string) => void {
		const processor = new WorkflowCommandProcessor();
		return (stream, line) => {
			const { line: kept, effect } = processor.process(line);
			if (effect?.kind === 'mask') this.masker.add(effect.value);
			else if (effect?.kind === 'output') outputs[effect.name] = effect.value;
			else if (effect?.kind === 'warning') this.logs.system(index, `Warning: ${effect.message}`);
			if (kept !== null) this.logs.push(index, stream, kept);
		};
	}

	private async executeRun(scope: Scope, spec: PipelineStepSpec, env: Record<string, string>, outputs: Record<string, string>): Promise<Outcome> {
		const options = this.evalOptions(scope);
		const directory = spec.workingDirectory ?? scope.defaults.workingDirectory;
		const cwd = resolveWorkingDirectory(this.paths.workspace, directory ? interpolate(directory, scope.context, options) : null);
		const script = interpolate(spec.run!, scope.context, options);
		const shell = spec.shell ?? scope.defaults.shell;
		const scriptPath = join(this.paths.temp, `step_${scope.index}_${randomUUID()}${scriptExtension(shell)}`);
		await writeFile(scriptPath, script.endsWith('\n') ? script : `${script}\n`, { mode: 0o700 });
		await chmod(scriptPath, 0o700);
		const hasBash = Boolean(Bun.which('bash', { PATH: env.PATH ?? '' }));
		const argv = shellCommand(shell, scriptPath, hasBash);
		const code = await this.spawnLogged(argv, { cwd, env, onLine: this.commandLines(scope.index, outputs) });
		if (code !== 0) this.logs.system(scope.index, `Process completed with exit code ${code}.`);
		return code === 0 ? 'success' : 'failure';
	}

	private async executeUses(
		scope: Scope,
		spec: PipelineStepSpec,
		env: Record<string, string>,
		stepEnv: Record<string, string>,
		outputs: Record<string, string>,
	): Promise<Outcome> {
		const ref = parsePipelineActionRef(spec.uses!);
		if (ref.kind === 'invalid') {
			this.logs.push(scope.index, 'stderr', `Error: ${ref.message}`);
			return 'failure';
		}
		const inputs: Record<string, string> = {};
		for (const [key, template] of Object.entries(spec.with)) inputs[key] = interpolate(template, scope.context, this.evalOptions(scope));
		if (ref.kind === 'builtin') return this.executeBuiltin(scope, ref.action, inputs, env, outputs);
		return this.executeAction(scope, spec, ref, inputs, env, stepEnv, outputs);
	}

	private async executeBuiltin(
		scope: Scope,
		action: PipelineBuiltinAction,
		inputs: Record<string, string>,
		env: Record<string, string>,
		outputs: Record<string, string>,
	): Promise<Outcome> {
		const index = scope.index;
		const directory = scope.defaults.workingDirectory;
		const cwd = resolveWorkingDirectory(
			this.paths.workspace,
			directory ? interpolate(directory, scope.context, this.evalOptions(scope)) : null,
		);
		const host: ActionHost = {
			api: this.api,
			claim: this.claim,
			workspace: this.paths.workspace,
			temp: this.paths.temp,
			home: this.paths.home,
			cwd,
			env,
			masker: this.masker,
			secretNames: Object.keys(this.context.secrets ?? {}),
			log: (text, stream = 'stdout') => this.logs.push(index, stream, text),
			exec: (argv, options = {}) =>
				this.spawnLogged(argv, {
					cwd: options.cwd ?? cwd,
					env: { ...env, ...options.env },
					stdin: options.stdin,
					onLine: (stream, line) => this.logs.push(index, stream, line),
				}),
			// Built-in post steps (cache save) only run on success, like actions/cache.
			addPost: (run) => this.posts.push({ index, if: 'success()', failsJob: false, run }),
			isCancelled: () => this.cancelled || this.timedOut,
		};
		const result = await runAction(action, inputs, host);
		Object.assign(outputs, result.outputs);
		return result.outcome;
	}

	/** A composite or JavaScript action, local (`./path`) or from github.com (`owner/repo@ref`). */
	private async executeAction(
		scope: Scope,
		spec: PipelineStepSpec,
		ref: Extract<PipelineActionRef, { kind: 'local' | 'remote' }>,
		given: Record<string, string>,
		env: Record<string, string>,
		stepEnv: Record<string, string>,
		outputs: Record<string, string>,
	): Promise<Outcome> {
		const uses = spec.uses!;
		if (scope.depth >= MAX_ACTION_DEPTH) {
			this.logs.push(scope.index, 'stderr', `Error: ${uses}: composite actions are nested more than ${MAX_ACTION_DEPTH} deep`);
			return 'failure';
		}
		let action: ResolvedAction;
		try {
			action = await this.actions.resolve(ref, uses, {
				token: env.GITHUB_TOKEN || this.context.secrets?.[ACTIONS_TOKEN_SECRET] || null,
				log: (text) => this.logs.system(scope.index, text),
			});
		} catch (error) {
			this.logs.push(scope.index, 'stderr', `Error: ${errorText(error)}`);
			return 'failure';
		}
		const options = this.evalOptions(scope);
		let inputs: Record<string, string>;
		try {
			const resolved = actionInputs(action.manifest, given, (template) => interpolate(template, scope.context, options));
			inputs = resolved.values;
			if (resolved.unexpected.length)
				this.logs.system(
					scope.index,
					`Warning: Unexpected input(s) ${resolved.unexpected.map((name) => `'${name}'`).join(', ')}, valid inputs are [${Object.keys(action.manifest.inputs)
						.map((name) => `'${name}'`)
						.join(', ')}]`,
				);
		} catch (error) {
			this.logs.push(scope.index, 'stderr', `Error evaluating the inputs of ${uses}: ${errorText(error)}`);
			return 'failure';
		}
		const identity: Record<string, string> = {
			GITHUB_ACTION: spec.id ?? `__${(action.repository ?? 'self').replace(/[^A-Za-z0-9]+/g, '_')}`,
			GITHUB_ACTION_PATH: action.dir,
			GITHUB_ACTION_REPOSITORY: action.repository ?? '',
			GITHUB_ACTION_REF: action.ref ?? '',
		};
		const runs = action.manifest.runs;
		switch (runs.using) {
			case 'docker':
				this.logs.push(
					scope.index,
					'stderr',
					`Error: ${uses} is a Docker container action, which Yoal Pipelines cannot run; use a run: step or the GitHub runner pool (docs/RUNNERS.md).`,
				);
				return 'failure';
			case 'composite':
				return this.runComposite(scope, action, runs.steps, inputs, stepEnv, identity, outputs);
			default:
				return this.runNodeAction(scope, action, runs, inputs, env, identity, outputs);
		}
	}

	private async runComposite(
		scope: Scope,
		action: ResolvedAction,
		steps: PipelineStepSpec[],
		inputs: Record<string, string>,
		stepEnv: Record<string, string>,
		identity: Record<string, string>,
		outputs: Record<string, string>,
	): Promise<Outcome> {
		const yoal = {
			...scope.context.yoal,
			action: identity.GITHUB_ACTION,
			action_path: action.dir,
			action_repository: identity.GITHUB_ACTION_REPOSITORY,
			action_ref: identity.GITHUB_ACTION_REF,
		};
		let failed = false;
		const nested: Scope = {
			index: scope.index,
			context: { ...scope.context, yoal, github: yoal, inputs, steps: {}, env: { ...this.jobEnv, ...this.fileEnv, ...stepEnv } },
			status: () => ({ failed, cancelled: this.cancelled || this.timedOut }),
			markFailed: () => {
				failed = true;
			},
			outerEnv: stepEnv,
			actionEnv: identity,
			depth: scope.depth + 1,
			// `defaults.run` does not reach into actions.
			defaults: { shell: null, workingDirectory: null },
		};
		for (const step of steps) await this.runNestedStep(nested, step);
		for (const [name, output] of Object.entries(action.manifest.outputs)) {
			if (output.value === null) continue;
			try {
				outputs[name] = interpolate(output.value, nested.context, this.evalOptions(nested));
			} catch (error) {
				this.logs.system(scope.index, `Warning: output ${name} of ${action.uses} could not be evaluated: ${errorText(error)}`);
			}
		}
		return failed ? 'failure' : 'success';
	}

	private async runNodeAction(
		scope: Scope,
		action: ResolvedAction,
		runs: Extract<PipelineActionRuns, { main: string }>,
		inputs: Record<string, string>,
		env: Record<string, string>,
		identity: Record<string, string>,
		outputs: Record<string, string>,
	): Promise<Outcome> {
		const index = scope.index;
		const node = Bun.which('node', { PATH: env.PATH ?? '' });
		if (!node) {
			this.logs.push(
				index,
				'stderr',
				`Error: ${action.uses} is a JavaScript action (runs.using: ${runs.using}) and needs Node.js, but node is not on PATH. ` +
					`Use a job image with Node (${PIPELINE_DEFAULT_IMAGE} has it) or install Node in an earlier step.`,
			);
			return 'failure';
		}
		const stateFile = join(this.paths.temp, '_commands', `state_${index}_${randomUUID()}`);
		await writeFile(stateFile, '', { mode: 0o644 });
		const inputEnv = Object.fromEntries(Object.entries(inputs).map(([name, value]) => [inputEnvName(name), value]));
		const baseEnv = { ...env, ...identity, ...inputEnv, GITHUB_STATE: stateFile, YOAL_STATE: stateFile };
		const state: Record<string, string> = {};
		const phase = async (file: string, phaseOutputs: Record<string, string>): Promise<number> => {
			const script = await actionFile(action, file);
			const code = await this.spawnLogged([node, script], {
				cwd: this.paths.workspace,
				env: { ...baseEnv, ...stateEnv(state) },
				onLine: this.commandLines(index, phaseOutputs),
			});
			Object.assign(state, parseKeyValueFile(await readFile(stateFile, 'utf8')));
			await writeFile(stateFile, '');
			if (code !== 0) this.logs.system(index, `Process completed with exit code ${code}.`);
			return code;
		};

		try {
			if (runs.pre && evaluateCondition(runs.preIf ?? 'always()', scope.context, this.evalOptions(scope))) {
				this.logs.system(index, `Pre ${action.uses}`);
				if ((await phase(runs.pre, {})) !== 0) return 'failure';
			}
			const code = await phase(runs.main, outputs);
			if (runs.post) {
				const post = runs.post;
				this.posts.push({
					index,
					if: runs.postIf ?? 'always()',
					failsJob: true,
					run: async () => {
						this.logs.system(index, `Post ${action.uses}`);
						const postCode = await phase(post, {});
						if (postCode !== 0) throw new Error(`the post step of ${action.uses} exited with code ${postCode}`);
					},
				});
			}
			return code === 0 ? 'success' : 'failure';
		} catch (error) {
			this.logs.push(index, 'stderr', `Error: ${errorText(error)}`);
			return 'failure';
		}
	}

	/** Spawn in its own process group (so cancel reaches the whole tree) and stream lines. */
	private async spawnLogged(
		argv: string[],
		options: {
			cwd: string;
			env: Record<string, string>;
			stdin?: string;
			onLine: (stream: 'stdout' | 'stderr', line: string) => void;
		},
	): Promise<number> {
		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(argv, {
				cwd: options.cwd,
				env: options.env,
				stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
				stdout: 'pipe',
				stderr: 'pipe',
				detached: true,
			});
		} catch (error) {
			options.onLine('stderr', `Error: could not start ${argv[0]}: ${errorText(error)}`);
			return 127;
		}
		const tracked: TrackedProcess = { pid: proc.pid, exited: proc.exited };
		this.processes.add(tracked);
		this.stepProcesses.add(tracked);
		const pumps = Promise.all([
			pumpLines(proc.stdout as ReadableStream<Uint8Array>, (line) => options.onLine('stdout', line)),
			pumpLines(proc.stderr as ReadableStream<Uint8Array>, (line) => options.onLine('stderr', line)),
		]);
		const code = await proc.exited;
		// A background child may hold the pipes open; do not wait on it forever.
		await Promise.race([pumps, new Promise((resolve) => setTimeout(resolve, 1_000))]);
		// Keep tracking the group only while something in it may still run (background children).
		void pumps.finally(() => {
			this.processes.delete(tracked);
			this.stepProcesses.delete(tracked);
		});
		return code;
	}

	/** Post steps, last registered first, each under its `if:` (built-ins: success(); actions: post-if, default always()). */
	private async runPosts(): Promise<void> {
		for (const post of [...this.posts].reverse()) {
			let shouldRun: boolean;
			try {
				shouldRun = evaluateCondition(post.if, this.context, this.evalOptions());
			} catch (error) {
				this.logs.system(post.index, `Error evaluating the post step condition: ${errorText(error)}`);
				continue;
			}
			if (!shouldRun) continue;
			this.currentStep = post.index;
			try {
				await post.run();
			} catch (error) {
				this.logs.push(post.index, 'stderr', `${post.failsJob ? 'Error' : 'Warning'}: post step failed: ${errorText(error)}`);
				if (post.failsJob) this.failed = true;
			}
		}
	}

	private jobOutputs(): Record<string, string> {
		const outputs: Record<string, string> = {};
		const context = { ...this.context, env: { ...this.jobEnv } };
		for (const [name, template] of Object.entries(this.claim.job.outputs)) {
			let value: string;
			try {
				value = interpolate(template, context, this.evalOptions());
			} catch (error) {
				this.logs.system(-1, `Warning: job output ${name} could not be evaluated: ${errorText(error)}`);
				continue;
			}
			// GitHub drops outputs that would carry a secret to other jobs.
			if (this.masker.contains(value)) {
				this.logs.system(-1, `Warning: skipped job output ${name} because it may contain a secret.`);
				continue;
			}
			outputs[name] = value;
		}
		return outputs;
	}
}
