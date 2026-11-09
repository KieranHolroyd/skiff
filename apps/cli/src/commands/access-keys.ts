import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import type { ApiClient } from '../api.ts';
import { CliError, UsageError } from '../errors.ts';
import { formatTime, printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { asRecord, parseExpiry, parsePermissions, requestJson, stringValue } from './iam.ts';
import { confirmOrRefuse } from './run-operation.ts';
import { fetchServiceAccounts, resolveServiceAccount } from './service-accounts.ts';

/**
 * Access keys (docs/IAM.md I14, §7.2; docs/API.md §Access keys). A key belongs to one org and one
 * principal: the caller (`user`) or a service account. The raw `yoal_…` key is shown exactly once,
 * from `create`; every later read carries only its `start`. Server checks decide who may list and
 * revoke; this is a thin client over `/api/v1/access-keys`.
 */

const usage = `Usage: yoal key <command> [options]

Commands:
  list [list]                  Keys you can see (--principal to filter by principal id)
  create <name>                Mint a key; the secret is printed once and never again
  revoke <id>                  Revoke a key at once

Create options:
      --service-account <name|id>  Mint the key for a service account (default: a key for yourself)
      --permission <p>         A permission ceiling, e.g. project:read; repeat or comma-separate
      --resource <r>           A resource ceiling (type:id or type:*); repeat or comma-separate
      --expires <when>         An ISO timestamp or a duration: 30m, 8h, 90d, 1w
      --cidr <cidr>            Allow only these networks; repeat or comma-separate

Options:
      --principal <id>         list: only this principal's keys (needs accessKey:read-all)
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output (create prints the whole response, secret included)
  -h, --help                   Show this help

A user key can only be minted for yourself. A service-account key needs serviceAccount:manage-keys.
Server-side key defaults: service-account keys expire after 90 days; user keys do not expire. A key
with CIDRs is refused when the request carries no IP.

Examples:
  yoal key create ci --service-account ci-bot --expires 90d
  yoal key create ci --service-account ci-bot --permission project:read --cidr 10.0.0.0/8
  yoal key list
  yoal key revoke ak_abc123`;

export interface AccessKeyView {
	id: string;
	orgId: string;
	principalType: string;
	principalId: string;
	name: string;
	prefix: string;
	start: string;
	permissions: string[] | null;
	resources: string[] | null;
	allowedCidrs: string[];
	expiresAt: number | null;
	lastUsedAt: number | null;
	createdBy: string;
	revokedAt: number | null;
	createdAt: number;
}

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };
const listFlags: FlagSpec = { ...baseFlags, principal: { type: 'string' } };
const createFlags: FlagSpec = {
	...baseFlags,
	'service-account': { type: 'string' },
	permission: { type: 'string', multiple: true },
	resource: { type: 'string', multiple: true },
	expires: { type: 'string' },
	cidr: { type: 'string', multiple: true },
};

export async function accessKeysCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first === 'help' || first === '--help' || first === '-h') {
		console.log(usage);
		return;
	}
	if (first.startsWith('-')) return listAccessKeys(argv);
	switch (first) {
		case 'list':
		case 'ls':
			return listAccessKeys(argv.slice(1));
		case 'create':
		case 'add':
			return createAccessKey(argv.slice(1));
		case 'revoke':
		case 'rm':
			return revokeAccessKey(argv.slice(1));
		default:
			throw new UsageError(`Unknown key command "${first}".\n\n${usage}`);
	}
}

