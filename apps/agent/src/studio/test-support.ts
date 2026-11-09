/** Fixtures shared by the studio process and front tests. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseEngines, type DatabaseEngine, type DatabaseStudioActivation } from '@yoal/contracts';
import type { PluginLoader, StudioPlugin } from '@yoal/studio';
import { createFakePlugin, type FakePluginOptions } from '@yoal/studio/fake';

export function testActivation(
	sessionId: string,
	overrides: Partial<DatabaseStudioActivation> = {},
): DatabaseStudioActivation {
	return {
		v: 1,
		sessionId,
		databaseId: 'db_orders',
		engine: 'postgres',
		version: '17',
		host: '127.0.0.1',
		port: 5432,
		database: 'orders',
		user: 'owner',
		password: 'secret',
		tls: null,
		readOnly: false,
		limits: { maxRows: 1_000, maxBytes: 16 * 1_048_576, statementTimeoutMs: 30_000 },
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		...overrides,
	};
}

/** The fake plugin, recording when a `run`/`browse` signal fires. */
export function trackedFake(options: FakePluginOptions = {}) {
	const aborts: number[] = [];
	let connects = 0;
	const fake = createFakePlugin(options);
	const plugin: StudioPlugin = {
		...fake,
		async connect(target, sessionOptions) {
			connects += 1;
			const session = await fake.connect(target, sessionOptions);
			const track = (signal: AbortSignal) =>
				signal.addEventListener('abort', () => aborts.push(Date.now()), { once: true });
			return {
				tree: (path, signal) => session.tree(path, signal),
				describe: (object, signal) => session.describe(object, signal),
				browse(object, query, signal) {
					track(signal);
					return session.browse(object, query, signal);
				},
				run(input, runOptions, signal) {
					track(signal);
					return session.run(input, runOptions, signal);
				},
				apply: (object, changes, signal) => session.apply(object, changes, signal),
				...(session.alter ? { alter: session.alter.bind(session) } : {}),
				close: () => session.close(),
			};
		},
	};
	const load: PluginLoader = async () => plugin;
	const loaders = Object.fromEntries(databaseEngines.map((engine) => [engine, load])) as Partial<
		Record<DatabaseEngine, PluginLoader>
	>;
	return { loaders, aborts, connects: () => connects };
}

export function tempSocket(): string {
	return join(tmpdir(), `yoal-studio-${Math.random().toString(36).slice(2, 10)}.sock`);
}
