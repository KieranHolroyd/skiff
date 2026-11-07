import { describe, expect, test } from 'bun:test';
import { workloadDesiredSchema, workloadSpecSchema } from './workload.ts';

/** Scale to zero for process apps (D121). */
describe('workload spec idleStopSeconds', () => {
	const base = { runtime: 'process' as const, command: ['frankenphp', 'run'] };

	test('a socket-activated HTTP process app may scale to zero', () => {
		const spec = workloadSpecSchema.parse({ ...base, idleStopSeconds: 300 });
		expect(spec.idleStopSeconds).toBe(300);
		expect(spec.socketActivation).toBe(true);
	});

	test('absent and 0 both mean always on', () => {
		expect(workloadSpecSchema.parse(base).idleStopSeconds).toBeUndefined();
		expect(workloadSpecSchema.parse({ ...base, idleStopSeconds: 0 }).idleStopSeconds).toBe(0);
		// A 0 with no socket is not an error: there is nothing to scale.
		expect(workloadSpecSchema.safeParse({ ...base, socketActivation: false, idleStopSeconds: 0 }).success).toBe(true);
	});

	test('needs socket activation', () => {
		const result = workloadSpecSchema.safeParse({ ...base, socketActivation: false, idleStopSeconds: 300 });
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(['socketActivation']);
		expect(result.error?.issues[0]?.message).toContain('socket activation');
	});

	test('is refused for workers, replicas, containers and functions', () => {
		const worker = workloadSpecSchema.safeParse({ ...base, ingress: 'none', idleStopSeconds: 60 });
		expect(worker.error?.issues[0]?.message).toContain('HTTP ingress');
		const replicas = workloadSpecSchema.safeParse({ ...base, replicas: 2, idleStopSeconds: 60 });
		expect(replicas.error?.issues.map((issue) => issue.path[0])).toContain('replicas');
		const container = workloadSpecSchema.safeParse({ runtime: 'container', image: 'php:8.4', idleStopSeconds: 60 });
		expect(container.error?.issues[0]?.message).toContain('containers are always on');
	});

	test('is capped at a day', () => {
		expect(workloadSpecSchema.safeParse({ ...base, idleStopSeconds: 86_401 }).success).toBe(false);
	});

	test('desired state carries it only when set', () => {
		const desired = {
			id: 'wld_a',
			projectId: 'prj_a',
			projectSlug: 'a',
			deploymentId: 'dep_a',
			runtime: 'process',
			status: 'running',
			release: 'a'.repeat(64),
			upstream: 'unix//run/skiff-workloads/prj_a.sock',
			memoryMb: 128,
			cpus: 1,
			port: 3000,
			healthPath: '/',
			socketActivation: true,
			activationVersion: 'b'.repeat(64),
			dataSizeMb: null,
		};
		expect(workloadDesiredSchema.parse(desired).idleStopSeconds).toBeUndefined();
		expect(workloadDesiredSchema.parse({ ...desired, idleStopSeconds: 90 }).idleStopSeconds).toBe(90);
		expect(workloadDesiredSchema.safeParse({ ...desired, idleStopSeconds: 0 }).success).toBe(false);
	});
});