async function listAccessKeys(argv: string[]): Promise<void> {
	const args = parseArgs(argv, listFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal key [list] [--principal <id>] [--json]');
	const client = await authenticatedClient();
	const keys = await fetchAccessKeys(client, args.string('principal'));
	if (args.boolean('json')) {
		printJson({ accessKeys: keys });
		return;
	}
	if (keys.length === 0) {
		console.log('No access keys. Mint one with `yoal key create <name>`.');
		return;
	}
	console.log(accessKeyTable(keys));
}

async function createAccessKey(argv: string[]): Promise<void> {
	const args = parseArgs(argv, createFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal key create <name> [--service-account <name|id>] [options]');
	const name = requirePositional(args, 0, `key name.\n\n${usage}`);
	const client = await authenticatedClient();

	const body: Record<string, unknown> = { name };
	const serviceAccount = args.string('service-account');
	if (serviceAccount) {
		const account = resolveServiceAccount(await fetchServiceAccounts(client), serviceAccount);
		body.principalType = 'serviceAccount';
		body.principalId = account.id;
	}
	const permissionValues = args.strings('permission');
	if (permissionValues.length > 0) body.permissions = parsePermissions(permissionValues);
	const resourceValues = args.strings('resource');
	if (resourceValues.length > 0) body.resources = parseList(resourceValues);
	const cidrValues = args.strings('cidr');
	if (cidrValues.length > 0) body.allowedCidrs = parseCidrs(cidrValues);
	const expires = args.string('expires');
	if (expires) body.expiresInSeconds = parseExpiresInSeconds(expires);

	const raw = await requestJson(client, 'POST', '/api/v1/access-keys', body);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const created = asRecord(raw);
	const key = stringValue(created?.key);
	const view = asAccessKey(created?.accessKey);
	if (!key || !view)
		throw new CliError('The platform returned an unexpected access key response.', {
			code: 'protocol',
			details: raw,
		});
	console.log(`Created access key "${view.name}" (${view.id}) for ${view.principalType}:${view.principalId}.`);
	console.log('');
	console.log(`  ${key}`);
	console.log('');
	console.log('Copy it now: the secret is shown once and cannot be recovered.');
	if (view.expiresAt !== null) console.log(`Expires ${formatTime(view.expiresAt)}.`);
}

async function revokeAccessKey(argv: string[]): Promise<void> {
	const args = parseArgs(argv, confirmFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: yoal key revoke <id> [--yes]');
	const id = requirePositional(args, 0, `access key id.\n\n${usage}`);
	const confirmed = await confirmOrRefuse(`Revoke access key ${id}? It stops working at once. [y/N] `, {
		yes: args.boolean('yes'),
		refusal: 'Not revoked. Pass --yes to revoke without asking.',
	});
	if (!confirmed) {
		console.log('Cancelled.');
		return;
	}
	const client = await authenticatedClient();
	const raw = await requestJson(client, 'DELETE', `/api/v1/access-keys/${encodeURIComponent(id)}`);
	if (args.boolean('json')) printJson(raw);
	else console.log(`Revoked access key ${id}.`);
}

// ---------------------------------------------------------------- pure helpers

export function accessKeyTable(keys: AccessKeyView[]): string {
	const rows = keys.map((key) => [
		key.id,
		key.name,
		`${key.principalType}:${key.principalId}`,
		key.start,
		key.expiresAt === null ? 'never' : formatTime(key.expiresAt),
		key.lastUsedAt === null ? 'never' : formatTime(key.lastUsedAt),
		key.revokedAt === null ? 'active' : 'revoked',
	]);
	return renderTable(['ID', 'NAME', 'PRINCIPAL', 'START', 'EXPIRES', 'LAST USED', 'STATE'], rows);
}

/** `--cidr a,b --cidr c` into a deduplicated list; empty entries are ignored. */
export function parseCidrs(values: string[]): string[] {
	const cidrs = values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	if (cidrs.length === 0) throw new UsageError('Add at least one --cidr, e.g. --cidr 10.0.0.0/8.');
	return [...new Set(cidrs)];
}

/** The API takes a TTL in seconds; `--expires` accepts the same durations as `yoal iam --expires`. */
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

// ---------------------------------------------------------------- wire helpers

async function fetchAccessKeys(client: ApiClient, principalId?: string): Promise<AccessKeyView[]> {
	const query = principalId ? `?principalId=${encodeURIComponent(principalId)}` : '';
	const record = asRecord(await requestJson(client, 'GET', `/api/v1/access-keys${query}`));
	const raw = record?.accessKeys;
	if (!Array.isArray(raw))
		throw new CliError('The platform returned an unexpected access key response.', {
			code: 'protocol',
			details: record,
		});
	return raw.map((entry) => {
		const key = asAccessKey(entry);
		if (!key)
			throw new CliError('The platform returned an unexpected access key entry.', {
				code: 'protocol',
				details: entry,
			});
		return key;
	});
}

function asAccessKey(value: unknown): AccessKeyView | undefined {
	const record = asRecord(value);
	const id = stringValue(record?.id);
	const name = stringValue(record?.name);
	if (!record || !id || !name) return undefined;
	return {
		id,
		orgId: stringValue(record.orgId) ?? '',
		principalType: stringValue(record.principalType) ?? 'user',
		principalId: stringValue(record.principalId) ?? '',
		name,
		prefix: stringValue(record.prefix) ?? 'yoal_',
		start: stringValue(record.start) ?? '',
		permissions: stringArray(record.permissions),
		resources: stringArray(record.resources),
		allowedCidrs: stringArray(record.allowedCidrs) ?? [],
		expiresAt: numberOrNull(record.expiresAt),
		lastUsedAt: numberOrNull(record.lastUsedAt),
		createdBy: stringValue(record.createdBy) ?? '',
		revokedAt: numberOrNull(record.revokedAt),
		createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
	};
}

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.filter((entry): entry is string => typeof entry === 'string');
}

function numberOrNull(value: unknown): number | null {
	return typeof value === 'number' ? value : null;
}
