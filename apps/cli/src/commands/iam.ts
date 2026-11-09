import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import type { ApiClient } from '../api.ts';
import { CliError, UsageError } from '../errors.ts';
import { formatTime, printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * IAM at org scope (docs/IAM.md, docs/API.md §IAM): roles, bindings and groups, plus the
 * "why can (or can't) I?" and "who can?" views. Every check lives on the server; this is a thin
 * client over `/api/v1/iam`.
 */

const usage = `Usage: skif iam <command> [options]

Commands:
  roles [list]                  Built-in and custom roles, with how many permissions each has
  roles create <name>           Create a custom role (--permission, repeat for each)
  roles delete <id>             Delete a custom role that no binding uses
  bindings [list]               Who is bound to which role, where, and until when
  bind <type>:<id> <role>       Give a user, group or service account a role at a scope
  unbind <id>                   Remove a binding
  groups [list]                 Groups and how many members each has
  group create <name>           Create a group
  group add <group> <user>      Add a member (a user id, e.g. user_…)
  group remove <group> <user>   Remove a member
  explain <permission>          Why you can or cannot do something
  who-can <permission>          Everyone who can do it
  keys [list]                   Signing keys by purpose, and the next rotation decision
  keys rotate --purpose <p>     Rotate one purpose (--all for every automatic purpose)
  migrate-keys                  Copy legacy Better Auth keys into org-bound access keys

Role and group options:
      --permission <p>          A catalog permission, e.g. project:read; repeat or comma-separate
      --description <text>      A note for the role or group list

Bind options:
      --scope <scope>           org, platform, project:<id> or environment:<project>/<id>
      --expires <when>          An ISO timestamp or a duration: 8h, 7d, 2w
      --reason <text>           Why the grant exists (kept in the audit log)

Explain and who-can options:
      --resource <resource>     org (default), platform, project:<id> or environment:<project>/<id>

Keys rotate options:
      --purpose <p>             sts, registry, oidc, workload, or an explicit pool:<id>
      --all                     Rotate every purpose the monthly sweep rotates

Migrate keys options:
      --org <id>                A platform admin: limit the run to one org (default: every org)

Options:
  -y, --yes                    Don't ask for confirmation (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help

Bindings nest: an org binding covers every project and environment; a project binding covers
that project and its environments. Attachments confer nothing. Custom roles are matched by name
or id; groups by name or id. Members are added by user id, because the API takes one.

Examples:
  skif iam roles create billing --permission project:read --permission database:read
  skif iam bind user:user_abc owner --scope org
  skif iam bind group:grp_eng deployer --scope project:prj_shop --expires 7d --reason "release week"
  skif iam explain deployment:promote --resource project:prj_shop
  skif iam who-can database:credentials --resource project:prj_shop
  skif iam keys rotate --purpose sts
  skif iam keys rotate --all`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };
const createRoleFlags: FlagSpec = {
	...baseFlags,
	permission: { type: 'string', multiple: true },
	description: { type: 'string' },
};
const createGroupFlags: FlagSpec = { ...baseFlags, description: { type: 'string' } };
const bindFlags: FlagSpec = {
	...baseFlags,
	scope: { type: 'string' },
	expires: { type: 'string' },
	reason: { type: 'string' },
};
const resourceFlags: FlagSpec = { ...baseFlags, resource: { type: 'string' } };
const keysRotateFlags: FlagSpec = {
	...baseFlags,
	purpose: { type: 'string' },
	all: { type: 'boolean' },
};
const migrateKeysFlags: FlagSpec = { ...baseFlags, org: { type: 'string' } };

const PRINCIPAL_TYPES = ['user', 'group', 'serviceAccount'] as const;
type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export interface IamScopeView {
	type: string;
	id?: string;
	projectId?: string;
}

export interface IamRoleView {
	id: string;
	name: string;
	description: string;
	permissions: string[];
	builtIn: boolean;
}

