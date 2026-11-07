import { describe, expect, test } from 'bun:test';
import {
	invokeSummary,
	isSuccessStatus,
	normalizeRequestPath,
	parseHeaderFlags,
	parseMethod,
	responseBodyBytes,
	responseHead,
	scheduledFailed,
	scheduledSummary,
} from './functions.ts';
import type { FunctionInvokeResult } from './node-tasks.ts';

function response(overrides: Partial<FunctionInvokeResult> = {}): FunctionInvokeResult {
	return {
		status: 200,
		statusText: 'OK',
		headers: [
			['content-type', 'application/json'],
			['x-request-id', 'r1'],
		],
		encoding: 'utf8',
		body: '{"ok":true}',
		size: 11,
		truncated: false,
		durationMs: 12.4,
		coldStart: false,
		...overrides,
	};
}

describe('parseHeaderFlags', () => {
	test('reads Name: value, trimming around the colon', () => {
		expect(parseHeaderFlags(['content-type: application/json', 'X-Token:abc', 'Empty:'])).toEqual({
			'content-type': 'application/json',
			'X-Token': 'abc',
			Empty: '',
		});
	});

	test('keeps colons in values and joins repeated names case-insensitively', () => {
		expect(parseHeaderFlags(['Accept: text/html', 'accept: application/json', 'X-Url: http://a:1/b'])).toEqual({
			Accept: 'text/html, application/json',
			'X-Url': 'http://a:1/b',
		});
	});

	test('rejects values without a name', () => {
		expect(() => parseHeaderFlags(['no-colon'])).toThrow("-H expects 'Name: value'");
		expect(() => parseHeaderFlags([': value'])).toThrow('-H expects');
		expect(() => parseHeaderFlags(['bad name: value'])).toThrow('-H expects');
	});

	test('no flags means no headers', () => {
		expect(parseHeaderFlags([])).toEqual({});
	});
});

describe('parseMethod and normalizeRequestPath', () => {
	test('GET by default, POST with a body, upper-cased', () => {
		expect(parseMethod(undefined, false)).toBe('GET');
		expect(parseMethod(undefined, true)).toBe('POST');
		expect(parseMethod('put', true)).toBe('PUT');
		expect(parseMethod('delete', false)).toBe('DELETE');
	});

	test('refuses unknown methods and bodies on GET or HEAD', () => {
		expect(() => parseMethod('TRACE', false)).toThrow('-X must be one of');
		expect(() => parseMethod('GET', true)).toThrow('GET requests have no body');
		expect(() => parseMethod('head', true)).toThrow('HEAD requests have no body');
	});

	test('paths start with / and URLs are refused', () => {
		expect(normalizeRequestPath(undefined)).toBe('/');
		expect(normalizeRequestPath('users?limit=5')).toBe('/users?limit=5');
		expect(normalizeRequestPath('/api')).toBe('/api');
		expect(() => normalizeRequestPath('https://example.com/api')).toThrow('not a URL');
	});
});

describe('invoke output', () => {
	test('responseHead prints the status line and headers like curl -i', () => {
		expect(responseHead(response())).toBe('HTTP 200 OK\ncontent-type: application/json\nx-request-id: r1');
		expect(responseHead(response({ statusText: '', headers: [] }))).toBe('HTTP 200');
	});

	test('invokeSummary shows status, time, cold start, size and cuts', () => {
		expect(invokeSummary(response())).toBe('200 OK · 12 ms · 11 B');
		expect(invokeSummary(response({ status: 503, statusText: 'Service Unavailable', coldStart: true, durationMs: 1500, size: 300_000, truncated: true }))).toBe(
			'503 Service Unavailable · 1.50 s · cold start · 293 KiB · body cut at 256 KiB',
		);
	});

	test('success is 2xx only', () => {
		expect(isSuccessStatus(200)).toBe(true);
		expect(isSuccessStatus(204)).toBe(true);
		expect(isSuccessStatus(302)).toBe(false);
		expect(isSuccessStatus(500)).toBe(false);
	});

	test('responseBodyBytes decodes base64 bodies', () => {
		expect([...responseBodyBytes(response({ encoding: 'base64', body: 'AAEC' }))]).toEqual([0, 1, 2]);
		expect(new TextDecoder().decode(responseBodyBytes(response({ body: 'héllo' })))).toBe('héllo');
	});
});

describe('scheduled output', () => {
	test('a clean run is one line', () => {
		const result = { status: 200, error: null, durationMs: 8, coldStart: true };
		expect(scheduledFailed(result)).toBe(false);
		expect(scheduledSummary('*/5 * * * *', result)).toBe('Ran scheduled() for "*/5 * * * *": status 200 in 8 ms, cold start.');
	});

	test('an error or a 4xx/5xx status is a failure', () => {
		const thrown = { status: 500, error: 'TypeError: x is undefined', durationMs: 3, coldStart: false };
		expect(scheduledFailed(thrown)).toBe(true);
		expect(scheduledSummary('0 * * * *', thrown)).toBe('scheduled() for "0 * * * *" failed (status 500, 3 ms): TypeError: x is undefined');
		expect(scheduledFailed({ status: 200, error: 'no scheduled handler', durationMs: 1, coldStart: false })).toBe(true);
		expect(scheduledFailed({ status: 404, error: null, durationMs: 1, coldStart: false })).toBe(true);
	});
});
