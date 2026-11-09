/**
 * Pipelines end-to-end on real Linux (docs/PIPELINES.md §14): the real control-plane engine runs
 * here (macOS or Linux) behind a small HTTP server that mirrors the SvelteKit routes, and a Podman
 * machine VM runs the real, compiled `yoal-helper` and `yoal-agent builder` as the systemd units
 * the installer writes (`scripts/systemd/{helper,builder}.ts`). Jobs run in real job containers
 * started by the helper, with the real `yoal-agent pipeline-step` inside.
 *
 * Scenarios:
 *   a  outputs/needs, secret masking, artifacts and cache (two runs) under container isolation
 *   b  a postgres:17 service with a health command, reached by name from the job container
 *   c  yoal/build-image through the per-job BuildKit sidecar (push: false), twice: the second is cached
 *   d  a repository whose trusted minimum is gvisor: the job runs under runsc
 *   e  cancelling a running `sleep 300`: the always() step runs, the run is cancelled, nothing is left behind
 *
 * The VM reaches this machine at `host.containers.internal` (gvproxy forwards it to the host's
 * loopback), from the VM itself and from containers on any Podman network. The test repository is
 * served over smart HTTP by `git http-backend`.
 *
 *   E2E_VM=yoal-spike bun tests/e2e/pipelines-linux.e2e.ts [a,b,c,d,e]
 *
 * Needs a rootful Podman machine with runsc on PATH, the `containers` subuid range and
 * /var/lib/yoal-builder. E2E_KEEP=1 leaves the units running; E2E_SKIP_BUILD=1 reuses the binaries.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../../packages/db/src/index.ts';
import {
	pipelineArtifactCreateSchema,
	pipelineCacheLookupSchema,
	pipelineCacheReserveSchema,
	pipelineClaimRequestSchema,
	pipelineJobCompleteSchema,
	pipelineLogBatchSchema,
	pipelineResolveReportSchema,
	pipelineStepReportSchema,
	type PipelineRunView,
} from '../../packages/contracts/src/index.ts';
import { CoreError, LocalObjectStore, buildPrincipal, createCore, type Core } from '../../packages/core/src/index.ts';
import { gitRepo } from '../../apps/builder/src/pipeline/git-fixture.ts';
import { builderUnit } from '../../scripts/systemd/builder.ts';
import { helperUnit } from '../../scripts/systemd/helper.ts';

const VM = process.env.E2E_VM ?? 'yoal-spike';
const PORT = Number(process.env.E2E_PORT ?? 47820);
const ORIGIN = `http://host.containers.internal:${PORT}`;
const OPT = '/opt/yoal-e2e';
const ETC = '/etc/yoal-e2e';
const scenarios = new Set((process.argv[2] ?? 'a,b,c,d,e').split(','));
const repoRoot = join(import.meta.dir, '../..');

const root = mkdtempSync(join(tmpdir(), 'yoal-pipelines-linux-e2e-'));
let core: Core;
let store: LocalObjectStore;

// ------------------------------------------------------------------------------------- the VM

function vm(script: string, stdin?: string | Uint8Array): { code: number; out: string } {
	const result = Bun.spawnSync(['podman', 'machine', 'ssh', VM, script], {
		stdin: stdin === undefined ? 'ignore' : typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return { code: result.exitCode ?? 1, out: `${result.stdout.toString()}${result.stderr.toString()}`.trim() };
}

function vmOk(script: string, stdin?: string | Uint8Array): string {
	const result = vm(script, stdin);
	if (result.code !== 0) throw new Error(`VM command failed (${result.code}): ${script.slice(0, 200)}\n${result.out.slice(-2000)}`);
	return result.out;
}

/** Cross-compile the agent and helper for the VM's architecture and copy them in when they changed. */
function installBinaries(): void {
	const arch = vmOk('uname -m') === 'aarch64' ? 'arm64' : 'x64';
	const out = join(root, 'bin');
	mkdirSync(out, { recursive: true });
	const binaries = { 'yoal-agent': 'apps/agent/src/main.ts', 'yoal-helper': 'apps/helper/src/main.ts' };
	for (const [name, entry] of Object.entries(binaries)) {
		const target = join(process.env.E2E_BIN_DIR ?? out, name);
		if (process.env.E2E_SKIP_BUILD !== '1') {
			const build = Bun.spawnSync(['bun', 'build', '--compile', '--minify', `--target=bun-linux-${arch}`, entry, '--outfile', target], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
			if (build.exitCode !== 0) throw new Error(`bun build ${name} failed: ${build.stderr.toString()}`);
		}
		const bytes = readFileSync(target);
		const sha = createHash('sha256').update(bytes).digest('hex');
		const remote = vm(`sha256sum ${OPT}/bin/${name} 2>/dev/null | cut -d' ' -f1`).out;
		if (remote !== sha) {
			vmOk(`mkdir -p ${OPT}/bin && cat > ${OPT}/bin/${name}.new && chmod 755 ${OPT}/bin/${name}.new && mv ${OPT}/bin/${name}.new ${OPT}/bin/${name}`, bytes);
			console.log(`copied ${name} (${(bytes.length / 1e6).toFixed(0)} MB) into ${VM}`);
		}
	}
}

/** The installer's units, pointed at the e2e layout; the helper and Builder env files. */
function installUnits(nodeToken: string): void {
	vmOk(
		[
			'getent group yoal >/dev/null || groupadd --system yoal',
			'id -u yoal-build >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin yoal-build',
			`mkdir -p ${OPT}/current/agent ${OPT}/helper ${ETC}`,
			`cp -f ${OPT}/bin/yoal-agent ${OPT}/current/agent/yoal-agent`,
			`ln -sfn yoal-agent ${OPT}/current/agent/yoal-builder`,
			`cp -f ${OPT}/bin/yoal-helper ${OPT}/helper/yoal-helper`,
		].join(' && '),
	);
	vmOk('cat > /etc/systemd/system/yoal-helper.service', helperUnit({ optDir: OPT, etcDir: ETC }));
	// The test VM is Fedora with SELinux enforcing, which Yoal does not support (D27: Debian and
	// Ubuntu). There, the unit's NoNewPrivileges=yes blocks podman/conmon/crun from transitioning to
	// container_runtime_t, so crun's device eBPF filter is refused and no job container starts. The
	// production unit keeps NoNewPrivileges; only this VM gets the override.
	vmOk(
		'mkdir -p /etc/systemd/system/yoal-helper.service.d && cat > /etc/systemd/system/yoal-helper.service.d/selinux-test.conf',
		'[Service]\nNoNewPrivileges=no\n',
	);
	vmOk('cat > /etc/systemd/system/yoal-builder.service', builderUnit({ optDir: OPT, agentEnvFile: `${ETC}/agent.env` }));
	vmOk(
		`umask 077 && cat > ${ETC}/helper.env`,
		[
			`YOAL_HELPER_AGENT_BINARY=${OPT}/current/agent/yoal-agent`,
			'YOAL_HELPER_CONTROL_SOCKET_GROUP=yoal',
			'YOAL_HELPER_APPARMOR_PROFILE=none',
			'YOAL_HELPER_STORAGE_TOOLS=0',
			'',
		].join('\n'),
	);
	vmOk(
		`umask 077 && cat > ${ETC}/agent.env`,
		[
			`YOAL_CONTROL_URL=${ORIGIN}`,
			`YOAL_NODE_TOKEN=${nodeToken}`,
			'YOAL_PIPELINE_ISOLATION=auto',
			'YOAL_PIPELINE_POLL_MS=1000',
			'YOAL_BUILDER_POLL_MS=60000',
			'',
		].join('\n'),
	);
	vmOk('systemctl daemon-reload && systemctl restart yoal-helper.service && sleep 1 && systemctl restart yoal-builder.service');
}

/** The Builder's `[pipeline]` lines since its current start. */
function builderJournal(): string {
	const since = vm('systemctl show -p ActiveEnterTimestamp --value yoal-builder.service').out;
	return vm(`journalctl -u yoal-builder.service --since "${since}" --no-pager -o cat | grep "\\[pipeline\\]" | tail -5`).out;
}

function stopUnits(): void {
	vm('systemctl stop yoal-builder.service yoal-helper.service; systemctl reset-failed yoal-builder.service yoal-helper.service 2>/dev/null; true');
}

/** Job containers and networks the helper labelled, and job directories, still in the VM. */
function leftovers(): string {
	return vm(
		"podman ps -a --filter label=yoal.pipeline-job --format '{{.Names}}'; podman network ls --format '{{.Name}}' | grep '^yoal-job-'; ls /var/lib/yoal-builder/pipelines 2>/dev/null; true",
	).out;
}

// ------------------------------------------------------------------------------ control plane

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** Smart HTTP for the test repositories: `git http-backend` as CGI. */
async function gitHttp(request: Request, url: URL): Promise<Response> {
	const body = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : undefined;
	const proc = Bun.spawn(['git', 'http-backend'], {
		env: {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			GIT_PROJECT_ROOT: join(root, 'repos'),
			GIT_HTTP_EXPORT_ALL: '1',
			PATH_INFO: url.pathname.slice('/git'.length),
			REQUEST_METHOD: request.method,
			QUERY_STRING: url.search.replace(/^\?/, ''),
			CONTENT_TYPE: request.headers.get('content-type') ?? '',
			CONTENT_LENGTH: body ? String(body.length) : '',
			HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
			GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
			REMOTE_ADDR: '127.0.0.1',
		},
		stdin: body ?? 'ignore',
		stdout: 'pipe',
		stderr: 'inherit',
	});
	const out = Buffer.from(await new Response(proc.stdout).arrayBuffer());
	await proc.exited;
	const split = out.indexOf('\r\n\r\n');
	const head = out.subarray(0, split).toString();
	const headers = new Headers();
	let status = 200;
	for (const line of head.split('\r\n')) {
		const colon = line.indexOf(':');
		const name = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
		else headers.append(name, value);
	}
	return new Response(out.subarray(split + 4), { status, headers });
}

async function route(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	if (path.startsWith('/git/')) return gitHttp(request, url);
	const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
	const body = async <T>(schema: { parse(value: unknown): T }) => schema.parse(await request.json());
	const engine = core.pipelines.engine;
	try {
		if (path.startsWith('/api/objects/')) {
			const key = decodeURIComponent(path.slice('/api/objects/'.length));
			const ok = store.verify(request.method === 'PUT' ? 'PUT' : 'GET', key, Number(url.searchParams.get('exp')), url.searchParams.get('sig') ?? '');
			if (!ok) return new Response('bad signature', { status: 403 });
			if (request.method === 'PUT') {
				await store.put(key, new Uint8Array(await request.arrayBuffer()));
				return new Response(null, { status: 204 });
			}
			return new Response(await store.get(key));
		}
		// The git Builder loop shares the daemon; there are never git builds here.
		if (path === '/api/agent/builds/next') return new Response(null, { status: 204 });
		if (path === '/api/agent/pipelines/claim') {
			const node = core.nodes.authenticate(token);
			return json((await engine.claim(node.id, await body(pipelineClaimRequestSchema))) ?? null);
		}
		const [, , , action, id, sub] = path.split('/');
		if (token.startsWith('ptk_')) {
			const trigger = engine.authenticateTrigger(token);
			if (action === 'resolve') return json({ ok: true, runIds: engine.resolveTrigger(trigger, await body(pipelineResolveReportSchema)) });
			if (action === 'heartbeat') return json(engine.heartbeatTrigger(trigger));
		}
		if (action === 'complete') {
			const job = engine.authenticateJob(token, { allowCompleted: true });
			const input = await body(pipelineJobCompleteSchema);
			if (job.status === 'completed') return json({ ok: true, alreadyCompleted: true, conclusion: job.conclusion });
			engine.complete(job, input);
			return json({ ok: true });
		}
		if (action === 'logs') {
			const job = engine.authenticateJob(token, { allowCompleted: true });
			return json({ ok: true, accepted: engine.appendLogs(job, await body(pipelineLogBatchSchema)) });
		}
		const job = engine.authenticateJob(token);
		if (action === 'heartbeat') return json(engine.heartbeat(job));
		if (action === 'secrets') return json({ secrets: engine.secrets(job) });
		if (action === 'steps') {
			engine.reportStep(job, Number(id), await body(pipelineStepReportSchema));
			return json({ ok: true });
		}
		if (action === 'artifacts') {
			if (!id && request.method === 'GET')
				return json({ artifacts: await engine.listArtifacts(job.runId, { name: url.searchParams.get('name') ?? undefined, withUrls: true }) });
			if (!id) return json(await engine.createArtifact(job, await body(pipelineArtifactCreateSchema)));
			if (sub === 'finalize') return json(await engine.finalizeArtifact(job, id));
		}
		if (action === 'cache') {
			if (id === 'lookup') return json({ hit: await engine.lookupCache(job, await body(pipelineCacheLookupSchema)) });
			if (id === 'reserve') return json(await engine.reserveCache(job, await body(pipelineCacheReserveSchema)));
			if (sub === 'commit') {
				await engine.commitCache(job, id!);
				return json({ ok: true });
			}
		}
		return json({ error: 'not_found', path }, 404);
	} catch (error) {
		if (error instanceof CoreError) return json({ error: error.code, message: error.message }, error.status);
		console.error('[e2e server]', error);
		return json({ error: String(error) }, 500);
	}
}

// gvproxy forwards host.containers.internal to this machine's loopback.
const server = Bun.serve({ hostname: '127.0.0.1', port: PORT, fetch: route, idleTimeout: 120 });
store = new LocalObjectStore(join(root, 'objects'), ORIGIN, 'object-secret-123');
const opened = createDb({ path: ':memory:' });
core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: root,
		platformOrigin: ORIGIN,
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'builder').token, name: 'linux-builder' });
core.nodes.setBuilder(owner, joined.nodeId, true);

