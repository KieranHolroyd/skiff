import { and, eq, gt, ne } from 'drizzle-orm';
import {
	blueprints as blueprintStacks,
	brokerAttachments,
	databaseAttachments,
	domains,
	projects,
	slugRedirects,
	storageAttachments,
	storageBuckets,
	workloads,
} from '@skiff/db';
import {
	BLUEPRINT_MAX_BYTES,
	attachmentTarget,
	blueprintApplyRequestSchema,
	blueprintPlanRequestSchema,
	blueprintSchema,
	brokerCreateSchema,
	brokerEngineRegistry,
	brokerUpgradeVersions,
	checkSlug,
	databaseCreateSchema,
	databaseEngineRegistry,
	databaseVariantSupported,
	defaultAttachmentPrefix,
	hasPermission,
	isTerminalOperation,
	operationActions,
	projectCreateSchema,
	storageCreateSchema,
	workloadSpecSchema,
	type Blueprint,
	type BlueprintApplyView,
	type BlueprintAttachment,
	type BlueprintChange,
	type BlueprintPlanAction,
	type BlueprintPlanView,
	type BlueprintResourceKind,
	type BlueprintStackView,
	type ItemStatus,
	type OperationStatus,
	type Permission,
	type Principal,
	type StorageGrant,
	type WorkloadSpec,
} from '@skiff/contracts';
import type { BrokerRow } from './brokers.ts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import type { DatabaseRow } from './databases.ts';
import { ConflictError, CoreError, ForbiddenError, NotFoundError, ValidationError } from './errors.ts';
import type { ActionDefinition, ItemResult, OperationParams, RunContext, StoredItem } from './operations/types.ts';
import type { ProjectRow } from './projects.ts';
import { effectiveRuntime } from './runtime-tier.ts';
import type { StorageRow } from './storage-instances.ts';
import { isPostgresMajorChange } from './upgrade-plan.ts';
import { newId, parseJson, sha256Hex } from './util.ts';

/**
 * Blueprints (plan 11, docs/OPERATIONS.md §12): one declarative file describes a stack, `plan`
 * diffs it against live state, and `apply` runs that diff as one `blueprint.apply` operation
 * through the normal services, so permissions, quotas and audit entries are exactly what the same
 * clicks in the dashboard produce.
 *
 * A plan is a list of resource steps in dependency order (projects → environments → databases →
 * storage → buckets → brokers → workload settings → domains → attachments, then deletes in reverse
 * when pruning). Every step converges one resource: at apply time it re-reads live state and
 * changes only what still differs, so a second apply of the same file is a no-op. The first
 * failure stops the run; later steps are skipped and nothing is rolled back.
 */

const MiB = 1024 * 1024;
const PLAN_WAIT_MS = 10_000;

/** One resource step in a plan (an operation item's `data`). */
export interface BlueprintStep {
	key: string;
	kind: BlueprintResourceKind;
	action: BlueprintPlanAction;
	changes: BlueprintChange[];
	reason: string | null;
}

/** What a `blueprint.apply` operation stores (internal; never in an `OperationView`). */
export interface BlueprintOperationParams {
	stack: string;
	planHash: string;
	prune: boolean;
	document: Blueprint;
	documentHash: string;
	stackAction: 'create' | 'update' | 'noop';
	steps: BlueprintStep[];
	warnings: string[];
	generatedAt: string;
}

/** A plan problem; any one of them fails the plan before anything runs. */
interface Problem {
	path: string[];
	message: string;
}

interface Diff {
	steps: BlueprintStep[];
	warnings: string[];
	problems: Problem[];
	stack: StackRow | null;
}

type StackRow = typeof blueprintStacks.$inferSelect;

/** `validate` output: the normalised document, before any live state is read. */
export interface BlueprintValidation {
	stack: string;
	document: Blueprint;
	resources: { projects: number; databases: number; storage: number; buckets: number; brokers: number; attachments: number };
}

// ---------------------------------------------------------------- parsing

/** JSON when it looks like JSON, YAML otherwise. Size is capped before parsing. */
export function parseBlueprintText(text: string): unknown {
	if (new TextEncoder().encode(text).length > BLUEPRINT_MAX_BYTES)
		throw new ValidationError(`A blueprint is at most ${BLUEPRINT_MAX_BYTES / 1024} KB.`);
	const trimmed = text.trim();
	if (!trimmed) throw new ValidationError('The blueprint is empty.');
	const json = trimmed.startsWith('{');
	try {
		return json ? JSON.parse(trimmed) : Bun.YAML.parse(text);
	} catch (error) {
		const message = `The blueprint is not valid ${json ? 'JSON' : 'YAML'}: ${(error as Error).message}`;
		throw new ValidationError(message, [{ path: [], message }]);
	}
}

/**
 * Parse and validate a blueprint (text or an already-parsed object). Unknown fields and broken
 * cross references fail here with their exact path, before any live state is read.
 */
export function parseBlueprint(document: string | Record<string, unknown>): Blueprint {
	const raw = typeof document === 'string' ? parseBlueprintText(document) : document;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		throw new ValidationError('A blueprint is one mapping with `apiVersion: skiff/v1` and a `name` at the top.');
	const parsed = blueprintSchema.safeParse(coerceVersions(raw as Record<string, unknown>));
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }));
		const first = issues[0]!;
		throw new ValidationError(
			`The blueprint has ${issues.length} problem${issues.length === 1 ? '' : 's'}. ${first.path.length ? `${first.path.join('.')}: ` : ''}${first.message}`,
			issues,
		);
	}
	return parsed.data;
}

/** YAML reads `version: 18` as a number; versions are strings everywhere else. */
function coerceVersions(raw: Record<string, unknown>): Record<string, unknown> {
	const out = { ...raw };
	for (const section of ['databases', 'brokers'] as const) {
		const entries = out[section];
		if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
		out[section] = Object.fromEntries(
			Object.entries(entries as Record<string, unknown>).map(([name, value]) => {
				if (!value || typeof value !== 'object' || Array.isArray(value)) return [name, value];
				const record = value as Record<string, unknown>;
				return [name, typeof record.version === 'number' ? { ...record, version: String(record.version) } : record];
			}),
		);
	}
	return out;
}

// ---------------------------------------------------------------- hashing and rendering

/** JSON with sorted keys, so equal values hash equally. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object')
		return `{${Object.keys(value as Record<string, unknown>)
			.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(',')}}`;
	return JSON.stringify(value ?? null);
}

export function blueprintDocumentHash(document: Blueprint): string {
	return sha256Hex(canonical(document));
}

/** Stable for the same document, prune flag and live state; apply refuses when it moved. */
export function blueprintPlanHash(input: { stack: string; prune: boolean; documentHash: string; steps: BlueprintStep[] }): string {
	return sha256Hex(
		canonical({
			v: 1,
			stack: input.stack,
			prune: input.prune,
			document: input.documentHash,
			steps: input.steps.map((step) => [step.key, step.kind, step.action, step.changes]),
		}),
	);
}

