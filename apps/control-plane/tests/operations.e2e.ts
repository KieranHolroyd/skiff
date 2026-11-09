/**
 * End-to-end test for mass operations and prune (docs/OPERATIONS.md). Run against a dev server
 * started with YOAL_DEV_PASSWORD_LOGIN=1 and a fresh data dir:
 *   YOAL_BASE=http://localhost:5173 bun tests/operations.e2e.ts
 *
 * Covers: plan → verdicts → apply, the SSE progress stream, the trash listing, bulk restore and
 * purge, prune plan/apply, idempotency keys and the error contract.
 */
export {};

const BASE = process.env.YOAL_BASE ?? 'http://localhost:5173';
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
const post = (body: unknown, headers: Record<string, string> = {}) => ({
	method: 'POST',
	headers: { 'content-type': 'application/json', ...headers },
	body: JSON.stringify(body),
});

/** Read an SSE response into `{ event, data }` records until it ends. */
async function readSse(res: Response): Promise<Array<{ event: string; data: any; id?: string }>> {
	const events: Array<{ event: string; data: any; id?: string }> = [];
	const text = await res.text();
	for (const block of text.split('\n\n')) {
		const lines = block.split('\n');
		const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
		const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
		const id = lines.find((line) => line.startsWith('id: '))?.slice(4);
		if (event && data) events.push({ event, data: JSON.parse(data), id });
	}
	return events;
}

const suffix = Date.now().toString(36);
const slugs = ['a', 'b', 'c'].map((letter) => `ops-${letter}-${suffix}`);

// 1. Sign up and create projects (one deployed, so it is live).
const signUp = await http(
	'/api/auth/sign-up/email',
	post({ email: `ops-${suffix}@yoal.test`, password: 'correct horse battery staple', name: 'Ops' }),
);
check('dev sign-up', signUp.status === 200, `status ${signUp.status}`);
for (const slug of slugs) await http('/api/v1/projects', post({ name: slug, slug }));
const deployed = await http(`/api/v1/projects/${slugs[0]}/deploy`, post({ files: [{ path: 'index.html', content: '<h1>live</h1>' }] }));
check('deploy one project', deployed.status === 200, `status ${deployed.status}`);

// 2. Actions available to an owner session.
const actions = await (await http('/api/v1/operations/actions')).json();
check(
	'actions list includes the bulk actions and prune',
	['project.delete', 'project.restore', 'project.purge', 'prune'].every((id) => actions.actions.some((action: any) => action.id === id)),
);

// 3. Plan a bulk delete and read the verdicts.
const planRes = await http('/api/v1/operations?wait=10', post({ action: 'project.delete', targets: [...slugs, 'ops-nope'] }));
const plan = await planRes.json();
check('plan returns 202 and stops at planned', planRes.status === 202 && plan.status === 'planned', `${planRes.status} ${plan.status}`);
check('plan counts ok and skipped', plan.summary.verdicts.ok === 3 && plan.summary.verdicts.skip === 1, JSON.stringify(plan.summary.verdicts));
check('plan flags the live project', plan.summary.flags.live === 1, JSON.stringify(plan.summary.flags));
const planItems = await (await http(`/api/v1/operations/${plan.id}?items=1`)).json();
check(
	'plan items carry labels and reasons',
	planItems.items.length === 4 && planItems.items.at(-1).reason === 'not_found',
	JSON.stringify(planItems.items.map((item: any) => [item.label, item.verdict])),
);
const stillLive = await (await http('/api/v1/projects')).json();
check('planning changes nothing', slugs.every((slug) => stillLive.projects.some((project: any) => project.slug === slug)));