const DOCKERFILE = `# syntax=docker/dockerfile:1
FROM docker.io/library/alpine:3.22 AS build
RUN echo "stage one on $(uname -m)" > /msg && sha256sum /msg > /msg.sha256
FROM docker.io/library/busybox:1.37
COPY --from=build /msg /msg.sha256 /
RUN cat /msg && echo E2E-IMAGE-RUN-OK
CMD ["cat", "/msg"]
`;

function addRepository(name: string, minIsolation?: { trusted: 'gvisor' | null; untrusted: null }): void {
	const repo = gitRepo(join(root, 'repos', name));
	repo.commit({ 'README.md': 'hello\n', 'bun.lock': 'lock-v1\n', Dockerfile: DOCKERFILE }, 'Initial commit');
	core.pipelines.createRepository(owner, { name, cloneUrl: `https://example.invalid/${name}.git`, provider: 'generic', defaultBranch: 'main', minIsolation });
	// The API only accepts https/ssh URLs; this one is plain HTTP on the VM's view of this machine.
	opened.sqlite.run('UPDATE pipeline_repositories SET clone_url = ? WHERE name = ?', [`${ORIGIN}/git/${name}`, name]);
}
addRepository('demo');
addRepository('gvisor', { trusted: 'gvisor', untrusted: null });
core.pipelines.setSecret(owner, 'demo', 'API_TOKEN', { value: 's3cr3t-value-123' });
core.pipelines.setSecret(owner, 'demo', 'PG_PASSWORD', { value: 'pg-pass-9f3a2c' });

