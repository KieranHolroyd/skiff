import { describe, expect, test } from 'bun:test';
import { BUILD_VERSION } from './build-version.ts';
import { HelperConfigError, loadHelperConfig } from './config.ts';

describe('loadHelperConfig', () => {
	test('applies production defaults', () => {
		const config = loadHelperConfig({});
		expect(config.socketPath).toBe('/run/yoal-helper/helper.sock');
		expect(config.unitDir).toBe('/etc/systemd/system');
		expect(config.quadletDir).toBe('/etc/containers/systemd');
		expect(config.runtimeDir).toBe('/run/yoal-workloads');
		expect(config.stateDir).toBe('/var/lib/yoal-workloads');
		expect(config.releaseDirs).toEqual(['/srv/yoal/releases', '/var/lib/yoal/agent/releases']);
		expect(config.bunPath).toBe('/usr/local/bin/bun');
		expect(config.workerdDir).toBe('/usr/lib/yoal/workerd');
		expect(config.systemctlPath).toBe('/usr/bin/systemctl');
		expect(config.journalctlPath).toBe('/usr/bin/journalctl');
		expect(config.workloadSocketMode).toBe('0666');
		expect(config.workloadSocketGroup).toBeNull();
		expect(config.controlSocketMode).toBe('0660');
		expect(config.controlSocketGroup).toBe('yoal');
	});

	test('reads overrides and a release-dir list', () => {
		const config = loadHelperConfig({
			YOAL_HELPER_SOCKET: '/run/custom/helper.sock',
			YOAL_HELPER_UNIT_DIR: '/etc/custom/system',
			YOAL_HELPER_RUNTIME_DIR: '/run/custom-workloads',
			YOAL_HELPER_STATE_DIR: '/var/lib/custom',
			YOAL_HELPER_RELEASE_DIRS: '/srv/a, /srv/b',
			YOAL_HELPER_BUN_PATH: '/opt/bun',
			YOAL_HELPER_WORKERD_DIR: '/opt/workerd',
			YOAL_HELPER_JOURNALCTL: '/opt/journalctl',
			YOAL_HELPER_WORKLOAD_SOCKET_MODE: '0660',
			YOAL_HELPER_WORKLOAD_SOCKET_GROUP: 'caddy',
			YOAL_HELPER_CONTROL_SOCKET_MODE: '0600',
			YOAL_HELPER_CONTROL_SOCKET_GROUP: 'yoal-agent',
			YOAL_HELPER_APPARMOR_PROFILE: 'unconfined',
		});
		expect(config.socketPath).toBe('/run/custom/helper.sock');
		expect(config.releaseDirs).toEqual(['/srv/a', '/srv/b']);
		expect(config.journalctlPath).toBe('/opt/journalctl');
		expect(config.workerdDir).toBe('/opt/workerd');
		expect(config.workloadSocketMode).toBe('0660');
		expect(config.workloadSocketGroup).toBe('caddy');
		expect(config.controlSocketMode).toBe('0600');
		expect(config.controlSocketGroup).toBe('yoal-agent');
		expect(config.version).toBe(BUILD_VERSION);
		expect(config.apparmorProfile).toBe('unconfined');
	});

	test('maps AppArmor none to the runtime default and rejects unsafe names', () => {
		expect(loadHelperConfig({ YOAL_HELPER_APPARMOR_PROFILE: 'none' }).apparmorProfile).toBeNull();
		expect(() => loadHelperConfig({ YOAL_HELPER_APPARMOR_PROFILE: 'a b' })).toThrow(
			HelperConfigError,
		);
	});

	test('rejects unsafe configuration', () => {
		expect(() => loadHelperConfig({ YOAL_HELPER_SOCKET: 'run/helper.sock' })).toThrow(
			HelperConfigError,
		);
		expect(() => loadHelperConfig({ YOAL_HELPER_RELEASE_DIRS: ',' })).toThrow();
		expect(() => loadHelperConfig({ YOAL_HELPER_WORKERD_DIR: 'workerd' })).toThrow(HelperConfigError);
		expect(() => loadHelperConfig({ YOAL_HELPER_WORKLOAD_SOCKET_MODE: '666' })).toThrow(/octal/);
		expect(() => loadHelperConfig({ YOAL_HELPER_CONTROL_SOCKET_MODE: '0666' })).toThrow(
			/other users/,
		);
		expect(() =>
			loadHelperConfig({ YOAL_HELPER_WORKLOAD_SOCKET_GROUP: 'bad group' }),
		).toThrow(HelperConfigError);
		expect(() => loadHelperConfig({ YOAL_HELPER_CONTROL_SOCKET_GROUP: 'bad group' })).toThrow(
			HelperConfigError,
		);
		expect(() =>
			loadHelperConfig({ YOAL_HELPER_SOCKET: '/run/yoal-workloads/helper.sock' }),
		).toThrow(/inside the workload runtime dir/);
	});
});
