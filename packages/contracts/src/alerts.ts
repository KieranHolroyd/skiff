import * as z from 'zod';
import { panelQuerySchema, queryVariablesSchema, type BuilderSpec, type PanelQuery } from './observability.ts';

/**
 * Metric alert rules (docs/ALERTS.md, D109): outage and threshold alerts evaluated against the
 * ClickHouse telemetry store, delivered through the platform's notifiers (email, webhook, SMS,
 * chat) and recorded as a per-series state machine with history, silences and acknowledgements.
 *
 * A rule runs one query over a trailing window and compares one number per series with a
 * threshold. Builder queries give one series per `groupBy` combination (one series without
 * group-by). SQL queries (platform admins) give one series per row: the last numeric column is
 * the value, every string column is a label.
 *
 * Shared by the REST API (`/api/v1/alerts/*`), the dashboard UI, MCP tools and the service layer.
 */

export const alertSeverities = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof alertSeverities)[number];

export const alertOperators = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'] as const;
export type AlertOperator = (typeof alertOperators)[number];
export const alertOperatorSymbols: Record<AlertOperator, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' };

/**
 * What a series without data means. `ok`: nothing is wrong (quiet sites). `nodata`: a distinct
 * "no data" alert (an agent or exporter stopped reporting). `alerting`: treat it as the condition
 * being met (outage rules: a database that stops reporting is down). `keep`: hold the last state.
 */
export const alertNoDataModes = ['ok', 'nodata', 'alerting', 'keep'] as const;
export type AlertNoDataMode = (typeof alertNoDataModes)[number];

/** Per-series states. `pending`: the condition holds but not yet for `forSeconds`. */
export const alertStates = ['normal', 'pending', 'firing', 'nodata'] as const;
export type AlertState = (typeof alertStates)[number];

export type AlertRuleHealth = 'ok' | 'error' | 'unknown';

const EMAIL = /^[^\s@<>"]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;

export const alertConditionSchema = z.object({
	op: z.enum(alertOperators),
	threshold: z.number().finite(),
});
export type AlertCondition = z.infer<typeof alertConditionSchema>;

/** Every field of a rule except identity; defaults suit an outage rule evaluated each minute. */
export const alertRuleInputSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().max(2_000).default(''),
	enabled: z.boolean().default(true),
	severity: z.enum(alertSeverities).default('warning'),
	query: panelQuerySchema,
	/** Values for `$variables` in the query (a rule made from a dashboard panel keeps them). */
	variables: queryVariablesSchema.default({}),
	condition: alertConditionSchema,
	/** The query reads this trailing window, e.g. "error rate over the last 5 minutes". */
	windowSeconds: z.number().int().min(60).max(86_400).default(300),
	/** How often the rule runs. */
	intervalSeconds: z.number().int().min(60).max(3_600).default(60),
	/** The condition must hold this long before the alert fires (0: on the first evaluation). */
	forSeconds: z.number().int().min(0).max(86_400).default(120),
	/** A firing series stays firing until the condition has been clear this long (anti-flap). */
	keepFiringSeconds: z.number().int().min(0).max(86_400).default(0),
	noData: z.enum(alertNoDataModes).default('ok'),
	/** Re-notify a series that is still firing after this many minutes; 0 notifies once. */
	repeatMinutes: z.number().int().min(0).max(10_080).default(240),
	notifyOnResolve: z.boolean().default(true),
	/** Platform notifier names (`email`, `webhook`, `sms`, `slack`, …). Empty sends to all of them. */
	channels: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
	/** Extra email recipients for this rule, sent through the platform's SMTP settings. */
	emails: z.array(z.string().trim().regex(EMAIL, 'Must be an email address')).max(10).default([]),
	/** A link or short text included in every notification: what to do when it fires. */
	runbook: z.string().max(2_000).default(''),
	/** The panel the rule was made from, for "open in dashboard" links. */
	source: z
		.object({ dashboardId: z.string().max(64), panelId: z.string().max(64) })
		.nullable()
		.default(null),
});
export type AlertRuleInput = z.input<typeof alertRuleInputSchema>;
export type AlertRuleSpec = z.infer<typeof alertRuleInputSchema>;

