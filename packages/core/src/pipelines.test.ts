import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { PipelineClaimRequestInput, PipelineJobClaim, PipelineResolveClaim, Principal } from '@yoal/contracts';
import { zipSync } from 'fflate';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { PIPELINE_LEASE_MS, labelsSatisfied } from './pipeline-engine.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-pipelines-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.now();

const core: Core = createCore({
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
		now: () => clock,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'deployer' });
const engine = core.pipelines.engine;
const WEBHOOK_SECRET = 'webhook-secret-0123456789';
let counter = 0;
let nodeId = '';

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	clock = Date.now();
	for (const table of ['pipeline_triggers', 'pipeline_runs', 'pipeline_jobs', 'pipeline_steps', 'pipeline_log_lines'])
		opened.sqlite.run(`DELETE FROM ${table}`);
	if (!nodeId) {
		const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'builder').token, name: 'builder' });
		core.nodes.setBuilder(owner, node.nodeId, true);
		nodeId = node.nodeId;
	}
});

function repo(name = `app-${++counter}`) {
	return core.pipelines.createRepository(owner, {
		name,
		cloneUrl: 'https://github.com/acme/app.git',
		provider: 'github',
		defaultBranch: 'main',
		webhookSecret: WEBHOOK_SECRET,
	});
}

const labels: PipelineClaimRequestInput = { labels: ['linux', 'x64'], capacity: 1, isolation: 'sandbox' };

/** Dispatch an inline workflow and play the build node's resolve step. */
async function dispatchInline(name: string, yaml: string, inputs: Record<string, string | number | boolean> = {}) {
	const trigger = core.pipelines.dispatch(owner, name, { workflowText: yaml, ref: 'main', inputs });
	const claim = (await engine.claim(nodeId, labels)) as PipelineResolveClaim;
	expect(claim.kind).toBe('resolve');
	expect(claim.triggerId).toBe(trigger.id);
	const runIds = engine.resolveTrigger(engine.authenticateTrigger(claim.token), {
		sha: 'a'.repeat(40),
		commitMessage: 'Ship it\n\nbody',
		files: [],
	});
	return { trigger, runIds };
}

async function claimJob(request: PipelineClaimRequestInput = labels): Promise<PipelineJobClaim | null> {
	const claim = await engine.claim(nodeId, request);
	if (claim && claim.kind !== 'job') throw new Error(`expected a job, got ${claim.kind}`);
	return claim as PipelineJobClaim | null;
}

function finish(claim: PipelineJobClaim, conclusion: 'success' | 'failure' = 'success', outputs: Record<string, string> = {}) {
	engine.complete(engine.authenticateJob(claim.token), { conclusion, outputs });
}

describe('labels', () => {
	test('hosted aliases map to linux and self-hosted is free', () => {
		expect(labelsSatisfied(['ubuntu-latest'], ['linux'])).toBe(true);
		expect(labelsSatisfied(['self-hosted', 'linux', 'ARM64'], ['linux', 'arm64'])).toBe(true);
		expect(labelsSatisfied(['linux', 'gpu'], ['linux'])).toBe(false);
	});
});

