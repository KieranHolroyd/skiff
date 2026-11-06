import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkManager } from './network.ts';
import type { CommandRunner } from './wireguard.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-network-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runnerFor(status: { ufw?: string; firewalld?: string }, calls: string[][]): CommandRunner {
	return async (argv) => {
		calls.push(argv);
		if (argv[0] === 'ufw' && argv[1] === 'status') return { code: 0, stdout: status.ufw ?? 'Status: inactive', stderr: '' };
		if (argv[0] === 'firewall-cmd' && argv[1] === '--state')
			return { code: 0, stdout: status.firewalld ?? 'not running', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	};
}

describe('NetworkManager', () => {
	test('opens the underlay port and overlay port through ufw', async () => {
		const calls: string[][] = [];
		const manager = new NetworkManager({ runner: runnerFor({ ufw: 'Status: active' }, calls), paths: { configPath: join(dir, 'ufw.nft') } });
		expect(await manager.apply()).toEqual({ backend: 'ufw', opened: 2 });
		expect(calls).toContainEqual(['ufw', 'allow', '51820/udp']);
		expect(calls.some((call) => call.includes('8080'))).toBe(true);
	});

	test('uses firewalld when it is running', async () => {
		const calls: string[][] = [];
		const manager = new NetworkManager({ runner: runnerFor({ firewalld: 'running' }, calls), paths: { configPath: join(dir, 'fw.nft') } });
		expect(await manager.apply()).toEqual({ backend: 'firewalld', opened: 2 });
		expect(calls).toContainEqual(['firewall-cmd', '--permanent', '--add-port=51820/udp']);
	});

	test('falls back to a dedicated nftables table', async () => {
		const calls: string[][] = [];
		const path = join(dir, 'skiff.nft');
		const manager = new NetworkManager({ runner: runnerFor({}, calls), paths: { configPath: path } });
		expect(await manager.apply()).toEqual({ backend: 'nftables', opened: 1 });
		expect(readFileSync(path, 'utf8')).toContain('table inet skiff');
		expect(calls).toContainEqual(['nft', '-c', '-f', path]);
		expect(calls).toContainEqual(['nft', '-f', path]);
	});

	test('renders a default-drop overlay chain with the served ports', () => {
		const manager = new NetworkManager({ paths: { configPath: join(dir, 'render.nft'), overlayTcpPorts: [8080, 9090] } });
		const rules = manager.renderNftables();
		expect(rules).toContain('tcp dport 8080 accept');
		expect(rules).toContain('tcp dport 9090 accept');
		expect(rules).toContain('iifname "wg0" drop');
	});
});
