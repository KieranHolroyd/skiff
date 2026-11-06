import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Kernel WireGuard for the private overlay (docs/CLUSTERING.md §4.1, phase C1).
 *
 * The helper owns the privileged part: it generates the private key, writes a root-only config,
 * and applies peers with `ip`/`wg`. No shell is involved and every argument comes from the
 * validated state. `wg-quick` and networkd are deliberately not used; they would take over the
 * host's network manager.
 */

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (argv: string[], input?: string) => Promise<CommandResult>;

export interface WireguardPaths {
	interface: string;
	dir: string;
	privateKeyPath: string;
	configPath: string;
	wgPath: string;
	ipPath: string;
}

export interface WireguardPeer {
	publicKey: string;
	endpoint: string | null;
	allowedIps: string[];
	persistentKeepalive: number;
}

export interface WireguardState {
	mode: 'skiff' | 'external' | 'edge';
	address: string | null;
	cidr: string | null;
	mtu: number;
	listenPort: number;
	peers: WireguardPeer[];
}

export interface WireguardStatusPeer {
	publicKey: string;
	endpoint: string | null;
	latestHandshakeAt: string | null;
	rxBytes: number;
	txBytes: number;
}

export interface WireguardStatus {
	interface: string;
	peers: WireguardStatusPeer[];
}

export class WireguardError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WireguardError';
	}
}

export const DEFAULT_WIREGUARD_PATHS: WireguardPaths = {
	interface: 'wg0',
	dir: '/etc/skiff/wireguard',
	privateKeyPath: '/etc/skiff/wireguard/wg0.key',
	configPath: '/etc/skiff/wireguard/wg0.conf',
	wgPath: 'wg',
	ipPath: 'ip',
};

export class WireguardManager {
	private readonly paths: WireguardPaths;
	private readonly runner: CommandRunner;
	private readonly firewall?: { apply(): Promise<unknown> };

	constructor(options: { paths?: Partial<WireguardPaths>; runner?: CommandRunner; firewall?: { apply(): Promise<unknown> } } = {}) {
		this.paths = { ...DEFAULT_WIREGUARD_PATHS, ...options.paths };
		this.runner = options.runner ?? defaultRunner;
		this.firewall = options.firewall;
	}

	/** Generate the key pair on the node, or read the existing private key. Public key only. */
	async keygen(): Promise<{ publicKey: string }> {
		await fs.mkdir(this.paths.dir, { recursive: true, mode: 0o700 });
		let privateKey: string;
		try {
			privateKey = (await fs.readFile(this.paths.privateKeyPath, 'utf8')).trim();
		} catch {
			const generated = await this.runWg(['genkey']);
			privateKey = generated.stdout.trim();
			if (!privateKey) throw new WireguardError('wg genkey returned no key');
			await fs.writeFile(this.paths.privateKeyPath, `${privateKey}\n`, { mode: 0o600 });
			await fs.chmod(this.paths.privateKeyPath, 0o600);
		}
		const publicKey = (await this.runWg(['pubkey'], `${privateKey}\n`)).stdout.trim();
		if (!publicKey) throw new WireguardError('wg pubkey returned no key');
		return { publicKey };
	}

	/** Apply interface address, MTU, listen port and every peer. Idempotent. */
	async apply(raw: unknown): Promise<{ peers: number }> {
		const state = parseWireguardState(raw);
		if (state.mode === 'external' || !state.address) return { peers: 0 };
		const privateKey = (await fs.readFile(this.paths.privateKeyPath, 'utf8')).trim();
		if (!privateKey) throw new WireguardError('the WireGuard private key is missing; run keygen first');
		await fs.mkdir(this.paths.dir, { recursive: true, mode: 0o700 });
		await fs.writeFile(this.paths.configPath, renderConfig(privateKey, state), { mode: 0o600 });
		await fs.chmod(this.paths.configPath, 0o600);

		await this.ensureInterface();
		await this.runIp(['addr', 'replace', `${state.address}/32`, 'dev', this.paths.interface]);
		await this.runIp(['link', 'set', 'mtu', String(state.mtu), 'dev', this.paths.interface]);
		await this.runIp(['link', 'set', this.paths.interface, 'up']);
		const setconf = await this.runWg(['setconf', this.paths.interface, this.paths.configPath]);
		if (setconf.code !== 0) throw new WireguardError(`wg setconf failed: ${setconf.stderr.trim()}`);
		await this.firewall?.apply();
		return { peers: state.peers.length };
	}

