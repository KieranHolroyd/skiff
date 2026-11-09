import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineResolveClaim, PipelineResolveReport } from '@yoal/contracts';
import { gitRepo } from './git-fixture.ts';
import { readWorkflowFiles, runResolve } from './resolve.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-resolve-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('readWorkflowFiles', () => {
	test('reads *.yml/*.yaml directly in .yoal/workflows, sorted; skips other files, subdirectories and escaping links', async () => {
		const checkout = join(root, 'checkout');
		const workflows = join(checkout, '.yoal', 'workflows');
		mkdirSync(join(workflows, 'nested'), { recursive: true });
		writeFileSync(join(workflows, 'b.yaml'), 'name: b');
		writeFileSync(join(workflows, 'a.yml'), 'name: a');
		writeFileSync(join(workflows, 'README.md'), 'no');
		writeFileSync(join(workflows, 'nested', 'c.yml'), 'name: c');
		writeFileSync(join(root, 'secret.yml'), 'password: x');
		symlinkSync(join(root, 'secret.yml'), join(workflows, 'escape.yml'));
		writeFileSync(join(checkout, 'shared.yml'), 'name: shared');
		symlinkSync(join(checkout, 'shared.yml'), join(workflows, 'linked.yml'));
		expect(await readWorkflowFiles(checkout)).toEqual([
			{ path: '.yoal/workflows/a.yml', content: 'name: a' },
			{ path: '.yoal/workflows/b.yaml', content: 'name: b' },
			{ path: '.yoal/workflows/linked.yml', content: 'name: shared' },
		]);
	});

	test('no directory means no workflows; a linked-out directory is ignored', async () => {
		const empty = join(root, 'empty');
		mkdirSync(empty);
		expect(await readWorkflowFiles(empty)).toEqual([]);
		const linked = join(root, 'linked');
		mkdirSync(join(linked, '.yoal'), { recursive: true });
		mkdirSync(join(root, 'elsewhere'));
		writeFileSync(join(root, 'elsewhere', 'x.yml'), 'x');
		symlinkSync(join(root, 'elsewhere'), join(linked, '.yoal', 'workflows'));
		expect(await readWorkflowFiles(linked)).toEqual([]);
	});

	test('rejects oversized files', async () => {
		const big = join(root, 'big');
		mkdirSync(join(big, '.yoal', 'workflows'), { recursive: true });
		writeFileSync(join(big, '.yoal', 'workflows', 'huge.yml'), 'x'.repeat(512_001));
		await expect(readWorkflowFiles(big)).rejects.toThrow(/larger than/);
	});
});

describe('runResolve', () => {
	const origin = gitRepo(join(root, 'origin'));
	const sha = origin.commit({ '.yoal/workflows/ci.yml': 'name: ci\n', 'src/app.ts': 'x' }, 'add ci');
	const buildDir = join(root, 'build');
	const credentials = { gitToken: null, gitTokenHosts: [], gitSshKey: null, gitSshKnownHosts: null, buildDir };
	const claim = (overrides: Partial<PipelineResolveClaim> = {}): PipelineResolveClaim => ({
		kind: 'resolve',
		triggerId: 'trg_1',
		token: 't',
		repository: { id: 'r', name: 'acme/app', cloneUrl: origin.dir },
		ref: 'refs/heads/main',
		sha: null,
		...overrides,
	});

	test('reports sha, message and files, then cleans up', async () => {
		const reports: PipelineResolveReport[] = [];
		await runResolve({ claim: claim(), api: { resolve: async (report) => void reports.push(report) }, credentials, log: () => undefined });
		expect(reports).toEqual([{ sha, commitMessage: 'add ci', files: [{ path: '.yoal/workflows/ci.yml', content: 'name: ci\n' }] }]);
		expect(readdirSync(join(buildDir, 'pipelines'))).toEqual([]);
	});

	test('resolves at an explicit sha', async () => {
		const reports: PipelineResolveReport[] = [];
		await runResolve({ claim: claim({ sha }), api: { resolve: async (report) => void reports.push(report) }, credentials, log: () => undefined });
		expect(reports[0]?.sha).toBe(sha);
	});

	test('reports an error instead of hanging the trigger', async () => {
		const reports: PipelineResolveReport[] = [];
		await runResolve({
			claim: claim({ ref: 'refs/heads/nope' }),
			api: { resolve: async (report) => void reports.push(report) },
			credentials,
			log: () => undefined,
		});
		expect(reports).toHaveLength(1);
		expect(reports[0]?.error).toContain('git');
		expect(reports[0]?.files).toEqual([]);
	});
});
