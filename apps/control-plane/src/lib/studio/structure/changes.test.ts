import { describe, expect, test } from 'bun:test';
import { schemaChangeSchema, type Column, type ObjectRef, type StudioInfo } from '@yoal/studio/protocol';
import {
	canAlter,
	columnEditChanges,
	columnSpec,
	confirmPhrase,
	editDraft,
	emptyColumn,
	indexChange,
	renamedNode,
	renamedPath,
	starterColumns,
	structureOps,
	suggestedIndexName,
	tableChange
} from './changes.js';

const table: ObjectRef = { path: ['public', 'items'], kind: 'table' };

function info(structure: string[] | undefined, readOnly = false): Pick<StudioInfo, 'readOnly' | 'capabilities'> {
	return {
		readOnly,
		capabilities: {
			family: 'relational',
			language: 'sql',
			dialect: 'postgres',
			edit: 'primary-key',
			cancel: 'native',
			explain: true,
			schemas: true,
			structure: structure as StudioInfo['capabilities']['structure']
		}
	};
}

describe('structureOps', () => {
	test('offers the declared ops on a write session', () => {
		expect(canAlter(info(['drop', 'rename']), 'drop')).toBe(true);
		expect(canAlter(info(['drop', 'rename']), 'truncate')).toBe(false);
	});
	test('offers nothing read-only or from an older node', () => {
		expect(structureOps(info(['drop'], true)).size).toBe(0);
		expect(structureOps(info(undefined)).size).toBe(0);
	});
});

describe('renames', () => {
	test('replaces the last path element', () => {
		expect(renamedPath(['public', 'items'], 'table', 'things')).toEqual(['public', 'things']);
		expect(renamedPath(['orders'], 'collection', 'sales')).toEqual(['sales']);
	});
	test('a renamed key sits directly under its keyspace', () => {
		expect(renamedPath(['0', 'user:', 'user:1'], 'key', 'member:1')).toEqual(['0', 'member:1']);
		const node = renamedNode({ path: ['0', 'a'], name: 'a', kind: 'key', hasChildren: false, browsable: true }, 'b');
		expect(node).toMatchObject({ path: ['0', 'b'], name: 'b' });
	});
});

describe('confirmPhrase', () => {
	test('destructive changes are confirmed with the name they destroy', () => {
		expect(confirmPhrase({ op: 'drop', object: table })).toBe('items');
		expect(confirmPhrase({ op: 'truncate', object: table })).toBe('items');
		expect(confirmPhrase({ op: 'drop-column', object: table, column: 'price' })).toBe('price');
		expect(confirmPhrase({ op: 'drop-index', object: table, name: 'items_name_idx' })).toBe('items_name_idx');
		expect(confirmPhrase({ op: 'rename', object: table, name: 'x' })).toBeNull();
	});
});

describe('columnSpec', () => {
	test('builds a spec the protocol accepts', () => {
		const spec = columnSpec({ ...emptyColumn(), name: ' price ', type: 'numeric(10,2)', defaultMode: 'literal', defaultText: '0' });
		expect(spec).toEqual({ ok: true, value: { name: 'price', type: 'numeric(10,2)', nullable: true, identity: false, default: { literal: '0' } } });
		if (spec.ok) expect(schemaChangeSchema.safeParse({ op: 'add-column', object: table, column: spec.value }).success).toBe(true);
	});
	test('refuses bad types and expressions early', () => {
		expect(columnSpec({ ...emptyColumn(), name: 'x', type: 'int; drop table y' }).ok).toBe(false);
		expect(columnSpec({ ...emptyColumn(), name: 'x', type: 'int', defaultMode: 'expression', defaultText: "now() || 'x'" }).ok).toBe(false);
		expect(columnSpec({ ...emptyColumn(), name: '', type: 'int' }).ok).toBe(false);
	});
	test('identity columns are not null and have no default', () => {
		const spec = columnSpec({ ...emptyColumn(), name: 'id', type: 'bigint', identity: true });
		expect(spec.ok && spec.value.nullable).toBe(false);
		expect(columnSpec({ ...emptyColumn(), name: 'id', type: 'bigint', identity: true, defaultMode: 'literal', defaultText: '1' }).ok).toBe(false);
	});
});

