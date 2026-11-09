import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import type { ApiClient } from '../api.ts';
import { CliError, UsageError } from '../errors.ts';
import { formatTime, printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { asRecord, requestJson, stringValue } from './iam.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Service accounts (docs/IAM.md I13, §7.2; docs/API.md §Service accounts). An account is an
 * org-owned machine principal with a stable `sa_…` id. Keys are minted with `skif key`. Every
 * check lives on the server; this is a thin client over `/api/v1/service-accounts`.
 */

const usage = `Usage: skif sa <command> [options]

Commands:
  list [list]                  Service accounts, their owner group and whether they are disabled
  create <name>                Create one (--description, --owner-group)
  disable <name|id>            Switch it off; its keys and bindings stay but stop authenticating
  enable <name|id>             Switch it back on
  delete <name|id>             Remove it; refused while a binding still uses it

Options:
      --description <text>     A note shown in the list and dashboard
      --owner-group <id>       The iam group that owns it (grp_…); default: the organisation
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help

A service account is bound to roles like any other principal:
  skif iam bind serviceAccount:<id> deployer --scope project:<id>
Disabling is the normal off-switch; delete only works once nothing is bound to it.

Examples:
  skif sa create ci-bot --description "GitHub Actions"
  skif key create ci --service-account ci-bot --expires 90d
  skif sa disable ci-bot
  skif sa list`;

export interface ServiceAccountView {
	id: string;
	name: string;
	description: string;
	ownerGroupId: string | null;
	disabled: boolean;
	disabledAt: number | null;
	createdBy: string;
	createdAt: number;
}

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };
const createFlags: FlagSpec = {
	...baseFlags,
	description: { type: 'string' },
	'owner-group': { type: 'string' },
};

export async function serviceAccountsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first === 'help' || first === '--help' || first === '-h') {
		console.log(usage);
		return;
	}
	if (first.startsWith('-')) return listServiceAccounts(argv);
	switch (first) {
		case 'list':
		case 'ls':
			return listServiceAccounts(argv.slice(1));
		case 'create':
		case 'add':
			return createServiceAccount(argv.slice(1));
		case 'disable':
		case 'off':
			return setDisabled(argv.slice(1), true);
		case 'enable':
		case 'on':
			return setDisabled(argv.slice(1), false);
		case 'delete':
		case 'rm':
			return deleteServiceAccount(argv.slice(1));
		default:
			throw new UsageError(`Unknown sa command "${first}".\n\n${usage}`);
	}
}

async function listServiceAccounts(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif sa [list] [--json]');
	const client = await authenticatedClient();
	const accounts = await fetchServiceAccounts(client);
	if (args.boolean('json')) {
		printJson({ serviceAccounts: accounts });
		return;
	}
	if (accounts.length === 0) {
		console.log('No service accounts yet. Create one with `skif sa create <name>`.');
		return;
	}
	console.log(serviceAccountTable(accounts));
}

