import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnRunner } from './systemd.ts';
import {
	databaseTlsPaths,
	disableDatabaseTls,
	generateDatabaseTls,
	readDatabaseTlsState,
} from './tls.ts';

const directories: string[] = [];
const openssl = Bun.which('openssl');

async function fixture() {
	const root = await fs.mkdtemp(join(tmpdir(), 'yoal-helper-tls-'));
	directories.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('database TLS', () => {
	test.skipIf(!openssl)('generates a CA and server certificate as 0400 files', async () => {
		const root = await fixture();
		const state = await generateDatabaseTls({
			runner: spawnRunner(),
			opensslPath: openssl!,
			runtimeDir: root,
			id: 'db_0123456789abcdef0123456789abcdef',
			alias: 'db-0123456789abcdef0123456789abcdef',
		});

		expect(state.enabled).toBe(true);
		expect(state.error).toBeNull();
		expect(state.caPem).toContain('BEGIN CERTIFICATE');

		const paths = databaseTlsPaths(root, 'db_0123456789abcdef0123456789abcdef');
		for (const path of [paths.caCert, paths.serverCert, paths.serverKey]) {
			expect((await fs.stat(path)).mode & 0o777).toBe(0o400);
		}
		// The private signing key is removed; only the CA certificate and server pair remain.
		await expect(fs.stat(join(paths.dir, 'ca.key'))).rejects.toThrow();
		await expect(fs.stat(join(paths.dir, 'server.csr'))).rejects.toThrow();
	});

	test.skipIf(!openssl)('completes a TLS handshake that verifies against the generated CA', async () => {
		const root = await fixture();
		const id = 'db_0123456789abcdef0123456789abcdef';
		const alias = 'db-0123456789abcdef0123456789abcdef';
		await generateDatabaseTls({
			runner: spawnRunner(),
			opensslPath: openssl!,
			runtimeDir: root,
			id,
			alias,
		});
		const paths = databaseTlsPaths(root, id);

		// Pick a free loopback port, then let openssl act as a fake Postgres TLS endpoint.
		const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
		const port = probe.port;
		probe.stop(true);
		const server = Bun.spawn(
			[
				openssl!,
				's_server',
				'-accept',
				`127.0.0.1:${port}`,
				'-cert',
				paths.serverCert,
				'-key',
				paths.serverKey,
				'-CAfile',
				paths.caCert,
				'-verify',
				'0',
				'-quiet',
			],
			{ stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
		);
		try {
			let handshake: { code: number; stdout: string; stderr: string } | null = null;
			for (let attempt = 0; attempt < 20 && handshake?.code !== 0; attempt++) {
				await Bun.sleep(50);
				const client = Bun.spawn(
					[
						openssl!,
						's_client',
						'-connect',
						`127.0.0.1:${port}`,
						'-CAfile',
						paths.caCert,
						'-verify_return_error',
						'-servername',
						alias,
					],
					{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
				);
				const [code, stdout, stderr] = await Promise.all([
					client.exited,
					new Response(client.stdout).text(),
					new Response(client.stderr).text(),
				]);
				handshake = { code, stdout, stderr };
			}
			expect(handshake?.code).toBe(0);
			expect(handshake?.stdout ?? '').toContain('Verify return code: 0 (ok)');
		} finally {
			server.kill();
			await server.exited.catch(() => undefined);
		}
	});

	test.skipIf(!openssl)('reuses an existing marker instead of restarting Postgres for a new cert', async () => {
		const root = await fixture();
		const options = {
			runner: spawnRunner(),
			opensslPath: openssl!,
			runtimeDir: root,
			id: 'db_0123456789abcdef0123456789abcdef',
			alias: 'db-0123456789abcdef0123456789abcdef',
		};
		const first = await generateDatabaseTls(options);
		const paths = databaseTlsPaths(root, options.id);
		const before = await fs.stat(paths.serverCert);
		const second = await generateDatabaseTls(options);
		const after = await fs.stat(paths.serverCert);
		expect(second.caPem).toBe(first.caPem);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	test('disable removes the marker but keeps the certificate for reuse', async () => {
		const root = await fixture();
		const paths = databaseTlsPaths(root, 'db_0123456789abcdef0123456789abcdef');
		await fs.mkdir(paths.dir, { recursive: true });
		await fs.writeFile(paths.marker, '1\n');
		await fs.writeFile(paths.caCert, '-----BEGIN CERTIFICATE-----\n');
		await disableDatabaseTls(root, 'db_0123456789abcdef0123456789abcdef');
		expect(await readDatabaseTlsState(root, 'db_0123456789abcdef0123456789abcdef')).toEqual({
			enabled: false,
			caPem: null,
			error: null,
		});
		expect(await fs.readFile(paths.caCert, 'utf8')).toContain('BEGIN CERTIFICATE');
	});
});
