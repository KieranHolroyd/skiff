import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@yoal/db";
import { buildPrincipal } from "./orgs.ts";
import { createCore } from "./index.ts";
import { LocalObjectStore } from "./object-store.ts";
import type { Core } from "./index.ts";

const dir = mkdtempSync(join(tmpdir(), "yoal-source-"));
const opened = createDb({ path: ":memory:" });
const core: Core = createCore({
  db: opened.db,
  sqlite: opened.sqlite,
  version: "0.1.0",
  config: {
    dataDir: dir,
    platformOrigin: "https://control.test",
    contentDomain: "sites.test",
    objectStore: new LocalObjectStore(
      join(dir, "objects"),
      "https://control.test",
      "object-secret-123",
    ),
    masterKey: new Uint8Array(32).fill(7),
    siteCookieSecret: "site-cookie-secret-123",
    objectStoreSecret: "object-secret-123",
    desiredAgentVersion: "0.1.0",
    now: () => Date.now(),
  },
});

const owner = buildPrincipal({
  kind: "user",
  userId: "user_src",
  orgId: "org_src",
  role: "owner",
});
const viewer = buildPrincipal({
  kind: "user",
  userId: "user_view",
  orgId: "org_src",
  role: "viewer",
});

afterAll(() => {
  opened.sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

async function setup(
  slug: string,
  files: Array<{ path: string; content: string; encoding: "utf8" }> = [
    { path: "index.html", content: "<h1>hello</h1>", encoding: "utf8" },
    { path: "assets/app.js", content: 'console.log("hi")', encoding: "utf8" },
    { path: "assets/site.css", content: "body{color:red}", encoding: "utf8" },
  ],
) {
  await core.projects.create(owner, {
    name: slug,
    slug,
    runtime: "static",
    placement: "edge",
    productionAccess: "public",
    previewAccess: "platform",
  });
  const project = core.projects.requireRow(owner, slug);
  const deployment = await core.uploads.deployInline(owner, project, files);
  return { project: core.projects.requireRow(owner, slug), deployment };
}

describe("source viewer service", () => {
  test("lists canonical release files without the precompressed twins", async () => {
    const { project, deployment } = await setup("source-list");
    const view = await core.source.view(owner, project, deployment.id);
    expect(view.files.map((file) => file.path)).toEqual([
      "assets/app.js",
      "assets/site.css",
      "index.html",
    ]);
    expect(view.deployment.shortId).toBe(deployment.shortId);
    expect(view.release.sha256).toHaveLength(64);
  });

  test("reads a file by exact manifest path and skips inflating the rest", async () => {
    const { project } = await setup("source-read");
    const { data, file } = await core.source.file(
      owner,
      project,
      undefined,
      "assets/app.js",
    );
    expect(file.size).toBe(data.byteLength);
    expect(new TextDecoder().decode(data)).toBe('console.log("hi")');
  });

  test("never serves paths outside the manifest, including .br twins", async () => {
    const { project } = await setup("source-guard");
    await expect(
      core.source.file(owner, project, undefined, "../secret"),
    ).rejects.toThrow("not found");
    await expect(
      core.source.file(owner, project, undefined, "index.html.br"),
    ).rejects.toThrow("not found");
  });

  test("viewers can read source but another org cannot", async () => {
    const { project, deployment } = await setup("source-audience");
    const view = await core.source.view(viewer, project, deployment.id);
    expect(view.files).toHaveLength(3);

    const outsider = buildPrincipal({
      kind: "user",
      userId: "user_x",
      orgId: "org_other",
      role: "owner",
    });
    await expect(
      core.source.view(outsider, project, deployment.id),
    ).rejects.toThrow();
  });

  test("falls back to production, then the newest active deployment", async () => {
    const { project, deployment } = await setup("source-default");
    const defaulted = await core.source.view(owner, project);
    expect(defaulted.deployment.id).toBe(deployment.id);

    const artifact = await core.source.artifact(owner, project);
    expect(artifact.release.sha256).toBe(deployment.release.sha256);
    expect(artifact.zip.byteLength).toBeGreaterThan(0);
  });

  test("suggests env names from .env files and code without returning values", async () => {
    const { project } = await setup("source-env", [
      { path: ".env.example", content: "DATABASE_URL=postgres://secret\nAPI_KEY=also-secret\n", encoding: "utf8" },
      { path: "src/server.ts", content: "const url = process.env.PUBLIC_URL;\nconst token = process.env['API_TOKEN'];\n", encoding: "utf8" },
      { path: "index.html", content: "<h1>hello</h1>", encoding: "utf8" },
    ]);
    const scan = await core.source.envSuggestions(owner, project);
    expect(scan.names).toEqual([
      { name: "DATABASE_URL", source: "env-file", detail: ".env.example" },
      { name: "API_KEY", source: "env-file", detail: ".env.example" },
      { name: "PUBLIC_URL", source: "code", detail: "src/server.ts" },
      { name: "API_TOKEN", source: "code", detail: "src/server.ts" },
    ]);
    expect(JSON.stringify(scan)).not.toContain("postgres://secret");
    expect(JSON.stringify(scan)).not.toContain("also-secret");
  });

  test("env suggestions keep the deployment permission check", async () => {
    const { project } = await setup("source-env-audience", [
      { path: ".env.example", content: "API_KEY=secret\n", encoding: "utf8" },
    ]);
    expect((await core.source.envSuggestions(viewer, project)).names[0]?.name).toBe("API_KEY");
    const outsider = buildPrincipal({
      kind: "user",
      userId: "user_env_x",
      orgId: "org_other",
      role: "owner",
    });
    await expect(core.source.envSuggestions(outsider, project)).rejects.toThrow();
  });
});
