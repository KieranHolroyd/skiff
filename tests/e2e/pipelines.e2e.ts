/**
 * Pipelines end-to-end (docs/PIPELINES.md): the real control-plane engine (`@yoal/core`) behind a
 * small HTTP server that mirrors the SvelteKit routes, and the real Builder pipeline loop and
 * in-job step runner (`apps/builder`) claiming from it in direct (no sandbox) mode. A local git
 * repository is the origin; steps are real bash.
 *
 * It covers the contract between the two halves: resolve → runs, claim by label, steps, logs with
 * masking, step outputs → job outputs → `needs`, cache save/restore, artifacts across jobs, and a
 * clean run conclusion.
 *
 *   bun tests/e2e/pipelines.e2e.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../../packages/db/src/index.ts';
import {
	pipelineArtifactCreateSchema,
	pipelineCacheLookupSchema,
	pipelineCacheReserveSchema,
	pipelineClaimRequestSchema,
	pipelineJobCompleteSchema,
	pipelineLogBatchSchema,
	pipelineResolveReportSchema,
	pipelineStepReportSchema,
	type PipelineRunView,
} from '../../packages/contracts/src/index.ts';
import { CoreError, LocalObjectStore, buildPrincipal, createCore, type Core } from '../../packages/core/src/index.ts';
import { loadConfig } from '../../apps/builder/src/config.ts';
import { runPipelineLoop } from '../../apps/builder/src/pipeline/loop.ts';
import { gitRepo } from '../../apps/builder/src/pipeline/git-fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-pipelines-e2e-'));
let core: Core;
let store: LocalObjectStore;

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function route(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
	const body = async <T>(schema: { parse(value: unknown): T }) => schema.parse(await request.json());
	const engine = core.pipelines.engine;
	try {
		if (path.startsWith('/api/objects/')) {
			const key = decodeURIComponent(path.slice('/api/objects/'.length));
			const ok = store.verify(request.method === 'PUT' ? 'PUT' : 'GET', key, Number(url.searchParams.get('exp')), url.searchParams.get('sig') ?? '');
			if (!ok) return new Response('bad signature', { status: 403 });
			if (request.method === 'PUT') {
				await store.put(key, new Uint8Array(await request.arrayBuffer()));
				return new Response(null, { status: 204 });
			}
			return new Response(await store.get(key));
		}
		if (path === '/api/agent/pipelines/claim') {
			const node = core.nodes.authenticate(token);
			return json((await engine.claim(node.id, await body(pipelineClaimRequestSchema))) ?? null);
		}
		const [, , , action, id, sub] = path.split('/');
		if (token.startsWith('ptk_')) {
			const trigger = engine.authenticateTrigger(token);
			if (action === 'resolve') return json({ ok: true, runIds: engine.resolveTrigger(trigger, await body(pipelineResolveReportSchema)) });
			if (action === 'heartbeat') return json(engine.heartbeatTrigger(trigger));
		}
		if (action === 'complete') {
			const job = engine.authenticateJob(token, { allowCompleted: true });
			const input = await body(pipelineJobCompleteSchema);
			if (job.status !== 'completed') engine.complete(job, input);
			return json({ ok: true });
		}
		if (action === 'logs') {
			const job = engine.authenticateJob(token, { allowCompleted: true });
			return json({ ok: true, accepted: engine.appendLogs(job, await body(pipelineLogBatchSchema)) });
		}
		const job = engine.authenticateJob(token);
		if (action === 'heartbeat') return json(engine.heartbeat(job));
		if (action === 'secrets') return json({ secrets: engine.secrets(job) });
		if (action === 'steps') {
			engine.reportStep(job, Number(id), await body(pipelineStepReportSchema));
			return json({ ok: true });
		}
		if (action === 'artifacts') {
			if (!id && request.method === 'GET')
				return json({ artifacts: await engine.listArtifacts(job.runId, { name: url.searchParams.get('name') ?? undefined, withUrls: true }) });
			if (!id) return json(await engine.createArtifact(job, await body(pipelineArtifactCreateSchema)));
			if (sub === 'finalize') return json(await engine.finalizeArtifact(job, id));
		}
		if (action === 'cache') {
			if (id === 'lookup') return json({ hit: await engine.lookupCache(job, await body(pipelineCacheLookupSchema)) });
			if (id === 'reserve') return json(await engine.reserveCache(job, await body(pipelineCacheReserveSchema)));
			if (sub === 'commit') {
				await engine.commitCache(job, id!);
				return json({ ok: true });
			}
		}
		return json({ error: 'not_found', path }, 404);
	} catch (error) {
		if (error instanceof CoreError) return json({ error: error.code, message: error.message }, error.status);
		console.error('[e2e server]', error);
		return json({ error: String(error) }, 500);
	}
}

const server = Bun.serve({ port: 0, fetch: route });
const origin = `http://127.0.0.1:${server.port}`;
store = new LocalObjectStore(join(root, 'objects'), origin, 'object-secret-123');
const opened = createDb({ path: ':memory:' });
core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: root,
		platformOrigin: origin,
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'builder').token, name: 'builder' });
core.nodes.setBuilder(owner, joined.nodeId, true);

const repoDir = join(root, 'origin');
const repo = gitRepo(repoDir);
repo.commit({ 'README.md': 'hello\n', 'bun.lock': 'lock-v1\n' }, 'Initial commit');
core.pipelines.createRepository(owner, { name: 'demo', cloneUrl: `https://example.invalid/demo.git`, provider: 'generic', defaultBranch: 'main' });
// The repository row must point at the local origin; the API only accepts https/ssh URLs.
opened.sqlite.run('UPDATE pipeline_repositories SET clone_url = ? WHERE name = ?', [repoDir, 'demo']);
core.pipelines.setSecret(owner, 'demo', 'API_TOKEN', { value: 's3cr3t-value-123' });

const workflow = `
name: e2e
on: workflow_dispatch
env:
  GREETING: hello
jobs:
  build:
    runs-on: self-hosted
    outputs:
      version: \${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v4
      - id: meta
        run: |
          echo "version=1.2.\${{ yoal.run_number }}" >> "$YOAL_OUTPUT"
          echo "$GREETING from \${{ yoal.repository }} at $(head -c 7 <<< "$YOAL_SHA")"
          echo "token is $API_TOKEN"
        env:
          API_TOKEN: \${{ secrets.API_TOKEN }}
      - uses: actions/cache@v4
        with:
          path: .cache-dir
          key: deps-\${{ hashFiles('bun.lock') }}
      - run: mkdir -p .cache-dir dist && echo cached > .cache-dir/x && echo "artifact \${{ steps.meta.outputs.version }}" > dist/out.txt
      - uses: actions/upload-artifact@v4
        with: { name: dist, path: dist }
  verify:
    needs: build
    runs-on: self-hosted
    steps:
      - uses: actions/download-artifact@v4
        with: { name: dist, path: got }
      - run: |
          test "$(cat got/out.txt)" = "artifact \${{ needs.build.outputs.version }}"
          echo "verified \${{ needs.build.outputs.version }}"
      - if: failure()
        run: echo "should not run"
`;

const config = loadConfig(
	{
		YOAL_CONTROL_URL: origin,
		YOAL_NODE_TOKEN: joined.token,
		YOAL_BUILD_DIR: join(root, 'build'),
		YOAL_BUILDER_SYSTEMD: 'false',
		YOAL_PIPELINE_POLL_MS: '200',
		YOAL_PIPELINE_ISOLATION: 'sandbox',
		YOAL_PIPELINE_STEP_BINARY: process.env.E2E_STEP_BINARY ?? '',
	},
	{ platform: process.platform, isRoot: false, has: (b) => Boolean(Bun.which(b)), arch: process.arch, exists: () => false },
);

const abort = new AbortController();
const loop = runPipelineLoop(config, abort.signal);
let failed = false;

async function waitForRun(predicate: (run: PipelineRunView) => boolean, timeoutMs: number): Promise<PipelineRunView> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const runs = core.pipelines.listRuns(owner, 'demo');
		if (runs[0]) {
			const run = await core.pipelines.getRun(owner, 'demo', runs[0].id);
			if (predicate(run)) return run;
		}
		if (Date.now() > deadline) throw new Error(`timed out; runs: ${JSON.stringify(runs)}; triggers: ${JSON.stringify(core.pipelines.listTriggers(owner, 'demo'))}`);
		await Bun.sleep(200);
	}
}

function check(label: string, ok: boolean, detail = ''): void {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failed = true;
}

try {
	core.pipelines.dispatch(owner, 'demo', { workflowText: workflow, ref: 'main', inputs: {} });
	const run = await waitForRun((r) => r.status === 'completed', 90_000);
	check('run completed successfully', run.conclusion === 'success', `${run.conclusion} ${JSON.stringify(run.jobs.map((j) => [j.key, j.conclusion, j.error]))}`);
	const build = run.jobs.find((job) => job.key === 'build')!;
	const verify = run.jobs.find((job) => job.key === 'verify')!;
	check('job outputs flow through needs', build.outputs.version === '1.2.1', JSON.stringify(build.outputs));
	check('every build step succeeded', build.steps.every((s) => s.conclusion === 'success'), JSON.stringify(build.steps));
	check('failure() step was skipped', verify.steps.at(-1)?.conclusion === 'skipped', JSON.stringify(verify.steps));
	const logs = core.pipelines.jobLogs(owner, 'demo', run.id, build.id, { limit: 5000 }).lines.map((l) => l.text);
	check('logs streamed', logs.some((l) => l.includes('hello from demo')), logs.slice(0, 20).join(' | '));
	check('secret masked', logs.some((l) => l.includes('token is ***')) && !logs.some((l) => l.includes('s3cr3t-value-123')));
	const verifyLogs = core.pipelines.jobLogs(owner, 'demo', run.id, verify.id, { limit: 5000 }).lines.map((l) => l.text);
	check('artifact downloaded in the next job', verifyLogs.some((l) => l.includes('verified 1.2.1')), verifyLogs.slice(-10).join(' | '));
	check('artifact listed on the run', run.artifacts.map((a) => a.name).join() === 'dist');
	const caches = opened.sqlite.query("SELECT key, status FROM pipeline_caches").all() as Array<{ key: string; status: string }>;
	check('cache saved after success', caches.some((c) => c.status === 'ready' && c.key.startsWith('deps-')), JSON.stringify(caches));

	// A second run restores the cache (exact key hit).
	core.pipelines.dispatch(owner, 'demo', { workflowText: workflow, ref: 'main', inputs: {} });
	const second = await waitForRun((r) => r.number === 2 && r.status === 'completed', 90_000);
	const secondBuild = second.jobs.find((job) => job.key === 'build')!;
	const secondLogs = core.pipelines.jobLogs(owner, 'demo', second.id, secondBuild.id, { limit: 5000 }).lines.map((l) => l.text);
	check('second run succeeded', second.conclusion === 'success');
	check('cache restored on the second run', secondLogs.some((l) => /cache (restored|hit)/i.test(l)), secondLogs.filter((l) => /cache/i.test(l)).join(' | '));
} catch (error) {
	console.error(error);
	failed = true;
} finally {
	abort.abort();
	await Promise.race([loop, Bun.sleep(10_000)]);
	server.stop(true);
	opened.sqlite.close();
	rmSync(root, { recursive: true, force: true });
}
console.log(failed ? '\npipelines e2e: FAILED' : '\npipelines e2e: passed');
process.exit(failed ? 1 : 0);
