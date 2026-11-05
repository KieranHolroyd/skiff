import { describe, expect, test } from 'bun:test';
import {
	applyStaged,
	blankEntry,
	countChanges,
	draftFromSpec,
	exportEnv,
	payloadOf,
	removeRow,
	replacePlainFromText,
	revertRow,
	stageText,
	stagedIssues
} from './variables-draft.js';

const spec = {
	env: { NODE_ENV: 'production', LOG_LEVEL: 'info' },
	secrets: [{ name: 'API_KEY', delivery: 'env' as const }]
};

describe('variables draft', () => {
	test('a fresh draft has no changes and round-trips the spec', () => {
		const draft = draftFromSpec(spec);
		expect(countChanges(draft).total).toBe(0);
		expect(payloadOf(draft)).toEqual({ ...spec, newSecrets: [] });
	});

	test('removing a saved row keeps it listed until reverted; a new row just goes', () => {
		const draft = draftFromSpec(spec);
		removeRow(draft, draft.plain[0]!);
		expect(draft.plain).toHaveLength(2);
		expect(countChanges(draft)).toMatchObject({ removed: 1, total: 1 });
		expect(payloadOf(draft).env).toEqual({ LOG_LEVEL: 'info' });
		revertRow(draft.plain[0]!);
		expect(countChanges(draft).total).toBe(0);

		applyStaged(draft, [{ ...blankEntry(), key: 'EXTRA', value: '1' }]);
		removeRow(draft, draft.plain.at(-1)!);
		expect(draft.plain).toHaveLength(2);
	});

	test('pasting .env text into a form row spreads it over rows and merges repeats', () => {
		const first = { ...blankEntry(), key: 'A', value: 'old' };
		const target = blankEntry(true);
		const result = stageText([first, target], 'A=new\nB=2\nnot a line\n', target.uid);
		expect(result.imported).toBe(2);
		expect(result.invalidLines).toEqual([3]);
		expect(result.staged.map((entry) => [entry.key, entry.value, entry.secret])).toEqual([
			['A', 'new', false],
			['B', '2', true]
		]);
	});

	test('staged rows explain what they will do and refuse bad secrets', () => {
		const draft = draftFromSpec(spec);
		const rows = [
			{ ...blankEntry(), key: 'NODE_ENV', value: 'staging' },
			{ ...blankEntry(true), key: 'LOG_LEVEL', value: 'debug' },
			{ ...blankEntry(true), key: 'lower', value: 'x' },
			{ ...blankEntry(true), key: 'EMPTY', value: '' },
			{ ...blankEntry(), key: 'DATABASE_URL', value: 'x' }
		];
		const issues = stagedIssues(draft, rows, new Map([['DATABASE_URL', 'main-db']]));
		expect(rows.map((row) => issues.get(row.uid)?.tone)).toEqual([
			'info',
			'info',
			'error',
			'error',
			'warning'
		]);
	});

	test('applying staged rows converts between plain and secret', () => {
		const draft = draftFromSpec(spec);
		applyStaged(draft, [
			{ ...blankEntry(true), key: 'LOG_LEVEL', value: 'debug' },
			{ ...blankEntry(), key: 'API_KEY', value: 'plain-now' },
			{ ...blankEntry(true), key: 'TOKEN', value: 's3cret' }
		]);
		const payload = payloadOf(draft);
		expect(payload.env).toEqual({ NODE_ENV: 'production', API_KEY: 'plain-now' });
		expect(payload.secrets.map((ref) => ref.name)).toEqual(['LOG_LEVEL', 'TOKEN']);
		expect(payload.newSecrets).toEqual([
			{ name: 'LOG_LEVEL', value: 'debug' },
			{ name: 'TOKEN', value: 's3cret' }
		]);
	});

	test('re-adding a removed name restores the saved row instead of duplicating it', () => {
		const draft = draftFromSpec(spec);
		removeRow(draft, draft.plain[0]!);
		applyStaged(draft, [{ ...blankEntry(), key: 'NODE_ENV', value: 'production' }]);
		expect(draft.plain).toHaveLength(2);
		expect(countChanges(draft).total).toBe(0);
	});

	test('the raw editor replaces plain variables and refuses names set by a secret', () => {
		const draft = draftFromSpec(spec);
		expect(replacePlainFromText(draft, 'API_KEY=x')).toContain('set by a secret');
		expect(replacePlainFromText(draft, 'NODE_ENV=production\nNEW=1')).toBeNull();
		expect(payloadOf(draft).env).toEqual({ NODE_ENV: 'production', NEW: '1' });
		expect(countChanges(draft)).toMatchObject({ added: 1, removed: 1 });
	});

	test('export writes plain values and lists secrets as comments', () => {
		const draft = draftFromSpec(spec);
		expect(exportEnv(draft)).toBe(
			'NODE_ENV=production\nLOG_LEVEL=info\n\n# Secrets are encrypted and cannot be exported:\n# API_KEY=\n'
		);
	});
});
