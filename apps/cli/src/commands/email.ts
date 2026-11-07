import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec, type ParsedArgs } from '../args.ts';
import { assertEnvPrefix } from '../databases.ts';
import {
	DEFAULT_EMAIL_ENV_PREFIX,
	EMAIL_MAX_RECIPIENTS,
	MANUAL_SUPPRESSION_REASONS,
	emailCredentialSecretDetails,
	emailCredentialTable,
	emailDomainDetails,
	emailDomainTable,
	emailEnvNames,
	emailMessageDetails,
	emailMessageLine,
	emailMessageTable,
	emailRecordsTable,
	emailStatusReport,
	emailSuppressionTable,
	failingRecords,
	parseAddressList,
	parseTags,
	takeNewMessages,
	type EmailCredentialCreateInput,
	type EmailDomainCreateInput,
	type EmailSendInput,
} from '../email.ts';
import { UsageError } from '../errors.ts';
import { indent, plural, printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/** Email, Skiff's self-hosted SES (docs/EMAIL.md §9). Every check lives on the server; this is a thin client. */

const usage = `Usage: skif email <command> [options]

Commands:
  status                           Org state, limits, sent today, bounce and complaint rates (the default)
  domains list                     Sending domains and how many of their DNS records check out
  domains add <name>               Add a domain and print the DNS records to create (--no-auto-dns, --no-sending)
  domains info <name>              A domain's DNS records, with what public DNS returns
  domains check <name>             Re-check the domain's DNS records now
  domains rm <name>                Remove a domain; mail from it is refused straight away
  send                             Send a message (--from, --to, --subject, --text|--text-file, --html-file)
  log                              Recent messages, newest first (--follow to keep watching)
  log <messageId>                  One message: each recipient's status and delivery timeline
  suppressions list                Addresses Skiff won't send to (--address to look one up)
  suppressions add <address>       Suppress an address (--reason manual|unsubscribe)
  suppressions rm <address>        Allow sending to an address again
  credentials list                 SMTP credentials (passwords are never shown again)
  credentials create <name>        Create an SMTP credential (--project <slug>, --from <domain>…)
  credentials revoke <id>          Revoke a credential; apps using it stop sending
  attach -p <project>              Inject SMTP credentials into a project (<PREFIX>_HOST, _USER, …)
  detach -p <project>              Remove them; the credential is revoked

Send options:
      --from <address>             Sender, on a verified sending domain (required)
      --to <address>[,…]           Recipients; repeat or separate with commas
      --cc <address>[,…]           Copy recipients
      --bcc <address>[,…]          Blind copy recipients
      --subject <text>             Subject (required)
      --text <text>                Plain-text body
      --text-file <path>           Plain-text body from a file
      --html-file <path>           HTML body from a file
      --tag <key=value>            Tag echoed in events and webhooks; repeat for more (at most 10)

Log options:
      --limit <n>                  How many messages (default 50, at most 200)
      --recipient <address>        Only messages to this address
      --status <status>            Only messages in this state (accepted, delivered, deferred, bounced, …)
  -f, --follow                     Poll every few seconds and print new messages and status changes

Options:
  -p, --project <slug>             The project (attach, detach, credentials create)
      --prefix <PREFIX>            Env prefix for attach/detach (default SMTP)
  -y, --yes                        Don't ask for confirmation (required when stdin isn't a terminal)
      --json                       JSON output
  -h, --help                       Show this help

New organisations start in the sandbox: they can only send to their own verified domains and
addresses, 200 messages a day. A platform admin activates the org for wider sending.

Examples:
  skif email domains add example.com             # prints the DKIM, SPF and DMARC records
  skif email domains check example.com
  skif email send --from hi@example.com --to you@example.com --subject Hello --text "It works"
  skif email attach --project api                # api receives SMTP_HOST, SMTP_USER, …
  skif email log --follow`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };
