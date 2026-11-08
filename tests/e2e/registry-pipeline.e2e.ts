/**
 * Build → registry → deploy, end to end (docs/REGISTRY.md, docs/PIPELINES.md).
 *
 * The real control-plane engine (`@skiff/core`) behind a small HTTP server that mirrors the
 * SvelteKit routes it needs (pipeline job API, registry token realm, registry webhook), the real
 * Builder pipeline loop and step runner (direct mode), and a real zot from the helper's own pinned
 * image and rendered config, run in Docker. The workflow builds a Dockerfile with
 * `skiff/build-image` (docker backend), pushes `registry/web:<sha>` and `registry/web:latest` with
 * the job's own registry login, and deploys the built digest with `skiff/deploy`. A push of
 * `latest` also deploys a second project through deploy on push.
 *
 * Needs Docker (OrbStack/Docker Desktop), whose engine reaches this process as host.docker.internal.
 *
 *   bun tests/e2e/registry-pipeline.e2e.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../../packages/db/src/index.ts';
import {
	DEFAULT_FEATURES,
	pipelineClaimRequestSchema,
	pipelineDeploySchema,
	pipelineJobCompleteSchema,
	pipelineLogBatchSchema,
	pipelineResolveReportSchema,
	pipelineStepReportSchema,
	type PipelineRunView,
} from '../../packages/contracts/src/index.ts';
import { CoreError, LocalObjectStore, buildPrincipal, createCore, type Core } from '../../packages/core/src/index.ts';
import { loadConfig } from '../../apps/builder/src/config.ts';
import { runPipelineLoop } from '../../apps/builder/src/pipeline/loop.ts';
import { gitRepo } from '../../apps/builder/src/pipeline/git-fixture.ts';
import { renderZotConfig } from '../../apps/helper/src/registry.ts';

const ZOT_PORT = 5057;
const REGISTRY = `localhost:${ZOT_PORT}`;
const ZOT_IMAGE = 'ghcr.io/project-zot/zot:v2.1.23@sha256:9d3de83ac2099e6f4843045b4c9b65b7e8baf40f92d28f54906dee9d4d390fd7';
const CONTAINER = 'skiff-registry-e2e';

/** How the Docker engine (and zot inside it) reaches this process: OrbStack/Docker Desktop's host alias. */
const DOCKER_HOST_ALIAS = process.env.E2E_DOCKER_HOST_ALIAS ?? 'host.docker.internal';

const root = mkdtempSync(join(tmpdir(), 'skiff-registry-e2e-'));
let core: Core;
const json = (data: unknown, status = 200) => Response.json(data, { status });

async function route(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	const authorization = request.headers.get('authorization') ?? '';
	const token = authorization.replace(/^Bearer /, '');
	const engine = core.pipelines.engine;
	try {
		if (path === '/api/registry/token') {
			const [username, password] = Buffer.from(authorization.slice(6), 'base64').toString().split(/:(.*)/s); // RFC 7617: the user id has no colon
			const client = authorization.startsWith('Basic ') ? { kind: 'login' as const, username: username!, password: password ?? '' } : { kind: 'anonymous' as const };
			try {
				const issued = await core.registry.authorize(client, url.searchParams.get('service'), url.searchParams.getAll('scope'));
				if (process.env.E2E_VERBOSE) console.log('[realm]', username, url.searchParams.getAll('scope'), JSON.parse(Buffer.from(issued.token.split('.')[1]!, 'base64url').toString()).access);
				return json(issued);
			} catch (error) {
				if (process.env.E2E_VERBOSE) console.log('[realm] refused', JSON.stringify(authorization.slice(0, 12)), username, url.searchParams.getAll('scope'), String(error));
				throw error;
			}
		}
		if (path.startsWith('/api/webhooks/registry/'))
			return json({ ok: core.registry.recordEvent(path.split('/').pop()!, request.headers.get('ce-type'), await request.json()) }, 202);
		if (path === '/api/agent/pipelines/claim') {
			const node = core.nodes.authenticate(token);
			return json((await engine.claim(node.id, pipelineClaimRequestSchema.parse(await request.json()))) ?? null);
		}
		const [, , , action, id, sub] = path.split('/');
		if (token.startsWith('ptk_')) {
			const trigger = engine.authenticateTrigger(token);
			if (action === 'resolve') return json({ ok: true, runIds: engine.resolveTrigger(trigger, pipelineResolveReportSchema.parse(await request.json())) });
			if (action === 'heartbeat') return json(engine.heartbeatTrigger(trigger));
		}
		if (action === 'complete') {
			const job = engine.authenticateJob(token, { allowCompleted: true });
			const input = pipelineJobCompleteSchema.parse(await request.json());
			if (job.status !== 'completed') engine.complete(job, input);
			return json({ ok: true });
		}
		if (action === 'logs') {
			const job = engine.authenticateJob(token, { allowCompleted: true });
			return json({ ok: true, accepted: engine.appendLogs(job, pipelineLogBatchSchema.parse(await request.json())) });
		}
		const job = engine.authenticateJob(token);
		if (action === 'heartbeat') return json(engine.heartbeat(job));
		if (action === 'secrets') return json({ secrets: engine.secrets(job) });
		if (action === 'steps') {
			engine.reportStep(job, Number(id), pipelineStepReportSchema.parse(await request.json()));
			return json({ ok: true });
		}
		if (action === 'deploy' && !id) return json(await engine.startDeploy(job, pipelineDeploySchema.parse(await request.json())));
		if (action === 'deploy' && sub === 'finalize') return json(await engine.finalizeDeploy(job, id!));
		return json({ error: 'not_found', path }, 404);
	} catch (error) {
		if (error instanceof CoreError) return json({ error: error.code, message: error.message }, error.status);
		console.error('[e2e server]', error);
		return json({ error: String(error) }, 500);
	}
}