describe('runs', () => {
	test('a dispatched DAG runs in order and passes outputs through needs', async () => {
		const r = repo();
		const { runIds } = await dispatchInline(
			r.name,
			`
name: ci
on: workflow_dispatch
jobs:
  build:
    runs-on: linux
    outputs:
      version: \${{ steps.v.outputs.version }}
    steps:
      - id: v
        run: echo "version=1.2.3" >> "$YOAL_OUTPUT"
  deploy:
    needs: build
    runs-on: [self-hosted, linux]
    steps:
      - run: echo deploying \${{ needs.build.outputs.version }}
`,
		);
		expect(runIds).toHaveLength(1);
		let run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.number).toBe(1);
		expect(run.title).toBe('Ship it');
		expect(run.jobs.map((job) => [job.key, job.status])).toEqual([
			['build', 'queued'],
			['deploy', 'pending'],
		]);

		const build = (await claimJob())!;
		expect(build.job.key).toBe('build');
		expect(build.context.yoal.sha).toBe('a'.repeat(40));
		expect(await claimJob()).toBeNull(); // deploy waits for build
		engine.appendLogs(engine.authenticateJob(build.token), { lines: [{ step: 0, stream: 'stdout', text: 'hello' }] });
		engine.reportStep(engine.authenticateJob(build.token), 0, { status: 'completed', conclusion: 'success' });
		finish(build, 'success', { version: '1.2.3' });

		const deploy = (await claimJob())!;
		expect(deploy.job.key).toBe('deploy');
		expect(deploy.context.needs?.build).toEqual({ result: 'success', outputs: { version: '1.2.3' } });
		finish(deploy);

		run = await core.pipelines.getRun(owner, r.name, '#1');
		expect(run.status).toBe('completed');
		expect(run.conclusion).toBe('success');
		const logs = core.pipelines.jobLogs(owner, r.name, run.id, run.jobs[0]!.id);
		expect(logs.lines.map((line) => line.text)).toEqual(['hello']);
		expect(logs.complete).toBe(true);
		// The token keeps accepting a final log flush, but not new work.
		expect(() => engine.authenticateJob(build.token)).toThrow();
		expect(engine.authenticateJob(build.token, { allowCompleted: true }).id).toBe(build.jobId);
	});

	test('a failed job skips its dependents unless they use always()', async () => {
		const r = repo();
		const { runIds } = await dispatchInline(
			r.name,
			`
on: workflow_dispatch
jobs:
  test: { runs-on: linux, steps: [{ run: exit 1 }] }
  ship: { needs: test, runs-on: linux, steps: [{ run: echo ship }] }
  report: { needs: test, if: always(), runs-on: linux, steps: [{ run: echo report }] }
`,
		);
		finish((await claimJob())!, 'failure');
		const report = (await claimJob())!;
		expect(report.job.key).toBe('report');
		expect(report.context.needs?.test?.result).toBe('failure');
		finish(report);
		const run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.jobs.find((job) => job.key === 'ship')?.conclusion).toBe('skipped');
		expect(run.conclusion).toBe('failure');
	});

	test('matrix expansion, max-parallel and fail-fast', async () => {
		const r = repo();
		const { runIds } = await dispatchInline(
			r.name,
			`
on: workflow_dispatch
jobs:
  build:
    strategy:
      max-parallel: 2
      matrix: { arch: [x64, arm64, riscv] }
    runs-on: [linux]
    steps: [{ run: 'echo \${{ matrix.arch }}' }]
`,
		);
		let run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.jobs).toHaveLength(3);
		expect(run.jobs.map((job) => job.status).sort()).toEqual(['pending', 'queued', 'queued']);
		expect(run.jobs[0]!.name).toBe('build (x64)');
		const first = (await claimJob())!;
		expect(first.context.matrix).toEqual({ arch: 'x64' });
		finish(first, 'failure');
		run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.jobs.filter((job) => job.conclusion === 'cancelled')).toHaveLength(2);
		expect(run.conclusion).toBe('failure');
	});

	test('jobs wait for a node with matching labels and container isolation', async () => {
		const r = repo();
		await dispatchInline(
			r.name,
			`
on: workflow_dispatch
jobs:
  arm: { runs-on: [linux, arm64], steps: [{ run: uname -m }] }
  svc:
    runs-on: linux
    services: { db: { image: postgres:17 } }
    steps: [{ run: echo hi }]
`,
		);
		expect(await claimJob()).toBeNull();
		const arm = await claimJob({ labels: ['linux', 'arm64'], capacity: 1, isolation: 'sandbox' });
		expect(arm?.job.key).toBe('arm');
		const svc = await claimJob({ labels: ['linux'], capacity: 1, isolation: 'container' });
		expect(svc?.job.key).toBe('svc');
		expect(svc?.image).toBe('docker.io/library/node:24-bookworm');
	});

	test('a lapsed lease fails the job', async () => {
		const r = repo();
		const { runIds } = await dispatchInline(r.name, `on: workflow_dispatch\njobs:\n  a: { runs-on: linux, steps: [{ run: sleep 1 }] }\n`);
		const job = (await claimJob())!;
		expect(engine.heartbeat(engine.authenticateJob(job.token)).cancelled).toBe(false);
		clock += PIPELINE_LEASE_MS + 1;
		engine.recoverExpiredLeases();
		const run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.jobs[0]!.error).toContain('stopped responding');
		expect(run.conclusion).toBe('failure');
	});

	test('cancel tells the running job and cancels the rest; rerun of failed jobs', async () => {
		const r = repo();
		const { runIds } = await dispatchInline(
			r.name,
			`
on: workflow_dispatch
jobs:
  a: { runs-on: linux, steps: [{ run: echo a }] }
  b: { needs: a, runs-on: linux, steps: [{ run: echo b }] }
`,
		);
		const a = (await claimJob())!;
		await core.pipelines.cancelRun(owner, r.name, runIds[0]!);
		expect(engine.heartbeat(engine.authenticateJob(a.token)).cancelled).toBe(true);
		finish(a, 'success'); // the runner finished anyway: still recorded as cancelled
		let run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.conclusion).toBe('cancelled');
		expect(run.jobs.map((job) => job.conclusion)).toEqual(['cancelled', 'cancelled']);

		await core.pipelines.rerun(owner, r.name, runIds[0]!, true);
		run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.attempt).toBe(2);
		expect(run.status).toBe('queued');
		finish((await claimJob())!);
		finish((await claimJob())!);
		run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.conclusion).toBe('success');
	});

	test('invalid workflow files become failed runs with the issues', async () => {
		const r = repo();
		const { runIds } = await dispatchInline(r.name, `on: workflow_dispatch\njobs:\n  a: { runs-on: linux, steps: [{ uses: "docker://alpine:3" }] }\n`);
		const run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.conclusion).toBe('failure');
		expect((run as unknown as { error: string }).error).toContain('jobs.a.steps[0]');
	});

	test('dispatch inputs are coerced and exposed', async () => {
		const r = repo();
		await dispatchInline(
			r.name,
			`
on:
  workflow_dispatch:
    inputs:
      promote: { type: boolean, default: false }
jobs:
  a: { runs-on: linux, steps: [{ run: 'echo \${{ inputs.promote }}' }] }
`,
			{ promote: 'true' },
		);
		const job = (await claimJob())!;
		expect(job.context.inputs).toEqual({ promote: true });
	});
});