const domainAddFlags: FlagSpec = { ...baseFlags, 'auto-dns': { type: 'boolean' }, sending: { type: 'boolean' } };
const sendFlags: FlagSpec = {
	...baseFlags,
	from: { type: 'string' },
	to: { type: 'string', multiple: true },
	cc: { type: 'string', multiple: true },
	bcc: { type: 'string', multiple: true },
	subject: { type: 'string' },
	text: { type: 'string' },
	'text-file': { type: 'string' },
	'html-file': { type: 'string' },
	tag: { type: 'string', multiple: true },
};
const logFlags: FlagSpec = {
	...baseFlags,
	limit: { type: 'string' },
	recipient: { type: 'string' },
	status: { type: 'string' },
	follow: { type: 'boolean', short: 'f' },
};
const suppressionListFlags: FlagSpec = { ...baseFlags, address: { type: 'string' }, limit: { type: 'string' } };
const suppressionAddFlags: FlagSpec = { ...baseFlags, reason: { type: 'string' } };
const credentialCreateFlags: FlagSpec = {
	...baseFlags,
	project: { type: 'string', short: 'p' },
	from: { type: 'string', multiple: true },
};
const attachFlags: FlagSpec = { ...baseFlags, project: { type: 'string', short: 'p' }, prefix: { type: 'string' } };

/** How often `skif email log --follow` polls. */
const FOLLOW_INTERVAL_MS = 3_000;

type Handler = (argv: string[]) => Promise<void>;

const domainCommands: Record<string, Handler> = {
	list: listDomains,
	ls: listDomains,
	add: addDomain,
	create: addDomain,
	info: showDomain,
	show: showDomain,
	check: checkDomain,
	rm: removeDomain,
	delete: removeDomain,
};

const suppressionCommands: Record<string, Handler> = {
	list: listSuppressions,
	ls: listSuppressions,
	add: addSuppression,
	rm: removeSuppression,
	remove: removeSuppression,
	delete: removeSuppression,
};

const credentialCommands: Record<string, Handler> = {
	list: listCredentials,
	ls: listCredentials,
	create: createCredential,
	revoke: revokeCredential,
	rm: revokeCredential,
	delete: revokeCredential,
};

const subcommands: Record<string, Handler> = {
	status: emailStatus,
	domains: group('domains', domainCommands, listDomains),
	domain: group('domains', domainCommands, listDomains),
	send: sendEmail,
	log: emailLog,
	logs: emailLog,
	suppressions: group('suppressions', suppressionCommands, listSuppressions),
	suppression: group('suppressions', suppressionCommands, listSuppressions),
	credentials: group('credentials', credentialCommands, listCredentials),
	creds: group('credentials', credentialCommands, listCredentials),
	attach: attachEmail,
	detach: detachEmail,
};

export async function emailCommand(argv: string[]): Promise<void> {
	await dispatch(argv, subcommands, emailStatus, 'email');
}

function group(name: string, commands: Record<string, Handler>, fallback: Handler): Handler {
	return (argv) => dispatch(argv, commands, fallback, `email ${name}`);
}

