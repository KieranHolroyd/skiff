import { describe, expect, test } from 'bun:test';
import { checkDns, digLookup, dnsTargets, isPublicAddress, parseDigShort, parseServerAddresses } from './dns-check.ts';

describe('installer DNS check', () => {
	test('checks the platform host, content apex and a fresh wildcard probe', () => {
		expect(dnsTargets('control.example.com', 'examplecloud.com', 'abcd')).toEqual([
			{ display: 'control.example.com', name: 'control.example.com' },
			{ display: 'examplecloud.com', name: 'examplecloud.com' },
			{ display: '*.examplecloud.com', name: 'skiff-dns-check-abcd.examplecloud.com' },
		]);
		const [, , first] = dnsTargets('control.example.com', 'examplecloud.com');
		const [, , second] = dnsTargets('control.example.com', 'examplecloud.com');
		expect(first!.name).not.toBe(second!.name);
	});

	test('does not check the same name twice in shared-domain mode', () => {
		expect(dnsTargets('example.com', 'example.com', 'abcd').map((target) => target.display)).toEqual([
			'example.com',
			'*.example.com',
		]);
	});

	test('classifies records as ok, pointing elsewhere, or missing', async () => {
		const records: Record<string, string[]> = {
			'control.example.com': ['203.0.113.10'],
			'examplecloud.com': ['104.16.0.1'],
		};
		const results = await checkDns(
			dnsTargets('control.example.com', 'examplecloud.com', 'abcd'),
			async (name) => records[name] ?? [],
			['203.0.113.10'],
		);
		expect(results.map((result) => result.status)).toEqual(['ok', 'elsewhere', 'missing']);
	});

	test('treats any resolving record as ok when the server address is unknown', async () => {
		const [result] = await checkDns([{ display: 'a.example.com', name: 'a.example.com' }], async () => ['198.51.100.1'], []);
		expect(result!.status).toBe('ok');
	});

	test('a failing lookup counts as missing', async () => {
		const [result] = await checkDns([{ display: 'a.example.com', name: 'a.example.com' }], async () => {
			throw new Error('SERVFAIL');
		}, []);
		expect(result!.status).toBe('missing');
	});

	test('dig output keeps addresses and drops CNAME targets', async () => {
		expect(parseDigShort('examplecloud.com.\n203.0.113.10\n\n')).toEqual(['203.0.113.10']);
		const lookup = digLookup((cmd) => (cmd.includes('A') ? '203.0.113.10\n' : '2001:db8::1\n'));
		expect(await lookup('examplecloud.com')).toEqual(['203.0.113.10', '2001:db8::1']);
	});

	test('server addresses keep only publicly routable ones', () => {
		expect(parseServerAddresses('10.0.0.5 203.0.113.10 100.101.1.2 172.17.0.1 2001:db8::1 fd00::1 \n')).toEqual([
			'203.0.113.10',
			'2001:db8::1',
		]);
		expect(isPublicAddress('192.168.0.9')).toBe(false);
		expect(isPublicAddress('not-an-ip')).toBe(false);
	});
});
