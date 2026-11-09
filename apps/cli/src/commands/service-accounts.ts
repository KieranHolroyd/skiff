import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import type { ApiClient } from '../api.ts';
import { CliError, UsageError } from '../errors.ts';
import { formatTime, printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { asRecord, parseExpiry, parsePermissions, requestJson, stringValue } from './iam.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * Service accounts (docs/IAM.md I13, §7.2; docs/API.md §Service accounts). An account is an
 * org-owned machine principal with a stable `sa_…` id. Keys are minted with `yoal key` or
 * `yoal sa keys create`, and `yoal sa token` mints a short impersonation token. Every check lives
 * on the server; this is a thin client over `/api/v1/service-accounts`.
 */

const usage = `Usage: yoal sa <command> [options]

Commands:
  list [list]                  Service accounts, their owner group and whether they are disabled
  create <name>                Create one (--description, --owner-group)
  disable <name|id>            Switch it off; its keys and bindings stay but stop authenticating
  enable <name|id>             Switch it back on
  delete <name|id>             Remove it; refused while a binding still uses it
  token <name|id>              Mint a short-lived token for it (at most one hour)
  keys list <name|id>          Its access keys
  keys create <name|id> <key>  Mint a key; the secret is printed once
  keys revoke <key-id>         Revoke one of its keys (--service-account <name|id>)

Options:
      --description <text>     A note shown in the list and dashboard
      --owner-group <id>       The iam group that owns it (grp_…); default: the organisation

Token options:
      --ttl <duration>         30m, 15m or 1h (default: 1h, maximum: 1h)
      --audience <aud>         Token audience (default: the platform origin)

Keys options:
      --service-account <name|id>  The account a key belongs to (revoke)
      --permission <p>         A permission ceiling, e.g. project:read; repeat or comma-separate
      --resource <r>           A resource ceiling (type:id or type:*); repeat or comma-separate
      --expires <when>         90d, 30d or an ISO timestamp (default: 90 days)
      --cidr <cidr>            Allow only these networks; repeat or comma-separate

Global options:
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help

A service account is bound to roles like any other principal:
  yoal iam bind serviceAccount:<id> deployer --scope project:<id>
Disabling is the normal off-switch; delete only works once nothing is bound to it.
An impersonation token carries the account's bindings and is audited; it is not a standing key.

Examples:
  yoal sa create ci-bot --description "GitHub Actions"
  yoal sa token ci-bot --ttl 30m
  yoal sa keys create ci-bot ci --expires 90d
  yoal sa keys list ci-bot
  yoal key create ci --service-account ci-bot --expires 90d
  yoal sa disable ci-bot
  yoal sa list`;

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

export interface ServiceAccountKeyView {
	id: string;
	name: string;
	start: string;
	expiresAt: number | null;
	lastUsedAt: number | null;
	revokedAt: number | null;
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
const tokenFlags: FlagSpec = {
	...baseFlags,
	ttl: { type: 'string' },
	audience: { type: 'string' },
};
const keyCreateFlags: FlagSpec = {
	...baseFlags,
	permission: { type: 'string', multiple: true },
	resource: { type: 'string', multiple: true },
	expires: { type: 'string' },
	cidr: { type: 'string', multiple: true },
};
const keyRevokeFlags: FlagSpec = {
	...confirmFlags,
	'service-account': { type: 'string' },
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
		case 'token':
			return issueToken(argv.slice(1));
		case 'keys':
		case 'key':
			return serviceAccountKeysCommand(argv.slice(1));
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
	rejectExtraPositionals(args, 0, 'Usage: yoal sa [list] [--json]');
	const client = await authenticatedClient();
	const accounts = await fetchServiceAccounts(client);
	if (args.boolean('json')) {
		printJson({ serviceAccounts: accounts });
		return;
	}
	if (accounts.length === 0) {
		console.log('No service accounts yet. Create one with `yoal sa create <name>`.');
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
	rejectExtraPositionals(args, 1, 'Usage: yoal sa create <name> [--description <text>] [--owner-group <id>]');
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
	console.log(`Bind it with: yoal iam bind serviceAccount:${account.id} <role> --scope org`);
	console.log(`Mint a key with: yoal key create <name> --service-account ${account.name}`);
}

async function setDisabled(argv: string[], disabled: boolean): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const action = disabled ? 'disable' : 'enable';
	rejectExtraPositionals(args, 1, `Usage: yoal sa ${action} <name|id>`);
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
	rejectExtraPositionals(args, 1, 'Usage: yoal sa delete <name|id> [--yes]');
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

async function issueToken(argv: string[]): Promise<void> {
	const args = parseArgs(argv, tokenFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal sa token <name|id> [--ttl <duration>] [--audience <aud>]');
	const value = requirePositional(args, 0, `service account name or id.\n\n${usage}`);
	const ttl = parseTokenTtl(args.string('ttl'));
	const body: Record<string, unknown> = { ttl };
	const audience = args.string('audience');
	if (audience) body.audience = audience;

	const client = await authenticatedClient();
	const account = resolveServiceAccount(await fetchServiceAccounts(client), value);
	const raw = await requestJson(
		client,
		'POST',
		`/api/v1/service-accounts/${encodeURIComponent(account.id)}/token`,
		body,
	);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const record = asRecord(raw);
	const token = stringValue(record?.access_token) ?? stringValue(record?.token);
	const expiresIn = typeof record?.expires_in === 'number' ? record.expires_in : ttl;
	if (!token)
		throw new CliError('The platform returned an unexpected service-account token response.', {
			code: 'protocol',
			details: raw,
		});
	console.log(`Token for ${account.name} (${account.id}), expires in ${expiresIn} seconds:`);
	console.log('');
	console.log(`  ${token}`);
	console.log('');
	console.log('Copy it now: the token is shown once and cannot be recovered.');
}

async function serviceAccountKeysCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first.startsWith('-')) return listServiceAccountKeys(argv);
	switch (first) {
		case 'list':
		case 'ls':
			return listServiceAccountKeys(argv.slice(1));
		case 'create':
		case 'add':
			return createServiceAccountKey(argv.slice(1));
		case 'revoke':
		case 'rm':
			return revokeServiceAccountKey(argv.slice(1));
		default:
			throw new UsageError(`Unknown sa keys command "${first}".\n\n${usage}`);
	}
}

async function listServiceAccountKeys(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal sa keys [list] <name|id> [--json]');
	const value = requirePositional(args, 0, `service account name or id.\n\n${usage}`);
	const client = await authenticatedClient();
	const account = resolveServiceAccount(await fetchServiceAccounts(client), value);
	const keys = await fetchServiceAccountKeys(client, account.id);
	if (args.boolean('json')) {
		printJson({ accessKeys: keys });
		return;
	}
	if (keys.length === 0) {
		console.log(`No keys for ${account.name}. Mint one with \`yoal sa keys create ${account.name} <key>\`.`);
		return;
	}
	console.log(serviceAccountKeyTable(keys));
}

async function createServiceAccountKey(argv: string[]): Promise<void> {
	const args = parseArgs(argv, keyCreateFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 2, 'Usage: yoal sa keys create <name|id> <key> [options]');
	const value = requirePositional(args, 0, `service account name or id.\n\n${usage}`);
	const name = requirePositional(args, 1, `key name.\n\n${usage}`);
	const body: Record<string, unknown> = { name };
	const permissionValues = args.strings('permission');
	if (permissionValues.length > 0) body.permissions = parsePermissions(permissionValues);
	const resourceValues = args.strings('resource');
	if (resourceValues.length > 0) body.resources = parseList(resourceValues);
	const cidrValues = args.strings('cidr');
	if (cidrValues.length > 0) body.allowedCidrs = parseCidrs(cidrValues);
	const expires = args.string('expires');
	if (expires) body.expiresInSeconds = parseExpiresInSeconds(expires);

	const client = await authenticatedClient();
	const account = resolveServiceAccount(await fetchServiceAccounts(client), value);
	const raw = await requestJson(
		client,
		'POST',
		`/api/v1/service-accounts/${encodeURIComponent(account.id)}/keys`,
		body,
	);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const created = asRecord(raw);
	const key = stringValue(created?.key);
	const view = asServiceAccountKey(created?.accessKey);
	if (!key || !view)
		throw new CliError('The platform returned an unexpected service-account key response.', {
			code: 'protocol',
			details: raw,
		});
	console.log(`Created key "${view.name}" (${view.id}) for ${account.name} (${account.id}).`);
	console.log('');
	console.log(`  ${key}`);
	console.log('');
	console.log('Copy it now: the secret is shown once and cannot be recovered.');
	if (view.expiresAt !== null) console.log(`Expires ${formatTime(view.expiresAt)}.`);
}

async function revokeServiceAccountKey(argv: string[]): Promise<void> {
	const args = parseArgs(argv, keyRevokeFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal sa keys revoke <key-id> --service-account <name|id> [--yes]');
	const keyId = requirePositional(args, 0, `key id.\n\n${usage}`);
	const accountValue = args.string('service-account');
	if (!accountValue)
		throw new UsageError('Say which account the key belongs to with --service-account <name|id>.');
	const client = await authenticatedClient();
	const account = resolveServiceAccount(await fetchServiceAccounts(client), accountValue);
	const confirmed = await confirmOrRefuse(
		`Revoke key ${keyId} for ${account.name}? It stops working at once. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: 'Not revoked. Pass --yes to revoke without asking.',
		},
	);
	if (!confirmed) {
		console.log('Cancelled.');
		return;
	}
	const raw = await requestJson(
		client,
		'DELETE',
		`/api/v1/service-accounts/${encodeURIComponent(account.id)}/keys?keyId=${encodeURIComponent(keyId)}`,
	);
	if (args.boolean('json')) printJson(raw);
	else console.log(`Revoked key ${keyId} for ${account.name} (${account.id}).`);
}

// ---------------------------------------------------------------- pure helpers

/** The core caps an impersonation token at one hour; reject anything longer before the request. */
export function parseTokenTtl(value: string | undefined, now = Date.now()): number {
	if (!value) return 3600;
	const seconds = Math.max(1, Math.round((parseExpiry(value, now) - now) / 1000));
	if (seconds > 3600)
		throw new UsageError('An impersonation token lasts at most one hour; use --ttl 30m or --ttl 1h.');
	return seconds;
}

/** `--cidr a,b --cidr c` into a deduplicated list, matching `yoal key create`. */
export function parseCidrs(values: string[]): string[] {
	const cidrs = values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	if (cidrs.length === 0) throw new UsageError('Add at least one --cidr, e.g. --cidr 10.0.0.0/8.');
	return [...new Set(cidrs)];
}

/** The API takes a TTL in seconds; `--expires` accepts the same durations as `yoal sa token`. */
export function parseExpiresInSeconds(value: string, now = Date.now()): number {
	return Math.max(1, Math.round((parseExpiry(value, now) - now) / 1000));
}

function parseList(values: string[]): string[] {
	const entries = values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	if (entries.length === 0) throw new UsageError('Add at least one value.');
	return [...new Set(entries)];
}

export function serviceAccountKeyTable(keys: ServiceAccountKeyView[]): string {
	const rows = keys.map((key) => [
		key.id,
		key.name,
		key.start,
		key.expiresAt === null ? 'never' : formatTime(key.expiresAt),
		key.lastUsedAt === null ? 'never' : formatTime(key.lastUsedAt),
		key.revokedAt === null ? 'active' : 'revoked',
	]);
	return renderTable(['ID', 'NAME', 'START', 'EXPIRES', 'LAST USED', 'STATE'], rows);
}

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

/** Resolve an account by exact id or name, so both `yoal sa disable sa_…` and `… ci-bot` work. */
export function resolveServiceAccount(
	accounts: ServiceAccountView[],
	value: string,
): ServiceAccountView {
	const account =
		accounts.find((entry) => entry.id === value) ?? accounts.find((entry) => entry.name === value);
	if (!account)
		throw new UsageError(`Unknown service account "${value}". Run \`yoal sa\` to see them.`);
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

export async function fetchServiceAccountKeys(
	client: ApiClient,
	accountId: string,
): Promise<ServiceAccountKeyView[]> {
	const record = asRecord(
		await requestJson(
			client,
			'GET',
			`/api/v1/service-accounts/${encodeURIComponent(accountId)}/keys`,
		),
	);
	const raw = record?.accessKeys;
	if (!Array.isArray(raw))
		throw new CliError('The platform returned an unexpected service-account key response.', {
			code: 'protocol',
			details: record,
		});
	return raw.map((entry) => {
		const key = asServiceAccountKey(entry);
		if (!key)
			throw new CliError('The platform returned an unexpected service-account key entry.', {
				code: 'protocol',
				details: entry,
			});
		return key;
	});
}

function asServiceAccountKey(value: unknown): ServiceAccountKeyView | undefined {
	const record = asRecord(value);
	const id = stringValue(record?.id);
	const name = stringValue(record?.name);
	if (!record || !id || !name) return undefined;
	return {
		id,
		name,
		start: stringValue(record.start) ?? '',
		expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : null,
		lastUsedAt: typeof record.lastUsedAt === 'number' ? record.lastUsedAt : null,
		revokedAt: typeof record.revokedAt === 'number' ? record.revokedAt : null,
	};
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