function render(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	const text = typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : JSON.stringify(value);
	return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

const same = (a: unknown, b: unknown): boolean => canonical(a ?? null) === canonical(b ?? null);

/** Record a change when the file sets a value that differs from live. */
function change(changes: BlueprintChange[], path: string, from: unknown, to: unknown): void {
	if (to === undefined || same(from, to)) return;
	changes.push({ path, from: render(from), to: render(to) });
}

const sortedGrants = (grants: StorageGrant[]): StorageGrant[] =>
	[...grants].sort((a, b) => a.bucket.localeCompare(b.bucket)).map((grant) => ({ bucket: grant.bucket, mode: grant.mode }));

const grantsText = (grants: StorageGrant[]): string => sortedGrants(grants).map((grant) => `${grant.bucket}:${grant.mode}`).join(', ');

const PERMISSION_LABEL: Record<'database' | 'storage' | 'broker', 'database:update' | 'storage:update' | 'broker:update'> = {
	database: 'database:update',
	storage: 'storage:update',
	broker: 'broker:update',
};

/** Delete order when pruning: children before parents (the reverse of create order). */
const DELETE_ORDER: BlueprintResourceKind[] = ['attachment', 'domain', 'environment', 'bucket', 'broker', 'storage', 'database', 'project'];

interface ParsedKey {
	kind: BlueprintResourceKind;
	project?: string;
	name?: string;
	child?: string;
	type?: 'database' | 'storage' | 'broker';
}

/** Resource keys are dot-separated names; only hostnames contain dots, and they come last. */
export function parseResourceKey(key: string): ParsedKey | null {
	const parts = key.split('.');
	const [section, a, b, ...rest] = parts;
	if (section === 'projects' && a && parts.length === 2) return { kind: 'project', project: a };
	if (section === 'projects' && a && b === 'service' && parts.length === 3) return { kind: 'service', project: a };
	if (section === 'projects' && a && b === 'environments' && rest.length === 1) return { kind: 'environment', project: a, child: rest[0] };
	if (section === 'projects' && a && b === 'domains' && rest.length > 0) return { kind: 'domain', project: a, child: rest.join('.') };
	if (section === 'databases' && a && parts.length === 2) return { kind: 'database', name: a };
	if (section === 'brokers' && a && parts.length === 2) return { kind: 'broker', name: a };
	if (section === 'storage' && a && parts.length === 2) return { kind: 'storage', name: a };
	if (section === 'storage' && a && b === 'buckets' && rest.length === 1) return { kind: 'bucket', name: a, child: rest[0] };
	if (section === 'attachments' && a && (b === 'database' || b === 'storage' || b === 'broker') && rest.length === 1)
		return { kind: 'attachment', project: a, type: b, name: rest[0] };
	return null;
}

const keys = {
	project: (slug: string) => `projects.${slug}`,
	environment: (slug: string, env: string) => `projects.${slug}.environments.${env}`,
	service: (slug: string) => `projects.${slug}.service`,
	domain: (slug: string, host: string) => `projects.${slug}.domains.${host}`,
	database: (name: string) => `databases.${name}`,
	storage: (name: string) => `storage.${name}`,
	bucket: (storage: string, bucket: string) => `storage.${storage}.buckets.${bucket}`,
	broker: (name: string) => `brokers.${name}`,
	attachment: (attachment: BlueprintAttachment) => {
		const target = attachmentTarget(attachment);
		return `attachments.${attachment.project}.${target.type}.${target.name}`;
	},
};

const WORKLOAD_FIELDS = ['command', 'image', 'port', 'healthPath', 'memoryMb', 'cpus', 'replicas'] as const;

// ---------------------------------------------------------------- service

export class BlueprintService {
	constructor(private readonly ctx: CoreContext) {}

	// --- reads ------------------------------------------------------------------------

	/** Parse and check a document without reading live state. */
	validate(principal: Principal, document: string | Record<string, unknown>): BlueprintValidation {
		this.requireFeature();
		this.require(principal, 'project:read');
		const doc = parseBlueprint(document);
		return {
			stack: doc.name,
			document: doc,
			resources: {
				projects: Object.keys(doc.projects).length,
				databases: Object.keys(doc.databases).length,
				storage: Object.keys(doc.storage).length,
				buckets: Object.values(doc.storage).reduce((sum, storage) => sum + Object.keys(storage.buckets).length, 0),
				brokers: Object.keys(doc.brokers).length,
				attachments: doc.attachments.length,
			},
		};
	}

	list(principal: Principal): BlueprintStackView[] {
		this.requireFeature();
		this.require(principal, 'project:read');
		return this.ctx.db
			.select()
			.from(blueprintStacks)
			.where(eq(blueprintStacks.orgId, principal.orgId))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(stackView);
	}

	get(principal: Principal, name: string): BlueprintStackView {
		this.requireFeature();
		this.require(principal, 'project:read');
		const row = this.stackRow(principal.orgId, name);
		if (!row) throw new NotFoundError(`Blueprint stack "${name}"`);
		return stackView(row);
	}

	// --- plan ---------------------------------------------------------------------------

	/**
	 * Diff a document against live state and store the result as a planned `blueprint.apply`
	 * operation (it expires with the plan, after an hour). Never changes anything. Any problem
	 * (a missing permission or secret, an immutable field, a taken name) fails the whole plan.
	 */
	async plan(principal: Principal, raw: unknown): Promise<BlueprintPlanView> {
		this.requireFeature();
		this.require(principal, 'project:read');
		const input = blueprintPlanRequestSchema.parse(raw);
		if (input.prune && principal.credential === 'oauth')
			throw new CoreError('surface_not_allowed', 'Pruning a blueprint deletes resources; use the dashboard or CLI.', 403);
		const document = parseBlueprint(input.document);
		const diff = this.diff(principal, document, input.prune);
		failOnProblems(diff.problems);
		const documentHash = blueprintDocumentHash(document);
		const planHash = blueprintPlanHash({ stack: document.name, prune: input.prune, documentHash, steps: diff.steps });
		const params: BlueprintOperationParams = {
			stack: document.name,
			planHash,
			prune: input.prune,
			document,
			documentHash,
			stackAction: !diff.stack
				? 'create'
				: diff.steps.every((step) => step.action === 'noop') && diff.stack.documentHash === documentHash
					? 'noop'
					: 'update',
			steps: diff.steps,
			warnings: diff.warnings,
			generatedAt: new Date(this.ctx.now()).toISOString(),
		};
		const created = this.ctx.operations.create(
			principal,
			{ action: 'blueprint.apply', targets: [document.name], stage: 'plan' },
			{ internal: { blueprint: params } },
		);
		const planned = await this.ctx.operations.wait(principal, created.id, PLAN_WAIT_MS);
		return planViewOf(params, created.id, planned.planExpiresAt);
	}

	/** The caller's own plan with this hash that is still waiting to be applied, or null. */
	pendingPlan(principal: Principal, planHash: string): BlueprintPlanView | null {
		this.requireFeature();
		const row = this.ctx.sqlite
			.query<{ id: string; plan_expires_at: number | null }, [string, string, string, number]>(
				`SELECT id, plan_expires_at FROM operations
				 WHERE org_id = ? AND actor_id = ? AND action = 'blueprint.apply' AND status = 'planned'
				   AND json_extract(params_json, '$.blueprint.planHash') = ? AND plan_expires_at >= ?
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.get(principal.orgId, principal.userId, planHash, this.ctx.now());
		const params = row ? this.operationParams(row.id) : undefined;
		if (!row || !params) return null;
		return planViewOf(params, row.id, row.plan_expires_at ? new Date(row.plan_expires_at).toISOString() : null);
	}

	/**
	 * Apply a plan by its hash (the caller's own plan, within the hour). Live state is re-read and
	 * the plan hash recomputed first; a plan whose world moved is refused. A pruning plan also needs
	 * the stack name typed back. Submitting the same hash again returns the run already started.
	 */
	apply(principal: Principal, raw: unknown): BlueprintApplyView {
		this.requireFeature();
		const input = blueprintApplyRequestSchema.parse(raw);
		const rows = this.ctx.sqlite
			.query<{ id: string; status: OperationStatus }, [string, string, string]>(
				`SELECT id, status FROM operations
				 WHERE org_id = ? AND actor_id = ? AND action = 'blueprint.apply'
				   AND json_extract(params_json, '$.blueprint.planHash') = ?
				 ORDER BY created_at DESC`,
			)
			.all(principal.orgId, principal.userId, input.planHash);
		const planned = rows.find((row) => row.status === 'planned');
		if (!planned) {
			const started = rows.find((row) => row.status === 'applying' || isTerminalOperation(row.status));
			if (started && started.status !== 'expired' && started.status !== 'cancelled') return this.applyView(principal, started.id);
			if (started)
				throw new ConflictError(
					started.status === 'expired' ? 'This plan has expired. Plan the blueprint again.' : 'This plan was cancelled. Plan the blueprint again.',
				);
			throw new NotFoundError('A blueprint plan with that hash (plan it first; plans last an hour and only their author can apply them)');
		}
		this.ctx.operations.apply(principal, planned.id, { ...(input.confirm !== undefined ? { confirm: input.confirm } : {}) });
		// Identical plans of the same state are superseded, so submitting the hash again returns this run.
		for (const sibling of rows) if (sibling.id !== planned.id && sibling.status === 'planned') this.ctx.operations.cancel(principal, sibling.id);
		return this.applyView(principal, planned.id);
	}

	/** Progress and per-resource results of a `blueprint.apply` operation. */
	applyView(principal: Principal, operationId: string): BlueprintApplyView {
		const operation = this.ctx.operations.get(principal, operationId);
		if (operation.action !== 'blueprint.apply') throw new NotFoundError('Blueprint operation');
		const params = this.operationParams(operationId);
		const items = this.ctx.sqlite
			.query<
				{ target_kind: string; target_id: string; status: ItemStatus; reason: string | null; error: string | null; data_json: string | null },
				[string]
			>('SELECT target_kind, target_id, status, reason, error, data_json FROM operation_items WHERE operation_id = ? ORDER BY seq')
			.all(operationId);
		const failed = items.find((item) => item.status === 'failed');
		return {
			operationId,
			planHash: params?.planHash ?? '0'.repeat(64),
			stack: params?.stack ?? operation.params.targets?.[0] ?? '',
			status: operation.status,
			done: operation.done,
			total: operation.total,
			resources: items.map((item) => ({
				key: item.target_id,
				kind: item.target_kind as BlueprintResourceKind,
				action: parseJson<{ action?: BlueprintPlanAction }>(item.data_json, {}).action ?? 'noop',
				status: item.status,
				reason: item.reason,
				error: item.error,
			})),
			error: failed ? `${failed.target_id}: ${failed.error ?? 'failed'}` : operation.status === 'failed' ? operation.phase : null,
			appliedAt: operation.status === 'succeeded' ? operation.finishedAt : null,
		};
	}

	/** Apply, then wait (bounded) for the run to settle; MCP and the CLI's `--wait` use it. */
	async applyAndWait(principal: Principal, raw: unknown, timeoutMs: number): Promise<BlueprintApplyView> {
		const started = this.apply(principal, raw);
		if (isTerminalOperation(started.status)) return started;
		await this.ctx.operations.wait(principal, started.operationId, timeoutMs);
		return this.applyView(principal, started.operationId);
	}

	// --- diff ---------------------------------------------------------------------------

	/** Every step the document needs against live state, plus problems and warnings. Read-only. */
	diff(principal: Principal, doc: Blueprint, prune: boolean): Diff {
		const steps: BlueprintStep[] = [];
		const problems: Problem[] = [];
		const warnings: string[] = [];
		const stack = this.stackRow(principal.orgId, doc.name) ?? null;
		const managed = new Set(parseJson<string[]>(stack?.managedJson, []));
		const push = (step: Omit<BlueprintStep, 'reason'> & { reason?: string | null }, permissions: Permission[]) => {
			const adopted = step.action !== 'create' && !managed.has(step.key);
			const reason =
				step.reason ?? (step.action === 'noop' ? (adopted ? 'exists; this stack adopts it' : 'up to date') : adopted ? 'exists; this stack adopts it' : null);
			steps.push({ ...step, reason });
			if (step.action === 'noop') return;
			for (const permission of permissions)
				if (!hasPermission(principal, permission))
					problems.push({ path: [step.key], message: `Needs the ${permission} permission.` });
		};
		const fail = (key: string, message: string) => problems.push({ path: [key], message });

		if (Object.keys(doc.brokers).length > 0 && !featureEnabled(this.ctx.config, 'BROKERS'))
			fail('brokers', 'Queue brokers are not enabled on this platform (SKIFF_FEATURE_BROKERS).');

		// projects, then their environments
		for (const [slug, project] of Object.entries(doc.projects)) {
			const key = keys.project(slug);
			const result = this.projectDiff(principal, slug, project);
			for (const message of result.problems) fail(key, message);
			push({ key, kind: 'project', action: result.action, changes: result.changes }, [
				result.action === 'create' ? 'project:create' : 'project:update',
			]);
			for (const [env, environment] of Object.entries(project.environments)) {
				const envKey = keys.environment(slug, env);
				const live = result.row ? this.ctx.environments.rows(result.row.id).find((row) => row.slug === env) : undefined;
				const changes: BlueprintChange[] = [];
				if (!live) {
					changes.push({ path: 'access', from: null, to: environment.access ?? `inherits previews (${project.access?.previews ?? result.row?.previewAccess ?? 'platform'})` });
					push({ key: envKey, kind: 'environment', action: 'create', changes }, ['project:update']);
				} else {
					change(changes, 'access', live.access, environment.access);
					push({ key: envKey, kind: 'environment', action: changes.length ? 'update' : 'noop', changes }, ['project:update']);
				}
			}
		}

		for (const [name, database] of Object.entries(doc.databases)) {
			const key = keys.database(name);
			const result = this.databaseDiff(principal, name, database);
			for (const message of result.problems) fail(key, message);
			push({ key, kind: 'database', action: result.action, changes: result.changes }, [
				result.action === 'create' ? 'database:create' : 'database:update',
			]);
		}

		for (const [name, storage] of Object.entries(doc.storage)) {
			const key = keys.storage(name);
			const result = this.storageDiff(principal, name, storage);
			for (const message of result.problems) fail(key, message);
			push({ key, kind: 'storage', action: result.action, changes: result.changes }, [
				result.action === 'create' ? 'storage:create' : 'storage:update',
			]);
		}
		for (const [name, storage] of Object.entries(doc.storage))
			for (const [bucket, config] of Object.entries(storage.buckets)) {
				const key = keys.bucket(name, bucket);
				const result = this.bucketDiff(principal, name, bucket, config);
				for (const message of result.problems) fail(key, message);
				push({ key, kind: 'bucket', action: result.action, changes: result.changes }, ['storage:update']);
			}

		for (const [name, broker] of Object.entries(doc.brokers)) {
			const key = keys.broker(name);
			const result = this.brokerDiff(principal, name, broker);
			for (const message of result.problems) fail(key, message);
			push({ key, kind: 'broker', action: result.action, changes: result.changes }, [
				result.action === 'create' ? 'broker:create' : 'broker:update',
			]);
		}

		for (const [slug, project] of Object.entries(doc.projects)) {
			if (!WORKLOAD_FIELDS.some((field) => project[field] !== undefined) && !project.env && !project.secrets) continue;
			const key = keys.service(slug);
			const result = this.serviceDiff(principal, slug, project);
			for (const message of result.problems) fail(key, message);
			push({ key, kind: 'service', action: result.action, changes: result.changes }, ['project:update']);
		}

		for (const [slug, project] of Object.entries(doc.projects))
			for (const host of project.domains) {
				const key = keys.domain(slug, host);
				const result = this.domainDiff(principal, slug, host);
				for (const message of result.problems) fail(key, message);
				push({ key, kind: 'domain', action: result.action, changes: result.changes }, ['domain:create']);
			}

		for (const attachment of doc.attachments) {
			const key = keys.attachment(attachment);
			const target = attachmentTarget(attachment);
			const result = this.attachmentDiff(principal, doc, attachment);
			for (const message of result.problems) fail(key, message);
			push({ key, kind: 'attachment', action: result.action, changes: result.changes, reason: result.reason }, [
				PERMISSION_LABEL[target.type],
				'project:update',
			]);
		}

		// Managed resources the file no longer lists: deleted with prune, kept (and warned) without.
		const wanted = new Set(steps.map((step) => step.key));
		const orphans = [...managed]
			.filter((key) => !wanted.has(key))
			.map((key) => ({ key, parsed: parseResourceKey(key) }))
			.filter((entry): entry is { key: string; parsed: ParsedKey } => entry.parsed !== null && entry.parsed.kind !== 'service')
			.filter((entry) => this.exists(principal, entry.parsed))
			.sort(
				(a, b) =>
					DELETE_ORDER.indexOf(a.parsed.kind) - DELETE_ORDER.indexOf(b.parsed.kind) || a.key.localeCompare(b.key),
			);
		const deletedProjects = new Set(orphans.filter((entry) => entry.parsed.kind === 'project').map((entry) => entry.parsed.project));
		const deletedStorage = new Set(orphans.filter((entry) => entry.parsed.kind === 'storage').map((entry) => entry.parsed.name));
		const detached = new Set(orphans.filter((entry) => entry.parsed.kind === 'attachment').map((entry) => entry.key));
		for (const { key, parsed } of orphans) {
			if (!prune) {
				warnings.push(`${key} is no longer in the file. It is kept; plan with prune to delete it.`);
				continue;
			}
			// A project's environments and domains go with it (to the trash); a storage's buckets likewise.
			if ((parsed.kind === 'environment' || parsed.kind === 'domain') && deletedProjects.has(parsed.project)) continue;
			if (parsed.kind === 'bucket' && deletedStorage.has(parsed.name)) continue;
			const problem = this.deleteProblem(principal, parsed, detached);
			if (problem) fail(key, problem);
			push(
				{ key, kind: parsed.kind, action: 'delete', changes: [], reason: deleteReason(parsed) },
				deletePermissions(parsed),
			);
		}
		return { steps, warnings, problems, stack };
	}

	// --- per-resource diffs (shared by plan and apply) -----------------------------------

	private projectDiff(principal: Principal, slug: string, project: Blueprint['projects'][string]) {
		const row = this.projectRow(principal.orgId, slug);
		const problems: string[] = [];
		const changes: BlueprintChange[] = [];
		const patch: { name?: string; placement?: string; productionAccess?: 'public' | 'platform'; previewAccess?: 'public' | 'platform' } = {};
		if (row?.deletedAt) problems.push(`Project "${slug}" is in the trash. Restore it, or remove it from the file.`);
		if (!row) {
			const check = checkSlug(slug, this.slugTakenElsewhere(principal.orgId, slug) ? [slug] : []);
			if (!check.ok) problems.push(check.reason ?? `"${slug}" cannot be used.`);
			if (project.runtime === 'function' && !featureEnabled(this.ctx.config, 'FUNCTIONS'))
				problems.push('Functions are not enabled on this platform (SKIFF_FEATURE_FUNCTIONS).');
			changes.push({ path: 'runtime', from: null, to: project.runtime });
			change(changes, 'name', null, project.name ?? slug);
			change(changes, 'placement', null, project.placement ?? 'edge');
			change(changes, 'access.production', null, project.access?.production ?? 'public');
			change(changes, 'access.previews', null, project.access?.previews ?? 'platform');
			return { row: null, action: 'create' as const, changes, problems, patch };
		}
		const runtime = effectiveRuntime(row);
		if (runtime !== project.runtime)
			problems.push(`The runtime is fixed for a project's life (it is ${runtime}, the file says ${project.runtime}). Create a new project instead.`);
		const set = <K extends keyof typeof patch>(field: K, path: string, live: unknown, value: (typeof patch)[K] | undefined) => {
			if (value === undefined || same(live, value)) return;
			patch[field] = value;
			change(changes, path, live, value);
		};
		set('name', 'name', row.name, project.name);
		set('placement', 'placement', row.placement, project.placement);
		set('productionAccess', 'access.production', row.productionAccess, project.access?.production);
		set('previewAccess', 'access.previews', row.previewAccess, project.access?.previews);
		return { row, action: changes.length ? ('update' as const) : ('noop' as const), changes, problems, patch };
	}

	private databaseDiff(principal: Principal, name: string, database: Blueprint['databases'][string]) {
		const row = this.maybe(() => this.ctx.databases.requireRow(principal, name, { includeDeleted: true }));
		const info = databaseEngineRegistry[database.engine];
		const problems: string[] = [];
		const changes: BlueprintChange[] = [];
		const patch: { version?: string; memoryMb?: number; cpus?: number; storageMb?: number; extensions?: string[]; pooler?: boolean } = {};
		if (!row) {
			const version = database.version ?? info.defaultVersion;
			const variant = database.variant ?? 'standard';
			if (!databaseVariantSupported(database.engine, version, variant))
				problems.push(`The ${variant} variant has no ${info.label} ${version} image.`);
			const parsed = databaseCreateSchema.safeParse(this.databaseCreateInput(name, database));
			if (!parsed.success) for (const issue of parsed.error.issues) problems.push(issue.message);
			changes.push({ path: 'engine', from: null, to: database.engine });
			changes.push({ path: 'version', from: null, to: version });
			if (variant !== 'standard') changes.push({ path: 'variant', from: null, to: variant });
			change(changes, 'memoryMb', null, database.memoryMb);
			change(changes, 'cpus', null, database.cpus);
			change(changes, 'storageMb', null, database.storageMb);
			if (database.extensions?.length) change(changes, 'extensions', null, database.extensions);
			change(changes, 'pooler', null, database.pooler);
			return { row: null, action: 'create' as const, changes, problems, patch };
		}
		if (row.deletedAt) problems.push(`Database "${name}" is in the trash. Restore it, or remove it from the file.`);
		if (row.engine !== database.engine)
			problems.push(`The engine is fixed for a database's life (it is ${row.engine}, the file says ${database.engine}).`);
		if (database.variant !== undefined && database.variant !== row.variant)
			problems.push(`The image variant is fixed for a database's life (it is ${row.variant}, the file says ${database.variant}).`);
		const live = databaseEngineRegistry[row.engine] ?? info;
		if (database.version !== undefined && database.version !== row.version && row.engine === database.engine) {
			if (row.engine === 'postgres' && isPostgresMajorChange(row.version, database.version))
				problems.push(
					`PostgreSQL ${row.version} → ${database.version} is a major-version upgrade. Run \`skif db upgrade ${name} --to ${database.version} --plan\` first; a blueprint never switches a major.`,
				);
			else if (row.engine !== 'postgres') {
				const forward = live.versions.indexOf(database.version) < live.versions.indexOf(row.version);
				if (live.inPlaceUpgrade === 'never' || !forward)
					problems.push(
						forward
							? `${live.label} ${row.version} → ${database.version} cannot be changed in place.`
							: `${live.label} cannot be downgraded in place (${row.version} → ${database.version}).`,
					);
			}
			patch.version = database.version;
			change(changes, 'version', row.version, database.version);
		}
		for (const field of ['memoryMb', 'cpus', 'storageMb'] as const) {
			const value = database[field];
			if (value === undefined || value === row[field]) continue;
			patch[field] = value;
			change(changes, field, row[field], value);
		}
		if (database.extensions) {
			const current = parseJson<string[]>(row.extensionsJson, []);
			// Adding only: removing one from the file never drops it from the database.
			const missing = database.extensions.filter((extension) => !current.includes(extension));
			if (missing.length) {
				patch.extensions = [...current, ...missing];
				change(changes, 'extensions', current, patch.extensions);
			}
		}
		if (database.pooler !== undefined && database.pooler !== row.poolerEnabled) {
			patch.pooler = database.pooler;
			change(changes, 'pooler', row.poolerEnabled, database.pooler);
		}
		return { row, action: changes.length ? ('update' as const) : ('noop' as const), changes, problems, patch };
	}

	private databaseCreateInput(name: string, database: Blueprint['databases'][string], placement?: string) {
		return {
			name,
			engine: database.engine,
			...(database.version !== undefined ? { version: database.version } : {}),
			...(database.variant !== undefined ? { variant: database.variant } : {}),
			...(database.memoryMb !== undefined ? { memoryMb: database.memoryMb } : {}),
			...(database.cpus !== undefined ? { cpus: database.cpus } : {}),
			...(database.storageMb !== undefined ? { storageMb: database.storageMb } : {}),
			...(database.extensions !== undefined ? { extensions: database.extensions } : {}),
			...(database.pooler !== undefined ? { pooler: database.pooler } : {}),
			...(placement ? { placement } : {}),
		};
	}

	private storageDiff(principal: Principal, name: string, storage: Blueprint['storage'][string]) {
		const row = this.maybe(() => this.ctx.storage.requireRow(principal, name, { includeDeleted: true }));
		const problems: string[] = [];
		const changes: BlueprintChange[] = [];
		const patch: { public?: boolean; memoryMb?: number; cpus?: number; storageMb?: number } = {};
		if (!row) {
			const parsed = storageCreateSchema.safeParse(this.storageCreateInput(name, storage));
			if (!parsed.success) for (const issue of parsed.error.issues) problems.push(issue.message);
			change(changes, 'public', null, storage.public ?? false);
			change(changes, 'memoryMb', null, storage.memoryMb);
			change(changes, 'cpus', null, storage.cpus);
			change(changes, 'storageMb', null, storage.storageMb);
			return { row: null, action: 'create' as const, changes, problems, patch };
		}
		if (row.deletedAt) problems.push(`Storage "${name}" is in the trash. Restore it, or remove it from the file.`);
		for (const field of ['public', 'memoryMb', 'cpus', 'storageMb'] as const) {
			const value = storage[field];
			if (value === undefined || value === row[field]) continue;
			(patch as Record<string, unknown>)[field] = value;
			change(changes, field, row[field], value);
		}
		return { row, action: changes.length ? ('update' as const) : ('noop' as const), changes, problems, patch };
	}

	private storageCreateInput(name: string, storage: Blueprint['storage'][string], placement?: string) {
		return {
			name,
			...(storage.public !== undefined ? { public: storage.public } : {}),
			...(storage.memoryMb !== undefined ? { memoryMb: storage.memoryMb } : {}),
			...(storage.cpus !== undefined ? { cpus: storage.cpus } : {}),
			...(storage.storageMb !== undefined ? { storageMb: storage.storageMb } : {}),
			...(placement ? { placement } : {}),
		};
	}

	private bucketDiff(principal: Principal, storageName: string, bucket: string, config: Blueprint['storage'][string]['buckets'][string]) {
		const storage = this.maybe(() => this.ctx.storage.requireRow(principal, storageName, { includeDeleted: true }));
		const live = storage ? this.bucketRow(storage.id, bucket) : undefined;
		const problems: string[] = [];
		const changes: BlueprintChange[] = [];
		const quotaBytes = config.quotaMb === undefined ? undefined : config.quotaMb === null ? null : config.quotaMb * MiB;
		const patch: { access?: 'private' | 'public-read'; versioning?: boolean; quotaBytes?: number | null } = {};
		const needsFlag = config.versioning === true || (quotaBytes !== undefined && quotaBytes !== null);
		if (needsFlag && !featureEnabled(this.ctx.config, 'OBJECT_BROWSER') && (!live || live.versioning !== config.versioning || live.quotaBytes !== quotaBytes))
			problems.push('Bucket versioning and quotas need the OBJECT_BROWSER feature (SKIFF_FEATURE_OBJECT_BROWSER).');
		if (live?.deleteRequestedAt && !live.deleteBlocked)
			problems.push(`Bucket "${bucket}" is being deleted. Plan again once it is gone.`);
		if (!live || (live.deleteRequestedAt && live.deleteBlocked)) {
			change(changes, 'access', null, config.access ?? 'private');
			change(changes, 'versioning', null, config.versioning);
			change(changes, 'quotaMb', null, config.quotaMb);
			return { live: null, action: 'create' as const, changes, problems, patch };
		}
		if (config.access !== undefined && config.access !== live.access) {
			patch.access = config.access;
			change(changes, 'access', live.access, config.access);
		}
		if (config.versioning !== undefined && config.versioning !== live.versioning) {
			patch.versioning = config.versioning;
			change(changes, 'versioning', live.versioning, config.versioning);
		}
		if (quotaBytes !== undefined && quotaBytes !== live.quotaBytes) {
			patch.quotaBytes = quotaBytes;
			change(changes, 'quotaMb', live.quotaBytes === null ? null : Math.round(live.quotaBytes / MiB), config.quotaMb);
		}
		return { live, action: changes.length ? ('update' as const) : ('noop' as const), changes, problems, patch };
	}

	private brokerDiff(principal: Principal, name: string, broker: Blueprint['brokers'][string]) {
		const row = this.maybe(() => this.ctx.brokers.requireRow(principal, name, { includeDeleted: true }));
		const info = brokerEngineRegistry[broker.engine];
		const problems: string[] = [];
		const changes: BlueprintChange[] = [];
		const patch: { version?: string; memoryMb?: number; cpus?: number; storageMb?: number } = {};
		if (!row) {
			const parsed = brokerCreateSchema.safeParse(this.brokerCreateInput(name, broker));
			if (!parsed.success) for (const issue of parsed.error.issues) problems.push(issue.message);
			changes.push({ path: 'engine', from: null, to: broker.engine });
			changes.push({ path: 'version', from: null, to: broker.version ?? info.defaultVersion });
			change(changes, 'memoryMb', null, broker.memoryMb);
			change(changes, 'cpus', null, broker.cpus);
			change(changes, 'storageMb', null, broker.storageMb);
			return { row: null, action: 'create' as const, changes, problems, patch };
		}
		if (row.deletedAt) problems.push(`Broker "${name}" is in the trash. Restore it, or remove it from the file.`);
		if (row.engine !== broker.engine)
			problems.push(`The engine is fixed for a broker's life (it is ${row.engine}, the file says ${broker.engine}).`);
		if (broker.version !== undefined && broker.version !== row.version) {
			if (!brokerUpgradeVersions(row.engine, row.version).includes(broker.version))
				problems.push(`${info.label} cannot be downgraded in place (${row.version} → ${broker.version}).`);
			patch.version = broker.version;
			change(changes, 'version', row.version, broker.version);
		}
		for (const field of ['memoryMb', 'cpus', 'storageMb'] as const) {
			const value = broker[field];
			if (value === undefined || value === row[field]) continue;
			patch[field] = value;
			change(changes, field, row[field], value);
		}
		return { row, action: changes.length ? ('update' as const) : ('noop' as const), changes, problems, patch };
	}

	private brokerCreateInput(name: string, broker: Blueprint['brokers'][string], placement?: string) {
		return {
			name,
			engine: broker.engine,
			...(broker.version !== undefined ? { version: broker.version } : {}),
			...(broker.memoryMb !== undefined ? { memoryMb: broker.memoryMb } : {}),
			...(broker.cpus !== undefined ? { cpus: broker.cpus } : {}),
			...(broker.storageMb !== undefined ? { storageMb: broker.storageMb } : {}),
			...(placement ? { placement } : {}),
		};
	}

	/** Workload settings: only the fields the file sets are managed; the rest keep their value. */
	private serviceDiff(principal: Principal, slug: string, project: Blueprint['projects'][string]) {
		const row = this.projectRow(principal.orgId, slug);
		const problems: string[] = [];
		const changes: BlueprintChange[] = [];
		const runtime = project.runtime as 'process' | 'container';
		let current: WorkloadSpec | null = null;
		if (row && !row.deletedAt) {
			try {
				current = this.ctx.workloads.projectSpec(row);
			} catch {
				problems.push('The project has a stored workload spec this version cannot read; set it once in the dashboard.');
			}
		}
		const refs = project.secrets?.map(
			(name) => current?.secrets.find((ref) => ref.name === name) ?? { name, delivery: 'env' as const },
		);
		const next: Record<string, unknown> = { ...(current ?? {}), runtime };
		for (const field of WORKLOAD_FIELDS) if (project[field] !== undefined) next[field] = project[field];
		if (project.env) next.env = project.env;
		if (refs) next.secrets = refs;
		const parsed = workloadSpecSchema.safeParse(next);
		if (!parsed.success) for (const issue of parsed.error.issues) problems.push(`${issue.path.join('.') || 'workload'}: ${issue.message}`);
		if (runtime === 'container' && !(parsed.success ? parsed.data.image : project.image))
			problems.push('A container project needs an `image`.');
		for (const name of project.secrets ?? [])
			if (!this.ctx.secrets.resolve(principal.orgId, row?.id ?? null, name))
				problems.push(`Secret ${name} does not exist for this project or the organisation. Create it first; blueprints only hold secret names.`);
		for (const field of WORKLOAD_FIELDS) change(changes, field, current?.[field] ?? null, project[field]);
		if (project.env) {
			const before = current?.env ?? {};
			for (const name of [...new Set([...Object.keys(before), ...Object.keys(project.env)])].sort())
				if (!same(before[name], project.env[name])) changes.push({ path: `env.${name}`, from: render(before[name]), to: render(project.env[name]) });
		}
		if (project.secrets) {
			const before = (current?.secrets ?? []).map((ref) => ref.name).sort();
			const after = [...project.secrets].sort();
			if (!same(before, after)) changes.push({ path: 'secrets', from: before.length ? before.join(', ') : null, to: after.join(', ') || null });
		}
		const spec = parsed.success ? parsed.data : null;
		return { row, spec, action: changes.length ? (current ? ('update' as const) : ('create' as const)) : ('noop' as const), changes, problems };
	}

	private domainDiff(principal: Principal, slug: string, host: string) {
		const row = this.projectRow(principal.orgId, slug);
		const problems: string[] = [];
		const live = this.ctx.db.select().from(domains).where(eq(domains.hostname, host)).get();
		const platformHost = new URL(this.ctx.config.platformOrigin).hostname;
		const contentDomain = this.ctx.config.contentDomain;
		if (host === platformHost || host === contentDomain || host.endsWith(`.${contentDomain}`))
			problems.push(`"${host}" belongs to the platform and cannot be a custom domain.`);
		if (live && (!row || live.projectId !== row.id)) problems.push(`"${host}" is already attached to another project.`);
		if (live && row && live.projectId === row.id) return { live, action: 'noop' as const, changes: [], problems };
		return { live: null, action: 'create' as const, changes: [{ path: 'hostname', from: null, to: host }], problems };
	}

	private attachmentDiff(principal: Principal, doc: Blueprint, attachment: BlueprintAttachment) {
		const target = attachmentTarget(attachment);
		const prefix = attachment.prefix ?? defaultAttachmentPrefix(doc, target);
		const project = this.projectRow(principal.orgId, attachment.project);
		const live = project ? this.attachmentRow(principal, project.id, target) : null;
		const problems: string[] = [];
		const changes: BlueprintChange[] = [];
		const grants = attachment.grants ? sortedGrants(attachment.grants as StorageGrant[]) : [];
		if (project) {
			const clash = this.prefixOwner(project.id, target.type, prefix);
			if (clash && clash !== target.name)
				problems.push(`"${attachment.project}" already uses the env prefix ${prefix} for ${target.type} "${clash}". Set a different \`prefix\`.`);
		}
		if (!live) {
			changes.push({ path: 'prefix', from: null, to: prefix });
			if (target.type === 'storage') changes.push({ path: 'grants', from: null, to: grantsText(grants) });
			return { live: null, prefix, grants, action: 'create' as const, changes, problems, reason: null };
		}
		change(changes, 'prefix', live.envPrefix, prefix);
		const reason = changes.length
			? 'the env prefix changes: it is detached and attached again, so the app gets new variable names on its next activation'
			: null;
		if (target.type === 'storage' && live.grants && !same(sortedGrants(live.grants), grants))
			changes.push({ path: 'grants', from: grantsText(live.grants), to: grantsText(grants) });
		return { live, prefix, grants, action: changes.length ? ('update' as const) : ('noop' as const), changes, problems, reason };
	}

	private deleteProblem(principal: Principal, parsed: ParsedKey, detached: Set<string>): string | null {
		const outside = (type: 'database' | 'storage' | 'broker', id: string): string[] => {
			const rows =
				type === 'database'
					? this.ctx.db.select({ projectId: databaseAttachments.projectId }).from(databaseAttachments).where(eq(databaseAttachments.databaseId, id)).all()
					: type === 'storage'
						? this.ctx.db.select({ projectId: storageAttachments.projectId }).from(storageAttachments).where(eq(storageAttachments.storageId, id)).all()
						: this.ctx.db.select({ projectId: brokerAttachments.projectId }).from(brokerAttachments).where(eq(brokerAttachments.brokerId, id)).all();
			return rows
				.map((row) => this.projectSlugById(row.projectId) ?? row.projectId)
				.filter((slug) => !detached.has(`attachments.${slug}.${type}.${parsed.name}`));
		};
		if (parsed.kind === 'database' || parsed.kind === 'storage' || parsed.kind === 'broker') {
			const row =
				parsed.kind === 'database'
					? this.maybe(() => this.ctx.databases.requireRow(principal, parsed.name!))
					: parsed.kind === 'storage'
						? this.maybe(() => this.ctx.storage.requireRow(principal, parsed.name!))
						: this.maybe(() => this.ctx.brokers.requireRow(principal, parsed.name!));
			const users = row ? outside(parsed.kind, row.id) : [];
			if (users.length) return `It is still attached to ${users.join(', ')}, outside this plan. Detach it first.`;
		}
		if (parsed.kind === 'bucket') {
			const storage = this.maybe(() => this.ctx.storage.requireRow(principal, parsed.name!));
			const bucket = storage ? this.bucketRow(storage.id, parsed.child!) : undefined;
			if (bucket && (bucket.objects ?? 0) > 0)
				return `Bucket "${parsed.child}" holds ${bucket.objects} objects. Empty it first; a blueprint never deletes data in a bucket.`;
		}
		return null;
	}

	// --- apply steps --------------------------------------------------------------------

	/** Converge one resource to the document (or delete it). Re-reads live state first. */
	async applyStep(principal: Principal, params: BlueprintOperationParams, item: StoredItem): Promise<ItemResult> {
		const parsed = parseResourceKey(item.targetId);
		if (!parsed) return { status: 'failed', error: `Unknown resource key ${item.targetId}.` };
		const action = (item.data?.action as BlueprintPlanAction | undefined) ?? 'noop';
		const doc = params.document;
		const upToDate: ItemResult = { status: 'skipped', reason: 'up to date' };
		try {
			if (action === 'delete') return await this.removeStep(principal, parsed);
			switch (parsed.kind) {
				case 'project': {
					const slug = parsed.project!;
					const project = doc.projects[slug]!;
					const result = this.projectDiff(principal, slug, project);
					if (result.problems.length) throw new ConflictError(result.problems.join(' '));
					if (result.action === 'create') {
						await this.ctx.projects.create(
							principal,
							projectCreateSchema.parse({
								slug,
								name: project.name ?? slug,
								runtime: project.runtime,
								...(project.placement ? { placement: project.placement } : {}),
								...(project.access?.production ? { productionAccess: project.access.production } : {}),
								...(project.access?.previews ? { previewAccess: project.access.previews } : {}),
							}),
						);
						return { status: 'succeeded' };
					}
					if (result.action === 'noop') return upToDate;
					await this.ctx.projects.update(principal, slug, result.patch);
					return { status: 'succeeded' };
				}
				case 'environment': {
					const row = this.ctx.projects.requireRow(principal, parsed.project!);
					const environment = doc.projects[parsed.project!]!.environments[parsed.child!]!;
					const live = this.ctx.environments.rows(row.id).find((env) => env.slug === parsed.child);
					if (!live) {
						this.ctx.environments.create(principal, row, {
							name: parsed.child!,
							slug: parsed.child!,
							...(environment.access ? { access: environment.access } : {}),
						});
						return { status: 'succeeded' };
					}
					if (!environment.access || environment.access === live.access) return upToDate;
					this.ctx.environments.update(principal, row, parsed.child!, { access: environment.access });
					return { status: 'succeeded' };
				}
				case 'database': {
					const name = parsed.name!;
					const database = doc.databases[name]!;
					const result = this.databaseDiff(principal, name, database);
					if (result.problems.length) throw new ConflictError(result.problems.join(' '));
					if (result.action === 'create') {
						this.ctx.databases.create(
							principal,
							databaseCreateSchema.parse(this.databaseCreateInput(name, database, this.colocation(principal, doc, { type: 'database', name }))),
						);
						return { status: 'succeeded' };
					}
					if (result.action === 'noop') return upToDate;
					this.ctx.databases.update(principal, name, result.patch as never);
					return { status: 'succeeded' };
				}
				case 'storage': {
					const name = parsed.name!;
					const storage = doc.storage[name]!;
					const result = this.storageDiff(principal, name, storage);
					if (result.problems.length) throw new ConflictError(result.problems.join(' '));
					if (result.action === 'create') {
						const placement = storage.public ? undefined : this.colocation(principal, doc, { type: 'storage', name });
						this.ctx.storage.create(principal, storageCreateSchema.parse(this.storageCreateInput(name, storage, placement)));
						return { status: 'succeeded' };
					}
					if (result.action === 'noop') return upToDate;
					this.ctx.storage.update(principal, name, result.patch);
					return { status: 'succeeded' };
				}
				case 'bucket': {
					const config = doc.storage[parsed.name!]!.buckets[parsed.child!]!;
					const result = this.bucketDiff(principal, parsed.name!, parsed.child!, config);
					if (result.problems.length) throw new ConflictError(result.problems.join(' '));
					if (result.action === 'create') {
						this.ctx.storage.createBucket(principal, parsed.name!, {
							name: parsed.child!,
							...(config.access ? { access: config.access } : {}),
							...(config.versioning !== undefined ? { versioning: config.versioning } : {}),
							...(config.quotaMb != null ? { quotaBytes: config.quotaMb * MiB } : {}),
						});
						return { status: 'succeeded' };
					}
					if (result.action === 'noop') return upToDate;
					this.ctx.storage.updateBucket(principal, parsed.name!, parsed.child!, result.patch);
					return { status: 'succeeded' };
				}
				case 'broker': {
					const name = parsed.name!;
					const broker = doc.brokers[name]!;
					const result = this.brokerDiff(principal, name, broker);
					if (result.problems.length) throw new ConflictError(result.problems.join(' '));
					if (result.action === 'create') {
						this.ctx.brokers.create(
							principal,
							brokerCreateSchema.parse(this.brokerCreateInput(name, broker, this.colocation(principal, doc, { type: 'broker', name }))),
						);
						return { status: 'succeeded' };
					}
					if (result.action === 'noop') return upToDate;
					this.ctx.brokers.update(principal, name, result.patch);
					return { status: 'succeeded' };
				}
				case 'service': {
					const result = this.serviceDiff(principal, parsed.project!, doc.projects[parsed.project!]!);
					if (result.problems.length || !result.spec) throw new ConflictError(result.problems.join(' ') || 'The workload settings do not validate.');
					if (result.action === 'noop') return upToDate;
					this.ctx.workloads.setSpec(principal, this.ctx.projects.requireRow(principal, parsed.project!), result.spec);
					return { status: 'succeeded' };
				}
				case 'domain': {
					const result = this.domainDiff(principal, parsed.project!, parsed.child!);
					if (result.problems.length) throw new ConflictError(result.problems.join(' '));
					if (result.action === 'noop') return upToDate;
					await this.ctx.domains.create(principal, { project: parsed.project!, hostname: parsed.child!, redirectWww: false });
					return { status: 'succeeded' };
				}
				case 'attachment': {
					const attachment = doc.attachments.find((entry) => keys.attachment(entry) === item.targetId);
					if (!attachment) return { status: 'failed', error: 'The attachment is no longer in the plan.' };
					const result = this.attachmentDiff(principal, doc, attachment);
					if (result.problems.length) throw new ConflictError(result.problems.join(' '));
					if (result.action === 'noop') return upToDate;
					const project = this.ctx.projects.requireRow(principal, attachment.project);
					const target = attachmentTarget(attachment);
					const reattach = result.live !== null && result.live.envPrefix !== result.prefix;
					if (result.live && !reattach) {
						// Only the storage grants differ.
						this.ctx.storage.updateAttachment(principal, project, target.name, { grants: result.grants });
						return { status: 'succeeded' };
					}
					if (reattach) this.detach(principal, project, target);
					if (target.type === 'database')
						this.ctx.databases.attach(principal, project, {
							database: target.name,
							envPrefix: result.prefix,
							...(result.live?.credentialId ? { credential: result.live.credentialId } : {}),
						});
					else if (target.type === 'storage')
						this.ctx.storage.attach(principal, project, { storage: target.name, envPrefix: result.prefix, grants: result.grants });
					else this.ctx.brokers.attach(principal, project, { broker: target.name, envPrefix: result.prefix });
					return { status: 'succeeded' };
				}
			}
			return { status: 'failed', error: `Cannot apply ${item.targetId}.` };
		} catch (error) {
			return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async removeStep(principal: Principal, parsed: ParsedKey): Promise<ItemResult> {
		const gone: ItemResult = { status: 'skipped', reason: 'already gone' };
		if (!this.exists(principal, parsed)) return gone;
		switch (parsed.kind) {
			case 'attachment': {
				const project = this.ctx.projects.requireRow(principal, parsed.project!, { includeDeleted: true });
				this.detach(principal, project, { type: parsed.type!, name: parsed.name! });
				break;
			}
			case 'domain': {
				const row = this.ctx.db.select().from(domains).where(eq(domains.hostname, parsed.child!)).get();
				if (!row) return gone;
				await this.ctx.domains.remove(principal, row.id);
				break;
			}
			case 'environment':
				this.ctx.environments.remove(principal, this.ctx.projects.requireRow(principal, parsed.project!), parsed.child!);
				break;
			case 'bucket':
				this.ctx.storage.deleteBucket(principal, parsed.name!, parsed.child!);
				break;
			case 'broker':
				this.ctx.brokers.delete(principal, parsed.name!);
				break;
			case 'storage':
				this.ctx.storage.delete(principal, parsed.name!);
				break;
			case 'database':
				this.ctx.databases.delete(principal, parsed.name!);
				break;
			case 'project':
				await this.ctx.projects.softDelete(principal, parsed.project!);
				break;
			default:
				return { status: 'failed', error: 'This resource cannot be deleted by a blueprint.' };
		}
		return { status: 'succeeded' };
	}

	private detach(principal: Principal, project: ProjectRow, target: { type: 'database' | 'storage' | 'broker'; name: string }): void {
		if (target.type === 'database') this.ctx.databases.detach(principal, project, target.name);
		else if (target.type === 'storage') this.ctx.storage.detach(principal, project, target.name);
		else this.ctx.brokers.detach(principal, project, target.name);
	}

	/**
	 * Where a new database, private storage or broker goes: next to the first project the file
	 * attaches it to (D56), so the attachments that follow find everything on one node.
	 */
	private colocation(principal: Principal, doc: Blueprint, target: { type: 'database' | 'storage' | 'broker'; name: string }): string | undefined {
		const first = doc.attachments.find((attachment) => same(attachmentTarget(attachment), target));
		if (!first) return undefined;
		const project = this.projectRow(principal.orgId, first.project);
		if (project) {
			try {
				const pinned = this.ctx.workloads.attachmentNode(project.id);
				if (pinned) return pinned;
			} catch {
				// Attachments already disagree; let the service decide and report.
			}
			const workloadNode = this.ctx.db.select({ nodeId: workloads.nodeId }).from(workloads).where(eq(workloads.projectId, project.id)).get()?.nodeId;
			if (workloadNode) return workloadNode;
		}
		// Something else this project will use may already exist (created earlier in this run).
		for (const attachment of doc.attachments) {
			if (attachment.project !== first.project) continue;
			const other = attachmentTarget(attachment);
			if (same(other, target)) continue;
			if (other.type === 'storage' && doc.storage[other.name]?.public) continue;
			const row =
				other.type === 'database'
					? this.maybe(() => this.ctx.databases.requireRow(principal, other.name))
					: other.type === 'storage'
						? this.maybe(() => this.ctx.storage.requireRow(principal, other.name))
						: this.maybe(() => this.ctx.brokers.requireRow(principal, other.name));
			if (row) return row.nodeId;
		}
		return project?.placement ?? doc.projects[first.project]?.placement;
	}

	// --- stack record -------------------------------------------------------------------

	/** The finish hook: record what the stack now manages and how the run went. */
	recordRun(run: RunContext): void {
		const params = run.params.blueprint;
		if (!params) return;
		const items = this.ctx.sqlite
			.query<{ target_id: string; status: ItemStatus; reason: string | null; data_json: string | null }, [string]>(
				'SELECT target_id, status, reason, data_json FROM operation_items WHERE operation_id = ? ORDER BY seq',
			)
			.all(run.operationId);
		const existing = this.stackRow(run.principal.orgId, params.stack);
		const managed = new Set(parseJson<string[]>(existing?.managedJson, []));
		for (const item of items) {
			const action = parseJson<{ action?: BlueprintPlanAction }>(item.data_json, {}).action ?? 'noop';
			if (action === 'delete') {
				if (item.status === 'succeeded' || item.reason === 'already gone') managed.delete(item.target_id);
			} else if (action !== 'create' || item.status === 'succeeded' || item.reason === 'up to date') managed.add(item.target_id);
		}
		// Keys whose resource is gone (deleted by hand) or that cannot be pruned drop out.
		const inDoc = new Set(params.steps.map((step) => step.key));
		for (const key of [...managed]) {
			if (inDoc.has(key)) continue;
			const parsed = parseResourceKey(key);
			if (!parsed || parsed.kind === 'service' || !this.exists(run.principal, parsed)) managed.delete(key);
		}
		const failed = items.some((item) => item.status === 'failed');
		const succeeded = items.some((item) => item.status === 'succeeded');
		const status: OperationStatus = run.cancelled() ? 'cancelled' : !failed ? 'succeeded' : succeeded ? 'partial' : 'failed';
		const now = this.ctx.now();
		const clean = status === 'succeeded';
		const values = {
			managedJson: JSON.stringify([...managed].sort()),
			lastOperationId: run.operationId,
			lastStatus: status,
			updatedAt: now,
			...(clean
				? {
						documentJson: JSON.stringify(params.document),
						documentHash: params.documentHash,
						appliedPlanHash: params.planHash,
						appliedAt: now,
						appliedBy: run.principal.userId,
					}
				: {}),
		};
		if (existing) this.ctx.db.update(blueprintStacks).set(values).where(eq(blueprintStacks.id, existing.id)).run();
		else
			this.ctx.db
				.insert(blueprintStacks)
				.values({ id: newId('bp_'), orgId: run.principal.orgId, name: params.stack, createdAt: now, ...values })
				.run();
		this.ctx.audit.record({
			principal: run.principal,
			action: 'blueprint.apply',
			resource: 'blueprint',
			resourceId: params.stack,
			args: { stack: params.stack, planHash: params.planHash, prune: params.prune, status },
			result: status === 'failed' ? 'error' : 'ok',
			operationId: run.operationId,
		});
	}

	/** Refuse an apply whose plan no longer matches live state, or an unconfirmed prune. */
	checkBeforeApply(principal: Principal, params: BlueprintOperationParams, confirm: string | undefined): void {
		this.requireFeature();
		const deletes = params.steps.some((step) => step.action === 'delete');
		if (params.prune && principal.credential === 'oauth')
			throw new CoreError('surface_not_allowed', 'A pruning blueprint plan deletes resources; apply it from the dashboard or CLI.', 403);
		if (deletes && confirm !== params.stack)
			throw new ValidationError(`This plan deletes resources. Type the stack name "${params.stack}" to confirm.`);
		const fresh = this.diff(principal, params.document, params.prune);
		if (fresh.problems.length)
			throw new ConflictError(
				`Live state changed since the plan and it no longer applies: ${fresh.problems.map((problem) => `${problem.path.join('.')}: ${problem.message}`).join(' ')}`,
			);
		const hash = blueprintPlanHash({ stack: params.stack, prune: params.prune, documentHash: params.documentHash, steps: fresh.steps });
		if (hash !== params.planHash)
			throw new ConflictError('Live state changed since this plan was made. Plan the blueprint again and review the new diff.');
	}

	/** Permissions the plan's steps need (checked when the operation is created and applied). */
	requiredPermissions(params: BlueprintOperationParams): Permission[] {
		const out = new Set<Permission>();
		for (const step of params.steps) {
			if (step.action === 'noop') continue;
			const parsed = parseResourceKey(step.key);
			if (!parsed) continue;
			if (step.action === 'delete') for (const permission of deletePermissions(parsed)) out.add(permission);
			else for (const permission of stepPermissions(parsed, step.action)) out.add(permission);
		}
		return [...out];
	}

	// --- helpers ------------------------------------------------------------------------

	private requireFeature(): void {
		if (!featureEnabled(this.ctx.config, 'BLUEPRINTS'))
			throw new CoreError('feature_disabled', 'Blueprints are not enabled on this platform (SKIFF_FEATURE_BLUEPRINTS).', 403);
	}

	private require(principal: Principal, permission: Permission): void {
		if (!hasPermission(principal, permission)) throw new ForbiddenError(permission);
	}

	private maybe<T>(read: () => T): T | undefined {
		try {
			return read();
		} catch (error) {
			if (error instanceof NotFoundError) return undefined;
			throw error;
		}
	}

	private stackRow(orgId: string, name: string): StackRow | undefined {
		return this.ctx.db
			.select()
			.from(blueprintStacks)
			.where(and(eq(blueprintStacks.orgId, orgId), eq(blueprintStacks.name, name)))
			.get();
	}

	private operationParams(operationId: string): BlueprintOperationParams | undefined {
		const row = this.ctx.sqlite.query<{ params_json: string | null }, [string]>('SELECT params_json FROM operations WHERE id = ?').get(operationId);
		return parseJson<OperationParams>(row?.params_json, {}).blueprint;
	}

	private projectRow(orgId: string, slug: string): ProjectRow | undefined {
		return this.ctx.db
			.select()
			.from(projects)
			.where(and(eq(projects.orgId, orgId), eq(projects.slug, slug)))
			.get() as ProjectRow | undefined;
	}

	private projectSlugById(id: string): string | undefined {
		return this.ctx.db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, id)).get()?.slug;
	}

	/** Slugs are platform-wide: another org's project or a live rename redirect holds it. */
	private slugTakenElsewhere(orgId: string, slug: string): boolean {
		const other = this.ctx.db
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.slug, slug), ne(projects.orgId, orgId)))
			.get();
		if (other) return true;
		return Boolean(
			this.ctx.db
				.select({ id: slugRedirects.id })
				.from(slugRedirects)
				.where(and(eq(slugRedirects.fromSlug, slug), gt(slugRedirects.expiresAt, this.ctx.now())))
				.get(),
		);
	}

	private bucketRow(storageId: string, name: string) {
		return this.ctx.db
			.select()
			.from(storageBuckets)
			.where(and(eq(storageBuckets.storageId, storageId), eq(storageBuckets.name, name)))
			.get();
	}

	private targetRow(principal: Principal, target: { type: 'database' | 'storage' | 'broker'; name: string }): DatabaseRow | StorageRow | BrokerRow | undefined {
		return target.type === 'database'
			? this.maybe(() => this.ctx.databases.requireRow(principal, target.name))
			: target.type === 'storage'
				? this.maybe(() => this.ctx.storage.requireRow(principal, target.name))
				: this.maybe(() => this.ctx.brokers.requireRow(principal, target.name));
	}

	private attachmentRow(
		principal: Principal,
		projectId: string,
		target: { type: 'database' | 'storage' | 'broker'; name: string },
	): { envPrefix: string; grants: StorageGrant[] | null; credentialId: string | null } | null {
		const row = this.targetRow(principal, target);
		if (!row) return null;
		if (target.type === 'database') {
			const live = this.ctx.db
				.select()
				.from(databaseAttachments)
				.where(and(eq(databaseAttachments.databaseId, row.id), eq(databaseAttachments.projectId, projectId)))
				.get();
			return live ? { envPrefix: live.envPrefix, grants: null, credentialId: live.credentialId ?? null } : null;
		}
		if (target.type === 'storage') {
			const live = this.ctx.db
				.select()
				.from(storageAttachments)
				.where(and(eq(storageAttachments.storageId, row.id), eq(storageAttachments.projectId, projectId)))
				.get();
			return live ? { envPrefix: live.envPrefix, grants: parseJson<StorageGrant[]>(live.grantsJson, []), credentialId: null } : null;
		}
		const live = this.ctx.db
			.select()
			.from(brokerAttachments)
			.where(and(eq(brokerAttachments.brokerId, row.id), eq(brokerAttachments.projectId, projectId)))
			.get();
		return live ? { envPrefix: live.envPrefix, grants: null, credentialId: null } : null;
	}

	/** The service name that already holds `prefix` on this project for this service type. */
	private prefixOwner(projectId: string, type: 'database' | 'storage' | 'broker', prefix: string): string | null {
		if (type === 'database')
			return (
				this.ctx.sqlite
					.query<{ name: string }, [string, string]>(
						'SELECT d.name FROM database_attachments a JOIN databases d ON d.id = a.database_id WHERE a.project_id = ? AND a.env_prefix = ?',
					)
					.get(projectId, prefix)?.name ?? null
			);
		if (type === 'storage')
			return (
				this.ctx.sqlite
					.query<{ name: string }, [string, string]>(
						'SELECT s.name FROM storage_attachments a JOIN storage_instances s ON s.id = a.storage_id WHERE a.project_id = ? AND a.env_prefix = ?',
					)
					.get(projectId, prefix)?.name ?? null
			);
		return (
			this.ctx.sqlite
				.query<{ name: string }, [string, string]>(
					'SELECT b.name FROM broker_attachments a JOIN brokers b ON b.id = a.broker_id WHERE a.project_id = ? AND a.env_prefix = ?',
				)
				.get(projectId, prefix)?.name ?? null
		);
	}

	/** Whether a managed resource still exists (and is not in the trash). */
	private exists(principal: Principal, parsed: ParsedKey): boolean {
		switch (parsed.kind) {
			case 'project': {
				const row = this.projectRow(principal.orgId, parsed.project!);
				return Boolean(row && !row.deletedAt);
			}
			case 'environment': {
				const row = this.projectRow(principal.orgId, parsed.project!);
				return Boolean(row && this.ctx.environments.rows(row.id).some((env) => env.slug === parsed.child));
			}
			case 'domain': {
				const row = this.projectRow(principal.orgId, parsed.project!);
				const domain = this.ctx.db.select().from(domains).where(eq(domains.hostname, parsed.child!)).get();
				return Boolean(row && domain && domain.projectId === row.id);
			}
			case 'database':
			case 'storage':
			case 'broker':
				return Boolean(this.targetRow(principal, { type: parsed.kind, name: parsed.name! }));
			case 'bucket': {
				const storage = this.maybe(() => this.ctx.storage.requireRow(principal, parsed.name!));
				const bucket = storage ? this.bucketRow(storage.id, parsed.child!) : undefined;
				return Boolean(bucket && !bucket.deleteRequestedAt);
			}
			case 'attachment': {
				const row = this.projectRow(principal.orgId, parsed.project!);
				return Boolean(row && this.attachmentRow(principal, row.id, { type: parsed.type!, name: parsed.name! }));
			}
			case 'service':
				return true;
		}
	}
}

