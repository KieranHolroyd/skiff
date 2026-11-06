/**
 * Engine → plugin loaders. Every entry is a lazy `import()`, so the studio process only loads
 * the driver code for engines that actually have an open session, and the agent and control
 * plane never load any. Each engine maps to the plugin that serves it.
 */
import type { DatabaseEngine } from '@skiff/contracts';
import type { StudioPlugin } from './driver.ts';
import { StudioError } from './protocol.ts';

export type PluginLoader = () => Promise<StudioPlugin>;

export const pluginLoaders: Partial<Record<DatabaseEngine, PluginLoader>> = {
	postgres: () => import('./plugins/postgres/index.ts').then((m) => m.postgresPlugin),
	mysql: () => import('./plugins/mysql/index.ts').then((m) => m.mysqlPlugin),
	mariadb: () => import('./plugins/mysql/index.ts').then((m) => m.mysqlPlugin),
	mongodb: () => import('./plugins/mongodb/index.ts').then((m) => m.mongodbPlugin),
	valkey: () => import('./plugins/keyvalue/index.ts').then((m) => m.keyvaluePlugin),
	redis: () => import('./plugins/keyvalue/index.ts').then((m) => m.keyvaluePlugin),
};

const loaded = new Map<DatabaseEngine, Promise<StudioPlugin>>();

/** Resolve the plugin for an engine, loading it at most once. */
export function loadPlugin(
	engine: DatabaseEngine,
	loaders: Partial<Record<DatabaseEngine, PluginLoader>> = pluginLoaders,
): Promise<StudioPlugin> {
	if (loaders !== pluginLoaders) {
		const loader = loaders[engine];
		if (!loader) return Promise.reject(new StudioError('unsupported', `The studio has no plugin for ${engine} yet.`));
		return loader();
	}
	let plugin = loaded.get(engine);
	if (!plugin) {
		const loader = loaders[engine];
		if (!loader) return Promise.reject(new StudioError('unsupported', `The studio has no plugin for ${engine} yet.`));
		plugin = loader();
		loaded.set(engine, plugin);
		plugin.catch(() => loaded.delete(engine));
	}
	return plugin;
}
