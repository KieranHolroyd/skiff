import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_WORKLOAD_NETWORK,
	orgNetworkName,
	secretRefEnvName,
	workloadDesiredSchema,
	workloadEnvIssues,
	workloadNetworkName,
	workloadsShareNetwork,
} from './workload.ts';

const base = {
	id: 'wl_1',
	projectId: 'prj_1',
	projectSlug: 'my-app',
	deploymentId: 'dep_1',
	runtime: 'process',
	status: 'running',
	release: 'a'.repeat(64),
	upstream: '127.0.0.1:3000',
	memoryMb: 256,
	cpus: 1,
	port: 3000,
	healthPath: '/',
	socketActivation: true,
	activationVersion: 'b'.repeat(64),
} as const;

describe('WorkloadDesired additive fields', () => {
	test('older desired state still parses with the defaults', () => {
		const parsed = workloadDesiredSchema.parse(base);
		expect(parsed).toMatchObject({ env: {}, secrets: [], dataSizeMb: null });
		expect(parsed.volumes).toBeUndefined();
		expect(parsed.processes).toBeUndefined();
		expect(parsed.job).toBeUndefined();
	});

	test('volumes, processes and job are optional and additive', () => {
		const parsed = workloadDesiredSchema.parse({
			...base,
			volumes: [
				{ id: 'av_1', mountPath: '/var/lib/app', readOnly: false },
				{ id: 'av_2', mountPath: '/var/lib/assets', readOnly: true },
			],
			processes: [
				{ name: 'web', command: ['bun', 'run', 'start'], port: 3000, healthPath: '/health' },
				{ name: 'worker', command: ['bun', 'run', 'worker'] },
			],
			job: { id: 'job_1', timeoutSeconds: 300 },
		});
		expect(parsed.volumes).toHaveLength(2);
		expect(parsed.volumes?.[1]).toEqual({ id: 'av_2', mountPath: '/var/lib/assets', readOnly: true });
		expect(parsed.processes?.[0]?.name).toBe('web');
		expect(parsed.job).toEqual({ id: 'job_1', timeoutSeconds: 300 });
	});

	test('unknown fields from a newer control plane are dropped, not rejected', () => {
		const parsed = workloadDesiredSchema.parse({ ...base, futureField: { enabled: true } });
		expect(parsed).not.toHaveProperty('futureField');
	});

	test('a bad mount path or job timeout is rejected', () => {
		expect(workloadDesiredSchema.safeParse({ ...base, volumes: [{ id: 'av_1', mountPath: '', readOnly: false }] }).success).toBe(
			false,
		);
		expect(workloadDesiredSchema.safeParse({ ...base, job: { id: 'job_1', timeoutSeconds: 1 } }).success).toBe(false);
	});
});

describe('per-org network derivation', () => {
	test('derives a stable org network and keeps the shared fallback', () => {
		expect(orgNetworkName('org_123')).toBe('skiff-org-org_123');
		expect(orgNetworkName('Org ABC')).toBe('skiff-org-org-abc');
		expect(workloadNetworkName({})).toBe(DEFAULT_WORKLOAD_NETWORK);
	});

	test('two orgs are isolated and same-org workloads share a network', () => {
		const a = { orgId: 'org_1' };
		const b = { orgId: 'org_2' };
		expect(workloadNetworkName(a)).not.toBe(workloadNetworkName(b));
		expect(workloadsShareNetwork(a, { orgId: 'org_1' })).toBe(true);
		expect(workloadsShareNetwork(a, b)).toBe(false);
		// Explicit names win, which is what the node protocol sends.
		expect(workloadNetworkName({ orgId: 'org_1', networkName: 'skiff-org-org_1' })).toBe('skiff-org-org_1');
	});

	test('desired state accepts the new fields and old state stays valid', () => {
		expect(workloadDesiredSchema.parse({ ...base, orgId: 'org_1' }).orgId).toBe('org_1');
		expect(workloadDesiredSchema.parse(base).orgId).toBeUndefined();
	});
});

describe('workloadEnvIssues', () => {
	test('accepts distinct plain variables and secret references', () => {
		expect(
			workloadEnvIssues({
				env: { PORT: '3000', TLS_KEY: 'not-a-clash' },
				secrets: [
					{ name: 'API_KEY', delivery: 'env' },
					{ name: 'TLS_KEY', delivery: 'file' }
				]
			})
		).toEqual([]);
		expect(secretRefEnvName({ name: 'TLS_KEY', delivery: 'file' })).toBe('TLS_KEY_FILE');
	});

	test('flags names that would be set twice', () => {
		expect(
			workloadEnvIssues({
				env: { API_KEY: 'plain', TLS_KEY_FILE: '/tmp/key' },
				secrets: [
					{ name: 'API_KEY', delivery: 'env' },
					{ name: 'API_KEY', delivery: 'env' },
					{ name: 'TLS_KEY', delivery: 'file' }
				]
			})
		).toEqual([
			'API_KEY is set both as a plain variable and by secret API_KEY. Keep one.',
			'Secret API_KEY is referenced more than once.',
			'TLS_KEY_FILE is set both as a plain variable and by secret TLS_KEY. Keep one.'
		]);
	});
});
