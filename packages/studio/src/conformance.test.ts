import { describeConformance } from './conformance.ts';
import { FAKE_ROW_COUNT, fakePlugin } from './fake.ts';

describeConformance({
	name: 'fake',
	plugin: fakePlugin,
	target: {
		engine: 'postgres',
		version: '17',
		host: '127.0.0.1',
		port: 5432,
		database: 'app',
		user: 'app',
		password: 'pw',
		tls: null,
	},
	fixture: {
		object: { path: ['public', 'items'], kind: 'table' },
		rowCount: FAKE_ROW_COUNT,
		keyColumns: ['id'],
		editableColumn: 'name',
		selectAllInput: 'select * from items',
		slowInput: 'sleep 10000',
		writeInput: 'delete from items',
		readOnlyEscapes: ['delete from items; select count'],
		scratchCreate: {
			op: 'create-table',
			parent: ['public'],
			name: 'conformance_scratch',
			columns: [{ name: 'id', type: 'integer', nullable: false, identity: false }],
			primaryKey: ['id'],
		},
	},
});
