import * as z from 'zod';
import type { AlertChannelInfo } from './alerts.ts';
import type { PlatformPolicyKey } from './platform-policies.ts';

/**
 * Built-in ("system") alerts (docs/ALERTS.md §0): raised by the maintenance loop from heartbeats
 * and platform state, not from metric rules. Platform owners turn each kind on or off and pick
 * its channels on Alerts → System alerts; thresholds are platform policies, edited there too.
 *
 * The alert key's prefix (`node_offline:<id>`, `cert:critical:…`) names its kind.
 */

export const systemAlertKinds = [
	'node_offline',
	'disk',
	'cert',
	'promote_5xx',
	'backup',
	'database_storage',
	'database_connections',
	'database_pool',
	'storage_usage',
	'broker_store',
	'quota',
	'telemetry',
] as const;
export type SystemAlertKind = (typeof systemAlertKinds)[number];

export interface SystemAlertThreshold {
	key: PlatformPolicyKey;
	label: string;
	unit: 'percent' | 'minutes' | 'days';
	min: number;
	max: number;
}

export interface SystemAlertInfo {
	kind: SystemAlertKind;
	label: string;
	description: string;
	/** What severity it raises, in words ("critical", "warning; critical at 95%"). */
	severity: string;
	thresholds: SystemAlertThreshold[];
}

export const systemAlertCatalog: SystemAlertInfo[] = [
	{
		kind: 'node_offline',
		label: 'Node offline',
		description: 'A node stops sending heartbeats, or reports its proxy (Caddy) down.',
		severity: 'critical',
		thresholds: [{ key: 'nodeAlertMinutes', label: 'After', unit: 'minutes', min: 1, max: 60 }],
	},
	{
		kind: 'disk',
		label: 'Node disk full',
		description: 'A node’s root disk passes the threshold.',
		severity: 'warning',
		thresholds: [{ key: 'diskAlertPercent', label: 'Above', unit: 'percent', min: 50, max: 99 }],
	},
	{
		kind: 'cert',
		label: 'TLS certificate expiring',
		description: 'A certificate Caddy serves is close to expiry (renewal normally happens ~30 days ahead).',
		severity: 'warning; critical near expiry',
		thresholds: [
			{ key: 'certWarnDays', label: 'Warn within', unit: 'days', min: 2, max: 60 },
			{ key: 'certCriticalDays', label: 'Critical within', unit: 'days', min: 1, max: 30 },
		],
	},
	{
		kind: 'promote_5xx',
		label: '5xx spike after promote',
		description: 'In the 30 minutes after a promote, production returns ≥ 5% 5xx and at least double the rate before.',
		severity: 'critical',
		thresholds: [],
	},
	{
		kind: 'backup',
		label: 'Backup or restore drill failed',
		description: 'The platform database backup (Litestream) or the monthly restore drill failed.',
		severity: 'critical',
		thresholds: [],
	},
	{
		kind: 'database_storage',
		label: 'Database storage',
		description: 'A managed database passes a share of its storage budget.',
		severity: 'warning; critical at 95%',
		thresholds: [{ key: 'databaseStorageAlertPercent', label: 'Above', unit: 'percent', min: 50, max: 99 }],
	},
	{
		kind: 'database_connections',
		label: 'Database connections',
		description: 'Open connections pass a share of max_connections.',
		severity: 'warning',
		thresholds: [{ key: 'databaseConnectionsAlertPercent', label: 'Above', unit: 'percent', min: 50, max: 100 }],
	},
	{
		kind: 'database_pool',
		label: 'Connection pool saturation',
		description: 'A database’s PgBouncer pool is nearly full, so clients wait.',
		severity: 'warning; critical at 95%',
		thresholds: [{ key: 'poolSaturationAlertPercent', label: 'Above', unit: 'percent', min: 50, max: 100 }],
	},
	{
		kind: 'storage_usage',
		label: 'Object storage usage',
		description: 'A storage instance passes a share of its storage budget.',
		severity: 'warning; critical at 95%',
		thresholds: [{ key: 'storageAlertPercent', label: 'Above', unit: 'percent', min: 50, max: 99 }],
	},
	{
		kind: 'broker_store',
		label: 'Queue broker store',
		description: 'A queue broker’s message store passes a share of its budget. A full store refuses new messages.',
		severity: 'warning; critical at 95%',
		thresholds: [{ key: 'brokerStoreAlertPercent', label: 'Above', unit: 'percent', min: 50, max: 99 }],
	},
	{
		kind: 'quota',
		label: 'Org quota',
		description: 'An organisation reaches 80% or 95% of a quota (once per threshold per day).',
		severity: 'warning',
		thresholds: [],
	},
	{
		kind: 'telemetry',
		label: 'Alert rules cannot evaluate',
		description: 'The telemetry store has been unavailable for 10 minutes, so metric alert rules cannot fire.',
		severity: 'critical',
		thresholds: [],
	},
];

