import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	DEFAULT_CONTROL_PLANE_PATHS,
	GUARD_UNIT,
	MASTER_KEY_DROP_IN,
	PRIMARY_UNIT,
	STANDBY_UNIT,
	controlPlaneUnits,
	ensureControlPlaneUnits,
	ensureMasterKeyDropIns,
	masterKeyDropIn,
} from './control-plane.ts';

describe('control-plane units', () => {
	const units = controlPlaneUnits();

	test('primary and standby run different slots on different sockets', () => {
		expect(units[PRIMARY_UNIT]).toContain('ExecStart=/opt/yoal/current/runtime/bun /opt/yoal/current/repo/apps/control-plane/build/index.js');
		expect(units[PRIMARY_UNIT]).toContain('SOCKET_PATH=/run/yoal/control-primary.sock');
		expect(units[STANDBY_UNIT]).toContain('ExecStart=/opt/yoal/standby/runtime/bun /opt/yoal/standby/repo/apps/control-plane/build/index.js');
		expect(units[STANDBY_UNIT]).toContain('SOCKET_PATH=/run/yoal/control-standby.sock');
	});

	test('only the primary owns background work and boots; the standby is never enabled', () => {
		expect(units[STANDBY_UNIT]).toContain('Environment=YOAL_STANDBY=1');
		expect(units[PRIMARY_UNIT]).not.toContain('YOAL_STANDBY');
		expect(units[PRIMARY_UNIT]).toContain('[Install]');
		expect(units[STANDBY_UNIT]).not.toContain('[Install]');
	});

	test('the primary pre-start escapes shell variables for systemd and leaves a serving standby alone', () => {
		const pre = units[PRIMARY_UNIT]!.split('\n').find((line) => line.startsWith('ExecStartPre='))!;
		expect(pre.startsWith('ExecStartPre=+/bin/sh -c ')).toBe(true);
		// Every shell `$` is doubled, or systemd would expand it as an environment variable.
		expect(pre.replace(/\$\$/g, '')).not.toContain('$');
		expect(pre).toContain(`systemctl is-active --quiet ${STANDBY_UNIT}`);
		expect(pre).toContain('ln -sfn control-primary.sock');
	});

	test('the guard runs before the control plane and Litestream, and cannot block boot', () => {
		const guard = units[GUARD_UNIT]!;
		expect(guard).toContain(`Before=${PRIMARY_UNIT} ${STANDBY_UNIT} yoal-litestream.service`);
		expect(guard).toContain('DefaultDependencies=no');
		expect(guard).toContain('ExecStart=-/usr/local/sbin/yoal-update-self recover --boot');
		expect(units[PRIMARY_UNIT]).toContain(`After=network-online.target caddy.service ${GUARD_UNIT} yoal-clickhouse.service`);
	});

	test('both slots start after ClickHouse but only want it, never require it', () => {
		for (const unit of [units[PRIMARY_UNIT]!, units[STANDBY_UNIT]!]) {
			expect(unit).toContain('Wants=network-online.target yoal-clickhouse.service');
			expect(unit).toMatch(/^After=.* yoal-clickhouse\.service$/m);
			expect(unit).not.toMatch(/^(Requires|BindsTo|Requisite)=/m);
		}
	});

	test('ensureControlPlaneUnits writes only on change and enables the guard', () => {
		const dir = mkdtempSync(join(tmpdir(), 'yoal-units-'));
		const calls: string[][] = [];
		const input = { systemdDir: dir, run: (cmd: string[]) => void calls.push(cmd), log: () => {} };
		expect(ensureControlPlaneUnits(input)).toBe(true);
		expect(calls).toEqual([['systemctl', 'daemon-reload'], ['systemctl', 'enable', GUARD_UNIT]]);
		expect(readFileSync(join(dir, STANDBY_UNIT), 'utf8')).toBe(units[STANDBY_UNIT]!);
		expect(ensureControlPlaneUnits(input)).toBe(false);
		expect(calls).toHaveLength(2);
	});
});