async function dispatch(argv: string[], commands: Record<string, Handler>, fallback: Handler, name: string): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = commands[first];
		if (!handler) throw new UsageError(`Unknown ${name} command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await fallback(argv);
}

/** Parse and handle --help; null means help was printed. */
function parse(argv: string[], spec: FlagSpec, line: string, maxPositionals: number): ParsedArgs | null {
	const args = parseArgs(argv, spec);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	rejectExtraPositionals(args, maxPositionals, line);
	return args;
}

/** Parse, handle --help, and return the single positional (`<name>`, `<address>`, `<id>`). */
function parseNamed(argv: string[], spec: FlagSpec, command: string, what: string) {
	const line = `Usage: skif email ${command} <${what}>`;
	const args = parse(argv, spec, line, 1);
	if (!args) return null;
	return { args, name: requirePositional(args, 0, `${what}.\n\n${line}`) };
}

function parseLimit(value: string | undefined, max: number): number | undefined {
	if (value === undefined) return undefined;
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1 || limit > max)
		throw new UsageError(`--limit must be a whole number between 1 and ${max}.`);
	return limit;
}

async function readBody(path: string, flag: string): Promise<string> {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		throw new UsageError(`Could not read ${flag} ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// ------------------------------------------------------------------------------------------ status

async function emailStatus(argv: string[]): Promise<void> {
	const args = parse(argv, baseFlags, 'Usage: skif email status [--json]', 0);
	if (!args) return;
	const client = await authenticatedClient();
	const { org, settings, raw } = await client.emailStatus();
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(emailStatusReport(org, settings));
}

// ----------------------------------------------------------------------------------------- domains

async function listDomains(argv: string[]): Promise<void> {
	const args = parse(argv, baseFlags, 'Usage: skif email domains list [--json]', 0);
	if (!args) return;
	const client = await authenticatedClient();
	const { domains, raw } = await client.listEmailDomains();
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (domains.length === 0) {
		console.log('No sending domains yet. Add one with `skif email domains add <domain>`.');
		return;
	}
	console.log(emailDomainTable(domains));
}

async function addDomain(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, domainAddFlags, 'domains add', 'domain');
	if (!parsed) return;
	const { args, name } = parsed;
	const input: EmailDomainCreateInput = { name };
	if (args.has('sending')) input.sending = args.boolean('sending');
	if (args.has('auto-dns')) input.autoDns = args.boolean('auto-dns');
	const client = await authenticatedClient();
	const { domain, raw } = await client.createEmailDomain(input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Added ${domain.name} (${domain.status}).`);
	const managed = domain.records.filter((record) => record.managed);
	const toCreate = domain.records.filter((record) => !record.managed);
	if (managed.length > 0)
		console.log(`Skiff created ${plural(managed.length, 'record')} through Cloudflare: ${managed.map((record) => record.purpose.toUpperCase()).join(', ')}.`);
	if (toCreate.length > 0) {
		console.log('\nCreate these records at your DNS provider:\n');
		console.log(emailRecordsTable(toCreate));
	}
	console.log(`\nNext steps:\n${indent([
		`Check DNS:  skif email domains check ${domain.name}   (public DNS can take a few minutes)`,
		`Send:       skif email send --from hello@${domain.name} --to <address> --subject <text> --text <text>`,
	])}`);
}

async function showDomain(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'domains info', 'domain');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { domain, raw } = await client.getEmailDomain(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(emailDomainDetails(domain));
}

async function checkDomain(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'domains check', 'domain');
	if (!parsed) return;
	const { args, name } = parsed;
	const client = await authenticatedClient();
	const { domain, raw } = await client.checkEmailDomain(name);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const required = domain.records.filter((record) => record.required);
	const ok = required.filter((record) => record.ok).length;
	console.log(`${domain.name} is ${domain.status}: ${ok} of ${plural(required.length, 'required record')} check out.\n`);
	console.log(emailRecordsTable(domain.records));
	const failing = failingRecords(domain.records);
	if (failing.length > 0) console.log(`\nNot matching yet:\n${indent(failing)}`);
}

async function removeDomain(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'domains rm', 'domain');
	if (!parsed) return;
	const { args, name } = parsed;
	const confirmed = await confirmOrRefuse(
		`Remove sending domain "${name}"? Mail from it is refused straight away and its DKIM key is deleted. [y/N] `,
		{
			yes: args.boolean('yes'),
			accept: (answer) => /^y(es)?$/i.test(answer),
			refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before removing "${name}".`,
		},
	);
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const client = await authenticatedClient();
	const raw = await client.deleteEmailDomain(name);
	if (args.boolean('json')) {
		printJson(raw ?? { ok: true });
		return;
	}
	console.log(`Removed ${name}. Records Skiff created through Cloudflare are deleted; remove any you added by hand.`);
}

// -------------------------------------------------------------------------------------------- send