// ---------------------------------------------------------------------------------- workflows

const workflowA = `
name: e2e
on: workflow_dispatch
env:
  GREETING: hello
jobs:
  build:
    runs-on: self-hosted
    outputs:
      version: \${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v4
      - id: meta
        run: |
          echo "version=1.2.\${{ yoal.run_number }}" >> "$YOAL_OUTPUT"
          echo "$GREETING from \${{ yoal.repository }} at $(head -c 7 <<< "$YOAL_SHA")"
          echo "token is $API_TOKEN"
          echo "uid=$(id -u) kernel=$(uname -r) image=$(. /etc/os-release; echo $PRETTY_NAME)"
        env:
          API_TOKEN: \${{ secrets.API_TOKEN }}
      - uses: actions/cache@v4
        with:
          path: .cache-dir
          key: deps-\${{ hashFiles('bun.lock') }}
      - run: mkdir -p .cache-dir dist && echo cached > .cache-dir/x && echo "artifact \${{ steps.meta.outputs.version }}" > dist/out.txt
      - uses: actions/upload-artifact@v4
        with: { name: dist, path: dist }
  verify:
    needs: build
    runs-on: self-hosted
    steps:
      - uses: actions/download-artifact@v4
        with: { name: dist, path: got }
      - run: |
          test "$(cat got/out.txt)" = "artifact \${{ needs.build.outputs.version }}"
          echo "verified \${{ needs.build.outputs.version }}"
      - if: failure()
        run: echo "should not run"
`;

