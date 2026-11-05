import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GUARD_UNIT, PRIMARY_UNIT, STANDBY_UNIT, controlPlaneUnits, ensureControlPlaneUnits } from './control-plane.ts';

describe('control-plane units', () => {
	const units = controlPlaneUnits();

	test('primary and standby run different slots on different sockets', () => {
		expect(units[PRIMARY_UNIT]).toContain('ExecStart=/opt/skiff/current/runtime/bun /opt/skiff/current/repo/apps/control-plane/build/index.js');
		expect(units[PRIMARY_UNIT]).toContain('SOCKET_PATH=/run/skiff/control-primary.sock');
		expect(units[STANDBY_UNIT]).toContain('ExecStart=/opt/skiff/standby/runtime/bun /opt/skiff/standby/repo/apps/control-plane/build/index.js');
		expect(units[STANDBY_UNIT]).toContain('SOCKET_PATH=/run/skiff/control-standby.sock');
	});

	test('only the primary owns background work and boots; the standby is never enabled', () => {
		expect(units[STANDBY_UNIT]).toContain('Environment=SKIFF_STANDBY=1');
		expect(units[PRIMARY_UNIT]).not.toContain('SKIFF_STANDBY');
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
		expect(guard).toContain(`Before=${PRIMARY_UNIT} ${STANDBY_UNIT} skiff-litestream.service`);
		expect(guard).toContain('DefaultDependencies=no');
		expect(guard).toContain('ExecStart=-/usr/local/sbin/skiff-update-self recover --boot');
		expect(units[PRIMARY_UNIT]).toContain(`After=network-online.target caddy.service ${GUARD_UNIT}`);
	});

	test('ensureControlPlaneUnits writes only on change and enables the guard', () => {
		const dir = mkdtempSync(join(tmpdir(), 'skiff-units-'));
		const calls: string[][] = [];
		const input = { systemdDir: dir, run: (cmd: string[]) => void calls.push(cmd), log: () => {} };
		expect(ensureControlPlaneUnits(input)).toBe(true);
		expect(calls).toEqual([['systemctl', 'daemon-reload'], ['systemctl', 'enable', GUARD_UNIT]]);
		expect(readFileSync(join(dir, STANDBY_UNIT), 'utf8')).toBe(units[STANDBY_UNIT]!);
		expect(ensureControlPlaneUnits(input)).toBe(false);
		expect(calls).toHaveLength(2);
	});
});
