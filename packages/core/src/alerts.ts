import {
	alertOperatorSymbols,
	alertQueryProblem,
	alertRuleInputSchema,
	alertSilenceCreateSchema,
	compareAlert,
	type AlertChannelInfo,
	type AlertEventKind,
	type AlertEventView,
	type AlertInstanceView,
	type AlertMatcher,
	type AlertPreview,
	type AlertRuleHealth,
	type AlertRuleSpec,
	type AlertRuleSummary,
	type AlertRuleUpdateInput,
	type AlertRuleView,
	type AlertSeverity,
	type AlertSilenceCreateInput,
	type AlertSilenceView,
	type AlertState,
	type AlertsOverview,
	type ObservabilityDataset,
	type Principal,
	type QueryResult,
	SYSTEM_ALERT_ROUTING_KEY,
	knownAlertChannels,
	systemAlertCatalog,
	systemAlertKindOf,
	systemAlertRoutingSchema,
	systemAlertsUpdateSchema,
	type SystemAlertKind,
	type SystemAlertRouting,
	type SystemAlertsUpdate,
	type SystemAlertsView,
} from '@skiff/contracts';
import type { AlertMessage, Notifier } from './config.ts';
import type { CoreContext } from './context.ts';
import { ClickHouseError, ClickHouseUnavailableError } from './clickhouse.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { DATASETS, expandSqlMacros } from './observability-query.ts';
import { toQueryResult, type ObservabilityService } from './observability.ts';
import { buildPrincipal } from './orgs.ts';
import { TELEMETRY_NOT_INSTALLED } from './telemetry.ts';
import { newId, parseJson } from './util.ts';

/**
 * Metric alert rules (docs/ALERTS.md, D109).
 *
 * Every rule runs its query over a trailing window on its own interval and compares one value per
 * series with a threshold. Each series keeps a small state machine in `alert_instances`; changes
 * are written to `alert_events`, and notifications go to the platform's notifiers (and optional
 * per-rule emails), grouped per rule and evaluation so ten hosts going down send one message.
 *
 * The evaluator is fail-safe in both directions: a failing query keeps every series in its last
 * state (an outage of the telemetry store never resolves or fires anything), and a rule that keeps
 * failing for ten minutes says so once.
 */

const MINUTE_MS = 60_000;
/** A rule failing this long notifies its channels once (per failure streak). */
export const RULE_ERROR_NOTIFY_MS = 10 * MINUTE_MS;
/** Telemetry down this long notifies the platform notifiers once (per outage). */
export const TELEMETRY_DOWN_NOTIFY_MS = 10 * MINUTE_MS;
const EVENT_RETENTION_MS = 90 * 86_400_000;
const SILENCE_RETENTION_MS = 30 * 86_400_000;
/** Normal series not returned by the query for this long are forgotten. */
const STALE_INSTANCE_MS = 86_400_000;
const NOTIFY_TIMEOUT_MS = 20_000;
const MAX_LISTED_SERIES = 10;
const TELEMETRY_DOWN_KEY = 'alerts:telemetry_down';

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };
const STATE_RANK: Record<AlertState, number> = { normal: 0, pending: 1, nodata: 2, firing: 3 };
const ALERTING: ReadonlySet<AlertState> = new Set(['firing', 'nodata']);

// --- the state machine (pure) -------------------------------------------------------------------

export interface InstanceRecord {
	fingerprint: string;
	labels: Record<string, string>;
	state: AlertState;
	value: number | null;
	stateSince: number;
	/** When the condition began holding (pending start), for "down for 12 min". */
	activeSince: number | null;
	/** When a firing series' condition first cleared (keep-firing countdown). */
	clearedSince: number | null;
	lastSeenAt: number | null;
	lastEvaluatedAt: number;
	notifiedAt: number | null;
	/** The alerting state last notified (`firing`/`nodata`); null once resolved was handled. */
	notifiedState: AlertState | null;
	acknowledgedBy: string | null;
	acknowledgedAt: number | null;
}

/** `value: null` means the series returned no data this evaluation. */
export interface Observation {
	value: number | null;
}

type Timing = Pick<AlertRuleSpec, 'condition' | 'forSeconds' | 'keepFiringSeconds' | 'noData'>;

export function newInstance(fingerprint: string, labels: Record<string, string>, now: number): InstanceRecord {
	return {
		fingerprint,
		labels,
		state: 'normal',
		value: null,
		stateSince: now,
		activeSince: null,
		clearedSince: null,
		lastSeenAt: null,
		lastEvaluatedAt: now,
		notifiedAt: null,
		notifiedState: null,
		acknowledgedBy: null,
		acknowledgedAt: null,
	};
}

/**
 * Advance one series by one evaluation. Pure, so every transition is unit-tested.
 *
 * - condition met: normal → pending → firing after `forSeconds` (straight to firing when 0);
 * - condition clear: pending → normal; firing → normal once clear for `keepFiringSeconds`;
 * - no data: per `noData` — treated as clear (`ok`), as met (`alerting`), as its own `nodata`
 *   state, or ignored (`keep`).
 */
export function advanceInstance(previous: InstanceRecord, observation: Observation, spec: Timing, now: number): InstanceRecord {
	const next: InstanceRecord = { ...previous, lastEvaluatedAt: now };
	if (observation.value !== null) {
		next.value = observation.value;
		next.lastSeenAt = now;
	}
	const enter = (state: AlertState) => {
		if (next.state === state) return;
		next.state = state;
		next.stateSince = now;
		if (!ALERTING.has(state)) {
			next.acknowledgedBy = null;
			next.acknowledgedAt = null;
		}
	};

	let met: boolean;
	if (observation.value !== null) met = compareAlert(observation.value, spec.condition);
	else if (spec.noData === 'keep') return next;
	else if (spec.noData === 'ok') met = false;
	else if (spec.noData === 'alerting') met = true;
	else {
		next.value = null;
		next.clearedSince = null;
		next.activeSince ??= now;
		enter('nodata');
		return next;
	}

	if (met) {
		next.clearedSince = null;
		if (previous.state === 'firing') return next;
		if (previous.state !== 'pending') next.activeSince = now;
		const heldMs = now - (next.activeSince ?? now);
		enter(heldMs >= spec.forSeconds * 1000 ? 'firing' : 'pending');
		return next;
	}

	if (previous.state === 'firing' && spec.keepFiringSeconds > 0) {
		next.clearedSince ??= now;
		if (now - next.clearedSince < spec.keepFiringSeconds * 1000) return next;
	}
	next.clearedSince = null;
	next.activeSince = null;
	enter('normal');
	return next;
}

/** Stable series id within a rule: its labels, sorted. `{}` for an ungrouped rule. */
export function fingerprintOf(labels: Record<string, string>): string {
	return JSON.stringify(Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))));
}

export function matchesSilence(silence: { ruleId: string | null; matchers: AlertMatcher[] }, ruleId: string, labels: Record<string, string>): boolean {
	if (silence.ruleId !== null && silence.ruleId !== ruleId) return false;
	return silence.matchers.every((matcher) => labels[matcher.label] === matcher.value);
}

/** Series from a query result: string columns are labels, the last numeric column the value. */
export function seriesFromResult(result: Pick<QueryResult, 'columns' | 'rows'>): Array<{ labels: Record<string, string>; value: number | null }> {
	const labelColumns = result.columns.flatMap((column, index) => (column.kind === 'string' || column.kind === 'other' ? [index] : []));
	let valueColumn = -1;
	result.columns.forEach((column, index) => {
		if (column.kind === 'number') valueColumn = index;
	});
	const series = new Map<string, { labels: Record<string, string>; value: number | null }>();
	for (const row of result.rows) {
		const labels: Record<string, string> = {};
		for (const index of labelColumns) {
			const cell = row[index];
			labels[result.columns[index]!.name] = cell === null || cell === undefined ? '' : String(cell);
		}
		const raw = valueColumn >= 0 ? row[valueColumn] : null;
		const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
		// Rows are ordered by time when a query has a time column: the last row per series wins.
		series.set(fingerprintOf(labels), { labels, value });
	}
	return [...series.values()];
}

// --- formatting -------------------------------------------------------------------------------