describe('master key drop-ins', () => {
	test('the unit body names the plaintext credential; the drop-in clears it and loads the sealed one', () => {
		expect(controlPlaneUnits()[PRIMARY_UNIT]).toContain('LoadCredential=master-key:/etc/yoal/master.key\n');
		const body = masterKeyDropIn('/etc/yoal/master.key.cred');
		const lines = body.split('\n').filter((line) => line && !line.startsWith('#'));
		// The reset must come before the new directive, or it would clear nothing useful.
		expect(lines).toEqual(['[Service]', 'LoadCredential=', 'LoadCredentialEncrypted=master-key:/etc/yoal/master.key.cred']);
	});

	test('written for both slots when the key is sealed, removed again when it is not', () => {
		const systemdDir = mkdtempSync(join(tmpdir(), 'yoal-dropins-'));
		const etc = mkdtempSync(join(tmpdir(), 'yoal-etc-'));
		const masterKeyFile = join(etc, 'master.key');
		const dropIn = (unit: string) => join(systemdDir, `${unit}.d`, MASTER_KEY_DROP_IN);

		expect(ensureMasterKeyDropIns({ systemdDir, masterKeyFile })).toEqual([]);
		writeFileSync(`${masterKeyFile}.cred`, 'sealed');
		expect(ensureMasterKeyDropIns({ systemdDir, masterKeyFile, dryRun: true })).toEqual([dropIn(PRIMARY_UNIT), dropIn(STANDBY_UNIT)]);
		expect(existsSync(dropIn(PRIMARY_UNIT))).toBe(false);
		expect(ensureMasterKeyDropIns({ systemdDir, masterKeyFile })).toEqual([dropIn(PRIMARY_UNIT), dropIn(STANDBY_UNIT)]);
		for (const unit of [PRIMARY_UNIT, STANDBY_UNIT]) expect(readFileSync(dropIn(unit), 'utf8')).toBe(masterKeyDropIn(`${masterKeyFile}.cred`));
		expect(ensureMasterKeyDropIns({ systemdDir, masterKeyFile })).toEqual([]);

		// Back to plaintext (installer rollback): the drop-ins go.
		expect(ensureMasterKeyDropIns({ systemdDir, masterKeyFile, exists: () => false })).toEqual([dropIn(PRIMARY_UNIT), dropIn(STANDBY_UNIT)]);
		expect(existsSync(dropIn(PRIMARY_UNIT)) || existsSync(dropIn(STANDBY_UNIT))).toBe(false);
	});

	test('ensureControlPlaneUnits reloads systemd when only a drop-in changed', () => {
		const systemdDir = mkdtempSync(join(tmpdir(), 'yoal-units-'));
		const etc = mkdtempSync(join(tmpdir(), 'yoal-etc-'));
		const paths = { ...DEFAULT_CONTROL_PLANE_PATHS, masterKeyFile: join(etc, 'master.key') };
		const calls: string[][] = [];
		const logs: string[] = [];
		const input = { systemdDir, paths, run: (cmd: string[]) => void calls.push(cmd), log: (line: string) => void logs.push(line) };
		expect(ensureControlPlaneUnits(input)).toBe(true);
		expect(ensureControlPlaneUnits(input)).toBe(false);
		writeFileSync(join(etc, 'master.key.cred'), 'sealed');
		calls.length = 0;
		expect(ensureControlPlaneUnits(input)).toBe(true);
		expect(calls[0]).toEqual(['systemctl', 'daemon-reload']);
		expect(logs.at(-1)).toContain(`${PRIMARY_UNIT}.d/${MASTER_KEY_DROP_IN}`);
		expect(existsSync(join(systemdDir, `${STANDBY_UNIT}.d`, MASTER_KEY_DROP_IN))).toBe(true);
	});
});
