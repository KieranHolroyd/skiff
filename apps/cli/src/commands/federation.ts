import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import type { ApiClient } from '../api.ts';
import { CliError, UsageError } from '../errors.ts';
import { printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { asRecord, requestJson, stringValue } from './iam.ts';
import { confirmOrRefuse } from './run-operation.ts';
import { fetchServiceAccounts, resolveServiceAccount } from './service-accounts.ts';

/**
 * Federation trusts (docs/IAM.md I17, §7.3, §12). A trust maps an OIDC issuer to a service
 * account; the STS endpoint reads it at exchange time. Every check lives on the server, so this is
 * a thin client over `/api/v1/federation-trusts`.
 */

const usage = `Usage: skif federation <command> [options]

Commands:
  list [list]                  Trusts in this organisation
  create                       Map an issuer to a service account
  delete <id>                  Remove a trust; new exchanges stop immediately

Create options:
      --issuer <url>           The exact OIDC issuer (the token's iss claim)
      --audience <aud>         An accepted audience; repeat or comma-separate (at least one)
      --subject <glob>         Subject pattern: * within a segment, ** across (default: any)
      --service-account <name|id>  The account whose bindings exchanges carry
      --claim <key=value>      Require a claim; repeat for each (value may be JSON)
      --ttl <duration>         Maximum minted token lifetime, at most 1h (default: 15m)
      --permission <p>         Permission ceiling; repeat or comma-separate
      --resource <r>           Resource ceiling (type:id or type:*); repeat or comma-separate

Options:
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help

A trust with no permission ceiling uses the service account's bindings as its ceiling. A trust
never widens the account: the exchange can only narrow with restriction and the caller's scope.

Examples:
  skif federation create --issuer https://token.actions.githubusercontent.com \\
    --audience https://control.example.com --subject 'repo:acme/web:ref:refs/heads/main' \\
    --service-account github-actions --claim ref=refs/heads/main --ttl 15m
  skif federation list
  skif federation delete ft_abc123`;

export interface FederationTrustView {
	id: string;
	orgId: string;
	serviceAccountId: string;
	issuer: string;
	audiences: string[];
	subjectPattern: string;
	claimConditions: Record<string, unknown>;
	maxTtlSeconds: number;
	restriction: { permissions?: string[]; resources?: string[] };
}

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };
const createFlags: FlagSpec = {
	...baseFlags,
	issuer: { type: 'string' },
	audience: { type: 'string', multiple: true },
	subject: { type: 'string' },
	'service-account': { type: 'string' },
	claim: { type: 'string', multiple: true },
	ttl: { type: 'string' },
	permission: { type: 'string', multiple: true },
	resource: { type: 'string', multiple: true },
};

export async function federationCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first === 'help' || first === '--help' || first === '-h') {
		console.log(usage);
		return;
	}
	if (first.startsWith('-')) throw new UsageError(`Unknown option ${first}.\n\n${usage}`);
	switch (first) {
		case 'list':
		case 'ls':
			return listTrusts(argv.slice(1));
		case 'create':
		case 'add':
			return createTrust(argv.slice(1));
		case 'delete':
		case 'rm':
			return deleteTrust(argv.slice(1));
		default:
			throw new UsageError(`Unknown federation command "${first}".\n\n${usage}`);
	}
}

async function listTrusts(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif federation [list] [--json]');
	const client = await authenticatedClient();
	const trusts = await fetchTrusts(client);
	if (args.boolean('json')) {
		printJson({ federationTrusts: trusts });
		return;
	}
	if (trusts.length === 0) {
		console.log('No federation trusts. Add one with `skif federation create`.');
		return;
	}
	console.log(federationTable(trusts));
}

