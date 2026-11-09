import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineClaimRequestInput, PipelineJobClaim, PipelineResolveClaim } from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/** The Pipelines MCP tools (docs/PIPELINES.md §8) against a real core; the build node is played by the test. */

const dir = mkdtempSync(join(tmpdir(), 'yoal-mcp-pipelines-'));
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
		desiredAgentVersion: '0.1.0'
	}
});

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { yoalToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');
const { pipelineTools, PIPELINE_LOG_TAIL } = await import('./mcp-pipelines');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const engine = realCore.pipelines.engine;
const labels: PipelineClaimRequestInput = { labels: ['linux', 'x64'], capacity: 1, isolation: 'sandbox' };
const SECRET_VALUE = 'npm_s3cr3t_value_never_shown';

const TOOLS = ['list_pipeline_runs', 'get_pipeline_run', 'dispatch_workflow', 'rerun_pipeline_run', 'cancel_pipeline_run'];
const WORKFLOW = `
name: ci
on:
  workflow_dispatch:
    inputs:
      reason:
        type: string
jobs:
  build:
    runs-on: linux
    steps:
      - run: echo build
  test:
    needs: build
    runs-on: linux
    steps:
      - name: Install
        run: bun install
      - name: Run tests
        run: bun test
        env:
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
`;

let nodeId = '';

async function call(principal: typeof owner, name: string, args: Record<string, unknown>) {
	const tool = assistantTools(principal).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	return { ok: result.ok, text: result.text, body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null };
}

/** Play the build node's resolve step for whatever trigger is waiting. */
async function resolveNext(): Promise<string[]> {
	const claim = (await engine.claim(nodeId, labels)) as PipelineResolveClaim | null;
	if (!claim || claim.kind !== 'resolve') return [];
	return engine.resolveTrigger(engine.authenticateTrigger(claim.token), { sha: 'a'.repeat(40), commitMessage: 'Fix the cart', files: [] });
}

async function claimJob(): Promise<PipelineJobClaim> {
	const claim = await engine.claim(nodeId, labels);
	if (!claim || claim.kind !== 'job') throw new Error(`expected a job, got ${claim?.kind ?? 'nothing'}`);
	return claim;
}

describe('pipeline MCP tools', () => {
	test('setup: a build node and a repository with a secret', () => {
		const node = realCore.nodes.join({ token: realCore.nodes.createJoinToken(owner, 'builder').token, name: 'builder' });
		realCore.nodes.setBuilder(owner, node.nodeId, true);
		nodeId = node.nodeId;
		realCore.pipelines.createRepository(owner, { name: 'shop', cloneUrl: 'https://github.com/acme/shop.git', provider: 'github', defaultBranch: 'main' });
		realCore.pipelines.setSecret(owner, 'shop', 'NPM_TOKEN', { value: SECRET_VALUE });
	});

	test('are registered; no tool sets secrets or approves environments; viewers only read', () => {
		const names = new Set(yoalToolDefinitions(owner).map((entry) => entry.name));
		for (const name of TOOLS) expect(names.has(name)).toBe(true);
		for (const spec of pipelineTools(owner)) expect(spec.name).not.toMatch(/secret|variable|approve/);
		const tools = new Map(assistantTools(owner).map((entry) => [entry.name, entry]));
		for (const name of ['dispatch_workflow', 'rerun_pipeline_run']) expect(tools.get(name)?.destructive).toBe(true);
		for (const name of ['list_pipeline_runs', 'get_pipeline_run', 'cancel_pipeline_run']) expect(tools.get(name)?.destructive).toBe(false);
		const forViewer = new Set(assistantTools(viewer).map((entry) => entry.name));
		for (const name of ['dispatch_workflow', 'rerun_pipeline_run', 'cancel_pipeline_run']) expect(forViewer.has(name)).toBe(false);
		for (const name of ['list_pipeline_runs', 'get_pipeline_run']) expect(forViewer.has(name)).toBe(true);
	});

	test('dispatch waits for the build node and returns the run', async () => {
		// Resolve once, then stop: the next claim would take the job the next test plays.
		let busy = false;
		const timer = setInterval(async () => {
			if (busy) return;
			busy = true;
			if ((await resolveNext()).length > 0) clearInterval(timer);
			else busy = false;
		}, 20);
		try {
			const dispatched = await call(owner, 'dispatch_workflow', { repo: 'shop', workflow_text: WORKFLOW, inputs: { reason: 'mcp' }, wait_seconds: 5 });
			expect(dispatched.ok).toBe(true);
			expect(dispatched.body?.trigger).toMatchObject({ status: 'resolved', runIds: [expect.any(String)] });
			expect(dispatched.body?.runs[0]).toMatchObject({ number: 1, status: 'queued', title: 'Fix the cart' });
			expect(dispatched.body?.nextSteps[0]).toContain('get_pipeline_run');
		} finally {
			clearInterval(timer);
		}
	});

	test('get_pipeline_run shows the failing step and the last log lines, never secret values', async () => {
		const build = await claimJob();
		engine.complete(engine.authenticateJob(build.token), { conclusion: 'success', outputs: {} });
		const testJob = await claimJob();
		expect(testJob.secretNames).toContain('NPM_TOKEN');
		const auth = engine.authenticateJob(testJob.token);
		engine.reportStep(auth, 0, { status: 'completed', conclusion: 'success', name: 'Install' });
		engine.reportStep(auth, 1, { status: 'in_progress', name: 'Run tests' });
		const lines = Array.from({ length: 250 }, (_, i) => ({ step: 1, stream: 'stdout' as const, text: `line ${i + 1}` }));
		engine.appendLogs(auth, { lines });
		engine.reportStep(auth, 1, { status: 'completed', conclusion: 'failure' });
		engine.complete(auth, { conclusion: 'failure', outputs: {} });

		const got = await call(owner, 'get_pipeline_run', { repo: 'shop', run: '#1' });
		expect(got.ok).toBe(true);
		expect(got.body?.run).toMatchObject({ number: 1, status: 'completed', conclusion: 'failure', inputs: { reason: 'mcp' } });
		expect(got.body?.jobs.map((job: { key: string; conclusion: string }) => [job.key, job.conclusion])).toEqual([
			['build', 'success'],
			['test', 'failure'],
		]);
		expect(got.body?.failure.job.key).toBe('test');
		expect(got.body?.failure.step).toMatchObject({ number: 2, name: 'Run tests' });
		expect(got.body?.failure.log.lines).toHaveLength(PIPELINE_LOG_TAIL);
		expect(got.body?.failure.log.lines.at(-1)).toBe('[2 Run tests] line 250');
		expect(got.body?.failure.log).toMatchObject({ truncated: true, linesInLog: 250 });
		expect(got.text).not.toContain(SECRET_VALUE);
		expect(got.text).not.toContain(testJob.token);
	});

	test('list, rerun failed jobs and cancel', async () => {
		const failed = await call(owner, 'list_pipeline_runs', { repo: 'shop', status: 'failure' });
		expect(failed.body?.runs.map((run: { number: number }) => run.number)).toEqual([1]);
		expect((await call(owner, 'list_pipeline_runs', { repo: 'shop', status: 'success' })).body?.runs).toEqual([]);
		expect((await call(viewer, 'list_pipeline_runs', {})).body?.runs).toHaveLength(1);

		const rerun = await call(owner, 'rerun_pipeline_run', { repo: 'shop', run: '1', failed_only: true });
		expect(rerun.ok).toBe(true);
		expect(rerun.body?.run).toMatchObject({ attempt: 2, conclusion: null });
		expect(rerun.body?.jobs).toContainEqual({ name: 'test', status: 'queued', conclusion: null });
		expect(rerun.body?.jobs).toContainEqual({ name: 'build', status: 'completed', conclusion: 'success' });

		const cancelled = await call(owner, 'cancel_pipeline_run', { repo: 'shop', run: '1' });
		expect(cancelled.ok).toBe(true);
		const again = await call(owner, 'cancel_pipeline_run', { repo: 'shop', run: '1' });
		expect(again.ok).toBe(false);
		expect(again.text).toMatch(/already completed/);
	});

	test('errors come back as tool errors', async () => {
		const both = await call(owner, 'dispatch_workflow', { repo: 'shop', workflow: 'ci.yml', workflow_text: WORKFLOW, wait_seconds: 0 });
		expect(both.ok).toBe(false);
		expect(both.text).toContain('exactly one');
		const missing = await call(owner, 'get_pipeline_run', { repo: 'shop', run: '99' });
		expect(missing.ok).toBe(false);
		expect(missing.text).toMatch(/not found/i);
		const forbidden = await yoalToolDefinitions(viewer)
			.find((entry) => entry.name === 'dispatch_workflow')!
			.handler({ repo: 'shop', workflow: 'ci.yml', inputs: {}, wait_seconds: 0 });
		expect((forbidden as { isError?: boolean }).isError).toBe(true);
	});
});
