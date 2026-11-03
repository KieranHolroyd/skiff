// Spike 1b: steady-state footprint. Realistic shape: small batches every "10s", periodic rollup
// queries, with a tight memory_limit. Measures RSS after warm-up, not a 1M-row burst.
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync, rmSync } from "node:fs";
const limit = process.env.LIMIT ?? "64MB";
const dir = new URL("./tmp/steady/", import.meta.url).pathname;
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const inst = await DuckDBInstance.create(`${dir}t.duckdb`, { memory_limit: limit, threads: "1" });
const con = await inst.connect();
await con.run(`CREATE TABLE r (ts TIMESTAMPTZ, svc VARCHAR, code USMALLINT, bytes UINTEGER, dur DOUBLE)`);
const samples: number[] = [];
let ts = Date.UTC(2026, 10, 1);
for (let tick = 0; tick < 2000; tick++) {            // 2000 ticks × 300 rows = 600k rows
  const a = await con.createAppender("r");
  for (let i = 0; i < 300; i++) {
    a.appendVarchar(new Date(ts += 33).toISOString()); a.appendVarchar(`svc${i % 20}`);
    a.appendUSmallInt(i % 13 ? 200 : 500); a.appendUInteger(1000 + i); a.appendDouble(i % 90);
    a.endRow();
  }
  a.closeSync();
  if (tick % 50 === 0) {
    await con.runAndReadAll(`SELECT time_bucket(INTERVAL '1 minute', ts) b, svc, count(*), quantile_cont(dur, 0.95)
      FROM r WHERE ts > (SELECT max(ts) FROM r) - INTERVAL '48 hours' GROUP BY ALL`);
    samples.push(mb());
  }
}
Bun.gc(true);
console.log(JSON.stringify({ limit, rows: 600_000, rssSamplesMB: samples.filter((_, i) => i % 8 === 0), rssFinalMB: mb() }));
