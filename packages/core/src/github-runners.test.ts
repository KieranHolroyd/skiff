import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { GITHUB_RUNNER_JITCONFIG_ENV } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { githubAppJwt } from './github-runners.ts';
import { aggregateReplicaReports } from './workloads.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-runners-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');

interface Call {
	method: string;
	url: string;
	auth: string;
	body: Record<string, unknown> | null;
}
const calls: Call[] = [];
let nextRunnerId = 100;
let failWith: { status: number; message: string } | null = null;

const githubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = String(input);
	const method = init?.method ?? 'GET';
	const headers = new Headers(init?.headers);
	const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
	calls.push({ method, url, auth: headers.get('authorization') ?? '', body });
	if (failWith) return Response.json({ message: failWith.message }, { status: failWith.status });
	if (url.endsWith('/generate-jitconfig')) {
		const id = nextRunnerId++;
		return Response.json(
			{ runner: { id, name: body?.name, status: 'offline', busy: false }, encoded_jit_config: `jit-${id}` },
			{ status: 201 },
		);
	}
	if (url.includes('/access_tokens'))
		return Response.json({ token: 'ghs_installation', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
	if (method === 'DELETE') return new Response(null, { status: 204 });
	if (url.includes('/actions/runners?'))
		return Response.json({
			total_count: 1,
			runners: [{ id: nextRunnerId - 1, name: 'x', status: 'online', busy: true, labels: [{ name: 'self-hosted' }] }],
		});
	return Response.json({ message: 'Not Found' }, { status: 404 });
}) as typeof fetch;

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
		githubFetch,
	},
});

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	calls.length = 0;
	failWith = null;
});

