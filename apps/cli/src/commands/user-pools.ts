import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import type { ApiClient } from '../api.ts';
import { CliError, UsageError } from '../errors.ts';
import { formatTime, printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { asRecord, requestJson, stringValue } from './iam.ts';

/**
 * Managed user pools (docs/IAM.md I26–I29, §11.2; docs/API.md §User pools). A pool is an org
 * resource: a hosted OIDC provider for one deployed app's own end users. This client manages the
 * pool and reads its OIDC clients; users, sessions and hosted sign-in belong to the identity
 * engine. Every check lives on the server.
 */

const usage = `Usage: skif pool <command> [options]

Commands:
  list [list]                  User pools with their issuer, engine and status
  create <name>                Create a pool (--description, --signup invite|open, --engine)
  disable <name|id>            Switch a pool off; its clients and signing key stay
  clients <name|id>            The pool's OIDC clients (secrets are never shown again)

Create options:
      --description <text>     A note shown in the list and dashboard
      --signup <mode>          invite (default) or open
      --engine <engine>        skiff-identity (default, the only engine)

Options:
      --json                   JSON output
  -h, --help                   Show this help

A pool's discovery document is public at /api/v1/user-pools/<id>/.well-known/openid-configuration
and its keys at .../.well-known/jwks.json. A disabled pool's discovery returns 404.

Examples:
  skif pool create customer-auth --signup open
  skif pool clients customer-auth
  skif pool disable customer-auth`;

export interface UserPoolView {
	id: string;
	orgId: string;
	name: string;
	description: string;
	engine: string;
	issuer: string;
	signingKeyId: string | null;
	signupMode: string;
	disabled: boolean;
	disabledAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface UserPoolClientView {
	id: string;
	poolId: string;
	name: string;
	clientId: string;
	redirectUris: string[];
	public: boolean;
	createdAt: number;
}

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const createFlags: FlagSpec = {
	...baseFlags,
	description: { type: 'string' },
	signup: { type: 'string' },
	engine: { type: 'string' },
};

export async function userPoolsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first === 'help' || first === '--help' || first === '-h') {
		console.log(usage);
		return;
	}
	if (first.startsWith('-')) return listPools(argv);
	switch (first) {
		case 'list':
		case 'ls':
			return listPools(argv.slice(1));
		case 'create':
		case 'add':
			return createPool(argv.slice(1));
		case 'disable':
		case 'off':
			return disablePool(argv.slice(1));
		case 'clients':
		case 'client':
			return listClients(argv.slice(1));
		default:
			throw new UsageError(`Unknown pool command "${first}".\n\n${usage}`);
	}
}

async function listPools(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif pool [list] [--json]');
	const client = await authenticatedClient();
	const pools = await fetchPools(client);
	if (args.boolean('json')) {
		printJson({ pools });
		return;
	}
	if (pools.length === 0) {
		console.log('No user pools yet. Create one with `skif pool create <name>`.');
		return;
	}
	console.log(poolTable(pools));
}

