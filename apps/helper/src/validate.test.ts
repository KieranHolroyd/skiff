import { describe, expect, test } from 'bun:test';
import {
	assertAbsolutePath,
	assertCommand,
	assertEnvName,
	assertId,
	assertImage,
	assertPort,
	assertRelativePath,
	parseActivation,
	parseApplyRequest,
	parseWorkload,
	ValidationError,
} from './validate.ts';

const SHA = 'a'.repeat(64);

export function workloadInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'wld_abc123',
		projectId: 'prj_abc123',
		projectSlug: 'my-app',
		deploymentId: 'dep_abc123',
		runtime: 'process',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/skiff-workloads/prj_abc123.sock',
		memoryMb: 256,
		cpus: 1,
		port: 3000,
		healthPath: '/health',
		socketActivation: true,
		activationVersion: 'b'.repeat(64),
		env: { NODE_ENV: 'production' },
		secrets: [{ name: 'DATABASE_URL', delivery: 'env' }],
		dataSizeMb: null,
		...overrides,
	};
}

export function activationInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		workloadId: 'wld_abc123',
		activationVersion: 'b'.repeat(64),
		env: { DATABASE_URL: 'postgres://example' },
		files: {},
		...overrides,
	};
}

describe('identifiers', () => {
	test('accepts safe ids and rejects separators or traversal', () => {
		expect(assertId('wld_abc-123')).toBe('wld_abc-123');
		for (const value of ['../etc', 'a/b', 'a b', 'a.b', '', 'x\n']) {
			expect(() => assertId(value)).toThrow(ValidationError);
		}
	});

	test('relative paths cannot escape or use absolute paths', () => {
		expect(assertRelativePath('secrets/token')).toBe('secrets/token');
		for (const value of ['/etc/passwd', '../escape', 'a//b', 'a\\b', 'a b']) {
			expect(() => assertRelativePath(value)).toThrow(ValidationError);
		}
	});

	test('absolute paths reject whitespace and relative forms', () => {
		expect(assertAbsolutePath('/var/lib/skiff')).toBe('/var/lib/skiff');
		expect(() => assertAbsolutePath('var/lib')).toThrow(/absolute/);
		expect(() => assertAbsolutePath('/tmp/a b')).toThrow(/unsupported/);
	});
});

describe('field validation', () => {
	test('env names follow the shell-safe pattern', () => {
		expect(assertEnvName('DATABASE_URL')).toBe('DATABASE_URL');
		expect(() => assertEnvName('1BAD')).toThrow(ValidationError);
		expect(() => assertEnvName('BAD-NAME')).toThrow(ValidationError);
	});

	test('ports are in range', () => {
		expect(assertPort(1)).toBe(1);
		expect(assertPort(65535)).toBe(65535);
		for (const value of [0, 65536, 1.5, '80']) expect(() => assertPort(value)).toThrow(ValidationError);
	});

	test('commands are argv arrays with no control characters', () => {
		expect(assertCommand(['bun', 'run', 'start'])).toEqual(['bun', 'run', 'start']);
		expect(() => assertCommand('bun run start')).toThrow(ValidationError);
		expect(() => assertCommand([])).toThrow(ValidationError);
		expect(() => assertCommand(['sh', '-c', 'echo\nrm -rf /'])).toThrow(ValidationError);
		expect(() => assertCommand(['sh', '-c', 'a\tb'])).toThrow(/control/);
	});

	test('images are OCI refs, not shell fragments', () => {
		expect(assertImage('ghcr.io/acme/app:1.2.3')).toBe('ghcr.io/acme/app:1.2.3');
		expect(assertImage('localhost:5000/team/app:1.0')).toBe('localhost:5000/team/app:1.0');
		expect(assertImage('nginx@sha256:' + SHA)).toBe(`nginx@sha256:${SHA}`);
		for (const value of ['Nginx', 'app;rm -rf /', '../app', 'app:..', ''] ) {
			expect(() => assertImage(value)).toThrow(ValidationError);
		}
	});
});

describe('parseWorkload', () => {
	test('accepts a valid process workload', () => {
		const workload = parseWorkload(workloadInput());
		expect(workload.runtime).toBe('process');
		expect(workload.secrets).toEqual([{ name: 'DATABASE_URL', delivery: 'env' }]);
		expect(workload.socketActivation).toBe(true);
	});

	test('process requires a release and rejects an image', () => {
		expect(() => parseWorkload(workloadInput({ release: null }))).toThrow(/need a release/);
		expect(() => parseWorkload(workloadInput({ image: 'nginx' }))).toThrow(/cannot set an image/);
	});

	test('container requires an image and rejects a command', () => {
		const container = workloadInput({
			runtime: 'container',
			release: null,
			image: 'ghcr.io/acme/app:1.2.3',
		});
		expect(parseWorkload(container).image).toBe('ghcr.io/acme/app:1.2.3');
		expect(() => parseWorkload(workloadInput({ runtime: 'container', release: null }))).toThrow(/need an image/);
		expect(() => parseWorkload({ ...container, command: ['bun'] })).toThrow(/cannot set a command/);
	});

	test('rejects duplicate secret names and malformed secrets', () => {
		expect(() =>
			parseWorkload(
				workloadInput({
					secrets: [
						{ name: 'TOKEN', delivery: 'env' },
						{ name: 'TOKEN', delivery: 'file' },
					],
				}),
			),
		).toThrow(/Duplicate/);
		expect(() => parseWorkload(workloadInput({ secrets: [{ name: 'token', delivery: 'env' }] }))).toThrow(
			ValidationError,
		);
	});

	test('rejects an invalid health path and upstream type', () => {
		expect(() => parseWorkload(workloadInput({ healthPath: 'health' }))).toThrow(/start with/);
		expect(() => parseWorkload(workloadInput({ healthPath: '/a b' }))).toThrow(ValidationError);
		expect(() => parseWorkload(workloadInput({ upstream: 42 }))).toThrow(ValidationError);
	});
});

describe('parseActivation', () => {
	test('accepts matching activation and file secrets', () => {
		const workload = parseWorkload(
			workloadInput({ secrets: [{ name: 'TLS_KEY', delivery: 'file' }] }),
		);
		const activation = parseActivation(
			activationInput({ files: { TLS_KEY: '-----BEGIN KEY-----\nabc\n' } }),
			workload,
		);
		expect(activation.files.TLS_KEY).toContain('BEGIN KEY');
	});

	test('rejects a version mismatch and an undeclared file secret', () => {
		const workload = parseWorkload(workloadInput());
		expect(() => parseActivation(activationInput({ workloadId: 'wld_other' }), workload)).toThrow(
			/workloadId/,
		);
		expect(() => parseActivation(activationInput({ activationVersion: SHA }), workload)).toThrow(
			/activationVersion/,
		);
		expect(() => parseActivation(activationInput({ files: { TLS_KEY: 'x' } }), workload)).toThrow(
			/not a file secret/,
		);
	});

	test('parseApplyRequest validates both halves together', () => {
		const parsed = parseApplyRequest({ workload: workloadInput(), activation: activationInput() });
		expect(parsed.workload.id).toBe('wld_abc123');
		expect(parsed.activation.env.DATABASE_URL).toBe('postgres://example');
	});
});
