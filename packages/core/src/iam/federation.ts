/**
 * Federation trusts (docs/IAM.md I17, §4, §7.3): the CRUD surface for `federation_trusts`.
 *
 * A trust maps an OIDC issuer to one org-owned service account. `TokenService` (`sts.ts`) reads
 * the rows back on every exchange, so this module only owns the writes and the validation that
 * stops a trust from silently widening access:
 *
 *   - the issuer is an absolute http(s) URL, stored without a trailing slash;
 *   - at least one audience is required, because a trust with none can never match;
 *   - the subject pattern is the same glob the exchange uses (`*` within a segment, `**` across);
 *   - a trust may cap the exchange at one hour, never more;
 *   - `restriction_json` is the credential ceiling (`permissions`, `resources`) and only ever
 *     narrows the service account's bindings;
 *   - the service account must belong to the caller's organisation.
 *
 * Permissions are `federation:read|create|update|delete` from the catalog. They are checked
 * directly, like the other IAM writes, until every call site goes through `iam.require`.
 */
import type { Database } from 'bun:sqlite';
import { isPermission, type Permission, type Principal } from '@yoal/contracts';
import type { CoreContext } from '../context.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { newId, parseJson } from '../util.ts';

/** The exchange's own maximum (`sts.ts`). A trust may lower it, never raise it. */
const MAX_TTL_SECONDS = 60 * 60;
const DEFAULT_TTL_SECONDS = 15 * 60;
const MAX_ISSUER = 2048;
const MAX_AUDIENCE = 512;
const MAX_AUDIENCES = 32;
const MAX_SUBJECT = 512;
const MAX_CONDITIONS = 64;
const MAX_RESOURCES = 256;
const MAX_RESOURCE = 200;

export interface FederationRestriction {
	permissions?: readonly Permission[];
	resources?: readonly string[];
}

export interface FederationTrustView {
	id: string;
	orgId: string;
	serviceAccountId: string;
	issuer: string;
	audiences: string[];
	subjectPattern: string;
	claimConditions: Record<string, unknown>;
	maxTtlSeconds: number;
	restriction: FederationRestriction;
}

export interface FederationTrustCreate {
	serviceAccountId: string;
	issuer: string;
	audiences: readonly string[];
	subjectPattern?: string;
	claimConditions?: Record<string, unknown>;
	maxTtlSeconds?: number;
	restriction?: FederationRestriction;
}

export interface FederationTrustUpdate {
	serviceAccountId?: string;
	issuer?: string;
	audiences?: readonly string[];
	subjectPattern?: string;
	claimConditions?: Record<string, unknown>;
	maxTtlSeconds?: number;
	restriction?: FederationRestriction;
}

interface FederationTrustRow {
	id: string;
	org_id: string;
	service_account_id: string;
	issuer: string;
	audiences: string;
	subject_pattern: string;
	claim_conditions_json: string;
	max_ttl_seconds: number;
	restriction_json: string;
}

export class FederationTrustService {
	readonly #sqlite: Database;

	constructor(private readonly ctx: CoreContext) {
		this.#sqlite = ctx.sqlite;
	}

	// ---------------------------------------------------------------- reads

	list(principal: Principal): FederationTrustView[] {
		this.#require(principal, 'federation:read');
		return this.#sqlite
			.query<FederationTrustRow, [string]>(
				'SELECT * FROM federation_trusts WHERE org_id = ? ORDER BY issuer, id',
			)
			.all(principal.orgId)
			.map(view);
	}

