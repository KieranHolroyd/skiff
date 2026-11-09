import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { parseArgs, rejectExtraPositionals, type FlagSpec } from '../args.ts';
import { defaultExportFileName, exportFormatFor, exportSummary, renderExport } from '../config-export.ts';
import { UsageError } from '../errors.ts';
import { renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';

/** Config export (docs/OPERATIONS.md §13): a read-only snapshot of the org's configuration. */

const usage = `Usage: skif export [options]

Write the organisation's configuration to one file: every project's settings,
environments, domains, workload spec, jobs, volumes and attachments, plus the
managed databases, storage and brokers, IAM, service accounts, access keys,
federation, access policies, user pools and clients, log drains, backup targets,
event and alert rules, email, pipelines, registry logins, forges, shares and
templates.

It is configuration only. No deployments, database rows, objects, logs or pool
users are included, and secrets appear by name, never by value. Each section is
read with your own permissions; anything you cannot read is listed under
\`skipped\` instead of failing the export.

Options:
  -o, --out <file>        Where to write (default skiff-config-<org>-<date>.yaml); - for stdout
      --format <yaml|json>  Output format (default yaml, or json for a .json --out)
  -p, --project <slug>    Only these projects (repeatable or comma-separated);
                          org-level config is still exported
      --force             Overwrite an existing file
  -h, --help              Show this help

Examples:
  skif export
  skif export --out skiff-config.json
  skif export --project shop-web,shop-api --out - | less`;

const flags: FlagSpec = {
	out: { type: 'string', short: 'o' },
	format: { type: 'string' },
	project: { type: 'string', short: 'p', multiple: true },
	force: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

export async function exportCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif export [--out <file>] [--format yaml|json] [--project <slug>]');
	const out = args.string('out');
	let format;
	try {
		format = exportFormatFor(args.string('format'), out);
	} catch (error) {
		throw new UsageError((error as Error).message);
	}
	const projects = args
		.strings('project')
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter(Boolean);

	const client = await authenticatedClient();
	const doc = await client.configExport({ projects });
	const text = renderExport(doc, format);

	if (out === '-') {
		process.stdout.write(text);
		return;
	}
	const path = out ?? defaultExportFileName(doc, format);
	if (existsSync(path) && !args.boolean('force')) throw new UsageError(`${path} already exists. Pass --force to overwrite it.`);
	// Configuration still describes the estate (hosts, names, policies), so keep it private.
	await writeFile(path, text, { mode: 0o600 });

	const summary = exportSummary(doc);
	console.log(`Wrote ${path} (${format}, ${text.length.toLocaleString('en-GB')} bytes)`);
	console.log(renderTable(['SECTION', 'ITEMS'], summary.map((row) => [row.section, row.count])));
	if (doc.skipped.length > 0) {
		console.log(`\nSkipped ${doc.skipped.length} section${doc.skipped.length === 1 ? '' : 's'}:`);
		console.log(renderTable(['SECTION', 'REASON'], doc.skipped.map((skip) => [skip.section, skip.reason])));
	}
}
