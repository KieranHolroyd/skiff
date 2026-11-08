import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imagesInUnits, normalizeImageRef, planImagePrune, pruneNodeImages, type PodmanImage } from './images.ts';
import type { CommandRunner } from './systemd.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('normalizeImageRef', () => {
	test('qualifies Docker Hub names and defaults the tag', () => {
		expect(normalizeImageRef('nginx')).toBe('docker.io/library/nginx:latest');
		expect(normalizeImageRef('bitnami/redis:7')).toBe('docker.io/bitnami/redis:7');
		expect(normalizeImageRef('index.docker.io/library/nginx:1')).toBe('docker.io/library/nginx:1');
		expect(normalizeImageRef('ghcr.io/acme/api:1.0')).toBe('ghcr.io/acme/api:1.0');
		expect(normalizeImageRef(`ghcr.io/acme/api:1.0@${DIGEST}`)).toBe(`ghcr.io/acme/api@${DIGEST}`);
		expect(normalizeImageRef('localhost:5000/app')).toBe('localhost:5000/app:latest');
	});
});

describe('planImagePrune', () => {
	const keep = imagesInUnits([
		'[Container]\nImage=ghcr.io/acme/api@' + DIGEST + '\n',
		'[Container]\nImage=docker.io/library/postgres:17-alpine\n',
		'[Container]\nImage=build.image\n',
	]);
	const images: PodmanImage[] = [
		{ Id: '1'.repeat(64), Names: [], RepoDigests: [`ghcr.io/acme/api@${DIGEST}`], Size: 10 },
		{ Id: '2'.repeat(64), Names: ['docker.io/library/postgres:17-alpine'], Size: 20 },
		{ Id: '3'.repeat(64), Names: ['ghcr.io/acme/api:0.9'], Size: 30 },
		{ Id: '4'.repeat(64), Names: ['localhost/cairn-skiff:old'], Size: 40 },
		{ Id: '5'.repeat(64), Names: ['docker.io/library/busybox:latest'], Size: 50, Containers: 1 },
		{ Id: '6'.repeat(64), Names: null, RepoDigests: null, Size: 60 },
	];

	test('keeps unit images (by tag or digest), local images and images in use', () => {
		expect([...keep].sort()).toEqual(['docker.io/library/postgres:17-alpine', `ghcr.io/acme/api@${DIGEST}`]);
		const plan = planImagePrune(images, keep);
		expect(plan.keep.map((image) => image.Id[0])).toEqual(['1', '2', '4', '5']);
		expect(plan.remove.map((image) => image.Id[0])).toEqual(['3', '6']);
	});
});

describe('pruneNodeImages', () => {
	const dir = mkdtempSync(join(tmpdir(), 'skiff-images-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test('removes unreferenced images without --force and reports what failed', async () => {
		writeFileSync(join(dir, 'skiff-workload-wld_1.container'), '[Container]\nImage=ghcr.io/acme/api:1.0\n');
		writeFileSync(join(dir, 'notes.txt'), 'Image=ghcr.io/acme/old:1\n');
		const calls: string[][] = [];
		const runner: CommandRunner = {
			async run(argv) {
				calls.push(argv);
				if (argv[1] === 'images')
					return {
						code: 0,
						stderr: '',
						stdout: JSON.stringify([
							{ Id: 'a'.repeat(64), Names: ['ghcr.io/acme/api:1.0'], Size: 5 },
							{ Id: 'b'.repeat(64), Names: ['ghcr.io/acme/old:1'], Size: 7 },
							{ Id: 'c'.repeat(64), Names: ['ghcr.io/acme/parent:1'], Size: 9 },
						]),
					};
				if (argv[2] === 'c'.repeat(64)) return { code: 2, stdout: '', stderr: 'image has dependent child images' };
				return { code: 0, stdout: '', stderr: '' };
			},
		};
		const result = await pruneNodeImages({ runner, podmanPath: '/usr/bin/podman', quadletDir: dir });
		expect(calls.filter((argv) => argv[1] === 'rmi').map((argv) => argv.slice(1))).toEqual([
			['rmi', 'b'.repeat(64)],
			['rmi', 'c'.repeat(64)],
		]);
		expect(result.removed).toEqual([{ id: 'b'.repeat(12), names: ['ghcr.io/acme/old:1'], bytes: 7 }]);
		expect(result.reclaimedBytes).toBe(7);
		expect(result.kept).toBe(2);
		expect(result.failed[0]!.error).toContain('dependent child images');
	});
});
