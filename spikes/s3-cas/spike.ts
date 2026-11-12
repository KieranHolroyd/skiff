/**
 * Spike S3 (docs/CLUSTERING.md §15.2): do R2 and each S3 target honour `If-Match` and
 * `If-None-Match` on PUT strongly enough to be the only arbiter of one control-plane primary?
 *
 *   S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com S3_BUCKET=… S3_ACCESS_KEY_ID=… \
 *   S3_SECRET_ACCESS_KEY=… [S3_REGION=auto] [WRITERS=200] [SECONDS=60] bun run spike.ts
 *
 * It talks to the store through the same `S3ObjectStore.readVersioned/writeConditional` the
 * lease uses, under `yoal/spikes/s3-cas/<run>/`, and deletes what it wrote. Pass criteria:
 *   - exactly one 200 per epoch, never two holders;
 *   - 409 or 412, never 200, for a stale `If-Match` and for `If-None-Match: *` on an existing key;
 *   - the ETag changes on every write, even with an identical body;
 *   - p99 conditional PUT ≤ 300 ms;
 *   - the store's `Date` within 5 s of this host's (NTP-synced) clock;
 *   - 501 for an unsupported condition, never silent success.
 * Results print as JSON for docs/SPIKES.md §S3.
 */
import { S3ObjectStore } from '../../packages/core/src/object-store.ts';

const env = process.env;
const need = (name: string): string => {
	const value = env[name];
	if (!value) {
		console.error(`missing ${name}`);
		process.exit(64);
	}
	return value;
};
const store = new S3ObjectStore({
	endpoint: need('S3_ENDPOINT'),
	bucket: need('S3_BUCKET'),
	accessKeyId: need('S3_ACCESS_KEY_ID'),
	secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
	region: env.S3_REGION ?? 'auto',
});
const writers = Number(env.WRITERS ?? 200);
const seconds = Number(env.SECONDS ?? 60);
const run = `yoal/spikes/s3-cas/${new Date().toISOString().replace(/[:.]/g, '-')}`;
const checks: Record<string, { pass: boolean; detail: string }> = {};
const check = (name: string, pass: boolean, detail: string) => {
	checks[name] = { pass, detail };
	console.error(`${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
};

// 1. Clock: the lease trusts only the store's Date header.
{
	const before = Date.now();
	const read = await store.readVersioned(`${run}/clock`);
	const after = Date.now();
	const skew = read.serverDate === null ? null : read.serverDate - (before + after) / 2;
	check('store-clock', skew !== null && Math.abs(skew) <= 5_000, skew === null ? 'no Date header' : `store − local = ${skew} ms (±1 s header resolution)`);
}

// 2. Create-only and ETag behaviour on one key.
{
	const key = `${run}/single`;
	const created = await store.writeConditional(key, '{"epoch":1}', { ifNoneMatch: '*' });
	check('create-if-none-match', created.status === 200 && Boolean(created.etag), `status ${created.status}, etag ${created.etag}`);
	const again = await store.writeConditional(key, '{"epoch":1}', { ifNoneMatch: '*' });
	check('create-refused-when-present', again.status === 412 || again.status === 409, `status ${again.status}`);
	const same = await store.writeConditional(key, '{"epoch":1}', { ifMatch: created.etag! });
	check('etag-changes-on-identical-body', same.status === 200 && same.etag !== created.etag, `${created.etag} → ${same.etag}`);
	const stale = await store.writeConditional(key, '{"epoch":2}', { ifMatch: created.etag! });
	check('stale-if-match-refused', stale.status === 412 || stale.status === 409, `status ${stale.status}`);
	const bogus = await store.writeConditional(key, '{"epoch":2}', { ifMatch: '"not-an-etag"' });
	check('unknown-if-match-refused', bogus.status === 412 || bogus.status === 409, `status ${bogus.status}`);
	const read = await store.readVersioned(key);
	check('read-sees-last-write', read.etag === same.etag && read.body === '{"epoch":1}', `etag ${read.etag}`);
	await store.delete(key);
}

// 3. Contention: `writers` loops of read → CAS(epoch + 1) for `seconds`.
{
	const key = `${run}/race`;
	const first = await store.writeConditional(key, JSON.stringify({ epoch: 0, writer: 'init' }), { ifNoneMatch: '*' });
	if (first.status !== 200) throw new Error(`could not create the race key: ${first.status}`);
	const winners = new Map<number, string[]>();
	const latencies: number[] = [];
	const statuses = new Map<number, number>();
	let attempts = 0;
	let errors = 0;
	const deadline = Date.now() + seconds * 1000;
	await Promise.all(
		Array.from({ length: writers }, async (_, index) => {
			const writer = `w${index}`;
			while (Date.now() < deadline) {
				try {
					const read = await store.readVersioned(key);
					if (read.status !== 200 || !read.etag || !read.body) continue;
					const epoch = (JSON.parse(read.body) as { epoch: number }).epoch + 1;
					const started = performance.now();
					const write = await store.writeConditional(key, JSON.stringify({ epoch, writer }), { ifMatch: read.etag });
					latencies.push(performance.now() - started);
					attempts++;
					statuses.set(write.status, (statuses.get(write.status) ?? 0) + 1);
					if (write.status === 200) winners.set(epoch, [...(winners.get(epoch) ?? []), writer]);
				} catch {
					errors++;
				}
			}
		}),
	);
	const doubled = [...winners.entries()].filter(([, who]) => who.length > 1);
	const final = JSON.parse((await store.readVersioned(key)).body ?? '{"epoch":-1}') as { epoch: number };
	latencies.sort((a, b) => a - b);
	const p = (q: number) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? NaN);
	check('one-winner-per-epoch', doubled.length === 0, doubled.length ? `epochs with two winners: ${doubled.slice(0, 5).map(([e]) => e).join(', ')}` : `${winners.size} epochs, each one winner`);
	check('final-epoch-matches-wins', final.epoch === winners.size, `final ${final.epoch}, wins ${winners.size}`);
	check('only-200-409-412', [...statuses.keys()].every((status) => [200, 409, 412].includes(status)), JSON.stringify(Object.fromEntries(statuses)));
	check('put-p99-under-300ms', p(0.99) <= 300, `p50 ${p(0.5)} ms, p99 ${p(0.99)} ms over ${attempts} attempts (${errors} transport errors)`);
	await store.delete(key);
}

const pass = Object.values(checks).every((entry) => entry.pass);
console.log(JSON.stringify({ spike: 'S3', at: new Date().toISOString(), endpoint: new URL(need('S3_ENDPOINT')).host, writers, seconds, pass, checks }, null, 2));
process.exit(pass ? 0 : 1);
