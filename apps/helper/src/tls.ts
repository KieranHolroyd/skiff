import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-database TLS material (docs/DATABASES.md §10). The helper is the only process that writes
 * it; the private keys never reach the control plane, the agent, desired state or the journal.
 *
 * OpenSSL is invoked through the injected argv runner (never a shell string). The pinned Postgres
 * image does not ship a certificate generator, so the node's `openssl` does it. If generation
 * fails the caller renders the unit without TLS and records `tls/error`; a certificate bug must
 * never keep a database from starting.
 */

export interface TlsCommandRunner {
	run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface DatabaseTlsPaths {
	dir: string;
	caCert: string;
	serverCert: string;
	serverKey: string;
	/** Present only while TLS is rendered into the Postgres unit. */
	marker: string;
	/** Last generation error; present instead of `marker` after a failed attempt. */
	error: string;
}

export interface DatabaseTlsState {
	enabled: boolean;
	/** PEM of the CA certificate (public). Null when TLS is not active. */
	caPem: string | null;
	error: string | null;
}

export interface DatabaseTlsOptions {
	runner: TlsCommandRunner;
	opensslPath: string;
	/** Usually /run/skiff-workloads. */
	runtimeDir: string;
	id: string;
	/** Postgres network alias, used as the certificate CN/SAN. */
	alias: string;
	/** Hand the files to the image's postgres uid/gid (70:70). */
	chown?: (path: string, uid: number, gid: number) => Promise<void>;
}

export type DatabaseTlsGenerator = (options: DatabaseTlsOptions) => Promise<DatabaseTlsState>;

export const DATABASE_TLS_UID = 70;
export const DATABASE_TLS_GID = 70;
const VALIDITY_DAYS = 825;
const CA_VALIDITY_DAYS = 3650;

export function databaseTlsPaths(runtimeDir: string, id: string): DatabaseTlsPaths {
	const dir = join(runtimeDir, id, 'tls');
	return {
		dir,
		caCert: join(dir, 'ca.crt'),
		serverCert: join(dir, 'server.crt'),
		serverKey: join(dir, 'server.key'),
		marker: join(dir, 'enabled'),
		error: join(dir, 'error'),
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Read the state the last apply left on disk. Never throws. */
export async function readDatabaseTlsState(runtimeDir: string, id: string): Promise<DatabaseTlsState> {
	const paths = databaseTlsPaths(runtimeDir, id);
	const [enabled, error] = await Promise.all([
		exists(paths.marker),
		fs.readFile(paths.error, 'utf8').catch(() => null),
	]);
	if (!enabled) return { enabled: false, caPem: null, error: error?.trim().slice(0, 1_000) || null };
	const caPem = await fs.readFile(paths.caCert, 'utf8').catch(() => null);
	if (!caPem) return { enabled: false, caPem: null, error: 'The TLS CA certificate is missing on the node.' };
	return { enabled: true, caPem, error: null };
}

async function run(runner: TlsCommandRunner, argv: string[]): Promise<void> {
	const result = await runner.run(argv);
	if (result.code !== 0) {
		const detail = (result.stderr.trim() || result.stdout.trim() || 'no detail').slice(0, 500);
		throw new Error(`${argv[0]?.split('/').pop() ?? 'openssl'} failed (${result.code}): ${detail}`);
	}
}

/** Generate (or reuse) a per-database CA and server certificate, all 0400. */
export async function generateDatabaseTls(options: DatabaseTlsOptions): Promise<DatabaseTlsState> {
	const paths = databaseTlsPaths(options.runtimeDir, options.id);
	await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
	await fs.chmod(paths.dir, 0o700);
	await options.chown?.(paths.dir, DATABASE_TLS_UID, DATABASE_TLS_GID);

	const reusable =
		(await exists(paths.caCert)) &&
		(await exists(paths.serverCert)) &&
		(await exists(paths.serverKey));
	if (reusable) {
		for (const path of [paths.caCert, paths.serverCert, paths.serverKey]) {
			await fs.chmod(path, 0o400);
			await options.chown?.(path, DATABASE_TLS_UID, DATABASE_TLS_GID);
		}
		await fs.rm(paths.marker, { force: true });
		await fs.writeFile(paths.marker, '1\n', { mode: 0o400 });
		await options.chown?.(paths.marker, DATABASE_TLS_UID, DATABASE_TLS_GID);
		await fs.rm(paths.error, { force: true });
		return readDatabaseTlsState(options.runtimeDir, options.id);
	}

	await fs.rm(paths.marker, { force: true });
	await fs.rm(paths.error, { force: true });

	const caKey = join(paths.dir, 'ca.key');
	const serverCsr = join(paths.dir, 'server.csr');
	const extFile = join(paths.dir, 'server.ext');
	const serial = join(paths.dir, 'ca.srl');

	try {
		await run(options.runner, [
			options.opensslPath,
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-sha256',
			'-nodes',
			'-days',
			String(CA_VALIDITY_DAYS),
			'-subj',
			'/CN=Skiff managed database CA',
			'-keyout',
			caKey,
			'-out',
			paths.caCert,
		]);
		await run(options.runner, [
			options.opensslPath,
			'req',
			'-new',
			'-newkey',
			'rsa:2048',
			'-sha256',
			'-nodes',
			'-subj',
			`/CN=${options.alias}`,
			'-keyout',
			paths.serverKey,
			'-out',
			serverCsr,
		]);
		await fs.writeFile(
			extFile,
			[
				`subjectAltName=DNS:${options.alias},DNS:${options.alias}-pool,DNS:localhost,IP:127.0.0.1`,
				'basicConstraints=CA:FALSE',
				'keyUsage=digitalSignature,keyEncipherment',
				'extendedKeyUsage=serverAuth',
				'',
			].join('\n'),
			{ mode: 0o600 },
		);
		await run(options.runner, [
			options.opensslPath,
			'x509',
			'-req',
			'-in',
			serverCsr,
			'-CA',
			paths.caCert,
			'-CAkey',
			caKey,
			'-CAcreateserial',
			'-CAserial',
			serial,
			'-days',
			String(VALIDITY_DAYS),
			'-sha256',
			'-extfile',
			extFile,
			'-out',
			paths.serverCert,
		]);
		for (const path of [paths.caCert, paths.serverCert, paths.serverKey]) {
			await fs.chmod(path, 0o400);
			await options.chown?.(path, DATABASE_TLS_UID, DATABASE_TLS_GID);
		}
		await fs.writeFile(paths.marker, '1\n', { mode: 0o400 });
		await options.chown?.(paths.marker, DATABASE_TLS_UID, DATABASE_TLS_GID);
		await fs.rm(paths.error, { force: true });
		return readDatabaseTlsState(options.runtimeDir, options.id);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		await fs.rm(paths.marker, { force: true });
		await fs.rm(paths.serverKey, { force: true });
		await fs.rm(paths.serverCert, { force: true });
		await fs.rm(paths.caCert, { force: true });
		await fs.writeFile(paths.error, `${detail}\n`, { mode: 0o600 }).catch(() => undefined);
		throw error;
	} finally {
		await fs.rm(caKey, { force: true });
		await fs.rm(serverCsr, { force: true });
		await fs.rm(extFile, { force: true });
		await fs.rm(serial, { force: true });
	}
}

/** Remove the marker so a later status reports TLS as disabled; certificates stay for reuse. */
export async function disableDatabaseTls(runtimeDir: string, id: string): Promise<void> {
	const paths = databaseTlsPaths(runtimeDir, id);
	await fs.rm(paths.marker, { force: true });
	await fs.rm(paths.error, { force: true });
}
