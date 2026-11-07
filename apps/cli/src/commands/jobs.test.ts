import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatCommand, parseDuration, runExitCode, splitCommand, type JobRunView } from '../jobs.ts';

/** `skif jobs` and `skif run` against a fake control plane (plan 09). */

let dir = '';
let server: ReturnType<typeof Bun.serve> | undefined;

interface Seen {
	method: string;
	path: string;
	body: unknown;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-jobs-'));
});

afterEach(async () => {
	server?.stop(true);
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

const RUN = `jr_${'c'.repeat(32)}`;

function runView(overrides: Partial<JobRunView> = {}): JobRunView {
	return {
		id: RUN,
		jobId: null,
		jobName: null,
		trigger: 'manual',
		attempt: 1,
		status: 'queued',
		command: ['bun', 'run', 'migrate'],
		timeoutSeconds: 600,
		deploymentId: 'dep_1',
		nodeId: 'node_1',
		exitCode: null,
		error: null,
		createdBy: 'user_1',
		createdAt: '2026-11-07T10:00:00.000Z',
		runAt: '2026-11-07T10:00:00.000Z',
		startedAt: null,
		finishedAt: null,
		durationMs: null,
		cancelRequested: false,
		...overrides,
	};
}

type Route = unknown | ((seen: Seen) => unknown);

/** `routes` maps `METHOD /path` (query ignored) to a JSON body, a Response or a function of the request. */
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

async function cli(...args: string[]) {
	const child = Bun.spawn([process.execPath, 'src/main.ts', ...args], {
		cwd: join(import.meta.dir, '../..'),
		env: {
			...process.env,
			SKIFF_CONFIG_DIR: dir,
			SKIFF_URL: `http://127.0.0.1:${server!.port}`,
			SKIFF_TOKEN: 'skif_test',
			SKIFF_CONTENT_DOMAIN: '',
			SKIFF_PROFILE: '',
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const code = await child.exited;
	return { code, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

describe('helpers', () => {
	test('the command is everything after --, exactly as the shell split it', () => {
		expect(splitCommand(['shop', '-t', '5m', '--', 'bun', '-e', 'console.log("a b")', '--', 'x'])).toEqual({
			before: ['shop', '-t', '5m'],
			command: ['bun', '-e', 'console.log("a b")', '--', 'x'],
		});
		expect(splitCommand(['shop']).command).toBeNull();
		expect(formatCommand(['bun', 'tidy.ts', '--older than', "it's"])).toBe(`bun tidy.ts '--older than' 'it'\\''s'`);
	});

	test('durations and exit codes', () => {
		expect(parseDuration('90', '--timeout')).toBe(90);
		expect(parseDuration('15m', '--timeout')).toBe(900);
		expect(parseDuration('2h', '--timeout')).toBe(7200);
		expect(() => parseDuration('soon', '--timeout')).toThrow(/duration/);
		expect(runExitCode(runView({ status: 'succeeded', exitCode: 0 }))).toBe(0);
		expect(runExitCode(runView({ status: 'failed', exitCode: 3 }))).toBe(3);
		expect(runExitCode(runView({ status: 'timeout' }))).toBe(124);
		expect(runExitCode(runView({ status: 'cancelled' }))).toBe(130);
		expect(runExitCode(runView({ status: 'failed', exitCode: null }))).toBe(1);
	});
});

describe('skif run', () => {
	test('posts the argv, streams output to stdout/stderr and exits with the command’s status', async () => {
		let polls = 0;
		const routes = {
			'POST /api/v1/projects/shop/jobs/runs': { run: runView() },
			[`GET /api/v1/projects/shop/jobs/runs/${RUN}`]: () => {
				polls += 1;
				return { run: runView(polls < 2 ? { status: 'running' } : { status: 'failed', exitCode: 3, durationMs: 1200, error: 'Exited with status 3.' }) };
			},
			[`GET /api/v1/projects/shop/jobs/runs/${RUN}/logs`]: (request: Seen) =>
				request.path.includes('after=')
					? polls >= 2 && request.path.includes('after=1')
						? { events: [{ seq: 2, ts: 2, stream: 'stderr', level: 'error', message: 'boom' }], cursor: 2, hasMore: false }
						: { events: [], cursor: Number(new URL(`http://x${request.path}`).searchParams.get('after')), hasMore: false }
					: { events: [{ seq: 1, ts: 1, stream: 'stdout', level: 'info', message: 'migrating 3 tables' }], cursor: 1, hasMore: false },
		};
		const requests = serve(routes);
		const result = await cli('run', 'shop', '--timeout', '15m', '--', 'bun', 'run', 'migrate', '--name', 'a b');
		expect(requests[0]).toEqual({
			method: 'POST',
			path: '/api/v1/projects/shop/jobs/runs',
			body: { command: ['bun', 'run', 'migrate', '--name', 'a b'], timeoutSeconds: 900 },
		});
		expect(result.stdout).toBe('migrating 3 tables\n');
		expect(result.stderr).toContain('boom');
		expect(result.stderr).toContain(`Run ${RUN} failed (exit 3) in 1.2s: Exited with status 3.`);
		expect(result.code).toBe(3);
	});

	test('--detach prints the run id; a missing command is a usage error that sends nothing', async () => {
		const seen = serve({ 'POST /api/v1/projects/shop/jobs/runs': { run: runView() } });
		const detached = await cli('run', 'shop', '-d', '--', 'bun', 'x.ts');
		expect(detached.code).toBe(0);
		expect(detached.stdout.trim()).toBe(RUN);
		const missing = await cli('run', 'shop');
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain('Give the command after --');
		expect(seen).toHaveLength(1);
	});
});

describe('skif jobs', () => {
	const job = {
		id: 'job_1',
		projectSlug: 'shop',
		name: 'tidy',
		command: ['bun', 'tidy.ts', '--days', '30'],
		schedule: '0 3 * * *',
		timeoutSeconds: 900,
		concurrency: 'forbid',
		maxRetries: 2,
		enabled: true,
		nextRunAt: '2026-11-08T03:00:00.000Z',
		lastRun: null,
		createdAt: '2026-11-07T10:00:00.000Z',
		updatedAt: '2026-11-07T10:00:00.000Z',
	};

	test('create sends the definition; update can drop the schedule; list prints a table', async () => {
		const seen = serve({
			'POST /api/v1/projects/shop/jobs': { job },
			'PATCH /api/v1/projects/shop/jobs/tidy': { job: { ...job, schedule: null, nextRunAt: null } },
			'GET /api/v1/projects/shop/jobs': { jobs: [job, { ...job, name: 'reindex', schedule: null, enabled: false, nextRunAt: null }] },
		});
		const created = await cli('jobs', 'create', 'shop', 'tidy', '--schedule', '0 3 * * *', '--timeout', '15m', '--retries', '2', '--', 'bun', 'tidy.ts', '--days', '30');
		expect(created.code).toBe(0);
		expect(seen[0]?.body).toEqual({ name: 'tidy', command: ['bun', 'tidy.ts', '--days', '30'], schedule: '0 3 * * *', timeoutSeconds: 900, maxRetries: 2 });
		expect(created.stdout).toContain('Created job tidy on shop.');

		const updated = await cli('jobs', 'update', 'shop', 'tidy', '--no-schedule');
		expect(updated.code).toBe(0);
		expect(seen[1]?.body).toEqual({ schedule: null });

		const listed = await cli('jobs', 'list', 'shop');
		expect(listed.stdout).toContain('tidy');
		expect(listed.stdout).toContain('0 3 * * *');
		expect(listed.stdout).toContain('reindex (paused)');
		expect(listed.stdout).toContain('manual');
	});

	test('mistakes are caught before a request: unquoted cron, no command, bad policy', async () => {
		const seen = serve({});
		expect((await cli('jobs', 'create', 'shop', 'tidy', '--schedule', '0', '3', '*', '*', '*', '--', 'x')).stderr).toContain('quote the schedule');
		expect((await cli('jobs', 'create', 'shop', 'tidy')).stderr).toContain('Give the command after --');
		expect((await cli('jobs', 'update', 'shop', 'tidy', '--concurrency', 'sometimes')).stderr).toContain('forbid, allow, replace');
		expect((await cli('jobs', 'update', 'shop', 'tidy')).stderr).toContain('Nothing to update');
		expect(seen).toHaveLength(0);
	});

	test('delete refuses without a terminal or --yes', async () => {
		const seen = serve({ 'DELETE /api/v1/projects/shop/jobs/tidy': { deleted: true, stopping: 0 } });
		const refused = await cli('jobs', 'delete', 'shop', 'tidy');
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain('--yes');
		expect(seen).toHaveLength(0);
		expect((await cli('jobs', 'delete', 'shop', 'tidy', '--yes')).code).toBe(0);
		expect(seen.map((item) => item.method)).toEqual(['DELETE']);
	});
});