export const alertRuleCreateSchema = alertRuleInputSchema;

/**
 * Partial update; `version` guards concurrent edits like dashboards do. The other fields pass
 * through unparsed (a `.partial()` would fill in defaults and overwrite them) and are validated
 * after they are merged over the saved rule.
 */
export const alertRuleUpdateSchema = z.object({ version: z.number().int().min(1) }).passthrough();
export type AlertRuleUpdateInput = Partial<AlertRuleInput> & { version: number };

/** Check a builder query is usable as an alert: one metric, one value per series. */
export function alertQueryProblem(query: PanelQuery): string | null {
	if (query.mode === 'sql') return null;
	const spec: BuilderSpec = query.builder;
	if (spec.metrics.length !== 1) return 'An alert query needs exactly one metric: the value compared with the threshold.';
	return null;
}

export function compareAlert(value: number, condition: AlertCondition): boolean {
	switch (condition.op) {
		case 'gt':
			return value > condition.threshold;
		case 'gte':
			return value >= condition.threshold;
		case 'lt':
			return value < condition.threshold;
		case 'lte':
			return value <= condition.threshold;
		case 'eq':
			return value === condition.threshold;
		case 'neq':
			return value !== condition.threshold;
	}
}

// --- views ------------------------------------------------------------------------------------

export interface AlertInstanceView {
	ruleId: string;
	ruleName: string;
	severity: AlertSeverity;
	/** Stable id of the series within the rule (its sorted labels). */
	fingerprint: string;
	labels: Record<string, string>;
	/** Display names for id labels (`database_id` → the database's name). */
	labelNames: Record<string, string>;
	state: AlertState;
	value: number | null;
	/** When the series entered its current state. */
	since: string;
	/** When the condition started holding (pending/firing), for "down for 12 min". */
	activeSince: string | null;
	lastEvaluatedAt: string;
	notifiedAt: string | null;
	acknowledgedBy: string | null;
	acknowledgedByName: string | null;
	acknowledgedAt: string | null;
	/** The silence muting it now, if any. */
	silencedBy: string | null;
}

export interface AlertRuleSummary extends AlertRuleSpec {
	id: string;
	version: number;
	createdBy: string | null;
	createdByName: string | null;
	createdAt: string;
	updatedAt: string;
	health: AlertRuleHealth;
	lastError: string | null;
	lastEvaluatedAt: string | null;
	/** The worst state across its series. */
	state: AlertState;
	counts: Record<AlertState, number>;
	canEdit: boolean;
	usesSql: boolean;
}

export interface AlertRuleView extends AlertRuleSummary {
	instances: AlertInstanceView[];
}

export type AlertEventKind = 'state' | 'notification' | 'error' | 'system' | 'ack' | 'silence';

export interface AlertEventView {
	id: string;
	kind: AlertEventKind;
	ruleId: string | null;
	ruleName: string | null;
	fingerprint: string | null;
	labels: Record<string, string>;
	from: AlertState | null;
	to: AlertState | null;
	value: number | null;
	severity: AlertSeverity;
	title: string;
	detail: string;
	/** Per-channel outcome for notifications: `{ email: 'ok', webhook: 'HTTP 500' }`. */
	delivery: Record<string, string> | null;
	at: string;
}

export const alertMatcherSchema = z.object({
	label: z.string().min(1).max(64),
	value: z.string().max(500),
});
export type AlertMatcher = z.infer<typeof alertMatcherSchema>;