export interface IamBindingView {
	id: string;
	principalType: string;
	principalId: string;
	roleId: string;
	roleName: string;
	scope: IamScopeView;
	expiresAt: number | null;
	reason: string | null;
	createdBy: string;
	createdAt: number;
}

export interface IamGroupView {
	id: string;
	name: string;
	description: string;
	source: string;
	members: number;
}

export interface IamSnapshot {
	version: number;
	roles: IamRoleView[];
	bindings: IamBindingView[];
	groups: IamGroupView[];
}

export interface IamGrantEvaluation {
	bindingId: string;
	roleId: string;
	scope: IamScopeView;
	outcome: 'allow' | 'expired' | 'condition' | 'scope' | 'restricted';
}

export interface IamDecision {
	allow: boolean;
	reason: string;
	via?: string;
	chain: IamGrantEvaluation[];
}

export interface IamWhoCan {
	permission: string;
	principals: Array<{ principalType: string; principalId: string; via: string | null }>;
}

export interface IamKeyEntry {
	purpose: string;
	automatic: boolean;
	active: { kid: string; createdAt: number; activatedAt: number | null } | null;
	next: { kid: string; createdAt: number } | null;
	retired: number;
	keys: Array<{
		kid: string;
		alg: string;
		state: string;
		createdAt: number;
		activatedAt: number | null;
		retireAfter: number | null;
	}>;
	rotation: { due: boolean; action: string; reason: string };
}

export interface IamKeysView {
	purposes: IamKeyEntry[];
	policy: { intervalDays: number; overlapHours: number; automaticPurposes: string[] };
	lastRotatedAt: number | null;
	nextCheckAt: number | null;
	can: { rotate: boolean };
}

export interface IamKeyRotation {
	purpose: string;
	active: { kid: string };
	next: { kid: string } | null;
	retiredKid: string | null;
}

export async function iamCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first === 'help' || first === '--help' || first === '-h') {
		console.log(usage);
		return;
	}
	if (first.startsWith('-')) throw new UsageError(`Unknown option ${first}.\n\n${usage}`);
	switch (first) {
		case 'roles':
		case 'role':
			return rolesCommand(argv.slice(1));
		case 'bindings':
		case 'binding':
			return bindingsCommand(argv.slice(1));
		case 'bind':
			return bindCommand(argv.slice(1));
		case 'unbind':
			return unbindCommand(argv.slice(1));
		case 'groups':
		case 'group':
			return groupsCommand(argv.slice(1));
		case 'explain':
			return explainCommand(argv.slice(1));
		case 'who-can':
		case 'whocan':
			return whoCanCommand(argv.slice(1));
		case 'keys':
		case 'key':
			return keysCommand(argv.slice(1));
		case 'migrate-keys':
		case 'migrate-access-keys':
			return migrateKeys(argv.slice(1));
		default:
			throw new UsageError(`Unknown iam command "${first}".\n\n${usage}`);
	}
}

// ---------------------------------------------------------------- roles

const roleActions: Record<string, (argv: string[]) => Promise<void>> = {
	list: listRoles,
	ls: listRoles,
	create: createRole,
	add: createRole,
	delete: deleteRole,
	rm: deleteRole,
};

async function rolesCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first.startsWith('-')) return listRoles(argv);
	const handler = roleActions[first];
	if (!handler) throw new UsageError(`Unknown roles command "${first}".\n\n${usage}`);
	await handler(argv.slice(1));
}

async function listRoles(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif iam roles [--json]');
	const client = await authenticatedClient();
	const snapshot = await fetchSnapshot(client);
	if (args.boolean('json')) {
		printJson({ roles: snapshot.roles });
		return;
	}
	console.log(roleTable(snapshot.roles));
}

