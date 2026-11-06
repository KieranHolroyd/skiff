import { describe, expect, test } from 'bun:test';
import { readMigrations, parseNameStatus, checkMigrations, findDestructiveStatements } from './check-migrations.ts';

const names = (count: number) =>
	Array.from({ length: count }, (_, index) => `${String(index + 1).padStart(4, '0')}_step_${index + 1}.sql`);

describe('migration names', () => {
	test('accepts a sequential, uniquely numbered stream', () => {
		const result = checkMigrations({ names: names(3) });
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.migrations.map((entry) => entry.prefix)).toEqual([1, 2, 3]);
	});

	test('reports duplicate prefixes', () => {
		const result = checkMigrations({
			names: ['0001_init.sql', '0002_a.sql', '0002_b.sql']
		});
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('duplicate migration prefix 0002');
	});

	test('reports a gap', () => {
		const result = checkMigrations({
			names: ['0001_init.sql', '0002_a.sql', '0004_b.sql']
		});
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('expected migration 0003, found 0004');
	});

	test('rejects malformed names', () => {
		const result = checkMigrations({
			names: ['0001_init.sql', 'add_index.sql', '00002_bad.sql']
		});
		expect(result.ok).toBe(false);
		expect(result.errors.filter((error) => error.includes('expected NNNN_'))).toHaveLength(2);
	});
});

describe('changed migrations', () => {
	test('fails when an existing migration was modified or deleted', () => {
		const result = checkMigrations({
			names: names(2),
			changed: [
				{ status: 'M', path: '0001_step_1.sql' },
				{ status: 'D', path: '0002_step_2.sql' }
			]
		});
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('was modified');
		expect(result.errors.join('\n')).toContain('was deleted');
	});

	test('fails when an existing migration was renamed', () => {
		const result = checkMigrations({
			names: ['0001_renamed.sql'],
			changed: [{ status: 'R100', from: '0001_old.sql', path: '0001_renamed.sql' }]
		});
		expect(result.ok).toBe(false);
		expect(result.errors.join('\n')).toContain('0001_old.sql -> 0001_renamed.sql');
		expect(result.errors.join('\n')).toContain('was renamed');
	});

	test('a newly added file is not a history edit', () => {
		const result = checkMigrations({
			names: names(3),
			changed: [{ status: 'A', path: '0003_step_3.sql' }]
		});
		expect(result.ok).toBe(true);
	});

	test('parses name-status output including renames', () => {
		expect(parseNameStatus('M\t0001_a.sql\nD\t0002_b.sql\nR100\t0003_old.sql\t0003_new.sql\n')).toEqual([
			{ status: 'M', path: '0001_a.sql' },
			{ status: 'D', path: '0002_b.sql' },
			{ status: 'R100', from: '0003_old.sql', path: '0003_new.sql' }
		]);
	});
});

describe('destructive statements', () => {
	test('flags DROP TABLE, DROP COLUMN and ALTER COLUMN TYPE', () => {
		const statements = findDestructiveStatements(
			'9999_test.sql',
			[
				'ALTER TABLE nodes DROP COLUMN old_name;',
				'DROP TABLE IF EXISTS obsolete;',
				'ALTER TABLE nodes',
				'  ALTER COLUMN memory TYPE TEXT;'
			].join('\n')
		);
		expect(statements.map((entry) => entry.statement)).toEqual([
			'DROP COLUMN',
			'DROP TABLE',
			'ALTER COLUMN TYPE'
		]);
	});

	test('ignores mentions inside comments', () => {
		const statements = findDestructiveStatements(
			'9999_test.sql',
			[
				'-- Never DROP TABLE in a migration.',
				'/* ALTER COLUMN TYPE is also banned. */',
				'ALTER TABLE nodes ADD COLUMN note TEXT;'
			].join('\n')
		);
		expect(statements).toEqual([]);
	});

	test('warns by default and fails in strict mode', () => {
		const input = {
			names: ['0001_init.sql'],
			contents: { '0001_init.sql': 'DROP TABLE old;' }
		};
		const warned = checkMigrations(input);
		expect(warned.ok).toBe(true);
		expect(warned.warnings.join('\n')).toContain('DROP TABLE needs manual review');

		const strict = checkMigrations(input, { strict: true });
		expect(strict.ok).toBe(false);
		expect(strict.errors.join('\n')).toContain('DROP TABLE needs manual review');
	});

	test('a reviewed migration is a note, even in strict mode', () => {
		const input = {
			names: ['0001_init.sql', '0002_drop.sql'],
			contents: { '0001_init.sql': 'DROP TABLE old;', '0002_drop.sql': 'ALTER TABLE t DROP COLUMN c;' }
		};
		const result = checkMigrations(input, { strict: true, reviewed: { '0002_drop.sql': 'D1: reviewed' } });
		expect(result.notes).toEqual([
			'packages/db/migrations/0002_drop.sql:1: DROP COLUMN (reviewed: D1: reviewed)'
		]);
		// Only the unreviewed file fails.
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('0001_init.sql');
	});
});

describe('repository migrations', () => {
	test('the checked-in stream is sequential and additive', () => {
		const result = checkMigrations(readMigrations(`${import.meta.dir}/..`));
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		// Every destructive statement in the stream is a reviewed exception.
		expect(result.notes.every((note) => note.includes('(reviewed: '))).toBe(true);
		expect(result.migrations[0]?.prefix).toBe(1);
	});
});
