/**
 * End-to-end REST/agent test. Run against a dev server started with YOAL_DEV_PASSWORD_LOGIN=1:
 *   YOAL_BASE=http://localhost:5173 bun tests/rest.e2e.ts
 *
 * Covers: session auth, project CRUD, inline deploy, presigned upload, promote/rollback,
 * node join + desired state + heartbeat, share links, password-protected site login and audit.
 */
import { zipSync } from 'fflate';
import { createHash, randomBytes } from 'node:crypto';
import { contentUrl } from '@yoal/contracts';

const BASE = process.env.YOAL_BASE ?? 'http://localhost:5173';
/** Where the dev server serves deployed content (HTTP + the Vite port for *.localhost). */
const site = (host: string) => contentUrl(BASE, host);
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
	results.push({ name, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const jar = new Map<string, string>();
const remember = (res: Response) => {
	for (const cookie of res.headers.getSetCookie()) {
		const [pair] = cookie.split(';');
		const [key, ...value] = pair!.split('=');
		jar.set(key!.trim(), value.join('='));
	}
};
const cookieHeader = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');

async function http(path: string, init: RequestInit = {}) {
	const res = await fetch(new URL(path, BASE), {
		redirect: 'manual',
		...init,
		headers: { origin: BASE, cookie: cookieHeader(), ...(init.headers ?? {}) },
	});
	remember(res);
	return res;
}
const json = (body: unknown) => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

// 1. Dev sign-up
const email = `rest-${Date.now()}@yoal.test`;
const signUp = await http('/api/auth/sign-up/email', json({ email, password: 'correct horse battery staple', name: 'REST' }));
check('dev sign-up', signUp.status === 200 && jar.size > 0, `status ${signUp.status}`);

// 2. whoami + create project
const who = await http('/api/v1/whoami');
const whoBody = await who.json();
check('whoami resolves a personal org and owner role', who.status === 200 && whoBody.user.role === 'owner', JSON.stringify(whoBody.user));
const create = await http('/api/v1/projects', json({ name: 'Rest Site', slug: 'restsite' }));
const project = await create.json();
check('create project', create.status === 201 && project.productionUrl === site('restsite.localhost'), JSON.stringify(project));

// 3. Inline deploy
const deploy = await http(
	'/api/v1/projects/restsite/deploy',
	json({
		project: 'restsite',
		promote: true,
		files: [
			{ path: 'index.html', content: '<h1>rest v1</h1>' },
			{ path: '_redirects', content: '/old /new 301\n' },
		],
	}),
);
const deployment = await deploy.json();
check(
	'inline deploy promotes and returns a preview URL',
	deploy.status === 200 && deployment.isProduction === true && deployment.previewUrl === site(`restsite--${deployment.shortId}.localhost`),
	deployment.previewUrl,
);

// 3b. The dev server serves the deployed files on *.localhost without Caddy.
const siteHome = await fetch(`${site('restsite.localhost')}/`, { redirect: 'manual' });
const siteBody = await siteHome.text();
check(
	'dev server serves production content on <slug>.localhost',
	siteHome.status === 200 && siteBody.includes('rest v1'),
	`status ${siteHome.status} ${siteBody.slice(0, 40)}`,
);
const redirected = await fetch(`${site('restsite.localhost')}/old`, { redirect: 'manual' });
check(
	'_redirects apply to dev-served content',
	redirected.status === 301 && redirected.headers.get('location') === '/new',
	`status ${redirected.status} ${redirected.headers.get('location') ?? ''}`,
);
const previewHost = `restsite--${deployment.shortId}.localhost`;
const protectedPreview = await fetch(`${site(previewHost)}/`, {
	redirect: 'manual',
});
check(
	'platform-protected previews redirect to the site-login bridge',
	protectedPreview.status === 303 &&
		(protectedPreview.headers.get('location') ?? '').includes('/_yoal/site-login?project='),
	`status ${protectedPreview.status} ${protectedPreview.headers.get('location') ?? ''}`,
);
const bridge = await http(
	`/_yoal/site-login?project=${project.id}&return=${encodeURIComponent(`${site(previewHost)}/`)}`,
);
const callbackUrl = bridge.headers.get('location') ?? '';
check(
	'site-login mints a host-bound callback for the dev preview',
	bridge.status === 302 && callbackUrl.startsWith(`${site(previewHost)}/_yoal/callback?token=`),
	callbackUrl.slice(0, 80),
);
const siteCallback = await fetch(callbackUrl, { redirect: 'manual' });
const siteCookie = (siteCallback.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
check(
	'dev callback sets the host-only site cookie',
	siteCallback.status === 303 && siteCookie.startsWith('__yoal_dev_site='),
	`status ${siteCallback.status} ${siteCookie.slice(0, 30)}`,
);
const unlocked = await fetch(`${site(previewHost)}/`, {
	redirect: 'manual',
	headers: { cookie: siteCookie },
});
const unlockedBody = await unlocked.text();
check(
	'dev server serves the protected preview once the cookie is set',
	unlocked.status === 200 && unlockedBody.includes('rest v1'),
	`status ${unlocked.status} ${unlockedBody.slice(0, 40)}`,
);

// 4. Project + deployment listing
const listed = await (await http('/api/v1/projects/restsite/deployments')).json();
check('list deployments', listed.deployments?.length === 1 && listed.deployments[0].release.fileCount === 2);

// 5. Presigned upload → PUT → finalize
const upload = await (await http('/api/v1/uploads', json({ project: 'restsite', fileCount: 1, totalBytes: 64 }))).json();
check('create presigned upload', upload.method === 'PUT' && !!upload.url, upload.uploadId);
const zip = zipSync({ 'index.html': new TextEncoder().encode('<h1>rest v2</h1>') });
const put = await fetch(upload.url, { method: 'PUT', body: zip, headers: { 'content-type': 'application/zip' } });
check('PUT to presigned URL (no cookie)', put.status === 204, `status ${put.status}`);
const finalize = await http(
	`/api/v1/uploads/${upload.uploadId}/finalize`,
	json({ uploadId: upload.uploadId, project: 'restsite', promote: false }),
);
const uploaded = await finalize.json();
check('finalize upload creates a second deployment', finalize.status === 200 && uploaded.release.fileCount === 1, uploaded.previewUrl);

// 6. Promote + rollback
const promote = await http('/api/v1/projects/restsite/promote', json({ project: 'restsite', deploymentId: uploaded.id }));
const promoted = await promote.json();
check('promote moves the production pointer', promote.status === 200 && promoted.isProduction === true);
const rollback = await http('/api/v1/projects/restsite/rollback', { method: 'POST' });
const rolledBack = await rollback.json();
check('rollback returns to the previous deployment', rollback.status === 200 && rolledBack.id === deployment.id, rolledBack.id);

// 7. Node join, heartbeat, desired state
const joinToken = await (await http('/api/v1/nodes/join-token', json({ name: 'edge' }))).json();
check('create single-use node join token', typeof joinToken.token === 'string');
const join = await fetch(new URL('/api/agent/join', BASE), {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ token: joinToken.token, name: 'edge' }),
});
const joined = await join.json();
check('agent joins and becomes the edge node', join.status === 201 && joined.mode === 'edge', joined.nodeId);
const desiredRes = await fetch(new URL('/api/agent/desired-state', BASE), {
	headers: { authorization: `Bearer ${joined.token}` },
});
const desired = await desiredRes.json();
check(
	'desired state includes production + preview routes and a download URL',
	desiredRes.status === 200 &&
		desired.routes.some((route: { host: string }) => route.host === 'restsite.localhost') &&
		desired.routes.some((route: { host: string }) => /^restsite--/.test(route.host)) &&
		desired.releases[0]?.url.includes('/api/objects/releases/') === true,
	`${desired.routes?.length} routes`,
);
const etag = desiredRes.headers.get('etag');
const notModified = await fetch(new URL('/api/agent/desired-state', BASE), {
	headers: { authorization: `Bearer ${joined.token}`, 'if-none-match': etag! },
});
check('desired state is ETag-conditional', notModified.status === 304, `status ${notModified.status}`);
const heartbeat = await fetch(new URL('/api/agent/heartbeat', BASE), {
	method: 'POST',
	headers: { 'content-type': 'application/json', authorization: `Bearer ${joined.token}` },
	body: JSON.stringify({
		nodeId: joined.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: desired.version,
		status: 'online',
		caddyOk: true,
		stats: { cpuPercent: 1, memoryBytes: 1000, memoryTotalBytes: 2000, diskUsedBytes: 10, diskTotalBytes: 100, uptimeSeconds: 5, load1: 0.1 },
	}),
});
check('heartbeat accepted', heartbeat.status === 200, `status ${heartbeat.status}`);

// 8. Status + audit
const status = await (await http('/api/v1/status')).json();
check('status sees the node online and two deployments', status.nodes.online === 1 && status.deployments.total === 2, JSON.stringify(status));
const audit = await (await http('/api/v1/audit?limit=100')).json();
check(
	'audit records deploys, promote and rollback',
	['project.create', 'deployment.create', 'deployment.promote', 'deployment.rollback'].every((action) =>
		audit.entries.some((entry: { action: string }) => entry.action === action),
	),
	`${audit.entries.length} entries`,
);

// 9. Share link redemption via the site-login bridge
const projectFresh = await (await http('/api/v1/projects/restsite')).json();
const share = await (await http('/api/v1/projects/restsite/shares', json({ project: 'restsite', maxRedemptions: 1 }))).json();
const shareUrl = new URL(share.url);
const rawToken = shareUrl.searchParams.get('_yoal_share')!;
const returnTo = `${shareUrl.origin}/some/page?x=1`;
const shareLogin = await http(
	`/_yoal/site-login?project=${projectFresh.id}&return=${encodeURIComponent(`${returnTo}&_yoal_share=${rawToken}`)}`,
);
const location = shareLogin.headers.get('location') ?? '';
check(
	'share link redeems and redirects with a host-bound callback token',
	shareLogin.status === 302 && location.startsWith(`${shareUrl.origin}/_yoal/callback?token=`),
	location.slice(0, 80),
);
const secondRedeem = await http(
	`/_yoal/site-login?project=${projectFresh.id}&return=${encodeURIComponent(`${returnTo}&_yoal_share=${rawToken}`)}`,
);
check('share link redemption cap enforced', secondRedeem.status === 410, `status ${secondRedeem.status}`);

// 10. Password-protected production: form then token
await http('/api/v1/projects/restsite/access', json({ scope: 'production', mode: 'password', password: 'let me in' }));
const loginPage = await http(`/_yoal/site-login?project=${projectFresh.id}&return=${encodeURIComponent(`${site('restsite.localhost')}/`)}`);
const form = await loginPage.text();
check('password mode serves a login form', loginPage.status === 200 && form.includes('password protected'));
const formPost = await http('/_yoal/site-login', {
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({ project: projectFresh.id, return: `${site('restsite.localhost')}/` }).toString(),
	redirect: 'manual',
});
check('wrong password is rejected', formPost.status === 401, `status ${formPost.status}`);
const good = await http('/_yoal/site-login', {
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({ project: projectFresh.id, return: `${site('restsite.localhost')}/`, password: 'let me in' }).toString(),
});
check(
	'correct password redirects with a token',
	good.status === 302 && (good.headers.get('location') ?? '').includes('/_yoal/callback?token='),
	`status ${good.status} ${good.headers.get('location') ?? ''}`,
);

// 11. CLI browser login: approval -> one-time PKCE code -> API key
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(24).toString('base64url');
const redirectUri = 'http://127.0.0.1:43210/callback';
const cliQuery = new URLSearchParams({
	redirect_uri: redirectUri,
	state,
	code_challenge: challenge,
	code_challenge_method: 'S256',
});
const cliPage = await http(`/cli/login?${cliQuery}`);
check(
	'CLI approval page renders for a signed-in session',
	cliPage.status === 200 && (await cliPage.text()).includes('Authorize the Yoal CLI'),
	`status ${cliPage.status}`,
);
const approve = await http('/cli/login', {
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
	body: new URLSearchParams({ ...Object.fromEntries(cliQuery), decision: 'approve' }).toString(),
});
const callback = approve.headers.get('location') ?? '';
const cliCode = new URL(callback).searchParams.get('code');
check(
	'CLI approval redirects a one-time code to loopback',
	approve.status === 303 && callback.startsWith(redirectUri) && !!cliCode,
	`${approve.status} ${callback.slice(0, 80)}`,
);
const exchange = await fetch(new URL('/api/v1/cli/token', BASE), {
	method: 'POST',
	headers: { 'content-type': 'application/json', origin: BASE },
	body: JSON.stringify({ code: cliCode, codeVerifier: verifier }),
});
const cliKey = await exchange.json();
check(
	'CLI token endpoint mints an API key',
	exchange.status === 200 && typeof cliKey.token === 'string' && cliKey.token.startsWith('yoal_'),
	`status ${exchange.status}`,
);
const cliWho = await fetch(new URL('/api/v1/whoami', BASE), {
	headers: { authorization: `Bearer ${cliKey.token}` },
});
check('minted CLI key authenticates REST', cliWho.status === 200, `status ${cliWho.status}`);
const replay = await fetch(new URL('/api/v1/cli/token', BASE), {
	method: 'POST',
	headers: { 'content-type': 'application/json', origin: BASE },
	body: JSON.stringify({ code: cliCode, codeVerifier: verifier }),
});
check('CLI login code is single-use', replay.status === 400, `status ${replay.status}`);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
