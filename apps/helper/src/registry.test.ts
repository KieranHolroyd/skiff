import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAdminHtpasswd, parseRegistryProfile, renderZotConfig } from './registry.ts';
import { MIRROR_CONF_NAME, applyMirror, parseMirrorRequest, renderMirrorConf } from './registry-mirror.ts';

const base = { engine: 'zot', version: '2.1.23', service: 'registry.example.com', realm: 'https://control.example.com/api/registry/token' };
const htpasswd = `yoal-admin:$2b$10$${'a'.repeat(53)}`;

describe('zot config (G4–G6)', () => {
	test('mirrors sync on demand under their upstream prefix', () => {
		const config = JSON.parse(renderZotConfig(parseRegistryProfile({ ...base, mirrors: ['docker.io', 'quay.io'] }), null));
		expect(config.extensions.sync.registries).toEqual([
			{ urls: ['https://index.docker.io'], content: [{ prefix: '**', destination: '/docker.io' }], onDemand: true, tlsVerify: true, maxRetries: 2, retryDelay: '5s' },
			{ urls: ['https://quay.io'], content: [{ prefix: '**', destination: '/quay.io' }], onDemand: true, tlsVerify: true, maxRetries: 2, retryDelay: '5s' },
		]);
		expect(config.extensions.sync.downloadDir).toBeUndefined();
	});

	test('trust adds the admin htpasswd and the trust extension; CVE scanning adds the scanner', () => {
		const registry = parseRegistryProfile({ ...base, trust: true, cve: true });
		expect(() => renderZotConfig(registry, null)).toThrow(/admin htpasswd/);
		const config = JSON.parse(renderZotConfig(registry, { certificatePem: '', eventsUrl: null, adminHtpasswd: `${htpasswd}\n`, s3: null }));
		expect(config.http.auth.htpasswd).toEqual({ path: '/etc/zot/htpasswd' });
		expect(config.http.accessControl.adminPolicy.users).toEqual(['yoal-admin']);
		expect(config.extensions.trust).toEqual({ enable: true, cosign: true, notation: true });
		expect(config.extensions.search.cve).toEqual({ updateInterval: '24h' });
		expect(config.http.auth.bearer.service).toBe('registry.example.com');
	});

	test('S3 storage uses the redis cache, stages sync downloads, and refuses CVE scanning', () => {
		const s3 = { endpoint: 's3.example.com:9000', bucket: 'images', region: 'us-east-1', secure: true };
		expect(() => parseRegistryProfile({ ...base, s3, cve: true })).toThrow(/CVE/);
		const registry = parseRegistryProfile({ ...base, s3, mirrors: ['docker.io'] });
		expect(() => renderZotConfig(registry, null)).toThrow(/credentials/);
		const config = JSON.parse(
			renderZotConfig(registry, {
				certificatePem: '',
				eventsUrl: null,
				adminHtpasswd: null,
				s3: { accessKey: 'AK', secretKey: 'SK', cacheUrl: 'redis://cache:6379' },
			}),
		);
		expect(config.storage.remoteCache).toBe(true);
		expect(config.storage.cacheDriver).toEqual({ name: 'redis', url: 'redis://cache:6379', keyprefix: 'zot' });
		expect(config.storage.storageDriver).toMatchObject({
			name: 's3',
			regionendpoint: 's3.example.com:9000',
			bucket: 'images',
			forcepathstyle: true,
			secure: true,
			accesskey: 'AK',
			secretkey: 'SK',
		});
		expect(config.extensions.sync.downloadDir).toBe('/var/lib/registry/.sync');
	});

	test('validates the profile and the htpasswd line', () => {
		expect(() => parseRegistryProfile({ ...base, mirrors: ['evil.io'] })).toThrow(/mirrors/);
		expect(() => parseRegistryProfile({ ...base, s3: { endpoint: 'http://x', bucket: 'bkt', region: 'r', secure: true } })).toThrow(/endpoint/);
		expect(assertAdminHtpasswd(htpasswd)).toBe(`${htpasswd}\n`);
		expect(() => assertAdminHtpasswd('root:$2b$10$x')).toThrow(/htpasswd/);
	});
});

describe('registry mirror on a node (G4)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'yoal-mirror-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const paths = { confDir: join(dir, 'registries.conf.d'), authFile: join(dir, 'run', 'auth.json') };

	test('renders one mirrored [[registry]] per upstream', () => {
		expect(renderMirrorConf('registry.example.com', ['docker.io'])).toContain(
			'[[registry]]\nprefix = "docker.io"\nlocation = "docker.io"\n\n[[registry.mirror]]\nlocation = "registry.example.com/docker.io"\n',
		);
	});

	test('writes the mirror and merges the node login without touching other logins, then removes both', async () => {
		await Bun.write(paths.authFile, JSON.stringify({ auths: { 'ghcr.io': { auth: 'b3BlcmF0b3I=' } } }));
		const request = parseMirrorRequest({ host: 'registry.example.com', upstreams: ['docker.io', 'ghcr.io'], username: 'node.nod_1', password: 'tok' });
		expect((await applyMirror(request, paths)).changed).toBe(true);
		expect((await applyMirror(request, paths)).changed).toBe(false);
		expect(readFileSync(join(paths.confDir, MIRROR_CONF_NAME), 'utf8')).toContain('location = "registry.example.com/ghcr.io"');
		const auths = JSON.parse(readFileSync(paths.authFile, 'utf8')).auths;
		expect(auths['ghcr.io']).toEqual({ auth: 'b3BlcmF0b3I=' });
		expect(Buffer.from(auths['registry.example.com'].auth, 'base64').toString()).toBe('node.nod_1:tok');
		await applyMirror(parseMirrorRequest({ host: 'registry.example.com', upstreams: [], username: '', password: '' }), paths);
		expect(() => readFileSync(join(paths.confDir, MIRROR_CONF_NAME))).toThrow();
		expect(JSON.parse(readFileSync(paths.authFile, 'utf8')).auths).toEqual({ 'ghcr.io': { auth: 'b3BlcmF0b3I=' } });
	});

	test('refuses bad hosts, upstreams and logins', () => {
		expect(() => parseMirrorRequest({ host: 'https://x', upstreams: [], username: '', password: '' })).toThrow(/host/);
		expect(() => parseMirrorRequest({ host: 'r.example.com', upstreams: ['evil.io'], username: 'n', password: 'p' })).toThrow(/upstreams/);
		expect(() => parseMirrorRequest({ host: 'r.example.com', upstreams: ['docker.io'], username: 'a:b', password: 'p' })).toThrow(/username/);
	});
});
