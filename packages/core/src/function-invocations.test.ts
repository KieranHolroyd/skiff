import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES } from '@skiff/contracts';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { FunctionInvocationQuery, TelemetryStore } from './telemetry.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-fn-invocations-'));
const opened = createDb({ path: ':memory:' });
const core = createCore({
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
		features: { ...DEFAULT_FEATURES, FUNCTIONS: true },
	},
});
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function functionRow(slug: string) {
	await core.projects.create(principal, {
		name: slug,
		slug,
		runtime: 'function',
		placement: 'auto',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	return core.projects.requireRow(principal, slug);
}

describe('FunctionService invocations', () => {
	test('reports unavailable, not empty, when there is no telemetry store', async () => {
		const row = await functionRow('fn-no-telemetry');
		core.ctx.telemetry = undefined;
		expect(await core.functions.invocations(principal, row, { from: 0, to: Date.now() })).toEqual({
			available: false,
			rows: [],
		});
		expect((await core.functions.invocationSummary(principal, row, { from: 0, to: 1 })).available).toBe(false);
	});

	test('scopes the read to the function and passes paging through', async () => {
		const row = await functionRow('fn-with-telemetry');
		const seen: FunctionInvocationQuery[] = [];
		core.ctx.telemetry = {
			ready: async () => true,
			functionInvocations: async (query: FunctionInvocationQuery) => {
				seen.push(query);
				return [
					{
						at: '2026-11-06T10:00:00.000Z',
						workloadId: 'wl_1',
						scriptName: 'fn',
						outcome: 'exception',
						logs: [{ level: 'error', message: 'boom' }],
						exceptions: [{ name: 'Error', message: 'boom' }],
						request: { method: 'GET', url: 'https://fn.sites.test/', status: 500 },
					},
				];
			},
			functionInvocationSummary: async () => ({ total: 3, byOutcome: { ok: 2, exception: 1 } }),
		} as unknown as TelemetryStore;

		const result = await core.functions.invocations(principal, row, {
			from: 0,
			to: 1_000,
			limit: 10,
			before: 900,
			outcome: 'exception',
		});
		expect(result.available).toBe(true);
		expect(result.rows[0]?.outcome).toBe('exception');
		expect(seen[0]).toEqual({ projectId: row.id, from: 0, to: 1_000, limit: 10, before: 900, outcome: 'exception' });

		const summary = await core.functions.invocationSummary(principal, row, { from: 0, to: 1_000 });
		expect(summary).toEqual({ available: true, summary: { total: 3, byOutcome: { ok: 2, exception: 1 } } });
		core.ctx.telemetry = undefined;
	});
});
