import {
	dashboardSpecSchema,
	dashboardTemplates,
	dashboardVariableSchema,
	panelDraftSchema,
	panelQuerySchema,
	panelsFromDrafts,
	type DashboardPanel,
	type DashboardTemplateId,
	type DashboardVariable,
	type PanelDraft,
	type DashboardCreateInput,
	type DashboardSpec,
	type DashboardSummary,
	type DashboardUpdateInput,
	type DashboardView,
	type ObservabilityDataset,
	type ObservabilitySchema,
	type PanelQuery,
	type Principal,
	type QueryColumn,
	type QueryResult,
	type QueryVariables,
} from '@yoal/contracts';
import { ClickHouseAbortedError, ClickHouseError, ClickHouseUnavailableError, type ClickHouseCompactResult } from './clickhouse.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { DATASETS, compileBuilder, datasetCatalog, expandSqlMacros } from './observability-query.ts';
import { TELEMETRY_NOT_INSTALLED } from './telemetry.ts';
import { newId, parseJson } from './util.ts';

/**
 * Observability dashboards (D101): saved dashboards and the query endpoint behind them.
 *
 * Builder queries are compiled by the control plane and always scoped to what the caller can
 * see (projects for traffic, databases, storage instances). SQL queries reach every org's rows,
 * so they run as ClickHouse's read-only user and only for platform admins.
 */

const MAX_RANGE_MS = 400 * 86_400_000;
const ROW_CAP = 20_000;

interface DashboardRow {
	id: string;
	org_id: string;
	title: string;
	description: string;
	tags_json: string;
	spec_json: string;
	version: number;
	created_by: string | null;
	updated_by: string | null;
	created_at: number;
	updated_at: number;
	created_by_name: string | null;
}

export interface ObservabilityQueryInput {
	query: PanelQuery;
	range: { from: string; to: string };
	maxDataPoints: number;
	variables: QueryVariables;
}

function requireMetrics(principal: Principal): void {
	if (!principal.permissions.has('metrics:read')) throw new CoreError('forbidden', 'Missing permission metrics:read', 403);
}

function parseRange(range: { from: string; to: string }): { fromMs: number; toMs: number } {
	const fromMs = Date.parse(range.from);
	const toMs = Date.parse(range.to);
	if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new ValidationError('range.from and range.to must be ISO timestamps.');
	if (toMs < fromMs) throw new ValidationError('range.to is before range.from.');
	if (toMs - fromMs > MAX_RANGE_MS) throw new ValidationError('Ranges are limited to 400 days.');
	return { fromMs, toMs };
}

function baseType(type: string): string {
	let current = type;
	for (;;) {
		const match = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(current);
		if (!match) return current;
		current = match[1]!;
	}
}

function columnKind(type: string): QueryColumn['kind'] {
	const base = baseType(type);
	if (/^(DateTime|DateTime64|Date|Date32)\b/.test(base)) return 'time';
	if (/^(U?Int\d+|Float\d+|Decimal|Bool)/.test(base)) return 'number';
	if (/^(String|FixedString|Enum|UUID|IPv4|IPv6)/.test(base)) return 'string';
	return 'other';
}

/** Normalise a compact result: time columns to epoch ms, numbers to JS numbers. */
export function toQueryResult(
	raw: ClickHouseCompactResult,
	extra: { sql: string; intervalSeconds: number; resolution: '1m' | '1h' | null; notice?: string },
): QueryResult {
	const columns: QueryColumn[] = raw.meta.map((meta) => ({ name: meta.name, type: meta.type, kind: columnKind(meta.type) }));
	const rows = raw.data.map((row) =>
		row.map((value, index) => {
			const column = columns[index]!;
			if (value === null || value === undefined) return null;
			if (column.kind === 'time') {
				if (typeof value === 'number') return Math.round(value * 1000);
				const text = String(value);
				const numeric = Number(text);
				if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(text)) return Math.round(numeric * 1000);
				const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : `${text.replace(' ', 'T')}Z`);
				return Number.isFinite(parsed) ? parsed : text;
			}
			if (column.kind === 'number') {
				if (typeof value === 'boolean') return value ? 1 : 0;
				const numeric = typeof value === 'number' ? value : Number(value);
				return Number.isFinite(numeric) ? numeric : null;
			}
			if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
			return JSON.stringify(value);
		}),
	);
	return {
		columns,
		rows,
		sql: extra.sql.trim(),
		intervalSeconds: extra.intervalSeconds,
		resolution: extra.resolution,
		stats: {
			elapsedMs: Math.round((raw.statistics?.elapsed ?? 0) * 1000),
			rowsRead: raw.statistics?.rows_read ?? 0,
			bytesRead: raw.statistics?.bytes_read ?? 0,
		},
		truncated: rows.length >= ROW_CAP,
		...(extra.notice ? { notice: extra.notice } : {}),
	};
}

