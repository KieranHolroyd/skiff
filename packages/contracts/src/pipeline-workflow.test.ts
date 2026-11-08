import { describe, expect, test } from 'bun:test';
import { resolvePipelineAction, type PipelineTriggerEvent, type PipelineWorkflowIssue } from './pipeline.ts';
import {
	checkWorkflowCallSecrets,
	coerceDispatchInputs,
	expandMatrix,
	findWorkflowCalls,
	parseActionManifest,
	parsePipelineActionRef,
	validateWorkflowCallInputs,
	workflowCallOutputs,
	globMatch,
	matrixJobName,
	parseWorkflow,
	PipelineWorkflowError,
	topologicalJobOrder,
	workflowTriggerMatches,
} from './pipeline-workflow.ts';

const PATH = '.skiff/workflows/ci.yml';

function yaml(text: string): unknown {
	return Bun.YAML.parse(text);
}

function issuesOf(doc: unknown): PipelineWorkflowIssue[] {
	try {
		parseWorkflow(doc, PATH);
	} catch (error) {
		if (error instanceof PipelineWorkflowError) return error.issues;
		throw error;
	}
	return [];
}

/** A minimal valid workflow with one job, overridable per test. */
function minimal(job: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		on: 'push',
		jobs: { build: { 'runs-on': 'linux', steps: [{ run: 'echo hi' }], ...job } },
		...top,
	};
}

/**
 * docs/PIPELINES.md §5.1, verbatim except that the two unquoted `${{ }}` values inside flow
 * mappings (`{ group: ci-${{ … }} }`, `{ key: bun-${{ … }} }`) are quoted: `{`/`}` are flow
 * indicators there, so the docs' version is not valid YAML (Bun.YAML and GitHub both reject it).
 */
const DOCS_EXAMPLE = `
name: ci
on:
  push: { branches: [main] }
  pull_request: {}
  workflow_dispatch:
    inputs: { promote: { type: boolean, default: false } }

concurrency: { group: "ci-\${{ skiff.ref }}", cancel-in-progress: true }

jobs:
  test:
    runs-on: [linux]
    steps:
      - uses: actions/checkout@v4          # built-in alias, no github.com API needed
      - uses: actions/cache@v4             # aliased to skiff/cache
        with: { path: ~/.bun/install/cache, key: "bun-\${{ hashFiles('bun.lock') }}" }
      - run: bun install --frozen-lockfile && bun test
    services:
      postgres: { image: postgres:17, env: { POSTGRES_PASSWORD: test } }

  image:
    needs: test
    strategy: { matrix: { arch: [x64, arm64] } }
    runs-on: [linux, "\${{ matrix.arch }}", oci-build]
    outputs: { digest: "\${{ steps.b.outputs.digest }}" }
    steps:
      - uses: actions/checkout@v4
      - id: b
        uses: skiff/build-image@v1
        with: { tags: "registry/acme/api:\${{ skiff.sha }}-\${{ matrix.arch }}" }

  deploy:
    needs: image
    if: skiff.ref == 'refs/heads/main'
    environment: production
    runs-on: [linux]
    steps:
      - id: idx
        uses: skiff/image-index@v1
        with:   # matrix job outputs collide (as in GHA), so join by the per-arch tags
          tag: "registry/acme/api:\${{ skiff.sha }}"
          sources: "registry/acme/api:\${{ skiff.sha }}-x64 registry/acme/api:\${{ skiff.sha }}-arm64"
      - uses: skiff/deploy@v1
        with: { project: api, image: "\${{ steps.idx.outputs.image }}", promote: true }
`;