// 4. Apply and follow the SSE stream to the end.
const applyRes = await http(`/api/v1/operations/${plan.id}/apply`, post({}));
check('apply accepted', applyRes.status === 200, `status ${applyRes.status}`);
const stream = await http(`/api/v1/operations/${plan.id}/stream?until=done`);
check('stream is text/event-stream', (stream.headers.get('content-type') ?? '').startsWith('text/event-stream'));
const events = await readSse(stream);
const done = events.at(-1);
check('stream ends with done/succeeded', done?.event === 'done' && done.data.status === 'succeeded', JSON.stringify(done?.data?.status));
const streamedItems = events.filter((event) => event.event === 'items').flatMap((event) => event.data.items);
check('stream reports every item once', streamedItems.length === 4, `${streamedItems.length} items`);
check('item events carry resumable ids', events.some((event) => event.event === 'items' && event.id));

// 5. Resuming the stream after the last id sends no duplicate items.
const lastId = events.filter((event) => event.id).at(-1)?.id;
const resumed = await readSse(await http(`/api/v1/operations/${plan.id}/stream?until=done`, { headers: { 'last-event-id': lastId ?? '0' } }));
check('a resumed stream skips items already seen', resumed.filter((event) => event.event === 'items').length === 0);

// 6. Trash listing shows them with a purge date.
const trash = await (await http('/api/v1/projects?trash=1')).json();
check(
	'trash lists the deleted projects with purgeAt',
	slugs.every((slug) => trash.projects.some((project: any) => project.slug === slug && project.purgeAt)),
);

// 7. Restore one straight through (stage=apply), with an idempotency key.
const restoreBody = { action: 'project.restore', targets: [slugs[1]], stage: 'apply' };
const restored = await (await http('/api/v1/operations?wait=10', post(restoreBody, { 'idempotency-key': `r-${suffix}` }))).json();
check('restore runs straight through', restored.status === 'succeeded', restored.status);
const again = await (await http('/api/v1/operations', post(restoreBody, { 'idempotency-key': `r-${suffix}` }))).json();
check('an idempotency key returns the same operation', again.id === restored.id);

// 8. Purge: the restored project is blocked, the trashed ones go.
const purge = await (await http('/api/v1/operations?wait=10', post({ action: 'project.purge', targets: slugs }))).json();
check('purge blocks the live project', purge.summary.verdicts.blocked === 1 && purge.summary.verdicts.ok === 2, JSON.stringify(purge.summary.verdicts));
await http(`/api/v1/operations/${purge.id}/apply`, post({}));
const purged = await (await http(`/api/v1/operations/${purge.id}?wait=10`)).json();
check('purge succeeds', purged.operation.status === 'succeeded', purged.operation.status);
const afterPurge = await (await http('/api/v1/projects?trash=1')).json();
check('purged projects are gone from the trash', !afterPurge.projects.some((project: any) => project.slug === slugs[0]));

// 9. Prune: plan and apply an org-scope run.
const prunePlan = await (await http('/api/v1/operations?wait=20', post({ action: 'prune' }))).json();
check('prune plans', prunePlan.status === 'planned' && prunePlan.scope === 'org', `${prunePlan.status} ${prunePlan.scope}`);
await http(`/api/v1/operations/${prunePlan.id}/apply`, post({}));
const pruned = await (await http(`/api/v1/operations/${prunePlan.id}?wait=20`)).json();
check('prune finishes', ['succeeded', 'partial'].includes(pruned.operation.status), pruned.operation.status);

// 10. Error contract.
const applyPrune = await http('/api/v1/operations', post({ action: 'prune', stage: 'apply' }));
check('prune cannot skip the plan', applyPrune.status === 422, `status ${applyPrune.status}`);
const unknown = await http('/api/v1/operations/op_missing');
check('unknown operation is 404', unknown.status === 404, `status ${unknown.status}`);
const reapply = await http(`/api/v1/operations/${plan.id}/apply`, post({}));
check('a finished operation cannot be applied again', reapply.status === 409, `status ${reapply.status}`);
const opsHistory = await (await http('/api/v1/operations?kind=bulk')).json();
check('history lists bulk operations', opsHistory.operations.length >= 3, `${opsHistory.operations.length}`);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
