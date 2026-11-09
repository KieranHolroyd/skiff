import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	PipelinesApi,
	defaultLogJob,
	formatLogLine,
	parseInputs,
	runDetails,
	runExitCode,
	runTable,
	runTransitions,
	selectJob,
	statusFilter,
	workflowPath,
	type PipelineJobView,
	type PipelineStepView,
	type PipelineTriggerView,
	type RunView,
} from './pipelines.ts';
import { parsePairs, printJobLogs, waitForTrigger, watchRun } from './commands/pipelines.ts';
import { importGithubWorkflow, lintDocument, toYaml } from './pipelines.ts';
import { runLocalWorkflow } from './pipelines-local.ts';

/** `yoal repo|run|workflow|secret|var` (docs/PIPELINES.md §8) against a fake control plane. */

let dir = '';
let server: ReturnType<typeof Bun.serve> | undefined;

interface Seen {
	method: string;
	path: string;
	body: unknown;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'yoal-cli-pipelines-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

const T0 = '2026-11-08T10:00:00.000Z';
const T1 = '2026-11-08T10:01:05.000Z';

function step(index: number, name: string, overrides: Partial<PipelineStepView> = {}): PipelineStepView {
	return { index, name, status: 'completed', conclusion: 'success', startedAt: T0, finishedAt: T1, ...overrides };
}

function job(overrides: Partial<PipelineJobView> = {}): PipelineJobView {
	return {
		id: 'pj_build',
		key: 'build',
		name: 'build',
		matrix: null,
		needs: [],
		runsOn: ['linux'],
		status: 'completed',
		conclusion: 'success',
		environment: null,
		nodeId: 'node_1',
		nodeName: 'builder-1',
		attempt: 1,
		error: null,
		outputs: {},
		steps: [step(0, 'Checkout'), step(1, 'Install')],
		createdAt: T0,
		startedAt: T0,
		finishedAt: T1,
		...overrides,
	};
}

function runView(overrides: Partial<RunView> = {}): RunView {
	return {
		id: 'pr_1',
		repository: 'shop',
		number: 42,
		workflowName: 'CI',
		workflowPath: '.yoal/workflows/ci.yml',
		event: 'push',
		ref: 'refs/heads/main',
		sha: 'abcdef1234567890',
		title: 'Fix the cart',
		actor: 'kieran',
		trust: 'trusted',
		status: 'completed',
		conclusion: 'failure',
		attempt: 1,
		createdAt: T0,
		startedAt: T0,
		finishedAt: T1,
		inputs: {},
		jobs: [
			job(),
			job({
				id: 'pj_test',
				key: 'test',
				name: 'test',
				needs: ['build'],
				conclusion: 'failure',
				steps: [step(0, 'Checkout'), step(1, 'Run tests', { conclusion: 'failure' }), step(2, 'Upload', { conclusion: 'skipped' })],
			}),
		],
		artifacts: [{ id: 'pa_1', runId: 'pr_1', jobId: 'pj_build', name: 'dist', size: 2048, sha256: 'a'.repeat(64), createdAt: T0, expiresAt: T1 }],
		...overrides,
	};
}

type Route = unknown | ((seen: Seen) => unknown);

function serve(routes: Record<string, Route>): Seen[] {
	const seen: Seen[] = [];
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const text = await request.text();
			const entry: Seen = { method: request.method, path: `${url.pathname}${url.search}`, body: text ? JSON.parse(text) : undefined };
			seen.push(entry);
			const route = routes[`${request.method} ${url.pathname}`];
			if (route === undefined) return Response.json({ error: 'not_found', message: 'no route' }, { status: 404 });
			const value = typeof route === 'function' ? (route as (seen: Seen) => unknown)(entry) : route;
			return value instanceof Response ? value : Response.json(value);
		},
	});
	return seen;
}

