import { describe, expect, test } from 'bun:test';
import { workloadDesiredSchema } from './workload.ts';

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
