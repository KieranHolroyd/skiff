import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	USAGE_ANALYTICS_VERSION,
	usageMetricKeys,
	usagePingSchema,
	type UsagePing
} from '@yoal/contracts';
import { createCore } from './index.ts';
import type { Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

/**
 * The opt-in contract: off by default, a random install id, an exact payload, and no request when
 * the setting is off. The collector's own tests cover the server side.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-usage-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-10T12:00:00.000Z');

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.4.2',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.4.2',
		now: () => clock
	}
});

const owner = buildPrincipal({
	kind: 'user',
	userId: 'user_owner',
	orgId: 'org_1',
	role: 'owner',
	platformAdmin: true
});
const member = buildPrincipal({
	kind: 'user',
	userId: 'user_member',
	orgId: 'org_1',
	role: 'viewer',
	platformAdmin: false
});

const originalFetch = globalThis.fetch;
let sent: UsagePing[] = [];
let responseStatus = 202;

globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
	sent.push(JSON.parse(String(init?.body)) as UsagePing);
	return new Response(JSON.stringify({ ok: true }), { status: responseStatus });
}) as typeof fetch;

afterEach(() => {
	sent = [];
	responseStatus = 202;
	const row = opened.sqlite.query("SELECT value FROM settings WHERE key = 'usage.analytics'").get();
	if (row) opened.sqlite.run("DELETE FROM settings WHERE key = 'usage.analytics'");
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('usage analytics settings', () => {
	test('is off by default and creates no id', () => {
		const view = core.usageAnalytics.view(owner);
		expect(view.enabled).toBe(false);
		expect(view.installId).toBeNull();
		expect(view.lastSentAt).toBeNull();
		expect(view.nextSendAt).toBeNull();
		expect(view.sample.v).toBe(USAGE_ANALYTICS_VERSION);
		expect(Object.keys(view.sample.metrics).sort()).toEqual([...usageMetricKeys].sort());
	});

	test('enabling assigns a random install id and a next send time', () => {
		const view = core.usageAnalytics.setEnabled(owner, { enabled: true });
		expect(view.enabled).toBe(true);
		expect(view.installId).toMatch(/^[0-9a-f]{32}$/);
		expect(view.nextSendAt).not.toBeNull();
		// A second read keeps the same id: it identifies the install, not the session.
		expect(core.usageAnalytics.view(owner).installId).toBe(view.installId);
	});

	test('turning it off stops sending and keeps the id', () => {
		const on = core.usageAnalytics.setEnabled(owner, { enabled: true });
		const off = core.usageAnalytics.setEnabled(owner, { enabled: false });
		expect(off.enabled).toBe(false);
		expect(off.installId).toBe(on.installId);
		expect(off.nextSendAt).toBeNull();
	});

	test('a custom endpoint must be an absolute http(s) URL', () => {
		expect(() =>
			core.usageAnalytics.setEnabled(owner, { enabled: true, endpoint: 'not a url' })
		).toThrow(/absolute/i);
		const view = core.usageAnalytics.setEnabled(owner, {
			enabled: true,
			endpoint: 'https://usage.example.com/api/v1/ping'
		});
		expect(view.endpoint).toBe('https://usage.example.com/api/v1/ping');
		expect(view.endpointSource).toBe('setting');
	});

	test('only a platform admin can read or change it', () => {
		expect(() => core.usageAnalytics.view(member)).toThrow(/platform admin/i);
		expect(() => core.usageAnalytics.setEnabled(member, { enabled: true })).toThrow(/platform:settings/i);
	});
});

describe('sending', () => {
	test('sends exactly the payload the page shows, under the wire schema', async () => {
		const view = core.usageAnalytics.setEnabled(owner, { enabled: true });
		const sample = core.usageAnalytics.preview(owner);
		const result = await core.usageAnalytics.send();
		expect(result).toEqual({ sent: true, error: null });
		expect(sent).toHaveLength(1);
		const ping = sent[0]!;
		expect(usagePingSchema.parse(ping)).toBeTruthy();
		expect(ping.installId).toBe(view.installId!);
		expect(ping.version).toBe('0.4.2');
		expect(ping.metrics).toEqual(sample.metrics);
		expect(ping.features).toEqual(sample.features);
	});

	test('records the success, and does not send while off', async () => {
		core.usageAnalytics.setEnabled(owner, { enabled: true });
		await core.usageAnalytics.send();
		expect(core.usageAnalytics.view(owner).lastSentAt).not.toBeNull();
		expect(core.usageAnalytics.view(owner).lastError).toBeNull();

		core.usageAnalytics.setEnabled(owner, { enabled: false });
		expect(await core.usageAnalytics.send()).toEqual({ sent: false, error: null });
		expect(sent).toHaveLength(1);
	});

	test('a non-2xx answer is recorded, never retried immediately', async () => {
		responseStatus = 503;
		core.usageAnalytics.setEnabled(owner, { enabled: true });
		const result = await core.usageAnalytics.send();
		expect(result.sent).toBe(false);
		expect(result.error).toContain('503');
		expect(core.usageAnalytics.view(owner).lastError).toContain('503');
	});

	test('the daily tick sends once, then waits for the interval', async () => {
		core.usageAnalytics.setEnabled(owner, { enabled: true });
		await core.usageAnalytics.tick();
		expect(sent).toHaveLength(1);
		clock += 60_000;
		await core.usageAnalytics.tick();
		expect(sent).toHaveLength(1);
		clock += 24 * 60 * 60 * 1_000;
		await core.usageAnalytics.tick();
		expect(sent).toHaveLength(2);
	});

	test('an install that never opted in sends nothing on the tick', async () => {
		await core.usageAnalytics.tick();
		expect(sent).toHaveLength(0);
	});
});
