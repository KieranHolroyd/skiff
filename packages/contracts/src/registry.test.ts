import { describe, expect, test } from 'bun:test';
import {
	isLocalImage,
	normalizeRegistryHost,
	parseImageReference,
	pinnedImageReference,
	registryCredentialCreateSchema,
	workloadSpecSchema,
} from './index.ts';

const DIGEST = `sha256:${'d'.repeat(64)}`;

describe('parseImageReference', () => {
	test('normalises Docker Hub names', () => {
		expect(parseImageReference('nginx')).toEqual({ registry: 'docker.io', repository: 'library/nginx', tag: null, digest: null });
		expect(parseImageReference('nginx:1.27-alpine')?.tag).toBe('1.27-alpine');
		expect(parseImageReference('bitnami/redis:7')?.repository).toBe('bitnami/redis');
		expect(parseImageReference('index.docker.io/library/nginx')?.registry).toBe('docker.io');
	});

	test('keeps registries, ports, tags and digests apart', () => {
		expect(parseImageReference('ghcr.io/acme/api:1.0')).toEqual({
			registry: 'ghcr.io',
			repository: 'acme/api',
			tag: '1.0',
			digest: null,
		});
		expect(parseImageReference(`registry.example.com:5000/team/app/web:v2@${DIGEST}`)).toEqual({
			registry: 'registry.example.com:5000',
			repository: 'team/app/web',
			tag: 'v2',
			digest: DIGEST,
		});
		expect(parseImageReference('localhost/cairn-yoal:2026-11-07')?.registry).toBe('localhost');
		expect(parseImageReference('localhost:5000/app')?.registry).toBe('localhost:5000');
	});

	test('rejects what is not a reference', () => {
		for (const bad of ['', 'UPPER/case', 'a b', 'ghcr.io/acme/api@sha256:short', 'ghcr.io//x', 'x:bad tag', 'x:'])
			expect(parseImageReference(bad)).toBeNull();
	});

	test('pins to registry/repository@digest without the tag', () => {
		expect(pinnedImageReference('ghcr.io/acme/api:1.0', DIGEST)).toBe(`ghcr.io/acme/api@${DIGEST}`);
		expect(pinnedImageReference('nginx:1.27', DIGEST)).toBe(`docker.io/library/nginx@${DIGEST}`);
		expect(pinnedImageReference('nginx:1.27', 'sha256:nope')).toBe('nginx:1.27');
	});

	test('recognises local images and Docker Hub aliases', () => {
		expect(isLocalImage('localhost/app:1')).toBe(true);
		expect(isLocalImage('ghcr.io/app:1')).toBe(false);
		expect(normalizeRegistryHost('Registry-1.Docker.io')).toBe('docker.io');
	});
});

describe('registry credential input', () => {
	test('normalises the host and refuses localhost', () => {
		expect(registryCredentialCreateSchema.parse({ name: 'hub', registry: 'INDEX.docker.io', username: 'u', password: 'p' }).registry).toBe(
			'docker.io',
		);
		expect(() => registryCredentialCreateSchema.parse({ name: 'x', registry: 'ghcr.io', username: 'u', password: 'p' })).toThrow();
		expect(() => registryCredentialCreateSchema.parse({ name: 'loc', registry: 'localhost', username: 'u', password: 'p' })).toThrow();
		expect(() => registryCredentialCreateSchema.parse({ name: 'web', registry: 'https://ghcr.io', username: 'u', password: 'p' })).toThrow();
	});
});

describe('imageDigest on the workload spec', () => {
	test('only containers carry a well-formed digest', () => {
		const base = { runtime: 'container', image: 'ghcr.io/acme/api:1' } as const;
		expect(workloadSpecSchema.parse({ ...base, imageDigest: DIGEST }).imageDigest).toBe(DIGEST);
		expect(() => workloadSpecSchema.parse({ ...base, imageDigest: 'sha256:abc' })).toThrow();
		expect(() => workloadSpecSchema.parse({ runtime: 'process', imageDigest: DIGEST })).toThrow(/Only container/);
	});
});
