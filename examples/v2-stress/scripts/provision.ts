#!/usr/bin/env bun
/**
 * Provision (and optionally deploy) the v2-stress example through the public REST API.
 *
 * Idempotent: re-running updates the workload spec, reuses existing secrets and environments, and
 * deploys a fresh artifact. Everything it needs is an API key with project/build/secret rights.
 *
 *   SKIFF_URL=https://control.example.com SKIFF_TOKEN=skif_… \
 *     bun examples/v2-stress/scripts/provision.ts --slug v2-stress
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	ApiClient,
	ApiError,
	Flags,
	asArray,
	dim,
	exampleDir,
	green,
	randomSecret,
	readState,
	sha256Hex,
	sleep,
	unwrap,
	writeState,
	yellow,
	type FlagSpec,
	type StressState
} from './lib.ts';

const flags = new Flags(process.argv.slice(2), {
	url: 'string',
	token: 'string',
	slug: 'string',
	runtime: 'string',
	image: 'string',
	placement: 'string',
	memory: 'string',
	cpus: 'string',
	port: 'string',
	'health-path': 'string',
	command: 'string',
	data: 'string',
	env: 'string',
	environment: 'string',
	'no-environment': 'boolean',
	domain: 'string',
	'check-domain': 'boolean',
	'git-repo': 'string',
	'git-branch': 'string',
	'git-root': 'string',
	'git-command': 'string',
	'git-output': 'string',
	'webhook-secret': 'string',
	'secret-env-value': 'string',
	'secret-file-value': 'string',
	'rotate-secrets': 'boolean',
	'no-secrets': 'boolean',
	'no-deploy': 'boolean',
	'no-git': 'boolean',
	'require-running': 'boolean',
	wait: 'string',
	label: 'string',
	state: 'string',
	json: 'boolean',
	help: 'boolean'
} satisfies FlagSpec);

if (flags.bool('help')) {
	console.log(`Usage: bun examples/v2-stress/scripts/provision.ts [options]

Platform (or SKIFF_URL / SKIFF_TOKEN):
  --url <origin>            control plane origin
  --token <key>             skif_… API key

Project:
  --slug <slug>             project slug (default v2-stress)
  --runtime process|container
  --image <ref>             OCI image (container runtime)
  --placement edge|auto|<node>
  --memory <mb>             workload memory budget (default 256)
  --cpus <n>                CPU quota (default 1)
  --port <n>                app port (default 3000)
  --health-path <path>      health check path (default /healthz)
  --command <argv>          process command (default "bun server.js")
  --data <mb>               /data size, 0 disables (default 128)
  --env KEY=VALUE           extra public env (repeatable)
  --environment <slug>      create this environment too (default staging)
  --no-environment          do not create a named environment
  --domain <hostname>       attach a custom domain
  --check-domain            run the DNS check after attaching

Git build (optional):
  --git-repo <url>          public HTTPS repository
  --git-branch <branch>     default main
  --git-root <dir>          default examples/v2-stress
  --git-command <command>   default "bun run build"
  --git-output <dir>        default dist
  --webhook-secret <value>  reuse an existing GitHub webhook secret
  --no-git                  skip git configuration

Secrets and deploy:
  --secret-env-value <v>    use a known env secret instead of generating one
  --secret-file-value <v>   use a known file secret instead of generating one
  --rotate-secrets          create a new secret version even when one exists
  --no-secrets              do not attach secret refs
  --no-deploy               configure only; do not build/deploy
  --require-running         fail unless the workload reaches running
  --wait <seconds>          wait for the workload (default 120, 0 skips)
  --label <text>            build/deploy label

Output:
  --state <path>            state file (default examples/v2-stress/.state.json)
  --json                    print the final state as JSON
  -h, --help
`);
	process.exit(0);
}

const example = exampleDir();
const statePath = join(example, '.state.json');
const saved = readState(flags.string('state') ?? statePath);

const platform = (flags.string('url') ?? process.env.SKIFF_URL ?? saved?.platform ?? '').replace(
	/\/+$/,
	''
);
const token = flags.string('token') ?? process.env.SKIFF_TOKEN ?? '';
if (!platform || !token) {
	fail('Set SKIFF_URL and SKIFF_TOKEN (or pass --url/--token).');
}
if (!/^https?:\/\//.test(platform)) fail('--url must start with http:// or https://');

const slug = flags.string('slug') ?? saved?.project ?? 'v2-stress';
const previous = saved?.project === slug ? saved : null;
const runtime = (flags.string('runtime') ?? previous?.runtime ?? 'process') as 'process' | 'container';
if (runtime !== 'process' && runtime !== 'container')
	fail('--runtime must be process or container');
const image = flags.string('image');
if (runtime === 'container' && !image) fail('--image is required for a container workload');

const memoryMb = flags.int('memory', 256, 32, 8192);
const cpus = Number(flags.string('cpus') ?? '1');
if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 8) fail('--cpus must be between 0.1 and 8');
const port = flags.int('port', 3000, 1, 65_535);
const healthPath = flags.string('health-path') ?? '/healthz';
const dataMb = flags.int('data', 128, 0, 65_536);
const label = flags.string('label') ?? new Date().toISOString().replace(/[:.]/g, '-');
const environmentSlug = flags.bool('no-environment')
	? undefined
	: (flags.string('environment') ?? 'staging');
const wantSecrets = !flags.bool('no-secrets');
const wantDeploy = !flags.bool('no-deploy');
const waitSeconds = flags.int('wait', 120, 0, 1800);
const stateFile = flags.string('state') ?? statePath;

const api = new ApiClient({ baseUrl: platform, token });

interface ProjectView {
	id: string;
	slug: string;
	name: string;
	runtime: string;
	placement: string;
	productionDeploymentId: string | null;
	productionUrl: string;
	previewPattern?: string;
}
interface WorkloadView {
	id: string;
	projectId: string;
	projectSlug: string;
	deploymentId: string;
	nodeId: string | null;
	runtime: string;
	status: string;
	memoryMb: number;
	cpus: number;
	upstream: string | null;
	message: string | null;
}
interface SecretView {
	id: string;
	name: string;
	type: string;
	version: number;
	projectId: string | null;
}
interface EnvironmentView {
	id: string;
	name: string;
	slug: string;
	isProduction: boolean;
	host: string;
	access: string;
	deploymentId: string | null;
}
interface DeploymentView {
	id: string;
	shortId?: string;
	status: string;
	productionUrl?: string;
	url?: string;
	environmentSlug?: string;
	production?: boolean;
}
interface DomainView {
	id: string;
	hostname: string;
	status: string;
	verification: { recordName: string; recordValue: string } | null;
}
interface GitView {
	repoUrl: string;
	branch: string;
	rootDir: string;
	buildCommand: string;
	outputDir: string;
	hasWebhookSecret: boolean;
}

const state: StressState = {
	...(previous ?? { project: slug, secretDigests: {}, updatedAt: new Date(0).toISOString() }),
	platform,
	project: slug,
	runtime,
	memoryMb,
	cpus,
	port,
	secretDigests: { ...(previous?.secretDigests ?? {}) },
	updatedAt: new Date().toISOString()
};

function log(message: string): void {
	if (!flags.bool('json')) console.log(message);
}

try {
	await main();
} catch (error) {
	if (error instanceof ApiError) fail(`${error.message} (HTTP ${error.status})`);
	fail(error instanceof Error ? error.message : String(error));
}

async function main(): Promise<void> {
	log(`${dim('platform')} ${platform}`);

	const project = await ensureProject();
	state.projectId = project.id;
	state.runtime = project.runtime;

	const whoami = await api.get<{ contentDomain?: string }>('/api/v1/whoami');
	const contentDomain = whoami.contentDomain ?? '';

	const secretRefs = await ensureSecrets(project.id);
	await ensureWorkload(secretRefs);
	const environment = environmentSlug ? await ensureEnvironment(environmentSlug) : null;
	if (environment) {
		state.environment = environment.slug;
		state.stagingUrl = contentUrl(platform, environment.host);
	}
	await ensureGit();
	const domain = flags.string('domain') ? await ensureDomain(project) : null;

	let deployment: DeploymentView | null = null;
	if (wantDeploy) {
		deployment = await deploy(project);
		state.deploymentId = deployment.id;
		const url = deployment.productionUrl ?? deployment.url ?? project.productionUrl;
		if (url) state.appUrl = url;
	}

	if (waitSeconds > 0) {
		const workload = await waitForWorkload();
		if (workload) {
			state.workloadId = workload.id;
			const tone =
				workload.status === 'running' ? green : workload.status === 'failed' ? yellow : yellow;
			log(
				`${dim('workload')} ${workload.id} ${tone(workload.status)}` +
					`${workload.nodeId ? ` on ${workload.nodeId}` : ''}` +
					`${workload.upstream ? ` → ${workload.upstream}` : ''}`
			);
			if (workload.message) log(`${dim('message')}  ${workload.message}`);
			if (flags.bool('require-running') && workload.status !== 'running') {
				throw new Error(`workload did not reach running (last status: ${workload.status})`);
			}
			if (workload.status !== 'running') {
				log(
					yellow(
						'warning: the workload is not running yet. A dev control plane without an enrolled agent will stay pending; the runtime starts on a real node.'
					)
				);
			}
		}
	}

	state.updatedAt = new Date().toISOString();
	writeState(stateFile, state);

	if (flags.bool('json')) {
		console.log(JSON.stringify(state, null, 2));
		return;
	}

	log('');
	log(`${green('provisioned')} ${project.slug} (${project.runtime}, ${project.placement})`);
	if (state.appUrl) log(`  app        ${state.appUrl}`);
	if (state.stagingUrl) log(`  staging    ${state.stagingUrl}`);
	if (state.workloadId) log(`  workload   ${state.workloadId}`);
	if (deployment) log(`  deployment ${deployment.id}`);
	if (state.gitRepo) {
		log(`  webhook    ${platform}/api/webhooks/github/${project.slug}`);
		log(
			`  secret     ${state.webhookSecret ?? '(set in GitHub)'}  ${dim('(also in .state.json, 0600)')}`
		);
	}
	if (domain) printDomain(domain, contentDomain);
	if (state.secretDigests.STRESS_ENV_SECRET)
		log(`  secret env sha256  ${state.secretDigests.STRESS_ENV_SECRET}`);
	if (state.secretDigests.STRESS_FILE_SECRET)
		log(`  secret file sha256 ${state.secretDigests.STRESS_FILE_SECRET}`);
	log('');
	log(`state written to ${stateFile}`);
	if (state.appUrl) {
		log('');
		log('next:');
		log(
			`  bun examples/v2-stress/scripts/stress.ts --base ${state.appUrl} --state ${stateFile}${
				state.workloadId ? ' --node-token "$SKIFF_NODE_TOKEN"' : ''
			}`
		);
	}
}

async function ensureProject(): Promise<ProjectView> {
	let existing: ProjectView | null = null;
	try {
		existing = unwrap<ProjectView>(
			await api.get(`/api/v1/projects/${encodeURIComponent(slug)}`),
			'project'
		);
	} catch (error) {
		if (!(error instanceof ApiError) || error.status !== 404) throw error;
	}
	if (existing) {
		if (existing.runtime !== runtime) {
			throw new Error(
				`project "${slug}" already exists with runtime ${existing.runtime}; runtime cannot change. Use another --slug.`
			);
		}
		const placement = flags.string('placement');
		if (placement && placement !== existing.placement) {
			const updated = unwrap<ProjectView>(
				await api.patch(`/api/v1/projects/${encodeURIComponent(slug)}`, { placement }),
				'project'
			);
			log(`${dim('project')}  ${updated.slug} (placement → ${placement})`);
			return updated;
		}
		log(`${dim('project')}  ${existing.slug} (exists)`);
		return existing;
	}
	const created = unwrap<ProjectView>(
		await api.post('/api/v1/projects', {
			name: 'v2 stress',
			slug,
			runtime,
			placement: flags.string('placement') ?? 'edge',
			productionAccess: 'public',
			previewAccess: 'platform'
		}),
		'project'
	);
	log(`${dim('project')}  ${created.slug} (${created.id}) created`);
	return created;
}

async function ensureSecrets(
	projectId: string
): Promise<Array<{ name: string; delivery: 'env' | 'file' }>> {
	if (!wantSecrets) return [];
	const refs: Array<{ name: string; delivery: 'env' | 'file' }> = [
		{ name: 'STRESS_ENV_SECRET', delivery: 'env' },
		{ name: 'STRESS_FILE_SECRET', delivery: 'file' }
	];
	const listed = await api.get('/api/v1/secrets');
	// Secrets are org-scoped by name (projectId is metadata), so a name may already exist for a
	// different project. Reuse it instead of silently creating a version that changes that project.
	const existing = asArray<SecretView>(listed, 'secrets');
	const byName = new Map(existing.map((secret) => [secret.name, secret]));
	const rotate = flags.bool('rotate-secrets');

	for (const ref of refs) {
		const present = byName.get(ref.name);
		if (present && !rotate) {
			const foreign = present.projectId !== projectId;
			log(
				`${dim('secret')}   ${ref.name} v${present.version} (exists${foreign ? ', org-wide' : ''})`
			);
			if (!state.secretDigests[ref.name]) {
				log(
					yellow(
						`  note: no local digest for ${ref.name}; rerun with --rotate-secrets to generate a value this harness can verify.`
					)
				);
			}
			continue;
		}
		if (rotate && present) {
			log(
				yellow(
					`  note: rotating ${ref.name} affects every project that references it; it takes effect at their next activation.`
				)
			);
		}
		const supplied =
			ref.name === 'STRESS_ENV_SECRET'
				? (flags.string('secret-env-value') ?? process.env.STRESS_ENV_SECRET)
				: (flags.string('secret-file-value') ?? process.env.STRESS_FILE_SECRET);
		const value = supplied ?? randomSecret(ref.delivery === 'env' ? 'sks_env' : 'sks_file');
		const created = await api.post<SecretView>('/api/v1/secrets', {
			name: ref.name,
			value,
			projectId,
			type: 'secret'
		});
		state.secretDigests[ref.name] = sha256Hex(value);
		log(
			`${dim('secret')}   ${ref.name} v${created.version} ${rotate && present ? 'rotated' : 'created'}` +
				` ${dim(`sha256:${state.secretDigests[ref.name]!.slice(0, 12)}…`)}`
		);
	}
	return refs;
}

function parseEnvPairs(pairs: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of pairs) {
		const equals = pair.indexOf('=');
		if (equals <= 0) throw new Error(`--env expects KEY=VALUE, got "${pair}"`);
		const key = pair.slice(0, equals);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid env name "${key}"`);
		out[key] = pair.slice(equals + 1);
	}
	return out;
}

async function ensureWorkload(
	secretRefs: Array<{ name: string; delivery: 'env' | 'file' }>
): Promise<void> {
	const env: Record<string, string> = {
		STRESS_APP: 'v2-stress',
		STRESS_ENV: 'production',
		STRESS_RUNTIME: runtime,
		STRESS_BUILD: label,
		...(runtime === 'container' ? { HOST: '0.0.0.0' } : {}),
		...parseEnvPairs(flags.list('env'))
	};
	const spec: Record<string, unknown> = {
		runtime,
		port,
		memoryMb,
		cpus,
		healthPath,
		env,
		...(wantSecrets ? { secrets: secretRefs } : {}),
		...(dataMb > 0 ? { data: { sizeMb: dataMb } } : {})
	};
	if (runtime === 'process') {
		const command = (flags.string('command') ?? 'bun server.js')
			.trim()
			.split(/\s+/)
			.filter(Boolean);
		if (command.length === 0) throw new Error('--command must not be empty');
		spec.command = command;
		// Bun 1.4 cannot adopt systemd's inherited listen fd, so the example opts into loopback.
		spec.socketActivation = false;
	} else {
		spec.image = image;
	}
	await api.put(`/api/v1/projects/${encodeURIComponent(slug)}/workload`, spec);
	log(
		`${dim('workload')}  ${runtime} spec saved (${memoryMb} MB, ${cpus} vCPU, :${port}${healthPath})`
	);
}

async function ensureEnvironment(name: string): Promise<EnvironmentView | null> {
	const listed = await api.get(`/api/v1/projects/${encodeURIComponent(slug)}/environments`);
	const environments = asArray<EnvironmentView>(listed, 'environments');
	const slugified = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const existing = environments.find((candidate) => candidate.slug === slugified);
	if (existing) {
		log(`${dim('environment')} ${existing.slug} ${dim(`(${existing.host})`)}`);
		return existing;
	}
	if (slugified === 'production')
		return environments.find((candidate) => candidate.isProduction) ?? null;
	const created = unwrap<EnvironmentView>(
		await api.post(`/api/v1/projects/${encodeURIComponent(slug)}/environments`, {
			name: name.trim() || slugified,
			slug: slugified,
			access: 'platform'
		}),
		'environment'
	);
	log(`${dim('environment')} ${created.slug} ${dim(`(${created.host})`)} created`);
	return created;
}

async function ensureGit(): Promise<void> {
	if (flags.bool('no-git')) return;
	const repoUrl = flags.string('git-repo');
	if (!repoUrl) return;
	if (!repoUrl.startsWith('https://')) {
		log(
			yellow(
				`warning: the Builder clones public HTTPS repositories; "${repoUrl}" may fail without credentials.`
			)
		);
	}
	const branch = flags.string('git-branch') ?? 'main';
	const rootDir = flags.string('git-root') ?? 'examples/v2-stress';
	const buildCommand = flags.string('git-command') ?? 'bun run build';
	const outputDir = flags.string('git-output') ?? 'dist';
	const webhookSecret =
		flags.string('webhook-secret') ??
		(previous?.gitRepo === repoUrl ? previous.webhookSecret : undefined) ??
		sha256Hex(randomSecret('whsec')).slice(0, 40);
	const view = unwrap<GitView>(
		await api.put(`/api/v1/projects/${encodeURIComponent(slug)}/git`, {
			repoUrl,
			branch,
			rootDir,
			buildCommand,
			outputDir,
			webhookSecret,
			enabled: true
		}),
		'gitSource'
	);
	state.gitRepo = view.repoUrl ?? repoUrl;
	state.webhookSecret = webhookSecret;
	log(
		`${dim('git')}       ${view.repoUrl ?? repoUrl} @ ${view.branch ?? branch} → ${view.outputDir ?? outputDir}`
	);
}

async function ensureDomain(project: ProjectView): Promise<DomainView> {
	const hostname = flags.string('domain')!;
	const listed = await api.get(`/api/v1/domains?project=${encodeURIComponent(slug)}`);
	const existing = asArray<DomainView>(listed, 'domains').find(
		(candidate) => candidate.hostname === hostname.toLowerCase()
	);
	let domain: DomainView;
	if (existing) {
		domain = existing;
		log(`${dim('domain')}    ${domain.hostname} (${domain.status})`);
	} else {
		domain = unwrap<DomainView>(
			await api.post('/api/v1/domains', {
				project: project.slug,
				hostname,
				redirectWww: hostname.split('.').length === 2
			}),
			'domain'
		);
		log(`${dim('domain')}    ${domain.hostname} (${domain.status}) created`);
	}
	state.domain = domain.hostname;
	if (flags.bool('check-domain')) {
		const checked = await api.post<{
			domain?: DomainView;
			detail?: string;
			records?: Array<{ type: string; name: string; value: string }>;
		}>(`/api/v1/domains/${encodeURIComponent(domain.id)}/check`);
		const updated = checked.domain ?? domain;
		log(
			`${dim('domain')}    check → ${updated.status}${checked.detail ? ` (${checked.detail})` : ''}`
		);
		for (const record of checked.records ?? []) {
			log(`  ${record.type.padEnd(5)} ${record.name} → ${record.value}`);
		}
	}
	return domain;
}

function platformHost(origin: string): string {
	try {
		return new URL(origin).hostname;
	} catch {
		return origin;
	}
}

async function deploy(project: ProjectView): Promise<DeploymentView> {
	let file: { path: string; content: string; encoding: 'base64' | 'utf8' };
	if (runtime === 'process') {
		log(`${dim('build')}     bun build → dist/server.js`);
		const outdir = join(example, 'dist');
		mkdirSync(outdir, { recursive: true });
		const result = await Bun.build({
			entrypoints: [join(example, 'src/server.ts')],
			outdir,
			target: 'bun',
			sourcemap: 'none'
		});
		if (!result.success) {
			for (const message of result.logs) console.error(String(message));
			throw new Error('Bun.build failed');
		}
		const bytes = readFileSync(join(outdir, 'server.js'));
		log(`${dim('artifact')}  ${bytes.byteLength} bytes`);
		file = {
			path: 'server.js',
			content: Buffer.from(bytes).toString('base64'),
			encoding: 'base64'
		};
	} else {
		// A container workload pulls its image at activation; the release is only the deploy record.
		file = {
			path: 'artifact.txt',
			content: `v2-stress container ${image} ${label}\n`,
			encoding: 'utf8'
		};
	}
	const deployment = unwrap<DeploymentView>(
		await api.post(`/api/v1/projects/${encodeURIComponent(slug)}/deploy`, {
			files: [file],
			promote: true,
			message: `v2-stress ${label}`
		}),
		'deployment'
	);
	log(
		`${dim('deployment')} ${deployment.id}${deployment.shortId ? ` (${deployment.shortId})` : ''} active`
	);
	return deployment;
}

async function waitForWorkload(): Promise<WorkloadView | null> {
	const deadline = Date.now() + waitSeconds * 1000;
	let last: WorkloadView | null = null;
	let announced = false;
	while (Date.now() < deadline) {
		try {
			const workload = unwrap<WorkloadView | null>(
				await api.get(`/api/v1/projects/${encodeURIComponent(slug)}/workload`),
				'workload'
			);
			if (!workload) return null;
			last = workload;
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) return null;
			throw error;
		}
		if (last.status === 'running' || last.status === 'failed' || last.status === 'stopped')
			return last;
		if (!announced) {
			log(`${dim('workload')}  waiting for ${slug} (${last.status})…`);
			announced = true;
		}
		await sleep(2000);
	}
	return last;
}

function contentUrl(origin: string, host: string): string {
	const normalized = host.trim().toLowerCase();
	if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
		try {
			const parsed = new URL(origin);
			return `${parsed.protocol}//${normalized}${parsed.port ? `:${parsed.port}` : ''}`;
		} catch {
			return `http://${normalized}`;
		}
	}
	return `https://${normalized}`;
}

function printDomain(domain: DomainView, contentDomain: string): void {
	log(`  domain     ${domain.hostname} (${domain.status})`);
	if (domain.verification) {
		log(`    TXT   ${domain.verification.recordName} → ${domain.verification.recordValue}`);
	}
	if (contentDomain) {
		const traffic =
			contentDomain === 'localhost'
				? { type: 'A', value: platformHost(platform) }
				: /^\d+(?:\.\d+){3}$/.test(contentDomain)
					? { type: 'A', value: contentDomain }
					: { type: 'CNAME', value: `${slug}.${contentDomain}` };
		log(`    ${traffic.type.padEnd(5)} ${domain.hostname} → ${traffic.value}`);
	}
}

function fail(message: string): never {
	console.error(`provision: ${message}`);
	process.exit(1);
}
