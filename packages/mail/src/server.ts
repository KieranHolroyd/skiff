import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SMTPServer } from 'smtp-server';
import {
	mailInjectSchema,
	mailStateSchema,
	parseAddress,
	type MailHealth,
	type MailInject,
	type MailState,
} from '@yoal/contracts';
import { SystemResolver, type MailResolver } from './dns.ts';
import { prepareHeaders, signMessage } from './message.ts';
import { MailPolicy } from './policy.ts';
import { DeliveryQueue } from './queue.ts';
import { Shaper } from './shaping.ts';
import { createInboundServer, createSubmissionServer, type SmtpTls } from './smtp.ts';
import { Spool, type EventInput } from './spool.ts';

/**
 * `yoal-mail`: Yoal's MTA (EMAIL.md §3.2, D115). It holds no credentials and never dials the
 * control plane; the node agent pushes state, injects outbox mail and pulls events over the
 * control socket.
 */

export interface MailServerConfig {
	dataDir: string;
	/** Unix socket for the control API; null serves nothing (tests call `handle`). */
	controlSocket: string | null;
	listen: {
		host: string;
		/** null leaves a listener off. */
		inbound: number | null;
		submission: number | null;
		submissions: number | null;
	};
	/** Directory with `cert.pem` + `key.pem`, written by the agent from Caddy's certificate. */
	tlsDir?: string | null;
	/** Or the certificate directly (tests). */
	tls?: SmtpTls | null;
	/** Port on recipient MX hosts: 25, or a fake MX in tests. */
	deliveryPort?: number;
	ipv6?: boolean;
	resolver?: MailResolver;
	now?: () => number;
	log?: (message: string) => void;
	/** Scheduler tick; 0 leaves the timer off (tests tick by hand). */
	tickMs?: number;
}

const HISTORY_DAYS = 30;

export class MailServer {
	readonly spool: Spool;
	readonly policy: MailPolicy;
	readonly shaper: Shaper;
	readonly queue: DeliveryQueue;
	private tls: SmtpTls | null;
	private readonly servers = new Map<string, { server: SMTPServer; port: number; ok: boolean }>();
	private control: ReturnType<typeof Bun.serve> | null = null;
	private pruneTimer: ReturnType<typeof setInterval> | null = null;
	private readonly now: () => number;
	private readonly log: (message: string) => void;

	constructor(private readonly config: MailServerConfig) {
		this.now = config.now ?? Date.now;
		this.log = config.log ?? ((message) => console.log(`[yoal-mail] ${message}`));
		this.spool = new Spool(config.dataDir);
		this.policy = new MailPolicy(this.now);
		this.shaper = new Shaper(this.now);
		this.tls = config.tls ?? this.readTls();
		this.queue = new DeliveryQueue({
			spool: this.spool,
			policy: this.policy,
			shaper: this.shaper,
			delivery: { resolver: config.resolver ?? new SystemResolver(), port: config.deliveryPort ?? 25, ipv6: config.ipv6 ?? false },
			hostnames: () => this.policy.state?.hostnames ?? null,
			now: this.now,
			log: this.log,
		});
	}

	private readTls(): SmtpTls | null {
		const dir = this.config.tlsDir;
		if (!dir) return null;
		const cert = join(dir, 'cert.pem');
		const key = join(dir, 'key.pem');
		if (!existsSync(cert) || !existsSync(key)) return null;
		try {
			return { cert: readFileSync(cert), key: readFileSync(key) };
		} catch (error) {
			this.log(`cannot read TLS files in ${dir}: ${String(error)}`);
			return null;
		}
	}

	async start(): Promise<void> {
		const { listen } = this.config;
		if (listen.inbound !== null) await this.listen('inbound', listen.inbound);
		if (listen.submission !== null && this.tls) await this.listen('submission', listen.submission);
		if (listen.submissions !== null && this.tls) await this.listen('submissions', listen.submissions);
		if (!this.tls && (listen.submission !== null || listen.submissions !== null))
			this.log('no TLS certificate yet: submission stays off until the agent provides one');
		if (this.config.controlSocket) this.serveControl(this.config.controlSocket);
		if ((this.config.tickMs ?? 1000) > 0) this.queue.start(this.config.tickMs ?? 1000);
		this.pruneTimer = setInterval(() => this.spool.pruneHistory(this.now() - HISTORY_DAYS * 86_400_000), 3_600_000);
	}

