import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { addRecordLines, domainTable, recordLines, type DomainView } from '../domains.ts';
import { CliError, UsageError } from '../errors.ts';
import { formatTime, printJson } from '../output.ts';
import { authenticatedClient, authenticatedContext } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Custom domains (DESIGN §5, D31). Attaching a hostname creates a verification TXT record; the
 * platform issues a certificate once DNS points at Yoal and the TXT record is in place.
 */

const usage = `Usage: yoal domains <command> [options]

Commands:
  list [--project <slug>]      List custom domains (the default)
  add <hostname> -p <project>  Attach a hostname and print the DNS records to create
  check <id|hostname>          Re-read DNS and certificate state
  remove <id|hostname>         Stop serving the hostname (--yes off a terminal)

Options:
  -p, --project <slug>         Project (required for add; narrows list/check/remove)
      --redirect-www           Add the www sibling and redirect it to the apex
  -y, --yes                    Don't ask before removing
      --json                   JSON output
  -h, --help                   Show this help

Examples:
  yoal domains add shop.example.com --project shop
  yoal domains add example.com --project shop --redirect-www
  yoal domains check shop.example.com
  yoal domains remove shop.example.com --yes`;

const baseFlags: FlagSpec = {
	project: { type: 'string', short: 'p' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const addFlags: FlagSpec = {
	...baseFlags,
	'redirect-www': { type: 'boolean' },
};

const removeFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	list: listDomains,
	ls: listDomains,
	add: addDomain,
	create: addDomain,
	check: checkDomain,
	remove: removeDomain,
	rm: removeDomain,
	delete: removeDomain,
};

export async function domainsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown domains command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await listDomains(argv);
}

async function listDomains(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal domains list [--project <slug>] [--json]');
	const client = await authenticatedClient();
	const { domains, raw } = await client.listDomains({ project: args.string('project') });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (domains.length === 0) {
		console.log('No custom domains yet. Add one with `yoal domains add <hostname> --project <slug>`.');
		return;
	}
	console.log(domainTable(domains));
}

async function addDomain(argv: string[]): Promise<void> {
	const args = parseArgs(argv, addFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal domains add <hostname> --project <slug>');
	const hostname = requirePositional(args, 0, 'hostname (for example shop.example.com)');
	const project = args.string('project');
	if (!project) throw new UsageError('Name the project: --project <slug>.');
	const { client, config } = await authenticatedContext();
	const { domain, raw } = await client.createDomain({
		project,
		hostname,
		redirectWww: args.boolean('redirect-www'),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Added ${domain.hostname} to ${project} (${domain.status}).`);
	const contentDomain = config.contentDomain;
	if (contentDomain) {
		const target = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(contentDomain)
			? { type: 'A' as const, value: contentDomain }
			: { type: 'CNAME' as const, value: `${project}.${contentDomain}` };
		console.log('\nCreate these DNS records:');
		console.log(addRecordLines(domain, target).map((line) => `  ${line}`).join('\n'));
	} else if (domain.verification) {
		console.log('\nCreate this DNS record:');
		console.log(`  TXT    ${domain.verification.recordName}  →  ${domain.verification.recordValue}`);
	}
	console.log('\nThen run `yoal domains check <hostname>`; Yoal also re-checks pending domains every 10 minutes.');
}

/** `dmn_…` is an id; anything else is matched against hostnames. */
async function resolveDomain(
	needle: string,
	project: string | undefined,
): Promise<{ client: Awaited<ReturnType<typeof authenticatedClient>>; domain: DomainView }> {
	const client = await authenticatedClient();
	if (/^dmn_/.test(needle)) {
		const { domain } = await client.getDomain(needle);
		return { client, domain };
	}
	const { domains } = await client.listDomains({ project });
	const match = domains.find((domain) => domain.hostname.toLowerCase() === needle.toLowerCase());
	if (!match)
		throw new CliError(`No custom domain "${needle}"${project ? ` in ${project}` : ''}.`, {
			code: 'not_found',
			suggestions: [`Run \`yoal domains list${project ? ` --project ${project}` : ''}\` to see the hostnames.`],
		});
	return { client, domain: match };
}

async function checkDomain(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal domains check <id|hostname> [--project <slug>]');
	const needle = requirePositional(args, 0, 'domain id or hostname');
	const { client, domain } = await resolveDomain(needle, args.string('project'));
	const { check, raw } = await client.checkDomain(domain.id);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`${check.domain.hostname}  ${check.domain.status}${check.detail ? `  ·  ${check.detail}` : ''}`);
	if (check.domain.lastCheckedAt) console.log(`Last checked ${formatTime(check.domain.lastCheckedAt)}`);
	if (check.records.length > 0) {
		console.log('\nRecords:');
		console.log(recordLines(check.records).map((line) => `  ${line}`).join('\n'));
	}
	if (check.domain.lastError) console.log(`\nError: ${check.domain.lastError}`);
	if (check.domain.status === 'active')
		console.log(`\nServing at https://${check.domain.hostname}`);
}

async function removeDomain(argv: string[]): Promise<void> {
	const args = parseArgs(argv, removeFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal domains remove <id|hostname> [--project <slug>] [--yes]');
	const needle = requirePositional(args, 0, 'domain id or hostname');
	const { client, domain } = await resolveDomain(needle, args.string('project'));
	await confirmOrRefuse(
		`Remove ${domain.hostname} from ${domain.projectSlug}? It stops serving and automatic DNS records are deleted. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: 'Confirmation required to remove a domain. Re-run with --yes.',
		},
	);
	const raw = await client.deleteDomain(domain.id);
	if (args.boolean('json')) printJson(raw);
	else console.log(`Removed ${domain.hostname}.`);
}
