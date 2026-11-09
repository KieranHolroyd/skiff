import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { ApiError, CliError } from '../errors.ts';
import { parseArgs, rejectExtraPositionals, type FlagSpec } from '../args.ts';
import { formatBytes, printJson } from '../output.ts';
import { applySpaConfig, buildZip, collectFiles, readEntries } from '../zip.ts';
import {
	buildFunctionBundle,
	type BuiltFunctionBundle,
} from '../function-bundle.ts';
import {
	findWranglerConfig,
	resolveWranglerConfig,
	type WranglerConfig,
} from '../wrangler.ts';
import type {
	ApiClient,
	FinalizeOutcome,
	ProjectView,
	SecretView,
} from '../api.ts';
import {
	assertProjectSlug,
	authenticatedClient,
	printOutcome,
	printProgress,
	slugifyProjectName,
} from './common.ts';

/** The API surface `deploy` needs; tests inject a fake that satisfies it. */
export type DeployClient = Pick<
	ApiClient,
	| 'getProject'
	| 'createProject'
	| 'listSecrets'
	| 'createUpload'
	| 'putUpload'
	| 'finalizeUpload'
	| 'deployCompose'
>;

/** Compose file names Yoal looks for, in order, when `--compose` is not given. */
const COMPOSE_FILE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'] as const;

async function findComposeFile(dir: string): Promise<string | null> {
	for (const name of COMPOSE_FILE_NAMES) {
		const path = join(dir, name);
		try {
			await readFile(path);
			return path;
		} catch {
			// Try the next conventional name.
		}
	}
	return null;
}

export interface DeployCommandDeps {
	client?: DeployClient;
	log?: (message: string) => void;
}

