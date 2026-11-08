import type { Database } from 'bun:sqlite';
import type { SkiffDb } from '@skiff/db';
import type { CoreConfig } from './config.ts';
import type { CoreContext } from './context.ts';
import { AuditService } from './audit.ts';
import { QuotaService } from './quota.ts';
import { UsageService } from './usage.ts';
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
import { MetricsExporter } from './metrics-export.ts';
import { PlatformPolicyService } from './platform-policies.ts';
import { ObservabilityService } from './observability.ts';
import { AlertService } from './alerts.ts';
import { TopologyService } from './topology.ts';
import { ServiceEndpointService } from './service-endpoints.ts';
import { ShareService } from './shares.ts';
import { RegistryCredentialService } from './registry-credentials.ts';
import { RegistryService } from './registry.ts';
import { DatabaseReplicaService } from './database-replica-service.ts';
import { StorageReplicationService } from './storage-replication-service.ts';
import { IngressHaService } from './ingress-ha.ts';
import { FailoverService } from './failover-service.ts';
import { ClusterConfigService } from './cluster-config-service.ts';
import { WorkloadService } from './workloads.ts';
import { DatabaseService } from './databases.ts';
import { DatabaseStudioService } from './database-studio.ts';
import { ContainerConsoleService } from './container-console.ts';
import { StorageService } from './storage-instances.ts';
import { BrokerService } from './brokers.ts';
import { EmailService, type EmailServiceOptions } from './email.ts';
import { cloudflareConfigFromEnv, HttpCloudflareClient } from './domains.ts';
import { EventService } from './events.ts';
import { NodeTaskService } from './node-tasks.ts';
import { JobService } from './jobs.ts';
import { ConnectedAppService } from './connected-apps.ts';
import { DiskService } from './disks.ts';
import { AppVolumeService } from './app-volumes.ts';
import { ServiceMoveService } from './service-moves.ts';
import { StorageObjectsService } from './storage-objects.ts';
import { DomainService } from './domains.ts';
import { BuildService } from './builds.ts';
import { PipelineService } from './pipelines.ts';
import { LogService } from './logs.ts';
import { LogDrainService } from './log-drains.ts';
import { EnvironmentService } from './environments.ts';
import { SourceService } from './source.ts';
import { createOperationService, type OperationService } from './operations/index.ts';
import { SchedulerService } from './scheduler.ts';
import { FlowService } from './flows/service.ts';
import { ServiceActionsService } from './service-actions.ts';
import { BackupTargetService } from './backup-targets.ts';
import { UpgradeService } from './upgrades.ts';
import { GithubRunnerService } from './github-runners.ts';
import { GithubAppService } from './github-app.ts';
import { FunctionService } from './functions.ts';
import { TemplateService } from './templates.ts';
import { BlueprintService } from './blueprints.ts';
import { IamService } from './iam/service.ts';
import { ServiceAccountService } from './service-accounts.ts';
import { AccessKeyService } from './access-keys.ts';

export * from './config.ts';
export * from './context.ts';
export * from './errors.ts';
export * from './util.ts';
export * from './cron.ts';
export * from './artifact.ts';
export * from './object-store.ts';
export * from './orgs.ts';
export * from './iam/service.ts';
export * from './service-accounts.ts';
export * from './access-keys.ts';
export * from './projects.ts';
export * from './releases.ts';
export * from './deployments.ts';
export * from './uploads.ts';
export * from './nodes.ts';
export * from './access.ts';
export * from './deploy.ts';
export * from './maintenance.ts';
export * from './failover-service.ts';
export * from './secrets.ts';
export * from './metrics.ts';
export * from './metrics-export.ts';
export * from './platform-policies.ts';
export * from './observability.ts';
export * from './observability-query.ts';
export * from './alerts.ts';
export * from './clickhouse.ts';
export * from './placement.ts';
export * from './workloads.ts';
export * from './functions.ts';
export * from './runtime-tier.ts';
export * from './github-runners.ts';
export * from './github-app.ts';
export * from './templates.ts';
export * from './databases.ts';
export * from './database-studio.ts';
export * from './container-console.ts';
export * from './storage-instances.ts';
export * from './brokers.ts';
export * from './email.ts';
export * from './events.ts';
export * from './node-tasks.ts';
export * from './jobs.ts';
export * from './connected-apps.ts';
export * from './domain-reconcile.ts';
export * from './disks.ts';
export * from './app-volumes.ts';
export * from './app-volume-lifecycle.ts';
export * from './service-moves.ts';
export * from './storage-objects.ts';
export * from './storage-s3.ts';
export * from './domains.ts';
export * from './builds.ts';
export * from './pipelines.ts';
export * from './pipeline-engine.ts';
export * from './registry-credentials.ts';
export * from './registry.ts';
export * from './registry-token.ts';
export * from './oci-client.ts';
export * from './logs.ts';
export * from './environments.ts';
export * from './source.ts';
export * from './notify.ts';
export * from './web-push.ts';
export * from './notify-chat.ts';
export * from './telemetry.ts';
export * from './operations/index.ts';
export * from './scheduler.ts';
export * from './flows/index.ts';
export * from './usage.ts';
export * from './service-actions.ts';
export * from './backup-targets.ts';
export * from './audit.ts';
export * from './log-drains.ts';
export * from './webhook-signature.ts';
export * from './upgrades.ts';
export * from './blueprints.ts';

