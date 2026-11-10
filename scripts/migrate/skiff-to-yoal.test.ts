import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	migrateEnvText,
	migrateHost,
	migratePath,
	migratePathText,
	migrateUnitText,
	rollback,
	type Manifest,
} from './skiff-to-yoal.ts';

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'skiff-to-yoal-'));
	roots.push(root);
	return root;
}

function put(root: string, path: string, body = ''): void {
	const full = join(root, path.replace(/^\//, ''));
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body);
}

function link(root: string, path: string, target: string): void {
	const full = join(root, path.replace(/^\//, ''));
	mkdirSync(dirname(full), { recursive: true });
	symlinkSync(target, full);
}

function read(root: string, path: string): string {
	return readFileSync(join(root, path.replace(/^\//, '')), 'utf8');
}

function exist(root: string, path: string): boolean {
	return existsSync(join(root, path.replace(/^\//, '')));
}

function isLink(root: string, path: string): boolean {
	try {
		return lstatSync(join(root, path.replace(/^\//, ''))).isSymbolicLink();
	} catch {
		return false;
	}
}

describe('text conversion', () => {
	test('maps host paths without touching domains', () => {
		expect(migratePath('/opt/skiff/current')).toBe('/opt/yoal/current');
		expect(migratePath('/var/lib/skiff-update/channel')).toBe('/var/lib/yoal-update/channel');
		expect(migratePath('/var/lib/skiff-workloads/wld_1.sock')).toBe('/var/lib/yoal-workloads/wld_1.sock');
		expect(migratePath('/usr/local/sbin/skiff-update-self')).toBe('/usr/local/sbin/yoal-update-self');
		expect(migratePath('/etc/systemd/system/skiff-agent.service')).toBe('/etc/systemd/system/yoal-agent.service');
		expect(migratePath('/var/lib/skiff')).toBe('/var/lib/yoal');
		expect(migratePath('https://skiff.example.com')).toBe('https://skiff.example.com');
	});

	test('rewrites paths inside systemd/Caddy syntax', () => {
		expect(migratePathText('reverse_proxy unix//run/skiff/control.sock')).toBe(
			'reverse_proxy unix//run/yoal/control.sock',
		);
		expect(migratePathText('EnvironmentFile=/etc/skiff/skiff.env')).toBe('EnvironmentFile=/etc/yoal/yoal.env');
		expect(migratePathText('path: ${SKIFF_DATA_DIR}/skiff.db')).toBe('path: ${SKIFF_DATA_DIR}/yoal.db');
		expect(migratePathText('KieranHolroyd/skiff')).toBe('KieranHolroyd/yoal');
	});

	test('renames unit identifiers and accounts', () => {
		const unit = [
			'[Service]',
			'User=skiff',
			'Group=skiff',
			'SupplementaryGroups=skiff-caddy',
			'EnvironmentFile=/etc/skiff/skiff.env',
			'ExecStart=/opt/skiff/current/agent/skiff-agent',
			'After=skiff-clickhouse.service',
			'Environment=SKIFF_DATA_DIR=/var/lib/skiff/data',
		].join('\n');
		const migrated = migrateUnitText(unit);
		expect(migrated).toContain('User=yoal');
		expect(migrated).toContain('Group=yoal');
		expect(migrated).toContain('SupplementaryGroups=yoal-caddy');
		expect(migrated).toContain('EnvironmentFile=/etc/yoal/yoal.env');
		expect(migrated).toContain('ExecStart=/opt/yoal/current/agent/yoal-agent');
		expect(migrated).toContain('After=yoal-clickhouse.service');
		expect(migrated).toContain('Environment=YOAL_DATA_DIR=/var/lib/yoal/data');
	});

	test('maps env keys and path values but not user domains', () => {
		const env = [
			'# converted by hand',
			'SKIFF_PLATFORM_ORIGIN=https://skiff.example.com',
			'SKIFF_DATA_DIR=/var/lib/skiff/data',
			'SKIFF_SMTP_FROM="Skiff <noreply@skiff.example.com>"',
			'SKIFF_CLICKHOUSE_DATABASE=skiff',
			'SKIFF_CLICKHOUSE_USER=skiff',
			'SKIFF_CLICKHOUSE_READER_USER=skiff_reader',
			'SKIFF_BUILDER_USER=skiff-build',
			'SKIFF_HELPER_CONTROL_SOCKET_GROUP=skiff',
		].join('\n');
		const migrated = migrateEnvText(env);
		expect(migrated).toContain('# converted by hand');
		expect(migrated).toContain('YOAL_PLATFORM_ORIGIN=https://skiff.example.com');
		expect(migrated).toContain('YOAL_DATA_DIR=/var/lib/yoal/data');
		expect(migrated).toContain('YOAL_SMTP_FROM="Yoal <noreply@skiff.example.com>"');
		expect(migrated).toContain('YOAL_CLICKHOUSE_DATABASE=yoal');
		expect(migrated).toContain('YOAL_CLICKHOUSE_USER=yoal');
		expect(migrated).toContain('YOAL_CLICKHOUSE_READER_USER=yoal_reader');
		expect(migrated).toContain('YOAL_BUILDER_USER=yoal-build');
		expect(migrated).toContain('YOAL_HELPER_CONTROL_SOCKET_GROUP=yoal');
	});
});

describe('host conversion', () => {
	test('dry-run changes nothing', () => {
		const root = tempRoot();
		put(root, '/opt/skiff/current/meta.json', '{}');
		put(root, '/etc/skiff/skiff.env', 'SKIFF_DATA_DIR=/var/lib/skiff/data\n');
		const result = migrateHost({ root, dryRun: true, log: () => {} });
		expect(result.alreadyConverted).toBe(false);
		expect(result.backupDir).toBeNull();
		expect(exist(root, '/opt/skiff')).toBe(true);
		expect(exist(root, '/opt/yoal')).toBe(false);
		expect(exist(root, '/etc/yoal')).toBe(false);
	});

	test('moves a control-plane host to the Yoal names', () => {
		const root = tempRoot();
		// Release tree and symlink.
		put(root, '/opt/skiff/releases/v0.1.0/agent/skiff-agent', 'agent');
		link(root, '/opt/skiff/releases/v0.1.0/agent/skiff-builder', 'skiff-agent');
		link(root, '/opt/skiff/releases/v0.1.0/agent/skiff-storage', 'skiff-agent');
		put(root, '/opt/skiff/releases/v0.1.0/helper/skiff-helper', 'helper');
		put(root, '/opt/skiff/releases/v0.1.0/cli/skif.js', 'cli');
		put(root, '/opt/skiff/runtime/bin/bun', 'bun');
		link(root, '/opt/skiff/current', '/opt/skiff/releases/v0.1.0');
		put(root, '/opt/skiff/update-state.json', '{"repo":"KieranHolroyd/skiff","path":"/opt/skiff/current"}');
		link(root, '/opt/skiff/runtime/bin/bunx', '/opt/skiff/runtime/bin/bun');

		// Config and secrets.
		put(root, '/etc/skiff/skiff.env', [
			'SKIFF_PLATFORM_ORIGIN=https://skiff.example.com',
			'SKIFF_DATA_DIR=/var/lib/skiff/data',
			'SKIFF_SMTP_FROM="Skiff <noreply@skiff.example.com>"',
			'SKIFF_SITE_COOKIE_SECRET=abc',
		].join('\n'));
		put(root, '/etc/skiff/agent.env', 'SKIFF_NODE_ID=nod_1\nSKIFF_DATA_DIR=/var/lib/skiff/agent\n');
		put(root, '/etc/skiff/master.key', 'secret');
		put(root, '/etc/skiff/clickhouse/users.xml', '<name>skiff</name><query>GRANT ALL ON skiff.*</query>');

		// Data and database.
		put(root, '/var/lib/skiff/data/objects/abc', 'object');
		put(root, '/var/lib/skiff-update/channel', 'canary\n');
		const db = new Database(join(root, 'var/lib/skiff/data/skiff.db'), { create: true });
		db.run('CREATE TABLE user (id TEXT PRIMARY KEY)');
		db.run("INSERT INTO user (id) VALUES ('usr_1')");
		db.run('CREATE TABLE skiff_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
		db.run("INSERT INTO skiff_migrations (id, applied_at) VALUES ('0001_init', 1)");
		db.close();

		// ClickHouse metadata uses the old database name.
		put(root, '/var/lib/skiff/clickhouse/data/metadata/skiff.sql', 'ATTACH DATABASE _ UUID \'x\' ENGINE = Atomic');
		put(root, '/var/lib/skiff/clickhouse/data/metadata/skiff/t.sql', 'ATTACH TABLE _');
		put(root, '/var/lib/skiff/clickhouse/data/data/skiff/t.bin', 'telemetry');

		// Units, drop-ins, want links and workload/Quadlet files.
		put(root, '/etc/systemd/system/skiff-control-plane.service', '[Service]\nUser=skiff\nGroup=skiff\nSupplementaryGroups=skiff-caddy\nEnvironmentFile=/etc/skiff/skiff.env\nExecStart=/opt/skiff/current/control-plane/runtime/bun /opt/skiff/current/control-plane/build/index.js\n');
		put(root, '/etc/systemd/system/skiff-control-plane.service.d/skiff-master-key.conf', '[Service]\nLoadCredential=master-key:/etc/skiff/master.key\n');
		link(root, '/etc/systemd/system/multi-user.target.wants/skiff-control-plane.service', '/etc/systemd/system/skiff-control-plane.service');
		put(root, '/etc/systemd/system/skiff-workload-wld_1.service', '[Service]\nExecStart=/run/skiff-workloads/wld_1.sock\n');
		put(root, '/etc/containers/systemd/skiff-workload-wld_1.container', '[Container]\nContainerName=skiff-workload-wld_1\nVolume=/var/lib/skiff-workloads/wld_1:/data\n');

		// Caddy, tmpfiles, logs and wrapper commands.
		put(root, '/etc/caddy/Caddyfile', 'admin unix//var/lib/caddy/admin.sock\nreverse_proxy unix//run/skiff/control.sock\n');
		put(root, '/etc/caddy/skiff.Caddyfile', 'reverse_proxy unix//run/skiff/control.sock\n');
		put(root, '/etc/tmpfiles.d/skiff.conf', 'd /run/skiff 2770 root caddy -\n');
		put(root, '/var/log/caddy/skiff-access.log', '{}\n');
		put(root, '/usr/local/sbin/skiff-update-self', '#!/bin/sh\nexec /opt/skiff/runtime/bin/bun /opt/skiff/current/repo/scripts/update-self/main.ts "$@"\n');
		put(root, '/usr/local/lib/skiff-updater/current/skiff-updated', 'binary');
		put(root, '/mnt/skiff-shares/share1/file', 'shared');

		const manifestPath = join(root, 'var/backups/test/manifest.json');
		const result = migrateHost({
			root,
			dryRun: false,
			yes: true,
			backupDir: join(root, 'var/backups/test'),
			log: () => {},
		});

		expect(result.alreadyConverted).toBe(false);
		expect(exist(root, '/opt/skiff')).toBe(false);
		expect(exist(root, '/opt/yoal/releases/v0.1.0/agent/yoal-agent')).toBe(true);
		expect(exist(root, '/opt/yoal/releases/v0.1.0/helper/yoal-helper')).toBe(true);
		expect(exist(root, '/opt/yoal/releases/v0.1.0/cli/yoal.js')).toBe(true);
		expect(readlinkSync(join(root, 'opt/yoal/releases/v0.1.0/agent/yoal-builder'))).toBe('yoal-agent');
		expect(readlinkSync(join(root, 'opt/yoal/releases/v0.1.0/agent/yoal-storage'))).toBe('yoal-agent');
		expect(readlinkSync(join(root, 'opt/yoal/current'))).toBe('/opt/yoal/releases/v0.1.0');
		expect(readlinkSync(join(root, 'opt/yoal/runtime/bin/bunx'))).toBe('/opt/yoal/runtime/bin/bun');
		expect(read(root, '/opt/yoal/update-state.json')).toContain('KieranHolroyd/yoal');

		expect(exist(root, '/etc/skiff')).toBe(false);
		expect(exist(root, '/etc/yoal/skiff.env')).toBe(false);
		const env = read(root, '/etc/yoal/yoal.env');
		expect(env).toContain('YOAL_PLATFORM_ORIGIN=https://skiff.example.com');
		expect(env).toContain('YOAL_DATA_DIR=/var/lib/yoal/data');
		expect(env).toContain('YOAL_SMTP_FROM="Yoal <noreply@skiff.example.com>"');
		expect(read(root, '/etc/yoal/agent.env')).toContain('YOAL_NODE_ID=nod_1');
		expect(read(root, '/etc/yoal/clickhouse/users.xml')).toContain('yoal');
		expect(exist(root, '/etc/yoal/master.key')).toBe(true);

		expect(exist(root, '/var/lib/skiff')).toBe(false);
		expect(exist(root, '/var/lib/yoal/data/skiff.db')).toBe(false);
		expect(exist(root, '/var/lib/yoal/data/objects/abc')).toBe(true);
		const migrated = new Database(join(root, 'var/lib/yoal/data/yoal.db'), { readonly: true });
		expect(migrated.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'yoal_migrations'").get()).toBeTruthy();
		expect(migrated.query('SELECT COUNT(*) AS n FROM yoal_migrations').get()).toEqual({ n: 1 });
		expect(migrated.query('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 1 });
		migrated.close();
		expect(read(root, '/var/lib/yoal-update/channel')).toBe('canary\n');

		expect(exist(root, '/var/lib/yoal/clickhouse/data/metadata/yoal.sql')).toBe(true);
		expect(exist(root, '/var/lib/yoal/clickhouse/data/metadata/yoal/t.sql')).toBe(true);
		expect(exist(root, '/var/lib/yoal/clickhouse/data/data/yoal/t.bin')).toBe(true);

		expect(exist(root, '/etc/systemd/system/skiff-control-plane.service')).toBe(false);
		const unit = read(root, '/etc/systemd/system/yoal-control-plane.service');
		expect(unit).toContain('User=yoal');
		expect(unit).toContain('EnvironmentFile=/etc/yoal/yoal.env');
		expect(read(root, '/etc/systemd/system/yoal-control-plane.service.d/yoal-master-key.conf')).toContain('/etc/yoal/master.key');
		expect(isLink(root, '/etc/systemd/system/multi-user.target.wants/yoal-control-plane.service')).toBe(true);
		expect(isLink(root, '/etc/systemd/system/multi-user.target.wants/skiff-control-plane.service')).toBe(false);
		expect(read(root, '/etc/systemd/system/yoal-workload-wld_1.service')).toContain('/run/yoal-workloads/wld_1.sock');
		const quadlet = read(root, '/etc/containers/systemd/yoal-workload-wld_1.container');
		expect(quadlet).toContain('ContainerName=yoal-workload-wld_1');
		expect(quadlet).toContain('/var/lib/yoal-workloads/wld_1');

		expect(read(root, '/etc/caddy/Caddyfile')).toContain('unix//run/yoal/control.sock');
		expect(exist(root, '/etc/caddy/yoal.Caddyfile')).toBe(true);
		expect(read(root, '/etc/tmpfiles.d/yoal.conf')).toContain('/run/yoal');
		expect(exist(root, '/var/log/caddy/yoal-access.log')).toBe(true);
		expect(read(root, '/usr/local/sbin/yoal-update-self')).toContain('/opt/yoal');
		expect(exist(root, '/usr/local/lib/yoal-updater/current/yoal-updated')).toBe(true);
		expect(exist(root, '/mnt/yoal-shares/share1/file')).toBe(true);

		expect(existsSync(manifestPath)).toBe(true);
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
		expect(manifest.renames.some((rename) => rename.from === '/opt/skiff' && rename.to === '/opt/yoal')).toBe(true);
	});

	test('rolls the conversion back from its manifest', () => {
		const root = tempRoot();
		put(root, '/opt/skiff/releases/v1/agent/skiff-agent', 'agent');
		link(root, '/opt/skiff/current', '/opt/skiff/releases/v1');
		put(root, '/etc/skiff/skiff.env', 'SKIFF_DATA_DIR=/var/lib/skiff/data\n');
		put(root, '/etc/systemd/system/skiff-agent.service', '[Service]\nUser=skiff\n');
		mkdirSync(join(root, 'var/lib/skiff/data'), { recursive: true });
		const db = new Database(join(root, 'var/lib/skiff/data/skiff.db'), { create: true });
		db.run('CREATE TABLE user (id TEXT PRIMARY KEY)');
		db.run("INSERT INTO user (id) VALUES ('usr_1')");
		db.run('CREATE TABLE skiff_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
		db.close();

		const backupDir = join(root, 'var/backups/test');
		migrateHost({ root, dryRun: false, yes: true, backupDir, log: () => {} });
		const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as Manifest;
		rollback(manifest, { root, run: () => ({ code: 0, stdout: '', stderr: '' }), log: () => {} });

		expect(exist(root, '/opt/yoal')).toBe(false);
		expect(exist(root, '/opt/skiff/releases/v1/agent/skiff-agent')).toBe(true);
		expect(readlinkSync(join(root, 'opt/skiff/current'))).toBe('/opt/skiff/releases/v1');
		expect(exist(root, '/etc/yoal')).toBe(false);
		expect(read(root, '/etc/skiff/skiff.env')).toContain('SKIFF_DATA_DIR=/var/lib/skiff/data');
		expect(exist(root, '/etc/systemd/system/skiff-agent.service')).toBe(true);
		expect(exist(root, '/var/lib/skiff/data/skiff.db')).toBe(true);
		expect(exist(root, '/var/lib/yoal/data/yoal.db')).toBe(false);
	});

	test('is idempotent when the host is already Yoal', () => {
		const root = tempRoot();
		put(root, '/opt/yoal/current/meta.json', '{}');
		const result = migrateHost({ root, dryRun: false, yes: true, log: () => {} });
		expect(result.alreadyConverted).toBe(true);
		expect(result.changed).toEqual([]);
	});
});