async function createPool(argv: string[]): Promise<void> {
	const args = parseArgs(argv, createFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif pool create <name> [--description <text>] [--signup invite|open] [--engine skiff-identity]');
	const name = requirePositional(args, 0, `pool name.\n\n${usage}`);
	const body: Record<string, unknown> = { name };
	const description = args.string('description');
	if (description) body.description = description;
	const signup = args.string('signup');
	if (signup) {
		if (signup !== 'invite' && signup !== 'open')
			throw new UsageError('--signup must be invite or open.');
		body.signupMode = signup;
	}
	const engine = args.string('engine');
	if (engine) {
		if (engine !== 'skiff-identity')
			throw new UsageError('The only user-pool engine is skiff-identity.');
		body.engine = engine;
	}
	const client = await authenticatedClient();
	const raw = await requestJson(client, 'POST', '/api/v1/user-pools', body);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const pool = asPool(asRecord(raw)?.pool ?? raw);
	if (!pool)
		throw new CliError('The platform returned an unexpected user pool response.', {
			code: 'protocol',
			details: raw,
		});
	console.log(`Created user pool "${pool.name}" (${pool.id}).`);
	console.log(`Issuer ${pool.issuer}`);
	console.log(`Add an OIDC client in Settings → Identity, or read them with \`skif pool clients ${pool.name}\`.`);
}

async function disablePool(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif pool disable <name|id>');
	const value = requirePositional(args, 0, `pool name or id.\n\n${usage}`);
	const client = await authenticatedClient();
	const pool = resolvePool(await fetchPools(client), value);
	const raw = await requestJson(client, 'PATCH', `/api/v1/user-pools/${encodeURIComponent(pool.id)}`, {
		disabled: true,
	});
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const updated = asPool(asRecord(raw)?.pool ?? raw) ?? pool;
	console.log(`Disabled user pool ${updated.name} (${updated.id}). Its clients and signing key stay.`);
	console.log('Its discovery and JWKS endpoints return 404 while it is disabled.');
}

async function listClients(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif pool clients <name|id> [--json]');
	const value = requirePositional(args, 0, `pool name or id.\n\n${usage}`);
	const client = await authenticatedClient();
	const pool = resolvePool(await fetchPools(client), value);
	const record = asRecord(
		await requestJson(client, 'GET', `/api/v1/user-pools/${encodeURIComponent(pool.id)}/clients`),
	);
	const raw = record?.clients;
	if (!Array.isArray(raw))
		throw new CliError('The platform returned an unexpected user pool client response.', {
			code: 'protocol',
			details: record,
		});
	const clients = raw.map((entry) => asClient(entry)).filter((entry): entry is UserPoolClientView => entry !== undefined);
	if (args.boolean('json')) {
		printJson({ pool: pool.name, clients });
		return;
	}
	if (clients.length === 0) {
		console.log(`No OIDC clients in ${pool.name}. Add one in Settings → Identity.`);
		return;
	}
	console.log(clientTable(clients));
}

// ---------------------------------------------------------------- pure helpers

export function poolTable(pools: UserPoolView[]): string {
	const rows = pools.map((pool) => [
		pool.id,
		pool.name,
		pool.engine,
		pool.signupMode,
		pool.disabled ? 'disabled' : 'active',
		pool.issuer,
	]);
	return renderTable(['ID', 'NAME', 'ENGINE', 'SIGNUP', 'STATE', 'ISSUER'], rows);
}

export function clientTable(clients: UserPoolClientView[]): string {
	const rows = clients.map((client) => [
		client.clientId,
		client.name,
		client.public ? 'public' : 'confidential',
		client.redirectUris.join(', '),
		formatTime(client.createdAt),
	]);
	return renderTable(['CLIENT ID', 'NAME', 'TYPE', 'REDIRECTS', 'CREATED'], rows);
}

export function resolvePool(pools: UserPoolView[], value: string): UserPoolView {
	const pool = pools.find((entry) => entry.id === value) ?? pools.find((entry) => entry.name === value);
	if (!pool) throw new UsageError(`Unknown user pool "${value}". Run \`skif pool\` to see them.`);
	return pool;
}

// ---------------------------------------------------------------- wire helpers

async function fetchPools(client: ApiClient): Promise<UserPoolView[]> {
	const record = asRecord(await requestJson(client, 'GET', '/api/v1/user-pools'));
	const raw = record?.pools;
	if (!Array.isArray(raw))
		throw new CliError('The platform returned an unexpected user pool response.', {
			code: 'protocol',
			details: record,
		});
	return raw.map((entry) => {
		const pool = asPool(entry);
		if (!pool)
			throw new CliError('The platform returned an unexpected user pool entry.', {
				code: 'protocol',
				details: entry,
			});
		return pool;
	});
}

function asPool(value: unknown): UserPoolView | undefined {
	const record = asRecord(value);
	const id = stringValue(record?.id);
	const name = stringValue(record?.name);
	if (!record || !id || !name) return undefined;
	return {
		id,
		orgId: stringValue(record.orgId) ?? '',
		name,
		description: stringValue(record.description) ?? '',
		engine: stringValue(record.engine) ?? 'skiff-identity',
		issuer: stringValue(record.issuer) ?? '',
		signingKeyId: stringValue(record.signingKeyId) ?? null,
		signupMode: stringValue(record.signupMode) ?? 'invite',
		disabled: record.disabled === true,
		disabledAt: typeof record.disabledAt === 'number' ? record.disabledAt : null,
		createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
		updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
	};
}

function asClient(value: unknown): UserPoolClientView | undefined {
	const record = asRecord(value);
	const id = stringValue(record?.id);
	const clientId = stringValue(record?.clientId);
	if (!record || !id || !clientId) return undefined;
	return {
		id,
		poolId: stringValue(record.poolId) ?? '',
		name: stringValue(record.name) ?? '',
		clientId,
		redirectUris: Array.isArray(record.redirectUris)
			? record.redirectUris.filter((entry): entry is string => typeof entry === 'string')
			: [],
		public: record.public === true,
		createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
	};
}