describe('GitHub Actions runner template', () => {
	let nodeToken = '';
	let nodeId = '';

	test('setup: an edge node with room for a runner pool', () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'edge').token, name: 'edge' });
		nodeToken = joined.token;
		nodeId = joined.nodeId;
		core.nodes.update(principal, nodeId, { sliceMemoryMb: 8192 });
	});

	test('lists the catalog', () => {
		expect(core.templates.list(principal).map((template) => template.id)).toEqual(['github-actions-runner']);
	});

	test('creates the project, a suffixed secret, the spec and a deployment', async () => {
		const result = await core.templates.instantiate(principal, 'github-actions-runner', {
			name: 'CI runners',
			slug: 'ci-runners',
			placement: 'edge',
			owner: 'acme',
			repo: 'api',
			labels: 'gpu',
			replicas: 2,
			memoryMb: 1024,
			token: 'github_pat_abc',
		});
		expect(result.project.slug).toBe('ci-runners');
		expect(result.secrets).toEqual(['GITHUB_RUNNER_TOKEN_CI_RUNNERS']);
		const project = core.projects.requireRow(principal, 'ci-runners');
		const spec = core.workloads.projectSpec(project)!;
		expect(spec.runner?.auth).toEqual({ method: 'pat', tokenSecret: 'GITHUB_RUNNER_TOKEN_CI_RUNNERS' });
		expect(spec.ingress).toBe('none');
		// The token is a control-plane secret only: never an env var or secret ref of the container.
		expect(spec.secrets).toEqual([]);
		const view = core.workloads.get(principal, project)!;
		expect(view.replicas).toBe(2);
		expect(view.memoryMb).toBe(2048);
		expect(view.upstream).toBe('none');
	});

	test('desired state has one entry per replica and no route', async () => {
		const state = await core.nodes.desiredState(nodeToken);
		const runners = state.workloads.filter((workload) => workload.projectSlug === 'ci-runners');
		expect(runners.map((workload) => workload.id)).toEqual([runners[0]!.id, `${runners[0]!.id}-r1`]);
		for (const runner of runners) {
			expect(runner.ingress).toBe('none');
			expect(runner.runner).toEqual({ provider: 'github' });
			expect(runner.memoryMb).toBe(1024);
			expect(runner.socketActivation).toBe(false);
			expect(JSON.stringify(runner)).not.toContain('github_pat_abc');
		}
		expect(state.routes.some((route) => route.slug === 'ci-runners')).toBe(false);
	});

	test('each activation mints a fresh JIT config and removes the replica’s previous runner', async () => {
		const state = await core.nodes.desiredState(nodeToken);
		const replica = state.workloads.find((workload) => workload.id.endsWith('-r1'))!;

		const first = await core.workloads.activationFor(nodeId, replica.id);
		expect(first.workloadId).toBe(replica.id);
		expect(first.activationVersion).toBe(replica.activationVersion);
		expect(first.env[GITHUB_RUNNER_JITCONFIG_ENV]).toMatch(/^jit-\d+$/);
		expect(Object.values(first.env)).not.toContain('github_pat_abc');
		const mint = calls.find((call) => call.url.endsWith('/generate-jitconfig'))!;
		expect(mint.url).toBe('https://api.github.com/repos/acme/api/actions/runners/generate-jitconfig');
		expect(mint.auth).toBe('Bearer github_pat_abc');
		expect(mint.body?.labels).toEqual(['self-hosted', 'linux', 'gpu']);
		expect(String(mint.body?.name)).toStartWith('skiff-ci-runners-1-');

		calls.length = 0;
		const second = await core.workloads.activationFor(nodeId, replica.id);
		expect(second.env[GITHUB_RUNNER_JITCONFIG_ENV]).not.toBe(first.env[GITHUB_RUNNER_JITCONFIG_ENV]);
		const firstId = Number(first.env[GITHUB_RUNNER_JITCONFIG_ENV]!.slice(4));
		expect(calls[0]).toMatchObject({ method: 'DELETE', url: `https://api.github.com/repos/acme/api/actions/runners/${firstId}` });
	});

	test('a GitHub failure is recorded on the workload and surfaces to the agent', async () => {
		const state = await core.nodes.desiredState(nodeToken);
		const replica = state.workloads.find((workload) => workload.projectSlug === 'ci-runners')!;
		failWith = { status: 401, message: 'Bad credentials' };
		await expect(core.workloads.activationFor(nodeId, replica.id)).rejects.toThrow('GitHub rejected the credential');
		const project = core.projects.requireRow(principal, 'ci-runners');
		expect(core.workloads.get(principal, project)?.message).toContain('Runner: GitHub rejected');
		failWith = null;
		await core.workloads.activationFor(nodeId, replica.id);
		expect(core.workloads.get(principal, project)?.message).toBeNull();
	});

	test('replica logs are stored on the pool’s project, tagged with the replica', () => {
		const project = core.projects.requireRow(principal, 'ci-runners');
		const id = core.workloads.get(principal, project)!.id;
		const stored = core.logs.appendRuntime(nodeId, {
			workloadId: `${id}-r1`,
			lines: [{ ts: Date.now(), stream: 'stdout', level: 'info', message: 'Listening for Jobs' }],
		});
		expect(stored).toBe(1);
		const row = opened.sqlite
			.query<{ message: string }, [string]>(
				"SELECT message FROM log_events WHERE project_id = ? AND source = 'runtime' ORDER BY ts DESC LIMIT 1",
			)
			.get(project.id);
		expect(row?.message).toBe('[r1] Listening for Jobs');
	});

	test('a replica index beyond the pool is refused', () => {
		const project = core.projects.requireRow(principal, 'ci-runners');
		const id = core.workloads.get(principal, project)!.id;
		expect(() => core.workloads.activation(nodeId, `${id}-r5`)).toThrow();
	});

	test('the pool view matches registrations to GitHub', async () => {
		const project = core.projects.requireRow(principal, 'ci-runners');
		const pool = (await core.workloads.runnerPool(principal, project))!;
		expect(pool.target).toBe('acme/api');
		expect(pool.error).toBeNull();
		expect(pool.runners.length).toBeGreaterThan(0);
		expect(pool.runners.some((runner) => runner.busy && runner.status === 'online')).toBe(true);
	});

	test('a missing existing secret refuses before anything is created', async () => {
		await expect(
			core.templates.instantiate(principal, 'github-actions-runner', {
				name: 'Org runners',
				slug: 'org-runners',
				scope: 'org',
				owner: 'acme',
				existingSecret: 'NOPE_TOKEN',
			}),
		).rejects.toThrow('NOPE_TOKEN');
		expect(() => core.projects.requireRow(principal, 'org-runners')).toThrow();
	});

	test('a failed deploy purges the half-made project and its secret', async () => {
		await expect(
			core.templates.instantiate(principal, 'github-actions-runner', {
				name: 'Too big',
				slug: 'too-big',
				placement: 'edge',
				owner: 'acme',
				repo: 'api',
				replicas: 20,
				memoryMb: 8192,
				token: 'github_pat_big',
			}),
		).rejects.toThrow();
		expect(() => core.projects.requireRow(principal, 'too-big', { includeDeleted: true })).toThrow();
		expect(core.secrets.getValue('org_1', 'GITHUB_RUNNER_TOKEN_TOO_BIG')).toBeNull();
	});

	test('purging the project deregisters its runners on GitHub', async () => {
		await core.projects.softDelete(principal, 'ci-runners');
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
	});
});

