import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import type { ApiClient } from '../api.ts';
import { CliError, UsageError } from '../errors.ts';
import { printJson, renderTable } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { asRecord, parseScope, requestJson, stringValue } from './iam.ts';

/**
 * Skiff Access policies (docs/IAM.md I25, §11.1; docs/API.md §Access policies). A policy is an
 * ordered allow/deny list; assigning it turns the `access` protection mode on for a project scope.
 * `assign` uses the existing `POST /projects/:slug/access` route with `mode: "access"`. Every check
 * lives on the server.
 */

const usage = `Usage: skif access-policy <command> [options]

Commands:
  list [list]                  Policies you can read (--project to narrow by project id)
  create <name>                Create a policy (--scope, --description, --rule …)
  assign <name|id>             Turn Skiff Access on for a project scope (--project, --scope)

Create options:
      --scope <where>          org, project:<id> or environment:<project>/<id> (required)
      --description <text>     A note shown in the list and dashboard
      --rule <rule>            One rule, repeatable and kept in order. Forms:
                                 allow|deny member
                                 allow|deny group <group id>
                                 allow|deny email <address>
                                 allow|deny domain <example.com>
                                 allow|deny sso <provider id>
                                 allow|deny pool <pool id>[:group,…]
                                 allow|deny cidr <10.0.0.0/8>[,<cidr>]
                               A matching deny beats every allow; no match denies.

Assign options:
  -p, --project <slug>         The project whose scope changes (required)
      --scope <scope>          production (default) or previews
                               Named-environment assignment has no REST route yet; use the dashboard.

Options:
      --project <id>           list: only policies that apply to this project id
      --json                   JSON output
  -h, --help                   Show this help

Assigning writes \`access\` to the scope's protection mode and points it at the policy. To turn it
off again, set that scope back to public, password or platform with \`skif projects\` or the dashboard.
Creating an environment-scoped policy needs the environment's project id.

Examples:
  skif access-policy create staff-only --scope org --rule "allow group grp_eng"
  skif access-policy create office --scope project:prj_abc --rule "allow cidr 10.0.0.0/8"
  skif access-policy assign staff-only --project api --scope production`;

export interface AccessPolicyRuleView {
	idx: number;
	action: string;
	matcher: Record<string, unknown>;
}

export interface AccessPolicyView {
	id: string;
	orgId: string;
	name: string;
	description: string;
	scope: { type: string; id?: string; projectId?: string };
	enabled: boolean;
	rules: AccessPolicyRuleView[];
	createdAt: number;
	updatedAt: number;
}

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const listFlags: FlagSpec = { ...baseFlags, project: { type: 'string' } };
const createFlags: FlagSpec = {
	...baseFlags,
	scope: { type: 'string' },
	description: { type: 'string' },
	rule: { type: 'string', multiple: true },
};
const assignFlags: FlagSpec = {
	...baseFlags,
	project: { type: 'string', short: 'p' },
	scope: { type: 'string' },
};

export async function accessPoliciesCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first === 'help' || first === '--help' || first === '-h') {
		console.log(usage);
		return;
	}
	if (first.startsWith('-')) return listPolicies(argv);
	switch (first) {
		case 'list':
		case 'ls':
			return listPolicies(argv.slice(1));
		case 'create':
		case 'add':
			return createPolicy(argv.slice(1));
		case 'assign':
		case 'attach':
			return assignPolicy(argv.slice(1));
		default:
			throw new UsageError(`Unknown access-policy command "${first}".\n\n${usage}`);
	}
}

