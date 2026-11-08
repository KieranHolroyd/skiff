/**
 * `skif workflow run --local` (docs/PIPELINES.md §8, WP4): run a workflow's jobs on this machine
 * with the builder's own step runner, without a control plane. A Bun.serve on 127.0.0.1 plays the
 * job API (`/api/pipeline/*`) in memory; artifacts and caches live under `.skiff/local/`.
 *
 * Steps run directly on this machine (no job container, no services); `container:`, `services:`,
 * environments' approvals and `skiff/deploy` need a real control plane and are reported, not faked.
 * Loaded lazily (and only under Bun): it pulls in the step runner and the workflow parser.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import type {
	PipelineJobClaim,
	PipelineJobComplete,
	PipelineJobSpec,
	PipelineLogBatch,
	PipelineNeedsContext,
	PipelineStepReport,
	PipelineWorkflow,
} from '../../../packages/contracts/src/pipeline.ts';
import { containsStatusFunction, evaluateCondition, interpolate, interpolateValue } from '../../../packages/contracts/src/pipeline-expr.ts';
import {
	PipelineWorkflowError,
	coerceDispatchInputs,
	expandMatrix,
	matrixJobName,
	parseWorkflow,
	topologicalJobOrder,
} from '../../../packages/contracts/src/pipeline-workflow.ts';
import { JobApi } from '../../builder/src/pipeline/client.ts';
import { StepRunner } from '../../builder/src/pipeline/step-runner.ts';
import { CliError } from './errors.ts';

export interface LocalRunOptions {
	/** The workflow file. */
	file: string;
	/** Only this job (its `needs` are not run; their outputs are empty). */
	job?: string;
	/** `-f key=value` workflow_dispatch inputs. */
	inputs?: Record<string, string>;
	secrets?: Record<string, string>;
	vars?: Record<string, string>;
	/** `--matrix key=value`: run only the combinations that match. */
	matrix?: Record<string, string>;
	/** `skiff.event_name` (default `workflow_dispatch`). */
	event?: string;
	/** Repository root; the workspace unless `copy`. */
	cwd: string;
	/** Run in a temporary copy of `cwd` so steps cannot change the checkout. */
	copy?: boolean;
	print?: (line: string) => void;
	/** For tests: flush logs faster. */
	logFlushMs?: number;
}

export interface LocalJobResult {
	key: string;
	name: string;
	conclusion: PipelineJobComplete['conclusion'] | 'skipped';
	outputs: Record<string, string>;
}

export interface LocalRunResult {
	ok: boolean;
	runId: string;
	jobs: LocalJobResult[];
}

const ZERO_SHA = '0'.repeat(40);

function git(cwd: string, ...args: string[]): string | null {
	try {
		const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' });
		return result.exitCode === 0 ? result.stdout.toString().trim() : null;
	} catch {
		return null;
	}
}

/** `owner/repo` from the origin remote, else the directory name. */
function repositoryName(cwd: string): string {
	const remote = git(cwd, 'remote', 'get-url', 'origin');
	const match = remote ? /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote) : null;
	return match?.[1] ?? basename(cwd);
}

export async function loadWorkflow(file: string, cwd: string): Promise<PipelineWorkflow> {
	const yaml = (globalThis as { Bun?: { YAML?: { parse(text: string): unknown } } }).Bun?.YAML;
	if (!yaml) throw new CliError('skif workflow run --local needs the Bun runtime. Run it with bun, or use the standalone skif binary.');
	let text: string;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		throw new CliError(`Could not read ${file}: ${(error as Error).message}`);
	}
	let doc: unknown;
	try {
		doc = yaml.parse(text);
	} catch (error) {
		throw new CliError(`${file}: YAML: ${(error as Error).message}`);
	}
	const path = relative(cwd, resolve(file)) || file;
	try {
		return parseWorkflow(doc, path.startsWith('..') ? file : path);
	} catch (error) {
		if (error instanceof PipelineWorkflowError)
			throw new CliError(error.issues.map((issue) => `${file}: ${issue.path ? `${issue.path}: ` : ''}${issue.message}`).join('\n'), { code: 'invalid_workflow' });
		throw error;
	}
}

// --- the in-memory job API ----------------------------------------------------------------

interface JobState {
	label: string;
	stepNames: Map<number, string>;
	complete: PipelineJobComplete | null;
}