describe('columnEditChanges', () => {
	const column: Column = { name: 'name', nativeType: 'character varying(32)', kind: 'text', nullable: true, default: "'x'::character varying" };

	test('nothing changed, nothing to run', () => {
		expect(columnEditChanges(table, column, editDraft(column))).toEqual({ ok: true, value: [] });
	});
	test('type comparison ignores case and spacing', () => {
		const draft = { ...editDraft(column), type: 'Character  Varying(32)' };
		expect(columnEditChanges(table, column, draft)).toEqual({ ok: true, value: [] });
	});
	test('alters on the old name, then renames', () => {
		const draft = { ...editDraft(column), name: 'title', type: 'text', nullable: false, defaultMode: 'none' as const };
		const result = columnEditChanges(table, column, draft);
		expect(result).toEqual({
			ok: true,
			value: [
				{ op: 'alter-column', object: table, column: 'name', type: 'text', nullable: false, default: null },
				{ op: 'rename-column', object: table, column: 'name', name: 'title' }
			]
		});
		if (result.ok) for (const change of result.value) expect(schemaChangeSchema.safeParse(change).success).toBe(true);
	});
	test('dropping a default the column lacks changes nothing', () => {
		const bare = { ...column, default: null };
		expect(columnEditChanges(table, bare, { ...editDraft(bare), defaultMode: 'none' })).toEqual({ ok: true, value: [] });
	});
	test('sets an expression default', () => {
		const draft = { ...editDraft(column), defaultMode: 'expression' as const, defaultText: 'CURRENT_USER' };
		expect(columnEditChanges(table, column, draft)).toEqual({
			ok: true,
			value: [{ op: 'alter-column', object: table, column: 'name', default: { expression: 'CURRENT_USER' } }]
		});
	});
});

describe('tableChange', () => {
	test('a starter table is valid and its key columns are not null', () => {
		const result = tableChange({
			parent: ['public'],
			name: 'things',
			columns: [...starterColumns('postgres'), { ...emptyColumn(), name: 'label', type: 'text' }],
			primaryKey: ['id']
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.primaryKey).toEqual(['id']);
		expect(result.value.columns[0]).toMatchObject({ name: 'id', identity: true, nullable: false });
		expect(schemaChangeSchema.safeParse(result.value).success).toBe(true);
	});
	test('refuses duplicate columns and drops unknown key columns', () => {
		const twice = { ...emptyColumn(), name: 'a', type: 'int' };
		expect(tableChange({ parent: [], name: 't', columns: [twice, twice], primaryKey: [] }).ok).toBe(false);
		const result = tableChange({ parent: [], name: 't', columns: [twice], primaryKey: ['gone'] });
		expect(result.ok && result.value.primaryKey).toEqual([]);
	});
	test('needs a name and a column', () => {
		expect(tableChange({ parent: [], name: ' ', columns: starterColumns('mysql'), primaryKey: [] }).ok).toBe(false);
		expect(tableChange({ parent: [], name: 't', columns: [], primaryKey: [] }).ok).toBe(false);
	});
});

describe('indexChange', () => {
	test('leaves the name to the engine when empty', () => {
		const result = indexChange(table, { name: ' ', columns: [{ name: 'a', dir: 'asc' }, { name: '', dir: 'asc' }], unique: true });
		expect(result).toEqual({ ok: true, value: { op: 'create-index', object: table, columns: [{ name: 'a', dir: 'asc' }], unique: true } });
	});
	test('refuses no columns or a repeated column', () => {
		expect(indexChange(table, { name: '', columns: [], unique: false }).ok).toBe(false);
		expect(indexChange(table, { name: '', columns: [{ name: 'a', dir: 'asc' }, { name: 'a', dir: 'desc' }], unique: false }).ok).toBe(false);
	});
	test('suggests a conventional name', () => {
		expect(suggestedIndexName('items', ['name', 'created at'], false)).toBe('items_name_created_at_idx');
		expect(suggestedIndexName('items', ['email'], true)).toBe('items_email_key');
	});
});
