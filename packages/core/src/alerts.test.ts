import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertRuleInputSchema, alertRuleTemplate, alertRuleTemplates, type AlertRuleInput, type MetricBucket } from '@skiff/contracts';
import { createDb } from '@skiff/db';
import {
	advanceInstance,
	fingerprintOf,
	formatAlertValue,
	matchesSilence,
	newInstance,
	seriesFromResult,
	type InstanceRecord,
} from './alerts.ts';
import type { AlertMessage, Notifier } from './config.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import { disposeTelemetryStore, hasClickHouse, testTelemetryStore } from './test-clickhouse.ts';

const SECOND = 1_000;
const MINUTE = 60_000;
const T0 = Date.parse('2026-11-06T12:00:00Z');

const timing = (overrides: Partial<{ forSeconds: number; keepFiringSeconds: number; noData: 'ok' | 'nodata' | 'alerting' | 'keep' }> = {}) => ({
	condition: { op: 'gt' as const, threshold: 0.5 },
	forSeconds: 120,
	keepFiringSeconds: 0,
	noData: 'ok' as const,
	...overrides,
});

function run(steps: Array<number | null>, spec = timing(), stepMs = MINUTE): InstanceRecord[] {
	let instance = newInstance('{}', {}, T0);
	return steps.map((value, index) => (instance = advanceInstance(instance, { value }, spec, T0 + index * stepMs)));
}

