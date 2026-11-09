/**
 * End-to-end spike: an MCP client authenticates against Yoal via OAuth 2.1 and uses tools.
 *
 * Run against a dev server started with YOAL_DEV_PASSWORD_LOGIN=1:
 *   YOAL_BASE=http://localhost:5173 bun tests/mcp-oauth.e2e.ts
 *
 * Covers: RFC 9728 challenge + discovery, RFC 8414 AS metadata, DCR (legacy clients),
 * sign-in, PKCE authorize → consent → token, audience-bound JWT, scope enforcement,
 * scope step-up (insufficient_scope), and destructive-action confirmation via
 * multi-round-trip elicitation (accept and decline).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHash, randomBytes } from 'node:crypto';

const BASE = process.env.YOAL_BASE ?? 'http://localhost:5173';
const MCP = `${BASE}/mcp`;
const REDIRECT = 'http://127.0.0.1:8976/callback';
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
	results.push({ name, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// --- tiny cookie jar
const jar = new Map<string, string>();
const remember = (res: Response) => {
	for (const c of res.headers.getSetCookie()) {
		const [pair] = c.split(';');
		const [k, ...v] = pair!.split('=');
		jar.set(k!.trim(), v.join('='));
	}
};
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const http = async (url: string, init: RequestInit = {}) => {
	const res = await fetch(url, {
		redirect: 'manual',
		...init,
		headers: { origin: BASE, cookie: cookieHeader(), ...(init.headers ?? {}) },
	});
	remember(res);
	return res;
};
const json = (body: unknown) => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

// 1. Unauthenticated MCP call → 401 with resource_metadata pointer
const unauth = await fetch(MCP, {
	method: 'POST',
	headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
	body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});
const challenge = unauth.headers.get('www-authenticate') ?? '';
check('unauthenticated /mcp → 401 + WWW-Authenticate', unauth.status === 401 && /resource_metadata=/.test(challenge), challenge.slice(0, 120));
const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? `${BASE}/.well-known/oauth-protected-resource/mcp`;

// 2. Protected resource metadata (RFC 9728)
const prm = await (await fetch(prmUrl)).json().catch(() => ({}));
check('protected resource metadata names /mcp + an AS', prm.resource === MCP && prm.authorization_servers?.length > 0, `${prmUrl}`);

// 3. Authorization server metadata (RFC 8414), path-inserted per issuer
const issuer: string = prm.authorization_servers?.[0] ?? `${BASE}/api/auth`;
const issuerPath = new URL(issuer).pathname.replace(/\/$/, '');
const asUrl = `${new URL(issuer).origin}/.well-known/oauth-authorization-server${issuerPath}`;
const as = await (await fetch(asUrl)).json().catch(() => ({}));
check('AS metadata: PKCE S256, CIMD + registration advertised',
	as.code_challenge_methods_supported?.includes('S256') && as.client_id_metadata_document_supported === true && !!as.registration_endpoint,
	asUrl);

// 4. Dynamic client registration (older clients)
const reg = await (await fetch(as.registration_endpoint, json({
	client_name: 'Yoal e2e agent',
	redirect_uris: [REDIRECT],
	grant_types: ['authorization_code', 'refresh_token'],
	response_types: ['code'],
	token_endpoint_auth_method: 'none',
	application_type: 'native',
}))).json();
check('DCR registers a public native client', typeof reg.client_id === 'string', reg.error_description ?? reg.client_id);

// 5. Sign up + sign in (dev-only email/password)
const email = `e2e-${Date.now()}@yoal.test`;
const signUp = await http(`${BASE}/api/auth/sign-up/email`, json({ email, password: 'correct horse battery staple', name: 'E2E' }));
check('dev sign-up creates a session', signUp.ok && jar.size > 0, `status ${signUp.status}`);

// 6–8. Authorize → consent → token, returning an access token
async function authorize(scope: string, consentScope = scope) {
	const verifier = randomBytes(32).toString('base64url');
	const challengeS256 = createHash('sha256').update(verifier).digest('base64url');
	const state = randomBytes(8).toString('hex');
	const q = new URLSearchParams({
		response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, scope, state,
		code_challenge: challengeS256, code_challenge_method: 'S256', resource: MCP,
	});
	let res = await http(`${as.authorization_endpoint}?${q}`);
	let location = res.headers.get('location') ?? '';
	if (location.includes('/consent')) {
		const consentUrl = new URL(location, BASE);
		res = await http(`${BASE}/api/auth/oauth2/consent`, json({
			accept: true, scope: consentScope, oauth_query: consentUrl.search.slice(1),
		}));
		const body = await res.json().catch(() => ({}));
		location = body.url ?? body.redirect_uri ?? res.headers.get('location') ?? '';
	}
	const cb = new URL(location, BASE);
	const code = cb.searchParams.get('code');
	if (!code || cb.searchParams.get('state') !== state)
		throw new Error(`no code: ${location} ${cb.searchParams.get('error_description') ?? ''}`);
	const tok = await (await fetch(as.token_endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: MCP }),
	})).json();
	if (!tok.access_token) throw new Error(`token error: ${JSON.stringify(tok)}`);
	return tok as { access_token: string; scope?: string; refresh_token?: string };
}

const baseScope = 'openid offline_access project:read project:create deployment:create';
const tok1 = await authorize(baseScope);
const claims = JSON.parse(Buffer.from(tok1.access_token.split('.')[1]!, 'base64url').toString());
const aud = ([] as string[]).concat(claims.aud);
check('access token is a JWT bound to the MCP resource', aud.includes(MCP), `aud=${aud.join(',')} scope=${claims.scope}`);
check('refresh token issued (offline_access)', !!tok1.refresh_token);

// 9. MCP client with the token
/** The last confirmation prompt the server sent, to check what the human was shown. */
let lastElicitation = '';
async function connect(token: string, elicitAnswer: 'accept' | 'decline', mode: 'auto' | 'legacy' = 'auto') {
	const client = new Client(
		{ name: 'yoal-e2e', version: '0.0.0' },
		{ capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode } },
	);
	client.setRequestHandler('elicitation/create', async (request: { params?: { message?: string } }) => {
		lastElicitation = request.params?.message ?? '';
		return elicitAnswer === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
	});
	await client.connect(new StreamableHTTPClientTransport(new URL(MCP), {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
	}));
	return client;
}
const textOf = (r: { content?: unknown }) =>
	((r.content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? '').join('');

let client = await connect(tok1.access_token, 'accept');
const tools = await client.listTools();
check('tools/list over authenticated MCP', tools.tools.some((t) => t.name === 'delete_project'), tools.tools.map((t) => t.name).join(','));
const toolNames = new Set(tools.tools.map((t) => t.name));
// Credential tools that manage credentials without ever returning a secret (reveal stays human-only).
const NON_SECRET_CREDENTIAL_TOOLS = new Set([
	'rotate_database_credentials',
	'list_database_credentials',
	'create_database_credential',
	'rotate_database_credential',
	'revoke_database_credential',
]);
check(
	'database tools listed; rotation allowed, no credential reveal or purge tool (D58, D53)',
	['list_databases', 'get_database', 'create_database', 'attach_database', 'detach_database', 'delete_database'].every((name) => toolNames.has(name)) &&
		toolNames.has('rotate_database_credentials') &&
		![...toolNames].some(
			(name) =>
				/purge|reveal/.test(name) || (/credential/.test(name) && !NON_SECRET_CREDENTIAL_TOOLS.has(name)),
		),
);
check(
	'storage tools listed; no key reveal, purge or bucket delete tool (S6)',
	['list_storage', 'get_storage', 'create_storage', 'create_bucket', 'attach_storage', 'detach_storage', 'delete_storage'].every((name) => toolNames.has(name)) &&
		!toolNames.has('delete_bucket'),
);
const who = JSON.parse(textOf(await client.callTool({ name: 'whoami', arguments: {} })));
check('whoami reflects token scopes ∩ role', JSON.stringify(who.permissions) === JSON.stringify(['deployment:create', 'project:create', 'project:read']), JSON.stringify(who.permissions));
const list = await client.callTool({ name: 'list_projects', arguments: {} });
check('scoped tool works with granted scope', !list.isError);

// Create the project the delete tests operate on (real service layer, not a stub).
const created = await client.callTool({ name: 'create_project', arguments: { name: 'Demo', slug: 'demo' } });
check('create_project works over MCP', !created.isError, textOf(created).slice(0, 100));

// 10. Missing scope → step-up challenge
let stepUp = '';
try {
	const r = await client.callTool({ name: 'delete_project', arguments: { project: 'demo' } });
	stepUp = `unexpected result: ${textOf(r)}`;
} catch (e) {
	stepUp = String((e as Error).message ?? e);
}
check('delete without project:delete → insufficient_scope step-up', /insufficient_scope|403|project:delete/i.test(stepUp), stepUp.slice(0, 140));
await client.close();

// 11. Re-authorize with project:delete explicitly granted, confirm via elicitation
const tok2 = await authorize(`${baseScope} project:delete`);
client = await connect(tok2.access_token, 'accept');
const del = await client.callTool({ name: 'delete_project', arguments: { project: 'demo' } });
check('delete with scope + user confirms → done', !del.isError && /restorable/.test(textOf(del)), textOf(del));
await client.close();

client = await connect(tok2.access_token, 'decline');
let declined = '';
try {
	const r = await client.callTool({ name: 'delete_project', arguments: { project: 'demo' } });
	declined = textOf(r) || JSON.stringify(r);
} catch (e) {
	declined = `error: ${(e as Error).message}`;
}
check('delete when user declines → not deleted', !/moved to trash/.test(declined) && !/restorable/.test(declined), declined.slice(0, 140));
await client.close();

// 11b. Bulk delete: one prompt names every project; accept deletes them, decline deletes none.
client = await connect(tok2.access_token, 'accept');
for (const slug of ['bulk-one', 'bulk-two', 'bulk-keep'])
	await client.callTool({ name: 'create_project', arguments: { name: slug, slug } });
lastElicitation = '';
const bulk = await client.callTool({ name: 'delete_projects', arguments: { projects: ['bulk-one', 'bulk-two', 'bulk-ghost'] } });
const bulkBody = (() => {
	try {
		return JSON.parse(textOf(bulk));
	} catch {
		return {};
	}
})();
check(
	'delete_projects prompt lists the projects and the skipped one',
	/bulk-one/.test(lastElicitation) && /bulk-two/.test(lastElicitation) && /bulk-ghost \(not_found\)/.test(lastElicitation),
	lastElicitation.slice(0, 160),
);
check(
	'delete_projects after confirmation deletes exactly the confirmed list',
	!bulk.isError && bulkBody.status === 'succeeded' && bulkBody.succeeded?.length === 2,
	textOf(bulk).slice(0, 600),
);
await client.close();

client = await connect(tok2.access_token, 'decline');
const bulkDeclined = await client.callTool({ name: 'delete_projects', arguments: { projects: ['bulk-keep'] } });
const stillThere = textOf(await client.callTool({ name: 'list_projects', arguments: {} }));
check(
	'delete_projects declined → nothing deleted',
	/Cancelled/.test(textOf(bulkDeclined)) && /bulk-keep/.test(stillThere),
	textOf(bulkDeclined).slice(0, 120),
);
await client.close();

// 12. 2025-era client: destructive tool degrades to a clear "use the dashboard" error
client = await connect(tok2.access_token, 'accept', 'legacy');
const legacyDel = await client.callTool({ name: 'delete_project', arguments: { project: 'demo' } });
check('legacy client: delete → dashboard hand-off, not deleted', !!legacyDel.isError && /dashboard/.test(textOf(legacyDel)), textOf(legacyDel).slice(0, 100));
const legacyBulk = await client.callTool({ name: 'delete_projects', arguments: { projects: ['bulk-keep'] } });
check(
	'legacy client: delete_projects → dashboard link with the selection',
	!!legacyBulk.isError && /projects\?select=bulk-keep/.test(textOf(legacyBulk)),
	textOf(legacyBulk).slice(0, 140),
);
await client.close();

// 13. A forged / wrong-audience token is rejected
const forged = await fetch(MCP, {
	method: 'POST',
	headers: { 'content-type': 'application/json', authorization: `Bearer ${tok2.access_token.slice(0, -4)}AAAA` },
	body: '{}',
});
check('tampered token rejected', forged.status === 401);

// 14. Disconnecting the app (Settings → Connected apps) cuts off a token that hasn't expired yet.
const mcpCall = (token: string) =>
	fetch(MCP, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
		body: JSON.stringify({
			jsonrpc: '2.0', id: 1, method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'yoal-e2e', version: '0.0.0' } },
		}),
	});