async function createRole(argv: string[]): Promise<void> {
	const args = parseArgs(argv, createRoleFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif iam roles create <name> --permission <p>…');
	const name = requirePositional(args, 0, `role name.\n\n${usage}`);
	const permissions = parsePermissions(args.strings('permission'));
	const body: Record<string, unknown> = { name, permissions };
	const description = args.string('description');
	if (description) body.description = description;
	const client = await authenticatedClient();
	const raw = await requestJson(client, 'POST', '/api/v1/iam/roles', body);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const role = asRecord(raw);
	const id = stringValue(role?.id) ?? name;
	console.log(`Created role "${name}" (${id}) with ${permissions.length} permission${permissions.length === 1 ? '' : 's'}.`);
	console.log(`Bind it with: skif iam bind <type>:<id> ${name} --scope org`);
}

async function deleteRole(argv: string[]): Promise<void> {
	const args = parseArgs(argv, confirmFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif iam roles delete <id> [--yes]');
	const id = requirePositional(args, 0, `role id.\n\n${usage}`);
	const confirmed = await confirmOrRefuse(
		`Delete role ${id}? It must not be bound to anyone. [y/N] `,
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
	const raw = await requestJson(client, 'DELETE', `/api/v1/iam/roles/${encodeURIComponent(id)}`);
	if (args.boolean('json')) printJson(raw);
	else console.log(`Deleted role ${id}.`);
}

// ---------------------------------------------------------------- bindings

async function bindingsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first.startsWith('-')) return listBindings(argv);
	if (first === 'list' || first === 'ls') return listBindings(argv.slice(1));
	throw new UsageError(
		`Unknown bindings command "${first}". Use \`skif iam bind\` or \`skif iam unbind\`.\n\n${usage}`,
	);
}

async function listBindings(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif iam bindings [--json]');
	const client = await authenticatedClient();
	const snapshot = await fetchSnapshot(client);
	if (args.boolean('json')) {
		printJson({ bindings: snapshot.bindings });
		return;
	}
	if (snapshot.bindings.length === 0) {
		console.log('No bindings yet. Add one with `skif iam bind <type>:<id> <role> --scope org`.');
		return;
	}
	console.log(bindingTable(snapshot.bindings, snapshot.roles));
}

async function bindCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, bindFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 2, 'Usage: skif iam bind <type>:<id> <role> --scope <scope> [--expires <when>] [--reason <text>]');
	const principal = parsePrincipal(requirePositional(args, 0, `principal, as <type>:<id>.\n\n${usage}`));
	const roleValue = requirePositional(args, 1, `role.\n\n${usage}`);
	const scopeValue = args.string('scope');
	if (!scopeValue) throw new UsageError('Say where: --scope org, project:<id> or environment:<project>/<id>.');
	const scope = parseScope(scopeValue, '--scope');
	const expiresAt = args.string('expires') === undefined ? undefined : parseExpiry(args.string('expires')!);

	const client = await authenticatedClient();
	const snapshot = await fetchSnapshot(client);
	const role = resolveRole(roleValue, snapshot.roles);
	const body: Record<string, unknown> = {
		principalType: principal.principalType,
		principalId: principal.principalId,
		roleId: role.id,
		scope,
	};
	if (expiresAt !== undefined) body.expiresAt = expiresAt;
	const reason = args.string('reason');
	if (reason) body.reason = reason;

	const raw = await requestJson(client, 'POST', '/api/v1/iam/bindings', body);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const until = expiresAt === undefined ? 'no expiry' : `until ${formatTime(expiresAt)}`;
	console.log(
		`Bound ${principal.principalType}:${principal.principalId} to ${role.name} at ${formatScope(scope)} (${until}).`,
	);
}

async function unbindCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, confirmFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif iam unbind <id> [--yes]');
	const id = requirePositional(args, 0, `binding id.\n\n${usage}`);
	const confirmed = await confirmOrRefuse(`Remove binding ${id}? Its access stops at once. [y/N] `, {
		yes: args.boolean('yes'),
		refusal: 'Not removed. Pass --yes to remove without asking.',
	});
	if (!confirmed) {
		console.log('Cancelled.');
		return;
	}
	const client = await authenticatedClient();
	const raw = await requestJson(client, 'DELETE', `/api/v1/iam/bindings/${encodeURIComponent(id)}`);
	if (args.boolean('json')) printJson(raw);
	else console.log(`Removed binding ${id}.`);
}

