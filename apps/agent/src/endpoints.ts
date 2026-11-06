import { createServer, connect, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer, connect as connectTls, type TLSSocket } from 'node:tls';
import type { ServiceEndpoint, ServiceProvider } from '@skiff/contracts';

/**
 * Cross-node service forwarding (docs/CLUSTERING.md §4.3, phase C2, Bun fallback).
 *
 * The control plane plans the endpoints; this process owns only the sockets. A consumer listens
 * on 127.0.0.1:<localPort> and pipes to the provider's overlay address. A provider listens on its
 * overlay address and pipes to the service's loopback port. WireGuard encrypts the hop today;
 * the mTLS/Caddy-L4 path can replace this class without changing the desired-state contract.
 */

interface Listener {
	server: Server;
	signature: string;
}

export class ServiceForwarder {
	private readonly consumers = new Map<number, Listener>();
	private readonly providers = new Map<number, Listener>();
	private readonly log: (level: 'info' | 'warn', message: string) => void;
	private readonly certificate?: { certPem: string; keyPem: string };

	constructor(options: { log?: (level: 'info' | 'warn', message: string) => void; certificate?: { certPem: string; keyPem: string } } = {}) {
		this.log = options.log ?? (() => undefined);
		this.certificate = options.certificate;
	}

	/** Reconcile listeners to desired state. Idempotent; changed upstreams restart that listener. */
	converge(endpoints: ServiceEndpoint[], providers: ServiceProvider[]): { started: number; stopped: number } {
		const wantedConsumers = new Map<number, ServiceEndpoint>();
		for (const endpoint of endpoints) wantedConsumers.set(endpoint.localPort, endpoint);
		const wantedProviders = new Map<number, ServiceProvider>();
		for (const provider of providers) wantedProviders.set(provider.listenPort, provider);

		let stopped = 0;
		let started = 0;
		for (const [port, listener] of this.consumers) {
			const wanted = wantedConsumers.get(port);
			if (!wanted || listener.signature !== signatureOf(wanted)) {
				closeListener(listener);
				this.consumers.delete(port);
				stopped += 1;
			}
		}
		for (const [port, listener] of this.providers) {
			const wanted = wantedProviders.get(port);
			if (!wanted || listener.signature !== signatureOfProvider(wanted)) {
				closeListener(listener);
				this.providers.delete(port);
				stopped += 1;
			}
		}
		for (const endpoint of wantedConsumers.values()) {
			if (this.consumers.has(endpoint.localPort)) continue;
			this.consumers.set(
				endpoint.localPort,
				this.listenConsumer(endpoint),
			);
			started += 1;
		}
		for (const provider of wantedProviders.values()) {
			if (this.providers.has(provider.listenPort)) continue;
			this.providers.set(
				provider.listenPort,
				this.listenProvider(provider),
			);
			started += 1;
		}
		return { started, stopped };
	}

	/** Stop every listener; used on shutdown. */
	close(): void {
		for (const listener of [...this.consumers.values(), ...this.providers.values()]) closeListener(listener);
		this.consumers.clear();
		this.providers.clear();
	}

	private listenConsumer(endpoint: ServiceEndpoint): Listener {
		const bind = '127.0.0.1';
		const port = endpoint.localPort;
		const targetHost = endpoint.upstream.address;
		const targetPort = endpoint.upstream.port;
		const fingerprint = endpoint.tlsFingerprint;
		const server = createServer((socket) => {
			if (!targetHost) {
				socket.destroy();
				return;
			}
			if (!this.certificate || !fingerprint) {
				this.pipePlain(socket, targetHost, targetPort);
				return;
			}
			const upstream = connectTls(
				{
					host: targetHost,
					port: targetPort,
					key: this.certificate.keyPem,
					cert: this.certificate.certPem,
					rejectUnauthorized: false,
				},
				() => {
					const peer = normalizeFingerprint(upstream.getPeerCertificate().fingerprint256 ?? '');
					if (peer !== fingerprint) {
						this.log('warn', `endpoint ${bind}:${port} provider certificate does not match the pinned fingerprint`);
						socket.destroy();
						upstream.destroy();
						return;
					}
					upstream.pipe(socket).pipe(upstream);
				},
			);
			upstream.on('error', () => socket.destroy());
			socket.on('error', () => upstream.destroy());
		});
		server.on('error', (error) => this.log('warn', `endpoint ${bind}:${port} could not listen: ${error.message}`));
		server.listen(port, bind);
		return { server, signature: `${bind}:${port}->${targetHost}:${targetPort}:${fingerprint ?? 'plain'}` };
	}

	private listenProvider(provider: ServiceProvider): Listener {
		const bind = provider.listenAddress;
		const port = provider.listenPort;
		const allowed = new Set(provider.allowedClientFingerprints);
		if (!this.certificate) {
			const server = createServer((socket) => this.pipePlain(socket, '127.0.0.1', provider.targetPort));
			server.on('error', (error) => this.log('warn', `provider ${bind}:${port} could not listen: ${error.message}`));
			server.listen(port, bind);
			return { server, signature: `${bind}:${port}->127.0.0.1:${provider.targetPort}:plain` };
		}
		const server = createTlsServer(
			{
				key: this.certificate.keyPem,
				cert: this.certificate.certPem,
				requestCert: true,
				rejectUnauthorized: false,
			},
			(socket: TLSSocket) => {
				const peer = normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? '');
				if (!allowed.has(peer)) {
					this.log('warn', `provider ${bind}:${port} rejected an unknown client certificate`);
					socket.destroy();
					return;
				}
				this.pipePlain(socket, '127.0.0.1', provider.targetPort);
			},
		);
		server.on('error', (error) => this.log('warn', `provider ${bind}:${port} could not listen: ${error.message}`));
		server.listen(port, bind);
		return {
			server,
			signature: `${bind}:${port}->127.0.0.1:${provider.targetPort}:${[...allowed].sort().join(',')}`,
		};
	}

	private pipePlain(socket: Socket, host: string, port: number): void {
		const upstream = connect({ host, port });
		upstream.on('error', (error) => {
			this.log('warn', `endpoint -> ${host}:${port} failed: ${error.message}`);
			socket.destroy();
		});
		socket.on('error', () => upstream.destroy());
		upstream.pipe(socket).pipe(upstream);
	}
}

function signatureOf(endpoint: ServiceEndpoint): string {
	return `${endpoint.localPort}->${endpoint.upstream.address ?? ''}:${endpoint.upstream.port}`;
}

function signatureOfProvider(provider: ServiceProvider): string {
	return `${provider.listenAddress}:${provider.listenPort}->127.0.0.1:${provider.targetPort}:${[...provider.allowedClientFingerprints].sort().join(',')}`;
}

function normalizeFingerprint(value: string): string {
	return value.replaceAll(':', '').toLowerCase();
}

function closeListener(listener: Listener): void {
	try {
		listener.server.close();
	} catch {
		// A listener that never bound has nothing to close.
	}
}
