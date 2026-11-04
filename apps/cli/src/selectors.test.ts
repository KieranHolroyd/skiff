import { describe, expect, test } from 'bun:test';
import { UsageError } from './errors.ts';
import {
	MAX_BULK_TARGETS,
	assertTargetCount,
	globToRegExp,
	parseDuration,
	parseSlugList,
	resolveTargets,
	type SelectableProject,
} from './selectors.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('parseDuration', () => {
	test('reads the supported units and combinations', () => {
		expect(parseDuration('30d')).toBe(30 * DAY);
		expect(parseDuration('12h')).toBe(12 * 60 * 60 * 1000);
		expect(parseDuration('2w')).toBe(14 * DAY);
		expect(parseDuration('90m')).toBe(90 * 60 * 1000);
		expect(parseDuration('45s')).toBe(45 * 1000);
		expect(parseDuration('1w2d')).toBe(9 * DAY);
		expect(parseDuration(' 3D ')).toBe(3 * DAY);
	});

	test('rejects anything else with a usage error', () => {
		for (const bad of ['', '30', 'd', '1y', '1.5d', '-2d', '0d', '3 days'])
			expect(() => parseDuration(bad)).toThrow(UsageError);
	});
});

describe('globToRegExp', () => {
	const matches = (glob: string, value: string) => globToRegExp(glob).test(value);

	test('* and ? match runs and single characters across the whole slug', () => {
		expect(matches('test-*', 'test-a')).toBe(true);
		expect(matches('test-*', 'test-')).toBe(true);
		expect(matches('test-*', 'my-test-a')).toBe(false);
		expect(matches('*-demo', 'blog-demo')).toBe(true);
		expect(matches('pr-?', 'pr-1')).toBe(true);
		expect(matches('pr-?', 'pr-12')).toBe(false);
		expect(matches('blog', 'blog')).toBe(true);
		expect(matches('blog', 'blog-2')).toBe(false);
	});

	test('character classes, ranges and negation', () => {
		expect(matches('pr-[0-9]*', 'pr-42')).toBe(true);
		expect(matches('pr-[0-9]*', 'pr-x')).toBe(false);
		expect(matches('[!a]*', 'blog')).toBe(true);
		expect(matches('[!a]*', 'app')).toBe(false);
	});

	test('regex metacharacters are literal', () => {
		expect(matches('a.b', 'a.b')).toBe(true);
		expect(matches('a.b', 'axb')).toBe(false);
		expect(matches('a+(b)', 'a+(b)')).toBe(true);
		expect(matches('[oops', '[oops')).toBe(true);
	});
});

describe('parseSlugList', () => {
	test('one slug per line; blanks, whitespace and # comments ignored', () => {
		expect(parseSlugList('alpha\n\n  beta  \r\n# a comment\ngamma # trailing\n')).toEqual(['alpha', 'beta', 'gamma']);
	});
});

describe('resolveTargets', () => {
	const now = Date.parse('2026-11-04T12:00:00Z');
	const projects: SelectableProject[] = [
		{ slug: 'test-a', productionDeploymentId: null, createdAt: '2026-09-01T00:00:00Z' },
		{ slug: 'test-b', productionDeploymentId: 'dpl_1', createdAt: '2026-09-01T00:00:00Z' },
		{ slug: 'test-c', productionDeploymentId: null, createdAt: '2026-11-03T00:00:00Z' },
		{ slug: 'blog', productionDeploymentId: 'dpl_2', createdAt: '2025-01-01T00:00:00Z', deletedAt: '2026-11-04T06:00:00Z' },
	];
	const base = { explicit: [], ageField: 'createdAt' as const, now };

	test('without selectors only the explicit slugs are used, unknown ones included', () => {
		expect(resolveTargets(projects, { ...base, explicit: ['blog', 'nope', 'blog'] })).toEqual(['blog', 'nope']);
	});

	test('selectors combine with AND', () => {
		expect(resolveTargets(projects, { ...base, match: 'test-*' })).toEqual(['test-a', 'test-b', 'test-c']);
		expect(resolveTargets(projects, { ...base, match: 'test-*', notDeployed: true })).toEqual(['test-a', 'test-c']);
		expect(resolveTargets(projects, { ...base, match: 'test-*', notDeployed: true, olderThanMs: 30 * DAY })).toEqual([
			'test-a',
		]);
		expect(resolveTargets(projects, { ...base, notDeployed: true })).toEqual(['test-a', 'test-c']);
	});

	test('explicit slugs come first and are unioned with matches, without duplicates', () => {
		expect(resolveTargets(projects, { ...base, explicit: ['blog', 'test-c'], match: 'test-*', notDeployed: true })).toEqual([
			'blog',
			'test-c',
			'test-a',
		]);
	});

	test('the trash compares --older-than with deletedAt; projects without the date never match', () => {
		expect(resolveTargets(projects, { ...base, ageField: 'deletedAt', olderThanMs: 2 * 60 * 60 * 1000 })).toEqual(['blog']);
		expect(resolveTargets(projects, { ...base, ageField: 'deletedAt', olderThanMs: 12 * 60 * 60 * 1000 })).toEqual([]);
	});
});

describe('assertTargetCount', () => {
	test('explains an empty selection differently with and without selectors', () => {
		expect(() => assertTargetCount([], { usedSelectors: false, where: '' })).toThrow(/Name at least one project/);
		expect(() => assertTargetCount([], { usedSelectors: true, where: 'in the trash' })).toThrow(
			'No projects in the trash matched the selectors. Nothing to do.',
		);
		expect(() => assertTargetCount([], { usedSelectors: true, where: '' })).toThrow('No projects matched the selectors.');
	});

	test('caps a run at the server limit and suggests narrowing', () => {
		const many = Array.from({ length: MAX_BULK_TARGETS + 1 }, (_, i) => `p-${i}`);
		expect(() => assertTargetCount(many, { usedSelectors: true, where: '' })).toThrow(/at most 100\. Narrow the selection/);
		expect(() => assertTargetCount(many.slice(1), { usedSelectors: true, where: '' })).not.toThrow();
	});
});
