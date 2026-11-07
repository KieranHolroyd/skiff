import {
	EMAIL_EXPIRY_SECONDS,
	EMAIL_RETRY_SCHEDULE_SECONDS,
	HARD_BOUNCE_CLASSES,
	verpAddress,
	type MailHostnames,
} from '@skiff/contracts';
import type { ReplyOutcome } from './classify.ts';
import { deliverDomain, type DeliveryItem, type DeliveryOptions, type DeliveryResult } from './deliver.ts';
import type { MailPolicy } from './policy.ts';
import { providerFor, type Shaper } from './shaping.ts';
import type { EventInput, Spool, SpoolMessage, SpoolRecipient } from './spool.ts';

/**
 * The delivery scheduler (EMAIL.md §3.2). Each tick takes due recipients, groups them by
 * recipient domain, and hands each group to `deliverDomain` within the provider's shaping budget.
 * Outcomes go back to the spool with their events in one transaction.
 */

export interface QueueOptions {
	spool: Spool;
	policy: MailPolicy;
	shaper: Shaper;
	delivery: Omit<DeliveryOptions, 'helo'>;
	hostnames: () => MailHostnames | null;
	now?: () => number;
	/** Domain groups delivered concurrently. */
	maxGroups?: number;
	/** Recipients per domain group per tick. */
	maxBatch?: number;
	log?: (message: string) => void;
	/** Test seam. */
	deliver?: typeof deliverDomain;
}

/** Seconds until the next attempt after `attempts` failed ones. */
export function retryDelaySeconds(attempts: number): number {
	const schedule = EMAIL_RETRY_SCHEDULE_SECONDS;
	return schedule[Math.min(attempts, schedule.length - 1)]!;
}

export class DeliveryQueue {
	private readonly inFlight = new Set<string>();
	private groups = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private ticking = false;
	private stopped = false;
	private readonly now: () => number;
	private readonly deliver: typeof deliverDomain;

	constructor(private readonly options: QueueOptions) {
		this.now = options.now ?? Date.now;
		this.deliver = options.deliver ?? deliverDomain;
	}

