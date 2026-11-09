import { readFile } from 'node:fs/promises';
import { parseArgs, rejectExtraPositionals, type FlagSpec } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { printJson } from '../output.ts';
import { asRecord, stringValue } from './iam.ts';

/**
 * Workload identity tokens (docs/IAM.md I18, §7.4; docs/CLOUD-IDENTITY.md).
 *
 * A process or container workload gets an audience-bound ES256 JWT in
 * `$YOAL_TOKEN_FILE` (`/var/run/yoal/token`). The node's metadata endpoint mints a fresh token
 * for another audience (`sts.amazonaws.com`, a GCP workload identity provider, …) when the
 * workload presents that file as a bearer token. This command only prints the token: the subject
 * credential is never included in an error or a log line.
 */

/** Mirrors `WORKLOAD_IDENTITY_AUDIENCE` in `@yoal/contracts`. */
export const WORKLOAD_IDENTITY_AUDIENCE = 'yoal';
/** Mirrors `WORKLOAD_IDENTITY_MOUNT_PATH` in `@yoal/contracts`. */
export const WORKLOAD_IDENTITY_TOKEN_FILE = '/var/run/yoal/token';
/** The agent's loopback metadata endpoint for a process workload (`YOAL_IDENTITY_URL`). */
export const WORKLOAD_IDENTITY_URL = 'http://127.0.0.1:8086';
const METADATA_TIMEOUT_MS = 15_000;

const usage = `Usage: yoal identity <command> [options]

Commands:
  token                        Mint a workload token for an audience (default: yoal)

Options:
      --audience <aud>         Token audience: yoal (default), sts.amazonaws.com, a GCP provider
                               resource name, api://AzureADTokenExchange, …
      --token-file <path>      The workload token file (default: $YOAL_TOKEN_FILE or
                               /var/run/yoal/token)
      --metadata-url <url>     The node metadata endpoint (default: $YOAL_IDENTITY_URL or
                               http://127.0.0.1:8086; containers use
                               http://host.containers.internal:8086)
      --json                   Print the whole token response, not just the token
  -h, --help                   Show this help

For the yoal audience the command prints the token file as-is. For any other audience it presents
that file to the metadata endpoint, which asks the control plane to mint a one-hour token. The
metadata endpoint is only reachable inside a workload; run this there, or pass its URL.

Examples:
  yoal identity token
  yoal identity token --audience sts.amazonaws.com
  TOKEN=$(yoal identity token --audience api://AzureADTokenExchange)`;

const tokenFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
	audience: { type: 'string' },
	'token-file': { type: 'string' },
	'metadata-url': { type: 'string' },
};

export async function identityCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first === 'help' || first === '--help' || first === '-h') {
		console.log(usage);
		return;
	}
	if (first.startsWith('-')) throw new UsageError(`Unknown option ${first}.\n\n${usage}`);
	switch (first) {
		case 'token':
			return tokenCommand(argv.slice(1));
		default:
			throw new UsageError(`Unknown identity command "${first}".\n\n${usage}`);
	}
}

export interface IdentityTokenResponse {
	access_token: string;
	expires_in: number;
	token_type: string;
}

async function tokenCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, tokenFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal identity token [--audience <aud>] [--json]');

	const audience = parseAudience(args.string('audience'));
	const tokenPath = identityTokenPath(args.string('token-file'));
	const subjectToken = await readWorkloadToken(tokenPath);

	const response =
		audience === WORKLOAD_IDENTITY_AUDIENCE
			? {
					access_token: subjectToken,
					expires_in: jwtRemainingSeconds(subjectToken) ?? 0,
					token_type: 'Bearer',
				}
			: await mintAtMetadata(
					identityMetadataUrl(args.string('metadata-url')),
					audience,
					subjectToken,
				);

	if (args.boolean('json')) printJson(response);
	else console.log(response.access_token);
}

// ---------------------------------------------------------------- pure helpers

