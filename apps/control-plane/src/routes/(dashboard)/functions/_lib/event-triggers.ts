import type { EventRuleView } from '@skiff/contracts';

/** A queue on a broker, as a function's queue consumer or an event rule's target names it. */
export interface QueueTarget {
	broker: string;
	queue: string;
}

/** An event rule as a function's console shows it: whether this function consumes its queue yet. */
export type FunctionEventTrigger = EventRuleView & { consumed: boolean };

export const queueKey = (target: QueueTarget) => `${target.broker}/${target.queue}`;

/** `broker/queue` from a select value; broker names never contain a slash. */
export function parseQueueKey(value: string): QueueTarget | null {
	const slash = value.indexOf('/');
	if (slash <= 0 || slash === value.length - 1) return null;
	return { broker: value.slice(0, slash), queue: value.slice(slash + 1) };
}

/**
 * The event rules that belong to one function (D122). Events reach a function only through a queue
 * it consumes, so a rule belongs here when it targets one of the function's consumer queues. A rule
 * on a broker attached to the function whose queue no function consumes yet is shown too (flagged
 * `consumed: false`), so a trigger set up before the consumer is deployed doesn't disappear.
 */
export function eventTriggersFor(
	rules: EventRuleView[],
	scope: {
		consumers: QueueTarget[];
		attachedBrokers: string[];
		/** `broker/queue` keys other functions consume. */
		consumedElsewhere: Set<string>;
	}
): FunctionEventTrigger[] {
	const consumed = new Set(scope.consumers.map(queueKey));
	const attached = new Set(scope.attachedBrokers);
	const sources: FunctionEventTrigger[] = [];
	for (const rule of rules) {
		const key = queueKey(rule);
		if (consumed.has(key)) sources.push({ ...rule, consumed: true });
		else if (attached.has(rule.broker) && !scope.consumedElsewhere.has(key))
			sources.push({ ...rule, consumed: false });
	}
	return sources;
}

/** The `wrangler.jsonc` line that makes a function consume a queue. */
export const consumerSnippet = (queue: string) =>
	`"queues": { "consumers": [{ "queue": "${queue || 'my-queue'}" }] }`;
