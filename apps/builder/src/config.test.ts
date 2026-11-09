import { describe, expect, test } from 'bun:test';
import {
	chooseIsolation,
	ConfigError,
	DEFAULT_BUILD_PATH,
	loadConfig,
	pipelineNodeLabels,
	resolvePipelineIsolation,
	type HelperCapabilitiesLike,
	type HostProbe,
} from './config.ts';

const base = { YOAL_CONTROL_URL: 'https://control.test/', YOAL_NODE_TOKEN: 'tok', YOAL_BUILD_DIR: '/tmp/b' };
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('builder config', () => {
	test.skipIf(isRoot)('direct execution needs no build account', () => {
		const config = loadConfig({ ...base, YOAL_BUILDER_SYSTEMD: 'false' });
		expect(config.controlUrl).toBe('https://control.test');
		expect(config.buildUser).toBeNull();
		expect(config.buildPath).toBe(DEFAULT_BUILD_PATH);
		expect(config.idlePollMs).toBe(30_000);
	});

	test('honours an explicit build account with systemd-run', () => {
		const config = loadConfig({ ...base, YOAL_BUILDER_SYSTEMD: 'true', YOAL_BUILDER_USER: 'yoal-build' });
		expect(config.buildUser).toBe('yoal-build');
	});

	test('rejects a build account without systemd-run, and odd user names', () => {
		expect(() => loadConfig({ ...base, YOAL_BUILDER_SYSTEMD: 'false', YOAL_BUILDER_USER: 'yoal-build' })).toThrow(
			ConfigError,
		);
		expect(() => loadConfig({ ...base, YOAL_BUILDER_SYSTEMD: 'true', YOAL_BUILDER_USER: 'root;rm' })).toThrow(
			ConfigError,
		);
	});

	test('sends the git token only to listed hosts, github.com by default', () => {
		const config = { ...base, YOAL_BUILDER_SYSTEMD: 'true', YOAL_BUILDER_USER: 'yoal-build' };
		expect(loadConfig(config).gitTokenHosts).toEqual(['github.com']);
		expect(loadConfig({ ...config, YOAL_GIT_TOKEN_HOSTS: 'GitHub.com, git.corp:8443' }).gitTokenHosts).toEqual([
			'github.com',
			'git.corp:8443',
		]);
		expect(() => loadConfig({ ...config, YOAL_GIT_TOKEN_HOSTS: 'https://github.com' })).toThrow(ConfigError);
		expect(() => loadConfig({ ...config, YOAL_GIT_TOKEN_HOSTS: 'evil/.com' })).toThrow(ConfigError);
	});

	test('reads an SSH deploy key and a pinned known_hosts file as plain absolute paths', () => {
		const config = { ...base, YOAL_BUILDER_SYSTEMD: 'true', YOAL_BUILDER_USER: 'yoal-build' };
		expect(loadConfig(config)).toMatchObject({ gitSshKey: null, gitSshKnownHosts: null });
		expect(
			loadConfig({ ...config, YOAL_GIT_SSH_KEY: '/etc/yoal/git-deploy-key', YOAL_GIT_SSH_KNOWN_HOSTS: '/etc/yoal/git-known-hosts' }),
		).toMatchObject({ gitSshKey: '/etc/yoal/git-deploy-key', gitSshKnownHosts: '/etc/yoal/git-known-hosts' });
		expect(() => loadConfig({ ...config, YOAL_GIT_SSH_KEY: 'relative/key' })).toThrow(ConfigError);
		expect(() => loadConfig({ ...config, YOAL_GIT_SSH_KEY: "/etc/yoal/key'; rm -rf /" })).toThrow(ConfigError);
		expect(() => loadConfig({ ...config, YOAL_GIT_SSH_KNOWN_HOSTS: '/etc/../tmp/kh' })).toThrow(ConfigError);
	});
});

