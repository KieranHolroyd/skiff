import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	alertRuleTemplates,
	builderSpecSchema,
	dashboardCreateSchema,
	dashboardTemplates,
	observabilityQueryRequestSchema,
	type MetricBucket,
	type ObservabilityQueryRequest,
} from '@skiff/contracts';
import { createDb } from '@skiff/db';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { autoInterval, compileBuilder, expandSqlMacros, type CompileContext } from './observability-query.ts';
import { buildPrincipal } from './orgs.ts';
import { disposeTelemetryStore, hasClickHouse, testTelemetryStore } from './test-clickhouse.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-06T12:00:00Z');

const ctx = (overrides: Partial<CompileContext> = {}): CompileContext => ({
	database: 'skiff',
	fromMs: NOW - HOUR,
	toMs: NOW,
	maxDataPoints: 60,
	variables: {},
	scope: ['prj_a'],
	minuteRetentionHours: 48,
	nowMs: NOW,
	...overrides,
});

describe('builder compilation', () => {
	test('every starter dashboard and alert template compiles, brokers included (D123)', () => {
		const specs = [
			...Object.values(dashboardTemplates).flatMap((template) =>
				template.panels.flatMap((panel) => (panel.query?.mode === 'builder' ? [panel.query.builder] : [])),
			),
			...alertRuleTemplates.flatMap((template) => (template.rule.query.mode === 'builder' ? [template.rule.query.builder] : [])),
		];
		expect(specs.some((spec) => spec.dataset === 'brokers')).toBe(true);
		for (const spec of specs) {
			const compiled = compileBuilder(builderSpecSchema.parse(spec), ctx({ variables: { database: '$__all' } }));
			expect(compiled.sql).toContain('FROM');
		}
		const broker = compileBuilder(
			builderSpecSchema.parse({ dataset: 'brokers', metrics: [{ field: 'store_utilization' }], groupBy: ['broker_id'] }),
			ctx({ scope: ['mq_a'] }),
		);
		expect(broker.sql).toContain('broker_metrics_1m');
		expect(broker.sql).toContain('max(store_bytes) / max(store_limit_bytes)');
	});

	test('values become parameters and the scope is always applied', () => {
		const spec = builderSpecSchema.parse({
			dataset: 'traffic',
			metrics: [{ field: 'requests' }, { field: 'error_rate' }],
			groupBy: ['host'],
			filters: [{ field: 'host', op: 'eq', value: "x'; DROP TABLE traffic_1m --" }],
		});
		const compiled = compileBuilder(spec, ctx());
		expect(compiled.sql).not.toContain('DROP');
		expect(compiled.params.f0).toBe("x'; DROP TABLE traffic_1m --");
		expect(compiled.sql).toContain('project_id IN {scope:Array(String)}');
		expect(compiled.params.scope).toEqual(['prj_a']);
		expect(compiled.resolution).toBe('1m');
		expect(compiled.intervalSeconds).toBe(60);
		expect(compiled.sql).toContain('__m0 AS requests');
		expect(compiled.sql).toContain('__m1 AS error_rate');
	});

	test('an empty scope matches nothing; unknown names are refused', () => {
		const spec = builderSpecSchema.parse({ dataset: 'traffic', metrics: [{ field: 'requests' }] });
		expect(compileBuilder(spec, ctx({ scope: [] })).sql).toContain('AND 0');
		expect(() => compileBuilder({ ...spec, metrics: [{ field: 'nope', agg: 'sum' }] }, ctx())).toThrow('not a measure');
		expect(() => compileBuilder({ ...spec, groupBy: ['requests'] }, ctx())).toThrow('not a dimension');
	});

	test('old ranges read hourly data and say so', () => {
		const spec = builderSpecSchema.parse({ dataset: 'traffic', metrics: [{ field: 'requests' }], interval: '5m' });
		const compiled = compileBuilder(spec, ctx({ fromMs: NOW - 7 * 24 * HOUR }));
		expect(compiled.resolution).toBe('1h');
		expect(compiled.intervalSeconds).toBe(3_600);
		expect(compiled.sql).toContain('skiff.traffic_hourly');
		expect(compiled.notice).toContain('hourly');
	});

	test('variables resolve; $__all drops the filter', () => {
		const spec = builderSpecSchema.parse({
			dataset: 'traffic',
			metrics: [{ field: 'requests' }],
			filters: [{ field: 'host', op: 'eq', value: '$host' }],
		});
		const many = compileBuilder(spec, ctx({ variables: { host: ['a.test', 'b.test'] } }));
		expect(many.sql).toContain('IN {f0:Array(String)}');
		expect(many.params.f0).toEqual(['a.test', 'b.test']);
		const all = compileBuilder(spec, ctx({ variables: { host: ['$__all'] } }));
		expect(all.params.f0).toBeUndefined();
	});

	test('auto intervals snap to nice steps', () => {
		expect(autoInterval(3_600, 60, 60)).toBe(60);
		expect(autoInterval(86_400, 500, 60)).toBe(300);
		expect(autoInterval(30 * 86_400, 500, 3_600)).toBe(7_200);
	});

	test('SQL macros and variables expand', () => {
		const out = expandSqlMacros('SELECT $__timeInterval(bucket) t FROM traffic_1m WHERE $__timeFilter(bucket) AND host IN $hosts AND x = ${one}', {
			fromMs: NOW - HOUR,
			toMs: NOW,
			maxDataPoints: 60,
			variables: { hosts: ['a', "b'c"], one: 'v' },
		});
		expect(out.sql).toContain("toStartOfInterval(bucket, INTERVAL 60 SECOND)");
		expect(out.sql).toContain("bucket >= toDateTime('2026-11-06 11:00:00', 'UTC')");
		expect(out.sql).toContain("host IN ('a', 'b\\'c')");
		expect(out.sql).toContain("x = 'v'");
	});
});

