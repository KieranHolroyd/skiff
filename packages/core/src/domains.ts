import { resolve4, resolveCname } from 'node:dns/promises';
import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { domains, nodes, projects } from '@skiff/db';
import {
	requirePermission,
	type DomainCheckResult,
	type DomainCreateInput,
	type DomainKind,
	type DomainStatus,
	type DomainView,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { resolveTxtRecords } from './dns-txt.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { newId, randomToken } from './util.ts';
import type { ProjectRow } from './projects.ts';

export type DomainRow = typeof domains.$inferSelect;

const VERIFY_PREFIX = '_skiff';
const TOKEN_PREFIX = 'skiff-verify=';
const HOSTNAME_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;
const HOUR_MS = 3_600_000;

/**
 * Status lifecycle (DESIGN §5, D31): `pending` → `verified` (TXT found) → `active` (an edge node
 * reports a valid certificate for the hostname, so it is really serving HTTPS). A domain that has
 * never verified becomes `failed` once its checks have kept failing for this long after it was
 * added. Re-checks continue, so a fixed record recovers it to `verified`.
 */
export const DOMAIN_FAIL_AFTER_MS = 72 * HOUR_MS;
/** Background re-check cadence (the maintenance sweep): pending often, failed rarely. */
export const DOMAIN_RECHECK_PENDING_MS = 10 * 60_000;
export const DOMAIN_RECHECK_FAILED_MS = 6 * HOUR_MS;
/** At most this many background DNS checks per sweep, oldest first. */
const RECHECK_BATCH = 20;
/** Statuses that are routed to nodes (and approved for certificates). */
const SERVED_STATUSES: DomainStatus[] = ['verified', 'active'];

/** --- DNS seam -------------------------------------------------------------
 * Everything the service needs from public DNS is behind this interface. Production uses the
 * system resolver; tests inject a fake so they never touch the network.
 */
export interface DnsResolver {
	resolveTxt(name: string): Promise<string[][]>;
	resolveCname(name: string): Promise<string[]>;
	resolve4(name: string): Promise<string[]>;
}

export const nodeDnsResolver: DnsResolver = { resolveTxt: resolveTxtRecords, resolveCname, resolve4 };

/** --- Cloudflare seam ------------------------------------------------------
 * Least privilege: the client only sees records for the configured zone and never a token.
 */
export interface CloudflareRecord {
	id: string;
	type: string;
	name: string;
	content: string;
	proxied?: boolean;
}

export interface CloudflareRecordInput {
	/** TXT and MX are written by Email (docs/EMAIL.md §4.2); domains only use CNAME/A. */
	type: 'CNAME' | 'A' | 'TXT' | 'MX';
	name: string;
	content: string;
	/** Grey cloud (DESIGN §5, D8): DNS only, never the Cloudflare proxy. */
	proxied: false;
	ttl: 1;
	comment: string;
	/** MX only. */
	priority?: number;
}

export interface CloudflareClient {
	findRecord(name: string): Promise<CloudflareRecord | null>;
	createRecord(input: CloudflareRecordInput): Promise<CloudflareRecord>;
	updateRecord(id: string, input: CloudflareRecordInput): Promise<CloudflareRecord>;
	deleteRecord(id: string): Promise<void>;
}

export interface CloudflareConfig {
	apiToken: string;
	zoneId?: string;
	zoneName?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const RECORD_COMMENT = 'Managed by Skiff';

interface CloudflareEnvelope<T> {
	success?: boolean;
	result?: T;
	errors?: Array<{ message?: string }>;
}

/** Read Cloudflare auto-record settings from the environment. Disabled unless a token is set. */
export function cloudflareConfigFromEnv(env: Record<string, string | undefined> = process.env): CloudflareConfig | null {
	const apiToken = env.SKIFF_CLOUDFLARE_API_TOKEN?.trim();
	if (!apiToken) return null;
	const zoneId = env.SKIFF_CLOUDFLARE_ZONE_ID?.trim() || undefined;
	const zoneName = env.SKIFF_CLOUDFLARE_ZONE_NAME?.trim().toLowerCase() || undefined;
	// The zone is required: never guess which zone a record belongs to.
	if (!zoneId && !zoneName) return null;
	return { apiToken, zoneId, zoneName };
}

/**
 * Cloudflare v4 client. `fetch` is injectable so the service's tests never hit the network.
 * The token is only ever placed in the Authorization header; it is never logged or returned.
 */
export class HttpCloudflareClient implements CloudflareClient {
	private resolvedZoneId: string | null;

	constructor(
		private readonly config: CloudflareConfig,
		private readonly fetchImpl: FetchLike = fetch,
	) {
		this.resolvedZoneId = config.zoneId ?? null;
	}

	async findRecord(name: string): Promise<CloudflareRecord | null> {
		const zoneId = await this.zoneId();
		const records = await this.request<CloudflareRecord[]>(
			`/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(name)}`,
			'GET',
		);
		const normalized = normalizeDnsName(name);
		return records.find((record) => normalizeDnsName(record.name) === normalized) ?? null;
	}

	async createRecord(input: CloudflareRecordInput): Promise<CloudflareRecord> {
		const zoneId = await this.zoneId();
		return this.request<CloudflareRecord>(
			`/zones/${encodeURIComponent(zoneId)}/dns_records`,
			'POST',
			input,
		);
	}

	async updateRecord(id: string, input: CloudflareRecordInput): Promise<CloudflareRecord> {
		const zoneId = await this.zoneId();
		return this.request<CloudflareRecord>(
			`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`,
			'PUT',
			input,
		);
	}

	async deleteRecord(id: string): Promise<void> {
		const zoneId = await this.zoneId();
		await this.request<{ id: string }>(
			`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`,
			'DELETE',
			undefined,
			// Already gone is the desired state; a manual delete must not block removing the domain.
			true,
		);
	}

	private async zoneId(): Promise<string> {
		if (this.resolvedZoneId) return this.resolvedZoneId;
		if (!this.config.zoneName) throw new Error('Cloudflare zone id or name is required');
		const zones = await this.request<Array<{ id: string; name: string }>>(
			`/zones?name=${encodeURIComponent(this.config.zoneName)}`,
			'GET',
		);
		const zone = zones.find((candidate) => candidate.name.toLowerCase() === this.config.zoneName);
		if (!zone) throw new Error(`Cloudflare zone "${this.config.zoneName}" was not found for this token`);
		this.resolvedZoneId = zone.id;
		return zone.id;
	}

	private async request<T>(path: string, method: string, body?: unknown, allowNotFound = false): Promise<T> {
		const response = await this.fetchImpl(`${CLOUDFLARE_API}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${this.config.apiToken}`,
				'content-type': 'application/json',
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		let envelope: CloudflareEnvelope<T> | null = null;
		try {
			envelope = (await response.json()) as CloudflareEnvelope<T>;
		} catch {
			// Fall through to the status-based error below.
		}
		if (allowNotFound && response.status === 404) return undefined as T;
		if (!response.ok || envelope?.success === false) {
			const detail = envelope?.errors?.map((error) => error.message).filter(Boolean).join('; ');
			throw new Error(`Cloudflare ${method} ${path} failed (${response.status})${detail ? `: ${detail}` : ''}`);
		}
		return envelope?.result as T;
	}
}

export interface DomainServiceOptions {
	dns?: DnsResolver;
	/** `null` disables auto-records even if the environment is configured. */
	cloudflare?: CloudflareClient | null;
	/** Explicit Cloudflare settings; `null` disables. Defaults to `SKIFF_CLOUDFLARE_*`. */
	cloudflareConfig?: CloudflareConfig | null;
	/** Injectable fetch for the default Cloudflare client (tests never touch the network). */
	fetch?: FetchLike;
	/** Restricts automatic records to this zone; hostnames elsewhere fall back to manual DNS. */
	cloudflareZoneName?: string | null;
}

interface ExpectedRecord {
	type: 'CNAME' | 'A';
	name: string;
	value: string;
	/** The record for the attached hostname (the one whose Cloudflare id is stored). */
	primary: boolean;
}

interface RecordCheck {
	ok: boolean;
	detail: string | null;
}

/**
 * Custom domains (DESIGN §5, D31). A hostname only serves traffic after a TXT record proves control.
 * Once verified it reaches the nodes' desired state and Caddy obtains its certificate straight away
 * (reusing one already in storage), DNS-01 first so Cloudflare-proxied domains work. `approve()`
 * still answers the `ask` endpoint for agents that predate that change.
 *
 * When a Cloudflare token and zone are configured, CNAME/A records are created on attach, kept in
 * sync on check, and removed on delete. Records are grey-cloud (DNS only), and a non-address record
 * that happens to share the hostname is reported rather than overwritten.
 */
export class DomainService {
	private readonly dns: DnsResolver;
	private readonly cloudflare: CloudflareClient | null;
	private readonly cloudflareZoneName: string | null;

	constructor(
		private readonly ctx: CoreContext,
		options: DomainServiceOptions = {},
	) {
		this.dns = options.dns ?? nodeDnsResolver;
		if (options.cloudflare !== undefined) {
			this.cloudflare = options.cloudflare;
			this.cloudflareZoneName = options.cloudflareZoneName ?? null;
		} else {
			const config =
				options.cloudflareConfig === undefined ? cloudflareConfigFromEnv() : options.cloudflareConfig;
			this.cloudflare = config ? new HttpCloudflareClient(config, options.fetch) : null;
			this.cloudflareZoneName = options.cloudflareZoneName ?? config?.zoneName ?? null;
		}
	}

	view(row: DomainRow, project: ProjectRow): DomainView {
		const www = row.redirectWww ? `www.${row.hostname}` : null;
		return {
			id: row.id,
			projectId: row.projectId,
			projectSlug: project.slug,
			hostname: row.hostname,
			kind: row.kind,
			status: row.status,
			verification: row.verificationToken
				? { recordName: `${VERIFY_PREFIX}.${row.hostname}`, recordValue: `${TOKEN_PREFIX}${row.verificationToken}` }
				: null,
			redirectWww: row.redirectWww,
			wwwHostname: www,
			lastCheckedAt: row.lastCheckedAt ? new Date(row.lastCheckedAt).toISOString() : null,
			lastError: row.lastError,
			createdAt: new Date(row.createdAt).toISOString(),
			verifiedAt: row.verifiedAt ? new Date(row.verifiedAt).toISOString() : null,
		};
	}

	list(principal: Principal, project?: ProjectRow): DomainView[] {
		requirePermission(principal, 'domain:read');
		const rows = project
			? this.ctx.db.select().from(domains).where(eq(domains.projectId, project.id)).orderBy(desc(domains.createdAt)).all()
			: this.ctx.db
					.select()
					.from(domains)
					.where(eq(domains.orgId, principal.orgId))
					.orderBy(desc(domains.createdAt))
					.all();
		return rows.flatMap((row) => {
			const owner = this.projectById(row.projectId);
			return owner ? [this.view(row, owner)] : [];
		});
	}

	get(principal: Principal, id: string): DomainView {
		requirePermission(principal, 'domain:read');
		const row = this.requireRow(principal, id);
		const project = this.projectById(row.projectId);
		if (!project) throw new NotFoundError('Project');
		return this.view(row, project);
	}

	async create(principal: Principal, input: DomainCreateInput): Promise<DomainView> {
		requirePermission(principal, 'domain:create');
		const project = this.ctx.projects.requireRow(principal, input.project);
		const hostname = normalizeHostname(input.hostname);
		this.assertNotPlatformHost(hostname);
		const clash = this.ctx.db.select().from(domains).where(eq(domains.hostname, hostname)).get();
		if (clash) {
			const owner = this.projectById(clash.projectId);
			throw new ConflictError(
				owner?.id === project.id
					? `"${hostname}" is already attached to this project.`
					: `"${hostname}" is already attached to another project.`,
			);
		}
		const now = this.ctx.now();
		const apex = hostname.split('.').length === 2;
		let row: DomainRow = {
			id: newId('dom_'),
			orgId: project.orgId,
			projectId: project.id,
			hostname,
			kind: input.redirectWww || apex ? ('apex' as DomainKind) : 'custom',
			status: 'pending',
			verificationToken: randomToken(24),
			verifiedAt: null,
			redirectWww: input.redirectWww,
			cloudflareRecordId: null,
			lastCheckedAt: null,
			lastError: null,
			createdAt: now,
		};
		this.ctx.db.insert(domains).values(row).run();

		// Auto-records are a convenience: a Cloudflare/API failure must not lose the domain.
		const synced = await this.syncCloudflare(row, project);
		if (synced.recordId !== row.cloudflareRecordId || synced.error) {
			row = { ...row, cloudflareRecordId: synced.recordId, lastError: synced.error };
			this.ctx.db
				.update(domains)
				.set({ cloudflareRecordId: synced.recordId, lastError: synced.error })
				.where(eq(domains.id, row.id))
				.run();
		}

		this.ctx.audit.record({
			principal,
			action: 'domain.create',
			resource: 'domain',
			resourceId: row.id,
			args: { project: project.slug, hostname, redirectWww: input.redirectWww },
			result: 'ok',
		});
		this.ctx.projects.bump(project.orgId);
		return this.view(row, project);
	}

	/**
	 * Remove every domain of a project that is being hard-deleted, including the managed Cloudflare
	 * records (internal: the caller already checked permissions). Returns how many were removed.
	 */
	async removeForProject(project: ProjectRow): Promise<number> {
		const rows = this.ctx.db.select().from(domains).where(eq(domains.projectId, project.id)).all();
		for (const row of rows) await this.removeOrphan(row, project);
		return rows.length;
	}

	/** Remove one domain row and its managed records; `project` may already be gone (prune). */
	async removeOrphan(row: DomainRow, project: ProjectRow | null, operationId?: string): Promise<void> {
		await this.removeCloudflareRecords(row, project);
		this.ctx.db.delete(domains).where(eq(domains.id, row.id)).run();
		this.ctx.audit.record({
			orgId: row.orgId,
			action: 'domain.delete',
			resource: 'domain',
			resourceId: row.id,
			args: { hostname: row.hostname, reason: project?.deletedAt || !project ? 'project_purged' : 'removed' },
			result: 'ok',
			operationId,
		});
		this.ctx.projects.bump(row.orgId);
	}

	async remove(principal: Principal, id: string): Promise<void> {
		requirePermission(principal, 'domain:delete');
		const row = this.ctx.db.select().from(domains).where(and(eq(domains.id, id), eq(domains.orgId, principal.orgId))).get();
		if (!row) throw new NotFoundError('Domain');
		const project = this.projectById(row.projectId);
		await this.removeCloudflareRecords(row, project);
		this.ctx.db.delete(domains).where(eq(domains.id, id)).run();
		this.ctx.audit.record({
			principal,
			action: 'domain.delete',
			resource: 'domain',
			resourceId: id,
			args: { hostname: row.hostname },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
	}

	/** Re-check DNS; on success the domain moves to `verified` and is eligible for TLS. */
	async check(principal: Principal, id: string): Promise<DomainCheckResult> {
		requirePermission(principal, 'domain:read');
		const row = this.requireRow(principal, id);
		const project = this.projectById(row.projectId);
		if (!project) throw new NotFoundError('Project');
		if (!row.verificationToken)
			throw new ValidationError('This domain has no verification token; remove and re-add it.');
		return this.runCheck(row, project, principal);
	}

	/**
	 * Background re-checks (the maintenance sweep): pending domains every 10 minutes, failed ones
	 * every 6 hours, oldest first, so a domain verifies (or recovers) without anyone pressing
	 * Check, and one that never verifies is marked `failed`. Verified and active domains are only
	 * re-checked on request. Returns how many were checked.
	 */
	async recheckDue(): Promise<number> {
		const now = this.ctx.now();
		const due = this.ctx.db
			.select()
			.from(domains)
			.where(
				or(
					and(
						eq(domains.status, 'pending'),
						or(isNull(domains.lastCheckedAt), lt(domains.lastCheckedAt, now - DOMAIN_RECHECK_PENDING_MS)),
					),
					and(
						eq(domains.status, 'failed'),
						or(isNull(domains.lastCheckedAt), lt(domains.lastCheckedAt, now - DOMAIN_RECHECK_FAILED_MS)),
					),
				),
			)
			.orderBy(asc(domains.lastCheckedAt))
			.limit(RECHECK_BATCH)
			.all();
		let checked = 0;
		for (const row of due) {
			const project = this.projectById(row.projectId);
			if (!project || !row.verificationToken) continue;
			try {
				await this.runCheck(row, project);
				checked += 1;
			} catch (cause) {
				console.error(`[domains] background check of ${row.hostname} failed:`, cause);
			}
		}
		return checked;
	}

	/**
	 * The certificates a node's proxy reports serving (heartbeat `stats.certs`, probed with the
	 * hostname as SNI and matched against the certificate's names). A verified domain with a
	 * current certificate is `active`; an active one whose certificate has expired everywhere it
	 * is reported goes back to `verified` with the reason in `lastError`. Never throws into the
	 * heartbeat.
	 */
	applyServedCertificates(certs: ReadonlyArray<{ host: string; notAfter: string }>): void {
		const now = this.ctx.now();
		const current = new Set<string>();
		const expired = new Map<string, string>();
		for (const cert of certs) {
			const host = normalizeDnsName(cert.host);
			const notAfter = Date.parse(cert.notAfter);
			if (!host || host.startsWith('*.') || !Number.isFinite(notAfter)) continue;
			if (notAfter > now) current.add(host);
			else expired.set(host, cert.notAfter);
		}
		if (current.size > 0) {
			const rows = this.ctx.db
				.select()
				.from(domains)
				.where(and(inArray(domains.hostname, [...current]), eq(domains.status, 'verified')))
				.all();
			for (const row of rows) {
				// A drift note from the last check stays; a stale certificate note does not.
				const lastError = row.lastError?.startsWith('The certificate for ') ? null : row.lastError;
				this.ctx.db.update(domains).set({ status: 'active', lastError }).where(eq(domains.id, row.id)).run();
				this.recordStatus(row, 'active');
			}
		}
		const stale = [...expired.keys()].filter((host) => !current.has(host));
		if (stale.length > 0) {
			const rows = this.ctx.db
				.select()
				.from(domains)
				.where(and(inArray(domains.hostname, stale), eq(domains.status, 'active')))
				.all();
			if (rows.length === 0) return;
			// Another edge may still serve a current certificate; only demote when none does.
			const elsewhere = this.reportedCurrentCertificates(now);
			for (const row of rows) {
				if (elsewhere.has(row.hostname)) continue;
				this.ctx.db
					.update(domains)
					.set({
						status: 'verified',
						lastError: `The certificate for ${row.hostname} expired at ${expired.get(row.hostname)}. The proxy keeps trying to renew it; check that the hostname still points at Skiff.`,
					})
					.where(eq(domains.id, row.id))
					.run();
				this.recordStatus(row, 'verified');
			}
		}
	}

	/** Hostnames any node's latest heartbeat reports with a certificate that is still valid. */
	private reportedCurrentCertificates(now: number): Set<string> {
		const out = new Set<string>();
		for (const node of this.ctx.db.select({ statsJson: nodes.statsJson }).from(nodes).all()) {
			if (!node.statsJson) continue;
			try {
				const stats = JSON.parse(node.statsJson) as { certs?: Array<{ host?: unknown; notAfter?: unknown }> };
				for (const cert of stats.certs ?? [])
					if (typeof cert.host === 'string' && typeof cert.notAfter === 'string' && Date.parse(cert.notAfter) > now)
						out.add(normalizeDnsName(cert.host));
			} catch {
				/* malformed stats are ignored */
			}
		}
		return out;
	}

	private recordStatus(row: DomainRow, status: DomainStatus, principal?: Principal): void {
		this.ctx.audit.record({
			...(principal ? { principal } : { orgId: row.orgId }),
			action: 'domain.status',
			resource: 'domain',
			resourceId: row.id,
			args: { hostname: row.hostname, from: row.status, to: status },
			result: 'ok',
		});
	}

	/** One DNS check: TXT verification, traffic-record drift, Cloudflare sync, and the new status. */
	private async runCheck(row: DomainRow, project: ProjectRow, principal?: Principal): Promise<DomainCheckResult> {
		if (!row.verificationToken)
			throw new ValidationError('This domain has no verification token; remove and re-add it.');

		const recordName = `${VERIFY_PREFIX}.${row.hostname}`;
		const expected = `${TOKEN_PREFIX}${row.verificationToken}`;
		const now = this.ctx.now();
		let verified = false;
		let error: string | null = null;
		try {
			const records = await this.dns.resolveTxt(recordName);
			verified = records.some((parts) => parts.join('').trim() === expected);
			if (!verified) error = `TXT record ${recordName} does not contain ${expected}.`;
		} catch (cause) {
			error = `Could not read TXT record ${recordName}: ${errorText(cause)}`;
		}

		// Verification proves control; DNS drift is reported separately so a working TXT record is
		// never lost just because the traffic record is not in place yet.
		const drift = await this.checkExpectedRecords(row, project);
		let cloudflareRecordId = row.cloudflareRecordId;
		let cloudflareError: string | null = null;
		if (this.cloudflare) {
			const synced = await this.syncCloudflare(row, project);
			cloudflareRecordId = synced.recordId;
			cloudflareError = synced.error;
		}

		const problem = [drift, cloudflareError].filter((value): value is string => Boolean(value)).join(' ');
		const status = nextStatus(row, verified, now);
		const failing = status === 'failed' ? ` ${failedNote(row.hostname)}` : '';
		const lastError = verified ? (problem || null) : error ? `${error}${failing}` : null;
		const updated: DomainRow = {
			...row,
			cloudflareRecordId,
			status,
			verifiedAt: verified ? (row.verifiedAt ?? now) : row.verifiedAt,
			lastCheckedAt: now,
			lastError,
		};
		this.ctx.db
			.update(domains)
			.set({
				status: updated.status,
				verifiedAt: updated.verifiedAt,
				lastCheckedAt: updated.lastCheckedAt,
				lastError: updated.lastError,
				cloudflareRecordId: updated.cloudflareRecordId,
			})
			.where(eq(domains.id, row.id))
			.run();
		if (status !== row.status) this.recordStatus(row, status, principal);
		// Desired state carries served domains only: bump when that changes (or on request, so a
		// manual check also nudges the nodes).
		if (principal || SERVED_STATUSES.includes(status) !== SERVED_STATUSES.includes(row.status))
			this.ctx.projects.bump(row.orgId);

		const records = this.suggestedRecords(row, project);
		const detail = verified
			? problem
				? `Verified, but DNS needs attention: ${problem}`
				: status === 'active'
					? `Verified and serving over HTTPS.`
					: `Verified. ${row.hostname} gets its certificate within a minute if it does not already have one.`
			: (lastError ?? `Add TXT ${recordName} = ${expected}, then check again.`);
		return { domain: this.view(updated, project), detail, records };
	}

	/**
	 * Caddy on-demand TLS authorization. Only a verified hostname for a live project is approved,
	 * plus the `www.` sibling of one that redirects www (nodes serve that redirect over HTTPS too).
	 */
	approve(hostname: string): boolean {
		const host = normalizeDnsName(hostname);
		if (!host) return false;
		const servable = (row: DomainRow | undefined): boolean => {
			if (!row) return false;
			const project = this.projectById(row.projectId);
			return Boolean(project && !project.deletedAt);
		};
		const verified = (name: string): DomainRow | undefined =>
			this.ctx.db
				.select()
				.from(domains)
				.where(and(eq(domains.hostname, name), inArray(domains.status, SERVED_STATUSES)))
				.get();
		if (servable(verified(host))) return true;
		if (!host.startsWith('www.')) return false;
		const parent = verified(host.slice(4));
		return Boolean(parent?.redirectWww) && servable(parent);
	}

	/** Domains served by a set of projects (the node building routes), verified or active only. */
	desiredForProjects(projectIds: Iterable<string>): Array<{
		host: string;
		projectId: string;
		kind: DomainKind;
		redirectTo: string | null;
	}> {
		const ids = [...new Set(projectIds)];
		if (ids.length === 0) return [];
		const rows = this.ctx.db
			.select()
			.from(domains)
			.where(and(inArray(domains.projectId, ids), inArray(domains.status, SERVED_STATUSES)))
			.all();
		const out: Array<{ host: string; projectId: string; kind: DomainKind; redirectTo: string | null }> = [];
		for (const row of rows) {
			out.push({ host: row.hostname, projectId: row.projectId, kind: row.kind, redirectTo: null });
			if (row.redirectWww)
				out.push({ host: `www.${row.hostname}`, projectId: row.projectId, kind: row.kind, redirectTo: row.hostname });
		}
		return out;
	}

	private requireRow(principal: Principal, id: string): DomainRow {
		const row = this.ctx.db.select().from(domains).where(and(eq(domains.id, id), eq(domains.orgId, principal.orgId))).get();
		if (!row) throw new NotFoundError('Domain');
		return row;
	}

	private projectById(id: string): ProjectRow | null {
		const row = this.ctx.db
			.select()
			.from(projects)
			.where(and(eq(projects.id, id), isNull(projects.deletedAt)))
			.get();
		return (row as ProjectRow | undefined) ?? null;
	}

	private assertNotPlatformHost(hostname: string): void {
		const platform = new URL(this.ctx.config.platformOrigin).hostname.toLowerCase();
		const content = this.ctx.config.contentDomain.toLowerCase();
		const host = hostname.toLowerCase();
		if (host === platform || host.endsWith(`.${platform}`) || host === content || host.endsWith(`.${content}`))
			throw new ValidationError(
				`"${hostname}" is on the Skiff platform or content domain; add it as a project domain instead.`,
			);
	}

	/**
	 * Records the operator/Cloudflare must create. An apex/`www` pair gets both names; the content
	 * domain doubles as the CNAME target (Cloudflare flattens a root CNAME).
	 */
	private expectedRecords(row: DomainRow, project: ProjectRow): ExpectedRecord[] {
		const contentDomain = this.ctx.config.contentDomain.toLowerCase();
		const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(contentDomain);
		const target = isIp ? contentDomain : `${project.slug}.${contentDomain}`;
		const type: ExpectedRecord['type'] = isIp ? 'A' : 'CNAME';
		const records: ExpectedRecord[] = [{ type, name: row.hostname, value: target, primary: true }];
		if (row.redirectWww) records.push({ type, name: `www.${row.hostname}`, value: target, primary: false });
		return records;
	}

	private suggestedRecords(row: DomainRow, project: ProjectRow): DomainCheckResult['records'] {
		const records: DomainCheckResult['records'] = [];
		if (row.verificationToken)
			records.push({
				type: 'TXT',
				name: `${VERIFY_PREFIX}.${row.hostname}`,
				value: `${TOKEN_PREFIX}${row.verificationToken}`,
			});
		for (const record of this.expectedRecords(row, project))
			records.push({ type: record.type, name: record.name, value: record.value });
		return records;
	}

	/** Public-DNS drift: a missing or wrong CNAME/A is reported for every expected name. */
	private async checkExpectedRecords(row: DomainRow, project: ProjectRow): Promise<string | null> {
		const problems: string[] = [];
		for (const record of this.expectedRecords(row, project)) {
			const check = await this.checkRecord(record);
			if (!check.ok && check.detail) problems.push(check.detail);
		}
		return problems.length ? problems.join(' ') : null;
	}

	private async checkRecord(record: ExpectedRecord): Promise<RecordCheck> {
		const expected = normalizeDnsName(record.value);
		if (record.type === 'A') {
			try {
				const addresses = (await this.dns.resolve4(record.name)).map(normalizeDnsName);
				if (addresses.includes(expected)) return { ok: true, detail: null };
				return {
					ok: false,
					detail: addresses.length
						? `${record.name} resolves to ${addresses.join(', ')}; expected ${expected}.`
						: `No A record found for ${record.name}; expected ${expected}.`,
				};
			} catch (cause) {
				return { ok: false, detail: `Could not read A record ${record.name}: ${errorText(cause)}` };
			}
		}

		try {
			const targets = (await this.dns.resolveCname(record.name)).map(normalizeDnsName);
			if (targets.includes(expected)) return { ok: true, detail: null };
			if (targets.length)
				return {
					ok: false,
					detail: `${record.name} points at ${targets.join(', ')}; expected ${expected}.`,
				};
			// An apex CNAME is flattened by Cloudflare, so the resolver may only return A/AAAA.
			const flattened = await this.flattenedMatch(record.name, expected);
			if (flattened.ok) return flattened;
			return { ok: false, detail: `No CNAME record found for ${record.name}; point it at ${expected}.` };
		} catch (cause) {
			// ENODATA is expected while the record does not exist yet; report it as missing.
			const flattened = await this.flattenedMatch(record.name, expected);
			if (flattened.ok) return flattened;
			return {
				ok: false,
				detail: `No CNAME record found for ${record.name} (expected ${expected}): ${errorText(cause)}`,
			};
		}
	}

	/** Resolve both names and compare addresses; `ok: false` carries no detail to avoid noise. */
	private async flattenedMatch(name: string, expected: string): Promise<RecordCheck> {
		try {
			const [actual, target] = await Promise.all([this.dns.resolve4(name), this.dns.resolve4(expected)]);
			const wanted = new Set(target.map(normalizeDnsName));
			const matched = actual.map(normalizeDnsName).some((address) => wanted.has(address));
			return matched
				? { ok: true, detail: null }
				: { ok: false, detail: `${name} and ${expected} do not resolve to the same address.` };
		} catch {
			return { ok: false, detail: null };
		}
	}

	/** Keep the connected Cloudflare account in sync; never fatal to the domain operation. */
	private async syncCloudflare(
		row: DomainRow,
		project: ProjectRow,
	): Promise<{ recordId: string | null; error: string | null }> {
		const client = this.cloudflare;
		if (!client) return { recordId: row.cloudflareRecordId, error: null };
		const records = this.expectedRecords(row, project);
		if (!this.cloudflareApplies(records)) return { recordId: row.cloudflareRecordId, error: null };

		let recordId = row.cloudflareRecordId;
		const errors: string[] = [];
		let changed = false;
		for (const record of records) {
			const input = this.cloudflareInput(record);
			try {
				const existing = await client.findRecord(record.name);
				if (record.primary && recordId) {
					if (existing && sameRecord(existing, record)) continue;
					if (existing) {
						await client.updateRecord(recordId, input);
					} else {
						// The managed record disappeared out of band; create it again.
						const created = await client.createRecord(input);
						recordId = created.id;
					}
					changed = true;
					continue;
				}
				if (existing) {
					if (sameRecord(existing, record)) {
						if (record.primary) recordId = existing.id;
						if (record.primary && row.cloudflareRecordId !== existing.id) changed = true;
						continue;
					}
					if (isAddressRecord(existing.type)) {
						// Attaching a hostname claims its address record: update it to point at Skiff.
						await client.updateRecord(existing.id, input);
						if (record.primary) recordId = existing.id;
						changed = true;
						continue;
					}
					// Never replace a non-address record (TXT/MX/…) that happens to share the name.
					errors.push(`${record.name} already has a ${existing.type} record; expected ${record.type}.`);
					continue;
				}
				const created = await client.createRecord(input);
				if (record.primary) recordId = created.id;
				changed = true;
			} catch (cause) {
				errors.push(`${record.name}: ${errorText(cause)}`);
			}
		}

		const error = errors.length ? `Cloudflare: ${errors.join(' ')}` : null;
		if (!changed && !error) return { recordId, error: null };
		this.ctx.audit.record({
			orgId: row.orgId,
			action: 'domain.records',
			resource: 'domain',
			resourceId: row.id,
			args: {
				hostname: row.hostname,
				records: records.map((record) => `${record.type} ${record.name} -> ${record.value}`),
			},
			result: error ? 'error' : 'ok',
			error: error ?? undefined,
		});
		return { recordId, error };
	}

	private async removeCloudflareRecords(row: DomainRow, project: ProjectRow | null): Promise<void> {
		const client = this.cloudflare;
		if (!client) return;
		const records = project
			? this.expectedRecords(row, project)
			: [{ type: 'CNAME' as const, name: row.hostname, value: '', primary: true }];
		const errors: string[] = [];
		for (const record of records) {
			try {
				if (record.primary && row.cloudflareRecordId) {
					await client.deleteRecord(row.cloudflareRecordId);
					continue;
				}
				const existing = await client.findRecord(record.name);
				// Only delete a record whose value still matches ours.
				if (existing && (!record.value || sameRecord(existing, record, true)))
					await client.deleteRecord(existing.id);
			} catch (cause) {
				errors.push(`${record.name}: ${errorText(cause)}`);
			}
		}
		if (errors.length)
			this.ctx.audit.record({
				orgId: row.orgId,
				action: 'domain.records',
				resource: 'domain',
				resourceId: row.id,
				args: { hostname: row.hostname, operation: 'delete' },
				result: 'error',
				error: `Cloudflare: ${errors.join(' ')}`,
			});
	}

	/** Only manage records for the configured zone; other zones stay manual. */
	private cloudflareApplies(records: ExpectedRecord[]): boolean {
		const zone = this.cloudflareZoneName;
		if (!zone) return true;
		return records.every((record) => record.name === zone || record.name.endsWith(`.${zone}`));
	}

	private cloudflareInput(record: ExpectedRecord): CloudflareRecordInput {
		return {
			type: record.type,
			name: record.name,
			content: record.value,
			proxied: false,
			ttl: 1,
			comment: RECORD_COMMENT,
		};
	}
}

/**
 * The status after a DNS check. Once a domain has verified it stays served: the TXT record may be
 * removed after verification, so a later failed check only records the problem. A domain that
 * has never verified is `failed` once it is older than DOMAIN_FAIL_AFTER_MS.
 */
export function nextStatus(row: Pick<DomainRow, 'status' | 'verifiedAt' | 'createdAt'>, verified: boolean, now: number): DomainStatus {
	if (verified) return row.status === 'active' ? 'active' : 'verified';
	if (row.verifiedAt !== null || row.status === 'verified' || row.status === 'active') return row.status;
	return now - row.createdAt >= DOMAIN_FAIL_AFTER_MS ? 'failed' : 'pending';
}

function failedNote(hostname: string): string {
	return `${hostname} has not verified within ${DOMAIN_FAIL_AFTER_MS / HOUR_MS} hours of being added; Skiff re-checks it every ${DOMAIN_RECHECK_FAILED_MS / HOUR_MS} hours, or select Check DNS after fixing the record.`;
}

function normalizeDnsName(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, '');
}

function normalizeHostname(value: string): string {
	const host = normalizeDnsName(value);
	if (!HOSTNAME_PATTERN.test(host))
		throw new ValidationError('Enter a hostname like example.com or app.example.com (no scheme, port or path)');
	return host;
}

function sameRecord(record: CloudflareRecord, expected: ExpectedRecord, contentOnly = false): boolean {
	if (!contentOnly && record.type.toUpperCase() !== expected.type) return false;
	return normalizeDnsName(record.content) === normalizeDnsName(expected.value);
}

function isAddressRecord(type: string): boolean {
	return ['A', 'AAAA', 'CNAME'].includes(type.toUpperCase());
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
