import { describe, expect, test } from 'bun:test';
import type { FunctionBinding } from '@yoal/contracts';
import type { CoreContext } from '../context.ts';
import type { ProjectRow } from '../projects.ts';
import { durableObjectUniqueKey, resolveDurableObject } from './durable-object.ts';
import type { BindingResolveContext } from './types.ts';

const project = {
	id: 'prj_abc123',
	orgId: 'org_1',
	slug: 'api',
} as ProjectRow;

function context(): BindingResolveContext {
	// Durable Objects need no org lookup: the project row plus the manifest binding are enough.
	return { core: {} as CoreContext, project };
}

function binding(overrides: Partial<FunctionBinding> = {}): FunctionBinding {
	return { name: 'ROOMS', type: 'durable_object', className: 'Room', ...overrides } as FunctionBinding;
}

describe('resolveDurableObject', () => {
	test('returns the class and the project-scoped unique key', async () => {
		expect(await resolveDurableObject(context(), binding())).toEqual({
			name: 'ROOMS',
			type: 'durable_object',
			className: 'Room',
			uniqueKey: 'prj_abc123-ROOMS',
		});
	});

	test('the key is stable across slugs and independent of binding order', () => {
		const renamed = { ...project, slug: 'renamed-project' } as ProjectRow;
		expect(durableObjectUniqueKey(renamed.id, 'ROOMS')).toBe(durableObjectUniqueKey(project.id, 'ROOMS'));
		expect(durableObjectUniqueKey('prj_abc123', 'COUNTER')).not.toBe(
			durableObjectUniqueKey('prj_abc123', 'ROOMS'),
		);
	});

	test('folds characters outside the workerd key alphabet', () => {
		// Binding names are JavaScript identifiers, so `$` is the only real case; project ids are
		// already in the alphabet. Mapping to `-` keeps distinct identifiers distinct.
		expect(durableObjectUniqueKey('prj_abc123', 'A$B')).toBe('prj_abc123-A-B');
		expect(durableObjectUniqueKey('prj_abc123', 'A_B')).toBe('prj_abc123-A_B');
	});

	test('refuses a binding of another type', () => {
		expect(() =>
			resolveDurableObject(context(), { name: 'GREETING', type: 'text', value: 'hi' }),
		).toThrow(/not "durable_object"/);
	});
});
