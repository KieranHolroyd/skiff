/**
 * Event notifications (docs/EVENTS.md, D122): the wire types the CLI reads and pure formatting for
 * `yoal events`. Types mirror `packages/contracts/src/event-notification.ts`; the CLI bundle stays
 * free of runtime dependencies (D40), so keep them in sync. The server validates everything.
 */
import { formatTime, renderTable, truncate } from './output.ts';

/** Mirrors `eventTypesBySource` in @yoal/contracts. */
export const EVENT_SOURCES = {
	storage: ['object-create', 'object-delete'],
	alerts: ['firing', 'resolved'],
	deployments: ['created', 'promoted', 'failed'],
	'database-backups': ['completed', 'failed'],
} as const;
export type EventSourceName = keyof typeof EVENT_SOURCES;

export interface EventRuleFilterView {
	storage?: string;
	bucket?: string;
	prefix?: string;
	suffix?: string;
	project?: string;
	database?: string;
	alertRule?: string;
}

export interface EventRuleView {
	id: string;
	source: EventSourceName;
	events: string[];
	filter: EventRuleFilterView;
	broker: string;
	queue: string;
	description: string | null;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	deliveries: { pending: number; delivered: number; failed: number };
	lastDeliveredAt: string | null;
	lastError: string | null;
}

export interface EventDeliveryView {
	id: string;
	ruleId: string;
	type: string;
	status: 'pending' | 'delivered' | 'failed';
	attempts: number;
	createdAt: string;
	deliveredAt: string | null;
	lastError: string | null;
	body: unknown;
}

export interface EventRuleCreateInput {
	source: EventSourceName;
	events?: string[];
	storage?: string;
	bucket?: string;
	prefix?: string;
	suffix?: string;
	project?: string;
	database?: string;
	alertRule?: string;
	broker: string;
	queue: string;
	description?: string;
	enabled?: boolean;
}

export interface EventRuleUpdateInput {
	events?: string[];
	prefix?: string | null;
	suffix?: string | null;
	queue?: string;
	description?: string | null;
	enabled?: boolean;
}

/** What a rule watches, in one short phrase: `media/uploads incoming/*.jpg`, `project shop`. */
export function watching(rule: EventRuleView): string {
	const filter = rule.filter;
	switch (rule.source) {
		case 'storage': {
			const keys = filter.prefix || filter.suffix ? ` ${filter.prefix ?? ''}*${filter.suffix ?? ''}` : '';
			return `${filter.storage}/${filter.bucket}${keys}`;
		}
		case 'deployments':
			return filter.project ? `project ${filter.project}` : 'every project';
		case 'database-backups':
			return filter.database ? `database ${filter.database}` : 'every database';
		case 'alerts':
			return filter.alertRule ? `rule ${filter.alertRule}` : 'every rule';
	}
}

export function eventRuleTable(rules: EventRuleView[]): string {
	const rows = rules.map((rule) => [
		rule.id,
		rule.enabled ? rule.source : `${rule.source} (off)`,
		truncate(watching(rule), 36),
		rule.events.join(','),
		`${rule.broker}/${rule.queue}`,
		`${rule.deliveries.delivered} ok, ${rule.deliveries.pending} pending, ${rule.deliveries.failed} failed`,
	]);
	return renderTable(['ID', 'SOURCE', 'WATCHING', 'EVENTS', 'QUEUE', 'LAST 24H'], rows);
}

export function eventRuleDetails(rule: EventRuleView): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(10)}  ${value}`);
	field('Rule', rule.id);
	field('Source', `${rule.source}${rule.enabled ? '' : ' (disabled)'}`);
	field('Watching', watching(rule));
	field('Events', rule.events.join(', '));
	field('Queue', `${rule.queue} on broker ${rule.broker}`);
	if (rule.description) field('About', rule.description);
	field('Delivered', `${rule.deliveries.delivered} in 24 h, last ${rule.lastDeliveredAt ? formatTime(rule.lastDeliveredAt) : 'never'}`);
	field('Waiting', String(rule.deliveries.pending));
	field('Failed', String(rule.deliveries.failed));
	if (rule.lastError) field('Error', rule.lastError);
	field('Created', formatTime(rule.createdAt));
	return lines.join('\n');
}

export function eventDeliveryTable(deliveries: EventDeliveryView[]): string {
	const rows = deliveries.map((delivery) => [
		delivery.id,
		delivery.type,
		delivery.status,
		String(delivery.attempts),
		formatTime(delivery.createdAt),
		truncate(delivery.lastError ?? '', 40),
	]);
	return renderTable(['ID', 'TYPE', 'STATUS', 'TRIES', 'CREATED', 'ERROR'], rows);
}
