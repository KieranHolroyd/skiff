import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertMailHost, copyMailTls } from './mail.ts';
import { createHandler, type HelperRuntime } from './server.ts';

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), 'skiff-helper-mail-'));
	dirs.push(dir);
	return dir;
}

describe('mail certificate copy', () => {
	test('only smtp.* / mx.* names are accepted', () => {
		expect(assertMailHost('smtp.example.com')).toBe('smtp.example.com');
		expect(assertMailHost('mx1.example.com')).toBe('mx1.example.com');
		for (const bad of ['*.sites.example.com', 'example.com', 'smtp.example.com/../x', 'SMTP.example.com', 'www.example.com', 42])
			expect(() => assertMailHost(bad)).toThrow();
	});

	test('copies the newest certificate, owned like the agent, and reports changes', async () => {
		const root = await tempDir();
		const caddy = join(root, 'caddy');
		const host = 'smtp.example.com';
		for (const [issuer, body] of [['acme-old', 'OLD'], ['acme-new', 'NEW']] as const) {
			await fs.mkdir(join(caddy, 'certificates', issuer, host), { recursive: true });
			await fs.writeFile(join(caddy, 'certificates', issuer, host, `${host}.crt`), `${body} CERT`);
			await fs.writeFile(join(caddy, 'certificates', issuer, host, `${host}.key`), `${body} KEY`);
			await Bun.sleep(5);
		}
		const owned: string[] = [];
		const options = { caddyDataDir: caddy, outDir: join(root, 'out'), ownerFrom: root, chown: async (path: string) => void owned.push(path) };
		expect(await copyMailTls(host, options)).toEqual({ found: true, changed: true });
		expect(await fs.readFile(join(root, 'out', 'cert.pem'), 'utf8')).toBe('NEW CERT');
		expect(((await fs.stat(join(root, 'out', 'key.pem'))).mode & 0o777).toString(8)).toBe('600');
		expect(owned.length).toBe(3);
		expect(await copyMailTls(host, options)).toEqual({ found: true, changed: false });
		expect(await copyMailTls('smtp.other.com', options)).toEqual({ found: false, changed: false });
	});
});

describe('mail verbs', () => {
	const runtime = (extra: Partial<HelperRuntime>) => ({ ...extra }) as unknown as HelperRuntime;
	const post = (path: string, body?: unknown) =>
		new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

	test('start/stop call the fixed unit verbs and take no input', async () => {
		const calls: string[] = [];
		const handler = createHandler(runtime({ startMail: async () => void calls.push('start'), stopMail: async () => void calls.push('stop') }), { version: '0.1.0' });
		expect((await handler(post('/v1/mail/start'))).status).toBe(200);
		expect((await handler(post('/v1/mail/stop'))).status).toBe(200);
		expect(calls).toEqual(['start', 'stop']);
		expect((await handler(post('/v1/mail/start', { unit: 'sshd.service' }))).status).toBe(400);
	});

	test('a runtime without mail support answers 501; bad hosts are refused', async () => {
		expect((await createHandler(runtime({}), { version: '0.1.0' })(post('/v1/mail/start'))).status).toBe(501);
		const handler = createHandler(runtime({ copyMailTls: async () => ({ found: true, changed: false }) }), { version: '0.1.0' });
		expect((await handler(post('/v1/mail/tls', { host: 'smtp.example.com' }))).status).toBe(200);
		expect((await handler(post('/v1/mail/tls', { host: '*.sites.example.com' }))).status).toBe(400);
	});
});
