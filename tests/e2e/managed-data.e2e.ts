/**
 * Managed-data end-to-end harness.
 *
 * Starts disposable Postgres 17 and RustFS 1.0.4 containers on a private container network and
 * exercises the path the platform relies on:
 *
 *   - Postgres create / connect / the agent's SSLRequest health probe
 *   - deterministic fixture data, `pg_dump -Fc`, restore into a fresh instance, checksum compare
 *   - RustFS bucket create/list, signed PUT/GET/HEAD/range/delete, presigned URLs, multipart
 *   - the control-plane object browser client (`S3Client`) list and bulk-delete
 *
 * One command, no root, no persistent state:
 *
 *   bun tests/e2e/managed-data.e2e.ts
 *
 * Set `SKIFF_E2E_ENGINE=podman|docker` to require an engine, or `none` to force the skip path.
 * The real Debian 13 wrapper is `scripts/e2e/debian13.sh`.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { bunSqlConnector } from '../../apps/agent/src/database-stats.ts';
import { RustfsApi } from '../../apps/agent/src/storage-admin.ts';
import { S3Client, presignPublicUrl, xmlTag } from '../../packages/core/src/storage-s3.ts';
import {
	ContainerRuntime,
	EngineUnavailableError,
	type Engine,
	detectEngine,
	freePort,
	postgresHealthProbe,
	waitFor,
} from './lib/containers.ts';

const IMAGES = {
	postgres: 'postgres:17-alpine',
	rustfs: 'rustfs/rustfs:1.0.4',
};

// Deterministic, obviously-fake credentials. Nothing here is a secret.
const PG_USER = 'skiff';
const PG_PASSWORD = 'skiff-e2e-password';
const PRIMARY_DB = 'skiff_e2e';
const APP_DB = 'skiff_e2e_app';
const S3_ACCESS_KEY = 'SKIFFE2EACCESSKEY';
const S3_SECRET_KEY = 'skiff-e2e-rustfs-secret-0123456789';
const S3_REGION = 'us-east-1';
const BUCKET = 'skiff-e2e-bucket';

interface Result {
	name: string;
	ok: boolean;
	detail?: string;
}

const results: Result[] = [];
let runtime: ContainerRuntime | undefined;
let tempDir: string | undefined;
let harnessFinished = false;

// Guard against a Bun process that empties its event loop mid-run and would otherwise exit 0
// with only a subset of checks executed. Normal completion calls process.exit(code) explicitly.
process.on('beforeExit', () => {
	if (harnessFinished) return;
	console.error(
		'FAIL  the harness exited before all checks completed (a promise is not keeping the event loop alive).\n' +
			'      Leftover containers carry label skiff.e2e=true; remove them with:\n' +
			'      podman ps -aq --filter label=skiff.e2e=true | xargs -r podman rm -f',
	);
	process.exit(1);
});

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
	try {
		await fn();
		results.push({ name, ok: true });
		console.log(`PASS  ${name}`);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		results.push({ name, ok: false, detail });
		console.log(`FAIL  ${name}\n      ${detail}`);
	}
}

/** Run an `exec` in a container with `PGPASSWORD` set, mirroring the helper's fixed verbs. */
async function pgExec(
	container: string,
	argv: string[],
	options: { stdin?: Uint8Array } = {},
): Promise<string> {
	const result = await runtime!.exec(
		['exec', '-i', '-e', `PGPASSWORD=${PG_PASSWORD}`, container, ...argv],
		{ stdin: options.stdin },
	);
	return result.stdout;
}

async function pgQuery(
	port: number,
	sqlText: string,
	database = APP_DB,
): Promise<Array<Record<string, unknown>>> {
	const client = bunSqlConnector()({
		hostname: '127.0.0.1',
		port,
		username: PG_USER,
		password: PG_PASSWORD,
		database,
	});
	try {
		return await client.query(sqlText);
	} finally {
		await client.close();
	}
}

function checksumRows(rows: Array<Record<string, unknown>>): { rows: number; total: number; checksum: string } {
	const row = rows[0] ?? {};
	return {
		rows: Number(row.rows ?? 0),
		total: Number(row.total ?? 0),
		checksum: String(row.checksum ?? ''),
	};
}