const server = Bun.serve({ port: 0, hostname: '0.0.0.0', fetch: route });
// The platform origin is what Docker and zot dial (token realm, push events); the builder and the
// object store stay on loopback.
const origin = `http://${DOCKER_HOST_ALIAS}:${server.port}`;
const local = `http://127.0.0.1:${server.port}`;
// The control plane talks to zot over plain http on loopback (production: https via Caddy).
const registryFetch = (async (input: string | URL | Request, init?: RequestInit) =>
	fetch(String(input instanceof Request ? input.url : input).replace(`https://${REGISTRY}`, `http://${REGISTRY}`), init)) as typeof fetch;
const opened = createDb({ path: ':memory:' });
core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: root,
		platformOrigin: origin,
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(root, 'objects'), local, 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features: DEFAULT_FEATURES,
		registryFetch,
	},
});

opened.sqlite.run('CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT, createdAt TEXT)');
opened.sqlite.run(`INSERT INTO organization (id, name, slug) VALUES ('org_1', 'Acme', 'acme')`);
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'builder').token, name: 'builder' });
core.nodes.setBuilder(owner, joined.nodeId, true);

// The registry: enabled on the builder node; zot runs from the helper's pinned image and config.
core.registry.update(owner, { enabled: true, node: 'builder', host: REGISTRY, mirrors: ['docker.io'] });
const [zot] = core.registry.desiredForNode(joined.nodeId);
const activation = core.workloads.activation(joined.nodeId, zot!.id);
const zotDir = join(root, 'zot');
await Bun.write(
	join(zotDir, 'config.json'),
	renderZotConfig(zot!.registry as never, {
		certificatePem: activation.env.SKIFF_REGISTRY_TOKEN_CERT!,
		eventsUrl: activation.env.SKIFF_REGISTRY_EVENTS_URL!,
		adminHtpasswd: null,
		s3: null,
	}),
);
await Bun.write(join(zotDir, 'cert.pem'), activation.env.SKIFF_REGISTRY_TOKEN_CERT!);
const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
docker('rm', '-f', CONTAINER);
const started = docker(
	'run', '-d', '--name', CONTAINER, '--user', '65532:65532', '--read-only', '--cap-drop', 'all',
	'--security-opt', 'no-new-privileges', '--tmpfs', '/tmp',
	'--mount', 'type=tmpfs,destination=/var/lib/registry,tmpfs-mode=1777',
	'-p', `${ZOT_PORT}:5000`, '-v', `${zotDir}:/etc/zot:ro`, ZOT_IMAGE, 'serve', '/etc/zot/config.json',
);
if (started.exitCode !== 0) throw new Error(`docker run failed: ${started.stderr.toString()}`);
for (let i = 0; i < 50; i++) {
	if ((await fetch(`http://${REGISTRY}/readyz`).catch(() => null))?.ok) break;
	await Bun.sleep(200);
}

