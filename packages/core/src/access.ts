import { and, desc, eq, sql } from 'drizzle-orm';
import { deployments, projects, shareLinks, shareRedemptions } from '@skiff/db';
import {
	requirePermission,
	type Principal,
	type ShareLinkCreate,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError, ValidationError } from './errors.ts';
import { siteKeyFor } from './config.ts';
import {
	hashVisitor,
	parseJson,
	randomToken,
	sha256Hex,
	signAccessToken,
	verifyAccessToken,
	verifyPassword,
	type AccessTokenClaims,
} from './util.ts';
import type { ProjectRow } from './projects.ts';

export interface ShareLinkView {
	id: string;
	projectId: string;
	deploymentId: string | null;
	/** Clear-text URL, returned only once on creation; null in listings. */
	url: string | null;
	host: string;
	expiresAt: string | null;
	maxVisitors: number | null;
	maxRedemptions: number | null;
	redemptions: number;
	sessionTtlSeconds: number;
	allowedEmails: string[];
	note: string | null;
	revokedAt: string | null;
	createdAt: string;
}

export interface SiteVisit {
	host: string;
	project: ProjectRow;
	deploymentId: string;
	token: string;
	expiresAt: string;
}

/**
 * Protected sites and share links (DESIGN §6.4, D20, D21).
 *
 * The control plane authenticates the human and mints a short-lived, host-bound token; the agent
 * verifies that token and every later request statelessly with the per-project HMAC key. Platform
 * session cookies never reach the content domain.
 */
export class AccessService {
	constructor(private readonly ctx: CoreContext) {}