describe('pipeline config', () => {
	const linuxRoot: HostProbe = { platform: 'linux', isRoot: true, has: (binary) => binary === 'podman', arch: 'x64', exists: () => true };
	const mac: HostProbe = { platform: 'darwin', isRoot: false, has: () => false, arch: 'arm64', exists: () => false };
	const dev = { ...base, YOAL_BUILDER_SYSTEMD: 'false' };

	test('defaults: on, 3 s poll, one job, sandbox off Linux', () => {
		const config = loadConfig(dev, mac);
		expect(config).toMatchObject({
			pipelinesEnabled: true,
			pipelinePollMs: 3_000,
			pipelineMaxJobs: 1,
			pipelineLabels: [],
			pipelineIsolation: 'sandbox',
			pipelineIsolationMode: 'auto',
			pipelineContainerDriver: 'helper',
			helperSocket: '/run/yoal-helper/helper.sock',
			pipelineStepBinary: null,
			pipelineControlUrl: 'https://control.test',
		});
	});

	test('YOAL_PIPELINES=false is an off switch; bad values are errors', () => {
		expect(loadConfig({ ...dev, YOAL_PIPELINES: 'false' }, mac).pipelinesEnabled).toBe(false);
		expect(() => loadConfig({ ...dev, YOAL_PIPELINES: 'maybe' }, mac)).toThrow(/YOAL_PIPELINES/);
	});

	test('isolation mode: auto by default, explicit values, provisional sandbox until probed', () => {
		expect(resolvePipelineIsolation(undefined)).toBe('auto');
		expect(resolvePipelineIsolation(' ')).toBe('auto');
		expect(resolvePipelineIsolation('Sandbox')).toBe('sandbox');
		expect(resolvePipelineIsolation('container')).toBe('container');
		expect(() => resolvePipelineIsolation('vm')).toThrow(ConfigError);
		expect(loadConfig({ ...dev, YOAL_PIPELINE_ISOLATION: 'container' }, mac).pipelineIsolation).toBe('container');
		expect(loadConfig({ ...dev, YOAL_PIPELINE_CONTAINER_DRIVER: 'podman' }, mac).pipelineContainerDriver).toBe('podman');
		expect(() => loadConfig({ ...dev, YOAL_PIPELINE_CONTAINER_DRIVER: 'docker' }, mac)).toThrow(ConfigError);
		expect(() => loadConfig({ ...dev, YOAL_HELPER_SOCKET: 'helper.sock' }, mac)).toThrow(ConfigError);
	});

	test('chooseIsolation: auto is container whenever yoal-helper can run job containers', () => {
		const caps: HelperCapabilitiesLike = { podman: '5.4.2', runtimes: ['runc', 'runsc'], userns: true, stepBinary: true, buildsRoot: '/b' };
		const helper = { mode: 'auto' as const, driver: 'helper' as const, buildDir: '/b', probe: mac };
		expect(chooseIsolation({ ...helper, caps })).toMatchObject({ isolation: 'container', runtimes: ['runc', 'runsc'] });
		expect(chooseIsolation({ ...helper, caps: null, capsError: 'ENOENT' })).toMatchObject({ isolation: 'sandbox', runtimes: [] });
		expect(chooseIsolation({ ...helper, caps: { ...caps, podman: null } }).isolation).toBe('sandbox');
		expect(chooseIsolation({ ...helper, caps: { ...caps, userns: false } }).isolation).toBe('sandbox');
		expect(chooseIsolation({ ...helper, caps: { ...caps, stepBinary: false } }).isolation).toBe('sandbox');
		const moved = chooseIsolation({ ...helper, caps: { ...caps, buildsRoot: '/elsewhere' } });
		expect(moved.isolation).toBe('sandbox');
		expect(moved.reason).toContain('/elsewhere');
		// Explicit values win; the dev podman driver keeps the old Linux + root + podman rule.
		expect(chooseIsolation({ ...helper, mode: 'container', caps: null })).toMatchObject({ isolation: 'container', runtimes: ['runc'] });
		expect(chooseIsolation({ ...helper, mode: 'sandbox', caps })).toMatchObject({ isolation: 'sandbox', runtimes: [] });
		expect(chooseIsolation({ ...helper, driver: 'podman', caps: null, probe: linuxRoot }).isolation).toBe('container');
		expect(chooseIsolation({ ...helper, driver: 'podman', caps: null, probe: { ...linuxRoot, isRoot: false } }).isolation).toBe('sandbox');
		expect(chooseIsolation({ ...helper, driver: 'podman', mode: 'container', caps: null }).isolation).toBe('container');
	});

	test('labels, max jobs, step binary and job control URL are validated', () => {
		const config = loadConfig(
			{
				...dev,
				YOAL_PIPELINE_LABELS: 'GPU, zone-a ,',
				YOAL_PIPELINE_MAX_JOBS: '500',
				YOAL_PIPELINE_STEP_BINARY: '/opt/yoal/current/bin/yoal-agent',
				YOAL_PIPELINE_CONTROL_URL: 'http://10.0.0.1:3000/',
			},
			mac,
		);
		expect(config.pipelineLabels).toEqual(['gpu', 'zone-a']);
		expect(config.pipelineMaxJobs).toBe(64);
		expect(config.pipelineStepBinary).toBe('/opt/yoal/current/bin/yoal-agent');
		expect(config.pipelineControlUrl).toBe('http://10.0.0.1:3000');
		expect(() => loadConfig({ ...dev, YOAL_PIPELINE_LABELS: 'bad label' }, mac)).toThrow(ConfigError);
		expect(() => loadConfig({ ...dev, YOAL_PIPELINE_STEP_BINARY: 'yoal-agent' }, mac)).toThrow(ConfigError);
		expect(() => loadConfig({ ...dev, YOAL_PIPELINE_CONTROL_URL: 'ftp://x' }, mac)).toThrow(ConfigError);
	});

	test('node labels: os, arch, self-hosted, oci-build when images can be built, then operator labels', () => {
		expect(pipelineNodeLabels({ pipelineIsolation: 'container', pipelineLabels: ['gpu'] }, linuxRoot)).toEqual([
			'linux',
			'x64',
			'self-hosted',
			'oci-build',
			'gpu',
		]);
		expect(pipelineNodeLabels({ pipelineIsolation: 'sandbox', pipelineLabels: [] }, mac)).toEqual(['macos', 'arm64', 'self-hosted']);
		expect(pipelineNodeLabels({ pipelineIsolation: 'sandbox', pipelineLabels: ['linux'] }, { ...mac, has: (b) => b === 'buildah' })).toEqual([
			'macos',
			'arm64',
			'self-hosted',
			'oci-build',
			'linux',
		]);
	});
});