describe('alert state machine', () => {
	test('pending until the condition has held for `for`, then firing, then resolved', () => {
		const states = run([0.9, 0.9, 0.9, 0.1]).map((instance) => instance.state);
		expect(states).toEqual(['pending', 'pending', 'firing', 'normal']);
	});

	test('for = 0 fires on the first breach', () => {
		expect(run([0.9], timing({ forSeconds: 0 }))[0]!.state).toBe('firing');
	});

	test('a blip shorter than `for` never fires', () => {
		expect(run([0.9, 0.1, 0.9, 0.1]).map((instance) => instance.state)).toEqual(['pending', 'normal', 'pending', 'normal']);
	});

	test('keep-firing holds a firing series through a short recovery', () => {
		const states = run([0.9, 0.1, 0.9, 0.1, 0.1, 0.1], timing({ forSeconds: 0, keepFiringSeconds: 120 })).map((instance) => instance.state);
		expect(states).toEqual(['firing', 'firing', 'firing', 'firing', 'firing', 'normal']);
	});

	test('activeSince survives pending → firing', () => {
		const [first, , third] = run([0.9, 0.9, 0.9]);
		expect(first!.activeSince).toBe(T0);
		expect(third!.activeSince).toBe(T0);
		expect(third!.stateSince).toBe(T0 + 2 * MINUTE);
	});

	test('no data: ok resolves, alerting fires, nodata is its own state, keep holds', () => {
		expect(run([0.9, 0.9, 0.9, null], timing()).at(-1)!.state).toBe('normal');
		expect(run([null, null, null], timing({ noData: 'alerting' })).map((instance) => instance.state)).toEqual(['pending', 'pending', 'firing']);
		expect(run([0.1, null], timing({ noData: 'nodata' })).at(-1)!.state).toBe('nodata');
		expect(run([0.9, 0.9, 0.9, null, null], timing({ noData: 'keep' })).at(-1)!.state).toBe('firing');
	});

	test('acknowledgement clears when the series leaves an alerting state', () => {
		let instance = run([0.9], timing({ forSeconds: 0 }))[0]!;
		instance = { ...instance, acknowledgedBy: 'u', acknowledgedAt: T0 };
		instance = advanceInstance(instance, { value: 0.9 }, timing({ forSeconds: 0 }), T0 + MINUTE);
		expect(instance.acknowledgedBy).toBe('u');
		instance = advanceInstance(instance, { value: 0.1 }, timing({ forSeconds: 0 }), T0 + 2 * MINUTE);
		expect(instance.acknowledgedBy).toBeNull();
	});

	test('every comparison operator', () => {
		const at = (op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq', value: number) =>
			advanceInstance(newInstance('{}', {}, T0), { value }, { ...timing({ forSeconds: 0 }), condition: { op, threshold: 1 } }, T0).state;
		expect([at('gt', 1), at('gte', 1), at('lt', 1), at('lte', 1), at('eq', 1), at('neq', 1)]).toEqual([
			'normal',
			'firing',
			'normal',
			'firing',
			'firing',
			'normal',
		]);
	});
});

describe('alert helpers', () => {
	test('fingerprints ignore label order', () => {
		expect(fingerprintOf({ b: '2', a: '1' })).toBe(fingerprintOf({ a: '1', b: '2' }));
		expect(fingerprintOf({})).toBe('{}');
	});

	test('silences match by rule and every label', () => {
		expect(matchesSilence({ ruleId: null, matchers: [] }, 'r1', { host: 'a' })).toBe(true);
		expect(matchesSilence({ ruleId: 'r2', matchers: [] }, 'r1', {})).toBe(false);
		expect(matchesSilence({ ruleId: 'r1', matchers: [{ label: 'host', value: 'a' }] }, 'r1', { host: 'a' })).toBe(true);
		expect(matchesSilence({ ruleId: 'r1', matchers: [{ label: 'host', value: 'a' }] }, 'r1', { host: 'b' })).toBe(false);
	});

	test('series take string columns as labels and the last number as the value', () => {
		const series = seriesFromResult({
			columns: [
				{ name: 'time', type: 'DateTime', kind: 'time' },
				{ name: 'host', type: 'String', kind: 'string' },
				{ name: 'requests', type: 'UInt64', kind: 'number' },
				{ name: 'error_rate', type: 'Float64', kind: 'number' },
			],
			rows: [
				[1, 'a', 10, 0.1],
				[2, 'a', 10, 0.7],
				[1, 'b', 5, null],
			],
		});
		expect(series).toEqual([
			{ labels: { host: 'a' }, value: 0.7 },
			{ labels: { host: 'b' }, value: null },
		]);
	});

	test('values format by unit', () => {
		expect(formatAlertValue(0.0532, 'percentunit')).toBe('5.3%');
		expect(formatAlertValue(2500, 'ms')).toBe('2.5 s');
		expect(formatAlertValue(1536, 'bytes')).toBe('1.5 KB');
		expect(formatAlertValue(null, 'short')).toBe('no data');
	});

	test('every template is a valid rule', () => {
		for (const template of alertRuleTemplates) expect(alertRuleInputSchema.safeParse(template.rule).success).toBe(true);
	});
});

describe.skipIf(!hasClickHouse)('alert service', () => {
	const dir = mkdtempSync(join(tmpdir(), 'skiff-alerts-'));
	const opened = createDb({ path: ':memory:' });
	let clock = T0;
	const sent: Array<{ via: string; alert: AlertMessage }> = [];
	const notifier = (name: string, fail = false): Notifier => ({
		name,
		async notify(alert) {
			if (fail) throw new Error('boom');
			sent.push({ via: name, alert });
		},
	});
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
			notifiers: [notifier('webhook'), notifier('sms', true)],
			now: () => clock,
		},
	});
	const telemetry = testTelemetryStore({ now: () => clock });
	const owner = buildPrincipal({ kind: 'user', userId: 'user_owner', orgId: 'org_1', role: 'owner' });
	const deployer = buildPrincipal({ kind: 'user', userId: 'user_dep', orgId: 'org_1', role: 'deployer' });
	const viewer = buildPrincipal({ kind: 'user', userId: 'user_viewer', orgId: 'org_1', role: 'viewer' });
	const outsider = buildPrincipal({ kind: 'user', userId: 'user_other', orgId: 'org_2', role: 'owner' });
	const admin = buildPrincipal({ kind: 'user', userId: 'user_admin', orgId: 'org_1', role: 'owner', platformAdmin: true });
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
		topPaths: [],
		topReferrers: [],
	});

	/** One minute of traffic for both hosts; `bad` hosts fail 90% of requests. */
	const minute = async (at: number, bad: string[] = []) => {
		await telemetry.ingest([
			bucket('mine.sites.test', mine, at, 100, bad.includes('mine') ? 90 : 0),
			bucket('other.sites.test', mine, at, 100, bad.includes('other') ? 90 : 0),
			bucket('theirs.sites.test', theirs, at, 100, 100),
		]);
	};
	const tick = async (at: number, bad: string[] = []) => {
		clock = at;
		await minute(at - 30 * SECOND, bad);
		return core.alerts.evaluateDue();
	};
	const siteDown = (): AlertRuleInput => ({ ...alertRuleTemplate('site_down')!.rule, windowSeconds: 60, forSeconds: 60, keepFiringSeconds: 0 });

	beforeAll(async () => {
		core.ctx.telemetry = telemetry;
		await telemetry.open();
		const create = async (principal: typeof owner, slug: string) =>
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
		mine = await create(owner, 'mine');
		theirs = await create(outsider, 'theirs');
	});

	afterAll(async () => {
		await disposeTelemetryStore(telemetry);
		opened.sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test('only owners and admins write rules; deployers may silence; other orgs see nothing', async () => {
		expect(() => core.alerts.createRule(deployer, siteDown())).toThrow('owners and admins');
		expect(() => core.alerts.createRule(owner, { ...siteDown(), query: { mode: 'sql', sql: 'SELECT 1' } })).toThrow('platform admins');
		expect(() =>
			core.alerts.createRule(owner, { ...siteDown(), query: { mode: 'builder', builder: { dataset: 'traffic', metrics: [] , groupBy: ['host'] } } }),
		).toThrow('exactly one metric');
		const rule = core.alerts.createRule(owner, { ...siteDown(), enabled: false });
		expect(core.alerts.listRules(viewer).map((item) => item.id)).toEqual([rule.id]);
		expect(core.alerts.listRules(outsider)).toEqual([]);
		expect(() => core.alerts.getRule(outsider, rule.id)).toThrow('not found');
		expect(core.alerts.canSilence(deployer)).toBe(true);
		expect(core.alerts.canSilence(viewer)).toBe(false);
		// A partial update keeps every field it does not name.
		const renamed = core.alerts.updateRule(owner, rule.id, { version: rule.version, name: 'Renamed' });
		expect(renamed).toMatchObject({ name: 'Renamed', windowSeconds: 60, severity: 'critical', enabled: false, version: 2 });
		expect(() => core.alerts.updateRule(owner, rule.id, { version: 1, name: 'Stale' })).toThrow('saved by someone else');
		core.alerts.deleteRule(owner, rule.id);
	});

	test('a host failing most requests goes pending, fires once, repeats nothing, then resolves', async () => {
		sent.length = 0;
		const rule = core.alerts.createRule(owner, siteDown());

		let report = await tick(T0, ['mine']);
		expect(report.evaluated).toBe(1);
		let view = core.alerts.getRule(viewer, rule.id);
		expect(view.health).toBe('ok');
		// Only this org's hosts are series; `theirs` fails too but belongs to another org.
		expect(view.instances.map((instance) => [instance.labels.host, instance.state])).toEqual([
			['mine.sites.test', 'pending'],
			['other.sites.test', 'normal'],
		]);
		expect(sent).toEqual([]);

		await tick(T0 + MINUTE, ['mine']);
		view = core.alerts.getRule(viewer, rule.id);
		expect(view.state).toBe('firing');
		expect(sent.map((item) => item.via)).toEqual(['webhook']);
		const firing = sent[0]!.alert;
		expect(firing).toMatchObject({ status: 'firing', severity: 'critical', labels: { host: 'mine.sites.test' }, url: `https://control.test/alerts/rules/${rule.id}` });
		expect(firing.title).toBe('Site down (mine.sites.test)');
		expect(firing.detail).toContain('90%');

		// Still down: no repeat inside the repeat interval.
		await tick(T0 + 2 * MINUTE, ['mine']);
		expect(sent).toHaveLength(1);

		const overview = await core.alerts.overview(viewer);
		expect(overview.counts.firing).toBe(1);
		expect(overview.active[0]).toMatchObject({ ruleName: 'Site down', state: 'firing', labels: { host: 'mine.sites.test' } });

		// Recovered.
		await tick(T0 + 3 * MINUTE);
		expect(sent).toHaveLength(2);
		expect(sent[1]!.alert).toMatchObject({ status: 'resolved', severity: 'info' });
		expect(sent[1]!.alert.title).toBe('Resolved: Site down (mine.sites.test)');

		const history = core.alerts.history(viewer, { ruleId: rule.id });
		const notifications = history.filter((event) => event.kind === 'notification');
		expect(notifications).toHaveLength(2);
		// The failing SMS notifier is recorded, not fatal.
		expect(notifications[0]!.delivery).toEqual({ webhook: 'ok', sms: 'boom' });
		expect(history.filter((event) => event.kind === 'state').map((event) => `${event.from}→${event.to}`)).toEqual([
			'firing→normal',
			'pending→firing',
			'normal→pending',
		]);
		core.alerts.deleteRule(owner, rule.id);
	});

	test('several series breaching together send one grouped message, routed to the picked channel', async () => {
		sent.length = 0;
		const rule = core.alerts.createRule(owner, { ...siteDown(), forSeconds: 0, channels: ['webhook'] });
		clock += 10 * MINUTE;
		await tick(clock, ['mine', 'other']);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.alert.title).toBe('Site down (2 series)');
		expect(sent[0]!.alert.detail).toContain('mine.sites.test');
		expect(sent[0]!.alert.detail).toContain('other.sites.test');
		const notification = core.alerts.history(viewer, { ruleId: rule.id, kinds: ['notification'] })[0]!;
		expect(notification.delivery).toEqual({ webhook: 'ok' });
		core.alerts.deleteRule(owner, rule.id);
	});

	test('silences and acknowledgements mute notifications but not state', async () => {
		sent.length = 0;
		const rule = core.alerts.createRule(owner, { ...siteDown(), forSeconds: 0, repeatMinutes: 1 });
		clock += 10 * MINUTE;
		const silence = core.alerts.createSilence(deployer, { ruleId: rule.id, matchers: [{ label: 'host', value: 'mine.sites.test' }], durationMinutes: 5, comment: 'deploying' });
		expect(silence.status).toBe('active');
		await tick(clock, ['mine']);
		let view = core.alerts.getRule(viewer, rule.id);
		expect(view.instances.find((instance) => instance.labels.host === 'mine.sites.test')).toMatchObject({ state: 'firing', silencedBy: silence.id });
		expect(sent).toEqual([]);

		// Silence over: it notifies, because nobody has heard about this firing yet.
		core.alerts.expireSilence(deployer, silence.id);
		clock += MINUTE;
		await tick(clock, ['mine']);
		expect(sent).toHaveLength(1);

		// Repeat after a minute… unless acknowledged.
		clock += MINUTE;
		await tick(clock, ['mine']);
		expect(sent).toHaveLength(2);
		const fingerprint = fingerprintOf({ host: 'mine.sites.test' });
		expect(() => core.alerts.acknowledge(viewer, rule.id, fingerprint)).toThrow();
		view = core.alerts.acknowledge(deployer, rule.id, fingerprint);
		expect(view.instances[0]!.acknowledgedBy).toBe('user_dep');
		clock += MINUTE;
		await tick(clock, ['mine']);
		expect(sent).toHaveLength(2);
		core.alerts.deleteRule(owner, rule.id);
	});

	test('a host that stops reporting fires with noData = alerting; preview evaluates without saving', async () => {
		sent.length = 0;
		const rule = core.alerts.createRule(owner, {
			name: 'Traffic stopped',
			query: { mode: 'builder', builder: { dataset: 'traffic', metrics: [{ field: 'requests', agg: 'sum' }], groupBy: ['host'] } },
			condition: { op: 'lt', threshold: 1 },
			windowSeconds: 60,
			forSeconds: 0,
			noData: 'alerting',
		});
		clock += 10 * MINUTE;
		await tick(clock);
		expect(core.alerts.getRule(viewer, rule.id).state).toBe('normal');

		// A minute with no rows for either host.
		clock += 2 * MINUTE;
		await core.alerts.evaluateDue();
		const view = core.alerts.getRule(viewer, rule.id);
		expect(view.counts.firing).toBe(2);
		expect(sent.map((item) => item.alert.title)).toEqual(['Traffic stopped (2 series)']);

		const preview = await core.alerts.preview(viewer, { rule: { ...siteDown() } });
		expect(preview.series).toEqual([]);
		core.alerts.deleteRule(owner, rule.id);
	});

	test('a failing SQL rule keeps its state and reports its error; telemetry outages skip evaluation', async () => {
		const rule = core.alerts.createRule(admin, {
			name: 'Broken',
			query: { mode: 'sql', sql: 'SELECT nope FROM nowhere' },
			condition: { op: 'gt', threshold: 1 },
		});
		clock += 10 * MINUTE;
		await core.alerts.evaluateDue();
		const view = core.alerts.getRule(admin, rule.id);
		expect(view.health).toBe('error');
		expect(view.lastError).toBeTruthy();
		// Owners may keep an admin's SQL when they edit something else, but not change it.
		expect(core.alerts.updateRule(owner, rule.id, { version: view.version, severity: 'critical' }).severity).toBe('critical');
		expect(() => core.alerts.updateRule(owner, rule.id, { version: view.version + 1, query: { mode: 'sql', sql: 'SELECT 2' } })).toThrow('platform admins');
		core.alerts.deleteRule(admin, rule.id);
	});

	test('system alerts land in history for platform admins only', () => {
		core.alerts.recordSystemAlert({ key: 'node_offline:n1', title: 'Node offline', detail: 'n1', severity: 'critical' }, { webhook: 'ok' });
		expect(core.alerts.history(admin, { kinds: ['system'] }).map((event) => event.title)).toContain('Node offline');
		expect(core.alerts.history(owner, { kinds: ['system'] })).toEqual([]);
	});

	test('metrics:read is checked at org scope, not by a project binding', () => {
		opened.sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, created_by, created_at)
			 VALUES ('bind_scope_alerts', 'org_1', 'user', 'user_scope_alerts', 'viewer', 'project', ?, 'test', 0)`,
			[mine],
		);
		const guest = buildPrincipal({ kind: 'user', userId: 'user_scope_alerts', orgId: 'org_1', role: 'viewer' });
		expect(() => core.alerts.listRules(guest)).toThrow(/metrics:read/);
		expect(() => core.alerts.listSilences(guest)).toThrow(/metrics:read/);
	});
});

describe('system alert settings', () => {
	const dir = mkdtempSync(join(tmpdir(), 'skiff-system-alerts-'));
	const opened = createDb({ path: ':memory:' });
	let clock = T0;
	const sent: Array<{ via: string; alert: AlertMessage }> = [];
	const notifier = (name: string): Notifier => ({
		name,
		async notify(alert) {
			sent.push({ via: name, alert });
		},
	});
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
			notifiers: [notifier('email'), notifier('sms')],
			now: () => clock,
		},
	});
	const owner = buildPrincipal({ kind: 'user', userId: 'user_owner', orgId: 'org_1', role: 'owner', platformAdmin: true });
	const orgOwner = buildPrincipal({ kind: 'user', userId: 'user_org', orgId: 'org_1', role: 'owner' });
	const disk = (percent: number) =>
		opened.sqlite.run(
			`INSERT INTO nodes (id, name, mode, status, token_hash, stats_json, created_at, updated_at) VALUES ('nod_1', 'edge', 'edge', 'online', 'x', ?, 1, 1)
			ON CONFLICT(id) DO UPDATE SET stats_json = excluded.stats_json`,
			[JSON.stringify({ diskUsedBytes: percent, diskTotalBytes: 100 })],
		);

	afterAll(() => {
		opened.sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test('only platform owners see and change them', () => {
		expect(() => core.alerts.systemAlerts(orgOwner)).toThrow('platform admins');
		const view = core.alerts.systemAlerts(owner);
		expect(view.canEdit).toBe(true);
		expect(view.alerts.find((alert) => alert.kind === 'disk')).toMatchObject({ enabled: true, channels: [], values: { diskAlertPercent: 85 } });
		expect(() => core.alerts.updateSystemAlerts(orgOwner, { routing: { disk: { enabled: false, channels: [] } } })).toThrow('platform owner');
	});

	test('thresholds, routing and the repeat interval drive the maintenance sweep', async () => {
		// The fake node never heartbeats, so node-offline alerts fire too; look at disk only.
		const diskSent = () => sent.filter((item) => item.alert.key.startsWith('disk:'));
		disk(88);
		await core.maintenance.run();
		expect(diskSent().map((item) => item.via)).toEqual(['email', 'sms']);
		expect(diskSent()[0]!.alert.title).toBe('Disk usage above 85%');
		expect(core.alerts.history(owner, { kinds: ['system'] }).find((event) => event.fingerprint === 'disk:nod_1')).toMatchObject({ title: 'Disk usage above 85%', delivery: { email: 'ok', sms: 'ok' } });

		// Raise the threshold past the current usage: quiet.
		sent.length = 0;
		core.alerts.updateSystemAlerts(owner, { policies: { diskAlertPercent: 90, systemAlertRepeatMinutes: 5 } });
		clock += 10 * MINUTE;
		await core.maintenance.run();
		expect(diskSent()).toEqual([]);

		// Back over, routed to SMS only.
		disk(95);
		core.alerts.updateSystemAlerts(owner, { routing: { disk: { enabled: true, channels: ['sms'] } } });
		clock += 10 * MINUTE;
		await core.maintenance.run();
		expect(diskSent().map((item) => item.via)).toEqual(['sms']);

		// Turned off: nothing, and nothing recorded.
		sent.length = 0;
		const before = core.alerts.history(owner, { kinds: ['system'] }).filter((event) => event.fingerprint === 'disk:nod_1').length;
		core.alerts.updateSystemAlerts(owner, { routing: { disk: { enabled: false, channels: [] } } });
		clock += 10 * MINUTE;
		await core.maintenance.run();
		expect(diskSent()).toEqual([]);
		expect(core.alerts.history(owner, { kinds: ['system'] }).filter((event) => event.fingerprint === 'disk:nod_1')).toHaveLength(before);
		const view = core.alerts.systemAlerts(owner);
		expect(view.repeatMinutes).toBe(5);
		expect(view.alerts.find((alert) => alert.kind === 'disk')).toMatchObject({ enabled: false, values: { diskAlertPercent: 90 }, recentCount: 2 });
	});

	test('policy ranges are enforced and a channel can be tested on its own', async () => {
		expect(() => core.alerts.updateSystemAlerts(owner, { policies: { certWarnDays: 2, certCriticalDays: 5 } })).toThrow();
		expect(() => core.alerts.updateSystemAlerts(owner, { policies: { diskAlertPercent: 10 } })).toThrow();
		sent.length = 0;
		expect(await core.alerts.testChannel(owner, 'sms')).toEqual({ sms: 'ok' });
		expect(sent.map((item) => item.via)).toEqual(['sms']);
		await expect(core.alerts.testChannel(owner, 'pager')).rejects.toThrow('not found');
	});
});
