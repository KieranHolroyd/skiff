import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, nodeCapabilities } from '@skiff/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@skiff/core';
import { createDb } from '@skiff/db';

/** The job MCP tools (plan 09) against a real core; the node is simulated by leasing and completing runs. */

const dir = mkdtempSync(join(tmpdir(), 'skiff-mcp-jobs-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const realCore: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features: { ...DEFAULT_FEATURES, JOBS: true }
	}
});

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { skiffToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

const TOOLS = ['list_jobs', 'create_job', 'update_job', 'pause_job', 'run_job', 'run_command', 'get_job_runs', 'get_job_run', 'cancel_job_run', 'delete_job'];
let nodeId = '';

async function call(principal: typeof owner, name: string, args: Record<string, unknown>) {
	const tool = assistantTools(principal).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	return { ok: result.ok, text: result.text, body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null };
}

/** Play the node: lease what is queued, write a line of output and exit with `exitCode`. */
function nodeRuns(exitCode: number): () => void {
	const timer = setInterval(() => {
		for (const run of realCore.jobs.lease(nodeId).runs) {
			realCore.logs.appendRuntime(nodeId, {
				workloadId: run.workloadId,
				jobRunId: run.runId,
				lines: [{ ts: Date.now(), stream: 'stdout', level: 'info', message: `ran ${run.command.join(' ')}` }]
			});
			realCore.jobs.complete(nodeId, {
				runId: run.runId,
				status: exitCode === 0 ? 'succeeded' : 'failed',
				exitCode,
				startedAt: Date.now(),
				finishedAt: Date.now(),
				error: null
			});
		}
	}, 20);
	return () => clearInterval(timer);
}

describe('job MCP tools', () => {
	test('setup: a node with jobs, a deployed process app', async () => {
		const joined = realCore.nodes.join({ token: realCore.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		nodeId = joined.nodeId;
		realCore.nodes.update(owner, nodeId, { sliceMemoryMb: 8192 });
		realCore.nodes.heartbeat(joined.token, {
			nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 0,
			status: 'online',
			caddyOk: true,
			capabilities: [...nodeCapabilities],
			releases: []
		} as never);
		await realCore.projects.create(owner, { name: 'shop', slug: 'shop', runtime: 'process', placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
		const row = realCore.projects.requireRow(owner, 'shop');
		realCore.workloads.setSpec(owner, row, { runtime: 'process', command: ['bun', 'run', 'start'], memoryMb: 128 });
		await realCore.uploads.deployInline(owner, row, [file('package.json', '{}'), file('server.ts', '')], { promote: true });
	});

	test('are registered; the assistant confirms runs and deletes and hides writes from viewers', () => {
		const names = new Set(skiffToolDefinitions(owner).map((entry) => entry.name));
		for (const name of TOOLS) expect(names.has(name)).toBe(true);
		const tools = new Map(assistantTools(owner).map((entry) => [entry.name, entry]));
		for (const name of ['run_job', 'run_command', 'delete_job']) expect(tools.get(name)?.destructive).toBe(true);
		for (const name of ['create_job', 'list_jobs', 'get_job_runs', 'pause_job']) expect(tools.get(name)?.destructive).toBe(false);
		const forViewer = new Set(assistantTools(viewer).map((entry) => entry.name));
		for (const name of ['create_job', 'update_job', 'pause_job', 'run_job', 'run_command', 'cancel_job_run', 'delete_job']) expect(forViewer.has(name)).toBe(false);
		expect(forViewer.has('list_jobs')).toBe(true);
	});

	test('create, run and read back a job with its output', async () => {
		const created = await call(owner, 'create_job', { project: 'shop', name: 'tidy', command: ['bun', 'tidy.ts', '--days', '30'], schedule: '0 3 * * *' });
		expect(created.body).toMatchObject({ name: 'tidy', schedule: '0 3 * * *', nextRunAt: expect.any(String) });
		const stop = nodeRuns(0);
		try {
			const ran = await call(owner, 'run_job', { project: 'shop', job: 'tidy', waitSeconds: 5 });
			expect(ran.body).toMatchObject({ run: { status: 'succeeded', exitCode: 0, jobName: 'tidy' }, output: ['ran bun tidy.ts --days 30'] });
		} finally {
			stop();
		}
		const runs = await call(owner, 'get_job_runs', { project: 'shop', job: 'tidy' });
		expect(runs.body?.runs).toHaveLength(1);
		const paused = await call(owner, 'pause_job', { project: 'shop', job: 'tidy' });
		expect(paused.body).toMatchObject({ enabled: false, nextRunAt: null });
		const updated = await call(owner, 'update_job', { project: 'shop', job: 'tidy', schedule: null });
		expect(updated.body).toMatchObject({ schedule: null });
	});

	test('run_command returns a queued run with next steps when the node is slow', async () => {
		const started = await call(owner, 'run_command', { project: 'shop', command: ['bun', 'run', 'migrate'], waitSeconds: 0 });
		expect(started.body?.run).toMatchObject({ status: 'queued', jobId: null });
		expect(started.body?.nextSteps.join(' ')).toContain('get_job_run');
		const stop = nodeRuns(2);
		try {
			const done = await call(owner, 'get_job_run', { project: 'shop', runId: started.body!.run.id, waitSeconds: 5 });
			expect(done.body).toMatchObject({ run: { status: 'failed', exitCode: 2 }, output: ['ran bun run migrate'] });
		} finally {
			stop();
		}
	});

	test('errors come back as tool errors', async () => {
		const shell = await call(owner, 'run_command', { project: 'shop', command: 'rm -rf /' });
		expect(shell.ok).toBe(false);
		const missing = await call(owner, 'run_job', { project: 'shop', job: 'nope', waitSeconds: 0 });
		expect(missing.ok).toBe(false);
		expect(missing.text).toMatch(/not found/i);
	});
});
