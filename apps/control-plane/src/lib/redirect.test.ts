import { describe, expect, test } from 'bun:test';
import { safeRedirect } from './redirect';

const origin = 'https://control.example.com';

describe('safeRedirect', () => {
	test('keeps same-origin paths', () => {
		expect(safeRedirect('/projects/blog?tab=deploys#x', origin)).toBe('/projects/blog?tab=deploys#x');
		expect(safeRedirect('https://control.example.com/overview', origin)).toBe('/overview');
	});

	test('rejects other origins and browser-normalised tricks', () => {
		for (const raw of [
			'//evil.com',
			'/\\evil.com',
			'\\\\evil.com',
			'/\t/evil.com',
			'https://evil.com/',
			'javascript:alert(1)',
			'http://control.example.com/',
		])
			expect(safeRedirect(raw, origin)).toBe('/');
	});

	test('scheme-relative same-scheme input stays on the platform', () => {
		// Browsers resolve `https:evil.com` against an https base as the path `/evil.com`.
		expect(safeRedirect('https:evil.com', origin)).toBe('/evil.com');
	});

	test('never returns a protocol-relative path', () => {
		expect(safeRedirect('/.//evil.com', origin)).toBe('/evil.com');
	});

	test('falls back on empty input', () => {
		expect(safeRedirect(null, origin)).toBe('/');
		expect(safeRedirect('', origin, '/overview')).toBe('/overview');
	});
});
