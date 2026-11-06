import { describe, expect, test } from 'bun:test';
import type { FunctionBinding, FunctionRuntimeBinding } from '@skiff/contracts';
import { resolveAnalyticsEngineBinding } from './analytics-engine.ts';
import type { BindingResolveContext } from './types.ts';

/** The resolver never reads the context: an Analytics Engine dataset names no org resource. */
const CONTEXT = {} as BindingResolveContext;

type AnalyticsRuntimeBinding = Extract<FunctionRuntimeBinding, { type: 'analytics_engine' }>;

const BINDING: FunctionBinding = { name: 'ANALYTICS', type: 'analytics_engine' };

function resolve(binding: FunctionBinding = BINDING): AnalyticsRuntimeBinding {
	return resolveAnalyticsEngineBinding(CONTEXT, binding) as AnalyticsRuntimeBinding;
}

describe('resolveAnalyticsEngineBinding', () => {
	test('defaults the dataset to the binding name', () => {
		expect(resolve()).toEqual({
			name: 'ANALYTICS',
			type: 'analytics_engine',
			dataset: 'ANALYTICS',
		});
	});

	test('keeps an explicit safe dataset', () => {
		expect(resolve({ name: 'EVENTS', type: 'analytics_engine', dataset: 'web_events.v2' })).toEqual({
			name: 'EVENTS',
			type: 'analytics_engine',
			dataset: 'web_events.v2',
		});
	});

	test('accepts the full safe alphabet and 100 characters', () => {
		const dataset = `${'a'.repeat(90)}._-09AZ`;
		expect(resolve({ name: 'EVENTS', type: 'analytics_engine', dataset })).toMatchObject({ dataset });
		expect(resolve({ name: 'EVENTS', type: 'analytics_engine', dataset: 'a'.repeat(100) })).toMatchObject({
			dataset: 'a'.repeat(100),
		});
	});

	test('refuses a dataset with unsafe characters or an empty/oversized name', () => {
		for (const dataset of ['has space', 'semi;colon', 'slash/name', 'quote"name', '', 'a'.repeat(101)]) {
			expect(() => resolve({ name: 'EVENTS', type: 'analytics_engine', dataset })).toThrow(
				`Analytics Engine dataset "${dataset}" is invalid`,
			);
		}
	});

	test('refuses a dataset with a validation error', () => {
		try {
			resolve({ name: 'EVENTS', type: 'analytics_engine', dataset: 'bad name' });
			throw new Error('expected the resolver to throw');
		} catch (error) {
			expect(error).toMatchObject({ name: 'CoreError', code: 'validation', status: 422 });
		}
	});

	test('is stable and does not mutate the manifest binding', () => {
		const binding: FunctionBinding = { name: 'ANALYTICS', type: 'analytics_engine', dataset: 'events' };
		const first = resolve(binding);
		const second = resolve(binding);
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		expect(binding).toEqual({ name: 'ANALYTICS', type: 'analytics_engine', dataset: 'events' });
	});

	test('refuses a binding of another type', () => {
		expect(() => resolve({ name: 'CACHE', type: 'cache' })).toThrow(
			'Binding "CACHE" uses type "cache"; the analytics resolver only handles binding type "analytics_engine".',
		);
	});
});