async function cli(args: string[], stdin?: string) {
	const child = Bun.spawn([process.execPath, 'src/main.ts', ...args], {
		cwd: join(import.meta.dir, '..'),
		env: {
			...process.env,
			YOAL_CONFIG_DIR: dir,
			YOAL_URL: `http://127.0.0.1:${server?.port ?? 1}`,
			YOAL_TOKEN: 'yoal_test',
			YOAL_CONTENT_DOMAIN: '',
			YOAL_PROFILE: '',
		},
		stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const code = await child.exited;
	return { code, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

const noSleep = { sleep: async () => {}, print: () => {} };

/** A fake `ApiClient.raw` that answers from a list of handlers, for the polling helpers. */
function fakeApi(handler: (method: string, path: string) => unknown): PipelinesApi {
	return new PipelinesApi({
		baseUrl: 'https://control.test',
		raw: async (method: string, path: string) => Response.json(handler(method, path)),
	} as never);
}

describe('helpers', () => {
	test('inputs, workflow paths and status filters', () => {
		expect(parseInputs(['env=staging', 'note=a=b', 'empty='])).toEqual({ env: 'staging', note: 'a=b', empty: '' });
		expect(() => parseInputs(['nokey'])).toThrow(/key=value/);
		expect(() => parseInputs(['=x'])).toThrow(/key=value/);
		expect(workflowPath('ci.yml')).toBe('.yoal/workflows/ci.yml');
		expect(workflowPath('./.yoal/workflows/ci.yml')).toBe('.yoal/workflows/ci.yml');
		expect(statusFilter('in_progress')).toEqual({ status: 'in_progress' });
		expect(statusFilter('failure')).toEqual({ status: 'completed', conclusion: 'failure' });
		expect(statusFilter('failed')).toEqual({ status: 'completed', conclusion: 'failure' });
		expect(statusFilter(undefined)).toEqual({});
		expect(() => statusFilter('broken')).toThrow(/--status/);
	});

	test('job selection: default is the first failed job, --job by id, key or name', () => {
		const run = runView();
		expect(defaultLogJob(run)?.key).toBe('test');
		expect(defaultLogJob(runView({ conclusion: 'success', jobs: [job(), job({ id: 'pj_last', key: 'last' })] }))?.id).toBe('pj_last');
		expect(selectJob(run, 'build').id).toBe('pj_build');
		expect(selectJob(run, 'pj_test').key).toBe('test');
		expect(() => selectJob(run, 'deploy')).toThrow(/no job "deploy"/);
		const matrix = runView({
			jobs: [job({ id: 'pj_a', name: 'test (18)', key: 'test' }), job({ id: 'pj_b', name: 'test (20)', key: 'test', conclusion: 'success' })],
		});
		expect(() => selectJob(matrix, 'test')).toThrow(/matches 2 jobs/);
		const oneFailed = runView({ jobs: [job({ id: 'pj_a', key: 'test' }), job({ id: 'pj_b', key: 'test', conclusion: 'failure' })] });
		expect(selectJob(oneFailed, 'test').id).toBe('pj_b');
		expect(() => selectJob(runView({ jobs: [] }), undefined)).toThrow(/no jobs/);
	});

	test('exit codes', () => {
		expect(runExitCode({ conclusion: 'success' })).toBe(0);
		expect(runExitCode({ conclusion: 'failure' })).toBe(1);
		expect(runExitCode({ conclusion: 'cancelled' })).toBe(1);
	});

	test('run view marks the failing step and lists artifacts', () => {
		const text = runDetails(runView(), Date.parse(T1)).join('\n');
		expect(text).toContain('Run #42 CI  ✗ failure');
		expect(text).toContain('push on main @ abcdef1 by kieran');
		expect(text).toContain('>> ✗ 2. Run tests');
		expect(text).not.toContain('>> ✓');
		expect(text).toMatch(/dist\s+2\.0 KiB/);
		expect(text).toContain('yoal run logs shop 42 --job pj_test');
	});

	test('run table', () => {
		const table = runTable([runView()], Date.parse(T1));
		expect(table.split('\n')[0]).toMatch(/^RUN\s+STATUS\s+WORKFLOW/);
		expect(table).toContain('#42');
		expect(table).toContain('1m05s');
	});

	test('log lines carry the 1-based step number and name', () => {
		const test = runView().jobs[1]!;
		expect(formatLogLine(test, { seq: 1, jobId: 'pj_test', step: 1, stream: 'stdout', text: 'FAIL cart', ts: 0 })).toBe('[2 Run tests] FAIL cart');
		expect(formatLogLine(test, { seq: 2, jobId: 'pj_test', step: -1, stream: 'system', text: 'cleaning up', ts: 0 })).toBe('[setup] cleaning up');
		expect(formatLogLine(test, { seq: 3, jobId: 'pj_test', step: 9, stream: 'stdout', text: 'x', ts: 0 })).toBe('[10 Step 10] x');
	});

	test('transitions between polls', () => {
		const queued = runView({
			status: 'in_progress',
			conclusion: null,
			finishedAt: null,
			jobs: [job({ status: 'queued', conclusion: null, nodeName: null, steps: [] }), job({ id: 'pj_test', key: 'test', name: 'test', status: 'pending', conclusion: null, steps: [] })],
		});
		expect(runTransitions(null, queued)).toEqual(['○ build: queued']);
		const running = runView({
			status: 'in_progress',
			conclusion: null,
			finishedAt: null,
			jobs: [
				job({ status: 'in_progress', conclusion: null, steps: [step(0, 'Checkout'), step(1, 'Install', { status: 'in_progress', conclusion: null })] }),
				queued.jobs[1]!,
			],
		});
		expect(runTransitions(queued, running)).toEqual(['● build: in progress on builder-1', '  ✓ build › 1. Checkout: success', '  ● build › 2. Install']);
		const done = runView();
		const lines = runTransitions(running, done);
		expect(lines).toContain('✓ build: success');
		expect(lines).toContain('  ✗ test › 2. Run tests: failure');
		expect(lines.at(-1)).toMatch(/^Run #42 failure in 1m05s$/);
	});
});

describe('polling', () => {
	test('watchRun polls until the run completes', async () => {
		let polls = 0;
		const printed: string[] = [];
		const api = fakeApi(() => {
			polls++;
			return { run: polls < 3 ? runView({ status: 'in_progress', conclusion: null, jobs: [] }) : runView() };
		});
		const run = await watchRun(api, 'shop', '42', { sleep: async () => {}, print: (line) => printed.push(line) });
		expect(polls).toBe(3);
		expect(run.conclusion).toBe('failure');
		expect(printed[0]).toBe('Run #42 CI (Fix the cart): in progress');
		expect(printed.at(-1)).toMatch(/Run #42 failure/);
	});

	test('waitForTrigger waits for run ids, and fails clearly', async () => {
		const resolving: PipelineTriggerView = { id: 'pt_1', event: 'workflow_dispatch', ref: 'refs/heads/main', status: 'resolving', error: null, runIds: [], createdAt: T0 };
		let polls = 0;
		const api = fakeApi(() => ({ trigger: ++polls < 2 ? resolving : { ...resolving, status: 'resolved', runIds: ['pr_9'] } }));
		expect((await waitForTrigger(api, 'shop', resolving, noSleep)).runIds).toEqual(['pr_9']);
		const failing = fakeApi(() => ({ trigger: { ...resolving, status: 'failed', error: 'ci.yml: no such file' } }));
		expect(waitForTrigger(failing, 'shop', resolving, noSleep)).rejects.toThrow(/did not start: ci.yml: no such file/);
		expect(waitForTrigger(failing, 'shop', { ...resolving, status: 'resolved' }, noSleep)).rejects.toThrow(/No run started/);
	});

	test('printJobLogs follows the after= cursor until the job completes', async () => {
		const seen: string[] = [];
		const printed: string[] = [];
		let page = 0;
		const api = fakeApi((_method, path) => {
			seen.push(path);
			if (path.includes('/logs')) {
				page++;
				if (page === 1) return { lines: [{ seq: 5, jobId: 'pj_test', step: 0, stream: 'stdout', text: 'cloned', ts: 0 }], next: 5, complete: false };
				return { lines: [{ seq: 6, jobId: 'pj_test', step: 1, stream: 'stderr', text: 'FAIL', ts: 0 }], next: 6, complete: true };
			}
			return { run: runView() };
		});
		const test = runView().jobs[1]!;
		const done = await printJobLogs(api, 'shop', 'pr_1', { ...test, status: 'in_progress', conclusion: null }, { follow: true }, { sleep: async () => {}, print: (line) => printed.push(line) });
		expect(printed).toEqual(['[1 Checkout] cloned', '[2 Run tests] FAIL']);
		expect(seen.filter((path) => path.includes('/logs'))).toEqual([
			'/api/v1/repositories/shop/runs/pr_1/jobs/pj_test/logs?after=0&limit=1000',
			'/api/v1/repositories/shop/runs/pr_1/jobs/pj_test/logs?after=5&limit=1000',
		]);
		expect(done.conclusion).toBe('failure');
	});
});

describe('yoal CLI', () => {
	test('repo list, add and remove', async () => {
		const repository = {
			id: 'prp_1',
			name: 'shop',
			cloneUrl: 'https://github.com/acme/shop.git',
			provider: 'github',
			defaultBranch: 'main',
			defaultImage: null,
			enabled: true,
			hasWebhookSecret: true,
			webhookPath: '/api/webhooks/pipelines/prp_1',
			lastRun: null,
			createdAt: T0,
			updatedAt: T0,
		};
		const seen = serve({
			'GET /api/v1/repositories': { repositories: [repository] },
			'POST /api/v1/repositories': Response.json({ repository }, { status: 201 }),
			'DELETE /api/v1/repositories/shop': { ok: true },
		});
		const list = await cli(['repo', 'list']);
		expect(list.code).toBe(0);
		expect(list.stdout).toContain('https://github.com/acme/shop.git');

		const add = await cli(['repo', 'add', 'shop', '--url', 'https://github.com/acme/shop.git', '--branch', 'trunk', '--webhook-secret', 'x'.repeat(20)]);
		expect(add.code).toBe(0);
		expect(seen.at(-1)?.body).toEqual({ name: 'shop', cloneUrl: 'https://github.com/acme/shop.git', defaultBranch: 'trunk', webhookSecret: 'x'.repeat(20) });
		expect(add.stdout).toContain(`http://127.0.0.1:${server!.port}/api/webhooks/pipelines/prp_1`);

		const short = await cli(['repo', 'add', 'shop', '--url', 'https://x/y.git', '--webhook-secret', 'short']);
		expect(short.code).toBe(1);
		expect(short.stderr).toContain('at least 16');

		const refused = await cli(['repo', 'remove', 'shop']);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain('--yes');
		expect((await cli(['repo', 'remove', 'shop', '--yes'])).code).toBe(0);
		expect(seen.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/v1/repositories/shop' });
	});

	test('run list sends filters and filters conclusions locally', async () => {
		const seen = serve({
			'GET /api/v1/repositories/shop/runs': { runs: [runView(), runView({ id: 'pr_2', number: 41, conclusion: 'success' })] },
		});
		const result = await cli(['run', 'list', 'shop', '--status', 'failure', '--workflow', 'ci.yml', '-n', '5']);
		expect(result.code).toBe(0);
		expect(seen[0]?.path).toBe('/api/v1/repositories/shop/runs?status=completed&workflow=.yoal%2Fworkflows%2Fci.yml&limit=100');
		expect(result.stdout).toContain('#42');
		expect(result.stdout).not.toContain('#41');
		const json = await cli(['run', 'list', 'shop', '--json']);
		expect(JSON.parse(json.stdout).runs).toHaveLength(2);
	});

	test('run view, logs, cancel and rerun', async () => {
		const seen = serve({
			'GET /api/v1/repositories/shop/runs/42': { run: runView() },
			'GET /api/v1/repositories/shop/runs/pr_1/jobs/pj_test/logs': { lines: [{ seq: 1, jobId: 'pj_test', step: 1, stream: 'stdout', text: 'expected 2, got 3', ts: 0 }], next: 1, complete: true },
			'POST /api/v1/repositories/shop/runs/42/cancel': { run: runView({ status: 'in_progress', conclusion: null }) },
			'POST /api/v1/repositories/shop/runs/42/rerun': { run: runView({ attempt: 2, status: 'queued', conclusion: null }) },
		});
		const view = await cli(['run', 'view', 'shop', '#42']);
		expect(view.code).toBe(0);
		expect(view.stdout).toContain('>> ✗ 2. Run tests');

		const logs = await cli(['run', 'logs', 'shop', '42']);
		expect(logs.code).toBe(0);
		expect(logs.stdout).toBe('[2 Run tests] expected 2, got 3\n');

		expect((await cli(['run', 'cancel', 'shop', '42'])).stdout).toContain('Cancelling run #42');
		const rerun = await cli(['run', 'rerun', 'shop', '42', '--failed']);
		expect(rerun.stdout).toContain('attempt 2');
		expect(seen.at(-1)?.body).toEqual({ failedOnly: true });
	});

	test('run watch exits 1 when the run fails', async () => {
		serve({ 'GET /api/v1/repositories/shop/runs/42': { run: runView() }, 'GET /api/v1/repositories/shop/runs/pr_1': { run: runView() } });
		const result = await cli(['run', 'watch', 'shop', '42']);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('Run #42 failure');
		expect(result.stderr).toContain('yoal run logs shop 42 --job pj_test');
	});

	test('yoal run <project> -- <command> is still a one-off job run', async () => {
		const seen = serve({
			'POST /api/v1/projects/list/jobs/runs': Response.json({ error: 'not_found', message: 'Project not found' }, { status: 404 }),
		});
		const result = await cli(['run', 'list', '--', 'echo', 'hi']);
		expect(result.code).toBe(1);
		expect(seen[0]?.path).toStartWith('/api/v1/projects/list/');
	});

	test('workflow dispatch sends inputs; workflow run sends the file text', async () => {
		const trigger = { id: 'pt_1', event: 'workflow_dispatch', ref: 'refs/heads/main', status: 'resolving', error: null, runIds: [], createdAt: T0 };
		const seen = serve({ 'POST /api/v1/repositories/shop/runs': () => Response.json({ trigger }, { status: 202 }) });
		const dispatched = await cli(['workflow', 'dispatch', 'shop', 'deploy.yml', '--ref', 'v1.2', '-f', 'env=staging', '-f', 'dry=true']);
		expect(dispatched.code).toBe(0);
		expect(dispatched.stdout.trim()).toBe('pt_1');
		expect(seen[0]?.body).toEqual({ workflow: 'deploy.yml', ref: 'v1.2', inputs: { env: 'staging', dry: 'true' } });

		const file = join(dir, 'ci.yml');
		await writeFile(file, 'name: CI\non: workflow_dispatch\njobs: {}\n');
		const ran = await cli(['workflow', 'run', 'shop', '--file', file]);
		expect(ran.code).toBe(0);
		expect(seen[1]?.body).toEqual({ workflowText: 'name: CI\non: workflow_dispatch\njobs: {}\n', inputs: {} });
	});

	test('workflow dispatch --watch fails when the trigger fails', async () => {
		const trigger = { id: 'pt_1', event: 'workflow_dispatch', ref: 'refs/heads/main', status: 'failed', error: 'deploy.yml: not found at main', runIds: [], createdAt: T0 };
		serve({ 'POST /api/v1/repositories/shop/runs': Response.json({ trigger }, { status: 202 }) });
		const result = await cli(['workflow', 'dispatch', 'shop', 'deploy.yml', '--watch']);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('deploy.yml: not found at main');
	});

	test('workflow lint reports issues with paths', async () => {
		const good = join(dir, 'good.yml');
		await writeFile(good, 'name: CI\non: push\njobs:\n  test:\n    runs-on: linux\n    steps:\n      - run: bun test\n');
		const ok = await cli(['workflow', 'lint', good]);
		expect(ok.code).toBe(0);
		expect(ok.stdout).toContain('ok — "CI", 1 job (test)');

		const bad = join(dir, 'bad.yml');
		await writeFile(bad, 'on: push\njobs:\n  test:\n    runs-on: linux\n    needs: [nope]\n    steps:\n      - frob: 1\n');
		const failed = await cli(['workflow', 'lint', bad]);
		expect(failed.code).toBe(1);
		expect(failed.stderr).toContain(`${bad}: jobs.test.needs:`);
		expect(failed.stderr).toContain(`${bad}: jobs.test.steps[0].frob:`);

		const broken = join(dir, 'broken.yml');
		await writeFile(broken, 'jobs: [\n');
		expect((await cli(['workflow', 'lint', broken])).stderr).toContain('YAML:');
	});

	test('secrets: value from stdin, never printed; variables', async () => {
		const seen = serve({
			'PUT /api/v1/repositories/shop/secrets/NPM_TOKEN': { secret: { name: 'NPM_TOKEN', environment: 'production', updatedAt: T0 } },
			'GET /api/v1/repositories/shop/secrets': { secrets: [{ name: 'NPM_TOKEN', environment: null, updatedAt: T0 }] },
			'DELETE /api/v1/repositories/shop/secrets/NPM_TOKEN': { ok: true },
			'PUT /api/v1/repositories/shop/variables/REGION': { variable: { name: 'REGION', value: 'eu', updatedAt: T0 } },
			'GET /api/v1/repositories/shop/variables': { variables: [{ name: 'REGION', value: 'eu', updatedAt: T0 }] },
		});
		const set = await cli(['secret', 'set', 'shop', 'NPM_TOKEN', '--env', 'production'], 's3cr3t-value\n');
		expect(set.code).toBe(0);
		expect(seen[0]?.body).toEqual({ value: 's3cr3t-value', environment: 'production' });
		expect(set.stdout + set.stderr).not.toContain('s3cr3t');
		expect((await cli(['secret', 'list', 'shop'])).stdout).toContain('NPM_TOKEN');
		await cli(['secret', 'rm', 'shop', 'NPM_TOKEN', '--env', 'production']);
		expect(seen.at(-1)?.path).toBe('/api/v1/repositories/shop/secrets/NPM_TOKEN?environment=production');
		expect((await cli(['secret', 'set', 'shop', 'GITHUB_TOKEN', '--value', 'x'])).stderr).toContain('reserved');

		expect((await cli(['var', 'set', 'shop', 'REGION', 'eu'])).code).toBe(0);
		expect(seen.at(-1)?.body).toEqual({ value: 'eu' });
		expect((await cli(['var', 'list', 'shop'])).stdout).toMatch(/REGION\s+eu/);
	});
});

describe('yoal workflow lint --import', () => {
	const github = {
		name: 'CI',
		on: { push: { branches: ['main'] }, release: { types: ['published'] }, workflow_dispatch: null },
		permissions: { contents: 'write' },
		jobs: {
			build: {
				'runs-on': '${{ matrix.runner }}',
				permissions: { packages: 'write' },
				strategy: { matrix: { include: [{ arch: 'amd64', runner: 'ubuntu-24.04' }, { arch: 'arm64', runner: 'ubuntu-24.04-arm' }] } },
				steps: [
					{ uses: 'actions/checkout@v4' },
					{ uses: 'docker/build-push-action@v6', with: { push: true } },
					{ uses: 'docker://alpine:3' , with: { args: 'echo hi' } },
					{ uses: 'oven-sh/setup-bun@v2' },
					{ name: 'Multi', env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }, run: 'echo one\necho "two: ${{ matrix.arch }}"\n' },
				],
			},
			mac: { 'runs-on': 'macos-14', steps: [{ run: 'echo mac', shell: 'pwsh' }] },
		},
	};

	test('rewrites runs-on, drops permissions and lists what does not carry over', () => {
		const { workflow, notes } = importGithubWorkflow(github);
		const jobs = workflow.jobs as Record<string, any>;
		expect(workflow.permissions).toBeUndefined();
		expect(workflow.on).toEqual({ push: { branches: ['main'] }, workflow_dispatch: null });
		expect(jobs.build['runs-on']).toEqual(['linux', '${{ matrix.runner }}']);
		expect(jobs.build.strategy.matrix.include.map((entry: any) => entry.runner)).toEqual(['x64', 'arm64']);
		expect(jobs.build.permissions).toBeUndefined();
		expect(jobs.build.steps[4].env.GH_TOKEN).toBe('${{ secrets.GH_TOKEN }}');
		const byPath = (path: string) => notes.filter((entry) => entry.path === path).map((entry) => entry.kind);
		expect(byPath('on.release')).toEqual(['unsupported']);
		expect(byPath('jobs.build.steps[1].uses')).toEqual(['unsupported']);
		expect(byPath('jobs.build.steps[2].uses')).toEqual(['unsupported']);
		expect(byPath('jobs.build.steps[3].uses')).toEqual(['note']);
		expect(byPath('jobs.mac.runs-on')).toEqual(['unsupported']);
		expect(byPath('jobs.mac.steps[0].shell')).toEqual(['unsupported']);
		expect(byPath('jobs.build.strategy.matrix')).toEqual(['changed']);
	});

	test('the YAML emitter round-trips through Bun.YAML and the real parser', async () => {
		const { workflow } = importGithubWorkflow({ ...github, jobs: { build: github.jobs.build } });
		const text = toYaml(workflow);
		expect(text).toContain('run: |\n');
		const reparsed = Bun.YAML.parse(text) as Record<string, any>;
		expect(reparsed).toEqual(JSON.parse(JSON.stringify(workflow)));
		const tricky = { a: 'yes', b: '1.0', c: 'x: y', d: "it's", e: '', f: ' lead', g: '#hash', h: [], i: {}, j: 'line\n  indented\n', k: '${{ a }}-b' };
		expect(Bun.YAML.parse(toYaml(tricky))).toEqual(tricky);
		// Docker actions still fail the parser, so the import reports them twice: as a note and an issue.
		const result = await lintDocument(reparsed, '.yoal/workflows/ci.yml');
		expect(result.ok).toBe(false);
		expect(result.issues.some((issue) => issue.path.includes('steps[2]'))).toBe(true);
	});

	test('parsePairs reads bare secret names from the environment', () => {
		expect(parsePairs(['A=1', 'B'], 'secret', true, { B: 'from-env' })).toEqual({ A: '1', B: 'from-env' });
		expect(() => parsePairs(['B'], 'secret', true, {})).toThrow(/not set/);
		expect(() => parsePairs(['B'], 'var')).toThrow(/NAME=VALUE/);
	});
});

describe('yoal workflow run --local', () => {
	test('runs jobs in order with matrix, needs outputs, masking, artifacts and caches under .yoal/local', async () => {
		const repo = await mkdtemp(join(tmpdir(), 'yoal-local-run-'));
		try {
			await Bun.write(join(repo, 'input.txt'), 'hello from the workspace\n');
			await Bun.write(
				join(repo, '.yoal/workflows/ci.yml'),
				`name: ci
on:
  workflow_dispatch:
    inputs:
      greeting: { type: string, default: hi }
jobs:
  build:
    runs-on: [linux, '\${{ matrix.arch }}']
    strategy: { matrix: { arch: [x64, arm64] } }
    outputs:
      word: \${{ steps.w.outputs.word }}
    steps:
      - id: w
        run: |
          echo "word=\${{ inputs.greeting }}-\${{ matrix.arch }}" >> "$YOAL_OUTPUT"
          echo "token is $TOKEN"
        env: { TOKEN: '\${{ secrets.TOKEN }}' }
      - run: mkdir -p out && cp input.txt out/\${{ matrix.arch }}.txt
      - uses: actions/upload-artifact@v4
        with: { name: 'out-\${{ matrix.arch }}', path: 'out/\${{ matrix.arch }}.txt' }
      - uses: actions/cache@v4
        with: { path: out, key: 'out-\${{ matrix.arch }}' }
  use:
    needs: build
    runs-on: linux
    steps:
      - uses: actions/download-artifact@v4
        with: { name: out-arm64, path: got }
      - run: |
          echo "need=\${{ needs.build.outputs.word }}"
          cat got/arm64.txt
  never:
    needs: use
    if: failure()
    runs-on: linux
    steps:
      - run: echo should-not-run
`,
			);
			const lines: string[] = [];
			const result = await runLocalWorkflow({
				file: '.yoal/workflows/ci.yml',
				cwd: repo,
				inputs: { greeting: 'hey' },
				secrets: { TOKEN: 'local-secret-value' },
				print: (line) => lines.push(line),
				logFlushMs: 20,
			});
			const output = lines.join('\n');
			expect(result.jobs.map((job) => [job.key, job.conclusion])).toEqual([
				['build', 'success'],
				['use', 'success'],
				['never', 'skipped'],
			]);
			expect(result.ok).toBe(true);
			expect(output).toContain('token is ***');
			expect(output).not.toContain('local-secret-value');
			expect(output).toContain('need=hey-arm64');
			expect(output).toContain('hello from the workspace');
			expect(output).toContain('▶ Run actions/upload-artifact@v4');
			const index = JSON.parse(await Bun.file(join(repo, '.yoal/local/caches/index.json')).text()) as Array<{ key: string }>;
			expect(index.map((entry) => entry.key).sort()).toEqual(['out-arm64', 'out-x64']);

			// -j runs one job; the cache saved above is restored.
			const again: string[] = [];
			const single = await runLocalWorkflow({ file: '.yoal/workflows/ci.yml', cwd: repo, job: 'build', matrix: { arch: 'x64' }, print: (line) => again.push(line), logFlushMs: 20 });
			expect(single.jobs).toHaveLength(1);
			expect(again.join('\n')).toContain('Cache restored from key: out-x64');
			expect(again.join('\n')).not.toContain('arm64.txt');
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	}, 30_000);
});