const workflowB = `
name: services
on: workflow_dispatch
jobs:
  db:
    runs-on: self-hosted
    container: postgres:17
    services:
      db:
        image: postgres:17
        env:
          POSTGRES_PASSWORD: \${{ secrets.PG_PASSWORD }}
        options: --health-cmd "pg_isready -U postgres"
    steps:
      - run: |
          getent hosts db
          PGPASSWORD="$PW" psql -h db -U postgres -tAc "select 'PG-OK ' || current_setting('server_version')"
          echo "password is $PW"
        env:
          PW: \${{ secrets.PG_PASSWORD }}
`;

const workflowC = `
name: image
on: workflow_dispatch
jobs:
  image:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - id: build
        uses: yoal/build-image@v1
        with:
          tags: localhost/e2e/app:\${{ yoal.run_number }}
          push: false
      - run: echo "built \${{ steps.build.outputs.image }}"
`;

const workflowD = `
name: gvisor
on: workflow_dispatch
jobs:
  sandboxed:
    runs-on: self-hosted
    steps:
      - run: |
          echo "kernel $(uname -r)"
          dmesg 2>/dev/null | head -3 || true
          cat /proc/version
`;

const workflowE = `
name: cancel
on: workflow_dispatch
jobs:
  long:
    runs-on: self-hosted
    steps:
      - run: echo STARTED-SLEEP && sleep 300
      - if: always()
        run: echo "ALWAYS-RAN status=\${{ job.status }}"
      - run: echo "should not run after cancel"
`;

