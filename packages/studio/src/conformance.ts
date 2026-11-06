/**
 * Plugin conformance suite (plan 22). Every plugin runs this against the standard fixture in its
 * engine (seeded by the e2e harness); passing it is the definition of done for a Phase 2 track.
 * The fake plugin runs it in this package's own tests, so the suite itself stays honest.
 *
 * Usage, in a plugin's e2e test:
 *
 *   describeConformance({ name: 'postgres 17', plugin, target, readOnlyTarget, fixture });
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_STUDIO_LIMITS } from '@skiff/contracts';
import type { StudioPlugin, StudioSession, StudioTarget } from './driver.ts';
import { limitEvents } from './limits.ts';
import type { Cell, ObjectRef, RowChange, StudioEvent } from './protocol.ts';

export interface ConformanceFixture {
	/** The standard fixture object (table, collection or key group) holding `rowCount` rows. */
	object: ObjectRef;
	rowCount: number;
	/** Key column(s) that identify a row: the primary key, `_id`, or `key`. */
	keyColumns: string[];
	/** A text column that `apply` may update. */
	editableColumn: string;
	/** Input that returns at least `rowCount` rows (more than the truncation test's maxRows). */
	selectAllInput: string;
	/** Input that runs for at least 5 s, for cancel and timeout tests. */
	slowInput: string;
	/** A write that a read-only session must refuse. */
	writeInput: string;
	/** Attempts to escape read-only mode; each must fail or leave the data unchanged. */
	readOnlyEscapes: string[];
	/** Optional: re-seed between destructive tests. */
	reset?: () => Promise<void>;
}

export interface ConformanceOptions {
	name: string;
	plugin: StudioPlugin;
	/** Owner credential (write sessions). */
	target: StudioTarget;
	/** Read-only credential; defaults to `target` with a read-only session. */
	readOnlyTarget?: StudioTarget;
	fixture: ConformanceFixture;
	/** Cancel must take effect within this many ms (plan: 2 s). */
	cancelWithinMs?: number;
}

