import { basename, resolve } from 'node:path';
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
	'getProject' | 'createProject' | 'listSecrets' | 'createUpload' | 'putUpload' | 'finalizeUpload'
>;

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
	'wrangler-bin': { type: 'string' },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: skif deploy [dir] [options]

Zip a directory and deploy it to Skiff.

If the directory contains wrangler.jsonc (or wrangler.json), Skiff treats it as a Functions
project (docs/FUNCTIONS.md): the Worker named by "main" is bundled with Skiff's own bundler
(esbuild, pinned in this CLI; Wrangler is not needed), and the generated bundle is deployed.
Otherwise the directory is deployed as a static site, exactly as before.

Options:
  -p, --project <slug>   Target project (default: derived from --name or the directory)
  -n, --name <name>      Project name, used when creating a missing project
      --no-promote       Create a preview only, do not move production
  -m, --message <text>   Deployment message
      --spa              Set "spa": true in the deployed skiff.json (static sites)
      --no-create        Fail if the project does not exist
      --wrangler <path>  Use this wrangler config instead of auto-detecting one
      --no-wrangler      Deploy the plain directory even if a wrangler config exists
      --json             Print the finalize response as JSON
  -h, --help             Show this help

Sign in first with \`skif login\` (opens the browser), or set SKIFF_URL and SKIFF_TOKEN in CI.
Run the Worker locally with \`skif wrangler dev\` (installs Wrangler for local development only).`;

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
		log('Note: --wrangler-bin is ignored; skif deploy bundles with its own pinned bundler, not Wrangler.');

	let wranglerConfig: WranglerConfig | null = null;
	if (wranglerFlag) {
		log(`Using wrangler config ${wranglerFlag}...`);
		wranglerConfig = await resolveWranglerConfig(wranglerFlag);
	} else if (!noWrangler) {
		wranglerConfig = await findWranglerConfig(dir);
	}
	if (wranglerConfig)
		log(`Detected ${wranglerConfig.path}; deploying as a function.`);

	const client = deps.client ?? (await authenticatedClient());
	let project = await findProject(client, slug);

	if (wranglerConfig && project?.runtime && project.runtime !== 'function')
		throw new CliError(
			`Project "${slug}" uses runtime "${project.runtime}", but ${basename(wranglerConfig.path)} is a Functions project. Use a project created with runtime "function" (or create a new one).`,
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
				...(wranglerConfig ? { runtime: 'function' as const } : {}),
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
				log(`Project ${slug} already exists; continuing.`);
			} else {
				throw error;
			}
		}
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
					'This is a function project, but no wrangler.jsonc was found and the directory has no built Worker module. Run skif deploy from the project root (or pass --wrangler <path>).',
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
 * an explicit `skiff.secrets` entry.
 */
async function projectSecretNames(
	client: DeployClient,
	project: ProjectView,
	log: (message: string) => void,
): Promise<string[]> {
	if (!project.id) {
		log(
			'Note: the platform did not return a project id, so project secrets were not bound automatically. Declare them with skiff.secrets if needed.',
		);
		return [];
	}
	let secrets: SecretView[];
	try {
		secrets = (await client.listSecrets()).secrets;
	} catch (error) {
		log(
			`Note: could not list project secrets (${messageOf(error)}); declare them with skiff.secrets if needed.`,
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