interface CacheEntry {
	key: string;
	version: string;
	file: string;
	size: number;
	createdAt: number;
}

class LocalJobApiServer {
	readonly jobs = new Map<string, JobState>();
	private readonly artifacts = new Map<string, { id: string; name: string; sha256: string; size: number; file: string; done: boolean; createdAt: string }>();
	private readonly pendingCaches = new Map<string, { key: string; version: string; file: string }>();
	private readonly blobs = new Map<string, string>();
	private server: ReturnType<typeof Bun.serve> | null = null;

	constructor(
		private readonly dirs: { artifacts: string; caches: string },
		private readonly secrets: Record<string, string>,
		private readonly print: (line: string) => void,
	) {}

	get url(): string {
		return `http://127.0.0.1:${this.server!.port}`;
	}

	start(): void {
		this.server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => this.handle(request) });
	}

	stop(): void {
		this.server?.stop(true);
	}

	private async cacheIndex(): Promise<CacheEntry[]> {
		return JSON.parse(await readFile(join(this.dirs.caches, 'index.json'), 'utf8').catch(() => '[]')) as CacheEntry[];
	}

	private async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const json = (value: unknown, status = 200) => Response.json(value, { status });
		const blob = /^\/blob\/([A-Za-z0-9_-]+)$/.exec(path);
		if (blob) {
			const file = this.blobs.get(blob[1]!);
			if (!file) return new Response('unknown blob', { status: 404 });
			if (request.method === 'PUT') {
				await Bun.write(file, request);
				return new Response(null, { status: 200 });
			}
			return new Response(Bun.file(file));
		}
		const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
		const job = this.jobs.get(token);
		if (!job) return new Response('unauthorized', { status: 401 });
		const body = request.method === 'POST' ? ((await request.json().catch(() => ({}))) as Record<string, any>) : {};
		const newBlob = (file: string) => {
			const id = randomUUID().replace(/-/g, '');
			this.blobs.set(id, file);
			return `/blob/${id}`;
		};

		if (path === '/api/pipeline/secrets') return json({ secrets: this.secrets });
		if (path === '/api/pipeline/heartbeat') return json({ cancelled: false, leaseExpiresAt: Date.now() + 60_000 });
		if (path === '/api/pipeline/logs') {
			for (const line of (body as PipelineLogBatch).lines ?? []) this.print(`[${job.label}] ${line.stream === 'system' ? '· ' : '  '}${line.text}`);
			return json({ ok: true });
		}
		const step = /^\/api\/pipeline\/steps\/(\d+)$/.exec(path);
		if (step) {
			const report = body as PipelineStepReport;
			const index = Number(step[1]);
			if (report.name) job.stepNames.set(index, report.name);
			const name = job.stepNames.get(index) ?? `Step ${index + 1}`;
			if (report.status === 'in_progress') this.print(`[${job.label}] ▶ ${name}`);
			else if (report.status === 'completed' && report.conclusion !== 'skipped') this.print(`[${job.label}] ${report.conclusion === 'success' ? '✓' : '✗'} ${name}${report.conclusion === 'success' ? '' : ` (${report.conclusion})`}`);
			else if (report.status === 'completed') this.print(`[${job.label}] - ${name} (skipped)`);
			return json({ ok: true });
		}
		if (path === '/api/pipeline/complete') {
			job.complete = body as PipelineJobComplete;
			return json({ ok: true });
		}
		if (path === '/api/pipeline/artifacts' && request.method === 'POST') {
			const id = `art_${randomUUID().slice(0, 8)}`;
			const file = join(this.dirs.artifacts, `${id}.tgz`);
			const createdAt = new Date().toISOString();
			this.artifacts.set(id, { id, name: String(body.name), sha256: String(body.sha256), size: Number(body.size), file, done: false, createdAt });
			return json({ artifactId: id, uploadUrl: newBlob(file) });
		}
		const finalize = /^\/api\/pipeline\/artifacts\/([^/]+)\/finalize$/.exec(path);
		if (finalize) {
			const artifact = this.artifacts.get(decodeURIComponent(finalize[1]!));
			if (!artifact) return json({ error: 'unknown artifact' }, 404);
			artifact.done = true;
			for (const other of this.artifacts.values()) if (other !== artifact && other.name === artifact.name) this.artifacts.delete(other.id);
			return json(this.view(artifact));
		}
		if (path === '/api/pipeline/artifacts') {
			const name = url.searchParams.get('name');
			const list = [...this.artifacts.values()].filter((artifact) => artifact.done && (!name || artifact.name === name));
			return json({ artifacts: list.map((artifact) => ({ ...this.view(artifact), downloadUrl: newBlob(artifact.file) })) });
		}
		if (path === '/api/pipeline/cache/lookup') {
			const entries = (await this.cacheIndex()).filter((entry) => entry.version === body.version).sort((a, b) => b.createdAt - a.createdAt);
			const hit =
				entries.find((entry) => entry.key === body.key) ??
				((body.restoreKeys as string[]) ?? []).map((prefix) => entries.find((entry) => entry.key.startsWith(prefix))).find(Boolean);
			if (!hit) return json({ hit: null });
			return json({ hit: { key: hit.key, size: hit.size, downloadUrl: newBlob(join(this.dirs.caches, hit.file)) } });
		}
		if (path === '/api/pipeline/cache/reserve') {
			if ((await this.cacheIndex()).some((entry) => entry.key === body.key && entry.version === body.version))
				return json({ cacheId: null, uploadUrl: null, reason: 'the key already exists' });
			const id = `cache_${randomUUID().slice(0, 8)}`;
			const file = `${createHash('sha256').update(`${body.key}|${body.version}`).digest('hex').slice(0, 32)}.tgz`;
			this.pendingCaches.set(id, { key: String(body.key), version: String(body.version), file });
			return json({ cacheId: id, uploadUrl: newBlob(join(this.dirs.caches, file)) });
		}
		const commit = /^\/api\/pipeline\/cache\/([^/]+)\/commit$/.exec(path);
		if (commit) {
			const pending = this.pendingCaches.get(decodeURIComponent(commit[1]!));
			if (!pending) return json({ error: 'unknown cache' }, 404);
			const size = Bun.file(join(this.dirs.caches, pending.file)).size;
			const index = (await this.cacheIndex()).filter((entry) => !(entry.key === pending.key && entry.version === pending.version));
			index.push({ ...pending, size, createdAt: Date.now() });
			await writeFile(join(this.dirs.caches, 'index.json'), JSON.stringify(index, null, 2));
			return json({ ok: true });
		}
		if (path.startsWith('/api/pipeline/deploy')) return json({ error: 'skiff/deploy needs a control plane; it does not run with --local' }, 501);
		if (path === '/api/pipeline/oidc-token') return json({ error: 'skiff/oidc-token needs a control plane; it does not run with --local' }, 501);
		return json({ error: `not available locally: ${path}` }, 404);
	}

	private view(artifact: { id: string; name: string; sha256: string; size: number; createdAt: string }) {
		return { id: artifact.id, runId: 'local', jobId: null, name: artifact.name, size: artifact.size, sha256: artifact.sha256, createdAt: artifact.createdAt, expiresAt: artifact.createdAt };
	}
}

