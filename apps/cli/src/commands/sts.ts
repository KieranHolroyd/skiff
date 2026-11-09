import { readFile } from 'node:fs/promises';
import { parseArgs, rejectExtraPositionals, type FlagSpec } from '../args.ts';
import { ApiError, CliError, UsageError } from '../errors.ts';
import { printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { asRecord, stringValue } from './iam.ts';
import { parseAudience } from './identity.ts';

/**
 * RFC 8693 token exchange (docs/IAM.md I16–I17, §7.3; docs/CLOUD-IDENTITY.md).
 *
 * The subject token is the credential, so `/api/iam/token` takes no session or API key. The CLI
 * still uses the active platform URL (and sends the configured key, which the endpoint ignores).
 * The subject token is read from a file and never printed or included in an error.
 */

/** Mirrors the token endpoint's grant and token-type constants in `@skiff/core`. */
export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';

const usage = `Usage: skif sts <command> [options]

Commands:
  exchange                     Exchange a subject token for a short-lived Skiff access token

Options:
      --subject-token-file <path>  File holding the subject JWT (required; never printed)
      --audience <aud>             Requested audience of the new token (required)
      --scope <permission>         Narrow the trust's permissions; repeat or comma-separate
      --trust-id <id>              Use one federation trust instead of the first match
      --json                       Print the whole token response, not just the token
  -h, --help                       Show this help

The call is POST /api/iam/token with grant_type
urn:ietf:params:oauth:grant-type:token-exchange. The subject token may be a Skiff workload JWT,
a pipeline OIDC token, a GitHub Actions OIDC token or any token from an issuer with a federation
trust. The response token lasts 15 minutes by default (at most 1 hour) and is narrowed by the
trust's restriction and --scope. The subject token is the credential: treat the file like a
password and keep the platform URL on TLS.

Examples:
  skif sts exchange --subject-token-file $SKIFF_TOKEN_FILE --audience https://control.example.com
  skif sts exchange --subject-token-file /tmp/github.jwt --audience skiff --scope project:read`;

const exchangeFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
	'subject-token-file': { type: 'string' },
	audience: { type: 'string' },
	scope: { type: 'string', multiple: true },
	'trust-id': { type: 'string' },
};

export async function stsCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first === 'help' || first === '--help' || first === '-h') {
		console.log(usage);
		return;
	}
	if (first.startsWith('-')) throw new UsageError(`Unknown option ${first}.\n\n${usage}`);
	switch (first) {
		case 'exchange':
			return exchangeCommand(argv.slice(1));
		default:
			throw new UsageError(`Unknown sts command "${first}".\n\n${usage}`);
	}
}

export interface StsTokenResponse {
	access_token: string;
	issued_token_type: string;
	token_type: string;
	expires_in: number;
}

export interface TokenExchangeRequest {
	subjectToken: string;
	audience: string;
	scope?: string;
	trustId?: string;
}

async function exchangeCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, exchangeFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(
		args,
		0,
		'Usage: skif sts exchange --subject-token-file <path> --audience <a> [--scope <p>] [--json]',
	);

	const file = args.string('subject-token-file')?.trim();
	if (!file)
		throw new UsageError('Pass --subject-token-file <path>: the exchange needs a subject JWT.');
	const audienceValue = args.string('audience')?.trim();
	if (!audienceValue)
		throw new UsageError('Pass --audience <aud>: the audience of the token to mint.');
	const audience = parseAudience(audienceValue);
	const subjectToken = await readSubjectToken(file);
	const scope = parseExchangeScopes(args.strings('scope'));
	const trustId = args.string('trust-id')?.trim();

	const body = buildTokenExchangeBody({
		subjectToken,
		audience,
		...(scope ? { scope } : {}),
		...(trustId ? { trustId } : {}),
	});

	const client = await authenticatedClient();
	let response: Response;
	try {
		response = await client.raw('POST', '/api/iam/token', {
			body: body.toString(),
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
		});
	} catch (error) {
		throw explainExchangeFailure(error);
	}

	const text = await response.text();
	let raw: unknown = null;
	try {
		raw = text ? JSON.parse(text) : null;
	} catch {
		raw = null;
	}
	const token = parseStsResponse(raw);
	if (args.boolean('json')) printJson(token);
	else console.log(token.access_token);
}

// ---------------------------------------------------------------- pure helpers

/** `--scope a,b --scope "c d"` into the space-separated scope the endpoint takes. */
export function parseExchangeScopes(values: string[]): string {
	const scopes = values
		.flatMap((value) => value.split(/[\s,]+/))
		.map((value) => value.trim())
		.filter(Boolean);
	if (values.length > 0 && scopes.length === 0)
		throw new UsageError('--scope needs at least one permission, e.g. --scope project:read.');
	return [...new Set(scopes)].join(' ');
}

/** The form body for `POST /api/iam/token`; only present optional fields are sent. */
export function buildTokenExchangeBody(input: TokenExchangeRequest): URLSearchParams {
	const body = new URLSearchParams({
		grant_type: TOKEN_EXCHANGE_GRANT,
		subject_token: input.subjectToken,
		subject_token_type: JWT_TOKEN_TYPE,
		audience: input.audience,
	});
	if (input.scope) body.set('scope', input.scope);
	if (input.trustId) body.set('trust_id', input.trustId);
	return body;
}

export function parseStsResponse(value: unknown): StsTokenResponse {
	const record = asRecord(value);
	const accessToken = stringValue(record?.access_token);
	if (!record || !accessToken)
		throw new CliError('The token endpoint returned an unexpected response.', {
			code: 'protocol',
		});
	return {
		access_token: accessToken,
		issued_token_type: stringValue(record.issued_token_type) ?? '',
		token_type: stringValue(record.token_type) ?? 'Bearer',
		expires_in:
			typeof record.expires_in === 'number' && Number.isFinite(record.expires_in)
				? record.expires_in
				: 0,
	};
}

/** RFC 8693 errors are `{ error, error_description }`; show both, never the request body. */
export function stsErrorText(value: unknown): string | null {
	const record = asRecord(value);
	const code = stringValue(record?.error);
	const description = stringValue(record?.error_description);
	if (!code && !description) return null;
	return [code, description].filter(Boolean).join(': ');
}

// ---------------------------------------------------------------- I/O

async function readSubjectToken(path: string): Promise<string> {
	let token: string;
	try {
		token = (await readFile(path, 'utf8')).trim();
	} catch (error) {
		throw new CliError(`Could not read the subject token file ${path}.`, {
			code: 'io',
			cause: error,
			suggestions: ['Pass --subject-token-file <path>; the file must contain one signed JWT.'],
		});
	}
	if (!token)
		throw new CliError(`The subject token file ${path} is empty.`, {
			code: 'io',
			suggestions: ['Write the subject JWT to the file first, then retry.'],
		});
	return token;
}

function explainExchangeFailure(error: unknown): unknown {
	if (!(error instanceof ApiError)) return error;
	const text = stsErrorText(error.body);
	if (!text) return error;
	return new CliError(`Token exchange rejected: ${text}`, {
		code: 'sts_rejected',
		suggestions: [
			'Check the issuer, audience and subject pattern of the federation trust, and that the service account is enabled.',
		],
	});
}