describe('environments and secrets', () => {
	test('secrets are delivered by name; environment secrets override and need approval', async () => {
		const r = repo();
		core.pipelines.setSecret(owner, r.name, 'TOKEN', { value: 'repo-token' });
		core.pipelines.setSecret(owner, r.name, 'TOKEN', { value: 'prod-token', environment: 'production' });
		core.pipelines.setEnvironment(owner, r.name, 'production', { allowedRefs: ['refs/heads/main'], requireApproval: true });
		expect(() => core.pipelines.setEnvironment(deployer, r.name, 'production', { allowedRefs: [], requireApproval: false })).toThrow();
		const { runIds } = await dispatchInline(
			r.name,
			`
on: workflow_dispatch
jobs:
  test: { runs-on: linux, steps: [{ run: echo }] }
  ship: { runs-on: linux, environment: production, steps: [{ run: echo }] }
`,
		);
		const test1 = (await claimJob())!;
		expect(test1.secretNames).toEqual(['TOKEN']);
		expect(await engine.secrets(engine.authenticateJob(test1.token))).toEqual({ TOKEN: 'repo-token' });
		finish(test1);
		expect(await claimJob()).toBeNull(); // waiting for approval
		let run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		const ship = run.jobs.find((job) => job.key === 'ship')!;
		expect(ship.status).toBe('waiting');
		await expect(core.pipelines.approveJob(deployer, r.name, run.id, ship.id, true)).rejects.toThrow('pipeline:approve');
		await core.pipelines.approveJob(owner, r.name, run.id, ship.id, true);
		const claim = (await claimJob())!;
		expect(await engine.secrets(engine.authenticateJob(claim.token))).toEqual({ TOKEN: 'prod-token' });
		finish(claim);
		run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.conclusion).toBe('success');
		expect(core.pipelines.listSecrets(owner, r.name).map((s) => `${s.environment ?? '-'}:${s.name}`)).toEqual([
			'-:TOKEN',
			'production:TOKEN',
		]);
	});

	test('an environment refuses refs it does not allow', async () => {
		const r = repo();
		core.pipelines.setEnvironment(owner, r.name, 'release', { allowedRefs: ['refs/tags/v*'], requireApproval: false });
		const { runIds } = await dispatchInline(r.name, `on: workflow_dispatch\njobs:\n  a: { runs-on: linux, environment: release, steps: [{ run: echo }] }\n`);
		const run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.jobs[0]!.error).toContain('not allowed');
		expect(run.conclusion).toBe('failure');
	});
});

describe('inline workflows', () => {
	test('run untrusted unless an owner or admin dispatches them from a human session', async () => {
		const r = repo();
		core.pipelines.setSecret(owner, r.name, 'TOKEN', { value: 'x' });
		const yaml = 'on: workflow_dispatch\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n';
		const mcp = buildPrincipal({ kind: 'mcp', userId: 'user_1', orgId: 'org_1', role: 'owner' });
		for (const [who, expected] of [
			[deployer, 'untrusted'],
			[mcp, 'untrusted'],
			[owner, 'trusted'],
		] as const) {
			core.pipelines.dispatch(who, r.name, { workflowText: yaml, ref: 'main', inputs: {} });
			const claim = (await engine.claim(nodeId, labels)) as PipelineResolveClaim;
			engine.resolveTrigger(engine.authenticateTrigger(claim.token), { sha: 'd'.repeat(40), files: [] });
			const job = (await claimJob())!;
			expect([who.kind, who.role, job.trust]).toEqual([who.kind, who.role, expected]);
			expect(job.secretNames).toEqual(expected === 'trusted' ? ['TOKEN'] : []);
			finish(job);
		}
	});
});

