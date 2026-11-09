import { generateKeyPairSync } from 'node:crypto';
import { resolveMx } from 'node:dns/promises';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import MailComposer from 'nodemailer/lib/mail-composer';
import {
	emailAccessRequests,
	emailAddresses,
	emailCredentials,
	emailDomains,
	emailMessages,
	emailOrgs,
	emailOutbox,
	emailRecipients,
	emailSuppressions,
	nodes,
	projects,
} from '@yoal/db';
import {
	EMAIL_ACCESS_REQUEST_ID_PREFIX,
	EMAIL_ACTIVE_DEFAULT_LIMITS,
	EMAIL_ADDRESS_ID_PREFIX,
	EMAIL_CREDENTIAL_ID_PREFIX,
	EMAIL_DOMAIN_ID_PREFIX,
	EMAIL_MESSAGE_ID_PREFIX,
	EMAIL_OUTBOX_TTL_SECONDS,
	EMAIL_REPUTATION,
	EMAIL_SANDBOX_ADDRESS_LIMITS,
	EMAIL_SANDBOX_LIMITS,
	EMAIL_USERNAME_PREFIX,
	HARD_BOUNCE_CLASSES,
	authorizeSend,
	brokerEnvPrefixSchema,
	dkimRecordName,
	dkimRecordValue,
	dkimSelector,
	emailAccessRequestCreateSchema,
	emailAccessRequestDecisionSchema,
	emailCredentialCreateSchema,
	emailDomainCreateSchema,
	emailDomainNameSchema,
	emailDomainUpdateSchema,
	emailEnvNames,
	emailSendBatchEnvelopeSchema,
	emailOrgStateUpdateSchema,
	emailSandboxAddressCreateSchema,
	emailSendSchema,
	emailSuppressionCreateSchema,
	mailHostnames,
	mergeSpf,
	normalizeAddress,
	parseAddress,
	recipientAddress,
	spfInclude,
	spfIncludes,
	suggestedDmarc,
	type EmailAccessRequestStatus,
	type EmailAccessRequestView,
	type EmailCredentialSecret,
	type EmailCredentialView,
	type EmailDnsRecord,
	type EmailDomainCreate,
	type EmailDomainView,
	type EmailEvent,
	type EmailEventKind,
	type EmailMessageView,
	type EmailOrgState,
	type EmailOrgView,
	type EmailPolicyOrg,
	type EmailRecordCheck,
	type EmailSandboxAddressView,
	type EmailSend,
	type EmailSendInput,
	type EmailSendResult,
	type EmailSuppressionReason,
	type EmailSuppressionView,
	type MailDesired,
	type MailHostnames,
	type MailInject,
	type MailState,
	type Principal,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { resolveTxtRecords } from './dns-txt.ts';
import type { CloudflareClient, CloudflareRecordInput } from './domains.ts';
import { ConflictError, CoreError, NotFoundError, QuotaError, RateLimitError, ValidationError } from './errors.ts';
import { buildSystemPrincipal } from './iam/system.ts';
import type { ProjectRow } from './projects.ts';
import { hashPassword, newId, parseJson, randomToken, sha256Hex } from './util.ts';

/**
 * Email: Yoal's self-hosted SES (docs/EMAIL.md, D114–D120).
 *
 * The control plane owns tenancy: domains and their DKIM keys, credentials, the org's sending
 * state, suppression lists, the outbox and the message log. `yoal-mail` on the mail node owns the
 * queue; the node agent bridges the two (`stateForNode`, `claimOutbox`, `ingestEvents`).
 */

export type EmailDomainRow = typeof emailDomains.$inferSelect;
export type EmailCredentialRow = typeof emailCredentials.$inferSelect;
type EmailAddressRow = typeof emailAddresses.$inferSelect;
type EmailAccessRequestRow = typeof emailAccessRequests.$inferSelect;

/** DNS lookups Email needs; tests inject a fake so they never touch the network. */
export interface EmailDnsResolver {
	resolveTxt(name: string): Promise<string[][]>;
	resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
}

export const nodeEmailDnsResolver: EmailDnsResolver = { resolveTxt: resolveTxtRecords, resolveMx };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** A routable IPv4: not private, loopback, link-local, CGNAT (Tailscale), multicast or reserved. */
export function isPublicIpv4(value: string): boolean {
	const match = IPV4.exec(value);
	if (!match) return false;
	const [a, b] = match.slice(1, 3).map(Number) as [number, number];
	if (match.slice(1).some((part) => Number(part) > 255)) return false;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	return true;
}

export interface EmailServiceOptions {
	dns?: EmailDnsResolver;
	/** The platform's Cloudflare client (the domains one); null disables automatic records. */
	cloudflare?: CloudflareClient | null;
	cloudflareZoneName?: string | null;
	/** Install-time default for the mail domain (`YOAL_MAIL_DOMAIN`); the dashboard setting wins. */
	mailDomain?: string | null;
}

/** The capability a node must advertise before it is made the mail node. */
const MAIL_CAPABILITY = 'mail';
const SETTINGS = {
	node: 'email.node_id',
	ip: 'email.ipv4',
	paused: 'email.paused',
	generation: 'email.generation',
	domain: 'email.mail_domain',
	platformDkim: 'email.platform_dkim',
} as const;
/**
 * The platform's own sender on the mail node (sandbox verification mail): `no-reply@<mail domain>`,
 * signed with a platform DKIM key. `'*'` is the platform's org id in the pushed state, as for the
 * platform suppression list.
 */
const PLATFORM_MAIL_ORG = '*';
const PLATFORM_KEY_ORG = 'platform';
const PLATFORM_SENDER_LOCAL = 'no-reply';
const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
/** A claimed outbox row the agent never acknowledged is handed out again after this. */
const CLAIM_TIMEOUT_MS = 60_000;
/** Unverified records keep sending for this long before the domain pauses (EMAIL.md §4.1). */
const FAILING_GRACE_MS = 72 * 3_600_000;
const RECORD_COMMENT = 'yoal-email';
/** The public page a sandbox recipient opens from the verification mail (EMAIL.md §4.3). */
export const SANDBOX_VERIFY_PATH = '/verify-email-address';
const DEFAULT_ENV_PREFIX = 'SMTP';

/** Where the mail domain came from: the dashboard setting, `YOAL_MAIL_DOMAIN`, or the content domain. */
export type MailDomainSource = 'custom' | 'env' | 'content';

/**
 * Mail hostnames (`mx1.`, `mx.`, `smtp.`, `bounces.`, `_spf.`) hang off one domain: a custom one
 * (the dashboard setting, else `YOAL_MAIL_DOMAIN`), else the content domain. A content domain
 * that is no domain name (`localhost`, an IP) falls back to the platform host's parent.
 */
export function mailDomainFor(
	contentDomain: string,
	platformOrigin: string,
	custom?: { setting?: string | null; env?: string | null },
): { domain: string; source: MailDomainSource } {
	if (custom?.setting) return { domain: custom.setting.toLowerCase(), source: 'custom' };
	if (custom?.env) return { domain: custom.env.toLowerCase(), source: 'env' };
	const content = contentDomain.trim().toLowerCase();
	if (emailDomainNameSchema.safeParse(content).success) return { domain: content, source: 'content' };
	const host = new URL(platformOrigin).hostname.toLowerCase();
	const labels = host.split('.');
	return { domain: labels.length > 2 ? labels.slice(1).join('.') : host, source: 'content' };
}

/** A custom mail domain as typed: a bare name or a URL (`https://mail.example.com/`). */
export function parseMailDomain(value: string): string {
	let host = value.trim();
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
		try {
			host = new URL(host).hostname;
		} catch {
			throw new ValidationError(`${value} is not a domain name or URL.`);
		}
	}
	const parsed = emailDomainNameSchema.safeParse(host.replace(/\.$/, ''));
	if (!parsed.success) throw new ValidationError(`${value} is not a domain name. Use one such as mail.example.com.`);
	return parsed.data;
}

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();
const iso = (value: number | null | undefined) => (value === null || value === undefined ? null : new Date(value).toISOString());

const KIND_RANK: Record<EmailEventKind, number> = {
	accepted: 0,
	deferred: 1,
	delivered: 2,
	suppressed: 2,
	rejected: 3,
	dropped: 3,
	bounced: 4,
	complained: 5,
	received: 0,
};

export class EmailService {
	private readonly dns: EmailDnsResolver;
	private readonly cloudflare: CloudflareClient | null;
	private readonly zoneName: string | null;
	private readonly envMailDomain: string | null;

	constructor(
		private readonly ctx: CoreContext,
		options: EmailServiceOptions = {},
	) {
		this.dns = options.dns ?? nodeEmailDnsResolver;
		this.cloudflare = options.cloudflare ?? null;
		this.zoneName = options.cloudflareZoneName?.toLowerCase() ?? null;
		this.envMailDomain = options.mailDomain?.trim().toLowerCase() || null;
	}

	// ------------------------------------------------------------------ platform settings

	private resolvedMailDomain(): { domain: string; source: MailDomainSource } {
		return mailDomainFor(this.ctx.config.contentDomain, this.ctx.config.platformOrigin, {
			setting: this.setting(SETTINGS.domain),
			env: this.envMailDomain,
		});
	}

	mailDomain(): string {
		return this.resolvedMailDomain().domain;
	}

	hostnames(): MailHostnames {
		return mailHostnames(this.mailDomain());
	}

