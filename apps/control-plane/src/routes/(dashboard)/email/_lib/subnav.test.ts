import { describe, expect, mock, test } from 'bun:test';

mock.module('$app/paths', () => ({ resolve: (path: string) => path }));
const { emailSection } = await import('./subnav.js');

describe('emailSection', () => {
	test('lights the list a detail page belongs to', () => {
		expect(emailSection('/email')).toBe('overview');
		expect(emailSection('/email/domains/example.com')).toBe('domains');
		expect(emailSection('/email/activity/em_12345678')).toBe('activity');
	});

	test('the mail server lives inside Email', () => {
		expect(emailSection('/email/server')).toBe('server');
	});

	test('the old setup guide path falls back to the overview, where the checklist now is', () => {
		expect(emailSection('/email/setup')).toBe('overview');
	});
});