describe('webhooks', () => {
	function sign(body: string) {
		return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
	}

	test('push creates a trigger; resolve runs matching workflows only and records schedules', async () => {
		const r = repo();
		const body = JSON.stringify({
			ref: 'refs/heads/main',
			after: 'b'.repeat(40),
			head_commit: { message: 'feat: x' },
			commits: [{ modified: ['src/app.ts'] }],
			pusher: { name: 'kieran' },
		});
		await expect(core.pipelines.handleGithubWebhook(r.id, body, 'sha256=bad', 'push')).rejects.toThrow();
		const result = await core.pipelines.handleGithubWebhook(r.id, body, sign(body), 'push');
		expect(result.accepted).toBe(true);
		const claim = (await engine.claim(nodeId, labels)) as PipelineResolveClaim;
		expect(claim.sha).toBe('b'.repeat(40));
		const runIds = engine.resolveTrigger(engine.authenticateTrigger(claim.token), {
			sha: 'b'.repeat(40),
			files: [
				{ path: '.yoal/workflows/ci.yml', content: 'on: { push: { paths: ["src/**"] } }\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n' },
				{ path: '.yoal/workflows/docs.yml', content: 'on: { push: { paths: ["docs/**"] } }\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n' },
				{ path: '.yoal/workflows/nightly.yml', content: 'on: { schedule: [{ cron: "0 3 * * *" }] }\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n' },
			],
		});
		expect(runIds).toHaveLength(1);
		const runs = core.pipelines.listRuns(owner, r.name);
		expect(runs[0]!.workflowPath).toBe('.yoal/workflows/ci.yml');
		expect(runs[0]!.actor).toBe('kieran');

		// The nightly cron was remembered from the default branch and fires once at 03:00 UTC.
		const at3 = Date.UTC(2026, 10, 9, 3, 0, 10);
		expect(core.pipelines.tickSchedules(at3)).toBeGreaterThanOrEqual(1);
		expect(core.pipelines.tickSchedules(at3 + 5_000)).toBe(0);
	});

	test('a pull request from a fork is untrusted: no secrets, no deploys', async () => {
		const r = repo();
		core.pipelines.setSecret(owner, r.name, 'TOKEN', { value: 'x' });
		const body = JSON.stringify({
			action: 'opened',
			number: 7,
			pull_request: {
				title: 'Add thing',
				head: { sha: 'c'.repeat(40), ref: 'feature', repo: { full_name: 'evil/app' } },
				base: { ref: 'main', repo: { full_name: 'acme/app' } },
			},
			sender: { login: 'evil' },
		});
		await core.pipelines.handleGithubWebhook(r.id, body, sign(body), 'pull_request');
		const claim = (await engine.claim(nodeId, labels)) as PipelineResolveClaim;
		expect(claim.ref).toBe('refs/pull/7/head');
		engine.resolveTrigger(engine.authenticateTrigger(claim.token), {
			sha: 'c'.repeat(40),
			files: [{ path: '.yoal/workflows/ci.yml', content: 'on: pull_request\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n' }],
		});
		const job = (await claimJob())!;
		expect(job.trust).toBe('untrusted');
		expect(job.secretNames).toEqual([]);
		expect(await engine.secrets(engine.authenticateJob(job.token))).toEqual({});
		await expect(engine.startDeploy(engine.authenticateJob(job.token), { project: 'x', archive: true, promote: false })).rejects.toThrow(
			'Untrusted',
		);
	});
});

describe('caches and artifacts', () => {
	test('cache scopes: a branch reads main, writes only its own', async () => {
		const r = repo();
		const { runIds } = await dispatchInline(r.name, `on: workflow_dispatch\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n`);
		const job = engine.authenticateJob((await claimJob())!.token);
		const reservation = await engine.reserveCache(job, { key: 'deps-1', version: 'v', size: 3 });
		expect(reservation.uploadUrl).toBeTruthy();
		await store.put(`pipelines/${job.repositoryId}/caches/${reservation.cacheId}.tar.gz`, new Uint8Array([1, 2, 3]));
		await engine.commitCache(job, reservation.cacheId!);
		expect((await engine.reserveCache(job, { key: 'deps-1', version: 'v', size: 3 })).uploadUrl).toBeNull();
		const hit = await engine.lookupCache(job, { key: 'deps-2', restoreKeys: ['deps-'], version: 'v' });
		expect(hit?.key).toBe('deps-1');
		expect(await engine.lookupCache(job, { key: 'deps-1', restoreKeys: [], version: 'other' })).toBeNull();

		const artifact = await engine.createArtifact(job, { name: 'dist', size: 3, sha256: 'f'.repeat(64) });
		await store.put(`pipelines/${job.repositoryId}/${job.runId}/artifacts/${artifact.artifactId}.tar.gz`, new Uint8Array([1, 2, 3]));
		await engine.finalizeArtifact(job, artifact.artifactId);
		const listed = await engine.listArtifacts(job.runId, { withUrls: true });
		expect(listed.map((a) => a.name)).toEqual(['dist']);
		expect(listed[0]!.downloadUrl).toContain('https://control.test');
		const run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.artifacts).toHaveLength(1);
	});
});

describe('isolation tiers (W14)', () => {
	test('a repository minimum routes jobs to nodes that can give it, with the matching runtime', async () => {
		const r = repo();
		core.pipelines.updateRepository(owner, r.name, { minIsolation: { trusted: 'gvisor', untrusted: 'microvm' } });
		expect(core.pipelines.getRepository(owner, r.name).minIsolation).toEqual({ trusted: 'gvisor', untrusted: 'microvm' });
		expect(() => core.pipelines.updateRepository(deployer, r.name, { minIsolation: { trusted: null, untrusted: null } })).toThrow();
		await dispatchInline(r.name, 'on: workflow_dispatch\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n');
		expect(await claimJob({ labels: ['linux'], capacity: 1, isolation: 'sandbox' })).toBeNull();
		expect(await claimJob({ labels: ['linux'], capacity: 1, isolation: 'container' })).toBeNull();
		const job = await claimJob({ labels: ['linux'], capacity: 1, isolation: 'container', runtimes: ['runc', 'runsc', 'kata'] });
		expect(job?.runtime).toBe('runsc');
		finish(job!);
	});

	test('build-image steps ask for a BuildKit sidecar with a trust-scoped cache', async () => {
		const r = repo();
		await dispatchInline(
			r.name,
			'on: workflow_dispatch\njobs:\n  img: { runs-on: linux, steps: [{ uses: yoal/build-image@v1, with: { tags: "x/y:z" } }] }\n',
		);
		const job = (await claimJob())!;
		expect(job.buildkit).toBe(true);
		expect(job.buildkitCacheScope).toBe(`${r.id}-trusted`);
		expect(job.runtime).toBeNull();
		finish(job);
	});
});