// Two container projects: `web` deployed by the workflow, `web-auto` by deploy on push of :latest.
for (const slug of ['web', 'web-auto'])
	await core.projects.create(owner, { name: slug, slug, runtime: 'container', placement: 'auto', productionAccess: 'public', previewAccess: 'platform' });
core.workloads.setSpec(owner, core.projects.requireRow(owner, 'web-auto'), { runtime: 'container', image: `${REGISTRY}/acme/web:latest`, port: 8080 } as never);

const repoDir = join(root, 'origin');
const repo = gitRepo(repoDir);
repo.commit(
	{
		Dockerfile: 'FROM busybox:1.37\nCOPY index.html /www/index.html\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n',
		'index.html': `<h1>built by skiff ${Date.now()}</h1>\n`,
	},
	'Initial commit',
);
core.pipelines.createRepository(owner, { name: 'web', cloneUrl: 'https://example.invalid/web.git', provider: 'generic', defaultBranch: 'main' });
opened.sqlite.run('UPDATE pipeline_repositories SET clone_url = ? WHERE name = ?', [repoDir, 'web']);
core.pipelines.linkProject(owner, 'web', 'web', { environment: null });

const workflow = `
name: ship
on: workflow_dispatch
jobs:
  image:
    runs-on: self-hosted
    steps:
      - uses: skiff/checkout
      - run: echo "pushing to $SKIFF_REGISTRY_NAMESPACE"
      - id: build
        uses: skiff/build-image
        with:
          builder: docker
          tags: |
            registry/web:\${{ skiff.sha }}
            registry/web:latest
      - uses: skiff/deploy
        with:
          project: web
          image: \${{ steps.build.outputs.image }}
          promote: true
`;

const config = loadConfig(
	{
		SKIFF_CONTROL_URL: local,
		SKIFF_NODE_TOKEN: joined.token,
		SKIFF_BUILD_DIR: join(root, 'build'),
		SKIFF_BUILDER_SYSTEMD: 'false',
		SKIFF_PIPELINE_POLL_MS: '200',
		SKIFF_PIPELINE_ISOLATION: 'sandbox',
		SKIFF_PIPELINE_STEP_BINARY: process.env.E2E_STEP_BINARY ?? '',
	},
	{ platform: process.platform, isRoot: false, has: (b) => Boolean(Bun.which(b)), arch: process.arch, exists: () => false },
);
const abort = new AbortController();
const loop = runPipelineLoop(config, abort.signal);
let failed = false;

function check(label: string, ok: boolean, detail = ''): void {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failed = true;
}

async function waitFor<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (ok(value) || Date.now() > deadline) return value;
		await Bun.sleep(250);
	}
}