	start(intervalMs = 1000): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), intervalMs);
	}

	/** Stop ticking and wait for deliveries in flight to settle (the spool must stay open until then). */
	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.stopped = true;
		while (this.busy) await Bun.sleep(10);
	}

	kick(): void {
		void this.tick();
	}

	/** Groups still being delivered; tests await this to settle. */
	get busy(): boolean {
		return this.groups > 0 || this.ticking;
	}

	async tick(): Promise<void> {
		if (this.ticking || this.stopped) return;
		const state = this.options.policy.state;
		const hostnames = this.options.hostnames();
		if (!state || state.paused || !hostnames) return;
		this.ticking = true;
		try {
			const now = this.now();
			const byDomain = new Map<string, SpoolRecipient[]>();
			for (const recipient of this.options.spool.due(now)) {
				if (this.inFlight.has(keyOf(recipient))) continue;
				const list = byDomain.get(recipient.domain) ?? [];
				list.push(recipient);
				byDomain.set(recipient.domain, list);
			}
			const maxGroups = this.options.maxGroups ?? 16;
			for (const [domain, recipients] of byDomain) {
				if (this.groups >= maxGroups) break;
				const provider = providerFor(domain);
				const budget = Math.min(this.options.shaper.budget(provider.key, provider.limits), this.options.maxBatch ?? 50);
				if (budget <= 0) continue;
				const batch = recipients.slice(0, budget);
				for (const recipient of batch) this.inFlight.add(keyOf(recipient));
				this.groups += 1;
				this.options.shaper.open(provider.key);
				void this.run(domain, provider.key, batch, hostnames).finally(() => {
					this.options.shaper.close(provider.key);
					this.groups -= 1;
					for (const recipient of batch) this.inFlight.delete(keyOf(recipient));
				});
			}
		} finally {
			this.ticking = false;
		}
	}

	private async run(domain: string, providerKey: string, batch: SpoolRecipient[], hostnames: MailHostnames): Promise<void> {
		const { spool } = this.options;
		const messages = new Map<string, SpoolMessage>();
		const items: DeliveryItem[] = [];
		const byKey = new Map<string, SpoolRecipient>();
		for (const recipient of batch) {
			const message = messages.get(recipient.messageId) ?? spool.message(recipient.messageId);
			if (!message) continue;
			messages.set(message.id, message);
			let raw: Buffer;
			try {
				raw = spool.body(message.id);
			} catch (error) {
				this.options.log?.(`spool body missing for ${message.id}: ${String(error)}`);
				continue;
			}
			const key = keyOf(recipient);
			byKey.set(key, recipient);
			items.push({ key, envelopeFrom: verpAddress(message.id, recipient.index, hostnames.bounce), recipient: recipient.address, raw });
		}
		let results: DeliveryResult[];
		try {
			results = await this.deliver(domain, items, { ...this.options.delivery, helo: hostnames.helo });
		} catch (error) {
			const outcome: ReplyOutcome = { kind: 'transient', bounceClass: 'other' };
			results = items.map((item) => ({ key: item.key, outcome, response: String(error).slice(0, 1000), remoteHost: null, tls: null }));
		}
		for (const result of results) {
			const recipient = byKey.get(result.key);
			if (!recipient) continue;
			const message = messages.get(recipient.messageId)!;
			this.settle(message, recipient, result, providerKey);
		}
	}

	private settle(message: SpoolMessage, recipient: SpoolRecipient, result: DeliveryResult, providerKey: string): void {
		const now = this.now();
		const attempt = recipient.attempts + 1;
		const base: EventInput = {
			kind: 'delivered',
			messageId: message.id,
			orgId: message.orgId,
			projectId: message.projectId,
			recipient: recipient.address,
			recipientIndex: recipient.index,
			at: new Date(now).toISOString(),
			attempt,
			severity: null,
			bounceClass: null,
			remoteHost: result.remoteHost,
			response: result.response,
			tls: result.tls,
			source: message.source,
			feedbackType: null,
			tags: message.tags,
		};
		const { outcome } = result;
		if (outcome.kind === 'delivered') {
			this.options.shaper.sent(providerKey);
			this.options.spool.settle(recipient, { status: 'delivered', response: result.response }, base);
			return;
		}
		if (outcome.kind === 'permanent') {
			if (HARD_BOUNCE_CLASSES.has(outcome.bounceClass)) this.options.policy.suppress(message.orgId, recipient.address);
			this.options.spool.settle(
				recipient,
				{ status: 'bounced', response: result.response },
				{ ...base, kind: 'bounced', severity: 'hard', bounceClass: outcome.bounceClass },
			);
			return;
		}
		let next = now + retryDelaySeconds(recipient.attempts) * 1000;
		// A throttle or a temporary spam block is about our IP, not the recipient: back off the provider.
		if (outcome.bounceClass === 'throttled' || outcome.bounceClass === 'spam-block') {
			this.options.shaper.throttled(providerKey);
			next = Math.max(next, this.options.shaper.blockedUntil(providerKey));
		}
		if (next - message.createdAt > EMAIL_EXPIRY_SECONDS * 1000) {
			this.options.spool.settle(
				recipient,
				{ status: 'bounced', response: result.response },
				{ ...base, kind: 'bounced', severity: 'soft', bounceClass: 'expired' },
			);
			return;
		}
		this.options.spool.settle(
			recipient,
			{ status: 'deferred', nextAttemptAt: next, response: result.response },
			{ ...base, kind: 'deferred', severity: 'soft', bounceClass: outcome.bounceClass },
		);
	}
}

function keyOf(recipient: { messageId: string; index: number }): string {
	return `${recipient.messageId}:${recipient.index}`;
}