describe('needs that were skipped', () => {
	test('skip their dependents unless the dependent decides with a status function', async () => {
		const r = repo();
		const { runIds } = await dispatchInline(
			r.name,
			`
on: workflow_dispatch
jobs:
  a: { if: "false", runs-on: linux, steps: [{ run: echo }] }
  b: { needs: a, runs-on: linux, steps: [{ run: echo }] }
  c: { needs: a, if: always(), runs-on: linux, steps: [{ run: echo }] }
`,
		);
		const c = (await claimJob())!;
		expect(c.job.key).toBe('c');
		finish(c);
		const run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.jobs.map((job) => [job.key, job.conclusion])).toEqual([
			['a', 'skipped'],
			['b', 'skipped'],
			['c', 'success'],
		]);
	});
});

describe('commit statuses', () => {
	test('a GitHub repository with a status token reports pending, then the conclusion', async () => {
		const posted: Array<{ url: string; body: { state: string; context: string; target_url: string } }> = [];
		engine.statusFetch = async (url, init) => {
			posted.push({ url, body: JSON.parse(String(init.body)) });
			return new Response('{}', { status: 201 });
		};
		try {
			const r = repo();
			core.pipelines.updateRepository(owner, r.name, { statusToken: 'ghp_statuses_token_123' });
			expect(core.pipelines.getRepository(owner, r.name).hasStatusToken).toBe(true);
			await dispatchInline(r.name, 'name: ci\non: workflow_dispatch\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n');
			finish((await claimJob())!);
			await Bun.sleep(10);
			expect(posted.map((p) => p.body.state)).toEqual(['pending', 'pending', 'success']);
			expect(posted[0]!.url).toBe(`https://api.github.com/repos/acme/app/statuses/${'a'.repeat(40)}`);
			expect(posted[0]!.body.context).toBe('yoal/ci');
			expect(posted[2]!.body.target_url).toContain(`/pipelines/${r.name}/runs/1`);
		} finally {
			engine.statusFetch = (url, init) => fetch(url, init);
		}
	});
});

