import { describe, expect, test } from 'bun:test';
import { StudioError, schemaChangeSchema, type SchemaChangeInput } from '../../protocol.ts';
import { currentDefaultSql, defaultSql, indexName, renderAlter, stringLiteral, type CurrentColumn } from './ddl.ts';

const table = { path: ['users'], kind: 'table' as const };
const view = { path: ['user_names'], kind: 'view' as const };
const render = (input: SchemaChangeInput, dialect: 'mysql' | 'mariadb' = 'mysql', current?: CurrentColumn) =>
	renderAlter(schemaChangeSchema.parse(input), dialect, current);

function column(overrides: Partial<CurrentColumn> = {}): CurrentColumn {
	return {
		name: 'email',
		dataType: 'varchar',
		columnType: 'varchar(100)',
		nullable: true,
		default: null,
		extra: '',
		comment: '',
		collation: null,
		generation: '',
		json: false,
		...overrides,
	};
}

function code(fn: () => unknown): string | null {
	try {
		fn();
		return null;
	} catch (error) {
		return error instanceof StudioError ? error.code : 'other';
	}
}

describe('literals and defaults', () => {
	test('string literals escape backslashes and quotes, refuse NUL', () => {
		expect(stringLiteral(`it's a \\ path`)).toBe(`'it''s a \\\\ path'`);
		expect(stringLiteral(`\\'; DROP TABLE x; --`)).toBe(`'\\\\''; DROP TABLE x; --'`);
		expect(code(() => stringLiteral('a\u0000b'))).toBe('bad_request');
	});

	test('requested defaults', () => {
		expect(defaultSql({ literal: 'x' })).toBe(`'x'`);
		expect(defaultSql({ literal: 1.5 })).toBe('1.5');
		expect(defaultSql({ literal: true })).toBe('TRUE');
		expect(code(() => defaultSql({ literal: Number.NaN }))).toBe('bad_request');
		expect(defaultSql({ expression: 'CURRENT_TIMESTAMP' })).toBe('CURRENT_TIMESTAMP');
		expect(defaultSql({ expression: 'CURRENT_TIMESTAMP(6)' })).toBe('CURRENT_TIMESTAMP(6)');
		expect(defaultSql({ expression: 'now()' })).toBe('now()');
		expect(defaultSql({ expression: 'uuid()' })).toBe('(uuid())');
		expect(defaultSql({ expression: 'CURRENT_DATE' })).toBe('(CURRENT_DATE)');
		expect(code(() => defaultSql({ expression: 'now()); DROP TABLE x' }))).toBe('bad_request');
	});

	test('MySQL stored defaults: raw literals are quoted, generated ones keep their expression', () => {
		expect(currentDefaultSql(column({ default: "o'k" }), 'mysql')).toBe(`'o''k'`);
		expect(currentDefaultSql(column({ default: '0', dataType: 'int', columnType: 'int' }), 'mysql')).toBe(`'0'`);
		expect(currentDefaultSql(column({ default: null }), 'mysql')).toBeNull();
		expect(
			currentDefaultSql(column({ default: 'CURRENT_TIMESTAMP(3)', extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)' }), 'mysql'),
		).toBe('CURRENT_TIMESTAMP(3)');
		expect(currentDefaultSql(column({ default: 'uuid()', extra: 'DEFAULT_GENERATED' }), 'mysql')).toBe('(uuid())');
		expect(
			currentDefaultSql(column({ default: "concat(_utf8mb4\\'a\\',_utf8mb4\\'b\\')", extra: 'DEFAULT_GENERATED' }), 'mysql'),
		).toBe("(concat(_utf8mb4'a',_utf8mb4'b'))");
		expect(currentDefaultSql(column({ default: "b'101'", dataType: 'bit', columnType: 'bit(3)' }), 'mysql')).toBe("b'101'");
		expect(currentDefaultSql(column({ default: '0x6162', dataType: 'varbinary', columnType: 'varbinary(4)' }), 'mysql')).toBe('0x6162');
	});

	test('MariaDB stored defaults are SQL text; NULL means none', () => {
		expect(currentDefaultSql(column({ default: "'o''k'" }), 'mariadb')).toBe("'o''k'");
		expect(currentDefaultSql(column({ default: 'NULL' }), 'mariadb')).toBeNull();
		expect(currentDefaultSql(column({ default: "'NULL'" }), 'mariadb')).toBe("'NULL'");
		expect(currentDefaultSql(column({ default: 'current_timestamp()' }), 'mariadb')).toBe('current_timestamp()');
		expect(currentDefaultSql(column({ default: '0' }), 'mariadb')).toBe('0');
	});
});

describe('renderAlter', () => {
	test('create-table with identity, defaults and a composite key', () => {
		expect(
			render({
				op: 'create-table',
				name: 'or`ders',
				columns: [
					{ name: 'id', type: 'bigint unsigned', nullable: false, identity: true },
					{ name: 'status', type: "enum('new','paid')", nullable: false, default: { literal: 'new' } },
					{ name: 'created', type: 'datetime(3)', default: { expression: 'CURRENT_TIMESTAMP(3)' } },
				],
				primaryKey: ['id'],
			}),
		).toEqual([
			'CREATE TABLE `or``ders` (\n' +
				'  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n' +
				"  `status` enum('new','paid') NOT NULL DEFAULT 'new',\n" +
				'  `created` datetime(3) NULL DEFAULT CURRENT_TIMESTAMP(3),\n' +
				'  PRIMARY KEY (`id`)\n)',
		]);
	});

	test('create-table refusals', () => {
		const base = { op: 'create-table' as const, name: 't', columns: [{ name: 'a', type: 'int' }] };
		expect(code(() => render({ ...base, parent: ['other'] }))).toBe('bad_request');
		expect(code(() => render({ ...base, primaryKey: ['b'] }))).toBe('bad_request');
		expect(code(() => render({ ...base, columns: [{ name: 'a', type: 'int', identity: true }] }))).toBe('bad_request');
		expect(code(() => render({ ...base, columns: [{ name: 'a', type: 'int' }, { name: 'a', type: 'int' }] }))).toBe(
			'bad_request',
		);
		// Defence in depth: a type that skipped the schema is still refused.
		expect(
			code(() =>
				renderAlter(
					{ op: 'create-table', parent: [], name: 't', primaryKey: [], columns: [{ name: 'a', type: 'int); DROP TABLE x; --', nullable: true, identity: false }] },
					'mysql',
				),
			),
		).toBe('bad_request');
	});

	test('object-level ops', () => {
		expect(render({ op: 'rename', object: table, name: 'people' })).toEqual(['RENAME TABLE `users` TO `people`']);
		expect(render({ op: 'rename', object: view, name: 'v2' })).toEqual(['RENAME TABLE `user_names` TO `v2`']);
		expect(render({ op: 'drop', object: table, cascade: true })).toEqual(['DROP TABLE `users`']);
		expect(render({ op: 'drop', object: view })).toEqual(['DROP VIEW `user_names`']);
		expect(render({ op: 'truncate', object: table })).toEqual(['TRUNCATE TABLE `users`']);
		expect(code(() => render({ op: 'truncate', object: view }))).toBe('bad_request');
		expect(code(() => render({ op: 'create-schema', name: 'x' }))).toBe('unsupported');
		expect(code(() => render({ op: 'create-collection', name: 'x' }))).toBe('unsupported');
		expect(code(() => render({ op: 'drop', object: { path: ['a', 'b'], kind: 'table' } }))).toBe('bad_request');
	});

	test('column ops', () => {
		expect(render({ op: 'add-column', object: table, column: { name: 'age', type: 'int', nullable: false, default: { literal: 0 } } })).toEqual([
			'ALTER TABLE `users` ADD COLUMN `age` int NOT NULL DEFAULT 0',
		]);
		expect(code(() => render({ op: 'add-column', object: table, column: { name: 'n', type: 'int', identity: true } }))).toBe('bad_request');
		expect(code(() => render({ op: 'add-column', object: view, column: { name: 'n', type: 'int' } }))).toBe('bad_request');
		expect(render({ op: 'drop-column', object: table, column: 'age' })).toEqual(['ALTER TABLE `users` DROP COLUMN `age`']);
		expect(render({ op: 'rename-column', object: table, column: 'age', name: 'years' })).toEqual([
			'ALTER TABLE `users` RENAME COLUMN `age` TO `years`',
		]);
	});

	test('alter-column: default-only changes use ALTER COLUMN', () => {
		const current = column();
		expect(render({ op: 'alter-column', object: table, column: 'email', default: { literal: 'a@b' } }, 'mysql', current)).toEqual([
			"ALTER TABLE `users` ALTER COLUMN `email` SET DEFAULT 'a@b'",
		]);
		expect(
			render({ op: 'alter-column', object: table, column: 'email', default: { expression: 'CURRENT_TIMESTAMP(3)' } }, 'mysql', current),
		).toEqual(['ALTER TABLE `users` ALTER COLUMN `email` SET DEFAULT (CURRENT_TIMESTAMP(3))']);
		expect(
			render({ op: 'alter-column', object: table, column: 'email', default: { expression: 'CURRENT_TIMESTAMP(3)' } }, 'mariadb', current),
		).toEqual(['ALTER TABLE `users` ALTER COLUMN `email` SET DEFAULT CURRENT_TIMESTAMP(3)']);
		expect(render({ op: 'alter-column', object: table, column: 'email', default: null }, 'mysql', current)).toEqual([
			'ALTER TABLE `users` ALTER COLUMN `email` DROP DEFAULT',
		]);
		// Same type and nullability as now: still only the default.
		expect(
			render({ op: 'alter-column', object: table, column: 'email', type: 'VARCHAR(100)', nullable: true, default: null }, 'mysql', current),
		).toEqual(['ALTER TABLE `users` ALTER COLUMN `email` DROP DEFAULT']);
		expect(code(() => render({ op: 'alter-column', object: table, column: 'email' }, 'mysql', current))).toBe('bad_request');
		expect(code(() => render({ op: 'alter-column', object: table, column: 'email', nullable: false }, 'mysql'))).toBe('not_found');
	});

	test('alter-column: MODIFY keeps default, ON UPDATE, AUTO_INCREMENT, invisibility, comment and collation', () => {
		const current = column({
			dataType: 'datetime',
			columnType: 'datetime(3)',
			default: 'CURRENT_TIMESTAMP(3)',
			extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3) INVISIBLE',
			comment: "it's",
		});
		expect(render({ op: 'alter-column', object: table, column: 'email', nullable: false }, 'mysql', current)).toEqual([
			"ALTER TABLE `users` MODIFY COLUMN `email` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) INVISIBLE COMMENT 'it''s'",
		]);
		// A default-only change on an ON UPDATE column is a MODIFY too (MariaDB would drop ON UPDATE).
		expect(render({ op: 'alter-column', object: table, column: 'email', default: null }, 'mariadb', current)).toEqual([
			"ALTER TABLE `users` MODIFY COLUMN `email` datetime(3) NULL ON UPDATE CURRENT_TIMESTAMP(3) INVISIBLE COMMENT 'it''s'",
		]);
		const text = column({ default: 'x', collation: 'utf8mb4_bin' });
		expect(render({ op: 'alter-column', object: table, column: 'email', nullable: false }, 'mysql', text)).toEqual([
			"ALTER TABLE `users` MODIFY COLUMN `email` varchar(100) COLLATE utf8mb4_bin NOT NULL DEFAULT 'x'",
		]);
		// A new type drops the old collation (it may not apply) but keeps the default.
		expect(render({ op: 'alter-column', object: table, column: 'email', type: 'varchar(200)' }, 'mysql', text)).toEqual([
			"ALTER TABLE `users` MODIFY COLUMN `email` varchar(200) NULL DEFAULT 'x'",
		]);
		const id = column({ dataType: 'int', columnType: 'int', nullable: false, extra: 'auto_increment' });
		expect(render({ op: 'alter-column', object: table, column: 'email', type: 'bigint' }, 'mysql', id)).toEqual([
			'ALTER TABLE `users` MODIFY COLUMN `email` bigint NOT NULL AUTO_INCREMENT',
		]);
		// A requested default replaces the stored one.
		expect(
			render({ op: 'alter-column', object: table, column: 'email', nullable: false, default: { literal: 'y' } }, 'mysql', text),
		).toEqual(["ALTER TABLE `users` MODIFY COLUMN `email` varchar(100) COLLATE utf8mb4_bin NOT NULL DEFAULT 'y'"]);
	});

	test('alter-column on MariaDB keeps SQL defaults verbatim and JSON as json', () => {
		const current = column({ default: "'o''k'", extra: '' });
		expect(render({ op: 'alter-column', object: table, column: 'email', nullable: false }, 'mariadb', current)).toEqual([
			"ALTER TABLE `users` MODIFY COLUMN `email` varchar(100) NOT NULL DEFAULT 'o''k'",
		]);
		const ts = column({ dataType: 'timestamp', columnType: 'timestamp', default: 'current_timestamp()', extra: 'on update current_timestamp()' });
		expect(render({ op: 'alter-column', object: table, column: 'email', nullable: false }, 'mariadb', ts)).toEqual([
			'ALTER TABLE `users` MODIFY COLUMN `email` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()',
		]);
		const json = column({ dataType: 'longtext', columnType: 'longtext', json: true, collation: 'utf8mb4_bin' });
		expect(render({ op: 'alter-column', object: table, column: 'email', nullable: false }, 'mariadb', json)).toEqual([
			'ALTER TABLE `users` MODIFY COLUMN `email` json NOT NULL',
		]);
	});

	test('alter-column refuses generated columns', () => {
		const generated = column({ generation: 'concat(a, b)', extra: 'VIRTUAL GENERATED' });
		expect(code(() => render({ op: 'alter-column', object: table, column: 'email', nullable: false }, 'mysql', generated))).toBe(
			'bad_request',
		);
	});

	test('indexes', () => {
		expect(
			render({ op: 'create-index', object: table, columns: [{ name: 'email' }, { name: 'created', dir: 'desc' }], unique: true }),
		).toEqual(['CREATE UNIQUE INDEX `users_email_created_idx` ON `users` (`email`, `created` DESC)']);
		expect(render({ op: 'create-index', object: table, name: 'by_email', columns: [{ name: 'email' }] })).toEqual([
			'CREATE INDEX `by_email` ON `users` (`email`)',
		]);
		expect(render({ op: 'drop-index', object: table, name: 'by_email' })).toEqual(['DROP INDEX `by_email` ON `users`']);
		const long = indexName('t'.repeat(50), ['c'.repeat(30)]);
		expect(long.length).toBe(64);
		expect(long.endsWith('_idx')).toBe(true);
	});
});
