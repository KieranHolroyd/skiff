import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderConfig, WireguardManager, type CommandResult, type CommandRunner } from './wireguard.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-wireguard-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const publicKey = `${'A'.repeat(43)}=`;
const state = {
	mode: 'yoal' as const,
	address: '10.88.1.5',
	cidr: '10.88.0.0/22',
	mtu: 1420,
	listenPort: 51820,
	peers: [
		{
			publicKey,
			endpoint: '203.0.113.10:51820',
			allowedIps: ['10.88.1.1/32', '10.88.1.2/32'],
			persistentKeepalive: 25,
		},
	],
};

function fakeRunner(calls: string[][]): CommandRunner {
	return async (argv, input) => {
		calls.push(argv);
		if (argv[1] === 'genkey') return { code: 0, stdout: 'private-key\n', stderr: '' };
		if (argv[1] === 'pubkey') {
			expect(input).toBe('private-key\n');
			return { code: 0, stdout: `${publicKey}\n`, stderr: '' };
		}
		if (argv[1] === 'show') {
			return {
				code: 0,
				stdout: `private\t${publicKey}\t51820\toff\n${publicKey}\t(none)\t203.0.113.10:51820\t10.88.1.1/32\t1700000000\t123\t456\t25\n`,
				stderr: '',
			};
		}
		return { code: 0, stdout: '', stderr: '' };
	};
}

describe('WireguardManager', () => {
	test('generates a key pair and keeps the private key 0600', async () => {
		const calls: string[][] = [];
		const manager = new WireguardManager({
			paths: { dir: join(dir, 'keys'), privateKeyPath: join(dir, 'keys', 'wg0.key'), configPath: join(dir, 'keys', 'wg0.conf') },
			runner: fakeRunner(calls),
		});
		const result = await manager.keygen();
		expect(result.publicKey).toBe(publicKey);
		expect(readFileSync(join(dir, 'keys', 'wg0.key'), 'utf8')).toContain('private-key');
		expect(statSync(join(dir, 'keys', 'wg0.key')).mode & 0o777).toBe(0o600);
		expect(calls.some((call) => call.includes('genkey'))).toBe(true);
	});

	test('applies the interface and renders a peer config', async () => {
		const calls: string[][] = [];
		const manager = new WireguardManager({
			paths: { dir: join(dir, 'apply'), privateKeyPath: join(dir, 'keys', 'wg0.key'), configPath: join(dir, 'apply', 'wg0.conf') },
			runner: fakeRunner(calls),
		});
		expect(await manager.apply(state)).toEqual({ peers: 1 });
		const config = readFileSync(join(dir, 'apply', 'wg0.conf'), 'utf8');
		expect(config).toContain('PrivateKey = private-key');
		expect(config).toContain('AllowedIPs = 10.88.1.1/32, 10.88.1.2/32');
		expect(config).toContain('Endpoint = 203.0.113.10:51820');
		expect(calls.some((call) => call[0] === 'ip' && call.includes('addr') && call.includes('10.88.1.5/32'))).toBe(true);
		expect(calls.some((call) => call[0] === 'wg' && call.includes('setconf'))).toBe(true);
		// The /32 address alone routes nothing: the overlay CIDR must point at the interface.
		expect(calls).toContainEqual(['ip', 'route', 'replace', '10.88.0.0/22', 'dev', 'wg0', 'src', '10.88.1.5']);
	});

	test('reads status and treats a missing interface as empty', async () => {
		const manager = new WireguardManager({
			paths: { dir: join(dir, 'status'), privateKeyPath: join(dir, 'keys', 'wg0.key'), configPath: join(dir, 'status', 'wg0.conf') },
			runner: fakeRunner([]),
		});
		const status = await manager.status();
		expect(status.interface).toBe('wg0');
		expect(status.peers[0]).toMatchObject({ publicKey, endpoint: '203.0.113.10:51820', rxBytes: 123, txBytes: 456 });
	});

	test('rejects an invalid state', async () => {
		const manager = new WireguardManager({ paths: { dir: join(dir, 'bad') }, runner: fakeRunner([]) });
		await expect(manager.apply({ mode: 'yoal', address: 'nope', mtu: 9000, listenPort: 0, peers: [] })).rejects.toThrow();
	});
});

describe('renderConfig', () => {
	test('emits setconf syntax, not wg-quick keys', () => {
		const config = renderConfig('private', state);
		expect(config).toContain('[Interface]');
		expect(config).not.toContain('Address =');
		expect(config).not.toContain('PostUp');
	});
});
