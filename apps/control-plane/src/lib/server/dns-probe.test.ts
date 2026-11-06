import { describe, expect, test } from 'bun:test';
import { interfaceAddresses } from './dns-probe.js';

describe('interfaceAddresses', () => {
	test('returns nothing when getifaddrs fails (control-plane unit has no AF_NETLINK)', () => {
		const denied = () => {
			throw new Error('A system error occurred: getifaddrs returned an error');
		};
		expect(interfaceAddresses(undefined, denied)).toEqual([]);
		expect(interfaceAddresses('IPv4', denied)).toEqual([]);
	});

	test('skips internal addresses and filters by family', () => {
		const read = () =>
			({
				lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
				eth0: [
					{ address: '203.0.113.7', family: 'IPv4', internal: false },
					{ address: '2001:db8::1', family: 'IPv6', internal: false }
				]
			}) as unknown as ReturnType<typeof import('node:os').networkInterfaces>;
		expect(interfaceAddresses('IPv4', read)).toEqual(['203.0.113.7']);
		expect(interfaceAddresses(undefined, read)).toEqual(['203.0.113.7', '2001:db8::1']);
	});
});
