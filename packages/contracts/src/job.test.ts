import { describe, expect, test } from 'bun:test';
import {
	agentJobResultSchema,
	agentJobRunSchema,
	jobCommandSchema,
	jobCreateSchema,
	jobOneOffSchema,
	jobRunDone,
	jobUpdateSchema,
} from './job.ts';

describe('job schemas', () => {
	test('create defaults to a manual, forbidding, 10-minute job with no retries', () => {
		expect(jobCreateSchema.parse({ name: 'cleanup', command: ['bun', 'run', 'cleanup'] })).toEqual({
			name: 'cleanup',
			command: ['bun', 'run', 'cleanup'],
			schedule: null,
			timeoutSeconds: 600,
			concurrency: 'forbid',
			maxRetries: 0,
			enabled: true,
		});
		expect(jobCreateSchema.parse({ name: 'cleanup', command: ['true'], schedule: '0 3 * * *' }).schedule).toBe('0 3 * * *');
		expect(jobCreateSchema.parse({ name: 'cleanup', command: ['true'], concurrency: 'replace' }).concurrency).toBe('replace');
	});

	test('commands are argv, never a shell string', () => {
		expect(jobCommandSchema.parse(['bun', 'run', 'cleanup --all'])).toEqual(['bun', 'run', 'cleanup --all']);
		expect(jobCommandSchema.safeParse([]).success).toBe(false);
		expect(jobCommandSchema.safeParse('bun run cleanup').success).toBe(false);
		expect(jobCommandSchema.safeParse(['echo', 'a\nb']).success).toBe(false);
	});

	test('names, cron, limits and unknown keys are validated', () => {
		expect(jobCreateSchema.safeParse({ name: 'Clean', command: ['true'] }).success).toBe(false);
		expect(jobCreateSchema.safeParse({ name: 'a--b', command: ['true'] }).success).toBe(false);
		expect(jobCreateSchema.safeParse({ name: 'cleanup', command: ['true'], schedule: 'every minute' }).success).toBe(false);
		expect(jobCreateSchema.safeParse({ name: 'cleanup', command: ['true'], schedule: '0 3 * *' }).success).toBe(false);
		expect(jobCreateSchema.safeParse({ name: 'cleanup', command: ['true'], timeoutSeconds: 5 }).success).toBe(false);
		expect(jobCreateSchema.safeParse({ name: 'cleanup', command: ['true'], maxRetries: 11 }).success).toBe(false);
		expect(jobCreateSchema.safeParse({ name: 'cleanup', command: ['true'], timezone: 'UTC' }).success).toBe(false);
	});

	test('update is partial and non-empty; a null schedule removes the cron', () => {
		expect(jobUpdateSchema.parse({ schedule: null })).toEqual({ schedule: null });
		expect(jobUpdateSchema.safeParse({}).success).toBe(false);
		expect(jobUpdateSchema.safeParse({ name: 'other' }).success).toBe(false);
	});

	test('one-off runs need a command and default to a 10-minute timeout', () => {
		expect(jobOneOffSchema.parse({ command: ['bun', 'run', 'migrate'] })).toEqual({ command: ['bun', 'run', 'migrate'], timeoutSeconds: 600 });
		expect(jobOneOffSchema.safeParse({}).success).toBe(false);
	});

	test('the node wire carries no env and only run ids the control plane mints', () => {
		const run = { runId: `jr_${'a'.repeat(32)}`, workloadId: 'wl_1', command: ['bun', 'run', 'cleanup'], timeoutSeconds: 300 };
		expect(agentJobRunSchema.parse(run)).toEqual(run);
		expect(agentJobRunSchema.safeParse({ ...run, env: { SECRET: 'value' } }).success).toBe(false);
		expect(agentJobRunSchema.safeParse({ ...run, runId: '../etc' }).success).toBe(false);
		expect(agentJobResultSchema.parse({ runId: run.runId, status: 'succeeded', exitCode: 0, startedAt: 1, finishedAt: 2 })).toEqual({
			runId: run.runId,
			status: 'succeeded',
			exitCode: 0,
			startedAt: 1,
			finishedAt: 2,
			error: null,
		});
	});

	test('done means finished', () => {
		expect(jobRunDone('queued')).toBe(false);
		expect(jobRunDone('running')).toBe(false);
		for (const status of ['succeeded', 'failed', 'timeout', 'cancelled', 'skipped'] as const) expect(jobRunDone(status)).toBe(true);
	});
});