/** Unit of the value a rule compares, from the builder catalog (`short` for SQL). */
export function alertValueUnit(spec: Pick<AlertRuleSpec, 'query'>): string {
	if (spec.query.mode !== 'builder') return 'short';
	const metric = spec.query.builder.metrics[0];
	const def = DATASETS[spec.query.builder.dataset as ObservabilityDataset];
	const measure = def?.measures.find((item) => item.name === metric?.field);
	if (!measure || !metric) return 'short';
	if (measure.kind !== 'derived' && metric.agg === 'count') return 'short';
	if (measure.kind !== 'derived' && metric.agg === 'rate') return measure.unit === 'bytes' ? 'bytesps' : 'reqps';
	return measure.unit;
}

export function formatAlertValue(value: number | null, unit: string): string {
	if (value === null) return 'no data';
	const round = (n: number, digits = 2) => String(Number(n.toFixed(digits)));
	switch (unit) {
		case 'percentunit':
			return `${round(value * 100, 1)}%`;
		case 'percent':
			return `${round(value, 1)}%`;
		case 'ms':
			return value >= 1000 ? `${round(value / 1000)} s` : `${round(value, 0)} ms`;
		case 'bytes':
		case 'bytesps': {
			const units = ['B', 'KB', 'MB', 'GB', 'TB'];
			let n = value;
			let i = 0;
			while (Math.abs(n) >= 1024 && i < units.length - 1) {
				n /= 1024;
				i++;
			}
			return `${round(n, 1)} ${units[i]}${unit === 'bytesps' ? '/s' : ''}`;
		}
		case 'reqps':
			return `${round(value)} req/s`;
		default:
			return round(value);
	}
}

