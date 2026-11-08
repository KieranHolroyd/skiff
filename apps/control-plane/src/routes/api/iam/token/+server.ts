import type { RequestHandler } from './$types';
import { StsError, TOKEN_EXCHANGE_GRANT, type TokenExchangeInput } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { json } from '#lib/server/api.js';

/**
 * RFC 8693 token exchange (docs/IAM.md §7.3, I16–I17).
 *
 *   POST /api/iam/token
 *   grant_type=urn:ietf:params:oauth:grant-type:token-exchange
 *   subject_token=<Skiff/GitHub/any trusted OIDC token>
 *   [subject_token_type=urn:ietf:params:oauth:token-type:...]
 *   [audience=<requested audience>] [scope=<space-separated permissions>]
 *
 * The endpoint is unauthenticated in the RFC sense: the subject token is the credential. Errors
 * use the RFC 8693 shapes (`invalid_request` / `invalid_grant`) and never leak key or trust detail.
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const params = await readParams(request);
		const grantType = params.get('grant_type')?.trim();
		if (grantType !== TOKEN_EXCHANGE_GRANT)
			throw new StsError(
				'invalid_request',
				`grant_type must be ${TOKEN_EXCHANGE_GRANT}.`,
			);
		const subjectToken = params.get('subject_token')?.trim();
		if (!subjectToken) throw new StsError('invalid_request', 'subject_token is required.');

		const subjectTokenType = params.get('subject_token_type')?.trim();
		if (subjectTokenType && !SUBJECT_TOKEN_TYPES.has(subjectTokenType))
			throw new StsError(
				'invalid_request',
				`Unsupported subject_token_type ${subjectTokenType}.`,
			);

		const input: TokenExchangeInput = {
			subjectToken,
			...(params.get('audience')?.trim() ? { audience: params.get('audience')!.trim() } : {}),
			...(params.get('scope')?.trim() ? { scope: params.get('scope')!.trim() } : {}),
			...(params.get('trust_id')?.trim() ? { trustId: params.get('trust_id')!.trim() } : {}),
		};
		const result = await core.ctx.sts.exchange(input);
		return json(result, 200, { 'cache-control': 'no-store' });
	} catch (error) {
		if (error instanceof StsError)
			return json(
				{ error: error.code, error_description: error.message },
				400,
				{ 'cache-control': 'no-store' },
			);
		console.error('[sts]', error);
		return json(
			{ error: 'server_error', error_description: 'Token exchange failed.' },
			500,
			{ 'cache-control': 'no-store' },
		);
	}
};

const SUBJECT_TOKEN_TYPES = new Set([
	'urn:ietf:params:oauth:token-type:access_token',
	'urn:ietf:params:oauth:token-type:jwt',
	'urn:ietf:params:oauth:token-type:id_token',
]);

/** Token endpoints take `application/x-www-form-urlencoded`; JSON is accepted for convenience. */
async function readParams(request: Request): Promise<URLSearchParams> {
	const contentType = request.headers.get('content-type') ?? '';
	if (contentType.includes('application/json')) {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		if (!body || typeof body !== 'object')
			throw new StsError('invalid_request', 'The request body must be valid JSON.');
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(body)) {
			if (typeof value === 'string') params.set(key, value);
		}
		return params;
	}
	const text = await request.text().catch(() => '');
	return new URLSearchParams(text);
}