async function createServiceAccount(argv: string[]): Promise<void> {
	const args = parseArgs(argv, createFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif sa create <name> [--description <text>] [--owner-group <id>]');
	const name = requirePositional(args, 0, `service account name.\n\n${usage}`);
	const body: Record<string, unknown> = { name };
	const description = args.string('description');
	if (description) body.description = description;
	const ownerGroupId = args.string('owner-group');
	if (ownerGroupId) body.ownerGroupId = ownerGroupId;
	const client = await authenticatedClient();
	const raw = await requestJson(client, 'POST', '/api/v1/service-accounts', body);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const account = asServiceAccount(raw);
	if (!account)
		throw new CliError('The platform returned an unexpected service account response.', {
			code: 'protocol',
			details: raw,
		});
	console.log(`Created service account "${account.name}" (${account.id}).`);
	console.log(`Bind it with: skif iam bind serviceAccount:${account.id} <role> --scope org`);
	console.log(`Mint a key with: skif key create <name> --service-account ${account.name}`);
}

async function setDisabled(argv: string[], disabled: boolean): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const action = disabled ? 'disable' : 'enable';
	rejectExtraPositionals(args, 1, `Usage: skif sa ${action} <name|id>`);
	const value = requirePositional(args, 0, `service account name or id.\n\n${usage}`);
	const client = await authenticatedClient();
	const account = resolveServiceAccount(await fetchServiceAccounts(client), value);
	const raw = await requestJson(client, 'PATCH', `/api/v1/service-accounts/${encodeURIComponent(account.id)}`, {
		disabled,
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const updated = asServiceAccount(raw) ?? account;
	console.log(
		disabled
			? `Disabled ${updated.name} (${updated.id}). Its keys and bindings stay; they cannot authenticate.`
			: `Enabled ${updated.name} (${updated.id}).`,
	);
}

async function deleteServiceAccount(argv: string[]): Promise<void> {
	const args = parseArgs(argv, confirmFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif sa delete <name|id> [--yes]');
	const value = requirePositional(args, 0, `service account name or id.\n\n${usage}`);
	const client = await authenticatedClient();
	const account = resolveServiceAccount(await fetchServiceAccounts(client), value);
	const confirmed = await confirmOrRefuse(
		`Delete service account ${account.name} (${account.id})? It must not be bound to any role. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: 'Not deleted. Pass --yes to delete without asking.',
		},
	);
	if (!confirmed) {
		console.log('Cancelled.');
		return;
	}
	const raw = await requestJson(
		client,
		'DELETE',
		`/api/v1/service-accounts/${encodeURIComponent(account.id)}`,
	);
	if (args.boolean('json')) printJson(raw);
	else console.log(`Deleted service account ${account.name} (${account.id}).`);
}

// ---------------------------------------------------------------- pure helpers

export function serviceAccountTable(accounts: ServiceAccountView[]): string {
	const rows = accounts.map((account) => [
		account.id,
		account.name,
		account.disabled ? 'disabled' : 'active',
		account.ownerGroupId ?? 'org',
		account.description || '-',
		formatTime(account.createdAt),
	]);
	return renderTable(['ID', 'NAME', 'STATE', 'OWNER', 'DESCRIPTION', 'CREATED'], rows);
}

/** Resolve an account by exact id or name, so both `skif sa disable sa_…` and `… ci-bot` work. */
export function resolveServiceAccount(
	accounts: ServiceAccountView[],
	value: string,
): ServiceAccountView {
	const account =
		accounts.find((entry) => entry.id === value) ?? accounts.find((entry) => entry.name === value);
	if (!account)
		throw new UsageError(`Unknown service account "${value}". Run \`skif sa\` to see them.`);
	return account;
}

// ---------------------------------------------------------------- wire helpers

export async function fetchServiceAccounts(client: ApiClient): Promise<ServiceAccountView[]> {
	const record = asRecord(await requestJson(client, 'GET', '/api/v1/service-accounts'));
	const raw = record?.serviceAccounts;
	if (!Array.isArray(raw))
		throw new CliError('The platform returned an unexpected service account response.', {
			code: 'protocol',
			details: record,
		});
	return raw.map((entry) => {
		const account = asServiceAccount(entry);
		if (!account)
			throw new CliError('The platform returned an unexpected service account entry.', {
				code: 'protocol',
				details: entry,
			});
		return account;
	});
}

function asServiceAccount(value: unknown): ServiceAccountView | undefined {
	const record = asRecord(value);
	const id = stringValue(record?.id);
	const name = stringValue(record?.name);
	if (!record || !id || !name) return undefined;
	return {
		id,
		name,
		description: stringValue(record.description) ?? '',
		ownerGroupId: stringValue(record.ownerGroupId) ?? null,
		disabled: record.disabled === true,
		disabledAt: typeof record.disabledAt === 'number' ? record.disabledAt : null,
		createdBy: stringValue(record.createdBy) ?? '',
		createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
	};
}
