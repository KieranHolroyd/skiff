import { basename, resolve } from 'node:path';
import { ApiError, CliError } from '../errors.ts';
import { parseArgs, rejectExtraPositionals, type FlagSpec } from '../args.ts';
import { formatBytes, printJson } from '../output.ts';
import { applySpaConfig, buildZip, collectFiles, readEntries } from '../zip.ts';
import {
	assertProjectSlug,
	authenticatedClient,
	printOutcome,
	printProgress,
	slugifyProjectName,
} from './common.ts';

const flags: FlagSpec = {
	project: { type: 'string', short: 'p' },
	name: { type: 'string', short: 'n' },
	promote: { type: 'boolean', default: true },
	message: { type: 'string', short: 'm' },
	spa: { type: 'boolean' },
	json: { type: 'boolean' },
	create: { type: 'boolean', default: true },
	help: { type: 'boolean', short: 'h' },
};

const usage = `Usage: skif deploy [dir] [options]

Zip a directory and deploy it to Skiff.

Options:
  -p, --project <slug>   Target project (default: derived from --name or the directory)
  -n, --name <name>      Project name, used when creating a missing project
      --no-promote       Create a preview only, do not move production
  -m, --message <text>   Deployment message
      --spa              Set "spa": true in the deployed skiff.json
      --no-create        Fail if the project does not exist
      --json             Print the finalize response as JSON
  -h, --help             Show this help

Sign in first with \`skif login\` (opens the browser), or set SKIFF_URL and SKIFF_TOKEN in CI.`;

export async function deployCommand(argv: string[]): Promise<void> {
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
	const client = await authenticatedClient();

	let projectExists = false;
	try {
		await client.getProject(slug);
		projectExists = true;
	} catch (error) {
		if (!(error instanceof ApiError) || error.status !== 404) throw error;
	}

	if (!projectExists) {
		if (!create)
			throw new CliError(
				`Project "${slug}" does not exist. Create it in the dashboard or re-run without --no-create.`,
				{ code: 'project_missing' },
			);
		printProgress(`Creating project ${slug}...`);
		try {
			const created = await client.createProject({
				slug,
				name,
				productionAccess: 'public',
				previewAccess: 'platform',
			});
			printProgress(`Created project ${created.project.slug}.`);
		} catch (error) {
			// A concurrent deploy may have created it between our GET and POST.
			if (error instanceof ApiError && error.status === 409 && error.suggestions.length === 0) {
				try {
					await client.getProject(slug);
					printProgress(`Project ${slug} already exists; continuing.`);
				} catch {
					throw error;
				}
			} else {
				throw error;
			}
		}
	}

	printProgress(`Zipping ${dirInput === '.' ? 'current directory' : dirInput}...`);
	const collected = await collectFiles(dir);
	for (const warning of collected.warnings.slice(0, 5)) printProgress(`Note: ${warning}`);
	if (collected.warnings.length > 5)
		printProgress(`Note: ${collected.warnings.length - 5} more skipped entries.`);

	let entries = await readEntries(collected.files);
	if (args.boolean('spa')) entries = applySpaConfig(entries);
	const zip = buildZip(entries);
	const fileCount = entries.length;
	const totalBytes = entries.reduce((sum, entry) => sum + entry.data.byteLength, 0);
	printProgress(
		`Package: ${formatBytes(totalBytes)} in ${fileCount} files (${formatBytes(zip.byteLength)} zipped).`,
	);

	const ticket = await client.createUpload({ project: slug, fileCount, totalBytes });
	printProgress(`Uploading ${formatBytes(zip.byteLength)}...`);
	await client.putUpload(ticket, zip);

	printProgress('Finalizing deployment...');
	const outcome = await client.finalizeUpload(ticket.uploadId, {
		project: slug,
		promote,
		message,
	});

	if (json) {
		printJson(outcome.raw);
		return;
	}
	printOutcome(outcome, slug);
}
