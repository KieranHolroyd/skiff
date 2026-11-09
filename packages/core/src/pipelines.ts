import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import {
	nodes,
	pipelineArtifacts,
	pipelineCaches,
	pipelineDeploys,
	pipelineEnvironments,
	pipelineJobs,
	pipelineLogLines,
	pipelineProjectLinks,
	pipelineRepositories,
	pipelineRuns,
	pipelineSecrets,
	pipelineSteps,
	pipelineTriggers,
	pipelineVariables,
	projects,
	settings,
} from '@skiff/db';
import {
	pipelineAutoSetupSchema,
	pipelineDispatchSchema,
	pipelineEnvironmentSetSchema,
	pipelineProjectLinkSchema,
	pipelineRepositoryCreateSchema,
	pipelineRepositoryUpdateSchema,
	pipelineSecretNameSchema,
	pipelineSecretSetSchema,
	pipelineVariableSetSchema,
	type PipelineAutoSetupInput,
	type PipelineAutoSetupView,
	type PipelineConclusion,
	type PipelineDispatch,
	type PipelineEnvironmentSet,
	type PipelineEnvironmentView,
	type PipelineEventName,
	type PipelineIsolationTier,
	type PipelineJobView,
	type PipelineLogLine,
	type PipelineProjectLink,
	type PipelineProjectLinkView,
	type PipelineRepositoryCreate,
	type PipelineRepositoryUpdate,
	type PipelineRepositoryView,
	type PipelineRunSummary,
	type PipelineRunView,
	type PipelineSecretSet,
	type PipelineSecretView,
	type PipelineStepView,
	type PipelineTriggerView,
	type PipelineVariableView,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { cronMatches } from './cron.ts';
import { decrypt, encrypt, newId } from './util.ts';
import {
	PipelineEngine,
	fullRef,
	type PipelineSubscription,
	type PipelineJobRow,
	type PipelineRepositoryRow,
	type PipelineRunRow,
	type PipelineTriggerRow,
} from './pipeline-engine.ts';
import {
	normaliseForgeEvent,
	verifyDelivery,
	webhookEventName,
	webhookSource,
	type ForgeEvent,
	type ForgePullRequestEvent,
	type ForgePushEvent,
	type HeaderReader,
	type WebhookSource,
} from './forges/events.ts';
import type { RepositoryIdentity } from './forges/router.ts';

const iso = (value: number | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

function parse<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

/** What the webhook did, for the delivery log on GitHub's side. */
export interface PipelineWebhookResult {
	accepted: boolean;
	reason?: string;
	triggerId?: string;
}

/** A repository without workflows is asked again after this, unless a push touches them (D172). */
const AUTO_SETUP_RECHECK_MS = 10 * 60_000;
const WORKFLOW_DIR = '.skiff/workflows';

/** Where a delivery for an unknown repository came from, so it may add it to Pipelines (D172, D177). */
export interface AutoRegisterSource {
	/** The forge connection; null for the GitHub App. */
	connectionId: string | null;
	fullName: string;
	/** Who the repository is created on behalf of (the installation linker or connection creator). */
	createdBy: string | null;
	/** The delivery covers repositories Skiff does not know yet (App installation, namespace hook). */
	mayAutoRegister: boolean;
}

/**
 * Pipelines (docs/PIPELINES.md): repositories, their secrets, variables, environments and deploy
 * targets, dispatch and webhook triggers, and the run/job/log views every surface reads. The job
 * DAG, claims and the job-token API are in `PipelineEngine` (`this.engine`).
 *
 * Permissions reuse `build:*` (W15: the git build is a one-job pipeline): `build:read` views,
 * `build:create` dispatches and manages repositories, `build:cancel` cancels. Secrets also need
 * `secret:create`; linking a deploy target needs `deployment:promote`; approving an environment
 * needs an org owner or admin.
 */
export class PipelineService {
	readonly engine: PipelineEngine;
	private lastScheduleMinute = 0;
	/** `orgId:owner/repo` → when to look for workflows again (automatic setup, D172). */
	private readonly autoSetupChecked = new Map<string, number>();

	constructor(private readonly ctx: CoreContext) {
		this.engine = new PipelineEngine(ctx);
	}

	// --- repositories -------------------------------------------------------------------

	listRepositories(principal: Principal): PipelineRepositoryView[] {
		// TODO(IAM I2): narrow this list with scopeFilter once a pipeline repository can be
		// resolved to a project binding; `scopeFilter` only returns project/environment ids.
		this.ctx.iam.require(principal, 'build:read', { type: 'org' });
		return this.ctx.db
			.select()
			.from(pipelineRepositories)
			.where(eq(pipelineRepositories.orgId, principal.orgId))
			.orderBy(asc(pipelineRepositories.name))
			.all()
			.map((row) => this.repositoryView(row));
	}

	getRepository(principal: Principal, name: string): PipelineRepositoryView {
		const row = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:read', { type: 'pipelineRepository', id: row.id });
		return this.repositoryView(row);
	}

	createRepository(principal: Principal, input: PipelineRepositoryCreate): PipelineRepositoryView {
		this.ctx.iam.require(principal, 'build:create', { type: 'org' });
		const parsed = pipelineRepositoryCreateSchema.parse(input);
		const taken = this.ctx.db
			.select({ id: pipelineRepositories.id })
			.from(pipelineRepositories)
			.where(and(eq(pipelineRepositories.orgId, principal.orgId), eq(pipelineRepositories.name, parsed.name)))
			.get();
		if (taken) throw new ConflictError(`A repository named "${parsed.name}" already exists.`);
		const now = this.ctx.now();
		const row: PipelineRepositoryRow = {
			id: newId('prp_'),
			orgId: principal.orgId,
			name: parsed.name,
			cloneUrl: parsed.cloneUrl,
			provider: parsed.provider ?? this.ctx.git.providerKind(principal.orgId, parsed.cloneUrl),
			defaultBranch: parsed.defaultBranch,
			defaultImage: parsed.defaultImage ?? null,
			webhookSecret: parsed.webhookSecret ? this.sealWebhookSecret(parsed.webhookSecret) : null,
			enabled: true,
			nextRunNumber: 1,
			schedulesJson: '[]',
			minIsolationJson: JSON.stringify(parsed.minIsolation ?? {}),
			statusToken: parsed.statusToken ? this.ctx.secrets.seal(principal.orgId, parsed.statusToken) : null,
			createdBy: principal.userId,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.db.insert(pipelineRepositories).values(row).run();
		// Adding it by hand undoes an earlier removal for automatic setup.
		const ignoreKey = this.ctx.git.autoSetupKey(row.orgId, row.cloneUrl);
		if (ignoreKey) this.setIgnored(row.orgId, ignoreKey, false);
		// D174: a repository on a connected forge gets Skiff's webhook.
		this.ctx.git.ensureWebhook(row.orgId, row.cloneUrl);
		this.audit(principal, 'pipeline.repository.create', row.id, { name: row.name, cloneUrl: row.cloneUrl });
		return this.repositoryView(row);
	}

	updateRepository(principal: Principal, name: string, input: PipelineRepositoryUpdate): PipelineRepositoryView {
		const row = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:create', { type: 'pipelineRepository', id: row.id });
		const parsed = pipelineRepositoryUpdateSchema.parse(input);
		const patch: Partial<PipelineRepositoryRow> = { updatedAt: this.ctx.now() };
		if (parsed.cloneUrl !== undefined) {
			patch.cloneUrl = parsed.cloneUrl;
			if (parsed.provider === undefined) patch.provider = this.ctx.git.providerKind(row.orgId, parsed.cloneUrl);
		}
		if (parsed.provider !== undefined) patch.provider = parsed.provider;
		if (parsed.defaultBranch !== undefined) patch.defaultBranch = parsed.defaultBranch;
		if (parsed.defaultImage !== undefined) patch.defaultImage = parsed.defaultImage;
		if (parsed.enabled !== undefined) patch.enabled = parsed.enabled;
		if (parsed.webhookSecret !== undefined)
			patch.webhookSecret = parsed.webhookSecret ? this.sealWebhookSecret(parsed.webhookSecret) : null;
		if (parsed.statusToken !== undefined)
			patch.statusToken = parsed.statusToken ? this.ctx.secrets.seal(row.orgId, parsed.statusToken) : null;
		if (parsed.minIsolation !== undefined) {
			// Loosening isolation is an owner/admin decision, like environment rules.
			if (!this.ctx.iam.can(principal, 'pipeline:manage', { type: 'pipelineRepository', id: row.id }))
				throw new CoreError('forbidden', 'Only org owners and admins can change isolation minimums.', 403);
			patch.minIsolationJson = JSON.stringify(parsed.minIsolation);
		}
		this.ctx.db.update(pipelineRepositories).set(patch).where(eq(pipelineRepositories.id, row.id)).run();
		if (patch.cloneUrl || (patch.enabled && !row.enabled)) this.ctx.git.ensureWebhook(row.orgId, patch.cloneUrl ?? row.cloneUrl);
		this.audit(principal, 'pipeline.repository.update', row.id, {
			name: row.name,
			fields: Object.keys(parsed).filter((key) => (key !== 'webhookSecret' && key !== 'statusToken') || parsed[key] !== undefined),
		});
		return this.repositoryView({ ...row, ...patch });
	}

	/** Deletes the repository and everything it owns: runs, logs, artifacts, caches, secrets. */
	async deleteRepository(principal: Principal, name: string): Promise<void> {
		const row = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:create', { type: 'pipelineRepository', id: row.id });
		const objectKeys = [
			...this.ctx.db.select({ key: pipelineArtifacts.objectKey }).from(pipelineArtifacts).where(eq(pipelineArtifacts.repositoryId, row.id)).all(),
			...this.ctx.db.select({ key: pipelineCaches.objectKey }).from(pipelineCaches).where(eq(pipelineCaches.repositoryId, row.id)).all(),
		].map((entry) => entry.key);
		this.ctx.db.transaction(() => {
			const runIds = this.ctx.db
				.select({ id: pipelineRuns.id })
				.from(pipelineRuns)
				.where(eq(pipelineRuns.repositoryId, row.id))
				.all()
				.map((run) => run.id);
			const jobIds = runIds.length
				? this.ctx.db
						.select({ id: pipelineJobs.id })
						.from(pipelineJobs)
						.where(inArray(pipelineJobs.runId, runIds))
						.all()
						.map((job) => job.id)
				: [];
			for (let i = 0; i < jobIds.length; i += 500) {
				const chunk = jobIds.slice(i, i + 500);
				this.ctx.db.delete(pipelineSteps).where(inArray(pipelineSteps.jobId, chunk)).run();
				this.ctx.db.delete(pipelineLogLines).where(inArray(pipelineLogLines.jobId, chunk)).run();
				this.ctx.db.delete(pipelineDeploys).where(inArray(pipelineDeploys.jobId, chunk)).run();
			}
			this.ctx.db.delete(pipelineJobs).where(eq(pipelineJobs.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineRuns).where(eq(pipelineRuns.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineTriggers).where(eq(pipelineTriggers.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineArtifacts).where(eq(pipelineArtifacts.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineCaches).where(eq(pipelineCaches.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineSecrets).where(eq(pipelineSecrets.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineVariables).where(eq(pipelineVariables.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineEnvironments).where(eq(pipelineEnvironments.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineProjectLinks).where(eq(pipelineProjectLinks.repositoryId, row.id)).run();
			this.ctx.db.delete(pipelineRepositories).where(eq(pipelineRepositories.id, row.id)).run();
		});
		for (const key of objectKeys) await this.ctx.objectStore.delete(key).catch(() => undefined);
		// A removed repository must not come back on its next push through the App or a namespace hook.
		const ignoreKey = this.ctx.git.autoSetupKey(row.orgId, row.cloneUrl);
		const identity = this.ctx.git.identity(row.orgId, row.cloneUrl);
		if (ignoreKey && identity && !this.repositoriesFor(row.orgId, identity).length) this.setIgnored(row.orgId, ignoreKey, true);
		this.audit(principal, 'pipeline.repository.delete', row.id, { name: row.name });
	}

	private repositoryView(row: PipelineRepositoryRow): PipelineRepositoryView {
		const last = this.ctx.db
			.select()
			.from(pipelineRuns)
			.where(eq(pipelineRuns.repositoryId, row.id))
			.orderBy(desc(pipelineRuns.createdAt))
			.limit(1)
			.get();
		return {
			id: row.id,
			name: row.name,
			cloneUrl: row.cloneUrl,
			provider: row.provider,
			defaultBranch: row.defaultBranch,
			defaultImage: row.defaultImage,
			enabled: row.enabled,
			hasWebhookSecret: Boolean(row.webhookSecret),
			hasStatusToken: Boolean(row.statusToken),
			githubAppInstallationId: row.provider === 'github' ? this.ctx.githubApp.repositoryLink(row.orgId, row.cloneUrl).installationId : null,
			gitProvider: this.ctx.git.link(row.orgId, row.cloneUrl),
			minIsolation: {
				trusted: parse<Record<string, PipelineIsolationTier | null>>(row.minIsolationJson, {}).trusted ?? null,
				untrusted: parse<Record<string, PipelineIsolationTier | null>>(row.minIsolationJson, {}).untrusted ?? null,
			},
			webhookPath: `/api/webhooks/pipelines/${row.id}`,
			lastRun: last ? this.runSummary(row, last) : null,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	requireRepository(principal: Principal, name: string): PipelineRepositoryRow {
		const row = this.ctx.db
			.select()
			.from(pipelineRepositories)
			.where(and(eq(pipelineRepositories.orgId, principal.orgId), eq(pipelineRepositories.name, name)))
			.get();
		if (!row) throw new NotFoundError('Repository');
		return row;
	}

	// --- triggers ------------------------------------------------------------------------

	/** `workflow_dispatch` from the dashboard, REST, CLI or MCP. Inputs are checked once resolved. */
	dispatch(principal: Principal, name: string, input: PipelineDispatch): PipelineTriggerView {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:create', { type: 'pipelineRepository', id: repository.id });
		if (!repository.enabled) throw new ConflictError(`Repository "${name}" is disabled.`);
		const parsed = pipelineDispatchSchema.parse(input);
		this.ctx.quota.assertCanCreateBuild(repository.orgId, null);
		// An inline workflow is code nobody committed. Run as anyone with `build:create`, it could
		// print the repository's secrets, so it runs untrusted (no secrets, environments or deploys)
		// unless an org owner or admin dispatches it from a human session. Never trusted over MCP.
		const inlineTrusted =
			!parsed.workflowText ||
			(principal.credential !== 'oauth' &&
				this.ctx.iam.can(principal, 'pipeline:manage', { type: 'pipelineRepository', id: repository.id }));
		const trigger = this.engine.createTrigger({
			repository,
			event: 'workflow_dispatch',
			ref: parsed.ref ?? repository.defaultBranch,
			actor: principal.userId,
			trust: inlineTrusted ? 'trusted' : 'untrusted',
			createdBy: principal.userId,
			payload: {
				inputs: parsed.inputs,
				workflowPath: parsed.workflow ?? null,
				workflowText: parsed.workflowText ?? null,
				event: { inputs: parsed.inputs },
			},
		});
		this.audit(principal, 'pipeline.dispatch', trigger.id, {
			repository: name,
			ref: trigger.ref,
			workflow: parsed.workflow ?? '(inline)',
		});
		return this.triggerView(trigger);
	}

	listTriggers(principal: Principal, name: string, limit = 20): PipelineTriggerView[] {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:read', { type: 'pipelineRepository', id: repository.id });
		return this.ctx.db
			.select()
			.from(pipelineTriggers)
			.where(eq(pipelineTriggers.repositoryId, repository.id))
			.orderBy(desc(pipelineTriggers.createdAt))
			.limit(Math.min(Math.max(limit, 1), 100))
			.all()
			.map((row) => this.triggerView(row));
	}

	getTrigger(principal: Principal, name: string, triggerId: string): PipelineTriggerView {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:read', { type: 'pipelineRepository', id: repository.id });
		const row = this.ctx.db
			.select()
			.from(pipelineTriggers)
			.where(and(eq(pipelineTriggers.id, triggerId), eq(pipelineTriggers.repositoryId, repository.id)))
			.get();
		if (!row) throw new NotFoundError('Trigger');
		return this.triggerView(row);
	}

	private triggerView(row: PipelineTriggerRow): PipelineTriggerView {
		return {
			id: row.id,
			event: row.event,
			ref: row.ref,
			status: row.status === 'queued' ? 'resolving' : row.status,
			error: row.error,
			runIds: parse<string[]>(row.runIdsJson, []),
			createdAt: new Date(row.createdAt).toISOString(),
		};
	}

	/**
	 * A delivery to a repository's own webhook (`/api/webhooks/pipelines/<id>`): GitHub, Gitea and
	 * Forgejo sign it with the stored secret, GitLab sends it in `X-Gitlab-Token` (D174). `push` and
	 * pull/merge requests start runs; `ping` is accepted. The secret is mandatory (D45). When Skiff's
	 * GitHub App or a Skiff-created forge hook already delivers the repository's events (D165), this
	 * hook is ignored so one push never starts two runs.
	 */
	async handleWebhook(repositoryId: string, rawBody: string, headers: HeaderReader): Promise<PipelineWebhookResult> {
		const repository = this.ctx.db.select().from(pipelineRepositories).where(eq(pipelineRepositories.id, repositoryId)).get();
		if (!repository) throw new NotFoundError('Repository');
		const from = webhookSource(headers) ?? 'github';
		this.verifySignature(repository, from, rawBody, headers);
		if (!repository.enabled) return { accepted: false, reason: 'repository disabled' };
		let payload: unknown;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			throw new ValidationError('Webhook payload is not valid JSON.');
		}
		const event = normaliseForgeEvent(from, webhookEventName(from, headers), payload);
		if (event.kind === 'ping') return { accepted: true, reason: 'pong' };
		if (event.kind === 'ignored') return { accepted: false, reason: event.reason };
		if (await this.ctx.git.deliversFor(repository.orgId, repository.cloneUrl, event.fullName))
			return { accepted: false, reason: `delivered by ${this.ctx.git.link(repository.orgId, repository.cloneUrl).via ?? 'a managed webhook'}` };
		return this.routeEvent(repository, event);
	}

	/** `handleWebhook` with GitHub's two headers (kept for callers and tests that pass them). */
	async handleGithubWebhook(repositoryId: string, rawBody: string, signature: string | null, event: string | null): Promise<PipelineWebhookResult> {
		const values: Record<string, string> = {};
		if (signature) values['x-hub-signature-256'] = signature;
		if (event) values['x-github-event'] = event;
		return this.handleWebhook(repositoryId, rawBody, { get: (name: string) => values[name.toLowerCase()] ?? null });
	}

	/** An event delivered through Skiff's GitHub App (D165). Returns the trigger ids created. */
	async handleAppEvent(orgId: string, fullName: string, event: string, payload: unknown): Promise<string[]> {
		const normalised = normaliseForgeEvent('github', event, payload);
		if (normalised.kind !== 'push' && normalised.kind !== 'pull_request') return [];
		const installationId = (payload as { installation?: { id?: number } } | null)?.installation?.id ?? null;
		return this.handleForgeEvent(orgId, this.ctx.git.githubIdentity(fullName), normalised, {
			connectionId: null,
			fullName,
			createdBy: installationId ? this.ctx.githubApp.installationLinker(orgId, installationId) : null,
			mayAutoRegister: true,
		});
	}

	/**
	 * An event delivered by a Skiff-managed hook (the GitHub App, or a forge connection's hook): every
	 * enabled pipeline repository of the org with `identity` gets it. A push to a repository Pipelines
	 * does not know yet may add it (D172, D177). Returns the trigger ids created.
	 */
	async handleForgeEvent(
		orgId: string,
		identity: RepositoryIdentity,
		event: ForgePushEvent | ForgePullRequestEvent,
		source: AutoRegisterSource,
	): Promise<string[]> {
		const known = this.repositoriesFor(orgId, identity);
		let repositories = known.filter((row) => row.enabled);
		if (known.length === 0 && event.kind === 'push' && source.mayAutoRegister) {
			const created = await this.autoRegister(orgId, identity, event, source);
			if (created) repositories = [created];
		}
		const triggers: string[] = [];
		for (const repository of repositories) {
			try {
				const result = this.routeEvent(repository, event);
				if (result.triggerId) triggers.push(result.triggerId);
			} catch (error) {
				console.warn(`[pipelines] ${repository.name}: ${event.kind} ignored: ${(error as Error).message}`);
			}
		}
		return triggers;
	}

	/** Every pipeline repository of the org (enabled or not) whose clone URL has `identity`. */
	private repositoriesFor(orgId: string, identity: RepositoryIdentity): PipelineRepositoryRow[] {
		return this.ctx.db
			.select()
			.from(pipelineRepositories)
			.where(eq(pipelineRepositories.orgId, orgId))
			.all()
			.filter((row) => this.ctx.git.identity(orgId, row.cloneUrl) === identity);
	}

	// --- automatic setup through the GitHub App or a namespace hook (D172, D177) -----------------------------------

	private autoSetupKey(orgId: string): string {
		return `pipelines.autoSetup.${orgId}`;
	}

	private readAutoSetup(orgId: string): PipelineAutoSetupView {
		const row = this.ctx.db.select().from(settings).where(eq(settings.key, this.autoSetupKey(orgId))).get();
		const stored = parse<Partial<PipelineAutoSetupView>>(row?.value, {});
		return {
			enabled: stored.enabled !== false,
			ignored: Array.isArray(stored.ignored) ? stored.ignored.filter((name) => typeof name === 'string') : [],
		};
	}

	private writeAutoSetup(orgId: string, value: PipelineAutoSetupView): void {
		const json = JSON.stringify(value);
		const now = this.ctx.now();
		this.ctx.db
			.insert(settings)
			.values({ key: this.autoSetupKey(orgId), value: json, updatedAt: now })
			.onConflictDoUpdate({ target: settings.key, set: { value: json, updatedAt: now } })
			.run();
	}

	private setIgnored(orgId: string, fullName: string, ignored: boolean): void {
		const current = this.readAutoSetup(orgId);
		const same = (name: string) => name.toLowerCase() === fullName.toLowerCase();
		const rest = current.ignored.filter((name) => !same(name));
		const next = ignored ? [...rest, fullName].sort((a, b) => a.localeCompare(b)) : rest;
		if (next.length === current.ignored.length && ignored === current.ignored.some(same)) return;
		this.writeAutoSetup(orgId, { ...current, ignored: next });
		for (const key of this.autoSetupChecked.keys()) if (key.startsWith(`${orgId}:`)) this.autoSetupChecked.delete(key);
	}

	/** Whether pushes through the GitHub App add repositories with workflows automatically. */
	autoSetup(principal: Principal): PipelineAutoSetupView {
		this.ctx.iam.require(principal, 'build:read', { type: 'org' });
		return this.readAutoSetup(principal.orgId);
	}

	/** Turn automatic setup on or off, or forget a removed repository. `pipeline:manage` only. */
	setAutoSetup(principal: Principal, input: PipelineAutoSetupInput): PipelineAutoSetupView {
		this.ctx.iam.require(principal, 'build:create', { type: 'org' });
		if (!this.ctx.iam.can(principal, 'pipeline:manage', { type: 'org' }))
			throw new CoreError('forbidden', 'Only org owners and admins can change automatic pipeline setup.', 403);
		const parsed = pipelineAutoSetupSchema.parse(input);
		if (parsed.unignore) this.setIgnored(principal.orgId, parsed.unignore, false);
		if (parsed.enabled !== undefined) this.writeAutoSetup(principal.orgId, { ...this.readAutoSetup(principal.orgId), enabled: parsed.enabled });
		this.autoSetupChecked.clear();
		this.audit(principal, 'pipeline.auto_setup', principal.orgId, { ...parsed });
		return this.readAutoSetup(principal.orgId);
	}

	/**
	 * A push through the GitHub App or a forge namespace hook to a repository the org has no
	 * pipeline repository for: when the pushed commit has `.skiff/workflows/*.yml`, add the
	 * repository (no webhook secret: the managed hook delivers its events) on behalf of whoever
	 * linked the installation or created the connection, and return it. Pull requests never add a
	 * repository, so a fork cannot register one. Never throws.
	 */
	private async autoRegister(
		orgId: string,
		identity: RepositoryIdentity,
		event: ForgePushEvent,
		source: AutoRegisterSource,
	): Promise<PipelineRepositoryRow | null> {
		const setup = this.readAutoSetup(orgId);
		if (!setup.enabled || !source.createdBy) return null;
		if (!event.ref.startsWith('refs/heads/') || !event.after || event.deleted) return null;
		const cloneUrl =
			event.cloneUrl ?? (source.connectionId ? null : `https://github.com/${source.fullName}.git`);
		if (!cloneUrl || this.ctx.git.identity(orgId, cloneUrl) !== identity) return null;
		const ignoreKey = this.ctx.git.autoSetupKey(orgId, cloneUrl);
		if (!ignoreKey || setup.ignored.some((name) => name.toLowerCase() === ignoreKey.toLowerCase())) return null;
		const cacheKey = `${orgId}:${identity}`;
		const touched = event.addedOrModified.some((file) => file.startsWith(`${WORKFLOW_DIR}/`));
		const until = this.autoSetupChecked.get(cacheKey);
		if (!touched && until && until > this.ctx.now()) return null;
		let workflows: string[];
		try {
			const listing = await this.ctx.git.readPath(orgId, { connectionId: source.connectionId, fullName: source.fullName }, WORKFLOW_DIR, event.after);
			workflows = listing?.kind === 'dir' ? listing.entries.filter((entry) => entry.type === 'file' && /\.ya?ml$/i.test(entry.name)).map((entry) => entry.name) : [];
		} catch (error) {
			console.warn(`[pipelines] ${source.fullName}: could not look for workflows: ${(error as Error).message}`);
			this.autoSetupChecked.set(cacheKey, this.ctx.now() + 60_000);
			return null;
		}
		if (workflows.length === 0) {
			this.autoSetupChecked.set(cacheKey, this.ctx.now() + AUTO_SETUP_RECHECK_MS);
			return null;
		}
		// Re-check after the await: a concurrent push or a person may have added it meanwhile.
		if (this.repositoriesFor(orgId, identity).length) return null;
		const now = this.ctx.now();
		const row: PipelineRepositoryRow = {
			id: newId('prp_'),
			orgId,
			name: this.freeRepositoryName(orgId, source.fullName),
			cloneUrl,
			provider: this.ctx.git.providerKind(orgId, cloneUrl),
			defaultBranch: event.defaultBranch ?? event.ref.slice('refs/heads/'.length),
			defaultImage: null,
			webhookSecret: null,
			enabled: true,
			nextRunNumber: 1,
			schedulesJson: '[]',
			minIsolationJson: '{}',
			statusToken: null,
			createdBy: source.createdBy,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.db.insert(pipelineRepositories).values(row).run();
		this.autoSetupChecked.delete(cacheKey);
		this.ctx.audit.record({
			action: 'pipeline.repository.auto_create',
			resource: 'build',
			resourceId: row.id,
			orgId,
			args: { name: row.name, repository: source.fullName, provider: row.provider, workflows },
			result: 'ok',
		});
		return row;
	}

	/** `repo`, else `owner-repo`, else `repo-2`… — a free pipeline repository name in the org. */
	freeRepositoryName(orgId: string, fullName: string): string {
		const slug = (value: string) =>
			value
				.toLowerCase()
				.replace(/[^a-z0-9._-]+/g, '-')
				.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
				.slice(0, 90) || 'repo';
		const segments = fullName.split('/');
		const repo = segments.pop() ?? '';
		const owner = segments.join('-');
		const taken = new Set(
			this.ctx.db
				.select({ name: pipelineRepositories.name })
				.from(pipelineRepositories)
				.where(eq(pipelineRepositories.orgId, orgId))
				.all()
				.map((row) => row.name),
		);
		const candidates = [slug(repo), slug(`${owner}-${repo}`)];
		for (const candidate of candidates) if (!taken.has(candidate)) return candidate;
		for (let n = 2; ; n++) if (!taken.has(`${candidates[0]}-${n}`)) return `${candidates[0]}-${n}`;
	}

	private routeEvent(repository: PipelineRepositoryRow, event: ForgeEvent): PipelineWebhookResult {
		if (event.kind === 'push') return this.onPush(repository, event);
		if (event.kind === 'pull_request') return this.onPullRequest(repository, event);
		return { accepted: false, reason: event.kind === 'ignored' ? event.reason : 'nothing to do' };
	}

	private onPush(repository: PipelineRepositoryRow, event: ForgePushEvent): PipelineWebhookResult {
		if (!event.after || event.deleted) return { accepted: false, reason: 'branch or tag deleted' };
		this.ctx.quota.assertCanCreateBuild(repository.orgId, null);
		const trigger = this.engine.createTrigger({
			repository,
			event: 'push',
			ref: event.ref,
			sha: event.after,
			actor: event.actor,
			trust: 'trusted',
			createdBy: repository.createdBy,
			payload: {
				// Null when the forge truncated the commit list: path filters then treat it as unknown.
				changedFiles: event.changedFiles,
				title: event.message,
				event: { ref: event.ref, after: event.after, repository: event.fullName },
			},
		});
		return { accepted: true, triggerId: trigger.id };
	}

	private onPullRequest(repository: PipelineRepositoryRow, event: ForgePullRequestEvent): PipelineWebhookResult {
		if (!['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review', 'labeled'].includes(event.action))
			return { accepted: false, reason: `action ${event.action} is not handled` };
		// W10: a PR (or GitLab MR) from a fork runs untrusted: no secrets, no deploys, its own cache scope.
		const trust = event.sameRepository ? 'trusted' : 'untrusted';
		this.ctx.quota.assertCanCreateBuild(repository.orgId, null);
		const trigger = this.engine.createTrigger({
			repository,
			event: 'pull_request',
			ref: event.fetchRef,
			sha: event.headSha,
			actor: event.actor,
			trust,
			createdBy: repository.createdBy,
			payload: {
				action: event.action,
				baseRef: event.baseRef ?? repository.defaultBranch,
				prNumber: event.number,
				title: event.title,
				event: {
					action: event.action,
					number: event.number,
					pull_request: { title: event.title, head: { ref: event.headRef, sha: event.headSha }, base: { ref: event.baseRef } },
				},
			},
		});
		return { accepted: true, triggerId: trigger.id };
	}

	private sealWebhookSecret(secret: string): string {
		const encrypted = encrypt(this.ctx.config.masterKey, new TextEncoder().encode(secret));
		return `${encrypted.nonce}:${encrypted.ciphertext}`;
	}

	private verifySignature(repository: PipelineRepositoryRow, from: WebhookSource, rawBody: string, headers: HeaderReader): void {
		// An unsigned public webhook would let anyone start runs on your build nodes.
		if (!repository.webhookSecret)
			throw new CoreError('unauthorized', 'This repository has no webhook secret. Set one before using webhooks.', 401);
		if (!headers.get('x-hub-signature-256') && !headers.get('x-gitea-signature') && !headers.get('x-forgejo-signature') && !headers.get('x-gitlab-token'))
			throw new CoreError('unauthorized', 'Missing webhook signature (X-Hub-Signature-256, X-Gitea-Signature or X-Gitlab-Token).', 401);
		const [nonce, ciphertext] = repository.webhookSecret.split(':');
		if (!nonce || !ciphertext) throw new CoreError('error', 'Stored webhook secret is corrupt.', 500);
		const secret = new TextDecoder().decode(decrypt(this.ctx.config.masterKey, ciphertext, nonce));
		if (!verifyDelivery(from, secret, rawBody, headers)) throw new CoreError('unauthorized', 'Invalid webhook signature.', 401);
	}

	/**
	 * `schedule:` triggers (maintenance tick). Crons come from the default branch's workflows as
	 * last resolved; each fires at most once per minute per workflow.
	 */
	tickSchedules(now = this.ctx.now()): number {
		const minute = Math.floor(now / 60_000) * 60_000;
		if (minute <= this.lastScheduleMinute) return 0;
		this.lastScheduleMinute = minute;
		let fired = 0;
		for (const repository of this.ctx.db.select().from(pipelineRepositories).where(eq(pipelineRepositories.enabled, true)).all()) {
			const schedules = parse<PipelineSubscription[]>(repository.schedulesJson, []).filter(
				(entry): entry is { path: string; cron: string } => 'cron' in entry,
			);
			for (const schedule of schedules) {
				let due = false;
				try {
					due = cronMatches(new Date(minute), schedule.cron);
				} catch {
					continue;
				}
				if (!due) continue;
				const already = this.ctx.db
					.select({ payload: pipelineTriggers.payloadJson })
					.from(pipelineTriggers)
					.where(
						and(
							eq(pipelineTriggers.repositoryId, repository.id),
							eq(pipelineTriggers.event, 'schedule'),
							gt(pipelineTriggers.createdAt, minute - 1),
						),
					)
					.all()
					.some((row) => {
						const payload = parse<{ schedule?: string; workflowPath?: string }>(row.payload, {});
						return payload.schedule === schedule.cron && payload.workflowPath === schedule.path;
					});
				if (already) continue;
				this.engine.createTrigger({
					repository,
					event: 'schedule',
					ref: repository.defaultBranch,
					actor: 'schedule',
					createdBy: repository.createdBy,
					payload: { schedule: schedule.cron, workflowPath: schedule.path, event: { schedule: schedule.cron } },
				});
				fired++;
			}
		}
		return fired;
	}

	/**
	 * A platform event (`deployments.failed`, `alerts.firing`, …) for an org: start every default
	 * branch workflow subscribed to it with `on: skiff_event`. Called by `EventService` for every
	 * event it emits; never throws (an event source must not fail because of a workflow).
	 */
	onPlatformEvent(orgId: string, type: string, data: Record<string, unknown>): number {
		let started = 0;
		try {
			for (const repository of this.ctx.db
				.select()
				.from(pipelineRepositories)
				.where(and(eq(pipelineRepositories.orgId, orgId), eq(pipelineRepositories.enabled, true)))
				.all()) {
				const subscriptions = parse<PipelineSubscription[]>(repository.schedulesJson, []).filter(
					(entry): entry is { path: string; events: string[] } =>
						'events' in entry && (entry.events.length === 0 || entry.events.includes(type)),
				);
				for (const subscription of subscriptions) {
					this.engine.createTrigger({
						repository,
						event: 'skiff_event',
						ref: repository.defaultBranch,
						actor: 'skiff',
						createdBy: repository.createdBy,
						payload: {
							eventType: type,
							workflowPath: subscription.path,
							title: `${type}`,
							event: { type, data },
						},
					});
					started++;
				}
			}
		} catch (error) {
			console.error(`[pipelines] skiff_event ${type} for ${orgId} not started:`, error);
		}
		return started;
	}

	// --- runs ----------------------------------------------------------------------------

	listRuns(
		principal: Principal,
		name: string,
		options: { status?: string; workflow?: string; ref?: string; event?: string; limit?: number; before?: number } = {},
	): PipelineRunSummary[] {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:read', { type: 'pipelineRepository', id: repository.id });
		const conditions = [eq(pipelineRuns.repositoryId, repository.id)];
		if (options.status === 'queued' || options.status === 'in_progress' || options.status === 'completed')
			conditions.push(eq(pipelineRuns.status, options.status));
		if (options.workflow) conditions.push(eq(pipelineRuns.workflowPath, options.workflow));
		if (options.ref) conditions.push(eq(pipelineRuns.ref, fullRef(options.ref)));
		if (options.event) conditions.push(eq(pipelineRuns.event, options.event));
		if (options.before) conditions.push(lt(pipelineRuns.number, options.before));
		return this.ctx.db
			.select()
			.from(pipelineRuns)
			.where(and(...conditions))
			.orderBy(desc(pipelineRuns.number))
			.limit(Math.min(Math.max(options.limit ?? 30, 1), 100))
			.all()
			.map((row) => this.runSummary(repository, row));
	}

	/** Runs across every repository of the org, newest first (dashboard overview). */
	recentRuns(principal: Principal, limit = 20): PipelineRunSummary[] {
		// TODO(IAM I2): narrow this list with scopeFilter once a pipeline repository can be
		// resolved to a project binding; `scopeFilter` only returns project/environment ids.
		this.ctx.iam.require(principal, 'build:read', { type: 'org' });
		const repos = new Map(
			this.ctx.db
				.select()
				.from(pipelineRepositories)
				.where(eq(pipelineRepositories.orgId, principal.orgId))
				.all()
				.map((row) => [row.id, row]),
		);
		return this.ctx.db
			.select()
			.from(pipelineRuns)
			.where(eq(pipelineRuns.orgId, principal.orgId))
			.orderBy(desc(pipelineRuns.createdAt))
			.limit(Math.min(Math.max(limit, 1), 100))
			.all()
			.flatMap((row) => {
				const repo = repos.get(row.repositoryId);
				return repo ? [this.runSummary(repo, row)] : [];
			});
	}

	async getRun(principal: Principal, name: string, runRef: string): Promise<PipelineRunView> {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:read', { type: 'pipelineRepository', id: repository.id });
		const run = this.requireRun(repository, runRef);
		// Workflow order first (stable sort keeps matrix rows in insertion order within a key).
		const keyOrder = Object.keys(parse<{ jobs?: Record<string, unknown> }>(run.workflowJson, {}).jobs ?? {});
		const jobs = this.ctx.db
			.select()
			.from(pipelineJobs)
			.where(eq(pipelineJobs.runId, run.id))
			.orderBy(asc(pipelineJobs.createdAt), sql`rowid`)
			.all()
			.sort((a, b) => keyOrder.indexOf(a.key) - keyOrder.indexOf(b.key));
		const steps = jobs.length
			? this.ctx.db
					.select()
					.from(pipelineSteps)
					.where(inArray(pipelineSteps.jobId, jobs.map((job) => job.id)))
					.orderBy(asc(pipelineSteps.idx))
					.all()
			: [];
		const nodeIds = [...new Set(jobs.map((job) => job.nodeId).filter((id): id is string => Boolean(id)))];
		const nodeNames = new Map(
			nodeIds.length
				? this.ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(inArray(nodes.id, nodeIds)).all().map((n) => [n.id, n.name])
				: [],
		);
		return {
			...this.runSummary(repository, run),
			inputs: parse<Record<string, unknown>>(run.inputsJson, {}),
			jobs: jobs.map((job) => this.jobView(job, steps.filter((step) => step.jobId === job.id), nodeNames)),
			artifacts: await this.engine.listArtifacts(run.id),
		};
	}

	private jobView(
		job: PipelineJobRow,
		steps: Array<typeof pipelineSteps.$inferSelect>,
		nodeNames: Map<string, string>,
	): PipelineJobView {
		return {
			id: job.id,
			key: job.key,
			name: job.name,
			matrix: job.matrixJson && job.matrixJson !== '{}' ? parse<Record<string, unknown>>(job.matrixJson, {}) : null,
			needs: parse<string[]>(job.needsJson, []),
			runsOn: parse<string[]>(job.runsOnJson, []),
			status: job.status,
			conclusion: job.conclusion,
			environment: job.environment,
			nodeId: job.nodeId,
			nodeName: job.nodeId ? (nodeNames.get(job.nodeId) ?? null) : null,
			runtime: job.runtime ?? null,
			attempt: job.attempt,
			error: job.error,
			outputs: parse<Record<string, string>>(job.outputsJson, {}),
			steps: steps.map(
				(step): PipelineStepView => ({
					index: step.idx,
					name: step.name,
					status: step.status,
					conclusion: step.conclusion,
					summary: step.summary ?? null,
					startedAt: iso(step.startedAt),
					finishedAt: iso(step.finishedAt),
				}),
			),
			createdAt: new Date(job.createdAt).toISOString(),
			startedAt: iso(job.startedAt),
			finishedAt: iso(job.finishedAt),
		};
	}

	runSummary(repository: PipelineRepositoryRow, row: PipelineRunRow): PipelineRunSummary & { error: string | null } {
		return {
			id: row.id,
			repository: repository.name,
			number: row.number,
			workflowName: row.workflowName,
			workflowPath: row.workflowPath,
			event: row.event as PipelineEventName,
			ref: row.ref,
			sha: row.sha,
			title: row.title,
			actor: row.actor,
			trust: row.trust,
			status: row.status,
			conclusion: row.conclusion as PipelineConclusion | null,
			attempt: row.attempt,
			error: row.error,
			createdAt: new Date(row.createdAt).toISOString(),
			startedAt: iso(row.startedAt),
			finishedAt: iso(row.finishedAt),
		};
	}

	/** A run by id or by its per-repository number (`42` or `#42`). */
	private requireRun(repository: PipelineRepositoryRow, runRef: string): PipelineRunRow {
		const number = /^#?(\d+)$/.exec(runRef);
		const row = number
			? this.ctx.db
					.select()
					.from(pipelineRuns)
					.where(and(eq(pipelineRuns.repositoryId, repository.id), eq(pipelineRuns.number, Number(number[1]))))
					.get()
			: this.ctx.db
					.select()
					.from(pipelineRuns)
					.where(and(eq(pipelineRuns.repositoryId, repository.id), eq(pipelineRuns.id, runRef)))
					.get();
		if (!row) throw new NotFoundError('Run');
		return row;
	}

	private requireRunJob(run: PipelineRunRow, jobId: string): PipelineJobRow {
		const row = this.ctx.db
			.select()
			.from(pipelineJobs)
			.where(and(eq(pipelineJobs.runId, run.id), eq(pipelineJobs.id, jobId)))
			.get();
		if (!row) throw new NotFoundError('Job');
		return row;
	}

	async cancelRun(principal: Principal, name: string, runRef: string): Promise<PipelineRunView> {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:cancel', { type: 'pipelineRepository', id: repository.id });
		const run = this.requireRun(repository, runRef);
		if (run.status === 'completed') throw new ConflictError('The run has already completed.');
		this.engine.cancelRun(run);
		this.audit(principal, 'pipeline.cancel', run.id, { repository: name, number: run.number });
		return this.getRun(principal, name, run.id);
	}

	async rerun(principal: Principal, name: string, runRef: string, failedOnly: boolean): Promise<PipelineRunView> {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:create', { type: 'pipelineRepository', id: repository.id });
		const run = this.requireRun(repository, runRef);
		this.ctx.quota.assertCanCreateBuild(repository.orgId, null);
		this.engine.rerun(run, failedOnly, principal.userId);
		this.audit(principal, 'pipeline.rerun', run.id, { repository: name, number: run.number, failedOnly });
		return this.getRun(principal, name, run.id);
	}

	/** Environment approval (W12): `pipeline:approve`, and never over MCP. */
	async approveJob(principal: Principal, name: string, runRef: string, jobId: string, approve: boolean): Promise<PipelineRunView> {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:read', { type: 'pipelineRepository', id: repository.id });
		this.ctx.iam.require(principal, 'pipeline:approve', { type: 'pipelineRepository', id: repository.id });
		if (principal.credential === 'oauth') throw new CoreError('forbidden', 'Environment approvals are a human decision.', 403);
		const run = this.requireRun(repository, runRef);
		const job = this.requireRunJob(run, jobId);
		this.engine.approveJob(job, principal.userId, approve);
		this.audit(principal, approve ? 'pipeline.approve' : 'pipeline.reject', job.id, {
			repository: name,
			number: run.number,
			environment: job.environment,
		});
		return this.getRun(principal, name, run.id);
	}

	jobLogs(
		principal: Principal,
		name: string,
		runRef: string,
		jobId: string,
		options: { after?: number; limit?: number; step?: number } = {},
	): { lines: PipelineLogLine[]; next: number; complete: boolean } {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:read', { type: 'pipelineRepository', id: repository.id });
		const run = this.requireRun(repository, runRef);
		const job = this.requireRunJob(run, jobId);
		const conditions = [eq(pipelineLogLines.jobId, job.id), gt(pipelineLogLines.seq, options.after ?? 0)];
		if (options.step !== undefined) conditions.push(eq(pipelineLogLines.step, options.step));
		const lines = this.ctx.db
			.select()
			.from(pipelineLogLines)
			.where(and(...conditions))
			.orderBy(asc(pipelineLogLines.seq))
			.limit(Math.min(Math.max(options.limit ?? 1000, 1), 5000))
			.all()
			.map((line) => ({
				seq: line.seq,
				jobId: line.jobId,
				step: line.step,
				stream: line.stream,
				text: line.text,
				ts: line.ts,
			}));
		return { lines, next: lines.at(-1)?.seq ?? options.after ?? 0, complete: job.status === 'completed' };
	}

	async artifactDownload(principal: Principal, name: string, runRef: string, artifactId: string): Promise<string> {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:read', { type: 'pipelineRepository', id: repository.id });
		const run = this.requireRun(repository, runRef);
		return this.engine.artifactDownloadUrl(run.id, artifactId);
	}

	// --- secrets, variables, environments, deploy targets --------------------------------

	listSecrets(principal: Principal, name: string): PipelineSecretView[] {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'secret:read-metadata', { type: 'pipelineRepository', id: repository.id });
		return this.ctx.db
			.select()
			.from(pipelineSecrets)
			.where(eq(pipelineSecrets.repositoryId, repository.id))
			.orderBy(asc(pipelineSecrets.environment), asc(pipelineSecrets.name))
			.all()
			.map((row) => ({ name: row.name, environment: row.environment || null, updatedAt: new Date(row.updatedAt).toISOString() }));
	}

	setSecret(principal: Principal, name: string, secretName: string, input: PipelineSecretSet): PipelineSecretView {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:create', { type: 'pipelineRepository', id: repository.id });
		this.ctx.iam.require(principal, 'secret:create', { type: 'pipelineRepository', id: repository.id });
		const key = pipelineSecretNameSchema.parse(secretName);
		const parsed = pipelineSecretSetSchema.parse(input);
		const environment = parsed.environment ?? '';
		const now = this.ctx.now();
		const sealed = this.ctx.secrets.seal(repository.orgId, parsed.value);
		const existing = this.ctx.db
			.select()
			.from(pipelineSecrets)
			.where(
				and(
					eq(pipelineSecrets.repositoryId, repository.id),
					eq(pipelineSecrets.environment, environment),
					eq(pipelineSecrets.name, key),
				),
			)
			.get();
		if (existing)
			this.ctx.db.update(pipelineSecrets).set({ valueSealed: sealed, updatedAt: now }).where(eq(pipelineSecrets.id, existing.id)).run();
		else
			this.ctx.db
				.insert(pipelineSecrets)
				.values({
					id: newId('psec_'),
					orgId: repository.orgId,
					repositoryId: repository.id,
					environment,
					name: key,
					valueSealed: sealed,
					createdBy: principal.userId,
					createdAt: now,
					updatedAt: now,
				})
				.run();
		this.audit(principal, 'pipeline.secret.set', repository.id, { repository: name, name: key, environment: environment || null });
		return { name: key, environment: environment || null, updatedAt: new Date(now).toISOString() };
	}

	deleteSecret(principal: Principal, name: string, secretName: string, environment?: string | null): void {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:create', { type: 'pipelineRepository', id: repository.id });
		this.ctx.iam.require(principal, 'secret:delete', { type: 'pipelineRepository', id: repository.id });
		const removed = this.ctx.sqlite.run(
			'DELETE FROM pipeline_secrets WHERE repository_id = ? AND environment = ? AND name = ?',
			[repository.id, environment ?? '', secretName],
		);
		if (removed.changes === 0) throw new NotFoundError('Secret');
		this.audit(principal, 'pipeline.secret.delete', repository.id, { repository: name, name: secretName, environment: environment ?? null });
	}

	listVariables(principal: Principal, name: string): PipelineVariableView[] {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:read', { type: 'pipelineRepository', id: repository.id });
		return this.ctx.db
			.select()
			.from(pipelineVariables)
			.where(eq(pipelineVariables.repositoryId, repository.id))
			.orderBy(asc(pipelineVariables.name))
			.all()
			.map((row) => ({ name: row.name, value: row.value, updatedAt: new Date(row.updatedAt).toISOString() }));
	}

	setVariable(principal: Principal, name: string, variable: string, value: string): PipelineVariableView {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:create', { type: 'pipelineRepository', id: repository.id });
		const key = pipelineSecretNameSchema.parse(variable);
		const parsed = pipelineVariableSetSchema.parse({ value });
		const now = this.ctx.now();
		this.ctx.db
			.insert(pipelineVariables)
			.values({ repositoryId: repository.id, name: key, value: parsed.value, updatedAt: now })
			.onConflictDoUpdate({
				target: [pipelineVariables.repositoryId, pipelineVariables.name],
				set: { value: parsed.value, updatedAt: now },
			})
			.run();
		this.audit(principal, 'pipeline.variable.set', repository.id, { repository: name, name: key });
		return { name: key, value: parsed.value, updatedAt: new Date(now).toISOString() };
	}

	deleteVariable(principal: Principal, name: string, variable: string): void {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:create', { type: 'pipelineRepository', id: repository.id });
		const removed = this.ctx.sqlite.run('DELETE FROM pipeline_variables WHERE repository_id = ? AND name = ?', [repository.id, variable]);
		if (removed.changes === 0) throw new NotFoundError('Variable');
		this.audit(principal, 'pipeline.variable.delete', repository.id, { repository: name, name: variable });
	}

	listEnvironments(principal: Principal, name: string): PipelineEnvironmentView[] {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:read', { type: 'pipelineRepository', id: repository.id });
		const secrets = this.ctx.db
			.select({ name: pipelineSecrets.name, environment: pipelineSecrets.environment })
			.from(pipelineSecrets)
			.where(eq(pipelineSecrets.repositoryId, repository.id))
			.all();
		return this.ctx.db
			.select()
			.from(pipelineEnvironments)
			.where(eq(pipelineEnvironments.repositoryId, repository.id))
			.orderBy(asc(pipelineEnvironments.name))
			.all()
			.map((row) => ({
				name: row.name,
				allowedRefs: parse<string[]>(row.allowedRefsJson, []),
				requireApproval: row.requireApproval,
				secretNames: secrets.filter((s) => s.environment === row.name).map((s) => s.name),
				updatedAt: new Date(row.updatedAt).toISOString(),
			}));
	}

	setEnvironment(principal: Principal, name: string, environment: string, input: PipelineEnvironmentSet): PipelineEnvironmentView {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:create', { type: 'pipelineRepository', id: repository.id });
		// Protection rules gate secrets and deploys; loosening them needs `pipeline:manage`.
		if (!this.ctx.iam.can(principal, 'pipeline:manage', { type: 'pipelineRepository', id: repository.id }))
			throw new CoreError('forbidden', 'Only org owners and admins can change environment rules.', 403);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(environment)) throw new ValidationError('Invalid environment name.');
		const parsed = pipelineEnvironmentSetSchema.parse(input);
		const now = this.ctx.now();
		this.ctx.db
			.insert(pipelineEnvironments)
			.values({
				id: newId('penv_'),
				repositoryId: repository.id,
				name: environment,
				allowedRefsJson: JSON.stringify(parsed.allowedRefs),
				requireApproval: parsed.requireApproval,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [pipelineEnvironments.repositoryId, pipelineEnvironments.name],
				set: { allowedRefsJson: JSON.stringify(parsed.allowedRefs), requireApproval: parsed.requireApproval, updatedAt: now },
			})
			.run();
		this.audit(principal, 'pipeline.environment.set', repository.id, { repository: name, environment, ...parsed });
		return this.listEnvironments(principal, name).find((env) => env.name === environment)!;
	}

	deleteEnvironment(principal: Principal, name: string, environment: string): void {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:create', { type: 'pipelineRepository', id: repository.id });
		if (!this.ctx.iam.can(principal, 'pipeline:manage', { type: 'pipelineRepository', id: repository.id }))
			throw new CoreError('forbidden', 'Only org owners and admins can change environment rules.', 403);
		this.ctx.db.transaction(() => {
			this.ctx.db
				.delete(pipelineEnvironments)
				.where(and(eq(pipelineEnvironments.repositoryId, repository.id), eq(pipelineEnvironments.name, environment)))
				.run();
			this.ctx.db
				.delete(pipelineSecrets)
				.where(and(eq(pipelineSecrets.repositoryId, repository.id), eq(pipelineSecrets.environment, environment)))
				.run();
		});
		this.audit(principal, 'pipeline.environment.delete', repository.id, { repository: name, environment });
	}

	listProjectLinks(principal: Principal, name: string): PipelineProjectLinkView[] {
		const repository = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'build:read', { type: 'pipelineRepository', id: repository.id });
		const links = this.ctx.db.select().from(pipelineProjectLinks).where(eq(pipelineProjectLinks.repositoryId, repository.id)).all();
		if (!links.length) return [];
		const rows = new Map(
			this.ctx.db
				.select()
				.from(projects)
				.where(inArray(projects.id, links.map((link) => link.projectId)))
				.all()
				.map((row) => [row.id, row]),
		);
		return links.flatMap((link) => {
			const project = rows.get(link.projectId);
			if (!project || project.deletedAt) return [];
			return [
				{
					projectSlug: project.slug,
					projectName: project.name,
					runtime: project.runtime,
					environment: link.environment,
					createdAt: new Date(link.createdAt).toISOString(),
				},
			];
		});
	}

	/** Allow this repository's trusted jobs to deploy to a project (§4.4). */
	linkProject(principal: Principal, name: string, slug: string, input: PipelineProjectLink): PipelineProjectLinkView {
		const repository = this.requireRepository(principal, name);
		const project = this.ctx.projects.requireRow(principal, slug);
		this.ctx.iam.require(principal, 'build:create', { type: 'pipelineRepository', id: repository.id });
		this.ctx.iam.require(principal, 'deployment:promote', { type: 'project', id: project.id });
		const parsed = pipelineProjectLinkSchema.parse(input);
		const now = this.ctx.now();
		this.ctx.db
			.insert(pipelineProjectLinks)
			.values({ repositoryId: repository.id, projectId: project.id, environment: parsed.environment, createdBy: principal.userId, createdAt: now })
			.onConflictDoUpdate({
				target: [pipelineProjectLinks.repositoryId, pipelineProjectLinks.projectId],
				set: { environment: parsed.environment },
			})
			.run();
		this.audit(principal, 'pipeline.project.link', repository.id, { repository: name, project: slug, environment: parsed.environment });
		return {
			projectSlug: project.slug,
			projectName: project.name,
			runtime: project.runtime,
			environment: parsed.environment,
			createdAt: new Date(now).toISOString(),
		};
	}

	unlinkProject(principal: Principal, name: string, slug: string): void {
		const repository = this.requireRepository(principal, name);
		const project = this.ctx.projects.requireRow(principal, slug);
		this.ctx.iam.require(principal, 'build:create', { type: 'pipelineRepository', id: repository.id });
		this.ctx.db
			.delete(pipelineProjectLinks)
			.where(and(eq(pipelineProjectLinks.repositoryId, repository.id), eq(pipelineProjectLinks.projectId, project.id)))
			.run();
		this.audit(principal, 'pipeline.project.unlink', repository.id, { repository: name, project: slug });
	}

	// --- helpers --------------------------------------------------------------------------

	private audit(principal: Principal, action: string, resourceId: string, args: Record<string, unknown>): void {
		this.ctx.audit.record({ principal, action, resource: 'build', resourceId, args, result: 'ok' });
	}
}
