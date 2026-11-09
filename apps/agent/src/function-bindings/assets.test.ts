import { describe, expect, test } from 'bun:test';
import type { FunctionRuntimeBinding, WorkloadDesired } from '@yoal/contracts';
import { renderAssetsBinding, resolveAssetsDirectory } from './assets.ts';

const RELEASE_DIR = '/data/sites/prj_1/releases/abc123';

function workload(
	options: {
		compatibilityDate?: string;
		directory?: string;
		assets?: 'absent' | 'null';
	} = {},
): WorkloadDesired {
	const functionSpec: Record<string, unknown> = {
		compatibilityDate: options.compatibilityDate ?? '2026-10-01',
	};
	if (options.assets === 'absent') {
		// no `assets` property at all
	} else if (options.assets === 'null') {
		functionSpec.assets = null;
	} else {
		functionSpec.assets = { directory: options.directory ?? 'public', runWorkerFirst: [] };
	}
	return {
		id: 'wl_1',
		projectId: 'prj_1',
		projectSlug: 'api',
		runtime: 'function',
		function: functionSpec,
	} as unknown as WorkloadDesired;
}

function assetsBinding(name = 'ASSETS'): FunctionRuntimeBinding {
	return { name, type: 'assets' };
}

function render(
	binding: FunctionRuntimeBinding = assetsBinding(),
	options: {
		index?: number;
		releaseDir?: string | undefined;
		workload?: WorkloadDesired;
		env?: Record<string, string>;
	} = {},
) {
	return renderAssetsBinding({
		workload: options.workload ?? workload(),
		env: options.env ?? {},
		binding,
		releaseDir: 'releaseDir' in options ? options.releaseDir : RELEASE_DIR,
		index: options.index ?? 0,
	});
}

const EXPECTED_DISK_SERVICE =
	`    ( name = "assets-disk-0", disk = ( path = "${RELEASE_DIR}/public", writable = false ) )`;

const EXPECTED_API_SERVICE = `    ( name = "assets-api-0",
      worker = (
        modules = [
          ( name = "assets.worker", esModule = embed "binding-assets" ),
        ],
        compatibilityDate = "2026-10-01",
        compatibilityFlags = [],
        bindings = [
          ( name = "DISK", service = "assets-disk-0" ),
          ( name = "ASSETS_PREFIX", text = "" ),
        ],
      ) ),`;