// ---------------------------------------------------------------- groups

const groupActions: Record<string, (argv: string[]) => Promise<void>> = {
	list: listGroups,
	ls: listGroups,
	create: createGroup,
	add: addGroupMember,
	remove: removeGroupMember,
	rm: removeGroupMember,
};

async function groupsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first.startsWith('-')) return listGroups(argv);
	const handler = groupActions[first];
	if (!handler) throw new UsageError(`Unknown groups command "${first}".\n\n${usage}`);
	await handler(argv.slice(1));
}

async function listGroups(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif iam groups [--json]');
	const client = await authenticatedClient();
	const snapshot = await fetchSnapshot(client);
	if (args.boolean('json')) {
		printJson({ groups: snapshot.groups });
		return;
	}
	if (snapshot.groups.length === 0) {
		console.log('No groups yet. Create one with `skif iam group create <name>`.');
		return;
	}
	console.log(groupTable(snapshot.groups));
}

async function createGroup(argv: string[]): Promise<void> {
	const args = parseArgs(argv, createGroupFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif iam group create <name> [--description <text>]');
	const name = requirePositional(args, 0, `group name.\n\n${usage}`);
	const body: Record<string, unknown> = { name };
	const description = args.string('description');
	if (description) body.description = description;
	const client = await authenticatedClient();
	const raw = await requestJson(client, 'POST', '/api/v1/iam/groups', body);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const group = asRecord(raw);
	const id = stringValue(group?.id) ?? name;
	console.log(`Created group "${name}" (${id}). Add members with \`skif iam group add ${name} <user>\`.`);
}

async function addGroupMember(argv: string[]): Promise<void> {
	const parsed = await groupMemberArgs(argv, 'add');
	if (!parsed) return;
	const client = await authenticatedClient();
	const raw = await requestJson(
		client,
		'POST',
		`/api/v1/iam/groups/${encodeURIComponent(parsed.group.id)}/members`,
		{ userId: parsed.userId },
	);
	if (parsed.args.boolean('json')) printJson(raw);
	else console.log(`Added ${parsed.userId} to ${parsed.group.name}.`);
}

async function removeGroupMember(argv: string[]): Promise<void> {
	const parsed = await groupMemberArgs(argv, 'remove');
	if (!parsed) return;
	const client = await authenticatedClient();
	const raw = await requestJson(
		client,
		'DELETE',
		`/api/v1/iam/groups/${encodeURIComponent(parsed.group.id)}/members`,
		{ userId: parsed.userId },
	);
	if (parsed.args.boolean('json')) printJson(raw);
	else console.log(`Removed ${parsed.userId} from ${parsed.group.name}.`);
}

async function groupMemberArgs(
	argv: string[],
	action: 'add' | 'remove',
): Promise<{ args: ReturnType<typeof parseArgs>; group: IamGroupView; userId: string } | null> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return null;
	}
	rejectExtraPositionals(args, 2, `Usage: skif iam group ${action} <group> <user>`);
	const groupValue = requirePositional(args, 0, `group name or id.\n\n${usage}`);
	const userId = requirePositional(args, 1, `user id.\n\n${usage}`);
	const client = await authenticatedClient();
	const snapshot = await fetchSnapshot(client);
	return { args, group: resolveGroup(groupValue, snapshot.groups), userId };
}

// ---------------------------------------------------------------- explain and who-can

async function explainCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, resourceFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif iam explain <permission> [--resource <resource>]');
	const permission = requirePositional(args, 0, `permission, e.g. project:read.\n\n${usage}`);
	const resource = parseScope(args.string('resource') ?? 'org', '--resource');
	const client = await authenticatedClient();
	const [snapshot, raw] = await Promise.all([
		fetchSnapshot(client),
		requestJson(client, 'GET', `/api/v1/iam/explain?${explainQuery(permission, resource)}`),
	]);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(explainText(decisionFrom(raw), permission, resource, snapshot.roles));
}