// ---------------------------------------------------------------- the operation action

function stepPermissions(parsed: ParsedKey, action: BlueprintPlanAction): Permission[] {
	switch (parsed.kind) {
		case 'project':
			return [action === 'create' ? 'project:create' : 'project:update'];
		case 'environment':
		case 'service':
			return ['project:update'];
		case 'domain':
			return ['domain:create'];
		case 'database':
			return [action === 'create' ? 'database:create' : 'database:update'];
		case 'storage':
			return [action === 'create' ? 'storage:create' : 'storage:update'];
		case 'bucket':
			return ['storage:update'];
		case 'broker':
			return [action === 'create' ? 'broker:create' : 'broker:update'];
		case 'attachment':
			return [PERMISSION_LABEL[parsed.type!], 'project:update'];
	}
}

function deletePermissions(parsed: ParsedKey): Permission[] {
	switch (parsed.kind) {
		case 'project':
			return ['project:delete'];
		case 'environment':
		case 'service':
			return ['project:update'];
		case 'domain':
			return ['domain:delete'];
		case 'database':
			return ['database:delete'];
		case 'storage':
			return ['storage:delete'];
		case 'bucket':
			return ['storage:update'];
		case 'broker':
			return ['broker:delete'];
		case 'attachment':
			return [PERMISSION_LABEL[parsed.type!], 'project:update'];
	}
}

