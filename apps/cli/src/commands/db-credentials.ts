import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import {
	DATABASE_NAMED_CREDENTIAL_ROLES,
	databaseCredentialTable,
	type DatabaseNamedCredentialRole,
} from '../databases.ts';
import { formatTime, printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * `yoal db credentials <verb>`: named Postgres credentials (docs/DATABASES.md §16). Listing,
 * creating, rotating and revoking return metadata only; `reveal` prints one password and is
 * audited exactly like `yoal db credentials <name>`.
 */

export const credentialVerbs = ['list', 'create', 'rotate', 'revoke', 'reveal'] as const;

export const credentialsUsage = `Usage: yoal db credentials <name>                 Print the owner connection URL
       yoal db credentials list <name>            List credentials (owner, monitor, named)
       yoal db credentials create <name> --role <app|readonly|backup> [--purpose <text>] [--expires <ISO time>]
       yoal db credentials rotate <name> <id>     New password; apps attached with it restart once the node confirms
       yoal db credentials revoke <name> <id>     Disable the role's login (asks first; refused while attached)
       yoal db credentials reveal <name> <id>     Print the password (audited; never over MCP)

Roles: app reads and writes tables in the public schema, readonly can only SELECT, backup reads
for dumps. Connect an app with one: yoal db attach <name> --project <slug> --credential <id|role>.

Options:
  -y, --yes                    Don't ask before revoking (required when stdin isn't a terminal)
      --json                   JSON output
  -h, --help                   Show this help`;

const flags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
	yes: { type: 'boolean', short: 'y' },
	role: { type: 'string' },
	purpose: { type: 'string' },
	expires: { type: 'string' },
};

/** True when `argv` (after `credentials`) starts with a verb followed by a database name. */
export function isCredentialVerb(argv: string[]): boolean {
	const positionals = argv.filter((token) => !token.startsWith('-'));
	return (credentialVerbs as readonly string[]).includes(positionals[0] ?? '') && positionals.length >= 2;
}

export async function credentialsCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help')) {
		console.log(credentialsUsage);
		return;
	}
	const verb = args.positionals[0] as (typeof credentialVerbs)[number];
	const name = requirePositional(args, 1, `database name.\n\n${credentialsUsage}`);
	const json = args.boolean('json');
	const client = await authenticatedClient();

	if (verb === 'list') {
		rejectExtraPositionals(args, 2, 'Usage: yoal db credentials list <name>');
		const { credentials, raw } = await client.listDatabaseCredentials(name);
		if (json) return printJson(raw);
		console.log(databaseCredentialTable(credentials));
		return;
	}

	if (verb === 'create') {
		rejectExtraPositionals(args, 2, 'Usage: yoal db credentials create <name> --role <role>');
		const role = args.string('role') ?? 'app';
		if (!(DATABASE_NAMED_CREDENTIAL_ROLES as readonly string[]).includes(role))
			throw new UsageError(`--role must be one of ${DATABASE_NAMED_CREDENTIAL_ROLES.join(', ')}.`);
		const expires = args.string('expires');
		let expiresAt: string | undefined;
		if (expires !== undefined) {
			const parsed = Date.parse(expires);
			if (Number.isNaN(parsed)) throw new UsageError('--expires must be an ISO date or time, e.g. 2026-12-31T00:00:00Z.');
			expiresAt = new Date(parsed).toISOString();
		}
		const purpose = args.string('purpose');
		const { credential, raw } = await client.createDatabaseCredential(name, {
			role: role as DatabaseNamedCredentialRole,
			...(purpose ? { purpose } : {}),
			...(expiresAt ? { expiresAt } : {}),
		});
		if (json) return printJson(raw);
		console.log(`Created ${credential.role} credential ${credential.id} (${credential.username}); the node provisions it next.`);
		console.log(`Use it from an app: yoal db attach ${name} --project <slug> --credential ${credential.id}`);
		return;
	}

	const line = `Usage: yoal db credentials ${verb} <name> <id>`;
	rejectExtraPositionals(args, 3, line);
	const id = requirePositional(args, 2, `credential id.\n\n${line}`);

	if (verb === 'rotate') {
		const { credential, raw } = await client.rotateDatabaseCredential(name, id);
		if (json) return printJson(raw);
		console.log(
			`Rotating ${credential.username}. The node applies the new password first; apps attached with it then restart with it.`,
		);
		return;
	}

	if (verb === 'revoke') {
		const confirmed = await confirmOrRefuse(
			`Revoke credential ${id} on "${name}"? Anything still connecting with it is locked out. [y/N] `,
			{
				yes: args.boolean('yes'),
				refusal: `Not confirmed: stdin is not a terminal, so there's no one to ask before revoking ${id}.`,
			},
		);
		if (!confirmed) {
			console.error('Cancelled. Nothing was changed.');
			process.exitCode = 1;
			return;
		}
		const { credential, raw } = await client.revokeDatabaseCredential(name, id);
		if (json) return printJson(raw);
		console.log(`Revoking ${credential.username} (${credential.status}). The node disables its login on its next pull.`);
		return;
	}

	// reveal: the password alone on stdout, so it can be piped.
	const { credential, raw } = await client.revealDatabaseCredential(name, id);
	if (json) return printJson(raw);
	console.log(credential.password);
	if (process.stderr.isTTY)
		process.stderr.write(
			`${credential.role} credential ${credential.username}${credential.expiresAt ? `, expires ${formatTime(credential.expiresAt)}` : ''}. This read is audited.\n`,
		);
}
