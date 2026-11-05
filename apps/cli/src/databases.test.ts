import { describe, expect, test } from 'bun:test';
import { UsageError } from './errors.ts';
import {
	assertEnvPrefix,
	databaseDetails,
	databaseTable,
	parseMegabytes,
	sizeVsBudget,
	topTables,
	type DatabaseTableStat,
	type DatabaseView,
} from './databases.ts';

function databaseView(overrides: Partial<DatabaseView> = {}): DatabaseView {
	return {
		id: 'db_0123456789abcdef0123456789abcdef',
		name: 'main',
		engine: 'postgres',
		engineLabel: 'PostgreSQL',
		version: '17',
		status: 'running',
		message: null,
		nodeId: 'node_home',
		nodeName: 'homelab',
		memoryMb: 256,
		cpus: 1,
		storageMb: 10_240,
		sizeBytes: 1024 * 1024 * 1024,
		databaseName: 'main',
		username: 'main',
		internalHost: { process: '127.0.0.1:15432', container: 'db-0123456789abcdef0123456789abcdef:5432' },
		attachments: [],
		tables: [],
		statsAt: null,
		createdAt: '2026-11-04T10:00:00.000Z',
		updatedAt: '2026-11-04T10:00:00.000Z',
		deletedAt: null,
		purgeAt: null,
		...overrides,
	};
}

function table(name: string, totalBytes: number): DatabaseTableStat {
	return {
		schema: 'public',
		name,
		rows: 1200,
		totalBytes,
		seqScans: 3,
		idxScans: 4500,
		lastAutovacuum: null,
		lastAutoanalyze: null,
	};
}

describe('parseMegabytes', () => {
	test('plain numbers are MB; M and G units are accepted', () => {
		expect(parseMegabytes('512', '--memory')).toBe(512);
		expect(parseMegabytes('512M', '--memory')).toBe(512);
		expect(parseMegabytes('10G', '--storage')).toBe(10_240);
		expect(parseMegabytes('1.5GiB', '--storage')).toBe(1536);
	});

	test('rejects junk and fractional megabytes', () => {
		expect(() => parseMegabytes('lots', '--memory')).toThrow(UsageError);
		expect(() => parseMegabytes('0', '--memory')).toThrow(UsageError);
		expect(() => parseMegabytes('1.5', '--memory')).toThrow('whole number');
	});
});

describe('assertEnvPrefix', () => {
	test('accepts UPPER_SNAKE and rejects the rest', () => {
		expect(() => assertEnvPrefix('DATABASE')).not.toThrow();
		expect(() => assertEnvPrefix('ANALYTICS_DB')).not.toThrow();
		expect(() => assertEnvPrefix('database')).toThrow(UsageError);
		expect(() => assertEnvPrefix('DB_')).toThrow(UsageError);
		expect(() => assertEnvPrefix('1DB')).toThrow(UsageError);
	});
});

describe('formatting', () => {
	test('size vs budget, with and without a sample', () => {
		expect(sizeVsBudget({ sizeBytes: 1024 * 1024 * 1024, storageMb: 10_240 })).toBe('1.0 GiB / 10 GiB (10%)');
		expect(sizeVsBudget({ sizeBytes: null, storageMb: 10_240 })).toBe('- / 10 GiB');
	});

	test('list table shows trashed databases as deleted', () => {
		const out = databaseTable([
			databaseView({ attachments: [attachment('api')] }),
			databaseView({ name: 'old', deletedAt: '2026-11-03T00:00:00.000Z' }),
		]);
		expect(out).toContain('PostgreSQL 17');
		expect(out).toMatch(/main\s+running/);
		expect(out).toMatch(/old\s+deleted/);
		expect(out).toContain('api');
	});

	test('top tables are the largest first', () => {
		const tables = [table('small', 10), table('big', 1000), table('mid', 100)];
		expect(topTables(tables, 2).map((item) => item.name)).toEqual(['big', 'mid']);
	});

	test('details include node, size vs budget, attachments and top tables', () => {
		const out = databaseDetails(
			databaseView({
				attachments: [attachment('api')],
				tables: [table('users', 8 * 1024 * 1024), table('events', 64 * 1024 * 1024)],
				statsAt: '2026-11-04T11:55:00.000Z',
			}),
			{ tables: 1 },
		);
		expect(out).toContain('homelab (node_home)');
		expect(out).toContain('1.0 GiB / 10 GiB (10%)');
		expect(out).toMatch(/api\s+DATABASE\s+DATABASE_URL, DATABASE_HOST/);
		expect(out).toContain('public.events');
		expect(out).not.toContain('public.users');
		expect(out).toContain('…and 1 more table');
	});

	test('details explain a missing snapshot and the trash', () => {
		const out = databaseDetails(databaseView({ deletedAt: '2026-11-03T00:00:00.000Z', purgeAt: '2026-11-10T00:00:00.000Z' }));
		expect(out).toContain('no snapshot yet');
		expect(out).toMatch(/Status\s+deleted/);
		expect(out).toContain('Purges');
	});
});

function attachment(projectSlug: string) {
	return {
		databaseId: 'db_0123456789abcdef0123456789abcdef',
		databaseName: 'main',
		projectId: `prj_${projectSlug}`,
		projectSlug,
		envPrefix: 'DATABASE',
		envNames: ['DATABASE_URL', 'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME'],
		createdAt: '2026-11-04T10:00:00.000Z',
	};
}
