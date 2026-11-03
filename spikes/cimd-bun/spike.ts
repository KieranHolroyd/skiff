// Spike: does Better Auth's Node CIMD transport (node:https + pinned lookup) behave correctly under Bun?
import { fetchClientMetadataResource as f } from "@better-auth/cimd/node";
const cases: [string, string, boolean][] = [
  ["public https", "https://example.com/", true],
  ["redirect refused", "https://github.com/login/oauth", false], // github 302s
  ["loopback rejected", "https://127.0.0.1/", false],
  ["localhost rejected", "https://localhost/", false],
  ["private rejected", "https://10.0.0.1/", false],
  ["link-local/metadata rejected", "https://169.254.169.254/", false],
  ["ipv6 loopback rejected", "https://[::1]/", false],
  ["plain http rejected", "http://example.com/", false],
];
let fails = 0;
for (const [name, url, shouldSucceed] of cases) {
  let ok = false, detail = "";
  try {
    const r = await Promise.race([f(url), Bun.sleep(8000).then(() => { throw new Error("timeout"); })]) as Response;
    ok = r.status >= 200 && r.status < 300; detail = `status ${r.status}`;
  } catch (e) { detail = (e as Error).message.slice(0, 90); }
  const pass = ok === shouldSucceed; if (!pass) fails++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(30)} ${detail}`);
}
process.exit(fails ? 1 : 0);