	/** Latest handshake and counters per peer, from `wg show <if> dump`. */
	async status(): Promise<WireguardStatus> {
		const result = await this.runWg(['show', this.paths.interface, 'dump']);
		if (result.code !== 0) return { interface: this.paths.interface, peers: [] };
		const lines = result.stdout.trim().split('\n').filter(Boolean);
		const peers: WireguardStatusPeer[] = [];
		for (const line of lines.slice(1)) {
			const fields = line.split('\t');
			if (fields.length < 7) continue;
			const handshake = Number(fields[4]);
			peers.push({
				publicKey: fields[0]!,
				endpoint: fields[2] && fields[2] !== '(none)' ? fields[2] : null,
				latestHandshakeAt:
					Number.isFinite(handshake) && handshake > 0 ? new Date(handshake * 1000).toISOString() : null,
				rxBytes: Number(fields[5]) || 0,
				txBytes: Number(fields[6]) || 0,
			});
		}
		return { interface: this.paths.interface, peers };
	}

	private async ensureInterface(): Promise<void> {
		const added = await this.runIp(['link', 'add', this.paths.interface, 'type', 'wireguard']);
		if (added.code !== 0 && !/file exists|already exists/i.test(added.stderr)) {
			throw new WireguardError(`could not create ${this.paths.interface}: ${added.stderr.trim()}`);
		}
	}

	private runWg(args: string[], input?: string): Promise<CommandResult> {
		return this.runner([this.paths.wgPath, ...args], input).catch((error: unknown) => {
			throw new WireguardError(error instanceof Error ? error.message : String(error));
		});
	}

	private runIp(args: string[]): Promise<CommandResult> {
		return this.runner([this.paths.ipPath, ...args]).catch((error: unknown) => {
			throw new WireguardError(error instanceof Error ? error.message : String(error));
		});
	}
}

/** Render a wg setconf config; the private key is written 0600 root inside the config directory. */
export function renderConfig(privateKey: string, state: WireguardState): string {
	const lines = ['[Interface]', `PrivateKey = ${privateKey}`, `ListenPort = ${state.listenPort}`];
	for (const peer of state.peers) {
		lines.push('', '[Peer]', `PublicKey = ${peer.publicKey}`, `AllowedIPs = ${peer.allowedIps.join(', ')}`);
		if (peer.endpoint) lines.push(`Endpoint = ${peer.endpoint}`);
		if (peer.persistentKeepalive > 0) lines.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
	}
	return `${lines.join('\n')}\n`;
}

/** Strict local validation: the helper does not link the control-plane contracts package. */
export function parseWireguardState(raw: unknown): WireguardState {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new WireguardError('state must be an object');
	const record = raw as Record<string, unknown>;
	const mode = record.mode;
	if (mode !== 'skiff' && mode !== 'external' && mode !== 'edge') throw new WireguardError('invalid network mode');
	const address = record.address;
	if (address !== null && (typeof address !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)))
		throw new WireguardError('invalid overlay address');
	const cidr = record.cidr;
	if (cidr !== null && typeof cidr !== 'string') throw new WireguardError('invalid overlay CIDR');
	const mtu = Number(record.mtu);
	if (!Number.isInteger(mtu) || mtu < 1280 || mtu > 1420) throw new WireguardError('invalid MTU');
	const listenPort = Number(record.listenPort);
	if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535) throw new WireguardError('invalid listen port');
	const peersRaw = record.peers;
	if (!Array.isArray(peersRaw) || peersRaw.length > 64) throw new WireguardError('peers must be an array of at most 64');
	const peers = peersRaw.map((value, index) => {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WireguardError(`peer ${index} is invalid`);
		const peer = value as Record<string, unknown>;
		if (typeof peer.publicKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(peer.publicKey))
			throw new WireguardError(`peer ${index} has an invalid public key`);
		if (peer.endpoint !== null && typeof peer.endpoint !== 'string') throw new WireguardError(`peer ${index} has an invalid endpoint`);
		if (!Array.isArray(peer.allowedIps) || peer.allowedIps.length === 0 || peer.allowedIps.length > 64)
			throw new WireguardError(`peer ${index} has invalid allowed IPs`);
		for (const ip of peer.allowedIps)
			if (typeof ip !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}\/32$/.test(ip))
				throw new WireguardError(`peer ${index} has an invalid allowed IP`);
		const keepalive = peer.persistentKeepalive === undefined ? 0 : Number(peer.persistentKeepalive);
		if (!Number.isInteger(keepalive) || keepalive < 0 || keepalive > 65_535)
			throw new WireguardError(`peer ${index} has an invalid keepalive`);
		return {
			publicKey: peer.publicKey,
			endpoint: peer.endpoint as string | null,
			allowedIps: peer.allowedIps as string[],
			persistentKeepalive: keepalive,
		};
	});
	return { mode, address, cidr, mtu, listenPort, peers };
}

export const defaultRunner: CommandRunner = async (argv, input) => {
	const proc = Bun.spawn(argv, {
		stdin: input === undefined ? 'ignore' : new Blob([input]),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	return { code, stdout, stderr };
};