export const alertSilenceCreateSchema = z
	.object({
		/** Null silences every rule in the org (a maintenance window). */
		ruleId: z.string().max(64).nullable().default(null),
		/** All must match a series' labels; empty matches every series of the rule(s). */
		matchers: z.array(alertMatcherSchema).max(10).default([]),
		startsAt: z.string().datetime({ offset: true }).optional(),
		endsAt: z.string().datetime({ offset: true }).optional(),
		/** Convenience instead of `endsAt`. */
		durationMinutes: z.number().int().min(1).max(60 * 24 * 90).optional(),
		comment: z.string().trim().max(500).default(''),
	})
	.refine((value) => value.endsAt !== undefined || value.durationMinutes !== undefined, {
		message: 'Give endsAt or durationMinutes.',
		path: ['endsAt'],
	});
export type AlertSilenceCreateInput = z.input<typeof alertSilenceCreateSchema>;

export interface AlertSilenceView {
	id: string;
	ruleId: string | null;
	ruleName: string | null;
	matchers: AlertMatcher[];
	startsAt: string;
	endsAt: string;
	comment: string;
	createdBy: string | null;
	createdByName: string | null;
	createdAt: string;
	status: 'active' | 'pending' | 'expired';
}

/** Delivery targets a rule can pick, from the platform's configured notifiers. */
export interface AlertChannelInfo {
	name: string;
	label: string;
}

export interface AlertsOverview {
	/** Telemetry is installed and reachable: rules can evaluate. */
	telemetryAvailable: boolean;
	telemetryError: string | null;
	channels: AlertChannelInfo[];
	/** Email is configured, so per-rule `emails` can be delivered. */
	emailAvailable: boolean;
	canEdit: boolean;
	canSilence: boolean;
	canUseSql: boolean;
	counts: { firing: number; pending: number; nodata: number; rules: number; paused: number; erroring: number; silences: number };
	/** Firing, pending and no-data series, most severe and oldest first. */
	active: AlertInstanceView[];
}

/** Result of evaluating a (possibly unsaved) rule once without changing any state. */
export interface AlertPreview {
	evaluatedAt: string;
	from: string;
	to: string;
	sql: string;
	series: Array<{
		fingerprint: string;
		labels: Record<string, string>;
		labelNames: Record<string, string>;
		value: number | null;
		/** The condition holds now. */
		met: boolean;
		/** The state saved for this series, when previewing a saved rule. */
		state: AlertState | null;
	}>;
	notice?: string;
}

// --- outage presets ---------------------------------------------------------------------------

export interface AlertRuleTemplate {
	id: string;
	title: string;
	description: string;
	rule: AlertRuleInput;
}

const builder = (spec: Partial<BuilderSpec> & Pick<BuilderSpec, 'dataset' | 'metrics'>): PanelQuery => ({
	mode: 'builder',
	builder: { groupBy: [], filters: [], timeSeries: false, interval: 'auto', ...spec },
});

/**
 * One-click outage rules over the built-in datasets. Each is a normal rule afterwards: edit the
 * threshold, add filters, change channels.
 */
