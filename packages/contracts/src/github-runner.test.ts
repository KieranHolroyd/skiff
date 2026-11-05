import { describe, expect, test } from 'bun:test';
import { githubRunnerLabels, githubRunnerSchema } from './github-runner.ts';
import {
	GITHUB_RUNNER_PAT_SECRET,
	buildAppTemplate,
	getAppTemplate,
	listAppTemplates,
} from './templates.ts';
import {
	parseWorkloadReplicaId,
	workloadDesiredSchema,
	workloadReplicaId,
	workloadSpecSchema,
} from './workload.ts';

const runner = {
	provider: 'github',
	scope: 'repo',
	owner: 'acme',
	repo: 'api',
	auth: { method: 'pat', tokenSecret: 'GITHUB_RUNNER_TOKEN' },
} as const;

describe('worker workload spec', () => {
	test('defaults keep existing specs as single-replica http workloads', () => {
		const spec = workloadSpecSchema.parse({ runtime: 'process' });
		expect(spec.ingress).toBe('http');
		expect(spec.replicas).toBe(1);
		expect(spec.runner).toBeUndefined();
	});

	test('replicas need a worker', () => {
		expect(workloadSpecSchema.safeParse({ runtime: 'container', image: 'x', replicas: 2 }).success).toBe(false);
		expect(
			workloadSpecSchema.safeParse({ runtime: 'container', image: 'x', replicas: 2, ingress: 'none' }).success,
		).toBe(true);
	});

	test('a runner must be a container worker without a data dir', () => {
		expect(workloadSpecSchema.safeParse({ runtime: 'container', image: 'x', ingress: 'none', runner }).success).toBe(true);
		expect(workloadSpecSchema.safeParse({ runtime: 'container', image: 'x', runner }).success).toBe(false);
		expect(workloadSpecSchema.safeParse({ runtime: 'process', ingress: 'none', runner }).success).toBe(false);
		expect(
			workloadSpecSchema.safeParse({ runtime: 'container', image: 'x', ingress: 'none', runner, data: { sizeMb: 64 } })
				.success,
		).toBe(false);
	});

	test('desired state carries the worker profile additively', () => {
		const parsed = workloadDesiredSchema.parse({
			id: 'wld_1-r1',
			projectId: 'prj_1',
			projectSlug: 'ci',
			deploymentId: 'dep_1',
			runtime: 'container',
			status: 'pending',
			release: null,
			image: 'ghcr.io/actions/actions-runner:latest',
			upstream: 'none',
			memoryMb: 512,
			cpus: 1,
			port: 3000,
			healthPath: '/',
			socketActivation: false,
			activationVersion: 'a'.repeat(64),
			ingress: 'none',
			runner: { provider: 'github' },
			replica: { index: 1 },
		});
		expect(parsed.replica).toEqual({ index: 1 });
	});

	test('replica ids round-trip', () => {
		expect(workloadReplicaId('wld_abc', 0)).toBe('wld_abc');
		expect(workloadReplicaId('wld_abc', 3)).toBe('wld_abc-r3');
		expect(parseWorkloadReplicaId('wld_abc-r3')).toEqual({ workloadId: 'wld_abc', replica: 3 });
		expect(parseWorkloadReplicaId('wld_abc')).toEqual({ workloadId: 'wld_abc', replica: 0 });
		expect(parseWorkloadReplicaId('wld_abc-r0')).toEqual({ workloadId: 'wld_abc-r0', replica: 0 });
	});
});

describe('github runner config', () => {
	test('repo scope needs a repo; org scope rejects one', () => {
		expect(githubRunnerSchema.safeParse({ ...runner, repo: undefined }).success).toBe(false);
		expect(githubRunnerSchema.safeParse({ ...runner, scope: 'org' }).success).toBe(false);
		expect(githubRunnerSchema.safeParse({ ...runner, scope: 'org', repo: undefined, runnerGroupId: 3 }).success).toBe(true);
	});

	test('labels always include self-hosted and linux once', () => {
		expect(githubRunnerLabels({ labels: ['Linux', 'X64', 'gpu'] })).toEqual(['self-hosted', 'linux', 'X64', 'gpu']);
	});
});

describe('template catalog', () => {
	test('lists the GitHub runner template', () => {
		expect(listAppTemplates().map((template) => template.id)).toContain('github-actions-runner');
		expect(getAppTemplate('nope')).toBeNull();
	});

	test('a PAT becomes a project secret and never reaches the manifest', () => {
		const plan = buildAppTemplate('github-actions-runner', {
			name: 'CI',
			owner: 'acme',
			repo: 'api',
			labels: 'gpu, X64',
			replicas: '3',
			token: 'github_pat_secret',
		})!;
		expect(plan.secrets).toEqual([{ name: GITHUB_RUNNER_PAT_SECRET, value: 'github_pat_secret' }]);
		expect(plan.spec.replicas).toBe(3);
		expect(plan.spec.ingress).toBe('none');
		expect(plan.spec.runner?.labels).toEqual(['gpu', 'X64']);
		expect(JSON.stringify(plan.manifest)).not.toContain('github_pat_secret');
		expect(workloadSpecSchema.safeParse(plan.spec).success).toBe(true);
	});

	test('a GitHub App can reference an existing key secret', () => {
		const plan = buildAppTemplate('github-actions-runner', {
			name: 'Org runners',
			scope: 'org',
			owner: 'acme',
			auth: 'app',
			appId: '12',
			installationId: 34,
			existingSecret: 'ORG_APP_KEY',
		})!;
		expect(plan.secrets).toEqual([]);
		expect(plan.requiredSecrets).toEqual(['ORG_APP_KEY']);
		expect(plan.spec.runner?.auth).toEqual({
			method: 'app',
			appId: 12,
			installationId: 34,
			privateKeySecret: 'ORG_APP_KEY',
		});
	});

	test('needs exactly one credential source', () => {
		expect(() => buildAppTemplate('github-actions-runner', { name: 'x', owner: 'acme', repo: 'api' })).toThrow();
		expect(() =>
			buildAppTemplate('github-actions-runner', {
				name: 'x',
				owner: 'acme',
				repo: 'api',
				token: 't',
				existingSecret: 'T',
			}),
		).toThrow();
	});
});