async function sendEmail(argv: string[]): Promise<void> {
	const args = parse(argv, sendFlags, 'Usage: skif email send --from <address> --to <address> --subject <text> --text <text>', 0);
	if (!args) return;
	const from = args.string('from');
	if (!from) throw new UsageError('Name the sender: --from <address> (on a verified sending domain).');
	const to = parseAddressList(args.strings('to'));
	const cc = parseAddressList(args.strings('cc'));
	const bcc = parseAddressList(args.strings('bcc'));
	if (to.length + cc.length + bcc.length === 0) throw new UsageError('Add at least one recipient with --to, --cc or --bcc.');
	if (to.length + cc.length + bcc.length > EMAIL_MAX_RECIPIENTS)
		throw new UsageError(`At most ${EMAIL_MAX_RECIPIENTS} recipients per message.`);
	const subject = args.string('subject');
	if (subject === undefined) throw new UsageError('Give a subject: --subject <text>.');
	if (args.has('text') && args.has('text-file')) throw new UsageError('Use --text or --text-file, not both.');
	const textFile = args.string('text-file');
	const htmlFile = args.string('html-file');
	const text = textFile ? await readBody(textFile, '--text-file') : args.string('text');
	const html = htmlFile ? await readBody(htmlFile, '--html-file') : undefined;
	if (text === undefined && html === undefined)
		throw new UsageError('Give a body: --text, --text-file or --html-file.');

	const input: EmailSendInput = { from, to, subject };
	if (cc.length) input.cc = cc;
	if (bcc.length) input.bcc = bcc;
	if (text !== undefined) input.text = text;
	if (html !== undefined) input.html = html;
	const tags = parseTags(args.strings('tag'));
	if (Object.keys(tags).length) input.tags = tags;

	const client = await authenticatedClient();
	const { result, raw } = await client.sendEmail(input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Queued ${result.id} for ${plural(result.accepted.length, 'recipient')}${result.accepted.length ? `: ${result.accepted.join(', ')}` : ''}.`);
	if (result.suppressed.length > 0)
		console.log(`Not sent to ${result.suppressed.join(', ')}: on the suppression list (\`skif email suppressions list\`).`);
	console.log(`Follow it: skif email log ${result.id}`);
}

// --------------------------------------------------------------------------------------------- log

async function emailLog(argv: string[]): Promise<void> {
	const args = parse(argv, logFlags, 'Usage: skif email log [<messageId>] [--limit n] [--recipient address] [--status s] [--follow]', 1);
	if (!args) return;
	const client = await authenticatedClient();
	const id = args.positionals[0];
	if (id) {
		if (args.boolean('follow') || args.has('limit') || args.has('recipient') || args.has('status'))
			throw new UsageError('`skif email log <messageId>` shows one message; drop --follow, --limit, --recipient and --status.');
		const { message, events, raw } = await client.getEmailMessage(id);
		if (args.boolean('json')) {
			printJson(raw);
			return;
		}
		console.log(emailMessageDetails(message, events));
		return;
	}

	const options = {
		limit: parseLimit(args.string('limit'), 200) ?? 50,
		...(args.string('recipient') ? { recipient: args.string('recipient') } : {}),
		...(args.string('status') ? { status: args.string('status') } : {}),
	};
	const json = args.boolean('json');
	if (!args.boolean('follow')) {
		const { messages, raw } = await client.listEmailMessages(options);
		if (json) {
			printJson(raw);
			return;
		}
		if (messages.length === 0) {
			console.log('No messages yet. Send one with `skif email send`.');
			return;
		}
		console.log(emailMessageTable(messages));
		return;
	}

	// Follow: every poll fetches the newest page and prints what's new or changed, oldest first.
	// JSON mode prints one message per line so the output can be piped.
	const seen = new Map<string, string>();
	if (!json) process.stderr.write('Following new messages (Ctrl-C to stop)…\n');
	for (;;) {
		const { messages } = await client.listEmailMessages(options);
		for (const message of takeNewMessages(messages, seen))
			console.log(json ? JSON.stringify(message) : emailMessageLine(message));
		await sleep(FOLLOW_INTERVAL_MS);
	}
}

// ------------------------------------------------------------------------------------ suppressions

async function listSuppressions(argv: string[]): Promise<void> {
	const args = parse(argv, suppressionListFlags, 'Usage: skif email suppressions list [--address a] [--limit n] [--json]', 0);
	if (!args) return;
	const client = await authenticatedClient();
	const { suppressions, raw } = await client.listEmailSuppressions({
		...(args.string('address') ? { address: args.string('address') } : {}),
		...(args.has('limit') ? { limit: parseLimit(args.string('limit'), 1000) } : {}),
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (suppressions.length === 0) {
		console.log(args.string('address') ? `${args.string('address')} is not suppressed.` : 'No suppressed addresses.');
		return;
	}
	console.log(emailSuppressionTable(suppressions));
}

async function addSuppression(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, suppressionAddFlags, 'suppressions add', 'address');
	if (!parsed) return;
	const { args, name: address } = parsed;
	const reason = args.string('reason');
	if (reason !== undefined && !(MANUAL_SUPPRESSION_REASONS as readonly string[]).includes(reason))
		throw new UsageError(`--reason must be ${MANUAL_SUPPRESSION_REASONS.join(' or ')}.`);
	const client = await authenticatedClient();
	const { suppression, raw } = await client.addEmailSuppression({ address, ...(reason ? { reason } : {}) });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Suppressed ${suppression.address} (${suppression.reason}). Skiff won't send to it until it is removed.`);
}

async function removeSuppression(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, baseFlags, 'suppressions rm', 'address');
	if (!parsed) return;
	const { args, name: address } = parsed;
	const client = await authenticatedClient();
	const raw = await client.removeEmailSuppression(address);
	if (args.boolean('json')) {
		printJson(raw ?? { ok: true });
		return;
	}
	console.log(`Removed ${address} from the suppression list. If it bounces again it is suppressed again.`);
}

// ------------------------------------------------------------------------------------- credentials

async function listCredentials(argv: string[]): Promise<void> {
	const args = parse(argv, baseFlags, 'Usage: skif email credentials list [--json]', 0);
	if (!args) return;
	const client = await authenticatedClient();
	const { credentials, raw } = await client.listEmailCredentials();
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (credentials.length === 0) {
		console.log('No SMTP credentials yet. Create one with `skif email credentials create <name>`.');
		return;
	}
	console.log(emailCredentialTable(credentials));
}

async function createCredential(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, credentialCreateFlags, 'credentials create', 'name');
	if (!parsed) return;
	const { args, name } = parsed;
	const input: EmailCredentialCreateInput = { name };
	const project = args.string('project');
	if (project) input.project = project;
	const from = parseAddressList(args.strings('from'));
	if (from.length) input.allowedFromDomains = from;
	const client = await authenticatedClient();
	const { credential, raw } = await client.createEmailCredential(input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(emailCredentialSecretDetails(credential));
}

async function revokeCredential(argv: string[]): Promise<void> {
	const parsed = parseNamed(argv, confirmFlags, 'credentials revoke', 'id');
	if (!parsed) return;
	const { args, name: id } = parsed;
	const confirmed = await confirmOrRefuse(`Revoke credential ${id}? Apps using it can no longer send. [y/N] `, {
		yes: args.boolean('yes'),
		accept: (answer) => /^y(es)?$/i.test(answer),
		refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before revoking ${id}.`,
	});
	if (!confirmed) {
		console.error('Cancelled. Nothing was changed.');
		process.exitCode = 1;
		return;
	}
	const client = await authenticatedClient();
	const raw = await client.revokeEmailCredential(id);
	if (args.boolean('json')) {
		printJson(raw ?? { ok: true });
		return;
	}
	console.log(`Revoked ${id}.`);
}

// ----------------------------------------------------------------------------------- attach/detach

function projectAndPrefix(args: ParsedArgs, command: string): { project: string; prefix: string | undefined } {
	const project = args.string('project');
	if (!project) throw new UsageError(`Name the project: skif email ${command} --project <slug>`);
	const prefix = args.string('prefix');
	if (prefix !== undefined) assertEnvPrefix(prefix);
	return { project, prefix };
}

async function attachEmail(argv: string[]): Promise<void> {
	const args = parse(argv, attachFlags, 'Usage: skif email attach --project <slug> [--prefix SMTP]', 0);
	if (!args) return;
	const { project, prefix } = projectAndPrefix(args, 'attach');
	const client = await authenticatedClient();
	const result = await client.attachEmail(project, prefix ? { envPrefix: prefix } : {});
	if (args.boolean('json')) {
		printJson(result.raw);
		return;
	}
	const envPrefix = result.envPrefix ?? prefix ?? DEFAULT_EMAIL_ENV_PREFIX;
	const envNames = result.envNames.length ? result.envNames : emailEnvNames(envPrefix);
	console.log(`Attached email to ${project} as ${envPrefix}: it receives ${envNames.join(', ')} at its next activation.`);
	if (result.warning) console.log(`Note: ${result.warning}`);
}

async function detachEmail(argv: string[]): Promise<void> {
	const args = parse(argv, attachFlags, 'Usage: skif email detach --project <slug> [--prefix SMTP]', 0);
	if (!args) return;
	const { project, prefix } = projectAndPrefix(args, 'detach');
	const client = await authenticatedClient();
	const raw = await client.detachEmail(project, prefix);
	if (args.boolean('json')) {
		printJson(raw ?? { ok: true });
		return;
	}
	console.log(
		`Detached email (${prefix ?? DEFAULT_EMAIL_ENV_PREFIX}) from ${project}. Its credential is revoked and the app restarts without the variables.`,
	);
}
