import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	DEFAULT_FEATURES,
	WHATS_NEW_ITEMS,
	parseSemver,
	whatsNewItemsBetween,
	type WhatsNewItem
} from '@yoal/contracts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import { ForbiddenError, ValidationError } from './errors.ts';

/**
 * Post-update onboarding (docs/WHATS-NEW.md, D212): the version window, the install-wide ledger,
 * and the rule that a consent item is never silently acknowledged.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-whats-new-'));
const open: Array<{
	core: Core;
	sqlite: ReturnType<typeof createDb>['sqlite'];
}> = [];

afterEach(() => {
	for (const entry of open.splice(0)) entry.sqlite.close();
});

function setup(version = '0.13.6') {
	const opened = createDb({ path: ':memory:' });
	const core = createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version,
		config: {
			dataDir: dir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: new LocalObjectStore(
				join(dir, 'objects'),
				'https://control.test',
				'object-secret-123'
			),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: version,
			now: () => Date.parse('2026-11-10T12:00:00.000Z'),
			features: { ...DEFAULT_FEATURES }
		}
	});
	open.push({ core, sqlite: opened.sqlite });
	return core;
}

const admin = buildPrincipal({
	kind: 'user',
	userId: 'user_admin',
	orgId: 'org_1',
	role: 'owner',
	platformAdmin: true
});
const viewer = buildPrincipal({
	kind: 'user',
	userId: 'user_viewer',
	orgId: 'org_1',
	role: 'owner',
	granted: ['platform:read']
});
const member = buildPrincipal({
	kind: 'user',
	userId: 'user_member',
	orgId: 'org_1',
	role: 'owner'
});

describe('whats-new catalog', () => {
	test('every entry has a stable id, a release and coherent consent fields', () => {
		const ids = new Set<string>();
		for (const item of WHATS_NEW_ITEMS) {
			expect(item.id).toBeTruthy();
			expect(ids.has(item.id)).toBe(false);
			ids.add(item.id);
			expect(parseSemver(item.since)).not.toBeNull();
			expect(item.title.length).toBeGreaterThan(0);
			expect(item.summary.length).toBeGreaterThan(0);
			if (item.attention === 'consent') {
				expect(item.consent).toBeDefined();
				expect(item.consentLabels?.enable.length).toBeGreaterThan(0);
				expect(item.consentLabels?.decline.length).toBeGreaterThan(0);
				expect(item.consentLabels?.keep.length).toBeGreaterThan(0);
			} else {
				expect(item.consent).toBeUndefined();
			}
		}
	});
});

describe('whatsNewItemsBetween', () => {
	const items: WhatsNewItem[] = [
		{
			id: 'old',
			since: '0.13.6',
			title: 'Old',
			summary: '',
			attention: 'info'
		},
		{
			id: 'new',
			since: '0.14.0',
			title: 'New',
			summary: '',
			attention: 'info'
		}
	];

	test('returns every release after the last seen version, newest first', () => {
		expect(whatsNewItemsBetween(items, '0.13.5', '0.14.0').map((item) => item.id)).toEqual([
			'new',
			'old'
		]);
	});

	test('does not repeat changes at or below the last seen version', () => {
		expect(whatsNewItemsBetween(items, '0.13.6', '0.14.0').map((item) => item.id)).toEqual(['new']);
		expect(whatsNewItemsBetween(items, '0.14.0', '0.14.0')).toEqual([]);
	});

	test('never shows an item from a release newer than the running one', () => {
		expect(whatsNewItemsBetween(items, '0.13.5', '0.13.6').map((item) => item.id)).toEqual(['old']);
	});

	test('an invalid version hides the flow rather than guessing at history', () => {
		expect(whatsNewItemsBetween(items, '0.13.5', 'not-a-version')).toEqual([]);
	});
});

describe('WhatsNewService', () => {
	test('an existing install starts at the baseline and sees the analytics consent', () => {
		const core = setup();
		const summary = core.whatsNew.summary(admin);
		expect(summary.pending).toBe(1);
		expect(summary.attention).toBe(1);

		const view = core.whatsNew.view(admin);
		expect(view.lastSeenVersion).toBe('0.13.5');
		expect(view.items.map((item) => item.id)).toEqual(['usage-analytics']);
		expect(view.items[0]?.consentState).toEqual({
			label: 'Anonymous usage data',
			enabled: false,
			endpoint: 'https://yoal-analytics-engine.kierancloud.dev/api/v1/ping'
		});
		expect(view.canDecide).toBe(true);
	});

	test('a fresh install records its release and has nothing to review', () => {
		const core = setup();
		core.whatsNew.markInstalled();
		expect(core.whatsNew.summary(admin).pending).toBe(0);
		expect(core.whatsNew.view(admin).items).toEqual([]);
	});

	test('enabling a consent item changes the setting and closes the item', () => {
		const core = setup();
		const view = core.whatsNew.decide(admin, 'usage-analytics', 'enabled');
		expect(view.pending).toBe(0);
		expect(view.items[0]?.decision).toBe('enabled');
		expect(core.usageAnalytics.view(admin).enabled).toBe(true);
	});

	test('declining leaves the setting off and records the decision', () => {
		const core = setup();
		const view = core.whatsNew.decide(admin, 'usage-analytics', 'declined');
		expect(view.pending).toBe(0);
		expect(view.items[0]?.decision).toBe('declined');
		expect(core.usageAnalytics.view(admin).enabled).toBe(false);
	});

	test('a consent item cannot be acknowledged as read', () => {
		const core = setup();
		expect(() => core.whatsNew.decide(admin, 'usage-analytics', 'acknowledged')).toThrow(
			ValidationError
		);
	});

	test('acknowledging is blocked until every consent item has a decision', () => {
		const core = setup();
		expect(() => core.whatsNew.acknowledge(admin)).toThrow(ValidationError);
		core.whatsNew.decide(admin, 'usage-analytics', 'declined');
		const view = core.whatsNew.acknowledge(admin);
		expect(view.items).toEqual([]);
		expect(view.lastSeenVersion).toBe('0.13.6');
	});

	test('a platform viewer can read but not decide', () => {
		const core = setup();
		core.ctx.platformIam.bind(admin, {
			userId: viewer.userId,
			roleId: 'platform-viewer'
		});
		expect(core.whatsNew.view(viewer).canDecide).toBe(false);
		expect(() => core.whatsNew.decide(viewer, 'usage-analytics', 'enabled')).toThrow(
			ForbiddenError
		);
	});

	test('an ordinary member cannot see the flow', () => {
		const core = setup();
		expect(() => core.whatsNew.summary(member)).toThrow(ForbiddenError);
	});
});
