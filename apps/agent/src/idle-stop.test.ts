import { describe, expect, test } from 'bun:test';
import { workloadDesiredSchema, type WorkloadDesired } from '@skiff/contracts';
import { isIdleStoppable } from './runtime.ts';

/** A stopped unit that scales to zero is steady state, not an outage to retry (FN4, D121). */
describe('isIdleStoppable', () => {
	const process = (extra: Record<string, unknown> = {}): WorkloadDesired =>
		workloadDesiredSchema.parse({
			id: 'wld_p',
			projectId: 'prj_p',
			projectSlug: 'p',
			deploymentId: 'dep_p',
			runtime: 'process',
			status: 'running',
			release: 'a'.repeat(64),
			upstream: 'unix//run/skiff-workloads/prj_p.sock',
			memoryMb: 128,
			cpus: 1,
			port: 3000,
			healthPath: '/',
			socketActivation: true,
			activationVersion: 'b'.repeat(64),
			dataSizeMb: null,
			...extra,
		});

	test('a socket-activated process app with idleStopSeconds', () => {
		expect(isIdleStoppable(process({ idleStopSeconds: 60 }))).toBe(true);
	});

	test('not without idleStopSeconds, without a socket, or for containers', () => {
		expect(isIdleStoppable(process())).toBe(false);
		expect(isIdleStoppable(process({ idleStopSeconds: 60, socketActivation: false }))).toBe(false);
		expect(isIdleStoppable(process({ idleStopSeconds: 60, runtime: 'container', image: 'x' }))).toBe(false);
		expect(isIdleStoppable(undefined)).toBe(false);
	});
});