/** The audience is a printable string of at most 512 characters, as the control plane requires. */
export function parseAudience(value: string | undefined, flag = '--audience'): string {
	const audience = value?.trim() || WORKLOAD_IDENTITY_AUDIENCE;
	if (audience.length > 512 || /[\u0000-\u001f\u007f]/.test(audience))
		throw new UsageError(`${flag} must be 1-512 printable characters.`);
	return audience;
}

/** The file the agent/helper writes: an explicit flag, then `$YOAL_TOKEN_FILE`, then the mount. */
export function identityTokenPath(
	value?: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return value?.trim() || env.YOAL_TOKEN_FILE?.trim() || WORKLOAD_IDENTITY_TOKEN_FILE;
}

/** The metadata endpoint base URL: an explicit flag, then `$YOAL_IDENTITY_URL`, then loopback. */
export function identityMetadataUrl(
	value?: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const raw = value?.trim() || env.YOAL_IDENTITY_URL?.trim() || WORKLOAD_IDENTITY_URL;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new UsageError(`--metadata-url "${raw}" is not a URL.`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
		throw new UsageError('--metadata-url must be an http or https URL.');
	return raw.replace(/\/+$/, '');
}

/** The remaining lifetime of a JWT, in seconds, or null when the payload has no numeric `exp`. */
export function jwtRemainingSeconds(token: string, now = Date.now()): number | null {
	const part = token.split('.')[1];
	if (!part) return null;
	try {
		const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
			exp?: unknown;
		};
		if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;
		return Math.max(0, Math.ceil(claims.exp - now / 1000));
	} catch {
		return null;
	}
}

export function parseIdentityTokenResponse(value: unknown): IdentityTokenResponse {
	const record = asRecord(value);
	const accessToken = stringValue(record?.access_token);
	if (!record || !accessToken)
		throw new CliError('The workload identity endpoint returned an unexpected response.', {
			code: 'protocol',
		});
	const expiresIn =
		typeof record.expires_in === 'number' && Number.isFinite(record.expires_in)
			? record.expires_in
			: 0;
	return {
		access_token: accessToken,
		expires_in: expiresIn,
		token_type: stringValue(record.token_type) ?? 'Bearer',
	};
}

// ---------------------------------------------------------------- I/O

async function readWorkloadToken(path: string): Promise<string> {
	let token: string;
	try {
		token = (await readFile(path, 'utf8')).trim();
	} catch (error) {
		throw new CliError(`Could not read the workload token file ${path}.`, {
			code: 'io',
			cause: error,
			suggestions: [
				'Run this inside a process or container workload, or pass --token-file / set YOAL_TOKEN_FILE.',
			],
		});
	}
	if (!token)
		throw new CliError(`The workload token file ${path} is empty.`, {
			code: 'io',
			suggestions: ['Wait for the agent to write the token, or redeploy the workload.'],
		});
	return token;
}

async function mintAtMetadata(
	baseUrl: string,
	audience: string,
	subjectToken: string,
): Promise<IdentityTokenResponse> {
	const url = `${baseUrl}/identity/token?${new URLSearchParams({ audience }).toString()}`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${subjectToken}`,
			},
			cache: 'no-store',
			signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
		});
	} catch (error) {
		// The URL and headers are safe to report; the subject token in the header is not.
		throw new CliError(`Could not reach the workload identity endpoint at ${baseUrl}.`, {
			code: 'network',
			cause: error,
			suggestions: [
				'Check YOAL_IDENTITY_URL: a process app uses http://127.0.0.1:8086 and a container uses http://host.containers.internal:8086.',
			],
		});
	}

	const text = await response.text().catch(() => '');
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = null;
	}
	if (!response.ok) {
		const record = asRecord(body);
		const code = stringValue(record?.error) ?? `http_${response.status}`;
		throw new CliError(`The workload identity endpoint refused the request (${code}).`, {
			code: 'identity_rejected',
			suggestions: [
				'Check that the workload token file is current and the workload service account is enabled.',
			],
		});
	}
	return parseIdentityTokenResponse(body);
}
