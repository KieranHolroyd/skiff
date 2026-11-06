import { describe, expect, test } from 'bun:test';
import type { FunctionBinding, FunctionRuntimeBinding } from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import type { ProjectRow } from '../projects.ts';
import { resolveQueueBinding } from './queue.ts';

function project(overrides: Partial<ProjectRow> = {}): ProjectRow {
	return {
		id: 'prj_0123456789',
		orgId: 'org_1',
		slug: 'api',
		name: 'API',
		runtime: 'process',
		runtimeName: 'function',
		placement: 'auto',
		productionDeploymentId: null,
		productionAccess: 'public',
		previewAccess: 'public',
		accessSecretHash: null,
		workloadJson: null,
		createdBy: 'usr_1',
		deletedAt: null,
		purgeAt: null,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

type QueueRuntimeBinding = Extract<FunctionRuntimeBinding, { type: 'queue' }>;

async function resolve(binding: FunctionBinding, row = project()): Promise<QueueRuntimeBinding> {
	return (await resolveQueueBinding({ core: {} as CoreContext, project: row }, binding)) as QueueRuntimeBinding;
}

function queue(name = 'JOBS', queueName = 'jobs'): FunctionBinding {
	return { name, type: 'queue', queue: queueName, producer: true };
}

describe('resolveQueueBinding', () => {
	test('derives one queue id from the project id, binding name and queue name', async () => {
		expect(await resolve(queue('EVENTS', 'events'))).toEqual({
			name: 'EVENTS',
			type: 'queue',
			queue: 'events',
			producer: true,
			namespaceId: 'prj_0123456789-EVENTS-events',
		});
	});

	test('carries producer and queue through unchanged', async () => {
		expect(await resolve({ name: 'CONSUMER', type: 'queue', queue: 'jobs', producer: false })).toMatchObject(
			{ queue: 'jobs', producer: false },
		);
	});

	test('falls back to the binding name when the runtime binding has no queue name', async () => {
		const runtime = await resolveQueueBinding(
			{ core: {} as CoreContext, project: project() },
			{ name: 'JOBS', type: 'queue', producer: true } as unknown as FunctionBinding,
		);
		expect(runtime).toMatchObject({
			queue: 'JOBS',
			namespaceId: 'prj_0123456789-JOBS-JOBS',
		});
	});

	test('filters unusual binding and queue names into the runtime alphabet', async () => {
		expect(await resolve(queue('my binding/one:two', 'jobs/eu west'))).toMatchObject({
			queue: 'jobs/eu west',
			namespaceId: 'prj_0123456789-my-binding-one-two-jobs-eu-west',
		});
		expect((await resolve(queue('  padded  ', '  jobs  '))).namespaceId).toBe(
			'prj_0123456789-padded-jobs',
		);
		expect((await resolve(queue('dots.and_underscores-ok', 'jobs.v1'))).namespaceId).toBe(
			'prj_0123456789-dots.and_underscores-ok-jobs.v1',
		);
	});

	test('is stable across renames and project row updates', async () => {
		const before = await resolve(queue('JOBS', 'jobs'), project({ slug: 'old-name', name: 'Old' }));
		const after = await resolve(
			queue('JOBS', 'jobs'),
			project({ slug: 'new-name', name: 'New', updatedAt: 99, runtimeName: 'function' }),
		);
		expect(after.namespaceId).toBe(before.namespaceId);
	});

	test('gives every binding and every queue a distinct id', async () => {
		const first = await resolve(queue('FIRST', 'jobs'));
		const second = await resolve(queue('SECOND', 'jobs'));
		const third = await resolve(queue('FIRST', 'events'));
		expect(new Set([first.namespaceId, second.namespaceId, third.namespaceId]).size).toBe(3);
	});

	test('keeps a long name and queue id within the schema limit without colliding', async () => {
		const longName = 'a'.repeat(100);
		const first = await resolve(queue(longName, 'b'.repeat(100)));
		const second = await resolve(queue(longName, 'c'.repeat(100)));

		for (const runtime of [first, second]) {
			expect(runtime.namespaceId).toHaveLength(128);
			expect(runtime.namespaceId).toMatch(/^[A-Za-z0-9._-]+$/);
		}
		expect(first.namespaceId).not.toBe(second.namespaceId);
	});

	test('refuses a binding of another type', () => {
		expect(() => resolve({ name: 'KV', type: 'kv' } as FunctionBinding)).toThrow(
			'Queue resolver received binding "KV" of type "kv", not "queue".',
		);
	});
});
