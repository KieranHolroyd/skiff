import { describe, expect, test } from 'bun:test';
import type { FunctionBinding } from '@yoal/contracts';
import { resolveCacheBinding } from './cache.ts';
import type { BindingResolveContext } from './types.ts';

/** The resolver never reads the context: a cache binding names no org resource. */
const CONTEXT = {} as BindingResolveContext;

const CACHE_BINDING: FunctionBinding = { name: 'CACHE', type: 'cache' };

describe('resolveCacheBinding', () => {
	test('returns the runtime binding with the name unchanged', () => {
		expect(resolveCacheBinding(CONTEXT, CACHE_BINDING)).toEqual({
			name: 'CACHE',
			type: 'cache',
		});
	});

	test('keeps unusual but valid binding names', () => {
		expect(resolveCacheBinding(CONTEXT, { name: 'CACHE_2', type: 'cache' })).toEqual({
			name: 'CACHE_2',
			type: 'cache',
		});
	});

	test('is stable and does not mutate the manifest binding', () => {
		const binding: FunctionBinding = { name: 'CACHE', type: 'cache' };
		const first = resolveCacheBinding(CONTEXT, binding);
		const second = resolveCacheBinding(CONTEXT, binding);
		expect(first).toEqual(second);
		expect(binding).toEqual({ name: 'CACHE', type: 'cache' });
		expect(first).not.toBe(second);
	});

	test('refuses a non-cache binding with a validation error', () => {
		const kv: FunctionBinding = { name: 'KV', type: 'kv' };
		expect(() => resolveCacheBinding(CONTEXT, kv)).toThrow(
			'Binding "KV" uses type "kv"; the cache resolver only handles binding type "cache".',
		);
		try {
			resolveCacheBinding(CONTEXT, kv);
		} catch (error) {
			expect(error).toMatchObject({ name: 'CoreError', code: 'validation', status: 422 });
		}
	});
});
