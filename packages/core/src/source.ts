import { and, desc, eq, ne, or } from "drizzle-orm";
import { unzipSync } from "fflate";
import { deployments, releases } from "@skiff/db";
import {
  detectEnvNames,
  isEnvFileName,
  parseEnvFileNames,
  type DetectedEnvName,
  type Principal,
} from "@skiff/contracts";
import { parseManifest, type ManifestFile } from "./artifact.ts";
import type { CoreContext } from "./context.ts";
import type { DeploymentView } from "./deployments.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import type { ProjectRow } from "./projects.ts";

export interface SourceFileView {
  path: string;
  size: number;
  sha256: string;
}

export interface SourceView {
  deployment: DeploymentView;
  release: {
    id: string;
    sha256: string;
    sizeBytes: number;
    fileCount: number;
    precompressed: boolean;
    createdAt: string;
  };
  files: SourceFileView[];
}

export interface SourceFileContent {
  file: SourceFileView;
  data: Uint8Array;
}

export interface SourceEnvSuggestions {
  /** Detected names, deduped, with the first file that mentioned each one. */
  names: DetectedEnvName[];
  /** How many release files were actually read (bounded; used for the UI note). */
  filesScanned: number;
}

/** Keep a small, bounded cache: the dashboard is a rare reader on a 4 GB edge box. */
const ZIP_CACHE_BYTES = 32 * 1024 * 1024;
const FILE_CACHE_BYTES = 16 * 1024 * 1024;

type ReleaseRow = typeof releases.$inferSelect;

/**
 * Read-only access to the files inside a deployment's artifact.
 *
 * Releases are content-addressed, immutable zips in the object store (D25), so the manifest in
 * SQLite is the index and the zip is only touched when a file is actually requested. Both caches
 * are byte-bounded LRUs: a release never grows beyond what one site can contain, and the source
 * viewer cannot pin an edge node's memory by browsing a large artifact.
 */