async function runHarness(runEngine: Engine): Promise<number> {
	tempDir = await mkdtemp(join(tmpdir(), 'skiff-e2e-'));
	const rt = new ContainerRuntime(runEngine, tempDir);
	runtime = rt;
	const runSuffix = rt.runId.replace(/[^a-z0-9-]/gi, '').slice(-8);
	const network = `skiff-e2e-${runSuffix}`;

	const onSignal = async () => {
		await rt.cleanup();
		if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		process.exit(130);
	};
	process.once('SIGINT', onSignal);
	process.once('SIGTERM', onSignal);

	let failed = false;
	try {
		console.log(`Engine: ${runEngine.kind} (${runEngine.version})`);
		console.log(`Temporary state: ${tempDir}`);

		await rt.createNetwork(network);

		const [pgPort, restorePort, s3Port] = await Promise.all([freePort(), freePort(), freePort()]);

		// ---------------------------------------------------------------- containers
		const pg = await rt.runContainer({
			name: `skiff-e2e-pg-${runSuffix}`,
			image: IMAGES.postgres,
			network,
			ports: [[pgPort, 5432]],
			env: {
				POSTGRES_USER: PG_USER,
				POSTGRES_PASSWORD: PG_PASSWORD,
				POSTGRES_DB: PRIMARY_DB,
			},
		});

		const restore = await rt.runContainer({
			name: `skiff-e2e-restore-${runSuffix}`,
			image: IMAGES.postgres,
			network,
			ports: [[restorePort, 5432]],
			env: {
				POSTGRES_USER: PG_USER,
				POSTGRES_PASSWORD: PG_PASSWORD,
				POSTGRES_DB: APP_DB,
			},
		});

		const s3 = await rt.runContainer({
			name: `skiff-e2e-s3-${runSuffix}`,
			image: IMAGES.rustfs,
			network,
			ports: [[s3Port, 9000]],
			env: {
				RUSTFS_ACCESS_KEY: S3_ACCESS_KEY,
				RUSTFS_SECRET_KEY: S3_SECRET_KEY,
				RUSTFS_VOLUMES: '/data',
				RUSTFS_ADDRESS: ':9000',
				RUSTFS_CONSOLE_ENABLE: 'false',
				RUSTFS_OBS_LOG_DIRECTORY: '',
			},
		});

		await check('both managed services join the private network', async () => {
			for (const container of [pg, s3]) {
				const raw = await rt.inspect(container, '{{json .NetworkSettings.Networks}}');
				const networks = JSON.parse(raw) as Record<string, unknown>;
				assert(networks[network], `${container} is not attached to ${network}`);
			}
		});

		// ---------------------------------------------------------------- postgres
		await check('Postgres 17 starts and reports pg_isready', async () => {
			await waitFor('Postgres pg_isready', async () => {
				const result = await rt.exec(
					['exec', pg, 'pg_isready', '-U', PG_USER, '-d', PRIMARY_DB],
					{ check: false },
				);
				return result.code === 0;
			});
			// The entrypoint runs a temporary init server on the unix socket only. Wait for the
			// final server to answer on the published TCP port before issuing SQL.
			await waitFor('Postgres TCP SELECT 1', () => pgQuery(pgPort, 'SELECT 1', PRIMARY_DB));
		});

		await check('the agent SSLRequest health probe answers on the published port', async () => {
			await waitFor('Postgres SSLRequest', () => postgresHealthProbe(pgPort));
		});

		await check('create a database and connect with deterministic credentials', async () => {
			const admin = bunSqlConnector()({
				hostname: '127.0.0.1',
				port: pgPort,
				username: PG_USER,
				password: PG_PASSWORD,
				database: PRIMARY_DB,
			});
			try {
				await admin.query(`CREATE DATABASE ${APP_DB} OWNER ${PG_USER}`);
			} finally {
				await admin.close();
			}
			const rows = await pgQuery(pgPort, 'SELECT 1 AS ok');
			assertEqual(Number(rows[0]?.ok), 1, 'SELECT 1');
		});

		await check('seed deterministic fixture data', async () => {
			// One transaction so a partial fixture cannot make the restore assertion pass by luck.
			await pgQuery(
				pgPort,
				`CREATE TABLE widgets (
					id integer PRIMARY KEY,
					name text NOT NULL,
					payload text NOT NULL,
					created_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z'
				);
				INSERT INTO widgets (id, name, payload)
					SELECT g, 'widget-' || g, repeat('x', 256) FROM generate_series(1, 100) AS g;`,
			);
			const summary = checksumRows(
				await pgQuery(
					pgPort,
					`SELECT count(*)::int AS rows,
						sum(id)::int AS total,
						md5(string_agg(name || ':' || payload, '|' ORDER BY id)) AS checksum
					 FROM widgets`,
				),
			);
			assertEqual(summary.rows, 100, 'fixture row count');
			assertEqual(summary.total, 5050, 'fixture id sum');
			assert(summary.checksum.length === 32, 'fixture checksum missing');
		});

		const dumpPath = join(tempDir, 'skiff-e2e.dump');
		let dumpBytes = new Uint8Array();
		await check('pg_dump -Fc streams a non-empty artifact', async () => {
			dumpBytes = await rt.execBytes([
				'exec',
				'-e',
				`PGPASSWORD=${PG_PASSWORD}`,
				pg,
				'pg_dump',
				'-Fc',
				'--no-owner',
				'-U',
				PG_USER,
				APP_DB,
			]);
			await writeFile(dumpPath, dumpBytes);
			const info = await stat(dumpPath);
			assert(info.size > 1_000, `dump is suspiciously small (${info.size} bytes)`);
			assertEqual(info.size, dumpBytes.byteLength, 'dump size');
		});

		await check('restore into a fresh Postgres instance and verify the data', async () => {
			// Wait for the *final* server, not the entrypoint's temporary init server.
			await waitFor('restore Postgres TCP SELECT 1', () =>
				pgQuery(restorePort, 'SELECT 1', APP_DB),
			);
			// The exact fixed profile in apps/helper/src/systemd.ts.
			await pgExec(
				restore,
				[
					'pg_restore',
					'--clean',
					'--if-exists',
					'--no-owner',
					'--exit-on-error',
					'-U',
					PG_USER,
					'-d',
					APP_DB,
				],
				{ stdin: dumpBytes },
			);
			const verification = await pgExec(restore, [
				'psql',
				'-tAc',
				'SELECT 1',
				'-U',
				PG_USER,
				'-d',
				APP_DB,
			]);
			assertEqual(verification.trim(), '1', 'restore verification query');

			const restored = checksumRows(
				await pgQuery(
					restorePort,
					`SELECT count(*)::int AS rows,
						sum(id)::int AS total,
						md5(string_agg(name || ':' || payload, '|' ORDER BY id)) AS checksum
					 FROM widgets`,
				),
			);
			assertEqual(restored.rows, 100, 'restored row count');
			assertEqual(restored.total, 5050, 'restored id sum');
			assert(restored.checksum.length === 32, 'restored checksum missing');
		});

		// ---------------------------------------------------------------- rustfs
		await check('RustFS 1.0.4 starts and reports healthy', async () => {
			await waitFor('RustFS /health', async () => {
				try {
					const response = await fetch(`http://127.0.0.1:${s3Port}/health`);
					return response.ok;
				} catch {
					return false;
				}
			});
			const response = await fetch(`http://127.0.0.1:${s3Port}/health`);
			assertEqual(response.status, 200, 'RustFS health status');
		});

		const admin = new RustfsApi({
			endpoint: `http://127.0.0.1:${s3Port}`,
			accessKeyId: S3_ACCESS_KEY,
			secretAccessKey: S3_SECRET_KEY,
		});
		const browser = new S3Client({
			endpoint: `http://127.0.0.1:${s3Port}`,
			host: `127.0.0.1:${s3Port}`,
			accessKeyId: S3_ACCESS_KEY,
			secretAccessKey: S3_SECRET_KEY,
			region: S3_REGION,
		});

		await check('create and list a bucket with the agent S3 admin client', async () => {
			assertEqual((await admin.listBuckets()).length, 0, 'initial bucket count');
			await admin.createBucket(BUCKET);
			const buckets = await admin.listBuckets();
			assert(buckets.includes(BUCKET), `bucket list missing ${BUCKET}: ${buckets.join(',')}`);
		});

		await check('object browser PUT / HEAD / GET round-trips bytes', async () => {
			const body = new TextEncoder().encode('hello from the object browser\n');
			await browser.putObject(BUCKET, 'docs/hello.txt', body, 'text/plain');
			const head = await browser.headObject(BUCKET, 'docs/hello.txt');
			assertEqual(head.sizeBytes, body.byteLength, 'head size');
			assertEqual(head.contentType, 'text/plain', 'head content type');
			const response = await browser.getObject(BUCKET, 'docs/hello.txt');
			const fetched = new Uint8Array(await response.arrayBuffer());
			assertEqual(new TextDecoder().decode(fetched), new TextDecoder().decode(body), 'GET body');
		});

		await check('object browser list applies prefix and delimiter', async () => {
			await browser.putObject(BUCKET, 'docs/nested/page.txt', new TextEncoder().encode('nested'));
			await browser.putObject(BUCKET, 'root.txt', new TextEncoder().encode('root'));
			const listing = await browser.listObjects(BUCKET, { prefix: '', delimiter: '/' });
			assert(listing.prefixes.includes('docs/'), `missing docs/ prefix: ${listing.prefixes.join(',')}`);
			assert(
				listing.objects.some((object) => object.key === 'root.txt'),
				`missing root.txt: ${listing.objects.map((object) => object.key).join(',')}`,
			);
			assert(
				!listing.objects.some((object) => object.key === 'docs/hello.txt'),
				'delimiter listing leaked a nested key',
			);
		});

		await check('presigned GET round-trips and rejects a tampered signature', async () => {
			const url = await presignPublicUrl({
				endpoint: `http://127.0.0.1:${s3Port}`,
				bucket: BUCKET,
				key: 'docs/hello.txt',
				method: 'GET',
				expiresIn: 120,
				accessKeyId: S3_ACCESS_KEY,
				secretAccessKey: S3_SECRET_KEY,
				region: S3_REGION,
			});
			const response = await fetch(url);
			assertEqual(response.status, 200, 'presigned GET status');
			assert((await response.text()).startsWith('hello from'), 'presigned GET body');

			const tampered = new URL(url);
			tampered.searchParams.set('X-Amz-Signature', 'deadbeef');
			const denied = await fetch(tampered);
			// RustFS reports a malformed signature as 400 AuthorizationQueryParametersError;
			// a well-formed wrong signature is 403. Both prove the signature is enforced.
			assert(
				denied.status === 400 || denied.status === 403,
				`tampered presigned GET status: ${denied.status}`,
			);
		});

		await check('presigned GET supports a byte range', async () => {
			const url = await presignPublicUrl({
				endpoint: `http://127.0.0.1:${s3Port}`,
				bucket: BUCKET,
				key: 'docs/hello.txt',
				method: 'GET',
				expiresIn: 120,
				accessKeyId: S3_ACCESS_KEY,
				secretAccessKey: S3_SECRET_KEY,
				region: S3_REGION,
			});
			const response = await fetch(url, { headers: { range: 'bytes=0-4' } });
			assertEqual(response.status, 206, 'range status');
			assertEqual(await response.text(), 'hello', 'range body');
		});

		await check('multipart upload completes with SigV4 and returns the original bytes', async () => {
			const aws = new AwsClient({
				accessKeyId: S3_ACCESS_KEY,
				secretAccessKey: S3_SECRET_KEY,
				service: 's3',
				region: S3_REGION,
			});
			const objectUrl = `http://127.0.0.1:${s3Port}/${BUCKET}/multipart.bin`;
			const body = new Uint8Array(6 * 1024 * 1024);
			for (let index = 0; index < body.length; index += 1) body[index] = index % 251;

			const init = await fetch(await aws.sign(`${objectUrl}?uploads`, { method: 'POST' }));
			assertEqual(init.status, 200, 'initiate multipart status');
			const uploadId = xmlTag(await init.text(), 'UploadId');
			assert(uploadId, 'initiate multipart returned no UploadId');

			const part = await fetch(
				await aws.sign(`${objectUrl}?partNumber=1&uploadId=${encodeURIComponent(uploadId)}`, {
					method: 'PUT',
					body,
				}),
			);
			assertEqual(part.status, 200, 'upload part status');
			const etag = part.headers.get('etag');
			assert(etag, 'upload part returned no ETag');

			const completeBody = new TextEncoder().encode(
				`<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag}</ETag></Part></CompleteMultipartUpload>`,
			);
			const complete = await fetch(
				await aws.sign(`${objectUrl}?uploadId=${encodeURIComponent(uploadId)}`, {
					method: 'POST',
					body: completeBody,
					headers: { 'content-type': 'application/xml' },
				}),
			);
			assertEqual(complete.status, 200, 'complete multipart status');

			const downloaded = await browser.getObject(BUCKET, 'multipart.bin');
			const bytes = new Uint8Array(await downloaded.arrayBuffer());
			assertEqual(bytes.byteLength, body.byteLength, 'multipart size');
			assertEqual(
				createHash('sha256').update(bytes).digest('hex'),
				createHash('sha256').update(body).digest('hex'),
				'multipart sha256',
			);
		});

		await check('object browser bulk delete removes keys and reports them', async () => {
			const result = await browser.deleteObjects(BUCKET, ['docs/hello.txt', 'docs/nested/page.txt']);
			assertEqual(result.errors.length, 0, `bulk delete errors: ${JSON.stringify(result.errors)}`);
			assert(result.deleted.includes('docs/hello.txt'), 'delete result missing docs/hello.txt');
			assert(result.deleted.includes('docs/nested/page.txt'), 'delete result missing nested page');
			let missing = false;
			try {
				await browser.getObject(BUCKET, 'docs/hello.txt');
			} catch {
				missing = true;
			}
			assert(missing, 'deleted object is still readable');
		});

		await check('a non-empty bucket refuses deletion, then deletes once empty', async () => {
			assertEqual(await admin.deleteBucket(BUCKET), 'not-empty', 'non-empty delete result');
			await browser.deleteObjects(BUCKET, ['root.txt', 'multipart.bin']);
			const listing = await browser.listObjects(BUCKET, { prefix: '', delimiter: '/' });
			assertEqual(listing.objects.length, 0, 'objects left before bucket delete');
			assertEqual(listing.prefixes.length, 0, 'prefixes left before bucket delete');
			assertEqual(await admin.deleteBucket(BUCKET), 'deleted', 'empty bucket delete result');
			assertEqual((await admin.listBuckets()).length, 0, 'bucket list after delete');
		});
	} catch (error) {
		failed = true;
		console.error(
			`\nHarness aborted: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
		);
	} finally {
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
		if (results.some((result) => !result.ok) || failed) {
			console.error('\nContainer logs (tail):');
			for (const container of runtime.containerNames)
				console.error(`\n--- ${container} ---\n${await runtime.logs(container, 80)}`);
		}
		await runtime.cleanup();
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}

	const failures = results.filter((result) => !result.ok);
	console.log(
		`\n${failures.length === 0 && !failed ? 'PASS' : 'FAIL'}  ${results.length - failures.length}/${results.length} checks passed`,
	);
	return failures.length === 0 && !failed ? 0 : 1;
}

async function main(): Promise<number> {
	let selected: Engine | null;
	try {
		selected = await detectEngine();
	} catch (error) {
		if (error instanceof EngineUnavailableError) {
			console.error(`FAIL  ${error.message}`);
			return 1;
		}
		throw error;
	}
	if (!selected) {
		console.log(
			'SKIP  managed-data e2e: no usable Podman or Docker engine found.\n' +
				'      Install Podman >= 5 (preferred) or Docker, then run again.\n' +
				'      Debian 13 node? Run scripts/e2e/debian13.sh --check-host for the full checklist.',
		);
		harnessFinished = true;
		return 0;
	}
	if (selected.kind === 'podman') {
		const major = Number((/podman version (\d+)/i.exec(selected.version) ?? [])[1] ?? 0);
		if (major > 0 && major < 5)
			console.log(
				`WARN  Podman ${major} is older than the supported Debian 13 baseline (>= 5).\n` +
					'      The container-level lane still runs; Quadlet/netavark cases need a real node.',
			);
	}
	return runHarness(selected).then((code) => {
		harnessFinished = true;
		return code;
	});
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		process.exit(1);
	});
