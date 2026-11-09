import { describe, expect, test } from 'bun:test';
import type { FunctionBinding, FunctionRuntimeBinding } from '@yoal/contracts';
import type { CoreContext } from '../context.ts';
import type { ProjectRow } from '../projects.ts';
import { resolveD1Binding } from './d1.ts';

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

type D1RuntimeBinding = Extract<FunctionRuntimeBinding, { type: 'd1' }>;

async function resolve(binding: FunctionBinding, row = project()): Promise<D1RuntimeBinding> {
	return (await resolveD1Binding({ core: {} as CoreContext, project: row }, binding)) as D1RuntimeBinding;
}

function d1(name = 'DB', database = 'main'): FunctionBinding {
	return { name, type: 'd1', database };
}

describe('resolveD1Binding', () => {
	test('derives one namespace id from the project id, binding name and database', async () => {
		expect(await resolve(d1('LEDGER', 'books'))).toEqual({
			name: 'LEDGER',
			type: 'd1',
			database: 'books',
			namespaceId: 'prj_0123456789-LEDGER-books',
		});
	});

	test('filters unusual project, binding and database names into the runtime alphabet', async () => {
		const row = project({ id: 'prj /one:two' });
		expect(await resolve(d1('my binding/one:two', 'prod db/v2'), row)).toEqual({
			name: 'my binding/one:two',
			type: 'd1',
			database: 'prod db/v2',
			namespaceId: 'prj-one-two-my-binding-one-two-prod-db-v2',
		});

		expect((await resolve(d1('  padded  ', '  spaced  '))).namespaceId).toBe(
			'prj_0123456789-padded-spaced',
		);
		expect((await resolve(d1('dots.and_underscores-ok', 'db.v2'))).namespaceId).toBe(
			'prj_0123456789-dots.and_underscores-ok-db.v2',
		);
	});

	test('is stable across renames and project row updates', async () => {
		const before = await resolve(d1('LEDGER', 'books'), project({ slug: 'old-name', name: 'Old' }));
		const after = await resolve(
			d1('LEDGER', 'books'),
			project({ slug: 'new-name', name: 'New', updatedAt: 99, runtimeName: 'function' }),
		);
		expect(after.namespaceId).toBe(before.namespaceId);
	});

	test('gives every binding and every database a distinct namespace id', async () => {
		const first = await resolve(d1('FIRST', 'main'));
		const second = await resolve(d1('SECOND', 'main'));
		const otherDatabase = await resolve(d1('FIRST', 'other'));
		expect(first.namespaceId).not.toBe(second.namespaceId);
		expect(first.namespaceId).not.toBe(otherDatabase.namespaceId);
	});

	test('caps an over-long id at the contract’s 128 characters', async () => {
		const binding = await resolve(d1('B'.repeat(64), 'd'.repeat(100)));
		expect(binding.namespaceId).toHaveLength(128);
		expect(binding.namespaceId.startsWith('prj_0123456789-')).toBe(true);
	});

	test('refuses a binding of another type', () => {
		expect(() => resolve({ name: 'KV', type: 'kv' } as FunctionBinding)).toThrow(
			'D1 resolver received binding "KV" of type "kv", not "d1".',
		);
	});
});
