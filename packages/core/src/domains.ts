import { resolveTxt } from 'node:dns/promises';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { domains, projects } from '@skiff/db';
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
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { newId, randomToken } from './util.ts';
import type { ProjectRow } from './projects.ts';

export type DomainRow = typeof domains.$inferSelect;

const VERIFY_PREFIX = '_skiff';
const TOKEN_PREFIX = 'skiff-verify=';

/**
 * Custom domains (DESIGN §5). A hostname only serves traffic after a TXT record proves control;
 * Caddy's on-demand TLS `ask` endpoint consults `approve()` before issuing a certificate.
 *
 * Automatic Cloudflare records and apex↔www drift detection are layered on by the domains
 * workstream; this base is enough for manual verification and on-demand TLS to work end to end.
 */
export class DomainService {
	constructor(private readonly ctx: CoreContext) {}

	view(row: DomainRow, project: ProjectRow): DomainView {
		const www = row.kind === 'apex' || row.redirectWww ? `www.${row.hostname}` : null;
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

	create(principal: Principal, input: DomainCreateInput): DomainView {
		requirePermission(principal, 'domain:create');
		const project = this.ctx.projects.requireRow(principal, input.project);
		this.assertNotPlatformHost(input.hostname);
		const clash = this.ctx.db.select().from(domains).where(eq(domains.hostname, input.hostname)).get();
		if (clash) {
			const owner = this.projectById(clash.projectId);
			throw new ConflictError(
				owner?.id === project.id
					? `"${input.hostname}" is already attached to this project.`
					: `"${input.hostname}" is already attached to another project.`,
			);
		}
		const now = this.ctx.now();
		const apex = input.hostname.split('.').length === 2;
		const row: DomainRow = {
			id: newId('dom_'),
			orgId: project.orgId,
			projectId: project.id,
			hostname: input.hostname,
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
		this.ctx.audit.record({
			principal,
			action: 'domain.create',
			resource: 'domain',
			resourceId: row.id,
			args: { project: project.slug, hostname: input.hostname, redirectWww: input.redirectWww },
			result: 'ok',
		});
		this.ctx.projects.bump(project.orgId);
		return this.view(row, project);
	}

	remove(principal: Principal, id: string): void {
		requirePermission(principal, 'domain:delete');
		const row = this.ctx.db.select().from(domains).where(and(eq(domains.id, id), eq(domains.orgId, principal.orgId))).get();
		if (!row) throw new NotFoundError('Domain');
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

		const recordName = `${VERIFY_PREFIX}.${row.hostname}`;
		const expected = `${TOKEN_PREFIX}${row.verificationToken}`;
		const now = this.ctx.now();
		let verified = false;
		let error: string | null = null;
		try {
			const records = await resolveTxt(recordName);
			verified = records.some((parts) => parts.join('').trim() === expected);
			if (!verified) error = `TXT record ${recordName} does not contain ${expected}.`;
		} catch (cause) {
			error = `Could not read TXT record ${recordName}: ${cause instanceof Error ? cause.message : String(cause)}`;
		}

		const status: DomainStatus = verified ? 'verified' : row.verifiedAt ? row.status : 'pending';
		this.ctx.db
			.update(domains)
			.set({
				status,
				verifiedAt: verified ? (row.verifiedAt ?? now) : row.verifiedAt,
				lastCheckedAt: now,
				lastError: verified ? null : error,
			})
			.where(eq(domains.id, row.id))
			.run();
		const updated = { ...row, status, verifiedAt: verified ? (row.verifiedAt ?? now) : row.verifiedAt, lastCheckedAt: now, lastError: verified ? null : error };
		this.ctx.projects.bump(row.orgId);
		return {
			domain: this.view(updated, project),
			detail: verified
				? `Verified. Caddy will issue a certificate for ${row.hostname} on first request.`
				: (error ?? `Add TXT ${recordName} = ${expected}, then check again.`),
			records: [
				{ type: 'TXT', name: recordName, value: expected },
				{ type: 'CNAME', name: row.hostname, value: `${project.slug}.${this.ctx.config.contentDomain}` },
			],
		};
	}

	/** Caddy on-demand TLS authorization. Only a verified hostname for a live project is approved. */
	approve(hostname: string): boolean {
		const host = hostname.trim().toLowerCase().replace(/\.$/, '');
		const row = this.ctx.db
			.select()
			.from(domains)
			.where(and(eq(domains.hostname, host), inArray(domains.status, ['verified', 'active'])))
			.get();
		if (!row) return false;
		const project = this.projectById(row.projectId);
		return Boolean(project && !project.deletedAt);
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
			.where(and(inArray(domains.projectId, ids), or(eq(domains.status, 'verified'), eq(domains.status, 'active'))))
			.all();
		const out: Array<{ host: string; projectId: string; kind: DomainKind; redirectTo: string | null }> = [];
		for (const row of rows) {
			out.push({ host: row.hostname, projectId: row.projectId, kind: row.kind, redirectTo: null });
			if (row.kind === 'apex' && row.redirectWww)
				out.push({ host: `www.${row.hostname}`, projectId: row.projectId, kind: row.kind, redirectTo: row.hostname });
		}
		return out;
	}

	/** Internal: mark a verified domain active once the agent has converged its route. */
	markActive(projectId: string): void {
		this.ctx.db
			.update(domains)
			.set({ status: 'active' })
			.where(and(eq(domains.projectId, projectId), eq(domains.status, 'verified')))
			.run();
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
		if (host === platform || host === content || host.endsWith(`.${content}`))
			throw new ValidationError(
				`"${hostname}" is on the Skiff platform or content domain; add it as a project domain instead.`,
			);
	}
}