async function createTrust(argv: string[]): Promise<void> {
	const args = parseArgs(argv, createFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif federation create --issuer <url> --audience <aud> --service-account <name|id>');
	const issuer = args.string('issuer');
	if (!issuer) throw new UsageError('Say which issuer the trust accepts with --issuer <url>.');
	const audiences = parseList(args.strings('audience'));
	if (audiences.length === 0)
		throw new UsageError('Add at least one --audience, e.g. --audience https://control.example.com.');
	const serviceAccountValue = args.string('service-account');
	if (!serviceAccountValue)
		throw new UsageError('Name the account with --service-account <name|id>.');

	const client = await authenticatedClient();
	const account = resolveServiceAccount(await fetchServiceAccounts(client), serviceAccountValue);
	const body: Record<string, unknown> = {
		serviceAccountId: account.id,
		issuer,
		audiences,
	};
	const subject = args.string('subject');
	if (subject) body.subjectPattern = subject;
	const claims = parseClaimConditions(args.strings('claim'));
	if (Object.keys(claims).length > 0) body.claimConditions = claims;
	const ttl = args.string('ttl');
	if (ttl) body.maxTtlSeconds = parseTtlSeconds(ttl);
	const permissions = args.strings('permission');
	const resources = args.strings('resource');
	if (permissions.length > 0 || resources.length > 0) {
		body.restriction = {
			...(permissions.length > 0 ? { permissions: parseList(permissions) } : {}),
			...(resources.length > 0 ? { resources: parseList(resources) } : {})
		};
	}

	const raw = await requestJson(client, 'POST', '/api/v1/federation-trusts', body);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const trust = asTrust(raw);
	if (!trust)
		throw new CliError('The platform returned an unexpected federation trust response.', {
			code: 'protocol',
			details: raw,
		});
	console.log(`Created federation trust ${trust.id} for ${account.name} (${account.id}).`);
	console.log(`Issuer ${trust.issuer}; subject ${trust.subjectPattern}; max TTL ${trust.maxTtlSeconds}s.`);
}

async function deleteTrust(argv: string[]): Promise<void> {
	const args = parseArgs(argv, confirmFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif federation delete <id> [--yes]');
	const id = requirePositional(args, 0, `federation trust id.\n\n${usage}`);
	const confirmed = await confirmOrRefuse(
		`Delete federation trust ${id}? New exchanges stop at once. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: 'Not deleted. Pass --yes to delete without asking.',
		},
	);
	if (!confirmed) {
		console.log('Cancelled.');
		return;
	}
	const client = await authenticatedClient();
	const raw = await requestJson(
		client,
		'DELETE',
		`/api/v1/federation-trusts/${encodeURIComponent(id)}`,
	);
	if (args.boolean('json')) printJson(raw);
	else console.log(`Deleted federation trust ${id}.`);
}

// ---------------------------------------------------------------- pure helpers

/** `--claim key=value` pairs into a condition object; a value that parses as JSON keeps its type. */
export function parseClaimConditions(values: string[]): Record<string, unknown> {
	const conditions: Record<string, unknown> = {};
	for (const raw of values) {
		const index = raw.indexOf('=');
		if (index <= 0) throw new UsageError(`--claim expects key=value, not "${raw}".`);
		const key = raw.slice(0, index).trim();
		const value = raw.slice(index + 1).trim();
		if (!key) throw new UsageError(`--claim expects key=value, not "${raw}".`);
		conditions[key] = parseClaimValue(value);
	}
	return conditions;
}

function parseClaimValue(value: string): unknown {
	if (value === '') return '';
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

/** A trust caps a token at one hour; reject anything the server would refuse. */
export function parseTtlSeconds(value: string): number {
	const match = /^(\d+)\s*([smh])$/i.exec(value.trim());
	if (!match) throw new UsageError(`--ttl must be a duration like 15m or 1h, not "${value}".`);
	const units: Record<string, number> = { s: 1, m: 60, h: 3600 };
	const seconds = Number(match[1]) * units[match[2]!.toLowerCase()]!;
	if (seconds <= 0) throw new UsageError('--ttl must be positive.');
	if (seconds > 3600) throw new UsageError('A federation trust caps tokens at one hour.');
	return seconds;
}

function parseList(values: string[]): string[] {
	const entries = values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	return [...new Set(entries)];
}

export function federationTable(trusts: FederationTrustView[]): string {
	const rows = trusts.map((trust) => [
		trust.id,
		trust.issuer,
		trust.audiences.join(', '),
		trust.subjectPattern,
		trust.serviceAccountId,
		`${trust.maxTtlSeconds}s`,
	]);
	return renderTable(['ID', 'ISSUER', 'AUDIENCE', 'SUBJECT', 'SERVICE ACCOUNT', 'MAX TTL'], rows);
}

// ---------------------------------------------------------------- wire helpers

async function fetchTrusts(client: ApiClient): Promise<FederationTrustView[]> {
	const record = asRecord(await requestJson(client, 'GET', '/api/v1/federation-trusts'));
	const raw = record?.federationTrusts;
	if (!Array.isArray(raw))
		throw new CliError('The platform returned an unexpected federation trust response.', {
			code: 'protocol',
			details: record,
		});
	return raw.map((entry) => {
		const trust = asTrust(entry);
		if (!trust)
			throw new CliError('The platform returned an unexpected federation trust entry.', {
				code: 'protocol',
				details: entry,
			});
		return trust;
	});
}

function asTrust(value: unknown): FederationTrustView | undefined {
	const record = asRecord(value);
	const id = stringValue(record?.id);
	const issuer = stringValue(record?.issuer);
	const serviceAccountId = stringValue(record?.serviceAccountId);
	if (!record || !id || !issuer || !serviceAccountId) return undefined;
	const restriction = asRecord(record.restriction);
	return {
		id,
		orgId: stringValue(record.orgId) ?? '',
		serviceAccountId,
		issuer,
		audiences: stringArray(record.audiences),
		subjectPattern: stringValue(record.subjectPattern) ?? '*',
		claimConditions: asRecord(record.claimConditions) ?? {},
		maxTtlSeconds: typeof record.maxTtlSeconds === 'number' ? record.maxTtlSeconds : 900,
		restriction: {
			...(Array.isArray(restriction?.permissions)
				? { permissions: stringArray(restriction.permissions) }
				: {}),
			...(Array.isArray(restriction?.resources)
				? { resources: stringArray(restriction.resources) }
				: {})
		}
	};
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
