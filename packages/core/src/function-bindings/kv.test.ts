import { describe, expect, test } from 'bun:test';
import type { FunctionBinding, FunctionRuntimeBinding } from '@yoal/contracts';
import type { CoreContext } from '../context.ts';
import type { ProjectRow } from '../projects.ts';
import { resolveKvBinding } from './kv.ts';

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

type KvRuntimeBinding = Extract<FunctionRuntimeBinding, { type: 'kv' }>;

async function resolve(binding: FunctionBinding, row = project()): Promise<KvRuntimeBinding> {
	return (await resolveKvBinding({ core: {} as CoreContext, project: row }, binding)) as KvRuntimeBinding;
}

function kv(name = 'KV'): FunctionBinding {
	return { name, type: 'kv' };
}

describe('resolveKvBinding', () => {
	test('derives one namespace id from the project id and binding name', async () => {
		expect(await resolve(kv('CACHE'))).toEqual({
			name: 'CACHE',
			type: 'kv',
			namespaceId: 'prj_0123456789-CACHE',
		});
	});

	test('filters unusual binding names into the runtime alphabet', async () => {
		expect(await resolve(kv('my binding/one:two'))).toEqual({
			name: 'my binding/one:two',
			type: 'kv',
			namespaceId: 'prj_0123456789-my-binding-one-two',
		});
		expect(await resolve(kv('  padded  '))).toEqual({
			name: '  padded  ',
			type: 'kv',
			namespaceId: 'prj_0123456789-padded',
		});
		expect((await resolve(kv('dots.and_underscores-ok'))).namespaceId).toBe(
			'prj_0123456789-dots.and_underscores-ok',
		);
	});

	test('is stable across renames and project row updates', async () => {
		const before = await resolve(kv('CACHE'), project({ slug: 'old-name', name: 'Old' }));
		const after = await resolve(
			kv('CACHE'),
			project({ slug: 'new-name', name: 'New', updatedAt: 99, runtimeName: 'function' }),
		);
		expect(after.namespaceId).toBe(before.namespaceId);
	});

	test('gives every binding in a project a distinct namespace id', async () => {
		const first = await resolve(kv('FIRST'));
		const second = await resolve(kv('SECOND'));
		expect(first.namespaceId).not.toBe(second.namespaceId);
	});

	test('refuses a binding of another type', () => {
		expect(() => resolve({ name: 'CACHE', type: 'cache' } as FunctionBinding)).toThrow(
			'KV resolver received binding "CACHE" of type "cache", not "kv".',
		);
	});
});