describe.skipIf(!hasClickHouse)('observability service', () => {
	const dir = mkdtempSync(join(tmpdir(), 'skiff-observability-'));
	const opened = createDb({ path: ':memory:' });
	const clock = NOW;
	const core: Core = createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version: '0.1.0',
		config: {
			dataDir: dir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.1.0',
			now: () => clock,
		},
	});
	const telemetry = testTelemetryStore({ now: () => clock });
	const admin = buildPrincipal({ kind: 'user', userId: 'user_admin', orgId: 'org_1', role: 'owner', platformAdmin: true });
	const member = buildPrincipal({ kind: 'user', userId: 'user_member', orgId: 'org_1', role: 'deployer' });
	const viewer = buildPrincipal({ kind: 'user', userId: 'user_viewer', orgId: 'org_1', role: 'viewer' });
	const outsider = buildPrincipal({ kind: 'user', userId: 'user_other', orgId: 'org_2', role: 'owner' });
	let mine = '';
	let theirs = '';

	const bucket = (host: string, projectId: string, at: number, requests: number, errors = 0): MetricBucket => ({
		host,
		projectId,
		bucket: new Date(at).toISOString(),
		requests,
		status2xx: requests - errors,
		status3xx: 0,
		status4xx: 0,
		status5xx: errors,
		bytes: requests * 100,
		durationP50Ms: 5,
		durationP95Ms: 50,
		topPaths: [{ path: '/', count: requests }],
		topReferrers: [],
	});

	const run = (principal = admin, request: ObservabilityQueryRequest) =>
		core.observability.query(principal, observabilityQueryRequestSchema.parse(request));
	const range = { from: new Date(NOW - HOUR).toISOString(), to: new Date(NOW).toISOString() };

	beforeAll(async () => {
		core.ctx.telemetry = telemetry;
		await telemetry.open();
		const create = async (principal: typeof admin, slug: string) =>
			(
				await core.projects.create(principal, {
					name: slug,
					slug,
					runtime: 'static',
					placement: 'edge',
					productionAccess: 'public',
					previewAccess: 'platform',
				})
			).id;
		mine = await create(admin, 'mine');
		theirs = await create(outsider, 'theirs');
		await telemetry.ingest([
			bucket('mine.sites.test', mine, NOW - 10 * MINUTE, 10, 1),
			bucket('mine.sites.test', mine, NOW - 9 * MINUTE, 20),
			bucket('theirs.sites.test', theirs, NOW - 10 * MINUTE, 500),
		]);
	});

	afterAll(async () => {
		await disposeTelemetryStore(telemetry);
		opened.sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test('builder queries only see the caller’s projects', async () => {
		const result = await run(member, {
			query: { mode: 'builder', builder: { dataset: 'traffic', metrics: [{ field: 'requests' }, { field: 'error_rate' }], groupBy: ['host'], timeSeries: false } },
			range,
		});
		expect(result.columns.map((column) => column.name)).toEqual(['host', 'requests', 'error_rate']);
		expect(result.rows).toEqual([['mine.sites.test', 30, 1 / 30]]);

		const series = await run(member, {
			query: { mode: 'builder', builder: { dataset: 'traffic', metrics: [{ field: 'requests', agg: 'rate' }] } },
			range,
		});
		expect(series.columns[0]).toMatchObject({ name: 'time', kind: 'time' });
		expect(series.rows).toEqual([
			[NOW - 10 * MINUTE, 10 / 60],
			[NOW - 9 * MINUTE, 20 / 60],
		]);

		const paths = await run(outsider, {
			query: { mode: 'builder', builder: { dataset: 'traffic_paths', metrics: [{ field: 'hits' }], groupBy: ['path'], timeSeries: false } },
			range,
		});
		expect(paths.rows).toEqual([['/', 500]]);
	});

	test('distinct values for variables', async () => {
		const result = await run(member, {
			query: { mode: 'builder', builder: { dataset: 'traffic', groupBy: ['host'] } },
			range,
		});
		expect(result.rows).toEqual([['mine.sites.test']]);
	});

	test('SQL is for platform admins and reads as the reader', async () => {
		await expect(run(member, { query: { mode: 'sql', sql: 'SELECT 1' }, range })).rejects.toMatchObject({ status: 403 });
		const result = await run(admin, {
			query: { mode: 'sql', sql: 'SELECT host, sum(requests) AS n FROM traffic_1m WHERE $__timeFilter(bucket) GROUP BY host ORDER BY host' },
			range,
		});
		expect(result.rows).toEqual([
			['mine.sites.test', 30],
			['theirs.sites.test', 500],
		]);
		await expect(run(admin, { query: { mode: 'sql', sql: 'SELEC nope' }, range })).rejects.toMatchObject({ status: 400 });
		await expect(run(admin, { query: { mode: 'sql', sql: "INSERT INTO traffic_1m (host, bucket) VALUES ('x', now())" }, range })).rejects.toMatchObject({
			status: 400,
		});
	});

	test('schema lists datasets for everyone and tables for SQL users', async () => {
		const forMember = await core.observability.schema(member);
		expect(forMember.available).toBe(true);
		expect(forMember.canUseSql).toBe(false);
		expect(forMember.tables).toEqual([]);
		expect(forMember.names.project).toEqual({ [mine]: 'mine' });
		const forAdmin = await core.observability.schema(admin);
		expect(forAdmin.canUseSql).toBe(true);
		expect(forAdmin.tables.map((table) => table.name)).toContain('traffic_1m');
	});

	test('dashboards are org-scoped, versioned and guarded', async () => {
		const created = core.observability.create(member, dashboardCreateSchema.parse({ title: 'Mine', tags: ['web'] }));
		expect(created.version).toBe(1);
		expect(created.canEdit).toBe(true);
		expect(core.observability.list(outsider)).toEqual([]);
		expect(() => core.observability.get(outsider, created.id)).toThrow();

		const spec = { ...created.spec, panels: [{ id: 'p1', title: 'SQL', description: '', viz: 'table' as const, gridPos: { x: 0, y: 0, w: 12, h: 8 }, query: { mode: 'sql' as const, sql: 'SELECT 1' }, options: {} }] };
		expect(() => core.observability.update(member, created.id, { version: 1, spec })).toThrow('platform admins');
		const updated = core.observability.update(admin, created.id, { version: 1, spec });
		expect(updated.version).toBe(2);
		expect(updated.usesSql).toBe(true);
		// A member may still save the admin's SQL unchanged (e.g. after moving a panel).
		expect(core.observability.update(member, created.id, { version: 2, title: 'Renamed', spec }).version).toBe(3);
		expect(() => core.observability.update(member, created.id, { version: 2, title: 'Stale' })).toThrow('saved by someone else');

		expect(core.observability.get(viewer, created.id).canEdit).toBe(false);
		expect(() => core.observability.delete(viewer, created.id)).toThrow();
		core.observability.delete(member, created.id);
		expect(core.observability.list(member)).toEqual([]);
	});

	test('agents build dashboards from templates and drafts, laid out automatically', async () => {
		const traffic = core.observability.createFromDrafts(member, { template: 'traffic' });
		expect(traffic.title).toBe('Traffic overview');
		expect(traffic.spec.panels.length).toBeGreaterThan(8);
		expect(traffic.spec.variables.map((variable) => variable.name)).toEqual(['host']);
		// No two panels overlap.
		const cells = new Set<string>();
		for (const { gridPos } of traffic.spec.panels)
			for (let x = gridPos.x; x < gridPos.x + gridPos.w; x++)
				for (let y = gridPos.y; y < gridPos.y + gridPos.h; y++) {
					expect(cells.has(`${x},${y}`)).toBe(false);
					cells.add(`${x},${y}`);
				}

		expect(() =>
			core.observability.createFromDrafts(member, {
				title: 'Bad',
				panels: [{ title: 'Oops', query: { mode: 'builder', builder: { dataset: 'traffic', metrics: [{ field: 'nope' }] } } }],
			}),
		).toThrow('panel 1 ("Oops"): nope is not a measure of traffic');
		expect(() =>
			core.observability.createFromDrafts(member, { title: 'SQL', panels: [{ title: 'Raw', query: { mode: 'sql', sql: 'SELECT 1' } }] }),
		).toThrow('platform-admin only');

		const mine = core.observability.createFromDrafts(member, {
			title: 'My site',
			panels: [{ title: 'Requests', viz: 'stat', unit: 'short', query: { mode: 'builder', builder: { dataset: 'traffic', metrics: [{ field: 'requests' }] } } }],
		});
		const { dashboard, added } = core.observability.addPanels(member, 'my site', [
			{ title: 'Errors', viz: 'timeseries', query: { mode: 'builder', builder: { dataset: 'traffic', metrics: [{ field: 'error_rate' }] } } },
			{ viz: 'text', text: '## Notes', size: 'full' },
		]);
		expect(dashboard.version).toBe(2);
		expect(added.map((panel) => panel.gridPos)).toEqual([
			{ x: 0, y: 5, w: 12, h: 8 },
			{ x: 0, y: 13, w: 24, h: 3 },
		]);
		const updated = core.observability.updatePanel(member, mine.id, 'errors', { title: 'Error rate', unit: 'percentunit', size: 'full' });
		const errors = updated.spec.panels.find((panel) => panel.title === 'Error rate')!;
		expect(errors.options.unit).toBe('percentunit');
		expect(errors.gridPos.w).toBe(24);
		const { removed } = core.observability.removePanels(member, mine.id, ['Requests']);
		expect(removed).toEqual(['Requests']);
		expect(core.observability.resolve(member, 'MY SITE').spec.panels).toHaveLength(2);
		expect(() => core.observability.resolve(outsider, mine.id)).toThrow();

		const preview = await core.observability.preview(member, core.observability.get(member, mine.id).spec.panels);
		expect(preview?.[0]).toMatchObject({ title: 'Error rate', rows: 1, columns: ['time', 'error_rate'] });
		expect(core.observability.url(mine.id)).toBe(`https://control.test/dashboards/${mine.id}`);
	});
});
