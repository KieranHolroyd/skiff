// Does Bun honour node:https `lookup` (IP pinning)? Force example.com -> 127.0.0.1; honoured => ECONNREFUSED.
import https from "node:https";
import { fetchClientMetadataResource as f } from "@better-auth/cimd/node";
const honoured = await new Promise<string>((res) => {
  const req = https.request("https://example.com/", {
    lookup: (_h: string, opts: any, cb: any) => opts?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4),
  }, (r) => res(`NOT honoured (got HTTP ${r.statusCode})`));
  req.on("error", (e) => res(`honoured (${(e as any).code})`));
  req.setTimeout(5000, () => { req.destroy(); res("timeout"); });
  req.end();
});
console.log("lookup pinning:", honoured);
try { const r = await f("https://google.com/"); console.log("redirect test: status", r.status, "(3xx returned, not followed = OK)"); }
catch (e) { console.log("redirect test: rejected ->", (e as Error).message.slice(0, 100)); }
