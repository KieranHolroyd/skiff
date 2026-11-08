import { describe, expect, test } from 'bun:test';
import {
	BuildValidationError,
	directRunArgs,
	gitAuthEnv,
	gitSshEnv,
	isSshRepoUrl,
	redactSecret,
	validateGitRef,
	safeRelativeDir,
	systemdRunArgs,
	unitName,
	validateBuildCommand,
} from './command.ts';
import { gitEnv, withCloneToken, type GitCredentials } from './pipeline/git.ts';

describe('build command validation', () => {
	test('accepts a normal command and trims edges', () => {
		expect(validateBuildCommand('  bun install && bun run build  ')).toBe('bun install && bun run build');
	});

	test('rejects empty, NUL and overlong commands', () => {
		expect(() => validateBuildCommand('   ')).toThrow(BuildValidationError);
		expect(() => validateBuildCommand('bun\0run')).toThrow(BuildValidationError);
		expect(() => validateBuildCommand('x'.repeat(2049))).toThrow(BuildValidationError);
	});
});

describe('repo-relative directories', () => {
	test('normalizes inside-repository paths', () => {
		expect(safeRelativeDir('.', 'rootDir')).toBe('.');
		expect(safeRelativeDir('apps/web/', 'rootDir')).toBe('apps/web');
		expect(safeRelativeDir('dist', 'outputDir')).toBe('dist');
	});

	test('rejects traversal and absolute paths', () => {
		expect(() => safeRelativeDir('../etc', 'rootDir')).toThrow(BuildValidationError);
		expect(() => safeRelativeDir('/srv', 'rootDir')).toThrow(BuildValidationError);
		expect(() => safeRelativeDir('a//b', 'rootDir')).toThrow(BuildValidationError);
	});
});

describe('systemd argv', () => {
	test('builds a transient unit with the D3 limits', () => {
		expect(
			systemdRunArgs({
				workDir: '/var/lib/skiff-builder/build-abc',
				command: 'bun run build',
				unit: unitName('bld_123'),
			}),
		).toEqual([
			'systemd-run',
			'--quiet',
			'--collect',
			'--pipe',
			'--wait',
			'--unit=skiff-build-bld_123',
			'--property=MemoryMax=2G',
			'--property=CPUQuota=200%',
			'--property=TimeoutStartSec=600',
			'--property=RuntimeMaxSec=600',
			'--working-directory=/var/lib/skiff-builder/build-abc',
			'/bin/bash',
			'-lc',
			'bun run build',
		]);
	});

	test('sandboxes the unit and runs it as the build account when a user is set', () => {
		const argv = systemdRunArgs({
			workDir: '/var/lib/skiff-builder/build-abc/apps/web',
			writableDir: '/var/lib/skiff-builder/build-abc',
			command: 'bun run build',
			unit: unitName('bld_123'),
			user: 'skiff-build',
			env: { HOME: '/var/lib/skiff-builder/build-abc/.home', CI: '1' },
		});
		expect(argv).toContain('--property=User=skiff-build');
		expect(argv).toContain('--property=NoNewPrivileges=yes');
		expect(argv).toContain('--property=ProtectSystem=strict');
		expect(argv).toContain('--property=ReadWritePaths=/var/lib/skiff-builder/build-abc');
		expect(argv).toContain('--property=CapabilityBoundingSet=');
		expect(argv.find((arg) => arg.startsWith('--property=InaccessiblePaths='))).toContain('-/etc/skiff');
		expect(argv).toContain('--setenv=HOME=/var/lib/skiff-builder/build-abc/.home');
		expect(argv).toContain('--setenv=CI=1');
		// The command is still the last argument, after every property.
		expect(argv.slice(-3)).toEqual(['/bin/bash', '-lc', 'bun run build']);
		expect(argv.indexOf('--working-directory=/var/lib/skiff-builder/build-abc/apps/web')).toBe(argv.length - 4);
	});

	test('direct fallback uses the same shell boundary', () => {
		expect(directRunArgs('bun run build')).toEqual(['/bin/bash', '-lc', 'bun run build']);
	});

	test('sanitizes unit names', () => {
		expect(unitName('bld_abc/../def')).toBe('skiff-build-bld_abc-..-def');
	});
});

