/**
 * Yoal user-pool `env.AUTH` service Worker (IAM.md I28, §11.2).
 *
 * The agent renders one of these next to a function that has a pool attachment. The pool's
 * public JWKS and issuer arrive as text bindings at deploy time, so `verify(request)` is local:
 * no network call, no control-plane round trip, and no secret in the Worker.
 *
 *   const user = await env.AUTH.verify(request);   // user or null
 *   if (!user) return new Response('Sign in', { status: 401 });
 *
 * It deliberately accepts only an access token (`typ: "access"`), not an id_token, and returns
 * null for anything malformed, expired, wrong-issuer or signed by a key that is not in the
 * attached pool's current key set.
 */

function decodeBase64Url(value) {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function decodeJson(value) {
	return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

function bearerToken(request) {
	if (typeof request === 'string') {
		const token = request.replace(/^Bearer\s+/i, '').trim();
		return token || null;
	}
	const headers = request && request.headers ? request.headers : request;
	if (!headers || typeof headers.get !== 'function') return null;
	const authorization = headers.get('authorization');
	if (!authorization || !/^Bearer\s+/i.test(authorization)) return null;
	return authorization.replace(/^Bearer\s+/i, '').trim() || null;
}

async function verifySignature(token, jwks) {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [encodedHeader, encodedPayload, encodedSignature] = parts;
	const header = decodeJson(encodedHeader);
	if (header.alg !== 'ES256') return null;
	const keys = Array.isArray(jwks) ? jwks : [];
	const jwk = keys.find((key) => key && key.kid === header.kid) ?? keys[0];
	if (!jwk) return null;
	const key = await crypto.subtle.importKey(
		'jwk',
		jwk,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['verify']
	);
	const valid = await crypto.subtle.verify(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		decodeBase64Url(encodedSignature),
		new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
	);
	return valid ? decodeJson(encodedPayload) : null;
}

export class Auth extends WorkerEntrypoint {
	async verify(request) {
		try {
			const token = bearerToken(request);
			if (!token) return null;
			const jwks = JSON.parse(this.env.AUTH_JWKS || '[]');
			const claims = await verifySignature(token, jwks);
			if (!claims) return null;
			if (claims.iss !== this.env.AUTH_ISSUER) return null;
			if (claims.typ !== 'access') return null;
			if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
			return {
				id: String(claims.sub),
				sub: String(claims.sub),
				email: typeof claims.email === 'string' ? claims.email : null,
				emailVerified: claims.email_verified === true,
				name: typeof claims.name === 'string' ? claims.name : null,
				claims
			};
		} catch {
			return null;
		}
	}
}

export default {
	async fetch() {
		return new Response('This binding is used through env.AUTH.verify(request).', {
			status: 200,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
	}
};