describe('parseWorkflow', () => {
	test('the docs §5.1 example parses', () => {
		const doc = yaml(DOCS_EXAMPLE);
		// `skiff/image-index` is used by the example but is not (yet) in pipelineBuiltinActions.
		if (resolvePipelineAction('skiff/image-index@v1') === null) {
			expect(issuesOf(doc)).toEqual([
				{ path: 'jobs.deploy.steps[0].uses', message: expect.stringContaining("'skiff/image-index@v1' is not supported") },
			]);
			return;
		}
		const workflow = parseWorkflow(doc, PATH);
		expect(workflow.name).toBe('ci');
		expect(workflow.jobs.image!.outputs).toEqual({ digest: '${{ steps.b.outputs.digest }}' });
	});

	test('the docs example without the unknown action normalizes fully', () => {
		const text = DOCS_EXAMPLE.replace('uses: skiff/image-index@v1', 'uses: skiff/build-image@v1');
		const workflow = parseWorkflow(yaml(text), PATH);
		expect(workflow.name).toBe('ci');
		expect(workflow.path).toBe(PATH);
		expect(workflow.concurrency).toEqual({ group: 'ci-${{ skiff.ref }}', cancelInProgress: true });
		expect(workflow.on.push).toEqual({ branches: ['main'], branchesIgnore: null, tags: null, tagsIgnore: null, paths: null, pathsIgnore: null });
		expect(workflow.on.pullRequest?.types).toEqual(['opened', 'synchronize', 'reopened']);
		expect(workflow.on.workflowDispatch).toEqual({
			inputs: { promote: { type: 'boolean', description: null, required: false, default: false, options: [] } },
		});
		expect(Object.keys(workflow.jobs)).toEqual(['test', 'image', 'deploy']);

		const testJob = workflow.jobs.test!;
		expect(testJob.name).toBe('test');
		expect(testJob.timeoutMinutes).toBe(60);
		expect(testJob.strategy).toEqual({ matrix: null, failFast: true, maxParallel: null });
		expect(testJob.services).toEqual({ postgres: { image: 'postgres:17', env: { POSTGRES_PASSWORD: 'test' }, ports: [], healthCmd: null } });
		expect(testJob.steps.map((step) => step.name)).toEqual(['Run actions/checkout@v4', 'Run actions/cache@v4', 'Run bun install --frozen-lockfile && bun test']);
		expect(testJob.steps[1]!.with).toEqual({ path: '~/.bun/install/cache', key: "bun-${{ hashFiles('bun.lock') }}" });

		const image = workflow.jobs.image!;
		expect(image.needs).toEqual(['test']);
		expect(image.runsOn).toEqual(['linux', '${{ matrix.arch }}', 'oci-build']);
		expect(image.strategy.matrix).toEqual({ arch: ['x64', 'arm64'] });
		expect(image.outputs).toEqual({ digest: '${{ steps.b.outputs.digest }}' });
		expect(image.steps[1]!.id).toBe('b');

		const deploy = workflow.jobs.deploy!;
		expect(deploy.if).toBe("skiff.ref == 'refs/heads/main'");
		expect(deploy.environment).toEqual({ name: 'production', url: null });
		expect(deploy.steps[1]!.with).toEqual({ project: 'api', image: '${{ steps.idx.outputs.image }}', promote: 'true' });
		expect(topologicalJobOrder(workflow)).toEqual(['test', 'image', 'deploy']);
	});

	test('a realistic CI workflow with every supported feature', () => {
		const workflow = parseWorkflow(
			yaml(`
name: Build and release
run-name: Release \${{ inputs.version }} by \${{ github.actor }}
on:
  push:
    branches: [main, 'release/**', '!release/old']
    tags: ['v*']
    paths-ignore: ['docs/**', '**.md']
  pull_request:
    types: [opened, synchronize, labeled]
    branches-ignore: [experimental]
    paths: ['src/**']
  workflow_dispatch:
    inputs:
      version: { description: Version to release, required: true, type: string }
      level: { type: choice, options: [patch, minor, major], default: patch }
      dry: { type: number, default: 1 }
      target: { type: environment }
  schedule:
    - cron: '0 3 * * 1'
    - cron: '*/30 * * * *'
env:
  CI: true
  RETRIES: 3
  TOKEN: \${{ secrets.TOKEN }}
defaults:
  run: { shell: bash, working-directory: app }
permissions:
  contents: read
  id-token: write
jobs:
  lint:
    runs-on: { group: big, labels: [linux, x64] }
    timeout-minutes: 10
    steps:
      - name: Install
        run: |
          bun install
          bun run lint
        env: { NODE_ENV: test }
      - run: echo "\${{ toJSON(github.event) }}"
        shell: sh -e {0}
        continue-on-error: true
        timeout-minutes: 5
        if: \${{ failure() }}
  test:
    name: Test \${{ matrix.os }}
    needs: [lint]
    if: \${{ !cancelled() && needs.lint.result == 'success' }}
    runs-on: \${{ matrix.os }}
    continue-on-error: \${{ matrix.experimental }}
    concurrency: test-\${{ matrix.os }}
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        os: [linux, macos]
        node: [20, 22]
        include:
          - os: linux
            experimental: true
        exclude:
          - os: macos
            node: 20
    container:
      image: node:\${{ matrix.node }}
      env: { TZ: UTC }
      options: --health-cmd "pg_isready -U postgres"
    services:
      redis:
        image: redis:7
        ports: [6379, '8080:80']
        options: --health-cmd="redis-cli ping"
    env: { MATRIX_OS: '\${{ matrix.os }}' }
    outputs:
      result: \${{ steps.run.outputs.result }}
    steps:
      - id: run
        run: bun test --node \${{ matrix.node }}
        working-directory: packages/\${{ matrix.os }}
  release:
    needs: [lint, test]
    runs-on: linux
    environment: { name: release, url: 'https://example.com/\${{ steps.pub.outputs.id }}' }
    defaults: { run: { shell: sh } }
    steps:
      - uses: actions/upload-artifact@v4
        with: { name: dist, retention-days: 5, compress: false }
      - id: pub
        uses: skiff/deploy@v1
        with: { project: web, archive: true }
`),
			PATH,
		);
		expect(workflow.name).toBe('Build and release');
		expect(workflow.runName).toBe('Release ${{ inputs.version }} by ${{ github.actor }}');
		expect(workflow.env).toEqual({ CI: 'true', RETRIES: '3', TOKEN: '${{ secrets.TOKEN }}' });
		expect(workflow.defaults).toEqual({ shell: 'bash', workingDirectory: 'app' });
		expect(workflow.on.push?.branches).toEqual(['main', 'release/**', '!release/old']);
		expect(workflow.on.push?.pathsIgnore).toEqual(['docs/**', '**.md']);
		expect(workflow.on.pullRequest?.types).toEqual(['opened', 'synchronize', 'labeled']);
		expect(workflow.on.schedule).toEqual(['0 3 * * 1', '*/30 * * * *']);
		expect(workflow.on.workflowDispatch?.inputs.level).toEqual({ type: 'choice', description: null, required: false, default: 'patch', options: ['patch', 'minor', 'major'] });
		expect(workflow.on.workflowDispatch?.inputs.dry?.default).toBe(1);

		const lint = workflow.jobs.lint!;
		expect(lint.runsOn).toEqual(['linux', 'x64']);
		expect(lint.timeoutMinutes).toBe(10);
		expect(lint.steps[0]!.name).toBe('Install');
		expect(lint.steps[1]!).toMatchObject({
			name: 'Run echo "${{ toJSON(github.event) }}"',
			shell: 'sh -e {0}',
			continueOnError: true,
			timeoutMinutes: 5,
			if: 'failure()',
		});

		const testJob = workflow.jobs.test!;
		expect(testJob.if).toBe("!cancelled() && needs.lint.result == 'success'");
		expect(testJob.runsOn).toEqual(['${{ matrix.os }}']);
		expect(testJob.continueOnError).toBe('${{ matrix.experimental }}');
		expect(testJob.concurrency).toEqual({ group: 'test-${{ matrix.os }}', cancelInProgress: false });
		expect(testJob.strategy.failFast).toBe(false);
		expect(testJob.strategy.maxParallel).toBe(2);
		expect(testJob.container).toEqual({ image: 'node:${{ matrix.node }}', env: { TZ: 'UTC' }, ports: [], healthCmd: 'pg_isready -U postgres' });
		expect(testJob.services.redis).toEqual({ image: 'redis:7', env: {}, ports: ['6379', '8080:80'], healthCmd: 'redis-cli ping' });
		expect(testJob.steps[0]!.workingDirectory).toBe('packages/${{ matrix.os }}');
		expect(expandMatrix(testJob.strategy.matrix as Record<string, unknown>)).toEqual([
			{ os: 'linux', node: 20, experimental: true },
			{ os: 'linux', node: 22, experimental: true },
			{ os: 'macos', node: 22 },
		]);

		const release = workflow.jobs.release!;
		expect(release.environment).toEqual({ name: 'release', url: 'https://example.com/${{ steps.pub.outputs.id }}' });
		expect(release.defaults).toEqual({ shell: 'sh', workingDirectory: null });
		expect(release.steps[0]!.with).toEqual({ name: 'dist', 'retention-days': '5', compress: 'false' });
		expect(topologicalJobOrder(workflow)).toEqual(['lint', 'test', 'release']);
	});

	test('on: string, list and bare events', () => {
		expect(parseWorkflow(minimal({}, { on: 'workflow_dispatch' }), PATH).on.workflowDispatch).toEqual({ inputs: {} });
		const listed = parseWorkflow(minimal({}, { on: ['push', 'pull_request'] }), PATH).on;
		expect(listed.push).not.toBeNull();
		expect(listed.pullRequest?.types).toEqual(['opened', 'synchronize', 'reopened']);
		expect(listed.workflowDispatch).toBeNull();
		expect(listed.schedule).toEqual([]);
	});

	test('defaults: job name is the key, workflow name is the path, timeout is 60', () => {
		const workflow = parseWorkflow(minimal(), PATH);
		expect(workflow.name).toBe(PATH);
		expect(workflow.jobs.build).toMatchObject({ name: 'build', timeoutMinutes: 60, continueOnError: false, if: null, needs: [], container: null, environment: null, concurrency: null });
		expect(workflow.jobs.build!.steps[0]).toEqual({
			id: null,
			name: 'Run echo hi',
			if: null,
			run: 'echo hi',
			shell: null,
			workingDirectory: null,
			uses: null,
			with: {},
			env: {},
			continueOnError: false,
			timeoutMinutes: null,
		});
	});

	test('if: accepts booleans and strips the wrapper; blank means none', () => {
		expect(parseWorkflow(minimal({ if: false }), PATH).jobs.build!.if).toBe('false');
		expect(parseWorkflow(minimal({ if: '${{ always() }}' }), PATH).jobs.build!.if).toBe('always()');
		expect(parseWorkflow(minimal({ if: '' }), PATH).jobs.build!.if).toBeNull();
	});
});