function deleteReason(parsed: ParsedKey): string {
	switch (parsed.kind) {
		case 'project':
			return 'no longer in the file; moves to the trash (restorable)';
		case 'database':
		case 'storage':
		case 'broker':
			return 'no longer in the file; moves to the trash (restorable)';
		case 'bucket':
			return 'no longer in the file; deleted only if empty';
		case 'attachment':
			return 'no longer in the file; detached (the app loses its variables on its next activation)';
		default:
			return 'no longer in the file';
	}
}

function planViewOf(params: BlueprintOperationParams, operationId: string, expiresAt: string | null): BlueprintPlanView {
	const summary = { create: 0, update: 0, delete: 0, noop: 0 };
	for (const step of params.steps) summary[step.action] += 1;
	return {
		planHash: params.planHash,
		stack: params.stack,
		stackAction: params.stackAction,
		operationId,
		prune: params.prune,
		resources: params.steps.map((step) => ({ ...step })),
		summary,
		warnings: params.warnings,
		generatedAt: params.generatedAt,
		expiresAt,
	};
}

function failOnProblems(problems: Problem[]): void {
	if (problems.length === 0) return;
	const first = problems[0]!;
	throw new ValidationError(
		`The plan has ${problems.length} problem${problems.length === 1 ? '' : 's'}. ${first.path.join('.')}: ${first.message}`,
		problems,
	);
}