describe('renderAssetsBinding', () => {
	test('renders the exact disk and assets service blocks', () => {
		const rendered = render();
		expect(rendered.services).toEqual([EXPECTED_DISK_SERVICE, EXPECTED_API_SERVICE]);
	});

	test('binds env.ASSETS to the assets service on the main Worker', () => {
		const rendered = render();
		expect(rendered.mainBindings).toEqual([
			'        ( name = "ASSETS", service = "assets-api-0" )',
		]);
		expect(rendered.mainFields).toBeUndefined();
	});

	test('uses no Durable Object storage, namespace or shared disk service', () => {
		const rendered = render();
		expect(rendered.requiresDurableStorage).toBe(false);
		expect(rendered.namespaces).toEqual([]);
		expect(rendered.services[0]).not.toContain('durableObjectStorage');
		expect(rendered.services[1]).not.toContain('durableObjectStorage');
	});

	test('embeds the assets worker under the binding-assets credential', () => {
		const rendered = render();
		expect(Object.keys(rendered.files)).toEqual(['binding-assets']);
		const source = rendered.files['binding-assets']!;
		expect(source).toContain('export default');
		expect(source).toContain('Miniflare (Apache-2.0)');
		expect(source).toContain('env.ASSETS.fetch(request)');
		expect(source.length).toBeGreaterThan(5_000);
	});

	test('numbers services by binding index and keeps two assets bindings apart', () => {
		const second: FunctionRuntimeBinding = { name: 'SITE', type: 'assets' };
		const first = render(assetsBinding(), { index: 0 });
		const other = render(second, { index: 3 });
		expect(first.services[0]).toContain('( name = "assets-disk-0",');
		expect(other.services[0]).toContain('( name = "assets-disk-3",');
		expect(first.services[1]).toContain('( name = "assets-api-0",');
		expect(other.services[1]).toContain('( name = "assets-api-3",');
		expect(first.mainBindings).toEqual(['        ( name = "ASSETS", service = "assets-api-0" )']);
		expect(other.mainBindings).toEqual(['        ( name = "SITE", service = "assets-api-3" )']);
		// Every assets service shares one embedded module.
		expect(first.files['binding-assets']).toBe(other.files['binding-assets']);
	});

	test('uses the workload compatibility date', () => {
		const rendered = render(assetsBinding(), {
			workload: workload({ compatibilityDate: '2026-11-06' }),
		});
		expect(rendered.services[1]).toContain('compatibilityDate = "2026-11-06"');
	});

	test('nests the directory under the release and escapes the absolute path', () => {
		const rendered = render(assetsBinding(), {
			releaseDir: '/data/sites/quote"release',
			workload: workload({ directory: 'app/assets' }),
		});
		expect(rendered.services[0]).toContain(
			'disk = ( path = "/data/sites/quote\\"release/app/assets", writable = false )',
		);
	});

	test('escapes the binding name as Cap’n Proto text', () => {
		const rendered = render({ name: 'ASSETS"1', type: 'assets' });
		expect(rendered.mainBindings?.[0]).toBe(
			'        ( name = "ASSETS\\"1", service = "assets-api-0" )',
		);
	});

	test('never reads or embeds activation secrets', () => {
		const rendered = render(assetsBinding(), {
			env: { SECRET: 'hunter2', DATABASE_PASSWORD: 'correct horse' },
		});
		const serialised = JSON.stringify(rendered);
		expect(serialised).not.toContain('hunter2');
		expect(serialised).not.toContain('correct horse');
	});

	test('refuses a binding of another type', () => {
		expect(() => render({ name: 'CACHE', type: 'cache' })).toThrow(
			'Assets renderer received binding "CACHE" of type "cache", not "assets".',
		);
	});

	test('refuses a workload without a function spec', () => {
		expect(() =>
			render(assetsBinding(), {
				workload: { id: 'wl_1', projectSlug: 'api', runtime: 'function' } as WorkloadDesired,
			}),
		).toThrow('Cannot render an assets binding for workload wl_1: it has no function spec.');
	});

	test('refuses a workload whose function spec has no assets directory', () => {
		expect(() => render(assetsBinding(), { workload: workload({ assets: 'absent' }) })).toThrow(
			'Cannot render an assets binding for workload wl_1: it has no assets directory.',
		);
		expect(() => render(assetsBinding(), { workload: workload({ assets: 'null' }) })).toThrow(
			'it has no assets directory',
		);
	});

	test('refuses a render context without a release directory', () => {
		expect(() => render(assetsBinding(), { releaseDir: undefined })).toThrow(
			'Cannot render an assets binding for workload wl_1: the render context has no release directory.',
		);
	});

	test('refuses a relative release directory rather than guessing', () => {
		expect(() => render(assetsBinding(), { releaseDir: 'releases/abc' })).toThrow(
			'the release directory "releases/abc" is not absolute',
		);
	});

	test('refuses an unsafe assets directory before it can escape the release', () => {
		for (const directory of [
			'../secrets',
			'a/../../secrets',
			'/etc',
			'',
			'a//b',
			'a/./b',
			'a/..',
			'a\\b',
			'a\u0000b',
		]) {
			expect(() => render(assetsBinding(), { workload: workload({ directory }) })).toThrow(
				/is not a safe relative path|resolves outside the release directory/,
			);
		}
	});
});

describe('resolveAssetsDirectory', () => {
	test('joins a clean relative directory under the release root', () => {
		expect(resolveAssetsDirectory('/data/sites/prj_1/rel', 'app/assets', 'wl_1')).toBe(
			'/data/sites/prj_1/rel/app/assets',
		);
	});

	test('keeps a single-segment directory directly under the release', () => {
		expect(resolveAssetsDirectory('/data/sites/prj_1/rel', 'public', 'wl_1')).toBe(
			'/data/sites/prj_1/rel/public',
		);
	});

	test('refuses traversal and absolute directories with the workload id in the message', () => {
		expect(() => resolveAssetsDirectory('/data/sites/prj_1/rel', '../rel2', 'wl_1')).toThrow(
			'Cannot render an assets binding for workload wl_1: assets directory "../rel2" is not a safe relative path.',
		);
		expect(() => resolveAssetsDirectory('/data/sites/prj_1/rel', '/etc', 'wl_1')).toThrow(
			'Cannot render an assets binding for workload wl_1: assets directory "/etc" is not a safe relative path.',
		);
	});
});