	private setting(key: string): string | null {
		const row = this.ctx.sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key);
		return row?.value ?? null;
	}

	private setSetting(key: string, value: string | null): void {
		if (value === null) {
			this.ctx.sqlite.run('DELETE FROM settings WHERE key = ?', [key]);
			return;
		}
		this.ctx.sqlite.run(
			'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
			[key, value, this.ctx.now()],
		);
	}

	settings(): {
		nodeId: string | null;
		/** The mail node's public IPv4: what the A, SPF and PTR records name. */
		ip: string | null;
		paused: boolean;
		generation: number;
		mailDomain: string;
		/** `content` when the mail domain follows the content domain, else where the custom one is set. */
		mailDomainSource: MailDomainSource;
		/** The content domain the mail domain follows when no custom one is set. */
		contentDomain: string;
		hostnames: MailHostnames;
	} {
		const mail = this.resolvedMailDomain();
		return {
			nodeId: this.setting(SETTINGS.node),
			ip: this.setting(SETTINGS.ip),
			paused: this.setting(SETTINGS.paused) === '1',
			generation: Number(this.setting(SETTINGS.generation) ?? 0),
			mailDomain: mail.domain,
			mailDomainSource: mail.source,
			contentDomain: this.ctx.config.contentDomain,
			hostnames: mailHostnames(mail.domain),
		};
	}

	/** Anything the mail node's state depends on changed: bump the generation and desired state. */
	private bumpMail(): void {
		this.setSetting(SETTINGS.generation, String(this.settings().generation + 1));
		this.ctx.nodes.bump();
	}

	private requireFeature(): void {
		if (!featureEnabled(this.ctx.config, 'EMAIL'))
			throw new CoreError('feature_disabled', 'Email is turned off on this platform (YOAL_FEATURE_EMAIL=0).', 403);
	}

	/**
	 * Choose (or clear) the mail node, its sending IPv4, the mail domain and the global pause.
	 * Platform admins only. `mailDomain: null` puts the mail hostnames back on the content domain.
	 * `nodes.public_address` is the WireGuard upstream the edge proxies to, so the edge never has
	 * one; the sending IP is its own setting. Left out, it is kept for the same node or found as
	 * `detectIp` explains; otherwise the admin has to enter it.
	 */
	async configure(
		principal: Principal,
		input: { nodeId?: string | null; ip?: string | null; paused?: boolean; mailDomain?: string | null },
	): Promise<ReturnType<EmailService['settings']>> {
		if (!this.ctx.platformIam.canAdminister(principal)) throw new CoreError('forbidden', 'Only a platform admin role can configure email.', 403);
		this.requireFeature();
		const current = this.settings();
		let mailDomain: string | null | undefined;
		if (input.mailDomain !== undefined) {
			mailDomain = input.mailDomain === null || input.mailDomain.trim() === '' ? null : parseMailDomain(input.mailDomain);
			// The content domain itself is the default, not a custom setting.
			if (mailDomain === this.ctx.config.contentDomain.toLowerCase()) mailDomain = null;
			const next = mailDomainFor(this.ctx.config.contentDomain, this.ctx.config.platformOrigin, { setting: mailDomain, env: this.envMailDomain }).domain;
			const bounce = mailHostnames(next).bounce;
			const clash = this.ctx.db
				.select({ name: emailDomains.name })
				.from(emailDomains)
				.all()
				.find((row) => row.name === next || row.name === bounce || row.name.endsWith(`.${bounce}`));
			if (clash) throw new ValidationError(`${clash.name} is an organisation's sending domain, so it can't hold the platform's mail hostnames.`);
		}
		const domainChanged = mailDomain !== undefined && mailDomain !== this.setting(SETTINGS.domain);
		const nodeId = input.nodeId !== undefined ? input.nodeId : current.nodeId;
		const touchesNode = input.nodeId !== undefined || input.ip !== undefined;
		let ip: string | null = null;
		if (touchesNode && nodeId !== null) {
			const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
			if (!node) throw new NotFoundError(`Node ${nodeId} not found.`);
			const capabilities = parseJson<string[]>(node.capabilitiesJson, []);
			if (!capabilities.includes(MAIL_CAPABILITY))
				throw new ValidationError(`Node "${node.name}" runs an agent without mail support; update its agent first.`);
			const given = input.ip?.trim() || null;
			if (given && !isPublicIpv4(given))
				throw new ValidationError(`${given} is not a public IPv4 address. Receivers check the PTR of a public IPv4.`);
			ip = given ?? (nodeId === current.nodeId ? current.ip : null) ?? (await this.detectIp(node));
			if (!ip)
				throw new ValidationError(
					`Couldn't find a public IPv4 for "${node.name}". Enter the IP it sends from (the one its provider sets the PTR on).`,
				);
		}
		if (touchesNode) {
			this.setSetting(SETTINGS.node, nodeId);
			this.setSetting(SETTINGS.ip, ip);
		}
		if (input.paused !== undefined) this.setSetting(SETTINGS.paused, input.paused ? '1' : null);
		if (domainChanged) this.setSetting(SETTINGS.domain, mailDomain ?? null);
		this.bumpMail();
		this.ctx.audit.record({
			principal,
			action: 'email.configure',
			resource: 'email',
			resourceId: 'platform',
			args: { ...input, ip, ...(mailDomain !== undefined ? { mailDomain } : {}) },
			result: 'ok',
		});
		const nodeSet = touchesNode ? nodeId : current.nodeId;
		if ((touchesNode || domainChanged) && nodeSet) await this.publishPlatformRecords().catch(() => undefined);
		return this.settings();
	}

	/**
	 * The node's public IPv4 when Yoal can tell it without guessing: a public IPv4 in its address,
	 * or for the edge, the zone's own A record for the platform host. Public DNS is not asked: a
	 * proxied platform host resolves to Cloudflare's IPs, and the control-plane unit cannot read
	 * interfaces (no AF_NETLINK).
	 */
	private async detectIp(node: { mode: string; publicAddress: string | null }): Promise<string | null> {
		const host = node.publicAddress?.replace(/:\d+$/, '') ?? '';
		if (isPublicIpv4(host)) return host;
		const platformHost = new URL(this.ctx.config.platformOrigin).hostname;
		if (node.mode !== 'edge' || !this.cloudflare || !this.inZone(platformHost)) return null;
		const record = await this.cloudflare.findRecord(platformHost).catch(() => null);
		return record?.type === 'A' && isPublicIpv4(record.content) ? record.content : null;
	}

	/** The platform records the mail node needs (EMAIL.md §3.3), as values to publish or show. */
	platformRecords(): Array<{ type: 'A' | 'TXT' | 'MX'; name: string; value: string; priority?: number }> {
		const { nodeId, ip: stored, hostnames: names } = this.settings();
		const ip = nodeId ? stored : null;
		const records: Array<{ type: 'A' | 'TXT' | 'MX'; name: string; value: string; priority?: number }> = [];
		if (ip) {
			for (const name of [names.helo, names.mx, names.submission]) records.push({ type: 'A', name, value: ip });
			records.push({ type: 'TXT', name: names.spf, value: `v=spf1 ip4:${ip} -all` });
		}
		records.push({ type: 'MX', name: names.bounce, value: names.mx, priority: 10 });
		records.push({ type: 'TXT', name: names.bounce, value: `v=spf1 ${spfInclude(this.mailDomain())} -all` });
		if (nodeId) {
			const key = this.platformDkim();
			records.push({ type: 'TXT', name: dkimRecordName(key.selector, this.mailDomain()), value: dkimRecordValue(key.publicKey) });
		}
		return records;
	}

	/**
	 * The platform's DKIM key for `<mail domain>`, created on first use. Creating it bumps the mail
	 * state so the mail node can sign with it before any platform mail reaches the outbox.
	 */
	private platformDkim(): { selector: string; publicKey: string; privateSealed: string } {
		const stored = parseJson<{ selector: string; publicKey: string; privateSealed: string } | null>(this.setting(SETTINGS.platformDkim) ?? 'null', null);
		if (stored) return stored;
		const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const key = {
			selector: dkimSelector(new Date(this.ctx.now())),
			publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
			privateSealed: this.ctx.secrets.seal(PLATFORM_KEY_ORG, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
		};
		this.setSetting(SETTINGS.platformDkim, JSON.stringify(key));
		this.bumpMail();
		// Installs that set up email before the platform sender existed get its record without a settings change.
		if (this.settings().nodeId)
			queueMicrotask(() => void this.publishPlatformRecords().catch((error) => console.error('[email] could not publish the platform DKIM record:', error instanceof Error ? error.message : error)));
		return key;
	}

	/** The platform sender in the pushed state; an org can never hold the mail domain (createDomain, configure). */
	private platformMailDomain(): MailState['domains'][number] {
		const key = this.platformDkim();
		return {
			id: 'platform',
			orgId: PLATFORM_MAIL_ORG,
			name: this.mailDomain(),
			sending: true,
			receiving: false,
			dkim: [{ selector: key.selector, algorithm: 'rsa-sha256', privateKey: this.ctx.secrets.open(PLATFORM_KEY_ORG, key.privateSealed) }],
		};
	}

	private inZone(name: string): boolean {
		return !!this.cloudflare && !!this.zoneName && (name === this.zoneName || name.endsWith(`.${this.zoneName}`));
	}

	private async upsertRecord(input: Omit<CloudflareRecordInput, 'proxied' | 'ttl' | 'comment'>): Promise<string | null> {
		if (!this.cloudflare || !this.inZone(input.name)) return null;
		const body: CloudflareRecordInput = { ...input, proxied: false, ttl: 1, comment: RECORD_COMMENT };
		const existing = await this.cloudflare.findRecord(input.name);
		if (existing && existing.type === input.type && (input.type !== 'TXT' || existing.content.replace(/^"|"$/g, '').split(' ')[0] === input.content.split(' ')[0])) {
			if (existing.content.replace(/^"|"$/g, '') === input.content) return existing.id;
			return (await this.cloudflare.updateRecord(existing.id, body)).id;
		}
		return (await this.cloudflare.createRecord(body)).id;
	}

	async publishPlatformRecords(): Promise<number> {
		let published = 0;
		for (const record of this.platformRecords()) {
			const id = await this.upsertRecord({ type: record.type, name: record.name, content: record.value, priority: record.priority });
			if (id) published += 1;
		}
		return published;
	}

	// ------------------------------------------------------------------ org state

	private orgRow(orgId: string, principal?: Principal): typeof emailOrgs.$inferSelect {
		const row = this.ctx.db.select().from(emailOrgs).where(eq(emailOrgs.orgId, orgId)).get();
		if (row) return row;
		// Orgs start in the sandbox (D119); one whose email a platform admin sets up starts active.
		const active = principal ? this.ctx.platformIam.canAdminister(principal) : false;
		const limits = active ? EMAIL_ACTIVE_DEFAULT_LIMITS : EMAIL_SANDBOX_LIMITS;
		const created = {
			orgId,
			state: (active ? 'active' : 'sandbox') as EmailOrgState,
			perSecond: limits.perSecond,
			perDay: limits.perDay,
			pausedReason: null,
			updatedAt: this.ctx.now(),
		};
		this.ctx.db.insert(emailOrgs).values(created).onConflictDoNothing().run();
		return this.ctx.db.select().from(emailOrgs).where(eq(emailOrgs.orgId, orgId)).get() ?? created;
	}

	/** The org's row, or the defaults it would get, without creating it (reads never write). */
	private peekOrg(orgId: string, principal?: Principal): Pick<typeof emailOrgs.$inferSelect, 'state' | 'perSecond' | 'perDay' | 'pausedReason'> {
		const row = this.ctx.db.select().from(emailOrgs).where(eq(emailOrgs.orgId, orgId)).get();
		if (row) return row;
		const active = principal ? this.ctx.platformIam.canAdminister(principal) : false;
		const limits = active ? EMAIL_ACTIVE_DEFAULT_LIMITS : EMAIL_SANDBOX_LIMITS;
		return { state: active ? 'active' : 'sandbox', perSecond: limits.perSecond, perDay: limits.perDay, pausedReason: null };
	}

	orgView(principal: Principal): EmailOrgView {
		this.ctx.iam.require(principal, 'email:read', { type: 'org' });
		const row = this.peekOrg(principal.orgId, principal);
		const reputation = this.reputation(principal.orgId);
		return {
			state: row.state,
			perSecond: row.perSecond,
			perDay: row.perDay,
			sentToday: this.sentToday(principal.orgId),
			bounceRate: reputation.bounceRate,
			complaintRate: reputation.complaintRate,
			windowMessages: reputation.windowMessages,
			pausedReason: row.pausedReason,
		};
	}

	/** Move an org out of (or back into) the sandbox, pause or resume it. Platform admins only. */
	setOrgState(principal: Principal, orgId: string, raw: { state?: EmailOrgState; perSecond?: number; perDay?: number }): EmailOrgView {
		if (!this.ctx.platformIam.canAdminister(principal)) throw new CoreError('forbidden', 'Only a platform admin role can change sending limits.', 403);
		const input = emailOrgStateUpdateSchema.parse(raw);
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(orgId)) throw new ValidationError('Not an organisation id.');
		const row = this.orgRow(orgId);
		const state = input.state ?? row.state;
		const defaults = state === 'sandbox' ? EMAIL_SANDBOX_LIMITS : EMAIL_ACTIVE_DEFAULT_LIMITS;
		const movedOut = row.state === 'sandbox' && state === 'active';
		const perSecond = input.perSecond ?? (movedOut ? defaults.perSecond : row.perSecond);
		const perDay = input.perDay ?? (movedOut ? defaults.perDay : row.perDay);
		if (!Number.isInteger(perSecond) || perSecond < 1 || perSecond > 1000) throw new ValidationError('perSecond must be 1–1000.');
		if (!Number.isInteger(perDay) || perDay < 1 || perDay > 10_000_000) throw new ValidationError('perDay must be 1–10,000,000.');
		this.ctx.db
			.update(emailOrgs)
			.set({ state, perSecond, perDay, pausedReason: state === 'paused' ? row.pausedReason ?? 'Paused by a platform admin.' : null, updatedAt: this.ctx.now() })
			.where(eq(emailOrgs.orgId, orgId))
			.run();
		this.bumpMail();
		this.ctx.audit.record({ principal, action: 'email.org.update', resource: 'email', resourceId: orgId, args: input, result: 'ok' });
		// Moved out by hand: a request still waiting for an answer is answered by this.
		if (movedOut) this.closePendingAccessRequest(principal, orgId, { perDay, perSecond });
		return this.orgView({ ...principal, orgId, permissions: new Set([...principal.permissions, 'email:read']) });
	}

	private sentToday(orgId: string): number {
		const start = new Date(this.ctx.now());
		start.setUTCHours(0, 0, 0, 0);
		const row = this.ctx.sqlite
			.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM email_messages WHERE org_id = ? AND created_at >= ? AND status != 'rejected'")
			.get(orgId, start.getTime());
		return row?.n ?? 0;
	}

	private sentLastSecond(orgId: string): number {
		const row = this.ctx.sqlite
			.query<{ n: number }, [string, number]>('SELECT COUNT(*) AS n FROM email_messages WHERE org_id = ? AND created_at > ?')
			.get(orgId, this.ctx.now() - 1000);
		return row?.n ?? 0;
	}

	/** Bounce and complaint rates over the reputation window (EMAIL.md §7.2). */
	reputation(orgId: string): { bounceRate: number | null; complaintRate: number | null; windowMessages: number } {
		const row = this.ctx.sqlite
			.query<{ n: number; bounced: number | null; complained: number | null }, [string, number, number]>(
				`SELECT COUNT(*) AS n, SUM(hard_bounced) AS bounced, SUM(complained) AS complained FROM (
					SELECT hard_bounced, complained FROM email_recipients
					WHERE org_id = ? AND created_at >= ? AND status != 'suppressed'
					ORDER BY created_at DESC LIMIT ?
				)`,
			)
			.get(orgId, this.ctx.now() - EMAIL_REPUTATION.windowDays * DAY_MS, EMAIL_REPUTATION.windowMessages);
		const n = row?.n ?? 0;
		if (n === 0) return { bounceRate: null, complaintRate: null, windowMessages: 0 };
		return { bounceRate: (row?.bounced ?? 0) / n, complaintRate: (row?.complained ?? 0) / n, windowMessages: n };
	}

	private async checkReputation(orgId: string): Promise<void> {
		const row = this.orgRow(orgId);
		if (row.state === 'paused') return;
		const { bounceRate, complaintRate, windowMessages } = this.reputation(orgId);
		if (windowMessages < EMAIL_REPUTATION.minMessages) return;
		let reason: string | null = null;
		if ((bounceRate ?? 0) >= EMAIL_REPUTATION.bouncePause)
			reason = `Hard-bounce rate ${((bounceRate ?? 0) * 100).toFixed(1)}% over the last ${windowMessages} messages (limit ${EMAIL_REPUTATION.bouncePause * 100}%).`;
		else if ((complaintRate ?? 0) >= EMAIL_REPUTATION.complaintPause)
			reason = `Complaint rate ${((complaintRate ?? 0) * 100).toFixed(2)}% over the last ${windowMessages} messages (limit ${EMAIL_REPUTATION.complaintPause * 100}%).`;
		if (!reason) return;
		this.ctx.db.update(emailOrgs).set({ state: 'paused', pausedReason: reason, updatedAt: this.ctx.now() }).where(eq(emailOrgs.orgId, orgId)).run();
		this.bumpMail();
		this.ctx.audit.record({
			principal: buildSystemPrincipal('system:email-delivery', orgId),
			action: 'email.org.paused',
			resource: 'email',
			resourceId: orgId,
			args: { reason },
			result: 'ok',
		});
		await this.notify({ key: `email.paused.${orgId}`, title: 'Email sending paused for an organisation', detail: reason, severity: 'critical' });
	}

	private async notify(alert: { key: string; title: string; detail: string; severity: 'info' | 'warning' | 'critical' }): Promise<void> {
		await Promise.all(this.ctx.notifiers.map((notifier) => notifier.notify(alert).catch(() => undefined)));
	}

	// ------------------------------------------------------------------ domains

	private domainRow(principal: Principal, name: string): EmailDomainRow {
		const row = this.ctx.db
			.select()
			.from(emailDomains)
			.where(and(eq(emailDomains.orgId, principal.orgId), eq(emailDomains.name, name.toLowerCase())))
			.get();
		if (!row) throw new NotFoundError(`Email domain "${name}" not found.`);
		return row;
	}

	/** Records a domain needs (EMAIL.md §4.2), without check results. */
	expectedRecords(row: Pick<EmailDomainRow, 'name' | 'dkimSelector' | 'dkimPublic' | 'receiving'>): EmailDnsRecord[] {
		const include = spfInclude(this.mailDomain());
		const records: EmailDnsRecord[] = [
			{ purpose: 'dkim', type: 'TXT', name: dkimRecordName(row.dkimSelector, row.name), value: dkimRecordValue(row.dkimPublic), required: true },
			{ purpose: 'spf', type: 'TXT', name: row.name, value: `v=spf1 ${include} ~all`, required: false },
			{ purpose: 'dmarc', type: 'TXT', name: `_dmarc.${row.name}`, value: suggestedDmarc(row.name), required: false },
		];
		if (row.receiving)
			records.push({ purpose: 'mx', type: 'MX', name: row.name, value: this.hostnames().mx, priority: 10, required: true });
		return records;
	}

	toDomainView(row: EmailDomainRow): EmailDomainView {
		const checks = parseJson<EmailRecordCheck[]>(row.recordsJson, []);
		const records = this.expectedRecords(row).map(
			(record) =>
				checks.find((check) => check.purpose === record.purpose && check.name === record.name) ?? {
					...record,
					ok: false,
					found: [],
					managed: false,
					note: 'Not checked yet.',
				},
		);
		return {
			id: row.id,
			name: row.name,
			status: row.status,
			sending: row.sending,
			receiving: row.receiving,
			dkimSelector: row.dkimSelector,
			records,
			lastCheckedAt: iso(row.lastCheckedAt),
			verifiedAt: iso(row.verifiedAt),
			failingSince: iso(row.failingSince),
			createdAt: iso(row.createdAt)!,
		};
	}

	listDomains(principal: Principal): EmailDomainView[] {
		// TODO(IAM I2): narrow this list with scopeFilter once it returns emailDomain ids; it
		// currently returns only project and environment ids.
		this.ctx.iam.require(principal, 'email:read', { type: 'org' });
		return this.ctx.db
			.select()
			.from(emailDomains)
			.where(eq(emailDomains.orgId, principal.orgId))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((row) => this.toDomainView(row));
	}

	getDomain(principal: Principal, name: string): EmailDomainView {
		const row = this.domainRow(principal, name);
		this.ctx.iam.require(principal, 'email:read', { type: 'emailDomain', id: row.id });
		return this.toDomainView(row);
	}

	async createDomain(principal: Principal, raw: EmailDomainCreate): Promise<EmailDomainView> {
		this.ctx.iam.require(principal, 'email:update', { type: 'org' });
		this.requireFeature();
		const input = emailDomainCreateSchema.parse(raw);
		if (input.name === this.mailDomain() || input.name.endsWith(`.${this.hostnames().bounce}`) || input.name === this.hostnames().bounce)
			throw new ValidationError(`${input.name} is used by the platform's own mail hostnames.`);
		if (input.receiving) throw new ValidationError('Receiving mail arrives in a later release; create the domain for sending first.');
		const taken = this.ctx.db.select({ orgId: emailDomains.orgId }).from(emailDomains).where(eq(emailDomains.name, input.name)).get();
		if (taken)
			throw new ConflictError(
				taken.orgId === principal.orgId ? `${input.name} is already set up.` : `${input.name} is already used by another organisation.`,
			);
		this.orgRow(principal.orgId, principal);
		const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const now = this.ctx.now();
		const row: EmailDomainRow = {
			id: newId(EMAIL_DOMAIN_ID_PREFIX),
			orgId: principal.orgId,
			name: input.name,
			sending: input.sending,
			receiving: false,
			status: 'pending',
			dkimSelector: dkimSelector(new Date(now)),
			dkimPublic: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
			dkimPrivateSealed: this.ctx.secrets.seal(principal.orgId, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
			recordsJson: '[]',
			managedJson: '{}',
			lastCheckedAt: null,
			verifiedAt: null,
			failingSince: null,
			createdBy: principal.userId,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.db.insert(emailDomains).values(row).run();
		this.ctx.audit.record({ principal, action: 'email.domain.create', resource: 'email', resourceId: row.id, args: { name: row.name }, result: 'ok' });
		if (input.autoDns) await this.publishDomainRecords(row).catch(() => undefined);
		return this.toDomainView(await this.runCheck(this.ctx.db.select().from(emailDomains).where(eq(emailDomains.id, row.id)).get()!));
	}

	/**
	 * Create the domain's records through Cloudflare when its zone is ours. Never overwrites
	 * SPF/DMARC. Returns the purposes written this time (records already in place are skipped).
	 */
	private async publishDomainRecords(row: EmailDomainRow): Promise<string[]> {
		if (!this.cloudflare || !this.inZone(row.name)) return [];
		const managed = parseJson<Record<string, string>>(row.managedJson, {});
		const written: string[] = [];
		const dkim = this.expectedRecords(row).find((record) => record.purpose === 'dkim')!;
		const dkimFound = (await this.txtValues(dkim.name)).some((value) => value.replace(/\s+/g, '').includes(`p=${row.dkimPublic}`));
		const dkimId = await this.upsertRecord({ type: 'TXT', name: dkim.name, content: dkim.value });
		if (dkimId) {
			managed.dkim = dkimId;
			if (!dkimFound) written.push('dkim');
		}
		const existingSpf = await this.txtValues(row.name).then((values) => values.find((value) => /^v=spf1(\s|$)/i.test(value)) ?? null);
		if (!existingSpf) {
			const id = await this.upsertRecord({ type: 'TXT', name: row.name, content: mergeSpf(null, spfInclude(this.mailDomain())) });
			if (id) {
				managed.spf = id;
				written.push('spf');
			}
		}
		const dmarc = await this.txtValues(`_dmarc.${row.name}`);
		if (!dmarc.some((value) => /^v=DMARC1/i.test(value))) {
			const id = await this.upsertRecord({ type: 'TXT', name: `_dmarc.${row.name}`, content: suggestedDmarc(row.name) });
			if (id) {
				managed.dmarc = id;
				written.push('dmarc');
			}
		}
		this.ctx.db.update(emailDomains).set({ managedJson: JSON.stringify(managed) }).where(eq(emailDomains.id, row.id)).run();
		return written;
	}

	/** Whether Yoal can write this domain's records itself: a Cloudflare token for the zone it sits in. */
	managesDns(name: string): boolean {
		return this.inZone(name.trim().toLowerCase());
	}

	/**
	 * "Set up for me": write the domain's records through Cloudflare now, then re-check. Unlike the
	 * quiet publish in `checkDomain`, Cloudflare errors reach the caller.
	 */
	async publishDomain(principal: Principal, name: string): Promise<{ domain: EmailDomainView; written: string[] }> {
		const row = this.domainRow(principal, name);
		this.ctx.iam.require(principal, 'email:update', { type: 'emailDomain', id: row.id });
		if (!this.inZone(row.name))
			throw new ValidationError(`${row.name} isn't in the Cloudflare zone Yoal manages; add its records at your DNS host.`);
		const written = await this.publishDomainRecords(row);
		this.ctx.audit.record({ principal, action: 'email.domain.publish', resource: 'email', resourceId: row.id, args: { name: row.name, written }, result: 'ok' });
		return { domain: this.toDomainView(await this.runCheck(this.domainRow(principal, name))), written };
	}

	private async txtValues(name: string): Promise<string[]> {
		try {
			return (await this.dns.resolveTxt(name)).map((chunks) => chunks.join(''));
		} catch {
			return [];
		}
	}

	private async runCheck(row: EmailDomainRow): Promise<EmailDomainRow> {
		const managed = parseJson<Record<string, string>>(row.managedJson, {});
		const include = spfInclude(this.mailDomain());
		const checks: EmailRecordCheck[] = [];
		for (const record of this.expectedRecords(row)) {
			let found: string[] = [];
			let ok = false;
			let note: string | null = null;
			if (record.type === 'TXT') {
				found = await this.txtValues(record.name);
				if (record.purpose === 'dkim') {
					ok = found.some((value) => value.replace(/\s+/g, '').includes(`p=${row.dkimPublic}`));
					if (!ok) note = found.length ? 'A DKIM record exists but carries a different key.' : 'Not found yet. DNS changes can take a few minutes.';
				} else if (record.purpose === 'spf') {
					const spf = found.filter((value) => /^v=spf1(\s|$)/i.test(value));
					found = spf;
					ok = spf.length === 1 && spfIncludes(spf[0]!, include);
					if (spf.length > 1) note = 'More than one SPF record: receivers treat that as an error. Merge them into one.';
					else if (spf.length === 1 && !ok) note = `Add ${include} to the existing record: ${mergeSpf(spf[0]!, include)}`;
				} else if (record.purpose === 'dmarc') {
					const dmarc = found.filter((value) => /^v=DMARC1/i.test(value));
					found = dmarc;
					ok = dmarc.length === 1;
					if (!ok) note = 'Gmail and Yahoo expect a DMARC record from bulk senders.';
				}
			} else if (record.type === 'MX') {
				try {
					const mx = await this.dns.resolveMx(record.name);
					found = mx.map((entry) => `${entry.priority} ${entry.exchange}`);
					ok = mx.some((entry) => entry.exchange.replace(/\.$/, '').toLowerCase() === record.value);
				} catch {
					found = [];
				}
			}
			checks.push({ ...record, ok, found, managed: !!managed[record.purpose], note });
		}
		const dkimOk = checks.find((check) => check.purpose === 'dkim')?.ok ?? false;
		const now = this.ctx.now();
		const wasVerified = row.status === 'verified';
		let status = row.status;
		let failingSince = row.failingSince;
		let verifiedAt = row.verifiedAt;
		if (dkimOk) {
			status = 'verified';
			failingSince = null;
			verifiedAt = verifiedAt ?? now;
		} else if (row.verifiedAt) {
			failingSince = failingSince ?? now;
			status = now - failingSince >= FAILING_GRACE_MS ? 'failed' : 'verified';
		}
		this.ctx.db
			.update(emailDomains)
			.set({ recordsJson: JSON.stringify(checks), lastCheckedAt: now, status, failingSince, verifiedAt, updatedAt: now })
			.where(eq(emailDomains.id, row.id))
			.run();
		if (wasVerified !== (status === 'verified')) {
			this.bumpMail();
			if (status === 'failed')
				await this.notify({
					key: `email.domain_unverified.${row.id}`,
					title: `Email domain ${row.name} lost its DKIM record`,
					detail: `Sending from ${row.name} is paused until ${dkimRecordName(row.dkimSelector, row.name)} is back.`,
					severity: 'warning',
				});
		}
		return this.ctx.db.select().from(emailDomains).where(eq(emailDomains.id, row.id)).get()!;
	}

	/** Re-check public DNS, and publish missing records through Cloudflare: a write. */
	async checkDomain(principal: Principal, name: string): Promise<EmailDomainView> {
		const row = this.domainRow(principal, name);
		this.ctx.iam.require(principal, 'email:update', { type: 'emailDomain', id: row.id });
		if (row.status !== 'verified') await this.publishDomainRecords(row).catch(() => undefined);
		return this.toDomainView(await this.runCheck(this.domainRow(principal, name)));
	}

	updateDomain(principal: Principal, name: string, raw: unknown): EmailDomainView {
		const row = this.domainRow(principal, name);
		this.ctx.iam.require(principal, 'email:update', { type: 'emailDomain', id: row.id });
		const input = emailDomainUpdateSchema.parse(raw);
		if (input.receiving) throw new ValidationError('Receiving mail arrives in a later release.');
		this.ctx.db
			.update(emailDomains)
			.set({ sending: input.sending ?? row.sending, updatedAt: this.ctx.now() })
			.where(eq(emailDomains.id, row.id))
			.run();
		this.bumpMail();
		this.ctx.audit.record({ principal, action: 'email.domain.update', resource: 'email', resourceId: row.id, args: input, result: 'ok' });
		return this.toDomainView(this.domainRow(principal, name));
	}

	async deleteDomain(principal: Principal, name: string): Promise<void> {
		const row = this.domainRow(principal, name);
		this.ctx.iam.require(principal, 'email:delete', { type: 'emailDomain', id: row.id });
		const managed = parseJson<Record<string, string>>(row.managedJson, {});
		if (this.cloudflare) for (const id of Object.values(managed)) await this.cloudflare.deleteRecord(id).catch(() => undefined);
		this.ctx.db.delete(emailDomains).where(eq(emailDomains.id, row.id)).run();
		this.bumpMail();
		this.ctx.audit.record({ principal, action: 'email.domain.delete', resource: 'email', resourceId: row.id, args: { name }, result: 'ok' });
	}

	/** Daily re-check of every domain (EMAIL.md §4.1). */
	async checkAllDomains(maxAgeMs = DAY_MS): Promise<number> {
		const stale = this.ctx.db
			.select()
			.from(emailDomains)
			.where(or(isNull(emailDomains.lastCheckedAt), lt(emailDomains.lastCheckedAt, this.ctx.now() - maxAgeMs)))
			.all();
		for (const row of stale) await this.runCheck(row).catch(() => undefined);
		return stale.length;
	}

	// ------------------------------------------------------------------ credentials and attachments

	private credentialView(row: EmailCredentialRow): EmailCredentialView {
		const project = row.projectId ? this.ctx.db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, row.projectId)).get() : null;
		return {
			id: row.id,
			name: row.name,
			username: row.username,
			projectId: row.projectId,
			projectSlug: project?.slug ?? null,
			allowedFromDomains: parseJson<string[]>(row.allowedFromJson, []),
			lastUsedAt: iso(row.lastUsedAt),
			createdAt: iso(row.createdAt)!,
		};
	}

	listCredentials(principal: Principal): EmailCredentialView[] {
		const scope = this.ctx.iam.scopeFilter(principal, 'email:read');
		if (scope !== 'all' && scope.size === 0) return [];
		const filters = [eq(emailCredentials.orgId, principal.orgId), isNull(emailCredentials.revokedAt)];
		if (scope !== 'all') filters.push(inArray(emailCredentials.projectId, [...scope]));
		return this.ctx.db
			.select()
			.from(emailCredentials)
			.where(and(...filters))
			.all()
			.map((row) => this.credentialView(row));
	}

	private insertCredential(
		principal: Principal,
		input: { name: string; projectId: string | null; allowedFromDomains: string[]; envPrefix: string | null },
	): { row: EmailCredentialRow; password: string } {
		const id = newId(EMAIL_CREDENTIAL_ID_PREFIX);
		const password = randomToken(30);
		const row: EmailCredentialRow = {
			id,
			orgId: principal.orgId,
			projectId: input.projectId,
			name: input.name,
			username: `${EMAIL_USERNAME_PREFIX}${id.slice(EMAIL_CREDENTIAL_ID_PREFIX.length)}`,
			hash: hashPassword(password),
			secretSealed: this.ctx.secrets.seal(principal.orgId, password),
			allowedFromJson: JSON.stringify(input.allowedFromDomains),
			envPrefix: input.envPrefix,
			lastUsedAt: null,
			createdBy: principal.userId,
			createdAt: this.ctx.now(),
			revokedAt: null,
		};
		this.ctx.db.insert(emailCredentials).values(row).run();
		this.orgRow(principal.orgId, principal);
		this.bumpMail();
		return { row, password };
	}

	createCredential(principal: Principal, raw: unknown): EmailCredentialSecret {
		this.requireFeature();
		const input = emailCredentialCreateSchema.parse(raw);
		const project = input.project ? this.ctx.projects.requireRow(principal, input.project) : null;
		this.ctx.iam.require(
			principal,
			'email:credentials',
			project ? { type: 'project', id: project.id } : { type: 'org' },
		);
		// The password is shown once, so creating one is a reveal (D58): an interactive person only.
		if (principal.kind !== 'user') throw new CoreError('forbidden', 'Email credentials are created by a person in the dashboard or CLI session, not an API key or agent (D58).', 403);
		const { row, password } = this.insertCredential(principal, {
			name: input.name,
			projectId: project?.id ?? null,
			allowedFromDomains: input.allowedFromDomains,
			envPrefix: null,
		});
		this.ctx.audit.record({ principal, action: 'email.credential.create', resource: 'email', resourceId: row.id, args: { name: input.name }, result: 'ok' });
		return { ...this.credentialView(row), password, smtp: { host: this.hostnames().submission, port: 587, secure: 'starttls' } };
	}

	revokeCredential(principal: Principal, id: string): void {
		const row = this.ctx.db
			.select()
			.from(emailCredentials)
			.where(and(eq(emailCredentials.id, id), eq(emailCredentials.orgId, principal.orgId), isNull(emailCredentials.revokedAt)))
			.get();
		if (!row) throw new NotFoundError(`Credential ${id} not found.`);
		this.ctx.iam.require(
			principal,
			'email:credentials',
			row.projectId ? { type: 'project', id: row.projectId } : { type: 'org' },
		);
		this.ctx.db.update(emailCredentials).set({ revokedAt: this.ctx.now() }).where(eq(emailCredentials.id, id)).run();
		this.bumpMail();
		this.ctx.audit.record({ principal, action: 'email.credential.revoke', resource: 'email', resourceId: id, args: {}, result: 'ok' });
		if (row.projectId && row.envPrefix) this.ctx.projects.bump();
	}

	/** Give a project SMTP credentials as `<PREFIX>_*` env at activation (EMAIL.md §5.4). */
	attach(principal: Principal, project: ProjectRow, input: { envPrefix?: string } = {}): { envPrefix: string; envNames: string[] } {
		this.ctx.iam.require(principal, 'email:update', { type: 'project', id: project.id });
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		this.requireFeature();
		const envPrefix = brokerEnvPrefixSchema.parse(input.envPrefix ?? DEFAULT_ENV_PREFIX);
		const existing = this.ctx.db
			.select()
			.from(emailCredentials)
			.where(and(eq(emailCredentials.projectId, project.id), eq(emailCredentials.envPrefix, envPrefix), isNull(emailCredentials.revokedAt)))
			.get();
		if (existing) throw new ConflictError(`${project.slug} already has email credentials under ${envPrefix}_*.`);
		this.insertCredential(principal, { name: `${project.slug} (${envPrefix})`, projectId: project.id, allowedFromDomains: [], envPrefix });
		this.ctx.projects.bump();
		this.ctx.audit.record({ principal, action: 'email.attach', resource: 'project', resourceId: project.id, args: { envPrefix }, result: 'ok' });
		return { envPrefix, envNames: emailEnvNames(envPrefix) };
	}

	detach(principal: Principal, project: ProjectRow, envPrefix = DEFAULT_ENV_PREFIX): void {
		this.ctx.iam.require(principal, 'email:update', { type: 'project', id: project.id });
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const row = this.ctx.db
			.select()
			.from(emailCredentials)
			.where(and(eq(emailCredentials.projectId, project.id), eq(emailCredentials.envPrefix, envPrefix), isNull(emailCredentials.revokedAt)))
			.get();
		if (!row) throw new NotFoundError(`${project.slug} has no email credentials under ${envPrefix}_*.`);
		this.ctx.db.update(emailCredentials).set({ revokedAt: this.ctx.now() }).where(eq(emailCredentials.id, row.id)).run();
		this.bumpMail();
		this.ctx.projects.bump();
		this.ctx.audit.record({ principal, action: 'email.detach', resource: 'project', resourceId: project.id, args: { envPrefix }, result: 'ok' });
	}

	attachments(projectId: string): Array<{ envPrefix: string; envNames: string[]; username: string }> {
		return this.ctx.db
			.select()
			.from(emailCredentials)
			.where(and(eq(emailCredentials.projectId, projectId), isNull(emailCredentials.revokedAt)))
			.all()
			.filter((row) => row.envPrefix)
			.map((row) => ({ envPrefix: row.envPrefix!, envNames: emailEnvNames(row.envPrefix!), username: row.username }));
	}

	/** Env for an attached project's activation; values come from sealed secrets (D18). */
	consumerEnv(projectId: string): Record<string, string> {
		const env: Record<string, string> = {};
		const host = this.hostnames().submission;
		for (const row of this.ctx.db
			.select()
			.from(emailCredentials)
			.where(and(eq(emailCredentials.projectId, projectId), isNull(emailCredentials.revokedAt)))
			.all()) {
			if (!row.envPrefix) continue;
			const password = this.ctx.secrets.open(row.orgId, row.secretSealed);
			const p = row.envPrefix;
			env[`${p}_HOST`] = host;
			env[`${p}_PORT`] = '587';
			env[`${p}_SECURE`] = 'starttls';
			env[`${p}_USER`] = row.username;
			env[`${p}_PASSWORD`] = password;
			env[`${p}_URL`] = `smtp://${encodeURIComponent(row.username)}:${encodeURIComponent(password)}@${host}:587`;
		}
		return env;
	}

	consumerVersion(projectId: string): string {
		return this.ctx.db
			.select({ id: emailCredentials.id })
			.from(emailCredentials)
			.where(and(eq(emailCredentials.projectId, projectId), isNull(emailCredentials.revokedAt)))
			.all()
			.map((row) => row.id)
			.sort()
			.join(',');
	}

	// ------------------------------------------------------------------ sending

	private policyOrg(orgId: string): EmailPolicyOrg {
		const org = this.orgRow(orgId);
		const sendingDomains = this.ctx.db
			.select({ name: emailDomains.name })
			.from(emailDomains)
			.where(and(eq(emailDomains.orgId, orgId), eq(emailDomains.sending, true), eq(emailDomains.status, 'verified')))
			.all()
			.map((row) => row.name);
		const verifiedAddresses = this.ctx.db
			.select({ address: emailAddresses.address })
			.from(emailAddresses)
			.where(and(eq(emailAddresses.orgId, orgId), isNotNull(emailAddresses.verifiedAt)))
			.all()
			.map((row) => row.address);
		return { orgId, state: org.state, perSecond: org.perSecond, perDay: org.perDay, sendingDomains, verifiedAddresses };
	}

	isSuppressed(orgId: string, address: string): boolean {
		const normalized = normalizeAddress(address);
		const row = this.ctx.db
			.select({ address: emailSuppressions.address, expiresAt: emailSuppressions.expiresAt })
			.from(emailSuppressions)
			.where(and(inArray(emailSuppressions.orgId, [orgId, '*']), eq(emailSuppressions.address, normalized)))
			.all();
		const now = this.ctx.now();
		return row.some((entry) => entry.expiresAt === null || entry.expiresAt > now);
	}

	private async compose(input: EmailSend, messageId: string): Promise<Buffer> {
		if (input.raw) return Buffer.from(input.raw.replace(/\r?\n/g, '\r\n'), 'utf8');
		const fromDomain = domainOf(recipientAddress(input.from));
		const headers: Record<string, string> = { ...input.headers };
		if (input.unsubscribe) {
			headers['List-Unsubscribe'] = `<${input.unsubscribe.url}>`;
			if (input.unsubscribe.oneClick) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
		}
		const composer = new MailComposer({
			from: input.from,
			to: input.to,
			cc: input.cc.length ? input.cc : undefined,
			replyTo: input.replyTo.length ? input.replyTo : undefined,
			subject: input.subject,
			text: input.text,
			html: input.html,
			attachments: input.attachments.map((attachment) => ({
				filename: attachment.filename,
				contentType: attachment.contentType,
				content: attachment.content,
				encoding: 'base64',
				cid: attachment.contentId,
			})),
			headers,
			messageId: `<${messageId}@${fromDomain}>`,
			date: new Date(this.ctx.now()),
		});
		// Bcc is never handed to the composer: blind recipients only ever appear in the envelope.
		const mime = composer.compile();
		return new Promise<Buffer>((resolve, reject) => mime.build((error, message) => (error ? reject(error) : resolve(message))));
	}

	/**
	 * Accept one message for delivery (D117): policy, suppression, MIME, then the message log and the
	 * outbox in one transaction. `projectId` is set for binding sends.
	 */
	async send(
		principal: Principal,
		raw: EmailSendInput,
		options: { projectId?: string | null; source?: 'api' | 'binding' } = {},
	): Promise<EmailSendResult> {
		this.ctx.iam.require(
			principal,
			'email:send',
			options.projectId ? { type: 'project', id: options.projectId } : { type: 'org' },
		);
		this.requireFeature();
		if (!this.settings().nodeId)
			throw new CoreError('email_not_set_up', 'Email is not set up on this platform yet: a platform admin has to choose a mail node in Email → Mail server.', 409);
		const input = emailSendSchema.parse(raw);
		if (input.idempotencyKey) {
			const existing = this.ctx.db
				.select()
				.from(emailMessages)
				.where(and(eq(emailMessages.orgId, principal.orgId), eq(emailMessages.idempotencyKey, input.idempotencyKey)))
				.get();
			if (existing && existing.createdAt > this.ctx.now() - DAY_MS) {
				const recipients = this.ctx.db.select().from(emailRecipients).where(eq(emailRecipients.messageId, existing.id)).all();
				return {
					id: existing.id,
					accepted: recipients.filter((entry) => entry.status !== 'suppressed').map((entry) => entry.address),
					suppressed: recipients.filter((entry) => entry.status === 'suppressed').map((entry) => entry.address),
				};
			}
		}
		const from = recipientAddress(input.from);
		const envelope = [...input.to, ...input.cc, ...input.bcc].map(recipientAddress);
		const messageId = `${EMAIL_MESSAGE_ID_PREFIX}${newId().slice(0, 32)}`;
		const mime = await this.compose(input, messageId);
		if (input.raw) {
			const headerFrom = /^From:\s*(.+)$/im.exec(mime.subarray(0, Math.min(mime.length, 64 * 1024)).toString('latin1'))?.[1];
			const parsedFrom = headerFrom ? parseAddress(/<([^>]+)>/.exec(headerFrom)?.[1] ?? headerFrom) : null;
			if (!parsedFrom || parsedFrom.address.toLowerCase() !== from.toLowerCase())
				throw new ValidationError('The raw message must carry a From: header with the same address as "from".');
		}

		const orgId = principal.orgId;
		const decision = authorizeSend(
			this.policyOrg(orgId),
			{ from, recipients: envelope, sizeBytes: mime.byteLength },
			{ sentToday: this.sentToday(orgId), sentLastSecond: this.sentLastSecond(orgId) },
			(address) => this.isSuppressed(orgId, address),
		);
		if (!decision.ok) {
			const status = decision.code === 'rate_limited' || decision.code === 'daily_quota' ? 429 : decision.code === 'email_paused' ? 403 : 422;
			throw new CoreError(decision.code, decision.message, status);
		}

		this.enqueue({
			messageId,
			orgId,
			projectId: options.projectId ?? null,
			source: options.source ?? 'api',
			from,
			subject: input.subject,
			tags: input.tags,
			idempotencyKey: input.idempotencyKey ?? null,
			deliver: decision.deliver,
			suppressed: decision.suppressed,
			mime,
		});
		return { id: messageId, accepted: decision.deliver, suppressed: decision.suppressed };
	}

	/** The message log and the outbox row, in one transaction (D117). */
	private enqueue(message: {
		messageId: string;
		orgId: string;
		projectId: string | null;
		source: 'api' | 'binding';
		from: string;
		subject: string;
		tags: Record<string, string>;
		idempotencyKey: string | null;
		deliver: string[];
		suppressed: string[];
		mime: Buffer;
	}): void {
		const { messageId, orgId, projectId, deliver, suppressed } = message;
		const now = this.ctx.now();
		const payload: MailInject = {
			messageId,
			orgId,
			projectId,
			from: message.from,
			recipients: deliver,
			raw: message.mime.toString('base64'),
			tags: message.tags,
		};
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.insert(emailMessages)
				.values({
					id: messageId,
					orgId,
					projectId,
					source: message.source,
					fromAddress: message.from,
					subject: message.subject,
					tagsJson: JSON.stringify(message.tags),
					status: 'accepted',
					idempotencyKey: message.idempotencyKey,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			const rows = [
				...deliver.map((address, idx) => ({ address, idx, status: 'accepted' })),
				...suppressed.map((address, i) => ({ address, idx: deliver.length + i, status: 'suppressed' })),
			];
			for (const entry of rows)
				this.ctx.db
					.insert(emailRecipients)
					.values({ messageId, idx: entry.idx, orgId, address: entry.address, status: entry.status, createdAt: now, updatedAt: now, lastResponse: entry.status === 'suppressed' ? 'on the suppression list' : null })
					.run();
			this.ctx.db.insert(emailOutbox).values({ messageId, orgId, payloadJson: JSON.stringify(payload), createdAt: now, claimedAt: null }).run();
		})();
	}

	/** Each message succeeds or fails on its own; only the batch envelope is validated up front. */
	async sendBatch(principal: Principal, raw: unknown): Promise<Array<EmailSendResult | { error: { code: string; message: string } }>> {
		const { messages } = emailSendBatchEnvelopeSchema.parse(raw);
		const results: Array<EmailSendResult | { error: { code: string; message: string } }> = [];
		for (const message of messages) {
			try {
				results.push(await this.send(principal, message as EmailSendInput));
			} catch (error) {
				if (error instanceof CoreError) results.push({ error: { code: error.code, message: error.message } });
				else if (error instanceof Error && error.name === 'ZodError') results.push({ error: { code: 'validation_failed', message: error.message } });
				else throw error;
			}
		}
		return results;
	}

	// ------------------------------------------------------------------ message log

	private messageView(row: typeof emailMessages.$inferSelect): EmailMessageView {
		const recipients = this.ctx.db
			.select()
			.from(emailRecipients)
			.where(eq(emailRecipients.messageId, row.id))
			.all()
			.sort((a, b) => a.idx - b.idx)
			.map((entry) => ({ address: entry.address, status: entry.status as EmailEventKind, lastResponse: entry.lastResponse, updatedAt: iso(entry.updatedAt)! }));
		return {
			id: row.id,
			from: row.fromAddress,
			subject: row.subject,
			projectId: row.projectId,
			source: row.source,
			tags: parseJson<Record<string, string>>(row.tagsJson, {}),
			status: row.status as EmailEventKind,
			recipients,
			createdAt: iso(row.createdAt)!,
		};
	}

	listMessages(principal: Principal, options: { limit?: number; before?: string; recipient?: string; status?: string } = {}): EmailMessageView[] {
		const scope = this.ctx.iam.scopeFilter(principal, 'email:read');
		if (scope !== 'all' && scope.size === 0) return [];
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
		const filters = [eq(emailMessages.orgId, principal.orgId)];
		if (scope !== 'all') filters.push(inArray(emailMessages.projectId, [...scope]));
		if (options.before) {
			const before = Date.parse(options.before);
			if (Number.isFinite(before)) filters.push(lt(emailMessages.createdAt, before));
		}
		if (options.status) filters.push(eq(emailMessages.status, options.status));
		if (options.recipient) {
			const ids = this.ctx.db
				.select({ id: emailRecipients.messageId })
				.from(emailRecipients)
				.where(and(eq(emailRecipients.orgId, principal.orgId), sql`lower(${emailRecipients.address}) = ${normalizeAddress(options.recipient)}`))
				.all()
				.map((row) => row.id);
			if (ids.length === 0) return [];
			filters.push(inArray(emailMessages.id, ids));
		}
		return this.ctx.db
			.select()
			.from(emailMessages)
			.where(and(...filters))
			.orderBy(desc(emailMessages.createdAt))
			.limit(limit)
			.all()
			.map((row) => this.messageView(row));
	}

	getMessage(principal: Principal, id: string): EmailMessageView {
		const row = this.ctx.db.select().from(emailMessages).where(and(eq(emailMessages.id, id), eq(emailMessages.orgId, principal.orgId))).get();
		if (!row) throw new NotFoundError(`Message ${id} not found.`);
		this.ctx.iam.require(
			principal,
			'email:read',
			row.projectId ? { type: 'project', id: row.projectId } : { type: 'org' },
		);
		return this.messageView(row);
	}

	// ------------------------------------------------------------------ suppressions

	listSuppressions(principal: Principal, options: { limit?: number; address?: string } = {}): EmailSuppressionView[] {
		this.ctx.iam.require(principal, 'email:read', { type: 'org' });
		const filters = [eq(emailSuppressions.orgId, principal.orgId)];
		if (options.address) filters.push(eq(emailSuppressions.address, normalizeAddress(options.address)));
		return this.ctx.db
			.select()
			.from(emailSuppressions)
			.where(and(...filters))
			.orderBy(desc(emailSuppressions.createdAt))
			.limit(Math.min(options.limit ?? 100, 1000))
			.all()
			.map((row) => ({ address: row.address, reason: row.reason, messageId: row.messageId, createdAt: iso(row.createdAt)! }));
	}

	private suppress(orgId: string, address: string, reason: EmailSuppressionReason, messageId: string | null): boolean {
		const result = this.ctx.sqlite.run(
			'INSERT INTO email_suppressions (org_id, address, reason, message_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
			[orgId, normalizeAddress(address), reason, messageId, this.ctx.now()],
		);
		return result.changes > 0;
	}

	addSuppression(principal: Principal, raw: unknown): EmailSuppressionView {
		this.ctx.iam.require(principal, 'email:update', { type: 'org' });
		const input = emailSuppressionCreateSchema.parse(raw);
		this.suppress(principal.orgId, input.address, input.reason, null);
		this.bumpMail();
		this.ctx.audit.record({ principal, action: 'email.suppression.add', resource: 'email', resourceId: normalizeAddress(input.address), args: { reason: input.reason }, result: 'ok' });
		return this.listSuppressions(principal, { address: input.address })[0]!;
	}

	removeSuppression(principal: Principal, address: string): void {
		this.ctx.iam.require(principal, 'email:update', { type: 'org' });
		const result = this.ctx.sqlite.run('DELETE FROM email_suppressions WHERE org_id = ? AND address = ?', [
			principal.orgId,
			normalizeAddress(address),
		]);
		if (result.changes === 0) throw new NotFoundError(`${address} is not on the suppression list.`);
		this.bumpMail();
		this.ctx.audit.record({ principal, action: 'email.suppression.remove', resource: 'email', resourceId: normalizeAddress(address), args: {}, result: 'ok' });
	}

	// ------------------------------------------------------------------ sandbox recipients (EMAIL.md §4.3)

	/** Display name of an org, for mail and the admin queue; null before the auth tables exist. */
	private orgName(orgId: string): string | null {
		try {
			return this.ctx.sqlite.query<{ name: string }, [string]>('SELECT name FROM organization WHERE id = ?').get(orgId)?.name ?? null;
		} catch {
			return null;
		}
	}

	private userEmail(userId: string): string | null {
		try {
			return this.ctx.sqlite.query<{ email: string | null }, [string]>('SELECT email FROM "user" WHERE id = ?').get(userId)?.email ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * How a verification mail leaves (EMAIL.md §4.3): through Yoal Email itself once a mail node is
	 * set, from the platform's own sender (`no-reply@<mail domain>`, never the org's domains, and
	 * past the org's sandbox, which is what the mail is for); else through platform SMTP (D22).
	 */
	private verificationSender(orgId: string): (message: { to: string; subject: string; text: string }) => Promise<void> {
		const settings = this.settings();
		if (settings.nodeId) {
			if (settings.paused)
				throw new CoreError('email_paused', 'Sending is paused on this platform, so the verification email cannot go out. Ask a platform admin to resume it.', 409);
			return async (message) => {
				await this.queuePlatformMail(orgId, message, { yoal: 'sandbox-verification' });
			};
		}
		const transport = this.ctx.config.email;
		if (!transport)
			throw new CoreError(
				'platform_mail_unavailable',
				'Yoal cannot send the verification email: no mail node is set up (Email → Mail server) and no platform SMTP is configured (YOAL_SMTP_*).',
				409,
			);
		return (message) => transport.send(message);
	}

	/**
	 * Queue one platform-originated message on the mail node, logged under `orgId` so it shows in
	 * that org's activity and its bounces suppress there. Policy is the platform's: only the
	 * suppression lists apply, not the org's sandbox, quota or sending domains.
	 */
	private async queuePlatformMail(orgId: string, message: { to: string; subject: string; text: string }, tags: Record<string, string>): Promise<string> {
		const to = normalizeAddress(message.to);
		if (this.isSuppressed(orgId, to))
			throw new CoreError('recipient_suppressed', `${to} is on the suppression list after a bounce or complaint. Remove it from the list first.`, 422);
		this.platformDkim();
		const from = `${PLATFORM_SENDER_LOCAL}@${this.mailDomain()}`;
		const messageId = `${EMAIL_MESSAGE_ID_PREFIX}${newId().slice(0, 32)}`;
		const input = emailSendSchema.parse({
			from: { name: 'Yoal', address: from },
			to: [to],
			subject: message.subject,
			text: message.text,
			headers: { 'Auto-Submitted': 'auto-generated' },
			tags,
		});
		const mime = await this.compose(input, messageId);
		this.enqueue({ messageId, orgId, projectId: null, source: 'api', from, subject: message.subject, tags, idempotencyKey: null, deliver: [to], suppressed: [], mime });
		return messageId;
	}

	private addressView(row: EmailAddressRow): EmailSandboxAddressView {
		const pending = row.verifiedAt === null;
		return {
			id: row.id,
			address: row.address,
			status: pending ? 'pending' : 'verified',
			verifiedAt: iso(row.verifiedAt),
			sentAt: pending ? iso(row.sentAt) : null,
			expiresAt: pending && row.sentAt !== null ? iso(row.sentAt + EMAIL_SANDBOX_ADDRESS_LIMITS.linkTtlSeconds * 1000) : null,
			createdAt: iso(row.createdAt)!,
		};
	}

	private addressRow(orgId: string, address: string): EmailAddressRow | undefined {
		return this.ctx.db
			.select()
			.from(emailAddresses)
			.where(and(eq(emailAddresses.orgId, orgId), eq(emailAddresses.address, normalizeAddress(address))))
			.get();
	}

	listSandboxAddresses(principal: Principal): EmailSandboxAddressView[] {
		this.ctx.iam.require(principal, 'email:read', { type: 'org' });
		return this.ctx.db
			.select()
			.from(emailAddresses)
			.where(eq(emailAddresses.orgId, principal.orgId))
			.all()
			.sort((a, b) => a.address.localeCompare(b.address))
			.map((row) => this.addressView(row));
	}

	/**
	 * Add a sandbox recipient and mail it a single-use verification link, or send a fresh link to one
	 * still pending. A verified address is returned as it is. The link replaces any earlier one.
	 */
	async addSandboxAddress(principal: Principal, raw: unknown): Promise<EmailSandboxAddressView> {
		this.ctx.iam.require(principal, 'email:update', { type: 'org' });
		this.requireFeature();
		const { address: parsed } = emailSandboxAddressCreateSchema.parse(raw);
		const address = normalizeAddress(parsed);
		const limits = EMAIL_SANDBOX_ADDRESS_LIMITS;
		const existing = this.addressRow(principal.orgId, address);
		if (existing?.verifiedAt) return this.addressView(existing);
		const send = this.verificationSender(principal.orgId);
		const now = this.ctx.now();
		let sendCount = 1;
		if (existing) {
			if (existing.sentAt !== null && now - existing.sentAt < limits.resendAfterSeconds * 1000)
				throw new RateLimitError(`A verification link went to ${address} less than a minute ago. Wait a minute before sending another.`);
			const linkLive = existing.sentAt !== null && now - existing.sentAt < limits.linkTtlSeconds * 1000;
			if (linkLive && existing.sendCount >= limits.maxSends)
				throw new RateLimitError(
					`${limits.maxSends} verification links already went to ${address} today. Ask its owner to check spam, or try again after ${iso(existing.sentAt! + limits.linkTtlSeconds * 1000)}.`,
				);
			sendCount = linkLive ? existing.sendCount + 1 : 1;
		} else {
			const rows = this.ctx.db
				.select({ verifiedAt: emailAddresses.verifiedAt })
				.from(emailAddresses)
				.where(eq(emailAddresses.orgId, principal.orgId))
				.all();
			if (rows.length >= limits.maxAddresses)
				throw new QuotaError(`An organisation can hold at most ${limits.maxAddresses} sandbox recipients. Remove one first, or request production access.`);
			if (rows.filter((row) => row.verifiedAt === null).length >= limits.maxPending)
				throw new QuotaError(`${limits.maxPending} addresses are already waiting for verification. Remove one that won't be confirmed first.`);
		}

		const token = randomToken(32);
		const id = existing?.id ?? newId(EMAIL_ADDRESS_ID_PREFIX);
		if (existing)
			this.ctx.db.update(emailAddresses).set({ tokenHash: sha256Hex(token), sentAt: now, sendCount }).where(eq(emailAddresses.id, id)).run();
		else
			this.ctx.db
				.insert(emailAddresses)
				.values({ id, orgId: principal.orgId, address, tokenHash: sha256Hex(token), verifiedAt: null, createdBy: principal.userId, createdAt: now, sentAt: now, sendCount })
				.run();

		const orgName = this.orgName(principal.orgId) ?? 'An organisation';
		const requester = this.userEmail(principal.userId);
		const url = `${this.ctx.config.platformOrigin}${SANDBOX_VERIFY_PATH}?token=${encodeURIComponent(token)}`;
		try {
			await send({
				to: address,
				subject: `Confirm ${address} to receive test email from ${orgName}`,
				text: [
					`${orgName}${requester ? ` (${requester})` : ''} is setting up email on Yoal and wants to send test messages to ${address}.`,
					'While an organisation is in the sandbox it can only reach addresses whose owners confirmed them.',
					'',
					`To allow it, open this link and confirm:`,
					url,
					'',
					`The link works once and expires in ${limits.linkTtlSeconds / 3600} hours. If you don't know ${orgName}, ignore this email: nothing is sent to you unless you confirm.`,
				].join('\n'),
			});
		} catch (error) {
			// Leave things as they were: no row for a new address, the previous link for an old one.
			if (existing)
				this.ctx.db
					.update(emailAddresses)
					.set({ tokenHash: existing.tokenHash, sentAt: existing.sentAt, sendCount: existing.sendCount })
					.where(eq(emailAddresses.id, id))
					.run();
			else this.ctx.db.delete(emailAddresses).where(eq(emailAddresses.id, id)).run();
			throw new CoreError('platform_mail_failed', `Could not send the verification email: ${error instanceof Error ? error.message : String(error)}`, 502);
		}
		this.ctx.audit.record({
			principal,
			action: existing ? 'email.address.resend' : 'email.address.add',
			resource: 'email',
			resourceId: address,
			args: { sendCount },
			result: 'ok',
		});
		return this.addressView(this.addressRow(principal.orgId, address)!);
	}

	private addressByToken(token: string): EmailAddressRow | undefined {
		if (!token || token.length > 200) return undefined;
		return this.ctx.db.select().from(emailAddresses).where(eq(emailAddresses.tokenHash, sha256Hex(token))).get();
	}

	/** What a verification link points at, without using it up (the public page shows it before the click). */
	peekSandboxVerification(token: string): { address: string; orgName: string | null; expired: boolean } | null {
		const row = this.addressByToken(token);
		if (!row || row.verifiedAt !== null) return null;
		const expired = row.sentAt === null || this.ctx.now() - row.sentAt >= EMAIL_SANDBOX_ADDRESS_LIMITS.linkTtlSeconds * 1000;
		return { address: row.address, orgName: this.orgName(row.orgId), expired };
	}

	/**
	 * The recipient confirmed: the address becomes a sandbox recipient and the link stops working.
	 * Public (the token is the credential); a GET never calls this, so link scanners can't confirm.
	 */
	verifySandboxAddress(token: string): { address: string; orgName: string | null } {
		const row = this.addressByToken(token);
		if (!row || row.verifiedAt !== null) throw new CoreError('invalid_link', 'This link is not valid or was already used.', 404);
		const now = this.ctx.now();
		if (row.sentAt === null || now - row.sentAt >= EMAIL_SANDBOX_ADDRESS_LIMITS.linkTtlSeconds * 1000)
			throw new CoreError('link_expired', 'This link has expired. Ask whoever added your address to send a new one.', 410);
		const result = this.ctx.sqlite.run('UPDATE email_addresses SET verified_at = ?, token_hash = NULL WHERE id = ? AND verified_at IS NULL', [now, row.id]);
		if (result.changes === 0) throw new CoreError('invalid_link', 'This link is not valid or was already used.', 404);
		this.bumpMail();
		this.ctx.audit.record({
			principal: buildSystemPrincipal('system:email-delivery', row.orgId),
			action: 'email.address.verify',
			resource: 'email',
			resourceId: row.address,
			result: 'ok',
		});
		return { address: row.address, orgName: this.orgName(row.orgId) };
	}

	removeSandboxAddress(principal: Principal, address: string): void {
		this.ctx.iam.require(principal, 'email:update', { type: 'org' });
		const row = this.addressRow(principal.orgId, address);
		if (!row) throw new NotFoundError(`Sandbox recipient ${address}`);
		this.ctx.db.delete(emailAddresses).where(eq(emailAddresses.id, row.id)).run();
		if (row.verifiedAt !== null) this.bumpMail();
		this.ctx.audit.record({ principal, action: 'email.address.remove', resource: 'email', resourceId: row.address, args: {}, result: 'ok' });
	}

	// ------------------------------------------------------------------ production access (EMAIL.md §7.3)

	private accessRequestView(row: EmailAccessRequestRow): EmailAccessRequestView {
		return {
			id: row.id,
			orgId: row.orgId,
			orgName: this.orgName(row.orgId),
			status: row.status,
			useCase: row.useCase,
			expectedDailyVolume: row.expectedDailyVolume,
			website: row.website,
			requestedBy: { id: row.requestedBy, email: row.requesterEmail },
			decidedBy: row.decidedBy,
			decidedAt: iso(row.decidedAt),
			note: row.decisionNote,
			perDay: row.grantedPerDay,
			perSecond: row.grantedPerSecond,
			createdAt: iso(row.createdAt)!,
		};
	}

	private pendingAccessRequest(orgId: string): EmailAccessRequestRow | undefined {
		return this.ctx.db
			.select()
			.from(emailAccessRequests)
			.where(and(eq(emailAccessRequests.orgId, orgId), eq(emailAccessRequests.status, 'pending')))
			.get();
	}

	/** The org's latest request, whatever its outcome; null if it never asked. */
	accessRequest(principal: Principal): EmailAccessRequestView | null {
		this.ctx.iam.require(principal, 'email:read', { type: 'org' });
		const row = this.ctx.db
			.select()
			.from(emailAccessRequests)
			.where(eq(emailAccessRequests.orgId, principal.orgId))
			.orderBy(desc(emailAccessRequests.createdAt))
			.limit(1)
			.get();
		return row ? this.accessRequestView(row) : null;
	}

	/** Whether the principal may ask to leave the sandbox: an org manager (`org:update`) with `email:update`. */
	canRequestProductionAccess(principal: Principal): boolean {
		return (
			this.ctx.iam.can(principal, 'org:update', { type: 'org' }) &&
			this.ctx.iam.can(principal, 'email:update', { type: 'org' })
		);
	}

	/** An org owner or admin asks a platform admin to move the org out of the sandbox. */
	async requestProductionAccess(principal: Principal, raw: unknown): Promise<EmailAccessRequestView> {
		this.ctx.iam.require(principal, 'email:update', { type: 'org' });
		if (!this.canRequestProductionAccess(principal))
			throw new CoreError('forbidden', 'Only an organisation owner or admin can request production access.', 403);
		this.requireFeature();
		const input = emailAccessRequestCreateSchema.parse(raw);
		const org = this.peekOrg(principal.orgId, principal);
		if (org.state === 'active') throw new ConflictError('This organisation is already out of the sandbox.');
		if (org.state === 'paused')
			throw new ConflictError(`Sending is paused for this organisation (${org.pausedReason ?? 'by a platform admin'}). A platform admin has to resume it first.`);
		const pending = this.pendingAccessRequest(principal.orgId);
		if (pending) throw new ConflictError(`A request is already waiting for a platform admin (sent ${iso(pending.createdAt)}).`);
		const now = this.ctx.now();
		const row: EmailAccessRequestRow = {
			id: newId(EMAIL_ACCESS_REQUEST_ID_PREFIX),
			orgId: principal.orgId,
			status: 'pending',
			useCase: input.useCase,
			expectedDailyVolume: input.expectedDailyVolume,
			website: input.website ?? null,
			requestedBy: principal.userId,
			requesterEmail: this.userEmail(principal.userId),
			decidedBy: null,
			decidedAt: null,
			decisionNote: null,
			grantedPerDay: null,
			grantedPerSecond: null,
			createdAt: now,
			updatedAt: now,
		};
		try {
			this.ctx.db.insert(emailAccessRequests).values(row).run();
		} catch (error) {
			// Two submissions racing: the partial unique index keeps one pending request per org.
			if (this.pendingAccessRequest(principal.orgId)) throw new ConflictError('A request is already waiting for a platform admin.');
			throw error;
		}
		this.ctx.audit.record({
			principal,
			action: 'email.access_request.create',
			resource: 'email',
			resourceId: row.id,
			args: { expectedDailyVolume: input.expectedDailyVolume, website: input.website ?? null },
			result: 'ok',
		});
		const orgName = this.orgName(principal.orgId) ?? principal.orgId;
		await this.notify({
			key: `email.access_request.${row.id}`,
			title: `Email production access requested for ${orgName}`,
			detail: [
				`${row.requesterEmail ?? principal.userId} asks to move ${orgName} out of the email sandbox, expecting about ${input.expectedDailyVolume.toLocaleString('en')} messages a day.`,
				input.website ? `Website: ${input.website}` : null,
				`Use case: ${input.useCase}`,
				`Review it at ${this.ctx.config.platformOrigin}/email/requests`,
			]
				.filter(Boolean)
				.join('\n\n'),
			severity: 'info',
		});
		return this.accessRequestView(row);
	}

	/** The platform admin's queue, pending first, then the newest decisions. */
	listAccessRequests(principal: Principal, options: { status?: EmailAccessRequestStatus; limit?: number } = {}): EmailAccessRequestView[] {
		if (!this.ctx.platformIam.canView(principal)) throw new CoreError('forbidden', 'Only a platform admin role can see production access requests.', 403);
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
		const rows = this.ctx.db
			.select()
			.from(emailAccessRequests)
			.where(options.status ? eq(emailAccessRequests.status, options.status) : undefined)
			.orderBy(desc(emailAccessRequests.createdAt))
			.limit(limit)
			.all();
		const rank = (row: EmailAccessRequestRow) => (row.status === 'pending' ? 0 : 1);
		return rows.sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt).map((row) => this.accessRequestView(row));
	}

	/**
	 * Approve (the org becomes active with the limits given, else the active defaults) or deny (a
	 * reason is required, and the org stays in the sandbox). The requester is told by email.
	 */
	async decideAccessRequest(principal: Principal, id: string, raw: unknown): Promise<EmailAccessRequestView> {
		if (!this.ctx.platformIam.canAdminister(principal)) throw new CoreError('forbidden', 'Only a platform admin role can decide production access requests.', 403);
		const input = emailAccessRequestDecisionSchema.parse(raw);
		const row = this.ctx.db.select().from(emailAccessRequests).where(eq(emailAccessRequests.id, id)).get();
		if (!row) throw new NotFoundError(`Access request ${id}`);
		if (row.status !== 'pending') throw new ConflictError(`This request was already ${row.status}.`);
		const note = input.note?.trim() || null;
		const now = this.ctx.now();
		let decided: EmailAccessRequestRow;
		if (input.decision === 'deny') {
			if (!note) throw new ValidationError('Say why the request is denied; the requester sees it.');
			decided = { ...row, status: 'denied', decidedBy: principal.userId, decidedAt: now, decisionNote: note, updatedAt: now };
			this.ctx.db.update(emailAccessRequests).set(decided).where(eq(emailAccessRequests.id, id)).run();
		} else {
			const org = this.orgRow(row.orgId);
			if (org.state === 'paused')
				throw new ConflictError('Sending is paused for this organisation; resume it in Email → Mail server before approving.');
			const perDay = input.perDay ?? (org.state === 'active' ? org.perDay : EMAIL_ACTIVE_DEFAULT_LIMITS.perDay);
			const perSecond = input.perSecond ?? (org.state === 'active' ? org.perSecond : EMAIL_ACTIVE_DEFAULT_LIMITS.perSecond);
			decided = {
				...row,
				status: 'approved',
				decidedBy: principal.userId,
				decidedAt: now,
				decisionNote: note,
				grantedPerDay: perDay,
				grantedPerSecond: perSecond,
				updatedAt: now,
			};
			this.ctx.sqlite.transaction(() => {
				// Answered first, so setOrgState finds nothing pending to close.
				this.ctx.db.update(emailAccessRequests).set(decided).where(eq(emailAccessRequests.id, id)).run();
				this.setOrgState(principal, row.orgId, { state: 'active', perDay, perSecond });
			})();
		}
		this.ctx.audit.record({
			principal,
			orgId: row.orgId,
			action: `email.access_request.${decided.status === 'approved' ? 'approve' : 'deny'}`,
			resource: 'email',
			resourceId: id,
			args: { note, perDay: decided.grantedPerDay, perSecond: decided.grantedPerSecond },
			result: 'ok',
		});
		await this.tellRequester(decided);
		return this.accessRequestView(decided);
	}

	/** setOrgState moved the org out by hand: answer its open request the same way. */
	private closePendingAccessRequest(principal: Principal, orgId: string, limits: { perDay: number; perSecond: number }): void {
		const pending = this.pendingAccessRequest(orgId);
		if (!pending) return;
		const now = this.ctx.now();
		const decided: EmailAccessRequestRow = {
			...pending,
			status: 'approved',
			decidedBy: principal.userId,
			decidedAt: now,
			decisionNote: null,
			grantedPerDay: limits.perDay,
			grantedPerSecond: limits.perSecond,
			updatedAt: now,
		};
		this.ctx.db.update(emailAccessRequests).set(decided).where(eq(emailAccessRequests.id, pending.id)).run();
		this.ctx.audit.record({ principal, orgId, action: 'email.access_request.approve', resource: 'email', resourceId: pending.id, args: limits, result: 'ok' });
		void this.tellRequester(decided);
	}

	/** Best effort: a decision stands even if the mail to the requester can't go out. */
	private async tellRequester(row: EmailAccessRequestRow): Promise<boolean> {
		const to = row.requesterEmail ?? this.userEmail(row.requestedBy);
		const transport = this.ctx.config.email;
		if (!to || !transport) return false;
		const orgName = this.orgName(row.orgId) ?? 'your organisation';
		const link = `${this.ctx.config.platformOrigin}/email`;
		const message =
			row.status === 'approved'
				? {
						subject: `Email production access approved for ${orgName}`,
						text: [
							`A platform admin moved ${orgName} out of the email sandbox. You can now send to any recipient, up to ${(row.grantedPerDay ?? 0).toLocaleString('en')} messages a day and ${row.grantedPerSecond ?? 0} a second.`,
							row.decisionNote ? `Note from the admin: ${row.decisionNote}` : null,
							'Keep bounces and complaints low: sending pauses automatically if they climb.',
							link,
						],
					}
				: {
						subject: `Email production access request for ${orgName} was declined`,
						text: [
							`A platform admin declined the request to move ${orgName} out of the email sandbox. It keeps sending to verified recipients only.`,
							`Reason: ${row.decisionNote ?? 'none given'}`,
							'You can send a new request from the Email area once this is addressed.',
							link,
						],
					};
		try {
			await transport.send({ to, subject: message.subject, text: message.text.filter(Boolean).join('\n\n') });
			return true;
		} catch (error) {
			console.error(`[email] could not tell ${to} about access request ${row.id}:`, error instanceof Error ? error.message : error);
			return false;
		}
	}

	// ------------------------------------------------------------------ the mail node

	/** `DesiredState.mail`: only for the configured mail node, and only while the feature is on. */
	desiredForNode(nodeId: string): MailDesired | null {
		if (!featureEnabled(this.ctx.config, 'EMAIL')) return null;
		const settings = this.settings();
		if (settings.nodeId !== nodeId) return null;
		return { generation: settings.generation, hostnames: settings.hostnames };
	}

	isMailNode(nodeId: string): boolean {
		return this.desiredForNode(nodeId) !== null;
	}

	private requireMailNode(nodeId: string): void {
		if (!this.isMailNode(nodeId)) throw new CoreError('forbidden', 'This node is not the mail node.', 403);
	}

	/** The full state `yoal-mail` runs on, with keys opened for the mail node (EMAIL.md §3.5). */
	stateForNode(nodeId: string): MailState {
		this.requireMailNode(nodeId);
		const platformDomain = this.platformMailDomain();
		const settings = this.settings();
		const domains = this.ctx.db.select().from(emailDomains).where(eq(emailDomains.status, 'verified')).all();
		const credentials = this.ctx.db.select().from(emailCredentials).where(isNull(emailCredentials.revokedAt)).all();
		const orgIds = [...new Set([...domains.map((row) => row.orgId), ...credentials.map((row) => row.orgId)])];
		const now = this.ctx.now();
		const suppressions = this.ctx.db.select().from(emailSuppressions).all().filter((row) => row.expiresAt === null || row.expiresAt > now);
		return {
			generation: settings.generation,
			hostnames: settings.hostnames,
			paused: settings.paused,
			domains: [
				platformDomain,
				...domains.map((row) => ({
					id: row.id,
					orgId: row.orgId,
					name: row.name,
					sending: row.sending,
					receiving: row.receiving,
					dkim: [{ selector: row.dkimSelector, algorithm: 'rsa-sha256' as const, privateKey: this.ctx.secrets.open(row.orgId, row.dkimPrivateSealed) }],
				})),
			],
			credentials: credentials.map((row) => ({
				id: row.id,
				orgId: row.orgId,
				projectId: row.projectId,
				username: row.username,
				hash: row.hash,
				allowedFromDomains: parseJson<string[]>(row.allowedFromJson, []),
			})),
			orgs: orgIds.map((orgId) => {
				const policy = this.policyOrg(orgId);
				return {
					orgId,
					state: policy.state,
					perSecond: policy.perSecond,
					perDay: policy.perDay,
					sentToday: this.sentToday(orgId),
					verifiedAddresses: [...policy.verifiedAddresses],
					suppressed: suppressions.filter((row) => row.orgId === orgId).map((row) => row.address),
				};
			}),
			platformSuppressed: suppressions.filter((row) => row.orgId === '*').map((row) => row.address),
		};
	}

	/** Hand the mail node's agent the next outbox messages (D117). Claims time out after a minute. */
	claimOutbox(nodeId: string, limit = 50): MailInject[] {
		this.requireMailNode(nodeId);
		const now = this.ctx.now();
		const rows = this.ctx.db
			.select()
			.from(emailOutbox)
			.where(or(isNull(emailOutbox.claimedAt), lt(emailOutbox.claimedAt, now - CLAIM_TIMEOUT_MS)))
			.orderBy(emailOutbox.createdAt)
			.limit(Math.min(Math.max(limit, 1), 200))
			.all();
		if (rows.length === 0) return [];
		this.ctx.db
			.update(emailOutbox)
			.set({ claimedAt: now })
			.where(inArray(emailOutbox.messageId, rows.map((row) => row.messageId)))
			.run();
		return rows.map((row) => JSON.parse(row.payloadJson) as MailInject);
	}

	ackOutbox(nodeId: string, messageIds: string[]): number {
		this.requireMailNode(nodeId);
		if (messageIds.length === 0) return 0;
		const placeholders = messageIds.map(() => '?').join(', ');
		return this.ctx.sqlite.run(`DELETE FROM email_outbox WHERE message_id IN (${placeholders})`, messageIds).changes;
	}

	/** Fail outbox rows the mail node never picked up (EMAIL.md §5.2). */
	expireOutbox(): number {
		const cutoff = this.ctx.now() - EMAIL_OUTBOX_TTL_SECONDS * 1000;
		const stale = this.ctx.db.select({ messageId: emailOutbox.messageId }).from(emailOutbox).where(lt(emailOutbox.createdAt, cutoff)).all();
		if (stale.length === 0) return 0;
		const ids = stale.map((row) => row.messageId);
		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			this.ctx.db.delete(emailOutbox).where(inArray(emailOutbox.messageId, ids)).run();
			this.ctx.db
				.update(emailRecipients)
				.set({ status: 'rejected', lastResponse: 'mail node unavailable', updatedAt: now })
				.where(and(inArray(emailRecipients.messageId, ids), eq(emailRecipients.status, 'accepted')))
				.run();
			this.ctx.db.update(emailMessages).set({ status: 'rejected', updatedAt: now }).where(inArray(emailMessages.id, ids)).run();
		})();
		return ids.length;
	}

	/** Apply events from `yoal-mail` (D120): message log, suppression, reputation. */
	async ingestEvents(nodeId: string, events: EmailEvent[]): Promise<{ applied: number }> {
		this.requireMailNode(nodeId);
		const touchedOrgs = new Set<string>();
		let suppressionsChanged = false;
		const touchedMessages = new Set<string>();
		for (const event of events) {
			const now = this.ctx.now();
			const at = Date.parse(event.at) || now;
			let message = this.ctx.db.select().from(emailMessages).where(eq(emailMessages.id, event.messageId)).get();
			if (!message) {
				if (event.kind !== 'accepted' && event.kind !== 'suppressed') continue;
				// SMTP-submitted mail reaches the message log through its first event.
				this.ctx.db
					.insert(emailMessages)
					.values({
						id: event.messageId,
						orgId: event.orgId,
						projectId: event.projectId,
						source: event.source === 'api' ? 'api' : 'smtp',
						fromAddress: event.from ?? '',
						subject: event.subject ?? '',
						tagsJson: JSON.stringify(event.tags ?? {}),
						status: 'accepted',
						idempotencyKey: null,
						createdAt: at,
						updatedAt: now,
					})
					.onConflictDoNothing()
					.run();
				message = this.ctx.db.select().from(emailMessages).where(eq(emailMessages.id, event.messageId)).get();
				if (!message) continue;
			}
			if (message.orgId !== event.orgId) continue;
			touchedMessages.add(message.id);
			if (event.recipient) {
				const existing =
					event.recipientIndex !== null
						? this.ctx.db
								.select()
								.from(emailRecipients)
								.where(and(eq(emailRecipients.messageId, message.id), eq(emailRecipients.idx, event.recipientIndex)))
								.get()
						: this.ctx.db
								.select()
								.from(emailRecipients)
								.where(and(eq(emailRecipients.messageId, message.id), eq(emailRecipients.address, event.recipient)))
								.get();
				const hard = event.kind === 'bounced' && event.severity === 'hard';
				if (!existing) {
					const idx =
						event.recipientIndex ??
						(this.ctx.sqlite.query<{ n: number }, [string]>('SELECT COALESCE(MAX(idx) + 1000, 1000) AS n FROM email_recipients WHERE message_id = ?').get(message.id)?.n ?? 1000);
					this.ctx.db
						.insert(emailRecipients)
						.values({
							messageId: message.id,
							idx,
							orgId: message.orgId,
							address: event.recipient,
							status: event.kind,
							bounceClass: event.bounceClass,
							lastResponse: event.response,
							hardBounced: hard,
							complained: event.kind === 'complained',
							createdAt: at,
							updatedAt: now,
						})
						.onConflictDoNothing()
						.run();
				} else if (KIND_RANK[event.kind] >= KIND_RANK[existing.status as EmailEventKind] || existing.status === 'deferred') {
					this.ctx.db
						.update(emailRecipients)
						.set({
							status: event.kind,
							bounceClass: event.bounceClass ?? existing.bounceClass,
							lastResponse: event.response ?? existing.lastResponse,
							hardBounced: existing.hardBounced || hard,
							complained: existing.complained || event.kind === 'complained',
							updatedAt: now,
						})
						.where(and(eq(emailRecipients.messageId, message.id), eq(emailRecipients.idx, existing.idx)))
						.run();
				}

				if (hard && event.bounceClass && HARD_BOUNCE_CLASSES.has(event.bounceClass)) {
					if (this.suppress(message.orgId, event.recipient, 'bounce', message.id)) suppressionsChanged = true;
					if (this.crossOrgHardBounce(message.orgId, event.recipient) && this.suppress('*', event.recipient, 'bounce', message.id))
						suppressionsChanged = true;
					touchedOrgs.add(message.orgId);
				} else if (event.kind === 'bounced' && this.softBounceStreak(message.orgId, event.recipient)) {
					if (this.suppress(message.orgId, event.recipient, 'bounce', message.id)) suppressionsChanged = true;
				}
				if (event.kind === 'complained') {
					if (this.suppress(message.orgId, event.recipient, 'complaint', message.id)) suppressionsChanged = true;
					touchedOrgs.add(message.orgId);
				}
			}
		}
		for (const id of touchedMessages) this.refreshMessageStatus(id);
		if (suppressionsChanged) this.bumpMail();
		for (const orgId of touchedOrgs) await this.checkReputation(orgId);
		return { applied: events.length };
	}

	/** Another org hard-bounced the same address in the last 30 days (EMAIL.md §7.1). */
	private crossOrgHardBounce(orgId: string, address: string): boolean {
		const row = this.ctx.sqlite
			.query<{ n: number }, [string, string, number]>(
				'SELECT COUNT(DISTINCT org_id) AS n FROM email_recipients WHERE address = ? COLLATE NOCASE AND org_id != ? AND hard_bounced = 1 AND created_at >= ?',
			)
			.get(address, orgId, this.ctx.now() - 30 * DAY_MS);
		return (row?.n ?? 0) > 0;
	}

	/** Three bounced messages in a row to an address, spanning at least 72 hours (EMAIL.md §7.1). */
	private softBounceStreak(orgId: string, address: string): boolean {
		const recent = this.ctx.db
			.select({ status: emailRecipients.status, createdAt: emailRecipients.createdAt })
			.from(emailRecipients)
			.where(and(eq(emailRecipients.orgId, orgId), eq(emailRecipients.address, address), gte(emailRecipients.createdAt, this.ctx.now() - 30 * DAY_MS)))
			.orderBy(desc(emailRecipients.createdAt))
			.limit(10)
			.all();
		const streak: number[] = [];
		for (const entry of recent) {
			if (entry.status !== 'bounced') break;
			streak.push(entry.createdAt);
		}
		return streak.length >= 3 && streak[0]! - streak.at(-1)! >= 72 * 3_600_000;
	}

	private refreshMessageStatus(messageId: string): void {
		const statuses = this.ctx.db
			.select({ status: emailRecipients.status })
			.from(emailRecipients)
			.where(eq(emailRecipients.messageId, messageId))
			.all()
			.map((row) => row.status as EmailEventKind);
		const live = statuses.filter((status) => status !== 'suppressed');
		let status: EmailEventKind = 'accepted';
		if (live.length === 0) status = statuses.length ? 'suppressed' : 'accepted';
		else if (live.includes('complained')) status = 'complained';
		else if (live.some((value) => value === 'accepted')) status = 'accepted';
		else if (live.some((value) => value === 'deferred')) status = 'deferred';
		else if (live.every((value) => value === 'delivered')) status = 'delivered';
		else if (live.some((value) => value === 'bounced')) status = 'bounced';
		else status = live[0]!;
		this.ctx.db.update(emailMessages).set({ status, updatedAt: this.ctx.now() }).where(eq(emailMessages.id, messageId)).run();
	}

	/** Maintenance: expire the outbox, trim the message log, re-check stale domains. */
	async sweep(): Promise<{ expired: number; trimmed: number; checked: number }> {
		const expired = this.expireOutbox();
		const cutoff = this.ctx.now() - RETENTION_DAYS * DAY_MS;
		const old = this.ctx.db.select({ id: emailMessages.id }).from(emailMessages).where(lt(emailMessages.createdAt, cutoff)).all();
		if (old.length) {
			const ids = old.map((row) => row.id);
			this.ctx.db.delete(emailRecipients).where(inArray(emailRecipients.messageId, ids)).run();
			this.ctx.db.delete(emailMessages).where(inArray(emailMessages.id, ids)).run();
		}
		const checked = await this.checkAllDomains();
		return { expired, trimmed: old.length, checked };
	}
}
