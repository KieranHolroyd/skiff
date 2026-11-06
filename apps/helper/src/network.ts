import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { defaultRunner, type CommandRunner } from './wireguard.ts';

/**
 * Overlay firewall (docs/CLUSTERING.md §4.1, phase C1).
 *
 * The helper owns one small firewall policy: the underlay WireGuard port and only the overlay
 * ports a node actually serves. It prefers the host's existing manager (ufw or firewalld) when one
 * is active, and otherwise writes a dedicated `inet skiff` nftables table. It never edits the
 * host's own filter table.
 */

export interface NetworkPaths {
	interface: string;
	wireguardPort: number;
	/** TCP ports reachable over the overlay; C1 is Caddy 8080. */
	overlayTcpPorts: number[];
	nftPath: string;
	ufwPath: string;
	firewallCmdPath: string;
	configPath: string;
}

export const DEFAULT_NETWORK_PATHS: NetworkPaths = {
	interface: 'wg0',
	wireguardPort: 51820,
	overlayTcpPorts: [8080],
	nftPath: 'nft',
	ufwPath: 'ufw',
	firewallCmdPath: 'firewall-cmd',
	configPath: '/etc/skiff/network/skiff.nft',
};

export type FirewallBackend = 'ufw' | 'firewalld' | 'nftables' | 'none';

export class NetworkManager {
	private readonly paths: NetworkPaths;
	private readonly runner: CommandRunner;

	constructor(options: { paths?: Partial<NetworkPaths>; runner?: CommandRunner } = {}) {
		this.paths = { ...DEFAULT_NETWORK_PATHS, ...options.paths };
		this.runner = options.runner ?? defaultRunner;
	}

	/** Open the underlay port and restrict overlay TCP to the served ports. Idempotent. */
	async apply(): Promise<{ backend: FirewallBackend; opened: number }> {
		const ufw = await this.runner([this.paths.ufwPath, 'status']);
		if (ufw.code === 0 && /Status:\s*active/i.test(ufw.stdout)) {
			await this.expect([this.paths.ufwPath, 'allow', `${this.paths.wireguardPort}/udp`], 'ufw allow wireguard');
			for (const port of this.paths.overlayTcpPorts)
				await this.expect(
					[this.paths.ufwPath, 'allow', 'in', 'on', this.paths.interface, 'to', 'any', 'port', String(port), 'proto', 'tcp'],
					'ufw allow overlay',
				);
			return { backend: 'ufw', opened: 1 + this.paths.overlayTcpPorts.length };
		}

		const firewalld = await this.runner([this.paths.firewallCmdPath, '--state']);
		if (firewalld.code === 0 && /^running\s*$/i.test(firewalld.stdout.trim())) {
			await this.expect(
				[this.paths.firewallCmdPath, '--permanent', `--add-port=${this.paths.wireguardPort}/udp`],
				'firewalld wireguard port',
			);
			await this.expect(
				[this.paths.firewallCmdPath, '--permanent', '--zone=trusted', `--add-interface=${this.paths.interface}`],
				'firewalld trusted overlay',
			);
			await this.expect([this.paths.firewallCmdPath, '--reload'], 'firewalld reload');
			return { backend: 'firewalld', opened: 1 + this.paths.overlayTcpPorts.length };
		}

		// No host manager detected: a dedicated table with a default-drop overlay chain.
		await fs.mkdir(dirname(this.paths.configPath), { recursive: true, mode: 0o755 });
		await fs.writeFile(this.paths.configPath, this.renderNftables(), { mode: 0o644 });
		const check = await this.runner([this.paths.nftPath, '-c', '-f', this.paths.configPath]);
		if (check.code !== 0) throw new Error(`nftables check failed: ${check.stderr.trim()}`);
		await this.expect([this.paths.nftPath, '-f', this.paths.configPath], 'nftables apply');
		return { backend: 'nftables', opened: this.paths.overlayTcpPorts.length };
	}

	/** Ruleset rendered for review and for `nft -f`; no shell interpolation. */
	renderNftables(): string {
		const accept = this.paths.overlayTcpPorts
			.map((port) => `\t\tiifname "${this.paths.interface}" tcp dport ${port} accept`)
			.join('\n');
		return `table inet skiff {
\tchain input {
\t\ttype filter hook input priority -10; policy accept;
${accept}
\t\tiifname "${this.paths.interface}" drop
\t}
}
`;
	}

	private async expect(argv: string[], label: string): Promise<void> {
		const result = await this.runner(argv);
		if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr.trim() || result.stdout.trim()}`);
	}
}