const connectedApps = await (await http(`${BASE}/api/v1/connected-apps`)).json().catch(() => ({}));
const grant = (connectedApps.connectedApps ?? []).find((app: { clientId: string }) => app.clientId === reg.client_id) as
	| { id: string; scopes: string[] }
	| undefined;
check('connected apps lists the approved client with its scopes', !!grant && grant.scopes.includes('project:delete'), JSON.stringify(grant ?? connectedApps).slice(0, 140));
const beforeRevoke = await mcpCall(tok2.access_token);
check('token works before the app is disconnected', beforeRevoke.status !== 401, `status ${beforeRevoke.status}`);
const revoked = await http(`${BASE}/api/v1/connected-apps/${grant?.id ?? 'missing'}`, { method: 'DELETE' });
const revokedBody = await revoked.json().catch(() => ({}));
check('DELETE /api/v1/connected-apps/{id} disconnects it', revoked.ok && revokedBody.revoked === true && revokedBody.clientId === reg.client_id, JSON.stringify(revokedBody).slice(0, 140));
for (const [label, token] of [['newest', tok2.access_token], ['older', tok1.access_token]] as const) {
	const after = await mcpCall(token);
	const afterChallenge = after.headers.get('www-authenticate') ?? '';
	check(
		`revoked grant (${label} token) → 401 + sign-in challenge`,
		after.status === 401 && /^Bearer /.test(afterChallenge) && /resource_metadata=/.test(afterChallenge),
		`status ${after.status} ${afterChallenge.slice(0, 100)}`,
	);
}
const refreshed = await (await fetch(as.token_endpoint, {
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok2.refresh_token ?? '', client_id: reg.client_id, resource: MCP }),
})).json().catch(() => ({}));
check('revoked grant: refresh token no longer mints access tokens', !refreshed.access_token, refreshed.error ?? 'issued a token');
const afterList = await (await http(`${BASE}/api/v1/connected-apps`)).json().catch(() => ({}));
check('disconnected app is gone from the list', !(afterList.connectedApps ?? []).some((app: { clientId: string }) => app.clientId === reg.client_id));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
