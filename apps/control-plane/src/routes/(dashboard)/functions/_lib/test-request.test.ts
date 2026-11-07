import { describe, expect, test } from 'bun:test';
import { headerLines, parseHeaderLines, prettyBody, statusTone } from './test-request.ts';

describe('function test request helpers', () => {
	test('header lines parse, skipping blanks and comments', () => {
		expect(parseHeaderLines('Content-Type: application/json\n\n# note\nX-Token:  abc:def ')).toEqual({
			'Content-Type': 'application/json',
			'X-Token': 'abc:def'
		});
		expect(() => parseHeaderLines('no colon here')).toThrow(/needs a name/);
		expect(() => parseHeaderLines('bad name: x')).toThrow(/not a valid header name/);
		expect(headerLines({ a: '1', b: '2' })).toBe('a: 1\nb: 2');
	});

	test('JSON bodies are pretty-printed, others left alone', () => {
		expect(prettyBody('{"a":1}', 'application/json')).toBe('{\n  "a": 1\n}');
		expect(prettyBody('[1]', null)).toBe('[\n  1\n]');
		expect(prettyBody('{oops', 'application/json')).toBe('{oops');
		expect(prettyBody('hello', 'text/plain')).toBe('hello');
		expect([statusTone(200), statusTone(404), statusTone(503)]).toEqual(['success', 'warning', 'danger']);
	});
});
