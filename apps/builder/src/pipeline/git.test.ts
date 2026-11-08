import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildValidationError } from '../command.ts';
import { gitRepo } from './git-fixture.ts';
import { cloneAtSha, cloneRef, commitInfo, gitEnv, validateSha, type GitCredentials } from './git.ts';

const root = mkdtempSync(join(tmpdir(), 'skiff-git-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const credentials: GitCredentials = { gitToken: null, gitTokenHosts: ['github.com'], gitSshKey: null, gitSshKnownHosts: null, buildDir: root };

const origin = gitRepo(join(root, 'origin'));
const first = origin.commit({ 'file.txt': 'one' }, 'first commit');
const second = origin.commit({ 'file.txt': 'two' }, 'second commit');

describe('cloneAtSha', () => {
	test('checks out exactly the planned commit even when the branch has moved', async () => {
		const dir = join(root, 'at-first');
		await cloneAtSha({ url: origin.dir, ref: 'refs/heads/main', sha: first, dir, credentials });
		expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('one');
		expect(await commitInfo(dir)).toEqual({ sha: first, message: 'first commit' });
	});

	test('checks out the tip', async () => {
		const dir = join(root, 'at-second');
		await cloneAtSha({ url: origin.dir, ref: 'main', sha: second, dir, credentials });
		expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('two');
	});

	test('fails clearly for an unknown commit and rejects odd input', async () => {
		await expect(cloneAtSha({ url: origin.dir, ref: 'main', sha: 'f'.repeat(40), dir: join(root, 'missing'), credentials })).rejects.toThrow(
			BuildValidationError,
		);
		expect(() => validateSha('--upload-pack=evil')).toThrow(BuildValidationError);
		await expect(cloneAtSha({ url: origin.dir, ref: '-x', sha: first, dir: join(root, 'bad'), credentials })).rejects.toThrow(BuildValidationError);
	});
});

describe('cloneRef', () => {
	test('clones a branch shallowly (the git Builder path)', async () => {
		const dir = join(root, 'branch');
		await cloneRef({ url: origin.dir, ref: 'main', dir, credentials });
		expect((await commitInfo(dir)).sha).toBe(second);
	});
});

describe('gitEnv', () => {
	test('never prompts, and sends the token only to allowed hosts', () => {
		expect(gitEnv('https://evil.example/x.git', { ...credentials, gitToken: 't' })).toEqual({ GIT_TERMINAL_PROMPT: '0' });
		expect(gitEnv('https://github.com/a/b.git', { ...credentials, gitToken: 't' }).GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
	});
});
