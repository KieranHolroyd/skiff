import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { parseSentryEnvelope } from './app-errors.ts';
import type { Core } from './index.ts';

/**
 * Real envelopes captured from the JS, PHP and Go Sentry SDK harnesses
 * (tests/harnesses/error-tracker). They prove the parser against SDK output rather than only
 * against hand-written JSON; the fixture paths and harness key are the only redactions.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-app-error-fixtures-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const key = '0123456789abcdef0123456789abcdef';

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '1.2.3',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => Date.parse('2026-11-12T12:00:00Z'),
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_a', orgId: 'org_a', role: 'owner' });
const project = await core.projects.create(owner, {
	name: 'Harness',
	slug: 'harness',
	runtime: 'static',
	placement: 'edge',
	productionAccess: 'public',
	previewAccess: 'platform',
});
core.appErrors.enable(owner, project);
opened.sqlite.run('UPDATE app_error_keys SET public_key = ? WHERE project_id = ?', [key, project.id]);
const dsnId = String(
	opened.sqlite
		.query<{ dsn_project_id: number }, [string]>('SELECT dsn_project_id FROM app_error_projects WHERE project_id = ?')
		.get(project.id)!.dsn_project_id,
);

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(new URL(`./app-errors/fixtures/${name}`, import.meta.url)));
}

describe('Sentry SDK harness fixtures', () => {
	test('parses and stores the JS, PHP and Go envelopes', async () => {
		for (const name of ['js-simple.envelope', 'php-simple.envelope', 'go-simple.envelope']) {
			const body = fixture(name);
			expect(parseSentryEnvelope(body).event).not.toBeNull();
			const outcome = core.appErrors.ingest({ dsnProjectId: dsnId, endpoint: 'envelope', body, headerKey: key });
			expect(outcome.status).toBe(200);
		}

		const list = core.appErrors.list(owner, project, { status: 'all', range: 'all' });
		expect(list.issues).toHaveLength(3);
		expect(list.issues.map((issue) => issue.name).sort()).toEqual([
			'*errors.errorString',
			'Error',
			'RuntimeException',
		]);
		for (const issue of list.issues) {
			expect(issue.environment).toBe('harness');
			expect(issue.count).toBe(1);
			const detail = core.appErrors.get(owner, project, issue.id);
			expect(detail.events[0]?.exceptions.length).toBeGreaterThan(0);
			expect(detail.events[0]?.exceptions.at(-1)?.value).toContain('harness: simple failure');
		}
	});

	test('the same SDK event id is counted once', async () => {
		const body = fixture('go-simple.envelope');
		for (let index = 0; index < 2; index++) {
			const outcome = core.appErrors.ingest({
				dsnProjectId: dsnId,
				endpoint: 'envelope',
				body,
				headerKey: key,
			});
			expect(outcome.status).toBe(200);
		}
		const issue = core.appErrors.list(owner, project, { status: 'all', q: 'go-harness: simple failure' }).issues[0]!;
		expect(issue.count).toBe(1);
	});
});
