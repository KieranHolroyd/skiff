import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	StepSetupError,
	hashFiles,
	inheritedEnv,
	layerEnv,
	resolveWorkingDirectory,
	stepProcessEnv,
	truthyInput,
	type JobContext,
} from './context.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-context-'));
const workspace = join(root, 'workspace');
mkdirSync(join(workspace, 'apps', 'web'), { recursive: true });
mkdirSync(join(root, 'outside'));
symlinkSync(join(root, 'outside'), join(workspace, 'escape'));
writeFileSync(join(workspace, 'bun.lock'), 'lock-a');
writeFileSync(join(workspace, 'apps', 'web', 'package.json'), '{}');
writeFileSync(join(workspace, 'apps', 'web', 'notes.txt'), 'n');

afterAll(() => rmSync(root, { recursive: true, force: true }));

const context: JobContext = {
	yoal: { ref: 'refs/heads/main', sha: 'abc' },
	github: { ref: 'refs/heads/main', sha: 'abc' },
	secrets: { TOKEN: 's3cret' },
	matrix: { node: '24' },
	env: {},
};

describe('env layering', () => {
	test('workflow < job, each value sees the ones before it', () => {
		const env = layerEnv(
			[
				{ A: 'wf', B: 'wf-${{ env.A }}', REF: '${{ github.ref }}' },
				{ A: 'job', C: '${{ env.A }}/${{ env.B }}/${{ matrix.node }}', SECRET: '${{ secrets.TOKEN }}' },
			],
			context,
		);
		expect(env).toEqual({ A: 'job', B: 'wf-wf', REF: 'refs/heads/main', C: 'job/wf-wf/24', SECRET: 's3cret' });
	});

	test('step env beats $YOAL_ENV beats job env; PATH additions are prepended, newest first', () => {
		const env = stepProcessEnv({
			inherited: { PATH: '/usr/bin', HOME: '/h' },
			runner: { CI: 'true' },
			jobEnv: { A: 'job', B: 'job' },
			fileEnv: { A: 'file', C: 'file' },
			stepEnv: { A: 'step' },
			pathAdditions: ['/first/bin', '/second/bin'],
		});
		expect(env).toEqual({ PATH: '/second/bin:/first/bin:/usr/bin', HOME: '/h', CI: 'true', A: 'step', B: 'job', C: 'file' });
	});

	test('only allowlisted variables are inherited; the job token never is', () => {
		const env = inheritedEnv({ PATH: '/bin', HOME: '/h', YOAL_JOB_TOKEN: 'tok', YOAL_NODE_TOKEN: 'node', AWS_SECRET: 'x' });
		expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
	});
});

describe('working directory', () => {
	test('resolves inside the workspace', () => {
		expect(resolveWorkingDirectory(workspace, null)).toBe(workspace);
		expect(resolveWorkingDirectory(workspace, 'apps/web')).toBe(join(workspace, 'apps', 'web'));
		expect(resolveWorkingDirectory(workspace, join(workspace, 'apps'))).toBe(join(workspace, 'apps'));
	});

	test('rejects escapes, symlinks out, and missing directories', () => {
		expect(() => resolveWorkingDirectory(workspace, '..')).toThrow(StepSetupError);
		expect(() => resolveWorkingDirectory(workspace, '../outside')).toThrow(/outside the workspace/);
		expect(() => resolveWorkingDirectory(workspace, '/etc')).toThrow(/outside the workspace/);
		expect(() => resolveWorkingDirectory(workspace, 'escape')).toThrow(/resolves outside/);
		expect(() => resolveWorkingDirectory(workspace, 'missing')).toThrow(/does not exist/);
		expect(() => resolveWorkingDirectory(workspace, 'bun.lock')).toThrow(/not a directory/);
	});
});

describe('hashFiles', () => {
	const digest = (data: string) => createHash('sha256').update(data).digest();

	test('sha256 over each file digest in sorted order; empty when nothing matches', () => {
		const expected = createHash('sha256').update(digest('{}')).digest('hex');
		expect(hashFiles(workspace, ['**/package.json'])).toBe(expected);
		const both = createHash('sha256').update(digest('{}')).update(digest('lock-a')).digest('hex');
		// apps/web/package.json sorts before bun.lock.
		expect(hashFiles(workspace, ['bun.lock', '**/package.json'])).toBe(both);
		expect(hashFiles(workspace, ['**/*.nothing'])).toBe('');
	});

	test('negated patterns exclude', () => {
		const onlyNotes = createHash('sha256').update(digest('n')).digest('hex');
		expect(hashFiles(workspace, ['apps/**', '!**/package.json'])).toBe(onlyNotes);
	});

	test('changes when content changes', () => {
		const before = hashFiles(workspace, ['bun.lock']);
		writeFileSync(join(workspace, 'bun.lock'), 'lock-b');
		expect(hashFiles(workspace, ['bun.lock'])).not.toBe(before);
	});
});

describe('truthyInput', () => {
	test('GitHub-ish booleans', () => {
		expect(truthyInput('true')).toBe(true);
		expect(truthyInput('false', true)).toBe(false);
		expect(truthyInput(undefined, true)).toBe(true);
		expect(truthyInput(true)).toBe(true);
		expect(truthyInput(0)).toBe(false);
	});
});
