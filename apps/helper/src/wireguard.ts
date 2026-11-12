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
	mode: 'yoal' | 'external' | 'edge';
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

/**
 * Under `/etc/wireguard/`, because Ubuntu's AppArmor profile for `/usr/bin/wg` only lets it read
 * files there: from `/etc/yoal/wireguard/` `wg setconf` fails with "fopen: Permission denied".
 */
export const DEFAULT_WIREGUARD_PATHS: WireguardPaths = {
	interface: 'wg0',
	dir: '/etc/wireguard/yoal',
	privateKeyPath: '/etc/wireguard/yoal/wg0.key',
	configPath: '/etc/wireguard/yoal/wg0.conf',
	wgPath: 'wg',
	ipPath: 'ip',
};

/** Where releases before 0.14.5 kept the key; `keygen` moves it so the node keeps its identity. */
export const LEGACY_WIREGUARD_KEY_PATH = '/etc/yoal/wireguard/wg0.key';

export class WireguardManager {
	private readonly paths: WireguardPaths;
	private readonly runner: CommandRunner;
	private readonly firewall?: { apply(): Promise<unknown> };
	private readonly legacyKeyPath: string | null;

	constructor(
		options: {
			paths?: Partial<WireguardPaths>;
			runner?: CommandRunner;
			firewall?: { apply(): Promise<unknown> };
			legacyKeyPath?: string | null;
		} = {},
	) {
		this.paths = { ...DEFAULT_WIREGUARD_PATHS, ...options.paths };
		// Only the default layout migrates; a test or custom layout names its own paths.
		this.legacyKeyPath = options.paths?.privateKeyPath ? (options.legacyKeyPath ?? null) : (options.legacyKeyPath ?? LEGACY_WIREGUARD_KEY_PATH);
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
			privateKey = '';
		}
		if (!privateKey && this.legacyKeyPath && this.legacyKeyPath !== this.paths.privateKeyPath) {
			// Keep the identity the control plane already has: a new key would orphan every peer.
			const legacy = await fs.readFile(this.legacyKeyPath, 'utf8').catch(() => '');
			if (legacy.trim()) {
				privateKey = legacy.trim();
				await fs.writeFile(this.paths.privateKeyPath, `${privateKey}\n`, { mode: 0o600 });
				await fs.chmod(this.paths.privateKeyPath, 0o600);
				await fs.rm(this.legacyKeyPath, { force: true });
			}
		}
		if (!privateKey) {
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
		// A node adopted into the overlay after it joined has no key yet; keygen keeps an existing one.
		await this.keygen();
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
		// The address is a /32, so nothing routes the overlay to the interface by itself: without
		// this, traffic to a peer leaves through the default gateway. `src` pins the reply address.
		if (state.cidr) {
			const route = await this.runIp(['route', 'replace', state.cidr, 'dev', this.paths.interface, 'src', state.address]);
			if (route.code !== 0) throw new WireguardError(`could not route ${state.cidr} via ${this.paths.interface}: ${route.stderr.trim()}`);
		}
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
	if (mode !== 'yoal' && mode !== 'external' && mode !== 'edge') throw new WireguardError('invalid network mode');
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