describe('clone credentials', () => {
	const hosts = ['github.com'];
	const header = `Authorization: Basic ${Buffer.from('x-access-token:tok en').toString('base64')}`;

	test('scopes the token to an allowed https host, through the environment only', () => {
		expect(gitAuthEnv('https://github.com/acme/app.git', 'tok en', hosts)).toEqual({
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
			GIT_CONFIG_VALUE_0: header,
		});
		expect(gitAuthEnv('https://GitHub.com/acme/app.git', 'tok en', hosts).GIT_CONFIG_KEY_0).toBe(
			'http.https://github.com/.extraHeader',
		);
	});

	test('never sends the token to another host, scheme or a URL with its own credentials', () => {
		expect(gitAuthEnv('https://attacker.example/x.git', 'tok', hosts)).toEqual({});
		expect(gitAuthEnv('https://github.com.attacker.example/x.git', 'tok', hosts)).toEqual({});
		expect(gitAuthEnv('https://github.com:8443/x.git', 'tok', hosts)).toEqual({});
		expect(gitAuthEnv('http://github.com/x.git', 'tok', hosts)).toEqual({});
		expect(gitAuthEnv('git@github.com:acme/app.git', 'tok', hosts)).toEqual({});
		expect(gitAuthEnv('https://me:pw@github.com/x.git', 'tok', hosts)).toEqual({});
		expect(gitAuthEnv('https://github.com/acme/app.git', null, hosts)).toEqual({});
		expect(gitAuthEnv('https://git.corp:8443/x.git', 'tok', ['git.corp:8443']).GIT_CONFIG_KEY_0).toBe(
			'http.https://git.corp:8443/.extraHeader',
		);
	});

	test('a forge clone token goes to its host only, with the user name the forge checks (D175)', () => {
		const env = withCloneToken(
			{ gitToken: 'node-token', gitTokenHosts: ['github.com'], gitSshKey: null, gitSshKnownHosts: null, buildDir: '/tmp' },
			'gldt-1',
			{ host: 'gitlab.example.com', username: 'gitlab+deploy-token-1' },
		);
		expect(env.gitTokenHosts).toEqual(['gitlab.example.com']);
		const auth = gitEnv('https://gitlab.example.com/acme/api.git', env);
		expect(auth.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from('gitlab+deploy-token-1:gldt-1').toString('base64')}`);
		expect(gitEnv('https://github.com/acme/api.git', env).GIT_CONFIG_VALUE_0).toBeUndefined();
		// No host (an older control plane): github.com with GitHub's user name, as before.
		const legacy: GitCredentials = withCloneToken({ gitToken: null, gitTokenHosts: [], gitSshKey: null, gitSshKnownHosts: null, buildDir: '/tmp' } as GitCredentials, 'ghs_1');
		expect(gitEnv('https://github.com/acme/api.git', legacy).GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from('x-access-token:ghs_1').toString('base64')}`);
		// A malformed host or user name never widens where the token goes.
		expect(withCloneToken(legacy, 'x', { host: 'evil.example/x' }).gitTokenHosts).toEqual(['github.com']);
		expect(gitAuthEnv('https://h.example/x.git', 't', ['h.example'], 'a:b').GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from('x-access-token:t').toString('base64')}`);
	});

	test('rejects refs git would read as options', () => {
		expect(validateGitRef('main')).toBe('main');
		expect(validateGitRef('feature/x-1')).toBe('feature/x-1');
		expect(() => validateGitRef('--upload-pack=touch /tmp/x')).toThrow(BuildValidationError);
		expect(() => validateGitRef('main x')).toThrow(BuildValidationError);
		expect(() => validateGitRef('')).toThrow(BuildValidationError);
	});

	test('redacts a token from git output', () => {
		expect(redactSecret('fatal: https://x-access-token:secret@github.com/x failed secret', 'secret')).toBe(
			'fatal: https://***@github.com/x failed ***',
		);
	});
});

describe('SSH deploy key', () => {
	const ssh = { keyPath: '/etc/skiff/git-deploy-key', knownHostsPath: null, fallbackKnownHostsPath: '/var/lib/skiff-builder/known_hosts' };

	test('recognises only SSH URL forms', () => {
		expect(isSshRepoUrl('git@github.com:acme/app.git')).toBe(true);
		expect(isSshRepoUrl('ssh://git@git.corp:2222/acme/app.git')).toBe(true);
		expect(isSshRepoUrl('https://github.com/acme/app.git')).toBe(false);
		expect(isSshRepoUrl('git://git.corp/acme/app.git')).toBe(false);
		expect(isSshRepoUrl('https://me@github.com/x.git')).toBe(false);
	});

	test('passes the key through GIT_SSH_COMMAND for SSH URLs, recording hosts on first use', () => {
		expect(gitSshEnv('git@github.com:acme/app.git', ssh)).toEqual({
			GIT_SSH_COMMAND:
				"ssh -i '/etc/skiff/git-deploy-key' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='/var/lib/skiff-builder/known_hosts'",
		});
	});

	test('a pinned known_hosts file turns on strict host checking', () => {
		const env = gitSshEnv('ssh://git@git.corp/acme/app.git', { ...ssh, knownHostsPath: '/etc/skiff/git-known-hosts' });
		expect(env.GIT_SSH_COMMAND).toContain('-o StrictHostKeyChecking=yes');
		expect(env.GIT_SSH_COMMAND).toContain("-o UserKnownHostsFile='/etc/skiff/git-known-hosts'");
	});

	test('never applies to other URLs or without a key, and refuses shell syntax in paths', () => {
		expect(gitSshEnv('https://github.com/acme/app.git', ssh)).toEqual({});
		expect(gitSshEnv('git@github.com:acme/app.git', { ...ssh, keyPath: null })).toEqual({});
		expect(() => gitSshEnv('git@github.com:acme/app.git', { ...ssh, fallbackKnownHostsPath: "/tmp/b'; touch /x'" })).toThrow(
			BuildValidationError,
		);
	});
});

describe('systemd argv for the pipeline step runner', () => {
	test('runs an explicit argv instead of bash -lc, inheriting the token by name', () => {
		const argv = systemdRunArgs({
			workDir: '/b/pipelines/j1/workspace',
			writableDir: '/b/pipelines/j1',
			argv: ['/opt/skiff/bin/skiff-agent', 'pipeline-step', '/b/pipelines/j1/meta/job.json'],
			unit: 'skiff-job-j1',
			user: 'skiff-build',
			env: { HOME: '/b/pipelines/j1/home' },
			inheritEnv: ['SKIFF_JOB_TOKEN'],
		});
		expect(argv.slice(-4)).toEqual([
			'--working-directory=/b/pipelines/j1/workspace',
			'/opt/skiff/bin/skiff-agent',
			'pipeline-step',
			'/b/pipelines/j1/meta/job.json',
		]);
		expect(argv).toContain('--setenv=SKIFF_JOB_TOKEN');
		expect(argv).toContain('--property=ReadWritePaths=/b/pipelines/j1');
		expect(argv).not.toContain('-lc');
	});

	test('rejects a relative program, NUL bytes and odd variable names', () => {
		expect(() => systemdRunArgs({ workDir: '/w', argv: ['skiff-agent'] })).toThrow(BuildValidationError);
		expect(() => systemdRunArgs({ workDir: '/w', argv: ['/bin/x', 'a\0b'] })).toThrow(BuildValidationError);
		expect(() => systemdRunArgs({ workDir: '/w', argv: ['/bin/x'], inheritEnv: ['A=B'] })).toThrow(BuildValidationError);
	});
});
