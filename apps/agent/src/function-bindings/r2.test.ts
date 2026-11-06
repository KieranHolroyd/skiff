import { describe, expect, test } from 'bun:test';
import {
	workloadDesiredSchema,
	type FunctionRuntimeBinding,
	type WorkloadDesired,
} from '@skiff/contracts';
import { renderR2Binding } from './r2.ts';
import type { BindingRenderContext } from './types.ts';

const SHA = 'c'.repeat(64);

/** A valid desired workload as a node receives it, parsed through the contract schema. */
function functionWorkload(
	bindings: FunctionRuntimeBinding[] = [],
	options: { projectId?: string; compatibilityDate?: string } = {},
): WorkloadDesired {
	return workloadDesiredSchema.parse({
		id: 'wl_1',
		projectId: options.projectId ?? 'prj_1',
		projectSlug: 'api',
		deploymentId: 'dep_1',
		runtime: 'function',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/skiff-workloads/wl_1.sock',
		memoryMb: 128,
		cpus: 1,
		port: 3000,
		healthPath: '/__skiff/health',
		socketActivation: true,
		activationVersion: SHA,
		function: {
			main: 'index.js',
			modules: [{ name: 'index.js', type: 'esm', sha256: SHA }],
			compatibilityDate: options.compatibilityDate ?? '2026-10-01',
			compatibilityFlags: [],
			bindings,
			workerdVersion: '1.20261106.1',
		},
	});
}

function render(
	binding: FunctionRuntimeBinding,
	options: { workload?: WorkloadDesired; index?: number; env?: Record<string, string> } = {},
) {
	const context: BindingRenderContext = {
		workload: options.workload ?? functionWorkload([binding]),
		env: options.env ?? {},
		binding,
		index: options.index ?? 0,
	};
	return renderR2Binding(context);
}

const R2_BINDING: FunctionRuntimeBinding = {
	name: 'BUCKET',
	type: 'r2',
	storage: 'media',
	bucket: 'uploads',
	prefix: 'tenant/',
	envPrefix: 'MEDIA',
};

describe('renderR2Binding', () => {
	test('renders the exact R2 service block', () => {
		const rendered = render(R2_BINDING);
		expect(rendered.services).toEqual([
			[
				'    ( name = "r2-api-0",',
				'      worker = (',
				'        modules = [',
				'          ( name = "r2.worker", esModule = embed "binding-r2" ),',
				'        ],',
				'        compatibilityDate = "2026-10-01",',
				'        compatibilityFlags = [],',
				'        bindings = [',
				'          ( name = "MEDIA_ENDPOINT_URL", fromEnvironment = "MEDIA_ENDPOINT_URL" ),',
				'          ( name = "MEDIA_ACCESS_KEY_ID", fromEnvironment = "MEDIA_ACCESS_KEY_ID" ),',
				'          ( name = "MEDIA_SECRET_ACCESS_KEY", fromEnvironment = "MEDIA_SECRET_ACCESS_KEY" ),',
				'          ( name = "MEDIA_REGION", fromEnvironment = "MEDIA_REGION" ),',
				'          ( name = "MEDIA_FORCE_PATH_STYLE", fromEnvironment = "MEDIA_FORCE_PATH_STYLE" ),',
				'          ( name = "BUCKET_NAME", text = "uploads" ),',
				'          ( name = "KEY_PREFIX", text = "tenant/" ),',
				'        ],',
				'      ) ),',
			].join('\n'),
		]);
	});

	test('binds the bucket capability on the main Worker only', () => {
		const rendered = render(R2_BINDING);
		expect(rendered.mainBindings).toEqual(['        ( name = "BUCKET", r2Bucket = "r2-api-0" )']);
		expect(rendered.mainFields).toBeUndefined();
	});

	test('uses no Durable Object storage, namespace or disk service', () => {
		const rendered = render(R2_BINDING);
		expect(rendered.requiresDurableStorage).toBe(false);
		expect(rendered.namespaces).toEqual([]);
		expect(rendered.services[0]).not.toContain('durableObjectStorage');
		expect(rendered.services[0]).not.toContain('durableObjectNamespaces');
	});

	test('embeds the R2 worker under the binding-r2 credential', () => {
		const rendered = render(R2_BINDING);
		expect(Object.keys(rendered.files)).toEqual(['binding-r2']);
		const source = rendered.files['binding-r2']!;
		expect(source).toContain('export default');
		expect(source).toContain('Miniflare (Apache-2.0)');
		expect(source).toContain("'cf-r2-request'");
		expect(source).toContain('AWS4-HMAC-SHA256');
		expect(source.length).toBeGreaterThan(10_000);
	});

	test('numbers services by binding index and keeps two R2 bindings apart', () => {
		const other: FunctionRuntimeBinding = {
			name: 'ARCHIVE',
			type: 'r2',
			storage: 'cold',
			bucket: 'archive',
			envPrefix: 'ARCHIVE',
		};
		const workload = functionWorkload([R2_BINDING, other]);
		const first = render(R2_BINDING, { workload, index: 0 });
		const second = render(other, { workload, index: 1 });

		expect(first.services[0]).toContain('( name = "r2-api-0",');
		expect(second.services[0]).toContain('( name = "r2-api-1",');
		expect(first.mainBindings).toEqual(['        ( name = "BUCKET", r2Bucket = "r2-api-0" )']);
		expect(second.mainBindings).toEqual(['        ( name = "ARCHIVE", r2Bucket = "r2-api-1" )']);
		expect(second.services[0]).toContain('( name = "ARCHIVE_ENDPOINT_URL", fromEnvironment = "ARCHIVE_ENDPOINT_URL" ),');
	});

	test('an absent prefix renders an empty KEY_PREFIX text binding', () => {
		const rendered = render({ ...R2_BINDING, prefix: undefined });
		expect(rendered.services[0]).toContain('          ( name = "KEY_PREFIX", text = "" ),');
	});

	test('escapes prefix and bucket text so they cannot break out of the capnp literal', () => {
		const rendered = render({ ...R2_BINDING, prefix: 'quote " backslash \\ newline\n' });
		expect(rendered.services[0]).toContain(
			'          ( name = "KEY_PREFIX", text = "quote \\" backslash \\\\ newline\\n" ),',
		);
		// capnpText escapes control characters: no raw newline splits the block.
		expect(rendered.services[0]!.split('\n')).toHaveLength(17);
	});

	test('never reads or embeds activation secrets', () => {
		const rendered = render(R2_BINDING, {
			env: {
				MEDIA_SECRET_ACCESS_KEY: 'super-secret-value',
				MEDIA_ACCESS_KEY_ID: 'SKFACCESSKEY',
				MEDIA_ENDPOINT_URL: 'http://127.0.0.1:19000',
			},
		});
		const serialised = JSON.stringify(rendered);
		expect(serialised).not.toContain('super-secret-value');
		expect(serialised).not.toContain('http://127.0.0.1:19000');
		// The credential names are present, but only as fromEnvironment references.
		expect(serialised).toContain('MEDIA_SECRET_ACCESS_KEY');
	});

	test('refuses a binding of another type', () => {
		expect(() => render({ name: 'CACHE', type: 'cache' })).toThrow(
			'R2 renderer received binding "CACHE" of type "cache", not "r2".',
		);
	});
});
