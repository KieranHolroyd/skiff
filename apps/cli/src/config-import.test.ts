import { describe, expect, test } from 'bun:test';
import { listFlag, parseSecretsFile, renderImport, type ImportView } from './config-import.ts';

describe('parseSecretsFile', () => {
	test('reads NAME=value and project/NAME=value lines', () => {
		const text = [
			'# comment',
			'',
			'STRIPE_KEY=sk_live_1',
			'export SENTRY_DSN = https://x@y/1',
			'cairn/BETTER_AUTH_SECRET="multi\\nline \\"quoted\\""',
			"cutcraft/RUNPOD_API_KEY='single # not a comment'",
			'EMPTY=',
		].join('\n');
		expect(parseSecretsFile(text)).toEqual({
			STRIPE_KEY: 'sk_live_1',
			SENTRY_DSN: 'https://x@y/1',
			'cairn/BETTER_AUTH_SECRET': 'multi\nline "quoted"',
			'cutcraft/RUNPOD_API_KEY': 'single # not a comment',
			EMPTY: '',
		});
	});

	test('names the bad line', () => {
		expect(() => parseSecretsFile('OK=1\nnot a pair')).toThrow(/Line 2/);
		expect(() => parseSecretsFile('Bad/Slug/X=1')).toThrow(/Line 1/);
	});
});

test('listFlag splits repeated and comma-separated values', () => {
	expect(listFlag(['projects,databases', ' iam ', ''])).toEqual(['projects', 'databases', 'iam']);
});

describe('renderImport', () => {
	const view: ImportView = {
		mode: 'plan',
		source: { platform: 'https://control.old', org: 'Acme', exportedAt: '2026-11-09T10:00:00Z' },
		steps: [
			{ key: 'projects.web', section: 'projects', kind: 'project', name: 'web', action: 'create', status: 'planned', reason: null, dependsOn: [] },
			{ key: 'databases.db', section: 'databases', kind: 'database', name: 'db', action: 'exists', status: 'exists', reason: 'already exists; left as it is', dependsOn: [] },
			{ key: 'secrets.X', section: 'secrets', kind: 'secret', name: 'X', action: 'skip', status: 'skipped', reason: 'no value supplied (--secrets)', dependsOn: [] },
		],
		manual: [{ section: 'secrets', item: 'X', what: 'Set the value' }],
		warnings: ['careful'],
		summary: { planned: 1, done: 0, exists: 1, skipped: 1, failed: 0 },
	};

	test('hides existing resources unless asked, and lists manual work', () => {
		const text = renderImport(view);
		expect(text).toContain('From Acme · https://control.old');
		expect(text).toContain('web');
		expect(text).not.toMatch(/exists\s+database/);
		expect(text).toContain('(1 already exist; --all lists them)');
		expect(text).toContain('By hand afterwards (1)');
		expect(text).toContain('Plan: 1 to create, 1 already exist, 1 skipped.');
		expect(renderImport(view, { all: true })).toMatch(/exists\s+database\s+db/);
	});

	test('summarises an apply', () => {
		const text = renderImport({ ...view, mode: 'apply', summary: { planned: 0, done: 1, exists: 1, skipped: 1, failed: 0 } });
		expect(text).toContain('Done: 1 created, 1 already existed, 1 skipped, 0 failed.');
	});
});
