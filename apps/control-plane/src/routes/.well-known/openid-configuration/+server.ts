import type { RequestHandler } from './$types';
import { ACCESS_TOKEN_TYPE, JWT_TOKEN_TYPE, ID_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT } from '@yoal/core';
import { core } from '#lib/server/core.js';

/** OIDC discovery for the platform issuer (docs/IAM.md §7.3, I15–I17). */
export const GET: RequestHandler = () => {
	const issuer = core.ctx.signingKeys.issuer();
	return Response.json(
		{
			issuer,
			jwks_uri: `${issuer}/.well-known/jwks.json`,
			token_endpoint: `${issuer}/api/iam/token`,
			response_types_supported: ['id_token'],
			subject_types_supported: ['public'],
			id_token_signing_alg_values_supported: ['ES256'],
			token_endpoint_auth_methods_supported: ['none'],
			grant_types_supported: [TOKEN_EXCHANGE_GRANT],
			subject_token_types_supported: [ACCESS_TOKEN_TYPE, JWT_TOKEN_TYPE, ID_TOKEN_TYPE],
			scopes_supported: ['openid'],
			claims_supported: [
				'iss',
				'sub',
				'aud',
				'exp',
				'iat',
				'nbf',
				'jti',
				'scope',
				'org_id',
				'trust_id',
				'act',
			],
		},
		{
			headers: {
				'cache-control': 'public, max-age=300',
				'content-type': 'application/json; charset=utf-8',
			},
		},
	);
};
