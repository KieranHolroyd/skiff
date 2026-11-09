// Spike 4: Caddy driven purely via its admin API on a unix socket, from Bun.
// Verifies: unix-socket admin (no TCP :2019), route insert/replace/delete by @id, catch-all ordering,
// atomic symlink release swap without touching Caddy, precompressed br/gzip serving, cache headers,
// forward_auth to a Bun "agent" on a unix socket with a stateless HMAC cookie, and Caddy RSS.
import { $ } from "bun";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, renameSync, writeFileSync } from "node:fs";

const root = new URL("./tmp/run/", import.meta.url).pathname;
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const ADMIN = `${root}admin.sock`;
const AGENT = `${root}agent.sock`;
const PORT = 8787;
const results: { check: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push({ check: name, ok, detail });

// --- releases on disk: /srv/releases/<project>/<sha>, /srv/sites/<project> -> current release
function writeRelease(project: string, sha: string, html: string) {
  const dir = `${root}srv/releases/${project}/${sha}`;
  mkdirSync(`${dir}/_app/immutable`, { recursive: true });
  writeFileSync(`${dir}/index.html`, html);
  writeFileSync(`${dir}/index.html.br`, brotliCompressSync(html));
  writeFileSync(`${dir}/index.html.gz`, gzipSync(html));
  writeFileSync(`${dir}/_app/immutable/app.abc123.js`, "console.log(1)");
}
function activate(project: string, sha: string) {
  mkdirSync(`${root}srv/sites`, { recursive: true });
  const link = `${root}srv/sites/${project}`;
  const tmp = `${link}.tmp-${sha}`;
  symlinkSync(`${root}srv/releases/${project}/${sha}`, tmp);
  renameSync(tmp, link); // rename(2) over the old symlink = atomic swap
}
writeRelease("blog", "aaa", "<h1>blog v1</h1>".repeat(50));
writeRelease("blog", "bbb", "<h1>blog v2</h1>".repeat(50));
writeRelease("secret", "ccc", "<h1>secret</h1>");
activate("blog", "aaa");
activate("secret", "ccc");

// --- agent stub: stateless HMAC cookie verification for forward_auth
const KEY = "spike-site-key";
const sign = (host: string, exp: number) =>
  createHmac("sha256", KEY).update(`${host}|${exp}`).digest("base64url");
const agent = Bun.serve({
  unix: AGENT,
  fetch(req) {
    const host = req.headers.get("x-forwarded-host") ?? "";
    const m = /(?:^|;\s*)__yoal_s=(\d+)\.([\w-]+)/.exec(req.headers.get("cookie") ?? "");
    if (m) {
      const exp = Number(m[1]);
      const good = Buffer.from(sign(host, exp));
      const got = Buffer.from(m[2]!);
      if (exp > Date.now() / 1000 && good.length === got.length && timingSafeEqual(good, got))
        return new Response(null, { status: 200, headers: { "X-Yoal-Visitor": "kieran" } });
    }
    const back = encodeURIComponent(`https://${host}${req.headers.get("x-forwarded-uri") ?? "/"}`);
    return new Response(null, {
      status: 302,
      headers: { Location: `https://cloud.platform.test/_yoal/site-login?return=${back}` },
    });
  },
});

// --- Caddy with admin on a unix socket and an empty "content" server with a catch-all 404
const initial = {
  admin: { listen: `unix/${ADMIN}` },
  apps: {
    http: {
      servers: {
        content: {
          listen: [`:${PORT}`],
          automatic_https: { disable: true },
          routes: [
            { "@id": "catch-all", handle: [{ handler: "static_response", status_code: 404, body: "no such site" }] },
          ],
        },
      },
    },
  },
};
writeFileSync(`${root}caddy.json`, JSON.stringify(initial));
const caddy = Bun.spawn(["./bin/caddy", "run", "--config", `${root}caddy.json`], {
  cwd: new URL(".", import.meta.url).pathname,
  stdout: "ignore",
  stderr: "pipe",
});

const admin = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://caddy${path}`, {
    unix: ADMIN,
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res;
};
for (let i = 0; i < 50; i++) {
  try { await admin("GET", "/config/"); break; } catch { await Bun.sleep(100); }
}

const ROUTES = "/config/apps/http/servers/content/routes";
const securityHeaders = {
  handler: "headers",
  response: {
    set: {
      "Strict-Transport-Security": ["max-age=63072000; includeSubDomains"],
      "X-Content-Type-Options": ["nosniff"],
      "Referrer-Policy": ["strict-origin-when-cross-origin"],
    },
  },
};
const cacheRoutes = [
  {
    match: [{ path: ["/_app/immutable/*"] }],
    handle: [{ handler: "headers", response: { set: { "Cache-Control": ["public, max-age=31536000, immutable"] } } }],
  },
  {
    match: [{ path: ["*.html", "/"] }],
    handle: [{ handler: "headers", response: { set: { "Cache-Control": ["no-cache"] } } }],
  },
];
const staticSite = (id: string, host: string, project: string, protectedSite = false) => ({
  "@id": id,
  match: [{ host: [host] }],
  terminal: true,
  handle: [
    {
      handler: "subroute",
      routes: [
        ...(protectedSite
          ? [{
              handle: [{
                handler: "reverse_proxy",
                upstreams: [{ dial: `unix/${AGENT}` }],
                rewrite: { method: "GET", uri: "/_yoal/verify" },
                headers: { request: { set: { "X-Forwarded-Uri": ["{http.request.uri}"] } } },
                handle_response: [{ match: { status_code: [2] }, routes: [{ handle: [{ handler: "vars" }] }] }],
              }],
            }, {
              handle: [{ handler: "headers", response: { set: { "X-Robots-Tag": ["noindex"], "Cache-Control": ["private"] } } }],
            }]
          : []),
        { handle: [securityHeaders] },
        ...cacheRoutes,
        {
          handle: [{
            handler: "file_server",
            root: `${root}srv/sites/${project}`,
            precompressed: { br: {}, gzip: {} },
            precompressed_order: ["br", "gzip"],
          }],
        },
      ],
    },
  ],
});