describe('OIDC ID tokens (W9)', () => {
	test('trusted jobs get a ring-signed ES256 token that verifies against the JWKS; untrusted get none', async () => {
		const { createPublicKey, verify } = await import('node:crypto');
		const r = repo();
		await dispatchInline(r.name, 'on: workflow_dispatch\njobs:\n  deploy: { runs-on: linux, environment: prod, steps: [{ run: echo }] }\n');
		const job = (await claimJob())!;
		const { token } = engine.mintOidcToken(engine.authenticateJob(job.token), 'sts.amazonaws.com');
		const [headerPart, body, signature] = token.split('.');
		const header = JSON.parse(Buffer.from(headerPart!, 'base64url').toString()) as { alg: string; kid: string };
		const active = await core.ctx.signingKeys.active('oidc');
		expect(header).toMatchObject({ alg: 'ES256', kid: active.kid });

		const key = createPublicKey({ key: engine.oidc.jwks().keys.find((candidate) => candidate.kid === active.kid) as never, format: 'jwk' });
		expect(verify('sha256', Buffer.from(`${headerPart}.${body}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(
			true,
		);
		const claims = JSON.parse(Buffer.from(body!, 'base64url').toString());
		expect(claims.iss).toBe('https://control.test/api/pipeline/oidc');
		expect(claims.aud).toBe('sts.amazonaws.com');
		expect(claims.sub).toBe(`repo:org_1/${r.name}:environment:prod`);

		// The ring verifies the path-based issuer, and both public JWKS documents publish the kid.
		await expect(
			core.ctx.signingKeys.verify('oidc', token, { issuer: 'https://control.test/api/pipeline/oidc' }),
		).resolves.toMatchObject({ iss: 'https://control.test/api/pipeline/oidc', sub: `repo:org_1/${r.name}:environment:prod` });
		expect(core.ctx.signingKeys.jwks('oidc').map((entry) => entry.kid)).toContain(active.kid);
		expect(core.ctx.signingKeys.jwksAll().keys.map((entry) => entry.kid)).toContain(active.kid);
		expect(engine.oidc.jwks().keys.map((entry) => entry.kid)).toContain(active.kid);
		expect(engine.oidc.discovery().jwks_uri).toBe('https://control.test/api/pipeline/oidc/jwks');
		finish(job);

		core.pipelines.dispatch(deployer, r.name, { workflowText: 'on: workflow_dispatch\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n', inputs: {} });
		const resolve = (await engine.claim(nodeId, labels)) as PipelineResolveClaim;
		engine.resolveTrigger(engine.authenticateTrigger(resolve.token), { sha: 'e'.repeat(40), files: [] });
		const untrusted = (await claimJob())!;
		expect(() => engine.mintOidcToken(engine.authenticateJob(untrusted.token), undefined)).toThrow('Untrusted');
		finish(untrusted);
	});

	test('the alias JWKS keeps the legacy settings key, and a legacy-signed token still verifies', async () => {
		const { createPublicKey, generateKeyPairSync, sign, verify } = await import('node:crypto');
		const { encrypt } = await import('./util.ts');
		const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
		const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
		const sealed = encrypt(new Uint8Array(32).fill(7), new TextEncoder().encode(pem));
		const stored = { kid: 'legacy-pipeline-kid', nonce: sealed.nonce, ciphertext: sealed.ciphertext, createdAt: clock };
		opened.sqlite.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [
			'pipelines.oidc.signing_key',
			JSON.stringify(stored),
			clock,
		]);
		try {
			const keys = engine.oidc.jwks().keys;
			const legacy = keys.find((candidate) => candidate.kid === 'legacy-pipeline-kid');
			expect(legacy).toBeDefined();
			// The legacy key is an alias-only key: it is never published at the platform JWKS.
			expect(core.ctx.signingKeys.jwksAll().keys.map((entry) => entry.kid)).not.toContain('legacy-pipeline-kid');

			const now = Math.floor(clock / 1000);
			const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'legacy-pipeline-kid' })).toString('base64url');
			const body = Buffer.from(
				JSON.stringify({
					iss: 'https://control.test/api/pipeline/oidc',
					aud: 'sts.amazonaws.com',
					sub: 'repo:org_1/app:ref:refs/heads/main',
					iat: now,
					nbf: now - 5,
					exp: now + 600,
				}),
			).toString('base64url');
			const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
			const publicKey = createPublicKey({ key: legacy as never, format: 'jwk' });
			expect(verify('sha256', Buffer.from(`${header}.${body}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
		} finally {
			opened.sqlite.run('DELETE FROM settings WHERE key = ?', ['pipelines.oidc.signing_key']);
		}
	});
});

describe('yoal_event triggers', () => {
	test('a default-branch workflow subscribed to deployments.failed starts on that event', async () => {
		const r = repo();
		const body = JSON.stringify({ ref: 'refs/heads/main', after: 'f'.repeat(40), commits: [] });
		const sig = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
		await core.pipelines.handleGithubWebhook(r.id, body, sig, 'push');
		const claim = (await engine.claim(nodeId, labels)) as PipelineResolveClaim;
		engine.resolveTrigger(engine.authenticateTrigger(claim.token), {
			sha: 'f'.repeat(40),
			files: [
				{
					path: '.yoal/workflows/on-fail.yml',
					content: 'on: { yoal_event: { types: [deployments.failed] } }\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n',
				},
			],
		});
		expect(core.pipelines.onPlatformEvent('org_1', 'deployments.created', {})).toBe(0);
		expect(core.pipelines.onPlatformEvent('org_1', 'deployments.failed', { projectId: 'p' })).toBe(1);
		const next = (await engine.claim(nodeId, labels)) as PipelineResolveClaim;
		expect(next.kind).toBe('resolve');
		const runIds = engine.resolveTrigger(engine.authenticateTrigger(next.token), {
			sha: 'f'.repeat(40),
			files: [
				{
					path: '.yoal/workflows/on-fail.yml',
					content: 'on: { yoal_event: { types: [deployments.failed] } }\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n',
				},
			],
		});
		expect(runIds).toHaveLength(1);
		const run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.event).toBe('yoal_event');
	});
});

describe('reusable workflows', () => {
	test('a caller is replaced by the callee jobs; inputs, secrets and outputs flow through', async () => {
		const r = repo();
		core.pipelines.setSecret(owner, r.name, 'DEPLOY_KEY', { value: 'k1' });
		core.pipelines.setSecret(owner, r.name, 'OTHER', { value: 'o1' });
		const caller = `
on: workflow_dispatch
jobs:
  prep: { runs-on: linux, outputs: { v: "\${{ steps.x.outputs.v }}" }, steps: [{ id: x, run: echo }] }
  ship:
    needs: prep
    uses: ./.yoal/workflows/deploy.yml
    with: { version: "\${{ needs.prep.outputs.v }}", dry: true }
    secrets: { KEY: "\${{ secrets.DEPLOY_KEY }}" }
  after: { needs: ship, runs-on: linux, steps: [{ run: echo }] }
`;
		const callee = `
on:
  workflow_call:
    inputs:
      version: { type: string, required: true }
      dry: { type: boolean }
    outputs:
      url: { value: "\${{ jobs.release.outputs.url }}" }
jobs:
  build: { runs-on: linux, steps: [{ run: echo }] }
  release: { needs: build, runs-on: linux, outputs: { url: "\${{ steps.r.outputs.url }}" }, steps: [{ id: r, run: echo }] }
`;
		core.pipelines.dispatch(owner, r.name, { workflow: 'ci.yml', ref: 'main', inputs: {} });
		const resolve = (await engine.claim(nodeId, labels)) as PipelineResolveClaim;
		const runIds = engine.resolveTrigger(engine.authenticateTrigger(resolve.token), {
			sha: 'a'.repeat(40),
			files: [
				{ path: '.yoal/workflows/ci.yml', content: caller },
				{ path: '.yoal/workflows/deploy.yml', content: callee },
			],
		});
		expect(runIds).toHaveLength(1);
		let run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.error ?? null).toBeNull();
		expect(run.jobs.map((job) => job.key)).toEqual(['prep', 'ship--build', 'ship--release', 'after']);

		finish((await claimJob())!, 'success', { v: '1.4.2' });
		const build = (await claimJob())!;
		expect(build.job.key).toBe('ship--build');
		expect(build.context.inputs).toEqual({ version: '1.4.2', dry: true });
		expect(build.secretNames).toEqual(['KEY']);
		expect(await engine.secrets(engine.authenticateJob(build.token))).toEqual({ KEY: 'k1' });
		expect('callWith' in build.job).toBe(false);
		finish(build);
		finish((await claimJob())!, 'success', { url: 'https://x.test' });
		const after = (await claimJob())!;
		expect(after.job.key).toBe('after');
		expect(after.context.needs?.ship).toEqual({ result: 'success', outputs: { url: 'https://x.test' } });
		finish(after);
		run = await core.pipelines.getRun(owner, r.name, runIds[0]!);
		expect(run.conclusion).toBe('success');
	});
});

