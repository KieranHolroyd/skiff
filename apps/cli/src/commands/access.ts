import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import type { ApiClient } from '../api.ts';
import { CliError, UsageError } from '../errors.ts';
import { formatTime, printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import {
	asRecord,
	formatScope,
	parseExpiry,
	parseScope,
	requestJson,
	stringValue,
	type IamScopeView,
} from './iam.ts';

/**
 * Just-in-time access (docs/IAM.md I22, §9.4, §12). Anyone in the org may request a role at a
 * scope for a duration; someone else with `iam:manage-bindings` at that scope approves or denies.
 * This is the `skif access` client over `/api/v1/iam/access-requests`.
 */

const usage = `Usage: skif access <command> [options]

Commands:
  request                      Ask for a role at a scope for a few hours
  approve <id>                 Grant a pending request (never your own)
  deny <id>                    Refuse a pending request with its reason on record

Request options:
      --role <name|id>         The role to ask for
      --scope <scope>          org (default), project:<id> or environment:<project>/<id>
      --duration <when>        How long the grant should last, e.g. 1h, 4h, 8h (max: 8h)
      --reason <text>          What you will do, and why now (at least 3 characters)
      --change-ref <ref>       A ticket, deploy or incident id (optional)

Options:
      --json                   JSON output
  -h, --help                   Show this help

Approving creates a binding that expires on its own. The approver must differ from the requester.

Examples:
  skif access request --role deployer --scope project:prj_shop --duration 2h --reason "release"
  skif access approve req_abc123
  skif access deny req_abc123`;

export interface AccessRequestView {
	id: string;
	requesterId: string;
	roleId: string;
	roleName: string;
	scope: IamScopeView;
	durationSeconds: number;
	reason: string;
	status: string;
	decidedBy: string | null;
	decidedAt: number | null;
	bindingId: string | null;
	expiresAt: number | null;
	createdAt: number;
}

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const requestFlags: FlagSpec = {
	...baseFlags,
	role: { type: 'string' },
	scope: { type: 'string' },
	duration: { type: 'string' },
	reason: { type: 'string' },
	'change-ref': { type: 'string' },
};

/** The server's own cap (`MAX_DURATION_SECONDS` in @skiff/core). */
const MAX_DURATION_SECONDS = 8 * 60 * 60;

export async function accessCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first === 'help' || first === '--help' || first === '-h') {
		console.log(usage);
		return;
	}
	if (first.startsWith('-')) throw new UsageError(`Unknown option ${first}.\n\n${usage}`);
	switch (first) {
		case 'request':
		case 'ask':
			return requestAccess(argv.slice(1));
		case 'approve':
			return decideAccess(argv.slice(1), 'approve');
		case 'deny':
			return decideAccess(argv.slice(1), 'deny');
		default:
			throw new UsageError(`Unknown access command "${first}".\n\n${usage}`);
	}
}

async function requestAccess(argv: string[]): Promise<void> {
	const args = parseArgs(argv, requestFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif access request --role <role> --reason <text> [options]');
	const roleValue = args.string('role');
	if (!roleValue) throw new UsageError('Say which role you need with --role <name|id>.');
	const reason = args.string('reason')?.trim();
	if (!reason || reason.length < 3)
		throw new UsageError('Give a reason with --reason <text> (at least 3 characters).');
	const scope = parseScope(args.string('scope') ?? 'org', '--scope');
	const durationSeconds = parseDurationSeconds(args.string('duration'));

	const client = await authenticatedClient();
	const role = await resolveRole(client, roleValue);
	const body: Record<string, unknown> = {
		roleId: role.id,
		scope,
		durationSeconds,
		reason,
	};
	const changeRef = args.string('change-ref');
	if (changeRef) body.changeRef = changeRef;

	const raw = await requestJson(client, 'POST', '/api/v1/iam/access-requests', body);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const request = asAccessRequest(raw);
	if (!request)
		throw new CliError('The platform returned an unexpected access request response.', {
			code: 'protocol',
			details: raw,
		});
	console.log(
		`Requested ${role.name} at ${formatScope(scope)} for ${formatDuration(request.durationSeconds)} (${request.id}).`,
	);
	console.log('A different approver must decide it. Check with `skif access approve|deny <id>`.');
}

async function decideAccess(argv: string[], action: 'approve' | 'deny'): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, `Usage: skif access ${action} <id>`);
	const id = requirePositional(args, 0, `access request id.\n\n${usage}`);
	const client = await authenticatedClient();
	const raw = await requestJson(
		client,
		'POST',
		`/api/v1/iam/access-requests/${encodeURIComponent(id)}/${action}`,
	);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const request = asAccessRequest(raw);
	if (!request)
		throw new CliError('The platform returned an unexpected access request response.', {
			code: 'protocol',
			details: raw,
		});
	if (action === 'approve') {
		const until = request.expiresAt === null ? 'its expiry' : formatTime(request.expiresAt);
		console.log(
			`Approved ${request.roleName} for ${request.requesterId}; the grant expires ${until}.`,
		);
	} else {
		console.log(`Denied ${request.roleName} for ${request.requesterId}.`);
	}
}

// ---------------------------------------------------------------- pure helpers

export function parseDurationSeconds(value: string | undefined, now = Date.now()): number {
	if (!value) return 3600;
	const seconds = Math.max(1, Math.round((parseExpiry(value, now) - now) / 1000));
	if (seconds > MAX_DURATION_SECONDS)
		throw new UsageError('A just-in-time grant lasts at most eight hours.');
	return seconds;
}

export function formatDuration(seconds: number): string {
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

// ---------------------------------------------------------------- wire helpers

async function resolveRole(
	client: ApiClient,
	value: string,
): Promise<{ id: string; name: string }> {
	const record = asRecord(await requestJson(client, 'GET', '/api/v1/iam'));
	const raw = record?.roles;
	if (!Array.isArray(raw))
		throw new CliError('The platform returned an unexpected IAM response.', {
			code: 'protocol',
			details: record,
		});
	const roles = raw.flatMap((entry) => {
		const role = asRecord(entry);
		const id = stringValue(role?.id);
		const name = stringValue(role?.name);
		return id && name ? [{ id, name }] : [];
	});
	const role = roles.find((entry) => entry.id === value) ?? roles.find((entry) => entry.name === value);
	if (!role) throw new UsageError(`Unknown role "${value}". Run \`skif iam roles\` to see them.`);
	return role;
}

function asAccessRequest(value: unknown): AccessRequestView | undefined {
	const record = asRecord(value);
	const id = stringValue(record?.id);
	const roleId = stringValue(record?.roleId);
	if (!record || !id || !roleId) return undefined;
	return {
		id,
		requesterId: stringValue(record.requesterId) ?? '',
		roleId,
		roleName: stringValue(record.roleName) ?? roleId,
		scope: (asRecord(record.scope) ?? { type: 'org' }) as unknown as IamScopeView,
		durationSeconds: typeof record.durationSeconds === 'number' ? record.durationSeconds : 0,
		reason: stringValue(record.reason) ?? '',
		status: stringValue(record.status) ?? 'pending',
		decidedBy: stringValue(record.decidedBy) ?? null,
		decidedAt: typeof record.decidedAt === 'number' ? record.decidedAt : null,
		bindingId: stringValue(record.bindingId) ?? null,
		expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : null,
		createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
	};
}