export interface CoreOptions {
	db: SkiffDb;
	sqlite: Database;
	config: CoreConfig;
	version?: string;
	/** Email DNS/Cloudflare seams (docs/EMAIL.md); defaults read `SKIFF_CLOUDFLARE_*` and `SKIFF_MAIL_DOMAIN`. */
	email?: EmailServiceOptions;
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
	metricsExport: MetricsExporter;
	policies: PlatformPolicyService;
	observability: ObservabilityService;
	alerts: AlertService;
	workloads: WorkloadService;
	databases: DatabaseService;
	databaseStudio: DatabaseStudioService;
	containerConsole: ContainerConsoleService;
	storage: StorageService;
	brokers: BrokerService;
	events: EventService;
	nodeTasks: NodeTaskService;
	/** App cron jobs and one-off commands (plan 09). */
	jobs: JobService;
	/** MCP/OAuth clients users have approved (Settings → Connected apps). */
	connectedApps: ConnectedAppService;
	/** Disks and default storage (docs/STORAGE.md, D169). */
	disks: DiskService;
	appVolumes: AppVolumeService;
	moves: ServiceMoveService;
	storageObjects: StorageObjectsService;
	domains: DomainService;
	builds: BuildService;
	pipelines: PipelineService;
	logs: LogService;
	environments: EnvironmentService;
	source: SourceService;
	audit: AuditService;
	operations: OperationService;
	blueprints: BlueprintService;
	scheduler: SchedulerService;
	flows: FlowService;
	serviceActions: ServiceActionsService;
	backupTargets: BackupTargetService;
	usage: UsageService;
	upgrades: UpgradeService;
	githubRunners: GithubRunnerService;
	/** Skiff's GitHub App (docs/GITHUB.md). */
	githubApp: GithubAppService;
	templates: TemplateService;
	/** Functions: Workers-compatible workloads on workerd (D110). */
	functions: FunctionService;
	/** Fleet topology and blast radius (CLUSTERING §3.6, C0). */
	topology: TopologyService;
	/** Cross-node service endpoints (CLUSTERING §4.3, C2). */
	endpoints: ServiceEndpointService;
	/** Cluster shares (CLUSTERING §5.2, C3). */
	shares: ShareService;
	/** Credentials for external container registries (docs/REGISTRY.md R2). */
	registryCredentials: RegistryCredentialService;
	/** The platform container registry (docs/REGISTRY.md G1). */
	registry: RegistryService;
	/** Managed database replicas (CLUSTERING §9.2, C7). */
	databaseReplicas: DatabaseReplicaService;
	/** Bucket replication (CLUSTERING §10.2, C9). */
	storageReplication: StorageReplicationService;
	/** Ingress HA status (CLUSTERING §7, C5). */
	ingress: IngressHaService;
	/** The failover controller (CLUSTERING §8.3, §9.3, C8). */
	failover: FailoverService;
	/** Cluster tunables (CLUSTERING). */
	cluster: ClusterConfigService;
	/** Identity and access management (IAM.md I1). */
	iam: IamService;
	/** Service accounts: org-owned machine principals (`sa_…`, IAM.md I13). */
	serviceAccounts: ServiceAccountService;
	/** Org-bound access keys and their verification (IAM.md I14). */
	accessKeys: AccessKeyService;
	/** Email: Skiff's self-hosted SES (docs/EMAIL.md). */
	email: EmailService;
	/** Log drains: forward stored log lines to webhooks and OTLP receivers (DESIGN §8). */
	logDrains: LogDrainService;
}

