import {
	mailHealthSchema,
	mailStateSchema,
	type EmailEvent,
	type MailDesired,
	type MailHealth,
	type MailInject,
} from '@yoal/contracts';

/**
 * The agent's side of Email (docs/EMAIL.md §3.2, §3.5). On the mail node only, it:
 * - starts `yoal-mail` through the helper and stops it when the node stops being the mail node;
 * - pushes the mail state (opened DKIM keys, credential hashes, policy) whenever its generation
 *   moves or `yoal-mail` restarted and lost it;
 * - long-polls the control plane's outbox and injects messages, acknowledging only spooled ones;
 * - forwards `yoal-mail`'s events to the control plane and acks them back by cursor;
 * - copies the submission certificate out of Caddy (through the helper) and reloads TLS.
 *
 * `yoal-mail` never talks to the control plane: everything crosses this bridge.
 */

export interface HelperMailApi {
	mailStart(): Promise<void>;
	mailStop(): Promise<void>;
	mailTls(host: string): Promise<{ found: boolean; changed: boolean }>;
}

type Fetch = (input: string, init?: RequestInit & { unix?: string }) => Promise<Response>;
type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface MailBridgeOptions {
	controlUrl: string;
	nodeToken: string;
	/** `yoal-mail`'s control socket. */
	socketPath: string;
	helper: HelperMailApi;
	fetch?: Fetch;
	log: Log;
	/** Health/state/events cadence. */
	intervalMs?: number;
	/** Certificate refresh cadence. */
	tlsIntervalMs?: number;
	/** Outbox long-poll, seconds (the control plane caps it at 25). */
	outboxWaitSeconds?: number;
	/** false: no background loops; the caller drives `tick` and `drainOutbox` (tests). */
	loops?: boolean;
}

const EVENT_BATCH = 500;

export class MailBridge {
	private desired: MailDesired | null = null;
	private active = false;
	private started = false;
	private controller: AbortController | null = null;
	private ticking = false;
	private lastTlsAt = 0;
	private readonly fetch: Fetch;

	constructor(private readonly options: MailBridgeOptions) {
		this.fetch = options.fetch ?? (fetch as Fetch);
	}

	/** Called with every desired state. Starting and stopping are idempotent. */
	apply(desired: MailDesired | null): void {
		this.desired = desired;
		if (desired && !this.active) this.activate();
		else if (!desired && this.active) void this.deactivate();
	}

	get isActive(): boolean {
		return this.active;
	}

	async close(): Promise<void> {
		this.controller?.abort();
		this.controller = null;
		this.active = false;
	}

	private activate(): void {
		this.active = true;
		this.controller = new AbortController();
		const signal = this.controller.signal;
		if (this.options.loops === false) return;
		void this.loop(signal);
		void this.outboxLoop(signal);
	}

	private async deactivate(): Promise<void> {
		this.active = false;
		this.controller?.abort();
		this.controller = null;
		this.started = false;
		try {
			await this.options.helper.mailStop();
			this.options.log('info', 'This node is no longer the mail node: stopped yoal-mail');
		} catch (error) {
			this.options.log('warn', `Stopping yoal-mail failed: ${String(error)}`);
		}
	}

	private async loop(signal: AbortSignal): Promise<void> {
		const interval = this.options.intervalMs ?? 3000;
		while (!signal.aborted) {
			await this.tick().catch((error) => this.options.log('warn', `Mail bridge: ${String(error)}`));
			await sleep(interval, signal);
		}
	}

	/** One pass: make sure yoal-mail runs and has current state, then forward events. Exposed for tests. */
	async tick(): Promise<void> {
		if (this.ticking || !this.desired) return;
		this.ticking = true;
		try {
			if (!this.started) {
				await this.options.helper.mailStart();
				this.started = true;
				this.options.log('info', 'Started yoal-mail (this node is the mail node)');
			}
			const health = await this.health();
			if (!health) return; // Still starting; the next tick tries again.
			if (health.generation === null || health.generation < this.desired.generation) await this.pushState();
			await this.refreshTls(health);
			await this.forwardEvents();
		} finally {
			this.ticking = false;
		}
	}

	private mail(path: string, init: RequestInit = {}): Promise<Response> {
		return this.fetch(`http://yoal-mail${path}`, {
			...init,
			unix: this.options.socketPath,
			headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
		});
	}

