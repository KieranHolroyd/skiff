import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELPER_ENV_FILE, HELPER_UNIT, ensureHelper, helperEnv, helperUnit, installHelperBinary } from './helper.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-helper-unit-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function releaseWithHelper(name: string, body = '#!/bin/sh\n'): string {
	const release = join(root, 'releases', name);
	mkdirSync(join(release, 'helper'), { recursive: true });
	writeFileSync(join(release, 'helper', 'yoal-helper'), body, { mode: 0o644 });
	return release;
}

describe('yoal-helper unit', () => {
	test('runs the stable helper path as root and creates its runtime dirs', () => {
		const unit = helperUnit({ optDir: '/opt/yoal', etcDir: '/etc/yoal' });
		expect(unit).toContain('ExecStart=/opt/yoal/helper/yoal-helper');
		expect(unit).toContain('EnvironmentFile=/etc/yoal/helper.env');
		expect(unit).toContain('ExecStartPre=+/usr/bin/install -d -o root -g yoal -m 0750 /run/yoal-helper');
		expect(unit).toContain('ExecStartPre=+/usr/bin/install -d -o root -g root -m 0755 /etc/containers/systemd');
		expect(unit).not.toContain('User=yoal');
	});

	test('the env file points at the bundled Bun and asks for AppArmor auto-detection', () => {
		const env = helperEnv({ optDir: '/opt/yoal', varDir: '/var/lib/yoal' });
		expect(env).toContain('YOAL_HELPER_BUN_PATH=/opt/yoal/runtime/bin/bun');
		expect(env).toContain('YOAL_HELPER_RELEASE_DIRS=/var/lib/yoal/agent/releases,/opt/yoal/releases');
		expect(env).toContain('YOAL_HELPER_QUADLET_DIR=/etc/containers/systemd');
		expect(env).toContain('YOAL_HELPER_APPARMOR_PROFILE=auto');
	});

	test('installs a release binary at the stable path without touching a missing one', () => {
		const missing = join(root, 'releases', 'empty');
		mkdirSync(missing, { recursive: true });
		expect(installHelperBinary({ optDir: join(root, 'opt'), release: missing })).toBe(false);
		const release = releaseWithHelper('v1');
		expect(installHelperBinary({ optDir: join(root, 'opt'), release })).toBe(true);
		expect(readFileSync(join(root, 'opt', 'helper', 'yoal-helper'), 'utf8')).toContain('#!/bin/sh');
	});

	test('ensureHelper writes the unit and env once, then restarts the service', () => {
		const systemdDir = join(root, 'systemd');
		const etcDir = join(root, 'etc');
		mkdirSync(systemdDir, { recursive: true });
		const calls: string[] = [];
		const run = (cmd: string[]) => void calls.push(cmd.join(' '));
		const release = releaseWithHelper('v2');
		const options = { systemdDir, etcDir, optDir: join(root, 'opt'), release, run };

		expect(ensureHelper(options)).toBe(true);
		expect(readFileSync(join(systemdDir, HELPER_UNIT), 'utf8')).toBe(
			helperUnit({ optDir: join(root, 'opt'), etcDir }),
		);
		expect(existsSync(join(etcDir, 'helper.env'))).toBe(true);
		expect(calls).toContain('systemctl restart yoal-helper.service');

		calls.length = 0;
		expect(ensureHelper(options)).toBe(false);
		expect(calls).toEqual(['systemctl daemon-reload', `systemctl enable ${HELPER_UNIT}`, `systemctl restart ${HELPER_UNIT}`]);
	});

	test('exports the env path used by the unit', () => {
		expect(HELPER_ENV_FILE).toBe('/etc/yoal/helper.env');
	});
});