	async stop(): Promise<void> {
		await this.queue.stop();
		if (this.pruneTimer) clearInterval(this.pruneTimer);
		await Promise.all([...this.servers.values()].map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));
		this.servers.clear();
		if (this.control) {
			this.control.stop(true);
			this.control = null;
		}
		this.spool.close();
	}

	/** The port a listener actually bound (tests use port 0). */
	port(name: 'inbound' | 'submission' | 'submissions'): number | null {
		return this.servers.get(name)?.port ?? null;
	}

	private createServer(name: string): SMTPServer {
		const deps = {
			policy: this.policy,
			spool: this.spool,
			now: this.now,
			log: this.log,
		};
		if (name === 'inbound') return createInboundServer({ ...deps, hostnames: () => this.policy.state?.hostnames ?? null }, this.tls);
		return createSubmissionServer(
			{ ...deps, hostname: () => this.policy.state?.hostnames.submission ?? 'localhost', onAccepted: () => this.queue.kick() },
			this.tls,
			name === 'submissions',
		);
	}

	private listen(name: string, port: number): Promise<void> {
		const server = this.createServer(name);
		server.on('error', (error: Error) => this.log(`${name} listener: ${error.message}`));
		return new Promise((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			server.server.once('error', onError);
			server.listen(port, this.config.listen.host, () => {
				server.server.off('error', onError);
				const address = server.server.address();
				const bound = typeof address === 'object' && address ? address.port : port;
				this.servers.set(name, { server, port: bound, ok: true });
				resolve();
			});
		});
	}

	/** New certificate from the agent: refresh running listeners, start submission if it was waiting. */
	async reloadTls(tls?: SmtpTls): Promise<void> {
		this.tls = tls ?? this.readTls();
		if (!this.tls) return;
		for (const { server } of this.servers.values()) server.updateSecureContext({ key: this.tls.key, cert: this.tls.cert });
		const { listen } = this.config;
		if (listen.submission !== null && !this.servers.has('submission')) await this.listen('submission', listen.submission);
		if (listen.submissions !== null && !this.servers.has('submissions')) await this.listen('submissions', listen.submissions);
	}

	loadState(state: MailState): void {
		this.policy.load(state);
		this.queue.kick();
	}

	/** Sign and spool an outbox message (D117). Idempotent on the message id. */
	async inject(input: MailInject): Promise<{ status: number; body: Record<string, unknown> }> {
		if (this.spool.has(input.messageId)) return { status: 200, body: { queued: true, duplicate: true } };
		if (!this.policy.state) return { status: 503, body: { error: 'no mail state yet' } };
		const from = parseAddress(input.from);
		if (!from) return { status: 422, body: { error: `invalid sender ${input.from}` } };
		const domain = this.policy.domain(from.domain);
		// The platform's own sender (orgId '*') signs platform mail logged under any org (EMAIL.md §4.3).
		if (!domain || (domain.orgId !== input.orgId && domain.orgId !== '*') || !domain.sending || domain.dkim.length === 0)
			return { status: 409, body: { error: `${from.domain} is not a sending domain with a key on this node` } };
		const at = new Date(this.now());
		const raw = Buffer.from(input.raw, 'base64');
		const signed = await signMessage(prepareHeaders(raw, input.messageId, from.address, at), domain);
		this.spool.accept(
			{ id: input.messageId, orgId: input.orgId, projectId: input.projectId, from: from.address, source: 'api', tags: input.tags },
			signed,
			input.recipients,
			[],
			at.getTime(),
		);
		this.policy.record(input.orgId);
		this.queue.kick();
		return { status: 200, body: { queued: true } };
	}

	health(): MailHealth {
		const counts = this.spool.counts();
		const listeners = (['inbound', 'submission', 'submissions'] as const)
			.filter((name) => this.config.listen[name] !== null)
			.map((name) => ({ name, port: this.servers.get(name)?.port ?? this.config.listen[name]!, ok: this.servers.has(name) }));
		return {
			ok: listeners.every((listener) => listener.ok || listener.name !== 'inbound') && this.policy.state !== null,
			generation: this.policy.generation,
			queued: counts.queued,
			deferred: counts.deferred,
			oldestQueuedAt: counts.oldestQueuedAt === null ? null : new Date(counts.oldestQueuedAt).toISOString(),
			pendingEvents: this.spool.pendingEvents(),
			listeners,
			tls: this.tls !== null,
		};
	}

	emit(event: EventInput): void {
		this.spool.emit(event);
	}

	/** The control API (EMAIL.md §3.2). Only the agent can reach the socket (0660 yoal:yoal). */
	async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
		try {
			if (request.method === 'GET' && url.pathname === '/health') return json(this.health());
			if (request.method === 'PUT' && url.pathname === '/state') {
				const parsed = mailStateSchema.safeParse(await request.json());
				if (!parsed.success) return json({ error: parsed.error.message }, 422);
				this.loadState(parsed.data);
				return json({ generation: parsed.data.generation });
			}
			if (request.method === 'POST' && url.pathname === '/inject') {
				const parsed = mailInjectSchema.safeParse(await request.json());
				if (!parsed.success) return json({ error: parsed.error.message }, 422);
				const result = await this.inject(parsed.data);
				return json(result.body, result.status);
			}
			if (request.method === 'GET' && url.pathname === '/events') {
				const after = Number(url.searchParams.get('after') ?? 0);
				const limit = Math.min(Number(url.searchParams.get('limit') ?? 500), 1000);
				return json({ events: this.spool.events(Number.isFinite(after) ? after : 0, limit) });
			}
			if (request.method === 'POST' && url.pathname === '/events/ack') {
				const body = (await request.json()) as { upTo?: unknown };
				if (typeof body.upTo !== 'number') return json({ error: 'upTo must be a number' }, 422);
				return json({ deleted: this.spool.ack(body.upTo) });
			}
			if (request.method === 'POST' && url.pathname === '/tls/reload') {
				await this.reloadTls();
				return json({ tls: this.tls !== null });
			}
			return json({ error: 'not found' }, 404);
		} catch (error) {
			this.log(`control ${request.method} ${url.pathname}: ${String(error)}`);
			return json({ error: 'internal error' }, 500);
		}
	}

	private serveControl(socket: string): void {
		rmSync(socket, { force: true });
		this.control = Bun.serve({ unix: socket, fetch: (request) => this.handle(request) });
		chmodSync(socket, 0o660);
	}
}
