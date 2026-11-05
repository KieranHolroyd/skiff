import type { Database } from 'bun:sqlite';
import type { SkiffDb } from '@skiff/db';
import type { CoreConfig } from './config.ts';
import type { CoreContext } from './context.ts';
import { AuditService } from './audit.ts';
import { QuotaService } from './quota.ts';
import { ProjectService } from './projects.ts';
import { ReleaseService } from './releases.ts';
import { DeploymentService } from './deployments.ts';
import { UploadService } from './uploads.ts';
import { NodeService } from './nodes.ts';
import { AccessService } from './access.ts';
import { DeployService } from './deploy.ts';
import { MaintenanceService } from './maintenance.ts';
import { SecretService } from './secrets.ts';
import { MetricsService } from './metrics.ts';
import { WorkloadService } from './workloads.ts';
import { DatabaseService } from './databases.ts';
import { StorageService } from './storage-instances.ts';
import { VolumeService } from './volumes.ts';
import { DomainService } from './domains.ts';
import { BuildService } from './builds.ts';
import { LogService } from './logs.ts';
import { EnvironmentService } from './environments.ts';
import { SourceService } from './source.ts';
import { createOperationService, type OperationService } from './operations/index.ts';

export * from './config.ts';
export * from './context.ts';
export * from './errors.ts';
export * from './util.ts';
export * from './artifact.ts';
export * from './object-store.ts';
export * from './orgs.ts';
export * from './projects.ts';
export * from './releases.ts';
export * from './deployments.ts';
export * from './uploads.ts';
export * from './nodes.ts';
export * from './access.ts';
export * from './deploy.ts';
export * from './maintenance.ts';
export * from './secrets.ts';
export * from './metrics.ts';
export * from './placement.ts';
export * from './workloads.ts';
export * from './databases.ts';
export * from './storage-instances.ts';
export * from './volumes.ts';
export * from './domains.ts';
export * from './builds.ts';
export * from './logs.ts';
export * from './environments.ts';
export * from './source.ts';
export * from './notify.ts';
export * from './telemetry.ts';
export * from './operations/index.ts';

export interface CoreOptions {
	db: SkiffDb;
	sqlite: Database;
	config: CoreConfig;
	version?: string;
}

export interface Core {
	ctx: CoreContext;
	projects: ProjectService;
	releases: ReleaseService;
	deployments: DeploymentService;
	uploads: UploadService;
	nodes: NodeService;
	access: AccessService;
	deploy: DeployService;
	maintenance: MaintenanceService;
	secrets: SecretService;
	metrics: MetricsService;
	workloads: WorkloadService;
	databases: DatabaseService;
	storage: StorageService;
	volumes: VolumeService;
	domains: DomainService;
	builds: BuildService;
	logs: LogService;
	environments: EnvironmentService;
	source: SourceService;
	audit: AuditService;
	operations: OperationService;
}

/**
 * The one service layer every surface calls (DESIGN §3.2): dashboard, REST, MCP and CLI get
 * identical permission checks and behaviour.
 */
export function createCore(options: CoreOptions): Core {
	const ctx = {
		db: options.db,
		sqlite: options.sqlite,
		config: options.config,
		objectStore: options.config.objectStore,
		notifiers: options.config.notifiers ?? [],
		now: options.config.now ?? (() => Date.now()),
	} as unknown as CoreContext;

	ctx.audit = new AuditService(ctx);
	ctx.quota = new QuotaService(ctx);
	ctx.projects = new ProjectService(ctx);
	ctx.releases = new ReleaseService(ctx);
	ctx.deployments = new DeploymentService(ctx);
	ctx.uploads = new UploadService(ctx);
	ctx.nodes = new NodeService(ctx);
	ctx.access = new AccessService(ctx);
	ctx.environments = new EnvironmentService(ctx);
	ctx.secrets = new SecretService(ctx);
	ctx.workloads = new WorkloadService(ctx);
	ctx.databases = new DatabaseService(ctx);
	ctx.storage = new StorageService(ctx);
	ctx.volumes = new VolumeService(ctx);
	ctx.domains = new DomainService(ctx);
	ctx.logs = new LogService(ctx);
	ctx.builds = new BuildService(ctx);
	ctx.operations = createOperationService(ctx);
	const source = new SourceService(ctx);

	const deploy = new DeployService(ctx);
	const maintenance = new MaintenanceService(ctx);
	const secrets = ctx.secrets;
	const metrics = new MetricsService(ctx, options.version);

	return {
		ctx,
		projects: ctx.projects,
		releases: ctx.releases,
		deployments: ctx.deployments,
		uploads: ctx.uploads,
		nodes: ctx.nodes,
		access: ctx.access,
		deploy,
		maintenance,
		secrets,
		metrics,
		workloads: ctx.workloads,
		databases: ctx.databases,
		storage: ctx.storage,
		volumes: ctx.volumes,
		domains: ctx.domains,
		builds: ctx.builds,
		logs: ctx.logs,
		environments: ctx.environments,
		source,
		audit: ctx.audit,
		operations: ctx.operations,
	};
}