export async function collect(events: AsyncIterable<StudioEvent>): Promise<StudioEvent[]> {
	const out: StudioEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

export function rowsOf(events: StudioEvent[]): Cell[][] {
	return events.flatMap((event) => (event.t === 'rows' ? event.rows : []));
}

export function describeConformance(options: ConformanceOptions): void {
	const { plugin, fixture } = options;
	const limits = DEFAULT_STUDIO_LIMITS;
	const open = (readOnly: boolean): Promise<StudioSession> =>
		plugin.connect(readOnly ? (options.readOnlyTarget ?? options.target) : options.target, { readOnly, limits });
	const signal = () => new AbortController().signal;

	describe(`studio conformance: ${options.name}`, () => {
		test('declares capabilities for its engine', () => {
			const caps = plugin.capabilities(options.target.engine, options.target.version);
			expect(plugin.engines).toContain(options.target.engine);
			expect(['relational', 'document', 'keyvalue']).toContain(caps.family);
		});

		test('tree reaches the fixture object', async () => {
			const session = await open(true);
			try {
				let level = await session.tree([], signal());
				for (let depth = 1; depth <= fixture.object.path.length; depth += 1) {
					const prefix = fixture.object.path.slice(0, depth);
					const node = level.find((n) => JSON.stringify(n.path) === JSON.stringify(prefix));
					expect(node, `tree node ${prefix.join('/')}`).toBeDefined();
					if (depth < fixture.object.path.length) level = await session.tree(prefix, signal());
					else expect(node?.browsable).toBe(true);
				}
			} finally {
				await session.close();
			}
		});

		test('describe reports columns and the key', async () => {
			const session = await open(true);
			try {
				const description = await session.describe(fixture.object, signal());
				expect(description.columns.length).toBeGreaterThan(0);
				for (const key of fixture.keyColumns) expect(description.columns.map((c) => c.name)).toContain(key);
				if (plugin.capabilities(options.target.engine, options.target.version).edit === 'primary-key')
					expect(description.primaryKey).toEqual(fixture.keyColumns);
			} finally {
				await session.close();
			}
		});

		test('browse pages through every row exactly once', async () => {
			const session = await open(true);
			try {
				const seen = new Set<string>();
				let cursor: string | undefined;
				let keyIndexes: number[] = [];
				for (let pages = 0; pages < 1_000; pages += 1) {
					const events = await collect(
						session.browse(fixture.object, { limit: 37, cursor, sort: [], filter: [] }, signal()),
					);
					const columns = events.find((e) => e.t === 'columns');
					if (columns?.t === 'columns')
						keyIndexes = fixture.keyColumns.map((k) => columns.columns.findIndex((c) => c.name === k));
					for (const row of rowsOf(events)) {
						const key = JSON.stringify(keyIndexes.map((i) => row[i]));
						expect(seen.has(key), `duplicate row ${key}`).toBe(false);
						seen.add(key);
					}
					const page = events.find((e) => e.t === 'page');
					expect(page, 'browse ends with a page event').toBeDefined();
					expect(events.at(-1)?.t).toBe('done');
					if (page?.t !== 'page' || page.next === null) break;
					cursor = page.next;
				}
				expect(seen.size).toBe(fixture.rowCount);
			} finally {
				await session.close();
			}
		});

		test('run streams rows and the limiter truncates at maxRows', async () => {
			const session = await open(true);
			try {
				const maxRows = Math.max(1, Math.min(10, fixture.rowCount - 1));
				const events = await collect(
					limitEvents(
						session.run(fixture.selectAllInput, { maxRows, timeoutMs: limits.statementTimeoutMs }, signal()),
						{ maxRows, maxBytes: limits.maxBytes },
					),
				);
				expect(events[0]?.t).toBe('columns');
				expect(rowsOf(events).length).toBe(maxRows);
				const done = events.at(-1);
				expect(done?.t === 'done' && done.truncated).toBe(true);
			} finally {
				await session.close();
			}
		});

		test('consecutive runs on one session each complete, including after truncation', async () => {
			// Sessions are long-lived: a run that leaves its connection or lock behind hangs the next.
			const session = await open(true);
			try {
				const run = (maxRows: number) =>
					withDeadline(
						collect(
							limitEvents(
								session.run(fixture.selectAllInput, { maxRows, timeoutMs: limits.statementTimeoutMs }, signal()),
								{ maxRows, maxBytes: limits.maxBytes },
							),
						),
						10_000,
						'run',
					);
				for (const maxRows of [3, fixture.rowCount + 10, 3]) {
					const events = await run(maxRows);
					expect(events.at(-1)?.t).toBe('done');
					expect(rowsOf(events).length).toBe(Math.min(maxRows, fixture.rowCount));
				}
			} finally {
				await session.close();
			}
		});

		test('aborting a slow run cancels it promptly', async () => {
			const caps = plugin.capabilities(options.target.engine, options.target.version);
			const session = await open(true);
			try {
				const controller = new AbortController();
				const started = performance.now();
				setTimeout(() => controller.abort(), 200);
				let failed = false;
				try {
					await collect(session.run(fixture.slowInput, { maxRows: 10, timeoutMs: 60_000 }, controller.signal));
				} catch {
					failed = true;
				}
				const elapsed = performance.now() - started;
				if (caps.cancel !== 'none') {
					expect(failed).toBe(true);
					expect(elapsed).toBeLessThan((options.cancelWithinMs ?? 2_000) + 200);
				}
			} finally {
				await session.close();
			}
		});

		test('a read-only session refuses writes and escapes', async () => {
			const session = await open(true);
			try {
				for (const input of [fixture.writeInput, ...fixture.readOnlyEscapes]) {
					let refused = false;
					try {
						const events = await collect(session.run(input, { maxRows: 10, timeoutMs: 10_000 }, signal()));
						refused = events.some((e) => e.t === 'error');
					} catch {
						refused = true;
					}
					// An escape that "succeeds" must still not have changed the data.
					if (!refused) {
						const count = rowsOf(
							await collect(session.run(fixture.selectAllInput, { maxRows: 100_000, timeoutMs: 30_000 }, signal())),
						).length;
						expect(count, `data changed after: ${input}`).toBe(fixture.rowCount);
					}
				}
				const description = await session.describe(fixture.object, signal());
				let applyRefused = false;
				try {
					await session.apply(fixture.object, [{ op: 'delete', key: await firstKey(session, fixture) }], signal());
				} catch {
					applyRefused = true;
				}
				expect(applyRefused || !description.editable).toBe(true);
			} finally {
				await session.close();
			}
		});

		test('apply updates by key and detects a stale original', async () => {
			const session = await open(false);
			try {
				const key = await firstKey(session, fixture);
				const current = await currentValue(session, fixture, key);
				const change: RowChange = {
					op: 'update',
					key,
					values: { [fixture.editableColumn]: 'conformance edit' },
					original: { [fixture.editableColumn]: current },
				};
				expect(await session.apply(fixture.object, [change], signal())).toEqual({ applied: 1, conflicts: [] });
				// The same change again is now stale: the original no longer matches.
				const stale = await session.apply(fixture.object, [change], signal());
				expect(stale.applied).toBe(0);
				expect(stale.conflicts.length).toBe(1);
				// Put the value back.
				await session.apply(
					fixture.object,
					[
						{
							op: 'update',
							key,
							values: { [fixture.editableColumn]: current },
							original: { [fixture.editableColumn]: 'conformance edit' },
						},
					],
					signal(),
				);
			} finally {
				await session.close();
				await fixture.reset?.();
			}
		});
	});
}

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

async function firstRow(
	session: StudioSession,
	fixture: ConformanceFixture,
): Promise<{ names: string[]; row: Cell[] }> {
	const events = await collect(
		session.browse(fixture.object, { limit: 1, sort: [], filter: [] }, new AbortController().signal),
	);
	const columns = events.find((e) => e.t === 'columns');
	const row = rowsOf(events)[0];
	if (columns?.t !== 'columns' || !row) throw new Error('The fixture object has no rows.');
	return { names: columns.columns.map((c) => c.name), row };
}

async function firstKey(session: StudioSession, fixture: ConformanceFixture): Promise<Record<string, Cell>> {
	const { names, row } = await firstRow(session, fixture);
	return Object.fromEntries(fixture.keyColumns.map((k) => [k, row[names.indexOf(k)] ?? null]));
}

async function currentValue(
	session: StudioSession,
	fixture: ConformanceFixture,
	key: Record<string, Cell>,
): Promise<Cell> {
	const { names, row } = await firstRow(session, fixture);
	void key;
	return row[names.indexOf(fixture.editableColumn)] ?? null;
}
