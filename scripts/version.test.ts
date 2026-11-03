import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decideAutoBump, isShipped, manualBump } from './version.ts';

describe('isShipped', () => {
	test('platform code ships; docs, tests, CI and the CLI do not', () => {
		for (const path of ['apps/control-plane/src/hooks.server.ts', 'packages/core/src/nodes.ts', 'scripts/install/main.ts', 'install.sh', 'bun.lock', 'apps/agent/src/main.ts'])
			expect(isShipped(path)).toBe(true);
		for (const path of ['docs/OPS.md', 'README.md', 'apps/control-plane/README.md', '.github/workflows/ci.yml', 'apps/cli/src/main.ts', 'packages/core/src/core.test.ts', 'apps/control-plane/tests/rest.e2e.ts', 'VERSION', 'scripts/version.ts', '.githooks/pre-commit'])
			expect(isShipped(path)).toBe(false);
	});
});

describe('decideAutoBump', () => {
	const base = { working: '0.1.0\n', indexed: '0.1.0\n', released: '0.1.0\n' };

	test('patch-bumps the first shipped commit after a release', () => {
		expect(decideAutoBump({ ...base, staged: ['packages/core/src/nodes.ts'] })).toMatchObject({ action: 'bump', from: '0.1.0', version: '0.1.1' });
	});

	test('does nothing for docs/tests/CLI-only commits', () => {
		expect(decideAutoBump({ ...base, staged: ['docs/OPS.md', 'apps/cli/src/main.ts'] }).action).toBe('none');
	});

	test('bumps once per release: a pending bump (automatic or manual) is left alone', () => {
		expect(decideAutoBump({ ...base, working: '0.1.1', indexed: '0.1.1', staged: ['install.sh'] }).action).toBe('none');
		expect(decideAutoBump({ ...base, working: '1.0.0', indexed: '1.0.0', staged: ['install.sh'] }).action).toBe('none');
	});

	test('stages a manual bump the developer forgot to add', () => {
		expect(decideAutoBump({ ...base, working: '0.2.0', staged: ['install.sh'] })).toMatchObject({ action: 'stage', version: '0.2.0' });
	});

	test('never lands below the released version when this checkout is behind', () => {
		expect(decideAutoBump({ ...base, working: '0.1.0', released: '0.3.0', staged: ['install.sh'] })).toMatchObject({ action: 'bump', version: '0.3.1' });
	});

	test('a released prerelease graduates to its release', () => {
		expect(decideAutoBump({ working: '1.0.0-rc.1', indexed: '1.0.0-rc.1', released: '1.0.0-rc.1', staged: ['install.sh'] })).toMatchObject({ action: 'bump', version: '1.0.0' });
	});

	test('refuses an invalid VERSION; ignores an unknown release', () => {
		expect(decideAutoBump({ ...base, working: 'latest', staged: ['install.sh'] }).action).toBe('error');
		expect(decideAutoBump({ ...base, released: null, staged: ['install.sh'] }).action).toBe('none');
	});
});

describe('manualBump', () => {
	test('bumps from the released version so repeats and auto patches do not skip a release', () => {
		expect(manualBump('minor', '0.1.0', '0.1.0')).toBe('0.2.0');
		expect(manualBump('minor', '0.1.1', '0.1.0')).toBe('0.2.0'); // after an automatic patch
		expect(manualBump('minor', '0.2.0', '0.1.0')).toBeNull(); // already bumped
		expect(manualBump('major', '0.2.0', '0.1.0')).toBe('1.0.0'); // escalate a pending minor
		expect(manualBump('patch', '0.1.0', null)).toBe('0.1.1');
		expect(manualBump('minor', '0.1.0', '0.4.0')).toBe('0.5.0'); // checkout behind origin
	});
});

describe('pre-commit hook in a real repository', () => {
	let dir: string;
	const sh = (cmd: string[], cwd: string, env: Record<string, string> = {}) => {
		const result = Bun.spawnSync({
			cmd,
			cwd,
			env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const out = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
		if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${out}`);
		return out;
	};
	const version = (repo: string) => readFileSync(join(repo, 'VERSION'), 'utf8');
	const committed = (repo: string) => sh(['git', 'show', 'HEAD:VERSION'], repo);
	const commit = (repo: string, file: string, env: Record<string, string> = {}) => {
		mkdirSync(join(repo, file, '..'), { recursive: true });
		writeFileSync(join(repo, file), `${Math.random()}\n`);
		sh(['git', 'add', file], repo);
		return sh(['git', 'commit', '-q', '-m', file], repo, env);
	};

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), 'skiff-version-')));
		const root = resolve(import.meta.dir, '..');
		const seed = join(dir, 'seed');
		mkdirSync(seed);
		// The real hook + script + semver module, exactly as they sit in the repository.
		for (const path of ['.githooks', 'scripts/version.ts', 'packages/contracts/src/semver.ts'])
			cpSync(join(root, path), join(seed, path), { recursive: true });
		writeFileSync(join(seed, 'VERSION'), '0.1.0\n');
		sh(['git', 'init', '-q', '-b', 'main'], seed);
		sh(['git', 'add', '.'], seed);
		sh(['git', 'commit', '-q', '-m', 'release 0.1.0'], seed);
		sh(['git', 'clone', '-q', '--bare', seed, join(dir, 'origin.git')], dir);
		sh(['git', 'clone', '-q', join(dir, 'origin.git'), join(dir, 'work')], dir);
		// What `bun install` does through the root `prepare` script.
		sh(['git', 'config', 'core.hooksPath', '.githooks'], join(dir, 'work'));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test('one automatic patch per release, inside the commit; docs never bump', () => {
		const work = join(dir, 'work');
		commit(work, 'docs/notes.md');
		expect(committed(work)).toBe('0.1.0\n');

		const out = commit(work, 'packages/core/src/x.ts');
		expect(out).toContain('0.1.0 → 0.1.1');
		expect(committed(work)).toBe('0.1.1\n');

		commit(work, 'apps/agent/src/y.ts');
		expect(committed(work)).toBe('0.1.1\n'); // same unreleased batch

		sh(['git', 'push', '-q', 'origin', 'main'], work);
		sh(['git', 'fetch', '-q', 'origin'], work);
		commit(work, 'apps/agent/src/z.ts');
		expect(committed(work)).toBe('0.1.2\n'); // next release
	});

	test('a manual minor bump replaces the automatic patch and is staged for you', () => {
		const work = join(dir, 'work');
		sh(['bun', 'scripts/version.ts', 'minor'], work);
		expect(version(work)).toBe('0.2.0\n');
		commit(work, 'packages/core/src/feature.ts'); // VERSION deliberately not `git add`ed
		expect(committed(work)).toBe('0.2.0\n');
	});

	test('SKIFF_NO_VERSION_BUMP=1 skips the hook', () => {
		const work = join(dir, 'work');
		commit(work, 'packages/core/src/x.ts', { SKIFF_NO_VERSION_BUMP: '1' });
		expect(committed(work)).toBe('0.1.0\n');
	});
});
