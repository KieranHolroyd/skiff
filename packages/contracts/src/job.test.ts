import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
	jobCommandSchema,
	jobCreateSchema,
	jobHistoryViewSchema,
	jobResultSchema,
	jobRunCreateSchema,
	jobTaskSchema,
	jobTimezoneSchema,
	jobUpdateSchema,
	jobViewSchema,
} from './job.ts';

describe('job schemas', () => {
	test('create defaults to a manual, forbidding, 5-minute job', () => {
		expect(jobCreateSchema.parse({ name: 'cleanup', command: ['bun', 'run', 'cleanup'] })).toEqual({
			name: 'cleanup',
			command: ['bun', 'run', 'cleanup'],
			schedule: null,
			timezone: 'UTC',
			timeoutSeconds: 300,
			concurrency: 'forbid',
			maxRetries: 0,
			catchUp: false,
			memoryMb: 256,
			cpus: 1,
			enabled: true,
			environment: 'production',
		});
		expect(jobCreateSchema.parse({ name: 'cleanup', command: ['true'], schedule: '0 3 * * *' }).schedule).toBe(
			'0 3 * * *',
		);
	});

	test('commands are argv, never a shell string', () => {
		expect(jobCommandSchema.parse(['bun', 'run', 'cleanup --all'])).toEqual(['bun', 'run', 'cleanup --all']);
		expect(jobCommandSchema.safeParse([]).success).toBe(false);
		expect(jobCommandSchema.safeParse('bun run cleanup').success).toBe(false);
	});

	test('cron and time zones are validated', () => {
		expect(jobCreateSchema.safeParse({ name: 'cleanup', command: ['true'], schedule: 'every minute' }).success).toBe(false);
		expect(jobCreateSchema.safeParse({ name: 'cleanup', command: ['true'], schedule: '0 3 * *' }).success).toBe(false);
		expect(jobTimezoneSchema.parse('Europe/London')).toBe('Europe/London');
		expect(jobTimezoneSchema.parse('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
		expect(jobTimezoneSchema.safeParse('Mars/Olympus').success).toBe(false);
		expect(jobTimezoneSchema.safeParse('london').success).toBe(false);
		expect(jobCreateSchema.safeParse({ name: 'cleanup', command: ['true'], unknown: 1 }).success).toBe(false);
	});

	test('update is partial and non-empty; a null schedule pauses the cron', () => {
		expect(jobUpdateSchema.parse({ schedule: null })).toEqual({ schedule: null });
		expect(jobUpdateSchema.safeParse({}).success).toBe(false);
		expect(jobUpdateSchema.safeParse({ maxRetries: 11 }).success).toBe(false);
	});

	test('run triggers are surface-attributed and deployment pins are optional', () => {
		expect(jobRunCreateSchema.parse({})).toEqual({ trigger: 'manual' });
		expect(jobRunCreateSchema.parse({ trigger: 'mcp', deploymentId: 'dep_1' })).toEqual({
			trigger: 'mcp',
			deploymentId: 'dep_1',
		});
		expect(jobRunCreateSchema.safeParse({ trigger: 'schedule' }).success).toBe(false);
	});

	test('task/result round-trip without env or secrets', () => {
		const task = {
			id: 'task_1',
			jobId: 'job_1',
			runId: 'run_1',
			projectId: 'prj_1',
			environment: 'production',
			release: 'a'.repeat(64),
			command: ['bun', 'run', 'cleanup'],
			timeoutSeconds: 300,
			memoryMb: 256,
			cpus: 1,
			volumes: [{ id: 'av_1', mountPath: '/var/lib/app', readOnly: false }],
		};
		expect(jobTaskSchema.parse(task)).toEqual(task);
		expect(jobTaskSchema.safeParse({ ...task, env: { SECRET: 'value' } }).success).toBe(false);

		const result: z.output<typeof jobResultSchema> = {
			taskId: 'task_1',
			jobId: 'job_1',
			runId: 'run_1',
			status: 'ok',
			exitCode: 0,
			startedAt: '2026-11-05T00:00:00.000Z',
			finishedAt: '2026-11-05T00:00:01.000Z',
			stdoutTail: 'done',
			stderrTail: '',
			error: null,
		};
		expect(jobResultSchema.parse(result)).toEqual(result);
	});

	test('history view round-trips', () => {
		const job: z.output<typeof jobViewSchema> = {
			id: 'job_1',
			orgId: 'org_1',
			projectId: 'prj_1',
			projectSlug: 'my-app',
			environment: 'production',
			name: 'cleanup',
			command: ['bun', 'run', 'cleanup'],
			schedule: '0 3 * * *',
			timezone: 'UTC',
			timeoutSeconds: 300,
			concurrency: 'forbid',
			maxRetries: 0,
			catchUp: false,
			memoryMb: 256,
			cpus: 1,
			enabled: true,
			nextRunAt: '2026-11-06T03:00:00.000Z',
			lastRunAt: null,
			lastRunStatus: null,
			missedRuns: 0,
			createdAt: '2026-11-05T00:00:00.000Z',
			updatedAt: '2026-11-05T00:00:00.000Z',
		};
		const history: z.output<typeof jobHistoryViewSchema> = {
			job,
			runs: [
				{
					id: 'run_1',
					jobId: 'job_1',
					jobName: 'cleanup',
					trigger: 'schedule',
					status: 'ok',
					startedAt: '2026-11-05T00:00:00.000Z',
					finishedAt: '2026-11-05T00:00:01.000Z',
					durationMs: 1000,
					exitCode: 0,
					stdoutTail: 'done',
					stderrTail: null,
					error: null,
					skippedReason: null,
				},
			],
			nextRunAt: '2026-11-06T03:00:00.000Z',
		};
		expect(jobHistoryViewSchema.parse(history)).toEqual(history);
	});
});