// --- running ------------------------------------------------------------------------------

function matches(combo: Record<string, unknown>, filter: Record<string, string>): boolean {
	return Object.entries(filter).every(([key, value]) => String(combo[key] ?? '') === value);
}

export async function runLocalWorkflow(options: LocalRunOptions): Promise<LocalRunResult> {
	const print = options.print ?? ((line: string) => console.log(line));
	const root = resolve(options.cwd);
	const workflow = await loadWorkflow(resolve(root, options.file), root);
	const runId = `local-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${randomBytes(2).toString('hex')}`;
	const localDir = join(root, '.skiff', 'local');
	const runDir = join(localDir, 'runs', runId);
	const dirs = { artifacts: join(runDir, 'artifacts'), caches: join(localDir, 'caches') };
	await mkdir(dirs.artifacts, { recursive: true });
	await mkdir(dirs.caches, { recursive: true });

	let workspace = root;
	if (options.copy) {
		workspace = join(runDir, 'workspace');
		const skip = join(root, '.skiff', 'local');
		await cp(root, workspace, { recursive: true, filter: (source) => source !== skip && !source.startsWith(`${skip}/`) });
		print(`Copied ${root} to ${workspace}`);
	}

	const sha = git(root, 'rev-parse', 'HEAD') ?? ZERO_SHA;
	const branch = git(root, 'symbolic-ref', '--quiet', 'HEAD');
	const ref = branch ?? 'refs/heads/local';
	const repository = repositoryName(root);
	const event = options.event ?? 'workflow_dispatch';
	let inputs: Record<string, unknown> = { ...options.inputs };
	if (workflow.on.workflowDispatch) {
		try {
			inputs = coerceDispatchInputs(workflow, options.inputs ?? {});
		} catch (error) {
			if (error instanceof PipelineWorkflowError) throw new CliError(error.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
			throw error;
		}
	} else if (Object.keys(inputs).length) print('Warning: the workflow has no workflow_dispatch trigger; -f inputs are passed as-is.');

	const secrets = options.secrets ?? {};
	const server = new LocalJobApiServer(dirs, secrets, print);
	server.start();
	const skiff: Record<string, unknown> = {
		sha,
		ref,
		ref_name: ref.replace(/^refs\/(heads|tags)\//, ''),
		ref_type: ref.startsWith('refs/tags/') ? 'tag' : 'branch',
		base_ref: '',
		head_ref: '',
		event_name: event,
		event: {},
		repository,
		repository_id: 'local',
		repository_owner: repository.split('/')[0],
		run_id: runId,
		run_number: 1,
		run_attempt: 1,
		actor: process.env.USER ?? 'local',
		triggering_actor: process.env.USER ?? 'local',
		workflow: workflow.name,
		workflow_ref: `${repository}/${workflow.path}@${ref}`,
		workspace,
		server_url: 'http://127.0.0.1',
		api_url: `${server.url}/api/pipeline`,
		default_branch: 'main',
	};

	let order = topologicalJobOrder(workflow);
	if (options.job) {
		if (!workflow.jobs[options.job]) {
			server.stop();
			throw new CliError(`No job "${options.job}" in ${options.file} (jobs: ${order.join(', ')})`);
		}
		order = [options.job];
		if (workflow.jobs[options.job]!.needs.length) print(`Note: running only ${options.job}; its needs (${workflow.jobs[options.job]!.needs.join(', ')}) are treated as succeeded with no outputs.`);
	}

	const results: LocalJobResult[] = [];
	const needsResults: Record<string, PipelineNeedsContext> = {};
	let current: StepRunner | null = null;
	let interrupts = 0;
	const onSignal = () => {
		interrupts += 1;
		if (interrupts > 1) process.exit(130);
		print('Cancelling (Ctrl-C again to quit now)…');
		current?.cancel('cancelled');
	};
	(process as NodeJS.EventEmitter).on('SIGINT', onSignal);

	try {
		for (const key of order) {
			const spec = workflow.jobs[key]!;
			const needs: Record<string, PipelineNeedsContext> = {};
			for (const need of spec.needs) needs[need] = needsResults[need] ?? { result: 'success', outputs: {} };
			const base = { skiff, inputs, vars: options.vars ?? {}, needs };
			const finish = (conclusion: LocalJobResult['conclusion'], name = spec.name, outputs: Record<string, string> = {}) => {
				results.push({ key, name, conclusion, outputs });
				needsResults[key] = { result: conclusion === 'success' ? 'success' : conclusion === 'skipped' ? 'skipped' : conclusion === 'cancelled' ? 'cancelled' : 'failure', outputs };
			};
			if (interrupts) {
				finish('cancelled');
				continue;
			}
			if (spec.uses) {
				print(`[${key}] ✗ calls the reusable workflow ${spec.uses}, which --local does not run; run that file with --local instead.`);
				finish('failure');
				continue;
			}
			const status = { failed: Object.values(needs).some((need) => need.result === 'failure' || need.result === 'cancelled'), cancelled: false };
			const skippedNeed = Object.values(needs).some((need) => need.result === 'skipped');
			let runs: boolean;
			try {
				runs = skippedNeed && !(spec.if && containsStatusFunction(spec.if)) ? false : evaluateCondition(spec.if, base, { status });
			} catch (error) {
				print(`[${key}] ✗ if: ${(error as Error).message}`);
				finish('failure');
				continue;
			}
			if (!runs) {
				print(`[${key}] - skipped (if: ${spec.if ?? 'success()'})`);
				finish('skipped');
				continue;
			}
			let combos: Record<string, unknown>[];
			try {
				const raw = typeof spec.strategy.matrix === 'string' ? interpolateValue(spec.strategy.matrix, base) : spec.strategy.matrix;
				combos = expandMatrix((raw as Record<string, unknown> | null) ?? null);
			} catch (error) {
				print(`[${key}] ✗ strategy.matrix: ${(error as Error).message}`);
				finish('failure');
				continue;
			}
			const all: Array<Record<string, unknown> | null> = combos.length ? combos : [null];
			const selected = options.matrix && Object.keys(options.matrix).length ? all.filter((combo) => combo && matches(combo, options.matrix!)) : all;
			if (!selected.length) {
				print(`[${key}] - no matrix combination matches --matrix; skipped`);
				finish('skipped');
				continue;
			}
			if (spec.container) print(`[${key}] Note: container: ${spec.container.image} is ignored; steps run on this machine.`);
			if (Object.keys(spec.services).length) print(`[${key}] Note: services (${Object.keys(spec.services).join(', ')}) are not started by --local; start them yourself.`);
			if (spec.environment) print(`[${key}] Note: environment ${spec.environment.name}: no approval or environment secrets locally; pass --secret.`);

			let failed = false;
			let cancelled = false;
			let outputs: Record<string, string> = {};
			let lastName = spec.name;
			for (const [index, matrix] of selected.entries()) {
				const context = {
					...base,
					matrix: matrix ?? {},
					strategy: { 'fail-fast': spec.strategy.failFast, 'max-parallel': 1, 'job-index': index, 'job-total': all.length },
				};
				const name = matrix ? matrixJobName(interpolate(spec.name, context), matrix) : interpolate(spec.name, context);
				lastName = name;
				const runsOn = spec.runsOn
					.flatMap((label) => {
						const value = interpolateValue(label, context);
						return Array.isArray(value) ? value.map(String) : [String(value ?? '')];
					})
					.filter(Boolean);
				const token = `local_${randomBytes(16).toString('hex')}`;
				const label = selected.length > 1 || matrix ? name : key;
				server.jobs.set(token, { label, stepNames: new Map(), complete: null });
				const resolved: PipelineJobSpec = { ...spec, name, runsOn };
				const claim: PipelineJobClaim = {
					kind: 'job',
					jobId: `local_${key}_${index}`,
					runId,
					runNumber: 1,
					attempt: 1,
					token,
					repository: { id: 'local', name: repository, cloneUrl: '' },
					checkout: { ref, sha },
					workflow: { name: workflow.name, path: workflow.path },
					job: resolved,
					workflowEnv: workflow.env,
					workflowDefaults: workflow.defaults,
					context: { ...context, skiff: { ...skiff, job: key } },
					secretNames: Object.keys(secrets),
					trust: 'trusted',
					image: '',
					limits: { memoryMb: 0, cpus: 0, timeoutMinutes: spec.timeoutMinutes },
					registry: null,
				};
				const jobDir = join(runDir, `${key}-${index}`);
				print(`[${label}] Job ${name} (runs-on: ${runsOn.join(', ') || '-'})`);
				const runner = new StepRunner({
					claim,
					api: new JobApi(server.url, token),
					paths: { workspace, temp: join(jobDir, 'tmp'), home: homedir(), toolCache: join(localDir, 'tool-cache') },
					runnerName: 'local',
					baseEnv: process.env,
					diagnostics: (message) => print(`[${label}] (runner) ${message}`),
					logFlushMs: options.logFlushMs ?? 200,
				});
				current = runner;
				const { complete } = await runner.run();
				current = null;
				await rm(join(jobDir, 'tmp'), { recursive: true, force: true });
				print(`[${label}] Job ${complete.conclusion}`);
				outputs = { ...outputs, ...complete.outputs };
				if (complete.conclusion === 'cancelled') cancelled = true;
				else if (complete.conclusion !== 'success') failed = true;
				if ((failed && spec.strategy.failFast) || cancelled) break;
			}
			const continueOnError = spec.continueOnError === true;
			finish(cancelled ? 'cancelled' : failed && !continueOnError ? 'failure' : 'success', selected.length > 1 ? spec.name : lastName, outputs);
		}
	} finally {
		(process as NodeJS.EventEmitter).removeListener('SIGINT', onSignal);
		server.stop();
		if (options.copy) await rm(join(runDir, 'workspace'), { recursive: true, force: true });
	}
	const ok = results.every((job) => job.conclusion === 'success' || job.conclusion === 'skipped');
	print(`Run ${runId}: ${ok ? 'success' : 'failure'} — ${results.map((job) => `${job.key} ${job.conclusion}`).join(', ')}`);
	print(`Artifacts and caches: ${relative(root, localDir) || localDir}`);
	return { ok, runId, jobs: results };
}
