import { describe, expect, test } from 'bun:test';
import { regroupTxtRecords } from './dns-txt.ts';

const first = `v=DKIM1; k=rsa; p=${'A'.repeat(255 - 'v=DKIM1; k=rsa; p='.length)}`;
const rest = 'B'.repeat(137);

describe('regroupTxtRecords', () => {
	test('joins a 255-byte string to the string after it when the runtime flattened them (Bun)', () => {
		expect(first.length).toBe(255);
		expect(regroupTxtRecords([[first], [rest]])).toEqual([[first, rest]]);
	});

	test('keeps separate short records separate', () => {
		const records = [['v=spf1 include:_spf.example.com ~all'], ['google-site-verification=abc']];
		expect(regroupTxtRecords(records)).toEqual(records);
	});

	test('splits a record off after its last short string', () => {
		expect(regroupTxtRecords([[first], [rest], ['other']])).toEqual([[first, rest], ['other']]);
	});

	test('leaves already grouped output (Node) untouched', () => {
		const records = [[first, rest], ['other']];
		expect(regroupTxtRecords(records)).toBe(records);
	});
});
