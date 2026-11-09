// Spike 1: does @duckdb/node-api (N-API) work under Bun for Yoal's telemetry needs?
// Checks: open file DB with memory limits, bulk ingest OTel-shaped rows, time-bucket rollup,
// Parquet export + query-from-Parquet, concurrent reads, RSS footprint.
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync, rmSync } from "node:fs";

const dir = new URL("./tmp/", import.meta.url).pathname;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const t = () => performance.now();
const results: Record<string, unknown> = { bun: Bun.version, rssStartMB: mb() };

const instance = await DuckDBInstance.create(`${dir}telemetry.duckdb`, {
  memory_limit: "256MB",
  threads: "2",
});
const con = await instance.connect();
results.rssAfterOpenMB = mb();

await con.run(`
  CREATE TABLE http_requests (
    ts TIMESTAMPTZ, "service.name" VARCHAR, "deployment.id" VARCHAR, "host.name" VARCHAR,
    "http.request.method" VARCHAR, "http.response.status_code" USMALLINT,
    "url.path" VARCHAR, bytes UINTEGER, duration_ms DOUBLE
  )`);

// Ingest 1M synthetic access-log rows (~ a busy week for a small box) via the Appender API.
const N = 1_000_000;
const services = ["blog", "portfolio", "docs", "landing", "status"];
const paths = ["/", "/about", "/_app/immutable/x.js", "/img/a.webp", "/api/ping"];
const codes = [200, 200, 200, 200, 304, 404, 500];
const start = Date.UTC(2026, 10, 1);
let t0 = t();
const appender = await con.createAppender("http_requests");
for (let i = 0; i < N; i++) {
  appender.appendVarchar(new Date(start + i * 600).toISOString()); // TIMESTAMPTZ from ISO string
  appender.appendVarchar(services[i % 5]!);
  appender.appendVarchar(`dep_${i % 3}`);
  appender.appendVarchar(i % 2 ? "edge" : "homelab");
  appender.appendVarchar("GET");
  appender.appendUSmallInt(codes[i % 7]!);
  appender.appendVarchar(paths[i % 5]!);
  appender.appendUInteger(500 + (i % 50_000));
  appender.appendDouble((i % 97) * 0.7);
  appender.endRow();
}
appender.closeSync();
results.ingest1MRowsMs = Math.round(t() - t0);
results.rssAfterIngestMB = mb();

// 1-minute rollup with p50/p95 per service (the dashboard's core query).
t0 = t();
const rollup = await con.runAndReadAll(`
  SELECT time_bucket(INTERVAL '1 minute', ts) AS bucket, "service.name" AS service,
         count(*) AS requests,
         count(*) FILTER (WHERE "http.response.status_code" >= 500) AS errors_5xx,
         sum(bytes) AS bytes,
         quantile_cont(duration_ms, 0.5) AS p50, quantile_cont(duration_ms, 0.95) AS p95
  FROM http_requests GROUP BY ALL ORDER BY bucket DESC LIMIT 5`);
results.rollupMs = Math.round(t() - t0);
results.rollupSample = rollup.getRowObjectsJson()[0];

// Archive to day-partitioned Parquet, then query the Parquet directly (cold-tier path).
t0 = t();
await con.run(`COPY (SELECT *, CAST(ts AS DATE) AS day FROM http_requests)
  TO '${dir}archive' (FORMAT parquet, PARTITION_BY (day), COMPRESSION zstd, OVERWRITE_OR_IGNORE)`);
results.parquetExportMs = Math.round(t() - t0);
t0 = t();
const cold = await con.runAndReadAll(`
  SELECT "service.name", count(*) AS n FROM read_parquet('${dir}archive/**/*.parquet', hive_partitioning = true)
  WHERE day = DATE '2026-11-02' GROUP BY 1 ORDER BY 1`);
results.parquetQueryMs = Math.round(t() - t0);
results.parquetSample = cold.getRowObjectsJson();

// Concurrent readers on separate connections (dashboard + MCP get_metrics at once).
t0 = t();
await Promise.all(
  Array.from({ length: 4 }, async () => {
    const c = await instance.connect();
    await c.runAndReadAll(`SELECT "service.name", count(*) FROM http_requests GROUP BY 1`);
    c.closeSync();
  }),
);
results.concurrent4ReadsMs = Math.round(t() - t0);
results.rssEndMB = mb();
const sizes = await con.runAndReadAll(`SELECT database_size, memory_usage FROM pragma_database_size()`);
results.dbSize = sizes.getRowObjectsJson()[0];

con.closeSync();
instance.closeSync();
console.log(JSON.stringify(results, null, 2));
