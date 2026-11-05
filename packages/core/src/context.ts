import type { Database } from 'bun:sqlite';
import type { SkiffDb } from '@skiff/db';
import type { Notifier, CoreConfig } from './config.ts';
import type { AuditService } from './audit.ts';
import type { QuotaService } from './quota.ts';
import type { ObjectStore } from './object-store.ts';
import type { TelemetryStore } from './telemetry.ts';
import type { ProjectService } from './projects.ts';
import type { ReleaseService } from './releases.ts';
import type { DeploymentService } from './deployments.ts';
import type { UploadService } from './uploads.ts';
import type { NodeService } from './nodes.ts';
import type { AccessService } from './access.ts';
import type { SecretService } from './secrets.ts';
import type { WorkloadService } from './workloads.ts';
import type { DatabaseService } from './databases.ts';
import type { StorageService } from './storage-instances.ts';
import type { VolumeService } from './volumes.ts';
import type { StorageObjectsService } from './storage-objects.ts';
import type { DomainService } from './domains.ts';
import type { BuildService } from './builds.ts';
import type { LogService } from './logs.ts';
import type { EnvironmentService } from './environments.ts';
import type { OperationService } from './operations/service.ts';
import type { SchedulerService } from './scheduler.ts';
import type { ServiceActionsService } from './service-actions.ts';
import type { BackupTargetService } from './backup-targets.ts';

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
	telemetry?: TelemetryStore;
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
	storage: StorageService;
	storageObjects: StorageObjectsService;
	volumes: VolumeService;
	domains: DomainService;
	builds: BuildService;
	logs: LogService;
	environments: EnvironmentService;
	operations: OperationService;
	scheduler: SchedulerService;
	serviceActions: ServiceActionsService;
	backupTargets: BackupTargetService;
}
