import { describe, expect, test } from 'bun:test';
import { BuildValidationError } from '../command.ts';
import {
	podmanJobArgs,
	podmanServiceArgs,
	qualifyImageRef,
	validateImageRef,
	validateJobId,
	type PodmanJobInput,
} from './podman.ts';

const base: PodmanJobInput = {
	jobId: 'job_abc123',
	image: 'docker.io/library/node:24-bookworm',
	dirs: {
		workspace: '/var/lib/yoal-builder/pipelines/job_abc123/workspace',
		meta: '/var/lib/yoal-builder/pipelines/job_abc123/meta',
		home: '/var/lib/yoal-builder/pipelines/job_abc123/home',
		tmp: '/var/lib/yoal-builder/pipelines/job_abc123/tmp',
	},
	stepBinary: '/opt/yoal/current/bin/yoal-agent',
	memoryMb: 2048,
	cpus: 2,
	network: null,
	ociBuild: false,
	fuse: false,
	env: { YOAL_CONTROL_URL: 'https://control.test' },
	inheritEnv: ['YOAL_JOB_TOKEN'],
};

describe('podmanJobArgs', () => {
	test('builds the W5 job container: userns=auto, no caps, no new privileges, limits, mounts', () => {
		expect(podmanJobArgs(base)).toEqual([
			'podman',
			'run',
			'--rm',
			'--init',
			'--name=yoal-job-job_abc123',
			'--userns=auto',
			'--cap-drop=all',
			'--security-opt=no-new-privileges',
			'--pids-limit=4096',
			'--memory=2048m',
			'--cpus=2',
			'-v',
			'/var/lib/yoal-builder/pipelines/job_abc123/workspace:/workspace:U',
			'-v',
			'/var/lib/yoal-builder/pipelines/job_abc123/meta:/yoal/meta:U,ro',
			'-v',
			'/var/lib/yoal-builder/pipelines/job_abc123/home:/yoal/home:U',
			'-v',
			'/var/lib/yoal-builder/pipelines/job_abc123/tmp:/yoal/tmp:U',
			'-v',
			'/opt/yoal/current/bin/yoal-agent:/yoal/bin/yoal-step:ro',
			'-w',
			'/workspace',
			'-e',
			'HOME=/yoal/home',
			'-e',
			'YOAL_CONTROL_URL=https://control.test',
			'-e',
			'YOAL_JOB_TOKEN',
			'--entrypoint',
			'/yoal/bin/yoal-step',
			'docker.io/library/node:24-bookworm',
			'pipeline-step',
			'/yoal/meta/job.json',
		]);
	});

	test('the job token is passed by name only, never as a value in argv', () => {
		const argv = podmanJobArgs(base);
		expect(argv.some((arg) => arg.startsWith('YOAL_JOB_TOKEN='))).toBe(false);
	});

	test('joins the per-job network when there are services', () => {
		expect(podmanJobArgs({ ...base, network: 'yoal-job-job_abc123' })).toContain('--network=yoal-job-job_abc123');
	});

	test('oci-build keeps default caps (pending WS2) and adds /dev/fuse when present', () => {
		const argv = podmanJobArgs({ ...base, ociBuild: true, fuse: true });
		expect(argv).not.toContain('--cap-drop=all');
		expect(argv).toContain('--userns=auto');
		expect(argv).toContain('--security-opt=no-new-privileges');
		expect(argv.join(' ')).toContain('--device /dev/fuse');
		expect(podmanJobArgs({ ...base, ociBuild: true, fuse: false })).not.toContain('--device');
	});

	test('rejects bad images, ids, paths and env names', () => {
		for (const image of ['', '--privileged', 'node:24 --rm', 'node;rm -rf /', 'UPPER/case', 'a'.repeat(600), 'node@sha256:short'])
			expect(() => podmanJobArgs({ ...base, image })).toThrow(BuildValidationError);
		for (const jobId of ['', '../x', 'a b', '-rf', 'a/b'])
			expect(() => podmanJobArgs({ ...base, jobId })).toThrow(BuildValidationError);
		expect(() => podmanJobArgs({ ...base, dirs: { ...base.dirs, workspace: '/tmp/a:/etc' } })).toThrow(BuildValidationError);
		expect(() => podmanJobArgs({ ...base, dirs: { ...base.dirs, home: '/tmp/../etc' } })).toThrow(BuildValidationError);
		expect(() => podmanJobArgs({ ...base, stepBinary: 'relative/bin' })).toThrow(BuildValidationError);
		expect(() => podmanJobArgs({ ...base, env: { 'BAD NAME': 'x' } })).toThrow(BuildValidationError);
		expect(() => podmanJobArgs({ ...base, inheritEnv: ['A=B'] })).toThrow(BuildValidationError);
		expect(() => podmanJobArgs({ ...base, memoryMb: Number.NaN })).toThrow(BuildValidationError);
	});
});

describe('image references', () => {
	test('accepts common forms', () => {
		for (const image of [
			'postgres',
			'postgres:17',
			'acme/api:v1.2.3',
			'ghcr.io/kieranholroyd/yoal-postgres:18-1',
			'localhost:5000/x/y:latest',
			`registry.example.com/a/b@sha256:${'a'.repeat(64)}`,
			`node:24@sha256:${'0'.repeat(64)}`,
		])
			expect(validateImageRef(image)).toBe(image);
	});

	test('qualifies short names with Docker Hub, like Docker does', () => {
		expect(qualifyImageRef('postgres:17')).toBe('docker.io/library/postgres:17');
		expect(qualifyImageRef('acme/api')).toBe('docker.io/acme/api');
		expect(qualifyImageRef('ghcr.io/a/b:1')).toBe('ghcr.io/a/b:1');
		expect(qualifyImageRef('localhost/x')).toBe('localhost/x');
	});

	test('job ids are plain', () => {
		expect(validateJobId('pjob_01HZY')).toBe('pjob_01HZY');
	});
});

describe('podmanServiceArgs', () => {
	test('runs detached on the job network with an alias; env values stay out of argv', () => {
		const argv = podmanServiceArgs({
			jobId: 'job1',
			name: 'postgres',
			spec: { image: 'postgres:17', env: {}, ports: [], healthCmd: 'pg_isready -U postgres' },
			env: { POSTGRES_PASSWORD: 'hunter2' },
			network: 'yoal-job-job1',
			memoryMb: 1024,
		});
		expect(argv).toEqual([
			'podman',
			'run',
			'-d',
			'--name=yoal-job-job1-svc-postgres',
			'--network=yoal-job-job1',
			'--network-alias=postgres',
			'--userns=auto',
			'--security-opt=no-new-privileges',
			'--pids-limit=4096',
			'--memory=1024m',
			'--health-cmd',
			'pg_isready -U postgres',
			'--health-interval=disable',
			'-e',
			'POSTGRES_PASSWORD',
			'docker.io/library/postgres:17',
		]);
		expect(argv.join(' ')).not.toContain('hunter2');
	});

	test('rejects odd service names', () => {
		const spec = { image: 'redis', env: {}, ports: [], healthCmd: null };
		for (const name of ['', 'a b', '-x', 'x'.repeat(70), 'a_b'])
			expect(() => podmanServiceArgs({ jobId: 'j', name, spec, env: {}, network: 'n', memoryMb: 512 })).toThrow(BuildValidationError);
	});
});