const flags: FlagSpec = {
	project: { type: 'string', short: 'p' },
	name: { type: 'string', short: 'n' },
	promote: { type: 'boolean', default: true },
	message: { type: 'string', short: 'm' },
	spa: { type: 'boolean' },
	json: { type: 'boolean' },
	create: { type: 'boolean', default: true },
	wrangler: { type: 'string' },
	'no-wrangler': { type: 'boolean' },
	compose: { type: 'string' },
	'no-compose': { type: 'boolean' },
	'wrangler-bin': { type: 'string' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: yoal deploy [dir] [options]

Zip a directory and deploy it to Yoal.

If the directory contains wrangler.jsonc (or wrangler.json), Yoal treats it as a Functions
project (docs/FUNCTIONS.md): the Worker named by "main" is bundled with Yoal's own bundler
(esbuild, pinned in this CLI; Wrangler is not needed), and the generated bundle is deployed.
Otherwise the directory is deployed as a static site, exactly as before.

Options:
  -p, --project <slug>   Target project (default: derived from --name or the directory)
  -n, --name <name>      Project name, used when creating a missing project
      --no-promote       Create a preview only, do not move production
  -m, --message <text>   Deployment message
      --spa              Set "spa": true in the deployed yoal.json (static sites)
      --no-create        Fail if the project does not exist
      --wrangler <path>  Use this wrangler config instead of auto-detecting one
      --no-wrangler      Deploy the plain directory even if a wrangler config exists
      --compose <path>   Deploy this docker-compose file (level 4)
      --no-compose       Deploy the directory even if a compose file exists
      --json             Print the finalize response as JSON
  -h, --help             Show this help

Sign in first with \`yoal login\` (opens the browser), or set YOAL_URL and YOAL_TOKEN in CI.
Run the Worker locally with \`yoal wrangler dev\` (installs Wrangler for local development only).`;

export async function deployCommand(
	argv: string[],
	deps: DeployCommandDeps = {},
): Promise<void> {
	const log = deps.log ?? printProgress;
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, usage);

	const dirInput = args.positionals[0] ?? '.';
	const dir = resolve(dirInput);
	const name = args.string('name');
	const projectFlag = args.string('project');
	const slug = projectFlag ?? slugifyProjectName(name ?? basename(dir));
	assertProjectSlug(slug);

	const promote = args.boolean('promote');
	const message = args.string('message');
	const create = args.boolean('create');
	const json = args.boolean('json');
	const noWrangler = args.boolean('no-wrangler');
	const wranglerBin = args.string('wrangler-bin');
	const wranglerFlag = args.string('wrangler');

	if (noWrangler && wranglerFlag)
		throw new CliError('--no-wrangler cannot be combined with --wrangler.', { code: 'usage' });
	if (wranglerBin)
		log('Note: --wrangler-bin is ignored; yoal deploy bundles with its own pinned bundler, not Wrangler.');

	let wranglerConfig: WranglerConfig | null = null;
	if (wranglerFlag) {
		log(`Using wrangler config ${wranglerFlag}...`);
		wranglerConfig = await resolveWranglerConfig(wranglerFlag);
	} else if (!noWrangler) {
		wranglerConfig = await findWranglerConfig(dir);
	}
	if (wranglerConfig)
		log(`Detected ${wranglerConfig.path}; deploying as a function.`);

	// A compose file in the directory is a level-4 deploy. Wrangler wins when both exist so a
	// Functions project that happens to vendor a compose file keeps its old behaviour.
	const composeFlag = args.string('compose');
	const composePath =
		composeFlag !== undefined
			? resolve(composeFlag)
			: !wranglerConfig && !args.boolean('no-compose')
				? await findComposeFile(dir)
				: null;
	if (composePath) log(`Detected ${basename(composePath)}; deploying as a compose stack.`);
	if (composePath && wranglerConfig)
		throw new CliError('A compose file and a wrangler config were both found; pass --no-compose or --no-wrangler.', {
			code: 'usage',
		});

	const client = deps.client ?? (await authenticatedClient());
	let project = await findProject(client, slug);

	if (wranglerConfig && project?.runtime && project.runtime !== 'function')
		throw new CliError(
			`Project "${slug}" uses runtime "${project.runtime}", but ${basename(wranglerConfig.path)} is a Functions project. Use a project created with runtime "function" (or create a new one).`,
			{ code: 'runtime_mismatch' },
		);
	if (composePath && project?.runtime && project.runtime !== 'compose')
		throw new CliError(
			`Project "${slug}" uses runtime "${project.runtime}", but ${basename(composePath)} is a compose stack. Use a project created with runtime "compose" (or create a new one).`,
			{ code: 'runtime_mismatch' },
		);
	if (!composePath && !wranglerConfig && project?.runtime === 'compose')
		throw new CliError(
			`Project "${slug}" is a compose stack, but no compose file was found. Pass --compose <path> or run from the directory containing docker-compose.yml.`,
			{ code: 'runtime_mismatch' },
		);

	if (!project) {
		if (!create)
			throw new CliError(
				`Project "${slug}" does not exist. Create it in the dashboard or re-run without --no-create.`,
				{ code: 'project_missing' },
			);
		log(`Creating project ${slug}...`);
		try {
			const created = await client.createProject({
				slug,
				name,
				productionAccess: 'public',
				previewAccess: 'platform',
				...(composePath
					? { runtime: 'compose' as const }
					: wranglerConfig
						? { runtime: 'function' as const }
						: {}),
			});
			project = created.project;
			log(`Created project ${project.slug}.`);
		} catch (error) {
			// A concurrent deploy may have created it between our GET and POST.
			if (error instanceof ApiError && error.status === 409 && error.suggestions.length === 0) {
				const existing = await findProject(client, slug);
				if (!existing) throw error;
				project = existing;
				if (wranglerConfig && project.runtime && project.runtime !== 'function')
					throw new CliError(
						`Project "${slug}" uses runtime "${project.runtime}", but ${basename(wranglerConfig.path)} is a Functions project. Use a project created with runtime "function" (or create a new one).`,
						{ code: 'runtime_mismatch' },
					);
				if (composePath && project.runtime && project.runtime !== 'compose')
					throw new CliError(
						`Project "${slug}" uses runtime "${project.runtime}", but ${basename(composePath)} is a compose stack. Use a project created with runtime "compose" (or create a new one).`,
						{ code: 'runtime_mismatch' },
					);
				log(`Project ${slug} already exists; continuing.`);
			} else {
				throw error;
			}
		}
	}

	if (composePath) {
		const document = await readFile(composePath, 'utf8');
		log('Deploying compose stack...');
		const result = await client.deployCompose(slug, { document, promote, message });
		if (json) {
			printJson(result.raw);
			return;
		}
		log(`Deployed ${slug} (${result.deployment.previewUrl}).`);
		return;
	}

	let bundle: BuiltFunctionBundle | null = null;
	let outcome: FinalizeOutcome | undefined;
	try {
		let sourceDir = dir;
		if (wranglerConfig) {
			const projectSecrets = await projectSecretNames(client, project, log);
			bundle = await buildFunctionBundle({
				config: wranglerConfig,
				log,
				projectSecrets,
			});
			for (const warning of bundle.warnings.slice(0, 5)) log(`Note: ${warning}`);
			if (bundle.warnings.length > 5)
				log(`Note: ${bundle.warnings.length - 5} more skipped asset entries.`);
			log(
				`Bundle: ${bundle.moduleCount} module(s), ${bundle.assetCount} asset file(s) (${formatBytes(bundle.assetBytes)} assets).`,
			);
			sourceDir = bundle.dir;
			if (args.boolean('spa'))
				log('Note: --spa applies to static sites; functions use assets.run_worker_first instead.');
		}

		log(
			sourceDir === dir
				? `Zipping ${dirInput === '.' ? 'current directory' : dirInput}...`
				: 'Zipping the generated bundle...',
		);
		const collected = await collectFiles(sourceDir);
		for (const warning of collected.warnings.slice(0, 5)) log(`Note: ${warning}`);
		if (collected.warnings.length > 5)
			log(`Note: ${collected.warnings.length - 5} more skipped entries.`);

		let entries = await readEntries(collected.files);
		if (!wranglerConfig && project?.runtime === 'function') {
			// The control plane can infer a manifest for an already-built Worker, but not for a
			// source tree with no Wrangler config. Fail with the fix instead of a server 422.
			const hasModule = entries.some((entry) => /\.(?:js|mjs|cjs|wasm)$/i.test(entry.path));
			if (!hasModule)
				throw new CliError(
					'This is a function project, but no wrangler.jsonc was found and the directory has no built Worker module. Run yoal deploy from the project root (or pass --wrangler <path>).',
					{ code: 'function_bundle_missing' },
				);
			log('No wrangler config found; uploading the directory as a prebuilt function bundle.');
		}
		if (!wranglerConfig && args.boolean('spa')) entries = applySpaConfig(entries);
		const zip = buildZip(entries);
		const fileCount = entries.length;
		const totalBytes = entries.reduce((sum, entry) => sum + entry.data.byteLength, 0);
		log(
			`Package: ${formatBytes(totalBytes)} in ${fileCount} files (${formatBytes(zip.byteLength)} zipped).`,
		);

		const ticket = await client.createUpload({ project: slug, fileCount, totalBytes });
		log(`Uploading ${formatBytes(zip.byteLength)}...`);
		await client.putUpload(ticket, zip);

		log('Finalizing deployment...');
		outcome = await client.finalizeUpload(ticket.uploadId, {
			project: slug,
			promote,
			message,
		});
	} finally {
		if (bundle) await bundle.cleanup().catch(() => {});
	}

	if (!outcome) return;
	if (json) {
		printJson(outcome.raw);
		return;
	}
	printOutcome(outcome, slug);
}

async function findProject(client: DeployClient, slug: string): Promise<ProjectView | null> {
	try {
		const { project } = await client.getProject(slug);
		return project;
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) return null;
		throw error;
	}
}

/**
 * Names of secrets scoped to this project. Organisation-scoped secrets are deliberately never
 * auto-bound: they are not this project's to expose. The manifest can still reference them with
 * an explicit `yoal.secrets` entry.
 */
async function projectSecretNames(
	client: DeployClient,
	project: ProjectView,
	log: (message: string) => void,
): Promise<string[]> {
	if (!project.id) {
		log(
			'Note: the platform did not return a project id, so project secrets were not bound automatically. Declare them with yoal.secrets if needed.',
		);
		return [];
	}
	let secrets: SecretView[];
	try {
		secrets = (await client.listSecrets()).secrets;
	} catch (error) {
		log(
			`Note: could not list project secrets (${messageOf(error)}); declare them with yoal.secrets if needed.`,
		);
		return [];
	}
	return secrets
		.filter((secret) => secret.projectId === project.id && typeof secret.name === 'string')
		.map((secret) => secret.name);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