describe('parseWorkflow issues', () => {
	const cases: [string, unknown, string, RegExp][] = [
		['not a mapping', 'nope', '', /must be a YAML mapping/],
		['unknown top-level key', minimal({}, { nmae: 'x' }), 'nmae', /Unknown key 'nmae'/],
		['missing on', { jobs: minimal().jobs }, 'on', /on is required/],
		['unsupported trigger', minimal({}, { on: { release: null } }), 'on.release', /'release' trigger is not supported/],
		['unsupported trigger in a list', minimal({}, { on: ['push', 'workflow_run'] }), 'on.workflow_run', /not supported/],
		['unknown push filter', minimal({}, { on: { push: { branch: ['main'] } } }), 'on.push.branch', /Unknown key/],
		['branches and branches-ignore', minimal({}, { on: { push: { branches: ['a'], 'branches-ignore': ['b'] } } }), 'on.push', /either branches or branches-ignore/],
		['tags on pull_request', minimal({}, { on: { pull_request: { tags: ['v*'] } } }), 'on.pull_request.tags', /Unknown key/],
		['unknown pull_request type', minimal({}, { on: { pull_request: { types: ['opend'] } } }), 'on.pull_request.types', /Unknown pull_request type 'opend'/],
		['invalid glob', minimal({}, { on: { push: { branches: ['[z-a]'] } } }), 'on.push.branches', /Invalid pattern/],
		['schedule not a list', minimal({}, { on: { schedule: '0 * * * *' } }), 'on.schedule', /list of/],
		['bad cron', minimal({}, { on: { schedule: [{ cron: '61 * * * *' }] } }), 'on.schedule[0].cron', /./],
		['cron with extra key', minimal({}, { on: { schedule: [{ cron: '0 * * * *', tz: 'UTC' }] } }), 'on.schedule[0].tz', /Unknown key/],
		['unknown input type', minimal({}, { on: { workflow_dispatch: { inputs: { a: { type: 'date' } } } } }), 'on.workflow_dispatch.inputs.a.type', /Unknown input type/],
		['choice without options', minimal({}, { on: { workflow_dispatch: { inputs: { a: { type: 'choice' } } } } }), 'on.workflow_dispatch.inputs.a.options', /needs options/],
		['choice default not an option', minimal({}, { on: { workflow_dispatch: { inputs: { a: { type: 'choice', options: ['x'], default: 'y' } } } } }), 'on.workflow_dispatch.inputs.a.default', /one of x/],
		['boolean default', minimal({}, { on: { workflow_dispatch: { inputs: { a: { type: 'boolean', default: 'yes' } } } } }), 'on.workflow_dispatch.inputs.a.default', /true or false/],
		['options on a string input', minimal({}, { on: { workflow_dispatch: { inputs: { a: { options: ['x'] } } } } }), 'on.workflow_dispatch.inputs.a.options', /only apply to choice/],
		['unknown input key', minimal({}, { on: { workflow_dispatch: { inputs: { a: { deprecationMessage: 'x' } } } } }), 'on.workflow_dispatch.inputs.a.deprecationMessage', /Unknown key/],
		['no jobs', { on: 'push', jobs: {} }, 'jobs', /at least one job/],
		['bad job key', { on: 'push', jobs: { '1build': minimal().jobs } }, 'jobs.1build', /Job ids start with/],
		['unknown job key', minimal({ 'runs_on': 'linux' }), 'jobs.build.runs_on', /Unknown key 'runs_on'/],
		['reusable workflow outside .skiff', minimal({ uses: './.github/workflows/x.yml' }), 'jobs.build.uses', /Expected a reusable workflow path like \.\/\.skiff\/workflows/],
		['caller with steps', minimal({ uses: './.skiff/workflows/x.yml' }), 'jobs.build.steps', /cannot have steps:/],
		['caller with runs-on', minimal({ uses: './.skiff/workflows/x.yml' }), 'jobs.build.runs-on', /cannot have runs-on:/],
		['caller with env', { on: 'push', jobs: { c: { uses: './.skiff/workflows/x.yml', env: { A: 'b' } } } }, 'jobs.c.env', /cannot have env:/],
		['caller with environment', { on: 'push', jobs: { c: { uses: './.skiff/workflows/x.yml', environment: 'prod' } } }, 'jobs.c.environment', /cannot have environment:/],
		['caller with container', { on: 'push', jobs: { c: { uses: './.skiff/workflows/x.yml', container: 'node:24' } } }, 'jobs.c.container', /cannot have container:/],
		['caller with services', { on: 'push', jobs: { c: { uses: './.skiff/workflows/x.yml', services: {} } } }, 'jobs.c.services', /cannot have services:/],
		['caller with unknown key', { on: 'push', jobs: { c: { uses: './.skiff/workflows/x.yml', input: {} } } }, 'jobs.c.input', /Unknown key 'input' \(allowed with uses/],
		['remote reusable workflow', { on: 'push', jobs: { c: { uses: 'acme/shared/.github/workflows/build.yml@v1' } } }, 'jobs.c.uses', /Remote reusable workflows are not supported yet/],
		['local reusable workflow with a ref', { on: 'push', jobs: { c: { uses: './.skiff/workflows/x.yml@main' } } }, 'jobs.c.uses', /takes no @ref/],
		['reusable workflow calling itself', { on: 'push', jobs: { c: { uses: './.skiff/workflows/ci.yml' } } }, 'jobs.c.uses', /cannot call itself/],
		['caller secrets not inherit', { on: 'push', jobs: { c: { uses: './.skiff/workflows/x.yml', secrets: 'all' } } }, 'jobs.c.secrets', /'inherit' or a mapping/],
		['caller with uses secrets context', { on: 'push', jobs: { c: { uses: './.skiff/workflows/x.yml', with: { t: '${{ secrets.T }}' } } } }, 'jobs.c.with.t', /Context 'secrets' is not available/],
		['caller with uses steps context', { on: 'push', jobs: { c: { uses: './.skiff/workflows/x.yml', secrets: { T: '${{ steps.a.outputs.b }}' } } } }, 'jobs.c.secrets.T', /Context 'steps' is not available/],
		['with on a steps job', minimal({ with: { a: 1 } }), 'jobs.build.with', /reusable workflow/],
		['secrets on a steps job', minimal({ secrets: 'inherit' }), 'jobs.build.secrets', /reusable workflow/],
		['workflow_call choice input', minimal({}, { on: { workflow_call: { inputs: { a: { type: 'choice', options: ['x'] } } } } }), 'on.workflow_call.inputs.a.type', /Unknown input type 'choice' \(string, boolean, number\)/],
		['workflow_call input without type', minimal({}, { on: { workflow_call: { inputs: { a: { required: true } } } } }), 'on.workflow_call.inputs.a.type', /need a type/],
		['workflow_call options', minimal({}, { on: { workflow_call: { inputs: { a: { type: 'string', options: ['x'] } } } } }), 'on.workflow_call.inputs.a.options', /Unknown key/],
		['workflow_call output without value', minimal({}, { on: { workflow_call: { outputs: { d: { description: 'x' } } } } }), 'on.workflow_call.outputs.d.value', /value is required/],
		['workflow_call output uses steps', minimal({}, { on: { workflow_call: { outputs: { d: { value: '${{ steps.a.outputs.b }}' } } } } }), 'on.workflow_call.outputs.d.value', /Context 'steps' is not available/],
		['workflow_call bad secret name', minimal({}, { on: { workflow_call: { secrets: { 'my-token': { required: true } } } } }), 'on.workflow_call.secrets.my-token', /letters, digits and underscores/],
		['workflow_call unknown key', minimal({}, { on: { workflow_call: { input: {} } } }), 'on.workflow_call.input', /Unknown key/],
		['skiff_event bad type', minimal({}, { on: { skiff_event: { types: ['deploymentfailed'] } } }), 'on.skiff_event.types', /<source>\.<event>/],
		['skiff_event unknown key', minimal({}, { on: { skiff_event: { events: ['deployments.failed'] } } }), 'on.skiff_event.events', /Unknown key/],
		['skiff_event as a list', minimal({}, { on: { skiff_event: ['deployments.failed'] } }), 'on.skiff_event', /Expected \{ types/],
		['missing runs-on', { on: 'push', jobs: { build: { steps: [{ run: 'x' }] } } }, 'jobs.build.runs-on', /runs-on is required/],
		['empty runs-on', minimal({ 'runs-on': [] }), 'jobs.build.runs-on', /at least one label/],
		['runs-on group only', minimal({ 'runs-on': { group: 'big' } }), 'jobs.build.runs-on', /at least one label/],
		['no steps', minimal({ steps: [] }), 'jobs.build.steps', /at least one step/],
		['step with run and uses', minimal({ steps: [{ run: 'x', uses: 'actions/checkout@v4' }] }), 'jobs.build.steps[0]', /exactly one of run or uses/],
		['step with neither', minimal({ steps: [{ name: 'x' }] }), 'jobs.build.steps[0]', /exactly one of run or uses/],
		['unknown step key', minimal({ steps: [{ run: 'x', args: 'y' }] }), 'jobs.build.steps[0].args', /Unknown key 'args'/],
		['action without a ref', minimal({ steps: [{ uses: 'actions/setup-node' }] }), 'jobs.build.steps[0].uses', /needs a version: actions\/setup-node@<ref>/],
		['action with an empty ref', minimal({ steps: [{ uses: 'actions/setup-node@' }] }), 'jobs.build.steps[0].uses', /needs a version/],
		['action path traversal', minimal({ steps: [{ uses: 'acme/actions/../x@v1' }] }), 'jobs.build.steps[0].uses', /Invalid action path/],
		['action ref traversal', minimal({ steps: [{ uses: 'acme/actions@../../x' }] }), 'jobs.build.steps[0].uses', /Invalid action ref/],
		['not an action', minimal({ steps: [{ uses: 'setup-node' }] }), 'jobs.build.steps[0].uses', /is not an action; use owner\/repo@ref.*GitHub runner pool \(docs\/RUNNERS\.md\)/],
		['local action escaping the workspace', minimal({ steps: [{ uses: './a/../../outside' }] }), 'jobs.build.steps[0].uses', /must stay inside the workspace/],
		['local action with a ref', minimal({ steps: [{ uses: './my-action@v1' }] }), 'jobs.build.steps[0].uses', /takes no @ref/],
		['unknown skiff built-in', minimal({ steps: [{ uses: 'skiff/teleport@v1' }] }), 'jobs.build.steps[0].uses', /Unknown built-in action/],
		['reusable workflow as a step', minimal({ steps: [{ uses: 'acme/shared/.github/workflows/build.yml@v1' }] }), 'jobs.build.steps[0].uses', /called with jobs.<id>.uses/],
		['docker action', minimal({ steps: [{ uses: 'docker://alpine:3' }] }), 'jobs.build.steps[0].uses', /Docker-container actions/],
		['template in uses', minimal({ steps: [{ uses: 'actions/checkout@${{ inputs.v }}' }] }), 'jobs.build.steps[0].uses', /cannot contain expressions/],
		['with on a run step', minimal({ steps: [{ run: 'x', with: { a: 1 } }] }), 'jobs.build.steps[0].with', /only applies to uses/],
		['shell on a uses step', minimal({ steps: [{ uses: 'actions/checkout@v4', shell: 'bash' }] }), 'jobs.build.steps[0].shell', /only applies to run/],
		['unsupported shell', minimal({ steps: [{ run: 'x', shell: 'pwsh' }] }), 'jobs.build.steps[0].shell', /Unsupported shell 'pwsh'/],
		['bad step id', minimal({ steps: [{ id: 'my step', run: 'x' }] }), 'jobs.build.steps[0].id', /Step ids start with/],
		['duplicate step id', minimal({ steps: [{ id: 'a', run: 'x' }, { id: 'A', run: 'y' }] }), 'jobs.build.steps[1].id', /Duplicate step id/],
		['nested with value', minimal({ steps: [{ uses: 'actions/cache@v4', with: { key: { a: 1 } } }] }), 'jobs.build.steps[0].with.key', /Expected a string, number or boolean/],
		['bad env name', minimal({ env: { 'A=B': 'x' } }), 'jobs.build.env.A=B', /environment variable name/],
		['unknown need', minimal({ needs: 'nope' }), 'jobs.build.needs', /needs unknown job 'nope'/],
		['self need', minimal({ needs: 'build' }), 'jobs.build.needs', /cannot need itself/],
		['timeout too large', minimal({ 'timeout-minutes': 1441 }), 'jobs.build.timeout-minutes', /between 1 and 1440/],
		['timeout zero', minimal({ 'timeout-minutes': 0 }), 'jobs.build.timeout-minutes', /between 1 and 1440/],
		['timeout expression', minimal({ 'timeout-minutes': '${{ inputs.t }}' }), 'jobs.build.timeout-minutes', /not supported in timeout-minutes/],
		['continue-on-error string', minimal({ 'continue-on-error': 'maybe' }), 'jobs.build.continue-on-error', /Expected true, false or an expression/],
		['concurrency without group', minimal({ concurrency: { 'cancel-in-progress': true } }), 'jobs.build.concurrency.group', /group is required/],
		['cancel-in-progress expression', minimal({}, { concurrency: { group: 'g', 'cancel-in-progress': '${{ true }}' } }), 'concurrency.cancel-in-progress', /Expressions are not supported here/],
		['environment without name', minimal({ environment: { url: 'https://x' } }), 'jobs.build.environment.name', /name is required/],
		['container without image', minimal({ container: { env: { A: 'b' } } }), 'jobs.build.container.image', /image is required/],
		['container credentials', minimal({ container: { image: 'x', credentials: {} } }), 'jobs.build.container.credentials', /Unknown key/],
		['service options', minimal({ services: { db: { image: 'postgres', options: '--health-cmd pg_isready --health-interval 10s --privileged' } } }), 'jobs.build.services.db.options', /'--privileged' is not supported/],
		['service as a string', minimal({ services: { db: 'postgres' } }), 'jobs.build.services.db', /Expected a mapping/],
		['bad port', minimal({ services: { db: { image: 'x', ports: ['abc'] } } }), 'jobs.build.services.db.ports[0]', /Invalid port/],
		['matrix axis not a list', minimal({ strategy: { matrix: { os: 'linux' } } }), 'jobs.build.strategy.matrix.os', /must be a list/],
		['matrix empty axis', minimal({ strategy: { matrix: { os: [] } } }), 'jobs.build.strategy.matrix.os', /has no values/],
		['matrix string not a lone template', minimal({ strategy: { matrix: 'x ${{ inputs.m }}' } }), 'jobs.build.strategy.matrix', /single \$\{\{ \}\} expression/],
		['matrix too big', minimal({ strategy: { matrix: { a: range(20), b: range(20) } } }), 'jobs.build.strategy.matrix', /max 256/],
		['matrix exclude non-axis', minimal({ strategy: { matrix: { a: [1], exclude: [{ b: 1 }] } } }), 'jobs.build.strategy.matrix.exclude[0]', /not a matrix axis/],
		['max-parallel', minimal({ strategy: { 'max-parallel': 0 } }), 'jobs.build.strategy.max-parallel', /positive whole number/],
		['fail-fast', minimal({ strategy: { 'fail-fast': 'no' } }), 'jobs.build.strategy.fail-fast', /true or false/],
		['permissions shape', minimal({}, { permissions: { contents: 'admin' } }), 'permissions.contents', /read, write or none/],
		['syntax error in expression', minimal({ steps: [{ run: 'echo ${{ skiff.sha == }}' }] }), 'jobs.build.steps[0].run', /Unexpected end of expression/],
		['unknown context', minimal({ steps: [{ run: 'echo ${{ foo.bar }}' }] }), 'jobs.build.steps[0].run', /Unrecognized named-value 'foo'/],
		['unterminated template', minimal({ env: { A: '${{ skiff.sha' } }), 'jobs.build.env.A', /Unterminated/],
		['matrix in job if', minimal({ if: "matrix.os == 'linux'" }), 'jobs.build.if', /Context 'matrix' is not available here/],
		['steps in job env', minimal({ env: { A: '${{ steps.x.outputs.y }}' } }), 'jobs.build.env.A', /Context 'steps' is not available/],
		['secrets in workflow concurrency', minimal({}, { concurrency: 'g-${{ secrets.X }}' }), 'concurrency', /Context 'secrets' is not available/],
		['matrix in workflow env', minimal({}, { env: { A: '${{ matrix.os }}' } }), 'env.A', /Context 'matrix' is not available/],
		['secrets in runs-on', minimal({ 'runs-on': ['${{ secrets.LABEL }}'] }), 'jobs.build.runs-on[0]', /Context 'secrets' is not available/],
		['secrets in step if', minimal({ steps: [{ run: 'x', if: "secrets.X != ''" }] }), 'jobs.build.steps[0].if', /Context 'secrets' is not available/],
		['hashFiles in job env', minimal({ env: { A: "${{ hashFiles('x') }}" } }), 'jobs.build.env.A', /hashFiles\(\) is only available in steps/],
		['status function outside if', minimal({ steps: [{ run: 'echo ${{ success() }}' }] }), 'jobs.build.steps[0].run', /success\(\) is only available in if/],
		['mixed text and template in if', minimal({ if: "${{ skiff.ref }} == 'x'" }), 'jobs.build.if', /Wrap the whole condition/],
		['inputs in strategy ok but steps not', minimal({ strategy: { matrix: { a: ['${{ steps.x.outputs.y }}'] } } }), 'jobs.build.strategy.matrix.a[0]', /Context 'steps' is not available/],
	];

	test.each(cases)('%s', (_name, doc, path, message) => {
		const issues = issuesOf(doc);
		const match = issues.find((issue) => issue.path === path && message.test(issue.message));
		if (!match) throw new Error(`Expected an issue at '${path}' matching ${message}, got ${JSON.stringify(issues, null, 2)}`);
	});

	test('cycles are reported with the path through them', () => {
		const issues = issuesOf({
			on: 'push',
			jobs: {
				a: { 'runs-on': 'x', needs: 'c', steps: [{ run: 'x' }] },
				b: { 'runs-on': 'x', needs: 'a', steps: [{ run: 'x' }] },
				c: { 'runs-on': 'x', needs: 'b', steps: [{ run: 'x' }] },
				d: { 'runs-on': 'x', steps: [{ run: 'x' }] },
			},
		});
		expect(issues).toEqual([{ path: 'jobs.b.needs', message: 'Dependency cycle: a → c → b → a' }]);
	});

	test('all issues are collected before throwing', () => {
		const issues = issuesOf({ on: 'release', bogus: 1, jobs: { a: { steps: [{ uses: 'docker://x' }, { run: 'x', foo: 1 }] } } });
		expect(issues.map((issue) => issue.path)).toEqual(['bogus', 'on.release', 'jobs.a.steps[0].uses', 'jobs.a.steps[1].foo', 'jobs.a.runs-on']);
		expect(() => parseWorkflow({ on: 'release' }, PATH)).toThrow(PipelineWorkflowError);
	});

	test('the error message lists every issue with its path', () => {
		try {
			parseWorkflow(minimal({ 'timeout-minutes': 0 }, { bogus: 1 }), PATH);
			throw new Error('expected a throw');
		} catch (error) {
			expect((error as Error).message).toBe("bogus: Unknown key 'bogus' (allowed: name, run-name, on, env, defaults, concurrency, permissions, jobs)\njobs.build.timeout-minutes: timeout-minutes must be between 1 and 1440");
		}
	});
});

function range(n: number): number[] {
	return Array.from({ length: n }, (_, i) => i);
}

describe('globMatch', () => {
	// GitHub's filter pattern cheat sheet.
	test.each([
		['feature/*', 'feature/my-branch', true],
		['feature/*', 'feature/your-branch', true],
		['feature/*', 'feature/a/b', false],
		['feature/**', 'feature/beta-a/my-branch', true],
		['feature/**', 'feature/mona/the/octocat', true],
		['main', 'main', true],
		['main', 'mainline', false],
		['releases/mona-the-octocat', 'releases/mona-the-octocat', true],
		['*', 'main', true],
		['*', 'releases/v1', false],
		['**', 'all/the/branches', true],
		['**', 'every/tag', true],
		['*feature', 'mona-feature', true],
		['*feature', 'feature', true],
		['*feature', 'ver-10-feature', true],
		['v2*', 'v2', true],
		['v2*', 'v2.0', true],
		['v2*', 'v2.9', true],
		['v[12].[0-9]+.[0-9]+', 'v1.10.1', true],
		['v[12].[0-9]+.[0-9]+', 'v2.0.0', true],
		['v[12].[0-9]+.[0-9]+', 'v3.0.0', false],
		['v[12].[0-9]+.[0-9]+', 'v1.x.0', false],
		['v1.?', 'v1.', true],
		['v1.?', 'v1', true],
		['v1.?', 'v1..', false],
		['*.js', 'app.js', true],
		['*.js', 'index.js', true],
		['*.js', 'src/app.js', false],
		['**.js', 'index.js', true],
		['**.js', 'js/index.js', true],
		['**.js', 'src/js/app.js', true],
		['docs/*', 'docs/README.md', true],
		['docs/*', 'docs/file.txt', true],
		['docs/*', 'docs/a/file.txt', false],
		['docs/**', 'docs/README.md', true],
		['docs/**', 'docs/mona/octocat.txt', true],
		['docs/**/*.md', 'docs/README.md', true],
		['docs/**/*.md', 'docs/mona/hello-world.md', true],
		['docs/**/*.md', 'docs/a/markdown/guide.md', true],
		['docs/**/*.md', 'docs/a/guide.txt', false],
		['**/docs/**', 'docs/hello.md', true],
		['**/docs/**', 'dir/docs/my-file.txt', true],
		['**/docs/**', 'space/docs/plan/space.doc', true],
		['**/README.md', 'README.md', true],
		['**/README.md', 'js/README.md', true],
		['**/*src/**', 'a/src/app.js', true],
		['**/*src/**', 'my-src/code/js/app.js', true],
		['**/*-post.md', 'my-post.md', true],
		['**/*-post.md', 'path/their-post.md', true],
		['**/migrate-*.sql', 'migrate-10909.sql', true],
		['**/migrate-*.sql', 'db/migrate-v1.0.sql', true],
		['**/migrate-*.sql', 'db/sept/migrate-v1.sql', true],
		['*.md', 'README.md', true],
		['*.md', 'docs/README.md', false],
		['\\*.md', '*.md', true],
		['\\*.md', 'a.md', false],
		['a+', 'aaa', true],
		['a+', '', false],
		['+a', '+a', true],
		['(x)|y', '(x)|y', true],
		['(x)|y', 'y', false],
		['[z-a]', 'b', false],
	])('%p vs %p → %p', (pattern, value, expected) => {
		expect(globMatch(pattern, value)).toBe(expected);
	});
});

describe('workflowTriggerMatches', () => {
	const wf = (on: unknown) => parseWorkflow(minimal({}, { on }), PATH);
	const push = (ref: string, changedFiles: string[] | null = null): PipelineTriggerEvent => ({ event: 'push', ref, changedFiles });
	const pr = (baseRef: string, action: string | null = 'opened', changedFiles: string[] | null = null): PipelineTriggerEvent => ({
		event: 'pull_request',
		ref: 'refs/pull/7/merge',
		baseRef,
		action,
		changedFiles,
	});

	test.each([
		// [on, event, expected]
		['push', push('refs/heads/anything'), true],
		['push', push('refs/tags/v1'), true],
		['pull_request', push('refs/heads/main'), false],
		[{ push: { branches: ['main'] } }, push('refs/heads/main'), true],
		[{ push: { branches: ['main'] } }, push('refs/heads/dev'), false],
		[{ push: { branches: ['main'] } }, push('refs/tags/v1'), false], // branches only: tags do not run
		[{ push: { tags: ['v*'] } }, push('refs/tags/v1.2'), true],
		[{ push: { tags: ['v*'] } }, push('refs/heads/main'), false], // tags only: branches do not run
		[{ push: { branches: ['main'], tags: ['v*'] } }, push('refs/tags/v2'), true],
		[{ push: { branches: ['main'], tags: ['v*'] } }, push('refs/tags/x'), false],
		[{ push: { 'branches-ignore': ['dev/**'] } }, push('refs/heads/dev/a/b'), false],
		[{ push: { 'branches-ignore': ['dev/**'] } }, push('refs/heads/main'), true],
		[{ push: { 'tags-ignore': ['*-rc*'] } }, push('refs/tags/v1-rc1'), false],
		[{ push: { 'tags-ignore': ['*-rc*'] } }, push('refs/tags/v1'), true],
		// negation, evaluated in order
		[{ push: { branches: ['releases/**', '!releases/**-alpha'] } }, push('refs/heads/releases/10'), true],
		[{ push: { branches: ['releases/**', '!releases/**-alpha'] } }, push('refs/heads/releases/10-alpha'), false],
		[{ push: { branches: ['!releases/**-alpha', 'releases/**'] } }, push('refs/heads/releases/10-alpha'), true],
		// paths
		[{ push: { paths: ['src/**'] } }, push('refs/heads/main', ['src/a.ts', 'README.md']), true],
		[{ push: { paths: ['src/**'] } }, push('refs/heads/main', ['README.md']), false],
		[{ push: { paths: ['src/**'] } }, push('refs/heads/main', null), true], // unknown files match
		[{ push: { paths: ['src/**'] } }, push('refs/tags/v1', ['README.md']), true], // not applied to tags
		[{ push: { paths: ['sub/**', '!sub/docs/**'] } }, push('refs/heads/main', ['sub/docs/a.md']), false],
		[{ push: { paths: ['sub/**', '!sub/docs/**'] } }, push('refs/heads/main', ['sub/docs/a.md', 'sub/x.ts']), true],
		[{ push: { 'paths-ignore': ['docs/**'] } }, push('refs/heads/main', ['docs/a.md']), false],
		[{ push: { 'paths-ignore': ['docs/**'] } }, push('refs/heads/main', ['docs/a.md', 'src/b.ts']), true],
		[{ push: { branches: ['main'], paths: ['src/**'] } }, push('refs/heads/main', ['docs/a.md']), false],
		// pull_request
		['pull_request', pr('main'), true],
		['pull_request', pr('main', 'synchronize'), true],
		['pull_request', pr('main', 'closed'), false], // not a default type
		[{ pull_request: { types: ['closed'] } }, pr('main', 'closed'), true],
		[{ pull_request: { branches: ['main'] } }, pr('main'), true],
		[{ pull_request: { branches: ['main'] } }, pr('refs/heads/main'), true],
		[{ pull_request: { branches: ['main'] } }, pr('dev'), false],
		[{ pull_request: { 'branches-ignore': ['dev'] } }, pr('dev'), false],
		[{ pull_request: { paths: ['src/**'] } }, pr('main', 'opened', ['README.md']), false],
		[{ pull_request: { paths: ['src/**'] } }, pr('main', null, null), true],
		['push', pr('main'), false],
	] as const)('on %j, %j → %p', (on, event, expected) => {
		expect(workflowTriggerMatches(wf(on), event)).toBe(expected);
	});

	test('workflow_dispatch matches the picked workflow only', () => {
		const workflow = wf('workflow_dispatch');
		expect(workflowTriggerMatches(workflow, { event: 'workflow_dispatch', ref: 'refs/heads/main', workflowPath: PATH })).toBe(true);
		expect(workflowTriggerMatches(workflow, { event: 'workflow_dispatch', ref: 'refs/heads/main', workflowPath: '.skiff/workflows/other.yml' })).toBe(false);
		expect(workflowTriggerMatches(wf('push'), { event: 'workflow_dispatch', ref: 'refs/heads/main', workflowPath: PATH })).toBe(false);
	});

	test('schedule matches the cron that fired', () => {
		const workflow = wf({ schedule: [{ cron: '0 3 * * *' }, { cron: '*/5 * * * *' }] });
		expect(workflowTriggerMatches(workflow, { event: 'schedule', ref: 'refs/heads/main', schedule: '*/5 * * * *' })).toBe(true);
		expect(workflowTriggerMatches(workflow, { event: 'schedule', ref: 'refs/heads/main', schedule: '0 4 * * *' })).toBe(false);
		expect(workflowTriggerMatches(workflow, { event: 'schedule', ref: 'refs/heads/main' })).toBe(false);
	});
});

describe('expandMatrix', () => {
	test('null means no matrix', () => {
		expect(expandMatrix(null)).toEqual([]);
	});

	test('cartesian product in key order', () => {
		expect(expandMatrix({ version: [10, 12, 14], os: ['ubuntu-latest', 'windows-latest'] })).toEqual([
			{ version: 10, os: 'ubuntu-latest' },
			{ version: 10, os: 'windows-latest' },
			{ version: 12, os: 'ubuntu-latest' },
			{ version: 12, os: 'windows-latest' },
			{ version: 14, os: 'ubuntu-latest' },
			{ version: 14, os: 'windows-latest' },
		]);
	});

	test('object values (GitHub docs)', () => {
		const combos = expandMatrix({
			os: ['ubuntu-latest', 'macos-latest'],
			node: [{ version: 14 }, { version: 20, env: 'NODE_OPTIONS=--openssl-legacy-provider' }],
		});
		expect(combos).toHaveLength(4);
		expect(combos[1]).toEqual({ os: 'ubuntu-latest', node: { version: 20, env: 'NODE_OPTIONS=--openssl-legacy-provider' } });
	});

	test('include expands and adds combinations (GitHub docs: fruit/animal)', () => {
		expect(
			expandMatrix({
				fruit: ['apple', 'pear'],
				animal: ['cat', 'dog'],
				include: [
					{ color: 'green' },
					{ color: 'pink', animal: 'cat' },
					{ fruit: 'apple', shape: 'circle' },
					{ fruit: 'banana' },
					{ fruit: 'banana', animal: 'cat' },
				],
			}),
		).toEqual([
			{ fruit: 'apple', animal: 'cat', color: 'pink', shape: 'circle' },
			{ fruit: 'apple', animal: 'dog', color: 'green', shape: 'circle' },
			{ fruit: 'pear', animal: 'cat', color: 'pink' },
			{ fruit: 'pear', animal: 'dog', color: 'green' },
			{ fruit: 'banana' },
			{ fruit: 'banana', animal: 'cat' },
		]);
	});

	test('include with conflicting original values adds a new job (GitHub docs: os/node)', () => {
		expect(
			expandMatrix({
				os: ['windows-latest', 'ubuntu-latest'],
				node: [14, 16],
				include: [{ os: 'windows-latest', node: 16, npm: 6 }, { os: 'windows-latest', node: 17 }],
			}),
		).toEqual([
			{ os: 'windows-latest', node: 14 },
			{ os: 'windows-latest', node: 16, npm: 6 },
			{ os: 'ubuntu-latest', node: 14 },
			{ os: 'ubuntu-latest', node: 16 },
			{ os: 'windows-latest', node: 17 },
		]);
	});

	test('include only (GitHub docs: site/datacenter)', () => {
		expect(
			expandMatrix({
				include: [
					{ site: 'production', datacenter: 'site-a' },
					{ site: 'staging', datacenter: 'site-b' },
				],
			}),
		).toEqual([
			{ site: 'production', datacenter: 'site-a' },
			{ site: 'staging', datacenter: 'site-b' },
		]);
	});

	test('exclude is a partial match and runs before include (GitHub docs)', () => {
		const combos = expandMatrix({
			os: ['macos-latest', 'windows-latest'],
			version: [12, 14, 16],
			environment: ['staging', 'production'],
			exclude: [
				{ os: 'macos-latest', version: 12, environment: 'production' },
				{ os: 'windows-latest', version: 16 },
			],
		});
		expect(combos).toHaveLength(9);
		expect(combos).not.toContainEqual({ os: 'macos-latest', version: 12, environment: 'production' });
		expect(combos.filter((combo) => combo.os === 'windows-latest' && combo.version === 16)).toEqual([]);

		expect(
			expandMatrix({
				os: ['a', 'b'],
				exclude: [{ os: 'a' }],
				include: [{ os: 'a', extra: true }],
			}),
		).toEqual([{ os: 'b' }, { os: 'a', extra: true }]);
	});

	test('include values may overwrite values added by an earlier include', () => {
		expect(expandMatrix({ os: ['a'], include: [{ color: 'red' }, { color: 'blue' }] })).toEqual([{ os: 'a', color: 'blue' }]);
	});

	test('limits and errors', () => {
		expect(expandMatrix({ a: range(16), b: range(16) })).toHaveLength(256);
		expect(() => expandMatrix({ a: range(16), b: range(17) })).toThrow(PipelineWorkflowError);
		expect(() => expandMatrix({ a: range(1000), b: range(1000), c: range(1000) })).toThrow(/max 256/);
		expect(() => expandMatrix({ a: 'x' })).toThrow(/must be a list/);
		expect(() => expandMatrix({ a: [] })).toThrow(/no values/);
		expect(() => expandMatrix({})).toThrow(/at least one axis/);
		expect(() => expandMatrix({ a: [1], include: ['x'] })).toThrow(/list of mappings/);
	});
});

describe('matrixJobName', () => {
	test.each([
		['build', {}, 'build'],
		['build', { os: 'linux', node: 20 }, 'build (linux, 20)'],
		['build', { os: 'linux', experimental: true, n: null }, 'build (linux, true, )'],
		['build', { node: { version: 20 } }, 'build ({"version":20})'],
		['Build ${{ matrix.os }}', { os: 'linux' }, 'Build ${{ matrix.os }}'],
		['Build ${{ skiff.sha }}', { os: 'linux' }, 'Build ${{ skiff.sha }} (linux)'],
	])('%p with %j → %p', (name, combo, expected) => {
		expect(matrixJobName(name, combo)).toBe(expected);
	});
});

describe('coerceDispatchInputs', () => {
	const workflow = parseWorkflow(
		minimal(
			{},
			{
				on: {
					workflow_dispatch: {
						inputs: {
							version: { type: 'string', required: true },
							level: { type: 'choice', options: ['patch', 'minor'], default: 'patch' },
							dry: { type: 'boolean', default: true },
							force: { type: 'boolean' },
							count: { type: 'number', default: 2 },
							limit: { type: 'number' },
							note: { description: 'free text' },
							target: { type: 'environment', default: 'staging' },
						},
					},
				},
			},
		),
		PATH,
	);

	test('applies defaults and types', () => {
		expect(coerceDispatchInputs(workflow, { version: '1.2.3' })).toEqual({
			version: '1.2.3',
			level: 'patch',
			dry: true,
			force: false,
			count: 2,
			note: '',
			target: 'staging',
		});
	});

	test('coerces strings from forms and CLIs', () => {
		expect(coerceDispatchInputs(workflow, { version: 'x', level: 'minor', dry: 'false', force: 'TRUE', count: '7', limit: 3.5, note: 42 })).toEqual({
			version: 'x',
			level: 'minor',
			dry: false,
			force: true,
			count: 7,
			limit: 3.5,
			note: '42',
			target: 'staging',
		});
	});

	test('rejects missing, unknown and mistyped inputs, all at once', () => {
		try {
			coerceDispatchInputs(workflow, { level: 'major', dry: 'maybe', count: 'many', bogus: 1 });
			throw new Error('expected a throw');
		} catch (error) {
			expect(error).toBeInstanceOf(PipelineWorkflowError);
			expect((error as PipelineWorkflowError).issues.map((issue) => issue.path)).toEqual(['inputs.bogus', 'inputs.version', 'inputs.level', 'inputs.dry', 'inputs.count']);
		}
		expect(() => coerceDispatchInputs(workflow, { version: '' })).toThrow(/required/);
	});

	test('a workflow without workflow_dispatch refuses inputs', () => {
		expect(() => coerceDispatchInputs(parseWorkflow(minimal(), PATH), {})).toThrow(/no workflow_dispatch/);
	});
});

describe('topologicalJobOrder', () => {
	test('respects needs and keeps declaration order otherwise', () => {
		const workflow = parseWorkflow(
			{
				on: 'push',
				jobs: {
					deploy: { 'runs-on': 'x', needs: ['build', 'test'], steps: [{ run: 'x' }] },
					test: { 'runs-on': 'x', needs: 'build', steps: [{ run: 'x' }] },
					lint: { 'runs-on': 'x', steps: [{ run: 'x' }] },
					build: { 'runs-on': 'x', steps: [{ run: 'x' }] },
				},
			},
			PATH,
		);
		expect(topologicalJobOrder(workflow)).toEqual(['lint', 'build', 'test', 'deploy']);
	});
});

describe('reusable workflows (workflow_call)', () => {
	const CALLEE = yaml(`
name: build
on:
  push: { branches: [main] }
  workflow_call:
    inputs:
      target: { type: string, required: true, description: Where to }
      debug: { type: boolean, default: false }
      shards: { type: number }
      label: { type: string }
    outputs:
      digest: { value: "\${{ jobs.image.outputs.digest }}", description: Image digest }
      both: { value: "\${{ jobs.image.outputs.digest }}@\${{ inputs.target }}" }
    secrets:
      REGISTRY_TOKEN: { required: true }
      OPTIONAL: {}
jobs:
  image:
    runs-on: [linux]
    outputs: { digest: "\${{ steps.b.outputs.digest }}" }
    steps:
      - id: b
        run: echo "digest=sha256:1" >> "$SKIFF_OUTPUT"
        env: { TOKEN: "\${{ secrets.REGISTRY_TOKEN }}", TARGET: "\${{ inputs.target }}" }
`);
	const CALLER = yaml(`
on: push
jobs:
  test:
    runs-on: linux
    steps: [{ run: echo }]
  build:
    name: Build \${{ matrix.arch }}
    needs: test
    if: skiff.ref == 'refs/heads/main'
    uses: ./.skiff/workflows/build.yml
    strategy: { matrix: { arch: [x64, arm64] } }
    concurrency: { group: build, cancel-in-progress: true }
    permissions: { contents: read }
    with: { target: "\${{ matrix.arch }}", debug: true }
    secrets: { REGISTRY_TOKEN: "\${{ secrets.ZOT }}" }
  inherit:
    uses: ./.skiff/workflows/build.yml
    secrets: inherit
`);

	test('on.workflow_call next to other triggers', () => {
		const callee = parseWorkflow(CALLEE, '.skiff/workflows/build.yml');
		expect(callee.on.push).not.toBeNull();
		expect(callee.on.workflowCall).toEqual({
			inputs: {
				target: { type: 'string', description: 'Where to', required: true, default: null, options: [] },
				debug: { type: 'boolean', description: null, required: false, default: false, options: [] },
				shards: { type: 'number', description: null, required: false, default: null, options: [] },
				label: { type: 'string', description: null, required: false, default: null, options: [] },
			},
			outputs: {
				digest: { value: '${{ jobs.image.outputs.digest }}', description: 'Image digest' },
				both: { value: '${{ jobs.image.outputs.digest }}@${{ inputs.target }}', description: null },
			},
			secrets: { REGISTRY_TOKEN: { required: true, description: null }, OPTIONAL: { required: false, description: null } },
		});
		expect(parseWorkflow(minimal(), PATH).on.workflowCall).toBeNull();
		expect(parseWorkflow(minimal({}, { on: { workflow_call: null } }), PATH).on.workflowCall).toEqual({ inputs: {}, outputs: {}, secrets: {} });
	});

	test('a calling job normalizes to uses/with/secrets with no steps or labels', () => {
		const workflow = parseWorkflow(CALLER, PATH);
		expect(workflow.jobs.build).toEqual({
			key: 'build',
			name: 'Build ${{ matrix.arch }}',
			needs: ['test'],
			if: "skiff.ref == 'refs/heads/main'",
			runsOn: [],
			strategy: { matrix: { arch: ['x64', 'arm64'] }, failFast: true, maxParallel: null },
			outputs: {},
			env: {},
			defaults: { shell: null, workingDirectory: null },
			timeoutMinutes: 60,
			continueOnError: false,
			concurrency: { group: 'build', cancelInProgress: true },
			environment: null,
			container: null,
			services: {},
			steps: [],
			uses: './.skiff/workflows/build.yml',
			with: { target: '${{ matrix.arch }}', debug: 'true' },
			secrets: { REGISTRY_TOKEN: '${{ secrets.ZOT }}' },
		});
		expect(workflow.jobs.inherit).toMatchObject({ uses: './.skiff/workflows/build.yml', with: {}, secrets: 'inherit', needs: [] });
		expect(workflow.jobs.test!.uses).toBeUndefined();
		expect(findWorkflowCalls(workflow)).toEqual([
			{ jobKey: 'build', path: '.skiff/workflows/build.yml' },
			{ jobKey: 'inherit', path: '.skiff/workflows/build.yml' },
		]);
		expect(topologicalJobOrder(workflow)).toEqual(['test', 'build', 'inherit']);
	});

	test('validateWorkflowCallInputs applies defaults, types and required inputs', () => {
		const callee = parseWorkflow(CALLEE, '.skiff/workflows/build.yml');
		expect(validateWorkflowCallInputs(callee, { target: 'x64', debug: 'true', shards: '3' })).toEqual({ target: 'x64', debug: true, shards: 3, label: '' });
		expect(validateWorkflowCallInputs(callee, { target: 'x64' })).toEqual({ target: 'x64', debug: false, shards: 0, label: '' });
		expect(validateWorkflowCallInputs(callee, { target: 5, debug: '' })).toEqual({ target: '5', debug: false, shards: 0, label: '' });
		try {
			validateWorkflowCallInputs(callee, { debug: 'maybe', nope: 1 });
			throw new Error('expected an error');
		} catch (error) {
			expect(error).toBeInstanceOf(PipelineWorkflowError);
			expect((error as PipelineWorkflowError).issues.map((issue) => issue.path).sort()).toEqual(['with.debug', 'with.nope', 'with.target']);
		}
		expect(() => validateWorkflowCallInputs(parseWorkflow(minimal(), PATH), {})).toThrow(/no workflow_call trigger/);
	});

	test('checkWorkflowCallSecrets', () => {
		const callee = parseWorkflow(CALLEE, '.skiff/workflows/build.yml');
		expect(() => checkWorkflowCallSecrets(callee, { REGISTRY_TOKEN: '${{ secrets.ZOT }}' })).not.toThrow();
		expect(() => checkWorkflowCallSecrets(callee, 'inherit')).not.toThrow();
		expect(() => checkWorkflowCallSecrets(callee, 'inherit', ['REGISTRY_TOKEN', 'OTHER'])).not.toThrow();
		expect(() => checkWorkflowCallSecrets(callee, 'inherit', ['OTHER'])).toThrow(/Secret 'REGISTRY_TOKEN' is required/);
		expect(() => checkWorkflowCallSecrets(callee, null)).toThrow(/Secret 'REGISTRY_TOKEN' is required/);
		expect(() => checkWorkflowCallSecrets(callee, { REGISTRY_TOKEN: 'x', EXTRA: 'y' })).toThrow(/has no secret 'EXTRA'/);
	});

	test('workflowCallOutputs reads jobs.<id> from the callee jobs', () => {
		const callee = parseWorkflow(CALLEE, '.skiff/workflows/build.yml');
		const outputs = workflowCallOutputs(callee, { image: { result: 'success', outputs: { digest: 'sha256:abc' } } }, { skiff: {}, inputs: { target: 'arm64' } });
		expect(outputs).toEqual({ digest: 'sha256:abc', both: 'sha256:abc@arm64' });
	});
});

describe('on.skiff_event', () => {
	test('types are kept; absent or null means any event', () => {
		const typed = parseWorkflow(minimal({}, { on: { skiff_event: { types: ['deployments.failed', 'database-backups.completed', 'deployments.failed'] } } }), PATH);
		expect(typed.on.skiffEvent).toEqual({ types: ['deployments.failed', 'database-backups.completed'] });
		expect(parseWorkflow(minimal({}, { on: { skiff_event: null } }), PATH).on.skiffEvent).toEqual({ types: [] });
		expect(parseWorkflow(minimal({}, { on: ['push', 'skiff_event'] }), PATH).on.skiffEvent).toEqual({ types: [] });
		expect(parseWorkflow(minimal(), PATH).on.skiffEvent).toBeNull();
	});

	test('matching', () => {
		const typed = parseWorkflow(minimal({}, { on: { skiff_event: { types: ['deployments.failed'] } } }), PATH);
		const any = parseWorkflow(minimal({}, { on: { skiff_event: {} } }), PATH);
		const event = (eventType: string): PipelineTriggerEvent => ({ event: 'skiff_event', ref: 'refs/heads/main', eventType });
		expect(workflowTriggerMatches(typed, event('deployments.failed'))).toBe(true);
		expect(workflowTriggerMatches(typed, event('deployments.created'))).toBe(false);
		expect(workflowTriggerMatches(any, event('storage.object-create'))).toBe(true);
		expect(workflowTriggerMatches(parseWorkflow(minimal(), PATH), event('deployments.failed'))).toBe(false);
	});
});

describe('step actions', () => {
	test('parsePipelineActionRef', () => {
		expect(parsePipelineActionRef('actions/checkout@v4')).toEqual({ kind: 'builtin', action: 'skiff/checkout' });
		expect(parsePipelineActionRef('skiff/image-index@v1')).toEqual({ kind: 'builtin', action: 'skiff/image-index' });
		expect(parsePipelineActionRef('actions/setup-node@v4')).toEqual({ kind: 'remote', owner: 'actions', repo: 'setup-node', path: '', ref: 'v4' });
		expect(parsePipelineActionRef('github/codeql-action/init@' + 'a'.repeat(40))).toEqual({ kind: 'remote', owner: 'github', repo: 'codeql-action', path: 'init', ref: 'a'.repeat(40) });
		expect(parsePipelineActionRef('acme/tools/a/b@releases/v1')).toEqual({ kind: 'remote', owner: 'acme', repo: 'tools', path: 'a/b', ref: 'releases/v1' });
		expect(parsePipelineActionRef('./')).toEqual({ kind: 'local', path: '' });
		expect(parsePipelineActionRef('./.github/actions/setup')).toEqual({ kind: 'local', path: '.github/actions/setup' });
		expect(parsePipelineActionRef('./a/./b/')).toEqual({ kind: 'local', path: 'a/b' });
		expect(parsePipelineActionRef('docker://alpine:3').kind).toBe('invalid');
		expect(parsePipelineActionRef('./../x').kind).toBe('invalid');
		expect(parsePipelineActionRef('acme/tools/..@v1').kind).toBe('invalid');
		expect(parsePipelineActionRef('acme/tools@-x').kind).toBe('invalid');
	});

	test('remote and local actions parse in workflows, with or without a SHA pin', () => {
		const workflow = parseWorkflow(
			minimal({ steps: [{ uses: 'actions/setup-node@v4', with: { 'node-version': 24 } }, { uses: 'acme/a@' + 'b'.repeat(40) }, { uses: './.github/actions/x' }] }),
			PATH,
		);
		expect(workflow.jobs.build!.steps.map((step) => step.uses)).toEqual(['actions/setup-node@v4', 'acme/a@' + 'b'.repeat(40), './.github/actions/x']);
	});
});

describe('parseActionManifest', () => {
	test('a JavaScript action', () => {
		const manifest = parseActionManifest(
			yaml(`
name: Hello
description: Says hello
author: someone
branding: { icon: box, color: blue }
inputs:
  who: { description: Who, required: true, default: world }
  token: { default: "\${{ github.token }}" }
  flag: { default: false }
outputs:
  greeting: { description: The greeting }
runs:
  using: node20
  main: dist/index.js
  pre: dist/pre.js
  post: dist/post.js
  post-if: \${{ success() }}
`),
			'action.yml',
		);
		expect(manifest).toEqual({
			name: 'Hello',
			description: 'Says hello',
			inputs: {
				who: { description: 'Who', required: true, default: 'world' },
				token: { description: null, required: false, default: '${{ github.token }}' },
				flag: { description: null, required: false, default: 'false' },
			},
			outputs: { greeting: { description: 'The greeting', value: null } },
			runs: { using: 'node20', main: 'dist/index.js', pre: 'dist/pre.js', preIf: null, post: 'dist/post.js', postIf: 'success()' },
		});
	});

	test('a composite action', () => {
		const manifest = parseActionManifest(
			yaml(`
name: Composite
inputs: { name: { default: x } }
outputs: { out: { value: "\${{ steps.a.outputs.v }}" } }
runs:
  using: composite
  steps:
    - id: a
      shell: bash
      run: echo "v=\${{ inputs.name }}" >> "$GITHUB_OUTPUT"
    - uses: ./other
      with: { a: b }
`),
			'action.yml',
		);
		expect(manifest.runs.using).toBe('composite');
		if (manifest.runs.using !== 'composite') throw new Error('unreachable');
		expect(manifest.runs.steps.map((step) => [step.id, step.shell, step.uses])).toEqual([
			['a', 'bash', null],
			[null, null, './other'],
		]);
		expect(manifest.outputs.out).toEqual({ description: null, value: '${{ steps.a.outputs.v }}' });
	});

	test('problems', () => {
		const issues = (doc: unknown): string[] => {
			try {
				parseActionManifest(doc, 'action.yml');
			} catch (error) {
				return (error as PipelineWorkflowError).issues.map((issue) => `${issue.path}: ${issue.message}`);
			}
			return [];
		};
		expect(issues('x')[0]).toMatch(/must be a YAML mapping/);
		expect(issues({ name: 'x' })[0]).toMatch(/^runs: .*runs is required/);
		expect(issues({ runs: { using: 'node20' } })[0]).toMatch(/^runs.main: .*required/);
		expect(issues({ runs: { using: 'node8', main: 'x.js' } })[0]).toMatch(/Unsupported runs.using 'node8'/);
		expect(issues({ runs: { using: 'composite', steps: [{ run: 'echo' }] } })[0]).toMatch(/^runs.steps\[0\].shell: .*shell is required/);
		expect(issues({ runs: { using: 'composite', steps: [{ run: 'echo', shell: 'bash', 'timeout-minutes': 1 }] } })[0]).toMatch(/Unknown key 'timeout-minutes'/);
		expect(issues({ runs: { using: 'composite', steps: [{ run: 'x', shell: 'python' }] } })).toEqual([]);
		expect(issues({ runs: { using: 'docker', image: 'Dockerfile' } })).toEqual([]);
	});
});