describe('resource-scoped access', () => {
	test('a pipelineRepository binding covers only that repository', () => {
		const scopedOwner = buildPrincipal({
			kind: 'user',
			userId: 'user_scope_owner',
			orgId: 'org_scope',
			role: 'owner',
		});
		const create = (name: string) =>
			core.pipelines.createRepository(scopedOwner, {
				name,
				cloneUrl: `https://github.com/acme/${name}.git`,
				provider: 'github',
				defaultBranch: 'main',
			});
		const visible = create('scope-visible');
		const hidden = create('scope-hidden');

		core.ctx.iam.bind(scopedOwner, {
			principalType: 'user',
			principalId: 'user_scope_owner',
			roleId: 'owner',
			scope: { type: 'org' },
		});
		core.ctx.iam.bind(scopedOwner, {
			principalType: 'user',
			principalId: 'user_pipeline_guest',
			roleId: 'viewer',
			scope: { type: 'pipelineRepository', id: visible.id },
		});

		const guest = buildPrincipal({
			kind: 'user',
			userId: 'user_pipeline_guest',
			orgId: 'org_scope',
			role: 'viewer',
		});
		expect(core.pipelines.getRepository(guest, visible.name).id).toBe(visible.id);
		expect(core.pipelines.listRuns(guest, visible.name)).toEqual([]);
		expect(() => core.pipelines.getRepository(guest, hidden.name)).toThrow(/build:read/);
		expect(() => core.pipelines.listRuns(guest, hidden.name)).toThrow(/build:read/);
	});
});

