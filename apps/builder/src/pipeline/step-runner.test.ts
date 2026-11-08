import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineJobClaim } from '@skiff/contracts';
import { JobApi } from './client.ts';
import { StepRunner, shellCommand } from './step-runner.ts';
import { jobClaim, startFakeControlPlane, stepSpec, type FakeControlPlane } from './test-server.ts';

const SECRET = 'sup3r-s3cret-value';
const root = mkdtempSync(join(tmpdir(), 'skiff-step-runner-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let fake: FakeControlPlane;
let workspace: string;
let counter = 0;

beforeEach(() => {
	fake = startFakeControlPlane({ secrets: { MY_SECRET: SECRET } });
	const dir = join(root, `job-${++counter}`);
	workspace = join(dir, 'workspace');
	mkdirSync(workspace, { recursive: true });
	mkdirSync(join(dir, 'home'), { recursive: true });
});
afterEach(() => fake.stop());

function makeRunner(
	claim: PipelineJobClaim,
	options: { killGraceMs?: number; actionsBaseUrl?: string; baseEnv?: Record<string, string | undefined> } = {},
): StepRunner {
	const dir = join(workspace, '..');
	return new StepRunner({
		claim,
		api: new JobApi(fake.url, fake.token),
		paths: { workspace, temp: join(dir, 'tmp'), home: join(dir, 'home'), toolCache: join(dir, 'home', 'tool-cache') },
		runnerName: 'test-runner',
		diagnostics: () => undefined,
		logFlushMs: 50,
		killGraceMs: options.killGraceMs ?? 500,
		baseEnv: options.baseEnv,
		// Never github.com in tests: an unserved port fails fast.
		actions: { baseUrl: options.actionsBaseUrl ?? 'http://127.0.0.1:9' },
	});
}

describe('shellCommand', () => {
	test('maps shells like GitHub', () => {
		expect(shellCommand(null, '/t/s.sh', true)).toEqual(['bash', '-e', '/t/s.sh']);
		expect(shellCommand(null, '/t/s.sh', false)).toEqual(['sh', '-e', '/t/s.sh']);
		expect(shellCommand('bash', '/t/s.sh', true)).toEqual(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '/t/s.sh']);
		expect(shellCommand('sh', '/t/s.sh', true)).toEqual(['sh', '-e', '/t/s.sh']);
		expect(shellCommand('perl -w {0}', '/t/s.sh', true)).toEqual(['perl', '-w', '/t/s.sh']);
		expect(() => shellCommand('zsh -e', '/t/s.sh', true)).toThrow(/\{0\}/);
	});
});

describe('StepRunner end-to-end (real bash, fake control plane)', () => {
	test('outputs, $SKIFF_ENV, $SKIFF_PATH, env layering, masking and job outputs', async () => {
		mkdirSync(join(workspace, 'tools'));
		writeFileSync(join(workspace, 'tools', 'hello-tool'), '#!/bin/sh\necho tool-ran\n', { mode: 0o755 });
		const claim = jobClaim({
			workflowEnv: { LEVEL: 'workflow', WF_ONLY: 'wf' },
			job: {
				env: { LEVEL: 'job', DERIVED: '${{ env.WF_ONLY }}-${{ matrix.node }}' },
				outputs: { greeting: '${{ steps.first.outputs.greeting }}', leak: '${{ secrets.MY_SECRET }}', multi: '${{ steps.first.outputs.multi }}' },
			},
			steps: [
				stepSpec({
					id: 'first',
					run: [
						'echo "greeting=hello" >> "$SKIFF_OUTPUT"',
						'{ echo "multi<<EOF"; echo "line one"; echo "line two"; echo "EOF"; } >> "$GITHUB_OUTPUT"',
						'echo "FROM_FILE=file-value" >> "$GITHUB_ENV"',
						'echo "$SKIFF_WORKSPACE/tools" >> "$SKIFF_PATH"',
						'echo "::set-output name=legacy::old-style"',
						'echo "secret: $MY"',
						'printf "%s" "$MY" | base64',
						'echo "::add-mask::dynamic-value"',
						'echo "dynamic-value is hidden"',
						'echo "level=$LEVEL derived=$DERIVED ci=$CI gh=$GITHUB_ACTIONS sha=$GITHUB_SHA ref_name=$SKIFF_REF_NAME"',
						'echo "token=${SKIFF_JOB_TOKEN:-unset}"',
					].join('\n'),
					env: { MY: '${{ secrets.MY_SECRET }}', LEVEL: 'step' },
				}),
				stepSpec({
					run: 'echo "got ${{ steps.first.outputs.greeting }} $FROM_FILE ${{ steps.first.outputs.legacy }} level=$LEVEL"\nhello-tool',
				}),
			],
		});
		const { complete, delivered } = await makeRunner(claim).run();
		expect(delivered).toBe(true);
		expect(complete.conclusion).toBe('success');
		expect(fake.completes).toEqual([complete]);
		// The secret-bearing job output is dropped, as on GitHub.
		expect(complete.outputs).toEqual({ greeting: 'hello', multi: 'line one\nline two' });

		const first = fake.stepLog(0).join('\n');
		expect(first).toContain('secret: ***');
		expect(first).toContain('*** is hidden');
		expect(first).toContain('level=step derived=wf-24 ci=true gh=true sha=' + 'a'.repeat(40) + ' ref_name=main');
		expect(first).toContain('token=unset');
		expect(first).not.toContain('::add-mask::');
		const second = fake.stepLog(1).join('\n');
		expect(second).toContain('got hello file-value old-style level=job');
		expect(second).toContain('tool-ran');

		const all = fake.logText();
		expect(all).not.toContain(SECRET);
		expect(all).not.toContain(Buffer.from(SECRET).toString('base64'));
		expect(all).not.toContain('dynamic-value');

		const steps = fake.finalSteps();
		expect(steps.get(0)).toMatchObject({ conclusion: 'success', outputs: { greeting: 'hello', legacy: 'old-style' } });
		expect(steps.get(1)?.conclusion).toBe('success');
		expect(fake.steps[0]).toEqual({ index: 0, report: { status: 'in_progress', name: expect.any(String) } });
	});

	test('failure skips later steps except failure()/always(); job fails', async () => {
		const claim = jobClaim({
			steps: [
				stepSpec({ id: 'boom', run: 'echo before\nexit 3\necho never' }),
				stepSpec({ run: 'echo should-not-run' }),
				stepSpec({ if: 'failure()', run: 'echo on-failure ${{ steps.boom.outcome }}' }),
				stepSpec({ if: '${{ always() }}', run: 'echo always-ran job=${{ job.status }}' }),
				stepSpec({ if: "steps.boom.outcome == 'failure'", run: 'echo implicit-success-guard' }),
			],
		});
		const { complete } = await makeRunner(claim).run();
		expect(complete.conclusion).toBe('failure');
		const steps = fake.finalSteps();
		expect([0, 1, 2, 3, 4].map((index) => steps.get(index)?.conclusion)).toEqual(['failure', 'skipped', 'success', 'success', 'skipped']);
		expect(fake.stepLog(0)).toContain('Process completed with exit code 3.');
		expect(fake.stepLog(0)).not.toContain('never');
		expect(fake.stepLog(2)).toContain('on-failure failure');
		expect(fake.logText()).not.toContain('should-not-run');
		expect(fake.stepLog(3)).toContain('always-ran job=failure');
	});

	test('bash steps run with -e, and shell: bash adds pipefail', async () => {
		const claim = jobClaim({
			steps: [
				stepSpec({ id: 'plain', run: 'false | true\necho pipe-ok', continueOnError: true }),
				stepSpec({ id: 'strict', shell: 'bash', run: 'false | true\necho strict-not-reached', continueOnError: true }),
			],
		});
		await makeRunner(claim).run();
		const steps = fake.finalSteps();
		expect(steps.get(0)?.conclusion).toBe('success');
		expect(fake.stepLog(0)).toContain('pipe-ok');
		expect(fake.stepLog(1)).not.toContain('strict-not-reached');
	});

	test('continue-on-error keeps the job green and exposes outcome vs conclusion', async () => {
		const claim = jobClaim({
			steps: [
				stepSpec({ id: 'flaky', run: 'exit 1', continueOnError: '${{ matrix.node == 24 }}' }),
				stepSpec({ run: 'echo next ${{ steps.flaky.outcome }}/${{ steps.flaky.conclusion }}' }),
			],
		});
		const { complete } = await makeRunner(claim).run();
		expect(complete.conclusion).toBe('success');
		expect(fake.finalSteps().get(0)?.conclusion).toBe('success');
		expect(fake.stepLog(1)).toContain('next failure/success');
	});

	test('a step timeout fails the step and kills its process group', async () => {
		const marker = join(workspace, 'child-survived');
		const claim = jobClaim({
			steps: [
				stepSpec({ run: `(sleep 3; touch ${marker}) &\nsleep 30`, timeoutMinutes: 1 / 60 }),
				stepSpec({ if: 'always()', run: 'echo after-timeout' }),
			],
		});
		const started = Date.now();
		const { complete } = await makeRunner(claim).run();
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(complete.conclusion).toBe('failure');
		expect(fake.finalSteps().get(0)?.conclusion).toBe('failure');
		expect(fake.stepLog(0).join('\n')).toContain('timed out');
		expect(fake.stepLog(1)).toContain('after-timeout');
		await Bun.sleep(3_500);
		expect(existsSync(marker)).toBe(false);
	}, 20_000);

	test('the job timeout cancels the running step, runs always() steps, and completes timed_out', async () => {
		const claim = jobClaim({
			job: { timeoutMinutes: 1.5 / 60 },
			steps: [
				stepSpec({ run: 'sleep 30' }),
				stepSpec({ run: 'echo skipped-after-timeout' }),
				stepSpec({ if: 'always()', run: 'echo cleanup-ran' }),
			],
		});
		const { complete } = await makeRunner(claim).run();
		expect(complete.conclusion).toBe('timed_out');
		const steps = fake.finalSteps();
		expect(steps.get(0)?.conclusion).toBe('cancelled');
		expect(steps.get(1)?.conclusion).toBe('skipped');
		expect(fake.stepLog(2)).toContain('cleanup-ran');
	}, 20_000);

	test('cancellation (SIGTERM) stops the step, runs always()/cancelled() steps, completes cancelled', async () => {
		const claim = jobClaim({
			steps: [
				stepSpec({ run: 'echo started\nsleep 30\necho not-reached' }),
				stepSpec({ run: 'echo normal-step' }),
				stepSpec({ if: 'cancelled()', run: 'echo saw-cancel' }),
				stepSpec({ if: 'always()', run: 'echo always-after-cancel' }),
			],
		});
		const runner = makeRunner(claim);
		const running = runner.run();
		const deadline = Date.now() + 5_000;
		while (!fake.logs.some((line) => line.text === 'started') && Date.now() < deadline) await Bun.sleep(25);
		runner.cancel();
		const { complete } = await running;
		expect(complete.conclusion).toBe('cancelled');
		const steps = fake.finalSteps();
		expect([0, 1, 2, 3].map((index) => steps.get(index)?.conclusion)).toEqual(['cancelled', 'skipped', 'success', 'success']);
		expect(fake.logText()).not.toContain('not-reached');
		expect(fake.stepLog(2)).toContain('saw-cancel');
	}, 20_000);

	test('working-directory must stay inside the workspace', async () => {
		mkdirSync(join(workspace, 'sub'));
		const claim = jobClaim({
			job: { defaults: { shell: null, workingDirectory: 'sub' } },
			steps: [stepSpec({ run: 'pwd' }), stepSpec({ if: 'always()', run: 'pwd', workingDirectory: '../..' })],
		});
		const { complete } = await makeRunner(claim).run();
		expect(complete.conclusion).toBe('failure');
		expect(fake.stepLog(0).some((line) => line.endsWith('/workspace/sub'))).toBe(true);
		expect(fake.stepLog(1).join('\n')).toContain('outside the workspace');
	});

	test('if: errors and unsupported actions fail the step; checkout is a no-op', async () => {
		const claim = jobClaim({
			steps: [
				stepSpec({ uses: 'actions/checkout@v4' }),
				stepSpec({ uses: 'actions/checkout@v4', with: { repository: 'someone/else' }, continueOnError: true }),
				stepSpec({ uses: 'docker://alpine:3', continueOnError: true }),
				stepSpec({ if: 'always() && (', run: 'echo x' }),
			],
		});
		const { complete } = await makeRunner(claim).run();
		expect(complete.conclusion).toBe('failure');
		const steps = fake.finalSteps();
		expect(steps.get(0)?.conclusion).toBe('success');
		expect(fake.stepLog(0).join('\n')).toContain('a'.repeat(40));
		expect(fake.stepLog(1).join('\n')).toContain('not supported yet');
		expect(fake.stepLog(2).join('\n')).toContain('Docker-container actions (docker://alpine:3) are not supported');
		expect(steps.get(3)?.conclusion).toBe('failure');
	});

	test('hashFiles() is available in templates', async () => {
		writeFileSync(join(workspace, 'bun.lock'), 'lockfile');
		const claim = jobClaim({ steps: [stepSpec({ run: "echo key-${{ hashFiles('bun.lock') }}-${{ hashFiles('nothing/**') }}-end" })] });
		await makeRunner(claim).run();
		const line = fake.stepLog(0).find((text) => text.startsWith('key-'))!;
		expect(line).toMatch(/^key-[a-f0-9]{64}--end$/);
	});

	test('upload-artifact and download-artifact round-trip through the job API', async () => {
		mkdirSync(join(workspace, 'dist', 'nested'), { recursive: true });
		writeFileSync(join(workspace, 'dist', 'index.html'), '<h1>hi</h1>');
		writeFileSync(join(workspace, 'dist', 'nested', 'a.js'), 'console.log(1)');
		writeFileSync(join(workspace, 'dist', 'skip.map'), 'map');
		const claim = jobClaim({
			steps: [
				stepSpec({ id: 'up', uses: 'actions/upload-artifact@v4', with: { name: 'site', path: 'dist/\n!**/*.map' } }),
				stepSpec({ uses: 'actions/upload-artifact@v4', with: { name: 'none', path: 'nope/*', 'if-no-files-found': 'error' }, continueOnError: true }),
				stepSpec({ uses: 'skiff/download-artifact@v1', with: { name: 'site', path: 'restored' } }),
				stepSpec({ uses: 'skiff/download-artifact@v1', with: { path: 'all' } }),
				stepSpec({ run: 'echo id=${{ steps.up.outputs.artifact-id }}' }),
			],
		});
		const { complete } = await makeRunner(claim).run();
		expect(complete.conclusion).toBe('success');
		expect(fake.finalSteps().get(1)?.conclusion).toBe('success');
		expect(fake.stepLog(1).join('\n')).toContain('No files were found');
		expect(readFileSync(join(workspace, 'restored', 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
		expect(readFileSync(join(workspace, 'restored', 'nested', 'a.js'), 'utf8')).toBe('console.log(1)');
		expect(existsSync(join(workspace, 'restored', 'skip.map'))).toBe(false);
		expect(readFileSync(join(workspace, 'all', 'site', 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
		expect(fake.stepLog(4)).toContain('id=art1');
	});

	test('cache misses, saves in the post phase on success, then hits exactly', async () => {
		const cacheStep = stepSpec({ id: 'cache', uses: 'actions/cache@v4', with: { path: 'deps\n~/.cache/tool', key: 'deps-v1', 'restore-keys': 'deps-' } });
		const first = jobClaim({
			steps: [
				cacheStep,
				stepSpec({ run: 'echo hit=${{ steps.cache.outputs.cache-hit }}\nmkdir -p deps ~/.cache/tool\necho cached > deps/file\necho home > ~/.cache/tool/x' }),
			],
		});
		const result = await makeRunner(first).run();
		expect(result.complete.conclusion).toBe('success');
		expect(fake.stepLog(1)).toContain('hit=false');
		expect(fake.stepLog(0).join('\n')).toContain('Cache saved with key: deps-v1');
		expect(fake.caches.size).toBe(1);

		rmSync(join(workspace, 'deps'), { recursive: true });
		rmSync(join(workspace, '..', 'home', '.cache'), { recursive: true });
		const second = jobClaim({ steps: [cacheStep, stepSpec({ run: 'echo hit=${{ steps.cache.outputs.cache-hit }}\ncat deps/file ~/.cache/tool/x' })] });
		const before = fake.caches.size;
		await makeRunner(second).run();
		expect(fake.stepLog(1)).toContain('hit=true');
		expect(fake.stepLog(1)).toContain('cached');
		expect(fake.stepLog(1)).toContain('home');
		expect(fake.caches.size).toBe(before);
	});
});

/** Write files under the workspace (`.github/actions/x/action.yml` …). */
function writeFiles(base: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(base, path, '..'), { recursive: true });
		writeFileSync(join(base, path), content);
	}
}

const NODE_MAIN = `
const fs = require('node:fs');
const append = (file, text) => fs.appendFileSync(process.env[file], text + '\\n');
console.log('main name=' + process.env.INPUT_NAME + ' spaced=' + process.env.INPUT_MY_INPUT + ' token=[' + process.env.INPUT_TOKEN + ']');
console.log('state-from-pre=' + process.env.STATE_phase);
console.log('action=' + process.env.GITHUB_ACTION + ' repo=[' + process.env.GITHUB_ACTION_REPOSITORY + '] path-ok=' + (process.env.GITHUB_ACTION_PATH.endsWith('/node-act')));
console.log('::add-mask::' + process.env.INPUT_SECRET);
console.log('the secret is ' + process.env.INPUT_SECRET);
append('GITHUB_OUTPUT', 'greeting=hello ' + process.env.INPUT_NAME);
append('GITHUB_ENV', 'FROM_NODE=exported');
append('GITHUB_PATH', process.env.GITHUB_ACTION_PATH + '/bin');
append('GITHUB_STATE', 'phase=main');
console.log('::set-output name=legacy::old');
`;

describe('StepRunner actions (composite and JavaScript)', () => {
	test('a local composite action: inputs with expression defaults, env, outputs, nested steps', async () => {
		writeFiles(workspace, {
			'.github/actions/greet/action.yml': `
name: greet
inputs:
  who: { default: "\${{ github.repository }}" }
  token: { default: "\${{ github.token }}" }
  unset: { required: false }
outputs:
  message: { value: "\${{ steps.say.outputs.message }}" }
  where: { value: "\${{ github.action_path }}" }
runs:
  using: composite
  steps:
    - id: say
      shell: bash
      run: |
        echo "hello \${{ inputs.who }} token=[\${{ inputs.token }}] unset=[\${{ inputs.unset }}] step-env=$FROM_STEP"
        echo "message=hi-\${{ inputs.who }}" >> "$GITHUB_OUTPUT"
        echo "COMPOSITE_ENV=set" >> "$GITHUB_ENV"
        bash "$GITHUB_ACTION_PATH/helper.sh"
    - if: failure()
      shell: bash
      run: echo never-runs
    - shell: sh
      run: echo "prev=\${{ steps.say.outputs.message }} env=$COMPOSITE_ENV"
    - uses: ./.github/actions/inner
      with: { value: "\${{ inputs.who }}" }
`,
			'.github/actions/greet/helper.sh': 'echo "helper ran in $(basename "$GITHUB_ACTION_PATH")"\n',
			'.github/actions/inner/action.yml': `
inputs: { value: {} }
runs:
  using: composite
  steps:
    - run: echo "inner got \${{ inputs.value }}"
      shell: bash
`,
		});
		const claim = jobClaim({
			steps: [
				stepSpec({ id: 'greet', uses: './.github/actions/greet', with: { who: 'kieran' }, env: { FROM_STEP: 'yes' } }),
				stepSpec({ id: 'default', uses: './.github/actions/greet' }),
				stepSpec({ run: 'echo "out=${{ steps.greet.outputs.message }} default=${{ steps.default.outputs.message }} env=$COMPOSITE_ENV leak=[${{ steps.say.outputs.message }}]"' }),
			],
		});
		const { complete } = await makeRunner(claim).run();
		expect(complete.conclusion).toBe('success');
		const log = fake.stepLog(0).join('\n');
		expect(log).toContain('hello kieran token=[] unset=[] step-env=yes');
		expect(log).toContain('helper ran in greet');
		expect(log).toContain('prev=hi-kieran env=set');
		expect(log).toContain('inner got kieran');
		expect(log).not.toContain('never-runs');
		expect(fake.stepLog(1).join('\n')).toContain('hello acme/app');
		// Nested step ids stay inside the composite.
		expect(fake.stepLog(2)).toContain('out=hi-kieran default=hi-acme/app env=set leak=[]');
		const outputs = fake.finalSteps().get(0)?.outputs ?? {};
		expect(outputs.message).toBe('hi-kieran');
		expect(outputs.where).toEndWith('/.github/actions/greet');
	});

	test('a failing composite step fails the action; failure() steps inside still run', async () => {
		writeFiles(workspace, {
			'act/action.yml': `
runs:
  using: composite
  steps:
    - { shell: bash, run: "exit 4" }
    - { shell: bash, run: "echo skipped-inside" }
    - { if: "failure()", shell: bash, run: "echo cleanup-inside" }
`,
		});
		const claim = jobClaim({ steps: [stepSpec({ uses: './act' }), stepSpec({ run: 'echo after' })] });
		const { complete } = await makeRunner(claim).run();
		expect(complete.conclusion).toBe('failure');
		expect(fake.finalSteps().get(0)?.conclusion).toBe('failure');
		expect(fake.finalSteps().get(1)?.conclusion).toBe('skipped');
		const log = fake.stepLog(0).join('\n');
		expect(log).toContain('Process completed with exit code 4.');
		expect(log).toContain('cleanup-inside');
		expect(log).not.toContain('skipped-inside');
	});

	test('a local JavaScript action: INPUT_*, file commands, state, masking, pre and post', async () => {
		const order = join(workspace, '..', 'order.txt');
		writeFiles(workspace, {
			'.github/actions/node-act/action.yml': `
inputs:
  name: { default: "\${{ github.repository }}" }
  token: { default: "\${{ github.token }}" }
  secret: {}
  My Input: { default: spaced }
outputs: { greeting: {} }
runs:
  using: node20
  pre: pre.js
  main: main.js
  post: post.js
`,
			'.github/actions/node-act/pre.js': `require('node:fs').appendFileSync(process.env.GITHUB_STATE, 'phase=pre\\n'); console.log('pre ran');`,
			'.github/actions/node-act/main.js': NODE_MAIN,
			'.github/actions/node-act/post.js': `require('node:fs').appendFileSync(${JSON.stringify(order)}, 'node-act ' + process.env.STATE_phase + '\\n'); console.log('post state=' + process.env.STATE_phase);`,
			'.github/actions/node-act/bin/added-tool': '#!/bin/sh\necho added-tool-ran\n',
			'.github/actions/second/action.yml': 'runs: { using: node24, main: main.js, post: post.js }\n',
			'.github/actions/second/main.js': 'console.log("second main")',
			'.github/actions/second/post.js': `require('node:fs').appendFileSync(${JSON.stringify(order)}, 'second\\n')`,
			'.github/actions/never/action.yml': "runs: { using: node20, main: main.js, post: post.js, post-if: 'failure()' }\n",
			'.github/actions/never/main.js': '',
			'.github/actions/never/post.js': `require('node:fs').appendFileSync(${JSON.stringify(order)}, 'never\\n')`,
		});
		Bun.spawnSync(['chmod', '+x', join(workspace, '.github/actions/node-act/bin/added-tool')]);
		const claim = jobClaim({
			steps: [
				stepSpec({ id: 'n', uses: './.github/actions/node-act', with: { secret: 'node-secret-value', unknown: 'x' } }),
				stepSpec({ uses: './.github/actions/second' }),
				stepSpec({ uses: './.github/actions/never' }),
				stepSpec({ run: 'echo "greeting=${{ steps.n.outputs.greeting }} legacy=${{ steps.n.outputs.legacy }} env=$FROM_NODE"\nadded-tool' }),
			],
		});
		const { complete } = await makeRunner(claim).run();
		expect(complete.conclusion).toBe('success');
		const log = fake.stepLog(0).join('\n');
		expect(log).toContain('pre ran');
		expect(log).toContain('main name=acme/app spaced=spaced token=[]');
		expect(log).toContain('state-from-pre=pre');
		expect(log).toContain('action=n repo=[] path-ok=true');
		expect(log).toContain('the secret is ***');
		expect(log).toContain("Unexpected input(s) 'unknown'");
		expect(log).toContain('post state=main');
		expect(fake.logText()).not.toContain('node-secret-value');
		expect(fake.finalSteps().get(0)?.outputs).toEqual({ greeting: 'hello acme/app', legacy: 'old' });
		expect(fake.stepLog(3)).toContain('greeting=hello acme/app legacy=old env=exported');
		expect(fake.stepLog(3)).toContain('added-tool-ran');
		// Post steps run last-registered first; post-if: failure() is skipped on success.
		expect(readFileSync(order, 'utf8')).toBe('second\nnode-act main\n');
	});

	test('a failing post step fails the job', async () => {
		writeFiles(workspace, {
			'a/action.yml': 'runs: { using: node20, main: main.js, post: post.js }\n',
			'a/main.js': '',
			'a/post.js': 'process.exit(3)',
		});
		const { complete } = await makeRunner(jobClaim({ steps: [stepSpec({ uses: './a' })] })).run();
		expect(complete.conclusion).toBe('failure');
		expect(fake.stepLog(0).join('\n')).toContain('post step failed');
	});

	test('JavaScript actions need node on PATH', async () => {
		writeFiles(workspace, { 'a/action.yml': 'runs: { using: node20, main: main.js }\n', 'a/main.js': '' });
		const emptyBin = join(workspace, '..', 'empty-bin');
		mkdirSync(emptyBin, { recursive: true });
		const { complete } = await makeRunner(jobClaim({ steps: [stepSpec({ uses: './a' })] }), { baseEnv: { PATH: emptyBin } }).run();
		expect(complete.conclusion).toBe('failure');
		expect(fake.stepLog(0).join('\n')).toContain('needs Node.js, but node is not on PATH');
	});

	test('docker actions, traversal and missing actions fail with clear messages', async () => {
		const outside = join(workspace, '..', 'outside-action');
		writeFiles(outside, { 'action.yml': 'runs: { using: composite, steps: [{ run: echo escaped, shell: bash }] }\n' });
		symlinkSync(outside, join(workspace, 'linked'));
		writeFiles(workspace, {
			'docker/action.yml': 'runs: { using: docker, image: Dockerfile }\n',
			'escape/action.yml': 'runs: { using: node20, main: ../../outside-action/x.js }\n',
		});
		writeFileSync(join(outside, 'x.js'), 'console.log("escaped")');
		const claim = jobClaim({
			steps: [
				stepSpec({ uses: './docker', continueOnError: true }),
				stepSpec({ uses: './linked', continueOnError: true }),
				stepSpec({ uses: './escape', continueOnError: true }),
				stepSpec({ uses: './missing', continueOnError: true }),
				stepSpec({ uses: './../outside-action', continueOnError: true }),
			],
		});
		await makeRunner(claim).run();
		expect(fake.stepLog(0).join('\n')).toContain('Docker container action');
		expect(fake.stepLog(0).join('\n')).toContain('docs/RUNNERS.md');
		expect(fake.stepLog(1).join('\n')).toContain('resolves outside the workspace');
		expect(fake.stepLog(2).join('\n')).toContain('is outside the action');
		expect(fake.stepLog(3).join('\n')).toContain('does not exist in the workspace');
		expect(fake.stepLog(4).join('\n')).toContain('must stay inside the workspace');
		expect(fake.logText()).not.toContain('escaped');
		expect([0, 1, 2, 3, 4].map((index) => fake.finalSteps().get(index)?.conclusion)).toEqual(['success', 'success', 'success', 'success', 'success']);
	});

	test('composite actions nested too deep fail', async () => {
		writeFiles(workspace, { 'loop/action.yml': 'runs: { using: composite, steps: [{ uses: ./loop }] }\n' });
		const { complete } = await makeRunner(jobClaim({ steps: [stepSpec({ uses: './loop' })] })).run();
		expect(complete.conclusion).toBe('failure');
		expect(fake.stepLog(0).join('\n')).toContain('nested more than 10 deep');
	});

	test('a remote action is downloaded once per job from the codeload-style server', async () => {
		const source = join(workspace, '..', 'tarball-src');
		writeFiles(join(source, 'hello-v1'), {
			'sub/action.yml': `
inputs: { who: { default: world } }
outputs: { said: { value: "\${{ steps.s.outputs.said }}" } }
runs:
  using: composite
  steps:
    - id: s
      shell: bash
      run: |
        echo "remote says hi \${{ inputs.who }} from $GITHUB_ACTION_REPOSITORY@$GITHUB_ACTION_REF"
        echo "said=\${{ inputs.who }}" >> "$GITHUB_OUTPUT"
`,
		});
		const tarball = join(workspace, '..', 'hello.tar.gz');
		expect(Bun.spawnSync(['tar', '-czf', tarball, '-C', source, 'hello-v1']).exitCode).toBe(0);
		const requests: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				requests.push(path);
				return path === '/acme/hello/tar.gz/v1' ? new Response(Bun.file(tarball)) : new Response('nope', { status: 404 });
			},
		});
		try {
			const claim = jobClaim({
				steps: [
					stepSpec({ id: 'a', uses: 'acme/hello/sub@v1', with: { who: 'kieran' } }),
					stepSpec({ uses: 'acme/hello/sub@v1' }),
					stepSpec({ uses: 'acme/missing@v1', continueOnError: true }),
					stepSpec({ run: 'echo said=${{ steps.a.outputs.said }}' }),
				],
			});
			const { complete } = await makeRunner(claim, { actionsBaseUrl: `http://127.0.0.1:${server.port}` }).run();
			expect(complete.conclusion).toBe('success');
			expect(fake.stepLog(0).join('\n')).toContain('remote says hi kieran from acme/hello@v1');
			expect(fake.stepLog(0).join('\n')).toContain('not pinned to a full commit SHA');
			expect(fake.stepLog(1).join('\n')).toContain('remote says hi world');
			expect(fake.stepLog(2).join('\n')).toContain('HTTP 404');
			expect(fake.stepLog(3)).toContain('said=kieran');
			expect(requests).toEqual(['/acme/hello/tar.gz/v1', '/acme/missing/tar.gz/v1']);
		} finally {
			server.stop(true);
		}
	});
});
