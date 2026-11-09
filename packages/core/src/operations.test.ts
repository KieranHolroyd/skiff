import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limits, operationLimits, type OperationEvent, type OperationView } from '@yoal/contracts';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore, parseListObjects } from './object-store.ts';
import type { Core } from './index.ts';

const DAY = 86_400_000;
const dir = mkdtempSync(join(tmpdir(), 'yoal-ops-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.now();

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_o', orgId: 'org_ops', role: 'owner' });
const admin = buildPrincipal({ kind: 'user', userId: 'user_admin', orgId: 'org_ops', role: 'owner', platformAdmin: true });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_d', orgId: 'org_ops', role: 'deployer' });
const agent = buildPrincipal({ kind: 'mcp', userId: 'user_o', orgId: 'org_ops', role: 'owner', clientId: 'claude' });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_x', orgId: 'org_other', role: 'owner' });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
const sql = opened.sqlite;
const count = (query: string, ...args: Array<string | number>) =>
	sql.query<{ n: number }, Array<string | number>>(`SELECT COUNT(*) AS n FROM ${query}`).get(...args)!.n;

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function project(slug: string, options: { deploy?: boolean; principal?: typeof owner } = {}) {
	const principal = options.principal ?? owner;
	await core.projects.create(principal, {
		name: slug,
		slug,
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	const row = core.projects.requireRow(principal, slug);
	if (options.deploy) await core.uploads.deployInline(principal, row, [file('index.html', `<h1>${slug}</h1>`)]);
	return core.projects.requireRow(principal, slug);
}

async function settle(principal: typeof owner, op: OperationView): Promise<OperationView> {
	await core.operations.settled(op.id);
	return core.operations.get(principal, op.id);
}

async function run(principal: typeof owner, input: Parameters<Core['operations']['create']>[1]) {
	return settle(principal, core.operations.create(principal, input));
}

const isDeleted = (slug: string) => Boolean(core.projects.requireRow(owner, slug, { includeDeleted: true }).deletedAt);

describe('bulk project operations', () => {
	test('plans with verdicts and consequence flags, then applies only the ok items', async () => {
		await project('bulk-live', { deploy: true });
		await project('bulk-idle');
		await project('bulk-trashed');
		await core.projects.softDelete(owner, 'bulk-trashed');

		const planned = await run(owner, {
			action: 'project.delete',
			targets: ['bulk-live', 'bulk-idle', 'bulk-trashed', 'bulk-missing', 'bulk-live'],
		});
		expect(planned.status).toBe('planned');
		expect(planned.total).toBe(2);
		expect(planned.summary.verdicts).toMatchObject({ ok: 2, skip: 2, blocked: 0 });
		expect(planned.summary.flags.live).toBe(1);
		expect(planned.planExpiresAt).not.toBeNull();
		// Planning never mutates.
		expect(isDeleted('bulk-live')).toBe(false);

		const { items } = core.operations.items(owner, planned.id);
		expect(items.map((item) => [item.label, item.verdict, item.reason])).toEqual([
			['bulk-live', 'ok', null],
			['bulk-idle', 'ok', null],
			['bulk-trashed', 'skip', 'already_in_trash'],
			['bulk-missing', 'skip', 'not_found'],
		]);
		expect(items[0]!.flags).toContain('live');

		const done = await settle(owner, core.operations.apply(owner, planned.id));
		expect(done.status).toBe('succeeded');
		expect(done.done).toBe(2);
		expect(isDeleted('bulk-live')).toBe(true);
		expect(isDeleted('bulk-idle')).toBe(true);

		// Every item has its own audit row linked to the operation, plus the operation entries.
		const audited = sql
			.query<{ action: string }, [string]>('SELECT action FROM audit_log WHERE operation_id = ? ORDER BY created_at')
			.all(planned.id)
			.map((row) => row.action);
		expect(audited.filter((action) => action === 'project.delete')).toHaveLength(2);
		expect(audited).toEqual(expect.arrayContaining(['operation.create', 'operation.apply', 'operation.finish']));
	});

	test('stage=apply runs straight through, and restore is the undo', async () => {
		await project('undo-a');
		await project('undo-b');
		const deleted = await run(owner, { action: 'project.delete', targets: ['undo-a', 'undo-b'], stage: 'apply' });
		expect(deleted.status).toBe('succeeded');
		expect(isDeleted('undo-a') && isDeleted('undo-b')).toBe(true);

		const restored = await run(owner, { action: 'project.restore', targets: ['undo-a', 'undo-b', 'bulk-missing'], stage: 'apply' });
		expect(restored.status).toBe('succeeded');
		expect(restored.summary.statuses).toMatchObject({ succeeded: 2, skipped: 1 });
		expect(isDeleted('undo-a') || isDeleted('undo-b')).toBe(false);
	});

	test('a target that changed since the plan is skipped, not acted on twice', async () => {
		await project('race-me');
		const planned = await run(owner, { action: 'project.delete', targets: ['race-me'] });
		await core.projects.softDelete(owner, 'race-me');
		const done = await settle(owner, core.operations.apply(owner, planned.id));
		expect(done.status).toBe('succeeded');
		expect(core.operations.items(owner, planned.id).items[0]).toMatchObject({ status: 'skipped', reason: 'already_in_trash' });
	});

	test('a failing item makes the run partial; the rest still apply', async () => {
		await project('quota-a');
		await project('quota-b');
		await run(owner, { action: 'project.delete', targets: ['quota-a', 'quota-b'], stage: 'apply' });
		// Room for exactly one more live project.
		const live = count('projects WHERE org_id = ? AND deleted_at IS NULL', 'org_ops');
		sql.run('INSERT OR REPLACE INTO org_quotas (org_id, projects, max_upload_bytes, retained_deployments, updated_at) VALUES (?, ?, -1, -1, ?)', [
			'org_ops',
			live + 1,
			clock,
		]);
		try {
			const restored = await run(owner, { action: 'project.restore', targets: ['quota-a', 'quota-b'], stage: 'apply' });
			expect(restored.status).toBe('partial');
			expect(restored.failed).toBe(1);
			const failed = core.operations.items(owner, restored.id, { status: 'failed' }).items;
			expect(failed[0]!.error).toContain('Project limit reached');
		} finally {
			sql.run('DELETE FROM org_quotas WHERE org_id = ?', ['org_ops']);
		}
	});

	test('purge only accepts trashed projects and removes everything they own', async () => {
		const live = await project('purge-live', { deploy: true });
		const doomed = await project('purge-doomed', { deploy: true });
		sql.run(
			`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, status, spec_json, memory_mb, created_at, updated_at)
			 VALUES ('wl_doomed', 'org_ops', ?, 'dep_x', 'node_x', 'process', 'running', '{}', 256, ?, ?)`,
			[doomed.id, clock, clock],
		);
		sql.run(
			`INSERT INTO domains (id, org_id, project_id, hostname, status, verification_token, created_at)
			 VALUES ('dom_doomed', 'org_ops', ?, 'doomed.example.com', 'pending', 'tok', ?)`,
			[doomed.id, clock],
		);
		await core.projects.softDelete(owner, 'purge-doomed');

		const plan = await run(owner, { action: 'project.purge', targets: ['purge-live', 'purge-doomed'] });
		expect(core.operations.items(owner, plan.id).items.map((item) => [item.label, item.verdict, item.reason])).toEqual([
			['purge-live', 'blocked', 'not_in_trash'],
			['purge-doomed', 'ok', null],
		]);
		expect(core.operations.items(owner, plan.id).items[1]!.flags).toEqual(expect.arrayContaining(['live', 'custom_domain']));
		const done = await settle(owner, core.operations.apply(owner, plan.id));
		expect(done.status).toBe('succeeded');

		expect(sql.query('SELECT 1 FROM projects WHERE id = ?').get(doomed.id)).toBeNull();
		for (const table of ['deployments', 'workloads', 'environments', 'domains'])
			expect(count(`${table} WHERE project_id = ?`, doomed.id)).toBe(0);
		expect(count("audit_log WHERE action = 'domain.delete' AND resource_id = 'dom_doomed'")).toBe(1);
		expect(sql.query('SELECT 1 FROM projects WHERE id = ?').get(live.id)).not.toBeNull();
	});

	test('permissions and surfaces are enforced', async () => {
		await project('perm-target');
		expect(() => core.operations.create(deployer, { action: 'project.delete', targets: ['perm-target'] })).toThrow(
			/project:delete/,
		);
		// Agents never get irreversible actions (D29).
		expect(() => core.operations.create(agent, { action: 'project.purge', targets: ['perm-target'] })).toThrow(/not available to MCP/);
		expect(() => core.operations.create(agent, { action: 'prune' })).toThrow(/not available to MCP/);
		expect(() =>
			core.operations.create(agent, {
				action: 'project.delete',
				targets: Array.from({ length: operationLimits.mcpTargets + 1 }, (_value, index) => `p-${index}`),
			}),
		).toThrow(/At most 25/);
		expect(core.operations.actions(agent).map((action) => action.id)).toEqual(['project.delete', 'project.restore']);
		expect(core.operations.actions(deployer).map((action) => action.id)).toEqual(['project.restore']);

		// Another org can neither see nor act on the operation, nor on these projects.
		const op = await run(owner, { action: 'project.delete', targets: ['perm-target'] });
		expect(() => core.operations.get(otherOrg, op.id)).toThrow(/not found/);
		const foreign = await run(otherOrg, { action: 'project.delete', targets: ['perm-target'] });
		expect(core.operations.items(otherOrg, foreign.id).items[0]).toMatchObject({ verdict: 'skip', reason: 'not_found' });
		// Only the planner applies their plan.
		expect(() => core.operations.apply(admin, op.id)).toThrow(/only the person who planned it/);
		core.operations.cancel(owner, op.id);
	});

	test('idempotency keys return the original operation', async () => {
		await project('idem');
		const first = core.operations.create(owner, { action: 'project.delete', targets: ['idem'] }, { idempotencyKey: 'k-1' });
		const second = core.operations.create(owner, { action: 'project.delete', targets: ['idem'] }, { idempotencyKey: 'k-1' });
		expect(second.id).toBe(first.id);
		await settle(owner, first);
		core.operations.cancel(owner, first.id);
	});

	test('cancelling a plan marks it cancelled; expired plans cannot be applied', async () => {
		await project('cancel-me');
		const plan = await run(owner, { action: 'project.delete', targets: ['cancel-me'] });
		const cancelled = core.operations.cancel(owner, plan.id);
		expect(cancelled.status).toBe('cancelled');
		expect(() => core.operations.apply(owner, plan.id)).toThrow(/Only a planned operation/);

		const stale = await run(owner, { action: 'project.delete', targets: ['cancel-me'] });
		clock += operationLimits.planTtlMs + 1;
		expect(() => core.operations.apply(owner, stale.id)).toThrow(/expired/);
		core.operations.expireAndPrune();
		expect(core.operations.get(owner, stale.id).status).toBe('expired');
		expect(isDeleted('cancel-me')).toBe(false);
	});

	test('one bulk run per org at a time', async () => {
		await project('busy-a');
		await project('busy-b');
		const first = await run(owner, { action: 'project.delete', targets: ['busy-a'] });
		sql.run("UPDATE operations SET status = 'applying', heartbeat_at = ? WHERE id = ?", [clock, first.id]);
		expect(() => core.operations.create(owner, { action: 'project.delete', targets: ['busy-b'], stage: 'apply' })).toThrow(
			/already running/,
		);
		sql.run("UPDATE operations SET status = 'cancelled' WHERE id = ?", [first.id]);
	});

	test('a run whose runner died resumes from the first unfinished item', async () => {
		await project('resume-a');
		await project('resume-b');
		const plan = await run(owner, { action: 'project.delete', targets: ['resume-a', 'resume-b'] });
		// Simulate a control plane that claimed the run, finished item 1 and then crashed.
		await core.projects.softDelete(owner, 'resume-a');
		sql.run("UPDATE operation_items SET status = 'succeeded' WHERE operation_id = ? AND seq = 1", [plan.id]);
		sql.run("UPDATE operations SET status = 'applying', done = 1, heartbeat_at = ? WHERE id = ?", [
			clock - operationLimits.staleHeartbeatMs - 1,
			plan.id,
		]);
		expect(core.operations.resume()).toContain(plan.id);
		const done = await settle(owner, core.operations.get(owner, plan.id));
		expect(done.status).toBe('succeeded');
		expect(done.done).toBe(2);
		expect(isDeleted('resume-b')).toBe(true);
	});

	test('events stream progress, finished items and done', async () => {
		await project('stream-a');
		await project('stream-b');
		const op = core.operations.create(owner, { action: 'project.delete', targets: ['stream-a', 'stream-b'], stage: 'apply' });
		const events: OperationEvent[] = [];
		for await (const event of core.operations.events(owner, op.id)) events.push(event);
		const last = events.at(-1)!;
		expect(last.type).toBe('done');
		expect(last.type === 'done' && last.operation.status).toBe('succeeded');
		const items = events.flatMap((event) => (event.type === 'items' ? event.items : []));
		expect(items.map((item) => item.label)).toEqual(['stream-a', 'stream-b']);
		expect(events.some((event) => event.type === 'progress')).toBe(true);
	});

	test('finished operations are removed after the retention window', async () => {
		const before = count('operations');
		clock += (operationLimits.retentionDays + 1) * DAY;
		const { removed } = core.operations.expireAndPrune();
		expect(removed).toBeGreaterThan(0);
		expect(count('operations')).toBeLessThan(before);
	});
});

describe('leak fixes', () => {
	test('a trashed project no longer reserves workload budget', async () => {
		const p = await project('reserved');
		sql.run(
			`INSERT INTO nodes (id, name, mode, status, token_hash, slice_memory_mb, created_at, updated_at)
			 VALUES ('node_budget', 'worker', 'worker', 'online', 'x', 2048, ?, ?)`,
			[clock, clock],
		);
		sql.run(
			`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, status, spec_json, memory_mb, created_at, updated_at)
			 VALUES ('wl_budget', 'org_ops', ?, 'dep_y', 'node_budget', 'process', 'running', '{}', 512, ?, ?)`,
			[p.id, clock, clock],
		);
		const reserved = () => core.workloads.capacityInternal().find((node) => node.nodeId === 'node_budget')!.reservedMemoryMb;
		expect(reserved()).toBe(512);
		await core.projects.softDelete(owner, 'reserved');
		expect(reserved()).toBe(0);
		await core.projects.restore(owner, 'reserved');
		expect(reserved()).toBe(512);
	});

	test('the trash purge runs the full cascade', async () => {
		const p = await project('expire-me', { deploy: true });
		sql.run(
			`INSERT INTO domains (id, org_id, project_id, hostname, status, verification_token, created_at)
			 VALUES ('dom_expire', 'org_ops', ?, 'expire.example.com', 'pending', 'tok', ?)`,
			[p.id, clock],
		);
		sql.run(`INSERT INTO log_events (org_id, project_id, source, stream, message, ts) VALUES ('org_ops', ?, 'system', 'system', 'x', ?)`, [
			p.id,
			clock,
		]);
		await core.projects.softDelete(owner, 'expire-me');
		clock += (limits.trashDays + 1) * DAY;
		expect(await core.projects.purgeExpired()).toBeGreaterThanOrEqual(1);
		for (const table of ['deployments', 'environments', 'log_events', 'domains'])
			expect(count(`${table} WHERE project_id = ?`, p.id)).toBe(0);
	});

	test('unreferenced config snapshots are collected after the grace window', async () => {
		sql.run(
			"INSERT INTO config_snapshots (id, org_id, hash, site_config_json, created_at) VALUES ('cfg_old', 'org_ops', 'h-old', '{}', ?)",
			[clock - 2 * DAY],
		);
		sql.run(
			"INSERT INTO config_snapshots (id, org_id, hash, site_config_json, created_at) VALUES ('cfg_new', 'org_ops', 'h-new', '{}', ?)",
			[clock],
		);
		core.releases.gcSnapshots(operationLimits.pruneGraceMs);
		expect(sql.query("SELECT 1 FROM config_snapshots WHERE id = 'cfg_old'").get()).toBeNull();
		expect(sql.query("SELECT 1 FROM config_snapshots WHERE id = 'cfg_new'").get()).not.toBeNull();
	});
});

describe('prune', () => {
	test('finds orphans by category, respects the grace window, and removes exactly the plan', async () => {
		// Let release GC queued by earlier purges finish, so only prune touches these rows.
		await core.deployments.gcReleases('org_ops');
		// Leftovers of a project that vanished without the cascade (old code).
		sql.run(
			`INSERT INTO environments (id, org_id, project_id, slug, name, created_at, updated_at)
			 VALUES ('env_orphan', 'org_ops', 'prj_gone', 'staging', 'Staging', ?, ?)`,
			[clock, clock],
		);
		sql.run(`INSERT INTO log_events (org_id, project_id, source, stream, message, ts) VALUES ('org_ops', 'prj_gone', 'system', 'system', 'x', ?)`, [
			clock,
		]);
		sql.run(
			`INSERT INTO domains (id, org_id, project_id, hostname, status, verification_token, created_at)
			 VALUES ('dom_orphan', 'org_ops', 'prj_gone', 'orphan.example.com', 'pending', 'tok', ?)`,
			[clock],
		);
		// An old unreferenced release and a fresh one (inside the grace window).
		sql.run(
			`INSERT INTO releases (id, org_id, sha256, object_key, storage, size_bytes, file_count, manifest_json, created_by, created_at)
			 VALUES ('rel_old', 'org_ops', 'aaa', 'releases/aaa.zip', 'local', 100, 1, '[]', 'user_o', ?)`,
			[clock - 2 * DAY],
		);
		sql.run(
			`INSERT INTO releases (id, org_id, sha256, object_key, storage, size_bytes, file_count, manifest_json, created_by, created_at)
			 VALUES ('rel_fresh', 'org_ops', 'bbb', 'releases/bbb.zip', 'local', 100, 1, '[]', 'user_o', ?)`,
			[clock],
		);
		await store.put('releases/aaa.zip', new Uint8Array(100));
		// Another org's orphan stays out of an org-scope prune.
		sql.run(
			`INSERT INTO environments (id, org_id, project_id, slug, name, created_at, updated_at)
			 VALUES ('env_foreign', 'org_other', 'prj_gone2', 'staging', 'Staging', ?, ?)`,
			[clock, clock],
		);

		const plan = await run(owner, { action: 'prune' });
		expect(plan.status).toBe('planned');
		expect(plan.scope).toBe('org');
		const categories = plan.summary.categories!;
		expect(categories.project_rows?.planned).toBe(2);
		expect(categories.domains?.planned).toBe(1);
		expect(categories.releases?.planned).toBe(1);
		expect(categories.releases?.bytes).toBe(100);
		expect(categories.objects).toBeUndefined();

		// Something new that appears after the scan is not touched by applying the plan.
		sql.run(
			`INSERT INTO environments (id, org_id, project_id, slug, name, created_at, updated_at)
			 VALUES ('env_late', 'org_ops', 'prj_late', 'staging', 'Staging', ?, ?)`,
			[clock, clock],
		);
		const done = await settle(owner, core.operations.apply(owner, plan.id, { categories: ['project_rows', 'domains', 'releases'] }));
		expect(done.status).toBe('succeeded');
		expect(done.summary.freedBytes).toBe(100);
		expect(count("environments WHERE id = 'env_orphan'")).toBe(0);
		expect(count("log_events WHERE project_id = 'prj_gone'")).toBe(0);
		expect(count("domains WHERE id = 'dom_orphan'")).toBe(0);
		expect(count("releases WHERE id = 'rel_old'")).toBe(0);
		expect(await store.exists('releases/aaa.zip')).toBe(false);
		expect(count("releases WHERE id = 'rel_fresh'")).toBe(1);
		expect(count("environments WHERE id = 'env_late'")).toBe(1);
		expect(count("environments WHERE id = 'env_foreign'")).toBe(1);
	});

	test('rows removed between scan and apply are reported as skipped', async () => {
		sql.run(
			`INSERT INTO environments (id, org_id, project_id, slug, name, created_at, updated_at)
			 VALUES ('env_vanish', 'org_ops', 'prj_vanish', 'staging', 'Staging', ?, ?)`,
			[clock, clock],
		);
		const plan = await run(owner, { action: 'prune', categories: ['project_rows'] });
		sql.run("DELETE FROM environments WHERE id = 'env_vanish'");
		const done = await settle(owner, core.operations.apply(owner, plan.id));
		const item = core.operations.items(owner, plan.id).items.find((entry) => entry.targetId === 'prj_vanish');
		expect(item).toMatchObject({ status: 'skipped', reason: 'already_removed' });
		expect(done.status).toBe('succeeded');
	});

	test('prune must be planned first and org prune cannot touch shared objects', () => {
		expect(() => core.operations.create(owner, { action: 'prune', stage: 'apply' })).toThrow(/planned first/);
		expect(() => core.operations.create(owner, { action: 'prune', categories: ['objects'] })).toThrow(/platform-scope/);
		expect(() => core.operations.create(owner, { action: 'prune', scope: 'platform' })).toThrow(/platform:admin/);
		expect(() => core.operations.create(deployer, { action: 'prune' })).toThrow(/project:delete/);
	});

	test('platform prune finds stored objects with no row, older than the grace window', async () => {
		await store.put('releases/orphan.zip', new Uint8Array(42));
		await store.put('uploads/abandoned.zip', new Uint8Array(7));
		await store.put('releases/new-orphan.zip', new Uint8Array(5));
		await store.put('releases/bbb.zip', new Uint8Array(100)); // referenced by rel_fresh
		// File mtimes are real time; pin them to the test clock.
		const old = (clock - 2 * DAY) / 1000;
		for (const key of ['releases/orphan.zip', 'uploads/abandoned.zip', 'releases/bbb.zip'])
			utimesSync(join(dir, 'objects', key), old, old);
		utimesSync(join(dir, 'objects', 'releases/new-orphan.zip'), clock / 1000, clock / 1000);

		const plan = await run(admin, { action: 'prune', scope: 'platform', categories: ['objects'] });
		expect(plan.scope).toBe('platform');
		const keys = core.operations.items(admin, plan.id).items.map((item) => item.targetId).sort();
		expect(keys).toEqual(['releases/orphan.zip', 'uploads/abandoned.zip']);
		// Platform runs are invisible to an org-only listing but visible to the platform listing.
		expect(core.operations.list(owner).some((op) => op.id === plan.id)).toBe(false);
		expect(core.operations.list(admin, { scope: 'platform' }).some((op) => op.id === plan.id)).toBe(true);

		const done = await settle(admin, core.operations.apply(admin, plan.id));
		expect(done.summary.freedBytes).toBe(49);
		expect(await store.exists('releases/orphan.zip')).toBe(false);
		expect(await store.exists('uploads/abandoned.zip')).toBe(false);
		expect(await store.exists('releases/new-orphan.zip')).toBe(true);
		expect(await store.exists('releases/bbb.zip')).toBe(true);
	});

	test('stale GitHub runner registrations are pruned, recent ones are kept', async () => {
		sql.run(
			`INSERT INTO github_runner_registrations
			 (id, org_id, project_id, workload_id, replica, runner_id, runner_name, target, created_at)
			 VALUES ('ghr_stale', 'org_ops', 'prj_gone', 'wl_gone', 0, 42, 'yoal-old-0-abc', 'acme/api', ?)`,
			[clock - 8 * DAY],
		);
		sql.run(
			`INSERT INTO github_runner_registrations
			 (id, org_id, project_id, workload_id, replica, runner_id, runner_name, target, created_at)
			 VALUES ('ghr_fresh', 'org_ops', 'prj_gone', 'wl_gone', 1, 43, 'yoal-old-1-def', 'acme/api', ?)`,
			[clock - DAY],
		);

		const plan = await run(owner, { action: 'prune', categories: ['runner_registrations'] });
		expect(plan.status).toBe('planned');
		expect(plan.summary.categories?.runner_registrations?.planned).toBe(1);
		expect(core.operations.items(owner, plan.id).items.map((item) => item.targetId)).toEqual(['ghr_stale']);

		const done = await settle(owner, core.operations.apply(owner, plan.id));
		expect(done.status).toBe('succeeded');
		expect(count("github_runner_registrations WHERE id = 'ghr_stale'")).toBe(0);
		expect(count("github_runner_registrations WHERE id = 'ghr_fresh'")).toBe(1);
	});
});

describe('object store listing', () => {
	test('parses S3 ListObjectsV2 pages', () => {
		const page = parseListObjects(`<?xml version="1.0"?><ListBucketResult>
			<IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken>
			<Contents><Key>releases/a&amp;b.zip</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified><Size>12</Size></Contents>
			<Contents><Key>releases/c.zip</Key><LastModified>2026-01-03T00:00:00.000Z</LastModified><Size>3</Size></Contents>
		</ListBucketResult>`);
		expect(page.nextToken).toBe('tok&1');
		expect(page.objects).toEqual([
			{ key: 'releases/a&b.zip', size: 12, lastModified: Date.parse('2026-01-02T03:04:05.000Z') },
			{ key: 'releases/c.zip', size: 3, lastModified: Date.parse('2026-01-03T00:00:00.000Z') },
		]);
		expect(parseListObjects('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')).toEqual({ objects: [] });
	});

	test('the local store refuses prefixes outside its root', async () => {
		const iterate = async () => {
			for await (const _object of store.list('../')) void _object;
		};
		await expect(iterate()).rejects.toThrow(/Invalid object prefix/);
	});
});
