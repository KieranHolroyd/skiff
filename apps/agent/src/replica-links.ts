import { promises as fs } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { join } from 'node:path';
import { isDatabaseReplicaWorkloadId, type DatabaseReplicaLink } from '@skiff/contracts';

/**
 * Replica upstream links (docs/CLUSTERING.md §9.2, C7).
 *
 * A replica container has no route to the overlay, so its walreceiver (and the first-start
 * `pg_basebackup`) connects to a unix socket instead: `<root>/<replica id>/.s.PGSQL.5432`, which
 * the helper bind-mounts read-only at `/run/skiff-upstream`. This class serves that socket and pipes
 * each connection to the primary: its loopback port when it runs on this node, or the primary
 * node's provider listener over the overlay, with this node's certificate and the primary node's
 * certificate pinned, exactly like a C2 consumer endpoint.
 *
 * The directory is created once and never replaced while the link lives: the container's bind
 * mount holds the directory, so only the socket file inside it may be recreated.
 */

export const REPLICA_LINK_SOCKET = '.s.PGSQL.5432';

interface Link {
	server: Server;
	signature: string;
	path: string;
	/** Open client connections: a walreceiver's lasts as long as the replica streams. */
	connections: Set<Socket>;
}

export interface ReplicaLinkOptions {
	/** `<agent data dir>/replication`; must match the helper's `SKIFF_HELPER_REPLICATION_DIR`. */
	root: string;
	certificate?: { certPem: string; keyPem: string };
	log?: (level: 'info' | 'warn', message: string) => void;
}

export class ReplicaLinkForwarder {
	private readonly root: string;
	private readonly certificate?: { certPem: string; keyPem: string };
	private readonly log: (level: 'info' | 'warn', message: string) => void;
	private readonly links = new Map<string, Link>();

	constructor(options: ReplicaLinkOptions) {
		this.root = options.root;
		this.certificate = options.certificate;
		this.log = options.log ?? (() => undefined);
	}

	/** Reconcile sockets to desired state; a changed upstream restarts that socket only. */
	async converge(links: readonly DatabaseReplicaLink[]): Promise<{ started: number; stopped: number }> {
		const wanted = new Map(
			links.filter((link) => isDatabaseReplicaWorkloadId(link.workloadId)).map((link) => [link.workloadId, link]),
		);
		let started = 0;
		let stopped = 0;
		for (const [id, link] of this.links) {
			const next = wanted.get(id);
			if (next && signatureOf(next) === link.signature) continue;
			await closeLink(link);
			this.links.delete(id);
			if (!next) await fs.rm(join(this.root, id), { recursive: true, force: true }).catch(() => undefined);
			stopped += 1;
		}
		if (wanted.size > 0 || this.links.size > 0) await fs.mkdir(this.root, { recursive: true, mode: 0o755 });
		await this.sweep(new Set(wanted.keys()));
		for (const link of wanted.values()) {
			if (this.links.has(link.workloadId)) continue;
			try {
				this.links.set(link.workloadId, await this.listen(link));
				started += 1;
			} catch (error) {
				this.log('warn', `replica link ${link.workloadId} could not listen: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { started, stopped };
	}

	/** Socket path for a replica (tests and the helper's mount must agree). */
	socketPath(workloadId: string): string {
		return join(this.root, workloadId, REPLICA_LINK_SOCKET);
	}

	async close(): Promise<void> {
		for (const link of this.links.values()) await closeLink(link);
		this.links.clear();
	}

	/** Remove link directories left by replicas this node no longer runs (an agent restart). */
	private async sweep(keep: ReadonlySet<string>): Promise<void> {
		const entries = await fs.readdir(this.root).catch(() => [] as string[]);
		for (const entry of entries) {
			if (!isDatabaseReplicaWorkloadId(entry) || keep.has(entry) || this.links.has(entry)) continue;
			await fs.rm(join(this.root, entry), { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async listen(link: DatabaseReplicaLink): Promise<Link> {
		const dir = join(this.root, link.workloadId);
		await fs.mkdir(dir, { recursive: true, mode: 0o755 });
		await fs.chmod(dir, 0o755).catch(() => undefined);
		const path = join(dir, REPLICA_LINK_SOCKET);
		await fs.rm(path, { force: true });
		const connections = new Set<Socket>();
		const server = createServer((socket) => {
			connections.add(socket);
			socket.once('close', () => connections.delete(socket));
			this.forward(link, socket);
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(path, () => {
				server.off('error', reject);
				resolve();
			});
		});
		server.on('error', (error) => this.log('warn', `replica link ${link.workloadId}: ${error.message}`));
		// The container's postgres uid must be able to connect; the socket only reaches Postgres,
		// which still asks the replication role for its password.
		await fs.chmod(path, 0o666);
		return { server, signature: signatureOf(link), path, connections };
	}

	private forward(link: DatabaseReplicaLink, socket: Socket): void {
		const upstream = link.upstream;
		if (upstream.kind === 'local') {
			pipe(socket, connect({ host: '127.0.0.1', port: upstream.port }), (message) =>
				this.log('warn', `replica link ${link.workloadId} -> 127.0.0.1:${upstream.port}: ${message}`),
			);
			return;
		}
		if (!upstream.address) {
			socket.destroy();
			return;
		}
		if (!this.certificate || !upstream.tlsFingerprint) {
			// No node certificate yet: plain over WireGuard, like the C2 endpoint fallback.
			pipe(socket, connect({ host: upstream.address, port: upstream.port }), (message) =>
				this.log('warn', `replica link ${link.workloadId} -> ${upstream.address}:${upstream.port}: ${message}`),
			);
			return;
		}
		const pinned = upstream.tlsFingerprint;
		const remote = connectTls(
			{
				host: upstream.address,
				port: upstream.port,
				key: this.certificate.keyPem,
				cert: this.certificate.certPem,
				rejectUnauthorized: false,
			},
			() => {
				const peer = (remote.getPeerCertificate().fingerprint256 ?? '').replaceAll(':', '').toLowerCase();
				if (peer !== pinned) {
					this.log('warn', `replica link ${link.workloadId}: the primary node's certificate does not match its pin`);
					socket.destroy();
					remote.destroy();
					return;
				}
				remote.pipe(socket).pipe(remote);
			},
		);
		remote.on('error', (error) => {
			this.log('warn', `replica link ${link.workloadId} -> ${upstream.address}:${upstream.port}: ${error.message}`);
			socket.destroy();
		});
		socket.on('error', () => remote.destroy());
	}
}

function pipe(socket: Socket, upstream: Socket, onError: (message: string) => void): void {
	upstream.on('error', (error) => {
		onError(error.message);
		socket.destroy();
	});
	socket.on('error', () => upstream.destroy());
	upstream.pipe(socket).pipe(upstream);
}

function signatureOf(link: DatabaseReplicaLink): string {
	const upstream = link.upstream;
	return upstream.kind === 'local'
		? `local:${upstream.port}`
		: `remote:${upstream.address ?? ''}:${upstream.port}:${upstream.tlsFingerprint ?? 'plain'}`;
}

async function closeLink(link: Link): Promise<void> {
	// `close` waits for open connections; a streaming walreceiver never ends on its own.
	for (const socket of link.connections) socket.destroy();
	await new Promise<void>((resolve) => {
		try {
			link.server.close(() => resolve());
		} catch {
			resolve();
		}
	});
	await fs.rm(link.path, { force: true }).catch(() => undefined);
}
