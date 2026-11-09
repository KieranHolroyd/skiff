import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settings } from '@yoal/db';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-sentry-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-09T10:00:00Z');

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '1.2.3',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(9),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock
	}
});

const admin = buildPrincipal({
	kind: 'user',
	userId: 'user_admin',
	orgId: 'org_a',
	role: 'owner',
	platformAdmin: true
});
const member = buildPrincipal({
	kind: 'user',
	userId: 'user_member',
	orgId: 'org_a',
	role: 'viewer'
});

const DSN = 'https://public-key@o123.ingest.sentry.io/456';

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('Sentry settings', () => {
	test('starts with nothing saved, so forwarding is off', () => {
		expect(core.sentry.config()).toBeNull();
		const view = core.sentry.view(admin);
		expect(view.enabled).toBe(false);
		expect(view.dsn).toBeNull();
		expect(view.hasAuthToken).toBe(false);
	});

	test('only a platform admin may read or change it', () => {
		expect(() => core.sentry.view(member)).toThrow();
		expect(() =>
			core.sentry.save(member, { enabled: false, dsn: DSN })
		).toThrow();
	});

	test('refuses to switch on without a DSN', () => {
		expect(() => core.sentry.save(admin, { enabled: true, dsn: null })).toThrow(
			'Add a Sentry DSN'
		);
	});

	test('rejects a DSN that is not a Sentry URL', () => {
		expect(() => core.sentry.save(admin, { enabled: true, dsn: 'not-a-url' })).toThrow(
			'Enter the DSN'
		);
		expect(() =>
			core.sentry.save(admin, { enabled: true, dsn: 'https://example.com/1' })
		).toThrow('public key');
	});

	test('rejects a performance sample rate outside 0–1', () => {
		expect(() =>
			core.sentry.save(admin, { enabled: false, dsn: DSN, tracesSampleRate: 1.5 })
		).toThrow('between 0 and 1');
	});

	test('stores the token sealed and never returns it in the view', () => {
		clock += 1_000;
		const view = core.sentry.save(admin, {
			enabled: true,
			dsn: DSN,
			environment: 'staging',
			release: 'yoal@1.2.3',
			tracesSampleRate: 0.05,
			authToken: 'sntrys_secret_token_wxyz',
			organizationSlug: 'acme',
			projectSlug: 'yoal'
		});
		expect(view).toMatchObject({
			enabled: true,
			dsn: DSN,
			environment: 'staging',
			release: 'yoal@1.2.3',
			tracesSampleRate: 0.05,
			hasAuthToken: true,
			authTokenHint: '…wxyz',
			releaseReady: true
		});
		expect(JSON.stringify(view)).not.toContain('sntrys_secret_token_wxyz');

		const row = opened.db.select().from(settings).all().find((entry) => entry.key === 'sentry.config');
		expect(row).toBeDefined();
		expect(row!.value).not.toContain('sntrys_secret_token_wxyz');
		expect(core.sentry.config()?.authToken).toBe('sntrys_secret_token_wxyz');
	});

	test('turning it off keeps the DSN, and the token can be removed', () => {
		const off = core.sentry.save(admin, {
			enabled: false,
			dsn: DSN,
			environment: 'staging',
			clearAuthToken: true
		});
		expect(off.enabled).toBe(false);
		expect(off.dsn).toBe(DSN);
		expect(off.hasAuthToken).toBe(false);
		expect(core.sentry.config()?.authToken).toBeNull();
		expect(core.sentry.active()).toBe(false);
	});

	test('a blank token on a later save does not overwrite the saved one', () => {
		core.sentry.save(admin, { enabled: true, dsn: DSN, authToken: 'sntrys_test_token' });
		core.sentry.save(admin, { enabled: true, dsn: DSN });
		expect(core.sentry.config()?.authToken).toBe('sntrys_test_token');
	});
});