try {
	// Deploy on push: every push of acme/web:latest deploys to web-auto. The repository row exists
	// once a push grant creates it, so ask for one first (what `docker push` would do).
	core.registry.issueToken({ kind: 'principal', principal: owner }, REGISTRY, ['repository:acme/web:push,pull']);
	core.registry.setAutoDeploy(owner, 'acme/web', { project: 'web-auto', tag: 'latest' });

	core.pipelines.dispatch(owner, 'web', { workflowText: workflow, ref: 'main', inputs: {} });
	const run = await waitFor(
		async (): Promise<PipelineRunView | null> => {
			const [latest] = core.pipelines.listRuns(owner, 'web');
			return latest ? core.pipelines.getRun(owner, 'web', latest.id) : null;
		},
		(value) => value?.status === 'completed',
		240_000,
	);
	const job = run?.jobs[0];
	const logs = run && job ? core.pipelines.jobLogs(owner, 'web', run.id, job.id, { limit: 5000 }).lines.map((line) => line.text) : [];
	check('run completed successfully', run?.conclusion === 'success', `${run?.conclusion} ${JSON.stringify(job?.steps)}\n${logs.slice(-40).join('\n')}`);
	check('steps saw the registry namespace', logs.some((line) => line.includes(`pushing to ${REGISTRY}/acme`)));
	const built = logs.find((line) => line.startsWith('Built and pushed '))?.slice('Built and pushed '.length) ?? '';
	const digest = built.split('@')[1] ?? '';
	check('build-image pushed with the job login and reported a digest', /^sha256:[a-f0-9]{64}$/.test(digest), built);
	check('the job token never reached the logs', !logs.some((line) => line.includes('pjt_')));

	const web = core.workloads.view(core.projects.requireRow(owner, 'web'));
	check('skiff/deploy pinned web to the built digest', web?.imageDigest === digest, JSON.stringify(web));

	const repository = await waitFor(
		() => core.registry.listRepositories(owner).find((row) => row.name === 'acme/web'),
		(row) => Boolean(row?.lastDigest),
		10_000,
	);
	check('zot reported the push', repository?.lastDigest === digest && Boolean(repository?.lastTag), JSON.stringify(repository));

	const auto = await waitFor(
		() => core.workloads.view(core.projects.requireRow(owner, 'web-auto')),
		(view) => view?.imageDigest === digest,
		20_000,
	);
	check('deploy on push deployed :latest to web-auto, pinned', auto?.imageDigest === digest, JSON.stringify(auto));

	const pins = (opened.sqlite.query('SELECT deployment_id, digest FROM registry_pins').all() as Array<{ deployment_id: string; digest: string }>);
	check('both deployments are pinned in the registry', pins.length >= 2 && pins.every((pin) => pin.digest === digest), JSON.stringify(pins));
	const tagList = await registryFetch(`https://${REGISTRY}/v2/acme/web/tags/list`, {
		headers: { Authorization: `Bearer ${core.registry.internalToken('acme/web')}` },
	}).then((response) => response.json() as Promise<{ tags: string[] }>);
	check('pin tags exist in zot', pins.every((pin) => tagList.tags.includes(`skiff-d-${pin.deployment_id}`)), JSON.stringify(tagList.tags));
	check('dashboard tags hide the pins', (await core.registry.tags(owner, 'acme/web')).every((tag) => !tag.tag.startsWith('skiff-d-')));

	// The pull-through cache (G4): a node logs in with its node token and pulls Docker Hub through zot.
	const mirrorConfig = join(root, 'mirror-docker');
	await Bun.write(
		join(mirrorConfig, 'config.json'),
		JSON.stringify({ auths: { [REGISTRY]: { auth: Buffer.from(`node.${joined.nodeId}:${joined.token}`).toString('base64') } } }),
	);
	// Async: this process serves the token realm the pull needs, so it must not block.
	const pull = async (ref: string, config: string) => {
		const child = Bun.spawn(['docker', 'pull', '-q', ref], { env: { ...process.env, DOCKER_CONFIG: config }, stdout: 'pipe', stderr: 'pipe' });
		return { code: await child.exited, stderr: await new Response(child.stderr).text() };
	};
	const mirrored = await pull(`${REGISTRY}/docker.io/library/busybox:1.37`, mirrorConfig);
	check('a node pulls Docker Hub through the mirror', mirrored.code === 0, mirrored.stderr.slice(0, 300));
	const anonymous = await pull(`${REGISTRY}/docker.io/library/alpine:3.20`, join(root, 'no-login'));
	check('the mirror refuses anonymous pulls', anonymous.code !== 0);
	docker('rmi', `${REGISTRY}/docker.io/library/busybox:1.37`);

	// Untrusted runs pull but never push (W10).
	opened.sqlite.run("UPDATE pipeline_runs SET trust = 'untrusted' WHERE id = ?", [run!.id]);
	check('an untrusted job registry view refuses pushes', core.registry.jobRegistry('org_1', 'untrusted')?.push === false);
} catch (error) {
	console.error(error);
	failed = true;
} finally {
	abort.abort();
	await Promise.race([loop, Bun.sleep(10_000)]);
	server.stop(true);
	docker('rm', '-f', CONTAINER);
	// Every tag the build left locally (`latest` and the commit SHA), so runs don't pile up images.
	const local = docker('images', '--format', '{{.Repository}}:{{.Tag}}', `${REGISTRY}/acme/web`).stdout.toString().split('\n').filter(Boolean);
	// One at a time: OrbStack's daemon answered a multi-image `rmi` with "page not found".
	for (const image of local) docker('rmi', image);
	opened.sqlite.close();
	rmSync(root, { recursive: true, force: true });
}
console.log(failed ? '\nregistry pipeline e2e: FAILED' : '\nregistry pipeline e2e: passed');
process.exit(failed ? 1 : 0);
