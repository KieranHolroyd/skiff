import type { Database } from 'bun:sqlite';
import type { SkiffDb } from '@skiff/db';
import type { Notifier, CoreConfig } from './config.ts';
import type { AuditService } from './audit.ts';
import type { QuotaService } from './quota.ts';
import type { UsageService } from './usage.ts';
import type { ObjectStore } from './object-store.ts';
import type { TelemetryStore } from './telemetry.ts';
import type { MetricsExporter } from './metrics-export.ts';
import type { PlatformPolicyService } from './platform-policies.ts';
import type { ProjectService } from './projects.ts';
import type { ReleaseService } from './releases.ts';
import type { DeploymentService } from './deployments.ts';
import type { UploadService } from './uploads.ts';
import type { NodeService } from './nodes.ts';
import type { AccessService } from './access.ts';
import type { SecretService } from './secrets.ts';
import type { WorkloadService } from './workloads.ts';
import type { DatabaseService } from './databases.ts';
import type { DatabaseStudioService } from './database-studio.ts';
import type { ContainerConsoleService } from './container-console.ts';
import type { StorageService } from './storage-instances.ts';
import type { BrokerService } from './brokers.ts';
import type { EmailService } from './email.ts';
import type { EventService } from './events.ts';
import type { NodeTaskService } from './node-tasks.ts';
import type { JobService } from './jobs.ts';
import type { VolumeService } from './volumes.ts';
import type { AppVolumeService } from './app-volumes.ts';
import type { ServiceMoveService } from './service-moves.ts';
import type { StorageObjectsService } from './storage-objects.ts';
import type { DomainService } from './domains.ts';
import type { BuildService } from './builds.ts';
import type { PipelineService } from './pipelines.ts';
import type { LogService } from './logs.ts';
import type { EnvironmentService } from './environments.ts';
import type { OperationService } from './operations/service.ts';
import type { BlueprintService } from './blueprints.ts';
import type { SchedulerService } from './scheduler.ts';
import type { FlowService } from './flows/service.ts';
import type { ServiceActionsService } from './service-actions.ts';
import type { BackupTargetService } from './backup-targets.ts';
import type { UpgradeService } from './upgrades.ts';
import type { GithubRunnerService } from './github-runners.ts';
import type { GithubAppService } from './github-app.ts';
import type { FunctionService } from './functions.ts';
import type { TemplateService } from './templates.ts';
import type { AlertService } from './alerts.ts';
import type { TopologyService } from './topology.ts';
import type { ServiceEndpointService } from './service-endpoints.ts';
import type { ShareService } from './shares.ts';
import type { DiskMountService } from './disk-mounts.ts';
import type { StoragePoolService } from './storage-pools.ts';
import type { RegistryCredentialService } from './registry-credentials.ts';
import type { RegistryService } from './registry.ts';
import type { DatabaseReplicaService } from './database-replica-service.ts';
import type { StorageReplicationService } from './storage-replication-service.ts';
import type { IngressHaService } from './ingress-ha.ts';
import type { FailoverService } from './failover-service.ts';
import type { ClusterConfigService } from './cluster-config-service.ts';
import type { IamService } from './iam/service.ts';
import type { ServiceAccountService } from './service-accounts.ts';

/**
 * Shared dependency object. Service instances are attached after construction (in `createCore`)
 * so the services can call each other without constructor cycles.
 */
export interface CoreContext {
	db: SkiffDb;
	sqlite: Database;
	config: CoreConfig;
	objectStore: ObjectStore;
	audit: AuditService;
	quota: QuotaService;
	usage: UsageService;
	telemetry?: TelemetryStore;
	/** Prometheus `/metrics` renderer and its settings (docs/METRICS.md). */
	metricsExport: MetricsExporter;
	/** Retention, alert thresholds, ingress, assistant caps and defaults the owner sets in Settings. */
	policies: PlatformPolicyService;
	notifiers: Notifier[];
	now(): number;
	projects: ProjectService;
	releases: ReleaseService;
	deployments: DeploymentService;
	uploads: UploadService;
	nodes: NodeService;
	access: AccessService;
	secrets: SecretService;
	workloads: WorkloadService;
	databases: DatabaseService;
	databaseStudio: DatabaseStudioService;
	/** Container console: inspect, files and shells (D127). */
	containerConsole: ContainerConsoleService;
	storage: StorageService;
	/** Managed queue brokers (D111). */
	brokers: BrokerService;
	/** Email: Skiff's self-hosted SES (docs/EMAIL.md). */
	email: EmailService;
	/** Event notifications into function queues (D122). */
	events: EventService;
	nodeTasks: NodeTaskService;
	/** App cron jobs and one-off commands (plan 09, docs/SCHEDULER.md §Jobs). */
	jobs: JobService;
	storageObjects: StorageObjectsService;
	volumes: VolumeService;
	appVolumes: AppVolumeService;
	moves: ServiceMoveService;
	domains: DomainService;
	builds: BuildService;
	/** GitHub-Actions-shaped pipelines (docs/PIPELINES.md). */
	pipelines: PipelineService;
	logs: LogService;
	environments: EnvironmentService;
	operations: OperationService;
	/** Blueprint stacks: plan/apply of a declarative file (plan 11). */
	blueprints: BlueprintService;
	scheduler: SchedulerService;
	/** Durable step machines for multi-step changes (docs/FLOWS.md, D163). */
	flows: FlowService;
	serviceActions: ServiceActionsService;
	backupTargets: BackupTargetService;
	upgrades: UpgradeService;
	githubRunners: GithubRunnerService;
	/** Skiff's GitHub App: installations, tokens, statuses, the App webhook (docs/GITHUB.md). */
	githubApp: GithubAppService;
	templates: TemplateService;
	/** Metric alert rules (docs/ALERTS.md). */
	alerts: AlertService;
	/** Fleet topology and blast radius (CLUSTERING §3.6, C0). */
	topology: TopologyService;
	/** Cross-node service endpoints (CLUSTERING §4.3, C2). */
	endpoints: ServiceEndpointService;
	/** Cluster shares (CLUSTERING §5.2, C3). */
	shares: ShareService;
	/** Local partitions mounted by UUID and adopted as volumes (docs/VOLUMES.md §3.1). */
	diskMounts: DiskMountService;
	/** Storage pools and placement rules (docs/STORAGE.md, D144). */
	storagePools: StoragePoolService;
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
	/** The failover controller: lease, replica moves, ingress rotation, database decide (C8). */
	failover: FailoverService;
	/** Cluster tunables (CLUSTERING). */
	cluster: ClusterConfigService;
	/** Identity and access management: bindings, roles, groups and the decision cache (IAM.md I1). */
	iam: IamService;
	/** Service accounts: org-owned machine principals (`sa_…`, IAM.md I13). */
	serviceAccounts: ServiceAccountService;
	/** Functions: Workers-compatible workloads on workerd (D110). */
	functions: FunctionService;
}