export const alertRuleTemplates: AlertRuleTemplate[] = [
	{
		id: 'site_down',
		title: 'Site down (most requests failing)',
		description: 'More than half of a host’s requests return 5xx for 2 minutes.',
		rule: {
			name: 'Site down',
			severity: 'critical',
			query: builder({ dataset: 'traffic', metrics: [{ field: 'error_rate', agg: 'sum' }], groupBy: ['host'] }),
			condition: { op: 'gt', threshold: 0.5 },
			windowSeconds: 180,
			forSeconds: 120,
			keepFiringSeconds: 120,
			runbook: 'Check the latest deployment and roll back if it started with the promote; then the app logs.',
		},
	},
	{
		id: 'high_error_rate',
		title: 'High 5xx error rate',
		description: 'A host’s server error rate stays above 5% for 5 minutes.',
		rule: {
			name: 'High error rate',
			severity: 'warning',
			query: builder({ dataset: 'traffic', metrics: [{ field: 'error_rate', agg: 'sum' }], groupBy: ['host'] }),
			condition: { op: 'gt', threshold: 0.05 },
			windowSeconds: 300,
			forSeconds: 300,
		},
	},
	{
		id: 'slow_responses',
		title: 'Slow responses (p95)',
		description: 'A host’s p95 latency stays above 2 seconds for 5 minutes.',
		rule: {
			name: 'Slow responses',
			severity: 'warning',
			query: builder({ dataset: 'traffic', metrics: [{ field: 'duration_p95_ms', agg: 'sum' }], groupBy: ['host'] }),
			condition: { op: 'gt', threshold: 2_000 },
			windowSeconds: 300,
			forSeconds: 300,
		},
	},
	{
		id: 'traffic_stopped',
		title: 'Traffic stopped',
		description: 'An app that was serving requests gets none for 10 minutes (DNS, proxy or edge outage). Best for apps with steady traffic.',
		rule: {
			name: 'Traffic stopped',
			severity: 'critical',
			// Per project, not per host: preview hosts going quiet is normal.
			query: builder({ dataset: 'traffic', metrics: [{ field: 'requests', agg: 'sum' }], groupBy: ['project_id'] }),
			condition: { op: 'lt', threshold: 1 },
			windowSeconds: 600,
			forSeconds: 0,
			noData: 'alerting',
		},
	},
	{
		id: 'database_down',
		title: 'Database down',
		description: 'A managed database reports down, or stops reporting, for 2 minutes.',
		rule: {
			name: 'Database down',
			severity: 'critical',
			query: builder({ dataset: 'databases', metrics: [{ field: 'up', agg: 'min' }], groupBy: ['database_id'] }),
			condition: { op: 'lt', threshold: 1 },
			windowSeconds: 120,
			forSeconds: 120,
			noData: 'alerting',
		},
	},
	{
		id: 'pooler_down',
		title: 'Connection pooler down',
		description: 'A database’s PgBouncer pooler reports down for 2 minutes.',
		rule: {
			name: 'Database pooler down',
			severity: 'critical',
			query: builder({ dataset: 'databases', metrics: [{ field: 'pooler_up', agg: 'max' }], groupBy: ['database_id'] }),
			condition: { op: 'lt', threshold: 1 },
			windowSeconds: 120,
			forSeconds: 120,
		},
	},
	{
		id: 'database_connections',
		title: 'Database connections near the limit',
		description: 'Open connections above 90% of max_connections for 5 minutes.',
		rule: {
			name: 'Database connections near limit',
			severity: 'warning',
			query: builder({ dataset: 'databases', metrics: [{ field: 'connection_utilization', agg: 'sum' }], groupBy: ['database_id'] }),
			condition: { op: 'gt', threshold: 0.9 },
			windowSeconds: 300,
			forSeconds: 300,
		},
	},
	{
		id: 'database_deadlocks',
		title: 'Database deadlocks',
		description: 'Any deadlock in the last 5 minutes.',
		rule: {
			name: 'Database deadlocks',
			severity: 'warning',
			query: builder({ dataset: 'databases', metrics: [{ field: 'deadlocks', agg: 'sum' }], groupBy: ['database_id'] }),
			condition: { op: 'gt', threshold: 0 },
			windowSeconds: 300,
			forSeconds: 0,
			repeatMinutes: 60,
		},
	},
	{
		id: 'storage_down',
		title: 'Object storage down',
		description: 'A storage instance reports down, or stops reporting, for 2 minutes.',
		rule: {
			name: 'Object storage down',
			severity: 'critical',
			query: builder({ dataset: 'storage', metrics: [{ field: 'up', agg: 'min' }], groupBy: ['storage_id'] }),
			condition: { op: 'lt', threshold: 1 },
			windowSeconds: 120,
			forSeconds: 120,
			noData: 'alerting',
		},
	},
];

export function alertRuleTemplate(id: string): AlertRuleTemplate | undefined {
	return alertRuleTemplates.find((template) => template.id === id);
}