function formatDuration(ms: number): string {
	const minutes = Math.round(ms / MINUTE_MS);
	if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

// --- rows ---------------------------------------------------------------------------------------

interface RuleRow {
	id: string;
	org_id: string;
	name: string;
	spec_json: string;
	enabled: number;
	version: number;
	health: string;
	last_error: string | null;
	error_since: number | null;
	error_notified: number;
	last_evaluated_at: number | null;
	next_eval_at: number;
	created_by: string | null;
	updated_by: string | null;
	created_at: number;
	updated_at: number;
}

interface InstanceRow {
	rule_id: string;
	fingerprint: string;
	labels_json: string;
	state: string;
	value: number | null;
	state_since: number;
	active_since: number | null;
	cleared_since: number | null;
	last_seen_at: number | null;
	last_evaluated_at: number;
	notified_at: number | null;
	notified_state: string | null;
	acknowledged_by: string | null;
	acknowledged_at: number | null;
}

interface EventRow {
	id: string;
	org_id: string | null;
	rule_id: string | null;
	kind: string;
	fingerprint: string | null;
	labels_json: string;
	from_state: string | null;
	to_state: string | null;
	value: number | null;
	severity: string;
	title: string;
	detail: string;
	delivery_json: string | null;
	at: number;
}

interface SilenceRow {
	id: string;
	org_id: string;
	rule_id: string | null;
	matchers_json: string;
	starts_at: number;
	ends_at: number;
	comment: string;
	created_by: string | null;
	created_at: number;
}

interface Silence {
	id: string;
	ruleId: string | null;
	matchers: AlertMatcher[];
}

function toRecord(row: InstanceRow): InstanceRecord {
	return {
		fingerprint: row.fingerprint,
		labels: parseJson<Record<string, string>>(row.labels_json, {}),
		state: row.state as AlertState,
		value: row.value,
		stateSince: row.state_since,
		activeSince: row.active_since,
		clearedSince: row.cleared_since,
		lastSeenAt: row.last_seen_at,
		lastEvaluatedAt: row.last_evaluated_at,
		notifiedAt: row.notified_at,
		notifiedState: (row.notified_state as AlertState | null) ?? null,
		acknowledgedBy: row.acknowledged_by,
		acknowledgedAt: row.acknowledged_at,
	};
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Label names that hold resource ids, and where their display names come from. */
const ID_LABELS = { project_id: 'project', database_id: 'database', storage_id: 'storage', broker_id: 'broker' } as const;

interface OrgNames {
	project: Map<string, string>;
	database: Map<string, string>;
	storage: Map<string, string>;
	broker: Map<string, string>;
}

export interface EvaluationReport {
	evaluated: number;
	failed: number;
	notifications: number;
	skipped?: 'telemetry_unavailable' | 'busy';
}

export class AlertService {
	#running = false;
	#lastPrune = 0;
	#routingCache: SystemAlertRouting | null = null;

	constructor(
		private readonly ctx: CoreContext,
		private readonly observability: ObservabilityService,
	) {}

	// --- access -------------------------------------------------------------------------------

	#requireRead(principal: Principal): void {
		if (!principal.permissions.has('metrics:read')) throw new CoreError('forbidden', 'Missing permission metrics:read', 403);
	}

	/** Rules page people (and can reach the platform's SMS), so org owners and admins write them. */
	canEdit(principal: Principal): boolean {
		return principal.permissions.has('metrics:read') && (principal.role === 'owner' || principal.role === 'admin' || principal.platformAdmin === true);
	}

	/** Silencing and acknowledging are on-call actions: deployers too. */
	canSilence(principal: Principal): boolean {
		return this.canEdit(principal) || (principal.permissions.has('metrics:read') && principal.role === 'deployer');
	}

	#requireEdit(principal: Principal): void {
		this.#requireRead(principal);
		if (!this.canEdit(principal)) throw new CoreError('forbidden', 'Only org owners and admins can change alert rules.', 403);
	}

	#requireSilence(principal: Principal): void {
		this.#requireRead(principal);
		if (!this.canSilence(principal)) throw new CoreError('forbidden', 'Only org owners, admins and deployers can silence or acknowledge alerts.', 403);
	}

	/** Dashboard page for a rule, for notification links. */
	url(ruleId?: string): string {
		const origin = this.ctx.config.platformOrigin.replace(/\/$/, '');
		return ruleId ? `${origin}/alerts/rules/${ruleId}` : `${origin}/alerts`;
	}

	channels(): AlertChannelInfo[] {
		const seen = new Set<string>();
		const out: AlertChannelInfo[] = [];
		for (const notifier of this.ctx.notifiers) {
			if (seen.has(notifier.name)) continue;
			seen.add(notifier.name);
			const label = notifier.name.length <= 3 ? notifier.name.toUpperCase() : notifier.name[0]!.toUpperCase() + notifier.name.slice(1);
			out.push({ name: notifier.name, label });
		}
		return out;
	}

	// --- names ----------------------------------------------------------------------------------

	#orgPrincipal(orgId: string): Principal {
		return buildPrincipal({ kind: 'system', userId: 'system:alerts', orgId, role: 'owner' });
	}

	#names(orgId: string): OrgNames {
		const principal = this.#orgPrincipal(orgId);
		const attempt = <T extends { id: string; name: string }>(read: () => T[]): Map<string, string> => {
			try {
				return new Map(read().map((item) => [item.id, item.name]));
			} catch {
				return new Map();
			}
		};
		return {
			project: attempt(() => this.ctx.projects.list(principal)),
			database: attempt(() => this.ctx.databases.list(principal)),
			storage: attempt(() => this.ctx.storage.list(principal)),
			broker: attempt(() => this.ctx.brokers.list(principal)),
		};
	}

	#labelNames(labels: Record<string, string>, names: OrgNames): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [label, value] of Object.entries(labels)) {
			const kind = ID_LABELS[label as keyof typeof ID_LABELS];
			const name = kind ? names[kind].get(value) : undefined;
			if (name) out[label] = name;
		}
		return out;
	}

	#userNames(ids: Array<string | null>): Map<string, string> {
		const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
		if (unique.length === 0) return new Map();
		try {
			const rows = this.ctx.sqlite
				.query<{ id: string; name: string }, string[]>(`SELECT id, name FROM "user" WHERE id IN (${unique.map(() => '?').join(', ')})`)
				.all(...unique);
			return new Map(rows.map((row) => [row.id, row.name]));
		} catch {
			return new Map();
		}
	}

	// --- rules: read ----------------------------------------------------------------------------

	#spec(row: RuleRow): AlertRuleSpec {
		const parsed = alertRuleInputSchema.safeParse({ ...parseJson<Record<string, unknown>>(row.spec_json, {}), name: row.name, enabled: row.enabled === 1 });
		if (parsed.success) return parsed.data;
		// A spec that no longer parses (a removed field) still lists, disabled, so it can be fixed.
		return alertRuleInputSchema.parse({
			name: row.name,
			enabled: false,
			query: { mode: 'sql', sql: 'SELECT 0' },
			condition: { op: 'gt', threshold: 0 },
		});
	}

	#ruleRow(principal: Principal, id: string): RuleRow {
		const row = this.ctx.sqlite.query<RuleRow, [string, string]>('SELECT * FROM alert_rules WHERE id = ? AND org_id = ?').get(id, principal.orgId);
		if (!row) throw new NotFoundError('Alert rule');
		return row;
	}

	#instances(ruleIds: string[]): Map<string, InstanceRecord[]> {
		const out = new Map<string, InstanceRecord[]>();
		if (ruleIds.length === 0) return out;
		const rows = this.ctx.sqlite
			.query<InstanceRow, string[]>(`SELECT * FROM alert_instances WHERE rule_id IN (${ruleIds.map(() => '?').join(', ')})`)
			.all(...ruleIds);
		for (const row of rows) {
			const list = out.get(row.rule_id) ?? [];
			list.push(toRecord(row));
			out.set(row.rule_id, list);
		}
		return out;
	}

	#activeSilences(orgId: string, now = this.ctx.now()): Silence[] {
		return this.ctx.sqlite
			.query<SilenceRow, [string, number, number]>('SELECT * FROM alert_silences WHERE org_id = ? AND starts_at <= ? AND ends_at > ?')
			.all(orgId, now, now)
			.map((row) => ({ id: row.id, ruleId: row.rule_id, matchers: parseJson<AlertMatcher[]>(row.matchers_json, []) }));
	}

	#summary(principal: Principal, row: RuleRow, instances: InstanceRecord[], userNames: Map<string, string>): AlertRuleSummary {
		const spec = this.#spec(row);
		const counts: Record<AlertState, number> = { normal: 0, pending: 0, firing: 0, nodata: 0 };
		let state: AlertState = 'normal';
		for (const instance of instances) {
			counts[instance.state]++;
			if (STATE_RANK[instance.state] > STATE_RANK[state]) state = instance.state;
		}
		return {
			...spec,
			id: row.id,
			version: row.version,
			createdBy: row.created_by,
			createdByName: row.created_by ? (userNames.get(row.created_by) ?? null) : null,
			createdAt: new Date(row.created_at).toISOString(),
			updatedAt: new Date(row.updated_at).toISOString(),
			health: row.health as AlertRuleHealth,
			lastError: row.last_error,
			lastEvaluatedAt: iso(row.last_evaluated_at),
			state,
			counts,
			canEdit: this.canEdit(principal),
			usesSql: spec.query.mode === 'sql',
		};
	}

	#instanceView(
		rule: { id: string; name: string; severity: AlertSeverity },
		instance: InstanceRecord,
		names: OrgNames,
		silences: Silence[],
		userNames: Map<string, string>,
	): AlertInstanceView {
		return {
			ruleId: rule.id,
			ruleName: rule.name,
			severity: rule.severity,
			fingerprint: instance.fingerprint,
			labels: instance.labels,
			labelNames: this.#labelNames(instance.labels, names),
			state: instance.state,
			value: instance.value,
			since: new Date(instance.stateSince).toISOString(),
			activeSince: iso(instance.activeSince),
			lastEvaluatedAt: new Date(instance.lastEvaluatedAt).toISOString(),
			notifiedAt: iso(instance.notifiedAt),
			acknowledgedBy: instance.acknowledgedBy,
			acknowledgedByName: instance.acknowledgedBy ? (userNames.get(instance.acknowledgedBy) ?? null) : null,
			acknowledgedAt: iso(instance.acknowledgedAt),
			silencedBy: silences.find((silence) => matchesSilence(silence, rule.id, instance.labels))?.id ?? null,
		};
	}

	listRules(principal: Principal): AlertRuleSummary[] {
		this.#requireRead(principal);
		const rows = this.ctx.sqlite.query<RuleRow, [string]>('SELECT * FROM alert_rules WHERE org_id = ? ORDER BY name COLLATE NOCASE').all(principal.orgId);
		const instances = this.#instances(rows.map((row) => row.id));
		const userNames = this.#userNames(rows.map((row) => row.created_by));
		return rows.map((row) => this.#summary(principal, row, instances.get(row.id) ?? [], userNames));
	}

	getRule(principal: Principal, id: string): AlertRuleView {
		this.#requireRead(principal);
		const row = this.#ruleRow(principal, id);
		const instances = (this.#instances([id]).get(id) ?? []).sort(
			(a, b) => STATE_RANK[b.state] - STATE_RANK[a.state] || a.fingerprint.localeCompare(b.fingerprint),
		);
		const userNames = this.#userNames([row.created_by, ...instances.map((instance) => instance.acknowledgedBy)]);
		const summary = this.#summary(principal, row, instances, userNames);
		const names = this.#names(principal.orgId);
		const silences = this.#activeSilences(principal.orgId);
		return {
			...summary,
			instances: instances.map((instance) => this.#instanceView(summary, instance, names, silences, userNames)),
		};
	}

	/** Resolve a rule by id or by unique name (agents). */
	resolveRule(principal: Principal, ref: string): AlertRuleView {
		this.#requireRead(principal);
		const byId = this.ctx.sqlite.query<{ id: string }, [string, string]>('SELECT id FROM alert_rules WHERE id = ? AND org_id = ?').get(ref, principal.orgId);
		if (byId) return this.getRule(principal, byId.id);
		const matches = this.ctx.sqlite
			.query<{ id: string }, [string, string]>('SELECT id FROM alert_rules WHERE org_id = ? AND lower(name) = lower(?)')
			.all(principal.orgId, ref.trim());
		if (matches.length === 1) return this.getRule(principal, matches[0]!.id);
		if (matches.length > 1) throw new ValidationError(`${matches.length} alert rules are named "${ref}"; pass an id: ${matches.map((m) => m.id).join(', ')}.`);
		throw new NotFoundError('Alert rule');
	}

	async overview(principal: Principal): Promise<AlertsOverview> {
		this.#requireRead(principal);
		const telemetry = this.ctx.telemetry;
		const available = telemetry ? await telemetry.ready() : false;
		const rows = this.ctx.sqlite.query<RuleRow, [string]>('SELECT * FROM alert_rules WHERE org_id = ?').all(principal.orgId);
		const instances = this.#instances(rows.map((row) => row.id));
		const silences = this.#activeSilences(principal.orgId);
		const names = this.#names(principal.orgId);
		const all = [...instances.values()].flat();
		const userNames = this.#userNames(all.map((instance) => instance.acknowledgedBy));
		const active: AlertInstanceView[] = [];
		for (const row of rows) {
			const spec = this.#spec(row);
			for (const instance of instances.get(row.id) ?? []) {
				if (instance.state === 'normal') continue;
				active.push(this.#instanceView({ id: row.id, name: row.name, severity: spec.severity }, instance, names, silences, userNames));
			}
		}
		active.sort(
			(a, b) =>
				STATE_RANK[b.state] - STATE_RANK[a.state] ||
				SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
				(a.activeSince ?? a.since).localeCompare(b.activeSince ?? b.since),
		);
		return {
			telemetryAvailable: available,
			telemetryError: available ? null : (telemetry?.error?.message ?? TELEMETRY_NOT_INSTALLED),
			channels: this.channels(),
			emailAvailable: Boolean(this.ctx.config.email),
			canEdit: this.canEdit(principal),
			canSilence: this.canSilence(principal),
			canUseSql: this.observability.canUseSql(principal),
			counts: {
				firing: all.filter((instance) => instance.state === 'firing').length,
				pending: all.filter((instance) => instance.state === 'pending').length,
				nodata: all.filter((instance) => instance.state === 'nodata').length,
				rules: rows.length,
				paused: rows.filter((row) => row.enabled !== 1).length,
				erroring: rows.filter((row) => row.enabled === 1 && row.health === 'error').length,
				silences: silences.length,
			},
			active,
		};
	}

	// --- rules: write ---------------------------------------------------------------------------

	#validate(principal: Principal, spec: AlertRuleSpec, previous?: AlertRuleSpec): void {
		const problem = alertQueryProblem(spec.query);
		if (problem) throw new ValidationError(problem);
		if (spec.query.mode === 'sql') {
			const unchanged = previous?.query.mode === 'sql' && previous.query.sql === spec.query.sql;
			if (!unchanged && !this.observability.canUseSql(principal))
				throw new CoreError('forbidden', 'SQL alert rules read every org’s telemetry, so only platform admins can write them. Use the query builder.', 403);
		} else {
			this.observability.validateQuery(principal, spec.query, 'query');
		}
		if (spec.keepFiringSeconds > 0 && spec.keepFiringSeconds < spec.intervalSeconds)
			throw new ValidationError('Keep firing for at least one evaluation interval, or 0 to resolve immediately.');
	}

	/** `input` is unparsed; defaults are applied here. */
	createRule(principal: Principal, input: unknown): AlertRuleView {
		this.#requireEdit(principal);
		const parsed = alertRuleInputSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid alert rule.', parsed.error.issues);
		const spec = parsed.data;
		this.#validate(principal, spec);
		const id = newId('alr_');
		const now = this.ctx.now();
		const { name, enabled, ...rest } = spec;
		this.ctx.sqlite.run(
			`INSERT INTO alert_rules (id, org_id, name, spec_json, enabled, version, health, next_eval_at, created_by, updated_by, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 1, 'unknown', 0, ?, ?, ?, ?)`,
			[id, principal.orgId, name, JSON.stringify(rest), enabled ? 1 : 0, principal.userId, principal.userId, now, now],
		);
		this.ctx.audit.record({ principal, action: 'alert_rule.create', resource: 'alert_rule', resourceId: id, args: { name }, result: 'ok' });
		return this.getRule(principal, id);
	}

	updateRule(principal: Principal, id: string, input: AlertRuleUpdateInput): AlertRuleView {
		this.#requireEdit(principal);
		const row = this.#ruleRow(principal, id);
		if (input.version !== row.version)
			throw new ConflictError(`This rule was saved by someone else (version ${row.version}; you edited version ${input.version}). Reload to see their changes.`);
		const previous = this.#spec(row);
		const { version: _version, ...patch } = input;
		const parsed = alertRuleInputSchema.safeParse({ ...previous, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) });
		if (!parsed.success) throw new ValidationError('Invalid alert rule.', parsed.error.issues);
		const spec = parsed.data;
		this.#validate(principal, spec, previous);
		const now = this.ctx.now();
		const { name, enabled, ...rest } = spec;
		// A changed query or condition starts the series over: old states describe another question.
		const reset =
			JSON.stringify(previous.query) !== JSON.stringify(spec.query) ||
			JSON.stringify(previous.variables) !== JSON.stringify(spec.variables) ||
			!enabled;
		const result = this.ctx.sqlite.run(
			`UPDATE alert_rules SET name = ?, spec_json = ?, enabled = ?, version = version + 1, updated_by = ?, updated_at = ?, next_eval_at = 0,
				health = CASE WHEN ? THEN 'unknown' ELSE health END, last_error = CASE WHEN ? THEN NULL ELSE last_error END,
				error_since = CASE WHEN ? THEN NULL ELSE error_since END, error_notified = CASE WHEN ? THEN 0 ELSE error_notified END
			WHERE id = ? AND org_id = ? AND version = ?`,
			[name, JSON.stringify(rest), enabled ? 1 : 0, principal.userId, now, reset ? 1 : 0, reset ? 1 : 0, reset ? 1 : 0, reset ? 1 : 0, id, principal.orgId, row.version],
		);
		if (result.changes === 0) throw new ConflictError('This rule was saved by someone else at the same time. Reload to see their changes.');
		if (reset) this.#dropInstances(row.org_id, id, name, enabled ? 'its query changed' : 'it was paused');
		this.ctx.audit.record({ principal, action: 'alert_rule.update', resource: 'alert_rule', resourceId: id, args: { name, enabled }, result: 'ok' });
		return this.getRule(principal, id);
	}

	deleteRule(principal: Principal, id: string): void {
		this.#requireEdit(principal);
		const row = this.#ruleRow(principal, id);
		this.#dropInstances(row.org_id, id, row.name, 'it was deleted');
		this.ctx.sqlite.run('DELETE FROM alert_rules WHERE id = ? AND org_id = ?', [id, principal.orgId]);
		this.ctx.sqlite.run('DELETE FROM alert_silences WHERE rule_id = ? AND org_id = ?', [id, principal.orgId]);
		this.ctx.audit.record({ principal, action: 'alert_rule.delete', resource: 'alert_rule', resourceId: id, args: { name: row.name }, result: 'ok' });
	}

	/** Forget a rule's series. Alerting ones are logged as cleared; nobody is notified. */
	#dropInstances(orgId: string, ruleId: string, ruleName: string, why: string): void {
		const alerting = this.ctx.sqlite
			.query<{ n: number }, [string]>("SELECT count(*) AS n FROM alert_instances WHERE rule_id = ? AND state IN ('firing', 'nodata', 'pending')")
			.get(ruleId);
		this.ctx.sqlite.run('DELETE FROM alert_instances WHERE rule_id = ?', [ruleId]);
		if (alerting && alerting.n > 0)
			this.#event({ orgId, ruleId, kind: 'state', to: 'normal', severity: 'info', title: `${ruleName}: cleared`, detail: `${alerting.n} active series cleared because ${why}.` });
	}

	acknowledge(principal: Principal, ruleId: string, fingerprint: string, acknowledged = true): AlertRuleView {
		this.#requireSilence(principal);
		const row = this.#ruleRow(principal, ruleId);
		const instance = this.ctx.sqlite
			.query<InstanceRow, [string, string]>('SELECT * FROM alert_instances WHERE rule_id = ? AND fingerprint = ?')
			.get(ruleId, fingerprint);
		if (!instance) throw new NotFoundError('Alert series');
		if (acknowledged && !ALERTING.has(instance.state as AlertState)) throw new ValidationError('Only firing or no-data alerts can be acknowledged.');
		const now = this.ctx.now();
		this.ctx.sqlite.run('UPDATE alert_instances SET acknowledged_by = ?, acknowledged_at = ? WHERE rule_id = ? AND fingerprint = ?', [
			acknowledged ? principal.userId : null,
			acknowledged ? now : null,
			ruleId,
			fingerprint,
		]);
		const labels = parseJson<Record<string, string>>(instance.labels_json, {});
		this.#event({
			orgId: row.org_id,
			ruleId,
			kind: 'ack',
			fingerprint,
			labels,
			severity: 'info',
			title: `${row.name}: ${acknowledged ? 'acknowledged' : 'acknowledgement removed'}`,
			detail: `${this.#userNames([principal.userId]).get(principal.userId) ?? principal.userId} ${acknowledged ? 'acknowledged' : 'un-acknowledged'} ${labelText(labels) || 'the alert'}. Repeat notifications ${acknowledged ? 'stop until it resolves' : 'resume'}.`,
		});
		return this.getRule(principal, ruleId);
	}

	// --- silences -------------------------------------------------------------------------------

	listSilences(principal: Principal, options: { includeExpired?: boolean } = {}): AlertSilenceView[] {
		this.#requireRead(principal);
		const now = this.ctx.now();
		const rows = this.ctx.sqlite
			.query<SilenceRow & { rule_name: string | null }, [string, number]>(
				`SELECT s.*, r.name AS rule_name FROM alert_silences s LEFT JOIN alert_rules r ON r.id = s.rule_id
				WHERE s.org_id = ? AND s.ends_at > ? ORDER BY s.ends_at DESC`,
			)
			.all(principal.orgId, options.includeExpired ? now - SILENCE_RETENTION_MS : now);
		const userNames = this.#userNames(rows.map((row) => row.created_by));
		return rows.map((row) => ({
			id: row.id,
			ruleId: row.rule_id,
			ruleName: row.rule_name,
			matchers: parseJson<AlertMatcher[]>(row.matchers_json, []),
			startsAt: new Date(row.starts_at).toISOString(),
			endsAt: new Date(row.ends_at).toISOString(),
			comment: row.comment,
			createdBy: row.created_by,
			createdByName: row.created_by ? (userNames.get(row.created_by) ?? null) : null,
			createdAt: new Date(row.created_at).toISOString(),
			status: row.ends_at <= now ? 'expired' : row.starts_at > now ? 'pending' : 'active',
		}));
	}

	createSilence(principal: Principal, input: AlertSilenceCreateInput): AlertSilenceView {
		this.#requireSilence(principal);
		const parsed = alertSilenceCreateSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid silence.', parsed.error.issues);
		const value = parsed.data;
		let ruleName: string | null = null;
		if (value.ruleId) ruleName = this.#ruleRow(principal, value.ruleId).name;
		const now = this.ctx.now();
		const startsAt = value.startsAt ? Date.parse(value.startsAt) : now;
		const endsAt = value.endsAt ? Date.parse(value.endsAt) : startsAt + value.durationMinutes! * MINUTE_MS;
		if (!(endsAt > startsAt)) throw new ValidationError('A silence must end after it starts.');
		if (endsAt <= now) throw new ValidationError('That silence would already be over.');
		if (endsAt - startsAt > 90 * 86_400_000) throw new ValidationError('Silences are limited to 90 days; pause the rule instead.');
		const id = newId('sil_');
		this.ctx.sqlite.run(
			'INSERT INTO alert_silences (id, org_id, rule_id, matchers_json, starts_at, ends_at, comment, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[id, principal.orgId, value.ruleId, JSON.stringify(value.matchers), startsAt, endsAt, value.comment, principal.userId, now],
		);
		const scope = `${ruleName ?? 'all alert rules'}${value.matchers.length ? ` where ${value.matchers.map((m) => `${m.label}=${m.value}`).join(', ')}` : ''}`;
		this.#event({
			orgId: principal.orgId,
			ruleId: value.ruleId,
			kind: 'silence',
			severity: 'info',
			title: `Silenced ${scope}`,
			detail: `Until ${new Date(endsAt).toISOString()}${value.comment ? `: ${value.comment}` : ''}.`,
		});
		this.ctx.audit.record({ principal, action: 'alert_silence.create', resource: 'alert_silence', resourceId: id, args: { ruleId: value.ruleId, endsAt }, result: 'ok' });
		return this.listSilences(principal, { includeExpired: true }).find((silence) => silence.id === id)!;
	}

	/** Ends a silence now (kept in the list as expired). */
	expireSilence(principal: Principal, id: string): void {
		this.#requireSilence(principal);
		const now = this.ctx.now();
		const result = this.ctx.sqlite.run('UPDATE alert_silences SET ends_at = ? WHERE id = ? AND org_id = ? AND ends_at > ?', [now, id, principal.orgId, now]);
		if (result.changes === 0) throw new NotFoundError('Active silence');
		this.ctx.audit.record({ principal, action: 'alert_silence.expire', resource: 'alert_silence', resourceId: id, args: {}, result: 'ok' });
	}

	// --- history --------------------------------------------------------------------------------

	history(principal: Principal, options: { ruleId?: string; limit?: number; before?: string; kinds?: AlertEventKind[] } = {}): AlertEventView[] {
		this.#requireRead(principal);
		const where = ['(e.org_id = ?' + (principal.platformAdmin ? ' OR e.org_id IS NULL)' : ')')];
		const args: Array<string | number> = [principal.orgId];
		if (options.ruleId) {
			where.push('e.rule_id = ?');
			args.push(options.ruleId);
		}
		if (options.before) {
			const before = Date.parse(options.before);
			if (Number.isFinite(before)) {
				where.push('e.at < ?');
				args.push(before);
			}
		}
		if (options.kinds?.length) {
			where.push(`e.kind IN (${options.kinds.map(() => '?').join(', ')})`);
			args.push(...options.kinds);
		}
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
		const rows = this.ctx.sqlite
			.query<EventRow & { rule_name: string | null }, Array<string | number>>(
				`SELECT e.*, r.name AS rule_name FROM alert_events e LEFT JOIN alert_rules r ON r.id = e.rule_id
				WHERE ${where.join(' AND ')} ORDER BY e.at DESC, e.rowid DESC LIMIT ${limit}`,
			)
			.all(...args);
		return rows.map((row) => ({
			id: row.id,
			kind: row.kind as AlertEventKind,
			ruleId: row.rule_id,
			ruleName: row.rule_name,
			fingerprint: row.fingerprint,
			labels: parseJson<Record<string, string>>(row.labels_json, {}),
			from: (row.from_state as AlertState | null) ?? null,
			to: (row.to_state as AlertState | null) ?? null,
			value: row.value,
			severity: row.severity as AlertSeverity,
			title: row.title,
			detail: row.detail,
			delivery: row.delivery_json ? parseJson<Record<string, string>>(row.delivery_json, {}) : null,
			at: new Date(row.at).toISOString(),
		}));
	}

	#event(input: {
		orgId: string | null;
		ruleId?: string | null;
		kind: AlertEventKind;
		fingerprint?: string | null;
		labels?: Record<string, string>;
		from?: AlertState | null;
		to?: AlertState | null;
		value?: number | null;
		severity: AlertSeverity;
		title: string;
		detail?: string;
		delivery?: Record<string, string> | null;
	}): void {
		this.ctx.sqlite.run(
			`INSERT INTO alert_events (id, org_id, rule_id, kind, fingerprint, labels_json, from_state, to_state, value, severity, title, detail, delivery_json, at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				newId('ale_'),
				input.orgId,
				input.ruleId ?? null,
				input.kind,
				input.fingerprint ?? null,
				JSON.stringify(input.labels ?? {}),
				input.from ?? null,
				input.to ?? null,
				input.value ?? null,
				input.severity,
				input.title,
				input.detail ?? '',
				input.delivery ? JSON.stringify(input.delivery) : null,
				this.ctx.now(),
			],
		);
	}

	/**
	 * Built-in platform alerts (node offline, disk, certificates, backups) are recorded here too,
	 * so the Alerts page shows one timeline. Platform-wide: only platform admins see them.
	 */
	recordSystemAlert(alert: AlertMessage, delivery: Record<string, string>): void {
		try {
			this.#event({ orgId: null, kind: 'system', severity: alert.severity, title: alert.title, detail: alert.detail, delivery, fingerprint: alert.key });
		} catch (error) {
			console.error('[alerts] could not record a system alert:', error);
		}
	}

	// --- system alerts (built-in; routing and thresholds) --------------------------------------

	/** Platform owner: a platform admin's own session in an org they own. */
	canConfigureSystem(principal: Principal): boolean {
		return principal.platformAdmin === true && principal.kind === 'user' && principal.role === 'owner';
	}

	#routing(): SystemAlertRouting {
		if (this.#routingCache) return this.#routingCache;
		let raw: unknown = {};
		try {
			const row = this.ctx.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(SYSTEM_ALERT_ROUTING_KEY);
			if (row) raw = JSON.parse(row.value);
		} catch {
			// No settings table yet, or a hand-edited row: every kind on, every channel.
		}
		const parsed = systemAlertRoutingSchema.safeParse(raw);
		this.#routingCache = parsed.success ? parsed.data : {};
		return this.#routingCache;
	}

	/** Where a built-in alert goes, or null when its kind is turned off. */
	systemRoute(key: string): Notifier[] | null {
		const kind = systemAlertKindOf(key);
		const route = kind ? this.#routing()[kind] : undefined;
		if (route && !route.enabled) return null;
		const channels = route?.channels ?? [];
		return channels.length ? this.ctx.notifiers.filter((notifier) => channels.includes(notifier.name)) : [...this.ctx.notifiers];
	}

	/**
	 * Deliver a built-in alert through its kind's routing and record it in the history. Returns
	 * false when the kind is turned off (nothing sent, nothing recorded).
	 */
	async deliverSystem(input: AlertMessage): Promise<boolean> {
		const notifiers = this.systemRoute(input.key);
		if (!notifiers) return false;
		// Webhook receivers get the documented `status` and a dashboard link on built-in alerts too.
		const alert: AlertMessage = { ...input, status: input.status ?? 'firing', url: input.url ?? this.url() };
		const delivery = await this.#send(notifiers, alert);
		if (notifiers.length === 0) delivery.none = 'no notification channel is configured';
		this.recordSystemAlert(alert, delivery);
		return true;
	}

	systemAlerts(principal: Principal): SystemAlertsView {
		this.#requireRead(principal);
		if (!principal.platformAdmin) throw new CoreError('forbidden', 'System alerts are platform-wide; only platform admins can see them.', 403);
		const routing = this.#routing();
		const policies = this.ctx.policies.get();
		const now = this.ctx.now();
		const recent = this.ctx.sqlite
			.query<{ fingerprint: string | null; title: string; at: number }, [number]>(
				"SELECT fingerprint, title, at FROM alert_events WHERE kind = 'system' AND org_id IS NULL AND at >= ? ORDER BY at DESC",
			)
			.all(now - EVENT_RETENTION_MS);
		return {
			alerts: systemAlertCatalog.map((info) => {
				const mine = recent.filter((event) => event.fingerprint !== null && systemAlertKindOf(event.fingerprint) === info.kind);
				const route = routing[info.kind];
				return {
					...info,
					enabled: route?.enabled ?? true,
					channels: route?.channels ?? [],
					values: Object.fromEntries(info.thresholds.map((threshold) => [threshold.key, policies[threshold.key] as number])),
					lastFiredAt: iso(mine[0]?.at ?? null),
					lastTitle: mine[0]?.title ?? null,
					recentCount: mine.filter((event) => event.at >= now - 86_400_000).length,
				};
			}),
			repeatMinutes: policies.systemAlertRepeatMinutes,
			channels: this.channels(),
			channelStatus: [
				...knownAlertChannels.map((channel) => ({ ...channel, configured: this.ctx.notifiers.some((notifier) => notifier.name === channel.name) })),
				...this.channels()
					.filter((channel) => !knownAlertChannels.some((known) => known.name === channel.name))
					.map((channel) => ({ ...channel, description: '', configured: true })),
			],
			canEdit: this.canConfigureSystem(principal),
		};
	}

	updateSystemAlerts(principal: Principal, input: SystemAlertsUpdate): SystemAlertsView {
		if (!this.canConfigureSystem(principal)) throw new CoreError('forbidden', 'Only the platform owner can change system alerts.', 403);
		const parsed = systemAlertsUpdateSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError('Invalid system alert settings.', parsed.error.issues);
		// Policies validate their own ranges (and that critical < warning for certificates).
		if (parsed.data.policies && Object.keys(parsed.data.policies).length) this.ctx.policies.update(principal, parsed.data.policies);
		if (parsed.data.routing) {
			const merged: SystemAlertRouting = { ...this.#routing() };
			for (const [kind, route] of Object.entries(parsed.data.routing)) if (route) merged[kind as SystemAlertKind] = route;
			this.ctx.sqlite.run(
				'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
				[SYSTEM_ALERT_ROUTING_KEY, JSON.stringify(merged), this.ctx.now()],
			);
			this.#routingCache = merged;
		}
		this.ctx.audit.record({ principal, action: 'system_alerts.update', resource: 'settings', resourceId: SYSTEM_ALERT_ROUTING_KEY, args: parsed.data, result: 'ok' });
		return this.systemAlerts(principal);
	}

	/** Send a test message through one platform channel (or all of them). */
	async testChannel(principal: Principal, name?: string): Promise<Record<string, string>> {
		if (!this.canConfigureSystem(principal)) throw new CoreError('forbidden', 'Only the platform owner can send test alerts.', 403);
		const notifiers = name ? this.ctx.notifiers.filter((notifier) => notifier.name === name) : [...this.ctx.notifiers];
		if (name && notifiers.length === 0) throw new NotFoundError(`Channel ${name}`);
		return this.#send(notifiers, {
			key: `alert_test:${name ?? 'all'}`,
			title: 'Test alert',
			detail: `A test from Skiff’s Alerts → Channels. If you can read this, ${name ? `the ${name} channel` : 'this channel'} works.\n\n${this.url()}`,
			severity: 'info',
			url: this.url(),
		});
	}

	// --- evaluation -----------------------------------------------------------------------------

	/** Run a query for a rule's window, as the rule's org (builder) or the reader (SQL). */
	async #run(orgId: string, spec: AlertRuleSpec, now: number): Promise<QueryResult> {
		const range = { from: new Date(now - spec.windowSeconds * 1000).toISOString(), to: new Date(now).toISOString() };
		if (spec.query.mode === 'builder') {
			const query = { mode: 'builder' as const, builder: { ...spec.query.builder, timeSeries: false, limit: spec.query.builder.limit ?? 1_000 } };
			return this.observability.query(this.#orgPrincipal(orgId), { query, range, maxDataPoints: 10, variables: spec.variables });
		}
		const telemetry = this.ctx.telemetry;
		if (!telemetry || !(await telemetry.ready())) throw new CoreError('telemetry_unavailable', telemetry?.error?.message ?? TELEMETRY_NOT_INSTALLED, 503);
		const expanded = expandSqlMacros(spec.query.sql, {
			fromMs: now - spec.windowSeconds * 1000,
			toMs: now,
			maxDataPoints: 10,
			variables: spec.variables,
			interval: spec.windowSeconds,
		});
		try {
			const raw = await telemetry.runQuery(expanded.sql, { asReader: true, settings: { date_time_output_format: 'unix_timestamp' } });
			return toQueryResult(raw, { sql: expanded.sql, intervalSeconds: expanded.intervalSeconds, resolution: null });
		} catch (error) {
			if (error instanceof ClickHouseUnavailableError) throw new CoreError('telemetry_unavailable', error.message, 503);
			if (error instanceof ClickHouseError) throw new CoreError('query_failed', error.message, 400);
			throw error;
		}
	}

	/** Evaluate a rule (saved or not) once, changing nothing. */
	async preview(principal: Principal, input: { ruleId?: string; rule?: unknown }): Promise<AlertPreview> {
		this.#requireRead(principal);
		let spec: AlertRuleSpec;
		let saved: InstanceRecord[] = [];
		if (input.rule !== undefined) {
			const parsed = alertRuleInputSchema.safeParse(input.rule);
			if (!parsed.success) throw new ValidationError('Invalid alert rule.', parsed.error.issues);
			spec = parsed.data;
			const previous = input.ruleId ? this.#spec(this.#ruleRow(principal, input.ruleId)) : undefined;
			this.#validate(principal, spec, previous);
		} else if (input.ruleId) {
			spec = this.#spec(this.#ruleRow(principal, input.ruleId));
		} else throw new ValidationError('Pass a rule or a ruleId.');
		if (input.ruleId) saved = this.#instances([input.ruleId]).get(input.ruleId) ?? [];
		const now = this.ctx.now();
		const result = await this.#run(principal.orgId, spec, now);
		const names = this.#names(principal.orgId);
		const states = new Map(saved.map((instance) => [instance.fingerprint, instance.state]));
		const series = seriesFromResult(result).map(({ labels, value }) => {
			const fingerprint = fingerprintOf(labels);
			return {
				fingerprint,
				labels,
				labelNames: this.#labelNames(labels, names),
				value,
				met: value !== null && compareAlert(value, spec.condition),
				state: states.get(fingerprint) ?? null,
			};
		});
		series.sort((a, b) => Number(b.met) - Number(a.met) || (b.value ?? -Infinity) - (a.value ?? -Infinity));
		return {
			evaluatedAt: new Date(now).toISOString(),
			from: new Date(now - spec.windowSeconds * 1000).toISOString(),
			to: new Date(now).toISOString(),
			sql: result.sql,
			series,
			...(result.notice ? { notice: result.notice } : {}),
		};
	}

	/**
	 * Evaluate every enabled rule that is due. Called on a short timer by the control plane; a
	 * conditional update claims each rule, so two processes never evaluate one rule twice.
	 */
	async evaluateDue(): Promise<EvaluationReport> {
		if (this.#running) return { evaluated: 0, failed: 0, notifications: 0, skipped: 'busy' };
		this.#running = true;
		try {
			const now = this.ctx.now();
			this.#prune(now);
			const due = this.ctx.sqlite
				.query<RuleRow, [number]>('SELECT * FROM alert_rules WHERE enabled = 1 AND next_eval_at <= ? ORDER BY next_eval_at')
				.all(now);
			if (due.length === 0) return { evaluated: 0, failed: 0, notifications: 0 };

			const telemetry = this.ctx.telemetry;
			if (!telemetry || !(await telemetry.ready())) {
				await this.#telemetryDown(now, due, telemetry?.error?.message ?? TELEMETRY_NOT_INSTALLED);
				return { evaluated: 0, failed: 0, notifications: 0, skipped: 'telemetry_unavailable' };
			}
			await this.#telemetryUp(now);

			const report: EvaluationReport = { evaluated: 0, failed: 0, notifications: 0 };
			for (const row of due) {
				const spec = this.#spec(row);
				const claimed = this.ctx.sqlite.run('UPDATE alert_rules SET next_eval_at = ? WHERE id = ? AND next_eval_at = ?', [
					now + spec.intervalSeconds * 1000,
					row.id,
					row.next_eval_at,
				]);
				if (claimed.changes === 0) continue;
				try {
					report.notifications += await this.#evaluate(row, spec, now);
					report.evaluated++;
				} catch (error) {
					report.failed++;
					await this.#ruleFailed(row, spec, error as Error, now);
				}
			}
			return report;
		} finally {
			this.#running = false;
		}
	}

	/** Evaluate one saved rule now (tests, "evaluate now" button). Returns notifications sent. */
	async evaluateRule(principal: Principal, id: string): Promise<AlertRuleView> {
		this.#requireEdit(principal);
		const row = this.#ruleRow(principal, id);
		const spec = this.#spec(row);
		if (!spec.enabled) throw new ValidationError('The rule is paused.');
		const now = this.ctx.now();
		this.ctx.sqlite.run('UPDATE alert_rules SET next_eval_at = ? WHERE id = ?', [now + spec.intervalSeconds * 1000, id]);
		try {
			await this.#evaluate(row, spec, now);
		} catch (error) {
			await this.#ruleFailed(row, spec, error as Error, now);
		}
		return this.getRule(principal, id);
	}

	async #evaluate(row: RuleRow, spec: AlertRuleSpec, now: number): Promise<number> {
		const result = await this.#run(row.org_id, spec, now);
		const observed = seriesFromResult(result);
		const existing = new Map((this.#instances([row.id]).get(row.id) ?? []).map((instance) => [instance.fingerprint, instance]));
		const names = this.#names(row.org_id);
		const seen = new Set<string>();
		const next: InstanceRecord[] = [];

		for (const { labels, value } of observed) {
			const fingerprint = fingerprintOf(labels);
			seen.add(fingerprint);
			const previous = existing.get(fingerprint) ?? newInstance(fingerprint, labels, now);
			next.push(advanceInstance(previous, { value }, spec, now));
		}
		// Series that were there before and are missing now have no data.
		for (const [fingerprint, previous] of existing) {
			if (seen.has(fingerprint)) continue;
			// A deleted project/database/storage instance/broker is gone, not down.
			const gone = Object.entries(previous.labels).some(([label, value]) => {
				const kind = ID_LABELS[label as keyof typeof ID_LABELS];
				return kind !== undefined && value !== '' && !names[kind].has(value);
			});
			if (gone) {
				next.push({ ...previous, state: 'normal', lastEvaluatedAt: now, activeSince: null, clearedSince: null, lastSeenAt: 0 });
				continue;
			}
			next.push(advanceInstance(previous, { value: null }, spec, now));
		}
		// An ungrouped builder rule with no rows at all is one series without data. (A grouped or
		// SQL rule with no rows has no series: nothing reported yet is not an outage.)
		const ungrouped = spec.query.mode === 'builder' && spec.query.builder.groupBy.length === 0;
		if (ungrouped && observed.length === 0 && existing.size === 0 && spec.noData !== 'ok' && spec.noData !== 'keep') {
			next.push(advanceInstance(newInstance('{}', {}, now), { value: null }, spec, now));
		}

		const silences = this.#activeSilences(row.org_id, now);
		const unit = alertValueUnit(spec);
		const firing: InstanceRecord[] = [];
		const resolved: InstanceRecord[] = [];

		for (const instance of next) {
			const before = existing.get(instance.fingerprint);
			const from = before?.state ?? 'normal';
			if (from !== instance.state) {
				this.#event({
					orgId: row.org_id,
					ruleId: row.id,
					kind: 'state',
					fingerprint: instance.fingerprint,
					labels: instance.labels,
					from,
					to: instance.state,
					value: instance.value,
					severity: ALERTING.has(instance.state) ? spec.severity : 'info',
					title: `${row.name}: ${from} → ${instance.state}`,
					detail: `${labelText(instance.labels, this.#labelNames(instance.labels, names)) || 'Value'} ${formatAlertValue(instance.value, unit)} (${conditionText(spec, unit)}).`,
				});
			}
			const silenced = silences.some((silence) => matchesSilence(silence, row.id, instance.labels));
			if (ALERTING.has(instance.state)) {
				if (silenced) continue;
				const changed = instance.notifiedState !== instance.state;
				const repeat =
					!changed &&
					spec.repeatMinutes > 0 &&
					instance.acknowledgedAt === null &&
					instance.notifiedAt !== null &&
					now - instance.notifiedAt >= spec.repeatMinutes * MINUTE_MS;
				if (changed || repeat) firing.push(instance);
			} else if (instance.notifiedState !== null) {
				instance.notifiedState = null;
				if (spec.notifyOnResolve && !silenced) resolved.push(instance);
			}
		}

		let sent = 0;
		if (firing.length > 0) {
			await this.#notify(row, spec, firing, 'firing', names, unit, now);
			for (const instance of firing) {
				instance.notifiedAt = now;
				instance.notifiedState = instance.state;
			}
			sent++;
		}
		if (resolved.length > 0) {
			await this.#notify(row, spec, resolved, 'resolved', names, unit, now);
			sent++;
		}

		const keep = next.filter((instance) => instance.state !== 'normal' || (instance.lastSeenAt !== null && instance.lastSeenAt !== 0 && now - instance.lastSeenAt < STALE_INSTANCE_MS));
		const write = this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run('DELETE FROM alert_instances WHERE rule_id = ?', [row.id]);
			for (const instance of keep) {
				this.ctx.sqlite.run(
					`INSERT INTO alert_instances (rule_id, fingerprint, labels_json, state, value, state_since, active_since, cleared_since, last_seen_at,
						last_evaluated_at, notified_at, notified_state, acknowledged_by, acknowledged_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						row.id,
						instance.fingerprint,
						JSON.stringify(instance.labels),
						instance.state,
						instance.value,
						instance.stateSince,
						instance.activeSince,
						instance.clearedSince,
						instance.lastSeenAt,
						instance.lastEvaluatedAt,
						instance.notifiedAt,
						instance.notifiedState,
						instance.acknowledgedBy,
						instance.acknowledgedAt,
					],
				);
			}
			const recovered = row.health === 'error';
			this.ctx.sqlite.run(
				"UPDATE alert_rules SET health = 'ok', last_error = NULL, error_since = NULL, error_notified = 0, last_evaluated_at = ? WHERE id = ?",
				[now, row.id],
			);
			if (recovered)
				this.#event({ orgId: row.org_id, ruleId: row.id, kind: 'error', severity: 'info', title: `${row.name}: evaluating again`, detail: 'The rule’s query succeeded.' });
		});
		write();
		return sent;
	}

	async #ruleFailed(row: RuleRow, spec: AlertRuleSpec, error: Error, now: number): Promise<void> {
		const message = error.message.slice(0, 2_000);
		const since = row.error_since ?? now;
		if (row.health !== 'error')
			this.#event({ orgId: row.org_id, ruleId: row.id, kind: 'error', severity: 'warning', title: `${row.name}: evaluation failed`, detail: message });
		let notified = row.error_notified === 1;
		if (!notified && now - since >= RULE_ERROR_NOTIFY_MS) {
			notified = true;
			const alert: AlertMessage = {
				key: `alert_rule_error:${row.id}`,
				title: `Alert rule failing: ${row.name}`,
				detail: `The rule has not evaluated for ${formatDuration(now - since)}, so it cannot fire. Last error: ${message}`,
				severity: 'warning',
				url: this.url(row.id),
			};
			const delivery = await this.#deliver(alert, spec);
			this.#event({ orgId: row.org_id, ruleId: row.id, kind: 'notification', severity: 'warning', title: alert.title, detail: alert.detail, delivery });
		}
		this.ctx.sqlite.run('UPDATE alert_rules SET health = ?, last_error = ?, error_since = ?, error_notified = ?, last_evaluated_at = ? WHERE id = ?', [
			'error',
			message,
			since,
			notified ? 1 : 0,
			now,
			row.id,
		]);
		if (error instanceof CoreError && error.status < 500 && error.code !== 'telemetry_unavailable') return;
		console.error(`[alerts] rule ${row.id} failed:`, message);
	}

	async #telemetryDown(now: number, due: RuleRow[], message: string): Promise<void> {
		// Rules keep their states; mark them so the UI says why nothing is evaluating.
		for (const row of due)
			this.ctx.sqlite.run("UPDATE alert_rules SET health = 'error', last_error = ?, error_since = COALESCE(error_since, ?) WHERE id = ?", [
				`Telemetry unavailable: ${message}`,
				now,
				row.id,
			]);
		const state = this.ctx.sqlite
			.query<{ last_fired_at: number | null; last_value: string | null }, [string]>('SELECT last_fired_at, last_value FROM alert_state WHERE key = ?')
			.get(TELEMETRY_DOWN_KEY);
		const since = state?.last_fired_at ?? now;
		if (!state)
			this.ctx.sqlite.run('INSERT INTO alert_state (key, last_fired_at, last_value) VALUES (?, ?, ?)', [TELEMETRY_DOWN_KEY, now, 'down']);
		if (state?.last_value === 'notified' || now - since < TELEMETRY_DOWN_NOTIFY_MS) return;
		const alert: AlertMessage = {
			key: TELEMETRY_DOWN_KEY,
			title: 'Alert rules cannot evaluate',
			detail: `The telemetry store (ClickHouse) has been unavailable for ${formatDuration(now - since)}, so ${due.length} metric alert rule(s) cannot fire. ${message}`,
			severity: 'critical',
			url: this.url(),
		};
		await this.deliverSystem(alert);
		this.ctx.sqlite.run('UPDATE alert_state SET last_value = ? WHERE key = ?', ['notified', TELEMETRY_DOWN_KEY]);
	}

	async #telemetryUp(now: number): Promise<void> {
		const state = this.ctx.sqlite
			.query<{ last_fired_at: number | null; last_value: string | null }, [string]>('SELECT last_fired_at, last_value FROM alert_state WHERE key = ?')
			.get(TELEMETRY_DOWN_KEY);
		if (!state) return;
		this.ctx.sqlite.run('DELETE FROM alert_state WHERE key = ?', [TELEMETRY_DOWN_KEY]);
		if (state.last_value !== 'notified') return;
		const alert: AlertMessage = {
			key: TELEMETRY_DOWN_KEY,
			title: 'Alert rules evaluating again',
			detail: `The telemetry store is back after ${formatDuration(now - (state.last_fired_at ?? now))}.`,
			severity: 'info',
			status: 'resolved',
			url: this.url(),
		};
		await this.deliverSystem(alert);
	}

	/** One message per rule, evaluation and direction, listing the series. */
	async #notify(
		row: RuleRow,
		spec: AlertRuleSpec,
		instances: InstanceRecord[],
		status: 'firing' | 'resolved',
		names: OrgNames,
		unit: string,
		now: number,
	): Promise<void> {
		const describe = (instance: InstanceRecord) => labelText(instance.labels, this.#labelNames(instance.labels, names));
		const single = instances.length === 1 ? instances[0]! : null;
		const subject = single ? describe(single) : `${instances.length} series`;
		const noData = instances.every((instance) => instance.state === 'nodata');
		const title =
			status === 'resolved'
				? `Resolved: ${row.name}${subject ? ` (${subject})` : ''}`
				: `${noData ? 'No data: ' : ''}${row.name}${subject ? ` (${subject})` : ''}`;
		const lines = instances.slice(0, MAX_LISTED_SERIES).map((instance) => {
			const who = describe(instance) || row.name;
			if (status === 'resolved') {
				const lasted = instance.activeSince ?? instance.stateSince;
				const at = instance.value === null ? '' : ` at ${formatAlertValue(instance.value, unit)}`;
				return `- ${who}: back to normal${at}${instance.notifiedAt ? ` after ${formatDuration(now - lasted)}` : ''}`;
			}
			if (instance.state === 'nodata') return `- ${who}: no data for ${formatDuration(now - (instance.activeSince ?? instance.stateSince))}`;
			return `- ${who}: ${formatAlertValue(instance.value, unit)} for ${formatDuration(now - (instance.activeSince ?? instance.stateSince))}`;
		});
		if (instances.length > MAX_LISTED_SERIES) lines.push(`- …and ${instances.length - MAX_LISTED_SERIES} more`);
		const detail = [
			status === 'resolved' ? `${row.name} has resolved.` : `${row.name}: ${conditionText(spec, unit)} over the last ${formatDuration(spec.windowSeconds * 1000)}.`,
			...lines,
			...(status === 'firing' && spec.runbook.trim() ? ['', `Runbook: ${spec.runbook.trim()}`] : []),
			'',
			this.url(row.id),
		].join('\n');
		const alert: AlertMessage = {
			key: `alert_rule:${row.id}`,
			title,
			detail,
			severity: status === 'resolved' ? 'info' : spec.severity,
			status,
			url: this.url(row.id),
			...(single ? { labels: single.labels } : {}),
		};
		const delivery = await this.#deliver(alert, spec);
		this.ctx.events.emitAlert(row.org_id, row.id, status, {
			ruleId: row.id,
			rule: row.name,
			key: alert.key,
			title,
			detail,
			severity: alert.severity,
			status,
			url: alert.url ?? null,
			labels: single?.labels ?? {},
			series: instances.map((instance) => ({ labels: instance.labels, state: instance.state, value: instance.value })),
		});
		this.#event({
			orgId: row.org_id,
			ruleId: row.id,
			kind: 'notification',
			fingerprint: single?.fingerprint ?? null,
			labels: single?.labels ?? {},
			severity: alert.severity,
			title,
			detail,
			delivery,
		});
	}

	/** Route to the rule's channels (all notifiers when none are picked) plus its own emails. */
	async #deliver(alert: AlertMessage, spec: Pick<AlertRuleSpec, 'channels' | 'emails'>): Promise<Record<string, string>> {
		const notifiers = spec.channels.length ? this.ctx.notifiers.filter((notifier) => spec.channels.includes(notifier.name)) : [...this.ctx.notifiers];
		const delivery = await this.#send(notifiers, alert);
		const transport = this.ctx.config.email;
		for (const to of spec.emails) {
			if (!transport) {
				delivery[`email:${to}`] = 'email is not configured';
				continue;
			}
			delivery[`email:${to}`] = await withTimeout(
				transport.send({ to, subject: `[Skiff ${alert.status === 'resolved' ? 'resolved' : alert.severity}] ${alert.title}`, text: alert.detail }),
			);
		}
		const missing = spec.channels.filter((name) => !this.ctx.notifiers.some((notifier) => notifier.name === name));
		for (const name of missing) delivery[name] = 'not configured';
		if (Object.keys(delivery).length === 0) delivery.none = 'no notification channel is configured';
		return delivery;
	}

	async #send(notifiers: Notifier[], alert: AlertMessage): Promise<Record<string, string>> {
		const results = await Promise.all(notifiers.map(async (notifier) => [notifier.name, await withTimeout(notifier.notify(alert))] as const));
		const delivery: Record<string, string> = {};
		for (const [name, result] of results) {
			if (result !== 'ok') console.error(`[alerts] ${name} failed: ${result}`);
			delivery[delivery[name] === undefined ? name : `${name}#${Object.keys(delivery).length}`] = result;
		}
		return delivery;
	}

	/** Send a test notification through a rule's routing. */
	async test(principal: Principal, ruleId: string): Promise<Record<string, string>> {
		this.#requireEdit(principal);
		const row = this.#ruleRow(principal, ruleId);
		const spec = this.#spec(row);
		const alert: AlertMessage = {
			key: `alert_rule_test:${row.id}`,
			title: `Test: ${row.name}`,
			detail: `A test notification for the alert rule “${row.name}”. When it fires, notifications arrive here.\n\n${this.url(row.id)}`,
			severity: 'info',
			url: this.url(row.id),
		};
		const delivery = await this.#deliver(alert, spec);
		this.#event({ orgId: row.org_id, ruleId: row.id, kind: 'notification', severity: 'info', title: alert.title, detail: 'Test notification.', delivery });
		return delivery;
	}

	#prune(now: number): void {
		if (now - this.#lastPrune < 3_600_000) return;
		this.#lastPrune = now;
		this.ctx.sqlite.run('DELETE FROM alert_events WHERE at < ?', [now - EVENT_RETENTION_MS]);
		this.ctx.sqlite.run('DELETE FROM alert_silences WHERE ends_at < ?', [now - SILENCE_RETENTION_MS]);
		this.ctx.sqlite.run('DELETE FROM alert_instances WHERE rule_id NOT IN (SELECT id FROM alert_rules)');
	}
}

async function withTimeout(promise: Promise<unknown>): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out after ${NOTIFY_TIMEOUT_MS / 1000}s`)), NOTIFY_TIMEOUT_MS);
			}),
		]);
		return 'ok';
	} catch (error) {
		return ((error as Error)?.message ?? String(error)).slice(0, 300);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** `host=shop.example.com, database_id=db_1 (orders)`. */
export function labelText(labels: Record<string, string>, names: Record<string, string> = {}): string {
	return Object.entries(labels)
		.map(([label, value]) => {
			const name = names[label];
			if (name) return name;
			return label === 'host' || label === 'path' || label === 'referrer' ? value || '(empty)' : `${label}=${value}`;
		})
		.join(', ');
}

function conditionText(spec: Pick<AlertRuleSpec, 'condition'>, unit: string): string {
	return `alert when ${alertOperatorSymbols[spec.condition.op]} ${formatAlertValue(spec.condition.threshold, unit)}`;
}