async function whoCanCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, resourceFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif iam who-can <permission> [--resource <resource>]');
	const permission = requirePositional(args, 0, `permission, e.g. project:read.\n\n${usage}`);
	const resource = parseScope(args.string('resource') ?? 'org', '--resource');
	const client = await authenticatedClient();
	const raw = await requestJson(client, 'GET', `/api/v1/iam/who-can?${explainQuery(permission, resource)}`);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const result = whoCanFrom(raw);
	if (result.principals.length === 0) {
		console.log(`No one can ${permission} on ${formatScope(resource)}.`);
		return;
	}
	console.log(whoCanTable(result));
}

// ---------------------------------------------------------------- signing keys

async function keysCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first.startsWith('-')) return listKeys(argv);
	if (first === 'list' || first === 'ls') return listKeys(argv.slice(1));
	if (first === 'rotate') return rotateKeys(argv.slice(1));
	throw new UsageError(`Unknown keys command "${first}". Use \`skif iam keys list\` or \`skif iam keys rotate\`.\n\n${usage}`);
}

async function listKeys(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif iam keys [list] [--json]');
	const client = await authenticatedClient();
	const raw = await requestJson(client, 'GET', '/api/v1/iam/keys');
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const view = keysViewFrom(raw);
	const lines = [keysTable(view.purposes)];
	if (view.lastRotatedAt !== null)
		lines.push(
			'',
			`Last rotation: ${formatTime(view.lastRotatedAt)}. Next check: ${formatTime(view.nextCheckAt ?? undefined)}.`,
		);
	if (!view.can.rotate)
		lines.push('Rotating signing keys needs platform maintenance (a platform admin session).');
	console.log(lines.join('\n'));
}

