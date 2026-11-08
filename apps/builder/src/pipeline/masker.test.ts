import { describe, expect, test } from 'bun:test';
import { Masker } from './masker.ts';

describe('Masker', () => {
	test('masks raw, base64 and URL-encoded forms', () => {
		const masker = new Masker();
		masker.add('p@ss w/rd');
		expect(masker.mask('token=p@ss w/rd end')).toBe('token=*** end');
		expect(masker.mask(`b64 ${Buffer.from('p@ss w/rd').toString('base64')}`)).toBe('b64 ***');
		expect(masker.mask(`url ${encodeURIComponent('p@ss w/rd')}`)).toBe('url ***');
	});

	test('masks base64 embedded without padding', () => {
		const masker = new Masker();
		masker.add('ab');
		const encoded = Buffer.from('ab').toString('base64'); // YWI=
		expect(masker.mask(`x${encoded.replace(/=+$/, '')}y`)).toBe('x***y');
	});

	test('ignores empty and blank values', () => {
		const masker = new Masker();
		masker.add('');
		masker.add('   ');
		masker.add(null);
		expect(masker.size).toBe(0);
		expect(masker.mask('nothing to hide')).toBe('nothing to hide');
	});

	test('masks a multi-line secret line by line', () => {
		const masker = new Masker();
		masker.add('-----BEGIN KEY-----\nAAAAsecretline\n-----END KEY-----\n');
		expect(masker.mask('AAAAsecretline')).toBe('***');
		expect(masker.mask('prefix -----BEGIN KEY----- suffix')).toBe('prefix *** suffix');
	});

	test('longest value wins, so no fragment of a containing secret is left', () => {
		const masker = new Masker();
		masker.add('abc');
		masker.add('abcdef');
		expect(masker.mask('xx abcdef yy abc')).toBe('xx *** yy ***');
	});

	test('treats regex metacharacters literally and masks every occurrence', () => {
		const masker = new Masker();
		masker.add('a.b*c(d)[e]$');
		expect(masker.mask('a.b*c(d)[e]$ and aXb*c(d)[e]$ and a.b*c(d)[e]$')).toBe('*** and aXb*c(d)[e]$ and ***');
	});

	test('values added later apply to later lines', () => {
		const masker = new Masker();
		expect(masker.mask('later')).toBe('later');
		masker.add('later');
		expect(masker.mask('later')).toBe('***');
		expect(masker.contains('it is later')).toBe(true);
		expect(masker.contains('nope')).toBe(false);
	});
});