describe('GitHub App auth', () => {
	test('signs an RS256 JWT GitHub accepts', () => {
		const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
		const jwt = githubAppJwt(42, pem, 1_700_000_000_000);
		const [header, payload, signature] = jwt.split('.');
		expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
		expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
			iat: 1_700_000_000 - 60,
			exp: 1_700_000_000 + 540,
			iss: '42',
		});
		const verifier = createVerify('RSA-SHA256');
		verifier.update(`${header}.${payload}`);
		expect(verifier.verify(publicKey, signature!, 'base64url')).toBe(true);
	});

	test('rejects a key that is not PEM', () => {
		expect(() => githubAppJwt(1, 'not a key', Date.now())).toThrow('private key');
	});

	test('exchanges the JWT for an installation token and uses it to mint', async () => {
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
		const joined = core.nodes.list(principal)[0]!;
		const result = await core.templates.instantiate(principal, 'github-actions-runner', {
			name: 'App runners',
			slug: 'app-runners',
			placement: 'edge',
			scope: 'org',
			owner: 'acme',
			runnerGroupId: 3,
			replicas: 1,
			memoryMb: 512,
			auth: 'app',
			appId: 42,
			installationId: 7,
			privateKey: pem,
		});
		expect(result.secrets).toEqual(['GITHUB_APP_PRIVATE_KEY_APP_RUNNERS']);
		const project = core.projects.requireRow(principal, 'app-runners');
		const id = core.workloads.get(principal, project)!.id;
		calls.length = 0;
		await core.workloads.activationFor(joined.id, id);
		expect(calls[0]?.url).toBe('https://api.github.com/app/installations/7/access_tokens');
		expect(calls[0]?.auth).toMatch(/^Bearer ey/);
		const mint = calls.find((call) => call.url.endsWith('/generate-jitconfig'))!;
		expect(mint.url).toBe('https://api.github.com/orgs/acme/actions/runners/generate-jitconfig');
		expect(mint.auth).toBe('Bearer ghs_installation');
		expect(mint.body?.runner_group_id).toBe(3);
		// The installation token is cached for the next replica start.
		calls.length = 0;
		await core.workloads.activationFor(joined.id, id);
		expect(calls.some((call) => call.url.includes('/access_tokens'))).toBe(false);
	});
});

describe('replica report aggregation', () => {
	test('worst status wins and restarts take the maximum', () => {
		expect(
			aggregateReplicaReports([
				{ id: 'wld_a', status: 'running', restarts: 0 },
				{ id: 'wld_a-r1', status: 'starting', restarts: 2 },
				{ id: 'wld_b', status: 'running', restarts: 1 },
			]),
		).toEqual([
			{ id: 'wld_a', status: 'starting', restarts: 2 },
			{ id: 'wld_b', status: 'running', restarts: 1 },
		]);
	});
});