export class SourceService {
  private readonly zips = new Map<string, Uint8Array>();
  private zipBytes = 0;
  private readonly files = new Map<string, Uint8Array>();
  private fileBytes = 0;
  private readonly inflight = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly ctx: CoreContext) {}

  /** List the canonical files of a deployment; production is the default when none is named. */
  async view(
    principal: Principal,
    project: ProjectRow,
    idOrShort?: string,
  ): Promise<SourceView> {
    const { row, release } = this.requireDeployment(
      principal,
      project,
      idOrShort,
    );
    return {
      deployment: this.ctx.deployments.view(row, project),
      release: {
        id: release.id,
        sha256: release.sha256,
        sizeBytes: release.sizeBytes,
        fileCount: release.fileCount,
        precompressed: release.precompressed,
        createdAt: new Date(release.createdAt).toISOString(),
      },
      files: manifestFiles(release),
    };
  }

  /** Read one canonical file. Only paths present in the signed-off manifest are readable. */
  async file(
    principal: Principal,
    project: ProjectRow,
    idOrShort: string | undefined,
    path: string,
  ): Promise<SourceFileContent> {
    if (!path) throw new ValidationError("A file path is required.");
    const { release } = this.requireDeployment(principal, project, idOrShort);
    const entry = manifestFiles(release).find((file) => file.path === path);
    if (!entry) throw new NotFoundError("File");
    return { file: entry, data: await this.extract(release, entry.path) };
  }

  /**
   * Railway-style "suggested variables": names found in the release's `.env*` files and in
   * common environment-access patterns. Bounded in files and bytes, so opening the runtime
   * editor never downloads or inflates an unbounded artifact.
   *
   * Only names are returned; values in a committed `.env` are never read back to a caller.
   */
  async envSuggestions(
    principal: Principal,
    project: ProjectRow,
    idOrShort?: string,
  ): Promise<SourceEnvSuggestions> {
    const { release } = this.requireDeployment(principal, project, idOrShort);
    // The zip is downloaded whole; a very large release must not turn a UI hint into a 500 MB read.
    if (release.sizeBytes > ENV_SCAN_MAX_ARTIFACT_BYTES) {
      return { names: [], filesScanned: 0 };
    }
    const files = manifestFiles(release);
    const envFiles = files.filter(
      (file) => isEnvFileName(file.path) && !isScanNoise(file.path),
    );
    const codeFiles = files
      .filter(
        (file) =>
          CODE_EXTENSIONS.has(extensionOf(file.path)) && !isScanNoise(file.path),
      )
      .sort(
        (a, b) => pathDepth(a.path) - pathDepth(b.path) || a.path.localeCompare(b.path),
      );
    const candidates = [...envFiles, ...codeFiles].slice(0, ENV_SCAN_MAX_FILES);
    const found = new Map<string, DetectedEnvName>();
    let bytes = 0;
    let filesScanned = 0;
    for (const file of candidates) {
      if (file.size > ENV_SCAN_MAX_FILE_BYTES) continue;
      if (bytes + file.size > ENV_SCAN_MAX_BYTES) continue;
      let data: Uint8Array;
      try {
        data = await this.extract(release, file.path);
      } catch {
        // One unreadable entry should not hide the rest of the suggestions.
        continue;
      }
      bytes += data.byteLength;
      filesScanned++;
      if (looksBinary(data)) continue;
      const text = new TextDecoder().decode(data);
      const isEnv = isEnvFileName(file.path);
      const names = isEnv ? parseEnvFileNames(text) : detectEnvNames(text);
      for (const name of names) {
        if (found.has(name)) continue;
        found.set(name, {
          name,
          source: isEnv ? "env-file" : "code",
          detail: file.path,
        });
        if (found.size >= ENV_SCAN_MAX_NAMES) break;
      }
      if (found.size >= ENV_SCAN_MAX_NAMES) break;
    }
    return { names: [...found.values()], filesScanned };
  }

  /** The original artifact, for "download release". */
  async artifact(
    principal: Principal,
    project: ProjectRow,
    idOrShort?: string,
  ): Promise<{
    deployment: DeploymentView;
    release: ReleaseRow;
    zip: Uint8Array;
  }> {
    const { row, release } = this.requireDeployment(
      principal,
      project,
      idOrShort,
    );
    return {
      deployment: this.ctx.deployments.view(row, project),
      release,
      zip: await this.zip(release),
    };
  }

  private requireDeployment(
    principal: Principal,
    project: ProjectRow,
    idOrShort?: string,
  ): { row: typeof deployments.$inferSelect; release: ReleaseRow } {
    let id: string | null | undefined = idOrShort;
    if (!id) id = this.defaultDeploymentId(project);
    if (!id) throw new NotFoundError("Deployment");
    const row = this.ctx.db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.projectId, project.id),
          or(eq(deployments.id, id), eq(deployments.shortId, id)),
        ),
      )
      .get();
    if (!row || row.status === "deleted") throw new NotFoundError("Deployment");
    this.ctx.iam.require(principal, "deployment:read", {
      type: "deployment",
      id: row.id,
      projectId: project.id,
    });
    const release = this.ctx.db
      .select()
      .from(releases)
      .where(
        and(
          eq(releases.id, row.releaseId),
          eq(releases.orgId, principal.orgId),
        ),
      )
      .get();
    if (!release) throw new NotFoundError("Release");
    return { row, release };
  }

  private defaultDeploymentId(project: ProjectRow): string | null {
    if (project.productionDeploymentId) {
      const production = this.ctx.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.id, project.productionDeploymentId),
            ne(deployments.status, "deleted"),
          ),
        )
        .get();
      if (production) return production.id;
    }
    return (
      this.ctx.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.projectId, project.id),
            eq(deployments.status, "active"),
          ),
        )
        .orderBy(desc(deployments.createdAt))
        .get()?.id ?? null
    );
  }

  private async extract(
    release: ReleaseRow,
    path: string,
  ): Promise<Uint8Array> {
    const key = `${release.sha256}:${path}`;
    const cached = this.files.get(key);
    if (cached) {
      // Refresh LRU order.
      this.files.delete(key);
      this.files.set(key, cached);
      return cached;
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const work = (async () => {
      const zip = await this.zip(release);
      let data: Uint8Array | undefined;
      try {
        // Filter before inflating: only the requested entry is decompressed.
        const unzipped = unzipSync(zip, {
          filter: (file) =>
            file.name === path || file.name.replaceAll("\\", "/") === path,
        });
        data = unzipped[path] ?? Object.values(unzipped)[0];
      } catch {
        throw new ValidationError(
          "The release artifact is not a readable zip.",
        );
      }
      if (!data) throw new NotFoundError("File");
      this.rememberFile(key, data);
      return data;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async zip(release: ReleaseRow): Promise<Uint8Array> {
    const cached = this.zips.get(release.objectKey);
    if (cached) {
      this.zips.delete(release.objectKey);
      this.zips.set(release.objectKey, cached);
      return cached;
    }
    const zip = await this.ctx.releases.download(release);
    if (zip.byteLength <= ZIP_CACHE_BYTES) {
      this.zips.set(release.objectKey, zip);
      this.zipBytes += zip.byteLength;
      while (this.zipBytes > ZIP_CACHE_BYTES) {
        const oldest = this.zips.keys().next().value;
        if (oldest === undefined) break;
        const evicted = this.zips.get(oldest);
        this.zips.delete(oldest);
        this.zipBytes -= evicted?.byteLength ?? 0;
      }
    }
    return zip;
  }

  private rememberFile(key: string, data: Uint8Array): void {
    if (data.byteLength > FILE_CACHE_BYTES) return;
    this.files.set(key, data);
    this.fileBytes += data.byteLength;
    while (this.fileBytes > FILE_CACHE_BYTES) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.files.get(oldest);
      this.files.delete(oldest);
      this.fileBytes -= evicted?.byteLength ?? 0;
    }
  }
}

/** Canonical entries only; the manifest never contains the `.br`/`.gz` twins. */
function manifestFiles(release: ReleaseRow): SourceFileView[] {
  const seen = new Set<string>();
  const out: ManifestFile[] = [];
  for (const file of parseManifest(release.manifestJson)) {
    if (!file?.path || seen.has(file.path)) continue;
    if (file.path.split("/").includes("..")) continue;
    seen.add(file.path);
    out.push(file);
  }
  return out
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 }));
}

/** Bounded scan: a 500 MB site must not turn the runtime editor into a download. */
const ENV_SCAN_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const ENV_SCAN_MAX_FILES = 24;
const ENV_SCAN_MAX_FILE_BYTES = 128 * 1024;
const ENV_SCAN_MAX_BYTES = 512 * 1024;
const ENV_SCAN_MAX_NAMES = 120;

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".php",
  ".java",
  ".kt",
  ".cs",
  ".sh",
  ".bash",
  ".yml",
  ".yaml",
  ".toml",
]);

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

/** Vendor trees and generated bundles are not where a project's own config lives. */
function isScanNoise(path: string): boolean {
  if (/(?:^|\/)(?:node_modules|vendor|\.git)\//.test(path)) return true;
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".min.js") ||
    lower.endsWith(".map") ||
    lower.endsWith(".lock") ||
    lower.endsWith("-lock.json")
  );
}

/** A NUL byte in the first pages means text decoding would only produce noise. */
function looksBinary(data: Uint8Array): boolean {
  const end = Math.min(data.byteLength, 4096);
  for (let index = 0; index < end; index++) if (data[index] === 0) return true;
  return false;
}