	get(principal: Principal, id: string): FederationTrustView {
		this.#require(principal, 'federation:read');
		return view(this.#row(principal, id));
	}

	// ---------------------------------------------------------------- mutations

	create(principal: Principal, input: FederationTrustCreate): FederationTrustView {
		this.#require(principal, 'federation:create');
		const trust = normalizeCreate(input, (serviceAccountId) =>
			this.#requireServiceAccount(principal.orgId, serviceAccountId),
		);

		const id = newId('ft_');
		this.#sqlite.run(
			`INSERT INTO federation_trusts
			   (id, org_id, service_account_id, issuer, audiences, subject_pattern,
			    claim_conditions_json, max_ttl_seconds, restriction_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				principal.orgId,
				trust.serviceAccountId,
				trust.issuer,
				JSON.stringify(trust.audiences),
				trust.subjectPattern,
				JSON.stringify(trust.claimConditions),
				trust.maxTtlSeconds,
				JSON.stringify(trust.restriction),
			],
		);
		this.ctx.audit.record({
			principal,
			action: 'federation.trust.create',
			resource: 'federation_trust',
			resourceId: id,
			args: trust,
			result: 'ok',
		});
		return { id, orgId: principal.orgId, ...trust };
	}

	update(principal: Principal, id: string, input: FederationTrustUpdate): FederationTrustView {
		this.#require(principal, 'federation:update');
		const row = this.#row(principal, id);
		const next = normalizeUpdate(view(row), input, (serviceAccountId) =>
			this.#requireServiceAccount(principal.orgId, serviceAccountId),
		);

		const sets: string[] = [];
		const values: Array<string | number> = [];
		const changes: Record<string, { from: unknown; to: unknown }> = {};
		const set = (column: string, key: string, value: string | number, before: unknown, after: unknown) => {
			sets.push(`${column} = ?`);
			values.push(value);
			changes[key] = { from: before, to: after };
		};

		if (next.serviceAccountId !== row.service_account_id)
			set(
				'service_account_id',
				'serviceAccountId',
				next.serviceAccountId,
				row.service_account_id,
				next.serviceAccountId,
			);
		if (next.issuer !== row.issuer) set('issuer', 'issuer', next.issuer, row.issuer, next.issuer);
		const currentAudiences = parseStringArray(row.audiences);
		if (!sameStrings(next.audiences, currentAudiences))
			set('audiences', 'audiences', JSON.stringify(next.audiences), currentAudiences, next.audiences);
		if (next.subjectPattern !== row.subject_pattern)
			set(
				'subject_pattern',
				'subjectPattern',
				next.subjectPattern,
				row.subject_pattern,
				next.subjectPattern,
			);
		const currentConditions = parseConditions(row.claim_conditions_json);
		if (!sameJson(next.claimConditions, currentConditions))
			set(
				'claim_conditions_json',
				'claimConditions',
				JSON.stringify(next.claimConditions),
				currentConditions,
				next.claimConditions,
			);
		if (next.maxTtlSeconds !== row.max_ttl_seconds)
			set(
				'max_ttl_seconds',
				'maxTtlSeconds',
				next.maxTtlSeconds,
				row.max_ttl_seconds,
				next.maxTtlSeconds,
			);
		const currentRestriction = parseRestriction(row.restriction_json);
		if (!sameJson(next.restriction, currentRestriction))
			set(
				'restriction_json',
				'restriction',
				JSON.stringify(next.restriction),
				currentRestriction,
				next.restriction,
			);

		if (sets.length > 0) {
			this.#sqlite.run(`UPDATE federation_trusts SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`, [
				...values,
				id,
				principal.orgId,
			]);
			this.ctx.audit.record({
				principal,
				action: 'federation.trust.update',
				resource: 'federation_trust',
				resourceId: id,
				args: { changes },
				result: 'ok',
			});
		}
		return view(this.#row(principal, id));
	}

	delete(principal: Principal, id: string): void {
		this.#require(principal, 'federation:delete');
		const row = this.#row(principal, id);
		this.#sqlite.run('DELETE FROM federation_trusts WHERE id = ? AND org_id = ?', [id, principal.orgId]);
		this.ctx.audit.record({
			principal,
			action: 'federation.trust.delete',
			resource: 'federation_trust',
			resourceId: id,
			args: { issuer: row.issuer, serviceAccountId: row.service_account_id },
			result: 'ok',
		});
	}

	// ---------------------------------------------------------------- internals

	#row(principal: Principal, id: string): FederationTrustRow {
		const row = this.#sqlite
			.query<FederationTrustRow, [string, string]>(
				'SELECT * FROM federation_trusts WHERE id = ? AND org_id = ?',
			)
			.get(id, principal.orgId);
		if (!row) throw new NotFoundError('Federation trust');
		return row;
	}

	#requireServiceAccount(orgId: string, id: string): void {
		const row = this.#sqlite
			.query<{ id: string }, [string, string]>(
				'SELECT id FROM service_accounts WHERE id = ? AND org_id = ?',
			)
			.get(id, orgId);
		if (!row) throw new ValidationError('The trust must name a service account in this organisation.');
	}

	#require(principal: Principal, permission: Permission): void {
		if (!principal.permissions.has(permission)) throw new ForbiddenError(permission);
	}
}

// ------------------------------------------------------------------------- validation

function normalizeCreate(
	input: FederationTrustCreate,
	checkServiceAccount: (id: string) => void,
): Omit<FederationTrustView, 'id' | 'orgId'> {
	const serviceAccountId = normalizeServiceAccount(input.serviceAccountId);
	checkServiceAccount(serviceAccountId);
	return {
		serviceAccountId,
		issuer: normalizeIssuer(input.issuer),
		audiences: normalizeAudiences(input.audiences),
		subjectPattern: normalizeSubject(input.subjectPattern),
		claimConditions: normalizeConditions(input.claimConditions),
		maxTtlSeconds: normalizeTtl(input.maxTtlSeconds),
		restriction: normalizeRestriction(input.restriction),
	};
}

function normalizeUpdate(
	current: FederationTrustView,
	input: FederationTrustUpdate,
	checkServiceAccount: (id: string) => void,
): Omit<FederationTrustView, 'id' | 'orgId'> {
	let serviceAccountId = current.serviceAccountId;
	if (input.serviceAccountId !== undefined) {
		serviceAccountId = normalizeServiceAccount(input.serviceAccountId);
		checkServiceAccount(serviceAccountId);
	}
	return {
		serviceAccountId,
		issuer: input.issuer === undefined ? current.issuer : normalizeIssuer(input.issuer),
		audiences: input.audiences === undefined ? current.audiences : normalizeAudiences(input.audiences),
		subjectPattern:
			input.subjectPattern === undefined
				? current.subjectPattern
				: normalizeSubject(input.subjectPattern),
		claimConditions:
			input.claimConditions === undefined
				? current.claimConditions
				: normalizeConditions(input.claimConditions),
		maxTtlSeconds:
			input.maxTtlSeconds === undefined ? current.maxTtlSeconds : normalizeTtl(input.maxTtlSeconds),
		restriction:
			input.restriction === undefined ? current.restriction : normalizeRestriction(input.restriction),
	};
}

function normalizeServiceAccount(value: string | undefined): string {
	const id = value?.trim() ?? '';
	if (!id) throw new ValidationError('A federation trust needs a service account id.');
	if (!id.startsWith('sa_') || id.length > 100)
		throw new ValidationError('A service account id starts with sa_.');
	return id;
}

/** The issuer is an absolute http(s) URL with no credentials, query or fragment. */
function normalizeIssuer(value: string | undefined): string {
	const raw = value?.trim() ?? '';
	if (!raw) throw new ValidationError('A federation trust needs an issuer URL.');
	if (raw.length > MAX_ISSUER)
		throw new ValidationError(`An issuer URL is at most ${MAX_ISSUER} characters.`);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ValidationError('The issuer is not a valid URL.');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		throw new ValidationError('The issuer must be an http or https URL.');
	if (url.username || url.password || url.search || url.hash)
		throw new ValidationError('The issuer URL cannot carry credentials, a query or a fragment.');
	return `${url.origin}${url.pathname}`.replace(/\/+$/, '') || url.origin;
}

function normalizeAudiences(values: readonly string[] | undefined): string[] {
	if (!Array.isArray(values) || values.length === 0)
		throw new ValidationError('A federation trust needs at least one audience.');
	if (values.length > MAX_AUDIENCES)
		throw new ValidationError(`A trust lists at most ${MAX_AUDIENCES} audiences.`);
	const out: string[] = [];
	for (const value of values) {
		const audience = typeof value === 'string' ? value.trim() : '';
		if (!audience)
			throw new ValidationError('An audience cannot be empty.');
		if (audience.length > MAX_AUDIENCE)
			throw new ValidationError(`An audience is at most ${MAX_AUDIENCE} characters.`);
		if (/[\u0000-\u001f\u007f]/.test(audience))
			throw new ValidationError('An audience cannot contain control characters.');
		if (!out.includes(audience)) out.push(audience);
	}
	return out;
}

function normalizeSubject(value: string | undefined): string {
	const pattern = value?.trim() ?? '*';
	if (!pattern) throw new ValidationError('A subject pattern cannot be empty; use * for any subject.');
	if (pattern.length > MAX_SUBJECT)
		throw new ValidationError(`A subject pattern is at most ${MAX_SUBJECT} characters.`);
	if (/[\u0000-\u001f\u007f]/.test(pattern))
		throw new ValidationError('A subject pattern cannot contain control characters.');
	return pattern;
}

function normalizeConditions(value: Record<string, unknown> | undefined): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (!isPlainObject(value))
		throw new ValidationError('Claim conditions must be a JSON object of claim names to values.');
	const entries = Object.entries(value);
	if (entries.length > MAX_CONDITIONS)
		throw new ValidationError(`A trust carries at most ${MAX_CONDITIONS} claim conditions.`);
	for (const [claim, expected] of entries) {
		if (!claim.trim()) throw new ValidationError('A claim condition needs a claim name.');
		if (expected === undefined || typeof expected === 'function' || typeof expected === 'symbol')
			throw new ValidationError(`The claim condition "${claim}" is not a JSON value.`);
		if (containsNonJson(expected, new Set()))
			throw new ValidationError(`The claim condition "${claim}" is not a JSON value.`);
	}
	return value;
}

function normalizeTtl(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TTL_SECONDS;
	if (!Number.isInteger(value) || value <= 0)
		throw new ValidationError('maxTtlSeconds must be a positive whole number of seconds.');
	if (value > MAX_TTL_SECONDS)
		throw new ValidationError(`A federation trust caps a token at ${MAX_TTL_SECONDS} seconds (one hour).`);
	return value;
}

function normalizeRestriction(value: FederationRestriction | undefined): FederationRestriction {
	if (value === undefined || value === null) return {};
	if (!isPlainObject(value)) throw new ValidationError('A restriction must be a JSON object.');
	const record = value as Record<string, unknown>;
	const permissions: Permission[] = [];
	const requestedPermissions = Array.isArray(record.permissions) ? record.permissions : [];
	for (const raw of requestedPermissions) {
		const permission = typeof raw === 'string' ? raw.trim() : '';
		if (!isPermission(permission) || permission.includes('*'))
			throw new ValidationError(`"${String(raw)}" is not a permission in the catalog.`);
		if (!permissions.includes(permission)) permissions.push(permission);
	}
	const resources: string[] = [];
	const requestedResources = Array.isArray(record.resources) ? record.resources : [];
	for (const raw of requestedResources) {
		const resource = typeof raw === 'string' ? raw.trim() : '';
		if (!/^[a-zA-Z][a-zA-Z0-9]*:(\*|[^\s:*]+)$/.test(resource))
			throw new ValidationError(`"${String(raw)}" is not a resource limit (expected type:id or type:*).`);
		if (resource.length > MAX_RESOURCE)
			throw new ValidationError(`A resource limit is at most ${MAX_RESOURCE} characters.`);
		if (!resources.includes(resource)) resources.push(resource);
		if (resources.length > MAX_RESOURCES)
			throw new ValidationError(`A trust carries at most ${MAX_RESOURCES} resource limits.`);
	}
	return {
		...(permissions.length > 0 ? { permissions } : {}),
		...(resources.length > 0 ? { resources } : {}),
	};
}

// ------------------------------------------------------------------------- helpers

function view(row: FederationTrustRow): FederationTrustView {
	return {
		id: row.id,
		orgId: row.org_id,
		serviceAccountId: row.service_account_id,
		issuer: row.issuer,
		audiences: parseStringArray(row.audiences),
		subjectPattern: row.subject_pattern,
		claimConditions: parseConditions(row.claim_conditions_json),
		maxTtlSeconds: row.max_ttl_seconds,
		restriction: parseRestriction(row.restriction_json),
	};
}

function parseStringArray(json: string): string[] {
	const value = parseJson<unknown>(json, []);
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function parseConditions(json: string): Record<string, unknown> {
	const value = parseJson<unknown>(json, {});
	return isPlainObject(value) ? (value as Record<string, unknown>) : {};
}

function parseRestriction(json: string): FederationRestriction {
	const value = parseJson<unknown>(json, {});
	if (!isPlainObject(value)) return {};
	const permissions = Array.isArray(value.permissions)
		? value.permissions.filter(
				(entry): entry is Permission => typeof entry === 'string' && isPermission(entry),
			)
		: [];
	const resources = Array.isArray(value.resources)
		? value.resources.filter((entry): entry is string => typeof entry === 'string')
		: [];
	return {
		...(permissions.length > 0 ? { permissions } : {}),
		...(resources.length > 0 ? { resources } : {}),
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsNonJson(value: unknown, seen: Set<unknown>): boolean {
	if (value === null) return false;
	const type = typeof value;
	if (type === 'string' || type === 'number' || type === 'boolean') return false;
	if (type !== 'object') return true;
	if (seen.has(value)) return true;
	seen.add(value);
	if (Array.isArray(value)) return value.some((entry) => containsNonJson(entry, seen));
	return Object.values(value as Record<string, unknown>).some((entry) => containsNonJson(entry, seen));
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
