import { describe, expect, test } from 'bun:test';
import { BUILD_VERSION } from './build-version.ts';
import { HelperConfigError, loadHelperConfig } from './config.ts';

describe('loadHelperConfig', () => {
	test('applies production defaults', () => {
		const config = loadHelperConfig({});
		expect(config.socketPath).toBe('/run/skiff-helper/helper.sock');
		expect(config.unitDir).toBe('/etc/systemd/system');
		expect(config.quadletDir).toBe('/etc/containers/systemd');
		expect(config.runtimeDir).toBe('/run/skiff-workloads');
		expect(config.stateDir).toBe('/var/lib/skiff-workloads');
		expect(config.releaseDirs).toEqual(['/srv/skiff/releases', '/var/lib/skiff/agent/releases']);
		expect(config.bunPath).toBe('/usr/local/bin/bun');
		expect(config.workerdDir).toBe('/usr/lib/skiff/workerd');
		expect(config.systemctlPath).toBe('/usr/bin/systemctl');
		expect(config.journalctlPath).toBe('/usr/bin/journalctl');
		expect(config.workloadSocketMode).toBe('0666');
		expect(config.workloadSocketGroup).toBeNull();
		expect(config.controlSocketMode).toBe('0660');
		expect(config.controlSocketGroup).toBe('skiff');
	});

	test('reads overrides and a release-dir list', () => {
		const config = loadHelperConfig({
			SKIFF_HELPER_SOCKET: '/run/custom/helper.sock',
			SKIFF_HELPER_UNIT_DIR: '/etc/custom/system',
			SKIFF_HELPER_RUNTIME_DIR: '/run/custom-workloads',
			SKIFF_HELPER_STATE_DIR: '/var/lib/custom',
			SKIFF_HELPER_RELEASE_DIRS: '/srv/a, /srv/b',
			SKIFF_HELPER_BUN_PATH: '/opt/bun',
			SKIFF_HELPER_WORKERD_DIR: '/opt/workerd',
			SKIFF_HELPER_JOURNALCTL: '/opt/journalctl',
			SKIFF_HELPER_WORKLOAD_SOCKET_MODE: '0660',
			SKIFF_HELPER_WORKLOAD_SOCKET_GROUP: 'caddy',
			SKIFF_HELPER_CONTROL_SOCKET_MODE: '0600',
			SKIFF_HELPER_CONTROL_SOCKET_GROUP: 'skiff-agent',
			SKIFF_HELPER_APPARMOR_PROFILE: 'unconfined',
		});
		expect(config.socketPath).toBe('/run/custom/helper.sock');
		expect(config.releaseDirs).toEqual(['/srv/a', '/srv/b']);
		expect(config.journalctlPath).toBe('/opt/journalctl');
		expect(config.workerdDir).toBe('/opt/workerd');
		expect(config.workloadSocketMode).toBe('0660');
		expect(config.workloadSocketGroup).toBe('caddy');
		expect(config.controlSocketMode).toBe('0600');
		expect(config.controlSocketGroup).toBe('skiff-agent');
		expect(config.version).toBe(BUILD_VERSION);
		expect(config.apparmorProfile).toBe('unconfined');
	});

	test('maps AppArmor none to the runtime default and rejects unsafe names', () => {
		expect(loadHelperConfig({ SKIFF_HELPER_APPARMOR_PROFILE: 'none' }).apparmorProfile).toBeNull();
		expect(() => loadHelperConfig({ SKIFF_HELPER_APPARMOR_PROFILE: 'a b' })).toThrow(
			HelperConfigError,
		);
	});

	test('rejects unsafe configuration', () => {
		expect(() => loadHelperConfig({ SKIFF_HELPER_SOCKET: 'run/helper.sock' })).toThrow(
			HelperConfigError,
		);
		expect(() => loadHelperConfig({ SKIFF_HELPER_RELEASE_DIRS: ',' })).toThrow();
		expect(() => loadHelperConfig({ SKIFF_HELPER_WORKERD_DIR: 'workerd' })).toThrow(HelperConfigError);
		expect(() => loadHelperConfig({ SKIFF_HELPER_WORKLOAD_SOCKET_MODE: '666' })).toThrow(/octal/);
		expect(() => loadHelperConfig({ SKIFF_HELPER_CONTROL_SOCKET_MODE: '0666' })).toThrow(
			/other users/,
		);
		expect(() =>
			loadHelperConfig({ SKIFF_HELPER_WORKLOAD_SOCKET_GROUP: 'bad group' }),
		).toThrow(HelperConfigError);
		expect(() => loadHelperConfig({ SKIFF_HELPER_CONTROL_SOCKET_GROUP: 'bad group' })).toThrow(
			HelperConfigError,
		);
		expect(() =>
			loadHelperConfig({ SKIFF_HELPER_SOCKET: '/run/skiff-workloads/helper.sock' }),
		).toThrow(/inside the workload runtime dir/);
	});
});
