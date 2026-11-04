import { and, desc, eq, ne, or } from "drizzle-orm";
import { unzipSync } from "fflate";
import { deployments, releases } from "@skiff/db";
import { requirePermission, type Principal } from "@skiff/contracts";
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
    requirePermission(principal, "deployment:read");
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
