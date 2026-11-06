import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { BindingRenderer, RenderedBinding } from './types.ts';
import { capnpText } from '../function-config.ts';
import assetsWorkerSource from '../../../../packages/function-bindings/src/assets.js' with { type: 'text' };

/** Helper credential name the assets service module is embedded as (fixed contract with the helper). */
export const ASSETS_BINDING_FILE = 'binding-assets';

/** A directory segment the contracts allow in `function.assets.directory`. */
const ASSETS_DIRECTORY_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Resolve the release-relative assets directory to the absolute path the disk service reads.
 *
 * The manifest already validates this field (docs/FUNCTIONS.md §4.3), but desired state reaches an
 * unprivileged agent that renders a privileged config: a hand-edited `..` must not point a disk
 * service at `/etc`. Reject anything that is not a clean relative path, then prove the resolved
 * path is still under the release root.
 */
export function resolveAssetsDirectory(
	releaseDir: string,
	directory: string,
	workloadId: string,
): string {
	if (!isAbsolute(releaseDir)) {
		throw new Error(
			`Cannot render an assets binding for workload ${workloadId}: the release directory "${releaseDir}" is not absolute.`,
		);
	}
	const segments = directory.split('/');
	if (
		directory.length === 0 ||
		segments.some(
			(segment) => segment === '' || segment === '.' || segment === '..' || !ASSETS_DIRECTORY_SEGMENT.test(segment),
		)
	) {
		throw new Error(
			`Cannot render an assets binding for workload ${workloadId}: assets directory "${directory}" is not a safe relative path.`,
		);
	}

	const root = resolve(releaseDir);
	const resolved = resolve(root, directory);
	const pathFromRoot = relative(root, resolved);
	if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
		throw new Error(
			`Cannot render an assets binding for workload ${workloadId}: assets directory "${directory}" resolves outside the release directory.`,
		);
	}
	return resolved;
}

/**
 * Phase-2 static assets: the `env.ASSETS` binding (docs/FUNCTIONS.md §4.2, §4.5, D110, FN10).
 *
 * Caddy serves the same release directory first; `env.ASSETS.fetch()` is for the paths the Worker
 * takes over (`run_worker_first`, a 404 fall-through, or code that reads a file directly). The
 * binding is a Skiff-supplied Worker because workerd cannot expose a directory to user code: the
 * Worker gets a read-only `disk` service for the assets directory and the user Worker only gets a
 * plain service binding named `ASSETS`.
 *
 * No durable storage and no activation secrets: the directory path is release data, not a secret.
 */
export const renderAssetsBinding: BindingRenderer = (context) => {
	const { binding, index, workload } = context;
	if (binding.type !== 'assets') {
		throw new Error(
			`Assets renderer received binding "${binding.name}" of type "${binding.type}", not "assets".`,
		);
	}
	const spec = workload.function;
	if (!spec) {
		throw new Error(
			`Cannot render an assets binding for workload ${workload.id}: it has no function spec.`,
		);
	}
	const directory = spec.assets?.directory;
	if (directory === undefined) {
		throw new Error(
			`Cannot render an assets binding for workload ${workload.id}: it has no assets directory.`,
		);
	}
	if (!context.releaseDir) {
		throw new Error(
			`Cannot render an assets binding for workload ${workload.id}: the render context has no release directory.`,
		);
	}

	const diskPath = resolveAssetsDirectory(context.releaseDir, directory, workload.id);
	const diskServiceName = `assets-disk-${index}`;
	const serviceName = `assets-api-${index}`;

	// The disk service is read-only: the assets tier is release output, never writable state.
	const diskService =
		`    ( name = ${capnpText(diskServiceName)}, disk = ( path = ${capnpText(diskPath)}, writable = false ) )`;

	// The binding service embeds the shared assets Worker source and points it at that disk.
	const service = [
		`    ( name = ${capnpText(serviceName)},`,
		'      worker = (',
		'        modules = [',
		`          ( name = "assets.worker", esModule = embed ${capnpText(ASSETS_BINDING_FILE)} ),`,
		'        ],',
		`        compatibilityDate = ${capnpText(spec.compatibilityDate)},`,
		'        compatibilityFlags = [],',
		'        bindings = [',
		`          ( name = "DISK", service = ${capnpText(diskServiceName)} ),`,
		'          ( name = "ASSETS_PREFIX", text = "" ),',
		'        ],',
		'      ) ),',
	].join('\n');

	const rendered: RenderedBinding = {
		files: { [ASSETS_BINDING_FILE]: assetsWorkerSource },
		services: [diskService, service],
		mainBindings: [
			`        ( name = ${capnpText(binding.name)}, service = ${capnpText(serviceName)} )`,
		],
		requiresDurableStorage: false,
		namespaces: [],
	};
	return rendered;
};