function stackView(row: StackRow): BlueprintStackView {
	const iso = (value: number | null) => (value ? new Date(value).toISOString() : null);
	return {
		name: row.name,
		managed: parseJson<string[]>(row.managedJson, []),
		lastOperationId: row.lastOperationId,
		lastStatus: row.lastStatus,
		document: row.documentJson ? (parseJson<Blueprint | null>(row.documentJson, null) ?? null) : null,
		appliedPlanHash: row.appliedPlanHash,
		appliedAt: iso(row.appliedAt),
		appliedBy: row.appliedBy,
		createdAt: new Date(row.createdAt).toISOString(),
		updatedAt: new Date(row.updatedAt).toISOString(),
	};
}

/**
 * `blueprint.apply` (docs/OPERATIONS.md §12): one item per resource step. The plan is computed
 * by `BlueprintService.plan` and carried in the operation's internal params; the first failed step
 * stops the run and every later step is skipped.
 */
export const blueprintApplyAction: ActionDefinition = {
	info: operationActions['blueprint.apply'],
	authorize(principal, params) {
		if (!params.blueprint)
			throw new ValidationError('Blueprint plans are made with POST /api/v1/blueprints/plan (or `skif blueprint plan`), not POST /operations.');
		if (!hasPermission(principal, 'project:read')) throw new ForbiddenError('project:read');
	},
	beforeApply(ctx, principal, params, input) {
		if (!params.blueprint) throw new ValidationError('This operation has no blueprint plan.');
		for (const permission of ctx.blueprints.requiredPermissions(params.blueprint))
			if (!hasPermission(principal, permission)) throw new ForbiddenError(permission);
		ctx.blueprints.checkBeforeApply(principal, params.blueprint, input.confirm);
	},
	async *plan(run) {
		for (const step of run.params.blueprint?.steps ?? []) {
			yield {
				targetKind: step.kind,
				targetId: step.key,
				label: step.key,
				verdict: step.action === 'noop' ? 'skip' : 'ok',
				...(step.reason ? { reason: step.reason } : step.action === 'noop' ? { reason: 'up to date' } : {}),
				data: { action: step.action },
			};
		}
	},
	async apply(run, item) {
		const params = run.params.blueprint;
		if (!params) return { status: 'failed', error: 'This operation has no blueprint plan.' };
		const earlier = run.ctx.sqlite
			.query<{ n: number }, [string, number]>(
				"SELECT COUNT(*) AS n FROM operation_items WHERE operation_id = ? AND seq < ? AND status = 'failed'",
			)
			.get(run.operationId, item.seq)?.n;
		if (earlier) return { status: 'skipped', reason: 'an earlier step failed' };
		return run.ctx.blueprints.applyStep(run.principal, params, item);
	},
	async finish(run) {
		run.ctx.blueprints.recordRun(run);
		run.ctx.projects.bump(run.principal.orgId);
	},
};