describe('per-repository pipeline service accounts (IAM §7.2)', () => {
	/** The organization row is normally written by Better Auth; this suite has no auth tables. */
	function ensureOrg(suffix: string) {
		opened.sqlite.run(
			'CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT, createdAt TEXT)',
		);
		opened.sqlite.run(
			"INSERT OR REPLACE INTO organization (id, name, slug, createdAt) VALUES ('org_1', 'Acme', ?, '2026-01-01T00:00:00.000Z')",
			[`acme-${suffix}`],
		);
	}

	async function project(slug: string) {
		await core.projects.create(owner, {
			name: slug,
			slug,
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		return core.projects.requireRow(owner, slug);
	}

	async function deployJob(repositoryName: string) {
		const { runIds } = await dispatchInline(
			repositoryName,
			'on: workflow_dispatch\njobs:\n  deploy: { runs-on: linux, steps: [{ run: echo }] }\n',
		);
		return { job: (await claimJob())!, runId: runIds[0]! };
	}

	function bindingsFor(serviceAccountId: string) {
		return opened.sqlite
			.query<{ role_id: string; scope_type: string; scope_id: string | null }, [string]>(
				`SELECT role_id, scope_type, scope_id FROM iam_bindings
				  WHERE principal_type = 'serviceAccount' AND principal_id = ?`,
			)
			.all(serviceAccountId);
	}

	function rolePermissions(roleId: string): string[] {
		const row = opened.sqlite
			.query<{ permissions_json: string }, [string]>('SELECT permissions_json FROM iam_roles WHERE id = ?')
			.get(roleId);
		return row ? (JSON.parse(row.permissions_json) as string[]) : [];
	}

	test('repository creation seeds pipeline-<repo> and least-privilege bindings', async () => {
		ensureOrg('seed');
		const r = repo();
		const row = core.pipelines.requireRepository(owner, r.name);
		expect(row.serviceAccountId).toBeTruthy();

		const account = opened.sqlite
			.query<{ id: string; name: string }, [string]>('SELECT id, name FROM service_accounts WHERE id = ?')
			.get(row.serviceAccountId!);
		expect(account?.name).toBe(`pipeline-${r.name}`);

		const bindings = bindingsFor(row.serviceAccountId!);
		const repositoryBinding = bindings.find((binding) => binding.scope_type === 'pipelineRepository');
		expect(repositoryBinding?.scope_id).toBe(r.id);
		expect(new Set(rolePermissions(repositoryBinding!.role_id))).toEqual(
			new Set(['pipeline:read', 'pipeline:dispatch', 'pipeline:cancel', 'pipeline:manage', 'pipeline:approve']),
		);

		const imageBinding = bindings.find((binding) => binding.scope_type === 'repository');
		expect(imageBinding?.scope_id).toBe(`acme-seed/${r.name}`);
		expect(rolePermissions(imageBinding!.role_id)).toEqual(['image:push']);

		const p = await project(`shop-${++counter}`);
		core.pipelines.linkProject(owner, r.name, p.slug, { environment: null });
		const linked = bindingsFor(row.serviceAccountId!).find(
			(binding) => binding.scope_type === 'project' && binding.scope_id === p.id,
		);
		expect(linked).toBeTruthy();
		expect(new Set(rolePermissions(linked!.role_id))).toEqual(new Set(['deployment:create', 'project:update']));

		// Removing the deploy target removes the provisioned project binding with it.
		core.pipelines.unlinkProject(owner, r.name, p.slug);
		expect(bindingsFor(row.serviceAccountId!).some((binding) => binding.scope_type === 'project')).toBe(false);
	});

	test('a trusted run deploys as the service account with actingFor the creator', async () => {
		ensureOrg('deploy');
		const r = repo();
		const p = await project(`deploy-${++counter}`);
		core.pipelines.linkProject(owner, r.name, p.slug, { environment: null });
		const { job, runId } = await deployJob(r.name);
		const serviceAccountId = core.pipelines.requireRepository(owner, r.name).serviceAccountId!;

		// A job principal gets the account's bindings, not the creator's role. The empty permission
		// set proves the old `system`/owner fallback is gone.
		const jobPrincipal: Principal = { kind: 'job', userId: job.jobId, orgId: 'org_1', role: 'owner', permissions: new Set() };
		expect(core.ctx.iam.can(jobPrincipal, 'deployment:create', { type: 'project', id: p.id })).toBe(true);

		const start = await engine.startDeploy(engine.authenticateJob(job.token), {
			project: p.slug,
			archive: true,
			promote: false,
		});
		expect(start.uploadUrl).toBeTruthy();
		const zip = zipSync({ 'index.html': new TextEncoder().encode('<h1>pipeline</h1>') });
		await store.put(`pipelines/${r.id}/${runId}/deploys/${start.deployId}.zip`, zip);
		const result = await engine.finalizeDeploy(engine.authenticateJob(job.token), start.deployId);
		expect(result.deploymentId).toBeTruthy();

		const audit = opened.sqlite
			.query<{ actor_id: string; credential_id: string | null; acting_for_type: string | null; acting_for_id: string | null }, []>(
				"SELECT actor_id, credential_id, acting_for_type, acting_for_id FROM audit_log WHERE action = 'pipeline.deploy' ORDER BY rowid DESC LIMIT 1",
			)
			.get();
		expect(audit?.actor_id).toBe(serviceAccountId);
		expect(audit?.credential_id).toBe('job');
		expect(audit?.acting_for_type).toBe('user');
		expect(audit?.acting_for_id).toBe('user_1');
	});

	test('a removed creator no longer blocks the repository automation', async () => {
		ensureOrg('removed');
		const r = repo();
		const p = await project(`removed-${++counter}`);
		core.pipelines.linkProject(owner, r.name, p.slug, { environment: null });
		const { job, runId } = await deployJob(r.name);

		// Simulate a leaver: the run still names them, but they hold no membership or bindings.
		opened.sqlite.run("UPDATE pipeline_runs SET created_by = 'user_left' WHERE id = ?", [runId]);
		core.ctx.iam.removeUserBindings('org_1', 'user_left');

		const start = await engine.startDeploy(engine.authenticateJob(job.token), {
			project: p.slug,
			archive: true,
			promote: false,
		});
		const zip = zipSync({ 'index.html': new TextEncoder().encode('<h1>still ships</h1>') });
		await store.put(`pipelines/${r.id}/${runId}/deploys/${start.deployId}.zip`, zip);
		const result = await engine.finalizeDeploy(engine.authenticateJob(job.token), start.deployId);
		expect(result.deploymentId).toBeTruthy();

		const audit = opened.sqlite
			.query<{ acting_for_id: string | null }, []>(
				"SELECT acting_for_id FROM audit_log WHERE action = 'pipeline.deploy' ORDER BY rowid DESC LIMIT 1",
			)
			.get();
		expect(audit?.acting_for_id).toBe('user_left');
	});

	test('a project that is not a deploy target is denied even though the run is trusted', async () => {
		ensureOrg('unlinked');
		const r = repo();
		const linked = await project(`linked-${++counter}`);
		const unlinked = await project(`unlinked-${++counter}`);
		core.pipelines.linkProject(owner, r.name, linked.slug, { environment: null });
		const { job } = await deployJob(r.name);
		const serviceAccountId = core.pipelines.requireRepository(owner, r.name).serviceAccountId!;
		const account: Principal = {
			kind: 'serviceAccount',
			userId: serviceAccountId,
			orgId: 'org_1',
			role: 'viewer',
			permissions: new Set(),
		};
		expect(core.ctx.iam.can(account, 'deployment:create', { type: 'project', id: linked.id })).toBe(true);
		expect(core.ctx.iam.can(account, 'deployment:create', { type: 'project', id: unlinked.id })).toBe(false);

		await expect(
			engine.startDeploy(engine.authenticateJob(job.token), { project: unlinked.slug, archive: true, promote: false }),
		).rejects.toThrow(/not linked/);
	});
});