	view(row: typeof shareLinks.$inferSelect): ShareLinkView {
		const deployment = row.deploymentId
			? this.ctx.db.select().from(deployments).where(eq(deployments.id, row.deploymentId)).get()
			: undefined;
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, row.projectId)).get();
		const host = deployment?.previewHost ?? `${project?.slug ?? 'unknown'}.${this.ctx.config.contentDomain}`;
		return {
			id: row.id,
			projectId: row.projectId,
			deploymentId: row.deploymentId,
			url: null,
			host,
			expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
			maxVisitors: row.maxVisitors,
			maxRedemptions: row.maxRedemptions,
			redemptions: row.redemptions,
			sessionTtlSeconds: row.sessionTtlSeconds,
			allowedEmails: parseJson<string[]>(row.allowedEmailsJson, []),
			note: row.note,
			revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
			createdAt: new Date(row.createdAt).toISOString(),
		};
	}

	async createShareLink(principal: Principal, project: ProjectRow, input: Omit<ShareLinkCreate, 'project'>): Promise<ShareLinkView> {
		requirePermission(principal, 'shareLink:create');
		if (input.deploymentId) {
			const deployment = this.ctx.db
				.select()
				.from(deployments)
				.where(and(eq(deployments.id, input.deploymentId), eq(deployments.projectId, project.id)))
				.get();
			if (!deployment) throw new NotFoundError('Deployment');
		}
		const token = randomToken(32);
		const id = `shr_${crypto.randomUUID().replace(/-/g, '')}`;
		const now = this.ctx.now();
		const expiresAt = input.expiresAt ? Date.parse(input.expiresAt) : null;
		if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now))
			throw new ValidationError('expiresAt must be in the future.');
		this.ctx.db
			.insert(shareLinks)
			.values({
				id,
				orgId: project.orgId,
				projectId: project.id,
				deploymentId: input.deploymentId ?? null,
				tokenHash: sha256Hex(token),
				expiresAt,
				maxVisitors: input.maxVisitors ?? null,
				maxRedemptions: input.maxRedemptions ?? null,
				sessionTtlSeconds: input.sessionTtlSeconds ?? 3600,
				allowedEmailsJson: JSON.stringify(input.allowedEmails ?? []),
				note: input.note ?? null,
				createdBy: principal.userId,
				createdAt: now,
			})
			.run();
		const row = this.ctx.db.select().from(shareLinks).where(eq(shareLinks.id, id)).get()!;
		this.ctx.audit.record({
			principal,
			action: 'share_link.create',
			resource: 'shareLink',
			resourceId: id,
			args: { project: project.slug, ...input, token: '[redacted]' },
			result: 'ok',
		});
		// The clear-text token is returned once; the view embeds a non-reversible suffix.
		const view = this.view(row);
		view.url = `https://${view.host}/?_skiff_share=${token}`;
		return view;
	}

	listShareLinks(principal: Principal, project: ProjectRow): ShareLinkView[] {
		requirePermission(principal, 'shareLink:read');
		return this.ctx.db
			.select()
			.from(shareLinks)
			.where(and(eq(shareLinks.orgId, principal.orgId), eq(shareLinks.projectId, project.id)))
			.orderBy(desc(shareLinks.createdAt))
			.all()
			.map((row) => this.view(row));
	}

	async revokeShareLink(principal: Principal, project: ProjectRow, id: string): Promise<void> {
		requirePermission(principal, 'shareLink:revoke');
		const row = this.ctx.db
			.select()
			.from(shareLinks)
			.where(and(eq(shareLinks.id, id), eq(shareLinks.projectId, project.id)))
			.get();
		if (!row) throw new NotFoundError('Share link');
		const now = this.ctx.now();
		this.ctx.db.update(shareLinks).set({ revokedAt: now }).where(eq(shareLinks.id, id)).run();
		this.ctx.db.update(shareRedemptions).set({ revokedAt: now }).where(eq(shareRedemptions.shareLinkId, id)).run();
		this.ctx.projects.bump(project.orgId);
		this.ctx.audit.record({
			principal,
			action: 'share_link.revoke',
			resource: 'shareLink',
			resourceId: id,
			args: { project: project.slug },
			result: 'ok',
		});
	}

	async revokeSession(principal: Principal, project: ProjectRow, sessionId: string): Promise<void> {
		requirePermission(principal, 'shareLink:revoke');
		this.ctx.db
			.update(shareRedemptions)
			.set({ revokedAt: this.ctx.now() })
			.where(and(eq(shareRedemptions.id, sessionId)))
			.run();
		this.ctx.projects.bump(project.orgId);
	}

	/** Resolve a content hostname to the project + deployment it serves. */
	resolveHost(host: string): { project: ProjectRow; deploymentId: string; production: boolean } | null {
		const cleanHost = host.split(':')[0]!.toLowerCase();
		const deployment = this.ctx.db
			.select()
			.from(deployments)
			.where(and(eq(deployments.previewHost, cleanHost), eq(deployments.status, 'active')))
			.get();
		if (deployment) {
			const project = this.ctx.db.select().from(projects).where(eq(projects.id, deployment.projectId)).get() as ProjectRow | undefined;
			if (project && !project.deletedAt) return { project, deploymentId: deployment.id, production: false };
		}
		const suffix = `.${this.ctx.config.contentDomain}`;
		if (!cleanHost.endsWith(suffix)) return null;
		const slug = cleanHost.slice(0, -suffix.length);
		const project = this.ctx.db
			.select()
			.from(projects)
			.where(and(eq(projects.slug, slug), sql`${projects.deletedAt} IS NULL`))
			.get() as ProjectRow | undefined;
		if (!project?.productionDeploymentId) return null;
		return { project, deploymentId: project.productionDeploymentId, production: true };
	}

	/** A logged-in platform user visiting a `platform`-mode site. */
	platformAccess(principal: Principal, host: string): SiteVisit {
		const resolved = this.resolveHost(host);
		if (!resolved) throw new NotFoundError('Site');
		if (resolved.project.orgId !== principal.orgId) throw new NotFoundError('Site');
		return this.mint(resolved.project, host, principal.userId, 'platform', 60 * 60, undefined, resolved.deploymentId);
	}

	/** Password mode: verified on the control plane, then bound to the host. */
	passwordAccess(host: string, password: string): SiteVisit {
		const resolved = this.resolveHost(host);
		if (!resolved) throw new NotFoundError('Site');
		const row = this.ctx.db.select().from(projects).where(eq(projects.id, resolved.project.id)).get();
		if (!verifyPassword(password, row?.accessSecretHash))
			throw new CoreError('invalid_password', 'Incorrect password', 403);
		return this.mint(
			resolved.project,
			host,
			`password:${resolved.project.id}`,
			'password',
			12 * 60 * 60,
			undefined,
			resolved.deploymentId,
		);
	}

	/**
	 * Redeem a share link. A visit is a redemption, not a page load (D21); the counter update is
	 * conditional so concurrent requests cannot exceed the cap.
	 */
	shareAccess(rawToken: string, request: { ip: string; userAgent: string; email?: string }): SiteVisit {
		const tokenHash = sha256Hex(rawToken);
		const link = this.ctx.db.select().from(shareLinks).where(eq(shareLinks.tokenHash, tokenHash)).get();
		if (!link || link.revokedAt) throw new NotFoundError('Share link');
		const now = this.ctx.now();
		if (link.expiresAt !== null && link.expiresAt < now) throw new CoreError('link_expired', 'This share link has expired', 410);
		const allowed = parseJson<string[]>(link.allowedEmailsJson, []);
		if (allowed.length > 0) {
			if (!request.email || !allowed.includes(request.email.toLowerCase()))
				throw new CoreError('email_not_allowed', 'This share link is restricted to specific email addresses', 403);
		}
		const visitorHash = hashVisitor(this.ctx.config.siteCookieSecret, request.ip, request.userAgent);
		const distinctVisitors = this.ctx.db
			.select({ count: sql<number>`count(distinct ${shareRedemptions.visitorHash})` })
			.from(shareRedemptions)
			.where(eq(shareRedemptions.shareLinkId, link.id))
			.get();
		if (link.maxVisitors !== null && (distinctVisitors?.count ?? 0) >= link.maxVisitors)
			throw new CoreError('visitor_limit', 'This share link has reached its visitor limit', 410);

		const redemptionId = `red_${crypto.randomUUID().replace(/-/g, '')}`;
		const expiresAt = now + link.sessionTtlSeconds * 1000;
		const changed = this.ctx.sqlite.transaction(() => {
			const result = this.ctx.sqlite.run(
				'UPDATE share_links SET redemptions = redemptions + 1 WHERE id = ? AND (max_redemptions IS NULL OR redemptions < max_redemptions)',
				[link.id],
			);
			if (result.changes === 0) return false;
			this.ctx.sqlite.run(
				'INSERT INTO share_redemptions (id, share_link_id, visitor_hash, email, redeemed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
				[redemptionId, link.id, visitorHash, request.email ?? null, now, expiresAt],
			);
			return true;
		})();
		if (!changed) throw new CoreError('redemption_limit', 'This share link has reached its redemption limit', 410);

		const project = this.ctx.db.select().from(projects).where(eq(projects.id, link.projectId)).get() as ProjectRow | undefined;
		if (!project) throw new NotFoundError('Project');
		const deployment = link.deploymentId
			? this.ctx.db.select().from(deployments).where(eq(deployments.id, link.deploymentId)).get()
			: undefined;
		const host = deployment?.previewHost ?? `${project.slug}.${this.ctx.config.contentDomain}`;
		return this.mint(
			project,
			host,
			visitorHash,
			'share',
			Math.floor(link.sessionTtlSeconds),
			redemptionId,
			deployment?.id ?? project.productionDeploymentId ?? '',
		);
	}

	/** Mint a host-bound token the agent can verify with the project's site key. */
	private mint(
		project: ProjectRow,
		host: string,
		subject: string,
		kind: AccessTokenClaims['kind'],
		ttlSeconds: number,
		sessionId?: string,
		deploymentId?: string,
	): SiteVisit {
		const siteKey = siteKeyFor(this.ctx.config.siteCookieSecret, project.id);
		const exp = Math.floor(this.ctx.now() / 1000) + ttlSeconds;
		const token = signAccessToken(siteKey, { host, exp, sub: subject, kind, sid: sessionId });
		return {
			host,
			project,
			deploymentId: deploymentId ?? project.productionDeploymentId ?? '',
			token,
			expiresAt: new Date(exp * 1000).toISOString(),
		};
	}

	/** The agent's callback validates the token against the same per-project key. */
	verifySiteToken(projectId: string, token: string): AccessTokenClaims | null {
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!project) return null;
		return verifyAccessToken(siteKeyFor(this.ctx.config.siteCookieSecret, project.id), token);
	}

	revocations(): Array<{ id: string; kind: 'shareLink' | 'session'; revokedAt: string }> {
		const now = this.ctx.now();
		const links = this.ctx.db.select().from(shareLinks).where(sql`${shareLinks.revokedAt} IS NOT NULL`).all();
		const sessions = this.ctx.db.select().from(shareRedemptions).where(sql`${shareRedemptions.revokedAt} IS NOT NULL`).all();
		return [
			...links.flatMap((row) =>
				row.revokedAt ? [{ id: row.id, kind: 'shareLink' as const, revokedAt: new Date(row.revokedAt).toISOString() }] : [],
			),
			...sessions.flatMap((row) =>
				row.revokedAt ? [{ id: row.id, kind: 'session' as const, revokedAt: new Date(row.revokedAt).toISOString() }] : [],
			),
		].filter((item) => Date.parse(item.revokedAt) > now - 7 * 86_400_000);
	}
}

