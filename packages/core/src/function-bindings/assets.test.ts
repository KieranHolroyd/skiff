import { describe, expect, test } from 'bun:test';
import type { FunctionBinding } from '@yoal/contracts';
import { resolveAssetsBinding } from './assets.ts';
import type { BindingResolveContext } from './types.ts';

/** The resolver never reads the context: an assets binding names no org resource. */
const CONTEXT = {} as BindingResolveContext;

const ASSETS_BINDING: FunctionBinding = { name: 'ASSETS', type: 'assets' };

describe('resolveAssetsBinding', () => {
	test('returns the runtime binding with the name unchanged', () => {
		expect(resolveAssetsBinding(CONTEXT, ASSETS_BINDING)).toEqual({
			name: 'ASSETS',
			type: 'assets',
		});
	});

	test('keeps unusual but valid binding names', () => {
		expect(resolveAssetsBinding(CONTEXT, { name: 'SITE_ASSETS', type: 'assets' })).toEqual({
			name: 'SITE_ASSETS',
			type: 'assets',
		});
	});

	test('keeps only the name and type, never the manifest shape', () => {
		const resolved = resolveAssetsBinding(CONTEXT, ASSETS_BINDING);
		expect(Object.keys(resolved).sort()).toEqual(['name', 'type']);
		// There is no directory here: that lives on the function spec, not the binding.
		expect(JSON.stringify(resolved)).not.toMatch(/directory|public|secret/i);
	});

	test('is stable and does not mutate the manifest binding', () => {
		const binding: FunctionBinding = { name: 'ASSETS', type: 'assets' };
		const first = resolveAssetsBinding(CONTEXT, binding);
		const second = resolveAssetsBinding(CONTEXT, binding);
		expect(first).toEqual(second);
		expect(binding).toEqual({ name: 'ASSETS', type: 'assets' });
		expect(first).not.toBe(second);
	});

	test('refuses a non-assets binding with a validation error', () => {
		const cache: FunctionBinding = { name: 'CACHE', type: 'cache' };
		expect(() => resolveAssetsBinding(CONTEXT, cache)).toThrow(
			'Binding "CACHE" uses type "cache"; the assets resolver only handles binding type "assets".',
		);
		try {
			resolveAssetsBinding(CONTEXT, cache);
		} catch (error) {
			expect(error).toMatchObject({ name: 'CoreError', code: 'validation', status: 422 });
		}
	});
});
