import { describe, expect, test } from 'bun:test';
import type { DashboardVariable } from '@yoal/contracts';
import {
	ALL,
	customOptions,
	interpolate,
	readUrlState,
	variableValues,
	writeUrlState
} from './variables.ts';

const variable = (patch: Partial<DashboardVariable>): DashboardVariable => ({
	name: 'host',
	label: '',
	kind: 'query',
	custom: '',
	multi: false,
	includeAll: false,
	current: [],
	...patch
});

describe('variableValues', () => {
	test('single and multi', () => {
		expect(variableValues([variable({ current: ['a'] })], {})).toEqual({ host: 'a' });
		expect(variableValues([variable({ multi: true, current: ['a', 'b'] })], {})).toEqual({
			host: ['a', 'b']
		});
	});

	test('All is the marker plus every option (just the marker before they load)', () => {
		const all = variable({ multi: true, includeAll: true, current: [ALL] });
		expect(variableValues([all], { host: ['a', 'b'] })).toEqual({ host: [ALL, 'a', 'b'] });
		expect(variableValues([all], {})).toEqual({ host: [ALL] });
	});

	test('nothing picked falls back to the first option', () => {
		expect(variableValues([variable({})], { host: ['x', 'y'] })).toEqual({ host: 'x' });
	});

	test('custom and textbox', () => {
		const custom = variable({
			kind: 'custom',
			custom: 'a, b ,, c',
			includeAll: true,
			current: [ALL]
		});
		expect(customOptions(custom)).toEqual(['a', 'b', 'c']);
		expect(variableValues([custom], {})).toEqual({ host: [ALL, 'a', 'b', 'c'] });
		expect(variableValues([variable({ kind: 'textbox', current: ['/api'] })], {})).toEqual({
			host: '/api'
		});
	});
});

test('interpolate', () => {
	expect(interpolate('Requests for $host', { host: 'a.test' })).toBe('Requests for a.test');
	expect(interpolate('${host}!', { host: ['a', 'b'] })).toBe('a, b!');
	expect(interpolate('$host', { host: [ALL] })).toBe('All');
	expect(interpolate('$missing', {})).toBe('$missing');
});

describe('url state', () => {
	test('round trip', () => {
		const params = writeUrlState(new URLSearchParams('tab=x&var-old=1'), {
			range: { from: 'now-24h', to: 'now' },
			refresh: '1m',
			variables: [variable({ multi: true, current: ['a', 'b'] })]
		});
		expect(params.get('tab')).toBe('x');
		expect(params.has('var-old')).toBe(false);
		expect(readUrlState(params)).toEqual({
			range: { from: 'now-24h', to: 'now' },
			refresh: '1m',
			vars: { host: ['a', 'b'] }
		});
	});

	test('absent values', () => {
		expect(readUrlState(new URLSearchParams(''))).toEqual({
			range: null,
			refresh: undefined,
			vars: {}
		});
	});
});