async function rotateKeys(argv: string[]): Promise<void> {
	const args = parseArgs(argv, keysRotateFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif iam keys rotate --purpose <p> | --all [--json]');
	const body = parseKeyRotation({ all: args.boolean('all'), purpose: args.string('purpose') });
	const client = await authenticatedClient();
	const raw = await requestJson(client, 'POST', '/api/v1/iam/keys/rotate', body);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const rotations = rotationsFrom(raw);
	for (const rotation of rotations) {
		const next = rotation.next ? rotation.next.kid : 'none';
		const retired = rotation.retiredKid ?? 'none';
		console.log(
			`Rotated ${rotation.purpose}: active ${rotation.active.kid}, next ${next}, retired ${retired}.`,
		);
	}
}

// ---------------------------------------------------------------- Better Auth key migration

async function migrateKeys(argv: string[]): Promise<void> {
	const args = parseArgs(argv, migrateKeysFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif iam migrate-keys [--org <id>] [--json]');
	const org = args.string('org');
	const client = await authenticatedClient();
	const raw = await requestJson(
		client,
		'POST',
		'/api/v1/access-keys/migrate',
		org ? { orgId: org } : {},
	);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const result = asRecord(raw);
	if (!result) throw new CliError('The platform returned an unexpected migration response.', { code: 'protocol' });
	const count = (key: string): number =>
		typeof result[key] === 'number' ? (result[key] as number) : 0;
	console.log(
		`Better Auth keys: ${count('examined')} examined, ${count('migrated')} migrated, ` +
			`${count('alreadyMigrated')} already migrated.`,
	);
	if (count('disabled') > 0)
		console.log(`${count('disabled')} migrated key${count('disabled') === 1 ? ' was' : 's were'} disabled and stay revoked.`);
	if (count('skippedNoOrg') > 0)
		console.log(`${count('skippedNoOrg')} skipped: the owner has no org membership.`);
	if (count('skippedOtherOrg') > 0) console.log(`${count('skippedOtherOrg')} skipped: another org.`);
	if (count('skippedInvalid') > 0)
		console.log(`${count('skippedInvalid')} skipped: the hash is not Better Auth's SHA-256 base64url.`);
}

// ---------------------------------------------------------------- parsing helpers (pure)

/** Validate `keys rotate` options: exactly one of `--purpose <p>` or `--all`. */
export function parseKeyRotation(options: { all: boolean; purpose?: string }): {
	all?: boolean;
	purpose?: string;
} {
	const purpose = options.purpose?.trim();
	if (options.all && purpose) throw new UsageError('Use --purpose or --all, not both.');
	if (options.all) return { all: true };
	if (!purpose) throw new UsageError('Name a purpose with --purpose, or pass --all.');
	return { purpose };
}

export function parseScope(value: string, flag = '--scope'): IamScopeView {
	const text = value.trim();
	if (text === 'org') return { type: 'org' };
	if (text === 'platform') return { type: 'platform' };
	if (text.startsWith('project:')) {
		const id = text.slice('project:'.length).trim();
		if (!id) throw new UsageError(`${flag} project: needs an id, e.g. project:prj_…`);
		return { type: 'project', id };
	}
	if (text.startsWith('environment:')) {
		const rest = text.slice('environment:'.length);
		const slash = rest.indexOf('/');
		const projectId = slash === -1 ? '' : rest.slice(0, slash).trim();
		const id = slash === -1 ? '' : rest.slice(slash + 1).trim();
		if (!projectId || !id)
			throw new UsageError(`${flag} environment: needs <project>/<id>, e.g. environment:prj_…/env_…`);
		return { type: 'environment', projectId, id };
	}
	throw new UsageError(`${flag} must be org, platform, project:<id> or environment:<project>/<id>.`);
}

export function formatScope(scope: IamScopeView): string {
	switch (scope.type) {
		case 'org':
		case 'platform':
			return scope.type;
		case 'project':
			return `project:${scope.id ?? '?'}`;
		case 'environment':
			return `environment:${scope.projectId ?? '?'}/${scope.id ?? '?'}`;
		default:
			return scope.id ? `${scope.type}:${scope.id}` : scope.type;
	}
}

export function parsePrincipal(value: string): { principalType: PrincipalType; principalId: string } {
	const colon = value.indexOf(':');
	if (colon <= 0 || colon === value.length - 1)
		throw new UsageError(`Name the principal as <type>:<id>, e.g. user:user_… or group:grp_….`);
	const principalType = value.slice(0, colon);
	const principalId = value.slice(colon + 1);
	if (!(PRINCIPAL_TYPES as readonly string[]).includes(principalType))
		throw new UsageError(`Principal type must be user, group or serviceAccount, not "${principalType}".`);
	return { principalType: principalType as PrincipalType, principalId };
}

/** A duration (`30m`, `8h`, `7d`, `2w`) or an ISO timestamp, as epoch milliseconds. */
export function parseExpiry(value: string, now = Date.now()): number {
	const text = value.trim();
	const duration = /^(\d+)\s*([smhdw])$/i.exec(text);
	let at: number;
	if (duration) {
		const amount = Number(duration[1]);
		const unit = duration[2]!.toLowerCase();
		const unitMs: Record<string, number> = {
			s: 1_000,
			m: 60_000,
			h: 3_600_000,
			d: 86_400_000,
			w: 604_800_000,
		};
		at = now + amount * unitMs[unit]!;
	} else {
		at = Date.parse(text);
	}
	if (!Number.isFinite(at))
		throw new UsageError(`"${value}" is not a date or duration. Use 2026-12-01T09:00:00Z or 8h.`);
	if (at <= now) throw new UsageError('An expiry must be in the future.');
	return at;
}

/** `--permission a,b --permission c` into a deduplicated list. */
export function parsePermissions(values: string[]): string[] {
	const permissions = values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	if (permissions.length === 0)
		throw new UsageError('Add at least one --permission, e.g. --permission project:read.');
	return [...new Set(permissions)];
}

// ---------------------------------------------------------------- formatting helpers (pure)

export function roleTable(roles: IamRoleView[]): string {
	const rows = roles.map((role) => [
		role.id,
		role.builtIn ? 'built-in' : 'custom',
		role.name,
		String(role.permissions.length),
	]);
	return renderTable(['ID', 'KIND', 'NAME', 'PERMISSIONS'], rows);
}

export function bindingTable(bindings: IamBindingView[], roles: IamRoleView[]): string {
	const rows = bindings.map((binding) => [
		binding.id,
		`${binding.principalType}:${binding.principalId}`,
		roleName(binding.roleId, roles),
		formatScope(binding.scope),
		binding.expiresAt === null ? 'never' : formatTime(binding.expiresAt),
	]);
	return renderTable(['ID', 'PRINCIPAL', 'ROLE', 'SCOPE', 'EXPIRES'], rows);
}

export function groupTable(groups: IamGroupView[]): string {
	const rows = groups.map((group) => [
		group.id,
		group.name,
		String(group.members),
		group.source,
	]);
	return renderTable(['ID', 'NAME', 'MEMBERS', 'SOURCE'], rows);
}

export function explainText(
	decision: IamDecision,
	permission: string,
	resource: IamScopeView,
	roles: IamRoleView[],
): string {
	const lines: string[] = [];
	lines.push(`${decision.allow ? 'Allowed' : 'Denied'}  ${permission} on ${formatScope(resource)}`);
	lines.push(`Reason      ${decision.reason}`);
	if (decision.via) lines.push(`Via         ${decision.via}`);
	if (decision.chain.length === 0) {
		lines.push('', 'No grant for this permission was considered.');
		return lines.join('\n');
	}
	const rows = decision.chain.map((entry) => [
		entry.bindingId,
		roleName(entry.roleId, roles),
		formatScope(entry.scope),
		entry.outcome,
	]);
	lines.push('', 'Grants considered:', renderTable(['BINDING', 'ROLE', 'SCOPE', 'OUTCOME'], rows));
	return lines.join('\n');
}

export function whoCanTable(result: IamWhoCan): string {
	const rows = result.principals.map((principal) => [
		`${principal.principalType}:${principal.principalId}`,
		principal.principalType,
		principal.via ?? '-',
	]);
	return renderTable(['PRINCIPAL', 'TYPE', 'VIA'], rows);
}

export function keysTable(purposes: IamKeyEntry[]): string {
	const rows = purposes.map((entry) => [
		entry.purpose,
		entry.active?.kid ?? '-',
		entry.next?.kid ?? '-',
		String(entry.retired),
		entry.rotation.due ? entry.rotation.action : 'no',
	]);
	return renderTable(['PURPOSE', 'ACTIVE', 'NEXT', 'RETIRED', 'DUE'], rows);
}

// ---------------------------------------------------------------- requests and small helpers

export async function requestJson(
	client: ApiClient,
	method: string,
	path: string,
	body?: unknown,
): Promise<unknown> {
	const response = await client.raw(
		method,
		path,
		body === undefined
			? {}
			: { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
	);
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new CliError(`The platform returned an unexpected response from ${method} ${path}.`, {
			code: 'protocol',
		});
	}
}

async function fetchSnapshot(client: ApiClient): Promise<IamSnapshot> {
	const record = asRecord(await requestJson(client, 'GET', '/api/v1/iam'));
	if (!record || !Array.isArray(record.roles) || !Array.isArray(record.bindings) || !Array.isArray(record.groups))
		throw new CliError('The platform returned an unexpected IAM response.', {
			code: 'protocol',
			details: record,
		});
	return {
		version: typeof record.version === 'number' ? record.version : 0,
		roles: record.roles as IamRoleView[],
		bindings: record.bindings as IamBindingView[],
		groups: record.groups as IamGroupView[],
	};
}

function decisionFrom(raw: unknown): IamDecision {
	const record = asRecord(raw);
	if (!record || typeof record.allow !== 'boolean' || typeof record.reason !== 'string')
		throw new CliError('The platform returned an unexpected explain response.', {
			code: 'protocol',
			details: raw,
		});
	return {
		allow: record.allow,
		reason: record.reason,
		via: stringValue(record.via),
		chain: Array.isArray(record.chain) ? (record.chain as IamGrantEvaluation[]) : [],
	};
}

function whoCanFrom(raw: unknown): IamWhoCan {
	const record = asRecord(raw);
	if (!record || typeof record.permission !== 'string' || !Array.isArray(record.principals))
		throw new CliError('The platform returned an unexpected who-can response.', {
			code: 'protocol',
			details: raw,
		});
	return {
		permission: record.permission,
		principals: record.principals as IamWhoCan['principals'],
	};
}

function keysViewFrom(raw: unknown): IamKeysView {
	const record = asRecord(raw);
	const policy = asRecord(record?.policy);
	if (!record || !Array.isArray(record.purposes) || !policy || !Array.isArray(policy.automaticPurposes))
		throw new CliError('The platform returned an unexpected signing-key response.', {
			code: 'protocol',
			details: raw,
		});
	const can = asRecord(record.can);
	return {
		purposes: record.purposes as IamKeyEntry[],
		policy: {
			intervalDays: typeof policy.intervalDays === 'number' ? policy.intervalDays : 30,
			overlapHours: typeof policy.overlapHours === 'number' ? policy.overlapHours : 24,
			automaticPurposes: policy.automaticPurposes.filter(
				(value): value is string => typeof value === 'string',
			),
		},
		lastRotatedAt: numberOrNull(record.lastRotatedAt),
		nextCheckAt: numberOrNull(record.nextCheckAt),
		can: { rotate: can?.rotate === true },
	};
}

function rotationsFrom(raw: unknown): IamKeyRotation[] {
	const record = asRecord(raw);
	if (!record || !Array.isArray(record.rotations))
		throw new CliError('The platform returned an unexpected key rotation response.', {
			code: 'protocol',
			details: raw,
		});
	return record.rotations.flatMap((value) => {
		const rotation = asRecord(value);
		const active = asRecord(rotation?.active);
		const next = asRecord(rotation?.next);
		if (!rotation || typeof rotation.purpose !== 'string' || typeof active?.kid !== 'string') return [];
		return [
			{
				purpose: rotation.purpose,
				active: { kid: active.kid },
				next: typeof next?.kid === 'string' ? { kid: next.kid } : null,
				retiredKid: typeof rotation.retiredKid === 'string' ? rotation.retiredKid : null,
			},
		];
	});
}

function numberOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function explainQuery(permission: string, scope: IamScopeView): string {
	const params = new URLSearchParams({ permission, resourceType: scope.type });
	if (scope.type === 'project' && scope.id) params.set('resourceId', scope.id);
	if (scope.type === 'environment') {
		if (scope.id) params.set('resourceId', scope.id);
		if (scope.projectId) params.set('projectId', scope.projectId);
	}
	return params.toString();
}

function resolveRole(value: string, roles: IamRoleView[]): IamRoleView {
	const role = roles.find((entry) => entry.id === value) ?? roles.find((entry) => entry.name === value);
	if (!role) throw new UsageError(`Unknown role "${value}". Run \`skif iam roles\` to see them.`);
	return role;
}

function resolveGroup(value: string, groups: IamGroupView[]): IamGroupView {
	const group = groups.find((entry) => entry.id === value) ?? groups.find((entry) => entry.name === value);
	if (!group) throw new UsageError(`Unknown group "${value}". Run \`skif iam groups\` to see them.`);
	return group;
}

function roleName(roleId: string, roles: IamRoleView[]): string {
	return roles.find((role) => role.id === roleId)?.name ?? roleId;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}