const curl = async (host: string, path = "/", extra: string[] = []) => {
  const out = await $`curl -s -D - -o - -H ${`Host: ${host}`} ${extra} http://127.0.0.1:${PORT}${path}`.nothrow().text();
  const [head = "", ...rest] = out.split("\r\n\r\n");
  return { status: Number(/HTTP\/[\d.]+ (\d+)/.exec(head)?.[1]), head: head.toLowerCase(), body: rest.join("\r\n\r\n") };
};

try {
  // 1. Admin API is NOT on TCP :2019
  const tcp = await $`curl -s -m 1 http://127.0.0.1:2019/config/`.nothrow();
  check("admin API not reachable on tcp :2019", tcp.exitCode !== 0);

  // 2. Insert site route at index 0 (ahead of catch-all) and measure apply latency
  let t0 = performance.now();
  await admin("PUT", `${ROUTES}/0`, staticSite("site:blog", "blog.yoal.test", "blog"));
  check("route insert latency < 100ms", performance.now() - t0 < 100, `${Math.round(performance.now() - t0)}ms`);
  let r = await curl("blog.yoal.test");
  check("serves release v1", r.status === 200 && r.body.includes("blog v1"));
  check("unknown host hits catch-all 404", (await curl("nope.yoal.test")).status === 404);

  // 3. Precompressed + headers
  r = await curl("blog.yoal.test", "/", ["-H", "Accept-Encoding: br, gzip"]);
  check("precompressed brotli served", r.head.includes("content-encoding: br"));
  r = await curl("blog.yoal.test", "/", ["-H", "Accept-Encoding: gzip"]);
  check("precompressed gzip served", r.head.includes("content-encoding: gzip"));
  check("security headers", r.head.includes("strict-transport-security") && r.head.includes("x-content-type-options: nosniff"));
  check("html no-cache", r.head.includes("cache-control: no-cache"));
  r = await curl("blog.yoal.test", "/_app/immutable/app.abc123.js");
  check("hashed asset immutable", r.head.includes("immutable"));

  // 4. Atomic symlink swap — no Caddy call at all
  activate("blog", "bbb");
  r = await curl("blog.yoal.test");
  check("symlink swap serves v2 without config change", r.body.includes("blog v2"));
  activate("blog", "aaa");
  check("rollback via symlink", (await curl("blog.yoal.test")).body.includes("blog v1"));

  // 5. forward_auth protected site
  await admin("PUT", `${ROUTES}/0`, staticSite("site:secret", "secret.yoal.test", "secret", true));
  r = await curl("secret.yoal.test", "/page?x=1");
  check("protected: no cookie -> 302 to platform login", r.status === 302 && r.head.includes("site-login?return=https%3a%2f%2fsecret.yoal.test%2fpage%3fx%3d1"));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const cookie = `__yoal_s=${exp}.${sign("secret.yoal.test", exp)}`;
  r = await curl("secret.yoal.test", "/", ["-H", `Cookie: ${cookie}`]);
  check("protected: valid cookie -> 200 + noindex", r.status === 200 && r.body.includes("secret") && r.head.includes("x-robots-tag: noindex"));
  r = await curl("secret.yoal.test", "/", ["-H", `Cookie: __yoal_s=${exp}.forged`]);
  check("protected: forged cookie -> 302", r.status === 302);
  const crossCookie = `__yoal_s=${exp}.${sign("blog.yoal.test", exp)}`;
  check("protected: cookie for another host rejected", (await curl("secret.yoal.test", "/", ["-H", `Cookie: ${crossCookie}`])).status === 302);

  // 6. Replace by @id (atomic) and delete by @id
  t0 = performance.now();
  await admin("PATCH", "/id/site:secret", staticSite("site:secret", "secret.yoal.test", "secret", false));
  check("replace by @id (unprotect) applies", (await curl("secret.yoal.test")).status === 200, `${Math.round(performance.now() - t0)}ms`);
  await admin("DELETE", "/id/site:secret");
  check("delete by @id -> falls to catch-all", (await curl("secret.yoal.test")).status === 404);

  // 7. Scale: 300 site routes, then measure a request + one more insert
  t0 = performance.now();
  for (let i = 0; i < 300; i++) await admin("PUT", `${ROUTES}/0`, staticSite(`site:p${i}`, `p${i}.yoal.test`, "blog"));
  const bulk = performance.now() - t0;
  t0 = performance.now();
  await admin("PUT", `${ROUTES}/0`, staticSite("site:last", "last.yoal.test", "blog"));
  check("insert with 300 routes present < 250ms", performance.now() - t0 < 250, `${Math.round(performance.now() - t0)}ms (bulk 300: ${Math.round(bulk)}ms)`);
  check("still serves with 300 routes", (await curl("p150.yoal.test")).status === 200);

  // 8. Caddy RSS
  const rss = (await $`ps -o rss= -p ${caddy.pid}`.text()).trim();
  check("caddy RSS (informational)", true, `${Math.round(Number(rss) / 1024)}MB with 301 routes`);
} finally {
  caddy.kill();
  agent.stop(true);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check}${r.detail ? `  (${r.detail})` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