// ------------------------------------------------------------------------------------ helpers

let failed = false;
const results: Array<{ scenario: string; ok: boolean; seconds: number; note: string }> = [];

function check(label: string, ok: boolean, detail = ''): boolean {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail && !ok ? ` — ${detail}` : detail ? ` (${detail.slice(0, 200)})` : ''}`);
	if (!ok) failed = true;
	return ok;
}

async function latestRun(repo: string): Promise<PipelineRunView | null> {
	const runs = core.pipelines.listRuns(owner, repo);
	return runs[0] ? core.pipelines.getRun(owner, repo, runs[0].id) : null;
}

async function waitFor(repo: string, predicate: (run: PipelineRunView) => boolean, timeoutMs: number): Promise<PipelineRunView> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const run = await latestRun(repo);
		if (run && predicate(run)) return run;
		if (Date.now() > deadline)
			throw new Error(`timed out on ${repo}: ${JSON.stringify(run?.jobs.map((j) => [j.key, j.status, j.conclusion, j.error]))}; triggers: ${JSON.stringify(core.pipelines.listTriggers(owner, repo).slice(0, 2))}`);
		await Bun.sleep(500);
	}
}

async function dispatch(repo: string, workflowText: string, timeoutMs = 10 * 60_000): Promise<{ run: PipelineRunView; seconds: number }> {
	const before = (await latestRun(repo))?.number ?? 0;
	const started = Date.now();
	core.pipelines.dispatch(owner, repo, { workflowText, ref: 'main', inputs: {} });
	const run = await waitFor(repo, (r) => r.number > before && r.status === 'completed', timeoutMs);
	return { run, seconds: (Date.now() - started) / 1000 };
}

function logs(repo: string, run: PipelineRunView, key: string): string[] {
	const job = run.jobs.find((j) => j.key === key)!;
	const lines = core.pipelines.jobLogs(owner, repo, run.id, job.id, { limit: 50_000 }).lines.map((l) => l.text);
	if (process.env.E2E_LOG_DIR) void Bun.write(join(process.env.E2E_LOG_DIR, `${repo}-${run.number}-${key}.log`), `${lines.join('\n')}\n`);
	return lines;
}

function jobSeconds(run: PipelineRunView, key: string): string {
	const job = run.jobs.find((j) => j.key === key);
	if (!job?.startedAt || !job.finishedAt) return '?';
	return ((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000).toFixed(1);
}

function summary(run: PipelineRunView): string {
	return JSON.stringify(run.jobs.map((j) => ({ key: j.key, c: j.conclusion, runtime: j.runtime, error: j.error, steps: j.steps.map((s) => s.conclusion) })));
}

async function scenario(name: string, body: () => Promise<{ seconds: number; note: string }>): Promise<void> {
	if (!scenarios.has(name)) return;
	console.log(`\n== scenario ${name}`);
	const wasFailed = failed;
	failed = false;
	const started = Date.now();
	let note = '';
	try {
		const out = await body();
		note = out.note;
	} catch (error) {
		console.error(error);
		failed = true;
		note = String(error).slice(0, 300);
	}
	// The run completes when the step runner reports; the Builder tears down right after.
	const cleanupStarted = Date.now();
	let lingering = leftovers();
	while (lingering && Date.now() - cleanupStarted < 30_000) {
		await Bun.sleep(1000);
		lingering = leftovers();
	}
	check(`${name}: no job containers, networks or directories left`, lingering === '', lingering || `clean after ${((Date.now() - cleanupStarted) / 1000).toFixed(1)}s`);
	results.push({ scenario: name, ok: !failed, seconds: (Date.now() - started) / 1000, note });
	failed = failed || wasFailed;
}

// -------------------------------------------------------------------------------------- run

try {
	installBinaries();
	installUnits(joined.token);
	// The Builder picks container isolation through the helper (auto).
	const deadline = Date.now() + 30_000;
	let journal = '';
	while (Date.now() < deadline) {
		journal = builderJournal();
		if (/polling for jobs/.test(journal)) break;
		await Bun.sleep(1000);
	}
	console.log(journal);
	check('Builder chose container isolation via yoal-helper', /polling for jobs \(container isolation, runtimes [a-z,]*runsc/.test(journal), journal);

	await scenario('a', async () => {
		const first = await dispatch('demo', workflowA);
		const run = first.run;
		check('a: run succeeded', run.conclusion === 'success', summary(run));
		const build = run.jobs.find((j) => j.key === 'build')!;
		check('a: ran in a container (runc)', build.runtime === 'runc', String(build.runtime));
		check('a: job outputs flow through needs', build.outputs.version === '1.2.1', JSON.stringify(build.outputs));
		const buildLogs = logs('demo', run, 'build');
		check('a: logs streamed from the container', buildLogs.some((l) => l.includes('hello from demo')), buildLogs.slice(0, 30).join(' | '));
		console.log(`   ${buildLogs.find((l) => l.startsWith('uid=')) ?? ''}`);
		check('a: secret masked', buildLogs.some((l) => l.includes('token is ***')) && !buildLogs.some((l) => l.includes('s3cr3t-value-123')));
		const verifyLogs = logs('demo', run, 'verify');
		check('a: artifact downloaded in the next job', verifyLogs.some((l) => l.includes('verified 1.2.1')), verifyLogs.slice(-10).join(' | '));
		check('a: failure() step skipped', run.jobs.find((j) => j.key === 'verify')!.steps.at(-1)?.conclusion === 'skipped');
		const second = await dispatch('demo', workflowA);
		const secondLogs = logs('demo', second.run, 'build');
		check('a: second run succeeded', second.run.conclusion === 'success', summary(second.run));
		check('a: cache restored on the second run', secondLogs.some((l) => /cache (restored|hit)/i.test(l)), secondLogs.filter((l) => /cache/i.test(l)).join(' | '));
		return {
			seconds: first.seconds + second.seconds,
			note: `run1 ${first.seconds.toFixed(1)}s (build ${jobSeconds(run, 'build')}s, verify ${jobSeconds(run, 'verify')}s); run2 ${second.seconds.toFixed(1)}s`,
		};
	});

	await scenario('b', async () => {
		const { run, seconds } = await dispatch('demo', workflowB);
		// The helper's progress events reach the job log through the Builder's own log batch, which
		// can land after the step runner's `Job completed` line; give it a moment.
		let out = logs('demo', run, 'db');
		for (let i = 0; i < 20 && !out.some((l) => l.includes('Service db is healthy')); i++) {
			await Bun.sleep(500);
			out = logs('demo', run, 'db');
		}
		check('b: run succeeded', run.conclusion === 'success', `${summary(run)} ${out.slice(-15).join(' | ')}`);
		const pg = out.find((l) => l.includes('PG-OK')) ?? '';
		check('b: psql reached the service by name', /PG-OK 17/.test(pg), out.slice(-15).join(' | '));
		check('b: service password masked', out.some((l) => l.includes('password is ***')) && !out.some((l) => l.includes('pg-pass-9f3a2c')));
		const health = out.find((l) => /Service db is healthy|db.*healthy/i.test(l)) ?? '';
		check('b: health command gated the job', Boolean(health), out.filter((l) => /service|db/i.test(l)).slice(0, 10).join(' | '));
		return { seconds, note: `${seconds.toFixed(1)}s; ${pg.trim()}; "${health}"` };
	});

	await scenario('c', async () => {
		const first = await dispatch('demo', workflowC, 15 * 60_000);
		const firstLogs = logs('demo', first.run, 'image');
		check('c: first build succeeded', first.run.conclusion === 'success', `${summary(first.run)} ${firstLogs.slice(-25).join(' | ')}`);
		check('c: built with BuildKit', firstLogs.some((l) => /with buildkit/i.test(l)), firstLogs.filter((l) => /Building/.test(l)).join(' | '));
		// `#11 0.123 E2E-IMAGE-RUN-OK` is the RUN step's output; the step header only names it.
		const ran = (lines: string[]) => lines.some((l) => /^#\d+ [\d.]+ E2E-IMAGE-RUN-OK$/.test(l));
		check('c: the RUN step ran in the build', ran(firstLogs));
		const second = await dispatch('demo', workflowC, 15 * 60_000);
		const secondLogs = logs('demo', second.run, 'image');
		check('c: second build succeeded', second.run.conclusion === 'success', `${summary(second.run)} ${secondLogs.slice(-25).join(' | ')}`);
		const cached = secondLogs.filter((l) => /\bCACHED\b/.test(l));
		check('c: second build hit the BuildKit cache', cached.length >= 3 && !ran(secondLogs), `${cached.length} CACHED lines`);
		return {
			seconds: first.seconds + second.seconds,
			note: `run1 ${first.seconds.toFixed(1)}s (job ${jobSeconds(first.run, 'image')}s), run2 ${second.seconds.toFixed(1)}s (job ${jobSeconds(second.run, 'image')}s, ${cached.length} CACHED)`,
		};
	});

	await scenario('d', async () => {
		const { run, seconds } = await dispatch('gvisor', workflowD);
		const out = logs('gvisor', run, 'sandboxed');
		check('d: run succeeded', run.conclusion === 'success', `${summary(run)} ${out.slice(-15).join(' | ')}`);
		const job = run.jobs[0]!;
		check('d: job ran with runsc', job.runtime === 'runsc', String(job.runtime));
		const gvisor = out.find((l) => /Starting gVisor/.test(l)) ?? '';
		check('d: the kernel is gVisor', Boolean(gvisor) && out.some((l) => /^kernel .*gvisor/.test(l)), out.slice(0, 20).join(' | '));
		return { seconds, note: `${seconds.toFixed(1)}s; runtime ${job.runtime}; "${out.find((l) => l.startsWith('kernel')) ?? ''}", "${gvisor.trim()}"` };
	});

	await scenario('e', async () => {
		const before = (await latestRun('demo'))?.number ?? 0;
		const started = Date.now();
		core.pipelines.dispatch(owner, 'demo', { workflowText: workflowE, ref: 'main', inputs: {} });
		const running = await waitFor('demo', (r) => r.number > before && r.jobs[0]?.steps[0]?.status === 'in_progress', 5 * 60_000);
		// Let the sleep get going inside the container.
		await Bun.sleep(3_000);
		const cancelAt = Date.now();
		await core.pipelines.cancelRun(owner, 'demo', running.id);
		const run = await waitFor('demo', (r) => r.id === running.id && r.status === 'completed', 3 * 60_000);
		const cancelSeconds = (Date.now() - cancelAt) / 1000;
		// The job row completes when the runner reports; teardown follows. Give cleanup a moment.
		let lingering = leftovers();
		for (let i = 0; i < 30 && lingering; i++) {
			await Bun.sleep(1000);
			lingering = leftovers();
		}
		const out = logs('demo', run, 'long');
		const job = run.jobs[0]!;
		check('e: run cancelled', run.conclusion === 'cancelled', summary(run));
		check('e: job cancelled', job.conclusion === 'cancelled', summary(run));
		check('e: always() step ran', out.some((l) => l.includes('ALWAYS-RAN')) && job.steps[1]?.conclusion === 'success', `${JSON.stringify(job.steps)} ${out.slice(-10).join(' | ')}`);
		check('e: later step skipped', job.steps[2]?.conclusion !== 'success', JSON.stringify(job.steps));
		check('e: sleep step did not finish normally', job.steps[0]?.conclusion !== 'success', JSON.stringify(job.steps));
		return {
			seconds: (Date.now() - started) / 1000,
			note: `cancel→run completed ${cancelSeconds.toFixed(1)}s; steps ${job.steps.map((s) => s.conclusion).join('/')}; "${out.find((l) => l.includes('ALWAYS-RAN')) ?? ''}"`,
		};
	});
} catch (error) {
	console.error(error);
	failed = true;
} finally {
	const journal = vm('journalctl -u yoal-builder.service -u yoal-helper.service --since "-30min" --no-pager -o cat | tail -400').out;
	await Bun.write(join(process.env.E2E_LOG_DIR ?? root, 'vm-journal.log'), journal);
	if (process.env.E2E_KEEP !== '1') {
		stopUnits();
		vm("podman rm -f $(podman ps -aq --filter label=yoal.pipeline-job) 2>/dev/null; podman network ls --format '{{.Name}}' | grep '^yoal-job-' | xargs -r podman network rm -f; rm -rf /var/lib/yoal-builder/pipelines; true");
	}
	server.stop(true);
	opened.sqlite.close();
	if (!process.env.E2E_LOG_DIR) rmSync(root, { recursive: true, force: true });
}

console.log('\nscenario | result | seconds | notes');
for (const r of results) console.log(`${r.scenario} | ${r.ok ? 'pass' : 'FAIL'} | ${r.seconds.toFixed(1)} | ${r.note}`);
console.log(failed ? '\npipelines linux e2e: FAILED' : '\npipelines linux e2e: passed');
process.exit(failed ? 1 : 0);