function defaultEmailOptions(): EmailServiceOptions {
	const cloudflare = cloudflareConfigFromEnv();
	return {
		cloudflare: cloudflare ? new HttpCloudflareClient(cloudflare) : null,
		cloudflareZoneName: cloudflare?.zoneName ?? null,
		mailDomain: process.env.SKIFF_MAIL_DOMAIN?.trim() || null,
	};
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

	ctx.policies = new PlatformPolicyService(ctx);
	ctx.audit = new AuditService(ctx);
	ctx.iam = new IamService(ctx);
	ctx.serviceAccounts = new ServiceAccountService(ctx);
	ctx.accessKeys = new AccessKeyService(ctx);
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
	ctx.databaseStudio = new DatabaseStudioService(ctx);
	ctx.containerConsole = new ContainerConsoleService(ctx);
	ctx.storage = new StorageService(ctx);
	ctx.brokers = new BrokerService(ctx);
	ctx.email = new EmailService(ctx, options.email ?? defaultEmailOptions());
	ctx.events = new EventService(ctx);
	ctx.nodeTasks = new NodeTaskService(ctx);
	ctx.jobs = new JobService(ctx);
	ctx.disks = new DiskService(ctx);
	ctx.appVolumes = new AppVolumeService(ctx);
	ctx.moves = new ServiceMoveService(ctx);
	ctx.storageObjects = new StorageObjectsService(ctx);
	ctx.domains = new DomainService(ctx);
	ctx.logs = new LogService(ctx);
	ctx.builds = new BuildService(ctx);
	ctx.pipelines = new PipelineService(ctx);
	ctx.operations = createOperationService(ctx);
	ctx.blueprints = new BlueprintService(ctx);
	ctx.scheduler = new SchedulerService(ctx);
	ctx.flows = new FlowService(ctx);
	ctx.serviceActions = new ServiceActionsService(ctx);
	ctx.backupTargets = new BackupTargetService(ctx);
	ctx.usage = new UsageService(ctx);
	ctx.upgrades = new UpgradeService(ctx, {
		platformVersion: options.version ?? '0.0.0',
		agentVersion: options.config.desiredAgentVersion ?? null
	});
	ctx.githubRunners = new GithubRunnerService(ctx);
	ctx.githubApp = new GithubAppService(ctx);
	ctx.templates = new TemplateService(ctx);
	ctx.functions = new FunctionService(ctx);
	ctx.topology = new TopologyService(ctx);
	ctx.endpoints = new ServiceEndpointService(ctx);
	ctx.shares = new ShareService(ctx);
	ctx.registryCredentials = new RegistryCredentialService(ctx);
	ctx.registry = new RegistryService(ctx);
	ctx.databaseReplicas = new DatabaseReplicaService(ctx);
	ctx.storageReplication = new StorageReplicationService(ctx);
	ctx.ingress = new IngressHaService(ctx);
	ctx.failover = new FailoverService(ctx);
	ctx.cluster = new ClusterConfigService(ctx);
	// Flow definitions register once every service exists, so their steps can call any of them.
	ctx.flows.register(ctx.moves.databaseMoveFlow());
	const source = new SourceService(ctx);

	const deploy = new DeployService(ctx);
	const maintenance = new MaintenanceService(ctx);
	const secrets = ctx.secrets;
	const metrics = new MetricsService(ctx, options.version);
	ctx.metricsExport = new MetricsExporter(ctx, () => metrics.platformLines());
	const observability = new ObservabilityService(ctx);
	ctx.alerts = new AlertService(ctx, observability);

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
		metricsExport: ctx.metricsExport,
		policies: ctx.policies,
		observability,
		alerts: ctx.alerts,
		workloads: ctx.workloads,
		databases: ctx.databases,
		databaseStudio: ctx.databaseStudio,
		containerConsole: ctx.containerConsole,
		storage: ctx.storage,
		brokers: ctx.brokers,
		email: ctx.email,
		events: ctx.events,
		nodeTasks: ctx.nodeTasks,
		jobs: ctx.jobs,
		connectedApps: new ConnectedAppService(ctx),
		disks: ctx.disks,
		appVolumes: ctx.appVolumes,
		moves: ctx.moves,
		storageObjects: ctx.storageObjects,
		domains: ctx.domains,
		builds: ctx.builds,
		pipelines: ctx.pipelines,
		logs: ctx.logs,
		environments: ctx.environments,
		source,
		audit: ctx.audit,
		operations: ctx.operations,
		blueprints: ctx.blueprints,
		scheduler: ctx.scheduler,
		flows: ctx.flows,
		serviceActions: ctx.serviceActions,
		backupTargets: ctx.backupTargets,
		usage: ctx.usage,
		upgrades: ctx.upgrades,
		githubRunners: ctx.githubRunners,
		githubApp: ctx.githubApp,
		templates: ctx.templates,
		functions: ctx.functions,
		topology: ctx.topology,
		endpoints: ctx.endpoints,
		shares: ctx.shares,
		registryCredentials: ctx.registryCredentials,
		registry: ctx.registry,
		databaseReplicas: ctx.databaseReplicas,
		storageReplication: ctx.storageReplication,
		ingress: ctx.ingress,
		failover: ctx.failover,
		cluster: ctx.cluster,
		iam: ctx.iam,
		serviceAccounts: ctx.serviceAccounts,
		accessKeys: ctx.accessKeys,
		logDrains: new LogDrainService(ctx, options.version),
	};
}