function queryUsesSql(query: PanelQuery | undefined): boolean {
	return query?.mode === 'sql';
}

function specUsesSql(spec: DashboardSpec): boolean {
	return spec.panels.some((panel) => queryUsesSql(panel.query)) || spec.variables.some((variable) => queryUsesSql(variable.query));
}

export class ObservabilityService {
	constructor(private readonly ctx: CoreContext) {}

	/** Platform roles may run SQL: the reader sees every org's telemetry. */
	canUseSql(principal: Principal): boolean {
		return this.ctx.platformIam.canView(principal) && principal.kind !== 'system' && principal.permissions.has('metrics:read');
	}

	/** Ids (and display names) the caller can see, per scope column. */
	#visible(principal: Principal): ObservabilitySchema['names'] {
		const attempt = <T>(read: () => T[]): T[] => {
			try {
				return read();
			} catch {
				return [];
			}
		};
		const project = Object.fromEntries(
			attempt(() => this.ctx.projects.list(principal, { includeDeleted: true })).map((item) => [item.id, item.name]),
		);
		const database = Object.fromEntries(
			attempt(() => this.ctx.databases.list(principal, { includeDeleted: true })).map((item) => [item.id, item.name]),
		);
		const storage = Object.fromEntries(
			attempt(() => this.ctx.storage.list(principal, { includeDeleted: true })).map((item) => [item.id, item.name]),
		);
		const broker = Object.fromEntries(
			attempt(() => this.ctx.brokers.list(principal, { includeDeleted: true })).map((item) => [item.id, item.name]),
		);
		return { project, database, storage, broker };
	}

	async schema(principal: Principal): Promise<ObservabilitySchema> {
		requireMetrics(principal);
		const telemetry = this.ctx.telemetry;
		const available = telemetry ? await telemetry.ready() : false;
		const canUseSql = this.canUseSql(principal);
		const tables = available && canUseSql && telemetry ? await telemetry.tables() : [];
		return {
			installed: telemetry?.installed ?? false,
			available,
			error: available ? null : (telemetry?.error?.message ?? TELEMETRY_NOT_INSTALLED),
			canUseSql,
			datasets: datasetCatalog(),
			tables: tables.map(({ name, engine, rows, bytes, columns }) => ({ name, engine, rows, bytes, columns })),
			names: this.#visible(principal),
			retention: telemetry?.retention ?? { minuteHours: 48, hourDays: 90 },
		};
	}

	async query(principal: Principal, input: ObservabilityQueryInput, signal?: AbortSignal): Promise<QueryResult> {
		requireMetrics(principal);
		const telemetry = this.ctx.telemetry;
		if (!telemetry || !(await telemetry.ready()))
			throw new CoreError('telemetry_unavailable', telemetry?.error?.message ?? TELEMETRY_NOT_INSTALLED, 503);
		const { fromMs, toMs } = parseRange(input.range);

		try {
			if (input.query.mode === 'builder') {
				const spec = input.query.builder;
				const names = this.#visible(principal);
				const scopeColumn = DATASETS[spec.dataset as ObservabilityDataset].scope;
				const scopeNames = {
					project_id: names.project,
					database_id: names.database,
					storage_id: names.storage,
					broker_id: names.broker,
				}[scopeColumn];
				const scope = Object.keys(scopeNames);
				const compiled = compileBuilder(spec, {
					database: telemetry.database,
					fromMs,
					toMs,
					maxDataPoints: input.maxDataPoints,
					variables: input.variables,
					scope,
					minuteRetentionHours: telemetry.retention.minuteHours,
					nowMs: this.ctx.now(),
				});
				const raw = await telemetry.runQuery(compiled.sql, {
					params: compiled.params,
					asReader: false,
					settings: { date_time_output_format: 'unix_timestamp' },
					signal,
				});
				return toQueryResult(raw, compiled);
			}

			if (!this.canUseSql(principal))
				throw new CoreError('forbidden', 'SQL queries read every org’s telemetry, so only platform admins can run them. Use the query builder.', 403);
			const expanded = expandSqlMacros(input.query.sql, {
				fromMs,
				toMs,
				maxDataPoints: input.maxDataPoints,
				variables: input.variables,
			});
			const raw = await telemetry.runQuery(expanded.sql, {
				asReader: true,
				settings: { date_time_output_format: 'unix_timestamp' },
				signal,
			});
			return toQueryResult(raw, { sql: expanded.sql, intervalSeconds: expanded.intervalSeconds, resolution: null });
		} catch (error) {
			if (error instanceof ClickHouseAbortedError || (error as Error)?.name === 'AbortError')
				throw new CoreError('cancelled', 'The query was cancelled.', 499);
			if (error instanceof ClickHouseUnavailableError) throw new CoreError('telemetry_unavailable', error.message, 503);
			if (error instanceof ClickHouseError) {
				if (error.status === 401 || error.status === 403 || error.code === 516)
					throw new CoreError('telemetry_auth', `ClickHouse refused the control plane's credentials: ${error.message}`, 502);
				throw new CoreError('query_failed', error.message, 400);
			}
			throw error;
		}
	}

	// --- dashboards -----------------------------------------------------------------------------

	#rows(principal: Principal, where = '', ...args: Array<string | number>): DashboardRow[] {
		const rows = this.ctx.sqlite
			.query<Omit<DashboardRow, 'created_by_name'>, Array<string | number>>(
				`SELECT * FROM observability_dashboards WHERE org_id = ? ${where} ORDER BY updated_at DESC`,
			)
			.all(principal.orgId, ...args);
		const names = this.#userNames(rows.map((row) => row.created_by).filter((id): id is string => id !== null));
		return rows.map((row) => ({ ...row, created_by_name: row.created_by ? (names.get(row.created_by) ?? null) : null }));
	}

	/** Author names from Better Auth's `user` table (absent in core-only databases). */
	#userNames(ids: string[]): Map<string, string> {
		const unique = [...new Set(ids)];
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

	#require(principal: Principal, id: string): DashboardRow {
		const row = this.#rows(principal, 'AND id = ?', id)[0];
		if (!row) throw new NotFoundError('Dashboard');
		return row;
	}

	#canEdit(principal: Principal, row: Pick<DashboardRow, 'created_by'>): boolean {
		return (
			row.created_by === principal.userId ||
			this.ctx.iam.can(principal, 'dashboard:update', { type: 'org' })
		);
	}

	#summary(principal: Principal, row: DashboardRow, spec: DashboardSpec): DashboardSummary {
		return {
			id: row.id,
			title: row.title,
			description: row.description,
			tags: parseJson<string[]>(row.tags_json, []),
			panelCount: spec.panels.length,
			createdBy: row.created_by,
			createdByName: row.created_by_name,
			createdAt: new Date(row.created_at).toISOString(),
			updatedAt: new Date(row.updated_at).toISOString(),
			version: row.version,
			canEdit: this.#canEdit(principal, row),
			usesSql: specUsesSql(spec),
		};
	}

	#spec(row: DashboardRow): DashboardSpec {
		const parsed = dashboardSpecSchema.safeParse(parseJson<unknown>(row.spec_json, {}));
		return parsed.success ? parsed.data : dashboardSpecSchema.parse({});
	}

	list(principal: Principal): DashboardSummary[] {
		requireMetrics(principal);
		return this.#rows(principal).map((row) => this.#summary(principal, row, this.#spec(row)));
	}

	get(principal: Principal, id: string): DashboardView {
		requireMetrics(principal);
		const row = this.#require(principal, id);
		const spec = this.#spec(row);
		return { ...this.#summary(principal, row, spec), spec };
	}

	/** `input` is already parsed by `dashboardCreateSchema` (defaults applied). */
	create(principal: Principal, input: Required<Pick<DashboardCreateInput, 'title'>> & { description: string; tags: string[]; spec: DashboardSpec }): DashboardView {
		requireMetrics(principal);
		this.#guardSql(principal, input.spec);
		const id = newId('dsh_');
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO observability_dashboards (id, org_id, title, description, tags_json, spec_json, version, created_by, updated_by, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
			[id, principal.orgId, input.title, input.description, JSON.stringify(input.tags), JSON.stringify(input.spec), principal.userId, principal.userId, now, now],
		);
		this.ctx.audit.record({ principal, action: 'dashboard.create', resource: 'dashboard', resourceId: id, args: { title: input.title }, result: 'ok' });
		return this.get(principal, id);
	}

	update(principal: Principal, id: string, input: Omit<DashboardUpdateInput, 'spec'> & { spec?: DashboardSpec }): DashboardView {
		requireMetrics(principal);
		const row = this.#require(principal, id);
		if (!this.#canEdit(principal, row)) throw new CoreError('forbidden', 'Only the dashboard’s author or an org owner/admin can change it.', 403);
		if (input.version !== row.version)
			throw new ConflictError(`This dashboard was saved by someone else (version ${row.version}; you edited version ${input.version}). Reload to see their changes.`);
		if (input.spec) this.#guardSql(principal, input.spec, this.#spec(row));
		const now = this.ctx.now();
		const result = this.ctx.sqlite.run(
			`UPDATE observability_dashboards SET title = ?, description = ?, tags_json = ?, spec_json = ?, version = version + 1, updated_by = ?, updated_at = ?
			WHERE id = ? AND org_id = ? AND version = ?`,
			[
				input.title ?? row.title,
				input.description ?? row.description,
				input.tags ? JSON.stringify(input.tags) : row.tags_json,
				input.spec ? JSON.stringify(input.spec) : row.spec_json,
				principal.userId,
				now,
				id,
				principal.orgId,
				row.version,
			],
		);
		if (result.changes === 0) throw new ConflictError('This dashboard was saved by someone else at the same time. Reload to see their changes.');
		this.ctx.audit.record({ principal, action: 'dashboard.update', resource: 'dashboard', resourceId: id, args: { title: input.title ?? row.title }, result: 'ok' });
		return this.get(principal, id);
	}

	// --- agent helpers (MCP and the dashboard assistant) -----------------------------------------

	/** Dashboard page URL for links in tool results. */
	url(id: string): string {
		return `${this.ctx.config.platformOrigin.replace(/\/$/, '')}/dashboards/${id}`;
	}

	/** Resolve a dashboard by id, or by title (case-insensitive) when the title is unique. */
	resolve(principal: Principal, ref: string): DashboardView {
		requireMetrics(principal);
		const byId = this.#rows(principal, 'AND id = ?', ref)[0];
		if (byId) return this.get(principal, byId.id);
		const matches = this.#rows(principal).filter((row) => row.title.toLowerCase() === ref.trim().toLowerCase());
		if (matches.length === 1) return this.get(principal, matches[0]!.id);
		if (matches.length > 1)
			throw new ValidationError(`${matches.length} dashboards are titled "${ref}"; pass one of their ids: ${matches.map((row) => row.id).join(', ')}.`);
		throw new NotFoundError('Dashboard');
	}

	/**
	 * Check a query without running it: builder specs must compile against the catalog, SQL needs a
	 * platform admin. Throws ValidationError/CoreError with a message an agent can act on.
	 */
	validateQuery(principal: Principal, query: PanelQuery, where = 'query'): void {
		if (query.mode === 'sql') {
			if (!this.canUseSql(principal))
				throw new CoreError('forbidden', `${where}: SQL queries are platform-admin only. Use a builder query (see describe_telemetry).`, 403);
			return;
		}
		try {
			compileBuilder(query.builder, {
				database: 'yoal',
				fromMs: this.ctx.now() - 3_600_000,
				toMs: this.ctx.now(),
				maxDataPoints: 100,
				variables: {},
				scope: [],
				minuteRetentionHours: 48,
				nowMs: this.ctx.now(),
			});
		} catch (error) {
			throw new ValidationError(`${where}: ${(error as Error).message}`);
		}
	}

	#validateDrafts(principal: Principal, drafts: ReadonlyArray<ReturnType<typeof panelDraftSchema.parse>>): void {
		drafts.forEach((draft, index) => {
			if (draft.query) this.validateQuery(principal, draft.query, `panel ${index + 1} ("${draft.title || draft.viz}")`);
		});
	}

	/**
	 * Create a dashboard from a starter template and/or panel drafts (laid out automatically). The
	 * easy path for agents: say what to show, not where.
	 */
	createFromDrafts(
		principal: Principal,
		input: {
			title?: string;
			description?: string;
			tags?: string[];
			template?: DashboardTemplateId;
			panels?: PanelDraft[];
			variables?: Array<Record<string, unknown>>;
			time?: { from: string; to: string };
			refresh?: string | null;
		},
	): DashboardView {
		requireMetrics(principal);
		const template = input.template ? dashboardTemplates[input.template] : undefined;
		const drafts = [...(template?.panels ?? []), ...(input.panels ?? [])].map((draft) => panelDraftSchema.parse(draft));
		this.#validateDrafts(principal, drafts);
		const variables = [...(template?.variables ?? []), ...(input.variables ?? [])].map((variable) => dashboardVariableSchema.parse(variable));
		for (const variable of variables) if (variable.query) this.validateQuery(principal, variable.query, `variable $${variable.name}`);
		const panels = panelsFromDrafts([], drafts, () => newId('p_').slice(0, 14));
		const title = input.title?.trim() || template?.title;
		if (!title) throw new ValidationError('Give the dashboard a title (or a template).');
		const spec = dashboardSpecSchema.parse({
			time: input.time ?? template?.time,
			refresh: input.refresh ?? null,
			variables,
			panels,
		});
		return this.create(principal, {
			title,
			description: input.description ?? template?.description ?? '',
			tags: input.tags ?? template?.tags ?? [],
			spec,
		});
	}

	/** Read-modify-write a dashboard spec, retrying once if someone saved in between. */
	#editSpec(principal: Principal, ref: string, change: (spec: DashboardSpec) => DashboardSpec): DashboardView {
		for (let attempt = 0; ; attempt++) {
			const current = this.resolve(principal, ref);
			if (!current.canEdit) throw new CoreError('forbidden', 'Only the dashboard’s author or an org owner/admin can change it.', 403);
			const spec = dashboardSpecSchema.parse(change(structuredClone(current.spec)));
			try {
				return this.update(principal, current.id, { version: current.version, spec });
			} catch (error) {
				if (!(error instanceof ConflictError) || attempt > 0) throw error;
			}
		}
	}

	addPanels(principal: Principal, ref: string, drafts: PanelDraft[]): { dashboard: DashboardView; added: DashboardPanel[] } {
		requireMetrics(principal);
		const parsed = drafts.map((draft) => panelDraftSchema.parse(draft));
		if (parsed.length === 0) throw new ValidationError('Pass at least one panel.');
		this.#validateDrafts(principal, parsed);
		let added: DashboardPanel[] = [];
		const dashboard = this.#editSpec(principal, ref, (spec) => {
			added = panelsFromDrafts(spec.panels, parsed, () => newId('p_').slice(0, 14));
			return { ...spec, panels: [...spec.panels, ...added] };
		});
		return { dashboard, added };
	}

	#findPanel(spec: DashboardSpec, ref: string): number {
		const byId = spec.panels.findIndex((panel) => panel.id === ref);
		if (byId >= 0) return byId;
		const matches = spec.panels.flatMap((panel, index) => (panel.title.toLowerCase() === ref.trim().toLowerCase() ? [index] : []));
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1)
			throw new ValidationError(`${matches.length} panels are titled "${ref}"; pass a panel id: ${matches.map((index) => spec.panels[index]!.id).join(', ')}.`);
		throw new NotFoundError(`Panel "${ref}"`);
	}

	/** Change one panel; only the fields given change. A new size or height re-flows nothing else. */
	updatePanel(
		principal: Principal,
		ref: string,
		panelRef: string,
		patch: Partial<Omit<PanelDraft, 'size'>> & { size?: PanelDraft['size'] },
	): DashboardView {
		requireMetrics(principal);
		const query = patch.query ? panelQuerySchema.parse(patch.query) : undefined;
		if (query) this.validateQuery(principal, query, `panel "${panelRef}"`);
		return this.#editSpec(principal, ref, (spec) => {
			const index = this.#findPanel(spec, panelRef);
			const panel = spec.panels[index]!;
			const width = patch.size ? { quarter: 6, third: 8, half: 12, 'two-thirds': 16, full: 24 }[patch.size] : panel.gridPos.w;
			spec.panels[index] = {
				...panel,
				title: patch.title ?? panel.title,
				description: patch.description ?? panel.description,
				viz: patch.viz ?? panel.viz,
				...(query ? { query } : {}),
				gridPos: { ...panel.gridPos, w: width, x: Math.min(panel.gridPos.x, 24 - width), h: patch.height ?? panel.gridPos.h },
				options: {
					...panel.options,
					...(patch.options ?? {}),
					...(patch.unit ? { unit: patch.unit } : {}),
					...(patch.text !== undefined ? { text: patch.text } : {}),
				},
			};
			return spec;
		});
	}

	removePanels(principal: Principal, ref: string, panelRefs: string[]): { dashboard: DashboardView; removed: string[] } {
		requireMetrics(principal);
		let removed: string[] = [];
		const dashboard = this.#editSpec(principal, ref, (spec) => {
			const indexes = new Set(panelRefs.map((panelRef) => this.#findPanel(spec, panelRef)));
			removed = [...indexes].map((index) => spec.panels[index]!.title || spec.panels[index]!.id);
			return { ...spec, panels: spec.panels.filter((_, index) => !indexes.has(index)) };
		});
		return { dashboard, removed };
	}

	/** Dashboard-level settings: title, description, tags, default time range, refresh, variables. */
	updateSettings(
		principal: Principal,
		ref: string,
		patch: {
			title?: string;
			description?: string;
			tags?: string[];
			time?: { from: string; to: string };
			refresh?: string | null;
			variables?: Array<Record<string, unknown>>;
		},
	): DashboardView {
		requireMetrics(principal);
		const variables = patch.variables?.map((variable) => dashboardVariableSchema.parse(variable));
		for (const variable of variables ?? []) if (variable.query) this.validateQuery(principal, variable.query, `variable $${variable.name}`);
		for (let attempt = 0; ; attempt++) {
			const current = this.resolve(principal, ref);
			const spec: DashboardSpec = {
				...current.spec,
				...(patch.time ? { time: patch.time } : {}),
				...(patch.refresh !== undefined ? { refresh: patch.refresh } : {}),
				...(variables ? { variables } : {}),
			};
			try {
				return this.update(principal, current.id, {
					version: current.version,
					title: patch.title,
					description: patch.description,
					tags: patch.tags,
					spec,
				});
			} catch (error) {
				if (!(error instanceof ConflictError) || attempt > 0) throw error;
			}
		}
	}

	/**
	 * Run each panel's query once over a recent window so an agent can tell the user which panels
	 * already have data. Never throws: a failing panel reports its error.
	 */
	async preview(
		principal: Principal,
		panels: ReadonlyArray<Pick<DashboardPanel, 'id' | 'title' | 'query'>>,
		hours = 24,
	): Promise<Array<{ id: string; title: string; rows: number; columns: string[]; error?: string }> | null> {
		const telemetry = this.ctx.telemetry;
		if (!telemetry || !(await telemetry.ready())) return null;
		const to = new Date(this.ctx.now()).toISOString();
		const from = new Date(this.ctx.now() - hours * 3_600_000).toISOString();
		const results = [];
		for (const panel of panels) {
			if (!panel.query) continue;
			try {
				const result = await this.query(principal, { query: panel.query, range: { from, to }, maxDataPoints: 60, variables: {} });
				results.push({ id: panel.id, title: panel.title, rows: result.rows.length, columns: result.columns.map((column) => column.name) });
			} catch (error) {
				results.push({ id: panel.id, title: panel.title, rows: 0, columns: [], error: (error as Error).message });
			}
		}
		return results;
	}

	delete(principal: Principal, id: string): void {
		requireMetrics(principal);
		const row = this.#require(principal, id);
		if (!this.#canEdit(principal, row)) throw new CoreError('forbidden', 'Only the dashboard’s author or an org owner/admin can delete it.', 403);
		this.ctx.sqlite.run('DELETE FROM observability_dashboards WHERE id = ? AND org_id = ?', [id, principal.orgId]);
		this.ctx.audit.record({ principal, action: 'dashboard.delete', resource: 'dashboard', resourceId: id, args: { title: row.title }, result: 'ok' });
	}

	/**
	 * Only SQL users may add or change SQL. Others may still save a dashboard an admin wrote, as
	 * long as every SQL query in it is one that was already there.
	 */
	#guardSql(principal: Principal, spec: DashboardSpec, previous?: DashboardSpec): void {
		if (this.canUseSql(principal)) return;
		const existing = new Set<string>();
		for (const item of [...(previous?.panels ?? []), ...(previous?.variables ?? [])])
			if (item.query?.mode === 'sql') existing.add(item.query.sql);
		for (const item of [...spec.panels, ...spec.variables])
			if (item.query?.mode === 'sql' && !existing.has(item.query.sql))
				throw new CoreError('forbidden', 'Only platform admins can add or edit SQL queries. Use the query builder.', 403);
	}
}