async function listPolicies(argv: string[]): Promise<void> {
	const args = parseArgs(argv, listFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif access-policy [list] [--project <id>] [--json]');
	const client = await authenticatedClient();
	const policies = await fetchPolicies(client, args.string('project'));
	if (args.boolean('json')) {
		printJson({ accessPolicies: policies });
		return;
	}
	if (policies.length === 0) {
		console.log('No access policies yet. Create one with `skif access-policy create <name> --scope org`.');
		return;
	}
	console.log(policyTable(policies));
}

async function createPolicy(argv: string[]): Promise<void> {
	const args = parseArgs(argv, createFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif access-policy create <name> --scope <where> [--description <text>] [--rule …]');
	const name = requirePositional(args, 0, `policy name.\n\n${usage}`);
	const scopeValue = args.string('scope');
	if (!scopeValue) throw new UsageError('Say where with --scope org, project:<id> or environment:<project>/<id>.');
	const rules = args.strings('rule').map((value, index) => parsePolicyRule(value, index));
	const body: Record<string, unknown> = {
		name,
		scope: parsePolicyScope(scopeValue),
		enabled: true,
		rules,
	};
	const description = args.string('description');
	if (description) body.description = description;

	const client = await authenticatedClient();
	const raw = await requestJson(client, 'POST', '/api/v1/access-policies', body);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const policy = asPolicy(raw);
	if (!policy)
		throw new CliError('The platform returned an unexpected access policy response.', {
			code: 'protocol',
			details: raw,
		});
	console.log(
		`Created access policy "${policy.name}" (${policy.id}) at ${formatPolicyScope(policy.scope)} with ${policy.rules.length} rule${policy.rules.length === 1 ? '' : 's'}.`,
	);
	console.log(`Assign it with: skif access-policy assign ${policy.name} --project <slug>`);
}

async function assignPolicy(argv: string[]): Promise<void> {
	const args = parseArgs(argv, assignFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif access-policy assign <name|id> --project <slug> [--scope production|previews]');
	const value = requirePositional(args, 0, `policy name or id.\n\n${usage}`);
	const project = args.string('project');
	if (!project) throw new UsageError('Name the project with --project <slug>.');
	const scope = args.string('scope') ?? 'production';
	if (scope !== 'production' && scope !== 'previews')
		throw new UsageError('--scope must be production or previews. Named-environment assignment has no REST route yet.');

	const client = await authenticatedClient();
	const policy = resolvePolicy(await fetchPolicies(client), value);
	const raw = await requestJson(
		client,
		'POST',
		`/api/v1/projects/${encodeURIComponent(project)}/access`,
		{ scope, mode: 'access', policyId: policy.id },
	);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Assigned "${policy.name}" (${policy.id}) to ${project} ${scope}.`);
	console.log('The scope now uses the access protection mode; visitors must match an allow rule.');
}

// ---------------------------------------------------------------- pure helpers

export function policyTable(policies: AccessPolicyView[]): string {
	const rows = policies.map((policy) => [
		policy.id,
		policy.name,
		formatPolicyScope(policy.scope),
		policy.enabled ? 'enabled' : 'disabled',
		String(policy.rules.length),
		policy.description || '-',
	]);
	return renderTable(['ID', 'NAME', 'SCOPE', 'STATE', 'RULES', 'DESCRIPTION'], rows);
}

export function resolvePolicy(policies: AccessPolicyView[], value: string): AccessPolicyView {
	const policy =
		policies.find((entry) => entry.id === value) ?? policies.find((entry) => entry.name === value);
	if (!policy)
		throw new UsageError(`Unknown access policy "${value}". Run \`skif access-policy\` to see them.`);
	return policy;
}

export function formatPolicyScope(scope: AccessPolicyView['scope']): string {
	if (scope.type === 'org') return 'org';
	if (scope.type === 'project') return `project:${scope.id ?? '?'}`;
	if (scope.type === 'environment')
		return `environment:${scope.projectId ?? '?'}/${scope.id ?? '?'}`;
	return scope.id ? `${scope.type}:${scope.id}` : scope.type;
}

function parsePolicyScope(value: string): { type: string; id?: string; projectId?: string } {
	const scope = parseScope(value, '--scope');
	if (scope.type === 'platform')
		throw new UsageError('An access policy applies at org, project or environment scope, not platform.');
	return scope.type === 'environment'
		? { type: scope.type, id: scope.id, projectId: scope.projectId }
		: scope.type === 'project'
			? { type: scope.type, id: scope.id }
			: { type: scope.type };
}

/** `allow|deny <matcher> …` into the contract's matcher shape. Kept in input order. */
export function parsePolicyRule(value: string, idx = 0): AccessPolicyRuleView {
	const parts = value.trim().split(/\s+/);
	const action = parts.shift();
	if (action !== 'allow' && action !== 'deny')
		throw new UsageError(`A rule starts with allow or deny, not "${action ?? ''}".`);
	const kind = parts.shift()?.toLowerCase();
	if (!kind) throw new UsageError('A rule needs a matcher, e.g. `allow member`.');
	const rest = parts.join(' ').trim();

	const matcher = (): Record<string, unknown> => {
		switch (kind) {
			case 'member':
			case 'any-member':
			case 'anymember':
				return { type: 'anyMember' };
			case 'group':
				return { type: 'orgGroup', groupId: required(rest, 'a group id') };
			case 'email':
				return { type: 'email', email: required(rest, 'an email address').toLowerCase() };
			case 'domain':
				return { type: 'emailDomain', domain: required(rest, 'a domain').toLowerCase() };
			case 'sso':
				return { type: 'ssoProvider', providerId: required(rest, 'a provider id') };
			case 'pool': {
				const [poolId, groups = ''] = rest.split(':');
				return {
					type: 'userPool',
					poolId: required(poolId ?? '', 'a pool id'),
					groups: groups
						.split(',')
						.map((entry) => entry.trim())
						.filter((entry) => entry.length > 0),
				};
			}
			case 'cidr': {
				const cidrs = rest
					.split(',')
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0);
				if (cidrs.length === 0) throw new UsageError('A cidr rule needs at least one network.');
				return { type: 'cidr', cidrs };
			}
			default:
				throw new UsageError(
					`Unknown matcher "${kind}". Use member, group, email, domain, sso, pool or cidr.`,
				);
		}
	};

	return { idx, action, matcher: matcher() };
}

function required(value: string | undefined, what: string): string {
	if (!value) throw new UsageError(`This rule needs ${what}.`);
	return value;
}

// ---------------------------------------------------------------- wire helpers

async function fetchPolicies(client: ApiClient, projectId?: string): Promise<AccessPolicyView[]> {
	const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
	const response = await requestJson(client, 'GET', `/api/v1/access-policies${query}`);
	// The list route returns a bare array; accept a wrapped `{ accessPolicies }` too, so the CLI
	// keeps working if the envelope is added later.
	const raw = Array.isArray(response) ? response : asRecord(response)?.accessPolicies;
	if (!Array.isArray(raw))
		throw new CliError('The platform returned an unexpected access policy response.', {
			code: 'protocol',
			details: response,
		});
	return raw.map((entry) => {
		const policy = asPolicy(entry);
		if (!policy)
			throw new CliError('The platform returned an unexpected access policy entry.', {
				code: 'protocol',
				details: entry,
			});
		return policy;
	});
}

function asPolicy(value: unknown): AccessPolicyView | undefined {
	const record = asRecord(value);
	const id = stringValue(record?.id);
	const name = stringValue(record?.name);
	const scope = asRecord(record?.scope);
	if (!record || !id || !name || !scope) return undefined;
	return {
		id,
		orgId: stringValue(record.orgId) ?? '',
		name,
		description: stringValue(record.description) ?? '',
		scope: {
			type: stringValue(scope.type) ?? 'org',
			...(stringValue(scope.id) ? { id: stringValue(scope.id) } : {}),
			...(stringValue(scope.projectId) ? { projectId: stringValue(scope.projectId) } : {}),
		},
		enabled: record.enabled !== false,
		rules: Array.isArray(record.rules)
			? record.rules.map((entry, index) => {
					const rule = asRecord(entry);
					return {
						idx: typeof rule?.idx === 'number' ? rule.idx : index,
						action: stringValue(rule?.action) ?? 'deny',
						matcher: asRecord(rule?.matcher) ?? {},
					};
				})
			: [],
		createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
		updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
	};
}
