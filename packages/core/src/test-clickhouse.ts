/**
 * ClickHouse for tests (D101). Each store gets its own throwaway database, so suites can run in
 * parallel against one server. Point `SKIFF_TEST_CLICKHOUSE_URL` at a server (CI runs one as a
 * service container; locally `bun run dev:clickhouse`). Without a reachable server, tests that
 * need telemetry are skipped.
 */
import { ClickHouseClient } from './clickhouse.ts';
import { TelemetryStore, type TelemetryOptions } from './telemetry.ts';

const url = process.env.SKIFF_TEST_CLICKHOUSE_URL ?? 'http://127.0.0.1:18123';
const user = process.env.SKIFF_TEST_CLICKHOUSE_USER ?? (process.env.SKIFF_TEST_CLICKHOUSE_URL ? 'default' : 'skiff');
const password = process.env.SKIFF_TEST_CLICKHOUSE_PASSWORD ?? (process.env.SKIFF_TEST_CLICKHOUSE_URL ? '' : 'skiff-dev');

async function probe(): Promise<boolean> {
	if (process.env.SKIFF_TEST_CLICKHOUSE === '0') return false;
	const client = new ClickHouseClient({ url, user, password, timeoutMs: 3_000 });
	try {
		await client.query('SELECT 1');
		return true;
	} catch {
		return false;
	}
}

/** A ClickHouse server answered; telemetry tests run only when true. */
export const hasClickHouse = await probe();

if (!hasClickHouse && process.env.CI) {
	throw new Error(`Telemetry tests need ClickHouse at ${url} (SKIFF_TEST_CLICKHOUSE_URL), and CI must provide one.`);
}

let counter = 0;

/** A store on a fresh database, without table TTLs (test clocks write "old" rows). */
export function testTelemetryStore(options: Partial<TelemetryOptions> = {}): TelemetryStore {
	const database = `skiff_test_${process.pid}_${Date.now().toString(36)}_${counter++}`;
	return new TelemetryStore({
		clickhouse: { url, user, password, database },
		tableTtl: false,
		...options,
	});
}

/** Close the store and drop its database (nothing to drop when no server answered). */
export async function disposeTelemetryStore(store: TelemetryStore): Promise<void> {
	try {
		if (hasClickHouse) await store.dropDatabase();
	} finally {
		await store.close();
	}
}