	private control(path: string, init: RequestInit = {}): Promise<Response> {
		return this.fetch(`${this.options.controlUrl}/api/agent/${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.options.nodeToken}`,
				accept: 'application/json',
				'content-type': 'application/json',
				...(init.headers as Record<string, string> | undefined),
			},
		});
	}

	private async health(): Promise<MailHealth | null> {
		try {
			const response = await this.mail('/health');
			if (!response.ok) return null;
			return mailHealthSchema.parse(await response.json());
		} catch {
			return null;
		}
	}

	private async pushState(): Promise<void> {
		const response = await this.control('email/state');
		if (!response.ok) throw new Error(`email/state -> ${response.status}`);
		const state = mailStateSchema.parse(await response.json());
		const pushed = await this.mail('/state', { method: 'PUT', body: JSON.stringify(state) });
		if (!pushed.ok) throw new Error(`yoal-mail refused the state: ${pushed.status} ${await pushed.text().catch(() => '')}`);
		this.options.log('info', `Pushed mail state g${state.generation} (${state.domains.length} domains, ${state.credentials.length} credentials)`);
	}

	private async refreshTls(health: MailHealth): Promise<void> {
		const interval = this.options.tlsIntervalMs ?? 6 * 3_600_000;
		if (health.tls && Date.now() - this.lastTlsAt < interval) return;
		if (!health.tls && Date.now() - this.lastTlsAt < 60_000) return;
		this.lastTlsAt = Date.now();
		const result = await this.options.helper.mailTls(this.desired!.hostnames.submission).catch((error: unknown) => {
			this.options.log('warn', `Copying the mail certificate failed: ${String(error)}`);
			return null;
		});
		if (!result) return;
		if (!result.found) {
			if (!health.tls) this.options.log('info', `No certificate for ${this.desired!.hostnames.submission} yet; submission stays off`);
			return;
		}
		if (result.changed || !health.tls) await this.mail('/tls/reload', { method: 'POST' });
	}

	private async forwardEvents(): Promise<void> {
		for (let round = 0; round < 20; round++) {
			const response = await this.mail(`/events?after=0&limit=${EVENT_BATCH}`);
			if (!response.ok) throw new Error(`yoal-mail events -> ${response.status}`);
			const { events } = (await response.json()) as { events: EmailEvent[] };
			if (events.length === 0) return;
			const sent = await this.control('email/events', { method: 'POST', body: JSON.stringify({ events }) });
			if (!sent.ok) throw new Error(`email/events -> ${sent.status} ${await sent.text().catch(() => '')}`);
			await this.mail('/events/ack', { method: 'POST', body: JSON.stringify({ upTo: events.at(-1)!.seq }) });
			if (events.length < EVENT_BATCH) return;
		}
	}

	private async outboxLoop(signal: AbortSignal): Promise<void> {
		const wait = this.options.outboxWaitSeconds ?? 25;
		while (!signal.aborted) {
			try {
				const handled = await this.drainOutbox(wait, signal);
				if (!handled) continue;
			} catch (error) {
				if (signal.aborted) return;
				this.options.log('warn', `Mail outbox: ${String(error)}`);
				await sleep(5000, signal);
			}
		}
	}

	/** One outbox round: claim, inject, ack what was spooled. Returns how many were handled. Exposed for tests. */
	async drainOutbox(waitSeconds = 0, signal?: AbortSignal): Promise<number> {
		if (!this.started) {
			await sleep(1000, signal);
			return 0;
		}
		const response = await this.control(`email/outbox?wait=${waitSeconds}`, { signal });
		if (!response.ok) throw new Error(`email/outbox -> ${response.status}`);
		const { messages } = (await response.json()) as { messages: MailInject[] };
		if (messages.length === 0) return 0;
		const spooled: string[] = [];
		for (const message of messages) {
			const injected = await this.mail('/inject', { method: 'POST', body: JSON.stringify(message) });
			if (injected.ok) spooled.push(message.messageId);
			else
				this.options.log(
					'warn',
					`yoal-mail did not take ${message.messageId}: ${injected.status} ${await injected.text().catch(() => '')}`,
				);
		}
		if (spooled.length > 0) {
			const ack = await this.control('email/outbox/ack', { method: 'POST', body: JSON.stringify({ messageIds: spooled }) });
			if (!ack.ok) throw new Error(`email/outbox/ack -> ${ack.status}`);
		}
		return messages.length;
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