/** Map an alert key to its kind; unknown keys are treated as their own always-on kind. */
export function systemAlertKindOf(key: string): SystemAlertKind | null {
	const prefix = key.split(':')[0]!;
	if (prefix === 'database_pool_saturation') return 'database_pool';
	if (prefix === 'alerts') return 'telemetry';
	return (systemAlertKinds as readonly string[]).includes(prefix) ? (prefix as SystemAlertKind) : null;
}

export const systemAlertRouteSchema = z.object({
	enabled: z.boolean().default(true),
	/** Platform notifier names; empty sends to every configured channel. */
	channels: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
});
export type SystemAlertRoute = z.infer<typeof systemAlertRouteSchema>;

/** Stored in `settings` under this key; kinds not listed use the defaults (on, every channel). */
export const SYSTEM_ALERT_ROUTING_KEY = 'system_alert_routing';

export const systemAlertRoutingSchema = z.partialRecord(z.enum(systemAlertKinds), systemAlertRouteSchema);
export type SystemAlertRouting = z.infer<typeof systemAlertRoutingSchema>;

/** The policy keys System alerts may change (thresholds and the repeat interval). */
export const systemAlertPolicyKeys = [
	'nodeAlertMinutes',
	'diskAlertPercent',
	'certWarnDays',
	'certCriticalDays',
	'databaseStorageAlertPercent',
	'databaseConnectionsAlertPercent',
	'poolSaturationAlertPercent',
	'storageAlertPercent',
	'brokerStoreAlertPercent',
	'systemAlertRepeatMinutes',
] as const satisfies readonly PlatformPolicyKey[];

export const systemAlertsUpdateSchema = z.object({
	routing: systemAlertRoutingSchema.optional(),
	policies: z.partialRecord(z.enum(systemAlertPolicyKeys), z.number().int()).optional(),
});
export type SystemAlertsUpdate = z.input<typeof systemAlertsUpdateSchema>;

export interface SystemAlertView extends SystemAlertInfo {
	enabled: boolean;
	channels: string[];
	values: Partial<Record<PlatformPolicyKey, number>>;
	lastFiredAt: string | null;
	lastTitle: string | null;
	/** Fired in the last 24 hours. */
	recentCount: number;
}

/** Every notifier Skiff can configure (Settings → Notifications), by its `Notifier.name`. */
export const knownAlertChannels = [
	{ name: 'email', label: 'Email', description: 'Through the platform’s SMTP settings to the alert address.' },
	{ name: 'webhook', label: 'Webhook', description: 'A JSON POST to any URL (Home Assistant, a custom receiver).' },
	{ name: 'sms', label: 'SMS', description: 'Text messages through Twilio.' },
	{ name: 'slack', label: 'Slack', description: 'An incoming webhook into a Slack channel.' },
	{ name: 'discord', label: 'Discord', description: 'A Discord channel webhook.' },
	{ name: 'telegram', label: 'Telegram', description: 'A Telegram bot message to a chat.' },
	{ name: 'ntfy', label: 'ntfy', description: 'A push to an ntfy topic.' },
	{ name: 'push', label: 'Push', description: 'Web Push to the dashboard installed as an app.' },
] as const;

export interface AlertChannelStatus {
	name: string;
	label: string;
	description: string;
	configured: boolean;
}

export interface SystemAlertsView {
	alerts: SystemAlertView[];
	repeatMinutes: number;
	channels: AlertChannelInfo[];
	/** Known channel kinds and whether each is set up, plus any other configured notifier. */
	channelStatus: AlertChannelStatus[];
	/** Platform owner: may change routing and thresholds. */
	canEdit: boolean;
}
